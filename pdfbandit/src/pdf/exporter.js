// MVP reconstruction export via pdf-lib. Never touches source bytes; builds a new PDF.
// Item-driven (spec §7/§13): mask polygons with content, then draw each item in its box.
import { PDFDocument, StandardFonts, rgb, setTextRenderingMode } from 'pdf-lib';
import { regionBBox, regionPoints } from '../model/geometry.js';
import { itemAbsBox, charStyles, normalizeColor, DEFAULT_BACKGROUND, DEFAULT_LINE_HEIGHT, itemBlocks, regionIsMasked } from '../model/region.js';
import { flowBase } from '../model/blocks.js';

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return rgb(0, 0, 0);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// The standard-font face for a style. Kept exported so the digitalization overlay uses the
// same family/weight selection as the visible reconstruction export.
export function fontForStyle(fonts, c) {
  const fam = c.font === 'serif' ? fonts.serif : c.font === 'mono' ? fonts.mono : fonts.sans;
  if (c.bold && c.italic) return fam.boldItalic;
  if (c.bold) return fam.bold;
  if (c.italic) return fam.italic;
  return fam.regular;
}

// StandardFonts are WinAnsi-only, but pdf-lib's `encodeText()` does not throw for a
// missing glyph: it UTF-8-encodes the character, which a viewer then reads as WinAnsi
// (mojibake). Probe the repertoire instead of trusting that call.
const WIN_ANSI_EXTRA = '\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178';
export function isStandardEncodable(ch) {
  if (!ch) return true;
  const cp = ch.codePointAt(0);
  if (cp === 9 || cp === 10 || cp === 13) return true;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  return WIN_ANSI_EXTRA.includes(ch);
}

// A per-character font hook lets the digitalization layer substitute a Unicode face for
// glyphs StandardFonts cannot encode (the text is invisible, so the substitute's look is
// irrelevant; its metrics and encoding are not). The normal reconstruction export has no
// hook and keeps exactly the old font choice.
function pickFont(fonts, c, ch) {
  if (typeof fonts.pick === 'function') return fonts.pick(c, ch);
  return fontForStyle(fonts, c);
}

// Set text rendering mode 3 (invisible) once per page. drawText() appends a text object
// to the page content stream and never resets text state, so every hidden run after this
// operator stays invisible while remaining selectable/searchable.
const hiddenPages = new WeakSet();
function hideText(page) {
  if (hiddenPages.has(page)) return;
  if (typeof setTextRenderingMode !== 'function') throw new Error('PDF-lib does not expose text rendering mode 3');
  page.pushOperators(setTextRenderingMode(3));
  hiddenPages.add(page);
}

async function embedImage(out, source) {
  if (!source || !source.startsWith('data:')) return null;
  const m = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(source);
  if (!m) return null;
  try {
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    if (/png/i.test(m[1])) return await out.embedPng(bytes);
    if (/jpe?g/i.test(m[1])) return await out.embedJpg(bytes);
  } catch {}
  return null;
}

