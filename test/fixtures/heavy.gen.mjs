#!/usr/bin/env node
// Generates heavy.svg: a squircle ring, 64 cubic segments per contour, two contours.
//
// The point of this fixture is float COUNT, not artistry. 64 segments x 6 numbers x 2
// contours = 768 floats emitted at three decimals, which is what gives `floatPrecision: 1`
// something real to round away - a fixture drawn on integer coordinates would pass the
// accuracy gate no matter what precision the pipeline used, and so would not gate anything.
//
// Committed script, committed output: regenerating must be a deliberate act with a visible
// diff, because a fixture that changes under you turns decision 5 into an unfalsifiable
// claim. Run `node test/fixtures/heavy.gen.mjs` and commit the result.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const N = 64;            // segments per contour
const POWER = 4;         // superellipse exponent; 2 is an ellipse, infinity a rectangle
// A 512-unit viewBox, not 64. floatPrecision: 1 keeps one decimal of whatever units the
// path is written in, so the SIZE of a unit decides how much error rounding introduces.
// Drawn at 64 units this fixture sat at 2.0% - above the 1.0% bar - no matter how large the
// palette, because the error was geometry, not colour. At 512 the same rounding is an
// eighth of the distance and the fixture lands inside the bar while still failing loudly at
// floatPrecision 0, which is exactly what a gate fixture has to do. See docs/BENCHMARKS.md.
const CX = 256, CY = 256;

// Polar superellipse: r(t) = R / (|cos t|^p + |sin t|^p)^(1/p), then x = r cos t.
//
// NOT the textbook x = R*sign(cos t)*|cos t|^(2/p) parametrisation. That one is singular in
// the parameter at every axis crossing - |sin t|^(2/p) has an infinite derivative at t = 0 -
// so the first control point came out at y = 1013.748 and the ring folded inside out. The
// polar form has no such cusp for an even p: |cos t|^4 is C-3 continuous everywhere, which
// is two more derivatives than the central difference below needs.
const point = (t, r) => {
  const c = Math.cos(t), s = Math.sin(t);
  const k = r / (Math.abs(c) ** POWER + Math.abs(s) ** POWER) ** (1 / POWER);
  return [CX + k * c, CY + k * s];
};

// Central difference. The analytic derivative is available but this fixture is generated
// once and committed; a closed form would be more code for bytes nobody reads.
const tangent = (t, r) => {
  const h = 1e-6;
  const [x1, y1] = point(t - h, r), [x2, y2] = point(t + h, r);
  return [(x2 - x1) / (2 * h), (y2 - y1) / (2 * h)];
};

const f = (n) => {
  const v = n.toFixed(3).replace(/\.?0+$/, '');
  return v === '-0' ? '0' : v;
};

// `reverse` runs the inner contour the other way round, so the ring is a hole under both
// nonzero and evenodd fill rules rather than only under evenodd.
const contour = (r, reverse) => {
  const step = (reverse ? -1 : 1) * (2 * Math.PI / N);
  const t = (i) => (reverse ? 2 * Math.PI : 0) + i * step;
  const [x0, y0] = point(t(0), r);
  let d = `M${f(x0)} ${f(y0)}`;
  for (let i = 0; i < N; i++) {
    const [px, py] = point(t(i), r), [qx, qy] = point(t(i + 1), r);
    const [pdx, pdy] = tangent(t(i), r), [qdx, qdy] = tangent(t(i + 1), r);
    // Hermite -> Bezier: the handle is the parameter-space tangent scaled by the step / 3.
    const c1x = px + pdx * step / 3, c1y = py + pdy * step / 3;
    const c2x = qx - qdx * step / 3, c2y = qy - qdy * step / 3;
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(qx)} ${f(qy)}`;
  }
  return d + 'Z';
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <style>.shell{fill:var(--shell, #24304A)}.core{fill:var(--core, #EF8354)}</style>
  <path class="shell" fill-rule="evenodd" d="${contour(240, false)}${contour(168, true)}"/>
  <circle class="core" cx="256" cy="256" r="88"/>
</svg>
`;

const out = fileURLToPath(new URL('./heavy.svg', import.meta.url));
writeFileSync(out, svg);
const floats = (svg.match(/-?\d*\.?\d+/g) || []).length;
process.stdout.write(`heavy.svg: ${svg.length} B, ${floats} numbers\n`);
