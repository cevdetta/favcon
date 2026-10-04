#!/usr/bin/env node
// The measurement harness. Sweeps the axes the pipeline was chosen on, over test/fixtures/,
// prints a table per sweep and regenerates docs/BENCHMARKS.md.
//
//   node bench/bench.mjs                  every sweep
//   node bench/bench.mjs colors dither    those two alone
//   node bench/bench.mjs --write          also rewrite docs/BENCHMARKS.md
//
// Scratch output goes to bench/out/, which is gitignored. Nothing here is imported by the
// tool; it exists so that "every pipeline change arrives with a number" is a command rather
// than an aspiration.

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, engineVersions, icoWrap } from '../bin/favcon.mjs';
import { DEFAULT_COLORS } from '../lib/core.mjs';
import { reference, score } from '../test/lib/accuracy.mjs';
import { decode } from '../test/lib/png.mjs';
import { nativeVersions, run } from './native.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const FIXTURES = join(ROOT, 'test', 'fixtures');
const OUT = join(HERE, 'out');

// Every fixture that builds. The negative ones do not, by design.
const MARKS = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil'];
// [label, px, file, ground, placed]: every raster a default build writes except the ICO.
// The whole set is padded into the safe zone now, so every row is placed on the ground.
const CHECKS = [
  ['180m', 180, 'apple-touch-icon.png', '#000000', true],
  ['192m', 192, 'icon-192.png', '#000000', true],
  ['512m', 512, 'icon-512.png', '#000000', true],
];

const size = (p) => statSync(p).size;
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

/** Raw, unquantised renders: the input to every sweep below. Rendered once. */
const rawRenders = async () => {
  const dir = join(OUT, 'raw');
  mkdirSync(dir, { recursive: true });
  const made = [];
  for (const m of MARKS) {
    // Render from favcon's own icon.svg, so the sweeps measure the PNG pipeline in
    // isolation rather than re-measuring svgo on every axis.
    const built = join(OUT, 'svg', m);
    await build({ input: join(FIXTURES, `${m}.svg`), out: built, sizes: [16], bg: null, zopfli: false });
    for (const px of [16, 32, 180, 192, 512]) {
      const f = join(dir, `${m}-${px}.png`);
      await run('resvg', ['--quiet', '-w', String(px), '-h', String(px), join(built, 'icon.svg'), f]);
      made.push({ mark: m, px, file: f });
    }
  }
  return made;
};

// ------------------------------------------------------------------ sweeps --

const sweeps = {};

sweeps.accuracy = async () => {
  const cols = [8, 16, 32, 64, 256];
  const rows = [];
  let worst = { pct: 0 };
  for (const m of MARKS) {
    for (const [label, px, file, bg, fitted] of CHECKS) {
      const cells = [];
      for (const c of cols) {
        const out = join(OUT, 'acc', `${m}-${c}-${label}`);
        await build({ input: join(FIXTURES, `${m}.svg`), out, sizes: [192, 512], colors: c, bg: '#000000', zopfli: false });
        const ref = await reference({ source: join(FIXTURES, `${m}.svg`), px, bg, vars: {}, fitted });
        const s = score(decode(readFileSync(join(out, file))), ref);
        cells.push(s.pct);
        if (m !== 'gradient' && s.pct > worst.pct) worst = { pct: s.pct, at: `${m}@${label}`, colors: c };
      }
      rows.push([m, label, ...cells]);
    }
  }
  const head = `${pad('mark', 10)}${num('size', 5)}${cols.map((c) => num('c' + c, 9)).join('')}`;
  const body = rows.map(([m, px, ...cs]) =>
    `${pad(m, 10)}${num(px, 5)}${cs.map((v) => num(v.toFixed(2), 9)).join('')}`);
  return { title: 'Accuracy: pct by mark, size and palette size',
           note: 'pct = share of pixels more than 8/255 from an unquantised reference, worse of a white and a black composite. The bar is 1.0 %. `gradient` is excluded from the worst-case line: it exists to make the lossless path win, and no palette of 256 or fewer colours holds a four-stop gradient inside the bar, so the size guard (decision 7) is what decides it.',
           text: [head, ...body].join('\n'),
           summary: `worst non-gradient: ${worst.pct.toFixed(3)} % (${worst.at}, --colors ${worst.colors})` };
};

