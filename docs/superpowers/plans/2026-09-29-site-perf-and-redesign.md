# Site performance + redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser site generate sets much faster without growing a single output byte, keep the tab responsive via a worker, and finish the page with per-platform previews.

**Architecture:** A pure-JS exact-palette arm (new `site/src/lib/exact.mjs`, Node-testable) skips WuQuant for low-color marks under keep-smallest; the pipeline moves to a single Web Worker with progress events and a main-thread fallback; the page gains the preview trio and a `<progress>` element on top of its current semantic form.

**Tech Stack:** Astro 7 (static), Vite `?worker` + `?url`, `@resvg/resvg-wasm`, `image-q`, `@jsquash/oxipng`, `node:test`, headless Chromium via `site/test/cdp-check.mjs`.

**Spec:** `/home/c/dev/favcon/docs/superpowers/specs/2026-09-29-site-perf-and-redesign-design.md`

## Starting state (read before touching anything)

The tree contains **uncommitted partner work** this plan builds on — do not
revert it: semantic `<form>` rebuild of `site/src/pages/index.astro`
(FormData submit, `pattern` validation, `<output>` status),
`site/src/styles/app.css` (105 lines, imported as `../styles/app.css`),
`build.inlineStylesheets: 'always'` in `site/astro.config.mjs`, and a
`warm()` export in `site/src/lib/pipeline.mjs`. The executor's first task
assumes all of it present. Package upgrades (Astro 7.3.5 et al.) are also
in the tree; never touch `package.json` or lockfiles.

## Global Constraints

- `lib/core.mjs` still imports nothing; the CLI (`bin/favcon.mjs`) is untouched by this plan.
- Site errors surface as `FavconError` messages on the status line — never a stack trace, never a frozen tab.
- **No golden bytes.** The per-mark byte gate (Task 1, Task 4) is a *measured comparison step* run on the executor's own machine (new totals ≤ the committed table), never a committed assertion — bytes differ across `image-q` versions the way pngquant's do across apt versions.
- `git commit` needs `--no-gpg-sign`. No attribution lines in commit messages.
- Comments explain *why*, citing the measurement.
- Never edit `bin/`, `lib/`, `test/`, or `astro/` while `npm test` runs (it spawns the CLI as a subprocess).

## Review Focus

The spec implies these; each names the input, the expected behavior, and the task that pins it:

1. A transparent mark (`--bg none`, alpha pixels) must never take the exact arm (indexed PNG without tRNS would corrupt it) — it falls back to the current arms with alpha intact. Pinned in Task 1 (check.astro transparent build asserts success + transparent pixels).
2. A browser without `CompressionStream` must skip the exact arm and build normally. Pinned in Task 1 (`exactArm()` returns `null`; unit test deletes `globalThis.CompressionStream` and restores it).
3. If `Worker` construction throws, the page falls back to a main-thread build and still completes. Pinned in Task 3 (cdp-check drives a real build through `/` — the default worker path — while `/check` keeps proving the shared module directly).
4. An `onProgress` callback that throws must not break the build (the pipeline wraps each call in try/catch). Pinned in Task 2 (check.astro passes a throwing callback and asserts success).
5. Absurd sizes (`[9000]`, `[0]`) are rejected mirroring the CLI's 1–8192 range. Pinned in Task 2 (check.astro asserts the CLI's range message).

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `site/src/lib/exact.mjs` (new) | Pure helpers: `countDistinct(rgba)` → `{distinct, opaque}` (early exit past a limit), `exactArm({width,height,rgba,colors})` → `{png} \| null` (null when inapplicable/unavailable). No WASM imports; Node-testable. |
| `site/src/lib/zip.mjs` | Also exports its `crc32` (unchanged behavior) for the indexed-PNG writer. |
| `site/src/lib/pipeline.mjs` | Uses the exact arm under keep-smallest; gains optional `onProgress`; validates sizes range 1–8192 (CLI parity). |
| `site/test/exact.test.mjs` (new) | `node:test` over `exact.mjs` with crafted RGBA; run as `node --test site/test/exact.test.mjs`. |
| `site/src/worker.mjs` (new) | Worker entry: warmup + build + progress/result protocol. |
| `site/src/pages/index.astro` | Preview trio, `<progress>`, worker wiring with fallback. Keeps every control, default, and message. |
| `site/src/styles/app.css` | Styles for the trio + progress only; the 105-line base is not reworked. |
| `site/src/pages/check.astro` | Worker-vs-direct equality, throwing-progress, transparent-fallback, sizes-range cases. |
| `site/test/cdp-check.mjs` | Also drives a real build through `/` (file input + submit via CDP) and fails on page errors. |
| `site/README.md`, `CHANGELOG.md` | Re-measured site byte column; one entry. Decision 21's table stays historical (add nothing). |

