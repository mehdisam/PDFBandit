// Digitalization (spec §22.1): a copy of the source PDF with an invisible, selectable
// text layer over every region that holds text in the PDF-language variant.
//
// Pure planning is separated from PDF writing on purpose. `digitalOverlayPages()` and
// `digitalizationStats()` are usable under Node (the tests exercise geometry and
// coverage); `exportDigitalizedPdf()` imports pdf-lib and the exporter's drawing code
// lazily, so importing this module for those pure helpers never pulls in a browser
// dependency.
import { itemAbsBox, itemText } from '../model/region.js';
import { regionPoints } from '../model/geometry.js';

const FONT_FILES = {
  latin: 'NotoSans-Regular.ttf',
  arabic: 'NotoSansArabic-Regular.ttf',
  hebrew: 'NotoSansHebrew-Regular.ttf',
};

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]/;

export function digitalizedPdfName(pdfName) {
  const stem = String(pdfName || 'document.pdf').replace(/\.pdf$/i, '');
  return `${stem}.digitalized.pdf`;
}

function entryItems(content, id) {
  return content?.regions?.[id]?.items || [];
}

// Table separators are layout punctuation, not selectable text: an all-empty table
// still has a non-empty `itemText()` (`" | "`), but it would add nothing to the layer.
function hasTextContent(item) {
  if (item?.type !== 'text') return false;
  if (Array.isArray(item.blocks) && item.blocks.length) {
    return item.blocks.some(b => {
      if (b?.type === 'table') return (b.rows || []).some(row => (row.cells || []).some(c => String(c?.value || '').trim() !== ''));
      if (b?.type === 'list') return (b.items || []).some(it => String(it?.value || '').trim() !== '');
      return String(b?.value || '').trim() !== '';
    });
  }
  return itemText(item).trim() !== '';
}

function pagesInOrder(pmap) {
  return [...(pmap?.pages || [])].sort((a, b) => Number(a.page) - Number(b.page));
}

/**
 * The overlay plan, in PDF points with the map's top-left origin. Only text items with
 * actual text are included; image items, backgrounds and empty text boxes are not. A
 * region with no entry in the variant (or an entry whose only items are empty/images)
 * contributes no layer, which is how figures and opted-out regions stay uncovered.
 *
 * Returned shape: [{ page, width, height, regions: [{ regionId, items: [{ item, box }] }] }]
 * where `box` is [x, y, w, h] in the same space as region geometry.
 */
export function digitalOverlayPages({ pmap, content } = {}) {
  const out = [];
  for (const page of pagesInOrder(pmap)) {
    const regions = [];
    for (const r of page.regions || []) {
      const items = entryItems(content, r.id)
        .filter(hasTextContent)
        .map(it => ({ item: it, box: itemAbsBox(regionPoints(r.geometry), it) }));
      if (items.length) regions.push({ regionId: r.id, items });
    }
    if (regions.length) out.push({ page: page.page, width: page.width, height: page.height, regions });
  }
  return out;
}

/**
 * What digitalization actually covered. `extracted` counts regions with at least one
 * non-empty text item (the exported layer); `awaiting` counts regions with no text that
 * are classified awaiting OCR; `notCovered` is everything else (figures, opted-out or
 * empty regions), so the status can state exactly what stayed out. A stale OCR flag on a
 * detected IMAGE region is ignored, matching §20's rule that figures are never text
 * candidates.
 */
export function digitalizationStats({ pmap, content, awaitingOcr } = {}) {
  const waiting = awaitingOcr instanceof Set ? awaitingOcr : new Set(awaitingOcr || []);
  let regions = 0, extracted = 0, awaiting = 0, notCovered = 0, figures = 0;
  for (const page of pagesInOrder(pmap)) {
    for (const r of page.regions || []) {
      regions += 1;
      const hasText = entryItems(content, r.id).some(hasTextContent);
      if (hasText) extracted += 1;
      else if (r.detectedType !== 'IMAGE' && waiting.has(r.id)) awaiting += 1;
      else {
        notCovered += 1;
        if (r.detectedType === 'IMAGE') figures += 1;
      }
    }
  }
  return { regions, extracted, awaiting, notCovered, figures };
}

// A short sentence shared by the status bar and tests: what the export covered and what
// it did not. Figure/empty regions are included in `not covered`; awaiting OCR is named
// separately because it is the actionable subset.
export function digitalizationSummary(stats) {
  if (!stats || !stats.regions) return 'no mapped regions';
  const parts = [`${stats.extracted} extracted`];
  if (stats.awaiting) parts.push(`${stats.awaiting} awaiting OCR`);
  if (stats.notCovered) parts.push(`${stats.notCovered} not covered`);
  return parts.join(', ');
}

