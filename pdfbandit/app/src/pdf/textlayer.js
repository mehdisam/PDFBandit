// Read a PDF's text layer and turn it into lines of text with bounding boxes in
// PDF points (top-left origin, scale-1 viewport — the same space the map/overlay
// uses). Backs "Translate from page text" (spec §7/§10). Read-only: it never
// touches the map or the source PDF.
import { areaOf } from '../model/geometry.js';
import { intersectPolygons } from '../geometry-ops.js';
import { fontFromCss, styleFromFontName } from '../model/richtext.js';

const MIN_RUN = 1.5;        // ignore degenerate runs smaller than this (pt)
const KEEP_MIN_AREA = 0.6;  // a line must overlap the region by at least this (pt²)
const KEEP_MIN_FRAC = 0.25; // ... and cover at least this fraction of the line box
const HEADING_RATIO = 1.35; // line font vs page median => heading

// Script ranges. RTL detection drives reading order + item direction; the source
// language is only guessed when we are confident (Arabic/Hebrew), otherwise 'auto'.
const RTL_CHARS = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const LTR_CHARS = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g;
const HEBREW = /[\u0590-\u05FF]/g;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g;

// The text's own direction, or `null` when there are fewer than `min` letters to vote on
// (a couple of digits, or an acronym, must never decide a box's direction). The strict
// form backs the RTL offer (spec §9b) — the caller asks before spelled-out text is laid
// out against its own script — while `detectDir` keeps the old, always-answering form for
// reading order, where "no letters" simply means "left-to-right is fine".
export function detectDirStrong(text, min = 4) {
  const s = String(text || '');
  const rtl = (s.match(RTL_CHARS) || []).length;
  const ltr = (s.match(LTR_CHARS) || []).length;
  if (rtl + ltr < min) return null;
  return rtl > ltr ? 'rtl' : 'ltr';
}

export function detectDir(text) {
  return detectDirStrong(text, 0) || 'ltr';
}

export function detectSourceLang(text) {
  const s = String(text || '');
  const he = (s.match(HEBREW) || []).length;
  const ar = (s.match(ARABIC) || []).length;
  if (!he && !ar) return 'auto';
  return he > ar ? 'he' : 'ar';
}

// Is this real, translatable text — or empty / broken encoding? (spec §9b guard)
export function textQuality(raw) {
  const t = String(raw || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length < 2) return { ok: false, reason: 'empty' };
  if (/\(cid:\d+\)/.test(t)) return { ok: false, reason: 'garbage' };
  const replacement = (t.match(/\uFFFD/g) || []).length;
  if (replacement / t.length > 0.02) return { ok: false, reason: 'garbage' };
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  const nonSpace = t.replace(/\s/g, '').length || 1;
  const ratio = letters / nonSpace;
  if (ratio < 0.5) return { ok: false, reason: 'garbage' };
  return { ok: true, ratio };
}

function runBox(it, viewport) {
  const tr = it.transform;
  if (!tr) return null;
  const fs = Math.hypot(tr[0], tr[1]) || Math.hypot(tr[2], tr[3]);
  if (!fs) return null;
  const adv = Number(it.width) || 0;
  const x = tr[4], y = tr[5];
  const p = (ux, uy) => viewport.convertToViewportPoint(ux, uy);
  const quad = [p(x, y), p(x + adv, y), p(x + adv, y + fs), p(x, y + fs)];
  const xs = quad.map(q => q[0]), ys = quad.map(q => q[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 - x0 < MIN_RUN && y1 - y0 < MIN_RUN) return null;
  return { x0, y0, x1, y1, font: fs, size: Math.round(fs), str: it.str };
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// Page text is immutable, and detection may ask for the same layer once per text
// proposal (awaiting-OCR probing). Cache the promise per page object so the page is
// parsed once per session; a failed read is cached as `null` too.
const textContentCache = new WeakMap();
function pageTextContent(page) {
  let pending = textContentCache.get(page);
  if (!pending) {
    pending = Promise.resolve().then(() => page.getTextContent()).catch(() => null);
    textContentCache.set(page, pending);
  }
  return pending;
}

// All text runs on the page, or null when there is no usable text layer (scanned PDF).
// Each run carries its glyph size and its family/weight/italic so extraction can emit
// per-character runs (spec 1.5 §18). `fonts` is the optional loadedName -> { bold,
// italic } map from viewer.js; without it only the family and size are known.
export async function pageTextRuns(page, viewport, fonts = null) {
  if (!page) return null;
  const content = await pageTextContent(page);
  const items = content && Array.isArray(content.items) ? content.items : null;
  if (!items) return null;
  const styles = (content && content.styles) || {};
  const runs = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
    const b = runBox(it, viewport);
    if (!b) continue;
    const st = styles[it.fontName] || {};
    const face = fonts && typeof fonts.get === 'function' ? fonts.get(it.fontName) : null;
    const weight = face && (face.bold || face.italic || face.name) ? face : styleFromFontName(st.fontFamily);
    b.bold = !!weight.bold;
    b.italic = !!weight.italic;
    b.fontFace = fontFromCss(st.fontFamily);
    runs.push(b);
  }
  return runs;
}

// Cluster runs into lines by vertical extent overlap.
function groupLines(runs) {
  const items = [...runs].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const r of items) {
    let ln = null;
    for (const cand of lines) {
      const v = Math.min(cand.y1, r.y1) - Math.max(cand.y0, r.y0);
      const minH = Math.min(cand.y1 - cand.y0, r.y1 - r.y0) || 1;
      if (v > 0.5 * minH) { ln = cand; break; }
    }
    if (ln) {
      ln.runs.push(r);
      ln.x0 = Math.min(ln.x0, r.x0); ln.x1 = Math.max(ln.x1, r.x1);
      ln.y0 = Math.min(ln.y0, r.y0); ln.y1 = Math.max(ln.y1, r.y1);
    } else {
      lines.push({ runs: [r], x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 });
    }
  }
  return lines;
}

