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
//   * The masked icons are placed by measurement, not by a padding percentage. The safe zone
//     is a circle of radius 40% of the icon, and what has to sit inside it is the mark's
//     opaque extent - not its viewBox, because most marks carry a margin of their own. So
//     icon.svg is rendered at each masked icon's own size and the farthest opaque pixel
//     decides the scale. Then the scale is snapped DOWN, within 10%, to a size where the mark
//     lands on whole pixels if one exists: at 512px a fitted scale of 0.6465 anti-aliased every
//     edge of a pixel-grid mark and cost 571 B at 12 colours; snapped to 0.625 it is 3 colours
//     and 290 B.
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
import { inflateSync } from 'node:zlib';
import { builtinPlugins, optimize } from 'svgo';

// The isomorphic half of favcon, shared verbatim with the website. lib/core.mjs explains why
// it is a second file and what the three seams are.
import {
  APPLE_SIZE, createSvgStage, DEFAULT_BG, DEFAULT_COLORS, DEFAULT_SIZES, FavconError, ICO_SIZE,
  icoWrap, linkTags, manifestJson, maskableFit, nestForMask, normaliseVars,
  placeInSafeZone, squareIconSvg, ZOPFLI_ITERATIONS,
} from '../lib/core.mjs';

// Re-exported so the public API is exactly what it was before the split: the Astro
// integration, the test suite and bench/ all import these from here.
export { FavconError, icoWrap, linkTags, maskableFit, nestForMask, placeInSafeZone };

// svgo's Node build. The website hands createSvgStage svgo/browser instead and gets the same
// plugin list, because the list lives in core rather than in either caller.
const { optimiseSvg } = createSvgStage({ optimize, builtinPlugins });
export { optimiseSvg };

const execFileAsync = promisify(execFile);

const PROG = 'favcon';
const IS_WINDOWS = process.platform === 'win32';
const HERE = dirname(fileURLToPath(import.meta.url));

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
    // Internal: the Astro integration's fast dev build. Never a CLI flag - the whole point
    // of the tool is that its output is final, and a flag to make it not final is a trap.
    zopfli: options.zopfli !== false,
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

// ============================================================= the masked icon ==

/**
 * resvg's own PNG: 8-bit RGBA, not interlaced. Anything else reaching this is an internal
 * error, so this is deliberately not a general PNG reader.
 */
