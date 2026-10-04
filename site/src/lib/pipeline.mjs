// The browser's build(). Same SVG stage as the CLI, a different raster stage, and honest about
// which is which.
//
// What is shared, by importing lib/core.mjs rather than copying it:
//
//   * the four svgo plugins and the whole plugin list, via createSvgStage. svgo's browser build
//     exports the same `optimize` and `builtinPlugins`, so icon.svg and logo.svg come out
//     byte-identical to the CLI's.
//   * squareIconSvg, so a non-square mark is boxed the same way
//   * placeInSafeZone, so the mark lands in the same place in the padded icons, including the
//     snap to whole pixels, or the caller's explicit padding
//   * icoWrap, manifestJson, linkTags
//
// What is not, and cannot be: resvg, pngquant and oxipng are binaries. Their WASM substitutes
// are different programs, and one difference dominates: @jsquash/oxipng exposes no zopfli, and
// zopfli is where most of the CLI's byte advantage comes from. So the PNGs here are LARGER than
// the CLI's and are not reproducible against it. The page says so; this comment is here so that
// nobody later mistakes the divergence for a bug and "fixes" it by loosening the CLI.

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url';
import { optimise as oxipng } from '@jsquash/oxipng';
import { decode as decodePng, encode as encodePng } from '@jsquash/png';
import { applyPalette, buildPalette, utils } from 'image-q';
import { builtinPlugins, optimize } from 'svgo/browser';

import {
  APPLE_SIZE, createSvgStage, DEFAULT_BG, DEFAULT_COLORS, DEFAULT_SIZES, FavconError, ICO_SIZE,
  icoWrap, linkTags, manifestJson, placeInSafeZone, squareIconSvg,
} from '../../../lib/core.mjs';
import { zip } from './zip.mjs';

const { optimiseSvg } = createSvgStage({ optimize, builtinPlugins });

// oxipng's top level. 6 is its `-o max`; there is no --zopfli here, which is the whole reason
// these PNGs are bigger than the CLI's.
const OXIPNG = { level: 6, interlace: false, optimiseAlpha: true };

let wasmReady;
const ready = () => (wasmReady ??= initWasm(fetch(resvgWasmUrl)));

/**
 * Start fetching and compiling the 2.4 MB resvg WASM before the first render asks for it, so
 * the page can overlap it with the visitor choosing options. A failure is not swallowed: the
 * rejected promise is what the first render awaits, and that is where it gets reported.
 */
export const warm = () => { ready().catch(() => {}); };

/** resvg at px x px. icon.svg is always square by the time it gets here, so width is enough. */
const render = async (svgText, px, background) => {
  await ready();
  const image = new Resvg(svgText, {
    fitTo: { mode: 'width', value: px },
    background: background ?? 'rgba(0,0,0,0)',
  }).render();
  return image;
};

/**
 * Decoded pixels for the safe-zone maths. resvg-wasm hands back the raster itself, so unlike
 * the CLI (which has to read resvg's PNG back with node:zlib) there is nothing to decode.
 */
const renderRgba = async (svgText, px) => {
  const image = await render(svgText, px, null);
  const rgba = image.pixels ?? new Uint8Array((await decodePng(image.asPng())).data.buffer);
  return { width: image.width, height: image.height, rgba };
};

/**
 * Quantise, then recompress. The order matters for the same reason it does in the CLI: the
 * quantiser re-encodes from scratch, so anything done before it is discarded.
 *
 * Two candidates, smaller wins: the quantised one and the untouched one. The CLI runs three
 * (it also has Floyd-Steinberg), but image-q's dithering is not pngquant's and adding a third
 * arm here would imply a correspondence that does not exist.
 */
const encodeRaster = async (image, colors) => {
  const width = image.width, height = image.height;
  const rgba = image.pixels ?? new Uint8Array((await decodePng(image.asPng())).data.buffer);

  const lossless = new Uint8Array(await oxipng(image.asPng(), OXIPNG));

  let quantised = null;
  try {
    const point = utils.PointContainer.fromUint8Array(rgba, width, height);
    // "pngquant" here names image-q's colour-distance formula, not the program: it is image-q's
    // closest approximation, and it is still a different quantiser.
    const palette = await buildPalette([point], {
      colors, colorDistanceFormula: 'pngquant', paletteQuantization: 'wuquant',
    });
    const applied = await applyPalette(point, palette, { colorDistanceFormula: 'pngquant' });
    const out = applied.toUint8Array();
    const png = await encodePng(new ImageData(
      new Uint8ClampedArray(out.buffer, out.byteOffset, out.byteLength), width, height));
    quantised = new Uint8Array(await oxipng(png, OXIPNG));
  } catch {
    // A mark with fewer distinct colours than the palette can make the quantiser unhappy; the
    // lossless arm is already a complete answer, as pngquant's exit 98 is in the CLI.
  }

  // Strictly smaller wins, so a tie keeps the quantised one: the same tie-break as the CLI.
  return quantised && quantised.length < lossless.length ? quantised : lossless;
};

