// Pure geometry helpers. Coordinates: PDF points, origin TOP-LEFT (viewer space at scale 1).
export function bboxOf(points) {
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const [x,y] of points) { x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); }
  return [x0,y0,x1,y1];
}
export function areaOf(points) {
  let a = 0;
  for (let i=0;i<points.length;i++) {
    const [x1,y1]=points[i], [x2,y2]=points[(i+1)%points.length];
    a += x1*y2 - x2*y1;
  }
  return Math.abs(a/2);
}
export function pointInPolygon(pt, poly) {
  const [x,y]=pt; let inside=false;
  for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
    const [xi,yi]=poly[i],[xj,yj]=poly[j];
    if (((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
// distance point->segment
export function distToSeg(p,a,b) {
  const dx=b[0]-a[0], dy=b[1]-a[1];
  const L2=dx*dx+dy*dy || 1;
  let t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L2;
  t=Math.max(0,Math.min(1,t));
  const cx=a[0]+t*dx, cy=a[1]+t*dy;
  return Math.hypot(p[0]-cx,p[1]-cy);
}
export function polygonIsValid(points) {
  return Array.isArray(points) && points.length >= 3 && areaOf(points) > 1;
}

// Do two segments properly cross? (A shared endpoint, a touch or a collinear overlap is not a
// crossing — good enough next to the point probes below, and it keeps a box flush with a
// polygon edge from counting as a cut.)
function segsCross(p, q, a, b) {
  const side = (u, v, w) => Math.sign((v[0]-u[0])*(w[1]-u[1]) - (v[1]-u[1])*(w[0]-u[0]));
  const d1 = side(a, b, p), d2 = side(a, b, q), d3 = side(p, q, a), d4 = side(p, q, b);
  return d1 !== d2 && d3 !== d4;
}
// Does any edge of `ring` cut through the rectangle, or sit inside it? An edge that only
// passes through the tolerance margin around the rectangle does not count: `rectInsideRings`
// insets by that margin before asking.
function ringCrossesRect(ring, x0, y0, x1, y1) {
  const within = (p) => p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (within(a) || within(b)) return true;
    for (let k = 0; k < 4; k++) if (segsCross(a, b, corners[k], corners[(k + 1) % 4])) return true;
  }
  return false;
}
// Is an axis-aligned rectangle [x, y, w, h] entirely inside the region's polygons? The rings
// of a multipolygon are disjoint parts (see regionRings), so "inside" means inside a single
// one of them. `tol` is how far the rectangle may overhang and still count as inside: the test
// runs on the rectangle inset by it, so a box sitting flush on a polygon edge is fine (float
// noise on the boundary decides nothing), while a real overhang is reported.
export function rectInsideRings(rings, rect, tol = 0) {
  const cx = rect[0] + rect[2] / 2, cy = rect[1] + rect[3] / 2;
  const x0 = Math.min(rect[0], rect[0] + rect[2]) + tol;
  const y0 = Math.min(rect[1], rect[1] + rect[3]) + tol;
  const x1 = Math.max(rect[0], rect[0] + rect[2]) - tol;
  const y1 = Math.max(rect[1], rect[1] + rect[3]) - tol;
  // A box too small to inset falls back to its centre point.
  const probes = x1 > x0 && y1 > y0
    ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2]]
    : [[cx, cy]];
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    // Every probe inside this part *and* none of its edges cutting through: for a simple ring
    // that pair means the whole rectangle is inside (the centre probe catches a concave notch
    // that dips in and back out, which the corners alone would miss).
    if (!probes.every(p => pointInPolygon(p, ring))) continue;
    if (!ringCrossesRect(ring, x0, y0, x1, y1)) return true;
  }
  return false;
}

// ---- multi-part region geometry -------------------------------------------------
// A region geometry is either { type:'polygon', points:[ [x,y], ... ] } or, after
// merging regions that don't touch, { type:'multipolygon', points:[ ring, ring, ... ] }.
// These helpers hide the difference from the rest of the app.
export function regionRings(geom) {
  if (!geom || !Array.isArray(geom.points) || !geom.points.length) return [];
  return geom.type === 'multipolygon' ? geom.points : [geom.points];
}
export function regionPoints(geom) {
  const out = [];
  for (const ring of regionRings(geom)) for (const p of ring) out.push(p);
  return out;
}
export function ringsBBox(rings) {
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const ring of rings) for (const [x,y] of ring) { x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); }
  return [x0,y0,x1,y1];
}
export function regionBBox(geom) { return ringsBBox(regionRings(geom)); }
// Rebuild a geometry of the same kind with new rings (a single-part region stays a
// polygon; a multi-part one stays a multipolygon).
export function geometryWithRings(geom, rings) {
  if (geom && geom.type === 'multipolygon') return { ...geom, points: rings };
  return { ...geom, type: 'polygon', points: rings[0] };
}
