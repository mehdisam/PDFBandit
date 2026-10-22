// Operator-list scanning for tier-1 detection (spec 1.5 §10a): raster placements (P1) and
// vector drawings (P2). Pure — a fake OPS enum and an identity viewport stand in for pdf.js,
// so every placement/merge/filter rule runs under `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  imageBoxes, vectorBoxes, clusterBoxes, bboxOfPoints, FIG_MIN, FIG_GAP,
} from '../src/services/detect_ops.js';

// Distinct numbers for every op the scanner looks at; the scanner never assumes pdf.js values.
const NAMES = [
  'save', 'restore', 'transform', 'paintFormXObjectBegin', 'paintFormXObjectEnd',
  'beginGroup', 'endGroup', 'paintImageXObject', 'paintInlineImageXObject',
  'paintImageMaskXObject', 'paintSolidColorImageMask', 'paintImageXObjectRepeat',
  'paintImageMaskXObjectRepeat', 'paintImageMaskXObjectGroup', 'paintInlineImageXObjectGroup',
  'constructPath', 'rectangle', 'moveTo', 'lineTo', 'curveTo', 'curveTo2', 'curveTo3',
  'closePath', 'fill', 'eoFill', 'stroke', 'closeStroke', 'fillStroke', 'eoFillStroke',
  'closeFillStroke', 'closeEOFillStroke', 'endPath', 'clip', 'eoClip',
];
const OPS = Object.fromEntries(NAMES.map((n, i) => [n, i + 1]));

const viewport = { width: 600, height: 800, convertToViewportPoint: (x, y) => [x, y] };
const list = (...ops) => ({
  fnArray: ops.map(o => OPS[o[0]]),
  argsArray: ops.map(o => o[1] ?? null),
});
const img = (a = [0, 0, 100, 100, 50, 60]) => list(['transform', a], ['paintImageXObject', ['img']]);
const rect = (x, y, w, h, paint = 'fill') => [
  ['constructPath', [[OPS.rectangle], [x, y, w, h], []]],
  [paint, null],
];
const near = (a, b, eps = 0.01) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

// ---------------------------------------------------------------- raster placements
test('image: the unit square is placed by the CTM and reported in viewport points', () => {
  const boxes = imageBoxes(img(), viewport, OPS);
  assert.equal(boxes.length, 1);
  assert.ok(near(boxes[0], [50, 60, 150, 160]), JSON.stringify(boxes[0]));
});

test('image: save/transform/restore nest without leaking the CTM', () => {
  const op = list(
    ['save', null], ['transform', [200, 0, 0, 200, 10, 20]], ['paintImageXObject', ['a']], ['restore', null],
    ['paintImageXObject', ['b']],
  );
  // The second image is painted at identity: a 1x1 unit square, below IMG_MIN and dropped.
  const boxes = imageBoxes(op, viewport, OPS);
  assert.equal(boxes.length, 1);
  assert.ok(near(boxes[0], [10, 20, 210, 220]));
});

test('image: a Form XObject matrix is part of the image placement', () => {
  const op = list(
    ['paintFormXObjectBegin', [[100, 0, 0, 100, 100, 100], null]],
    ['paintImageXObject', ['a']],
    ['paintFormXObjectEnd', null],
  );
  const boxes = imageBoxes(op, viewport, OPS);
  assert.equal(boxes.length, 1);
  assert.ok(near(boxes[0], [100, 100, 200, 200]));
});

test('image: paintImageXObjectRepeat emits one box per position', () => {
  const op = list(['paintImageXObjectRepeat', ['id', 100, 80, [10, 20, 200, 300]]]);
  const boxes = imageBoxes(op, viewport, OPS);
  assert.equal(boxes.length, 2);
  assert.ok(near(boxes[0], [10, 20, 110, 100]));
  assert.ok(near(boxes[1], [200, 300, 300, 380]));
});

test('image: mask repeat keeps the skew/scale components of its transform', () => {
  const op = list(['paintImageMaskXObjectRepeat', ['mask', 100, 0, 0, 50, [10, 20]]]);
  const boxes = imageBoxes(op, viewport, OPS);
  assert.equal(boxes.length, 1);
  assert.ok(near(boxes[0], [10, 20, 110, 70]));
});

test('image: mask and inline groups use each entry transform', () => {
  const mask = list(['paintImageMaskXObjectGroup', [[
    { transform: [100, 0, 0, 100, 10, 20] },
    { transform: [50, 0, 0, 50, 300, 400] },
  ]]]);
  assert.equal(imageBoxes(mask, viewport, OPS).length, 2);

  const inline = list(['paintInlineImageXObjectGroup', [{ width: 1, height: 1 }, [
    { transform: [120, 0, 0, 90, 10, 10], x: 0, y: 0, w: 1, h: 1 },
  ]]]);
  const boxes = imageBoxes(inline, viewport, OPS);
  assert.equal(boxes.length, 1);
  assert.ok(near(boxes[0], [10, 10, 130, 100]));
});

test('image: a solid color mask is the current unit square', () => {
  const op = list(['transform', [300, 0, 0, 200, 20, 20]], ['paintSolidColorImageMask', null]);
  assert.ok(near(imageBoxes(op, viewport, OPS)[0], [20, 20, 320, 220]));
});