/**
 * Build the set. Returns { files: [{name, bytes}], links, animated, fit } and never touches the
 * network beyond the WASM modules themselves.
 */
export async function buildInBrowser(svgText, options = {}) {
  const colors = Number(options.colors ?? DEFAULT_COLORS);
  const sizes = options.sizes ?? DEFAULT_SIZES;
  const bg = options.bg === 'none' ? null : (options.bg ?? DEFAULT_BG);
  const vars = options.vars ?? {};
  const wantManifest = options.manifest !== false;

  // The same messages as the CLI's normalise(): invalid input must fail here, fast, rather
  // than as an "internal error" from the placement maths or a near-empty icon with no message.
  const rawPadding = options.padding ?? 'auto';
  let padding;
  if (rawPadding === 'auto') {
    padding = 'auto';
  } else {
    if (!/^\d+(\.\d+)?$/.test(String(rawPadding))) {
      throw new FavconError(`--padding must be 'auto' or a percentage 0-45, got '${rawPadding}'`);
    }
    padding = Number(rawPadding);
    if (padding < 0 || padding > 45) throw new FavconError("--padding must be 'auto' or a percentage 0-45");
  }
  for (const s of sizes) {
    // Every size is placed in the safe zone with whole-pixel offsets, which needs an even
    // canvas: the same rule as the CLI.
    if (!Number.isInteger(s) || s % 2 !== 0) throw new FavconError(`--sizes takes even pixel sizes, got '${s}'`);
  }

  if (!/<svg[\s>]/i.test(svgText)) {
    throw new FavconError('not an SVG (no <svg> element found)');
  }

  // The CLI's order, step for step: the icon pass first, so a var() used only by an animation
  // cannot fail a build that discards it, and so the logo pass's error can name --no-animation.
  const iconOut = optimiseSvg(svgText, { icon: true, vars });
  const animated = options.animation !== false && iconOut.stripped > 0;
  const logoData = animated ? optimiseSvg(svgText, { icon: false, vars }).data : iconOut.data;

  const squared = squareIconSvg(iconOut.data);
  const iconData = squared.data;

  const files = [
    { name: 'logo.svg', bytes: new TextEncoder().encode(logoData) },
    { name: 'icon.svg', bytes: new TextEncoder().encode(iconData) },
  ];

  // The padded icons, placed by the shared maths so the mark sits where the CLI would put it.
  const place = async (canvas) => {
    const { svg, ...where } = await placeInSafeZone(iconData, renderRgba, canvas, padding);
    return { svg, fit: { ...where, canvas } };
  };
  const padded = bg !== null;

  const apple = await place(APPLE_SIZE);
  files.push({ name: 'apple-touch-icon.png', bytes: await encodeRaster(await render(apple.svg, APPLE_SIZE, bg ?? undefined), colors) });

  const icons = {};
  for (const s of sizes) {
    const placed = padded ? await place(s) : null;
    icons[s] = placed?.fit ?? null;
    files.push({ name: `icon-${s}.png`, bytes: await encodeRaster(await render(placed?.svg ?? iconData, s, bg ?? undefined), colors) });
  }
  // The ICO payload is never padded, so it is its own render even when a size matches.
  files.push({ name: 'favicon.ico', bytes: icoWrap(await encodeRaster(await render(iconData, ICO_SIZE, null), colors), ICO_SIZE) });

  if (wantManifest) {
    files.push({
      name: 'site.webmanifest',
      bytes: new TextEncoder().encode(manifestJson({ sizes, purpose: padded ? 'any maskable' : null })),
    });
  }

  // Emitted in the CLI's order, so the two summaries read the same way.
  const order = ['logo.svg', 'icon.svg', 'favicon.ico', 'apple-touch-icon.png',
                 ...sizes.map((s) => `icon-${s}.png`), 'site.webmanifest'];
  files.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  return {
    files,
    animated,
    fit: { apple: apple.fit, icons },
    links: linkTags('/', wantManifest),
    archive: () => zip(files),
  };
}
