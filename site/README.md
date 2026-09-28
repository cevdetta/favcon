# favcon, in the browser

The third of the three: the [CLI](../bin/favcon.mjs), the [Astro integration](../astro/), and
this. Drop an SVG, get the set, nothing leaves the tab.

```sh
npm install && npm run dev
```

## What it shares with the CLI

Everything in [`lib/core.mjs`](../lib/core.mjs), imported directly rather than copied — the four
svgo plugins, the safe-zone placement, the ICO container, the manifest and the `<link>` block.
`svgo` has a browser build that exports the same `optimize` and `builtinPlugins`, so **the SVG
stage is the same code with the same plugin list**: `icon.svg` and `logo.svg` come out
byte-identical to the CLI's.

## What it cannot share, and what that costs

The three binaries. Their WASM substitutes are not the same programs:

| stage | CLI | here | consequence |
|---|---|---|---|
| render | resvg 0.48.1 | `@resvg/resvg-wasm` 2.6.2 | a different resvg version |
| quantise | pngquant (libimagequant) | `image-q` | a different algorithm entirely |
| recompress | oxipng `-o max --zopfli --zi 120` | `@jsquash/oxipng` level 6 | **no zopfli** |

Measured in headless Chromium against the CLI on the same marks, same options
(`--colors 8 --sizes "192 512" --bg '#000000'`):

| fixture | logo.svg | icon.svg | manifest | placement | PNG bytes |
|---|---|---|---|---|---|
| `tiles` | exact | exact | exact | identical | 951 → 980 (+3.0%) |
| `heavy` | exact | exact | exact | identical | 7080 → 7248 (+2.4%) |
| `general` | exact | exact | exact | identical | 6204 → 6591 (+6.2%) |
| `gradient` | exact | exact | exact | identical | 8779 → 19066 (**+117%**) |

So the SVGs, the manifest and the safe-zone placement are exact; the PNGs cost a few percent on
a flat mark and **more than double on a gradient**. That last row is the honest headline: this
page cannot tell you what your icons will weigh.

`image-q` is used rather than a libimagequant WASM build on purpose: libimagequant is GPL-3.0+,
and linking it would make this GPL-3 (see the licence note in `CLAUDE.md`).

## Verifying it

```sh
npm run build
node test/cdp-check.mjs      # runs the real pipeline in headless Chromium over four fixtures
```

`test/cdp-check.mjs` serves `dist/` from inside its own process and drives Chromium over the
DevTools protocol with Node's built-in `WebSocket` — no Playwright, no stray listener. It checks
PNG and ICO magic bytes, not just byte counts, because a broken pipeline still produces files of
a plausible size. `/check` is the page it drives; open it in a normal browser to watch.
