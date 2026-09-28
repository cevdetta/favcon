// favcon's isomorphic core: everything that needs no filesystem, no child process and no
// Node built-in.
//
// It exists because the website generates icons in the browser, and the alternative to sharing
// this code was reimplementing it - the four svgo plugins, the safe-zone placement, the ICO
// container - against a second set of bugs. §10 of CLAUDE.md says bin/favcon.mjs stays one
// file; that rule was written to stop the CLI fragmenting into helpers, and it still holds for
// everything below the seam. What moved here is only what a browser can also run.
//
// Three seams make that possible, and each one is a parameter rather than a bundler trick:
//
//   * svgo is injected. `createSvgStage({ optimize, builtinPlugins })` takes the Node build
//     from the CLI and svgo/browser from the website. No aliasing, no conditional exports.
//   * the mask maths takes DECODED pixels. The CLI decodes resvg's PNG with node:zlib; the
//     website already has a WASM PNG codec for its own pipeline and uses that.
//   * icoWrap works in Uint8Array and DataView, not Buffer.
//
// Nothing here imports anything. That is the whole contract, and it is worth keeping.

/** Every error a caller is meant to handle. Carries a message, never a stack for the user. */
export class FavconError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FavconError';
  }
}

export const ICO_SIZE = 32;           // what favicon.ico holds
export const APPLE_SIZE = 180;        // 60pt at @3x, the largest size Apple documents for a web clip
                               // icon; no iPhone renders above @3x.
export const MASKABLE_SIZE = 512;     // one maskable icon, the size web.dev's and Evil Martians' sets use.
                               // Chrome takes a maskable icon by size and scales it down: to 83dp
                               // at the device density on Android's launcher (332px at 4x), and
                               // from the largest for splash screens and macOS's dock.
export const DEFAULT_COLORS = 8;      // NOT the palette that meets the 1.0% accuracy bar - 16 is. At 8
                               // the small files miss it on anti-aliased marks: heavy.svg, the
                               // deliberately adversarial fixture, scores 1.87% at 192px, and
                               // flat and animated 1.1% on the 180px apple icon. Every 512px
                               // file is inside. 8 ships because it is ~18% smaller and a mark
                               // drawn on a pixel grid scores 0.00% at 8 on every file. Raising
                               // it is one flag, and docs/BENCHMARKS.md says when. Decision 19.
export const DEFAULT_SIZES = [192, 512];  // the transparent "any" icons. web.dev's install criteria, Chrome's
                               // own docs and MDN all require a 192 and a 512. Chromium 152's code
                               // on desktop accepts one "any" icon of 144px or more (tested with
                               // Page.getInstallabilityErrors), but that is one engine on one
                               // platform, and the documentation is the contract every browser is
                               // held to. SVG cannot fill the role: an SVG entry makes Android's
                               // WebAPK install fail (crbug.com/40925759). Decision 11.
export const DEFAULT_BG = '#000000';  // the ground of the masked icons. iOS composites a
                               // transparent Home Screen icon onto black, so black is what
                               // the platform would have done anyway - the difference is
                               // that the alpha channel goes away and the file gets smaller.
export const ZOPFLI_ITERATIONS = 120; // measured over the corpus: 79665 B at the default 15,
                               // 79454 at 60, 79386 at 120. The curve is flattening hard
                               // (-0.27%, then -0.09%) but bytes ship forever and build
                               // time does not, so the knee is taken on the byte side.
export const MASK_SAFE_RADIUS = 0.4;  // W3C Web App Manifest, "icon masks": the safe zone is a circle
                               // centred on the icon with a radius of 2/5 of its size, the
                               // part every platform mask (circle, squircle, rounded square,
                               // teardrop) is guaranteed to show. iOS's own mask is a rounded
                               // square with corners of about 22% of the tile, which contains
                               // that circle whole, so the same placement serves
                               // apple-touch-icon: unplaced, a mark with a 6% margin lost 12
                               // corner pixels to it at 180 px. A square mark's corners reach furthest, so a
                               // square that fills its viewBox lands at 0.4 * sqrt(2) = 56.6%
                               // of the icon; a mark with its own margin lands proportionally
                               // larger, which is why the extent is measured, not padded.
export const SNAP_WINDOW = 0.9;       // how far below the exact fit the mark may shrink to land on
                               // whole pixels. A pixel-grid mark finds its size within a few
                               // percent (the C mark: 320 of a possible 330px at 512, 112 of 116
                               // at 180); a curved mark never does, and keeps the exact fit.

