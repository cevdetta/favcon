// Every line of the definition of done, as node:test. No bash, no ImageMagick.
//
// Two rules this suite holds itself to:
//
//   * Assert SELF-CONSISTENCY, never golden bytes. apt's pngquant is 3.0.1 while a
//     developer's may be 3.0.3, and they do not agree byte for byte. "Two runs with the
//     same inputs and the same tools produce the same bytes" is the property that actually
//     matters and it is true on every machine.
//   * Build as few times as possible. Zopfli is ~98% of the wall clock, so the builds are
//     memoised by key and shared across tests; only the tests that need 256/512 pay for it.

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { build, FavconError, icoWrap, optimiseSvg, toolPath } from '../bin/favcon.mjs';
import favconAstro from '../astro/index.mjs';
import { reference, score, THRESHOLD_PCT } from './lib/accuracy.mjs';
import { decode, encode, header } from './lib/png.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CLI = join(ROOT, 'bin', 'favcon.mjs');
const fixture = (n) => join(HERE, 'fixtures', n);

const scratch = mkdtempSync(join(tmpdir(), 'favcon-test.'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const freshDir = () => join(scratch, `case-${++counter}`);

/** Run the CLI. Never throws on a non-zero exit; the tests assert on the exit code. */
const cli = async (args, opts = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], opts);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

// Builds are memoised: several tests want the same output set and each one costs seconds.
const builds = new Map();
const buildOnce = (key, options) => {
  if (!builds.has(key)) {
    const out = join(scratch, `build-${key}`);
    builds.set(key, build({ out, ...options }).then((r) => ({ ...r, out })));
  }
  return builds.get(key);
};

const DEFAULT_BUILD = () => buildOnce('default', { input: fixture('general.svg') });
const SMALL = (name, extra = {}) =>
  buildOnce(`small-${name}${JSON.stringify(extra)}`, { input: fixture(`${name}.svg`), sizes: [32], ...extra });

const haveIcotool = (() => {
  try { execFileSync('icotool', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// Everything that rasterises needs resvg, pngquant and oxipng. The Windows CI job has none
// of them (upstream stopped shipping resvg-win64.zip after v0.47.0), so rather than a second
// suite that drifts out of step, the binary-dependent groups skip themselves and what is
// left - argument parsing, both svgo passes, the ICO writer, the option validator - is real
// coverage that runs everywhere.
const needsTools = await (async () => {
  try { await toolPath('resvg'); await toolPath('pngquant'); await toolPath('oxipng'); return false; }
  catch (e) { return e.message.split('\n')[0]; }
})();
const skipNoTools = needsTools ? `skipped: ${needsTools}` : false;

// ---------------------------------------------------------------- 1, 2, 9 --

describe('the output set', { skip: skipNoTools }, () => {
  it('produces exactly the promised files and nothing else', async () => {
    const { out } = await DEFAULT_BUILD();
    assert.deepEqual(readdirSync(out).sort(),
      ['apple-touch-icon.png', 'favicon.ico', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon.svg', 'logo.svg']);
  });

  it('renders every size exactly', async () => {
    const { out } = await DEFAULT_BUILD();
    for (const [file, px] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
      const h = header(readFileSync(join(out, file)));
      assert.equal(h.width, px, `${file} width`);
      assert.equal(h.height, px, `${file} height`);
    }
  });

  it('reports a single 32x32 entry in the ICO', async () => {
    const { out } = await DEFAULT_BUILD();
    const ico = readFileSync(join(out, 'favicon.ico'));
    assert.equal(ico.readUInt16LE(4), 1, 'idCount');
    assert.equal(ico[6], 32, 'bWidth');
    assert.equal(ico[7], 32, 'bHeight');
    assert.equal(header(ico.subarray(22)).width, 32, 'payload width');
  });

  it('gives apple-touch-icon.png no alpha channel when --bg is set', async () => {
    const { out } = await DEFAULT_BUILD();
    const buf = readFileSync(join(out, 'apple-touch-icon.png'));
    const h = header(buf);
    assert.ok(h.colorType !== 4 && h.colorType !== 6, `colour type ${h.colorType} carries alpha`);
    const img = decode(buf);
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] !== 255) assert.fail(`transparent pixel at ${(i - 3) / 4}`);
    }
  });

  it('keeps the alpha when --bg none is asked for', async () => {
    const { out } = await buildOnce('bgnone', { input: fixture('flat.svg'), sizes: [32], bg: null });
    const img = decode(readFileSync(join(out, 'apple-touch-icon.png')));
    assert.ok([...img.data.filter((_, i) => i % 4 === 3)].some((a) => a === 0),
      'flat.svg has a wide transparent margin; none of it survived');
  });
});

// ------------------------------------------------------------------- 3, 6 --

describe('icon.svg is the conservative favicon', { skip: skipNoTools }, () => {
  const forbidden = [
    [/\srole=/, 'role'], [/\saria-/, 'aria-*'], [/\sclass=/, 'class'], [/\sstyle=/, 'style='],
    [/<style/, '<style>'], [/<defs/, '<defs'], [/var\(/, 'var('],
  ];

  for (const [name, extra] of [
    ['general', {}], ['animated', {}], ['animated', { animation: false }],
    ['mask', {}], ['smil', {}], ['heavy', {}], ['tiles', {}],
  ]) {
    const label = `${name}${extra.animation === false ? ' --no-animation' : ''}`;
    it(`strips everything unrenderable from ${label}`, async () => {
      const { out } = await SMALL(name, extra);
      const svg = readFileSync(join(out, 'icon.svg'), 'utf8');
      for (const [re, what] of forbidden) assert.ok(!re.test(svg), `${label}: icon.svg still has ${what}\n${svg}`);
      assert.match(svg, /xmlns=/);
      assert.match(svg, /viewBox=/);
    });
  }

  it('keeps a referenced id and drops an unreferenced one', async () => {
    const { out } = await SMALL('mask');
    const svg = readFileSync(join(out, 'icon.svg'), 'utf8');
    assert.ok(!svg.includes('orphan'), 'the unreferenced id survived');
    const used = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(used.length > 0, 'the mask reference itself was lost');
    for (const id of used) assert.ok(svg.includes(`id="${id}"`), `url(#${id}) points at nothing`);
  });
});

// ---------------------------------------------------------------- 4, 5, 13 --

describe('custom properties', () => {
  it('overrides the fallback, leaving no trace of it', { skip: skipNoTools }, async () => {
    const out = freshDir();
    await build({ input: fixture('general.svg'), out, sizes: [32], vars: { ground: '#123456' } });
    const svg = readFileSync(join(out, 'icon.svg'), 'utf8');
    assert.ok(svg.includes('#123456'), 'the override is not in the output');
    assert.ok(!/1f3a5f/i.test(svg), 'the fallback value survived the override');
  });

  it('accepts a name given with or without the leading dashes', { skip: skipNoTools }, async () => {
    const a = freshDir(), b = freshDir();
    await build({ input: fixture('general.svg'), out: a, sizes: [32], vars: { ground: '#123456' } });
    await build({ input: fixture('general.svg'), out: b, sizes: [32], vars: { '--ground': '#123456' } });
    assert.equal(readFileSync(join(a, 'icon.svg'), 'utf8'), readFileSync(join(b, 'icon.svg'), 'utf8'));
  });

  it('fails loudly on an unresolvable var() and writes nothing', async () => {
    const out = freshDir();
    const r = await cli(['--bg', '#fff', '-o', out, fixture('unresolved.svg')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: unresolved var\(--brand\)/m);
    assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), `a stack trace leaked:\n${r.stderr}`);
    assert.ok(!existsSync(out), 'a failed run created the output directory');
  });
});

// -------------------------------------------------------------------- 7 --

describe('the ICO container', () => {
  it('starts 00 00 01 00 and holds a PNG', { skip: skipNoTools }, async () => {
    const { out } = await DEFAULT_BUILD();
    const ico = readFileSync(join(out, 'favicon.ico'));
    assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
    assert.deepEqual([...ico.subarray(22, 26)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(ico.readUInt32LE(18), 22, 'dwImageOffset');
    assert.equal(ico.readUInt32LE(14), ico.length - 22, 'dwBytesInRes');
  });

  it('describes the decoded image, not the encoding', () => {
    // A 1x1 fully paletted PNG: bColorCount must still be 0 and wBitCount still 32.
    const png = encode({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) });
    // icoWrap returns a Uint8Array so the website can call it too; Buffer.from to read fields.
    const ico = Buffer.from(icoWrap(png, 1));
    assert.equal(ico[8], 0, 'bColorCount');
    assert.equal(ico.readUInt16LE(10), 1, 'wPlanes');
    assert.equal(ico.readUInt16LE(12), 32, 'wBitCount');
  });

  it('stores 256 as 0 in the byte-wide fields', () => {
    const png = encode({ width: 256, height: 256, data: new Uint8Array(256 * 256 * 4) });
    const ico = icoWrap(png, 256);
    assert.equal(ico[6], 0);
    assert.equal(ico[7], 0);
  });

  it('refuses a size it cannot represent, and a payload that disagrees', () => {
    const png = encode({ width: 32, height: 32, data: new Uint8Array(32 * 32 * 4) });
    assert.throws(() => icoWrap(png, 257), FavconError);
    assert.throws(() => icoWrap(png, 0), FavconError);
    assert.throws(() => icoWrap(png, 16), /is 32x32, expected 16x16/);
    assert.throws(() => icoWrap(Buffer.from('not a png'), 32), /not a PNG/);
  });

  it('is byte-identical to icotool -c -r', { skip: skipNoTools || (haveIcotool ? false : 'icotool not installed') },
    async () => {
      const { out } = await DEFAULT_BUILD();
      const payload = join(scratch, 'payload.png');
      const ico = readFileSync(join(out, 'favicon.ico'));
      writeFileSync(payload, ico.subarray(22));
      const ref = join(scratch, 'icotool.ico');
      execFileSync('icotool', ['-c', '-r', payload, '-o', ref]);
      assert.deepEqual([...ico], [...readFileSync(ref)]);
    });
});

// -------------------------------------------------------------------- 8 --

describe('accuracy', { skip: skipNoTools }, () => {
  let resvg;
  before(async () => { resvg = await toolPath('resvg'); });

  // Scored at the sizes favcon actually ships by default. The bar is a statement about those:
  // at 32 px a mark is 1024 pixels of which nearly all are anti-aliasing edges, and no palette
  // reproduces that to 8/255 - the size table in docs/BENCHMARKS.md shows the whole curve.
  const CHECKS = [
    ['apple-touch-icon.png', 180, '#000000', true],   // background-matched and placed: the
    ['icon-192.png', 192, null, false],               // ground and the placement are not error
    ['icon-512.png', 512, null, false],
    ['icon-maskable-512.png', 512, '#000000', true],
  ];

  // Built at --colors 16, NOT at the default of 8. The bar is a claim about the pipeline,
  // and 16 is the palette that meets it on every mark here; 8 is what ships because it is
  // ~18% smaller and a flat mark - which is what a logo usually is - sits far inside the bar
  // at 8 anyway. The test below pins that trade so neither half can drift unnoticed.
  //
  // zopfli is switched off for these builds. It is a lossless recompressor: it changes how
  // the pixels are stored and not what they are, so the decoded image is identical and the
  // gate measures exactly the same thing ~50x faster. The next test is the proof.
  const accuracyBuild = (name) =>
    buildOnce(`acc-${name}`, { input: fixture(`${name}.svg`), sizes: [192, 512], colors: 16, zopfli: false });

  it('zopfli changes bytes, not pixels', async () => {
    const withZopfli = await SMALL('second');
    const without = await buildOnce('nozopfli', { input: fixture('second.svg'), sizes: [32], zopfli: false });
    const a = readFileSync(join(withZopfli.out, 'icon-32.png'));
    const b = readFileSync(join(without.out, 'icon-32.png'));
    assert.ok(a.length <= b.length, 'zopfli made the file larger');
    assert.deepEqual([...decode(a).data], [...decode(b).data], 'zopfli changed a pixel');
  });

  for (const name of ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'wide', 'smil', 'tiles']) {
    it(`${name}: every raster is inside the bar`, async () => {
      const { out } = await accuracyBuild(name);
      const source = fixture(`${name}.svg`);
      for (const [file, px, bg, fitted] of CHECKS) {
        const ref = await reference(resvg, { source, px, bg, vars: {}, fitted });
        const s = score(decode(readFileSync(join(out, file))), ref);
        assert.ok(s.pct <= THRESHOLD_PCT,
          `${name}/${file}: pct ${s.pct.toFixed(4)}% > ${THRESHOLD_PCT}% (rmse ${s.rmse.toFixed(2)})`);
      }
    });
  }

  it('ships --colors 8 by default, and 8 is outside the bar on a ramp-heavy mark', async () => {
    // Two halves of one deliberate trade. If the default moves, the first assertion fails;
    // if 8 quietly starts meeting the bar, the second does and the comment above is stale.
    const dflt = await buildOnce('dflt-colors', { input: fixture('flat.svg'), sizes: [32], zopfli: false });
    const eight = await buildOnce('eight-colors', { input: fixture('flat.svg'), sizes: [32], colors: 8, zopfli: false });
    for (const f of ['icon-32.png', 'apple-touch-icon.png']) {
      assert.deepEqual([...readFileSync(join(dflt.out, f))], [...readFileSync(join(eight.out, f))],
        `the default palette is no longer 8 (${f} differs)`);
    }
    const { out } = await buildOnce('heavy-8', { input: fixture('heavy.svg'), sizes: [192], colors: 8, zopfli: false });
    const ref = await reference(resvg, { source: fixture('heavy.svg'), px: 192, bg: null, vars: {} });
    const s = score(decode(readFileSync(join(out, 'icon-192.png'))), ref);
    assert.ok(s.pct > THRESHOLD_PCT,
      `heavy at --colors 8 scored ${s.pct.toFixed(3)}%, inside the bar - decision 19 needs revisiting`);
  });

  it('the gradient needs a palette big enough for it, and says so by failing at 8', async () => {
    // This fixture is the counter-example the bar needs: four stops cannot be spent on 8
    // colours, and pretending otherwise would make the gate meaningless everywhere else.
    const source = fixture('gradient.svg');
    const ref = await reference(resvg, { source, px: 192, bg: null, vars: {} });
    const at = async (colors) => {
      const { out } = await buildOnce(`grad-${colors}`,
        { input: source, sizes: [192], colors, zopfli: false });
      return score(decode(readFileSync(join(out, 'icon-192.png'))), ref).pct;
    };
    assert.ok(await at(8) > THRESHOLD_PCT, '8 colours should not be enough for a gradient');
    assert.ok(await at(256) < await at(8), 'a bigger palette should help');
  });
});

// ------------------------------------------------------------------ 10, 15 --

describe('optional outputs and option syntax', () => {
  it('--manifest writes valid JSON with one entry per size', { skip: skipNoTools }, async () => {
    const out = freshDir();
    const r = await cli(['--bg', '#fff', '--manifest', '--sizes', '32 64', '-o', out, fixture('flat.svg')]);
    assert.equal(r.code, 0, r.stderr);
    const m = JSON.parse(readFileSync(join(out, 'site.webmanifest'), 'utf8'));
    assert.deepEqual(m.icons.map((i) => [i.src, i.sizes, i.purpose]), [
      ['/icon-32.png', '32x32', undefined],
      ['/icon-64.png', '64x64', undefined],
      ['/icon-maskable-512.png', '512x512', 'maskable'],
    ]);
    for (const i of m.icons) assert.equal(i.type, 'image/png');
  });

  it('manifest may be an object, merged in ahead of the icons', { skip: skipNoTools }, async () => {
    // The CLI writes icons only because a CLI cannot know the app's name. The API can be
    // told, which is what the Astro integration passes through.
    const out = freshDir();
    await build({ input: fixture('flat.svg'), out, sizes: [32], bg: '#ffffff',
                  manifest: { name: 'Example', short_name: 'Ex', theme_color: '#0E7C68' } });
    const m = JSON.parse(readFileSync(join(out, 'site.webmanifest'), 'utf8'));
    assert.equal(m.name, 'Example');
    assert.equal(m.short_name, 'Ex');
    assert.equal(m.theme_color, '#0E7C68');
    assert.deepEqual(m.icons.map((i) => i.sizes), ['32x32', '512x512']);
  });

  it('--html prints the link set with sizes="32x32" on the ICO', { skip: skipNoTools }, async () => {
    const out = freshDir();
    const r = await cli(['--bg', '#fff', '--html', '--sizes', '32', '-o', out, fixture('flat.svg')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /<link rel="icon" href="\/favicon\.ico" sizes="32x32">/);
    assert.match(r.stdout, /<link rel="icon" href="\/icon\.svg" type="image\/svg\+xml">/);
    assert.match(r.stdout, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
    // logo.svg appears in the size summary; what matters is that nothing LINKS to it.
    const links = r.stdout.split('\n').filter((l) => l.startsWith('<link'));
    assert.ok(links.length > 0);
    assert.ok(!links.some((l) => l.includes('logo.svg')), 'logo.svg must not be linked');
  });

  it('accepts --opt=value', { skip: skipNoTools }, async () => {
    const out = freshDir();
    const r = await cli([`--out=${out}`, '--bg=#fff', '--sizes=32', '--colors=16',
                         `--var=ground=#654321`, fixture('general.svg')]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(readFileSync(join(out, 'icon.svg'), 'utf8').includes('#654321'));
  });

  it('rejects an argument on a flag that takes none', async () => {
    const r = await cli(['--quiet=yes', fixture('flat.svg')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: --quiet takes no argument/m);
  });

  it('ends option parsing at --', async () => {
    const r = await cli(['--bg', '#fff', '--', '--not-a-flag.svg']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: no such file: --not-a-flag\.svg$/m);
  });
});


// ------------------------------------------------------------ masked icons --

describe('the masked icons', { skip: skipNoTools }, () => {
  const BG = '#123456';
  const MASKED = (name, extra = {}) =>
    buildOnce(`masked-${name}${JSON.stringify(extra)}`, { input: fixture(`${name}.svg`), sizes: [32], bg: BG, zopfli: false, ...extra });

  // Distance from the icon's centre to the FAR corner of a pixel, so the whole pixel counts.
  const reach = (x, y, px) => Math.hypot(
    Math.max(Math.abs(x - px / 2), Math.abs(x + 1 - px / 2)),
    Math.max(Math.abs(y - px / 2), Math.abs(y + 1 - px / 2)));
  // Everything that is not the ground. Quantisation may nudge the ground by a few levels, so
  // the test is "far from it" rather than "equal to it".
  const markPixels = (img, [r, g, b]) => {
    const out = [];
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * 4;
        if (Math.abs(img.data[o] - r) + Math.abs(img.data[o + 1] - g) + Math.abs(img.data[o + 2] - b) > 24) out.push([x, y]);
      }
    }
    return out;
  };
  const farthest = (out, file, px) => {
    const img = decode(readFileSync(join(out, file)));
    const pts = markPixels(img, [0x12, 0x34, 0x56]);
    assert.ok(pts.length > 0, `no mark pixels found in ${file}`);
    return Math.max(...pts.map(([x, y]) => reach(x, y, px)));
  };
  const ICONS = [['apple-touch-icon.png', 180, 'apple'], ['icon-maskable-512.png', 512, 'maskable']];

  it('are a 180px apple-touch-icon and one 512px maskable icon, both opaque', async () => {
    const { out } = await MASKED('general');
    assert.deepEqual(readdirSync(out).sort(),
      ['apple-touch-icon.png', 'favicon.ico', 'icon-32.png', 'icon-maskable-512.png', 'icon.svg', 'logo.svg']);
    for (const [file, px] of ICONS) {
      const buf = readFileSync(join(out, file));
      assert.equal(header(buf).width, px, `${file} width`);
      assert.equal(header(buf).height, px, `${file} height`);
      const img = decode(buf);
      for (let i = 3; i < img.data.length; i += 4) {
        if (img.data[i] !== 255) assert.fail(`transparent pixel at ${(i - 3) / 4} in ${file}`);
      }
    }
  });

  it('keep a curved mark at its exact fit: every pixel inside the safe circle, and filling it', async () => {
    const { out, fit } = await MASKED('general');
    for (const [file, px, key] of ICONS) {
      assert.equal(fit[key].snapped, false, `${file}: a curved mark was shrunk to snap to pixels it never lands on`);
      const far = farthest(out, file, px), safe = 0.4 * px;
      assert.ok(far <= safe + 1.5, `${file}: a mark pixel reaches ${far.toFixed(1)} px; the safe circle ends at ${safe}`);
      assert.ok(far >= safe - 3, `${file}: the mark stops ${(safe - far).toFixed(1)} px short of the safe circle`);
    }
  });

  it('snap a pixel-grid mark to whole pixels, within 10% of the fit, and lose its anti-aliasing', async () => {
    // tiles.svg is drawn on a grid: at its exact fit every edge falls between pixels.
    const { out, fit } = await MASKED('tiles');
    assert.equal(fit.maskable.snapped, true, `not snapped (box ${fit.maskable.box})`);
    const far = farthest(out, 'icon-maskable-512.png', 512), safe = 0.4 * 512;
    assert.ok(far <= safe + 1.5, `a mark pixel reaches ${far.toFixed(1)} px`);
    assert.ok(far >= safe * 0.9 - 2, `snapped ${(100 - far / safe * 100).toFixed(1)}% below the fit; the window is 10%`);
    const colours = (file, opaqueOnly) => {
      const img = decode(readFileSync(join(out, file)));
      const set = new Set();
      for (let i = 0; i < img.data.length; i += 4) {
        if (!opaqueOnly || img.data[i + 3] === 255) set.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
      }
      return set.size;
    };
    const masked = colours('icon-maskable-512.png', false), source = colours('icon-32.png', true);
    assert.ok(masked <= source + 1, `${masked} colours: the snapped icon still carries edge blends`);
  });

  it('enlarge a mark drawn small, because its own margin means nothing under a mask', async () => {
    // flat.svg is a circle of radius 19/64: it reaches 0.30 of the icon, inside the 0.40 zone.
    const { fit } = await MASKED('flat');
    for (const key of ['apple', 'maskable']) {
      assert.ok(fit[key].scale > 1.2 && fit[key].scale < 1.5, `${key} scale ${fit[key].scale}`);
    }
  });

  it('--padding places the mark at exactly that fraction', async () => {
    // An explicit percentage must be obeyed literally: box = canvas * (1 - 2p), rounded down
    // to an even pixel so the offset stays whole. 20% of 512 leaves 60% = 307 -> 306.
    const out = freshDir();
    const r = await build({ input: fixture('tiles.svg'), out, sizes: [512], padding: 20, zopfli: false });
    assert.equal(r.fit.apple.padding, 20);
    assert.equal(r.fit.apple.box, 108);          // 180 * 0.6 = 108, already even
    assert.equal(r.fit.apple.snapped, false, 'an explicit padding must not be snapped away');
  });

  it('--padding auto still measures and snaps', async () => {
    const out = freshDir();
    const r = await build({ input: fixture('tiles.svg'), out, sizes: [512], padding: 'auto', zopfli: false });
    assert.equal(r.fit.apple.box, 112, 'tiles is a pixel-grid mark and snaps to 112 of 180');
    assert.equal(r.fit.apple.snapped, true);
  });

  it('are inside the accuracy bar against references placed the same way', async () => {
    const { out } = await MASKED('general', { colors: 16 });
    const resvg = await toolPath('resvg');
    for (const [file, px] of ICONS) {
      const ref = await reference(resvg, { source: fixture('general.svg'), px, bg: BG, vars: {}, fitted: true });
      const s = score(decode(readFileSync(join(out, file))), ref);
      assert.ok(s.pct <= THRESHOLD_PCT, `${file}: pct ${s.pct.toFixed(4)}%`);
    }
  });

  it('list the maskable icon after the "any" ones, and never icon.svg or the apple icon', async () => {
    const out = freshDir();
    const r = await cli(['--bg', '#fff', '--manifest', '--sizes', '32', '-o', out, fixture('flat.svg')]);
    assert.equal(r.code, 0, r.stderr);
    const m = JSON.parse(readFileSync(join(out, 'site.webmanifest'), 'utf8'));
    assert.deepEqual(m.icons.map((i) => [i.src, i.sizes, i.purpose]),
      [['/icon-32.png', '32x32', undefined], ['/icon-maskable-512.png', '512x512', 'maskable']]);
    assert.ok(!m.icons.some((i) => i.src.endsWith('.svg')), 'an SVG entry breaks Android WebAPK installs');
    assert.match(r.stdout, /apple-touch-icon\.png .* mark at \d+px of 180 in the safe zone/);
    assert.match(r.stdout, /icon-maskable-512\.png .* mark at \d+px of 512 in the safe zone/);
  });

  it('write no maskable icon when --bg none keeps the apple icon transparent', async () => {
    const out = freshDir();
    const r = await cli(['--bg', 'none', '--manifest', '--sizes', '32', '-o', out, fixture('flat.svg')]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(out, 'icon-maskable-512.png')), 'a transparent maskable icon was written');
    const m = JSON.parse(readFileSync(join(out, 'site.webmanifest'), 'utf8'));
    assert.deepEqual(m.icons.map((i) => i.src), ['/icon-32.png']);
  });

  it('use a full-bleed source as it is', async () => {
    const svg = join(scratch, 'bleed.svg');
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" fill="#0E7C68"/><circle cx="32" cy="32" r="20" fill="#F4F1EA"/></svg>');
    const out = freshDir();
    const r = await build({ input: svg, out, sizes: [32], bg: '#000000', zopfli: false });
    for (const [file, px, key] of ICONS) {
      assert.equal(r.fit[key].fullBleed, true, key);
      assert.equal(r.fit[key].box, px, key);
      // The --bg ground never shows: the corner is the source's own ground, not black.
      const img = decode(readFileSync(join(out, file)));
      assert.ok(Math.abs(img.data[0] - 0x0E) + Math.abs(img.data[1] - 0x7C) + Math.abs(img.data[2] - 0x68) < 24,
        `${file}: corner pixel is ${[...img.data.slice(0, 3)]}, expected the source's own ground`);
    }
  });
});

// ------------------------------------------------------------------ 11, 12 --

describe('determinism and atomicity', { skip: skipNoTools }, () => {
  it('re-running with the same inputs produces the same bytes', async () => {
    const a = freshDir(), b = freshDir();
    const opts = { input: fixture('general.svg'), sizes: [32], bg: '#ffffff', manifest: true };
    await build({ ...opts, out: a });
    await build({ ...opts, out: b });
    for (const f of readdirSync(a)) {
      assert.deepEqual([...readFileSync(join(a, f))], [...readFileSync(join(b, f))], `${f} differs between runs`);
    }
  });

  it('leaves no staging directory behind, on success or on failure', async () => {
    const out = freshDir();
    await build({ input: fixture('flat.svg'), out, sizes: [32] });
    await assert.rejects(build({ input: fixture('unresolved.svg'), out, sizes: [32] }), FavconError);
    assert.deepEqual(readdirSync(out).filter((f) => f.startsWith('.favcon')), []);
  });

  it('leaves a previous output set intact when a later run fails', async () => {
    const out = freshDir();
    await build({ input: fixture('flat.svg'), out, sizes: [32] });
    const before = Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(join(out, f))]));
    await assert.rejects(build({ input: fixture('unresolved.svg'), out, sizes: [32] }), FavconError);
    const after = Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(join(out, f))]));
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    for (const f of Object.keys(before)) assert.deepEqual([...after[f]], [...before[f]], `${f} was disturbed`);
  });

  it('removes its temp directory on success and on failure', async () => {
    // A PRIVATE temp directory for the duration, so the assertion sees only what these two
    // builds created. Snapshotting the shared tmpdir() made this fail whenever anything else
    // on the machine happened to be building at the same time - a benchmark run caught it,
    // and CI running jobs in parallel would have caught it later and more confusingly.
    const priv = freshDir();
    mkdirSync(priv, { recursive: true });
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    Object.assign(process.env, { TMPDIR: priv, TEMP: priv, TMP: priv });
    try {
      await build({ input: fixture('flat.svg'), out: freshDir(), sizes: [32], zopfli: false });
      await assert.rejects(build({ input: fixture('unresolved.svg'), out: freshDir(), sizes: [32] }));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    assert.deepEqual(readdirSync(priv), [], 'a temp directory outlived the build');
  });
});