sweeps.colors = async () => {
  const out = [];
  for (const c of [4, 8, 16, 32, 64, 128, 256]) {
    let bytes = 0, worst = 0, at = '';
    for (const m of MARKS) {
      if (m === 'gradient') continue;
      const dir = join(OUT, 'colors', `${m}-${c}`);
      const r = await build({ input: join(FIXTURES, `${m}.svg`), out: dir, sizes: [192, 512], colors: c, bg: '#000000' });
      for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) bytes += r.bytes[f];
      for (const [label, px, file, bg, fitted] of CHECKS) {
        const ref = await reference({ source: join(FIXTURES, `${m}.svg`), px, bg, vars: {}, fitted });
        const s = score(decode(readFileSync(join(dir, file))), ref);
        if (s.pct > worst) { worst = s.pct; at = `${m}@${label}`; }
      }
    }
    out.push([c, bytes, worst, at]);
  }
  const base = out.find((r) => r[0] === DEFAULT_COLORS)[1];
  const text = [`${num('colors', 7)}${num('bytes', 9)}${num(`vs c${DEFAULT_COLORS}`, 9)}${num('worst pct', 11)}  where`,
    ...out.map(([c, b, w, at]) =>
      `${num(c, 7)}${num(b, 9)}${num(((b / base - 1) * 100).toFixed(1) + '%', 9)}${num(w.toFixed(3) + '%', 11)}  ${at}${w <= 1 ? '' : '   OVER THE BAR'}`)].join('\n');
  return { title: 'Palette size: bytes against accuracy',
           note: `${MARKS.length - 1} marks (gradient excluded), 180 + 192 + 512 px all placed, zopfli on. This is the sweep that sets the default.`,
           text };
};

sweeps.dither = async () => {
  const raws = await rawRenders();
  const wins = { nofs: 0, floyd: 0, lossless: 0 };
  let bNofs = 0, bBest = 0;
  const dir = join(OUT, 'dither');
  mkdirSync(dir, { recursive: true });
  for (const { mark, px, file } of raws) {
    const cands = [];
    for (const [name, flag] of [['nofs', '--nofs'], ['floyd', '--floyd=1']]) {
      const f = join(dir, `${mark}-${px}-${name}.png`);
      try {
        await run('pngquant', ['--force', '--speed', '1', flag, '--colors', String(DEFAULT_COLORS), '--output', f, file]);
        await run('oxipng', ['-q', '-o', 'max', '-s', '-a', f]);
        cands.push([name, f]);
      } catch { /* 98/99: would be larger, or below the quality floor */ }
    }
    const l = join(dir, `${mark}-${px}-lossless.png`);
    copyFileSync(file, l);
    await run('oxipng', ['-q', '-o', 'max', '-s', '-a', l]);
    cands.push(['lossless', l]);
    let best = cands[0];
    for (const c of cands.slice(1)) if (size(c[1]) < size(best[1])) best = c;
    wins[best[0]]++;
    bBest += size(best[1]);
    const nofs = cands.find((c) => c[0] === 'nofs');
    bNofs += size((nofs ?? best)[1]);
  }
  const n = raws.length;
  return { title: `Which candidate wins, at --colors ${DEFAULT_COLORS} (the default)`,
           note: `One row per (mark, size) over ${MARKS.length} marks x 5 sizes. "keep smallest" is the guard from decision 7: it costs nothing when it never fires and stops a raised --colors from producing larger files.`,
           text: [`files                 ${n}`,
                  `no dither wins        ${wins.nofs}`,
                  `Floyd-Steinberg wins  ${wins.floyd}`,
                  `no pngquant wins      ${wins.lossless}`,
                  ``,
                  `always no-dither      ${bNofs} B`,
                  `keep smallest         ${bBest} B  (${((bBest / bNofs - 1) * 100).toFixed(2)} %)`].join('\n') };
};

sweeps.order = async () => {
  const raws = (await rawRenders()).filter((r) => r.px === 192);
  const dir = join(OUT, 'order');
  mkdirSync(dir, { recursive: true });
  let quantFirst = 0, oxiFirst = 0;
  for (const { mark, file } of raws) {
    const a = join(dir, `${mark}-qo.png`);
    await run('pngquant', ['--force', '--speed', '1', '--nofs', '--colors', String(DEFAULT_COLORS), '--output', a, file]);
    await run('oxipng', ['-q', '-o', 'max', '-s', '-a', a]);
    quantFirst += size(a);

    const b = join(dir, `${mark}-oq.png`);
    copyFileSync(file, b);
    await run('oxipng', ['-q', '-o', 'max', '-s', '-a', b]);
    const c = join(dir, `${mark}-oq2.png`);
    await run('pngquant', ['--force', '--speed', '1', '--nofs', '--colors', String(DEFAULT_COLORS), '--output', c, b]);
    oxiFirst += size(c);
  }
  return { title: 'Stage order at 192 px',
           note: 'pngquant re-encodes from scratch, so anything oxipng did before it is discarded. The measurement is not close.',
           text: [`pngquant then oxipng  ${quantFirst} B`,
                  `oxipng then pngquant  ${oxiFirst} B  (${((oxiFirst / quantFirst - 1) * 100).toFixed(1)} %)`].join('\n') };
};