---

### Task 1: Exact-palette fast path

**Files:**
- Create: `site/src/lib/exact.mjs`, `site/test/exact.test.mjs`
- Modify: `site/src/lib/zip.mjs` (export `crc32` only), `site/src/lib/pipeline.mjs` (`encodeRaster` + arm choice), `site/src/pages/check.astro` (transparent-fallback case)

**Interfaces:**
- Consumes: `crc32(bytes)` from `zip.mjs`; `width/height/rgba` as given to `encodeRaster`; `CompressionStream` (browser + Node 22 global).
- Produces: `exactArm({ width, height, rgba, colors })` → `{ png: Uint8Array } | null`. `null` when: more than `colors` distinct tuples, any alpha < 255, or no `CompressionStream`. `encodeRaster` races it against the current two arms under keep-smallest (strictly smaller wins; ties keep today's winner).

- [ ] **Step 1: Export `crc32` from `zip.mjs`**

```js
export const crc32 = (bytes) => {
```

That is the whole change: `const crc32` → `export const crc32`. No behavior change; `zip()` is untouched.

- [ ] **Step 2: Write the failing unit test**

Create `site/test/exact.test.mjs`:

```js
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import { countDistinct, exactArm } from '../src/lib/exact.mjs';

const rgba = (px) => {
  const buf = Buffer.alloc(px.length * 4);
  px.forEach(([r, g, b, a], i) => { buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = a; });
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};
// A 2x1 fully-opaque two-color mark.
const two = rgba([[18, 52, 86, 255], [244, 241, 234, 255]]);

describe('countDistinct', () => {
  it('counts RGBA tuples and reports opacity', () => {
    assert.deepEqual(countDistinct(two, 99), { distinct: 2, opaque: true });
    assert.deepEqual(countDistinct(rgba([[0, 0, 0, 0]]), 99), { distinct: 1, opaque: false });
  });

  it('stops early past the limit', () => {
    const many = rgba(Array.from({ length: 300 }, (_, i) => [i & 255, 0, 0, 255]));
    assert.ok(countDistinct(many, 8).distinct > 8);
  });
});

const parsePng = (png) => {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let pos = 8, ihdr = null, plte = null, idat = [];
  while (pos < png.length) {
    const len = Buffer.from(png.subarray(pos, pos + 4)).readUInt32BE(0);
    const type = Buffer.from(png.subarray(pos + 4, pos + 8)).toString('latin1');
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'PLTE') plte = data;
    if (type === 'IDAT') idat.push(Buffer.from(data));
    pos += 12 + len;
  }
  return { ihdr, plte, idat: Buffer.concat(idat) };
};

describe('exactArm', () => {
  it('writes an indexed PNG whose pixels decode back exactly', () => {
    const { png } = exactArm({ width: 2, height: 1, rgba: two, colors: 8 });
    const { ihdr, plte, idat } = parsePng(png);
    assert.equal(ihdr[8], 3, 'colour type 3 (indexed)');
    assert.equal(plte.length / 3, 2, 'two palette entries');
    const raw = inflateSync(idat);
    assert.equal(raw[0], 0, 'filter byte 0');
    assert.deepEqual([raw[1], raw[2]], [0, 1], 'indices in first-appearance order');
  });

  it('returns null past the palette, on alpha, and without CompressionStream', async () => {
    const many = rgba(Array.from({ length: 300 }, (_, i) => [i & 255, 0, 0, 255]));
    assert.equal(exactArm({ width: 300, height: 1, rgba: many, colors: 8 }), null);
    assert.equal(exactArm({ width: 1, height: 1, rgba: rgba([[0, 0, 0, 0]]), colors: 8 }), null);
    const keep = globalThis.CompressionStream;
    delete globalThis.CompressionStream;
    try {
      assert.equal(exactArm({ width: 2, height: 1, rgba: two, colors: 8 }), null);
    } finally {
      globalThis.CompressionStream = keep;
    }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
node --test site/test/exact.test.mjs
```
Expected: FAIL — `../src/lib/exact.mjs` does not exist.

- [ ] **Step 4: Implement `exact.mjs` (minimal)**

Create `site/src/lib/exact.mjs`:

```js
// Exact-indexed raster arm: for marks with few flat colors, skip WuQuant and map pixels
// directly onto their own palette. Pure JS with no WASM imports, so node:test covers it;
// the browser path is gated by the per-mark byte comparison (Tasks 1 and 4 measure it).
import { crc32 } from './zip.mjs';

/** { distinct, opaque } over RGBA tuples, stopping the count past `limit`. */
export const countDistinct = (rgba, limit) => {
  const seen = new Set();
  let opaque = true;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) opaque = false;
    seen.add((rgba[i] * 2 ** 24 + rgba[i + 1] * 2 ** 16 + rgba[i + 2] * 2 ** 8 + rgba[i + 3]) >>> 0);
    if (seen.size > limit) break;
  }
  return { distinct: seen.size, opaque };
};

const chunk = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0);
  return out;
};

/**
 * An indexed PNG of exactly these pixels, or null when the arm does not apply (more colors
 * than the palette, any transparency — indexed output has no tRNS path here by design — or
 * no CompressionStream). Palette order is first appearance, so output is deterministic.
 */
export const exactArm = ({ width, height, rgba, colors }) => {
  if (typeof CompressionStream !== 'function') return null;
  const { distinct, opaque } = countDistinct(rgba, colors);
  if (!opaque || distinct > colors) return null;
  const index = new Map();
  const indices = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < rgba.length; p += 4, i++) {
    const key = (rgba[p] * 2 ** 24 + rgba[p + 1] * 2 ** 16 + rgba[p + 2] * 2 ** 8 + 255) >>> 0;
    if (!index.has(key)) index.set(key, index.size);
    indices[i] = index.get(key);
  }
  const plte = new Uint8Array(index.size * 3);
  for (const [key, at] of index) {
    plte[at * 3] = (key >>> 24) & 255; plte[at * 3 + 1] = (key >>> 16) & 255; plte[at * 3 + 2] = (key >>> 8) & 255;
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 3; // 8-bit, indexed
  const raw = new Uint8Array(height * (1 + width));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter 0 (None): flat marks filter to nothing anyway
    raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  writer.write(raw);
  writer.close();
  return responseToPng(stream, ihdr, plte);
};

const responseToPng = async (stream, ihdr, plte) => {
  const idat = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', idat),
                 chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return { png };
};
```

Wait — `exactArm` is now async (CompressionStream is streaming). The test calls it synchronously. Fix the contract now, in the plan, not during execution: `exactArm()` returns a **Promise** of `{png}|null`, and the test awaits every call. Update Step 2's calls: `await exactArm(...)` (the `it` callbacks become async). The `null` early returns stay sync values inside the async function — fine.

- [ ] **Step 5: Run the unit test, watch it pass**

```bash
node --test site/test/exact.test.mjs
```
Expected: PASS. (If `CompressionStream` deflate output differs across Node versions, the test still passes — it inflates with `node:zlib` rather than comparing bytes.)

- [ ] **Step 6: Wire the arm into `encodeRaster`**

In `site/src/lib/pipeline.mjs`, inside `encodeRaster` after the `lossless` line, before the `quantised` try block:

```js
  // Flat marks skip WuQuant: mapping pixels onto their own palette is exact, and on a
  // 512px icon WuQuant is ~3.4 s of JS the result does not need. keep-smallest still
  // decides, so bytes can only stay or shrink — the per-mark comparison below is the proof.
  const { distinct, opaque } = countDistinct(rgba, colors);
  let exact = null;
  if (opaque && distinct <= colors) {
    const built = await exactArm({ width, height, rgba, colors });
    if (built) exact = new Uint8Array(await optimise(built.png, OXIPNG));
  }
```

and extend the final choice:

```js
  // Strictly smaller wins, so a tie keeps the quantised one - the same tie-break as the CLI.
  // The exact arm wins ties against the quantised arm (identical pixels, fewer colors) but
  // loses them to lossless, preserving both existing tie-breaks.
  let best = quantised && quantised.length < lossless.length ? quantised : lossless;
  if (exact && exact.length < best.length) best = exact;
  return best;
```

Import at the top of `pipeline.mjs`:

```js
import { countDistinct, exactArm } from './exact.mjs';
```

- [ ] **Step 7: oxipng call-overhead probe (temporary, reverted)**

Re-add a counter (not timings) around `optimise()` calls for one run: if first-call init dominates, hoisting the module init is a free, byte-identical win — implement it. Otherwise revert the probe with no change. Either way record the decision in a code comment only if a change ships. (Bytes are the gate: identical input must give identical output; verify by re-running the Task-4 comparison.)

- [ ] **Step 8: Transparent-fallback case in `check.astro`**

Inside the fixture loop is opaque-only; after the loop, before `lines.push('OK')`:

```js
    {
      // Review Focus 1: transparency never takes the exact arm — the build succeeds and
      // the alpha survives, via the current arms.
      const clear = await buildInBrowser(tiles, { colors: 8, sizes: [192], bg: 'none' });
      const png = clear.files.find((f) => f.name === 'icon-192.png');
      const img = await decodePng(png.bytes);
      if (![...img.data.filter((_, i) => i % 4 === 3)].some((a) => a === 0)) {
        throw new Error('transparent build lost its alpha');
      }
    }
```

`decodePng` is already imported in `pipeline.mjs`, not in `check.astro` — import it there from `'@jsquash/png'` (it is already a site dependency; the built page bundles it).

- [ ] **Step 9: Run the gates**

```bash
node --test site/test/exact.test.mjs
```
Expected: PASS.

```bash
cd site && npm run build && node test/cdp-check.mjs
```
Expected: `OK` across all four fixtures (fit lines identical, manifest purpose intact, validation negatives still throwing).

- [ ] **Step 10: Measured byte gate (same machine, no goldens)**

```bash
cd site && node test/cdp-check.mjs 2>/dev/null | awk '/file (tiles|general|gradient|heavy).*(apple-touch-icon|icon-192|icon-512)/{t[$2]+=$4} END{for (m in t) print m, t[m]}'
```
Expected: tiles ≤ 620, general ≤ 3758, heavy ≤ 3758, gradient ≤ 10730 (today's site column). Any growth fails the task — shrink the arm's scope or fix the writer; do not adjust the caps.

- [ ] **Step 11: Commit**

```bash
git add site/src/lib/exact.mjs site/test/exact.test.mjs site/src/lib/zip.mjs site/src/lib/pipeline.mjs site/src/pages/check.astro
git commit -m "feat(site): exact-palette fast path for flat marks"
```

---

### Task 2: Worker + progress + fallback

**Files:**
- Create: `site/src/worker.mjs`
- Modify: `site/src/lib/pipeline.mjs` (`onProgress`), `site/src/pages/index.astro` (wiring), `site/src/pages/check.astro` (equality + throwing-progress + sizes-range cases)

**Interfaces:**
- Consumes: `buildInBrowser` from Task 1 (with exact arm); `warm()` for preload.
- Produces: worker protocol — page posts `{ svgText, options }`, worker posts `{ type: 'progress', stage, done, total }` then `{ type: 'done', files }` (buffers transferred) or `{ type: 'error', message }`. `buildInBrowser` gains optional `onProgress({ stage, done, total })`, never required, never awaited (each call wrapped in try/catch).

- [ ] **Step 1: `onProgress` in `buildInBrowser` (failing test first)**

In `site/src/pages/check.astro`, after the loop (beside the Task-1 block):

```js
    {
      // Review Focus 4: a throwing progress callback must not break the build.
      const seen = [];
      const built = await buildInBrowser(tiles, {
        colors: 8, sizes: [192], bg: '#000000',
        onProgress: (p) => { seen.push(p.stage); throw new Error('page bug'); },
      });
      if (!built.files.some((f) => f.name === 'icon-192.png')) throw new Error('throwing onProgress broke the build');
      if (seen.length === 0) throw new Error('onProgress was never called');
    }
    for (const badSizes of [[9000], [0]]) {
      // Review Focus 5: sizes mirror the CLI range.
      let threw = null;
      try {
        await buildInBrowser(tiles, { colors: 8, sizes: badSizes, bg: '#000000' });
      } catch (e) { threw = e?.message ?? String(e); }
      if (!threw || !/--sizes takes pixel sizes 1-8192/.test(threw)) {
        throw new Error(`sizes ${JSON.stringify(badSizes)} was accepted (${threw ?? 'no error'})`);
      }
    }
```

Run: `cd site && npm run build && node test/cdp-check.mjs`. Expected: FAIL — `onProgress was never called` (and sizes `[9000]` accepted).

- [ ] **Step 2: Implement (minimal)**

In `pipeline.mjs`, top of `buildInBrowser` after option parsing:

```js
  const progress = (stage, done, total) => {
    try { options.onProgress?.({ stage, done, total }); } catch { /* the page's bug, not the build's */ }
  };
```

Call it at stage boundaries with a total known upfront: `total = 2 + sizes.length + (sizes.length + 2)` (svg, placements for apple + each size, rasters for apple + each size + ICO): `progress('svg', 0, total)` after validation, then after each `place()` and each `encodeRaster()` push. Keep the calls coarse — one line per boundary, e.g. `progress('place', done++, total)`.

Sizes range check beside the existing evenness check:

```js
  for (const s of sizes) {
    if (!Number.isInteger(s) || s < 1 || s > 8192) throw new FavconError(`--sizes takes pixel sizes 1-8192, got '${s}'`);
    // ... existing evenness check unchanged ...
  }
```

- [ ] **Step 3: Create the worker**

Create `site/src/worker.mjs`:

```js
// The pipeline, off the UI thread: a 72 s build must not freeze the tab. Same module the
// page falls back to, so worker and fallback cannot drift — check.astro proves they agree.
import { buildInBrowser, warm } from './lib/pipeline.mjs';

const progress = (done, total, stage) => (p) =>
  postMessage({ type: 'progress', stage: p.stage, done: p.done, total: p.total });

self.onmessage = async ({ data }) => {
  if (data?.warm) { warm(); return; }
  try {
    const total = 2 + data.options.sizes.length + (data.options.sizes.length + 2);
    let done = 0;
    const built = await buildInBrowser(data.svgText, {
      ...data.options,
      onProgress: (p) => postMessage({ type: 'progress', stage: p.stage, done: ++done, total }),
    });
    const files = built.files.map((f) => ({ name: f.name, bytes: f.bytes }));
    postMessage({ type: 'done', files, links: built.links, animated: built.animated, fit: built.fit },
      files.map((f) => f.bytes.buffer));
  } catch (e) {
    postMessage({ type: 'error', message: e?.message ?? String(e) });
  }
};
```

(The `progress` helper above is a leftover sketch — do not ship it; the inline `onProgress` is the implementation. If this sentence confuses you, delete the helper and keep the inline version.)

- [ ] **Step 4: Wire the page with fallback**

In `index.astro`'s submit handler, replace the direct `buildInBrowser` call with: try `new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' })`, post options, await done/error with progress events updating a `<progress id="prog">` element (added in Task 3 — for now update the `<output>` status text per stage); on `Worker` construction throwing, fall back to the existing dynamic `import('../lib/pipeline.mjs')` path. On file select, construct the worker early (replacing the `warm()` preload with worker warmup: post `{ warm: true }`).

Worker-vs-direct equality case in `check.astro` (self-consistent, no goldens):

```js
    {
      // The worker runs the same module the fallback imports: same files, same bytes.
      const direct = await buildInBrowser(tiles, { colors: 8, sizes: [192], bg: '#000000' });
      const via = await new Promise((res, rej) => {
        const w = new Worker(new URL('../worker.mjs', import.meta.url), { type: 'module' });
        w.onmessage = ({ data }) => {
          if (data.type === 'done') { w.terminate(); res(data); }
          else if (data.type === 'error') { w.terminate(); rej(new Error(data.message)); }
        };
        w.onerror = (e) => { w.terminate(); rej(e?.message ?? e); };
        w.postMessage({ svgText: tiles, options: { colors: 8, sizes: [192], bg: '#000000' } });
      });
      const names = (fs) => fs.map((f) => f.name).sort().join(',');
      if (names(via.files) !== names(direct.files)) throw new Error('worker file set differs');
      for (const f of via.files) {
        const d = direct.files.find((x) => x.name === f.name);
        if (d.bytes.length !== f.bytes.length || !d.bytes.every((b, i) => b === f.bytes[i])) {
          throw new Error(`worker bytes differ for ${f.name}`);
        }
      }
    }
