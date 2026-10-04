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
