// favcon/vite: the in-memory build and the cache first, then the plugin in a real Vite build
// and a real dev server, then its types.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, build as viteBuild } from 'vite';

import { build, buildFiles } from '../bin/favcon.mjs';
import { declaresIcon, manifestIcons, manifestJson } from '../lib/core.mjs';
import { cacheKey, favconVersion, readSlot, writeSlot } from '../vite/cache.mjs';
import favcon, { favconIcons } from '../vite/index.mjs';

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

describe('declaresIcon', () => {
  it('finds a link whose rel holds the icon keyword', () => {
    for (const html of ['<link rel="icon" href="/a.svg">', "<link href='/a.ico' rel='icon'>", '<link rel=icon href=/a.ico>',
      '<LINK REL="Icon" HREF="/a.ico">', '<link rel="alternate icon" href="/a.ico">']) {
      assert.equal(declaresIcon(`<head>${html}</head>`), true, html);
    }
  });

  it('ignores links and text that only look like one', () => {
    for (const html of ['<link rel="apple-touch-icon" href="/a.png">', '<link rel="iconic" href="/a">',
      '<meta name="x" content=\'rel="icon"\'>', '<p>rel="icon"</p>', '<link rel="stylesheet" href="/icon.css">']) {
      assert.equal(declaresIcon(`<head>${html}</head>`), false, html);
    }
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

/** A Vite project: index.html, the mark at src/logo.svg, and any extra files. */
const app = (files = {}) => {
  const d = dir();
  mkdirSync(join(d, 'src'));
  copyFileSync(fixture('general.svg'), join(d, 'src', 'logo.svg'));
  writeFileSync(join(d, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><script type="module" src="/main.js"></script></body></html>');
  writeFileSync(join(d, 'main.js'), "import { links, files } from 'virtual:favcon';\nwindow.favcon = { links, files };\n");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, name)), { recursive: true });
    writeFileSync(join(d, name), text);
  }
  return d;
};
const FAST = { sizes: [32], mode: 'fast', bg: '#000000' };
const warnings = [];
const vbuild = (root, plugins, extra = {}) => viteBuild({
  root, configFile: false, logLevel: 'silent', plugins,
  customLogger: { info() {}, warn: (m) => warnings.push(m), warnOnce: (m) => warnings.push(m), error() {}, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
  ...extra,
});

describe('favcon/vite in a build', () => {
  it('emits the set at the output root and links it in index.html', async () => {
    const root = app();
    await vbuild(root, [favcon(FAST)]);
    for (const f of ['favicon.ico', 'icon.svg', 'logo.svg', 'apple-touch-icon.png', 'icon-32.png']) {
      assert.ok(existsSync(join(root, 'dist', f)), f);
    }
    const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
    assert.match(html, /<link rel="icon" href="\/favicon\.ico" sizes="32x32">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  });

  it('emits the same bytes as the CLI', async () => {
    const root = app();
    await vbuild(root, [favcon(FAST)]);
    const set = await buildFiles({ ...FAST, input: join(root, 'src', 'logo.svg') });
    for (const f of set.files) assert.equal(sha(readFileSync(join(root, 'dist', f.name))), sha(f.bytes), f.name);
  });

  it("follows Vite's base, and the config file's base over it", async () => {
    const a = app();
    await vbuild(a, [favcon(FAST)], { base: '/sub/' });
    assert.match(readFileSync(join(a, 'dist', 'index.html'), 'utf8'), /href="\/sub\/favicon\.ico"/);
    const b = app({ 'favcon.config.mjs': "export default { base: '/other/' };" });
    await vbuild(b, [favcon(FAST)], { base: '/sub/' });
    assert.match(readFileSync(join(b, 'dist', 'index.html'), 'utf8'), /href="\/other\/favicon\.ico"/);
  });

  it("warns and uses / when Vite's base is not a path", async () => {
    warnings.length = 0;
    const root = app();
    await vbuild(root, [favcon(FAST)], { base: './' });
    assert.match(readFileSync(join(root, 'dist', 'index.html'), 'utf8'), /href="\/favicon\.ico"/);
    assert.ok(warnings.some((w) => /Vite's base '\.\/' is not a path/.test(w)), warnings.join('\n'));
  });

  it('leaves a page that already declares an icon alone', async () => {
    const root = app();
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><link rel="icon" href="/x.svg"></head><body></body></html>');
    await vbuild(root, [favcon(FAST)]);
    assert.ok(!/favicon\.ico/.test(readFileSync(join(root, 'dist', 'index.html'), 'utf8')));
  });

  it('exports the links and the files from virtual:favcon', async () => {
    const root = app();
    await vbuild(root, [favcon(FAST)]);
    const js = readFileSync(join(root, 'dist', 'assets', readdirSync(join(root, 'dist', 'assets')).find((f) => f.endsWith('.js'))), 'utf8');
    assert.match(js, /apple-touch-icon\.png/);
    assert.match(js, /icon-32\.png/);
  });

  it('refuses to shadow a different file in public/, before emptying dist/', async () => {
    const root = app({ 'public/favicon.ico': 'not favcon', 'dist/keep.txt': 'previous build' });
    await assert.rejects(vbuild(root, [favcon(FAST)]), /favcon: public\/favicon\.ico exists and is not the file favcon builds/);
    assert.ok(existsSync(join(root, 'dist', 'keep.txt')), 'the previous dist/ was emptied');
  });

  it('accepts an identical file in public/', async () => {
    const root = app();
    const set = await buildFiles({ ...FAST, input: join(root, 'src', 'logo.svg') });
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public', 'favicon.ico'), set.files.find((f) => f.name === 'favicon.ico').bytes);
    await vbuild(root, [favcon(FAST)]);
    assert.ok(existsSync(join(root, 'dist', 'favicon.ico')));
  });

  it('writes and links site.webmanifest with manifest: true', async () => {
    const root = app();
    await vbuild(root, [favcon({ ...FAST, manifest: { name: 'Example' } })]);
    assert.equal(JSON.parse(readFileSync(join(root, 'dist', 'site.webmanifest'), 'utf8')).name, 'Example');
    assert.match(readFileSync(join(root, 'dist', 'index.html'), 'utf8'), /<link rel="manifest" href="\/site\.webmanifest">/);
  });

  it('leaves the manifest to vite-plugin-pwa when it is present, and says so', async () => {
    warnings.length = 0;
    const root = app();
    const pwa = { name: 'vite-plugin-pwa', api: { pwaAssetsGenerator: async () => ({}) } };
    await vbuild(root, [pwa, favcon({ ...FAST, manifest: true })]);
    assert.ok(!existsSync(join(root, 'dist', 'site.webmanifest')));
    assert.ok(!/site\.webmanifest/.test(readFileSync(join(root, 'dist', 'index.html'), 'utf8')));
    assert.ok(warnings.some((w) => /vite-plugin-pwa writes the manifest/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some((w) => /pwaAssets/.test(w)), warnings.join('\n'));
  });

  it('emits nothing in an SSR build', async () => {
    const root = app({ 'server.js': 'export const x = 1;\n' });
    await vbuild(root, [favcon(FAST)], { build: { ssr: 'server.js', outDir: 'dist-ssr' } });
    assert.ok(existsSync(join(root, 'dist-ssr', 'server.mjs')), 'the SSR build produced nothing, so the test proves nothing');
    assert.ok(!existsSync(join(root, 'dist-ssr', 'favicon.ico')));
  });

  it('reports a missing mark as a favcon error', async () => {
    const root = app();
    await assert.rejects(vbuild(root, [favcon({ ...FAST, input: 'nope.svg' })]), /favcon: no such file: .*nope\.svg/);
  });

  it('serves the second build from the cache', async () => {
    const root = app();
    await vbuild(root, [favcon(FAST)]);
    const cache = join(root, 'node_modules', '.cache', 'favcon');
    const slots = readdirSync(cache).filter((f) => !f.startsWith('.'));
    assert.equal(slots.length, 1);
    const first = readFileSync(join(root, 'dist', 'favicon.ico'));
    rmSync(join(root, 'dist'), { recursive: true });
    await vbuild(root, [favcon(FAST)]);
    assert.deepEqual(readFileSync(join(root, 'dist', 'favicon.ico')), first);
    assert.equal(readdirSync(cache).filter((f) => !f.startsWith('.')).length, 1);
  });
});

const serve = async (root, plugins, extra = {}) => {
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', plugins, server: { port: 0, strictPort: false, host: '127.0.0.1' },
    customLogger: { info() {}, warn: (m) => warnings.push(m), warnOnce: (m) => warnings.push(m), error: (m) => warnings.push(m), clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
    ...extra,
  });
  await server.listen();
  const { port } = server.httpServer.address();
  return { server, url: (p) => `http://127.0.0.1:${port}${p}` };
};

describe('favcon/vite in dev', () => {
  it('serves the set from memory at base, with content types', async () => {
    const root = app();
    const { server, url } = await serve(root, [favcon({ sizes: [32], bg: '#000000' })], { base: '/sub/' });
    try {
      for (const [path, type] of [['favicon.ico', 'image/x-icon'], ['icon.svg', 'image/svg+xml'], ['icon-32.png', 'image/png']]) {
        const r = await fetch(url(`/sub/${path}`));
        assert.equal(r.status, 200, path);
        assert.equal(r.headers.get('content-type'), type, path);
      }
      const html = await (await fetch(url('/sub/'))).text();
      assert.match(html, /href="\/sub\/favicon\.ico"/);
    } finally { await server.close(); }
  });

  it('serves the public/ file and warns when it differs', async () => {
    warnings.length = 0;
    const root = app({ 'public/favicon.ico': 'mine' });
    const { server, url } = await serve(root, [favcon({ sizes: [32], bg: '#000000' })]);
    try {
      assert.equal(await (await fetch(url('/favicon.ico'))).text(), 'mine');
      assert.ok(warnings.some((w) => /public\/favicon\.ico exists and is not the file favcon builds/.test(w)), warnings.join('\n'));
    } finally { await server.close(); }
  });

  it('rebuilds when the mark changes', async () => {
    const root = app();
    const { server, url } = await serve(root, [favcon({ sizes: [32], bg: '#000000' })]);
    try {
      const before = await (await fetch(url('/icon.svg'))).text();
      writeFileSync(join(root, 'src', 'logo.svg'), readFileSync(fixture('second.svg')));
      let after = before;
      for (let i = 0; i < 100 && after === before; i++) {
        await new Promise((r) => setTimeout(r, 100));
        after = await (await fetch(url('/icon.svg'))).text();
      }
      assert.notEqual(after, before, 'icon.svg did not change after the mark did');
    } finally { await server.close(); }
  });

  it('logs a bad mark and keeps serving the page', async () => {
    warnings.length = 0;
    const root = app();
    writeFileSync(join(root, 'src', 'logo.svg'), 'not an svg');
    const { server, url } = await serve(root, [favcon({ sizes: [32], bg: '#000000' })]);
    try {
      assert.equal((await fetch(url('/favicon.ico'))).status, 404);
      assert.equal((await fetch(url('/'))).status, 200);
      assert.ok(warnings.some((w) => /favcon: not an SVG/.test(w)), warnings.join('\n'));
    } finally { await server.close(); }
  });
});

describe('favcon/vite types', () => {
  it('declares the plugin through the package exports', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.exports['./vite'], { types: './vite/index.d.mts', default: './vite/index.mjs' });
    assert.ok(pkg.files.includes('vite'));
    assert.equal(pkg.peerDependencies.vite, '^8.0.0');
    assert.equal(pkg.peerDependenciesMeta.vite.optional, true);
  });

  const tsc = join(ROOT, 'site', 'node_modules', 'typescript', 'bin', 'tsc');
  it('type-checks a vite.config, and catches out and a misspelt key', { skip: existsSync(tsc) ? false : 'typescript not installed' }, () => {
    const d = dir();
    const spec = JSON.stringify(join(ROOT, 'vite', 'index.mjs').replace(/\\/g, '/'));
    writeFileSync(join(d, 'good.mts'), `import favcon, { favconIcons } from ${spec};\nconst p = favcon({ input: 'src/logo.svg', sizes: [192, 512], mode: 'fast', base: '/x/' });\nconst icons: { src: string; sizes: string; type: string; purpose?: string }[] = favconIcons({ sizes: [192] });\nexport { p, icons };\n`);
    writeFileSync(join(d, 'bad.mts'), `import favcon from ${spec};\nexport const p = favcon({ out: 'dist', colours: 8 });\n`);
    const check = (f) => spawnSync(process.execPath, [tsc, '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', join(d, f)], { encoding: 'utf8' });
    const good = check('good.mts');
    assert.equal(good.status, 0, good.stdout + good.stderr);
    const bad = check('bad.mts');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout, /out|colours/);
  });
});
