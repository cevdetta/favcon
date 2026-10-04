# favcon, in the browser

The third of the three: the [CLI](../bin/favcon.mjs), the [Astro integration](../astro/), and
this. Drop an SVG, get the set, nothing leaves the tab.

```sh
pnpm install && pnpm --filter favcon-site dev   # from the repo root
```

Deployed to <https://favcon.cevdet.ch> by Cloudflare Pages from `main` (settings in
[RELEASING.md](../RELEASING.md)). `trailingSlash: 'never'` with `build.format: 'file'` serves
slash-free URLs without a redirect; `404.astro` must exist, or Pages answers every unknown path
with the home page and a 200.

The site's own icons in `public/` are favcon's output for `public/logo.svg`. The Open Graph
card is `src/og/og.svg`, rendered with the same three tools:

```sh
resvg src/og/og.svg /tmp/og.png
pngquant --force --speed 1 --nofs --colors 16 --output /tmp/og-q.png /tmp/og.png
oxipng -q -o max -s --zopfli -a --out public/og.png /tmp/og-q.png
```

## What it shares with the CLI

Everything in [`lib/core.mjs`](../lib/core.mjs), imported rather than copied: the four
svgo plugins, the safe-zone placement, the ICO container, the manifest and the `<link>` block.
`svgo` has a browser build that exports the same `optimize` and `builtinPlugins`, so **the SVG
stage is the same code with the same plugin list**: `icon.svg` and `logo.svg` come out
byte-identical to the CLI's.

## What it cannot share, and what that costs

The CLI's image engine, for now. This page runs WASM substitutes, which are not the same
programs:

| stage | CLI | here | consequence |
|---|---|---|---|
| render | resvg 0.48.1, in `@napi-rs/image` | `@resvg/resvg-wasm` 2.6.2 | a different resvg version |
| quantise | `@napi-rs/image`'s quantiser | `image-q` | a different algorithm |
| recompress | oxipng, then `@gfx/zopfli` at 120 iterations | `@jsquash/oxipng` level 6 | **no zopfli** |

Measured in headless Chromium against the CLI on the same marks, same options
(the defaults: `--colors 256 --sizes "192 512" --bg '#000000'`), 2026-10-05:

| fixture | logo.svg | icon.svg | manifest | placement | PNG bytes |
|---|---|---|---|---|---|
| `tiles` | exact | exact | exact | identical | 600 → 620 (+3.3%) |
| `heavy` | exact | exact | exact | identical | 5343 → 5043 (−5.6%) |
| `general` | exact | exact | exact | identical | 4959 → 5079 (+2.4%) |
| `gradient` | exact | exact | exact | identical | 25946 → 29642 (+14.2%) |

So the SVGs, the manifest and the safe-zone placement are exact, and the PNGs land within a
few percent of the CLI's on the flat marks and 14.2 % larger on the gradient: the missing
zopfli costs bytes, and `image-q` sometimes wins some back. (At the old default of 8 colours the gradient more than doubled here; the gap
was the two quantisers disagreeing about which 8 colours to keep.) Close is not identical, so
this page still cannot tell you what your icons will weigh.

`image-q` is used rather than a libimagequant WASM build on purpose: libimagequant is GPL-3.0+,
and linking it would make this GPL-3 (see "Licence" in the README).

## Verifying it

```sh
pnpm build
node test/cdp-check.mjs      # runs the real pipeline in headless Chromium over four fixtures
```

`test/cdp-check.mjs` serves `dist/` from inside its own process and drives Chromium over the
DevTools protocol with Node's built-in `WebSocket`: no Playwright, no stray listener. It checks
PNG and ICO magic bytes, not only byte counts, because a broken pipeline still produces files of
a plausible size. `/check` is the page it drives; open it in a normal browser to watch.