async function fetchFontBytes(file) {
  const url = new URL(`../../assets/fonts/${file}`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Noto Sans (Latin/Greek/Cyrillic), Noto Sans Arabic and Noto Sans Hebrew are vendored
// under assets/fonts. They are only loaded when a digitalized export runs. The visible
// text is hidden anyway, so one regular face per script is enough: size/family runs still
// decide metrics and per-character style switches still split the text objects.
async function embedUnicodeFonts(out) {
  const mod = await import('@pdf-lib/fontkit');
  const fontkit = mod.default || mod;
  out.registerFontkit(fontkit);
  const [latin, arabic, hebrew] = await Promise.all([
    fetchFontBytes(FONT_FILES.latin),
    fetchFontBytes(FONT_FILES.arabic),
    fetchFontBytes(FONT_FILES.hebrew),
  ]);
  return {
    latin: await out.embedFont(latin, { subset: true }),
    arabic: await out.embedFont(arabic, { subset: true }),
    hebrew: await out.embedFont(hebrew, { subset: true }),
  };
}

// StandardFonts are WinAnsi-only. Per character, keep the standard face when the
// character is in that repertoire; otherwise pick the vendored face for the script.
// The cache matters: a page of text asks the same question for every space and letter.
function makeFontPicker(fonts, standardFontFor, isStandardEncodable) {
  const cache = new Map();
  const standard = (ch) => {
    if (cache.has(ch)) return cache.get(ch);
    const ok = isStandardEncodable(ch);
    cache.set(ch, ok);
    return ok;
  };
  return (style, ch) => {
    const std = standardFontFor(fonts, style);
    if (!ch || ch === '\n' || ch === '\r' || !fonts.unicode) return std;
    if (standard(ch)) return std;
    return ARABIC.test(ch) ? fonts.unicode.arabic
      : HEBREW.test(ch) ? fonts.unicode.hebrew
      : fonts.unicode.latin;
  };
}

/**
 * Write a digitalized copy. `pdfBytes` is the untouched source; `content` is the
 * PDF-language content variant (not a live resolved map); `pmap` supplies page order,
 * geometry and detected classes. Returns the new bytes plus coverage stats and any
 * non-fatal font/encoding notes. The source bytes are never modified.
 */
export async function exportDigitalizedPdf({ pdfBytes, pmap, content, awaitingOcr, onProgress } = {}) {
  if (!pdfBytes) throw new Error('No source PDF is open');
  if (!pmap) throw new Error('No map is open');

  const PDFLib = await import('pdf-lib');
  const { PDFDocument } = PDFLib;
  const { embedStandardFonts, drawTextItem, fontForStyle, isStandardEncodable } = await import('../pdf/exporter.js');
  const out = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const fonts = await embedStandardFonts(out);
  const plan = digitalOverlayPages({ pmap, content });

  // Latin text stays on the standard faces: no font download, and no spurious warning
  // in an offline/local deployment. Only a glyph outside WinAnsi pulls in the vendored
  // faces. `isStandardEncodable` is a repertoire check, not `font.encodeText()`: pdf-lib
  // silently UTF-8-encodes unsupported standard-font characters instead of throwing.
  const needsUnicode = plan.some(p => p.regions.some(r => r.items.some(({ item }) => {
    for (const ch of itemText(item)) if (!isStandardEncodable(ch)) return true;
    return false;
  })));

  // The picker only knows the three vendored faces; this predicate keeps the drawing
  // path honest when the optional faces could not be loaded (skip + report, never let a
  // standard font emit mojibake). For a vendored face, `getCharacterSet()` is the real
  // coverage check: fontkit's `encodeText()` happily lays out an unsupported codepoint
  // as glyph 0, which extracts as NUL.
  const vendored = (font) => font === fonts.unicode?.latin || font === fonts.unicode?.arabic || font === fonts.unicode?.hebrew;
  const supports = (font, ch) => {
    const cs = font.getCharacterSet?.();
    if (!cs) return false;
    const cp = ch.codePointAt(0);
    return typeof cs.has === 'function' ? cs.has(cp) : Array.isArray(cs) ? cs.includes(cp) : false;
  };
  const encodable = (font, ch) => vendored(font) ? supports(font, ch) : isStandardEncodable(ch);
  fonts.encodable = encodable;

  let fontWarning = '';
  if (needsUnicode) {
    try {
      fonts.unicode = await embedUnicodeFonts(out);
      fonts.pick = makeFontPicker(fonts, fontForStyle, isStandardEncodable);
    } catch (e) {
      // StandardFonts still cover Latin text. Do not fail the whole export because the
      // optional Unicode faces could not be loaded; the status reports the gap.
      fontWarning = `Unicode fallback unavailable (${(e && e.message) || e})`;
    }
  }

  const byPage = new Map(plan.map(p => [p.page, p]));
  const total = out.getPageCount();
  let unsupported = 0;
  for (let n = 1; n <= total; n++) {
    const page = out.getPage(n - 1);
    const plan = byPage.get(n);
    if (plan?.regions?.length) {
      const { height } = page.getSize();
      const opts = { invisible: true, encodable: fonts.encodable, onUnsupported: () => { unsupported += 1; } };
      for (const region of plan.regions) {
        for (const { item, box } of region.items) {
          if (!(box[2] >= 1) || !(box[3] >= 1)) continue;
          drawTextItem(page, fonts, item, box[0], box[1], box[2], box[3], height, opts);
        }
      }
    }
    onProgress?.(n, total);
  }

  return {
    bytes: await out.save(),
    stats: digitalizationStats({ pmap, content, awaitingOcr }),
    unsupported,
    fontWarning,
  };
}
