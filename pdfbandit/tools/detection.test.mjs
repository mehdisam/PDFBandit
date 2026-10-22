// Tests for the re-detection rules of spec 1.5 §21: provenance fingerprint, proposal
// matching, and cleanup eligibility. Run: npm test (node --test tools/).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectionFingerprint, bboxIoU, bboxContains, isUntouchedAuto, clearDetection,
  refreshDetectedType, pairProposals, unmatchedAutoIds, normalizeDetectedType,
} from '../src/model/detection.js';

const poly = (x0, y0, x1, y1) => ({ type: 'polygon', points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const box = (x0, y0, x1, y1) => [x0, y0, x1, y1];
function region(id, geom, extra = {}) {
  return { id, geometry: geom, content: { background: '#ffffff', items: [] }, ...extra };
}
function auto(id, geom, page = 1, extra = {}) {
  return region(id, geom, { detected: true, fingerprint: detectionFingerprint(page, geom), ...extra });
}

test('fingerprint is stable, noise-tolerant, and geometry/page-sensitive', () => {
  const g = poly(10, 20, 110, 60);
  assert.equal(detectionFingerprint(1, g), detectionFingerprint(1, g));
  // Sub-hundredth drift from rendering must not read as an edit.
  const noisy = poly(10.004, 20.004, 110.004, 60.004);
  assert.equal(detectionFingerprint(1, g), detectionFingerprint(1, noisy));
  // A real edit, a different page, or a multipolygon all change the hash.
  assert.notEqual(detectionFingerprint(1, g), detectionFingerprint(1, poly(10, 20, 111, 60)));
  assert.notEqual(detectionFingerprint(1, g), detectionFingerprint(2, g));
  const multi = { type: 'multipolygon', points: [poly(0, 0, 10, 10).points, poly(20, 20, 30, 30).points] };
  assert.notEqual(detectionFingerprint(1, g), detectionFingerprint(1, multi));
});

test('bbox IoU and containment', () => {
  assert.equal(bboxIoU(box(0, 0, 10, 10), box(0, 0, 10, 10)), 1);
  assert.equal(bboxIoU(box(0, 0, 10, 10), box(20, 20, 30, 30)), 0);
  // Half overlap: intersection 50, union 150.
  assert.ok(Math.abs(bboxIoU(box(0, 0, 10, 10), box(5, 0, 15, 10)) - 50 / 150) < 1e-9);
  assert.equal(bboxContains(box(0, 0, 100, 100), box(10, 10, 20, 20)), true);
  assert.equal(bboxContains(box(10, 10, 20, 20), box(0, 0, 100, 100)), false);
  assert.equal(bboxContains(box(0, 0, 10, 10), box(0, 0, 10, 10.005)), true, 'a hair of float noise still contains');
  assert.equal(bboxContains(box(0, 0, 10, 10), box(0, 0, 10, 11)), false);
});

test('pairProposals matches one-to-one by IoU or containment', () => {
  const regions = [region('a', poly(0, 0, 10, 10)), region('b', poly(100, 100, 110, 110))];
  // Proposal 0 sits exactly on 'a'; proposal 1 is mostly overlapping 'b' (IoU 70/130 >= 0.5).
  const proposals = [
    { bbox: box(0, 0, 10, 10), fingerprint: 'p0' },
    { bbox: box(103, 100, 113, 110), fingerprint: 'p1' },
  ];
  const matches = pairProposals(regions, proposals, 0.5);
  assert.equal(matches.get(0).j, 0);
  assert.equal(matches.get(1).j, 1);
});

test('pairProposals: containment matches regardless of IoU, but a real IoU wins', () => {
  // A tiny proposal inside a huge region: IoU is ~0, containment matches.
  const big = region('big', poly(0, 0, 1000, 1000));
  const only = pairProposals([big], [{ bbox: box(10, 10, 20, 20), fingerprint: 'p' }], 0.5);
  assert.ok(only.has(0));
  assert.equal(only.get(0).contain, true);
  // With an exact match available too, the exact match is preferred over the container.
  const exact = auto('exact', poly(10, 10, 20, 20));
  const both = pairProposals([big, exact], [{ bbox: box(10, 10, 20, 20), fingerprint: 'p' }], 0.5);
  assert.equal(both.get(0).j, 1, 'the exactly-matching region wins over the container');
});

test('pairProposals leaves a below-threshold proposal unmatched', () => {
  const regions = [region('a', poly(0, 0, 10, 10))];
  const matches = pairProposals(regions, [{ bbox: box(40, 40, 50, 50), fingerprint: 'p' }], 0.5);
  assert.equal(matches.size, 0);
  // The threshold is editable; a loose one can still match by containment-free IoU? Here the
  // boxes are disjoint, so even a low threshold cannot match.
  assert.equal(pairProposals(regions, [{ bbox: box(40, 40, 50, 50), fingerprint: 'p' }], 0.3).size, 0);
});

test('isUntouchedAuto needs matching provenance, no content and no lock', () => {
  const geom = poly(0, 0, 10, 10);
  const r = auto('a', geom);
  assert.equal(isUntouchedAuto(1, r), true);
  assert.equal(isUntouchedAuto(2, r), false, 'wrong page');
  assert.equal(isUntouchedAuto(1, { ...r, locked: true }), false, 'locked');
  assert.equal(isUntouchedAuto(1, { ...r, content: { items: [{ type: 'text' }] } }), false, 'has content');
  assert.equal(isUntouchedAuto(1, { ...auto('a', geom), detected: true, fingerprint: 'stale' }), false, 'edited geometry');
  assert.equal(isUntouchedAuto(1, region('a', geom)), false, 'never detected');
  // clearDetection removes the provenance entirely (additive: gone from the map), including
  // the detected class that rides with it.
  const c = auto('a', geom, 1, { detectedType: 'image' });
  clearDetection(c);
  assert.equal('detected' in c, false);
  assert.equal('fingerprint' in c, false);
  assert.equal('detectedType' in c, false);
});

test('detectedType is a small, validated vocabulary', () => {
  assert.equal(normalizeDetectedType('image'), 'image');
  assert.equal(normalizeDetectedType('heading'), 'heading');
  assert.equal(normalizeDetectedType('text'), 'text');
  assert.equal(normalizeDetectedType('IMAGE'), null, 'stored lower-case only');
  assert.equal(normalizeDetectedType('banana'), null);
  assert.equal(normalizeDetectedType(undefined), null);
});

test('an identical match refreshes a missing or stale detectedType', () => {
  const r = auto('a', poly(0, 0, 10, 10), 1, { detectedType: 'text' });
  assert.equal(refreshDetectedType(r, 'IMAGE'), true);
  assert.equal(r.detectedType, 'image');
  assert.equal(refreshDetectedType(r, 'IMAGE'), false, 'already current');
  assert.equal(isUntouchedAuto(1, r), true, 'class refresh leaves provenance untouched');

  const legacy = auto('b', poly(20, 20, 30, 30));
  assert.equal('detectedType' in legacy, false);
  assert.equal(refreshDetectedType(legacy, 'HEADING'), true);
  assert.equal(legacy.detectedType, 'heading');

  const manual = region('c', poly(40, 40, 50, 50));
  assert.equal(refreshDetectedType(manual, 'IMAGE'), false, 'a user region is never typed');
  assert.equal('detectedType' in manual, false);

  const bogus = auto('d', poly(60, 60, 70, 70));
  assert.equal(refreshDetectedType(bogus, 'banana'), false);
  assert.equal('detectedType' in bogus, false);
});

test('unmatchedAutoIds removes only unmatched, untouched autos', () => {
  const page = 1;
  const a = auto('a', poly(0, 0, 10, 10));
  const b = auto('b', poly(20, 20, 30, 30));
  const edited = auto('c', poly(40, 40, 50, 50));
  edited.geometry = poly(41, 41, 51, 51); // user moved it: stale fingerprint
  const manual = region('d', poly(60, 60, 70, 70));
  const withContent = auto('e', poly(80, 80, 90, 90));
  withContent.content.items.push({ type: 'text' });
  const matched = new Set(['a']);
  const removed = unmatchedAutoIds(page, [a, b, edited, manual, withContent], matched);
  assert.deepEqual(removed.sort(), ['b'], 'b is the only removable region');
});
