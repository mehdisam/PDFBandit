// Classical-CV region detection for scanned (no-text-layer) pages (spec 1.5 §19).
//
// Deliberately dependency-free. The spec named OpenCV.js, but the block pipeline it
// describes — grayscale, denoise, adaptive threshold, morphological close, connected
// components, filter, classify and group — is a handful of O(n) passes over the page bitmap, while
// OpenCV's single-thread build is ~11 MB of WASM that the hosting plan explicitly rules
// out ("no .wasm, self-contained"). Only the *contract* is load-bearing and it is
// unchanged: the same proposal shape as tier-1
// (`{ type: 'HEADING'|'TEXT'|'IMAGE', points }` in PDF points), text padded by the caller
// (main.js detectPoints), images unpadded, proposals only, never a mutation.
//
// The module is split so the whole pipeline runs headless: `detectBlocks` operates on a
// plain `{ data, width, height }` bitmap (RGBA or single-channel gray) and returns pixel
// boxes; `blocksToRegions` maps them to PDF points. The DOM render that produces the
// bitmap lives in viewer.js.
//
// Text vs image is decided by **structure**, not ink density. A photo's thresholded ink
// is just as dense as a bold heading, so density put text boxes on the car photo in the
// 1.5 scan fixture. A block is TEXT only when it looks like lines of type: a stable line
// height, most ink in word/glyph-sized components, short ink runs relative to that line
// height, and blank rows around/between the lines (a tight single line is accepted when
// it has several line-fitting glyphs and low ink, and display-sized glyphs use a
// page-relative line cap). Everything else is IMAGE. The bias is deliberate: a stylised
// logo or text over a busy photo may come out as IMAGE; the user can draw the region. The
// reverse (rules on texture) is the failure this replaced.

import { clusterBoxes } from './detect_ops.js';

const PAD = 1.5;              // pt — the same small margin tier-1 adds around text
const ADAPT_WIN_FRAC = 1 / 16;// adaptive-threshold window, as a fraction of the long edge
const ADAPT_C = 10;           // how far below the local mean a pixel must be to read as ink
const DIL_W_FRAC = 0.012;     // close width: bridges inter-word gaps so a line is one blob
const DIL_H_FRAC = 0.010;     // close height: merges adjacent lines into one block
const MIN_AREA_FRAC = 2e-5;   // drop specks (fraction of the page)
const MIN_SIDE = 3;           // px — drop degenerate slivers
const IMG_MAX_COVER = 0.92;   // a block covering the whole page is the scan background, not a region

// --- text-likeness (spec §19). All lengths are bitmap pixels; ratios make the rules
// scale-free, the absolute caps only keep whole-photo blobs out of the line-height
// estimate. Tuned on a flattened cover (photo + two text bands) and the synthetic suite.
const MIN_STD = 12;           // below this a block is a shadow/gradient, not content
const MIN_INK_FRAC = 0.003;   // below this a block has no visible ink
const GLYPH_MAX_H = 128;      // px — old absolute floor; blockStats uses a page-relative line cap
const GLYPH_WIDTH_RATIO = 30; // a word may be long, but not a full-width strip
const GLYPH_HEIGHT_RATIO = 10; // a glyph is not a tall vertical stripe (I/l are close)
const GLYPH_FILL_MIN = 0.05;  // component fill (ink / bbox) worth calling a glyph
const GLYPH_FILL_MAX = 1;     // solid dots/bullets are glyphs too; the aspect caps exclude bars
const GLYPH_ASPECT_MAX = 2.5; // a glyph/word is not a flat horizontal streak
const MAX_WIDE_GLYPH_SHARE = 0.5; // most ink in wide flat marks = a smudge/rule, not type
const MIN_GLYPH_SHARE = 0.5;  // share of ink that must sit in glyph/word components
const MAX_TEXT_INK = 0.55;    // a text line is not a solid block
const MIN_BLANK_ROWS = 0.08;  // type has vertical whitespace in its box; texture fills it
const RUN_FACTOR = 2;         // runs longer than this × line height in BOTH axes = texture
const MAX_COMPS = 20000;      // more components than this is texture, not type
const MIN_TEXT_H_FRAC = 0.010;// px — smallest useful text box, as a fraction of the long edge
const MIN_TEXT_W_FRAC = 0.016;
const CLASSIFY_MAX_PX = 500000; // larger blocks are classified at half resolution
const MIN_IMAGE_SIDE_PT = 6;  // same floor as the digital tier
const IMAGE_GAP_FRAC = 0.002; // px — image fragments this close belong to one figure
const IMAGE_CONTAIN = 0.85;   // a figure mostly inside another is a duplicate