// =============================================================== CSS helpers ==
// Four scanners shared by the var() resolver and the animation strip. Hand-written rather
// than delegated to a CSS parser because they run on attribute values too, where there is no
// stylesheet to parse - and because svgo's own parser is not on the public API.

/** Split at the first top-level comma; quotes and nested parens do not count. */
const splitFirstComma = (s) => {
  let depth = 0, quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) return [s.slice(0, i), s.slice(i + 1)];
  }
  return [s, null];
};

/** Index of the ')' closing the '(' at or after `open`, or -1. */
const matchParen = (s, open) => {
  let depth = 0, quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (!depth) return i; }
  }
  return -1;
};

/** Index of the next of `stops` at nesting depth 0, or -1. */
const scanTo = (s, i, stops) => {
  let depth = 0, quote = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (!depth && stops.includes(c)) return i;
  }
  return -1;
};

/** Index of the '}' closing the '{' at or after `open`, or -1. */
const matchBrace = (s, open) => {
  let depth = 0, quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return i; }
  }
  return -1;
};

// ================================================================== plugins ==

/**
 * Resolve var() everywhere: attribute values and <style> text. Listed FIRST in the plugin
 * list, so it lands before preset-default's inlineStyles and minifyStyles get to a value
 * they cannot parse.
 *
 * Errors accumulate rather than throwing at the first one, so a mark with three unresolved
 * properties names all three. `errs` is owned by the caller: svgo reuses a plugin object
 * across passes and across calls, so per-run state cannot live in the plugin.
 */
const resolveVarsPlugin = (vars, errs) => {
  const rv = (text, depth = 0) => {
    if (depth > 32) { errs.push('var() nested more than 32 deep'); return text; }
    let out = '', i = 0;
    for (;;) {
      const at = text.indexOf('var(', i);
      if (at === -1) return out + text.slice(i);
      // `myvar(` and `--x-var(` are not var(). Only a token boundary starts one.
      if (at > 0 && /[\w-]/.test(text[at - 1])) { out += text.slice(i, at + 4); i = at + 4; continue; }
      const close = matchParen(text, at + 3);
      if (close === -1) { errs.push('unbalanced var('); return out + text.slice(i); }
      out += text.slice(i, at);
      const [rawName, fallback] = splitFirstComma(text.slice(at + 4, close));
      const name = rawName.trim();
      if (!/^--[\w-]+$/.test(name)) errs.push(`not a custom property: ${name}`);
      else if (vars.has(name)) out += vars.get(name);
      // A fallback is itself an arbitrary value, so it may hold another var().
      else if (fallback !== null) out += rv(fallback.trim(), depth + 1);
      else errs.push(`unresolved var(${name}) - no fallback and no --var override`);
      i = close + 1;
    }
  };
  return {
    name: 'resolveVars',
    fn: () => ({
      element: {
        enter(node) {
          for (const k of Object.keys(node.attributes)) {
            const v = node.attributes[k];
            if (typeof v === 'string' && v.includes('var(')) node.attributes[k] = rv(v);
          }
        },
      },
      text: {
        enter(node, parent) {
          if (parent.name === 'style' && node.value.includes('var(')) node.value = rv(node.value);
        },
      },
      root: { exit() { if (errs.length) throw new Error(errs.join('; ')); } },
    }),
  };
};

const SMIL = new Set(['animate', 'animateMotion', 'animateTransform', 'animateColor', 'set', 'discard']);
const MOTION = /^\s*(-[a-z]+-)?(animation|transition)(-[a-z-]+)?\s*:/i;

/**
 * Remove animation structurally, not by pattern-matching the whole file: SMIL elements,
 * @keyframes, any @media on prefers-reduced-motion (everything inside one is motion by
 * definition, including a "reduce" block that only exists to switch motion off), and any
 * `animation-`/`transition-` declaration wherever it is - rules, nested at-rules, style="".
 * Rules left empty are dropped. The CSS is only rewritten when something was actually
 * removed, so a static input reaches preset-default byte-for-byte.
 *
 * `state.stripped` is how the caller learns whether logo.svg has anything icon.svg does not,
 * and so whether it is worth keeping as a separate file.
 */
