// Contract tests for the extraction primitive (spec 1.5 §18). Pure: no pdf.js
// and no DOM, so these run anywhere `node --test` runs. The digital path itself
// is exercised end-to-end by the browser smoke suite.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractRegionContent, extractionFromTextLayer, blocksFromExtraction, styleHintsFromExtraction, isAwaitingOcr, runsFromChars,
} from '../src/services/extract.js';
import { styleFromFontName } from '../src/model/richtext.js';

// Per-character styles for a line: `mark(i)` says which characters are bold, etc.
const charsFor = (text, styleFor = () => ({})) => [...text].map((ch, i) => ({ size: 12, font: 'sans', bold: false, italic: false, ...styleFor(ch, i) }));

const layer = (over = {}) => ({
  ok: true, text: 'First line\nSecond line', lineCount: 2, dir: 'ltr', size: 12,
  heading: false, sourceLang: 'auto', ...over,
});

test('blocks: one paragraph per line, in reading order', () => {
  const blocks = blocksFromExtraction(layer());
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(b => b.value), ['First line', 'Second line']);
  assert.ok(blocks.every(b => b.type === 'paragraph' && Array.isArray(b.runs) && b.runs.length === 0));
  assert.ok(blocks.every(b => b.align === 'left' && b.direction === 'ltr'));
});

test('blocks: RTL text becomes right-aligned rtl paragraphs', () => {
  const blocks = blocksFromExtraction(layer({ text: 'مرحبا بالعالم', dir: 'rtl', lineCount: 1 }));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].value, 'مرحبا بالعالم');
  assert.equal(blocks[0].align, 'right');
  assert.equal(blocks[0].direction, 'rtl');
});

test('blocks: blank lines are dropped rather than becoming empty paragraphs', () => {
  const blocks = blocksFromExtraction(layer({ text: 'A\n\n   \nB', lineCount: 4 }));
  assert.deepEqual(blocks.map(b => b.value), ['A', 'B']);
});

test('style hints: size/font/direction/heading/source/line count', () => {
  const hints = styleHintsFromExtraction(layer({ size: 28, heading: true, sourceLang: 'ar', dir: 'rtl', lineCount: 3 }));
  assert.equal(hints.size, 28);
  assert.equal(hints.font, 'sans');
  assert.equal(hints.direction, 'rtl');
  assert.equal(hints.heading, true);
  assert.equal(hints.sourceLang, 'ar');
  assert.equal(hints.lineCount, 3);
});

test('style hints: a missing size falls back to a usable default', () => {
  const hints = styleHintsFromExtraction({ ok: true, text: 'x', dir: 'ltr' });
  assert.equal(hints.size, 12);
  assert.equal(hints.direction, 'ltr');
  assert.equal(hints.sourceLang, 'auto');
  assert.equal(hints.heading, false);
});

test('contract: implementation reasons map to the spec vocabulary', () => {
  assert.deepEqual(extractionFromTextLayer({ ok: false, reason: 'no-layer' }), { ok: false, reason: 'no-text-layer' });
  assert.deepEqual(extractionFromTextLayer({ ok: false, reason: 'empty' }), { ok: false, reason: 'no-text-under-polygon' });
  assert.deepEqual(extractionFromTextLayer({ ok: false, reason: 'garbage' }), { ok: false, reason: 'garbage-text' });
  assert.deepEqual(extractionFromTextLayer({ ok: false, reason: 'something-new' }), { ok: false, reason: 'no-text-under-polygon' });
  assert.deepEqual(extractionFromTextLayer(null), { ok: false, reason: 'no-text-under-polygon' });
});

test('contract: a successful read carries blocks and styleHints only', () => {
  const r = extractionFromTextLayer(layer({ text: 'INTRODUCTION', lineCount: 1, size: 28, heading: true }));
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ['blocks', 'ok', 'styleHints']);
  assert.equal(r.blocks[0].value, 'INTRODUCTION');
  assert.equal(r.styleHints.heading, true);
});

test('scanned pages fail as ocr-unavailable without importing pdf.js', async () => {
  const r = await extractRegionContent({ kind: 'scanned', image: {}, viewport: {} }, [[[0, 0], [1, 0], [1, 1]]]);
  assert.deepEqual(r, { ok: false, reason: 'ocr-unavailable' });
});

test('a missing or non-digital input fails as no-text-layer', async () => {
  assert.deepEqual(await extractRegionContent(null, []), { ok: false, reason: 'no-text-layer' });
  assert.deepEqual(await extractRegionContent({ kind: 'digital' }, []), { ok: false, reason: 'no-text-layer' });
  assert.deepEqual(await extractRegionContent({ kind: 'other', page: {}, viewport: {} }, []), { ok: false, reason: 'no-text-layer' });
});