// ------------------------------------------------------------------ bitmap helpers

// RGBA (ImageData) or single-channel gray -> luminance. Pure; exported for tests.
export function toGray(data, width, height) {
  const n = width * height;
  const out = new Uint8ClampedArray(n);
  if (data.length === n) { out.set(data); return out; }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
  }
  return out;
}

// Summed-area table (one extra row/column of zeros) so any box mean is O(1).
function integral(gray, w, h) {
  const ii = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return ii;
}
function boxSum(ii, w, x0, y0, x1, y1) { // inclusive-exclusive
  return ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
}

// A robust "is this a dark page?" test: the median of a strided sample. Scanned text is
// usually dark on light; a light-on-dark page would otherwise threshold to nothing.
export function medianSample(gray, n) {
  const step = Math.max(1, Math.floor(n / 4096));
  const s = [];
  for (let i = 0; i < n; i += step) s.push(gray[i]);
  s.sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 255;
}

// 1. Adaptive threshold: ink where the pixel is darker than its local neighbourhood mean
// by ADAPT_C. On a dark page the comparison flips. Returns a 0/1 mask.
function adaptiveMask(gray, w, h) {
  const ii = integral(gray, w, h);
  const long = Math.max(w, h);
  const half = Math.max(2, Math.round(long * ADAPT_WIN_FRAC / 2));
  const invert = medianSample(gray, w * h) < 128;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
      const mean = boxSum(ii, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
      const v = gray[y * w + x];
      mask[y * w + x] = (invert ? v >= mean + ADAPT_C : v <= mean - ADAPT_C) ? 1 : 0;
    }
  }
  return mask;
}

// Flat morphological "any" (dilation) as two 1-D sliding-window passes: O(n) regardless of
// the radius. `not` of that gives the matching "all" pass (erosion).
function anyWindow(mask, w, h, rw, rh) {
  const tmp = new Uint8Array(w * h);
  if (rw > 0) {
    for (let y = 0; y < h; y++) {
      const base = y * w;
      let count = 0;
      for (let x = 0; x < Math.min(w, rw + 1); x++) count += mask[base + x];
      for (let x = 0; x < w; x++) {
        tmp[base + x] = count > 0 ? 1 : 0;
        const add = x + rw + 1, drop = x - rw;
        if (add < w) count += mask[base + add];
        if (drop >= 0) count -= mask[base + drop];
      }
    }
  } else tmp.set(mask);
  if (rh === 0) return tmp;
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(h, rh + 1); y++) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = count > 0 ? 1 : 0;
      const add = y + rh + 1, drop = y - rh;
      if (add < h) count += tmp[add * w + x];
      if (drop >= 0) count -= tmp[drop * w + x];
    }
  }
  return out;
}
const invertMask = (m) => { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ? 0 : 1; return o; };
// Closing = dilate then erode with the same flat element.
function closeMask(mask, w, h, rw, rh) {
  return invertMask(anyWindow(invertMask(anyWindow(mask, w, h, rw, rh)), w, h, rw, rh));
}

// 2. Connected components (4-connectivity) with a reusable stack; returns pixel boxes plus
// the ink count taken from the original (un-closed) mask.
function components(mask, orig, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, ink = 0;
    while (top > 0) {
      const p = stack[--top];
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (orig[p]) ink++;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x + 1 < w && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[top++] = p - w; }
      if (y + 1 < h && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[top++] = p + w; }
    }
    out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, ink });
  }
  return out;
}

// 4. Text-likeness on one block crop. Otsu per block (so a light-on-dark band has the
// right polarity), then component heights, run lengths and blank rows. Pure.
function otsuThreshold(hist, n) {
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let wB = 0, sumB = 0, best = -1, t = 0;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = v; }
  }
  return t;
}

