// The raster engine on its own: render size and fidelity, the colour probe, encode's choice,
// and finish's promise that zopfli changes bytes and never pixels.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { crc32 } from 'node:zlib';

import { loadEngine, optimiseSvg } from '../bin/favcon.mjs';
import { squareIconSvg } from '../lib/core.mjs';
import { createEngine, wrapForSize } from '../lib/engine.mjs';
import { score } from './lib/accuracy.mjs';
import { decode } from './lib/png.mjs';

const FIX = new URL('./fixtures/', import.meta.url);
const icon = (name) =>
  squareIconSvg(optimiseSvg(readFileSync(new URL(`${name}.svg`, FIX), 'utf8'), { icon: true }).data).data;
const scratch = mkdtempSync(join(tmpdir(), 'favcon-engine.'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const engine = await loadEngine();

const haveResvg = (() => {
  try { execFileSync('resvg', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
// The suite's decoder reads Buffers; the engine returns Uint8Arrays.
const dec = (bytes) => decode(Buffer.from(bytes));

describe('render', () => {
  it('renders px x px, below and above the 1000 px floor', async () => {
    for (const px of [16, 32, 180, 512, 1024, 1500]) {
      const img = dec(await engine.render(icon('general'), px));
      assert.deepEqual([img.width, img.height], [px, px], `asked for ${px}`);
    }
  });

  it('carries attributes of the root <svg> onto the content', async () => {
    // Icon sets put fill="none" and the stroke on the root; dropping them changes the mark.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#7c3aed" stroke-width="4"><path d="M2 12h20"/></svg>';
    const img = dec(await engine.render(svg, 24));
    assert.deepEqual(pixel(img, 12, 12), [124, 58, 237, 255], 'the root stroke was lost');
    assert.equal(pixel(img, 12, 3)[3], 0, 'the root fill="none" was lost');
  });

  it('paints the background under the mark', async () => {
    const img = dec(await engine.render('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"/>', 4, '#0e7c68'));
    assert.deepEqual(pixel(img, 0, 0), [14, 124, 104, 255]);
  });

  it('renderRgba returns the decoded pixels of the same render', async () => {
    const svg = icon('general');
    const a = await engine.renderRgba(svg, 64);
    const b = dec(await engine.render(svg, 64));
    assert.deepEqual([a.width, a.height], [64, 64]);
    assert.deepEqual([...a.rgba], [...b.data]);
  });

  it('matches resvg -w N -h N pixel for pixel', { skip: haveResvg ? false : 'resvg not installed' }, async () => {
    for (const name of ['general', 'heavy', 'mask', 'tiles', 'flat', 'gradient', 'wide', 'dark']) {
      for (const px of [32, 192, 512]) {
        const svg = icon(name), src = join(scratch, `${name}.svg`), out = join(scratch, `${name}-${px}.png`);
        writeFileSync(src, svg);
        execFileSync('resvg', ['--quiet', '-w', String(px), '-h', String(px), src, out]);
        const s = score(dec(await engine.render(svg, px)), decode(readFileSync(out)));
        assert.equal(s.pct, 0, `${name}@${px}: ${s.pct} % of pixels differ from resvg`);
      }
    }
  });

  it('refuses an SVG without a viewBox', () => {
    assert.throws(() => wrapForSize('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 32), /viewBox/);
  });
});

describe('probe', () => {
  it('returns the pixel a ground paints', async () => {
    assert.deepEqual(await engine.probe('#ffffff'), [255, 255, 255, 255]);
    assert.deepEqual(await engine.probe('#ffffff80'), [255, 255, 255, 128]);
    assert.deepEqual(await engine.probe('rgb(14 124 104)'), [14, 124, 104, 255]);
  });

  it('rejects a colour resvg cannot parse', async () => {
    await assert.rejects(engine.probe('nonered'));
  });
});

const fakeImage = (q, l, seen = {}) => ({
  pngQuantize: async (png, opts) => { seen.quantize = opts; return q; },
  losslessCompressPng: async () => l,
});

describe('encode', () => {
  it('keeps the smaller encode, and the quantised one on a tie', async () => {
    const q = Uint8Array.of(1, 1, 1), smaller = Uint8Array.of(2, 2), same = Uint8Array.of(3, 3, 3);
    const enc = (a, b) => createEngine({ image: fakeImage(a, b) }).encode(Uint8Array.of(0), { colors: 8 });
    assert.deepEqual(await enc(q, smaller), smaller);
    assert.deepEqual(await enc(q, same), q);
    assert.deepEqual(await enc(smaller, q), smaller);
  });

  it('asks the quantiser for a fixed palette, with no quality gate', async () => {
    const seen = {};
    await createEngine({ image: fakeImage(Uint8Array.of(1), Uint8Array.of(1, 2), seen) })
      .encode(Uint8Array.of(0), { colors: 256 });
    assert.deepEqual(seen.quantize, { colors: 256, speed: 1, minQuality: 0, maxQuality: 100 });
  });

  it('returns a PNG of the same size as its input', async () => {
    const out = dec(await engine.encode(await engine.render(icon('heavy'), 96), { colors: 256 }));
    assert.deepEqual([out.width, out.height], [96, 96]);
  });
});

const chunksValid = (png) => {
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const crc = png.readUInt32BE(o + 8 + len);
    assert.equal(crc32(png.subarray(o + 4, o + 8 + len)), crc, `bad CRC at offset ${o}`);
    o += 12 + len;
  }
};

describe('finish', () => {
  for (const name of ['general', 'gradient', 'tiles']) {
    it(`${name}: the same pixels in no more bytes, with valid chunks`, async () => {
      const enc = await engine.encode(await engine.render(icon(name), 128, '#000000'), { colors: 256 });
      const fin = await engine.finish(enc, { iterations: 15 });
      assert.ok(fin.length <= enc.length, `${fin.length} > ${enc.length}`);
      assert.deepEqual([...dec(fin).data], [...dec(enc).data]);
      chunksValid(Buffer.from(fin));
    });
  }

  it('returns its input untouched at zero iterations', async () => {
    const enc = await engine.encode(await engine.render(icon('flat'), 32), { colors: 256 });
    assert.equal(await engine.finish(enc, { iterations: 0 }), enc);
  });
});
