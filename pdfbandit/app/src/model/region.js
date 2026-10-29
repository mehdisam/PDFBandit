// Region content-item model. No DOM here. A region is just a polygon + content
// items (spec §7). Semantic types and statuses were removed from the model.
import { bboxOf, regionPoints } from './geometry.js';

export const ALIGNS = ['left','right','center','justify'];
export const DIRECTIONS = ['ltr','rtl'];
export const FONTS = ['sans','serif','mono'];
export const DEFAULT_STYLE = { size: 12, bold: false, italic: false, underline: false, font: 'sans', color: '#111111', align: 'left', direction: 'ltr' };
// Line spacing (spec §9b) is a property of the *whole* text box: the multiple of the font size
// between its lines. It is deliberately not part of DEFAULT_STYLE — normalizeStyle drops a value
// equal to the default, so maps that never touched it keep serializing exactly as before (the
// same trick `region.locked` uses) — while the renderers, the exporter and the dialog all read
// it through lineHeightOf().
export const DEFAULT_LINE_HEIGHT = 1.25;
export const LINE_HEIGHT_MIN = 0.8;
export const LINE_HEIGHT_MAX = 3;
export const DEFAULT_BACKGROUND = '#ffffff';
export const REGION_COLOR = '#4a90d9';

let counter = 0;
export function newId(prefix = 'r') {
  counter += 1;
  return `${prefix}${String(counter).padStart(3,'0')}`;
}
export function resetIdCounter(n = 0) { counter = n; }

export function createRegion(page, points, type = 'polygon') {
  const clean = type === 'multipolygon'
    ? points.map(ring => ring.map(p => [p[0], p[1]]))
    : points.map(p => [p[0], p[1]]);
  return {
    id: newId(),
    geometry: { type, points: clean },
    content: { background: DEFAULT_BACKGROUND, items: [] },
  };
}

// ---------------------------------------------------------------- item model
export function normalizeStyle(style) {
  const s = { ...DEFAULT_STYLE, ...(style || {}) };
  const size = Number(s.size);
  s.size = Number.isFinite(size) && size > 0 ? size : DEFAULT_STYLE.size;
  s.bold = !!s.bold;
  s.italic = !!s.italic;
  s.underline = !!s.underline;
  if (!ALIGNS.includes(s.align)) s.align = 'left';
  if (!DIRECTIONS.includes(s.direction)) s.direction = 'ltr';
  if (!FONTS.includes(s.font)) s.font = DEFAULT_STYLE.font;
  if (typeof s.color !== 'string' || !s.color) s.color = DEFAULT_STYLE.color;
  const lh = Number(s.lineHeight);
  if (Number.isFinite(lh) && lh > 0) s.lineHeight = Math.round(Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, lh)) * 100) / 100;
  if (s.lineHeight === DEFAULT_LINE_HEIGHT) delete s.lineHeight;
  return s;
}

// The effective line spacing of a style (a multiple of the font size). A style that never set
// one reads as the default, so callers never deal with undefined.
export function lineHeightOf(style) {
  const v = Number(style?.lineHeight);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_LINE_HEIGHT;
}

export function normalizeColor(c, fallback = DEFAULT_BACKGROUND) {
  return (typeof c === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(c) && c) ? c : fallback;
}

