#!/usr/bin/env node
//
// Build a complete icon set from one SVG.
//
//   logo.svg              the mark itself: optimised, animation intact
//   icon.svg              the same optimisation plus a structural animation strip.
//                         Every raster below is rendered from this file.
//   favicon.ico           32px PNG wrapped in a 22-byte ICO container
//   apple-touch-icon.png  180px on an opaque ground, the mark placed in the safe zone: iOS
//   icon-<size>.png       one padded set on the same ground, the mark placed in the safe zone:
//                         the manifest's "any maskable" icons. --bg none keeps them
//                         transparent and unpadded, declared "any" only.
//
// Every step was chosen by measurement, not by habit. The tables are in docs/DECISIONS.md.
// The short version, because these are the parts that look wrong until you know why:
//
//   * resvg cannot read var(). It does not error: it renders the whole mark BLACK with a
//     warning on stderr. So custom properties are resolved before anything is rasterised.
//   * Quantise before recompressing. The quantiser re-encodes from scratch, so any order
//     that ends in quantising throws away everything the recompressor did.
//   * An ICO holding a PNG is a 22-byte header plus that PNG verbatim, so nothing can be
//     optimised after packing. The payload has to be final before it goes in.
//   * Zopfli runs once, on the file that already won the lossy/lossless comparison.
//     Running it on both sides costs three times as much for the same bytes.
//   * The rasters are built one at a time. Decision 13 measured that on the native
//     pipeline, where oxipng spread one file across every core; decision 27 measured it
//     again on the engine, where the largest job bounds any parallel build.
//   * icon.svg is the rasteriser's input, not only an output. Animation never reaches a
//     PNG, which makes "the rasters are the rest frame" a property of the pipeline
//     rather than of resvg's CSS support.
//   * resvg does NOT stretch to fill when given both -w and -h. It preserves the aspect
//     ratio and derives the second dimension, so a 128x64 mark rendered at -w 32 -h 32
//     comes out 32x16. Making the box authoritative takes a square intrinsic size AND
//     preserveAspectRatio="none"; see squareIconSvg in lib/core.mjs.
//   * The masked icons are placed by measurement, not by a padding percentage. The safe zone
//     is a circle of radius 40% of the icon, and what has to sit inside it is the mark's
//     opaque extent, not its viewBox, because most marks carry a margin of their own. So
//     icon.svg is rendered at each masked icon's own size and the farthest opaque pixel
//     decides the scale. Then the scale is snapped DOWN, within 10%, to a size where the mark
//     lands on whole pixels if one exists: at 512px a fitted scale of 0.6465 anti-aliased every
//     edge of a pixel-grid mark and cost 571 B at 12 colours; snapped to 0.625 it is 3 colours
//     and 290 B.
//   * svgo 4.1.0 both crashes on and mangles, without a warning, the animated shape this tool's own
//     input contract requires. Two workarounds, hoistKeyframes and the inlineStyles guard,
//     each documented where it sits.
//
// This file is both the CLI and the library: `build()` throws, `cli()` exits. Nothing
// below the build/cli split writes to stdout, so the Astro integration can call build()
// without a CLI's opinions about output.
//

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { builtinPlugins, optimize } from 'svgo';

// The isomorphic half of favcon, shared verbatim with the website. lib/core.mjs explains why
// it is a second file and what the three seams are.
import {
  createSvgStage, DEFAULT_BG, DEFAULT_COLORS, DEFAULT_SIZES, FAST_ZOPFLI_ITERATIONS, FavconError,
  icoWrap, linkTags, maskableFit, nestForMask, normaliseVars, placeInSafeZone, ZOPFLI_ITERATIONS,
} from '../lib/core.mjs';
import { createEngine } from '../lib/engine.mjs';
import { buildSet } from '../lib/pipeline.mjs';

// Re-exported so the public API is the same as before the split: the Astro
// integration, the test suite and bench/ all import these from here.
export { FavconError, icoWrap, linkTags, maskableFit, nestForMask, placeInSafeZone };

// svgo's Node build. The website hands createSvgStage svgo/browser instead and gets the same
// plugin list, because the list lives in core rather than in either caller.
const { optimiseSvg } = createSvgStage({ optimize, builtinPlugins });
export { optimiseSvg };

// The engine's libraries load on first use, inside build(), so a platform without a prebuilt
// fails with a favcon: message, not an import-time stack trace.
let enginePromise = null;
export const loadEngine = () => (enginePromise ??= (async () => {
  try {
    const [image, zopfli] = await Promise.all([import('@napi-rs/image'), import('@gfx/zopfli')]);
    return createEngine({ image, zopfli, inflate: (bytes) => inflateSync(bytes) });
  } catch (e) {
    enginePromise = null;
    throw new FavconError(
      `the image engine did not load on ${process.platform}-${process.arch}: ${e.message}\n` +
      `       @napi-rs/image ships prebuilt binaries for Linux, macOS, Windows and FreeBSD`,
    );
  }
})());

