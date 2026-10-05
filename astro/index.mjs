// The favcon Astro integration.
//
// Three things decide the shape of this file:
//
//   * The build belongs in astro:build:start, not astro:build:done. Writing into public/
//     before Astro's own copy step means the ordinary static-asset pipeline carries the
//     files to outDir: correct for static output AND for every SSR adapter, for free.
//     Building in astro:build:done means writing into `dir` by hand and getting it wrong
//     for any adapter that post-processes dist/.
//   * astro:config:setup must not build. It runs on every dev-server restart, and a 20-30 s
//     stall there is not a tool, it is a hostage situation. It only resolves paths, watches
//     the input and registers the middleware.
//   * Not re-running the build is a CONTENT-ADDRESSED CACHE, not a heuristic. See cacheKey
//     in vite/cache.mjs, which every host shares.

import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, engineVersions, FavconError, linkTags } from '../bin/favcon.mjs';
import { cacheKey, favconVersion } from '../vite/cache.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/** `/` and `/blog/` both come out as a prefix ending in a single slash. */
const basePrefix = (base) => (base && base !== '/' ? `/${base.replace(/^\/+|\/+$/g, '')}/` : '/');

/**
 * Copy a finished set into public/, refusing to clobber anything the integration did not
 * write itself. Overwriting a hand-tuned favicon.ico without a word is the worst possible
 * first impression, so the check is on content: a file favcon wrote has its hash in the stamp.
 */
const publish = async ({ from, files, publicDir, stampPath, logger }) => {
  let stamp = {};
  try { stamp = JSON.parse(await readFile(stampPath, 'utf8')); } catch { /* first run */ }

  for (const f of files) {
    const target = join(publicDir, f);
    if (!(await exists(target))) continue;
    const current = sha256(await readFile(target));
    // Already the bytes about to be written. Nothing to protect, and no stamp needed. That
    // is the case after `rm -rf node_modules`, where the stamp is gone but the files in
    // public/ are still favcon's because the same input and the same tools produce the same
    // bytes. Without this, a clean install would accuse the user of hand-editing their own
    // generated favicon.
    if (current === sha256(await readFile(join(from, f)))) continue;
    if (stamp[f] === current) continue;                    // ours, from an earlier build
    throw new FavconError(
      `public/${f} already exists and favcon did not write it.\n` +
      `       Delete it, or point the integration somewhere else, and run again.\n` +
      `       (favcon will happily replace a file it wrote itself; it will not replace yours.)`,
    );
  }

  await mkdir(publicDir, { recursive: true });
  const next = {};
  for (const f of files) {
    const src = join(from, f), dst = join(publicDir, f);
    await rm(dst, { force: true });
    // A hardlink is free; it fails across filesystems and on some Windows volumes, and the
    // copy is the answer there. Neither is observable from the page. The link does share an
    // inode with the cache entry, which only matters if something rewrites a file in public/
    // IN PLACE rather than replacing it, and the check above would then refuse to publish
    // over it anyway, which is the behaviour wanted.
    try { await link(src, dst); } catch { await copyFile(src, dst); }
    next[f] = sha256(await readFile(dst));
  }
  await mkdir(dirname(stampPath), { recursive: true });
  await writeFile(stampPath, JSON.stringify(next, null, 2));
  logger?.info(`wrote ${files.length} files to public/`);
};

