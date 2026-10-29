// polygon-clipping Web Worker client — handles heavy polygon operations off main thread
import {
  unionRings as unionRingsAsync,
  unionPolygons as unionPolygonsAsync,
  intersectPolygons as intersectPolygonsAsync,
  splitPolygonByLine as splitPolygonByLineAsync
} from './workers/polygon-clipping.client.js';

// Synchronous fallbacks for simple operations
function ring(pts) {
  const r = pts.map(p => [p[0], p[1]]);
  const f = r[0], l = r[r.length-1];
  if (f[0] !== l[0] || f[1] !== l[1]) r.push([f[0], f[1]]);
  return r;
}

const fromGeom = (geom) => {
  if (!geom || !geom.length) return null;
  let best = null, bestA = -1;
  for (const poly of geom) {
    const outer = poly[0];
    let a = 0;
    for (let i=0;i<outer.length;i++){ const [x1,y1]=outer[i],[x2,y2]=outer[(i+1)%outer.length]; a+=x1*y2-x2*y1; }
    a = Math.abs(a/2);
    if (a > bestA) { bestA = a; best = outer; }
  }
  if (!best) return null;
  const last = best[best.length-1], first = best[0];
  if (last[0]===first[0] && last[1]===first[1]) best = best.slice(0,-1);
  return best.map(p=>[p[0],p[1]]);
};

// Union of a list of rings, returning **every** outer ring of the result (one per
// disconnected part, holes ignored). A single-element result means the inputs form
// one connected area; more than one means they don't touch (see mergeSelected).
export async function unionRings(list) {
  const ringsIn = (list || []).filter(pts => Array.isArray(pts) && pts.length >= 3);
  if (!ringsIn.length) return [];
  try {
    return await unionRingsAsync(ringsIn);
  } catch (e) {
    console.warn('Worker unionRings failed, falling back:', e);
    return ringsIn; // fallback: return input
  }
}

export async function unionPolygons(aPts, bPts) {
  try {
    return await unionPolygonsAsync(aPts, bPts);
  } catch (e) {
    console.warn('Worker unionPolygons failed, falling back:', e);
    return null;
  }
}

export async function intersectPolygons(aPts, bPts) {
  try {
    return await intersectPolygonsAsync(aPts, bPts);
  } catch (e) {
    console.warn('Worker intersectPolygons failed, falling back:', e);
    return null;
  }
}

// Split polygon `pts` by line AB: build two large half-plane rects, intersect each.
export async function splitPolygonByLine(pts, A, B) {
  try {
    return await splitPolygonByLineAsync(pts, A, B);
  } catch (e) {
    console.warn('Worker splitPolygonByLine failed, falling back:', e);
    return null;
  }
}

// Synchronous fallbacks for simple operations (when polygons are simple)
export function unionRingsSync(list) {
  const ringsIn = (list || []).filter(pts => Array.isArray(pts) && pts.length >= 3);
  if (!ringsIn.length) return [];
  return ringsIn; // fallback: return input
}

export function unionPolygonsSync(aPts, bPts) {
  // Simple bounding box check for non-overlapping
  const bbox = (pts) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  };
  
  const bboxA = bbox(aPts);
  const bboxB = bbox(bPts);
  
  // Quick reject if bounding boxes don't overlap
  if (bboxA.maxX <= bboxB.minX || bboxB.maxX <= bboxA.minX ||
      bboxA.maxY <= bboxB.minY || bboxB.maxY <= bboxA.minY) {
    return null;
  }
  
  // Fallback to async for actual clipping
  return unionPolygonsAsync(aPts, bPts);
}

export function intersectPolygonsSync(aPts, bPts) {
  return intersectPolygonsAsync(aPts, bPts);
}

export function splitPolygonByLineSync(pts, A, B) {
  return splitPolygonByLineAsync(pts, A, B);
}

// ---- outward offset ("grow") of a region ------------------------------------------
// Grow a region outward by `p` points. Used to give a **detected** region the configured
// text-box padding (spec §7, `detectPoints` in main.js): the polygon gains a margin around
// the detected text — and so does its mask — while the box that will replace the text is
// the interior inset by that same padding. Growing the polygon instead of shrinking the box
// is what keeps that margin from being taken out of the text.
//
// The offset is a miter offset, which is exact and keeps corners sharp (a grown rectangle
// is still a rectangle — a dilated-copy union would leave a staircase of extra vertices
// behind). Miter offsets can fold on concave features narrower than the padding, so the
// result is validated and a fold falls back to dilating with a 16-gon; anything still
// surprising declines and the region keeps its geometry.

