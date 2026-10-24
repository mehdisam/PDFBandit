// Detection provenance, matching and cleanup (spec 1.5 §21).
//
// Re-detection is propose-only: a proposal is matched to at most one existing region by the
// IoU of their bounding boxes, or by containment, and only the conflicts are reviewed. These
// helpers are pure so the load-bearing rules — the provenance fingerprint, the pairing, and
// which regions cleanup may remove — can be tested without the editor's state or its dialogs.
import { regionRings, regionBBox } from './geometry.js';
import { regionHasContent } from './region.js';

// Coordinates are hashed at hundredths of a PDF point, so float noise from rendering cannot
// make an unchanged polygon look edited, and an exact match is a byte-for-byte no-op.
export const DETECT_EPS = 0.01;

// A stable, synchronous hash (FNV-1a) of the page number and the polygon.
export function detectionFingerprint(page, geom) {
  const q = (v) => Math.round(Number(v) * 100) || 0;
  const rings = regionRings(geom).map(ring => ring.map(([x, y]) => [q(x), q(y)]));
  const canon = JSON.stringify({ page: Number(page), type: geom?.type === 'multipolygon' ? 'multipolygon' : 'polygon', rings });
  let h = 2166136261 >>> 0;
  for (let i = 0; i < canon.length; i++) h = Math.imul(h ^ canon.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function boxArea(b) { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }

export function bboxIoU(a, b) {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union = boxArea(a) + boxArea(b) - iw * ih;
  return union > 0 ? (iw * ih) / union : 0;
}

// Containment is a match condition regardless of IoU (spec §21 rule 1). A hair of tolerance
// keeps float noise on an exact edge from failing.
export function bboxContains(outer, inner, tol = DETECT_EPS) {
  return inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol
    && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol;
}

// An auto-detected region that is still exactly as the detector left it: provenance matches
// its current geometry, it holds no content and it is not locked. Only such a region may be
// replaced by default or removed by cleanup. A geometry edit makes the stored fingerprint
// stale, so the region counts as user involvement even before anything clears the flag.
export function isUntouchedAuto(page, r) {
  return !!r.detected && r.fingerprint === detectionFingerprint(page, r.geometry)
    && !r.locked && !regionHasContent(r);
}

export function clearDetection(region) {
  if (!region) return;
  delete region.detected;
  delete region.fingerprint;
  delete region.detectedType;
}

// An identical proposal (same fingerprint) still carries the detector's semantic class. A
// region detected before the class was recorded, or one the detector reclassified, is
// refreshed in place: the geometry, id and content stay exactly as they were. Returns true
// when the stored class changed, so the caller can make the refresh undoable and report it.
export function refreshDetectedType(region, proposalType) {
  if (!region?.detected) return false;
  const kind = normalizeDetectedType(String(proposalType || 'TEXT').toLowerCase());
  if (!kind || region.detectedType === kind) return false;
  region.detectedType = kind;
  return true;
}

// The semantic class a proposal had when it arrived. It is detection provenance, not a region
// property the user maintains (spec 1.5 §10a): written next to `detected`, dropped with it,
// never part of a content variant. HEADING and TEXT are both text for the user-facing badge;
// the detector's finer distinction is kept so the property panel can say which it was.
export const DETECTED_TYPES = ['heading', 'text', 'image'];
export function normalizeDetectedType(v) {
  return DETECTED_TYPES.includes(v) ? v : null;
}

// Pair proposals to existing regions, best score first, each used once. Ties break by
// proposal then region order, so a run is deterministic. A proposal (or region) left out is
// an add (or a cleanup candidate). `proposals` items need `bbox`; `regions` need `geometry`.
export function pairProposals(regions, proposals, threshold) {
  const pairs = [];
  for (let i = 0; i < proposals.length; i++) {
    const pbox = proposals[i].bbox;
    for (let j = 0; j < regions.length; j++) {
      const rbox = regionBBox(regions[j].geometry);
      const iou = bboxIoU(pbox, rbox);
      const contain = bboxContains(pbox, rbox) || bboxContains(rbox, pbox);
      if (iou >= threshold || contain) {
        // Containment is a strong signal but must never outrank a genuinely better IoU, so it
        // adds a fixed bonus rather than replacing the score.
        pairs.push({ i, j, iou, contain, score: iou + (contain ? 0.25 : 0) });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  const usedProposal = new Set(), usedRegion = new Set();
  const matches = new Map();
  for (const pair of pairs) {
    if (usedProposal.has(pair.i) || usedRegion.has(pair.j)) continue;
    usedProposal.add(pair.i); usedRegion.add(pair.j);
    matches.set(pair.i, pair);
  }
  return matches;
}

// The ids cleanup may remove: unmatched, still-untouched auto regions (spec §21 rule 5).
export function unmatchedAutoIds(page, regions, matchedIds) {
  return regions.filter(r => !matchedIds.has(r.id) && isUntouchedAuto(page, r)).map(r => r.id);
}