// The `seconds` column here is the only wall-clock number in the whole harness, and it is
// only meaningful on an otherwise idle machine: a concurrent test run once made --zi 120
// look SLOWER than --zi 240. Run this sweep on its own, or do not believe the timings.
sweeps.zopfli = async () => {
  const raws = (await rawRenders()).filter((r) => r.px === 192 || r.px === 512);
  const dir = join(OUT, 'zopfli');
  mkdirSync(dir, { recursive: true });
  const rows = [];
  for (const zi of [15, 30, 60, 120, 240]) {
    let bytes = 0;
    const t0 = Date.now();
    for (const { mark, px, file } of raws) {
      const f = join(dir, `${mark}-${px}-${zi}.png`);
      await run('pngquant', ['--force', '--speed', '1', '--nofs', '--colors', String(DEFAULT_COLORS), '--output', f, file]);
      await run('oxipng', ['-q', '-o', 'max', '-s', '--zopfli', '--zi', String(zi), '-a', f]);
      bytes += size(f);
    }
    rows.push([zi, bytes, (Date.now() - t0) / 1000]);
  }
  const base = rows[0][1];
  return { title: 'Zopfli iterations',
           note: 'The default is 15. Bytes ship forever and build time does not, so the knee is taken on the byte side, but the curve is flat past 120.',
           text: [`${num('--zi', 6)}${num('bytes', 10)}${num('vs 15', 9)}${num('seconds', 10)}`,
             ...rows.map(([zi, b, s]) =>
               `${num(zi, 6)}${num(b, 10)}${num(((b / base - 1) * 100).toFixed(2) + '%', 9)}${num(s.toFixed(1), 10)}`)].join('\n') };
};

/**
 * Serial against concurrent rasters, crossed with the zopfli iteration count.
 *
 * Decision 13 says the rasters stay serial because oxipng already saturates the machine on
 * one file. A cross-tool comparison appeared to contradict it (favicon.sh renders four
 * sizes at once and finishes a like-for-like build in 12.5 s against favcon's 17.8 s), so
 * this re-runs the measurement under control.
 *
 * It crosses two axes on purpose, because the cross-tool gap confounds them: favicon.sh also
 * passes a bare `--zopfli`, which is `--zi 15`, where favcon passes `--zi 120`. Varying only
 * the scheduling would have credited the iteration count to concurrency.
 *
 * The arms do identical work (same jobs, same commands, same order) and differ only in how
 * many run at once and how hard zopfli tries. Repetitions are INTERLEAVED (every arm once,
 * then round again) rather than blocked, so drift and background load fall on every arm
 * alike instead of on whichever went last. "cores" is child CPU over wall clock, read from
 * /proc rather than inferred.
 */
