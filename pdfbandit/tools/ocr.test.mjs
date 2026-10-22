// OCR contract tests (spec §22.2). The Tesseract engine itself is browser-only; these
// tests cover the language mapping and the pure Tesseract-result → extraction mapping,
// plus the scanned branch of the §18 primitive with an injected recognizer.
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractRegionContent, isAwaitingOcr } from '../src/services/extract.js';
import { blocksFromExtraction } from '../src/services/extract.js';
import { tesseractLanguage, ocrExtractionFromData } from '../src/services/ocr_tesseract.js';

const line = (text, y0, y1, confidence = 90) => ({
  text, confidence, bbox: { x0: 0, y0, x1: 200, y1 },
});
const dataWith = (...lines) => ({
  text: lines.map(l => l.text).join('\n'),
  blocks: [{ paragraphs: [{ lines }] }],
});

test('Tesseract language codes follow the source language', () => {
  assert.equal(tesseractLanguage('en'), 'eng');
  assert.equal(tesseractLanguage('fr'), 'fra');
  assert.equal(tesseractLanguage('pt-BR'), 'por');
  assert.equal(tesseractLanguage('zh'), 'chi_sim');
  assert.equal(tesseractLanguage('zh-Hant'), 'chi_tra');
  assert.equal(tesseractLanguage('auto'), 'eng');
  assert.equal(tesseractLanguage(''), 'eng');
  assert.equal(tesseractLanguage('eng'), 'eng');
  assert.equal(tesseractLanguage('chi_sim'), 'chi_sim');
});

test('OCR lines become paragraphs with inferred size and direction', () => {
  const ex = ocrExtractionFromData(dataWith(
    line('Hello world', 0, 40),
    line('Second line', 50, 90),
  ), 4);
  assert.equal(ex.ok, true);
  assert.equal(ex.lineCount, 2);
  assert.equal(ex.text, 'Hello world\nSecond line');
  assert.equal(ex.size, 10);
  assert.equal(ex.dir, 'ltr');
  const blocks = blocksFromExtraction(ex);
  assert.deepEqual(blocks.map(b => b.value), ['Hello world', 'Second line']);
  assert.ok(blocks.every(b => b.type === 'paragraph' && b.align === 'left'));
});

test('OCR preserves RTL direction and guesses Arabic/Hebrew source', () => {
  const ar = ocrExtractionFromData(dataWith(line('مرحبا بالعالم', 0, 30)), 3);
  assert.equal(ar.ok, true);
  assert.equal(ar.dir, 'rtl');
  assert.equal(ar.sourceLang, 'ar');
  const block = blocksFromExtraction(ar)[0];
  assert.equal(block.direction, 'rtl');
  assert.equal(block.align, 'right');
});

test('OCR rejects empty and junk output as extraction failures', () => {
  assert.deepEqual(ocrExtractionFromData({ blocks: [] }, 1), { ok: false, reason: 'empty' });
  assert.deepEqual(ocrExtractionFromData(dataWith(line('!!! ???', 0, 20)), 1), { ok: false, reason: 'garbage' });
});

test('OCR drops an explicit low-confidence line when a usable line exists', () => {
  const ex = ocrExtractionFromData(dataWith(
    line('Real text', 0, 30, 95),
    line('noise', 40, 60, 5),
  ), 2);
  assert.equal(ex.ok, true);
  assert.equal(ex.lineCount, 1);
  assert.equal(ex.text, 'Real text');
});

test('scanned extraction can use an injected OCR recognizer', async () => {
  const r = await extractRegionContent({
    kind: 'scanned', image: 'data:image/png;base64,AA==', scale: 4, lang: 'fr',
    recognize: async () => dataWith(line('Bonjour le monde', 0, 40)),
  }, [[[0, 0], [100, 0], [100, 50]]]);
  assert.equal(r.ok, true);
  assert.equal(r.blocks[0].value, 'Bonjour le monde');
  assert.equal(r.styleHints.lineCount, 1);
});

test('scanned extraction reports OCR failures without inventing text', async () => {
  const noImage = await extractRegionContent({ kind: 'scanned', image: null }, []);
  assert.deepEqual(noImage, { ok: false, reason: 'ocr-unavailable' });
  const broken = await extractRegionContent({
    kind: 'scanned', image: 'data:image/png;base64,AA==',
    recognize: async () => { throw new Error('engine failed'); },
  }, []);
  assert.deepEqual(broken, { ok: false, reason: 'ocr-unavailable' });
  assert.equal(isAwaitingOcr(broken.reason), true);
});