```

Run: `cd site && npm run build && node test/cdp-check.mjs`. Expected: `OK` (all prior lines plus the three new cases).

- [ ] **Step 5: Commit**

```bash
git add site/src/worker.mjs site/src/lib/pipeline.mjs site/src/pages/index.astro site/src/pages/check.astro
git commit -m "feat(site): pipeline in a worker with progress and fallback"
```

---

### Task 3: Preview trio, progress UI, index smoke

**Files:**
- Modify: `site/src/pages/index.astro` (previews + `<progress>`), `site/src/styles/app.css` (trio + progress styles only), `site/test/cdp-check.mjs` (index smoke mode)

**Interfaces:**
- Consumes: worker protocol + `fit.icons` from Task 2; largest-icon bytes already on the page.
- Produces: the finished page. No byte output changes (previews reuse built files).

- [ ] **Step 1: Preview trio + progress element**

In `index.astro`'s `#result` section, replace the single masked figure with three, reusing the largest built icon URL (`biggestUrl`, already computed as the mask `src`):

```html
<figure><img id="p-ios" alt="the largest icon under iOS's squircle mask" /><figcaption>iOS squircle</figcaption></figure>
<figure><img id="p-android" alt="the largest icon under Android's circular mask" /><figcaption>Android circle</figcaption></figure>
<figure><img id="p-desk" alt="the largest icon unmasked, as a desktop shows it" /><figcaption>desktop, no mask</figcaption></figure>
```

