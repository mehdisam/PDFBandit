// Pure operator-list scanning for tier-1 detection (spec 1.5 §10a): raster image placements
// (P1) and vector drawings (P2). This module imports nothing from pdf.js so it can be
// unit-tested in Node; the caller passes the OPS enum, a viewport-like object
// ({ width, height, convertToViewportPoint }) and the operator list ({ fnArray, argsArray }).
//
// Coordinates in and out are PDF points in the overlay's viewport space: top-left origin,
// exactly the space region polygons live in. The scan never mutates the operator list.

// Ignore tiny raster placements (pt): bullets, icons in text runs, pattern swatches.
export const IMG_MIN = 6;
// Ignore a placement that covers the page: a scanned background, a watermark.
export const IMG_MAX_COVER = 0.92;
// A page with more placements than this is a tiled pattern, not a set of figures.
const IMG_MAX_PER_PAGE = 64;
// A vector drawing must have both sides at least this long (pt) — rules, underlines,
// table borders and bullets all fail this before clustering.
export const FIG_MIN = 24;
// ...and cover at least this fraction of the page.
export const FIG_MIN_AREA_FRAC = 0.003;
// Paths closer than this (pt) belong to the same drawing (bars, axes, a logo's parts).
export const FIG_GAP = 8;
// A drawing whose bbox is mostly text is a table or a decorated paragraph, not a figure.
export const FIG_MAX_TEXT_COVER = 0.5;
// A raster image already covers this drawing: proposing it twice is noise.
export const FIG_DUP_IOU = 0.6;
// Pathological pages (vectorised text) can emit thousands of paths; keep the scan bounded.
const MAX_PATHS = 2000;
export const FIG_MAX_PER_PAGE = 24;
// A path thinner than this (pt) is a rule/underline, not a drawing.
const THIN = 1.5;