sweeps.concurrency = async () => {
  const dir = join(OUT, 'conc');
  mkdirSync(dir, { recursive: true });

  const prep = join(dir, 'svg');
  await build({ input: join(FIXTURES, 'general.svg'), out: prep, sizes: [16], bg: null, zopfli: false });
  const iconSvg = join(prep, 'icon.svg');

  // The sizes a default build queues: the apple icon and the two --sizes entries on
  // their ground, and the ICO payload. Rendered from icon.svg for all four, since the
  // timing question is about oxipng contention, not about what is drawn.
  const JOBS = [{ px: 180, bg: '#000000' }, { px: 192, bg: '#000000' }, { px: 512, bg: '#000000' }, { px: 32, bg: null }];

  let seq = 0;
  const renderOne = async ({ px, bg }, zi) => {
    const tag = `${px}-${seq++}`;
    const raw = join(dir, `raw-${tag}.png`);
    await run('resvg', ['--quiet', '-w', String(px), '-h', String(px),
                        ...(bg ? ['--background', bg] : []), iconSvg, raw]);
    const cands = [];
    for (const [name, dither] of [['nofs', '--nofs'], ['floyd', '--floyd=1']]) {
      const f = join(dir, `${name}-${tag}.png`);
      try {
        // 16, not the shipped default of 8. This is a FIXED workload for a timing
        // comparison: every arm quantises the same way, so the palette only has to be the
        // same everywhere, and a larger one gives zopfli more to chew on. Do not "fix" it
        // to track the default; that would change the numbers without changing the answer.
        await run('pngquant', ['--force', '--speed', '1', dither, '--colors', '16', '--output', f, raw]);
      } catch { continue; }                      // 98/99: fall through to the lossless one
      await run('oxipng', ['-q', '-o', 'max', '-s', '-a', f]);
      cands.push(f);
    }
    const lossless = join(dir, `lossless-${tag}.png`);
    copyFileSync(raw, lossless);
    await run('oxipng', ['-q', '-o', 'max', '-s', '-a', lossless]);
    cands.push(lossless);
    let winner = cands[0];
    for (const c of cands.slice(1)) if (size(c) < size(winner)) winner = c;
    const final = join(dir, `final-${tag}.png`);
    copyFileSync(winner, final);
    await run('oxipng', ['-q', '-o', 'max', '-s', '--zopfli', '--zi', String(zi), '-a', final]);
    return size(final);
  };

  const pool = async (limit, zi) => {
    const queue = [...JOBS];
    // Collected, not accumulated: `total += await f()` reads `total` BEFORE the await, so
    // four concurrent workers all read 0 and three of the four updates are lost. That bug
    // made the concurrent arms report 3086 B against the serial arms' 5539 B for identical
    // output, which is the sort of thing that turns a benchmark into fiction unnoticed.
    const got = [];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) got.push(await renderOne(job, zi));
    }));
    return got.reduce((a, b) => a + b, 0);
  };

  // cutime + cstime from /proc: CPU burned by children this process has already reaped,
  // which is every resvg, pngquant and oxipng above. USER_HZ is 100 on every Linux worth
  // the name; where /proc is absent the column is dropped.
  const childCpu = () => {
    try {
      const f = readFileSync('/proc/self/stat', 'utf8');
      const t = f.slice(f.lastIndexOf(')') + 2).split(' ');
      return (Number(t[13]) + Number(t[14])) / 100;   // cutime + cstime, fields 16 and 17
    } catch { return null; }
  };

  const ARMS = [];
  for (const zi of [120, 15]) for (const limit of [1, 4]) ARMS.push({ zi, limit });
  const REPS = 3;
  const acc = ARMS.map(() => ({ wall: [], cpu: [], bytes: 0 }));
  for (let r = 0; r < REPS; r++) {
    for (let i = 0; i < ARMS.length; i++) {
      const c0 = childCpu(), t0 = Date.now();
      const bytes = await pool(ARMS[i].limit, ARMS[i].zi);
      acc[i].wall.push((Date.now() - t0) / 1000);
      acc[i].cpu.push(c0 === null ? null : childCpu() - c0);
      acc[i].bytes = bytes;
    }
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const shipped = mean(acc[0].wall);              // serial, --zi 120: what favcon does today
  const hasCpu = acc[0].cpu[0] !== null;
  const head = `${num('at once', 8)}${num('--zi', 6)}${num('wall', 9)}${num('min', 8)}${num('max', 8)}` +
               (hasCpu ? num('child cpu', 11) + num('cores', 8) : '') + num('bytes', 9) + num('vs shipped', 12);
  const body = ARMS.map((a, i) => {
    const w = mean(acc[i].wall), c = hasCpu ? mean(acc[i].cpu) : null;
    return `${num(a.limit === 1 ? '1 (serial)' : a.limit, 8)}${num(a.zi, 6)}${num(w.toFixed(2) + 's', 9)}` +
           `${num(Math.min(...acc[i].wall).toFixed(2), 8)}${num(Math.max(...acc[i].wall).toFixed(2), 8)}` +
           (hasCpu ? num(c.toFixed(1) + 's', 11) + num((c / w).toFixed(1) + 'x', 8) : '') +
           num(acc[i].bytes, 9) + num(((w / shipped - 1) * 100).toFixed(1) + '%', 12);
  });

  const conc120 = mean(acc[1].wall);
  return {
    title: 'Serial against concurrent rasters (decision 13, re-measured)',
    note: `Four jobs (180 px on a ground, 192, 512 and the 32 px ICO payload) through the full ` +
          `pipeline. ${REPS} interleaved repetitions per arm, identical work in every arm, on a ` +
          `${cpus().length}-core machine. The --zi axis is here because favicon.sh passes a bare ` +
          `--zopfli (which is --zi 15) where favcon passes --zi 120, and a comparison that varied ` +
          `only the scheduling would have credited that to concurrency.`,
    text: [head, ...body].join('\n'),
    summary: `concurrency buys ${((1 - conc120 / shipped) * 100).toFixed(1)} % at --zi 120; ` +
             `dropping to --zi 15 buys ${((1 - mean(acc[2].wall) / shipped) * 100).toFixed(1)} % ` +
             `and costs ${acc[2].bytes - acc[0].bytes} B`,
  };
};

