// buildSet on its own: the file set, the order and the determinism, with nothing written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { loadEngine, optimiseSvg } from '../bin/favcon.mjs';
import { normaliseVars } from '../lib/core.mjs';
import { buildSet } from '../lib/pipeline.mjs';
import { header } from './lib/png.mjs';

const read = (n) => readFileSync(new URL(`./fixtures/${n}.svg`, import.meta.url), 'utf8');
const engine = await loadEngine();
const opts = (extra = {}) => ({
  colors: 256, sizes: [32], padding: 'auto', bg: '#000000', vars: normaliseVars({}),
  animation: true, manifest: false, base: '/', iterations: 0, ...extra,
});
const run = (name, extra) => buildSet(read(name), opts(extra), { engine, optimiseSvg, name: `${name}.svg` });

describe('buildSet', () => {
  it('returns the set in the CLI order, as bytes', async () => {
    const set = await run('general', { manifest: true });
    assert.deepEqual(set.files.map((f) => f.name),
      ['logo.svg', 'icon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-32.png', 'site.webmanifest']);
    for (const f of set.files) assert.ok(f.bytes instanceof Uint8Array && f.bytes.length > 0, f.name);
    assert.equal(header(Buffer.from(set.files[3].bytes)).width, 180);
  });

  it('gives the same bytes twice', async () => {
    const a = await run('heavy', { iterations: 15 }), b = await run('heavy', { iterations: 15 });
    assert.deepEqual(a.files.map((f) => [...f.bytes]), b.files.map((f) => [...f.bytes]));
  });

  it('reports animation and keeps it out of icon.svg', async () => {
    const set = await run('animated');
    assert.equal(set.animated, true);
    const icon = new TextDecoder().decode(set.files.find((f) => f.name === 'icon.svg').bytes);
    assert.ok(!/@keyframes/.test(icon));
  });

  it('rejects input that is not an SVG', async () => {
    await assert.rejects(buildSet('hello', opts(), { engine, optimiseSvg, name: 'x.txt' }),
      /not an SVG \(no <svg> element found\): x\.txt/);
  });

  it('rejects a translucent ground before rendering anything', async () => {
    await assert.rejects(run('flat', { bg: '#ffffff80' }), /--bg must be opaque/);
  });
});
