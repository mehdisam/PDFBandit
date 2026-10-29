// Polygon Clipping Web Worker
// Handles heavy polygon operations off the main thread

// Lazily load polygon-clipping so the worker loads even if the package is absent.
let pc = null;
let pcLoaded = false;
async function loadPc() {
  if (pcLoaded) return pc;
  pcLoaded = true;
  try {
    const mod = await import('polygon-clipping');
    pc = (mod && mod.union) ? mod : (mod?.default ?? mod);
  } catch { pc = null; }
  return pc;
}

// Helpers
const ringFn = (pts) => {
  const r = pts.map(p => [p[0], p[1]]);
  const f = r[0], l = r[r.length-1];
  if (f[0] !== l[0] || f[1] !== l[1]) r.push([f[0], f[1]]);
  return r;
};

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

async function unionRings(rings) {
  const ringsIn = (rings || []).filter(pts => Array.isArray(pts) && pts.length >= 3);
  if (!ringsIn.length) return [];
  await loadPc();
  if (!pc) return ringsIn; // package absent: return input unchanged
  const out = pc.union(...ringsIn.map(pts => [[[ ...ringFn(pts) ]]]));
  if (!out || !out.length) return [];
  return out.map(poly => {
    const r = poly[0].slice();
    const first = r[0], last = r[r.length-1];
    if (r.length > 1 && last[0]===first[0] && last[1]===first[1]) r.pop();
    return r.map(p=>[p[0],p[1]]);
  }).filter(r => r.length >= 3);
}

async function intersection(aPts, bPts) {
  await loadPc();
  if (!pc) return fromGeom([[[...ringFn(aPts)]]]); // fallback: just return A
  const out = pc.intersection([[[...ringFn(aPts)]]], [[[ ...ringFn(bPts) ]]]);
  return fromGeom(out);
}

// Message handler
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  
  try {
    let result;
    
    switch (type) {
      case 'unionRings':
        result = await unionRings(payload.rings);
        break;
      case 'unionPolygons':
        result = await unionPolygons(payload.a, payload.b);
        break;
      case 'intersectPolygons':
        result = await intersection(payload.a, payload.b);
        break;
      case 'splitPolygonByLine':
        result = await splitPolygonByLine(payload.pts, payload.A, payload.B);
        break;
      case 'differencePolygons':
        result = await differencePolygons(payload.a, payload.b);
        break;
      default:
        throw new Error(`Unknown operation: ${type}`);
    }
    
    self.postMessage({ id, result, error: null });
  } catch (error) {
    self.postMessage({ id, result: null, error: error.message });
  }
};

async function unionPolygons(aPts, bPts) {
  const rings = await unionRings([aPts, bPts]);
  if (rings.length <= 1) return rings[0] || null;
  let best = null, bestA = -1;
  for (const r of rings) {
    let a = 0;
    for (let i=0;i<r.length;i++){ const [x1,y1]=r[i],[x2,y2]=r[(i+1)%r.length]; a+=x1*y2-x2*y1; }
    a = Math.abs(a/2);
    if (a > bestA) { bestA = a; best = r; }
  }
  return best;
}

async function differencePolygons(aPts, bPts) {
  await loadPc();
  if (!pc) return fromGeom([[[...ringFn(aPts)]]]); // fallback: just return A
  const out = pc.difference([[[...ringFn(aPts)]]], [[[ ...ringFn(bPts) ]]]);
  return fromGeom(out);
}

async function splitPolygonByLine(pts, A, B) {
  await loadPc();
  if (!pc) return { left: ringFn(pts), right: null }; // fallback: whole polygon to left
  const dx = B[0]-A[0], dy = B[1]-A[1];
  const len = Math.hypot(dx,dy) || 1;
  const nx = -dy/len, ny = dx/len; // left normal
  const M = 1e5;
  const left = [
    [A[0]+nx*M, A[1]+ny*M],[B[0]+nx*M, B[1]+ny*M],
    [B[0]-nx*M, B[1]-ny*M],[A[0]-nx*M, A[1]-ny*M],
  ];
  const leftHalfPlane = pc.intersection([[[...ringFn(pts)]]], [[left]]);
  const rightHalfPlane = pc.difference([[[...ringFn(pts)]]], [[left]]);
  return {
    left: fromGeom(leftHalfPlane),
    right: fromGeom(rightHalfPlane)
  };
}