// Draw one flow (paragraph / heading / list item / cell). Returns height used (pt).
// Line spacing is the item's own multiple of the font size, else the shared default — the
// export lays the lines out exactly where Preview mode does. The block floors mirror Preview
// mode: unset spacing keeps the historical 1.3 (1.35 for a list item), an explicit one is
// used as-is. Table rows keep their own height.
function spacingOf(base) {
  const v = Number(base?.lineHeight);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function drawFlowPdf(page, fonts, value, base, runs, ix, yTop, maxW, pageH, limitBottom, opts = {}) {
  const v = String(value || '');
  const cs = charStyles({ value: v, style: base, runs });
  const n = v.length;
  const sizeOf = (i) => Math.max(2, Math.min(200, Number((cs[i] || base).size) || 12));
  const widths = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = pickFont(fonts, cs[i], v[i]);
    widths[i] = opts.encodable && !opts.encodable(f, v[i]) ? 0 : f.widthOfTextAtSize(v[i], sizeOf(i));
  }
  // Invisible layers must not clip: every line is emitted even when it overflows the box,
  // because selection and search are the product here, not the visible layout.
  const bottomLimit = opts.invisible ? null : limitBottom;
  const lines = [];
  if (!n) lines.push([0, 0]);
  let start = 0;
  while (start < n) {
    if (v[start] === '\n') { lines.push([start, start]); start++; continue; }
    let x = 0, lastSpace = -1, end = start;
    while (end < n && v[end] !== '\n') {
      if (v[end] === ' ') lastSpace = end;
      if (x + widths[end] > maxW && end > start) break;
      x += widths[end]; end++;
    }
    let brk = end;
    if (end < n && v[end] === '\n') brk = end;
    else if (end < n && lastSpace >= start) brk = lastSpace;
    lines.push([start, brk]);
    start = brk;
    if (start < n && v[start] === '\n') start++;
    else while (start < n && v[start] === ' ') start++;
  }
  let yTop2 = yTop;
  const sp = spacingOf(base);
  for (const [a, b] of lines) {
    let lineMax = base.size || 12;
    for (let k = a; k < b; k++) lineMax = Math.max(lineMax, sizeOf(k));
    const lh = lineMax * (sp || DEFAULT_LINE_HEIGHT);
    if (bottomLimit != null && yTop2 + lh > bottomLimit && b > a) break;
    let lw = 0; for (let k = a; k < b; k++) lw += widths[k];
    const c0line = (a < b ? cs[a] : cs[Math.max(0, a - 1)]) || base;
    const dir = c0line.direction === 'rtl' ? 'rtl' : 'ltr';
    let align = c0line.align || base.align || 'left';
    if (dir === 'rtl' && align === 'left') align = 'right';
    let x = ix;
    if (align === 'right') x = ix + maxW - lw;
    else if (align === 'center') x = ix + (maxW - lw) / 2;
    const baselineY = pageH - (yTop2 + lineMax);
    let i = a;
    while (i < b) {
      const c0 = cs[i] || base;
      const f = pickFont(fonts, c0, v[i]);
      const enc = !opts.encodable || opts.encodable(f, v[i]);
      let j = i + 1;
      while (j < b && pickFont(fonts, cs[j], v[j]) === f && cs[j].color === c0.color && cs[j].underline === c0.underline && cs[j].size === c0.size
        && (!opts.encodable || opts.encodable(f, v[j]) === enc)) j++;
      const seg = v.slice(i, j);
      const sz = sizeOf(i);
      let w = 0;
      if (enc) {
        try { w = f.widthOfTextAtSize(seg, sz); } catch { w = 0; }
        try {
          page.drawText(seg, { x, y: baselineY, size: sz, font: f, color: hexToRgb(c0.color) });
        } catch {
          // Unsupported glyphs (e.g. a script with no available face). A digital layer
          // reports these rather than pretending the text was embedded.
          opts.onUnsupported?.(seg);
        }
      } else {
        opts.onUnsupported?.(seg);
      }
      if (c0.underline && !opts.invisible) page.drawLine({ start: { x, y: baselineY - 1 }, end: { x: x + w, y: baselineY - 1 }, thickness: Math.max(0.5, sz * 0.06), color: hexToRgb(c0.color) });
      x += w;
      i = j;
    }
    yTop2 += lh;
  }
  return yTop2 - yTop;
}

function drawTablePdf(page, fonts, block, item, ix, iy, iw, pageH, opts = {}) {
  const border = block.border || {};
  const bw = Math.max(0.2, Number(border.width) || 1);
  const widths = block.columns.map(c => Math.max(8, Number(c.width) || 90));
  const totalW = widths.reduce((a, b) => a + b, 0) || iw;
  let yTop = iy;
  for (const row of block.rows) {
    const rh = Math.max(8, Number(row.height) || 24);
    let x = ix;
    (row.cells || []).forEach((cell, ci) => {
      const cw = widths[ci] || 60;
      // A hidden layer carries the cell text only; painting table rules would change the
      // source page's appearance, which digitalization must never do.
      if (!opts.invisible) {
        page.drawRectangle({
          x, y: pageH - (yTop + rh), width: cw, height: rh,
          borderColor: hexToRgb(border.color || '#333333'), borderWidth: bw,
        });
      }
      const base = flowBase(item.style, 'paragraph', null, cell.align, cell.direction);
      drawFlowPdf(page, fonts, cell.value, base, cell.runs, x + 3, yTop + 2, Math.max(4, cw - 6), pageH, yTop + rh - 1, opts);
      x += cw;
    });
    yTop += rh;
  }
  return { height: yTop - iy, width: totalW };
}

