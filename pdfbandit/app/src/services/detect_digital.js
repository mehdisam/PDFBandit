// Tier-1 region detection for digital (text-based) PDFs (spec §10a / rev 1.5 §19).
// Outputs proposals as 4-point polygons in PDF points (top-left origin, matching the
// page.viewport({scale:1}) coordinate space used by the overlay). Text comes from the text
// layer; figures come from the operator list (raster placements and vector drawings, see
// detect_ops.js) and are already unpadded.
import * as pdfjs from 'pdfjs-dist';
import { bboxOfPoints, imageBoxes, vectorBoxes } from './detect_ops.js';

const OPS = pdfjs.OPS;

const MIN_BOX = 2;            // drop degenerate text runs smaller than this (pt)
const PAD = 1.5;              // padding around a detected text block (pt)
const HEADING_RATIO = 1.35;   // block font vs page median => heading

// Two independent passes over the same page: text comes from the text layer, figures from
// the operator list — every raster placement (P1) and every painted vector drawing (P2).
// An IMAGE proposal is never padded: the padding is for replacement text (spec §10a).
export async function detectPageRegions(page, viewport) {
  const regions = [];
  const notes = [];
  const text = [];
  try {
    const content = await page.getTextContent();
    text.push(...textRegions(content, viewport));
    regions.push(...text);
  } catch { /* no text layer */ }

  let opList = null;
  try { opList = await page.getOperatorList(); } catch (e) {
    // Do not let a failed operator-list read masquerade as "this page has no figures":
    // report it to the caller (the status bar) and to the console.
    notes.push(`figure scan unavailable (${(e && e.message) || e})`);
    try { console.warn('detectPageRegions: getOperatorList failed', e); } catch {}
  }
  if (!opList) return { regions, notes };

  const imageStats = { paints: 0, tiny: 0, cover: 0, invalid: 0, capped: 0 };
  const images = imageBoxes(opList, viewport, OPS, imageStats);
  const textBoxes = text.map(r => bboxOfPoints(r.points)).filter(Boolean);
  const figures = vectorBoxes(opList, viewport, OPS, textBoxes, images);
  for (const b of images) regions.push({ type: 'IMAGE', points: boxPoints(b, viewport) });
  for (const b of figures) regions.push({ type: 'IMAGE', points: boxPoints(b, viewport) });
  if (!images.length && !figures.length) notes.push(noFiguresNote(viewport, opList, imageStats));
  return { regions, notes };
}

// When a digital page yields no figure proposals, say what the scanner saw, so "0 image"
// in the run summary can be told apart from a failed read or a filtered full-page scan.
function noFiguresNote(viewport, opList, s) {
  const reasons = [];
  if (s.cover) reasons.push(`${s.cover} dropped as full-page background`);
  if (s.tiny) reasons.push(`${s.tiny} too small`);
  if (s.invalid) reasons.push(`${s.invalid} unplaceable`);
  if (s.capped) reasons.push(`${s.capped} over the per-page cap`);
  const paints = s.paints ? `${s.paints} image paint${s.paints === 1 ? '' : 's'}` : 'no image paint ops';
  return `no figures found (${Math.round(viewport.width)}×${Math.round(viewport.height)} pt, ${opList.fnArray.length} draw ops, ${paints}${reasons.length ? ': ' + reasons.join(', ') : ''})`;
}

// ---------------------------------------------------------------- text blocks
function itemBox(it, viewport) {
  const tr = it.transform;
  const fs = Math.hypot(tr[0], tr[1]) || Math.hypot(tr[2], tr[3]);
  if (!fs || !it.width) return null;
  const adv = it.width;                       // advance width already in user space
  const x = tr[4], y = tr[5];
  const p = (ux, uy) => viewport.convertToViewportPoint(ux, uy);
  const quad = [p(x, y), p(x + adv, y), p(x + adv, y + fs), p(x, y + fs)];
  const xs = quad.map(q => q[0]), ys = quad.map(q => q[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 - x0 < MIN_BOX || y1 - y0 < MIN_BOX) return null;
  return { x0, y0, x1, y1, font: fs, baseY: p(x, y)[1], text: it.str };
}

function textRegions(textContent, viewport) {
  const boxes = textContent.items
    .filter(it => it.str && it.str.trim().length)
    .map(it => itemBox(it, viewport))
    .filter(Boolean);
  if (!boxes.length) return [];

  // 1. cluster glyph boxes into lines by baseline
  boxes.sort((a, b) => a.baseY - b.baseY || a.x0 - b.x0);
  const lines = [];
  for (const b of boxes) {
    const line = lines.find(l => Math.abs(l.baseY - b.baseY) <= Math.max(MIN_BOX, b.font * 0.5));
    if (line) { line.items.push(b); line.baseY = line.items.reduce((s, q) => s + q.baseY, 0) / line.items.length; }
    else lines.push({ baseY: b.baseY, items: [b] });
  }

  // 2. split each line into runs on large horizontal gaps (separate columns/cells)
  const runs = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x0 - b.x0);
    let run = [line.items[0]];
    for (let i = 1; i < line.items.length; i++) {
      const prev = line.items[i - 1], cur = line.items[i];
      if (cur.x0 - prev.x1 > Math.max(12, cur.font * 1.5)) { runs.push(mergeRun(run)); run = [cur]; }
      else run.push(cur);
    }
    runs.push(mergeRun(run));
  }

  // 3. merge runs into blocks (stacked, horizontally overlapping)
  runs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const blocks = [];
  for (const r of runs) {
    let placed = false;
    for (const blk of blocks) {
      const vgap = r.y0 - blk.y1;
      const hOverlap = Math.min(blk.x1, r.x1) - Math.max(blk.x0, r.x0);
      const minW = Math.min(blk.x1 - blk.x0, r.x1 - r.x0);
      if (vgap >= -MIN_BOX && vgap < r.font * 0.9 && hOverlap > minW * 0.25) {
        blk.x0 = Math.min(blk.x0, r.x0); blk.y0 = Math.min(blk.y0, r.y0);
        blk.x1 = Math.max(blk.x1, r.x1); blk.y1 = Math.max(blk.y1, r.y1);
        blk.font = Math.max(blk.font, r.font); blk.lines += 1;
        placed = true; break;
      }
    }
    if (!placed) blocks.push({ ...r, lines: 1 });
  }

  const median = medianOf(boxes.map(b => b.font));
  return blocks.map(b => ({
    type: (b.font >= median * HEADING_RATIO && b.lines <= 2) ? 'HEADING' : 'TEXT',
    points: rectPoints(b, viewport),
  }));
}

function mergeRun(items) {
  return {
    x0: Math.min(...items.map(q => q.x0)), y0: Math.min(...items.map(q => q.y0)),
    x1: Math.max(...items.map(q => q.x1)), y1: Math.max(...items.map(q => q.y1)),
    font: items.reduce((a, q) => Math.max(a, q.font), 0),
  };
}
function medianOf(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function rectPoints(b, viewport) {
  const W = viewport.width, H = viewport.height;
  const x0 = clamp(b.x0 - PAD, 0, W), y0 = clamp(b.y0 - PAD, 0, H);
  const x1 = clamp(b.x1 + PAD, 0, W), y1 = clamp(b.y1 + PAD, 0, H);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}
// An image box, unpadded and clipped to the page, as a 4-point polygon in the viewport.
function boxPoints(b, viewport) {
  const x0 = clamp(b[0], 0, viewport.width), y0 = clamp(b[1], 0, viewport.height);
  const x1 = clamp(b[2], 0, viewport.width), y1 = clamp(b[3], 0, viewport.height);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