const stripAnimationPlugin = (state) => {
  const stripDecls = (s) => {
    const out = [];
    let i = 0;
    for (;;) {
      const j = scanTo(s, i, ';');
      const d = s.slice(i, j < 0 ? s.length : j);
      if (MOTION.test(d)) state.stripped++;
      else if (d.trim()) out.push(d);
      if (j < 0) return out.join(';');
      i = j + 1;
    }
  };
  const stripRules = (css) => {
    let out = '', i = 0;
    while (i < css.length) {
      const j = scanTo(css, i, '{;');
      if (j < 0) { out += css.slice(i); break; }
      if (css[j] === ';') { out += css.slice(i, j + 1); i = j + 1; continue; }
      const k = matchBrace(css, j);
      if (k < 0) { out += css.slice(i); break; }
      const pre = css.slice(i, j), p = pre.trim(), body = css.slice(j + 1, k);
      if (/^@(-[a-z]+-)?keyframes\b/i.test(p) || (/^@media\b/i.test(p) && /prefers-reduced-motion/i.test(p))) {
        state.stripped++;
      } else if (p[0] === '@') {
        const r = stripRules(body);       // @supports, @media on anything else: recurse
        if (r.trim()) out += pre + '{' + r + '}';
      } else {
        const r = stripDecls(body);
        if (r.trim()) out += pre + '{' + r + '}';
      }
      i = k + 1;
    }
    return out;
  };
  const stripCss = (css) => {
    const before = state.stripped;
    const r = stripRules(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    return state.stripped === before ? css : r;
  };
  const cssNode = { enter(node, parent) { if (parent.name === 'style') node.value = stripCss(node.value); } };
  return {
    name: 'stripAnimation',
    fn: () => ({
      element: {
        enter(node, parent) {
          if (SMIL.has(node.name)) {
            parent.children = parent.children.filter((c) => c !== node);
            state.stripped++;
            return;
          }
          const st = node.attributes.style;
          if (typeof st !== 'string') return;
          const before = state.stripped;
          const v = stripDecls(st);
          if (state.stripped === before) return;
          if (v.trim()) node.attributes.style = v;
          else delete node.attributes.style;
        },
      },
      text: cssNode,
      cdata: cssNode,
    }),
  };
};

/**
 * The class and id names that inlineStyles would consume even though another rule still
 * needs them. Empty means inlining is safe and gets to run.
 *
 * inlineStyles copies a rule's declarations onto the elements it matches and then deletes
 * the class or id attribute it just consumed (plugins/inlineStyles.js, "clean up matched
 * class + ID attribute values") - without checking whether a rule it LEFT ALONE still
 * selects that name. It leaves two kinds alone: rules inside an at-rule (its useMqs default
 * of ['', 'screen'] is compared against a string built as `media screen`, so in practice no
 * at-rule qualifies) and rules with a pseudo-class. Both are where motion lives.
 *
 * The damage is not just a dead selector. minifyStyles hands csso a usage list built from
 * the classes still present in the document, so once the attribute is gone csso drops the
 * @media rule as unused and the animation disappears from logo.svg with no warning at all -
 * a silently static "animated" logo, which is worse than a bigger file.
 *
 * The hazard is per NAME, not per file. A name only ever at risk if BOTH are true:
 *
 *   * some rule svgo will not inline selects it - so it is still needed afterwards, and
 *   * some rule svgo WILL inline selects it - so svgo will delete the attribute.
 *
 * A mark whose motion class appears only inside the guard (`.a` in an @media block, palette
 * classes at the top level) is the common case and is perfectly safe: nothing inlines `.a`,
 * so nothing removes it. Asking the coarser question - "is any class selected inside an
 * at-rule?" - switched inlining off for those marks too and cost 44 B on a real logo.
 */
const classesInliningWouldEat = (source) => {
  const sheets = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const needed = new Set();     // named by a rule svgo will NOT inline
  const consumed = new Set();   // named by a rule svgo WILL inline, and so will strip
  // Pseudo-classes are stripped from the selector before matching, so `.x:hover` still
  // names `.x`; a plain token scan is the right granularity.
  const names = (sel) => sel.match(/[.#][-\w]+/g) ?? [];

  const walk = (css, insideAtRule) => {
    let i = 0;
    while (i < css.length) {
      const j = scanTo(css, i, '{;');
      if (j < 0) return;
      if (css[j] === ';') { i = j + 1; continue; }
      const k = matchBrace(css, j);
      if (k < 0) return;
      const p = css.slice(i, j).trim(), body = css.slice(j + 1, k);
      if (/^@(-[a-z]+-)?keyframes\b/i.test(p)) {
        // Percentages, not selectors. svgo never puts these in the rule table, so they
        // neither need a class nor cause one to be removed.
      } else if (p[0] === '@') {
        walk(body, true);
      } else {
        for (const n of names(p)) (insideAtRule || p.includes(':') ? needed : consumed).add(n);
      }
      i = k + 1;
    }
  };
  for (const css of sheets) walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), false);
  return [...needed].filter((n) => consumed.has(n));
};

/**
 * Move any @keyframes that sits INSIDE another at-rule out to the top level of the same
 * stylesheet. Only the logo pass needs this, and only when there is something to move.
 *
 * This is a workaround for a real svgo 4.1.0 crash, and it is worth being precise about,
 * because the shape it crashes on is the exact shape the animated-input contract requires:
 * @keyframes inside @media (prefers-reduced-motion: no-preference).
 *
 * svgo's lib/style.js parseStylesheet walks the CSS and explicitly SKIPS a top-level
 * @keyframes - its percentage selectors are not selectors and have no business in a rule
 * table. But for any OTHER at-rule it runs an inner csstree.walk that collects every
 * descendant Rule with no such guard, so `0%` and `100%` land in the stylesheet svgo
 * matches elements against. Everything downstream that resolves a computed style then feeds
 * them to css-select, which throws:
 *
 *     Error: Unmatched selector: %   at css-what parse.js:128
 *       ... css-select is() -> svgo lib/xast.js matches() -> lib/style.js computeOwnStyle()
 *
 * That path is reached from removeDeprecatedAttrs, removeUnknownsAndDefaults, inlineStyles
 * and more, so switching off one plugin only moves the crash. Hoisting removes the input
 * that triggers it instead.
 *
 * The hoist is safe: @keyframes has no cascade and no conditional behaviour of its own, it
 * only defines a name. What decides whether the mark moves is the `animation` declaration,
 * and that stays inside the guard - so logo.svg still honours prefers-reduced-motion.
 */
const hoistKeyframesPlugin = (state) => {
  const lift = (css, lifted, top) => {
    let out = '', i = 0;
    while (i < css.length) {
      const j = scanTo(css, i, '{;');
      if (j < 0) { out += css.slice(i); break; }
      if (css[j] === ';') { out += css.slice(i, j + 1); i = j + 1; continue; }
      const k = matchBrace(css, j);
      if (k < 0) { out += css.slice(i); break; }
      const pre = css.slice(i, j), p = pre.trim(), body = css.slice(j + 1, k);
      if (/^@(-[a-z]+-)?keyframes\b/i.test(p)) {
        if (top) out += pre + '{' + body + '}';          // already where it belongs
        else { lifted.push(p + '{' + body + '}'); state.hoisted++; }
      } else if (p[0] === '@') {
        const inner = lift(body, lifted, false);
        if (inner.trim()) out += pre + '{' + inner + '}';
      } else {
        out += pre + '{' + body + '}';
      }
      i = k + 1;
    }
    return out;
  };
  const hoist = (css) => {
    const lifted = [];
    const rest = lift(css, lifted, true);
    return lifted.length ? rest + lifted.join('') : css;   // untouched when nothing moved
  };
  const cssNode = { enter(node, parent) { if (parent.name === 'style') node.value = hoist(node.value); } };
  return { name: 'hoistKeyframes', fn: () => ({ text: cssNode, cdata: cssNode }) };
};

/**
 * An animated logo keeps its <style>, so removeAttrs can no longer drop every class (the
 * motion rules select by class) and cleanupIds deoptimises entirely. This keeps exactly the
 * classes a selector names and the ids something references, and drops the rest.
 */
const pruneRefs = {
  name: 'pruneRefs',
  fn: () => {
    const els = [], refs = new Set();
    let css = '', smil = false;
    const urls = (v) => {
      for (const m of String(v).matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) refs.add(m[1]);
    };
    return {
      element: {
        enter(node) {
          els.push(node);
          if (SMIL.has(node.name)) smil = true;
          if (node.name === 'style') {
            for (const c of node.children) if (c.type === 'text' || c.type === 'cdata') css += c.value;
          }
          for (const v of Object.values(node.attributes)) urls(v);
          const h = node.attributes.href ?? node.attributes['xlink:href'];
          if (typeof h === 'string' && h[0] === '#') refs.add(h.slice(1));
        },
      },
      root: {
        exit() {
          const cls = new Set();
          for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) cls.add(m[1]);
          for (const m of css.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) refs.add(m[1]);
          urls(css);
          for (const n of els) {
            const c = n.attributes.class;
            if (c != null) {
              const keep = String(c).split(/\s+/).filter((x) => cls.has(x));
              if (keep.length) n.attributes.class = keep.join(' ');
              else delete n.attributes.class;
            }
            // SMIL can name an id in begin="x.end", which no pattern here would see.
            if (!smil && n.attributes.id != null && !refs.has(n.attributes.id)) delete n.attributes.id;
          }
        },
      },
    };
  },
};