export function drawTextItem(page, fonts, item, ix, iy, iw, ih, pageH, opts = {}) {
  if (opts.invisible) hideText(page);
  const blocks = itemBlocks(item);
  const pad = 2;
  const maxW = Math.max(4, iw - pad * 2);
  let y = iy + pad;
  const bottom = iy + ih;
  for (const block of blocks) {
    if (!opts.invisible && y > bottom) break;
    if (block.type === 'table') { y += drawTablePdf(page, fonts, block, item, ix + pad, y, maxW, pageH, opts).height; continue; }
    if (block.type === 'list') {
      const base = flowBase(item.style, 'paragraph', null, null, block.direction);
      const counters = {};
      for (const it of block.items) {
        const lvl = it.level || 0;
        counters[lvl] = (counters[lvl] || 0) + 1;
        for (const k of Object.keys(counters)) if (+k > lvl) delete counters[k];
        const mark = block.ordered ? `${counters[lvl]}.` : (lvl ? '◦' : '•');
        const f = pickFont(fonts, base, mark);
        const x0 = ix + pad + lvl * 14;
        if (opts.encodable && !opts.encodable(f, mark)) opts.onUnsupported?.(mark);
        else {
          try { page.drawText(mark, { x: x0, y: pageH - (y + (base.size || 12)), size: (base.size || 12), font: f, color: hexToRgb(base.color) }); }
          catch { opts.onUnsupported?.(mark); }
        }
        const h = drawFlowPdf(page, fonts, it.value, base, it.runs, x0 + 14, y, Math.max(4, maxW - lvl * 14 - 14), pageH, bottom, opts);
        y += Math.max(h, (base.size || 12) * (spacingOf(base) || 1.35));
        if (!opts.invisible && y > bottom) break;
      }
      continue;
    }
    const type = block.type === 'heading' ? 'heading' : 'paragraph';
    const base = flowBase(item.style, type, block.level, block.align, block.direction);
    const h = drawFlowPdf(page, fonts, block.value, base, block.runs, ix + pad, y, maxW, pageH, bottom, opts);
    y += Math.max(h, (base.size || 12) * (spacingOf(base) || 1.3));
  }
}

function fitDim(sw, sh, bw, bh, fit) {
  const ar = sw / sh, br = bw / bh;
  if (fit === 'cover') return (ar > br) ? [bh * ar, bh] : [bw, bw / ar];
  return (ar > br) ? [bw, bw / ar] : [bh * ar, bh];
}

// The three built-in families and four faces each. Shared by the visible reconstruction
// export and the digitalization overlay so the two cannot drift.
export async function embedStandardFonts(out) {
  return {
    sans: {
      regular: await out.embedFont(StandardFonts.Helvetica),
      bold: await out.embedFont(StandardFonts.HelveticaBold),
      italic: await out.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await out.embedFont(StandardFonts.HelveticaBoldOblique),
    },
    serif: {
      regular: await out.embedFont(StandardFonts.TimesRoman),
      bold: await out.embedFont(StandardFonts.TimesRomanBold),
      italic: await out.embedFont(StandardFonts.TimesRomanItalic),
      boldItalic: await out.embedFont(StandardFonts.TimesRomanBoldItalic),
    },
    mono: {
      regular: await out.embedFont(StandardFonts.Courier),
      bold: await out.embedFont(StandardFonts.CourierBold),
      italic: await out.embedFont(StandardFonts.CourierOblique),
      boldItalic: await out.embedFont(StandardFonts.CourierBoldOblique),
    },
  };
}

export async function exportReconstruction({ pmap, viewer, onProgress }) {
  const out = await PDFDocument.create();
  const fonts = await embedStandardFonts(out);
  const pages = [...pmap.pages].sort((a, b) => a.page - b.page);
  const total = pmap.source.page_count || Math.max(viewer.pageCount, pages.length);
  for (let n = 1; n <= total; n++) {
    const mapped = pages.find(p => p.page === n);
    const size = await viewer.baseSize(n);
    const page = out.addPage([size.width, size.height]);
    // background: original page raster
    try {
      const c = document.createElement('canvas');
      await viewer.renderTo(c, n, 1.2);
      const png = await out.embedPng(c.toDataURL('image/png'));
      page.drawImage(png, { x: 0, y: 0, width: size.width, height: size.height });
    } catch { page.drawRectangle({ x: 0, y: 0, width: size.width, height: size.height, color: rgb(1,1,1) }); }

    for (const r of (mapped?.regions || [])) {
      const items = r.content?.items || [];
      if (!regionIsMasked(r)) continue; // nothing to draw => original shows through
      const [x0, y0, x1, y1] = regionBBox(r.geometry);
      // mask the region area (bbox rectangle; polygon-exact clipping is a later milestone)
      page.drawRectangle({ x: x0, y: size.height - y1, width: x1 - x0, height: y1 - y0, color: hexToRgb(normalizeColor(r.content?.background, DEFAULT_BACKGROUND)) });
      for (const item of items) {
        const [ix, iy, iw, ih] = itemAbsBox(regionPoints(r.geometry), item);
        if (iw < 1 || ih < 1) continue;
        if (item.type === 'image') {
          const img = await embedImage(out, item.source);
          if (img) {
            const [dw, dh] = fitDim(img.width, img.height, iw, ih, item.fit);
            page.drawImage(img, { x: ix + (iw - dw) / 2, y: size.height - (iy + (ih - dh) / 2) - dh, width: dw, height: dh });
          }
        } else {
          drawTextItem(page, fonts, item, ix, iy, iw, ih, size.height);
        }
      }
    }
    onProgress?.(n, total);
  }
  return out.save();
}
