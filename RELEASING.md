# Releasing

favcon is one package, `favcon`. Registry commands use pnpm, which keeps its own login
(`pnpm login`, checked with `pnpm whoami`); pnpm 12 has `publish`, `stage`, `view` and
`deprecate`. No npm token is ever created for this project (decision 23).

- **0.1.0** is published by hand from a packed tarball: npm lets a package use trusted
  publishing only once it exists.
- **Every later release** starts from a tag. The Release workflow tests, packs, and **stages**
  the tarball on npm through trusted publishing (OIDC, with provenance). Nothing goes live until
  the maintainer approves it with 2FA.

Byte-output changes (a bumped resvg, pngquant or oxipng, or any pipeline change) are **minor at
minimum**, never patch: downstream users diff these files into git.

## Before 0.1.0: one-time setup

1. **GitHub.** Create `cevdetta/favcon` and push `main`. `package.json`'s `repository` must
   name the repository the workflow runs in, or npm rejects the provenance.

   ```sh
   git remote add origin git@github.com:cevdetta/favcon.git
   git push -u origin main
   ```

   Wait for CI to pass on `main` before going further.

2. **Cloudflare Pages** (the website, <https://favcon.cevdet.ch>). Create a Pages project
   connected to the repository, no adapter, no deploy workflow:

   | setting | value |
   |---|---|
   | Production branch | `main` |
   | Build command | `pnpm --filter favcon-site build` |
   | Build output directory | `site/dist` |
   | Environment variable | `NODE_VERSION` = `24` |

   pnpm is picked up from `packageManager` in `package.json`. Then **Custom domains → Set up a
   domain**: `favcon.cevdet.ch`. The site writes its own `_headers`.

## 0.1.0

On an up-to-date `main` with a clean working tree and CI green:

1. Check the login and that the name is free:

   ```sh
   pnpm whoami            # your npm user
   pnpm view favcon       # must fail with 404
   ```

2. Date the release in `CHANGELOG.md`: the `## [0.1.0] - YYYY-MM-DD` heading carries the day
   you publish. Commit that on its own.

3. Test and pack. The tarball `npm pack` writes is the file you publish.

   ```sh
   pnpm install
   pnpm test
   npm pack --dry-run     # read the list: bin/, lib/, astro/, README, LICENSE, CHANGELOG only
   npm pack
   ```

4. Try the tarball in an empty directory before it is public:

   ```sh
   cd "$(mktemp -d)" && npm init -y >/dev/null
   npm install /path/to/favcon/favcon-0.1.0.tgz
   npx favcon --version                        # 0.1.0
   npx favcon /path/to/favcon/test/fixtures/general.svg --out out && ls out
   ```

5. Publish it (pnpm asks for 2FA):

   ```sh
   pnpm publish favcon-0.1.0.tgz --access public
   ```

6. Set up trusted publishing for every later release, on npmjs.com, under the package:
   - **Settings → Trusted publishing → GitHub Actions**: repository `cevdetta/favcon`,
     workflow `release.yml`, environment `npm`, publishing mode **stage** (direct publishing
     off).
   - **Settings → Publishing access**: "Require two-factor authentication and disallow
     tokens".

7. Tag and push. The Release workflow runs the full chain, sees 0.1.0 already on npm and skips
   staging, then creates the GitHub Release from the changelog.

   ```sh
   git tag -s v0.1.0 -m v0.1.0
   git push origin v0.1.0
   ```

8. Check: the package on npmjs.com, and in an empty directory `npx favcon@0.1.0 --version`
   prints `0.1.0`.

9. Submit to the [Astro integrations directory](https://astro.build/integrations/): it indexes
   npm packages carrying the `astro-integration` keyword, which `package.json` has.

## Every later release

1. On a branch, set the new version in `package.json`, and move the `## [Unreleased]` entries
   of `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`. Open the release PR
   (`chore: release X.Y.Z`), merge it.
2. From an up-to-date `main`:

   ```sh
   git switch main && git pull --ff-only
   git tag -s vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

3. The Release workflow checks the tag against `package.json`, runs the test suite with the
   same pinned resvg, oxipng and apt pngquant as CI, packs, stages that exact tarball, and
   creates the GitHub Release from the changelog section.
4. Approve with 2FA:

   ```sh
   pnpm stage list
   pnpm stage view <stage-id>      # check name, version, file list
   pnpm stage approve <stage-id>
   ```

   `pnpm stage reject <stage-id>` drops a staged package instead.
5. Check the package on npmjs.com (provenance shown, `latest` moved) and run
   `npx favcon@X.Y.Z --version` in an empty directory.

The workflow runs in the GitHub environment `npm`, which the trusted publisher checks. GitHub
creates it on the first run; create it under Settings → Environments only to add protection
rules. Cloudflare Pages builds `main`, so the website follows `main`, not the release tags.