// §20: every failure that means "no usable selectable text under the region" classifies
// it awaiting OCR — no layer, a scan, a raster figure on a mixed page, or broken glyphs.
test('awaiting-OCR classification: every no-usable-text failure', () => {
  assert.equal(isAwaitingOcr('no-text-layer'), true);
  assert.equal(isAwaitingOcr('ocr-unavailable'), true);
  assert.equal(isAwaitingOcr('no-text-under-polygon'), true);
  assert.equal(isAwaitingOcr('garbage-text'), true);
  assert.equal(isAwaitingOcr('something-new'), false);
  assert.equal(isAwaitingOcr(undefined), false);
});

// ---- §18 style fidelity: per-character runs from the text layer ----

test('runs: a bold word inside a normal line becomes one bold run', () => {
  const text = 'Hello bold world';
  const chars = charsFor(text, (ch, i) => ({ bold: i >= 6 && i < 10 }));
  const blocks = blocksFromExtraction({
    ok: true, text, dir: 'ltr', size: 12, heading: false,
    lines: [{ text, chars, dir: 'ltr', font: 12 }],
  });
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].runs, [{ start: 6, end: 10, bold: true }]);
});

test('runs: a line whose glyphs are larger than the base carries a size run', () => {
  const text = 'Big';
  const chars = charsFor(text, () => ({ size: 24 }));
  const blocks = blocksFromExtraction({
    ok: true, text, dir: 'ltr', size: 12, heading: false,
    lines: [{ text, chars, dir: 'ltr', font: 24 }],
  });
  assert.deepEqual(blocks[0].runs, [{ start: 0, end: 3, size: 24 }]);
});

test('runs: a serif run overrides the sans base; a sans run does not', () => {
  const text = 'serif sans';
  const chars = charsFor(text, (ch, i) => ({ font: i < 5 ? 'serif' : 'sans' }));
  const blocks = blocksFromExtraction({
    ok: true, text, dir: 'ltr', size: 12, heading: false,
    lines: [{ text, chars, dir: 'ltr', font: 12 }],
  });
  assert.deepEqual(blocks[0].runs, [{ start: 0, end: 5, font: 'serif' }]);
});

test('runs: a heading item stays bold even when the font name does not say bold', () => {
  const text = 'Introduction';
  const chars = charsFor(text, () => ({ size: 28 })); // nothing detected as bold; glyphs match the base
  const blocks = blocksFromExtraction({
    ok: true, text, dir: 'ltr', size: 28, heading: true,
    lines: [{ text, chars, dir: 'ltr', font: 28 }],
  });
  assert.deepEqual(blocks[0].runs, []);
});

test('runs: no per-character data yields plain paragraphs (the lossless fallback)', () => {
  const blocks = blocksFromExtraction({ ok: true, text: 'A\nB', dir: 'ltr', size: 12, lines: [{ text: 'A', dir: 'ltr' }, { text: 'B', dir: 'ltr' }] });
  assert.ok(blocks.every(b => b.runs.length === 0));
  assert.deepEqual(blocks.map(b => b.value), ['A', 'B']);
});

test('runs: a line direction overrides the region direction on its own block', () => {
  const blocks = blocksFromExtraction({
    ok: true, text: 'right to left', dir: 'ltr', size: 12, heading: false,
    lines: [{ text: 'right to left', chars: charsFor('right to left'), dir: 'rtl', font: 12 }],
  });
  assert.equal(blocks[0].direction, 'rtl');
  assert.equal(blocks[0].align, 'right');
});

test('runsFromChars: mismatched or missing per-character data is ignored', () => {
  const base = { size: 12, bold: false, italic: false, underline: false, font: 'sans', color: '#111111', align: 'left', direction: 'ltr' };
  assert.deepEqual(runsFromChars('abc', null, base), []);
  assert.deepEqual(runsFromChars('abc', [{ size: 12 }], base), []);
  assert.deepEqual(runsFromChars('', [], base), []);
});

test('styleFromFontName: bold/italic from the BaseFont name', () => {
  assert.deepEqual(styleFromFontName('ABCDEF+Helvetica-Bold'), { bold: true, italic: false });
  assert.deepEqual(styleFromFontName('TimesNewRomanPS-ItalicMT'), { bold: false, italic: true });
  assert.deepEqual(styleFromFontName('Arial-BoldItalicMT'), { bold: true, italic: true });
  assert.deepEqual(styleFromFontName('DejaVuSansMono-Oblique'), { bold: false, italic: true });
  assert.deepEqual(styleFromFontName('Helvetica'), { bold: false, italic: false });
  assert.deepEqual(styleFromFontName(''), { bold: false, italic: false });
});