// =============================================================== the svg stage ==

/**
 * The SVG stage, bound to an svgo. `optimize` and `builtinPlugins` come from 'svgo' in Node and
 * from 'svgo/browser' in a bundler - the browser build exports both, so the plugin list below
 * is the same one in both places and cannot drift.
 */
export const createSvgStage = ({ optimize, builtinPlugins }) => {
  // What preset-default actually contains in the svgo that is installed. Asked rather than
  // assumed, because the answer differs by major version and getting it wrong is either a
  // console.warn on every run or a silently-dropped viewBox.
  const presetPlugins = new Set(
    (builtinPlugins.find((p) => p.name === 'preset-default')?.plugins ?? []).map((p) => p.name),
  );

  /**
   * Two modes, one config. ICON is the rasteriser's input and the conservative favicon: no
   * motion, no <style>, no classes. LOGO is the same optimisation with the animation left in,
   * which forces two plugins to change hands.
   */
  const svgoConfig = ({ icon, vars, errs, animState, source }) => {
    const overrides = {};

    // removeViewBox is disabled explicitly rather than left to the preset - but only when the
    // preset actually has it. It is in preset-default on svgo 3, where an input carrying
    // width/height that match the viewBox would lose the viewBox to removeViewBox and then
    // the width/height to removeDimensions below, leaving an SVG that cannot scale at all. It
    // is NOT in preset-default on svgo 4, and naming a plugin the preset does not have makes
    // svgo print a nine-line "You are trying to configure removeViewBox" block to stderr on
    // every single run. Asking PRESET_PLUGINS keeps the svgo 3 defence without the svgo 4 noise.
    if (presetPlugins.has('removeViewBox')) overrides.removeViewBox = false;

    // Only the logo pass keeps a stylesheet, so only it can lose a class it still needs.
    if (!icon && classesInliningWouldEat(source).length) overrides.inlineStyles = false;

    return {
      multipass: true,
      floatPrecision: 1,
      plugins: [
        // First, so a var() used only by an animation cannot fail a build that drops it.
        ...(icon ? [stripAnimationPlugin(animState)] : []),
        // The icon pass has just deleted every @keyframes, so only the logo pass can trip the
        // svgo crash this avoids. A source with nothing nested is passed through untouched.
        ...(icon ? [] : [hoistKeyframesPlugin(animState)]),
        resolveVarsPlugin(vars, errs),
        { name: 'preset-default', params: { overrides } },
        'convertStyleToAttrs',
        { name: 'removeAttrs', params: { attrs: icon ? '(role|aria-.*|data-.*|class)' : '(role|aria-.*|data-.*)' } },
        ...(icon ? [] : [pruneRefs]),
        'removeDimensions',
        'removeTitle',
        'removeDesc',
      ],
    };
  };

  /**
   * One svgo pass. `icon: true` is the rasteriser's input and the conservative favicon;
   * `icon: false` is logo.svg, with the animation left in.
   *
   * Exported because it is the only part of the pipeline that needs no external binary, which
   * makes it the only part a Windows CI job can cover today - and it is also the part with the
   * most moving pieces: var() resolution, the animation strip, the keyframes hoist and the
   * reference pruning all live here.
   *
   * Returns `{ data, stripped }`, where `stripped` counts what the animation strip removed -
   * zero means the source was static and logo.svg can simply be a copy of icon.svg.
   */
  function optimiseSvg(source, { icon = true, vars = {}, name = 'input.svg' } = {}) {
    const map = vars instanceof Map ? vars : normaliseVars(vars);
    const errs = [];
    const animState = { stripped: 0, hoisted: 0 };
    let result;
    try {
      result = optimize(source, svgoConfig({ icon, vars: map, errs, animState, source }));
    } catch (e) {
      // The resolveVars plugin throws through svgo; surface its message, not a stack.
      const m = /unresolved var\([^)]*\)[^;\n]*/.exec(e.message);
      if (m) {
        throw new FavconError(
          `${m[0]} in ${name} - supply it with --var name=value` +
          (icon ? '' : ', or drop the animation with --no-animation'),
        );
      }
      throw new FavconError(`svgo failed on ${name}: ${e.message}`);
    }
    if (!result.data) throw new FavconError(`optimising ${name} produced an empty file`);
    return { data: result.data, stripped: animState.stripped };
  }


  return { optimiseSvg };
};