// Rich-text runs: character-range overrides on top of the item style. Supported
// overrides: bold, italic, underline, font, color, size, direction (bidi) and
// align (applied per line — the line uses the alignment of its first character).
export function normalizeRuns(runs, len) {
  if (!Array.isArray(runs)) return [];
  const out = [];
  for (const r of runs) {
    if (!r) continue;
    const s = Math.max(0, Math.min(len, Math.round(r.start ?? 0)));
    const e = Math.max(s, Math.min(len, Math.round(r.end ?? 0)));
    if (e <= s) continue;
    const o = { start: s, end: e };
    if (r.bold != null) o.bold = !!r.bold;
    if (r.italic != null) o.italic = !!r.italic;
    if (r.underline != null) o.underline = !!r.underline;
    if (FONTS.includes(r.font)) o.font = r.font;
    if (typeof r.color === 'string' && r.color) o.color = r.color;
    if (Number.isFinite(+r.size) && +r.size > 0) o.size = +r.size;
    if (DIRECTIONS.includes(r.direction)) o.direction = r.direction;
    if (ALIGNS.includes(r.align)) o.align = r.align;
    if (o.bold === undefined && o.italic === undefined && o.underline === undefined && o.font === undefined
        && !o.color && o.size === undefined && o.direction === undefined && o.align === undefined) continue;
    out.push(o);
  }
  return out;
}

export function normalizeBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return [0, 0, 0, 0];
  return box.map(v => (Number.isFinite(+v) ? +v : 0));
}

// ---------------------------------------------------------------- block model
// A text item is a document of blocks (spec §7). Legacy text items that only
// carry a flat `value` + `runs` are migrated to a single/multi paragraph.
export const BLOCK_TYPES = ['paragraph', 'heading', 'list', 'table'];
export const HEADING_SCALE = { 1: 2, 2: 1.6, 3: 1.35, 4: 1.2, 5: 1.1, 6: 1 };
export const DEFAULT_TABLE_BORDER = { color: '#333333', width: 1 };
export const DEFAULT_COL_WIDTH = 90;
export const DEFAULT_ROW_HEIGHT = 24;

function asAlign(a, fallback = 'left') { return ALIGNS.includes(a) ? a : fallback; }
function asDir(d, fallback = 'ltr') { return d === 'rtl' ? 'rtl' : (d === 'ltr' ? 'ltr' : fallback); }

export function normalizeCell(cell) {
  const value = String(cell?.value ?? '');
  return { value, runs: normalizeRuns(cell?.runs, value.length), align: asAlign(cell?.align), direction: asDir(cell?.direction) };
}

export function normalizeTableBlock(b) {
  const rowsIn = Array.isArray(b?.rows) ? b.rows : [];
  const columnsIn = Array.isArray(b?.columns) ? b.columns : [];
  let nCols = columnsIn.length;
  for (const r of rowsIn) nCols = Math.max(nCols, (r?.cells || []).length);
  nCols = Math.max(1, nCols);
  const columns = [];
  for (let i = 0; i < nCols; i++) {
    const w = Number(columnsIn[i]?.width);
    columns.push({ width: Number.isFinite(w) && w > 0 ? w : DEFAULT_COL_WIDTH });
  }
  const srcRows = rowsIn.length ? rowsIn : [{ cells: [] }];
  const rows = srcRows.map(r => {
    const cells = [];
    for (let i = 0; i < nCols; i++) cells.push(normalizeCell((r?.cells || [])[i]));
    const h = Number(r?.height);
    return { height: Number.isFinite(h) && h > 0 ? h : DEFAULT_ROW_HEIGHT, cells };
  });
  const border = b?.border || {};
  const out = {
    type: 'table',
    dir: asDir(b?.dir),
    border: {
      color: typeof border.color === 'string' && border.color ? border.color : DEFAULT_TABLE_BORDER.color,
      width: Number.isFinite(+border.width) && +border.width >= 0 ? Math.min(12, +border.width) : DEFAULT_TABLE_BORDER.width,
    },
    columns,
    rows,
  };
  const ox = Number.isFinite(+b?.offsetX) ? +b.offsetX : 0;
  if (ox) out.offsetX = ox;
  return out;
}

