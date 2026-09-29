/**
 * Corner-quad parsing for the drawer layout overlay.
 * Run:  npm run test:labels
 *
 * Fixture values are the prod "Socket Drawer" (2026-09-29), which carries both
 * normalized reference_corners and tidyCAD's pixel-space correction.corner_points
 * on a 2048×2048 scan — px / ref = 2048 on every coordinate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pixelCorners, pixelToNormalized, referenceCorners, type CornerQuad } from "./labels";

const REF: CornerQuad = [
  [0.13309352517985548, 0.3153477218225419],
  [0.8171462829736209, 0.31474820143884885],
  [0.8129496402877697, 0.7170263788968814],
  [0.13429256594724154, 0.7158273381294948],
];
const PX: CornerQuad = [
  [272.58, 645.83],
  [1668.79, 644],
  [1664.92, 1468.47],
  [275.03, 1466.01],
];
const NAT = { w: 2048, h: 2048 };

function assertQuadClose(a: CornerQuad | null, b: CornerQuad, tol: number) {
  assert.ok(a, "expected a quad");
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(a[i][0] - b[i][0]) <= tol, `corner ${i} x: ${a[i][0]} vs ${b[i][0]}`);
    assert.ok(Math.abs(a[i][1] - b[i][1]) <= tol, `corner ${i} y: ${a[i][1]} vs ${b[i][1]}`);
  }
}

test("1.1 Socket Drawer: pixel corners ÷ 2048 match reference_corners within 0.005", () => {
  const dims = { correction: { corner_points: PX } };
  const px = pixelCorners(dims);
  assert.deepEqual(px, PX);
  assertQuadClose(pixelToNormalized(px as CornerQuad, NAT), REF, 0.005);
});

test("1.2 already-normalized corner_points are not pixels", () => {
  assert.equal(pixelCorners({ correction: { corner_points: REF } }), null);
});

test("1.3 pixel corners against a smaller photo are rejected", () => {
  assert.equal(pixelToNormalized(PX, { w: 1024, h: 1024 }), null);
});

test("1.4 unusable photo size → null", () => {
  assert.equal(pixelToNormalized(PX, { w: 0, h: 0 }), null);
  assert.equal(pixelToNormalized(PX, { w: -1, h: 2048 }), null);
  assert.equal(pixelToNormalized(PX, { w: NaN, h: 2048 }), null);
});

test("1.5 missing / malformed corner data → null for both readers", () => {
  for (const dims of [null, undefined, {}, { correction: {} }, { correction: { corner_points: [[1, 2]] } },
    { correction: { corner_points: [[1, "x"], [1, 2], [3, 4], [5, 6]] } }, "not json", 42]) {
    assert.equal(pixelCorners(dims), null, `pixelCorners(${JSON.stringify(dims)})`);
    assert.equal(referenceCorners(dims), null, `referenceCorners(${JSON.stringify(dims)})`);
  }
});

test("1.6 string-encoded dimensions JSON parses identically", () => {
  const obj = { reference_corners: REF, correction: { corner_points: PX } };
  const str = JSON.stringify(obj);
  assert.deepEqual(pixelCorners(str), pixelCorners(obj));
  assert.deepEqual(referenceCorners(str), referenceCorners(obj));
  assert.deepEqual(pixelCorners(str), PX);
});

test("1.7 referenceCorners still reads top-level and .correction.reference_corners", () => {
  assert.deepEqual(referenceCorners({ reference_corners: REF }), REF);
  assert.deepEqual(referenceCorners({ correction: { reference_corners: REF } }), REF);
  // Top level wins when both are present.
  const other: CornerQuad = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.deepEqual(referenceCorners({ reference_corners: REF, correction: { reference_corners: other } }), REF);
  // A drawer with only pixel corners has no reference quad.
  assert.equal(referenceCorners({ correction: { corner_points: PX } }), null);
});

test("edge: corners slightly outside the photo are tolerated up to 5%", () => {
  const near: CornerQuad = [[-100, -100], [2140, -100], [2140, 2140], [-100, 2140]];
  assert.ok(pixelToNormalized(near, NAT));
  const far: CornerQuad = [[-110, 0], [2048, 0], [2048, 2048], [0, 2048]];
  assert.equal(pixelToNormalized(far, NAT), null);
});