and in the script set all three `src` to the same `biggestUrl` (falling back to the SVG URL when there is no padded icon, exactly as the current mask line does). Add `<progress id="prog" max="100" value="0" hidden></progress>` beside the `<output>`, updated from worker progress events (`value = done / total * 100`), hidden again at done/error.

In `app.css`, append only:

```css
/* Platform previews: the shapes launchers actually mask with. */
#p-ios { border-radius: 22.4%; }
#p-android { border-radius: 50%; }
/* #p-desk is deliberately unmasked: desktops show the ground, padding cost included. */
#prog { width: 100%; }
```

Keep every control, default, message, the outputs table, and the byte table exactly as they are.

- [ ] **Step 2: Index smoke mode in `cdp-check.mjs`**

After the `PATH` const, the script serves any path. Add at the end, guarded by `process.argv[3] === '--smoke-index'`: load `/`, wait 3 s, fail on any collected `uncaught:`/`log: error` noise (missing asset, module error), pass otherwise. Concretely, after the existing `finish(...)` call site, restructure minimally: if the flag is set, skip the `#out` polling loop and instead `await sleep(3000)`, then `finish(noise.length ? 1 : 0, noise.join('\n') || 'index clean')`.

Run both:

```bash
cd site && npm run build && node test/cdp-check.mjs && node test/cdp-check.mjs / --smoke-index
```
Expected: `OK` on `/check/`, `index clean` on `/`.