export function normalizeBlock(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.type === 'table') return normalizeTableBlock(b);
  if (b.type === 'list') {
    const items = (Array.isArray(b.items) ? b.items : []).map(it => {
      const value = String(it?.value ?? '');
      return { value, runs: normalizeRuns(it?.runs, value.length), level: Math.max(0, Math.min(3, Math.round(it?.level || 0))) };
    });
    return { type: 'list', ordered: !!b.ordered, direction: asDir(b.direction), items: items.length ? items : [{ value: '', runs: [], level: 0 }] };
  }
  const value = String(b.value ?? '');
  if (b.type === 'heading') {
    return { type: 'heading', level: Math.max(1, Math.min(6, Math.round(b.level || 1))), value, runs: normalizeRuns(b.runs, value.length), align: asAlign(b.align), direction: asDir(b.direction) };
  }
  return { type: 'paragraph', value, runs: normalizeRuns(b.runs, value.length), align: asAlign(b.align), direction: asDir(b.direction) };
}

export function normalizeBlocks(blocks) {
  const out = (Array.isArray(blocks) ? blocks : []).map(normalizeBlock).filter(Boolean);
  return out.length ? out : [{ type: 'paragraph', value: '', runs: [], align: 'left', direction: 'ltr' }];
}

// Legacy flat value + runs -> paragraphs (split on \n, rebasing run offsets so
// the legacy model loads without loss; align/direction stay in the runs).
export function blocksFromValue(value, runs) {
  const v = String(value ?? '');
  const base = normalizeRuns(runs, v.length);
  const lines = [];
  let s = 0;
  for (let i = 0; i <= v.length; i++) if (i === v.length || v[i] === '\n') { lines.push([s, i]); s = i + 1; }
  return lines.map(([a, e]) => {
    const text = v.slice(a, e);
    const rl = [];
    for (const r of base) {
      const s2 = Math.max(a, r.start), e2 = Math.min(e, r.end);
      if (e2 > s2) rl.push({ ...r, start: s2 - a, end: e2 - a });
    }
    return { type: 'paragraph', value: text, runs: normalizeRuns(rl, text.length), align: 'left', direction: 'ltr' };
  });
}

export function itemBlocks(item) {
  if (item && Array.isArray(item.blocks) && item.blocks.length) return item.blocks;
  return blocksFromValue(item?.value, item?.runs);
}

export function blockText(b) {
  if (!b) return '';
  if (b.type === 'table') return (b.rows || []).map(r => (r.cells || []).map(c => c.value).join(' | ')).join('\n');
  if (b.type === 'list') return (b.items || []).map(it => it.value).join('\n');
  return b.value || '';
}
export function blocksText(blocks) { return (Array.isArray(blocks) ? blocks : []).map(blockText).join('\n'); }
export function itemText(item) { return blocksText(itemBlocks(item)); }

// A blank table block (used when the user inserts a table from the toolbar).
export function newTableBlock(rows = 2, cols = 2) {
  const columns = Array.from({ length: Math.max(1, cols) }, () => ({ width: DEFAULT_COL_WIDTH }));
  const rws = Array.from({ length: Math.max(1, rows) }, () => ({ height: DEFAULT_ROW_HEIGHT, cells: Array.from({ length: Math.max(1, cols) }, () => normalizeCell({ value: '' })) }));
  return normalizeTableBlock({ type: 'table', columns, rows: rws });
}

// `needsReview` flags a machine-produced item (e.g. a translation) the user has
// not looked at yet; it is persisted with the item and cleared once edited.
export function createTextItem({ value = '', box, style, runs, blocks, needsReview } = {}) {
  const v = String(value ?? '');
  const blks = (Array.isArray(blocks) && blocks.length) ? normalizeBlocks(blocks) : blocksFromValue(v, runs);
  const item = { type: 'text', box: normalizeBox(box), style: normalizeStyle(style), blocks: blks };
  if (needsReview) item.needsReview = true;
  return item;
}

