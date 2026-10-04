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

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const chunksOf = (png) => {
  const out = [];
  for (let o = 8; o + 12 <= png.length;) {
    const len = u32(png, o);
    out.push({ type: String.fromCharCode(...png.subarray(o + 4, o + 8)), data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
};
const chunk = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

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

    /**
     * The smaller of a quantised and a lossless encode. A tie keeps the quantised one (the
     * decision-7 guard and tie rule). An explicit palette size turns off napi's quality gate,
     * so this never fails with "quality too low"; speed 1 is its most accurate setting.
     */
    encode: async (png, { colors }) => {
      const [quantised, lossless] = await Promise.all([
        image.pngQuantize(png, { colors, speed: 1, minQuality: 0, maxQuality: 100 }),
        image.losslessCompressPng(png),
      ]);
      return copy(lossless.length < quantised.length ? lossless : quantised);
    },

    /**
     * Re-deflates the image data with zopfli and keeps everything else, row filters included.
     * napi's prebuilt binaries leave zopfli out, so it runs here: within 0.21 % of oxipng's own
     * zopfli on 40 files, with identical decoded pixels. Zero iterations skips it; a result that
     * is not smaller is dropped.
     */
    finish: async (png, { iterations }) => {
      if (!iterations) return png;
      const chunks = chunksOf(png);
      const idat = concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
      const deflated = copy(await zopfli.zlibAsync(await inflate(idat),
        { numiterations: iterations, blocksplitting: true, blocksplittingmax: 15 }));
      if (deflated.length >= idat.length) return png;
      const parts = [SIGNATURE];
      let written = false;
      for (const c of chunks) {
        if (c.type !== 'IDAT') parts.push(chunk(c.type, c.data));
        else if (!written) { parts.push(chunk('IDAT', deflated)); written = true; }
      }
      return concat(parts);
    },
  };
};