function runP99(hist, total) {
  if (!total) return 0;
  let acc = 0;
  for (let len = 1; len < hist.length; len++) {
    acc += hist[len];
    if (acc >= total * 0.99) return len;
  }
  return hist.length - 1;
}

function blockStats(gray, W, block, stack, pageLong) {
  const x0 = block.x0, y0 = block.y0;
  const bw = block.x1 - x0, bh = block.y1 - y0;
  // A block this large is a photo in practice. Classify it at half resolution so the
  // structural pass does not add a second full-page walk; every decision below is a ratio
  // (line height, run length, blank rows, glyph share), so the scale cancels out.
  const step = bw * bh > CLASSIFY_MAX_PX ? 2 : 1;
  const w = Math.ceil(bw / step), h = Math.ceil(bh / step);
  const n = w * h;
  let src = gray, base = y0 * W + x0, stride = W;
  if (step > 1) {
    const sample = new Uint8ClampedArray(n);
    for (let y = 0; y < h; y++) {
      const from = (y0 + y * step) * W + x0;
      const to = y * w;
      for (let x = 0; x < w; x++) sample[to + x] = gray[from + x * step];
    }
    src = sample; base = 0; stride = w;
  }
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const row = base + y * stride;
    for (let x = 0; x < w; x++) hist[src[row + x]]++;
  }
  let sum = 0, sumSq = 0;
  for (let v = 0; v < 256; v++) { sum += v * hist[v]; sumSq += v * v * hist[v]; }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const t = otsuThreshold(hist, n);
  let dark = 0;
  for (let v = 0; v <= t; v++) dark += hist[v];
  const invert = dark > n / 2;
  const inkFrac = invert ? 1 - dark / n : dark / n;
  if (std < MIN_STD || inkFrac < MIN_INK_FRAC) return null;

  const ink = new Uint8Array(n);
  const rowInk = new Uint32Array(h);
  const colInk = new Uint32Array(w);
  let inkTotal = 0;
  for (let y = 0; y < h; y++) {
    const row = base + y * stride;
    for (let x = 0; x < w; x++) {
      const v = src[row + x];
      if (invert ? v > t : v <= t) {
        ink[y * w + x] = 1; rowInk[y]++; colInk[x]++; inkTotal++;
      }
    }
  }
  if (inkTotal < 10) return null;

  // Runs longer than the line height in both axes are texture/photo, not type. Rows and
  // columns that are nearly solid are rules/fills; they must not inflate the run p99.
  const runH = new Uint32Array(w + 1);
  const runV = new Uint32Array(h + 1);
  let totalH = 0, totalV = 0;
  for (let y = 0; y < h; y++) {
    if (rowInk[y] > w * 0.6) continue;
    let x = 0;
    while (x < w) {
      if (!ink[y * w + x]) { x++; continue; }
      let e = x + 1;
      while (e < w && ink[y * w + e]) e++;
      runH[e - x]++; totalH++;
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    if (colInk[x] > h * 0.6) continue;
    let y = 0;
    while (y < h) {
      if (!ink[y * w + x]) { y++; continue; }
      let e = y + 1;
      while (e < h && ink[e * w + x]) e++;
      runV[e - y]++; totalV++;
      y = e;
    }
  }
  let blankRows = 0;
  for (let y = 0; y < h; y++) if (rowInk[y] < w * 0.01) blankRows++;
  blankRows /= h;

  // 8-connected components. The ink mask doubles as the visited set, so even a full-size
  // block does not need a second full-size array. Component heights feed the line height.
  const compH = [], compW = [], compInk = [];
  let tooMany = false;
  for (let start = 0; start < n; start++) {
    if (!ink[start]) continue;
    let top = 0;
    stack[top++] = start; ink[start] = 0;
    let bx0 = w, by0 = h, bx1 = 0, by1 = 0, c = 0;
    while (top) {
      const p = stack[--top];
      const x = p % w, y = (p / w) | 0;
      c++;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
      const xm = x > 0, xp = x + 1 < w, ym = y > 0, yp = y + 1 < h;
      let q;
      if (xm) { q = p - 1; if (ink[q]) { ink[q] = 0; stack[top++] = q; } }
      if (xp) { q = p + 1; if (ink[q]) { ink[q] = 0; stack[top++] = q; } }
      if (ym) {
        q = p - w; if (ink[q]) { ink[q] = 0; stack[top++] = q; }
        if (xm) { q = p - w - 1; if (ink[q]) { ink[q] = 0; stack[top++] = q; } }
        if (xp) { q = p - w + 1; if (ink[q]) { ink[q] = 0; stack[top++] = q; } }
      }
      if (yp) {
        q = p + w; if (ink[q]) { ink[q] = 0; stack[top++] = q; }
        if (xm) { q = p + w - 1; if (ink[q]) { ink[q] = 0; stack[top++] = q; } }
        if (xp) { q = p + w + 1; if (ink[q]) { ink[q] = 0; stack[top++] = q; } }
      }
    }
    compH.push(by1 - by0 + 1); compW.push(bx1 - bx0 + 1); compInk.push(c);
    if (compH.length > MAX_COMPS) { tooMany = true; break; }
  }
  if (tooMany) return { tooMany: true, std, inkFrac };

  // Ink-weighted median height of glyph-sized components = the line height. The cap is
  // relative to the render/page so a display-sized headline (whose glyphs are >128 px at
  // 170 DPI) is still measured; it only excludes whole-photo blobs. A title-only block
  // would otherwise have no line height at all and be forced to IMAGE.
  const lineCap = Math.max(GLYPH_MAX_H, Math.min(h, Math.round(pageLong * 0.25)));
  const inkByH = new Uint32Array(Math.min(h, lineCap) + 1);
  let lineInk = 0;
  for (let i = 0; i < compH.length; i++) {
    const ch = compH[i];
    if (ch > lineCap) continue;
    inkByH[ch] += compInk[i]; lineInk += compInk[i];
  }
  let lineH = 0;
  if (lineInk) {
    let acc = 0;
    for (let ch = 1; ch < inkByH.length; ch++) {
      acc += inkByH[ch];
      if (acc >= lineInk / 2) { lineH = ch; break; }
    }
  }
  if (!lineH) return { std, inkFrac, lineH: 0 };

  const cap = Math.max(GLYPH_MAX_H, lineH * 3);
  let glyphInk = 0, allInk = 0, wideInk = 0, lineFitInk = 0, glyphCount = 0;
  for (let i = 0; i < compH.length; i++) {
    const ch = compH[i], cw = compW[i], ci = compInk[i];
    allInk += ci;
    const fill = ci / (ch * cw);
    if (ch <= cap && cw <= ch * GLYPH_WIDTH_RATIO && ch <= cw * GLYPH_HEIGHT_RATIO && fill >= GLYPH_FILL_MIN && fill <= GLYPH_FILL_MAX) {
      glyphInk += ci;
      glyphCount++;
      if (cw > ch * GLYPH_ASPECT_MAX) wideInk += ci;
      // Glyphs that actually belong to this line height. A photo fragment usually has
      // components spread over many heights; a line of type does not.
      if (ch >= lineH * 0.65 && ch <= lineH * 1.45) lineFitInk += ci;
    }
  }
  const glyphShare = allInk ? glyphInk / allInk : 0;
  const lineShare = glyphInk ? lineFitInk / glyphInk : 0;
  // A tyre mark or a snow ridge is a wide, low component; real glyphs are roughly upright.
  const wideShare = glyphInk ? wideInk / glyphInk : 1;
  const hP99 = runP99(runH, totalH), vP99 = runP99(runV, totalV);
  return {
    std, inkFrac, lineH, glyphShare, lineShare, wideShare, glyphCount, blankRows, hP99, vP99,
    texture: hP99 > lineH * RUN_FACTOR && vP99 > lineH * RUN_FACTOR,
    tall: h > lineH * 3 && blankRows < MIN_BLANK_ROWS,
  };
}