// Resize a text item's content as a unit (spec §7): the base font size, every
// per-run size, and all table column widths / row heights multiply by `k`, so
// text and tables keep their relative sizes when the box is resized.
export function scaleTextItem(item, k) {
  if (!item || item.type !== 'text') return item;
  const f = Number(k);
  if (!Number.isFinite(f) || f <= 0 || f === 1) return item;
  const rs = (n) => Math.max(1, Math.round(n * 100) / 100);
  const sz = (n, d) => rs((Number.isFinite(+n) && +n > 0 ? +n : d) * f);
  item.style = normalizeStyle({ ...item.style, size: sz(item.style?.size, DEFAULT_STYLE.size) });
  const scaleRuns = (runs) => { for (const r of (runs || [])) if (Number.isFinite(+r.size) && +r.size > 0) r.size = sz(r.size, 12); };
  const blocks = itemBlocks(item);
  for (const b of blocks) {
    if (b.type === 'table') {
      for (const c of b.columns) c.width = sz(c.width, DEFAULT_COL_WIDTH);
      for (const row of b.rows) row.height = sz(row.height, DEFAULT_ROW_HEIGHT);
    } else if (b.type === 'list') {
      b.items.forEach(it => scaleRuns(it.runs));
    } else {
      scaleRuns(b.runs);
    }
  }
  if (Array.isArray(item.blocks) && item.blocks.length) { /* mutated in place */ }
  else { item.blocks = blocks; scaleRuns(item.runs); }
  return item;
}
export function createImageItem({ source = '', box, fit = 'contain' } = {}) {
  return { type: 'image', box: normalizeBox(box), source: String(source ?? ''), fit: fit === 'cover' ? 'cover' : 'contain' };
}

export function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'text') return createTextItem(item);
  if (item.type === 'image') return createImageItem(item);
  return null;
}

// Effective per-character style for a text item (base style + run overrides).
// Memoized with a WeakMap cache keyed by flow object; invalidates when value/runs/baseStyle change.
const charStylesCache = new WeakMap();

export function charStyles(flow, baseStyle) {
  // Support two calling conventions:
  // 1. charStyles(flow, baseStyle) - flow is { value, runs } from inlineState.blocks
  // 2. charStyles({ value, style, runs }) - legacy call from viewmode/exporter/richtext
  const isFlowObj = flow && typeof flow === 'object' && 'runs' in flow && !('style' in flow);
  const value = isFlowObj ? flow.value : flow?.value;
  const runs = isFlowObj ? flow.runs : flow?.runs;
  const base = baseStyle || normalizeStyle(isFlowObj ? flow.style : flow?.style);

  if (!value) return [];

  const n = String(value).length;
  const runsArray = runs || [];
  const baseKey = baseStyleKey(base);
  const runsHash = runsArray.map(r => `${r.start}:${r.end}:${r.bold ?? ''}:${r.italic ?? ''}:${r.underline ?? ''}:${r.font ?? ''}:${r.color ?? ''}:${r.size ?? ''}:${r.direction ?? ''}:${r.align ?? ''}`).join('|');
  const cacheKey = `${n}:${baseKey}:${runsHash}`;

  // Use flow object as cache key if available, otherwise create a temp object for caching
  const cacheKeyObj = isFlowObj ? flow : { __cacheKey: cacheKey };
  const cached = charStylesCache.get(cacheKeyObj);
  if (cached && cached.key === cacheKey) return cached.styles;

  const cs = new Array(n);
  for (let i = 0; i < n; i++) cs[i] = { bold: base.bold, italic: base.italic, underline: base.underline, font: base.font, color: base.color, size: base.size, direction: base.direction, align: base.align };
  for (const r of runsArray) {
    for (let i = r.start; i < r.end && i < n; i++) {
      const c = cs[i];
      if (r.bold != null) c.bold = r.bold;
      if (r.italic != null) c.italic = r.italic;
      if (r.underline != null) c.underline = r.underline;
      if (r.font) c.font = r.font;
      if (r.color) c.color = r.color;
      if (r.size) c.size = r.size;
      if (r.direction) c.direction = r.direction;
      if (r.align) c.align = r.align;
    }
  }
  charStylesCache.set(cacheKeyObj, { key: cacheKey, styles: cs });
  return cs;
}