const decodeRgba8 = (buf) => {
  if (buf.length < 33 || buf.readUInt32BE(1) !== 0x504e470d) {
    throw new FavconError('internal error: a placement render is not a PNG');
  }
  const idat = [];
  let W = 0, H = 0, ok = false;
  for (let i = 8; i + 8 <= buf.length;) {
    const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { W = data.readUInt32BE(0); H = data.readUInt32BE(4); ok = data[8] === 8 && data[9] === 6 && data[12] === 0; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (!ok) throw new FavconError('internal error: a placement render is not 8-bit RGBA');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * 4, rgba = Buffer.alloc(stride * H);
  let prev = Buffer.alloc(stride), pos = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[pos++], line = rgba.subarray(y * stride, (y + 1) * stride);
    raw.copy(line, 0, pos, pos + stride);
    pos += stride;
    if (f) {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? line[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
        let v = line[i];
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        line[i] = v & 0xff;
      }
    }
    prev = line;
  }
  return { width: W, height: H, rgba };
};

// =================================================================== build() ==

/**
 * Build the set. Throws FavconError with a finished message; never exits, never writes to
 * stdout. Returns { files, bytes, animated, fit, links }, where `fit` is
 * { apple, icons: { [size]: fit } } - how the mark was placed in each masked icon - and
 * `icons[s]` is null under --bg none, when that size is transparent and unpadded.
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

    // The square-box fix and the warning it prints both live in core, so the website applies
    // exactly the same transform to exactly the same marks.
    const squared = squareIconSvg(iconOut.data);
    if (squared.warning) warn(squared.warning);
    const iconData = squared.data;
    writeFileSync(iconSvg, iconData);

    // ---- 1b. the masked icons' placement: measured on renders, never assumed ----
    // A handful of transparent resvg renders at each icon's own size, milliseconds each.
    let renders = 0;
    // placeInSafeZone works in decoded pixels, so the PNG reader stays here: the website
    // supplies its own from the WASM codec it renders with, and neither host carries the
    // other's decoder. decodeRgba8 is just below.
    const renderAt = async (svg, px) => {
      const n = renders++, src = join(tmp, `place-${n}.svg`), png = join(tmp, `place-${n}.png`);
      writeFileSync(src, svg);
      await run('resvg', ['--quiet', '-w', String(px), '-h', String(px), src, png]);
      return decodeRgba8(readFileSync(png));
    };
    const place = async (canvas) => {
      const { svg, ...where } = await placeInSafeZone(iconData, renderAt, canvas, o.padding);
      const file = join(tmp, `masked-${canvas}.svg`);
      writeFileSync(file, svg);
      return { file, fit: { ...where, canvas } };
    };
    const apple = await place(APPLE_SIZE);
    // Every PNG a platform might mask is padded the same way. icon.svg and the ICO payload
    // are not: a tab favicon is never masked, and padding 32px of tab furniture only makes
    // the mark smaller. --bg none keeps them transparent and unpadded, because a maskable
    // icon must be opaque - the spec lets a platform composite a transparent one onto any
    // colour it likes, which would put the mark somewhere the safe zone never promised.
    const padded = o.bg !== null;
    const icons = {};
    for (const s of o.sizes) icons[s] = padded ? await place(s) : null;
    const fit = { apple: apple.fit, icons: Object.fromEntries(o.sizes.map((s) => [s, icons[s]?.fit ?? null])) };

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
    const renderPng = async ({ px, bg, tag, dests, svg }) => {
      const raw = join(tmp, `raw-${tag}.png`);
      await run('resvg', ['--quiet', '-w', String(px), '-h', String(px),
                          ...(bg ? ['--background', bg] : []), svg, raw]);

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

    // One render per distinct (source, size, background). A padded icon-32.png asks for
    // (32, bg) while the ICO payload asks for (32, null), so they are two different renders;
    // identical jobs (e.g. --sizes 180 repeating the apple icon's source and size) share one.
    const icoPng = join(tmp, `ico-${ICO_SIZE}.png`);
    const queue = new Map();
    const want = (px, bg, dest, svg = iconSvg) => {
      const key = `${svg}\0${px}\0${bg ?? ''}`;
      const job = queue.get(key) ?? { px, bg, svg, tag: `${px}-${queue.size}`, dests: [] };
      job.dests.push(dest);
      queue.set(key, job);
    };
    want(APPLE_SIZE, o.bg, join(stage, 'apple-touch-icon.png'), apple.file);
    for (const s of o.sizes) want(s, o.bg, join(stage, `icon-${s}.png`), icons[s]?.file);
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
      // Icons only from the CLI, which cannot know the app's name. The Astro integration can,
      // so `manifest` may also be an object whose keys are merged in ahead of them.
      writeFileSync(join(stage, 'site.webmanifest'), manifestJson({
        sizes: o.sizes, base, purpose: padded ? 'any maskable' : null,
        extra: typeof o.manifest === 'object' ? o.manifest : null,
      }));
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

    return { files, bytes, animated, fit, dir: outDir, links: linkTags(base, Boolean(o.manifest)) };
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
    warn(`--bg not given, using ${opts.bg} for the padded icons ` +
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
      padding: opts.padding, onWarn: warn,
    });
  } catch (e) {
    die(e instanceof FavconError ? e.message : (e.tool ? `${e.tool} failed: ${e.message}` : e.message));
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
 * which lands well after the 22.12 engines floor. realpath on both sides so a symlinked
 * bin (which is what npm installs) still matches.
 */
const isEntryPoint = (url) => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch { return false; }
};

if (isEntryPoint(import.meta.url)) await cli(process.argv.slice(2));