sweeps.ico = async () => {
  const raws = (await rawRenders()).filter((r) => r.px === 32);
  const dir = join(OUT, 'ico');
  mkdirSync(dir, { recursive: true });
  let png = 0, bmp = 0, identical = 0, checked = 0;
  let haveIcotool = true;
  for (const { mark, file } of raws) {
    const q = join(dir, `${mark}.png`);
    await run('pngquant', ['--force', '--speed', '1', '--nofs', '--colors', String(DEFAULT_COLORS), '--output', q, file]);
    await run('oxipng', ['-q', '-o', 'max', '-s', '-a', q]);
    const mine = icoWrap(readFileSync(q), 32);
    png += mine.length;
    try {
      const rp = join(dir, `${mark}-r.ico`), bp = join(dir, `${mark}-b.ico`);
      await run('icotool', ['-c', '-r', q, '-o', rp]);
      await run('icotool', ['-c', q, '-o', bp]);
      bmp += size(bp);
      checked++;
      if (Buffer.compare(mine, readFileSync(rp)) === 0) identical++;
    } catch { haveIcotool = false; }
  }
  return { title: 'The ICO container',
           note: 'A PNG payload against icotool\'s default BMP one, and favcon\'s 22-byte writer against `icotool -c -r`.',
           text: [`raw PNG payload       ${png} B`,
                  ...(haveIcotool ? [
                    `BMP payload           ${bmp} B  (${(bmp / png).toFixed(1)}x)`,
                    `byte-identical to icotool -c -r   ${identical}/${checked}`,
                  ] : ['(icotool not installed: comparison skipped)'])].join('\n') };
};

// The native pipeline against the engine, on the same raw renders: what decision 26 rests on.
sweeps.engine = async () => {
  const { loadEngine } = await import('../bin/favcon.mjs');
  const engine = await loadEngine();
  const raws = await rawRenders();
  const dir = join(OUT, 'engine');
  mkdirSync(dir, { recursive: true });
  let native = 0, napi = 0, worstNative = 0, worstNapi = 0;
  for (const { mark, px, file } of raws) {
    const raw = readFileSync(file);
    // native: the old pipeline's three candidates, then zopfli on the winner
    const cands = [];
    for (const dither of ['--nofs', '--floyd=1']) {
      const f = join(dir, `${mark}-${px}${dither}.png`);
      try { await run('pngquant', ['--force', '--speed', '1', dither, '--colors', String(DEFAULT_COLORS), '--output', f, file]); }
      catch (e) { if (e.code !== 98 && e.code !== 99) throw e; continue; }
      await run('oxipng', ['-q', '-o', 'max', '-s', '-a', f]);
      cands.push(f);
    }
    const l = join(dir, `${mark}-${px}-lossless.png`);
    copyFileSync(file, l);
    await run('oxipng', ['-q', '-o', 'max', '-s', '-a', l]);
    cands.push(l);
    let best = cands[0];
    for (const c of cands) if (size(c) < size(best)) best = c;
    await run('oxipng', ['-q', '-o', 'max', '-s', '--zopfli', '--zi', '120', '-a', best]);
    native += size(best);
    const enc = await engine.finish(await engine.encode(raw, { colors: DEFAULT_COLORS }), { iterations: 120 });
    napi += enc.length;
    worstNative = Math.max(worstNative, score(decode(readFileSync(best)), decode(raw)).pct);
    worstNapi = Math.max(worstNapi, score(decode(Buffer.from(enc)), decode(raw)).pct);
  }
  return { title: 'Native pipeline against the engine',
           note: `The same ${raws.length} raw renders, encoded at --colors ${DEFAULT_COLORS} with zopfli at 120 iterations by both. pct is against the raw render.`,
           text: [`native   ${num(native, 7)} B   worst ${worstNative.toFixed(3)} %`,
                  `engine   ${num(napi, 7)} B   worst ${worstNapi.toFixed(3)} %   (${((napi / native - 1) * 100).toFixed(1)} %)`].join('\n') };
};