// A block is TEXT only with line structure. Everything else is IMAGE; null drops the box
// (no visible content). `long` is the page's long edge, so the minimum useful text size
// scales with the render, not the page units.
function classifyBlock(stats, blockW, blockH, long) {
  if (!stats) return null;
  if (stats.tooMany) return 'IMAGE';
  if (!stats.lineH) return 'IMAGE';
  if (stats.texture || stats.tall) return 'IMAGE';
  // A single-line heading has almost no internal blank rows; require blank rows only for
  // multi-line blocks. The line height itself is now robust to display-sized glyphs.
  const oneLine = blockH <= stats.lineH * 2;
  const blankOk = stats.blankRows >= MIN_BLANK_ROWS || oneLine;
  // A cropped single line is not enough by itself: the crop may be a piece of a photo.
  // Require several glyphs that sit on this line. The wide-glyph veto is relaxed only for
  // a whole line that has real glyph structure (the top-right red line, a subtitle, a
  // column heading); a tyre mark/smudge still has too few glyphs and stays IMAGE.
  const singleLineOk = !oneLine || (
    stats.glyphCount >= 3
    && stats.lineShare >= 0.55
    && stats.inkFrac <= 0.45
  );
  const wideOk = stats.wideShare <= MAX_WIDE_GLYPH_SHARE || (
    oneLine && stats.glyphCount >= 3 && stats.lineShare >= 0.8 && stats.inkFrac <= 0.45
  );
  const text = stats.glyphShare >= MIN_GLYPH_SHARE
    && wideOk
    && stats.inkFrac <= MAX_TEXT_INK
    && blankOk
    && singleLineOk
    && blockW >= long * MIN_TEXT_W_FRAC
    && blockH >= long * MIN_TEXT_H_FRAC;
  return text ? 'TEXT' : 'IMAGE';
}

