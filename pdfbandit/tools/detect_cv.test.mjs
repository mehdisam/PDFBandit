// Unit tests for the dependency-free classical-CV detector (spec 1.5 §19). Pure: it runs
// on plain bitmaps, so no canvas and no pdf.js are needed. The end-to-end path (render a
// scanned page, propose regions, harvest) is covered by the browser smoke suite.
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectBlocks, blocksToRegions, detectCvRegions, cvScale, toGray, cleanImageBoxes, groupTextBoxes } from '../src/services/detect_cv.js';

const blank = (w, h, v = 255) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255; }
  return { data, width: w, height: h };
};
const px = (img, x, y, v) => { const i = (y * img.width + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; };
const fill = (img, x0, y0, x1, y1, fn) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(img, x, y, fn(x, y));
};

// Text-like stripes: 3 ink rows in every 8, so the close can bridge the gaps into a block.
const striped = (img, x0, y0, x1, y1, ink = 0, paper = 255) =>
  fill(img, x0, y0, x1, y1, (x, y) => ((y - y0) % 8 < 3 ? ink : paper));

// Glyph-like type: short strokes on a line pitch. Unlike a bar, each mark is narrow, so
// the structural classifier can tell it from a ruled band or photo texture.
const glyphLine = (img, x0, y0, count = 40, { gw = 4, gh = 8, pitch = 9, ink = 0 } = {}) => {
  for (let i = 0; i < count; i++) fill(img, x0 + i * pitch, y0, x0 + i * pitch + gw, y0 + gh, () => ink);
};
const paragraph = (img, x0, y0, lines = 3, opts = {}) => {
  for (let l = 0; l < lines; l++) glyphLine(img, x0, y0 + l * 14, opts.count ?? 40, opts);
};

test('blank page proposes nothing', () => {
  assert.deepEqual(detectBlocks(blank(600, 800)), []);
});

test('a paragraph of glyph-like type becomes one TEXT proposal near its box', () => {
  const img = blank(600, 800);
  paragraph(img, 80, 90, 3);
  const blocks = detectBlocks(img);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  const b = blocks[0];
  assert.equal(b.kind, 'TEXT', `density=${b.density}`);
  assert.ok(b.x0 <= 90 && b.x1 >= 430 && b.y0 <= 96 && b.y1 >= 120, JSON.stringify(b));
});

test('a light-on-dark text band is TEXT (per-block polarity)', () => {
  const img = blank(600, 800);
  fill(img, 80, 80, 520, 200, () => 30);          // dark band on a light page
  glyphLine(img, 100, 120, 30, { ink: 240 });     // light type inside it
  const blocks = detectBlocks(img);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.equal(blocks[0].kind, 'TEXT', `density=${blocks[0].density}`);
});

test('a text line with an underline is still TEXT', () => {
  const img = blank(600, 800);
  glyphLine(img, 80, 100, 40);
  fill(img, 80, 114, 440, 116, () => 0);          // thin full-width rule under the line
  const blocks = detectBlocks(img);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.equal(blocks[0].kind, 'TEXT', `density=${blocks[0].density}`);
});

test('full-width bars are rules, not type', () => {
  const img = blank(600, 800);
  striped(img, 80, 90, 520, 270);
  const blocks = detectBlocks(img);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.equal(blocks[0].kind, 'IMAGE', `density=${blocks[0].density}`);
});

test('a flat horizontal streak is IMAGE, not type', () => {
  const img = blank(600, 800);
  fill(img, 120, 100, 280, 106, () => 0); // 160×6 wide flat mark
  px(img, 200, 112, 0);                   // a speck keeps background inside the block
  const blocks = detectBlocks(img);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.equal(blocks[0].kind, 'IMAGE', `density=${blocks[0].density}`);
});

test('a dense textured region becomes an IMAGE proposal', () => {
  const img = blank(600, 800);
  // mostly-dark textured block: local mean ~50, most pixels are ink -> high density
  fill(img, 60, 90, 540, 270, (x, y) => (x % 4 === 0 ? 200 : 0));
  const blocks = detectBlocks(img);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.equal(blocks[0].kind, 'IMAGE', `density=${blocks[0].density}`);
});

test('a random-looking texture is not split into text', () => {
  const img = blank(600, 800);
  // 1px checkerboard: every local window is texture; no line structure and no blank rows.
  fill(img, 80, 90, 520, 470, (x, y) => ((x + y) % 2 ? 0 : 255));
  const blocks = detectBlocks(img);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.equal(blocks[0].kind, 'IMAGE', `density=${blocks[0].density}`);
});