// ============================================================== the options ==

export const normaliseVars = (vars) => {
  const map = new Map();
  const entries = vars instanceof Map ? vars.entries() : Object.entries(vars ?? {});
  for (const [rawName, value] of entries) {
    const name = String(rawName).trim().startsWith('--') ? String(rawName).trim() : '--' + String(rawName).trim();
    if (!/^--[\w-]+$/.test(name)) throw new FavconError(`--var name must be a CSS custom property, got '${name}'`);
    map.set(name, String(value));
  }
  return map;
};

// =================================================================== the ICO ==

/**
 * A 22-byte directory plus the PNG verbatim, byte-identical to `icotool -c -r` on every build
 * it was checked against.
 *
 * Uint8Array and DataView rather than Buffer, so the website can write an ICO too. Buffer is a
 * Uint8Array, so a Node caller may still pass one in.
 *
 * wBitCount is the field to get wrong. Across the corpus the payload IHDR was 2/3, 4/3, 8/3 or
 * 8/6 - four different bit-depth/colour-type pairs - and icotool wrote wPlanes=1, wBitCount=32
 * for every one of them. The directory entry describes the DECODED 32-bit image, not the
 * encoding, so deriving it from the IHDR produces a file icotool never writes. Same for
 * bColorCount=0 on a genuinely paletted payload.
 */