// 5. Image proposals: drop figures mostly contained in a larger one, then cluster the
// fragments that touch. A full-page photo must read as one IMAGE, not a pile of boxes.
function overlapArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}
export function cleanImageBoxes(boxes, minSide = 1, gap = 0) {
  const list = boxes
    .filter(b => b.kind === 'IMAGE' && b.x1 - b.x0 >= minSide && b.y1 - b.y0 >= minSide)
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0) || a.y0 - b.y0 || a.x0 - b.x0);
  const kept = [];
  for (const b of list) {
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (kept.some(k => overlapArea(k, b) >= area * IMAGE_CONTAIN)) continue;
    kept.push(b);
  }
  const clusters = clusterBoxes(kept.map(b => [b.x0, b.y0, b.x1, b.y1]), gap);
  return clusters.map(([x0, y0, x1, y1]) => {
    let density = 0;
    for (const b of kept) {
      if (b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1) density = Math.max(density, b.density || 0);
    }
    return { x0, y0, x1, y1, density, kind: 'IMAGE' };
  }).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

// The whole pipeline on a bitmap: ink mask -> close -> components -> filter -> structural
// classification -> text line/paragraph grouping. Returns pixel boxes
// `{ x0, y0, x1, y1, kind, density, lineH }`. Pure.
export function detectBlocks(input, opts = {}) {
  const width = input.width, height = input.height;
  const gray = toGray(input.data, width, height);
  const long = Math.max(width, height);
  const orig = adaptiveMask(gray, width, height);
  const rw = Math.max(1, Math.round(long * DIL_W_FRAC / 2));
  const rh = Math.max(1, Math.round(long * DIL_H_FRAC / 2));
  const closed = closeMask(orig, width, height, rw, rh);

  const minArea = long * long * MIN_AREA_FRAC;
  const maxCover = IMG_MAX_COVER;
  const boxes = components(closed, orig, width, height)
    .filter(b => (b.x1 - b.x0) >= MIN_SIDE && (b.y1 - b.y0) >= MIN_SIDE)
    .filter(b => (b.x1 - b.x0) * (b.y1 - b.y0) >= minArea)
    .filter(b => ((b.x1 - b.x0) * (b.y1 - b.y0)) / (width * height) <= maxCover);

  return assembleBlocks(gray, width, height, boxes, opts);
}

