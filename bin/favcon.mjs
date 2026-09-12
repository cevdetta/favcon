#!/usr/bin/env node
//
// Build a complete icon set from one SVG.
//
//   logo.svg              the mark itself: optimised, animation intact
//   icon.svg              the same optimisation plus a structural animation strip.
//                         Every raster below is rendered from this file.
//   favicon.ico           32px PNG wrapped in a 22-byte ICO container
//   apple-touch-icon.png  180px on an opaque ground
//   icon-<size>.png       rendered natively at each size
//
// Every step was chosen by measurement, not by habit. The tables are in docs/DECISIONS.md.
// The short version, because these are the parts that look wrong until you know why:
//
//   * resvg cannot read var(). It does not error - it renders the whole mark BLACK with a
//     warning on stderr. So custom properties are resolved before anything is rasterised.
//   * Quantise before recompressing. pngquant re-encodes from scratch, so any order that
//     ends in pngquant throws away everything oxipng did.
//   * An ICO holding a PNG is a 22-byte header plus that PNG verbatim, so nothing can be
//     optimised after packing - the payload has to be final before it goes in.
//   * Zopfli runs once, on the file that already won the lossy/lossless comparison.
//     Running it on both sides costs three times as much for exactly the same bytes.
//   * The rasters are built one at a time ON PURPOSE. Zopfli is ~98% of the wall clock
//     and oxipng already spreads one file across every core, so building the sizes
//     concurrently just makes them contend: traced, the 512px job alone takes 9.1s and
//     the whole serial build 13.1s, while four concurrent jobs finish in 13.6s - the
//     512px job stretches to 13.6s by itself. Four reps each: 13.80s serial, 14.08s
//     concurrent.
//   * icon.svg is the rasteriser's input, not just an output. Animation never reaches a
//     PNG, which makes "the rasters are the rest frame" a property of the pipeline
//     rather than of resvg's CSS support.
//   * resvg does NOT stretch to fill when given both -w and -h. It preserves the aspect
//     ratio and derives the second dimension, so a 128x64 mark rendered at -w 32 -h 32
//     comes out 32x16. Making the box authoritative takes a square intrinsic size AND
//     preserveAspectRatio="none"; see the viewBox block in build().
//   * svgo 4.1.0 both crashes on and silently mangles the animated shape this tool's own
//     input contract requires. Two workarounds, hoistKeyframes and the inlineStyles guard,
//     each documented where it sits.
//
// This file is both the CLI and the library: `build()` throws, `cli()` exits. Nothing
// below the build/cli split writes to stdout, so the Astro integration can call build()
// without a CLI's opinions about output.
//

import { execFile } from 'node:child_process';
import {
  accessSync, constants as FS_CONST, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { builtinPlugins, optimize } from 'svgo';

const execFileAsync = promisify(execFile);

const PROG = 'favcon';
const ICO_SIZE = 32;           // what favicon.ico holds
const APPLE_SIZE = 180;        // 60pt at @3x; no iPhone renders above @3x
const DEFAULT_COLORS = 8;      // NOT the palette that meets the 1.0% accuracy bar - 16 is,
                               // and 8 misses it on the marks with smooth colour ramps
                               // (worst: 1.87% on the deliberately adversarial heavy.svg).
                               // 8 ships anyway because it is ~18% smaller and a flat mark,
                               // which is what a logo usually is, sits far inside the bar at
                               // 8 - `flat.svg` scores 0.10%. Raising it is one flag and the
                               // table in docs/BENCHMARKS.md says when to. Decision 19.
const DEFAULT_SIZES = [192, 512];  // 192 rather than 256 so the manifest carries the token
                               // Chrome's installability check matches - without a 192
                               // entry a PWA install prompt may never appear. 512 is the
                               // splash/store size. Anything else is one --sizes away.
const DEFAULT_BG = '#000000';  // the ground under apple-touch-icon. iOS composites a
                               // transparent Home Screen icon onto black, so black is what
                               // the platform would have done anyway - the difference is
                               // that the alpha channel goes away and the file gets smaller.
const ZOPFLI_ITERATIONS = 120; // measured over the corpus: 79665 B at the default 15,
                               // 79454 at 60, 79386 at 120. The curve is flattening hard
                               // (-0.27%, then -0.09%) but bytes ship forever and build
                               // time does not, so the knee is taken on the byte side.

const IS_WINDOWS = process.platform === 'win32';
const HERE = dirname(fileURLToPath(import.meta.url));

/** Every error a caller is meant to handle. Carries a message, never a stack for the user. */
export class FavconError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FavconError';
  }
}

