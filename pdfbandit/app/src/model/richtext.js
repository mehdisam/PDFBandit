// Rich-text helpers: serialize item value+runs to styled HTML and parse a
// contenteditable DOM back into value + runs (overrides on the item base style).
//
// Each visual line is a <div class="rt-line"> so per-line alignment and bidi
// direction are visible while editing; lines are joined by an explicit "\n" text
// node so the DOM maps 1:1 onto the value's character offsets.
import { charStyles, normalizeRuns, normalizeStyle, DEFAULT_STYLE } from './region.js';

export const FONT_CSS = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' };

export function fontFromCss(css) {
  const c = String(css || '').toLowerCase();
  if (c.includes('mono') || c.includes('courier')) return 'mono';
  if (c.includes('sans')) return 'sans';
  if (c.includes('serif') || c.includes('times')) return 'serif';
  return 'sans';
}

// A run's weight/italic from a PDF BaseFont name (spec 1.5 §18). pdf.js's text layer
// exposes only a generic family and the glyph size, so the BaseFont name — reached
// through the page's resolved font objects — is the one per-run signal for bold/italic.
const BOLD_RE = /bold|black|heavy|semibold|demibold|extrabold|ultrabold/i;
const ITALIC_RE = /italic|oblique/i;
export function styleFromFontName(name) {
  const n = String(name || '');
  return { bold: BOLD_RE.test(n), italic: ITALIC_RE.test(n) };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

export function toHex(color) {
  const c = String(color || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return '#' + m[1].split('').map(x => x + x).join('').toLowerCase();
  m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return '#' + m[1].toLowerCase();
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
  if (m) {
    const h = (n) => (+n).toString(16).padStart(2, '0');
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  }
  return c;
}

// Per-character formatting record (a run override is a diff against this).
export function baseFmt(style) {
  const st = normalizeStyle(style);
  return {
    bold: st.bold, italic: st.italic, underline: st.underline, font: st.font,
    color: toHex(st.color), size: st.size, direction: st.direction, align: st.align,
    background: toHex(st.background),
  };
}

export function spanCss(c) {
  const p = [];
  p.push('font-weight:' + (c.bold ? '700' : '400'));
  p.push('font-style:' + (c.italic ? 'italic' : 'normal'));
  p.push('text-decoration:' + (c.underline ? 'underline' : 'none'));
  p.push('color:' + (c.color || DEFAULT_STYLE.color));
  if (c.background) p.push('background-color:' + c.background);
  p.push('font-family:' + (FONT_CSS[c.font] || FONT_CSS.sans));
  p.push('font-size:' + (c.size || DEFAULT_STYLE.size) + 'px');
  p.push('unicode-bidi:embed');
  p.push('direction:' + (c.direction === 'rtl' ? 'rtl' : 'ltr'));
  return p.join(';');
}

// Alignment is a per-line property; spans only split on character styles.
function sameStyle(a, b) {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline
    && a.font === b.font && a.color === b.color && a.size === b.size && a.direction === b.direction
    && a.background === b.background;
}

// value + runs -> HTML with one <div> per line and one <span> per run of style.
export function richToHtml(value, baseStyle, runs) {
  const v = String(value ?? '');
  if (!v) return '';
  const base = normalizeStyle(baseStyle);
  const cs = charStyles({ value: v, style: base, runs });
  const lines = [];
  let s = 0;
  for (let i = 0; i <= v.length; i++) if (i === v.length || v[i] === '\n') { lines.push([s, i]); s = i + 1; }
  const divs = lines.map(([a, e]) => {
    const c0 = a < e ? cs[a] : (cs[Math.max(0, a - 1)] || base);
    const align = c0.align || base.align || 'left';
    const dir = c0.direction || base.direction || 'ltr';
    let html = '';
    let i = a;
    while (i < e) {
      const c = cs[i];
      let j = i + 1;
      while (j < e && sameStyle(cs[j], c)) j++;
      html += `<span style="${spanCss(c)}">${escapeHtml(v.slice(i, j))}</span>`;
      i = j;
    }
    return `<div class="rt-line" dir="${dir}" style="text-align:${align};direction:${dir}">${html}</div>`;
  });
  return divs.join('\n');
}

export function mergeFmt(fmt, el) {
  const f = { ...fmt };
  const tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') f.bold = true;
  if (tag === 'I' || tag === 'EM') f.italic = true;
  if (tag === 'U') f.underline = true;
  const st = el.style;
  if (st) {
    const fw = parseInt(st.fontWeight, 10);
    if (st.fontWeight === 'bold' || (Number.isFinite(fw) && fw >= 600)) f.bold = true;
    else if (st.fontWeight === 'normal' || (Number.isFinite(fw) && fw < 600)) f.bold = false;
    if (st.fontStyle === 'italic') f.italic = true;
    else if (st.fontStyle === 'normal') f.italic = false;
    const deco = (st.textDecoration || '') + ' ' + (st.textDecorationLine || '');
    if (deco.includes('underline')) f.underline = true;
    else if (deco.includes('none')) f.underline = false;
    if (st.color) f.color = toHex(st.color);
    if (st.backgroundColor) f.background = toHex(st.backgroundColor);
    if (st.fontFamily) f.font = fontFromCss(st.fontFamily);
    if (st.fontSize) { const sz = parseFloat(st.fontSize); if (Number.isFinite(sz) && sz > 0) f.size = sz; }
    if (st.direction === 'rtl' || st.direction === 'ltr') f.direction = st.direction;
    if (['left', 'right', 'center', 'justify'].includes(st.textAlign)) f.align = st.textAlign;
  }
  if (el.getAttribute) {
    const face = el.getAttribute('face');
    if (face) f.font = fontFromCss(face);
    const color = el.getAttribute('color');
    if (color) f.color = toHex(color);
    const dir = el.getAttribute('dir');
    if (dir === 'rtl' || dir === 'ltr') f.direction = dir;
    const al = el.getAttribute('align');
    if (['left', 'right', 'center', 'justify'].includes(al)) f.align = al;
  }
  return f;
}

export function runsFromPerChar(per, base, n, text) {
  const b = baseFmt(base);
  const runs = [];
  let i = 0;
  while (i < per.length) {
    const c = per[i];
    let j = i + 1;
    if (text[i] !== '\n') while (j < per.length && text[j] !== '\n' && sameStyle(c, per[j])) j++;
    const o = { start: i, end: j };
    if (c.bold !== b.bold) o.bold = c.bold;
    if (c.italic !== b.italic) o.italic = c.italic;
    if (c.underline !== b.underline) o.underline = c.underline;
    if (c.font !== b.font) o.font = c.font;
    if (c.color !== b.color) o.color = c.color;
    if (c.size !== b.size) o.size = c.size;
    if (c.direction !== b.direction) o.direction = c.direction;
    if (c.align !== b.align) o.align = c.align;
    if (c.background !== b.background) o.background = c.background;
    if (o.bold !== undefined || o.italic !== undefined || o.underline !== undefined || o.font !== undefined
        || o.color !== undefined || o.size !== undefined || o.direction !== undefined || o.align !== undefined
        || o.background !== undefined) runs.push(o);
    i = j;
  }
  return normalizeRuns(runs, n);
}

// Apply a format to a character range. For bold/italic/underline, `value ===
// undefined` toggles the state at the range start. Alignment expands the range
// to the whole line(s) it touches (paragraph-level alignment).
export function applyFormatToRuns(text, baseStyle, runs, start, end, key, value) {
  const n = String(text ?? '').length;
  if (!n || start >= end) return normalizeRuns(runs, n);
  const prop = key === 'dir' ? 'direction' : key;
  const cs = charStyles({ value: text, style: baseStyle, runs });
  let s = Math.max(0, Math.min(n, start));
  let e = Math.max(s, Math.min(n, end));
  if (prop === 'align') {
    while (s > 0 && text[s - 1] !== '\n') s--;
    while (e < n && text[e] !== '\n') e++;
  }
  let v = value;
  if (key === 'bold' || key === 'italic' || key === 'underline') {
    if (value === undefined) v = !(cs[s] ? cs[s][key] : false);
  }
  if (key === 'background') {
    // background is a direct color value, not a toggle
  }
  if (prop === 'size') v = Math.max(4, Math.min(200, Number(value) || DEFAULT_STYLE.size));
  const per = cs.map(c => ({ ...c }));
  for (let i = s; i < e && i < n; i++) per[i][prop] = v;
  return runsFromPerChar(per, baseStyle, n, text);
}

// contenteditable DOM -> { value, runs } (runs are overrides vs the base style).
export function readRich(root, baseStyle) {
  const base = baseFmt(baseStyle);
  let text = '';
  const chars = [];
  const walk = (node, fmt) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        for (const ch of child.nodeValue) {
          if (ch === '\u200b') continue; // zero-width caret marker, not a character
          if (ch === '\n') { text += '\n'; chars.push(null); }
          else { text += ch; chars.push(fmt); }
        }
      } else if (child.nodeType === 1) {
        if (child.tagName === 'BR') { text += '\n'; chars.push(null); }
        else walk(child, mergeFmt(fmt, child));
      }
    }
  };
  walk(root, base);
  const runs = [];
  let i = 0;
  while (i < text.length) {
    const c = chars[i];
    let j = i + 1;
    while (j < text.length && (c === null ? chars[j] === null : (chars[j] !== null && sameStyle(chars[j], c)))) j++;
    if (c) {
      const o = { start: i, end: j };
      if (c.bold !== base.bold) o.bold = c.bold;
      if (c.italic !== base.italic) o.italic = c.italic;
      if (c.underline !== base.underline) o.underline = c.underline;
      if (c.font !== base.font) o.font = c.font;
      if (c.color !== base.color) o.color = c.color;
      if (c.size !== base.size) o.size = c.size;
      if (c.direction !== base.direction) o.direction = c.direction;
      if (c.align !== base.align) o.align = c.align;
      if (o.bold !== undefined || o.italic !== undefined || o.underline !== undefined || o.font !== undefined
          || o.color !== undefined || o.size !== undefined || o.direction !== undefined || o.align !== undefined) runs.push(o);
    }
    i = j;
  }
  return { value: text, runs: normalizeRuns(runs, text.length) };
}