// The shared half of the contract (spec §19): take arbitrary pixel boxes over a grayscale
// page and decide TEXT vs IMAGE with the structural classifier, drop empty ones, dedupe
// and cluster figures, and apply the minimum sizes. `detectBlocks` feeds it its own mask;
// the opt-in OpenCV.js engine feeds it OpenCV contours, so both engines produce identical
// proposal semantics and differ only in how they segment the bitmap. Pure and exported.
export function classifyPixelBoxes(gray, width, height, boxes, opts = {}) {
  const long = Math.max(width, height);
  const stack = boxes.length ? new Int32Array(width * height) : null;
  const texts = [], images = [];
  for (const b of boxes) {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    const st = blockStats(gray, width, b, stack, long);
    const kind = classifyBlock(st, w, h, long);
    if (!kind) continue;
    const area = w * h;
    const out = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, density: area ? (b.ink || 0) / area : 0, kind, lineH: st.lineH };
    (kind === 'TEXT' ? texts : images).push(out);
  }
  const scale = opts.scale || 1;
  return [
    ...texts,
    ...cleanImageBoxes(images, Math.max(1, Math.round(MIN_IMAGE_SIDE_PT * scale)), Math.max(2, Math.round(long * IMAGE_GAP_FRAC))),
  ];
}

// 5a. Text grouping (spec §19). Raw segmentation units are words, letters or lines; the
// proposal contract wants readable blocks. Group same-line units first, using a gap that
// scales with the line height (1.7×, wider for display type), then stack lines whose line
// heights match. Paragraph-sized raw boxes are excluded from horizontal grouping, so two
// columns can never be joined; a single title line still merges across its word space.
export function groupTextBoxes(boxes) {
  const sorted = boxes
    .filter(b => b.kind === 'TEXT')
    .slice()
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const b of sorted) {
    const bh = b.y1 - b.y0;
    const blh = b.lineH || bh;
    // A raw box taller than a line and a half is already a paragraph (the close bridged
    // several lines). It must not be horizontally merged with a different column, and
    // it will be placed by the vertical stage below.
    if (bh > blh * 1.8) {
      lines.push({ ...b, kind: 'TEXT' });
      continue;
    }
    let best = -1, bestGap = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const g = lines[i];
      const gh = g.y1 - g.y0;
      const glh = g.lineH || gh;
      if (gh > glh * 1.8) continue;
      const overlap = Math.min(g.y1, b.y1) - Math.max(g.y0, b.y0);
      if (overlap < 0.5 * Math.min(gh, bh)) continue;
      if (Math.max(glh, blh) > 1.8 * Math.max(1, Math.min(glh, blh))) continue;
      const gap = Math.max(g.x0, b.x0) - Math.min(g.x1, b.x1);
      const lineH = Math.min(glh, blh);
      // Display type ("KIA RIO") can have a genuinely wide word space, but body columns
      // must not merge. Keep the normal gap tight and allow a wider one only for a
      // display-sized line.
      const maxGap = Math.max(4, Math.round(lineH * (lineH >= 80 ? 3.5 : 1.7)));
      if (gap > maxGap) continue;
      if (gap < bestGap) { best = i; bestGap = gap; }
    }
    if (best >= 0) {
      const g = lines[best];
      const ga = (g.x1 - g.x0) * (g.y1 - g.y0);
      const ba = (b.x1 - b.x0) * (b.y1 - b.y0);
      const dens = ga + ba ? ((g.density || 0) * ga + (b.density || 0) * ba) / (ga + ba) : 0;
      g.x0 = Math.min(g.x0, b.x0); g.y0 = Math.min(g.y0, b.y0);
      g.x1 = Math.max(g.x1, b.x1); g.y1 = Math.max(g.y1, b.y1);
      g.density = dens;
      g.lineH = Math.max(g.lineH || (g.y1 - g.y0), blh);
    } else {
      lines.push({ ...b, kind: 'TEXT' });
    }
  }

  // Merge lines transitively. A middle word can be processed before the left one when
  // two boxes share y0, leaving left and right as separate line groups; a second pass
  // joins them without ever crossing a column gutter (the gap test is unchanged).
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i];
      const ah = a.y1 - a.y0;
      const alh = a.lineH || ah;
      if (ah > alh * 1.8) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j];
        const bh = b.y1 - b.y0;
        const blh = b.lineH || bh;
        if (bh > blh * 1.8) continue;
        const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (overlap < 0.5 * Math.min(ah, bh)) continue;
        if (Math.max(alh, blh) > 1.8 * Math.max(1, Math.min(alh, blh))) continue;
        const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        const lineH = Math.min(alh, blh);
        const maxGap = Math.max(4, Math.round(lineH * (lineH >= 80 ? 3.5 : 1.7)));
        if (gap > maxGap) continue;
        a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
        a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
        a.lineH = Math.max(alh, blh);
        lines.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }

  lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const paras = [];
  for (const l of lines) {
    const lh = l.y1 - l.y0;
    const llh = l.lineH || lh;
    let best = -1, bestGap = Infinity;
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      const lastH = p.lastLineH || p.lineH || (p.y1 - p.y0);
      if (Math.max(lastH, llh) > 1.5 * Math.max(1, Math.min(lastH, llh))) continue;
      const vgap = l.y0 - p.y1;
      const hover = Math.min(p.x1, l.x1) - Math.max(p.x0, l.x0);
      const minW = Math.min(p.x1 - p.x0, l.x1 - l.x0);
      if (vgap < -2 || vgap > Math.max(2, Math.round(lastH * 0.7)) || hover <= minW * 0.5) continue;
      if (vgap < bestGap) { best = i; bestGap = vgap; }
    }
    if (best >= 0) {
      const p = paras[best];
      const pa = (p.x1 - p.x0) * (p.y1 - p.y0);
      const la = (l.x1 - l.x0) * (l.y1 - l.y0);
      const dens = pa + la ? ((p.density || 0) * pa + (l.density || 0) * la) / (pa + la) : 0;
      p.x0 = Math.min(p.x0, l.x0); p.y0 = Math.min(p.y0, l.y0);
      p.x1 = Math.max(p.x1, l.x1); p.y1 = Math.max(p.y1, l.y1);
      p.density = dens;
      p.lastLineH = llh;
      p.lineH = Math.max(p.lineH || 0, llh);
    } else {
      paras.push({ ...l, kind: 'TEXT', lastLineH: llh });
    }
  }
  return paras;
}