// Join a line's runs into text, inserting a space where the horizontal gap is
// wide enough that words would otherwise merge. RTL lines read right-to-left.
// Returns `{ text, chars }` with one style per character (parallel to `text`), so the
// extraction can build per-character runs without re-measuring anything (spec 1.5 §18).
function joinLine(ln, dir) {
  const rs = [...ln.runs].sort((a, b) => (dir === 'rtl' ? b.x0 - a.x0 : a.x0 - b.x0));
  const styleOf = (r) => ({ bold: !!r.bold, italic: !!r.italic, font: r.fontFace || 'sans', size: r.size });
  let raw = '';
  const rawChars = [];
  let prev = null;
  for (const r of rs) {
    if (prev) {
      const gap = dir === 'rtl' ? prev.x0 - r.x1 : r.x0 - prev.x1;
      const thr = Math.max(0.6, Math.min(prev.font, r.font) * 0.25);
      if (gap > thr && !/\s$/.test(raw) && !/^\s/.test(r.str)) { raw += ' '; rawChars.push(styleOf(prev)); }
    }
    for (const ch of r.str) { raw += ch; rawChars.push(styleOf(r)); }
    prev = r;
  }
  // Collapse whitespace and trim exactly as before, moving the character styles in step.
  let text = '';
  const chars = [];
  let lastSpace = true; // also drops leading whitespace
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      text += ' '; chars.push(rawChars[i]); lastSpace = true;
    } else {
      text += ch; chars.push(rawChars[i]); lastSpace = false;
    }
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); chars.pop(); }
  return { text, chars };
}

function overlap(line, rings) {
  const boxArea = Math.max(0, (line.x1 - line.x0) * (line.y1 - line.y0));
  const box = [[line.x0, line.y0], [line.x1, line.y0], [line.x1, line.y1], [line.x0, line.y1]];
  let best = 0;
  for (const ring of rings) {
    let inter = null;
    try { inter = intersectPolygons(box, ring); } catch { inter = null; }
    if (inter && inter.length >= 3) best = Math.max(best, areaOf(inter));
  }
  return { area: best, frac: boxArea > 0 ? best / boxArea : 0 };
}

// Extract the text under `rings` (one or more polygon rings) in reading order.
// Returns { ok:false, reason:'no-layer'|'empty'|'garbage' } instead of throwing.
// `fonts` is the optional loadedName -> { bold, italic } map (viewer.js fontStyleMap).
export async function extractRegionText(page, viewport, rings, fonts = null) {
  const rs = (rings || []).filter(r => Array.isArray(r) && r.length >= 3);
  const runs = await pageTextRuns(page, viewport, fonts);
  if (!runs || !runs.length) return { ok: false, reason: 'no-layer' };
  if (!rs.length) return { ok: false, reason: 'empty' };
  const pageMedian = median(runs.map(r => r.font));
  const kept = [];
  for (const ln of groupLines(runs)) {
    const dir = detectDir(ln.runs.map(r => r.str).join(''));
    const joined = joinLine(ln, dir);
    if (!joined.text) continue;
    const ov = overlap(ln, rs);
    if (ov.area < KEEP_MIN_AREA || ov.frac < KEEP_MIN_FRAC) continue;
    kept.push({
      x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1,
      font: Math.max(...ln.runs.map(r => r.font)),
      text: joined.text, chars: joined.chars, dir,
    });
  }
  if (!kept.length) return { ok: false, reason: 'empty' };
  const dir = detectDir(kept.map(l => l.text).join(' '));
  kept.sort((a, b) => a.y0 - b.y0 || (dir === 'rtl' ? b.x1 - a.x1 : a.x0 - b.x0));
  const lines = kept.map(l => ({ text: l.text, chars: l.chars, dir: l.dir, font: l.font }));
  const text = lines.map(l => l.text).join('\n');
  const q = textQuality(text);
  if (!q.ok) return { ok: false, reason: q.reason };
  const size = Math.max(6, Math.min(96, Math.round(median(kept.map(l => l.font)))));
  const maxFont = Math.max(...kept.map(l => l.font));
  const heading = kept.length <= 3 && pageMedian > 0 && maxFont >= pageMedian * HEADING_RATIO;
  return { ok: true, text, lines, lineCount: kept.length, dir, size, heading, sourceLang: detectSourceLang(text) };
}
