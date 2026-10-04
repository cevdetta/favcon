// The options layer on its own (lib/config.mjs), then the CLI reading a config file, then the
// types a config file sees.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { FavconError } from '../lib/core.mjs';
import { checkConfig, CONFIG_KEYS, defineConfig, normaliseOptions, resolveOptions } from '../lib/config.mjs';

const fails = (fn, re) => assert.throws(fn, (e) => e instanceof FavconError && re.test(e.message));

describe('normaliseOptions', () => {
  it('fills the defaults', () => {
    const o = normaliseOptions({});
    assert.equal(o.colors, 256);
    assert.deepEqual(o.sizes, [192, 512]);
    assert.equal(o.bg, '#000000');
    assert.equal(o.padding, 'auto');
    assert.equal(o.base, '/');
    assert.equal(o.iterations, 120);
    assert.equal(o.out, '.');
  });

  it('keeps the existing messages', () => {
    fails(() => normaliseOptions({ colors: '0x10' }), /^--colors must be an integer 2-256, got '0x10'$/);
    fails(() => normaliseOptions({ sizes: '33' }), /^--sizes takes even pixel sizes, got '33'$/);
    fails(() => normaliseOptions({ padding: 50 }), /^--padding must be 'auto' or a percentage 0-45$/);
    fails(() => normaliseOptions({ mode: 'slow' }), /^mode must be 'release' or 'fast', got 'slow'$/);
  });

  it('maps fast mode and zopfli: false to their iteration counts', () => {
    assert.equal(normaliseOptions({ mode: 'fast' }).iterations, 15);
    assert.equal(normaliseOptions({ zopfli: false }).iterations, 0);
  });

  it('turns bg none and bg null into a transparent set', () => {
    assert.equal(normaliseOptions({ bg: 'none' }).bg, null);
    assert.equal(normaliseOptions({ bg: null }).bg, null);
  });

  it('normalises base to a path with a slash at each end', () => {
    for (const [given, want] of [['/', '/'], ['', '/'], ['blog', '/blog/'], ['/blog', '/blog/'],
      ['/blog/', '/blog/'], ['a/b', '/a/b/'], ['/a//b/', '/a/b/']]) {
      assert.equal(normaliseOptions({ base: given }).base, want, `base '${given}'`);
    }
  });

  it('refuses a base that is a URL, not a path', () => {
    fails(() => normaliseOptions({ base: 'https://cdn.example.com/' }), /^base must be a path such as '\/' or '\/blog\/', got 'https:\/\/cdn\.example\.com\/'$/);
    fails(() => normaliseOptions({ base: '//cdn.example.com' }), /^base must be a path/);
    fails(() => normaliseOptions({ base: 42 }), /^base must be a path/);
  });

  it('refuses an animation or manifest of the wrong type', () => {
    fails(() => normaliseOptions({ animation: 'no' }), /^animation must be true or false, got 'no'$/);
    fails(() => normaliseOptions({ manifest: 'yes' }), /^manifest must be true, false or an object of manifest members, got 'yes'$/);
  });
});

describe('resolveOptions', () => {
  it('layers defaults, then the file, then the inline options', () => {
    const r = resolveOptions({ out: '.', colors: 8 }, { colors: 16, sizes: [32] }, { colors: 64 });
    assert.deepEqual({ out: r.out, colors: r.colors, sizes: r.sizes }, { out: '.', colors: 64, sizes: [32] });
  });

  it('skips undefined, so an absent flag never hides the file', () => {
    assert.equal(resolveOptions({}, { bg: '#fff' }, { bg: undefined }).bg, '#fff');
  });

  it('merges vars by name, the inline value winning, with or without the dashes', () => {
    const r = resolveOptions({}, { vars: { ground: '#111111', ink: '#222222' } }, { vars: new Map([['--ground', '#333333']]) });
    assert.deepEqual([...r.vars], [['--ground', '#333333'], ['--ink', '#222222']]);
  });

  it('keeps a manifest object from the file when the inline value is only true', () => {
    const obj = { name: 'Example' };
    assert.equal(resolveOptions({}, { manifest: obj }, { manifest: true }).manifest, obj);
    const other = { name: 'Other' };
    assert.equal(resolveOptions({}, { manifest: obj }, { manifest: other }).manifest, other);
  });
});

