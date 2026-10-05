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
import { cacheKey, favconVersion, readSlot, writeSlot } from '../vite/cache.mjs';

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