// =============================================================== CSS helpers ==
// Four scanners shared by the var() resolver and the animation strip. They are hand-written
// rather than delegated to a CSS parser because they run on attribute values too, where
// there is no stylesheet to parse - and because svgo's own parser is not on the public API.

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
// Plain objects in the same file as everything else. They used to be ~110 lines of
// String.raw written to a temp config directory and run through the svgo CLI - which no
// linter, editor or debugger could see into, and which cost two extra node startups and an
// environment-variable channel to pass options in and results back out.

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

// What preset-default actually contains in the svgo that is installed. Asked rather than
// assumed, because the answer differs by major version and getting it wrong is either a
// console.warn on every run or a silently-dropped viewBox - see the two notes below.
const PRESET_PLUGINS = new Set(
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
  if (PRESET_PLUGINS.has('removeViewBox')) overrides.removeViewBox = false;

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
export function optimiseSvg(source, { icon = true, vars = {}, name = 'input.svg' } = {}) {
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

// ============================================================ tool resolution ==
// Replaces `sh -c command -v`, which needed a POSIX shell, could not see node_modules/.bin,
// and stopped at the first missing tool. This reports all of them, in one pass, memoised.

const TOOL_SPECS = {
  resvg: { env: 'FAVCON_RESVG' },
  pngquant: { env: 'FAVCON_PNGQUANT', npm: 'pngquant-bin' },
  oxipng: { env: 'FAVCON_OXIPNG' },
};

const INSTALL_HELP = `  resvg     brew install resvg     |  cargo install resvg
            https://github.com/linebender/resvg/releases
  oxipng    brew install oxipng    |  cargo install oxipng
            https://github.com/oxipng/oxipng/releases
  pngquant  brew install pngquant  |  apt install pngquant  |  https://pngquant.org

None of the three has a usable npm package: the published oxipng wrappers are stuck on
oxipng 4 and 8, neither of which has --zi, so they would silently produce larger files.
Set FAVCON_RESVG / FAVCON_PNGQUANT / FAVCON_OXIPNG to point at a binary directly.`;

/**
 * PATHEXT, in the order worth trying. .EXE and .COM come first even when PATHEXT lists .CMD
 * earlier: node_modules/.bin ships both a real executable and a .cmd shim for the same name,
 * and the shim costs a shell (see `shell` below). Sort is stable, so within a rank the
 * user's own PATHEXT order survives.
 */
const winExts = () => {
  const raw = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((s) => s.trim()).filter(Boolean)
    .map((e) => (e.startsWith('.') ? e : '.' + e));
  return raw.sort((a, b) => (/^\.(exe|com)$/i.test(a) ? 0 : 1) - (/^\.(exe|com)$/i.test(b) ? 0 : 1));
};

const isExecutable = (p) => {
  try { if (!statSync(p).isFile()) return false; } catch { return false; }
  // X_OK is meaningless on Windows - the fs layer answers it from the read-only flag, so it
  // rejects binaries that run perfectly well. There, the extension IS the executable bit.
  if (IS_WINDOWS) return true;
  try { accessSync(p, FS_CONST.X_OK); return true; } catch { return false; }
};

const candidates = (dir, name) =>
  (IS_WINDOWS ? [...winExts().map((e) => name + e), name] : [name]).map((n) => join(dir, n));

/**
 * EVERY match on PATH, in order - not just the first. A shadowing entry that does not run is
 * common enough to design for: `npm run` puts node_modules/.bin at the FRONT of PATH, so a
 * pngquant-bin shim with no downloaded binary hides the working /usr/bin/pngquant behind it.
 * The caller probes candidates in order and takes the first that actually runs.
 */
const findOnPath = (name) => {
  const out = [];
  const entries = (process.env.PATH || '').split(delimiter);
  // CreateProcess searches the current directory first, and spawn() is CreateProcess.
  for (let dir of IS_WINDOWS ? [process.cwd(), ...entries] : entries) {
    if (!dir) continue;
    // Quotes are PATH syntax on Windows ("C:\Program Files\tools"), not part of the name.
    if (IS_WINDOWS) dir = dir.replace(/^"(.*)"$/s, '$1');
    if (!dir) continue;
    for (const c of candidates(dir, name)) if (isExecutable(c)) out.push(c);
  }
  return out;
};

/**
 * Walk up for node_modules/.bin, from the cwd AND from this file. A globally installed
 * favcon does not have the project's .bin on PATH; a locally installed one only does when
 * npm put it there, which is true for `npm run` and false for a bare shell.
 */
const findInNodeModules = (name) => {
  const out = [];
  const seen = new Set();
  for (const start of [process.cwd(), HERE]) {
    let dir = start;
    for (;;) {
      const bin = join(dir, 'node_modules', '.bin');
      if (!seen.has(bin)) {
        seen.add(bin);
        for (const c of candidates(bin, name)) if (isExecutable(c)) out.push(c);
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return out;
};

const fromNpm = async (pkg) => {
  try {
    const m = await import(pkg);
    const p = m.default ?? m;
    // The package can be present with no binary: its postinstall downloads one, and that
    // step is skipped by --ignore-scripts and by npm's blocked-install-scripts default.
    if (typeof p === 'string' && isExecutable(p)) return p;
  } catch { /* an optionalDependency that is simply not installed. Not an error. */ }
  return null;
};

// Node >=18.20.2 refuses to spawn a .cmd or .bat with shell:false (the CVE-2024-27980
// fix), and node_modules/.bin/* on Windows IS a .cmd shim. With shell:true, Node hands
// cmd.exe a single string it builds by joining file and args with spaces, quoting nothing -
// so the quoting is ours to do, on the program path as well as on the arguments.
const cmdQuote = (s) => `"${String(s).replace(/"/g, '""')}"`;

const run = async (tool, args) => {
  const t = (await resolveTools())[tool];
  const shell = t.shell;
  try {
    return await execFileAsync(
      shell ? cmdQuote(t.path) : t.path,
      shell ? args.map(cmdQuote) : args,
      { shell, maxBuffer: 1 << 22, windowsHide: true },
    );
  } catch (e) {
    const err = (e.stderr ? String(e.stderr) : '').trim();
    const firstLine = err.split('\n').find((l) => l.trim()) || e.message;
    const wrapped = new Error(firstLine);
    wrapped.tool = tool;
    // execFile puts the exit status on .code, but a spawn failure puts a string there
    // (ENOENT). pngquant's 98/99 handling must never see a string as a number.
    wrapped.code = typeof e.code === 'number' ? e.code : -1;
    throw wrapped;
  }
};

let toolCache = null;

/**
 * Run `<tool> --version` and return its first line, or null if it did not run.
 *
 * A path on disk is not proof of a working tool, and the difference is not theoretical:
 * pngquant-bin installs `node_modules/.bin/pngquant` as a Node script that execs a binary
 * its postinstall downloads separately - and that postinstall is skipped by
 * --ignore-scripts and by npm's blocked-install-scripts default. The shim is then present,
 * executable, and fails at spawn time with a Node stack trace where a PNG should be.
 *
 * The version string is not a by-product either: the Astro integration's cache is keyed on
 * it, because all three tools change their output bytes across versions and a cache keyed
 * only on the SVG hands back stale files after a `brew upgrade`, invisibly.
 */
const probeVersion = async (path, shell) => {
  try {
    const { stdout, stderr } = await execFileAsync(
      shell ? cmdQuote(path) : path,
      shell ? [cmdQuote('--version')] : ['--version'],
      { shell, maxBuffer: 1 << 20, windowsHide: true },
    );
    const text = (String(stdout) + String(stderr)).trim();
    return text.split('\n')[0].trim() || 'unknown';
  } catch {
    return null;
  }
};

/**
 * Resolve all three binaries once, reporting every missing one rather than the first.
 *
 * Four tiers per tool: a FAVCON_* override, the optional npm package, node_modules/.bin
 * walking upwards, then PATH. Every candidate is probed, and a candidate that does not run
 * falls through to the next tier - which is what lets a machine with a broken pngquant-bin
 * shim still build using the pngquant on PATH. An explicit override is the one exception:
 * it is a hard error, because quietly running a different binary than the one that was
 * named is worse than not running at all.
 */
const resolveTools = async () => {
  if (toolCache) return toolCache;

  const resolveOne = async (name, spec) => {
    const override = process.env[spec.env];
    if (override) {
      if (!isExecutable(override)) throw new FavconError(`${spec.env}=${override} is not an executable file`);
      const shell = IS_WINDOWS && /\.(cmd|bat)$/i.test(override);
      const version = await probeVersion(override, shell);
      if (!version) throw new FavconError(`${spec.env}=${override} could not be run (\`--version\` failed)`);
      return { path: override, shell, version };
    }
    const tiers = [];
    if (spec.npm) tiers.push(await fromNpm(spec.npm));
    tiers.push(...findInNodeModules(name), ...findOnPath(name));
    const seen = new Set();
    for (const path of tiers) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const shell = IS_WINDOWS && /\.(cmd|bat)$/i.test(path);
      const version = await probeVersion(path, shell);
      if (version) return { path, shell, version };
    }
    return null;
  };

  // The three are independent, so the probes overlap: one spawn's latency, not three.
  const names = Object.keys(TOOL_SPECS);
  const settled = await Promise.all(names.map((n) => resolveOne(n, TOOL_SPECS[n])));

  const found = {};
  const missing = [];
  names.forEach((n, i) => { if (settled[i]) found[n] = settled[i]; else missing.push(n); });
  if (missing.length) {
    throw new FavconError(
      `missing ${missing.length === 1 ? 'dependency' : 'dependencies'}: ${missing.join(', ')}\n\n${INSTALL_HELP}`,
    );
  }
  toolCache = found;
  return found;
};

/** Absolute path to a resolved binary. The test suite renders its own references with it. */
export const toolPath = async (name) => (await resolveTools())[name].path;

/** `{ resvg, pngquant, oxipng }` version strings. The Astro cache key needs these. */
export const toolVersions = async () => {
  const t = await resolveTools();
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.version]));
};

// =================================================================== the ICO ==
/**
 * A 22-byte directory plus the PNG verbatim. Byte-identical to `icotool -c -r` on every
 * build it was checked against, which removes the only dependency with no npm package and
 * no Windows build.
 *
 * wBitCount is the field to get wrong. Across the corpus the payload IHDR was 2/3, 4/3, 8/3
 * or 8/6 - four different bit-depth/colour-type pairs - and icotool wrote wPlanes=1,
 * wBitCount=32 for every one of them. The directory entry describes the DECODED 32-bit
 * image, not the encoding, so deriving it from the IHDR produces a file icotool never
 * writes. Same for bColorCount=0 on a genuinely paletted payload.
 */
export const icoWrap = (png, px) => {
  if (!Number.isInteger(px) || px < 1 || px > 256) {
    throw new FavconError(`an ICO entry must be 1-256 px, got ${px}`);
  }
  // The directory says how big the image is, so check rather than trust: an ICO whose
  // header disagrees with its payload decodes at the wrong size in some viewers and not at
  // all in others. IHDR is always the first chunk, so width and height are at a fixed
  // offset. This is what caught resvg preserving the aspect ratio of a non-square source -
  // the payload was 32x16 and the header would have claimed 32x32.
  if (png.length < 24 || png.readUInt32BE(1) !== 0x504e470d) {
    throw new FavconError('ICO payload is not a PNG');
  }
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  if (w !== px || h !== px) {
    throw new FavconError(`ICO payload is ${w}x${h}, expected ${px}x${px}`);
  }
  const dir = Buffer.alloc(22);
  dir.writeUInt16LE(0, 0);            // idReserved
  dir.writeUInt16LE(1, 2);            // idType: 1 = icon
  dir.writeUInt16LE(1, 4);            // idCount
  dir.writeUInt8(px & 0xff, 6);       // bWidth  - 256 is stored as 0, hence the mask
  dir.writeUInt8(px & 0xff, 7);       // bHeight - likewise
  dir.writeUInt8(0, 8);               // bColorCount: 0 even for a paletted payload
  dir.writeUInt8(0, 9);               // bReserved
  dir.writeUInt16LE(1, 10);           // wPlanes
  dir.writeUInt16LE(32, 12);          // wBitCount: the decoded image, always 32
  dir.writeUInt32LE(png.length, 14);  // dwBytesInRes
  dir.writeUInt32LE(22, 18);          // dwImageOffset: straight after this directory
  return Buffer.concat([dir, png]);
};

// ================================================================== staging ==
// Temp directories that must not outlive the process, even on a signal. build() cleans up in
// its own finally; this is the belt to that pair of braces.
const LIVE = new Set();
let sweepRegistered = false;
const sweep = () => {
  for (const d of LIVE) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  LIVE.clear();
};
const registerSweep = () => {
  if (sweepRegistered) return;
  sweepRegistered = true;
  process.on('exit', sweep);
};

// ============================================================== the options ==

const normaliseVars = (vars) => {
  const map = new Map();
  const entries = vars instanceof Map ? vars.entries() : Object.entries(vars ?? {});
  for (const [rawName, value] of entries) {
    const name = String(rawName).trim().startsWith('--') ? String(rawName).trim() : '--' + String(rawName).trim();
    if (!/^--[\w-]+$/.test(name)) throw new FavconError(`--var name must be a CSS custom property, got '${name}'`);
    map.set(name, String(value));
  }
  return map;
};

const normalise = (options) => {
  const o = {
    input: options.input,
    out: options.out ?? '.',
    // Decimal digits only. Number() would accept 0x10, 1e2 and 0b111, which would satisfy
    // the range check while making the "clear message" contract a lie.
    colors: DEFAULT_COLORS,
    sizes: [],
    bg: options.bg === undefined ? DEFAULT_BG : options.bg,
    vars: normaliseVars(options.vars),
    animation: options.animation !== false,
    manifest: options.manifest ?? false,
    // Internal: the Astro integration's fast dev build. Never a CLI flag - the whole point
    // of the tool is that its output is final, and a flag to make it not final is a trap.
    zopfli: options.zopfli !== false,
  };

  const rawColors = options.colors ?? DEFAULT_COLORS;
  if (!/^\d+$/.test(String(rawColors))) throw new FavconError(`--colors must be an integer 2-256, got '${rawColors}'`);
  o.colors = Number(rawColors);
  if (o.colors < 2 || o.colors > 256) throw new FavconError('--colors must be an integer 2-256');

  const rawSizes = options.sizes ?? DEFAULT_SIZES;
  const list = Array.isArray(rawSizes) ? rawSizes : String(rawSizes).trim().split(/[\s,]+/).filter(Boolean);
  for (const s of list) {
    if (!/^\d+$/.test(String(s))) throw new FavconError(`--sizes takes pixel sizes, got '${s}'`);
    const n = Number(s);
    if (n < 1 || n > 8192) throw new FavconError(`--sizes takes pixel sizes 1-8192, got '${s}'`);
    if (!o.sizes.includes(n)) o.sizes.push(n);         // 032 and 32 are the same render
  }
  if (o.sizes.length === 0) throw new FavconError('--sizes is empty');

  if (o.bg === 'none') o.bg = null;

  if (!o.input) throw new FavconError('no input file given');
  if (!existsSync(o.input)) throw new FavconError(`no such file: ${o.input}`);
  if (!statSync(o.input).isFile()) throw new FavconError(`not a file: ${o.input}`);

  if (existsSync(o.out) && !statSync(o.out).isDirectory()) {
    throw new FavconError(`--out exists and is not a directory: ${o.out}`);
  }
  return o;
};

// =================================================================== build() ==

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

/**
 * Build the set. Throws FavconError with a finished message; never exits, never writes to
 * stdout. Returns { files, bytes, animated, links }.
 */
export async function build(options = {}) {
  const o = normalise(options);
  const warn = options.onWarn ?? (() => {});
  const base = options.base ?? '/';

  let source;
  try { source = readFileSync(o.input, 'utf8'); } catch (e) {
    throw new FavconError(`cannot read ${o.input}: ${e.message}`);
  }
  if (!/<svg[\s>]/i.test(source)) {
    throw new FavconError(`not an SVG (no <svg> element found): ${basename(o.input)}`);
  }

  // Before any work: report every missing binary at once, with the install lines.
  await resolveTools();

  registerSweep();
  const tmp = mkdtempSync(join(tmpdir(), `${PROG}.`));
  LIVE.add(tmp);
  let stage = null;
  let outDir = null;

  try {
    // ---- 1. input.svg -> icon.svg + logo.svg ----
    // Both passes are now in-process and synchronous, so they cannot overlap - and no longer
    // need to. The 0.894s -> 0.456s that concurrency used to buy here was two node startups
    // and two svgo module loads, which importing svgo deletes outright. The --bg probe is a
    // resvg SPAWN, so it still has real latency to hide, and it is started first.
    const bgProbe = o.bg === null ? null : (async () => {
      const probeSvg = join(tmp, 'probe.svg');
      writeFileSync(probeSvg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
      await run('resvg', ['--quiet', '--background', o.bg, '-w', '1', '-h', '1', probeSvg, join(tmp, 'probe.png')]);
    })();
    // Node reports an unhandled rejection if this settles before it is awaited below.
    if (bgProbe) bgProbe.catch(() => {});

    const optimise = (icon) => optimiseSvg(source, { icon, vars: o.vars, name: basename(o.input) });

    // The icon pass runs first so that, if the logo pass then fails on a var() only its
    // animation uses, we already know --no-animation would have worked.
    const iconOut = optimise(true);
    const animated = o.animation && iconOut.stripped > 0;
    // No animation in the source means the two passes describe the same mark. logo.svg is
    // then a copy of icon.svg rather than a second, subtly different optimisation of it.
    const logoData = animated ? optimise(false).data : iconOut.data;

    if (bgProbe) {
      try { await bgProbe; } catch {
        throw new FavconError(
          `--bg is not a colour resvg accepts: '${o.bg}'\n` +
          `       try a hex value (#fff, #ffffff, #ffffffff), an SVG colour name, ` +
          `rgb()/rgba()/hsl(), or 'none'`,
        );
      }
    }

    // The SVG stage succeeded, so it is now safe to touch the output directory. Deferring
    // this is what keeps a run that fails on an unresolvable var() from leaving one behind.
    try { mkdirSync(o.out, { recursive: true }); } catch (e) {
      throw new FavconError(`cannot create output directory ${o.out}: ${e.message}`);
    }
    outDir = realpathSync(o.out);
    // Stage inside $out so the final move is a same-filesystem rename, which is atomic.
    try { stage = mkdtempSync(join(outDir, `.${PROG}.`)); } catch (e) {
      throw new FavconError(`cannot create a staging directory in ${outDir}: ${e.message}`);
    }
    LIVE.add(stage);

    const iconSvg = join(stage, 'icon.svg');
    writeFileSync(join(stage, 'logo.svg'), logoData);

    // Every icon slot on every platform is square, so the output has to be. resvg does NOT
    // stretch to fill when handed both -w and -h: measured on 0.48.1, a 128x64 viewBox
    // rendered with `-w 32 -h 32` comes out 32x16, because the aspect ratio wins and the
    // second dimension is derived. That silently produced non-square rasters and an ICO
    // whose directory disagreed with its own payload. preserveAspectRatio="none" is what
    // makes the box authoritative, and it goes on icon.svg rather than on a private copy so
    // that the SVG favicon and the PNGs frame the mark the same way. logo.svg does not get
    // it: that one is the mark for pages and READMEs, where its real proportions are right.
    let iconData = iconOut.data;
    const vb = /\bviewBox\s*=\s*"([^"]*)"/.exec(iconData);
    if (vb) {
      const [, , w, h] = vb[1].trim().split(/[\s,]+/).map(Number);
      if (w > 0 && h > 0 && (w / h > 1.01 || h / w > 1.01)) {
        warn(`viewBox ${w}x${h} is not square; icon.svg and the rasters stretch it to fit ` +
             `(logo.svg keeps the original proportions)`);
        // Both halves are needed. resvg derives the output size from the SVG's INTRINSIC
        // size - its width/height, falling back to the viewBox - and `-w`/`-h` only scale
        // that, so a lone preserveAspectRatio still renders 32x16. removeDimensions has
        // just deleted the width/height, so a square pair is put back explicitly; with the
        // box square and the aspect ratio free, resvg fills it.
        const box = Math.max(w, h);
        iconData = iconData.replace(/<svg\b/,
          `<svg width="${box}" height="${box}" preserveAspectRatio="none"`);
      }
    }
    writeFileSync(iconSvg, iconData);


    // ---- 2. icon.svg -> a PNG at size N ----
    // Three candidates, compared by size:
    //   * no dither  - smallest on this corpus, and still inside the accuracy bar
    //   * Floyd-Steinberg - wins on a minority of files; adding it was the single biggest
    //     improvement to the keep-smallest oracle
    //   * no pngquant at all - a guard, not a contender. At --colors 8 it never wins, but
    //     pngquant's palette overhead can exceed what oxipng's own palette reduction
    //     achieves: at --colors 32 the quantised 16px file is 4% LARGER than doing nothing.
    // Only the winner gets the zopfli pass - running it on every candidate costs 3x for
    // exactly the same bytes, because the losers are discarded anyway.
    const renderPng = async ({ px, bg, tag, dests }) => {
      const raw = join(tmp, `raw-${tag}.png`);
      await run('resvg', ['--quiet', '-w', String(px), '-h', String(px),
                          ...(bg ? ['--background', bg] : []), iconSvg, raw]);

      const cands = [];
      for (const [name, dither] of [['nofs', '--nofs'], ['floyd', '--floyd=1']]) {
        const f = join(tmp, `${name}-${tag}.png`);
        try {
          await run('pngquant', ['--force', '--speed', '1', dither, '--colors', String(o.colors),
                                 '--output', f, raw]);
        } catch (e) {
          // Match on the exit CODE, not the message: 98 is "would be larger, skipped" and
          // 99 is "below the quality floor" - both ordinary outcomes for a flat image, and
          // the right response is to fall through to the lossless candidate. Every other
          // code is a real failure (25 = cannot decode, 26 = cannot read, ...) and must not
          // be swallowed - matching on text would catch "cannot decode image" too.
          if (e.code !== 98 && e.code !== 99) throw e;
          continue;
        }
        // -a here as well as in the final pass, so the comparison below is like-for-like:
        // otherwise the winner is chosen on pre-alpha-reduction sizes and may not be the
        // file that would actually have been smallest once -a is applied.
        await run('oxipng', ['-q', '-o', 'max', '-s', '-a', f]);
        cands.push(f);
      }

      const lossless = join(tmp, `lossless-${tag}.png`);
      copyFileSync(raw, lossless);
      await run('oxipng', ['-q', '-o', 'max', '-s', '-a', lossless]);
      cands.push(lossless);

      // Strictly-smaller wins, so a tie keeps the earliest - which is the one that ranked
      // best overall. Ties are common and decode identically; this just makes the choice
      // deterministic rather than incidental to iteration order.
      let winner = cands[0];
      for (const c of cands.slice(1)) if (statSync(c).size < statSync(winner).size) winner = c;

      const final = join(tmp, `final-${tag}.png`);
      copyFileSync(winner, final);
      // --zopfli, not -Z: oxipng 10.0.0 renamed the short form to -z and kept -Z only as an
      // undocumented alias. The long form is the one that is correct on both 9.x and 10.x.
      if (o.zopfli) {
        await run('oxipng', ['-q', '-o', 'max', '-s', '--zopfli', '--zi', String(ZOPFLI_ITERATIONS), '-a', final]);
      }
      for (const d of dests) copyFileSync(final, d);
    };

    // One render per distinct (size, background). --sizes 32 would otherwise rasterise and
    // zopfli the same image twice, once for icon-32.png and once for the ICO payload.
    const icoPng = join(tmp, `ico-${ICO_SIZE}.png`);
    const queue = new Map();
    const want = (px, bg, dest) => {
      const key = `${px}\0${bg ?? ''}`;
      const job = queue.get(key) ?? { px, bg, tag: `${px}-${queue.size}`, dests: [] };
      job.dests.push(dest);
      queue.set(key, job);
    };
    want(APPLE_SIZE, o.bg, join(stage, 'apple-touch-icon.png'));
    for (const s of o.sizes) want(s, null, join(stage, `icon-${s}.png`));
    want(ICO_SIZE, null, icoPng);

    // Serially: see the note at the top of the file. oxipng saturates the machine on one
    // file, so overlapping these only moves the contention around.
    for (const job of queue.values()) await renderPng(job);

    // ---- 3. icon-32.png -> favicon.ico ----
    writeFileSync(join(stage, 'favicon.ico'), icoWrap(readFileSync(icoPng), ICO_SIZE));

    // ---- 4. optional outputs ----
    const files = ['logo.svg', 'icon.svg', 'favicon.ico', 'apple-touch-icon.png',
                   ...o.sizes.map((s) => `icon-${s}.png`)];

    if (o.manifest) {
      // Icons only from the CLI, which cannot know the app's name. The Astro integration
      // can, so `manifest` may also be an object whose keys are merged in ahead of them.
      // Written by hand rather than with JSON.stringify(..., 2), which puts every key of
      // every icon on its own line; one entry per line is far easier to read and to diff.
      const extra = typeof o.manifest === 'object'
        ? Object.entries(o.manifest).filter(([k]) => k !== 'icons')
          .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join('')
        : '';
      const entries = o.sizes.map((s) =>
        `    { "src": "${base}icon-${s}.png", "sizes": "${s}x${s}", "type": "image/png" }`);
      writeFileSync(join(stage, 'site.webmanifest'),
        `{\n${extra}  "icons": [\n${entries.join(',\n')}\n  ]\n}\n`);
      files.push('site.webmanifest');
    }

    // ---- 5. move into place only once everything succeeded ----
    // Post-condition first: every file this run promised must exist and be non-empty.
    // Without this a silently-missing output would simply not appear in the summary and the
    // run would still exit 0. Checking before the first rename also means that if anything
    // is wrong, the previous output set survives untouched.
    for (const f of files) {
      const from = join(stage, f);
      if (!existsSync(from) || statSync(from).size === 0) {
        throw new FavconError(`internal error: ${f} was not produced`);
      }
    }
    // Each rename is atomic (same filesystem). The *set* is not - a signal mid-loop can
    // leave a mix of new and old files - so the window is kept as small as possible by
    // doing all the work first and validating before any of it lands.
    for (const f of files) renameSync(join(stage, f), join(outDir, f));

    const bytes = {};
    for (const f of files) bytes[f] = statSync(join(outDir, f)).size;

    return { files, bytes, animated, dir: outDir, links: linkTags(base, Boolean(o.manifest)) };
  } catch (e) {
    if (e instanceof FavconError) throw e;
    throw new FavconError(e.tool ? `${e.tool} failed: ${e.message}` : e.message);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    LIVE.delete(tmp);
    if (stage) {
      rmSync(stage, { recursive: true, force: true });
      LIVE.delete(stage);
    }
  }
}

