// The options every host shares: the keys a config file may set, the merge that puts the
// flags (or a plugin's options) over the file and the file over the defaults, and the
// validation build() has always done, minus the filesystem. Imports only core.mjs, so the
// website and the Vite plugin can run it too.
import {
  DEFAULT_BG, DEFAULT_COLORS, DEFAULT_SIZES, FAST_ZOPFLI_ITERATIONS, FavconError, normaliseVars,
  ZOPFLI_ITERATIONS,
} from './core.mjs';

/** Every key a config file may set. Output flags (--html, --quiet) are not options. */
export const CONFIG_KEYS = ['input', 'out', 'colors', 'sizes', 'bg', 'padding', 'vars', 'animation', 'manifest', 'mode', 'base'];

/** Returns its argument. It exists so a config file gets the types of FavconConfig. */
export const defineConfig = (config) => config;

/** The default export of a config file, checked: an object, with known keys only. */
export const checkConfig = (config, source) => {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new FavconError(`${source} must export an object as its default export`);
  }
  const unknown = Object.keys(config).filter((k) => !CONFIG_KEYS.includes(k));
  if (unknown.length) {
    throw new FavconError(
      `${source}: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')}; ` +
      `the options are ${CONFIG_KEYS.join(', ')}`,
    );
  }
  return config;
};

/**
 * defaults, then the config file, then the inline options (flags or a plugin's options). An
 * undefined value is "not given" and never hides a lower layer. vars merge by name, so a flag
 * overrides one property without dropping the file's others. `manifest: true` over a manifest
 * object keeps the object: the flag asks for the file to be written, not for its members to go.
 */
export const resolveOptions = (defaults = {}, file = {}, inline = {}) => {
  const out = { ...defaults };
  for (const layer of [file, inline]) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      if (k === 'vars') out.vars = new Map([...normaliseVars(out.vars), ...normaliseVars(v)]);
      else if (k === 'manifest' && v === true && out.manifest !== null && typeof out.manifest === 'object') continue;
      else out[k] = v;
    }
  }
  return out;
};

/** What build() validates, with no filesystem access. Messages name the CLI flag. */
export const normaliseOptions = (options) => {
  const o = {
    input: options.input,
    out: options.out ?? '.',
    colors: DEFAULT_COLORS,
    sizes: [],
    padding: 'auto',
    bg: options.bg === undefined ? DEFAULT_BG : options.bg,
    vars: normaliseVars(options.vars),
    animation: options.animation ?? true,
    manifest: options.manifest ?? false,
    base: '/',
  };

  // Decimal digits only. Number() would accept 0x10, 1e2 and 0b111, which would satisfy
  // the range check while making the "clear message" contract a lie.
  const rawColors = options.colors ?? DEFAULT_COLORS;
  if (!/^\d+$/.test(String(rawColors))) throw new FavconError(`--colors must be an integer 2-256, got '${rawColors}'`);
  o.colors = Number(rawColors);
  if (o.colors < 2 || o.colors > 256) throw new FavconError('--colors must be an integer 2-256');

  // 'auto' or a percentage per side. Capped at 45 because 50 leaves no mark at all, and a
  // value that produces an empty icon should be a message rather than a blank PNG.
  const rawPadding = options.padding ?? 'auto';
  if (rawPadding !== 'auto') {
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

  // A config file is JavaScript, so a value of the wrong type reaches here as it is, where
  // argv can only ever hand over strings.
  if (typeof o.animation !== 'boolean') throw new FavconError(`animation must be true or false, got '${o.animation}'`);
  if (typeof o.manifest !== 'boolean' && (o.manifest === null || typeof o.manifest !== 'object' || Array.isArray(o.manifest))) {
    throw new FavconError(`manifest must be true, false or an object of manifest members, got '${o.manifest}'`);
  }

  // The prefix of every href in the links and every src in the manifest. A path, because the
  // icons are written next to each other and served from one place; a CDN origin belongs in
  // the page's own <base>, not here.
  const rawBase = options.base ?? '/';
  if (typeof rawBase !== 'string' || /^[a-z][\w+.-]*:/i.test(rawBase) || /^\/\/[^/]/.test(rawBase)) {
    throw new FavconError(`base must be a path such as '/' or '/blog/', got '${rawBase}'`);
  }
  const trimmed = rawBase.replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
  o.base = trimmed ? `/${trimmed}/` : '/';
  return o;
};