test('image: tiny placements and full-page backgrounds are dropped', () => {
  assert.equal(imageBoxes(img([100, 0, 0, 100, 10, 10]), viewport, OPS).length, 1);
  assert.equal(imageBoxes(img([2, 0, 0, 2, 10, 10]), viewport, OPS).length, 0);
  assert.equal(imageBoxes(img([600, 0, 0, 800, 0, 0]), viewport, OPS).length, 0);
});

test('image: diagnostics explain why a placement was dropped', () => {
  const tiny = {};
  assert.equal(imageBoxes(img([2, 0, 0, 2, 10, 10]), viewport, OPS, tiny).length, 0);
  assert.equal(tiny.paints, 1);
  assert.equal(tiny.tiny, 1);
  const full = {};
  assert.equal(imageBoxes(img([600, 0, 0, 800, 0, 0]), viewport, OPS, full).length, 0);
  assert.equal(full.paints, 1);
  assert.equal(full.cover, 1);
  const kept = {};
  assert.equal(imageBoxes(img(), viewport, OPS, kept).length, 1);
  assert.deepEqual(kept, { paints: 1 });
});

// ---------------------------------------------------------------- vector drawings
test('vector: filled paths that are close together become one figure', () => {
  const op = list(...rect(100, 100, 80, 100), ...rect(185, 120, 90, 60));
  const boxes = vectorBoxes(op, viewport, OPS);
  assert.equal(boxes.length, 1);
  assert.ok(near(boxes[0], [100, 100, 275, 200]), JSON.stringify(boxes[0]));
});

test('vector: a paper-thin rule is not a drawing', () => {
  const rule = list(...rect(50, 100, 500, 1));
  assert.equal(vectorBoxes(rule, viewport, OPS).length, 0);
});

test('vector: a large outline is a frame, not a drawing', () => {
  const frame = list(...rect(20, 20, 560, 760, 'stroke'));
  assert.equal(vectorBoxes(frame, viewport, OPS).length, 0);
  // The same box, filled, is a panel and does propose.
  assert.equal(vectorBoxes(list(...rect(20, 20, 200, 200)), viewport, OPS).length, 1);
});

test('vector: a drawing smaller than the minimum is not proposed', () => {
  const small = list(...rect(10, 10, FIG_MIN - 2, FIG_MIN - 2, 'stroke'));
  assert.equal(vectorBoxes(small, viewport, OPS).length, 0);
});

test('vector: a path consumed by endPath or never painted is ignored; clip keeps it', () => {
  const discarded = list(['constructPath', [[OPS.rectangle], [100, 100, 100, 100], []]], ['endPath', null]);
  assert.equal(vectorBoxes(discarded, viewport, OPS).length, 0);

  const paintedAfterClip = list(
    ['constructPath', [[OPS.rectangle], [100, 100, 100, 100], []]],
    ['clip', null], ['fill', null],
  );
  assert.equal(vectorBoxes(paintedAfterClip, viewport, OPS).length, 1);
});

test('vector: a curve path bounds itself by its control points', () => {
  const curve = list(
    ['constructPath', [[OPS.moveTo, OPS.curveTo, OPS.lineTo], [100, 100, 150, 50, 250, 150, 300, 100, 300, 200], []]],
    ['stroke', null],
  );
  const boxes = vectorBoxes(curve, viewport, OPS);
  assert.equal(boxes.length, 1);
  assert.ok(near(boxes[0], [100, 50, 300, 200]), JSON.stringify(boxes[0]));
});

test('vector: a figure whose box is mostly text is rejected (table/decorated paragraph)', () => {
  const op = list(
    ['constructPath', [[OPS.rectangle], [100, 100, 200, 100], []]], ['fill', null],
    ['constructPath', [[OPS.rectangle], [110, 110, 180, 80], []]], ['fill', null],
  );
  const text = [[100, 100, 300, 200]];
  assert.equal(vectorBoxes(op, viewport, OPS, text).length, 0);
  // The same drawing with a small text label is still a figure.
  assert.equal(vectorBoxes(op, viewport, OPS, [[100, 100, 140, 120]]).length, 1);
});

test('vector: a drawing already proposed as a raster image is not proposed twice', () => {
  const op = list(['constructPath', [[OPS.rectangle], [100, 100, 200, 100], []]], ['fill', null]);
  assert.equal(vectorBoxes(op, viewport, OPS, [], [[98, 98, 302, 202]]).length, 0);
  assert.equal(vectorBoxes(op, viewport, OPS, [], [[400, 400, 500, 500]]).length, 1);
});

// ---------------------------------------------------------------- helpers
test('clusterBoxes: transitive chains merge, distant boxes stay apart', () => {
  const merged = clusterBoxes([[0, 0, 10, 10], [9, 0, 19, 10], [18, 0, 28, 10]], 0);
  assert.deepEqual(merged, [[0, 0, 28, 10]]);
  const apart = clusterBoxes([[0, 0, 10, 10], [10 + FIG_GAP + 1, 0, 30, 10]], FIG_GAP);
  assert.equal(apart.length, 2);
});

test('bboxOfPoints: polygons and multipolygons', () => {
  assert.deepEqual(bboxOfPoints([[10, 20], [30, 25], [15, 60]]), [10, 20, 30, 60]);
  assert.deepEqual(bboxOfPoints([[[10, 20], [30, 25]], [[0, 5], [5, 90]]]), [0, 5, 30, 90]);
});
