# Padding option and one icon set — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate maskable icon with one padded set, and expose the padding as a flag instead of only measuring it.

**Architecture:** `placeInSafeZone` in `lib/core.mjs` gains an explicit padding argument; `auto` keeps today's measured fit-and-snap. `build()` then places every PNG except the ICO payload, drops `icon-maskable-512.png`, and declares the `icon-<size>.png` files `"any maskable"`. The website shares all of it through `lib/core.mjs` and needs no logic of its own.

**Tech Stack:** Node ≥22.12, ESM, `svgo` 4.x, external `resvg`/`pngquant`/`oxipng`, `node:test`.

**Spec:** `/home/c/dev/favcon/CLAUDE.md` (§1 what ships, §9 definition of done), `/home/c/dev/favcon/docs/DECISIONS.md` (decisions 10, 11, 20, 21)

## Global Constraints

- `favcon: <message>` on stderr, non-zero exit, **never a raw stack trace**.
- `bin/favcon.mjs` stays one file for CLI-only concerns; shared logic goes in `lib/core.mjs`, which **imports nothing**.
- Every pipeline change arrives with a number: a `bench/bench.mjs` run showing the byte delta, and proof every fixture is still inside `pct <= 1.0 %`.
- `lib/` must stay in `package.json` `files` — `bin/favcon.mjs` imports it.
- Accuracy bar: `pct <= 1.0 %`, worse of a white and a black composite, tolerance 8/255.
- Tests assert **self-consistency, never golden bytes** (apt's pngquant is 3.0.1, local may be 3.0.3).
- No new CLI flags without a stated user need. `--padding` has one; nothing else in this plan adds a flag.

---

## Why this change, and what it costs

Today the masked icons are placed by measuring the mark's farthest opaque pixel and snapping to whole pixels. That measurement adapts per mark, and the spread is wide:

| fixture | box / canvas | padding it chose |
|---|---|---|
| `gradient` | 434/512 | 7.6 % per side |
| `general` | 408/512 | 10.2 % |
| `heavy` | 366/512 | 14.3 % |
| `tiles` | 320/512 | **18.8 %** |

**No single fixed percentage is correct for every mark.** The W3C safe zone is a *circle* of radius 40 %; how much of it a mark can use depends on its shape. A round mark fills 80 % of the width; a square mark's corners hit the circle at 56.6 %, needing 21.7 % padding. A fixed 11 % (the "20 px of 180" figure) is right for a round mark and pushes a square one's corners outside the safe circle.

So `auto` stays the default and an explicit percentage is the override — which is what Task 1 builds.

**The cost of collapsing the set:** `icon-192.png` and `icon-512.png` become padded and opaque. On a platform that does *not* mask (most desktops), they render as a smaller mark inside the `--bg` ground rather than edge to edge. That is the trade web.dev warns about, and it is now the default. `--bg none` opts out: transparent, unpadded, `"any"` only.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `lib/core.mjs` | `placeInSafeZone(iconData, render, canvas, padding)` — `padding` is `'auto'` or a number. `manifestJson` learns `purpose`. Still imports nothing. |
| `bin/favcon.mjs` | `--padding` parsing and validation; places every PNG; no maskable-specific file. |
| `test/run.mjs` | DoD assertions updated for the new file set and the flag. |
| `test/lib/accuracy.mjs` | `reference()` takes the same padding so references stay placed identically. |
| `site/src/lib/pipeline.mjs` | Passes padding through; loses its maskable special case. |
| `site/src/pages/index.astro` | A padding control. |
| `CLAUDE.md`, `docs/DECISIONS.md`, `CHANGELOG.md`, `README.md` | §1, §9, decision 20 amended; decision 22 added. |

---

### Task 1: `--padding` reaches `placeInSafeZone`

**Files:**
- Modify: `lib/core.mjs` (`placeInSafeZone`)
- Modify: `bin/favcon.mjs` (`normalise`, `cli`, `USAGE`, the `place` helper)
- Test: `test/run.mjs`

**Interfaces:**
- Consumes: `nestForMask(iconData, box, canvas)`, `maskableFit({width,height,rgba})` — unchanged.
- Produces: `placeInSafeZone(iconData, render, canvas, padding = 'auto')` returning `{ svg, box, scale, snapped, radius, fullBleed, padding }`, where `padding` is the per-side percentage actually used (a number, even when `auto` chose it). `normalise()` yields `o.padding` as `'auto'` or a `Number` in `[0, 45]`.

- [ ] **Step 1: Write the failing test**

In `test/run.mjs`, inside the `describe('the masked icons', ...)` group:

```js
it('--padding places the mark at exactly that fraction', async () => {
  // An explicit percentage must be obeyed literally: box = canvas * (1 - 2p), rounded down
  // to an even pixel so the offset stays whole. 20% of 512 leaves 60% = 307 -> 306.
  const out = freshDir();
  const r = await build({ input: fixture('tiles.svg'), out, sizes: [512], padding: 20, zopfli: false });
  assert.equal(r.fit.apple.padding, 20);
  assert.equal(r.fit.apple.box, 106);          // 180 * 0.6 = 108 -> even, minus rounding
  assert.equal(r.fit.apple.snapped, false, 'an explicit padding must not be snapped away');
});

it('--padding auto still measures and snaps', async () => {
  const out = freshDir();
  const r = await build({ input: fixture('tiles.svg'), out, sizes: [512], padding: 'auto', zopfli: false });
  assert.equal(r.fit.apple.box, 112, 'tiles is a pixel-grid mark and snaps to 112 of 180');
  assert.equal(r.fit.apple.snapped, true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test --test-name-pattern="padding" test/run.mjs
```
Expected: FAIL — `r.fit.apple.padding` is `undefined`.

- [ ] **Step 3: Teach `placeInSafeZone` an explicit padding**

In `lib/core.mjs`, change the signature and add the explicit branch before the measured one:

```js
export const placeInSafeZone = async (iconData, render, canvas, padding = 'auto') => {
  if (!Number.isInteger(canvas) || canvas < 2 || canvas % 2) {
    throw new FavconError(`internal error: a masked icon's size must be an even pixel count, got ${canvas}`);
  }
  const even = (n) => n - (n % 2);

  // An explicit padding is a promise, not a hint: it is applied literally and never snapped.
  // Snapping exists to find a crisper size NEAR the measured fit; moving a number the caller
  // chose would make --padding mean something different from what it says.
  if (padding !== 'auto') {
    const box = Math.max(2, even(Math.floor(canvas * (1 - 2 * padding / 100))));
    return {
      svg: nestForMask(iconData, box, canvas), box, scale: box / canvas,
      snapped: false, radius: null, fullBleed: false, padding,
    };
  }

  const fit = maskableFit(await render(iconData, canvas));
  if (fit.fullBleed) {
    return { svg: iconData, box: canvas, scale: 1, snapped: false, radius: fit.radius, fullBleed: true, padding: 0 };
  }
  // ...existing measured path unchanged, but every return gains:
  //   padding: (1 - box / canvas) / 2 * 100
};
```

Update the two remaining `return` statements in the measured path to include
`padding: (1 - box / canvas) / 2 * 100`.

- [ ] **Step 4: Validate the flag in `normalise`**

In `bin/favcon.mjs`, inside `normalise()`, after the `--colors` block:

```js
  // 'auto' or a percentage per side. Capped at 45 because 50 leaves no mark at all, and a
  // value that produces an empty icon should be a message rather than a blank PNG.
  const rawPadding = options.padding ?? 'auto';
  if (rawPadding === 'auto') {
    o.padding = 'auto';
  } else {
    if (!/^\d+(\.\d+)?$/.test(String(rawPadding))) {
      throw new FavconError(`--padding must be 'auto' or a percentage 0-45, got '${rawPadding}'`);
    }
    o.padding = Number(rawPadding);
    if (o.padding < 0 || o.padding > 45) throw new FavconError("--padding must be 'auto' or a percentage 0-45");
  }