export const icoWrap = (png, px) => {
  if (!Number.isInteger(px) || px < 1 || px > 256) {
    throw new FavconError(`an ICO entry must be 1-256 px, got ${px}`);
  }
  const src = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // The directory says how big the image is, so check rather than trust: an ICO whose header
  // disagrees with its payload decodes at the wrong size in some viewers and not at all in
  // others. IHDR is always the first chunk, so width and height sit at a fixed offset. This is
  // what caught resvg preserving the aspect ratio of a non-square source - the payload was
  // 32x16 and the header would have claimed 32x32.
  if (png.length < 24 || src.getUint32(1) !== 0x504e470d) {
    throw new FavconError('ICO payload is not a PNG');
  }
  const w = src.getUint32(16), h = src.getUint32(20);
  if (w !== px || h !== px) {
    throw new FavconError(`ICO payload is ${w}x${h}, expected ${px}x${px}`);
  }
  const out = new Uint8Array(22 + png.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true);            // idReserved
  dv.setUint16(2, 1, true);            // idType: 1 = icon
  dv.setUint16(4, 1, true);            // idCount
  out[6] = px & 0xff;                  // bWidth  - 256 is stored as 0, hence the mask
  out[7] = px & 0xff;                  // bHeight - likewise
  out[8] = 0;                          // bColorCount: 0 even for a paletted payload
  out[9] = 0;                          // bReserved
  dv.setUint16(10, 1, true);           // wPlanes
  dv.setUint16(12, 32, true);          // wBitCount: the decoded image, always 32
  dv.setUint32(14, png.length, true);  // dwBytesInRes
  dv.setUint32(18, 22, true);          // dwImageOffset: straight after this directory
  out.set(png, 22);
  return out;
};

// ============================================================= the masked icon ==

/**
 * How far the mark reaches from the centre of its (square) icon, from a transparent render.
 *
 * `radius` is the distance of the farthest opaque pixel's OUTER corner, as a fraction of the
 * icon width, so the whole pixel lands inside the zone rather than just its centre. Takes
 * DECODED pixels, not a PNG: the CLI decodes resvg's output with node:zlib and the website
 * with the same WASM codec it renders through, so neither has to carry the other's reader.
 * `scale`
 * is what icon.svg has to be multiplied by for that pixel to sit exactly on the safe circle:
 * the mark fills the zone, in both directions - a mark drawn small is enlarged, because on a
 * maskable icon its own margin means nothing (the platform's shape is the frame).
 *
 * A source that is opaque in all four corners is already full-bleed - a background drawn
 * into the mark on purpose - and is used as it is: scaling it would shrink the author's own
 * ground into a square sitting on --bg, which is never what a full-bleed mark wants.
 */
