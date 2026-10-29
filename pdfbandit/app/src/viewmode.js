// Preview mode: mask originals, render the loaded map's content items clipped inside
// their region polygons (spec §7/§9a). No language switching — one map, one rendering.
import { regionRings, regionPoints } from './model/geometry.js';
import { itemAbsBox, charStyles, normalizeColor, DEFAULT_BACKGROUND, DEFAULT_LINE_HEIGHT, itemBlocks, regionIsMasked } from './model/region.js';
import { flowBase } from './model/blocks.js';

// Trace one ring; `multi` only closes sub-paths so several rings can be filled/clipped
// as one shape (a multi-part region after merging non-touching regions).
function pathPoly(ctx, pts, scale, multi = false) {
  if (!multi) ctx.beginPath();
  pts.forEach(([x, y], i) => { const sx = x * scale, sy = y * scale; i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
  ctx.closePath();
}
function pathRings(ctx, rings, scale) {
  ctx.beginPath();
  for (const ring of rings) pathPoly(ctx, ring, scale, true);
}

// Decoded images, keyed by source. A data URL must not be decoded on every render:
// Edit mode repaints this canvas whenever the selection or content changes.
const imageCache = new Map();
function cachedImage(src) {
  let img = imageCache.get(src);
  if (!img) { img = new Image(); imageCache.set(src, img); }
  return img;
}

// Render view overlay canvas (same CSS size as base canvas) at given scale (= zoom).
// `maskExcept` is a set of region ids that are drawn without their background mask even
// when `mask` is true — Edit mode uses it for the region currently being edited, so the
// source PDF stays visible under the cursor while every other region already looks the
// way Preview mode and the export will render it.
export function renderView({ viewCanvas, baseCanvas, regions, zoom, overflowMark = true, mask = true, maskExcept = null, alpha = 1 }) {
  const w = Math.round(baseCanvas.clientWidth), h = Math.round(baseCanvas.clientHeight);
  viewCanvas.style.width = `${w}px`; viewCanvas.style.height = `${h}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewCanvas.width = Math.round(w * dpr); viewCanvas.height = Math.round(h * dpr);
  const ctx = viewCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const s = zoom; // pdf-pt -> css px
  for (const r of regions) {
    const items = r.content?.items || [];
    // Mask when there is something to draw: items *or* a non-default background colour.
    // An all-default, empty region stays transparent and the original shows through.
    if (!regionIsMasked(r)) continue;
    const useMask = mask && !(maskExcept && maskExcept.has(r.id));
    const rings = regionRings(r.geometry);
    const pts = regionPoints(r.geometry);
    // 1. mask original (tinted by `alpha`), clipped to the polygon
    if (useMask) {
      ctx.save();
      pathRings(ctx, rings, s);
      ctx.fillStyle = normalizeColor(r.content?.background, DEFAULT_BACKGROUND);
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.restore();
    }
    // 2. draw replacement items clipped to the polygon
    ctx.save();
    pathRings(ctx, rings, s);
    ctx.clip();
    for (const item of items) {
      const [ax, ay, aw, ah] = itemAbsBox(pts, item);
      const bx = ax * s, by = ay * s, bw = aw * s, bh = ah * s;
      if (bw < 2 || bh < 2) continue;
      if (item.type === 'image') drawItemImage(ctx, rings, s, bx, by, bw, bh, item, baseCanvas);
      else drawItemText(ctx, bx, by, bw, bh, item, s, overflowMark);
    }
    ctx.restore();
    // No region border: Preview mode must show exactly what the export produces (the
    // mask + the replacement items, nothing else). In Edit mode the polygon outline
    // is the SVG overlay's job — this canvas only ever paints region *content*.
  }
}

function fontOf(c, scale) {
  const fam = c.font === 'serif' ? 'serif' : c.font === 'mono' ? 'monospace' : 'sans-serif';
  const px = (Number(c.size) || 12) * scale;
  return `${c.italic ? 'italic ' : ''}${c.bold ? 'bold ' : ''}${px}px ${fam}`;
}

// Character-accurate word wrap honoring per-run fonts and sizes.
function layoutLines(ctx, v, cs, scale, maxW) {
  const lines = [];
  if (!v.length) return lines;
  const widths = new Array(v.length);
  for (let i = 0; i < v.length; i++) { ctx.font = fontOf(cs[i], scale); widths[i] = ctx.measureText(v[i]).width; }
  let start = 0;
  while (start < v.length) {
    if (v[start] === '\n') { lines.push({ start, end: start, width: 0 }); start++; continue; }
    let x = 0, lastSpace = -1, end = start;
    while (end < v.length && v[end] !== '\n') {
      if (v[end] === ' ') lastSpace = end;
      if (x + widths[end] > maxW && end > start) break;
      x += widths[end]; end++;
    }
    let brk;
    if (end < v.length && v[end] === '\n') brk = end;
    else if (end < v.length && lastSpace >= start) brk = lastSpace;
    else brk = end;
    let w = 0; for (let k = start; k < brk; k++) w += widths[k];
    lines.push({ start, end: brk, width: w });
    start = brk;
    if (start < v.length && v[start] === '\n') start++;
    else while (start < v.length && v[start] === ' ') start++;
  }
  return lines;
}

function lineHeight(ln, cs, scale, sp) {
  let max = 12;
  for (let k = ln.start; k < ln.end; k++) max = Math.max(max, Number(cs[k].size) || 12);
  return max * scale * (sp || DEFAULT_LINE_HEIGHT);
}

// The line spacing an item sets, or 0 when it does not set one. Unset keeps the historical
// numbers exactly: 1.25 per line and a block that is never shorter than 1.3 × its font
// (1.35 for a list item). A box with its own spacing uses that spacing for the floor too,
// so "Single (1.0)" really is one line tight. Table rows keep their own height.
function spacingOf(base) {
  const v = Number(base?.lineHeight);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function drawRichLine(ctx, v, cs, ln, x, y, scale) {
  let i = ln.start, xc = x;
  while (i < ln.end) {
    const c0 = cs[i];
    let j = i;
    while (j < ln.end && cs[j].font === c0.font && cs[j].bold === c0.bold && cs[j].italic === c0.italic
           && cs[j].color === c0.color && cs[j].underline === c0.underline && cs[j].size === c0.size) j++;
    const txt = v.slice(i, j);
    ctx.font = fontOf(c0, scale);
    ctx.fillStyle = c0.color || '#111';
    ctx.fillText(txt, xc, y);
    const w = ctx.measureText(txt).width;
    if (c0.underline) ctx.fillRect(xc, y + (Number(c0.size) || 12) * scale, w, Math.max(1, (Number(c0.size) || 12) * scale * 0.06));
    xc += w;
    i = j;
  }
}

function flowLines(ctx, value, base, runs, scale, maxW) {
  const cs = charStyles({ value, style: base, runs });
  const v = String(value || '');
  let lines = layoutLines(ctx, v, cs, scale, maxW);
  if (!lines.length) lines = [{ start: 0, end: 0, width: 0 }];
  return { cs, v, lines };
}

// Draw one flow (paragraph / heading / list item / table cell); returns height used.
function drawFlow(ctx, value, base, runs, x, y, scale, maxW, bottom) {
  const { cs, v, lines } = flowLines(ctx, value, base, runs, scale, maxW);
  const sp = spacingOf(base);
  let cy = y;
  for (const ln of lines) {
    const c0 = (ln.start < ln.end ? cs[ln.start] : cs[Math.max(0, ln.start - 1)]) || base;
    const lineDir = c0.direction === 'rtl' ? 'rtl' : 'ltr';
    let a = c0.align || base.align || 'left';
    if (lineDir === 'rtl' && a === 'left') a = 'right';
    ctx.direction = lineDir;
    const lh = lineHeight(ln, cs, scale, sp);
    if (cy + lh > bottom + 0.5 && ln.end > ln.start) break;
    let lx = x;
    if (a === 'right') lx = x + maxW - ln.width;
    else if (a === 'center') lx = x + (maxW - ln.width) / 2;
    if (lx < x) lx = x;
    drawRichLine(ctx, v, cs, ln, lx, cy, scale);
    cy += lh;
  }
  return cy - y;
}

function drawBlock(ctx, block, item, bx, y, maxW, bottom, s) {
  if (block.type === 'table') return drawTableBlock(ctx, block, item, bx, y, bottom, s);
  if (block.type === 'list') {
    const base = flowBase(item.style, 'paragraph', null, null, block.direction);
    const fs = (Number(base.size) || 12) * s;
    let cy = y;
    const counters = {};
    block.items.forEach((it) => {
      const lvl = it.level || 0;
      counters[lvl] = (counters[lvl] || 0) + 1;
      for (const k of Object.keys(counters)) if (+k > lvl) delete counters[k];
      const indent = lvl * 16 * s / s; // points
      const mark = block.ordered ? `${counters[lvl]}.` : (lvl ? '◦' : '•');
      ctx.direction = 'ltr';
      ctx.font = fontOf(base, s);
      ctx.fillStyle = base.color || '#111';
      ctx.fillText(mark, bx + indent * s, cy);
      const textX = bx + (indent + 14) * s;
      const h = drawFlow(ctx, it.value, base, it.runs, textX, cy, s, Math.max(4, maxW - (indent + 14) * s), bottom);
      cy += Math.max(h, fs * (spacingOf(base) || 1.35));
      if (cy >= bottom) return;
    });
    return cy - y;
  }
  const type = block.type === 'heading' ? 'heading' : 'paragraph';
  const base = flowBase(item.style, type, block.level, block.align, block.direction);
  const h = drawFlow(ctx, block.value, base, block.runs, bx, y, s, maxW, bottom);
  return Math.max(h, (Number(base.size) || 12) * s * (spacingOf(base) || 1.3));
}

function drawTableBlock(ctx, block, item, bx, y, bottom, s) {
  const border = block.border || {};
  const widths = block.columns.map(c => Math.max(8, (Number(c.width) || 90)) * s);
  ctx.save();
  ctx.direction = 'ltr';
  ctx.strokeStyle = border.color || '#333';
  ctx.lineWidth = Math.max(0.5, (Number(border.width) || 1) * s);
  let cy = y;
  for (const row of block.rows) {
    const rh = Math.max(8, (Number(row.height) || 24) * s);
    let cx = bx;
    (row.cells || []).forEach((cell, ci) => {
      const cw = widths[ci] || widths[widths.length - 1] || 60;
      ctx.strokeRect(cx, cy, cw, rh);
      const base = flowBase(item.style, 'paragraph', null, cell.align, cell.direction);
      ctx.direction = cell.direction === 'rtl' ? 'rtl' : 'ltr';
      drawFlow(ctx, cell.value, base, cell.runs, cx + 3, cy + 2, s, Math.max(4, cw - 6), cy + rh - 2);
      cx += cw;
    });
    cy += rh;
    if (cy > bottom + rh) break;
  }
  ctx.restore();
  return cy - y;
}

// ---- measuring an item's text (used by "Resize to text", spec §9b) ----
// The *same* layout code that draws an item is run against a scratch canvas at scale 1
// (1 unit = 1 PDF point) with an unbounded box: nothing is skipped, so the numbers match
// what Preview mode and the export will lay out. Returns the height the box must have to
// show every line, and the narrowest width that still holds the widest unbreakable token
// (a table asks for its own total width instead).
let measureCtx = null;
function measureContext() {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}
function blockFlows(block, item) {
  if (block.type === 'list') {
    const base = flowBase(item.style, 'paragraph', null, null, block.direction);
    return (block.items || []).map(it => ({ value: it.value, base, runs: it.runs }));
  }
  if (block.type === 'table') {
    const out = [];
    for (const row of block.rows || []) {
      for (const cell of row.cells || []) {
        out.push({ value: cell.value, base: flowBase(item.style, 'paragraph', null, cell.align, cell.direction), runs: cell.runs });
      }
    }
    return out;
  }
  const base = flowBase(item.style, block.type === 'heading' ? 'heading' : 'paragraph', block.level, block.align, block.direction);
  return [{ value: block.value, base, runs: block.runs }];
}
// Widest run of non-space characters in one flow (mixed sizes/fonts included).
function widestToken(ctx, value, base, runs) {
  const v = String(value || '');
  if (!v) return 0;
  const cs = charStyles({ value: v, style: base, runs });
  let max = 0, cur = 0;
  for (let i = 0; i < v.length; i++) {
    if (/\s/.test(v[i])) { if (cur > max) max = cur; cur = 0; continue; }
    ctx.font = fontOf(cs[i], 1);
    cur += ctx.measureText(v[i]).width;
  }
  return Math.max(max, cur);
}
export function measureTextItem(item, boxW) {
  const ctx = measureContext();
  const blocks = itemBlocks(item);
  const pad = 2;
  const maxW = Math.max(4, boxW - pad * 2);
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.direction = 'ltr';
  let y = pad, minWidth = 0;
  for (const block of blocks) {
    for (const f of blockFlows(block, item)) minWidth = Math.max(minWidth, widestToken(ctx, f.value, f.base, f.runs));
    if (block.type === 'table' && block.columns) {
      minWidth = Math.max(minWidth, block.columns.reduce((a, c) => a + Math.max(8, Number(c.width) || 90), 0));
    }
    y += drawBlock(ctx, block, item, pad, y, maxW, Infinity, 1);
  }
  ctx.restore();
  return { height: y + pad, minWidth: minWidth + pad * 2 };
}

function drawItemText(ctx, bx, by, bw, bh, item, s, overflowMark = true) {
  const blocks = itemBlocks(item);
  const pad = 2;
  const maxW = Math.max(4, bw - pad * 2);
  let y = by + pad;
  const bottom = by + bh;
  // Draw from the top of each line box: the default 'alphabetic' baseline would
  // push the glyphs above the box (the ascent is drawn upward from y).
  ctx.textBaseline = 'top';
  for (const block of blocks) {
    if (y > bottom) break;
    y += drawBlock(ctx, block, item, bx + pad, y, maxW, bottom, s);
  }
  ctx.direction = 'ltr';
  ctx.textBaseline = 'alphabetic';
  // Spec §9b: text that does not fit is never silently clipped — the item carries its own
  // marker. The measurement is the very layout code that just drew it, run unbounded and
  // converted back to PDF points with the zoom, so the marker and "Resize to text" agree.
  if (overflowMark && s > 0 && itemOverflows(item, bw / s, bh / s)) drawOverflowMark(ctx, bx, by, bw, bh);
}

// The item's text is taller than its box, or one of its words is wider than it (a word the
// layout cannot break is drawn past the right edge). Exported so the items list can badge
// the same condition the canvas marker draws (spec 1.5 §23).
export function itemOverflows(item, boxW, boxH) {
  const m = measureTextItem(item, boxW);
  return m.height > boxH + 0.5 || m.minWidth > boxW + 0.5;
}

// A small amber triangle tucked into the item's bottom-right corner. It is ink *on the
// box*, so it is drawn by the canvas only: the export renders the artifact, not the warning.
function drawOverflowMark(ctx, bx, by, bw, bh) {
  const k = Math.min(9, Math.max(5, Math.min(bw, bh) * 0.2));
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#d97706';
  ctx.beginPath();
  ctx.moveTo(bx + bw, by + bh - k);
  ctx.lineTo(bx + bw, by + bh);
  ctx.lineTo(bx + bw - k, by + bh);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawItemImage(ctx, rings, s, bx, by, bw, bh, item, baseCanvas) {
  const fitBox = (sw, sh) => {
    const ar = sw / sh, br = bw / bh;
    if ((item.fit === 'cover')) {
      // scale to cover the box, then center-crop
      if (ar > br) { const w2 = bh * ar; return [bx - (w2 - bw) / 2, by, w2, bh]; }
      const h2 = bw / ar; return [bx, by - (h2 - bh) / 2, bw, h2];
    }
    if (ar > br) { const h2 = bw / ar; return [bx, by + (bh - h2) / 2, bw, h2]; }
    const w2 = bh * ar; return [bx + (bw - w2) / 2, by, w2, bh];
  };
  const src = item.source;
  if (src && (src.startsWith('data:') || src.startsWith('http') || src.startsWith('/') || src.startsWith('./'))) {
    const paint = (img) => {
      ctx.save(); pathRings(ctx, rings, s); ctx.clip();
      const [dx, dy, dw, dh] = fitBox(img.naturalWidth, img.naturalHeight);
      try { ctx.drawImage(img, dx, dy, dw, dh); } catch {}
      ctx.restore();
    };
    const cached = imageCache.get(src);
    if (cached) {
      // Already decoded: draw on this frame instead of waiting for a load event.
      if (cached.complete && cached.naturalWidth) paint(cached);
    } else {
      const img = cachedImage(src);
      img.addEventListener('load', () => paint(img), { once: true });
      img.src = src;
    }
  } else if (baseCanvas) {
    // passthrough: re-draw the original crop (PDF pt -> device px)
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cx = bx * dpr, cy = by * dpr, cw = bw * dpr, ch = bh * dpr;
    try { ctx.drawImage(baseCanvas, cx, cy, cw, ch, bx, by, bw, bh); }
    catch { ctx.fillStyle = '#eee'; ctx.fillRect(bx, by, bw, bh); }
  } else {
    // empty source / edit preview placeholder
    ctx.fillStyle = 'rgba(234,67,53,.12)';
    ctx.fillRect(bx, by, bw, bh);
  }
}
