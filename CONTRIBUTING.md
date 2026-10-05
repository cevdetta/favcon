# Contributing

## The one rule

**Every pipeline change arrives with a number.**

If a change touches the optimisation path (plugin list, plugin params, the engine's quantiser
or zopfli settings, stage order, the ICO container), it comes with a `bench/bench.mjs` run showing the
byte delta and proof that every fixture is still inside the accuracy bar. "Looks the same" is
not evidence, and neither is a screenshot.

```sh
pnpm test                      # the definition of done, as node:test
node bench/bench.mjs           # every sweep, printed
node bench/bench.mjs colors    # one sweep only
node bench/bench.mjs --write   # regenerate docs/BENCHMARKS.md
```

A change that costs bytes to save build time is rejected by default. Smaller output beats
faster build: the bytes ship to every visitor forever, the build happens once.

## Measure before you believe it

`docs/DECISIONS.md` decision 13 exists because an obvious-looking parallelism win measured
12.8 s → 8.1 s in a quick hand test and **13.80 s → 14.08 s** under a controlled interleaved
benchmark. Interleave repetitions, check for background load, and prefer tracing over totals.

Two more traps this repo has already fallen into, both caught only by measuring:

- resvg does **not** stretch a non-square mark to fill `-w N -h N`. It preserves the aspect
  ratio and derives the second dimension, so the "obvious" reading of the flags produced
  32×16 rasters and an ICO whose header disagreed with its own payload.
- `--colors 8` was documented as inside the accuracy bar on every mark and size. On the
  fixtures this repo ships it is not; see `docs/BENCHMARKS.md`.

## Setting up

```sh
pnpm install                   # the whole setup: the root and site/, one workspace, one lockfile
```

Three optional tools turn on more checks. `resvg` on PATH runs the render-fidelity test, which
holds the engine to the resvg CLI pixel for pixel. `icotool` (from `icoutils`) runs the test
asserting favcon's 22-byte ICO writer is byte-identical to `icotool -c -r`. `bench/` needs
resvg, pngquant and oxipng for its native reference arm.

## Definition of done

`test/run.mjs` automates every line.

1. Produces `logo.svg`, `icon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`,
   `icon-512.png`, and nothing else.
2. Dimensions are exact: 180×180, 192×192, 512×512; the ICO reports a single 32×32 entry.
3. `icon.svg`, in **every** mode (including a default build of an animated source), contains no
   `role`, no `aria-*`, no `class`, no `style=`, no `<style>`, no `<defs`, no `var(`, no
   `<desc>`, no `<title>`, and keeps `xmlns` and `viewBox`. One exception: a source with a
   `prefers-color-scheme` block keeps that block in one `<style>`, with the classes it selects
   (decision 25).
4. `--var name=value` overrides the fallback, and the old value is gone from the output.
5. An unresolvable `var()` with no fallback fails with an error and a non-zero exit, and writes
   nothing.
6. A referenced id survives; unreferenced ids are dropped.
7. `favicon.ico` starts `00 00 01 00`, its payload is a PNG (`89 50 4E 47`), and the container is
   byte-identical to `icotool -c -r` wherever icotool is available.
8. Every emitted raster meets `pct <= 1.0 %`; the padded icons are scored against
   **background-matched references, padded the same way**.
9. `apple-touch-icon.png` has no alpha channel when `--bg` is set (the default).
10. `--manifest` writes valid JSON: the size icons as `"any maskable"` when `--bg` is opaque
    and `"any"` alone when it is `none`, and never `icon.svg`; `--html` emits the `<link>` set with
    `sizes="32x32"` on the ICO.
    Every opaque pixel of every padded icon lies inside the safe circle; a pixel-grid mark is
    snapped to whole pixels, a curved one keeps its exact fit.
11. Re-running with identical inputs and identical engine versions produces byte-identical outputs.
12. Temp files are removed on success **and** on failure; a failed run leaves any previous output
    set intact, and leaves no staging directory behind.
13. `--colors` outside 2–256, a missing input, a non-SVG input and an unknown flag all fail with a
    clear `favcon: …` message and **no stack trace**.