export const maskableFit = ({ width: W, height: H, rgba }) => {
  const alpha = (x, y) => rgba[(y * W + x) * 4 + 3];
  const cx = W / 2, cy = H / 2;
  let r2 = 0, any = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha(x, y) === 0) continue;
      any = true;
      const dx = Math.max(Math.abs(x - cx), Math.abs(x + 1 - cx));
      const dy = Math.max(Math.abs(y - cy), Math.abs(y + 1 - cy));
      const d = dx * dx + dy * dy;
      if (d > r2) r2 = d;
    }
  }
  if (!any) throw new FavconError('icon.svg renders nothing, so there is no mark to fit into the safe zone');
  const fullBleed = alpha(0, 0) > 0 && alpha(W - 1, 0) > 0 && alpha(0, H - 1) > 0 && alpha(W - 1, H - 1) > 0;
  const radius = Math.sqrt(r2) / W;
  return { radius, fullBleed, scale: fullBleed ? 1 : MASK_SAFE_RADIUS / radius };
};

/**
 * icon.svg drawn as a `box`-pixel square, centred in a `canvas`-pixel one. Both are even, so
 * the offset is a whole pixel and a mark that is crisp at `box` stays crisp in the canvas. The
 * inner <svg> keeps its own viewBox; for a non-square source, the square width/height and
 * preserveAspectRatio="none" that make its box authoritative are replaced by this placement,
 * which is square too. The ground is not drawn: it is resvg's --background, so the wrapper
 * adds no bytes to the PNG.
 */
export const nestForMask = (iconData, box, canvas) => {
  const off = (canvas - box) / 2;
  const inner = iconData
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, '')
    .replace(/<svg\b([^>]*)>/i, (m, attrs) =>
      `<svg${attrs.replace(/\s(?:x|y|width|height)\s*=\s*"[^"]*"/gi, '')} x="${off}" y="${off}" width="${box}" height="${box}">`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas} ${canvas}">${inner}</svg>`;
};

const partialAlpha = (rgba) => {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0 && rgba[i] !== 255) n++;
  return n;
};

/**
 * Where the mark goes in a masked icon of `canvas` px, decided on renders at that size, so the
 * snap is to that icon's own pixels. `render(svgText, px)` must
 * return { width, height, rgba } for `svgText` at px x px; favcon passes resvg plus its own
 * decoder, the website passes resvg-wasm plus its, the test suite passes
 * the same resvg for its reference, so the two can never place the mark differently.
 *
 * Two steps. The FIT scales the mark until its farthest opaque pixel sits on the safe circle
 * (maskableFit). The SNAP then walks the box size down in whole even pixels, no further than
 * SNAP_WINDOW, looking for the size where the mark renders with the fewest partly transparent
 * pixels - which for a mark drawn on a pixel grid is a size with none at all. A smaller box is
 * only taken when it at least halves them, so a curved mark, which is anti-aliased at every
 * size, is not shrunk for nothing.
 *
 * Returns { svg, box, scale, snapped, radius, fullBleed, padding }; `scale` is box / canvas
  * and `padding` is the per-side margin actually used, as a percentage - a number even when
  * `auto` chose it, so callers can report what the measurement decided.
 */
export const placeInSafeZone = async (iconData, render, canvas, padding = 'auto') => {
  if (!Number.isInteger(canvas) || canvas < 2 || canvas % 2) {
    throw new FavconError(`internal error: a masked icon's size must be an even pixel count, got ${canvas}`);
  }
  const even = (n) => n - (n % 2);

  // An explicit padding is a promise, not a hint: it is applied literally and never snapped.
  // Snapping exists to find a crisper size NEAR the measured fit; moving a number the caller
  // chose would make --padding mean something different from what it says.
  if (padding !== 'auto') {
    const box = Math.max(2, even(Math.floor(canvas * (1 - 2 * padding / 100))));
    return {
      svg: nestForMask(iconData, box, canvas), box, scale: box / canvas,
      snapped: false, radius: null, fullBleed: false, padding,
    };
  }

  const fit = maskableFit(await render(iconData, canvas));
  if (fit.fullBleed) {
    return { svg: iconData, box: canvas, scale: 1, snapped: false, radius: fit.radius, fullBleed: true, padding: 0 };
  }
  // Not capped at the canvas: a mark drawn small gets a box wider than the icon, and only its
  // own transparent margin falls outside - the fit has already put every opaque pixel inside.
  const exact = even(Math.floor(fit.scale * canvas));
  const baseline = partialAlpha((await render(iconData, exact)).rgba);
  let box = exact;
  if (baseline > 0) {
    let best = { box: exact, n: baseline };
    for (let b = exact - 2; b >= Math.ceil(exact * SNAP_WINDOW); b -= 2) {
      const n = partialAlpha((await render(iconData, b)).rgba);
      if (n < best.n) best = { box: b, n };
      if (n === 0) break;                 // the largest crisp size: nothing below can beat it
    }
    if (best.n * 2 <= baseline) box = best.box;
  }
  return {
    svg: nestForMask(iconData, box, canvas), box, scale: box / canvas,
    snapped: box !== exact, radius: fit.radius, fullBleed: false,
    padding: (1 - box / canvas) / 2 * 100,
  };
};

