# Contributing

## The one rule

**Every pipeline change arrives with a number.**

If a change touches the optimisation path — plugin list, plugin params, pngquant or oxipng
flags, stage order, the ICO container — it comes with a `bench/bench.mjs` run showing the
byte delta and proof that every fixture is still inside the accuracy bar. "Looks the same" is
not evidence, and neither is a screenshot.

```sh
pnpm test                      # the definition of done, as node:test
node bench/bench.mjs           # every sweep, printed
node bench/bench.mjs colors    # just one
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
  fixtures that actually ship it is not — see `docs/BENCHMARKS.md`.

## Setting up

```sh
pnpm install                   # the root and site/, one workspace, one lockfile
# plus the three binaries - see the README's install matrix
resvg --version && pngquant --version && oxipng --version
```

`icoutils` is optional. Installing it makes one more test run instead of skip: the one
asserting favcon's 22-byte ICO writer is byte-identical to `icotool -c -r`.

## Fixtures

`test/fixtures/` is thirteen neutral SVGs authored for this repo. No brand content, ever.
Each one exists to exercise something specific — `test/run.mjs` names it. If you add a
fixture, say in a comment what it is for; if it is generated, commit the generator and its
output together (`heavy.gen.mjs` is the pattern).

Fixtures are calibrated, not arbitrary. `heavy.svg` has to introduce real `floatPrecision`
error and still land inside the bar — it fails at `floatPrecision: 0` and passes at `1`,
which is the property that makes it a gate rather than decoration.

`tiles.svg` is the other calibrated one, and it exists because of a regression: it has the
shape almost every animated mark really has — palette classes named once at the top level, a
motion class named only inside the reduced-motion guard — and it must come out with the
palette inlined to `fill=` attributes and `class="blink"` still on the element. `animated.svg`
is the opposite case, where the same class is named both inside and outside the guard and
inlining has to be switched off. Both directions are asserted; neither alone is enough.

`heavy.svg` is also the tightest fixture in the suite, and deliberately so: at the default palette it
sits around 0.8 % against a 1.0 % bar, on the 180 px apple icon. If it is the *only* thing
that fails after a toolchain bump, that is the fixture doing its job — run
`node bench/bench.mjs accuracy` and compare against `docs/BENCHMARKS.md` before concluding
favcon regressed.

## House style

- `bin/favcon.mjs` stays **one file**. The Astro integration may import it; it must never
  import the Astro integration.
- No new CLI flags without a stated user need. The surface is deliberately small.
- Comments explain **why**, and cite the measurement. The code is dense in places because the
  obvious version is wrong, and a reader must be able to find out why without a git
  archaeology trip.
- Errors are `favcon: <message>` on stderr with a non-zero exit — never a raw stack trace.

## Releasing

Set the version in `package.json`, push a `v*` tag, and `release.yml` tests, packs and stages
the tarball on npm; the maintainer approves it there with 2FA. [RELEASING.md](RELEASING.md) has
the whole sequence, including the one-time setup and the hand-published first version.

Byte-output changes — a bumped resvg, pngquant or oxipng, or any pipeline change — are
**minor at minimum, never patch**. Downstream users diff these files into git, and a patch
release that rewrites six binaries is a nasty surprise in a review.