```

Add `padding: 'auto',` to the `o` object literal at the top of `normalise`.

- [ ] **Step 5: Thread it through `build()` and the CLI**

In `bin/favcon.mjs`, `place()`:

```js
    const place = async (canvas) => {
      const { svg, ...where } = await placeInSafeZone(iconData, renderAt, canvas, o.padding);
```

In `cli()`, add to the options object `padding: 'auto',` and a case:

```js
      case '--padding':          opts.padding = need(); break;
```

and pass `padding: opts.padding` in the `build({...})` call. In `USAGE`:

```
      --padding P   How much of each masked icon is margin, as a percentage per side
                    (default: auto). `auto` measures the mark's own extent and snaps it to
                    whole pixels, which is smaller and sharper than any fixed number - see
                    docs/DECISIONS.md decision 20. Give a number to override it.
```

- [ ] **Step 6: Run the tests**

```bash
node --test --test-name-pattern="padding" test/run.mjs
```
Expected: PASS. Then the whole suite: `npm test` → 98 pass.

- [ ] **Step 7: Commit**

```bash
git add lib/core.mjs bin/favcon.mjs test/run.mjs
git commit -m "feat: --padding, auto by default"
```

---

### Task 2: One padded icon set

**Files:**
- Modify: `bin/favcon.mjs` (the `place`/`want` block, `files`)
- Modify: `lib/core.mjs` (`manifestJson`)
- Test: `test/run.mjs`

**Interfaces:**
- Consumes: `placeInSafeZone(..., padding)` from Task 1.
- Produces: `manifestJson({ sizes, base, purpose, extra })` where `purpose` is `'any maskable'` or `'any'`. `build()` returns `fit` as `{ apple, icons: { [size]: fit } }` — `fit.maskable` is gone.

- [ ] **Step 1: Write the failing test**

```js
it('writes one padded set and no separate maskable icon', async () => {
  const out = freshDir();
  await build({ input: fixture('general.svg'), out, sizes: [192, 512], zopfli: false });
  assert.deepEqual(readdirSync(out).sort(),
    ['apple-touch-icon.png', 'favicon.ico', 'icon-192.png', 'icon-512.png', 'icon.svg', 'logo.svg']);
});

it('declares the padded icons "any maskable", and "any" alone when transparent', async () => {
  const opaque = freshDir();
  await build({ input: fixture('general.svg'), out: opaque, sizes: [192], manifest: true, zopfli: false });
  const a = JSON.parse(readFileSync(join(opaque, 'site.webmanifest'), 'utf8'));
  assert.equal(a.icons[0].purpose, 'any maskable');

  // --bg none cannot produce a maskable icon: the spec lets a platform composite a
  // transparent one onto any colour, so the safe zone would mean nothing.
  const clear = freshDir();
  await build({ input: fixture('general.svg'), out: clear, sizes: [192], bg: null, manifest: true, zopfli: false });
  const b = JSON.parse(readFileSync(join(clear, 'site.webmanifest'), 'utf8'));
  assert.equal(b.icons[0].purpose, undefined, 'a transparent icon is "any" only');
});

it('leaves icon.svg and the ICO payload unpadded', async () => {
  // These two are never masked: the SVG favicon is drawn in a browser tab and the ICO is
  // 32px of tab furniture. Padding them would shrink the mark for nothing.
  const out = freshDir();
  await build({ input: fixture('tiles.svg'), out, sizes: [32], zopfli: false });
  const icon32 = readFileSync(join(out, 'icon-32.png'));
  const payload = readFileSync(join(out, 'favicon.ico')).subarray(22);
  assert.notDeepEqual([...icon32], [...payload],
    'icon-32.png is padded now, so it can no longer be the ICO payload');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test --test-name-pattern="padded set|any maskable|unpadded" test/run.mjs
```
Expected: FAIL — `icon-maskable-512.png` is still produced.

- [ ] **Step 3: Place every PNG except the ICO payload**

In `bin/favcon.mjs`, replace the `place`/`want` block:

```js
    const apple = await place(APPLE_SIZE);
    // Every PNG a platform might mask is padded the same way. icon.svg and the ICO payload
    // are not: a tab favicon is never masked, and padding 32px of tab furniture only makes
    // the mark smaller. --bg none keeps them transparent and unpadded, because a maskable
    // icon must be opaque - the spec lets a platform composite a transparent one onto any
    // colour it likes, which would put the mark somewhere the safe zone never promised.
    const padded = o.bg !== null;
    const icons = {};
    for (const s of o.sizes) icons[s] = padded ? await place(s) : null;
    const fit = { apple: apple.fit, icons: Object.fromEntries(o.sizes.map((s) => [s, icons[s]?.fit ?? null])) };

    want(APPLE_SIZE, o.bg, join(stage, 'apple-touch-icon.png'), apple.file);
    for (const s of o.sizes) want(s, o.bg, join(stage, `icon-${s}.png`), icons[s]?.file);
    want(ICO_SIZE, null, icoPng);
```

and the file list:

```js
    const files = ['logo.svg', 'icon.svg', 'favicon.ico', 'apple-touch-icon.png',
                   ...o.sizes.map((s) => `icon-${s}.png`)];
```

> `want(px, bg, dest, svg)` already de-duplicates on `(px, bg)`. The ICO payload asks for
> `(32, null)` and a padded `icon-32.png` asks for `(32, bg)`, so they are now two different
> renders — which is why the third test above asserts they differ.

- [ ] **Step 4: Teach `manifestJson` a purpose**

In `lib/core.mjs`:

```js
export const manifestJson = ({ sizes, base = '/', purpose = null, extra = null }) => {
  const head = extra && typeof extra === 'object'
    ? Object.entries(extra).filter(([k]) => k !== 'icons')
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join('')
    : '';
  // "any maskable" on one file, rather than two files with one purpose each. The set is
  // padded into the safe zone, so it is honestly both - and Chrome will not install a PWA
  // whose icons are all "maskable", it needs at least one "any". icon.svg is never listed:
  // an SVG entry breaks Android's WebAPK install (crbug.com/40925759).
  const entry = (s) =>
    `    { "src": "${base}icon-${s}.png", "sizes": "${s}x${s}", "type": "image/png"` +
    `${purpose ? `, "purpose": "${purpose}"` : ''} }`;
  return `{\n${head}  "icons": [\n${sizes.map(entry).join(',\n')}\n  ]\n}\n`;
};
```

In `bin/favcon.mjs`, the manifest call becomes:

```js
      writeFileSync(join(stage, 'site.webmanifest'), manifestJson({
        sizes: o.sizes, base, purpose: padded ? 'any maskable' : null,
        extra: typeof o.manifest === 'object' ? o.manifest : null,
      }));
```

- [ ] **Step 5: Update the summary line and the remaining `MASKABLE_SIZE` uses**

`MASKABLE_SIZE` is now unused in `build()`. Leave the export in `lib/core.mjs` (the site's
default size list still reads it) but remove it from the `bin/favcon.mjs` import list, or
`node --check` will pass while the linter complains.

- [ ] **Step 6: Run the tests**

```bash
npm test
```
Expected: the three new tests pass; the old `icon-maskable-512.png` assertions fail. Update
them — DoD 1, 2, 8 and 10 in `test/run.mjs` all name the maskable file.

- [ ] **Step 7: Commit**

```bash
git add lib/core.mjs bin/favcon.mjs test/run.mjs
git commit -m "feat: one padded icon set, declared any maskable"
```

---

### Task 3: References stay placed identically

**Files:**
- Modify: `test/lib/accuracy.mjs` (`reference()`)
- Test: `test/run.mjs` (the accuracy group)

**Interfaces:**
- Consumes: `placeInSafeZone(..., padding)`.
- Produces: `reference(resvgPath, { source, px, bg, vars, fitted, padding })`.

> This is the task that catches the class of bug that has already bitten once: the accuracy
> gate builds its own reference through `placeInSafeZone`, so if the build pads an icon and
> the reference does not, every masked icon fails the bar for a reason that has nothing to do
> with the pipeline.

- [ ] **Step 1: Write the failing test**

```js
it('scores a padded icon against an identically padded reference', async () => {
  const { out } = await buildOnce('pad-20', { input: fixture('general.svg'), sizes: [192], padding: 20, zopfli: false });
  const ref = await reference(resvg, { source: fixture('general.svg'), px: 192, bg: '#000000', fitted: true, padding: 20 });
  const s = score(decode(readFileSync(join(out, 'icon-192.png'))), ref);
  assert.ok(s.pct <= THRESHOLD_PCT, `pct ${s.pct.toFixed(4)}% - the reference is placed differently`);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test --test-name-pattern="identically padded" test/run.mjs
```
Expected: FAIL with a large `pct` — the reference is placed by `auto`, the build by 20 %.

- [ ] **Step 3: Pass padding into the reference**

In `test/lib/accuracy.mjs`:

```js
export async function reference(resvgPath, { source, px, bg, vars, fitted = false, padding = 'auto' }) {
```

and at the placement call:

```js
      svg = (await placeInSafeZone(svg, render, px, padding)).svg;
```

- [ ] **Step 4: Run the tests**

```bash
npm test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/lib/accuracy.mjs test/run.mjs
git commit -m "test: reference renders honour the same padding as the build"
```

---

### Task 4: The website follows, for free

**Files:**
- Modify: `site/src/lib/pipeline.mjs`
- Modify: `site/src/pages/index.astro`
- Test: `site/src/pages/check.astro`, run via `site/test/cdp-check.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–2 via `lib/core.mjs`.
- Produces: `buildInBrowser(svgText, { colors, sizes, bg, vars, padding, manifest })`.

- [ ] **Step 1: Extend the browser self-check**

In `site/src/pages/check.astro`, inside the fixture loop, after the existing assertions:

```js
      if (built.files.some((f) => f.name.startsWith('icon-maskable'))) {
        throw new Error(`${name}: the browser still writes a separate maskable icon`);
      }
      const manifest = JSON.parse(new TextDecoder().decode(
        built.files.find((f) => f.name === 'site.webmanifest').bytes));
      if (manifest.icons[0].purpose !== 'any maskable') {
        throw new Error(`${name}: manifest purpose is ${manifest.icons[0].purpose}`);
      }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd site && npm run build && node test/cdp-check.mjs
```
Expected: FAIL — `the browser still writes a separate maskable icon`.

- [ ] **Step 3: Mirror the CLI in the pipeline**

In `site/src/lib/pipeline.mjs`, replace the masked-icon block:

```js
  const padding = options.padding ?? 'auto';
  const place = async (canvas) => {
    const { svg, ...where } = await placeInSafeZone(iconData, renderRgba, canvas, padding);
    return { svg, fit: { ...where, canvas } };
  };
  const padded = bg !== null;

  const apple = await place(APPLE_SIZE);
  files.push({ name: 'apple-touch-icon.png', bytes: await encodeRaster(await render(apple.svg, APPLE_SIZE, bg), colors) });

  const icons = {};
  for (const s of sizes) {
    const placed = padded ? await place(s) : null;
    icons[s] = placed?.fit ?? null;
    files.push({ name: `icon-${s}.png`, bytes: await encodeRaster(await render(placed?.svg ?? iconData, s, bg ?? undefined), colors) });
  }
  // The ICO payload is never padded, so it is its own render even when a size matches.
  files.push({ name: 'favicon.ico', bytes: icoWrap(await encodeRaster(await render(iconData, ICO_SIZE, null), colors), ICO_SIZE) });
```

and the manifest:

```js
      bytes: new TextEncoder().encode(manifestJson({ sizes, purpose: padded ? 'any maskable' : null })),
```

Return `fit: { apple: apple.fit, icons }`.

- [ ] **Step 4: Add the control to the page**

In `site/src/pages/index.astro`, in the `.options` block:

```html
      <label>Padding
        <input type="text" id="padding" value="auto" />
        <span class="quiet">Percent per side, or <code>auto</code> to measure the mark.</span>
      </label>
```

and in the click handler, `padding: el('padding').value.trim() === 'auto' ? 'auto' : Number(el('padding').value)`.

- [ ] **Step 5: Run the browser check**

```bash
cd site && npm run build && node test/cdp-check.mjs
```
Expected: `OK` across all four fixtures.

- [ ] **Step 6: Commit**

```bash
git add site/
git commit -m "feat(site): one padded set and a padding control"
```

---

### Task 5: Numbers, then documentation

**Files:**
- Modify: `docs/BENCHMARKS.md` (regenerated), `docs/DECISIONS.md`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Measure, on an idle machine**

```bash
node bench/bench.mjs --write
```

This is the project's standing rule: a pipeline change arrives with a number. The set changed
shape, so record the new totals and confirm every fixture is still inside `pct <= 1.0 %`.

- [ ] **Step 2: Amend decision 20 and add decision 22**

Decision 20 described the measured placement as the only mode. Amend it to say the measurement
is now the **default** of `--padding`, and add decision 22 recording:
- the measured spread (7.6 %–18.8 % across the fixtures) and why no fixed number is right for
  every mark;
- that Chrome will not install a PWA whose icons are all `maskable`, which is why the padded
  set carries `"any maskable"` rather than `"maskable"`;
- what `--bg none` now means (transparent, unpadded, `"any"`);
- the cost: on a desktop that does not mask, the padded icon is a smaller mark on the ground.

- [ ] **Step 3: Update `CLAUDE.md` §1 and §9**

§1's table loses `icon-maskable-512.png` and gains the padding note on `icon-<size>.png`.
§9's items 1, 2, 8, 10 and 16 all name the old file set — rewrite them against the new one.
Item 16 (`--sizes 32` renders once) is now **false** and must become its inverse: `--sizes 32`
renders twice on purpose, once padded for `icon-32.png` and once not for the ICO payload.

- [ ] **Step 4: Run everything**

```bash
npm test && (cd site && npm run build && node test/cdp-check.mjs)
```

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md README.md CHANGELOG.md
git commit -m "docs: decision 22, one padded set and the padding flag"
```

---

## Self-review notes

- **Spec coverage:** `--padding` (Task 1), collapsing the set (Task 2), manifest purpose
  (Task 2), reference parity (Task 3), website parity (Task 4), measurement and docs (Task 5).
- **Type consistency:** `placeInSafeZone` returns `padding` as a number in every branch,
  including `auto` and `fullBleed`. `build()` returns `fit.icons` keyed by size; `fit.maskable`
  is removed everywhere, including `astro/index.d.ts` if it names it.
- **The sharp edge:** DoD 16 inverts. `icon-32.png` and the ICO payload are no longer the same
  bytes, because one is padded and the other is not. Task 2 Step 1 asserts that directly so the
  change is deliberate rather than discovered.

---

## Roadmap — the next plans

Each needs its own plan document; none should be folded into this one.

**Plan 2 — Cheaper winner selection.** `renderPng` runs `oxipng -o max -s -a` on all three
candidates purely to rank them, then zopfli's the winner. `-o 2` for the ranking would be far
cheaper and probably picks the same winner. Never measured. The sweep must record **winner
agreement rate** as well as time: a faster ranking that picks a worse winner is a byte
regression wearing a speed costume. Gate: agreement ≥ 95 % and total bytes unchanged.

**Plan 3 — Revisit `--zi`.** From `docs/BENCHMARKS.md`: 120 → 60 is 47 % faster for +0.17 %
bytes; 120 → 15 is 83 % faster for +0.64 %. This is the single biggest time lever in the tool
and it is one constant. Decision 8 took the byte side deliberately; the plan is to re-judge it
with the cost now quantified, not to assume.

**Plan 4 — CI runs the browser check.** `site/test/cdp-check.mjs` proves the website's pipeline
works and that the shared core behaves identically under `svgo/browser`. It runs by hand only.
Add a CI job on `ubuntu-24.04` with Chromium, running the four-fixture check on every push.

**Plan 5 — Enforce the isomorphic claim.** The SVG stage is currently spot-checked against
`svgo/browser` by a one-off script. Make it a test: run the shared core's assertions under both
`svgo` and `svgo/browser` in the same suite, so "the website produces the CLI's SVG bytes" is
enforced rather than believed.

**Plan 6 — Redesign the site: semantic HTML, less CSS.** The current page is a `div` scaffold
with a hand-rolled drop zone and ~180 lines of CSS. Rebuild it on semantic elements — `<form>`,
`<fieldset>`/`<legend>` for the options, `<output>` for the result, a real `<label>`-wrapped
file input instead of a `tabindex` div — which removes most of the ARIA and keyboard handling
because the elements already do it. Add the per-platform previews asked for: the mark under
iOS's squircle, Android's circle, and a desktop tile that does not mask, so the cost of padding
is visible rather than described.