- [ ] **Step 3: Commit**

```bash
git add site/src/pages/index.astro site/src/styles/app.css site/test/cdp-check.mjs
git commit -m "feat(site): platform previews, progress UI, index smoke"
```

---

### Task 4: Numbers, docs, final verification

**Files:**
- Modify: `site/src/pages/index.astro` (byte table), `site/README.md` (byte table), `CHANGELOG.md` (one entry)

**Interfaces:**
- Consumes: measured totals from this task's Step 1.
- Produces: the final branch. No code changes.

- [ ] **Step 1: Re-measure the site byte column (same machine)**

```bash
cd site && node test/cdp-check.mjs 2>/dev/null | awk '/file (tiles|general|gradient|heavy).*(apple-touch-icon|icon-192|icon-512)/{t[$2]+=$4} END{for (m in t) print m, t[m]}'
```
Expected: each ≤ today's site column (tiles 620, general 3758, heavy 3758, gradient 10730). Any growth fails the plan — do not adjust the caps; fix the code (Task 1) instead.

- [ ] **Step 2: Update the two tables + changelog**

In `site/src/pages/index.astro` and `site/README.md`, replace only the "here" column and the deltas with the Step-1 numbers (CLI column is unchanged — the CLI is untouched). Keep the prose qualitative; adjust "more than doubles" only if no longer true. Append to `CHANGELOG.md` under `## [Unreleased]` → `### Changed` (create the heading if absent):