14. Animation lands in `logo.svg` and nowhere else: it keeps its reduced-motion guard, has `var()`
    resolved inside it, carries no `role`/`aria-*`, and every surviving class is a live selector.
    `--no-animation` makes `logo.svg` equal `icon.svg`; a static source does the same. `icon.svg`
    equals the same source with its animation deleted and is byte-identical in both modes, as is
    every raster. A `var()` used only by an animation fails the `logo.svg` pass, naming
    `--no-animation`, and never the `icon.svg` one.
15. Long options accept `--opt=value`; a flag that takes no argument rejects one.
16. `--sizes 32` renders twice on purpose: once padded for `icon-32.png`, once unpadded for
    the ICO payload. Under `--bg none` the icon is unpadded too, and the two are the same
    bytes again.
17. A non-square viewBox warns on stderr.
18. `npm pack` contains only `bin/`, `lib/`, `astro/`, `vite/`, `README.md`, `LICENSE`,
    `CHANGELOG.md`, and `lib/core.mjs` by name, since the package cannot run without it.
19. A `favcon.config.js`, `.mjs` or `.ts` in the working directory supplies any option; flags win,
    and `--var` merges by name. An unknown key, a default export that is not an object, or a
    config that fails to load is a `favcon: …` message with no stack trace; a `.ts` Node cannot
    load names `favcon.config.mjs`.
20. `base` prefixes every `href` from `--html` and every icon `src` in the manifest.
21. `favcon/vite` emits the same bytes as the CLI, once, at the output root of a client build
    and nowhere in an SSR build; links them in `index.html` unless the page already has a
    `<link rel="icon">`; serves them in dev at `base`; and never replaces a different file in
    `public/`.

---

## Fixtures

`test/fixtures/` is thirteen neutral SVGs authored for this repo. No brand content, ever.
Each one exists to exercise something specific; `test/run.mjs` names it. If you add a
fixture, say in a comment what it is for; if it is generated, commit the generator and its
output together (`heavy.gen.mjs` is the pattern).

Fixtures are calibrated, not arbitrary. `heavy.svg` has to introduce real `floatPrecision`
error and still land inside the bar: it fails at `floatPrecision: 0` and passes at `1`,
which is the property that makes it a gate rather than decoration.

`tiles.svg` is the other calibrated one, and it exists because of a regression: it has the
shape almost every animated mark has (palette classes named once at the top level, a motion
class named only inside the reduced-motion guard), and it must come out with the palette
inlined to `fill=` attributes and `class="blink"` still on the element. `animated.svg`
is the opposite case, where the same class is named both inside and outside the guard and
inlining has to be switched off. Both directions are asserted; neither alone is enough.

`heavy.svg` is also the tightest non-gradient fixture in the suite, by design: at the default
palette it sits at 0.114 % on the 192 px icon, and at `--colors 8` at 0.70 % on the 180 px
apple icon, against a 1.0 % bar. If it is the *only* thing that fails after an engine bump,
that is the fixture doing its job. Run
`node bench/bench.mjs accuracy` and compare against `docs/BENCHMARKS.md` before concluding
favcon regressed.

## House style

- `bin/favcon.mjs` holds what only the CLI does: options, staging, the atomic write. What the
  website also runs lives in `lib/`, which imports nothing. The Astro integration may import
  either; neither may import the Astro integration.
- No new CLI flags without a stated user need. The surface is kept small on purpose.
- Comments explain **why**, and cite the measurement. The code is dense in places because the
  obvious version is wrong, and a reader must be able to find out why without a git
  archaeology trip.
- Errors are `favcon: <message>` on stderr with a non-zero exit, never a raw stack trace.

## Releasing

Set the version in `package.json`, push a `v*` tag, and `release.yml` tests, packs and stages
the tarball on npm; the maintainer approves it there with 2FA. [RELEASING.md](RELEASING.md) has
the whole sequence, including the one-time setup and the hand-published first version.

Byte-output changes (a bumped `@napi-rs/image` or `@gfx/zopfli`, or any pipeline change) are
**minor at minimum, never patch**. Downstream users diff these files into git, and a patch
release that rewrites six binaries is a nasty surprise in a review.