describe('checkConfig', () => {
  it('lists the keys it knows', () => {
    assert.deepEqual(CONFIG_KEYS, ['input', 'out', 'colors', 'sizes', 'bg', 'padding', 'vars', 'animation', 'manifest', 'mode', 'base']);
  });

  it('refuses a default export that is not an object', () => {
    for (const bad of [undefined, null, 3, 'x', [1]]) {
      fails(() => checkConfig(bad, 'favcon.config.mjs'), /^favcon\.config\.mjs must export an object as its default export$/);
    }
  });

  it('names every unknown key and the keys it accepts', () => {
    fails(() => checkConfig({ colours: 8, quiet: true }, 'favcon.config.mjs'),
      /^favcon\.config\.mjs: unknown options 'colours', 'quiet'; the options are input, out, colors, sizes, bg, padding, vars, animation, manifest, mode, base$/);
  });

  it('defineConfig returns what it was given', () => {
    const c = { sizes: [32] };
    assert.equal(defineConfig(c), c);
  });
});

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'favcon.mjs');
const execFileAsync = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), 'favcon-config.'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** A project directory holding logo.svg (general.svg) and the given files. */
const project = (files) => {
  const dir = join(scratch, `p${++n}`);
  mkdirSync(dir);
  copyFileSync(join(ROOT, 'test', 'fixtures', 'general.svg'), join(dir, 'logo.svg'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};

/** The CLI, run in `cwd`. Never throws; tests assert on the exit code. */
const run = async (cwd, args = []) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd, timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

const FAST = "input: 'logo.svg', out: 'public', sizes: [32], mode: 'fast', bg: '#000000'";
const read = (dir, f) => readFileSync(join(dir, 'public', f), 'utf8');
const noStack = (r) => assert.ok(!/at .*\.m?[jt]s:\d+/.test(r.stderr), `a stack trace leaked:\n${r.stderr}`);

describe('the CLI with a config file', () => {
  it('builds from the config alone and names the mode', async () => {
    const dir = project({ 'favcon.config.mjs': `export default { ${FAST} };` });
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
    for (const f of ['logo.svg', 'icon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-32.png']) {
      assert.ok(existsSync(join(dir, 'public', f)), f);
    }
    assert.match(r.stdout, /^fast build \(zopfli at 15 iterations; not the release bytes\)$/m);
    assert.ok(!/--bg not given/.test(r.stderr), 'the config gave bg, so no warning');
  });

  it('lets a flag win over the config', async () => {
    const dir = project({ 'favcon.config.mjs': `export default { ${FAST.replace('[32]', '[64]')} };` });
    const r = await run(dir, ['--sizes', '32']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'public', 'icon-32.png')));
    assert.ok(!existsSync(join(dir, 'public', 'icon-64.png')));
  });

  it('merges --var over the config vars by name', async () => {
    const dir = project({ 'favcon.config.mjs': `export default { ${FAST}, vars: { ground: '#123456' } };` });
    assert.equal((await run(dir)).code, 0);
    assert.match(read(dir, 'icon.svg'), /#123456/i);
    assert.equal((await run(dir, ['--var', 'ground=#654321'])).code, 0);
    assert.match(read(dir, 'icon.svg'), /#654321/i);
    assert.ok(!/#123456/i.test(read(dir, 'icon.svg')));
  });

  it('puts base into --html and the manifest', async () => {
    const dir = project({ 'favcon.config.mjs': `export default { ${FAST}, base: 'blog' };` });
    const r = await run(dir, ['--html', '--manifest']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /<link rel="icon" href="\/blog\/favicon\.ico" sizes="32x32">/);
    assert.match(r.stdout, /<link rel="manifest" href="\/blog\/site\.webmanifest">/);
    assert.equal(JSON.parse(read(dir, 'site.webmanifest')).icons[0].src, '/blog/icon-32.png');
  });

  it('keeps the config manifest members under --manifest', async () => {
    const dir = project({ 'favcon.config.mjs': `export default { ${FAST}, manifest: { name: 'Example' } };` });
    assert.equal((await run(dir, ['--manifest'])).code, 0);
    const m = JSON.parse(read(dir, 'site.webmanifest'));
    assert.equal(m.name, 'Example');
    assert.equal(m.icons.length, 1);
  });

  it('loads a .js config written as ESM in a project with no package.json type', async () => {
    const dir = project({ 'favcon.config.js': `export default { ${FAST} };` });
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
  });

  it('loads a .ts config through type stripping', async () => {
    const dir = project({ 'favcon.config.ts': `const sizes: number[] = [32];\nexport default { input: 'logo.svg', out: 'public', sizes, mode: 'fast' as const, bg: '#000000' };` });
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'public', 'icon-32.png')));
  });

  it('names favcon.config.mjs when Node cannot load a .ts config', async () => {
    const dir = project({ 'favcon.config.ts': `enum Size { Small = 32 }\nexport default { input: 'logo.svg', sizes: [Size.Small] };` });
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: favcon\.config\.ts could not be loaded: /m);
    assert.match(r.stderr, /write favcon\.config\.mjs instead/);
    noStack(r);
  });

  it('refuses an unknown key, naming it', async () => {
    const dir = project({ 'favcon.config.mjs': `export default { ${FAST}, colours: 8 };` });
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: favcon\.config\.mjs: unknown option 'colours'; the options are /m);
    assert.ok(!existsSync(join(dir, 'public')), 'a failed run wrote output');
    noStack(r);
  });

  it('refuses a config that does not export an object', async () => {
    const dir = project({ 'favcon.config.mjs': 'export default 42;' });
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: favcon\.config\.mjs must export an object as its default export$/m);
  });

  it('reports a config that throws, without a stack trace', async () => {
    const dir = project({ 'favcon.config.mjs': "throw new Error('broken on purpose');" });
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: favcon\.config\.mjs could not be loaded: broken on purpose$/m);
    noStack(r);
  });

  it('uses the first config file and warns about the others', async () => {
    const dir = project({
      'favcon.config.js': `export default { ${FAST} };`,
      'favcon.config.mjs': 'export default { colours: 8 };',
    });
    const r = await run(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^favcon: warning: favcon\.config\.mjs ignored: favcon\.config\.js is the config file in use$/m);
  });

  it('still prints the usage and fails with no input from flags or config', async () => {
    const dir = project({});
    const r = await run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Usage:/m);
  });

  it('names release mode in the summary by default', async () => {
    const dir = project({});
    const r = await run(dir, ['--sizes', '32', '--bg', '#000', '-o', 'public', 'logo.svg']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^release build \(zopfli at 120 iterations\)$/m);
  });
});
