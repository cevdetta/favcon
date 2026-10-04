// The options layer on its own (lib/config.mjs), then the CLI reading a config file, then the
// types a config file sees.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