test('nested image fragments collapse to the outer figure', () => {
  const outer = { x0: 0, y0: 0, x1: 200, y1: 200, kind: 'IMAGE', density: 0.3 };
  const inner = { x0: 20, y0: 20, x1: 100, y1: 100, kind: 'IMAGE', density: 0.4 };
  const out = cleanImageBoxes([outer, inner], 10, 2);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.deepEqual([out[0].x0, out[0].y0, out[0].x1, out[0].y1], [0, 0, 200, 200]);
});

test('touching image fragments become one figure, separated ones stay apart', () => {
  const a = { x0: 0, y0: 0, x1: 50, y1: 50, kind: 'IMAGE', density: 0.3 };
  const b = { x0: 52, y0: 0, x1: 100, y1: 50, kind: 'IMAGE', density: 0.3 };
  assert.equal(cleanImageBoxes([a, b], 10, 2).length, 1);
  const c = { x0: 60, y0: 0, x1: 100, y1: 50, kind: 'IMAGE', density: 0.3 };
  assert.equal(cleanImageBoxes([a, c], 10, 2).length, 2);
});

test('specks below the size floor are dropped', () => {
  const img = blank(600, 800);
  px(img, 300, 300, 0); px(img, 301, 300, 0);
  assert.deepEqual(detectBlocks(img), []);
});

test('two separated blocks stay separate proposals', () => {
  const img = blank(600, 800);
  striped(img, 60, 90, 540, 190);
  striped(img, 60, 500, 540, 600);
  const blocks = detectBlocks(img);
  assert.equal(blocks.length, 2, JSON.stringify(blocks.map(b => [b.x0, b.y0, b.x1, b.y1])));
  assert.ok(blocks[0].y1 < blocks[1].y0, 'blocks are vertically ordered and distinct');
});

test('a dark (inverted) page still yields ink', () => {
  const img = blank(600, 800, 0);
  glyphLine(img, 80, 90, 40, { ink: 255 }); // light type on dark paper
  const blocks = detectBlocks(img);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.ok(blocks[0].y1 - blocks[0].y0 >= 8, JSON.stringify(blocks[0]));
});

test('blocksToRegions maps pixels to PDF points and adds the tier-1 margin', () => {
  const regs = blocksToRegions([{ x0: 10, y0: 20, x1: 110, y1: 70, kind: 'TEXT' }], { width: 612, height: 792 }, 2);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].type, 'TEXT');
  assert.deepEqual(regs[0].points, [[3.5, 8.5], [56.5, 8.5], [56.5, 36.5], [3.5, 36.5]]);
});

test('images are not padded by blocksToRegions', () => {
  const regs = blocksToRegions([{ x0: 10, y0: 20, x1: 110, y1: 70, kind: 'IMAGE' }], { width: 612, height: 792 }, 2);
  assert.deepEqual(regs[0].points, [[5, 10], [55, 10], [55, 35], [5, 35]]);
});

test('blocksToRegions clamps to the page', () => {
  const regs = blocksToRegions([{ x0: 0, y0: 0, x1: 1000, y1: 1000, kind: 'IMAGE' }], { width: 100, height: 200 }, 10);
  const [p] = regs;
  assert.ok(p.points.every(([x, y]) => x >= 0 && x <= 100 && y >= 0 && y <= 200), JSON.stringify(p.points));
});

test('detectCvRegions is the whole contract on an ImageData-like bitmap', () => {
  const img = blank(600, 800);
  striped(img, 60, 90, 540, 270);
  const regs = detectCvRegions({ data: img.data, width: 600, height: 800 }, { width: 600, height: 800 }, 1);
  assert.equal(regs.length, 1);
  assert.deepEqual(Object.keys(regs[0]).sort(), ['points', 'type']);
});

test('cvScale targets ~170 DPI and caps huge pages', () => {
  assert.ok(Math.abs(cvScale({ width: 612, height: 792 }) - 1600 / 792) < 1e-9);
  assert.ok(Math.abs(cvScale({ width: 3000, height: 3000 }) - 1600 / 3000) < 1e-9);
  // a small page gets the DPI target, not the cap
  assert.ok(Math.abs(cvScale({ width: 200, height: 200 }) - 170 / 72) < 1e-9);
});

test('toGray accepts RGBA and single-channel input', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
  const g = toGray(rgba, 2, 1);
  assert.ok(Math.abs(g[0] - 76) < 2 && Math.abs(g[1] - 150) < 2, `${g[0]},${g[1]}`);
  assert.deepEqual([...toGray(new Uint8ClampedArray([1, 2, 3, 4]), 2, 2)], [1, 2, 3, 4]);
});
