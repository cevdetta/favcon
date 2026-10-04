// The raster stage: render an SVG at N px, encode the smaller of a quantised and a lossless PNG,
// and finish the winner with zopfli. Import-free, like core.mjs: the host passes in
// @napi-rs/image (native in Node, its WASM build in a browser), @gfx/zopfli and an inflate
// function, so the CLI and the website run the same code and produce the same bytes.

// napi's Transformer.fromSvg never renders the longer side below 1000 px: it doubles the
// intrinsic size until it gets there. An outer SVG px wide and at least 1000 tall holds the
// longer side at that floor, and a crop then takes the px x px square from its top. Wrapping
// the content in the viewBox transform reproduced `resvg -w N -h N` on 40 of 40 renders.
const RENDER_FLOOR = 1000;

const ATTR = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g;
// Attributes that place the canvas, which the wrapper replaces. Every other attribute on the
// root (fill, stroke, style, class) is inherited by the content, so it moves onto the wrapper
// group; namespace declarations move onto the outer <svg>.
const CANVAS = new Set(['viewBox', 'width', 'height', 'preserveAspectRatio', 'x', 'y', 'version', 'baseProfile']);

export const wrapForSize = (svgText, px) => {
  const m = /<svg\b([^>]*?)\s*(?:\/>|>([\s\S]*)<\/svg>)\s*$/.exec(svgText);
  if (!m) throw new Error('not an SVG document');
  let box = null;
  const ns = [], carried = [];
  for (const [, k, v] of m[1].matchAll(ATTR)) {
    if (k === 'viewBox') box = v.slice(1, -1).trim().split(/[\s,]+/).map(Number);
    else if (k === 'xmlns') continue;
    else if (k.startsWith('xmlns:')) ns.push(` ${k}=${v}`);
    else if (!CANVAS.has(k)) carried.push(` ${k}=${v}`);
  }
  if (!box || box.length !== 4 || !(box[2] > 0 && box[3] > 0)) {
    throw new Error('icon.svg needs a viewBox to render at a size');
  }
  // Independent x and y scale: icon.svg is square, or stretched on purpose by squareIconSvg's
  // preserveAspectRatio="none", which is what resvg -w N -h N does with it.
  const [x, y, w, h] = box;
  return `<svg xmlns="http://www.w3.org/2000/svg"${ns.join('')} width="${px}" height="${Math.max(px, RENDER_FLOOR)}">` +
    `<g transform="scale(${px / w} ${px / h}) translate(${-x} ${-y})"${carried.join('')}>${m[2] ?? ''}</g></svg>`;
};

// Results can be views over WASM memory, which the next call reuses: own the bytes at once.
const copy = (bytes) => new Uint8Array(bytes);

export const createEngine = ({ image, zopfli, inflate }) => {
  const at = (svgText, px, background) =>
    image.Transformer.fromSvg(wrapForSize(svgText, px), background ?? null).crop(0, 0, px, px);

  return {
    /** A PNG of svgText at px x px. `background` is a colour resvg parses, or absent. */
    render: async (svgText, px, background) => copy(await at(svgText, px, background).png()),

    /** The same render, decoded: what the safe-zone placement measures. */
    renderRgba: async (svgText, px) => ({ width: px, height: px, rgba: copy(await at(svgText, px).rawPixels()) }),

    /** The pixel a ground paints, [r, g, b, a]. Rejects when resvg cannot parse the colour. */
    probe: async (background) => [...copy(await image.Transformer
      .fromSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${RENDER_FLOOR}"></svg>`, background)
      .crop(0, 0, 1, 1).rawPixels())],
  };
};