function baseStyleKey(style) {
  return `${style.bold}:${style.italic}:${style.underline}:${style.font}:${style.color}:${style.size}:${style.direction}:${style.align}:${style.lineHeight ?? ''}`;
}

// Default item box = whole region (relative to its bbox origin).
function fullBox(points) {
  const [x0, y0, x1, y1] = bboxOf(points);
  return [0, 0, Math.max(1, Math.round(x1 - x0)), Math.max(1, Math.round(y1 - y0))];
}

// Accepts the new `{ items: [...] }` shape and migrates the legacy
// `{ type: none|text|image|table, ... }` shapes into a one-item list.
export function normalizeContent(content, points) {
  const bg = normalizeColor(content?.background);
  if (content && Array.isArray(content.items)) {
    return { background: bg, items: content.items.map(normalizeItem).filter(Boolean) };
  }
  const box = points ? fullBox(points) : [0, 0, 0, 0];
  if (!content || content.type === 'none') return { background: bg, items: [] };
  if (content.type === 'text') {
    const value = content.source?.value ?? content.value ?? '';
    return { background: bg, items: value ? [createTextItem({ value, box })] : [] };
  }
  if (content.type === 'image') {
    return { background: bg, items: content.source ? [createImageItem({ source: content.source, box })] : [] };
  }
  if (content.type === 'table') {
    const rows = (content.rows || []).map(row => ({ cells: (row.cells || []).map(c => ({ value: c.value ?? '' })) }));
    const item = rows.length ? createTextItem({ box, blocks: [{ type: 'table', rows }] }) : null;
    return { background: bg, items: item ? [item] : [] };
  }
  return { background: bg, items: [] };
}

export function normalizeRegion(region) {
  // Semantic type/status were removed from the model — drop them on load.
  delete region.type;
  delete region.status;
  if (region.geometry && region.geometry.type !== 'multipolygon') region.geometry.type = 'polygon';
  region.content = normalizeContent(region.content, regionPoints(region.geometry));
  // Locking (spec §5): an optional, additive flag. A locked region's polygon is
  // frozen, but its content items stay fully editable. Kept out of the JSON when
  // false so unlocked maps serialize exactly as before.
  if (region.locked) region.locked = true; else delete region.locked;
  return region;
}

// A locked region refuses every geometry operation (move / vertex / edge / split /
// merge / delete); its content items are unaffected.
export function isRegionLocked(region) { return !!region?.locked; }

export function regionHasContent(region) {
  return !!region.content?.items?.length;
}

// A region's background is "default" when it is the shipped white (or unset). Only a
// non-default colour is a reason to paint the mask on its own (spec §13).
export function isDefaultBackground(bg) {
  return normalizeColor(bg, DEFAULT_BACKGROUND).toLowerCase() === DEFAULT_BACKGROUND;
}

// A region is masked — its background is painted over the original, in the Edit-mode
// preview, Preview mode and the export — when it holds content *or* the user gave it a
// non-default background colour: either way there is something to draw there.
export function regionIsMasked(region) {
  return regionHasContent(region) || !isDefaultBackground(region?.content?.background);
}
export function textItems(content) {
  return (content?.items || []).filter(i => i.type === 'text');
}
export function imageItems(content) {
  return (content?.items || []).filter(i => i.type === 'image');
}
export function firstTextItem(content) {
  return textItems(content)[0] || null;
}
export function contentText(content) {
  return textItems(content).map(itemText).join('\n');
}

// Absolute [x, y, w, h] (PDF points, top-left origin) for an item inside a region.
export function itemAbsBox(points, item) {
  const [x0, y0] = bboxOf(points);
  const [bx, by, bw, bh] = normalizeBox(item.box);
  return [x0 + bx, y0 + by, bw, bh];
}