const require = createRequire(import.meta.url);
/** The engine's package versions: what the bytes depend on, and the Astro cache key's input. */
export const engineVersions = () => ({
  '@napi-rs/image': require('@napi-rs/image/package.json').version,
  '@gfx/zopfli': require('@gfx/zopfli/package.json').version,
});

const PROG = 'favcon';

// =================================================================== the ICO ==
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

const normalise = (options) => {
  const o = {
    input: options.input,
    out: options.out ?? '.',
    // Decimal digits only. Number() would accept 0x10, 1e2 and 0b111, which would satisfy
    // the range check while making the "clear message" contract a lie.
    colors: DEFAULT_COLORS,
    sizes: [],
    padding: 'auto',
    bg: options.bg === undefined ? DEFAULT_BG : options.bg,
    vars: normaliseVars(options.vars),
    animation: options.animation !== false,
    manifest: options.manifest ?? false,
    base: options.base ?? '/',
  };

  const rawColors = options.colors ?? DEFAULT_COLORS;
  if (!/^\d+$/.test(String(rawColors))) throw new FavconError(`--colors must be an integer 2-256, got '${rawColors}'`);
  o.colors = Number(rawColors);
  if (o.colors < 2 || o.colors > 256) throw new FavconError('--colors must be an integer 2-256');

  // 'auto' or a percentage per side. Capped at 45 because 50 leaves no mark at all, and a
  // value that produces an empty icon should be a message rather than a blank PNG.
  const rawPadding = options.padding ?? 'auto';
  if (rawPadding === 'auto') {
    o.padding = 'auto';
  } else {
    if (!/^\d+(\.\d+)?$/.test(String(rawPadding))) {
      throw new FavconError(`--padding must be 'auto' or a percentage 0-45, got '${rawPadding}'`);
    }
    o.padding = Number(rawPadding);
    if (o.padding < 0 || o.padding > 45) throw new FavconError("--padding must be 'auto' or a percentage 0-45");
  }

  const mode = options.mode ?? 'release';
  if (mode !== 'release' && mode !== 'fast') throw new FavconError(`mode must be 'release' or 'fast', got '${mode}'`);
  // zopfli: false is internal: the suite and bench skip the lossless recompression to save
  // time, because it changes bytes and never pixels. Never a CLI flag.
  o.iterations = options.zopfli === false ? 0 : mode === 'fast' ? FAST_ZOPFLI_ITERATIONS : ZOPFLI_ITERATIONS;

  const rawSizes = options.sizes ?? DEFAULT_SIZES;
  const list = Array.isArray(rawSizes) ? rawSizes : String(rawSizes).trim().split(/[\s,]+/).filter(Boolean);
  for (const s of list) {
    if (!/^\d+$/.test(String(s))) throw new FavconError(`--sizes takes pixel sizes, got '${s}'`);
    const n = Number(s);
    if (n < 1 || n > 8192) throw new FavconError(`--sizes takes pixel sizes 1-8192, got '${s}'`);
    // Every size is placed in the safe zone, where the box is rounded down to an even pixel
    // so the offset stays whole. An odd canvas cannot be placed that way, so it is a message
    // here rather than an "internal error" from the placement maths later.
    if (n % 2 !== 0) throw new FavconError(`--sizes takes even pixel sizes, got '${s}'`);
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
 * Build the set. Throws FavconError with a finished message; never exits, never writes to
 * stdout. Returns { files, bytes, animated, fit, links }, where `fit` is
 * { apple, icons: { [size]: fit } } (how the mark was placed in each masked icon), and
 * `icons[s]` is null under --bg none, when that size is transparent and unpadded.
 */
export async function build(options = {}) {
  const o = normalise(options);
  const warn = options.onWarn ?? (() => {});

  let source;
  try { source = readFileSync(o.input, 'utf8'); } catch (e) {
    throw new FavconError(`cannot read ${o.input}: ${e.message}`);
  }
  if (!/<svg[\s>]/i.test(source)) {
    throw new FavconError(`not an SVG (no <svg> element found): ${basename(o.input)}`);
  }

  registerSweep();
  let stage = null;
  try {
    const engine = await loadEngine();
    const set = await buildSet(source, o, { engine, optimiseSvg, name: basename(o.input), warn });

    // The set exists in memory, so it is now safe to touch the output directory: a run that
    // fails on an unresolvable var() or a bad --bg leaves nothing behind.
    try { mkdirSync(o.out, { recursive: true }); } catch (e) {
      throw new FavconError(`cannot create output directory ${o.out}: ${e.message}`);
    }
    const outDir = realpathSync(o.out);
    // Stage inside $out so the final move is a same-filesystem rename, which is atomic.
    try { stage = mkdtempSync(join(outDir, `.${PROG}.`)); } catch (e) {
      throw new FavconError(`cannot create a staging directory in ${outDir}: ${e.message}`);
    }
    LIVE.add(stage);
    for (const f of set.files) writeFileSync(join(stage, f.name), f.bytes);
    const files = set.files.map((f) => f.name);
    // Every promised file must exist and be non-empty before the first rename, so a failure
    // leaves the previous output set untouched.
    for (const f of files) {
      const from = join(stage, f);
      if (!existsSync(from) || statSync(from).size === 0) throw new FavconError(`internal error: ${f} was not produced`);
    }
    // Each rename is atomic; the window between the first and the last is as small as it gets.
    for (const f of files) renameSync(join(stage, f), join(outDir, f));
    const bytes = Object.fromEntries(set.files.map((f) => [f.name, f.bytes.length]));
    return { files, bytes, animated: set.animated, fit: set.fit, dir: outDir, links: set.links };
  } catch (e) {
    if (e instanceof FavconError) throw e;
    throw new FavconError(e.message);
  } finally {
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
      --colors N    Palette size, 2-256 (default: 256, a ceiling: a flat mark still uses
                    only the colours it has). Lower it to trade accuracy for bytes.
      --sizes LIST  Padded PNG sizes, the manifest's "any maskable" icons (default:
                    "192 512", the pair Chrome's install criteria document).
      --bg COLOR    Ground of the padded icons, apple-touch-icon.png (180px) and
                    icon-<size>.png (default: #000000). The mark sits inside the safe
                    zone on it, measured and snapped to whole pixels. "none" keeps
                    the set transparent and unpadded, declared "any" only.
      --padding P   How much of each masked icon is margin, as a percentage per side
                    (default: auto). \`auto\` measures the mark's own extent and snaps it to
                    whole pixels, which is smaller and sharper than any fixed number - see
                    docs/DECISIONS.md decision 20. Give a number to override it.
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
    padding: 'auto',
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
      case '--padding':          opts.padding = need(); break;
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
      case '-V': case '--version': {
        const v = engineVersions();
        process.stdout.write(`${PROG} ${readVersion()} (@napi-rs/image ${v['@napi-rs/image']}, @gfx/zopfli ${v['@gfx/zopfli']})\n`);
        return 0;
      }
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
    warn(`--bg not given, using ${opts.bg} for the padded icons ` +
         `(iOS composites transparent icons onto black)`);
  }

  // 128 + signal number, the common convention.
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.on(sig, () => { sweep(); process.exit(128 + n); });
  }

  let result;
  try {
    result = await build({
      input, out: opts.out, colors: opts.colors, sizes: opts.sizes ?? DEFAULT_SIZES,
      bg: opts.bg, vars: opts.vars, animation: opts.animation, manifest: opts.manifest,
      padding: opts.padding, onWarn: warn,
    });
  } catch (e) {
    die(e.message);
  }

  if (!opts.quiet) {
    for (const f of result.files) {
      let note = '';
      if (f === 'logo.svg') note = result.animated ? '  animated' : '  static (no animation in the source)';
      else if (f === 'apple-touch-icon.png' || f.startsWith('icon-')) {
        const where = f === 'apple-touch-icon.png' ? result.fit.apple : result.fit.icons[Number(f.slice(5, -4))];
        // Under --bg none the size icons are transparent and unpadded, so there is no fit.
        note = !where ? '  transparent, unpadded (--bg none)'
          : where.fullBleed ? '  full-bleed source, used as it is'
          : `  mark at ${where.box}px of ${where.canvas} in the safe zone${where.snapped ? ', on whole pixels' : ''}`;
      }
      process.stdout.write(`${f.padEnd(22)} ${String(result.bytes[f]).padStart(6)} B${note}\n`);
    }
  }
  if (opts.html) process.stdout.write('\n' + result.links);
  return 0;
}

/**
 * True when this file is the program, false when it was imported. Not import.meta.main,
 * which arrived in Node 24.2, after the 24.0 engines floor. realpath on both sides so a symlinked
 * bin (which is what npm installs) still matches.
 */
const isEntryPoint = (url) => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch { return false; }
};

if (isEntryPoint(import.meta.url)) await cli(process.argv.slice(2));