// The complete post-segmentation assembly shared by both CV engines: classify the raw
// boxes, group the text candidates into lines/paragraphs, and keep the cleaned image
// proposals separate. This is what prevents a photo and a nearby text line from being
// merged before the classifier ever sees them.
export function assembleBlocks(gray, width, height, boxes, opts = {}) {
  const classified = classifyPixelBoxes(gray, width, height, boxes, opts);
  const texts = classified.filter(b => b.kind === 'TEXT');
  const images = classified.filter(b => b.kind === 'IMAGE');
  const grouped = groupTextBoxes(texts);
  // A letter-sized image fragment that falls inside a grouped text line is a
  // misclassified part of that line (the hole in a display "R", a wide red word);
  // don't propose it as a second, overlapping IMAGE.
  const keptImages = images.filter(img => {
    const area = (img.x1 - img.x0) * (img.y1 - img.y0);
    return !grouped.some(t => overlapArea(t, img) >= area * 0.8);
  });
  return [...grouped, ...keptImages];
}

// Pixel boxes -> the tier-1 proposal contract, in PDF points (top-left origin). `pt` is the
// scale-1 page size; `scale` is the bitmap's pixels-per-point. The small PAD margin is for
// text only; an image is its own extent (the caller adds the user's text-box padding to
// text only, and the digital tier leaves IMAGE unpadded too).
export function blocksToRegions(blocks, pt, scale) {
  const W = pt.width, H = pt.height;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return blocks.map(b => {
    const pad = b.kind === 'TEXT' ? PAD : 0;
    const x0 = clamp(b.x0 / scale - pad, 0, W), y0 = clamp(b.y0 / scale - pad, 0, H);
    const x1 = clamp(b.x1 / scale + pad, 0, W), y1 = clamp(b.y1 / scale + pad, 0, H);
    return { type: b.kind, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
  });
}

// Convenience for callers holding an ImageData-like bitmap and the scale-1 page size.
export function detectCvRegions(imageData, pt, scale, opts = {}) {
  return blocksToRegions(
    detectBlocks({ data: imageData.data, width: imageData.width, height: imageData.height }, { ...opts, scale }),
    pt, scale);
}

// The detection scale for a page: ~170 DPI (the spec's 150–200 band), capped so a very
// large page stays cheap. Pure so the viewer and tests agree.
export function cvScale(pt, longCap = 1600) {
  const long = Math.max(pt.width, pt.height);
  return Math.min(170 / 72, longCap / Math.max(1, long));
}
