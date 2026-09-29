# Site performance + redesign — design spec

Date: 2026-09-29. Status: approved design, awaiting spec review.

## Intent (agreed)

The browser site generates a set in ~10 s headless here and ~72 s on the
partner's machine, freezing the tab the whole time. Make generation fast
without growing a single output byte, and rebuild the page on semantic
HTML with per-platform previews. Performance is judged against output:
no change may regress bytes, accuracy, or exactness against the CLI.

Prior decisions carried in: `--padding` + one padded set (decision 22);
site validation parity (fix pass); hold-bytes over speed for the site
(2026-09-29); full Plan 6 scope for the rebuild.

## Non-goals (decided with measurements)

- **`@resvg/resvg-js`.** A Node NAPI binding; it cannot run in a browser
  tab, and the site is static client-side by design. Measured share of
  runtime: ~1 % (81–93 ms of 7–10 s across 19–44 renders). Rejected twice
  over: unusable here, and useless here.
- **Quantiser swaps, oxipng level cuts, heuristic arm-skipping.** All trade
  bytes for speed or risk worse winners. Ruled out by hold-bytes.
- **Parallel workers for speed.** Same CPU, more complexity. One worker
  only, for responsiveness (below), not throughput.

## Measured baseline (throwaway probe, headless Chromium, defaults)

Per mark: `image-q` palette ~3.4 s + apply ~2.5 s (≈60 %), oxipng WASM
both arms ≈1–4 s (≈35 %), placement renders ≈0.1 s (≈1 %, 19–44 calls),
svgo + wasm-init negligible. Proportions transfer even though absolute
times do not (10 s here vs 72 s reported).

## Design

### 1. Pipeline fast paths (`site/src/lib/pipeline.mjs`)

- **Distinct-color pre-pass.** One cheap scan of the final RGBA per icon.
  When distinct colors ≤ palette size, skip WuQuant entirely and race an
  **exact-indexed arm** (direct palette mapping → `@jsquash/png` →
  oxipng) against the lossless arm; keep-smallest decides, ties keep
  today's behavior. Ramp marks take the current two arms, untouched.
- **oxipng call overhead.** Investigate whether `optimise()` pays module
  init per call; hoist only if byte-identical (same input → same output
  is the test, run before/after on all four fixtures).
- Nothing else in the raster stage changes. Placement (including the
  snap search) is byte-identical by construction — it must stay
  pixel-identical to the CLI, verified by the existing fit lines.

### 2. Worker + progress (responsiveness, not speed)

- Run `buildInBrowser` in a **single Web Worker** (same code, same bytes;
  Vite `?worker`, WASM still fetched via `?url`). Fall back to a
  main-thread build if `Worker` construction throws, so the page works
  everywhere.
- `buildInBrowser` gains an optional `onProgress({ stage, done, total })`
  callback; the page wires it to a `<progress>` element. Stages are
  coarse and known upfront: svg stage, placements, rasters, archive.
- Validation (padding, even sizes) stays where it is and throws before
  any WASM loads, in both threads.

### 3. Page rebuild — mostly landed; remainder below

Since this spec was approved, the page has been rebuilt in the working
tree (uncommitted): semantic `<form>` + `<fieldset>`-style labels, a real
file input covering the drop zone, `<output>` status, `src/styles/app.css`
(shrunk, inlined via `inlineStylesheets: 'always'`), a `warm()` preload on
file select, and `pattern` validation on the inputs. The plan builds on
that state — it does not redo it. What remains for the page:

- **Per-platform previews from already-built files** (no extra renders):
  iOS squircle (~22.4 % radius), Android circle, desktop tile with no
  mask (shows the padding cost honestly), plus the existing on-white /
  on-dark SVG views. Preview source is the largest built icon.
- **`<progress>` element** wired to `onProgress` (Task 2's worker work),
  keeping the existing `<output>` status line and its messages.
- Byte table re-measured after the fast paths (both columns); prose
  claims stay qualitative ("a few percent", "more than doubles") only if
  still true. Controls keep current defaults and meanings.

## Interfaces

- `buildInBrowser(svgText, { colors, sizes, bg, vars, padding, manifest,
  onProgress })` — `onProgress` is the only addition, optional, ignored
  by every other caller. Validation messages unchanged.
- Worker message protocol is internal to the site (build request +
  progress events + result/transferables). No other consumer exists.

## Error handling

- Worker errors (including `FavconError` validation) serialize back and
  render through the existing status line; no stack traces to the page.
- Worker-construction failure falls back to main-thread, once, silently
  except for a `quiet` note. A failed build leaves previous results
  displayed, as today.

## Verification (gates, all required)

1. `cd site && npm run build` clean on Astro 7; no deprecated APIs.
2. `node test/cdp-check.mjs` **extended**: per-mark site PNG totals
   **≤ today's** (tiles 620, general 3758, heavy 3758, gradient 10730 B);
   SVGs, manifest, and placement still exact vs CLI (existing lines);
   validation negatives still throw (existing lines).
3. `npm test` once at the end (CLI suite untouched, proves nothing broke
   across the shared core).
4. Report: headless time before/after per fixture (relative, not
   absolute), per-mark byte table old→new, and confirmation the tab
   stays responsive (worker) — verified by inspection during the
   cdp-check run, not by assertion.

## Risks

- Boundary marks (distinct colors ≈ palette size): exact arm vs WuQuant
  byte differences. Covered by the per-mark gate; any growth fails the
  task, no judgment calls.
- WASM-in-worker bundling (`?worker` + `?url` interplay) and Safari
  quirks. Covered by the main-thread fallback and the cdp-check run.
- The partner's 72 s mark may be ramp-heavy (fast path helps flat marks
  most). Mitigated by honest reporting per fixture, not by averages —
  if ramp marks show no gain, the report says so and progress UI is the
  deliverable there.