export default function favcon(options = {}) {
  const {
    input = 'src/logo.svg',
    dev = 'fast',
    head = 'inject',
    ...buildOptions
  } = options;

  if (!['fast', 'skip', 'full'].includes(dev)) {
    throw new Error(`favcon: dev must be 'fast', 'skip' or 'full', got ${JSON.stringify(dev)}`);
  }
  if (![true, false, 'inject', 'component'].includes(head)) {
    throw new Error(`favcon: head must be 'inject', 'component' or false, got ${JSON.stringify(head)}`);
  }

  const state = { links: '', inputPath: '', publicDir: '', cacheDir: '', base: '/' };

  /** One build, cache-first. `mode` is 'full' or 'fast'. */
  const runBuild = async (mode, logger) => {
    const source = await readFile(state.inputPath);
    // The dev artefacts are not the production bytes, by design: one size, zopfli at 15 iterations.
    // base goes into the build, not only the links: the manifest's icon URLs carry it too,
    // and without it a site under /blog links /blog/site.webmanifest whose icons 404.
    const opts = mode === 'fast'
      ? { ...buildOptions, base: state.base, sizes: [256], mode: 'fast' }
      : { ...buildOptions, base: state.base };

    const key = cacheKey({ version: favconVersion(), source, options: opts, engine: engineVersions() });
    const slot = join(state.cacheDir, key);
    const stampPath = join(state.cacheDir, 'written.json');

    if (await exists(join(slot, 'index.json'))) {
      const { files } = JSON.parse(await readFile(join(slot, 'index.json'), 'utf8'));
      logger?.info(`cache hit (${key.slice(0, 12)})`);
      await publish({ from: slot, files, publicDir: state.publicDir, stampPath, logger });
      return;
    }

    // Build into a temp directory and move the finished set into the cache, so an
    // interrupted build cannot leave a half-populated slot that later reads as a hit.
    const staging = await mkdtemp(join(tmpdir(), 'favcon-astro.'));
    try {
      const result = await build({ ...opts, input: state.inputPath, out: staging, onWarn: (m) => logger?.warn(m) });
      await writeFile(join(staging, 'index.json'), JSON.stringify({ files: result.files }));
      await rm(slot, { recursive: true, force: true });
      await mkdir(dirname(slot), { recursive: true });
      try {
        await rename(staging, slot);
      } catch {
        // Across filesystems rename fails; copy the slot instead.
        await mkdir(slot, { recursive: true });
        for (const f of [...result.files, 'index.json']) await copyFile(join(staging, f), join(slot, f));
      }
      await publish({ from: slot, files: result.files, publicDir: state.publicDir, stampPath, logger });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };

  return {
    name: 'favcon',
    hooks: {
      'astro:config:setup': ({ command, config, addWatchFile, addMiddleware, updateConfig, logger }) => {
        // Nothing to do for either: `sync` only writes types, and `preview` serves what a
        // previous build already produced.
        if (command === 'sync' || command === 'preview') return;

        state.inputPath = resolve(fileURLToPath(config.root), input);
        state.publicDir = fileURLToPath(config.publicDir);
        state.cacheDir = join(fileURLToPath(config.root), 'node_modules', '.cache', 'favcon');
        state.base = basePrefix(config.base);
        state.links = linkTags(state.base, Boolean(buildOptions.manifest));

        addWatchFile(state.inputPath);

        // The links have to reach the middleware and <Head />, neither of which can be
        // passed arguments. A virtual module is the one channel Astro offers that works
        // in dev and in build, for both consumers, with no file on disk to keep in sync.
        updateConfig({
          vite: {
            plugins: [{
              name: 'favcon:virtual',
              resolveId: (id) => (id === 'virtual:favcon' ? '\0virtual:favcon' : null),
              load: (id) => (id === '\0virtual:favcon'
                ? `export const links = ${JSON.stringify(state.links)};`
                : null),
            }],
          },
        });

        if (head === 'inject') {
          // 'post' so the splice happens after the page has produced its HTML.
          addMiddleware({ entrypoint: 'favcon/astro/middleware', order: 'post' });
        } else if (head === false) {
          logger.info(`add these to your <head>:\n${state.links}`);
        }
      },

      // Dev has no build directory and these files need fixed root URLs, so they go to
      // public/ in both modes. The server hook is where a dev build belongs: config:setup
      // runs on every restart and must stay instant.
      'astro:server:setup': async ({ logger }) => {
        if (!state.inputPath || dev === 'skip') return;
        try {
          await runBuild(dev === 'full' ? 'full' : 'fast', logger);
        } catch (e) {
          // A dev server that will not start because the favicon is unhappy is worse than a
          // dev server with no favicon. The production build still fails, and says why.
          logger.warn(e instanceof FavconError ? e.message : String(e?.message ?? e));
        }
      },

      'astro:build:start': async ({ logger }) => {
        if (!state.inputPath) return;
        await runBuild('full', logger);
      },
    },
  };
}