// ====================================================================== CLI ==

const die = (msg) => { process.stderr.write(`${PROG}: ${msg}\n`); process.exit(1); };
const warn = (msg) => process.stderr.write(`${PROG}: warning: ${msg}\n`);

const USAGE = `Usage:
  ${PROG} [options] input.svg

Options:
  -o, --out DIR     Output directory (default: current)
      --colors N    Palette size, 2-256 (default: 8). Fine for a flat mark; raise it to 16
                    if yours has gradients or soft shading - see docs/BENCHMARKS.md.
      --sizes LIST  Standalone PNG sizes (default: "192 512"). 192 is the size
                    Chrome's PWA installability check looks for by name.
      --bg COLOR    Opaque ground for apple-touch-icon (default: #000000). "none" keeps it
                    transparent - iOS then composites the icon onto black.
      --var N=V     Set a CSS custom property, e.g. --var c-primary=#0E7C68. Repeatable.
                    Without it, var(--x, fallback) resolves to its fallback, the way a
                    browser resolves an undefined property.
      --no-animation
                    Build logo.svg static too, so it equals icon.svg. Animation never
                    reaches a raster in either mode.
      --manifest    Also write site.webmanifest with the icon entries.
      --html        Print the <link> tags for the generated set.
  -q, --quiet       Suppress the size summary.
  -V, --version     Print version.
  -h, --help        This message.

Long options also take --opt=value. Use -- to end options.

Outputs: logo.svg  icon.svg  favicon.ico  apple-touch-icon.png  icon-<size>.png
         [site.webmanifest]`;

