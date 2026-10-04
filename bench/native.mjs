// The native toolchain favcon's decisions were measured on: resvg, pngquant and oxipng,
// spawned by name from PATH. The package no longer uses them; the bench keeps them so every
// byte claim stays comparable with that pipeline.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Spawns `tool`; a failure carries the exit code as `e.code`, as pngquant's 98/99 need. */
export const run = (tool, args) => execFileAsync(tool, args, { maxBuffer: 1 << 22 });

/** `{ resvg, pngquant, oxipng }` first lines of `--version`, or null for a missing tool. */
export const nativeVersions = async () => Object.fromEntries(await Promise.all(
  ['resvg', 'pngquant', 'oxipng'].map(async (t) => {
    try { return [t, (await execFileAsync(t, ['--version'])).stdout.split('\n')[0].trim()]; }
    catch { return [t, null]; }
  })));