// Decision 27: does finishing the jobs in parallel worker threads beat finishing them in turn?
// WASM zopfli runs on one thread, unlike oxipng, so decision 13's reason may not hold.
sweeps.parallel = async () => {
  const { Worker } = await import('node:worker_threads');
  const { loadEngine } = await import('../bin/favcon.mjs');
  const engine = await loadEngine();
  const raws = (await rawRenders()).filter((r) => r.mark === 'general');
  const encs = await Promise.all(raws.map(async (r) => engine.encode(readFileSync(r.file), { colors: DEFAULT_COLORS })));
  const worker = `
    const { parentPort, workerData } = require('node:worker_threads');
    import('${new URL('../bin/favcon.mjs', import.meta.url).href}').then(async ({ loadEngine }) => {
      const e = await loadEngine();
      parentPort.postMessage((await e.finish(workerData, { iterations: 120 })).length);
    });`;
  const serial = [], parallel = [];
  for (let rep = 0; rep < 3; rep++) {
    let t = performance.now();
    for (const enc of encs) await engine.finish(enc, { iterations: 120 });
    serial.push((performance.now() - t) / 1000);
    t = performance.now();
    await Promise.all(encs.map((enc) => new Promise((ok, bad) => {
      const w = new Worker(worker, { eval: true, workerData: enc });
      w.once('message', ok); w.once('error', bad);
    })));
    parallel.push((performance.now() - t) / 1000);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[1];
  return { title: 'Finishing the jobs in turn against in parallel workers (decision 27)',
           note: `general.svg, ${encs.length} files, zopfli at 120 iterations, 3 interleaved repetitions, median shown.`,
           text: [`in turn     ${med(serial).toFixed(2)} s`, `in parallel ${med(parallel).toFixed(2)} s`].join('\n') };
};

// ------------------------------------------------------------------- main --

const main = async () => {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const want = args.filter((a) => !a.startsWith('--'));
  const names = want.length ? want : Object.keys(sweeps);
  for (const n of names) if (!sweeps[n]) { process.stderr.write(`bench: no sweep '${n}'\n`); process.exit(1); }

  // A partial --write would truncate the document to whichever sweeps ran, without a warning,
  // which is worse than not writing at all: the file claims to be the current state of every axis.
  if (write && names.length !== Object.keys(sweeps).length) {
    process.stderr.write('bench: --write needs every sweep; drop the sweep names or drop --write\n');
    process.exit(1);
  }

  const versions = { ...(await nativeVersions()), ...engineVersions() };

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const results = [];
  for (const n of names) {
    process.stderr.write(`bench: ${n}...\n`);
    const r = await sweeps[n]();
    results.push({ name: n, ...r });
    process.stdout.write(`\n## ${r.title}\n\n${r.text}\n${r.summary ? '\n' + r.summary + '\n' : ''}`);
  }

  if (write) {
    const doc = [
      '# Benchmarks',
      '',
      '<!-- Generated by `node bench/bench.mjs --write`. Do not edit by hand. -->',
      '',
      `Measured over \`test/fixtures/\` on ${new Date().toISOString().slice(0, 10)}, with:`,
      '',
      '```',
      ...Object.entries(versions).map(([k, v]) => `${k.padEnd(15)} ${v}`),
      `${'node'.padEnd(15)} ${process.version}`,
      '```',
      '',
      'These numbers come from the fixtures in this repository, which are not the 39-mark',
      'corpus the original decisions were taken on. Where they disagree, these are the ones',
      'to trust: they are the ones you can reproduce.',
      '',
      ...results.flatMap((r) => [
        `## ${r.title}`, '', r.note ?? '', r.note ? '' : null,
        '```', r.text, '```', '',
        ...(r.summary ? [`**${r.summary}**`, ''] : []),
      ].filter((l) => l !== null)),
    ].join('\n');
    writeFileSync(join(ROOT, 'docs', 'BENCHMARKS.md'), doc);
    process.stderr.write('bench: wrote docs/BENCHMARKS.md\n');
  }
};

await main();