const readVersion = () => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch { return 'unknown'; }
};

export async function cli(argv) {
  const opts = {
    out: '.', colors: DEFAULT_COLORS, sizes: null, bg: DEFAULT_BG, vars: new Map(),
    animation: true, manifest: false, html: false, quiet: false, bgGiven: false,
  };
  let input = null;

  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let inline = null;
    // --opt=value, the GNU spelling. Split on the FIRST '=' only, so --var=c-x=#fff keeps
    // its own name=value pair intact.
    if (flag.startsWith('--') && flag.includes('=')) {
      const eq = flag.indexOf('=');
      inline = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    let consumed = false;
    const need = () => {
      consumed = true;
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) die(`${flag} needs an argument`);
      return argv[++i];
    };

    switch (flag) {
      case '-o': case '--out':   opts.out = need(); break;
      case '--colors':           opts.colors = need(); break;
      case '--sizes':            opts.sizes = need(); break;
      case '--bg':               opts.bg = need(); opts.bgGiven = true; break;
      case '--var': {
        const kv = need();
        const eq = kv.indexOf('=');
        if (eq < 1) die(`--var takes name=value, got '${kv}'`);
        opts.vars.set(kv.slice(0, eq).trim(), kv.slice(eq + 1));
        break;
      }
      case '--no-animation':     opts.animation = false; break;
      case '--manifest':         opts.manifest = true; break;
      case '--html':             opts.html = true; break;
      case '-q': case '--quiet': opts.quiet = true; break;
      case '-V': case '--version': process.stdout.write(`${PROG} ${readVersion()}\n`); return 0;
      case '-h': case '--help':  process.stdout.write(USAGE + '\n'); return 0;
      case '--':
        // End of options, POSIX-style: everything after is an operand, so an input whose
        // name begins with a dash can still be passed.
        for (const rest of argv.slice(i + 1)) {
          if (input !== null) die('only one input file may be given');
          input = rest;
        }
        i = argv.length;
        break;
      default: {
        const a = argv[i];
        if (a.startsWith('-') && a !== '-') { process.stderr.write(USAGE + '\n'); die(`unknown option: ${flag}`); }
        if (input !== null) die('only one input file may be given');
        input = a;
      }
    }
    if (inline !== null && !consumed) die(`${flag} takes no argument, got '${flag}=${inline}'`);
  }

  if (input === null) { process.stderr.write(USAGE + '\n'); process.exit(1); }

  if (!opts.bgGiven) {
    warn(`--bg not given, using ${opts.bg} for apple-touch-icon ` +
         `(iOS composites transparent icons onto black)`);
  }

  // 128 + signal number, the usual convention. In practice a signal usually kills the child
  // first and the exec rejects instead, so treat this as best-effort tidy-up.
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.on(sig, () => { sweep(); process.exit(128 + n); });
  }

  let result;
  try {
    result = await build({
      input, out: opts.out, colors: opts.colors, sizes: opts.sizes ?? DEFAULT_SIZES,
      bg: opts.bg, vars: opts.vars, animation: opts.animation, manifest: opts.manifest,
      onWarn: warn,
    });
  } catch (e) {
    die(e instanceof FavconError ? e.message : (e.tool ? `${e.tool} failed: ${e.message}` : e.message));
  }

  if (!opts.quiet) {
    for (const f of result.files) {
      const note = f !== 'logo.svg' ? ''
        : result.animated ? '  animated' : '  static (no animation in the source)';
      process.stdout.write(`${f.padEnd(22)} ${String(result.bytes[f]).padStart(6)} B${note}\n`);
    }
  }
  if (opts.html) process.stdout.write('\n' + result.links);
  return 0;
}

/**
 * True when this file is the program, false when it was imported. Not import.meta.main,
 * which lands well after the 22.12 engines floor. realpath on both sides so a symlinked
 * bin (which is what npm installs) still matches.
 */
const isEntryPoint = (url) => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch { return false; }
};

if (isEntryPoint(import.meta.url)) await cli(process.argv.slice(2));