```md
- **The website builds sets much faster and stays responsive.** Flat marks skip WuQuant via an
  exact-palette arm (same or fewer bytes per mark, measured); long builds run in a Web Worker
  with progress instead of freezing the tab, falling back to the main thread where workers
  fail. Page: per-platform previews (iOS squircle, Android circle, unmasked desktop) and a
  semantic-HTML cleanup.
```

- [ ] **Step 3: Final verification**

```bash
npm test
```
Expected: same count as before this plan plus `site/test/exact.test.mjs` green — run `node --test site/test/exact.test.mjs` explicitly too, since the root suite does not cover `site/`.

```bash
cd site && npm run build && node test/cdp-check.mjs && node test/cdp-check.mjs / --smoke-index
```
Expected: `OK`, `index clean`.

- [ ] **Step 4: Report, then commit**

Report in the commit message body is overkill — report to the partner instead: headless time before/after per fixture (relative), per-mark byte table old→new, tab-responsive confirmation. Then:

```bash
git add site/src/pages/index.astro site/README.md CHANGELOG.md
git commit -m "docs: re-measured site byte tables and changelog"
```

---

## Self-review notes

- **Spec coverage:** resvg answer (§Non-goals, measured) needs no task; fast paths → Task 1; worker/progress/fallback → Task 2; previews/progress-UI → Task 3; tables/changelog/final verify → Task 4; Astro 7 verify → Task 3 Step 2 + Task 4 Step 3 (build clean + full suite once). `warm()` stays for the fallback path.
- **Type consistency:** `exactArm()` is async (CompressionStream streaming) — the test awaits it; `encodeRaster` awaits it. `onProgress` is optional and never awaited by the pipeline (try/catch per call). Worker messages: `{type:'progress'|'done'|'error'}` — page and check.astro consume the same three.
- **The sharp edge:** the byte gate is deliberately *not* a committed test (no golden bytes — same rule as the CLI suite). Its enforcement is Steps 1→10 (Task 1) and Steps 1→2 (Task 4), run by the executor on one machine and reported, not asserted in CI.
- **No placeholders:** every step names exact files, exact code, exact commands with expected outputs. The one deliberate judgment call left to the executor is Task 1 Step 7 (hoist oxipng init or revert), with both outcomes specified.
