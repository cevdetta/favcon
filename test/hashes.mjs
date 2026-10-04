// Prints a SHA-256 for every file of a fast build of every positive fixture. CI runs it on
// Linux, macOS and Windows and fails if any two disagree: the engine's claim is the same
// bytes on every platform, and this is where that claim is checked.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../bin/favcon.mjs';

const MARKS = ['general', 'flat', 'second', 'mask', 'heavy', 'animated', 'tiles', 'wide', 'gradient', 'smil', 'dark'];
const dir = mkdtempSync(join(tmpdir(), 'favcon-hashes.'));
try {
  for (const m of MARKS) {
    const out = join(dir, m);
    const input = fileURLToPath(new URL(`./fixtures/${m}.svg`, import.meta.url));
    const r = await build({ input, out, bg: '#000000', mode: 'fast' });
    for (const f of r.files) {
      process.stdout.write(`${createHash('sha256').update(readFileSync(join(out, f))).digest('hex')}  ${m}/${f}\n`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
