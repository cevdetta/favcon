// The favicon set as bytes: the svgo stage, the safe-zone placement, one raster job per
// distinct (svg, size, ground), the ICO, the manifest and the <link> block. No filesystem, no
// spawning: the host injects the engine and the svgo stage, writes the files, and owns the
// atomic move. The CLI, the integrations and the website run this same file.
import {
  APPLE_SIZE, FavconError, ICO_SIZE, icoWrap, linkTags, manifestJson, placeInSafeZone, squareIconSvg,
} from './core.mjs';

const text = (s) => new TextEncoder().encode(s);

export async function buildSet(source, o, { engine, optimiseSvg, name = 'input.svg', warn = () => {} }) {
  if (!/<svg[\s>]/i.test(source)) throw new FavconError(`not an SVG (no <svg> element found): ${name}`);

  // The icon pass runs first so that, if the logo pass then fails on a var() only its
  // animation uses, the build already knows --no-animation would have worked.
  const optimise = (icon) => optimiseSvg(source, { icon, vars: o.vars, name });
  const iconOut = optimise(true);
  const animated = o.animation && iconOut.stripped > 0;
  // No animation in the source means the two passes describe the same mark, so logo.svg is
  // a copy of icon.svg rather than a second optimisation that differs in small ways.
  const logoData = animated ? optimise(false).data : iconOut.data;

  if (o.bg !== null) {
    let ground;
    try { ground = await engine.probe(o.bg); } catch {
      throw new FavconError(
        `--bg is not a colour resvg accepts: '${o.bg}'\n` +
        `       try a hex value (#fff, #ffffff), an SVG colour name, rgb()/hsl(), or 'none'`,
      );
    }
    // Parsing proves nothing about opacity: transparent, rgba(..., 0) and 8-digit hex parse.
    // The padded icons are declared "any maskable" and the apple icon is composited by iOS, so
    // a ground with alpha would ship icons that break both.
    if (ground[3] !== 255) {
      throw new FavconError(
        `--bg must be opaque: '${o.bg}' has transparency, and the padded icons are declared ` +
        `maskable\n       use --bg none for a transparent, unpadded set`,
      );
    }
  }

  const squared = squareIconSvg(iconOut.data);
  if (squared.warning) warn(squared.warning);
  const iconData = squared.data;

  // Placement is measured on transparent renders at each icon's own size.
  const place = async (canvas) => {
    const { svg, ...where } = await placeInSafeZone(iconData, engine.renderRgba, canvas, o.padding);
    return { svg, fit: { ...where, canvas } };
  };
  const apple = await place(APPLE_SIZE);
  // --bg none keeps the set transparent and unpadded: a maskable icon must be opaque.
  const padded = o.bg !== null;
  const icons = {};
  for (const s of o.sizes) icons[s] = padded ? await place(s) : null;
  const fit = { apple: apple.fit, icons: Object.fromEntries(o.sizes.map((s) => [s, icons[s]?.fit ?? null])) };

  // One job per distinct (svg, size, ground): the padded icon-32.png and the unpadded ICO
  // payload are two jobs, and --sizes 180 shares the apple icon's job.
  const jobs = new Map();
  const want = (px, bg, file, svg) => {
    const key = `${svg}\0${px}\0${bg ?? ''}`;
    const job = jobs.get(key) ?? { px, bg, svg, files: [] };
    job.files.push(file);
    jobs.set(key, job);
  };
  const ICO = '\0ico';
  want(APPLE_SIZE, o.bg, 'apple-touch-icon.png', apple.svg);
  for (const s of o.sizes) want(s, o.bg, `icon-${s}.png`, icons[s]?.svg ?? iconData);
  want(ICO_SIZE, null, ICO, iconData);

  const png = new Map();
  // One job at a time (decision 13) until decision 27 measures the parallel version.
  for (const job of jobs.values()) {
    const raw = await engine.render(job.svg, job.px, job.bg);
    const out = await engine.finish(await engine.encode(raw, { colors: o.colors }), { iterations: o.iterations });
    for (const f of job.files) png.set(f, out);
  }

  const files = [
    { name: 'logo.svg', bytes: text(logoData) },
    { name: 'icon.svg', bytes: text(iconData) },
    { name: 'favicon.ico', bytes: icoWrap(png.get(ICO), ICO_SIZE) },
    { name: 'apple-touch-icon.png', bytes: png.get('apple-touch-icon.png') },
    ...o.sizes.map((s) => ({ name: `icon-${s}.png`, bytes: png.get(`icon-${s}.png`) })),
  ];
  if (o.manifest) {
    files.push({
      name: 'site.webmanifest',
      bytes: text(manifestJson({
        sizes: o.sizes, base: o.base, purpose: padded ? 'any maskable' : null,
        extra: typeof o.manifest === 'object' ? o.manifest : null,
      })),
    });
  }
  return { files, animated, fit, links: linkTags(o.base, Boolean(o.manifest)) };
}
