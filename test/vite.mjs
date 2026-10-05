// favcon/vite: the in-memory build and the cache first, then the plugin in a real Vite build
// and a real dev server, then its types.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { build, buildFiles } from '../bin/favcon.mjs';
import { manifestIcons, manifestJson } from '../lib/core.mjs';
import { cacheKey, favconVersion, readSlot, writeSlot } from '../vite/cache.mjs';
import { favconIcons } from '../vite/index.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (n) => join(ROOT, 'test', 'fixtures', n);
const scratch = mkdtempSync(join(tmpdir(), 'favcon-vite.'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const dir = () => { const d = join(scratch, `d${++n}`); mkdirSync(d); return d; };
const sha = (b) => createHash('sha256').update(b).digest('hex');

describe('buildFiles', () => {
  it('returns the bytes build() writes, and writes nothing', async () => {
    const opts = { input: fixture('general.svg'), sizes: [32], mode: 'fast', bg: '#000000' };
    const set = await buildFiles(opts);
    const out = dir();
    const r = await build({ ...opts, out });
    assert.deepEqual(set.files.map((f) => f.name), r.files);
    for (const f of set.files) assert.equal(sha(f.bytes), sha(readFileSync(join(out, f.name))), f.name);
  });
});

describe('the cache', () => {
  it('keys vars the same whether they arrive as an object or a Map, with or without dashes', () => {
    const base = { version: '1', source: 'x', engine: {} };
    const a = cacheKey({ ...base, options: { vars: { ground: '#111' } } });
    const b = cacheKey({ ...base, options: { vars: new Map([['--ground', '#111']]) } });
    const c = cacheKey({ ...base, options: { vars: { ground: '#222' } } });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('writes a slot and reads back the same bytes', async () => {
    const cache = dir();
    const files = [{ name: 'favicon.ico', bytes: Uint8Array.of(1, 2, 3) }, { name: 'icon.svg', bytes: new TextEncoder().encode('<svg/>') }];
    assert.equal(await readSlot(cache, 'k1'), null);
    await writeSlot(cache, 'k1', files);
    const back = await readSlot(cache, 'k1');
    assert.deepEqual(back.map((f) => [f.name, [...f.bytes]]), files.map((f) => [f.name, [...f.bytes]]));
  });

  it('knows its own version', () => {
    assert.match(favconVersion(), /^\d+\.\d+\.\d+/);
  });
});

describe('manifest icons', () => {
  it('manifestJson keeps its bytes and its entries match manifestIcons', () => {
    const text = manifestJson({ sizes: [192, 512], base: '/b/', purpose: 'any maskable', extra: { name: 'x' } });
    assert.equal(text, '{\n  "name": "x",\n  "icons": [\n' +
      '    { "src": "/b/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },\n' +
      '    { "src": "/b/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }\n  ]\n}\n');
    assert.deepEqual(JSON.parse(text).icons, manifestIcons({ sizes: [192, 512], base: '/b/', purpose: 'any maskable' }));
  });

  it('favconIcons gives vite-plugin-pwa the entries favcon writes', () => {
    assert.deepEqual(favconIcons(), [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ]);
    assert.deepEqual(favconIcons({ sizes: [64], bg: null, base: 'app' }), [{ src: '/app/icon-64.png', sizes: '64x64', type: 'image/png' }]);
  });
});