// A very sharp spike must not launch its vertex off to infinity.
const MITER_LIMIT = 4;
// Directions of the fallback dilation disc (16-gon, axis directions included).
const GROW_DIRS = Array.from({ length: 16 }, (_, i) => {
  const a = (i * Math.PI) / 8;
  return [Math.cos(a), Math.sin(a)];
});
const EPS = 1e-9;

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// Offset one ring outward by `p` with miter joins: each vertex moves along the bisector of
// its two edges, so both offset edges stay exactly `p` from the originals. Straight runs
// and right angles stay straight, and a concave vertex moves into the notch, as it should.
// Coordinates are y-down, so the sign of the area says which side is outward.
function miterRing(pts, p) {
  const n = pts.length;
  const s = signedArea(pts) >= 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const e1 = [cur[0] - prev[0], cur[1] - prev[1]];
    const e2 = [next[0] - cur[0], next[1] - cur[1]];
    const l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1]);
    if (l1 < EPS || l2 < EPS) { out.push([cur[0], cur[1]]); continue; }
    const n1 = [(e1[1] / l1) * s, (-e1[0] / l1) * s];
    const n2 = [(e2[1] / l2) * s, (-e2[0] / l2) * s];
    const bx = n1[0] + n2[0], by = n1[1] + n2[1];
    const bl = Math.hypot(bx, by);
    // A 180-degree turn has no bisector: step out along the incoming edge's normal.
    if (bl < EPS) { out.push([cur[0] + n1[0] * p, cur[1] + n1[1] * p]); continue; }
    const ux = bx / bl, uy = by / bl;
    const cos = ux * n1[0] + uy * n1[1];
    const m = cos > 1e-6 ? Math.min(1 / cos, MITER_LIMIT) : MITER_LIMIT;
    out.push([cur[0] + ux * p * m, cur[1] + uy * p * m]);
  }
  return out;
}

function segmentsCross(a, b, c, d) {
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const onSpan = (p, q, r) => Math.min(p[0], r[0]) - EPS <= q[0] && q[0] <= Math.max(p[0], r[0]) + EPS
    && Math.min(p[1], r[1]) - EPS <= q[1] && q[1] <= Math.max(p[1], r[1]) + EPS;
  const o1 = side(a, b, c), o2 = side(a, b, d), o3 = side(c, d, a), o4 = side(c, d, b);
  if (o1 && o2 && o3 && o4 && o1 !== o2 && o3 !== o4) return true;
  if (!o1 && onSpan(a, c, b)) return true;
  if (!o2 && onSpan(a, d, b)) return true;
  if (!o3 && onSpan(c, a, d)) return true;
  if (!o4 && onSpan(c, b, d)) return true;
  return false;
}
// No edge of the ring may cross another (shared endpoints don't count).
function ringIsSimple(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

// Returns the input array unchanged when it declines (p <= 0, a folded offset that the
// dilation could not rescue, or a dilation that would change how many parts the region
// has), so callers can test `grown !== ret` for identity.
export function growRings(rings, p) {
  const list = (rings || []).filter(r => Array.isArray(r) && r.length >= 3);
  if (!list.length || !(p > 0)) return rings;
  const miter = list.map(r => miterRing(r, p));
  // Keep the exact offset only while it is a sane polygon that really did grow.
  if (miter.every((r, i) => ringIsSimple(r) && Math.abs(signedArea(r)) > Math.abs(signedArea(list[i])))) return miter;
  const parts = [];
  for (const ring of list) {
    parts.push(ring);
    for (const [dx, dy] of GROW_DIRS) parts.push(ring.map(([x, y]) => [x + dx * p, y + dy * p]));
  }
  let out;
  try { out = unionRings(parts); } catch { return rings; }
  // Never split a region into more parts than it had (or drop one): a surprising result
  // is worse than no growth at all.
  if (out.length !== list.length) return rings;
  return out;
}