// ---------------------------------------------------------------- matrix helpers
// pdf.js `Util.transform` semantics: apply `n` first, then `m`.
function compose(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function boundsOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

// The unit square an image is painted into, mapped by a user-space matrix, then to viewport.
function unitBox(m, viewport) {
  const pts = [[0, 0], [1, 0], [1, 1], [0, 1]]
    .map(([x, y]) => apply(m, x, y))
    .map(([x, y]) => viewport.convertToViewportPoint(x, y));
  return boundsOf(pts);
}

// A [x0,y0,x1,y1] box in user space, mapped by the CTM, then to viewport. Corners are enough
// because every matrix pdf.js hands us here is affine; the box is axis-aligned afterwards.
function userBox(box, m, viewport) {
  const pts = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
    .map(([x, y]) => apply(m, x, y))
    .map(([x, y]) => viewport.convertToViewportPoint(x, y));
  return boundsOf(pts);
}

export function bboxOfPoints(points) {
  if (!Array.isArray(points) || !points.length) return null;
  // A polygon is [[x,y],…]; a multipolygon is [[[x,y],…],…]. Both end in point pairs.
  return boundsOf(Array.isArray(points[0][0]) ? points.flat(1) : points);
}

const boxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const unionBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const near = (a, b, gap) => a[0] - gap <= b[2] && a[2] + gap >= b[0] && a[1] - gap <= b[3] && a[3] + gap >= b[1];

function overlapArea(a, b) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return w * h;
}
function iou(a, b) {
  const i = overlapArea(a, b);
  const u = boxArea(a) + boxArea(b) - i;
  return u > 0 ? i / u : 0;
}
function contains(outer, inner) {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

// Merge boxes that touch or sit within `gap` of each other, transitively. One pass merges a
// chain into a single cluster; a few passes settle bridges. Deterministic and pure.
export function clusterBoxes(boxes, gap = 0) {
  let list = boxes.map(b => b.slice());
  let merged = true;
  while (merged) {
    merged = false;
    const next = [];
    for (const b of list) {
      let hit = -1;
      for (let i = 0; i < next.length; i++) if (near(next[i], b, gap)) { hit = i; break; }
      if (hit >= 0) { next[hit] = unionBox(next[hit], b); merged = true; }
      else next.push(b);
    }
    list = next;
  }
  return list;
}

// Walk the operator list once, tracking the CTM (save/restore, transform, form XObjects,
// transparency groups) and reporting every raster placement as a viewport box.
export function imageBoxes(opList, viewport, OPS, diag) {
  const { fnArray = [], argsArray = [] } = opList || {};
  const out = [];
  const pageArea = viewport.width * viewport.height;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const paint = (local) => {
    // Diagnostic counters for the "why did this page find no figures?" status note.
    if (diag) diag.paints = (diag.paints || 0) + 1;
    if (out.length >= IMG_MAX_PER_PAGE) { if (diag) diag.capped = (diag.capped || 0) + 1; return; }
    const m = local ? compose(ctm, local) : ctm;
    const box = unitBox(m, viewport);
    if (!box) { if (diag) diag.invalid = (diag.invalid || 0) + 1; return; }
    const w = box[2] - box[0], h = box[3] - box[1];
    if (w < IMG_MIN || h < IMG_MIN) { if (diag) diag.tiny = (diag.tiny || 0) + 1; return; }
    if (pageArea > 0 && (w * h) / pageArea > IMG_MAX_COVER) { if (diag) diag.cover = (diag.cover || 0) + 1; return; }
    out.push(box);
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    if (fn === OPS.save) { stack.push(ctm.slice()); continue; }
    if (fn === OPS.restore) { ctm = stack.pop() || ctm; continue; }
    if (fn === OPS.transform) { ctm = compose(ctm, a); continue; }
    if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm.slice());
      if (a && a[0]) ctm = compose(ctm, a[0]);
      continue;
    }
    if (fn === OPS.paintFormXObjectEnd) { ctm = stack.pop() || ctm; continue; }
    if (fn === OPS.beginGroup) {
      stack.push(ctm.slice());
      const g = a && a[0];
      if (g && g.matrix) ctm = compose(ctm, g.matrix);
      continue;
    }
    if (fn === OPS.endGroup) { ctm = stack.pop() || ctm; continue; }
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject
      || fn === OPS.paintImageMaskXObject || fn === OPS.paintSolidColorImageMask) {
      paint(null);
      continue;
    }
    // (save, transform, paintImageXObject, restore)+ collapsed by pdf.js's operator-list
    // optimizer: [objId, scaleX, scaleY, positions].
    if (fn === OPS.paintImageXObjectRepeat) {
      const [, sx, sy, positions] = a || [];
      for (let k = 0; positions && k + 1 < positions.length; k += 2) {
        paint([sx, 0, 0, sy, positions[k], positions[k + 1]]);
      }
      continue;
    }
    // Same optimization for masks: [maskParams, a, b, c, d, positions] — the four matrix
    // components are the original `transform` op, so they can include a skew.
    if (fn === OPS.paintImageMaskXObjectRepeat) {
      const [, ma, mb, mc, md, positions] = a || [];
      for (let k = 0; positions && k + 1 < positions.length; k += 2) {
        paint([ma, mb, mc, md, positions[k], positions[k + 1]]);
      }
      continue;
    }
    if (fn === OPS.paintImageMaskXObjectGroup) {
      for (const img of a?.[0] || []) if (img && img.transform) paint(img.transform);
      continue;
    }
    if (fn === OPS.paintInlineImageXObjectGroup) {
      for (const img of a?.[1] || []) if (img && img.transform) paint(img.transform);
    }
  }
  return out;
}