// ---------------------------------------------------------------------- 13 --

describe('bad input fails clearly', () => {
  const cases = [
    [['--colors', '1', 'X'], /--colors must be an integer 2-256/],
    [['--colors', '257', 'X'], /--colors must be an integer 2-256/],
    [['--colors', '0x10', 'X'], /--colors must be an integer 2-256, got '0x10'/],
    [['--sizes', 'big', 'X'], /--sizes takes pixel sizes, got 'big'/],
    [['--frobnicate', 'X'], /unknown option: --frobnicate/],
    [['--var', 'novalue', 'X'], /--var takes name=value/],
  ];
  for (const [args, expect] of cases) {
    it(`${args.join(' ')}`, async () => {
      const r = await cli(args.map((a) => (a === 'X' ? fixture('general.svg') : a)).concat(['--bg', '#fff']));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^favcon: /m);
      assert.match(r.stderr, expect);
      assert.ok(!/\n\s+at /.test(r.stderr), `a stack trace leaked:\n${r.stderr}`);
    });
  }

  it('a missing file', async () => {
    const r = await cli(['--bg', '#fff', join(scratch, 'nope.svg')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: no such file: /m);
  });

  it('a file that is not an SVG', async () => {
    const r = await cli(['--bg', '#fff', fixture('notsvg.txt')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: not an SVG \(no <svg> element found\): notsvg\.txt$/m);
  });

  it('a --bg resvg will not take', { skip: skipNoTools }, async () => {
    const r = await cli(['--bg', 'nonered', fixture('flat.svg'), '-o', freshDir()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^favcon: --bg is not a colour resvg accepts: 'nonered'/m);
  });
});

// ---------------------------------------------------------------------- 14 --

describe('animation lands in logo.svg and nowhere else', { skip: skipNoTools }, () => {
  it('keeps the guard, resolves var() inside it, and every class is live', async () => {
    const { out } = await SMALL('animated');
    const logo = readFileSync(join(out, 'logo.svg'), 'utf8');
    assert.match(logo, /@media[^{]*prefers-reduced-motion/, 'the reduced-motion guard is gone');
    assert.match(logo, /animation:/, 'the animation declaration is gone');
    assert.ok(!logo.includes('var('), 'an unresolved var() reached logo.svg');
    assert.ok(!/\srole=/.test(logo) && !/\saria-/.test(logo), 'role/aria survived in logo.svg');

    const selectors = new Set([...logo.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
    for (const m of logo.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/).filter(Boolean)) {
        assert.ok(selectors.has(c), `class="${c}" is not selected by anything`);
      }
    }
  });

  it('still inlines the palette when only the motion class is at risk', () => {
    // The shape almost every animated mark actually has: palette classes named once at the
    // top level, and a motion class named ONLY inside the reduced-motion guard. Nothing
    // inlines `.blink`, so nothing can strip it - inlining the palette is safe, and turning
    // it off "to be careful" cost 44 B on a real logo.
    const logo = optimiseSvg(readFileSync(fixture('tiles.svg'), 'utf8'), { icon: false }).data;
    assert.match(logo, /fill="#2f4858"/, 'the palette was not inlined onto the element');
    assert.match(logo, /fill="#f6ae2d"/, 'the palette was not inlined onto the element');
    assert.ok(!/\.base\s*\{/.test(logo), '.base survived as a rule instead of being inlined');
    assert.ok(!/\.spark\s*\{/.test(logo), '.spark survived as a rule instead of being inlined');
    assert.match(logo, /class="blink"/, 'the motion class was stripped');
    assert.match(logo, /@media[^{]*prefers-reduced-motion/, 'the guard was dropped');
    assert.match(logo, /animation:/, 'the animation declaration was dropped');
  });

  it('turns inlining off only when a class is named by an inlinable rule too', () => {
    // animated.svg names .ring both at the top level and inside the guard. Inlining the
    // first would delete the class the second still needs, and csso would then drop the
    // @media rule as unused - a silently static "animated" logo.
    const logo = optimiseSvg(readFileSync(fixture('animated.svg'), 'utf8'), { icon: false }).data;
    assert.match(logo, /@media[^{]*prefers-reduced-motion/);
    assert.match(logo, /class="ring"/, '.ring was consumed despite the guard still needing it');
    assert.match(logo, /\.ring\s*\{/, 'the .ring rule was inlined away');
  });

  it('--var reaches inside the animation', async () => {
    const out = freshDir();
    await build({ input: fixture('animated.svg'), out, sizes: [32], vars: { loop: '1' } });
    const logo = readFileSync(join(out, 'logo.svg'), 'utf8');
    assert.match(logo, /animation:[^}]*\b1\b/, 'the loop count was not overridden');
    assert.ok(!logo.includes('infinite'), 'the fallback survived the override');
  });

  it('reports the source as animated, and a static one as not', async () => {
    assert.equal((await SMALL('animated')).animated, true);
    assert.equal((await SMALL('smil')).animated, true);
    assert.equal((await SMALL('general')).animated, false);
  });

  it('--no-animation makes logo.svg equal icon.svg', async () => {
    const { out } = await SMALL('animated', { animation: false });
    assert.equal(readFileSync(join(out, 'logo.svg'), 'utf8'), readFileSync(join(out, 'icon.svg'), 'utf8'));
  });

  it('a static source gets logo.svg as a copy of icon.svg', async () => {
    const { out } = await SMALL('general');
    assert.equal(readFileSync(join(out, 'logo.svg'), 'utf8'), readFileSync(join(out, 'icon.svg'), 'utf8'));
  });

  it('icon.svg and every raster are byte-identical in both modes', async () => {
    const a = await SMALL('animated');
    const b = await SMALL('animated', { animation: false });
    for (const f of ['icon.svg', 'icon-32.png', 'apple-touch-icon.png', 'favicon.ico']) {
      assert.deepEqual([...readFileSync(join(a.out, f))], [...readFileSync(join(b.out, f))],
        `${f} differs between the default and --no-animation builds`);
    }
  });

  it('keeps a non-motion declaration that shares a style attribute with a motion one', async () => {
    const { out } = await SMALL('smil');
    const icon = readFileSync(join(out, 'icon.svg'), 'utf8');
    assert.ok(!icon.includes('animation'), 'the animation declaration survived');
    assert.ok(!icon.includes('<animate'), 'a SMIL element survived');
    assert.match(icon, /opacity=".9"|opacity=".90*"/, 'the non-motion opacity was thrown away with it');
  });

  it('a var() used only by the animation fails the logo pass, naming --no-animation', async () => {
    const out = freshDir();
    const r = await cli(['--bg', '#fff', '--sizes', '32', '-o', out, fixture('animvar.svg')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unresolved var\(--beat\)/);
    assert.match(r.stderr, /--no-animation/);
    assert.ok(!existsSync(out), 'a failed run left an output directory');
  });

  it('...and builds cleanly with --no-animation', async () => {
    const out = freshDir();
    const r = await cli(['--bg', '#fff', '--sizes', '32', '--no-animation', '-o', out, fixture('animvar.svg')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(out, 'logo.svg'), 'utf8'), readFileSync(join(out, 'icon.svg'), 'utf8'));
  });
});

// ------------------------------------------------------------------ 16, 17 --

describe('rendering', { skip: skipNoTools }, () => {
  it('renders 32px once: icon-32.png and the ICO payload are the same bytes', async () => {
    const { out } = await SMALL('second');
    const icon32 = readFileSync(join(out, 'icon-32.png'));
    const payload = readFileSync(join(out, 'favicon.ico')).subarray(22);
    assert.deepEqual([...icon32], [...payload]);
  });

  it('warns on a non-square viewBox, and still emits square rasters', async () => {
    const out = freshDir();
    const r = await cli(['--bg', '#fff', '--sizes', '32', '-o', out, fixture('wide.svg')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^favcon: warning: viewBox 128x64 is not square/m);
    const h = header(readFileSync(join(out, 'icon-32.png')));
    assert.equal(h.width, 32);
    assert.equal(h.height, 32);
    // logo.svg is the mark, not an icon: it keeps the proportions it was drawn with.
    assert.ok(!readFileSync(join(out, 'logo.svg'), 'utf8').includes('preserveAspectRatio'));
  });

  it('warns when --bg is not given', async () => {
    const r = await cli(['--sizes', '32', '-o', freshDir(), fixture('flat.svg')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^favcon: warning: --bg not given/m);
  });
});

// ---------------------------------------------------------------------- 18 --

describe('the published tarball', () => {
  it('contains bin/ and astro/ and nothing from test, docs, bench or .github', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
    // npm <= 11 prints an array of packages; npm 12 prints an object keyed by name.
    const parsed = JSON.parse(raw);
    const pkg = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const files = pkg.files.map((f) => f.path);
    assert.ok(files.includes('bin/favcon.mjs'), 'bin/favcon.mjs is missing');
    // bin/favcon.mjs imports lib/core.mjs, so a tarball without it installs and then throws
    // ERR_MODULE_NOT_FOUND on first run. This assertion is the only thing standing between
    // the split and a broken publish.
    assert.ok(files.includes('lib/core.mjs'), 'lib/core.mjs is missing - the package cannot run');
    assert.ok(files.some((f) => f.startsWith('astro/')), 'astro/ is missing');
    assert.ok(files.includes('package.json') && files.includes('README.md'));
    for (const f of files) {
      assert.ok(!/^(test|docs|bench|\.github)\//.test(f), `${f} must not ship`);
    }
  });
});

// ------------------------------------------------- the binary-free surface --
// These run everywhere, including the Windows job that has no rasteriser.

describe('the svg stage on its own', () => {
  const read = (n) => readFileSync(fixture(`${n}.svg`), 'utf8');

  it('strips animation for icon.svg and keeps it for logo.svg', () => {
    const src = read('animated');
    const icon = optimiseSvg(src, { icon: true });
    const logo = optimiseSvg(src, { icon: false });
    assert.ok(icon.stripped > 0, 'nothing was reported as stripped');
    assert.ok(!icon.data.includes('<style'), 'icon.svg kept a stylesheet');
    assert.ok(!icon.data.includes('animation'), 'icon.svg kept an animation');
    assert.match(logo.data, /prefers-reduced-motion/);
    assert.match(logo.data, /animation:/);
  });

  it('reports a static source as having nothing to strip', () => {
    assert.equal(optimiseSvg(read('general'), { icon: true }).stripped, 0);
  });

  it('hoists @keyframes out of the at-rule svgo 4.1.0 cannot walk', () => {
    // Nested @keyframes reaches css-select as the selector `0%` and throws
    // "Unmatched selector: %". The hoist is what stops that being a crash.
    const logo = optimiseSvg(read('animated'), { icon: false });
    const style = /<style>([\s\S]*?)<\/style>/.exec(logo.data)[1];
    const mediaAt = style.indexOf('@media');
    const kfAt = style.indexOf('@keyframes');
    assert.ok(kfAt !== -1 && mediaAt !== -1);
    assert.ok(!/@media[^{]*\{[^}]*@keyframes/.test(style), '@keyframes is still nested inside @media');
  });

  it('resolves var() from the fallback and from an override', () => {
    const a = optimiseSvg(read('general'), { icon: true });
    assert.match(a.data, /#1f3a5f/i);
    const b = optimiseSvg(read('general'), { icon: true, vars: { ground: '#123456' } });
    assert.match(b.data, /#123456/);
    assert.ok(!/#1f3a5f/i.test(b.data));
  });

  it('throws FavconError, naming --no-animation only for the logo pass', () => {
    const src = read('animvar');
    assert.doesNotThrow(() => optimiseSvg(src, { icon: true }));
    assert.throws(() => optimiseSvg(src, { icon: false }), (e) => {
      assert.ok(e instanceof FavconError);
      assert.match(e.message, /unresolved var\(--beat\)/);
      assert.match(e.message, /--no-animation/);
      return true;
    });
  });

  it('keeps a non-motion declaration when it strips a motion one beside it', () => {
    const icon = optimiseSvg(read('smil'), { icon: true });
    assert.ok(!icon.data.includes('<animate'));
    assert.ok(!icon.data.includes('animation'));
    assert.match(icon.data, /opacity=/);
  });

  it('drops role and aria-* from both passes', () => {
    for (const icon of [true, false]) {
      const out = optimiseSvg(read('animated'), { icon }).data;
      assert.ok(!/\srole=/.test(out) && !/\saria-/.test(out), `icon=${icon}`);
    }
  });

  it('icon.svg equals the same source with its animation deleted by hand', () => {
    // The strongest form of "animation never reaches a raster": not that the output looks
    // right, but that it is the same file you would get from a source that never had any.
    const src = read('animated');
    const at = src.indexOf('@media');
    let depth = 0, end = -1;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    assert.ok(end > at, 'the fixture no longer has a @media block to remove');
    const byHand = src.slice(0, at) + src.slice(end + 1);
    assert.ok(!byHand.includes('@keyframes'), 'the hand strip missed something');

    assert.equal(optimiseSvg(src, { icon: true }).data, optimiseSvg(byHand, { icon: true }).data);
  });

  it('is deterministic', () => {
    const src = read('mask');
    assert.equal(optimiseSvg(src, { icon: true }).data, optimiseSvg(src, { icon: true }).data);
  });
});

describe('option validation, without touching a binary', () => {
  const bad = async (options, expect) => {
    await assert.rejects(build({ input: fixture('general.svg'), ...options }), (e) => {
      assert.ok(e instanceof FavconError, `expected FavconError, got ${e?.name}`);
      assert.match(e.message, expect);
      return true;
    });
  };

  it('rejects a palette outside 2-256', async () => {
    await bad({ colors: 1 }, /--colors must be an integer 2-256/);
    await bad({ colors: 257 }, /--colors must be an integer 2-256/);
    await bad({ colors: '0x10' }, /got '0x10'/);
  });

  it('rejects a size that is not a pixel count', async () => {
    await bad({ sizes: ['big'] }, /--sizes takes pixel sizes, got 'big'/);
    await bad({ sizes: [] }, /--sizes is empty/);
  });

  it('rejects a var name that is not a custom property', async () => {
    await bad({ vars: { 'not a name': 'x' } }, /must be a CSS custom property/);
  });

  it('rejects a missing input and a non-SVG one', async () => {
    await assert.rejects(build({ input: join(scratch, 'nope.svg') }), /no such file/);
    await assert.rejects(build({ input: fixture('notsvg.txt') }), /not an SVG/);
  });
});

// ---------------------------------------------------- the Astro integration --
// Driven with stub hook arguments rather than a real Astro build: the contract that matters
// is which hook does what, and a real build would test Astro rather than favcon.

describe('the astro integration', () => {
  const stub = (root, base = '/') => {
    const calls = { watched: [], middleware: [], configs: [], logs: [] };
    return {
      calls,
      args: {
        config: {
          root: pathToFileURL(root + '/'),
          publicDir: pathToFileURL(join(root, 'public') + '/'),
          base,
        },
        addWatchFile: (f) => calls.watched.push(String(f)),
        addMiddleware: (m) => calls.middleware.push(m),
        updateConfig: (c) => calls.configs.push(c),
        logger: {
          info: (m) => calls.logs.push(['info', m]),
          warn: (m) => calls.logs.push(['warn', m]),
        },
      },
    };
  };

  const linksFrom = (calls) => {
    const plugin = calls.configs.flatMap((c) => c.vite?.plugins ?? [])
      .find((p) => p.name === 'favcon:virtual');
    return plugin.load('\0virtual:favcon');
  };

  it('bails immediately on sync and on preview', async () => {
    for (const command of ['sync', 'preview']) {
      const root = freshDir();
      const s = stub(root);
      await favconAstro({ input: 'logo.svg' }).hooks['astro:config:setup']({ command, ...s.args });
      assert.deepEqual(s.calls.watched, [], `${command} watched a file`);
      assert.deepEqual(s.calls.middleware, [], `${command} registered middleware`);
    }
  });

  it('config:setup watches the input and registers middleware, and does not build', async () => {
    const root = freshDir();
    const s = stub(root);
    await favconAstro({ input: 'src/logo.svg' }).hooks['astro:config:setup']({ command: 'build', ...s.args });
    assert.deepEqual(s.calls.watched, [join(root, 'src', 'logo.svg')]);
    assert.equal(s.calls.middleware.length, 1);
    assert.equal(s.calls.middleware[0].order, 'post');
    assert.equal(s.calls.middleware[0].entrypoint, 'favcon/astro/middleware');
    assert.ok(!existsSync(join(root, 'public')), 'config:setup built something');
  });

  it('prefixes config.base and keeps sizes="32x32" on the ICO', async () => {
    const root = freshDir();
    const s = stub(root, '/blog/');
    await favconAstro({}).hooks['astro:config:setup']({ command: 'build', ...s.args });
    const links = linksFrom(s.calls);
    assert.match(links, /\/blog\/favicon\.ico/);
    assert.match(links, /\/blog\/icon\.svg/);
    assert.match(links, /\/blog\/apple-touch-icon\.png/);
    assert.match(links, /sizes=\\"32x32\\"/);
    assert.ok(!links.includes('logo.svg'), 'logo.svg must not be linked');
  });

  it('head: false logs the block instead of registering middleware', async () => {
    const root = freshDir();
    const s = stub(root);
    await favconAstro({ head: false }).hooks['astro:config:setup']({ command: 'build', ...s.args });
    assert.deepEqual(s.calls.middleware, []);
    assert.ok(s.calls.logs.some(([, m]) => m.includes('rel="icon"')), 'the block was not logged');
  });

  it('rejects an option it cannot honour', () => {
    assert.throws(() => favconAstro({ dev: 'sometimes' }), /dev must be/);
    assert.throws(() => favconAstro({ head: 'maybe' }), /head must be/);
  });

  it('builds into public/ and hits the cache the second time',
    { skip: skipNoTools }, async () => {
      const root = freshDir();
      const s = stub(root);
      const integration = favconAstro({ input: 'logo.svg', sizes: [32] });
      copyFileSync(fixture('flat.svg'), (mkdirSync(root, { recursive: true }), join(root, 'logo.svg')));
      await integration.hooks['astro:config:setup']({ command: 'build', ...s.args });
      await integration.hooks['astro:build:start']({ logger: s.args.logger });

      const pub = join(root, 'public');
      assert.deepEqual(readdirSync(pub).sort(),
        ['apple-touch-icon.png', 'favicon.ico', 'icon-32.png', 'icon-maskable-512.png', 'icon.svg', 'logo.svg']);

      const before = readFileSync(join(pub, 'favicon.ico'));
      s.calls.logs.length = 0;
      await integration.hooks['astro:build:start']({ logger: s.args.logger });
      assert.ok(s.calls.logs.some(([, m]) => m.startsWith('cache hit')), 'the second run rebuilt');
      assert.deepEqual([...readFileSync(join(pub, 'favicon.ico'))], [...before]);
    });

  it('keeps going when public/ already holds exactly what it would write',
    { skip: skipNoTools }, async () => {
      // The clean-install case: node_modules/.cache is gone, so the stamp is gone, but the
      // files in public/ are still favcon's because the same input produces the same bytes.
      const root = freshDir();
      const s = stub(root);
      const integration = favconAstro({ input: 'logo.svg', sizes: [32] });
      mkdirSync(root, { recursive: true });
      copyFileSync(fixture('flat.svg'), join(root, 'logo.svg'));
      await integration.hooks['astro:config:setup']({ command: 'build', ...s.args });
      await integration.hooks['astro:build:start']({ logger: s.args.logger });

      rmSync(join(root, 'node_modules'), { recursive: true, force: true });
      await integration.hooks['astro:build:start']({ logger: s.args.logger });
      assert.ok(existsSync(join(root, 'public', 'favicon.ico')));
    });

  it('refuses to overwrite a favicon.ico it did not write',
    { skip: skipNoTools }, async () => {
      const root = freshDir();
      const s = stub(root);
      const integration = favconAstro({ input: 'logo.svg', sizes: [32] });
      mkdirSync(join(root, 'public'), { recursive: true });
      copyFileSync(fixture('flat.svg'), join(root, 'logo.svg'));
      writeFileSync(join(root, 'public', 'favicon.ico'), 'a hand-tuned icon nobody should clobber');

      await integration.hooks['astro:config:setup']({ command: 'build', ...s.args });
      await assert.rejects(integration.hooks['astro:build:start']({ logger: s.args.logger }),
        /public\/favicon\.ico already exists and favcon did not write it/);
    });
});
