# favcon

One SVG in, an optimised favicon set out.

```sh
npx favcon logo.svg --out public
```

That is the whole quickstart. It writes six files, prints their sizes, and tells you if your
mark is animated.

```
logo.svg                  289 B  static (no animation in the source)
icon.svg                  289 B
favicon.ico               463 B
apple-touch-icon.png     1092 B  mark at 142px of 180 in the safe zone
icon-192.png             1160 B  mark at 152px of 192 in the safe zone
icon-512.png             2721 B  mark at 408px of 512 in the safe zone
```

(That is `test/fixtures/general.svg`, a two-colour mark, at the defaults. Your bytes depend on
your mark — `node bench/bench.mjs` measures the whole corpus.)

No install at all: **[favcon.cevdet.ch](https://favcon.cevdet.ch)** runs the same SVG stage in
your browser, with nothing uploaded. Its SVGs are byte-identical to the CLI's; its PNGs come
from WASM substitutes for the three binaries and land within a few percent of the CLI's, and
the page shows the numbers.

Add the links to your `<head>` — `favcon --html` prints them:

```html
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

## Install

favcon is a small orchestrator around three binaries it does not bundle. You need all three.

| | macOS | Debian/Ubuntu | Arch | Anywhere |
|---|---|---|---|---|
| **resvg** | `brew install resvg` | tarball from [releases](https://github.com/linebender/resvg/releases) | `pacman -S resvg` | `cargo install resvg` |
| **oxipng** | `brew install oxipng` | `.deb` from [releases](https://github.com/oxipng/oxipng/releases) | `pacman -S oxipng` | `cargo install oxipng` |
| **pngquant** | `brew install pngquant` | `apt install pngquant` | `pacman -S pngquant` | [pngquant.org](https://pngquant.org) |

pngquant is also an `optionalDependency` (`pngquant-bin`), so on a platform it has a prebuilt
for you may already have it. It has no `linux/arm64` build and its install chain is elderly,
which is exactly why it is optional: a failed install is a warning, not a broken `npm i`. (Its
macOS binary is universal, so Apple Silicon is covered.)

If favcon cannot find something, it says so — all of them at once, with the install lines.
`FAVCON_RESVG`, `FAVCON_PNGQUANT` and `FAVCON_OXIPNG` point it at a binary directly.

For CI, prefer pinned release tarballs over `cargo install`: they land in seconds instead of
minutes, and they pin the exact toolchain your byte counts were measured with. See
`.github/workflows/ci.yml` for a worked example. Note that upstream resvg has shipped no
Windows binary since v0.47.0.

Node 22.12 or newer.

## What you get

| File | What it is |
|---|---|
| `logo.svg` | The mark itself. Optimised, **animation intact**. For pages and READMEs. |
| `icon.svg` | The same optimisation **plus a structural animation strip**. This is the browser favicon *and* the file every raster below is rendered from. |
| `favicon.ico` | One 32×32 entry, stored as a raw PNG in a 22-byte container. |
| `apple-touch-icon.png` | 180×180 (60pt @3x; no iPhone renders above @3x) on the `--bg` ground, the mark placed in the safe zone so iOS's rounded mask cuts nothing. |
| `icon-<size>.png` | On the `--bg` ground, the mark placed in the safe zone the same way (`--padding`, default `auto`). Default 192 and 512, the pair Chrome's install criteria document. The manifest's `any maskable` icons. |
| `site.webmanifest` | Only with `--manifest`. Icons only — you merge your own `name` and `theme_color`. |

Two SVGs, because they are not the same file. `icon.svg` is what a `<link rel="icon">` points
at, and a favicon carrying `<style>`, `@keyframes` and classes is bytes no rasteriser and no
ICO can use. `logo.svg` is the mark, animation and all, for the places that can show it.

## Why not one of the others

There are several favicon generators on npm. Most write whatever sharp's encoder produced; the
two that quantise do it through sharp's libimagequant and stop there. None of them compares
candidate encodings or recompresses with zopfli, which is the whole point of this one.

| | weekly | dependencies |
|---|---|---|
| [`favicons`](https://www.npmjs.com/package/favicons) | ~573k | `sharp` `xml2js` `escape-html` |
| [`@vite-pwa/assets-generator`](https://www.npmjs.com/package/@vite-pwa/assets-generator) | ~312k | `sharp` `sharp-ico` `cac` `consola` `picocolors` `unconfig` |
| [`astro-favicons`](https://www.npmjs.com/package/astro-favicons) | ~5.7k | `favilib` `ultrahtml` |
| [`favgen`](https://www.npmjs.com/package/favgen) | ~3 | `svgo` `sharp` `is-svg` `to-ico` `commander` |

(Weekly downloads for 22–28 September 2026.) `favicons` is thorough — it will write you thirty
files for platforms that stopped existing — and its PNGs are whatever sharp's encoder produced.
`astro-favicons` wraps the same engine for Astro. `@vite-pwa/assets-generator` encodes at
sharp's `quality: 60` and `favgen` at `colors: 64`: one quantised encode, no comparison, no
zopfli.

favcon does fewer files and more work on each: quantise, compare three candidate encodings,
and recompress the winner with zopfli. The default output is held to a pixel-accuracy bar —
no more than 1 % of pixels visibly off — by the test suite, rather than taken on trust
([docs/BENCHMARKS.md](docs/BENCHMARKS.md) has the numbers). It also does the thing none of them do — keeps your animation in one file
and guarantees it is *absent* from the other.

If you want thirty files for thirty platforms, use `favicons`. If you want six files that are
as small as they can be, this one.

## Flags

```
-o, --out DIR     Output directory (default: current)
    --colors N    Palette size, 2-256 (default: 256, a ceiling, not a target)
    --sizes LIST  Padded "any maskable" PNG sizes (default: "192 512")
    --bg COLOR    Ground of the padded icons (default: #000000). "none" keeps the set
                  transparent and unpadded, declared "any" only.
    --padding P   Margin of each padded icon, as a percentage per side (default: auto).
                  `auto` measures the mark's own extent and snaps it to whole pixels;
                  give a number to override it.
    --var N=V     Set a CSS custom property, e.g. --var brand=#0E7C68. Repeatable.
    --no-animation  Build logo.svg static too, so it equals icon.svg.
    --manifest    Also write site.webmanifest.
    --html        Print the <link> tags.
-q, --quiet   -V, --version   -h, --help
```

Long options also accept `--opt=value`; `--` ends option parsing. A flag that takes no
argument rejects one.

### `--var`

Your mark can be a template. `var(--brand, #0E7C68)` renders as `#0E7C68` by default, the way
a browser resolves an undefined property, and `--var brand=#7C0E68` overrides it:

```sh
favcon logo.svg --var brand=#7C0E68 --out public
```

A `var()` with no fallback and no override is an error, not a black square. (resvg has no
`var()` support at all — it renders the whole mark black and warns on stderr — so favcon
resolves every custom property before anything is rasterised.)

### `--bg`

iOS composites transparent Home Screen icons onto **black**, and a maskable icon should be
opaque, so the padded icons get a ground rather than an alpha channel they would lose anyway.
The default is `#000000`
— what the platform would have done to a transparent icon regardless, minus the tRNS chunk —
and favcon warns when you did not choose, because the right ground is a property of your mark
and not of the format. `--bg '#fff'` for a mark drawn on light, `--bg none` to keep the alpha
(and with it an unpadded set, declared `"any"` only).

The value is validated by asking resvg to render a 1×1 pixel with it, so anything resvg takes
works — `#fff`, `rebeccapurple`, `rgb(14 124 104)`, `hsl(170 80% 27%)` — and the validator can
never disagree with the renderer.

### The padded icons

Every platform that installs a web app shows its icon through a shape of its own:

| Platform | Reads | Shape | favcon's file |
|---|---|---|---|
| iOS, iPadOS, Safari Add to Dock | `apple-touch-icon`, 180 px for iPhone | rounded square, corners about 22 % | `apple-touch-icon.png` |
| Android (Chrome, WebAPK) | manifest, `any maskable` | circle, squircle, rounded square | `icon-192.png`, `icon-512.png` |
| ChromeOS, macOS (Chrome installs) | manifest, `any maskable` | the OS's rounded shape | `icon-192.png`, `icon-512.png` |
| Windows, Linux desktops | manifest, `any maskable` | none; drawn as is, on light and dark | `icon-192.png`, `icon-512.png` |
| Chrome's install criteria | manifest, `any maskable` icons at 192 and 512 px | none | `icon-192.png`, `icon-512.png` |
| Browser tabs | `<link rel="icon">` | none | `icon.svg`, `favicon.ico` |

The sizes are the documented ones: 180 px is the largest size Apple lists for a web clip
icon, and web.dev's install criteria, Chrome's own docs and MDN all ask for a 192 and a 512.
One set carries both purposes: the icons are padded into the safe zone, so they are honestly
maskable, and Chrome will not install a PWA whose icons are all `maskable` — it needs at
least one `any`. The cost is on desktops, which do not mask: there the icon shows a smaller
mark on its ground rather than edge to edge. `--bg none` opts out entirely (transparent,
unpadded, `"any"` only).

`icon.svg` is not in the manifest. An SVG entry makes Chrome's Android install fail and fall
back to a home-screen bookmark ([crbug.com/40925759](https://issues.chromium.org/issues/40925759)).

**The safe zone.** The W3C Web App Manifest names the one area every mask shows: a circle
centred on the icon, with a radius of 40 % of its size. iOS's rounded square contains that
circle whole, so every padded icon uses it.

**Placement is measured by default, fixed on request.** `auto` (the default) renders `icon.svg`
at each padded icon's size, finds the farthest opaque pixel from the centre (its outer corner,
so the whole pixel counts), and scales the mark until that pixel sits on the safe circle. A mark
with its own margin is enlarged, one that reaches its corners is shrunk. `--padding` overrides
it with a fixed percentage per side — applied literally and never snapped. No fixed number is
right for every mark (a round one fills 80 % of the width; a square one's corners touch the
safe circle at 56.6 %): across the fixtures `auto` chooses 7.6 %–18.8 % per side. A source
opaque in all four corners is full-bleed, drawn with its own ground, and used as it is.

**Then it snaps to whole pixels.** An exact fit scales by an arbitrary factor, so the edges of
a mark drawn on a grid fall between pixels and every one of them is anti-aliased. favcon walks
the size down in whole pixels, no more than 10 %, and takes the size where the mark renders
with the fewest partly covered pixels, but only if that at least halves them. A curved mark,
which is anti-aliased at every size, keeps its exact fit. Measured on a seven-block grid mark
at 512 px:

| Placement | Mark box | Colours | Edge pixels | Bytes |
|---|---|---|---|---|
| exact fit | 330 of 512 px | 12 | 1905 | 571 B |
| snapped | 320 of 512 px | 3 | 0 | 290 B |

At 180 px the same mark snaps from 116 to 112 px and the apple icon is 151 B.

`--bg none` keeps the set transparent and unpadded, declared `"any"` only: a platform
composites a transparent icon onto a colour of its own choosing, so the safe zone would mean
nothing, and padding 32 px of tab furniture only makes the mark smaller.

## Animation

Animation lands in `logo.svg` and nowhere else. Feed favcon an animated mark and you get a
`logo.svg` that still moves, an `icon.svg` with the motion structurally removed, and rasters
rendered from the second one — so "the rasters are the rest frame" is a property of the
pipeline rather than a hope about resvg's CSS support.

For that to work, the mark has to follow four rules:

- **The geometry as drawn is the rest frame.** Nothing is positioned by a keyframe, so resvg,
  `--no-animation` and a reduced-motion viewer all see the same mark.
- **Motion lives inside `@media (prefers-reduced-motion: no-preference)`.** Everything inside
  such a block is treated as motion and removed wholesale.
- **Iterations are `var(--loop, infinite)`.** Every keyframe set ends on the rest frame, so
  `--var loop=1` plays once and stops on the static mark.
- **Each palette class is used once per file**, so it can be inlined. Where several shapes
  share a colour, put the class on a wrapper `<g>`.

The strip is structural, not a regex: SMIL elements, `@keyframes`, any `@media` mentioning
`prefers-reduced-motion`, and `animation-`/`transition-` declarations wherever they are —
including inside `style=""`. A non-motion declaration sharing a `style` attribute with a
motion one survives.

`--no-animation` builds `logo.svg` static too. A source with no animation gets `logo.svg` as a
byte copy of `icon.svg`.

## Astro

```js
// astro.config.mjs
import favcon from 'favcon/astro'

export default defineConfig({
  integrations: [favcon({ input: 'src/logo.svg' })],
})
```

That is all of it. The files land in `public/`, the `<link>` tags are spliced into every page
that does not already declare an icon, and `config.base` is prefixed for you.

Options mirror the CLI, except that `sizes` is a real array and `vars` is an object — that is
what the flags *mean*; the string forms exist only because argv is strings. `manifest` may
take an object (`name`, `short_name`, `theme_color`, …) which is merged into the icons; the
CLI writes icons-only because a CLI cannot know your app's name, but an integration can.

```js
favcon({
  input: 'src/logo.svg',
  sizes: [192, 512],
  vars: { brand: '#0E7C68' },
  bg: '#0E1C28',     // the padded icons' ground; also a good background_color below
  manifest: { name: 'Example', short_name: 'Ex', theme_color: '#0E7C68', background_color: '#0E1C28' },
  dev: 'fast',       // 'fast' | 'full' | 'skip'
  head: 'inject',    // 'inject' | 'component' | false
})
```

**It does not rebuild on every dev-server restart.** The cache is content-addressed, not a
heuristic: keyed on favcon's version, the input bytes, the canonicalised options **and the
`--version` strings of resvg, pngquant and oxipng**. That last part is what makes it correct
— all three change their output across releases, so a cache keyed only on the SVG would hand
back stale files after a `brew upgrade`, invisibly. A hit hardlinks into `public/` in
single-digit milliseconds.

For a genuinely cold first run, `dev: 'fast'` (the default) builds one 256 px size with zopfli
off: under a second instead of the full build's ~30 s, since zopfli is ~98 % of the wall clock.
Dev artefacts are deliberately not the production bytes.

**Head tags.** Astro has no official head-injection hook — all four `injectScript` stages are
JavaScript, and a `<link rel="icon">` written by a script is found after the browser has
already asked for `/favicon.ico`. So `head: 'inject'` (the default) is an `order: 'post'`
middleware that splices before `</head>` and skips any page that already contains
`rel="icon"`. `head: 'component'` gives you `favcon/astro/Head.astro` to place yourself, and
`head: false` logs the block for pasting.

favcon **will not overwrite a `public/favicon.ico` it did not write itself.** Silently
clobbering a hand-tuned ICO is the worst possible first impression, so the check is on
content: delete or move the file, and favcon writes its own.

## How it decides

Every step was chosen by measurement. The reasoning is in
**[docs/DECISIONS.md](docs/DECISIONS.md)**, and the current numbers — regenerated by
`node bench/bench.mjs --write` — are in **[docs/BENCHMARKS.md](docs/BENCHMARKS.md)**.

The short version, because these are the parts that look wrong until you know why:

- **Quantise before you recompress.** pngquant re-encodes from scratch, so any order ending in
  pngquant throws away everything oxipng did — measured at 192 px, the wrong order is 19.7 %
  bigger.
- **An ICO holding a PNG is a 22-byte header plus that PNG verbatim**, so nothing can be
  optimised after packing. favcon writes that header itself, byte-identical to
  `icotool -c -r`, which removes the only dependency with no npm package and no Windows build.
  The BMP payload `icotool` writes by default is 16× larger.
- **Zopfli runs once**, on the file that already won the lossy/lossless comparison. Running it
  on both sides costs three times as much for identical bytes.
- **The rasters are built serially on purpose.** Zopfli is ~98 % of wall clock so overlapping
  looked obvious — but four jobs at once burn about 40 % more CPU for 1.6 % less wall clock
  (22.06 s serial, 21.72 s concurrent, inside the run-to-run spread). The extra cores go into
  contention, not work.

## Licence

MIT. favcon *spawns* pngquant (GPL-3.0+) and resvg (MPL-2.0) across a process boundary —
mere aggregation, no linking.