// ---------------------------------------------------------------- vector drawings
// The bounding box of one `constructPath` in user space. Curves contribute their control
// points, which bound the curve; that is conservative and exact enough for a figure box.
function pathBBox(fns, args, OPS) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let cx = 0, cy = 0, u = 0;
  const add = (x, y) => {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  };
  for (const fn of fns || []) {
    if (fn === OPS.rectangle) {
      const x = args[u++], y = args[u++], w = args[u++], h = args[u++];
      add(x, y); add(x + w, y + h); cx = x; cy = y;
    } else if (fn === OPS.moveTo || fn === OPS.lineTo) {
      const x = args[u++], y = args[u++];
      add(x, y); cx = x; cy = y;
    } else if (fn === OPS.curveTo) {
      const x1c = args[u++], y1c = args[u++], x2c = args[u++], y2c = args[u++];
      add(cx, cy); add(x1c, y1c); add(x2c, y2c);
      cx = args[u++]; cy = args[u++]; add(cx, cy);
    } else if (fn === OPS.curveTo2 || fn === OPS.curveTo3) {
      const x1c = args[u++], y1c = args[u++];
      add(cx, cy); add(x1c, y1c);
      cx = args[u++]; cy = args[u++]; add(cx, cy);
    }
    // closePath carries no coordinates.
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

// Every path that is actually painted (filled or stroked), as `{ box, filled }` in viewport
// space. A path is accumulated from one or more constructPath ops and consumed by
// fill/stroke; `clip` keeps it alive because `W f` paints the same path, while `endPath`
// discards it. `filled` distinguishes an area from a mere outline (a frame is not a figure).
function paintedPathBoxes(opList, viewport, OPS) {
  const { fnArray = [], argsArray = [] } = opList || {};
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let pending = [];
  const commit = () => {
    for (const p of pending) if (p) out.push(p);
    pending = [];
  };
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke]);
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = compose(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); if (a && a[0]) ctm = compose(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.beginGroup) { stack.push(ctm.slice()); const g = a && a[0]; if (g && g.matrix) ctm = compose(ctm, g.matrix); }
    else if (fn === OPS.endGroup) ctm = stack.pop() || ctm;
    // A path is fixed in device space the moment it is constructed: a `cm` between the path
    // and its paint must not move it.
    else if (fn === OPS.constructPath) {
      const b = pathBBox(a?.[0], a?.[1], OPS);
      pending.push(b ? { box: userBox(b, ctm, viewport), filled: false } : null);
    }
    else if (fillOps.has(fn)) { for (const p of pending) if (p) p.filled = true; commit(); }
    else if (strokeOps.has(fn)) commit();
    else if (fn === OPS.endPath) pending = [];
    // clip/eoClip intentionally keep the path pending.
  }
  return out.filter(Boolean);
}

// Vector figure proposals: painted paths, minus paper-thin rules, clustered into drawings
// and filtered against text and raster images. Returns viewport boxes, unpadded.
export function vectorBoxes(opList, viewport, OPS, textBoxes = [], images = []) {
  const pageArea = viewport.width * viewport.height;
  const paths = [];
  for (const p of paintedPathBoxes(opList, viewport, OPS)) {
    const b = p.box;
    const w = b[2] - b[0], h = b[3] - b[1];
    if (Math.min(w, h) < THIN) continue;
    // A large outline is a page frame or a panel border, not a drawing. Filled areas of the
    // same size are backgrounds and are caught by the cover test below.
    if (!p.filled && (w > viewport.width * 0.5 || h > viewport.height * 0.5)) continue;
    paths.push(b);
    if (paths.length >= MAX_PATHS) break;
  }
  if (!paths.length) return [];

  const out = [];
  for (const box of clusterBoxes(paths, FIG_GAP)) {
    const w = box[2] - box[0], h = box[3] - box[1];
    if (w < FIG_MIN || h < FIG_MIN) continue;
    const cover = pageArea > 0 ? (w * h) / pageArea : 0;
    if (cover < FIG_MIN_AREA_FRAC || cover > IMG_MAX_COVER) continue;
    // A full-width short band is a header/footer rule or a highlight, not a figure.
    if (w > viewport.width * 0.85 && h < viewport.height * 0.08) continue;
    // A drawing whose box is mostly covered by text is a table or a decorated paragraph.
    let text = 0;
    for (const t of textBoxes) text += overlapArea(box, t);
    if (boxArea(box) > 0 && text / boxArea(box) > FIG_MAX_TEXT_COVER) continue;
    // Already found as a raster image (an image drawn inside a form, say).
    if (images.some(img => iou(box, img) >= FIG_DUP_IOU || contains(img, box) || contains(box, img))) continue;
    out.push(box);
    if (out.length >= FIG_MAX_PER_PAGE) break;
  }
  return out;
}
