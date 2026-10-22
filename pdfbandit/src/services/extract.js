// The extraction primitive (spec 1.5 §18).
//
// One place turns "the source PDF under this polygon" into a block document plus
// the base-style hints an item needs. It knows nothing about translation, content
// variants or the UI: callers decide where the result is written and what to do
// with a failure. The digital path lazily delegates to the existing text-layer
// reader so there is exactly one copy of the run/line/overlap logic (and so this
// module's pure helpers can be unit-tested under Node without pdf.js/polygon-clipping).
// The scan path lazily delegates to the on-device Tesseract.js service (§22.2), so
// importing this module never loads an OCR engine or touches the DOM.
import { runsFromPerChar } from '../model/richtext.js';

// The text layer speaks in implementation reasons ('no-layer', 'empty', 'garbage');
// the spec's callers see the stable, user-facing vocabulary of §18.
const REASON = {
  'no-layer': 'no-text-layer',
  empty: 'no-text-under-polygon',
  garbage: 'garbage-text',
};

// The base style an extracted item and its runs are measured against. It must match
// main.js extractionStyle() exactly: paragraphs are laid out at the region's median
// glyph size, a short large block is a heading (bold), and the family is the generic
// sans default unless a run overrides it.
function runBase(ex, align, dir) {
  const hints = styleHintsFromExtraction(ex);
  return {
    size: hints.size, bold: !!hints.heading, italic: false, underline: false,
    font: 'sans', color: '#111111', align, direction: dir,
  };
}

// Per-character styles -> run overrides (spec 1.5 §18 "Style fidelity"). Sizes are
// approximate glyph heights rounded to whole points, and bold/italic are only ever
// *added* to the base (a heading's bold is never undone by a font name that does not
// say "bold"). Exported for tests.
export function runsFromChars(text, chars, base) {
  const n = String(text ?? '').length;
  if (!n || !Array.isArray(chars) || chars.length !== n) return [];
  const per = chars.map(c => {
    const size = Number(c?.size);
    return {
      bold: !!(base.bold || c?.bold),
      italic: !!(base.italic || c?.italic),
      underline: !!base.underline,
      font: c?.font === 'serif' || c?.font === 'mono' ? c.font : base.font,
      color: base.color,
      size: Number.isFinite(size) && size > 0 ? Math.round(size) : base.size,
      direction: base.direction,
      align: base.align,
    };
  });
  return runsFromPerChar(per, base, n, text);
}

// Map a successful text-layer read onto the block document + style hints. Lines
// become paragraphs in reading order; each carries the per-character runs the text
// layer exposed (size and family, plus bold/italic when the font name says so). The
// text-only shape (no `lines`) still yields plain paragraphs, so the contract's
// fallback stays lossless for the strings.
export function blocksFromExtraction(ex) {
  const regionDir = ex && ex.dir === 'rtl' ? 'rtl' : 'ltr';
  const lines = Array.isArray(ex?.lines) && ex.lines.length
    ? ex.lines
    : String(ex?.text ?? '').split('\n').map(text => ({ text, chars: null, dir: regionDir }));
  const blocks = [];
  for (const line of lines) {
    const value = String(line?.text ?? '');
    if (!value.trim()) continue;
    const dir = line?.dir === 'rtl' ? 'rtl' : (line?.dir === 'ltr' ? 'ltr' : regionDir);
    const align = dir === 'rtl' ? 'right' : 'left';
    const base = runBase(ex, align, dir);
    blocks.push({
      type: 'paragraph', value, runs: runsFromChars(value, line?.chars, base), align, direction: dir,
    });
  }
  return blocks;
}

export function styleHintsFromExtraction(ex) {
  const dir = ex && ex.dir === 'rtl' ? 'rtl' : 'ltr';
  return {
    size: Number(ex?.size) || 12,
    font: 'sans',
    direction: dir,
    heading: !!ex?.heading,
    sourceLang: ex?.sourceLang || 'auto',
    lineCount: Number(ex?.lineCount) || 0,
  };
}

// Map the text layer's result (success or implementation reason) onto the
// ExtractionResult contract. Pure, so the whole contract is testable without pdf.js.
export function extractionFromTextLayer(ex) {
  if (!ex || !ex.ok) return { ok: false, reason: REASON[ex?.reason] || 'no-text-under-polygon' };
  return { ok: true, blocks: blocksFromExtraction(ex), styleHints: styleHintsFromExtraction(ex) };
}

// Does this failure mean "there is no usable selectable text under this region — OCR
// is the only way it will ever get text" (spec 1.5 §20)? That covers a page with no
// text layer, a region over a raster figure on a page that has one, and a text layer
// whose glyphs are broken. Such regions are classified **awaiting OCR** (a runtime-only
// badge); every other failure just leaves the region empty with a status message. Pure,
// so callers and tests share one definition.
export function isAwaitingOcr(reason) {
  return reason === 'no-text-layer'
    || reason === 'ocr-unavailable'
    || reason === 'no-text-under-polygon'
    || reason === 'garbage-text';
}

// `pageInput` is `{ kind: 'digital', page, viewport, fonts? }` or
// `{ kind: 'scanned', image, scale?, lang?, onProgress?, recognize? }`.
// `fonts` is the optional loadedName -> { bold, italic } map (viewer.js fontStyleMap);
// `scale` converts OCR pixel boxes to PDF points and `recognize` is a test seam.
// `rings` is the region polygon in PDF points (top-left origin, scale-1 viewport).
// Returns `{ ok: true, blocks, styleHints }` or `{ ok: false, reason }`; it never
// throws, and an unreadable page is a normal failure, not an error.
export async function extractRegionContent(pageInput, rings) {
  const input = pageInput || {};
  if (input.kind === 'scanned') {
    if (!input.image) return { ok: false, reason: 'ocr-unavailable' };
    let ocr;
    try { ocr = await import('./ocr_tesseract.js'); }
    catch { return { ok: false, reason: 'ocr-unavailable' }; }
    let data;
    try {
      const recognize = typeof input.recognize === 'function' ? input.recognize : ocr.recognizeImage;
      data = await recognize(input.image, { lang: input.lang, onProgress: input.onProgress });
    } catch { return { ok: false, reason: 'ocr-unavailable' }; }
    return extractionFromTextLayer(ocr.ocrExtractionFromData(data, input.scale));
  }
  if (input.kind !== 'digital' || !input.page || !input.viewport) {
    return { ok: false, reason: 'no-text-layer' };
  }
  let extractRegionText;
  try { ({ extractRegionText } = await import('../pdf/textlayer.js')); }
  catch { return { ok: false, reason: 'no-text-layer' }; }
  let ex;
  try { ex = await extractRegionText(input.page, input.viewport, rings, input.fonts || null); }
  catch { return { ok: false, reason: 'no-text-layer' }; }
  return extractionFromTextLayer(ex);
}
