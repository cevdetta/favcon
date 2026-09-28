// The accuracy gate: pct <= 1.0 %, measured on a white AND a black composite.
//
// pct is the share of pixels whose colour distance from the reference exceeds 8/255.
// Distance is the largest single-channel difference, which is the strictest cheap metric -
// an error has to be invisible in every channel to pass, not merely small on average.
//
// Both composites are scored because alpha error cannot hide in either alone: a pixel whose
// alpha is wrong but whose RGB matches is identical to the reference over white if the
// reference is also white there, and only shows up over black. The reported pct is the worse
// of the two.
//
// RMSE is reported alongside but does NOT gate. Error is driven by size, not by the mark: at
// 16 px nearly every pixel is an anti-aliasing edge, so one RMSE threshold would either wave
// through the large sizes or fail every small one.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { placeInSafeZone } from '../../bin/favcon.mjs';
import { decode } from './png.mjs';
import { resolveVars } from './resolve.mjs';

const execFileAsync = promisify(execFile);

export const THRESHOLD_PCT = 1.0;
const CHANNEL_TOLERANCE = 8;      // out of 255

/**
 * An unquantised render of the var-resolved SOURCE - not of favcon's icon.svg. Comparing
 * against the optimised SVG would make the gate blind to exactly what it exists to measure:
 * the error floatPrecision introduces before a rasteriser is ever involved.
 *
 * `fitted: true` is the reference for a masked icon (apple-touch-icon.png, icon-maskable-512.png):
 * the same source placed in the safe zone at `px` by favcon's own placeInSafeZone, measured on
 * the SOURCE's renders.
 * The placement is shared on purpose - the gate is about pixels, not about re-deriving where
 * the mark goes - and the masked-icon tests check the placement itself.
 */
export async function reference(resvgPath, { source, px, bg, vars, fitted = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'favcon-ref.'));
  try {
    let svg = resolveVars(readFileSync(source, 'utf8'), vars);
    // Match what favcon does to a non-square mark, so the gate measures quantisation error
    // rather than the framing difference it would otherwise see at every single pixel.
    const vb = /\bviewBox\s*=\s*"([^"]*)"/.exec(svg);
    if (vb) {
      const [, , w, h] = vb[1].trim().split(/[\s,]+/).map(Number);
      if (w > 0 && h > 0 && (w / h > 1.01 || h / w > 1.01)) {
        const box = Math.max(w, h);
        svg = svg.replace(/<svg\b/, `<svg width="${box}" height="${box}" preserveAspectRatio="none"`);
      }
    }
    const src = join(dir, 'ref.svg'), out = join(dir, 'ref.png');
    if (fitted) {
      let n = 0;
      // placeInSafeZone takes DECODED pixels, so that the website can hand it the output of a
      // WASM codec without carrying Node's PNG reader. The reference path decodes with the
      // suite's own reader - deliberately a different one from favcon's, so a bug in either
      // cannot cancel itself out here.
      const render = async (text, size) => {
        const f = join(dir, `place-${n}.svg`), p = join(dir, `place-${n++}.png`);
        writeFileSync(f, text);
        await execFileAsync(resvgPath, ['--quiet', '-w', String(size), '-h', String(size), f, p]);
        const img = decode(readFileSync(p));
        return { width: img.width, height: img.height, rgba: img.data };
      };
      svg = (await placeInSafeZone(svg, render, px)).svg;
    }
    writeFileSync(src, svg);
    await execFileAsync(resvgPath, ['--quiet', '-w', String(px), '-h', String(px),
                                    ...(bg ? ['--background', bg] : []), src, out]);
    return decode(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const composite = (img, ground) => {
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, o = 0; i < img.data.length; i += 4, o += 3) {
    const a = img.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(img.data[i + c] * a + ground * (1 - a));
  }
  return out;
};

/** { pct, rmse, width, height } - pct and rmse are the worse of the two composites. */
export function score(candidate, ref) {
  if (candidate.width !== ref.width || candidate.height !== ref.height) {
    throw new Error(`size mismatch: ${candidate.width}x${candidate.height} vs ${ref.width}x${ref.height}`);
  }
  let pct = 0, rmse = 0;
  for (const ground of [255, 0]) {
    const a = composite(candidate, ground), b = composite(ref, ground);
    let bad = 0, sq = 0;
    for (let i = 0; i < a.length; i += 3) {
      let worst = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[i + c] - b[i + c]);
        if (d > worst) worst = d;
        sq += d * d;
      }
      if (worst > CHANNEL_TOLERANCE) bad++;
    }
    pct = Math.max(pct, (bad / (a.length / 3)) * 100);
    rmse = Math.max(rmse, Math.sqrt(sq / a.length));
  }
  return { pct, rmse, width: ref.width, height: ref.height };
}
