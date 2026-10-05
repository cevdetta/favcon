// The content-addressed cache every host shares: node_modules/.cache/favcon/<sha256>/. A slot
// is written to a temp directory and renamed into place, so an interrupted build cannot leave
// a half-populated slot that later reads as a hit.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normaliseVars } from '../lib/core.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

let version = null;
/** favcon's own version: a changed default is a minor release at least, so it is in the key. */
export const favconVersion = () => (version ??=
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

/**
 * The cache key, and the reason the cache is safe to trust.
 *
 * favcon's own version, the input bytes, the canonicalised options, and the versions of
 * @napi-rs/image and @gfx/zopfli, because both change output bytes across releases, so a
 * cache keyed only on the SVG hands back stale files after an upgrade. vars are canonical
 * whether they arrive as an object or a Map (the merged options are a Map), and with or
 * without their leading dashes: Object.entries of a Map is empty, which would drop every
 * --var from the key and serve one var's bytes for another's.
 */
export const cacheKey = ({ version, source, options, engine }) => sha256(JSON.stringify({
  version,
  source: sha256(source),
  engine,
  // Shape is canonicalised (sizes sorted), but DEFAULTS ARE NOT SUBSTITUTED: two copies of
  // every default would let the cache serve old bytes, unnoticed, after one changed.
  // `version` covers that. Every build option is in the key.
  options: {
    colors: options.colors ?? null,
    sizes: options.sizes ? [...options.sizes].map(Number).sort((a, b) => a - b) : null,
    bg: options.bg === undefined ? null : options.bg,
    padding: options.padding ?? null,
    vars: [...normaliseVars(options.vars)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    animation: options.animation !== false,
    manifest: options.manifest ?? false,
    mode: options.mode ?? 'release',
    // The manifest's bytes depend on it, so a changed base must not hit an old slot.
    base: options.base ?? '/',
  },
}));

/** The slot's files, or null on a miss. */
export const readSlot = async (cacheDir, key) => {
  const slot = join(cacheDir, key);
  let index;
  try { index = JSON.parse(await readFile(join(slot, 'index.json'), 'utf8')); } catch { return null; }
  return Promise.all(index.files.map(async (name) => ({ name, bytes: new Uint8Array(await readFile(join(slot, name))) })));
};

/** Writes the files to the slot, whole or not at all. */
export const writeSlot = async (cacheDir, key, files) => {
  await mkdir(cacheDir, { recursive: true });
  const staging = await mkdtemp(join(cacheDir, '.tmp-'));
  try {
    for (const f of files) await writeFile(join(staging, f.name), f.bytes);
    await writeFile(join(staging, 'index.json'), JSON.stringify({ files: files.map((f) => f.name) }));
    const slot = join(cacheDir, key);
    await rm(slot, { recursive: true, force: true });
    await rename(staging, slot);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};
