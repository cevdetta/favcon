# favcon on one engine: zero-install CLI, Vite plugin, Astro, website

**Status:** design approved section by section on 2026-10-04; spec awaiting maintainer review.
**Supersedes:** the native three-binary pipeline as the shipped engine (CLAUDE.md §2, §5, §6,
decision 13's reason, decision 15). Those stay true of `bench/`'s reference arm.

## Goal

People reach for `@vite-pwa/assets-generator` because it installs with `npm i`, runs in 0.3 s and
is one option inside vite-plugin-pwa. favcon is more correct (safe zone per mark, animation strip,
`var()` that fails loudly, `--out`, atomic output, documented decisions) but needs three native
binaries and 20–30 s. This design removes the install barrier, keeps or improves the bytes, and
puts the same pipeline behind a CLI, a Vite plugin, the Astro integration and the website, with
byte-identical output in all four.

**Non-goals.** No new output images and no new options without evidence (maintainer, 2026-10-04):
no dark PNG set, no presets, no splash screens, no extra sizes.

## Evidence this rests on (spike, 2026-10-04, scripts in `/tmp/spike-*`, throwaway)

| question | finding |
|---|---|
| Can one npm package replace resvg, pngquant and oxipng? | `@napi-rs/image` ≥ 1.13.0 (MIT, prebuilt for 12 platforms incl. Windows, linux/arm64, darwin/arm64): bundles **resvg 0.48.1** and **oxipng 10.2.1**, the exact versions favcon pins; quantiser is its own clean-room MIT code since 1.13.0 (`imagequant`, GPL-3, removed in #208). 1.12.x and earlier link libimagequant: **floor `>=1.13.0`**. |
| Render fidelity | `fromSvg` never renders below 1000 px (doubles the intrinsic size). Wrapping the icon in an outer SVG with `scale(N/vbW N/vbH) translate(-vbX -vbY)` and cropping to N×N is **pixel-identical to `resvg -w N -h N` on 40/40** files (10 fixtures × 32/180/192/512). Rendering big then resizing fails the bar (10–38 % at 32 px). |
| Bytes and accuracy, 40 files at 256 colours | native + zopfli `--zi 120`: 79 970 B, 288 s, worst 0.279 %. napi `pngQuantize` best-of `losslessCompressPng`: 79 165 B (−1.0 %), 2.9 s, worst 0.035 %. Excluding the gradient fixture napi is +0.6 % (47 005 vs 46 741 B without zopfli); on the gradient it is smaller and 8× more accurate. `pngQuantize` deterministic over two runs. |
| Zopfli without a native build | napi's prebuilt lacks the `png_quantize_zopfli` feature (and that feature is fixed at 15 iterations, quantised path only). Re-deflating the winner's IDAT with **`@gfx/zopfli`** (WASM, Apache-2.0) keeping napi's filters: **76 948 B, −3.8 % vs today, within +0.21 % of oxipng's own zopfli**, identical decoded pixels on 80/80. 15 iterations: 77 157 B, ~6× faster. |
| Browser | `@napi-rs/image-wasm32-wasi` runs in Chromium **only when cross-origin isolated** (COOP `same-origin` + COEP `require-corp` or `credentialless`); fails at load otherwise. 2.48 MB brotli wasm, runs in a worker pool, main thread stalls ≤ 30 ms. **SHA-256-identical output** to native `@napi-rs/image` and to the wasm build under Node. Needs a `globalThis.Buffer` polyfill (else a silent hang) and results copied out of shared memory before use. |
| Maintenance | `@napi-rs/image`: 172k/wk, effectively one maintainer, past gaps of 6–14 months; wasm build depends on emnapi `2.0.0-alpha.5`. `@gfx/zopfli`: last published 2020, stable. **Both are pinned exactly**, and the native reference arm in `bench/` keeps a measurable fallback. |

## Decisions

1. **One engine everywhere:** `@napi-rs/image` (+ `-wasm32-wasi` in the browser) and `@gfx/zopfli`.
   The native binaries leave the shipped package. (Decision 25.)
2. **Two speeds, one engine:** `mode: 'release'` = zopfli 120 iterations (CLI default);
   `mode: 'fast'` = 15 iterations (dev servers, website default). `mode` is a config/API key,
   not a CLI flag. It replaces the internal `zopfli: false`.
3. **`finish` runs in parallel** across sizes: WASM zopfli is single-threaded, so decision 13's
   reason (oxipng saturating the machine) no longer applies. Re-measured interleaved before it
   ships. (Decision 26.)
4. **Dark mode lives in `icon.svg`:** a source's `@media (prefers-color-scheme: dark)` block is
   kept; rasters stay light. §9.3 gains one exception. (Decision 27.)
5. **Config file** shared by every host; keys are today's options plus `mode` and `base`.
6. **Head and manifest are base-aware everywhere.**
7. **Ship as 0.1.0.** Nothing is published yet, so no byte change is visible to anyone.

## Architecture

```
lib/core.mjs       svgo stage, squaring, placement maths, ICO, links(), manifest()   (exists; no imports)
lib/engine.mjs     createEngine({ image, zopfli }) -> { render, encode, finish }     (new; no imports)
lib/pipeline.mjs   build(input, options, engine) -> { files, fit, animated, links }  (new; no imports)
lib/config.mjs     resolveOptions(defaults, file, inline) + defineConfig             (new; no imports)
bin/favcon.mjs     CLI host: argv, config file, Node engine, staging, atomic write, summary
vite/index.mjs     favcon/vite host
astro/index.mjs    favcon/astro: wrapper over favcon/vite + head middleware + <Head />
site/              website host: pipeline in a module worker, browser engine
bench/             native reference arm (resvg/pngquant/oxipng) for measurement only
```

Everything under `lib/` stays import-free: hosts inject svgo, the image library and zopfli, as
`createSvgStage({ optimize, builtinPlugins })` already does. That is what lets the website run the
same files.

### `lib/engine.mjs`

```js
createEngine({ image, zopfli }) -> {
  render(svgText, px, background?) -> Promise<Uint8Array /* PNG */>,
  encode(png, { colors }) -> Promise<Uint8Array>,
  finish(png, { iterations }) -> Promise<Uint8Array>,
}
```

- `render`: the scale-wrapper + crop technique above. `background` is a CSS colour or absent.
- `encode`: `pngQuantize(png, { colors, speed: 1, minQuality: 0, maxQuality: 100 })` and
  `losslessCompressPng(png)`; **strictly smaller wins, a tie keeps the quantised one** (decision 7's
  guard and tie rule, carried over). An explicit `colors` disables napi's quality gate, so this
  never throws for "quality too low".
- `finish`: inflate all IDAT chunks, re-deflate the concatenation with `zopfli` at `iterations`,
  write one IDAT with a fresh CRC, keep every other chunk and napi's row filters. Decoded pixels
  must equal the input's (asserted in tests, not at run time).
- Node host injects `@napi-rs/image` and `@gfx/zopfli`. Browser host injects
  `@napi-rs/image-wasm32-wasi` and `@gfx/zopfli`, installs the `Buffer` polyfill before importing,
  and copies every returned buffer (`new Uint8Array(result)`) before it leaves the adapter.

### `lib/pipeline.mjs`

`build(svgText, options, engine)` is today's `build()` without the filesystem:

1. svgo stage (icon pass first, then logo pass when animated), `squareIconSvg`.
2. Placement: `placeInSafeZone(iconData, renderRgba, canvas, padding)` with `renderRgba` built on
   `engine.render` + PNG decode.
3. One job per distinct `(size, background)` (decision 14 unchanged): `render` → `encode` →
   `finish`. Jobs run concurrently up to a host-supplied limit (Node: `worker_threads` pool sized to
   cores; browser: worker pool; tests: 1 for determinism checks — output does not depend on it).
4. `icoWrap`, `manifest()` when asked, `links()`.

Returns `{ files: [{ name, bytes }], fit: { apple, icons }, animated, links }`. Same file set,
names and order as today.

### Options and config (`lib/config.mjs`)

- Keys: `input`, `out`, `colors`, `sizes`, `bg`, `padding`, `vars`, `animation`, `manifest`
  (`true` or an object of manifest members), `mode` (`'release' | 'fast'`), `base` (default `/`).
- Files, first found in the project root: `favcon.config.js`, `favcon.config.mjs`,
  `favcon.config.ts` (loaded only when the running Node strips types; otherwise a clear
  `favcon: …` error naming the `.mjs` alternative).
- Precedence: CLI flags or plugin options > config file > defaults. Validation and messages are
  the existing `normalise()` ones, shared by every host.
- `defineConfig()` is exported from `favcon` for editor types.

### Dark mode

- The icon pass keeps exactly one `<style>` holding `@media (prefers-color-scheme: dark){…}` rules
  when the source has such a block, and keeps the classes those rules select. Everything else §9.3
  forbids stays forbidden. Implemented the way decision 18 protected motion classes: a plugin that
  marks the media-guarded classes live before `inlineStyles`/csso can drop them.
- Rasters are rendered from the same `icon.svg`; resvg does not evaluate media queries, so they
  are the light variant. No dark PNGs.

### Head and manifest

- `links(base, { manifest })` and `manifest({ sizes, base, purpose, overrides })` in `lib/core.mjs`;
  `base` prefixes every `href` and every manifest `src`.
- CLI: `--html` prints `links` with the configured `base`; `--manifest` writes the merged manifest
  (icons always; `name`, `theme_color`, … from a `manifest` object in the config).

## Hosts

### CLI (`bin/favcon.mjs`)

Argv parsing, flags, exit codes, staging, atomic rename and cleanup are unchanged (§9.11–13, 15).
Removed: tool resolution, spawning, `pngquant-bin`, `FAVCON_RESVG/PNGQUANT/OXIPNG`, the
missing-dependency report. The summary line names the mode. `--version` prints favcon's version
and the pinned engine versions.

### `favcon/vite`

- **Dev (`serve`):** builds in `fast` mode on first request for an icon; serves the set from
  memory at `${base}<name>` with correct content types; watches the input and the config file and
  rebuilds + full-reloads on change. Content-addressed cache in `node_modules/.cache/favcon`, key =
  favcon version + input bytes + canonical options (incl. `mode`) + `@napi-rs/image` and
  `@gfx/zopfli` versions.
- **Build:** `release` set (cached when possible), emitted with `this.emitFile({ type: 'asset',
  fileName })` at the output root. Nothing is written to `public/`.
- **Never clobbers:** a same-named file in `publicDir` fails the build with a `favcon: …` message
  unless its bytes are identical.
- **Head:** `transformIndexHtml` (`order: 'post'`) injects `links`, skipping a page that already has
  `rel="icon"` or `rel="shortcut icon"`. For frameworks without `index.html` (SvelteKit, Nuxt),
  `virtual:favcon` exports `{ links, files }` for the user's layout.
- **vite-plugin-pwa:** when present, favcon's icons go into its manifest instead of a second
  `site.webmanifest`, and favcon warns if its `pwaAssets` generator is also enabled. *Verify in the
  plan:* which of its APIs does this cleanly. Fallback, documented: `manifest: { icons }` filled
  from `virtual:favcon`.

### `favcon/astro`

- `astro:config:setup` registers `favcon/vite` via `updateConfig`, adds the head middleware
  (`order: 'post'`, base-aware, same skip rule) and keeps `<Head />` and `head: false`.
- Still bails on `sync` and `preview`.
- *Verify first in the plan:* emitted assets reach the deployed directory for a static build and
  for an SSR adapter build (`@astrojs/node`). If not, Astro alone keeps today's `public/` write
  path, now with stale-file cleanup.

### Website (`site/`)

- `lib/pipeline.mjs` + browser engine in a module worker; the page posts `{ svgText, options }`
  and receives `{ files, fit, animated, links }` plus progress events.
- Form gains *Fast / Release* (`mode`); default Fast. Output is byte-identical to `npx favcon`
  in the same mode. The "These bytes are not the CLI's bytes" aside is replaced by that claim.
- `_headers`: `/*` gets `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`; `/_astro/*` keeps its immutable cache line. The
  Astro dev server sets the same two headers.
- Not cross-origin isolated (e.g. embedded in an iframe): a clear message, never a hang.
- Removed: `@resvg/resvg-wasm`, `image-q`, `@jsquash/png`, `@jsquash/oxipng`,
  `site/src/lib/pipeline.mjs`'s substitute raster stage.
- First load still ships no pipeline code; choosing a file starts loading the worker and wasm.

## Errors

- Engine and pipeline failures become `FavconError`; hosts print `favcon: <message>` (CLI, exit
  1), throw it (API, Vite, Astro), or show it (site). No stack traces.
- A missing or unloadable engine package (e.g. an unsupported platform) is a `FavconError` naming
  the platform and the package, not a raw `ERR_DLOPEN_FAILED`.

## Testing

- `test/run.mjs` keeps every §9 item. The tool-skip machinery goes: **the full suite runs on
  Linux, macOS and Windows** in CI.
- Accuracy gate: the reference becomes the engine's unquantised render of the var-resolved source
  (pixel-identical to the resvg CLI per the spike). §9.8 unchanged otherwise.
- New:
  - `finish` decodes to identical pixels on every fixture × size.
  - **Cross-host identity:** Node engine and wasm engine under Node produce identical bytes for
    every fixture; the site's browser check compares hashes against the Node pipeline's.
  - Dark mode: a fixture with a `prefers-color-scheme: dark` block keeps it in `icon.svg`; its
    rasters equal the same source without the block.
  - Config precedence and `.ts` handling; `base` in links and manifest.
  - Vite: a fixture project built with `vite build` contains the set and the injected links;
    dev middleware serves them; `publicDir` clash fails; `virtual:favcon` resolves.
  - Astro: static and `@astrojs/node` builds contain the set; middleware injects under `base`;
    `rel="shortcut icon"` page is skipped.
- icotool equivalence stays an optional, skip-when-absent test.

## Benchmarks and decision records

- `bench/bench.mjs` gains the engine arms and keeps the native pipeline as a reference column.
- Record: **25** one engine (with this spike's tables), **26** parallel `finish` (interleaved
  measurement; rejected if it does not win), **27** the dark-mode exception to §9.3. Mark decision
  15 superseded and decision 13's reason re-scoped to the native reference.
- Regenerate `docs/BENCHMARKS.md`.

## Docs and release

- README: install becomes `npx favcon` / Node ≥ 22.12; new Vite section; Astro section updated;
  comparison table re-measured against `@vite-pwa/assets-generator`.
- CLAUDE.md §2, §5, §6, §7, §8 rewritten for the engine; licence note updated (resvg is
  `Apache-2.0 OR MIT`, nothing spawned, no GPL in the dependency tree at `@napi-rs/image >=1.13`).
- CHANGELOG 0.1.0 describes the engine as shipped; `package.json` drops `pngquant-bin`, adds the
  engine packages pinned exactly, adds `exports["./vite"]` with a `types` condition.
- Roadmap entries this closes are marked done in `.claude/roadmap-*.md`.

## Build order

1. `lib/engine.mjs` + `lib/pipeline.mjs`; CLI moved onto them; tests and bench green.
2. `lib/config.mjs`, dark mode, base-aware head and manifest.
3. `favcon/vite`.
4. `favcon/astro` on top (emit verification first).
5. Website on the shared pipeline.
6. Benchmarks, decision records, docs, release prep.

## Risks

| risk | mitigation |
|---|---|
| `@napi-rs/image` stalls or breaks a platform | pinned exact version; native reference arm in `bench/` stays runnable; engine seam means a replacement library is one adapter |
| emnapi alpha in the wasm build changes behaviour | pinned; the browser hash check in CI catches drift |
| `@gfx/zopfli` unmaintained | it is a pure function over bytes, pinned, and tested for identical decoded pixels |
| Release builds stay slow (120 iterations in WASM) | parallel `finish` (decision 26); `fast` for dev and the site |
| COOP/COEP blocks something on the site | the site loads nothing cross-origin today; the not-isolated message covers embeds |
| vite-plugin-pwa or Astro emit integration not clean | each has a stated fallback, verified early in the plan |