// ===================================================================== links ==

/**
 * The `<link>` block, in one place. The Astro integration imports this rather than keeping
 * its own copy: it needs the tags in astro:config:setup, before any build has run, and two
 * copies of the `sizes="32x32"` rule is exactly the kind of thing that drifts apart.
 */
export const linkTags = (base = '/', manifest = false) =>
  // sizes="32x32" on the ICO stops Chrome preferring it over the SVG. logo.svg is not
  // linked: it is the mark for pages and READMEs, not a favicon candidate.
  `<link rel="icon" href="${base}favicon.ico" sizes="${ICO_SIZE}x${ICO_SIZE}">\n` +
  `<link rel="icon" href="${base}icon.svg" type="image/svg+xml">\n` +
  `<link rel="apple-touch-icon" href="${base}apple-touch-icon.png">\n` +
  (manifest ? `<link rel="manifest" href="${base}site.webmanifest">\n` : '');

// ============================================================= the square box ==

/**
 * Every icon slot on every platform is square, so the output has to be. resvg does NOT stretch
 * to fill when handed both -w and -h: measured on 0.48.1, a 128x64 viewBox rendered with
 * `-w 32 -h 32` comes out 32x16, because the aspect ratio wins and the second dimension is
 * derived. That silently produced non-square rasters and an ICO whose directory disagreed with
 * its own payload.
 *
 * Both halves are needed. The renderer takes the output size from the SVG's INTRINSIC size -
 * its width/height, falling back to the viewBox - and -w/-h only scale that, so a lone
 * preserveAspectRatio still renders 32x16. removeDimensions has just deleted the width/height,
 * so a square pair is put back explicitly; with the box square and the aspect ratio free, the
 * renderer fills it.
 *
 * It goes on icon.svg rather than on a private copy, so the SVG favicon and the PNGs frame the
 * mark the same way. logo.svg does not get it: that one is the mark for pages and READMEs,
 * where its real proportions are the right ones.
 *
 * Returns { data, warning }; `warning` is null when the source was already square.
 */
export const squareIconSvg = (iconData) => {
  const vb = /\bviewBox\s*=\s*"([^"]*)"/.exec(iconData);
  if (!vb) return { data: iconData, warning: null };
  const [, , w, h] = vb[1].trim().split(/[\s,]+/).map(Number);
  if (!(w > 0 && h > 0 && (w / h > 1.01 || h / w > 1.01))) return { data: iconData, warning: null };
  const box = Math.max(w, h);
  return {
    data: iconData.replace(/<svg\b/, `<svg width="${box}" height="${box}" preserveAspectRatio="none"`),
    warning: `viewBox ${w}x${h} is not square; icon.svg and the rasters stretch it to fit `
           + `(logo.svg keeps the original proportions)`,
  };
};

// ================================================================== manifest ==

/**
 * site.webmanifest, icons only unless the caller has a name to add.
 *
 * Written by hand rather than with JSON.stringify(..., 2), which puts every key of every icon
 * on its own line; one entry per line is far easier to read and to diff.
 *
 * "any" and "maskable" are different files on purpose: one icon declared for both is either
 * padded (and sits as a small tile on a desktop that does not mask) or not (and is cropped
 * under a mask), and web.dev's guidance is not to combine them. icon.svg is never listed: an
 * SVG entry breaks Android's WebAPK install (crbug.com/40925759).
 */
export const manifestJson = ({ sizes, base = '/', maskable = false, extra = null }) => {
  const head = extra && typeof extra === 'object'
    ? Object.entries(extra).filter(([k]) => k !== 'icons')
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join('')
    : '';
  const entry = (s, name, purpose) =>
    `    { "src": "${base}${name}", "sizes": "${s}x${s}", "type": "image/png"` +
    `${purpose ? `, "purpose": "${purpose}"` : ''} }`;
  const entries = [
    ...sizes.map((s) => entry(s, `icon-${s}.png`, null)),
    ...(maskable ? [entry(MASKABLE_SIZE, `icon-maskable-${MASKABLE_SIZE}.png`, 'maskable')] : []),
  ];
  return `{\n${head}  "icons": [\n${entries.join(',\n')}\n  ]\n}\n`;
};
