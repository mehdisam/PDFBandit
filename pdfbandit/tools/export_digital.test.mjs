// Pure tests for the digitalization overlay (spec §22.1). The PDF-writing half is
// exercised in the browser; these tests keep the geometry, text coverage and status
// counters honest without a DOM or pdf-lib.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  digitalOverlayPages, digitalizationStats, digitalizationSummary, digitalizedPdfName,
} from '../src/services/export_digital.js';

const textItem = (value, box = [0, 0, 80, 20], extra = {}) => ({
  type: 'text',
  box,
  style: { size: 12, font: 'sans', color: '#111111', align: 'left', direction: 'ltr' },
  blocks: [{ type: 'paragraph', value, runs: [], align: 'left', direction: 'ltr' }],
  ...extra,
});
const imageItem = (box = [0, 0, 80, 20]) => ({ type: 'image', box, source: 'data:image/png;base64,AA==' });
const region = (id, x, y, w = 100, h = 50, extra = {}) => ({
  id,
  geometry: { type: 'polygon', points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] },
  ...extra,
});
const project = () => ({
  pages: [
    { page: 2, width: 600, height: 800, regions: [region('r4', 0, 0, 40, 40)] },
    {
      page: 1, width: 600, height: 800,
      regions: [
        region('r1', 10, 20),
        region('r2', 200, 20),
        region('r3', 300, 20, 100, 100, { detected: true, detectedType: 'IMAGE' }),
      ],
    },
  ],
});

test('overlay plan is page-ordered and uses region-relative item boxes', () => {
  const pmap = project();
  const content = {
    regions: {
      r1: { items: [textItem('Bonjour', [2, 3, 40, 12]), imageItem()] },
      r2: { items: [textItem('   ', [0, 0, 10, 10])] },
      r3: { items: [] },
      r4: { items: [textItem('Page two', [1, 2, 30, 10])] },
      // A stale entry for a region the map no longer has is inert data (spec §22).
      r99: { items: [textItem('Deleted region', [0, 0, 20, 10])] },
    },
  };
  const plan = digitalOverlayPages({ pmap, content });
  assert.deepEqual(plan.map(p => p.page), [1, 2]);
  assert.equal(plan[0].regions.length, 1);
  assert.equal(plan[0].regions[0].regionId, 'r1');
  assert.equal(plan[0].regions[0].items.length, 1, 'image items are not part of the text layer');
  assert.deepEqual(plan[0].regions[0].items[0].box, [12, 23, 40, 12]);
  assert.equal(plan[1].regions[0].regionId, 'r4');
  assert.deepEqual(plan[1].regions[0].items[0].box, [1, 2, 30, 10]);
});

test('empty text, empty entries and figures contribute no layer', () => {
  const pmap = {
    pages: [{
      page: 1, width: 600, height: 800,
      regions: [
        region('empty', 0, 0),
        region('empty-table', 100, 0),
        region('figure', 200, 0, 100, 100, { detected: true, detectedType: 'IMAGE' }),
        region('absent', 300, 0),
      ],
    }],
  };
  const emptyTable = {
    type: 'text', box: [0, 0, 80, 20],
    blocks: [{ type: 'table', columns: [], rows: [{ cells: [{ value: '' }, { value: '   ' }] }] }],
  };
  const content = {
    regions: {
      empty: { items: [textItem('')] },
      'empty-table': { items: [emptyTable] },
      figure: { items: [] },
    },
  };
  assert.deepEqual(digitalOverlayPages({ pmap, content }), []);
  assert.equal(digitalizationStats({ pmap, content, awaitingOcr: new Set() }).notCovered, 4);
});

test('stats separate extracted, awaiting OCR and not covered (figures included)', () => {
  const pmap = project();
  const content = {
    regions: {
      r1: { items: [textItem('Bonjour')] },
      r2: { items: [textItem('   ')] },
      r4: { items: [textItem('Page two')] },
    },
  };
  const stats = digitalizationStats({ pmap, content, awaitingOcr: new Set(['r2', 'r3']) });
  assert.deepEqual(stats, { regions: 4, extracted: 2, awaiting: 1, notCovered: 1, figures: 1 });
  assert.equal(digitalizationSummary(stats), '2 extracted, 1 awaiting OCR, 1 not covered');
});

test('a stale OCR flag on a text region or a figure is not counted as awaiting OCR', () => {
  const pmap = {
    pages: [{
      page: 1, width: 600, height: 800,
      regions: [
        region('text', 0, 0),
        region('figure', 100, 0, 100, 100, { detectedType: 'IMAGE' }),
      ],
    }],
  };
  const content = { regions: { text: { items: [textItem('Hello')] } } };
  const stats = digitalizationStats({ pmap, content, awaitingOcr: new Set(['text', 'figure']) });
  assert.equal(stats.extracted, 1);
  assert.equal(stats.awaiting, 0);
  assert.equal(stats.notCovered, 1);
  assert.equal(stats.figures, 1);
});

test('the status summary says exactly what stayed out', () => {
  assert.equal(digitalizationSummary({ regions: 0, extracted: 0, awaiting: 0, notCovered: 0 }), 'no mapped regions');
  assert.equal(
    digitalizationSummary({ regions: 3, extracted: 1, awaiting: 1, notCovered: 1 }),
    '1 extracted, 1 awaiting OCR, 1 not covered',
  );
  assert.equal(
    digitalizationSummary({ regions: 2, extracted: 2, awaiting: 0, notCovered: 0 }),
    '2 extracted',
  );
});

test('the output name is <stem>.digitalized.pdf', () => {
  assert.equal(digitalizedPdfName('document.pdf'), 'document.digitalized.pdf');
  assert.equal(digitalizedPdfName('UPPER.PDF'), 'UPPER.digitalized.pdf');
  assert.equal(digitalizedPdfName(''), 'document.digitalized.pdf');
});
