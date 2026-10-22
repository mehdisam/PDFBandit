import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileFind, countInTextItem, replaceInTextItem, replaceInBlocks,
} from '../src/model/findreplace.js';

test('plain search escapes regex characters and is case-insensitive by default', () => {
  const re = compileFind('a.b');
  assert.ok(re);
  assert.equal(re.test('A.B'), true);
  assert.equal(re.test('axb'), false);
  assert.equal(compileFind('a.b', { matchCase: true }).test('A.B'), false);
});

test('regex mode is compiled as-is and rejects invalid patterns', () => {
  assert.ok(compileFind('\\d+', { regex: true }));
  assert.equal(compileFind('(', { regex: true }), null);
  assert.equal(compileFind(''), null);
});

test('replaceInTextItem keeps surrounding run offsets and style on plain text', () => {
  const item = {
    type: 'text',
    style: { size: 12 },
    blocks: [{
      type: 'paragraph', value: 'One two three', align: 'left', direction: 'ltr',
      runs: [{ start: 4, end: 7, bold: true, color: '#f00' }],
    }],
  };
  const n = replaceInTextItem(item, compileFind('two'), 'TWO');
  assert.equal(n, 1);
  assert.equal(item.blocks[0].value, 'One TWO three');
  assert.deepEqual(item.blocks[0].runs, [{ start: 4, end: 7, bold: true, color: '#f00' }]);
});

test('replacement inherits the run style at the match start and shifts later runs', () => {
  const item = {
    type: 'text',
    blocks: [{
      type: 'paragraph', value: 'aaa bbb ccc', align: 'left', direction: 'ltr',
      runs: [{ start: 4, end: 7, italic: true }, { start: 8, end: 11, underline: true }],
    }],
  };
  replaceInTextItem(item, compileFind('bbb'), 'longer!');
  assert.equal(item.blocks[0].value, 'aaa longer! ccc');
  assert.deepEqual(item.blocks[0].runs, [
    { start: 4, end: 11, italic: true },
    { start: 12, end: 15, underline: true },
  ]);
});

test('regex capture replacement expands $1 and named groups', () => {
  const blocks = [{ type: 'paragraph', value: 'year 2024 and 2025', runs: [], align: 'left', direction: 'ltr' }];
  const re = compileFind('(\\d{4})', { regex: true });
  assert.equal(replaceInBlocks(blocks, re, '<$1>').blocks[0].value, 'year <2024> and <2025>');
  const reNamed = compileFind('(?<y>\\d{4})', { regex: true });
  assert.equal(replaceInBlocks(blocks, reNamed, '[$<y>]').blocks[0].value, 'year [2024] and [2025]');
});

test('plain replacement does not expand $1', () => {
  const blocks = [{ type: 'paragraph', value: 'a', runs: [], align: 'left', direction: 'ltr' }];
  const out = replaceInBlocks(blocks, compileFind('a'), '$1');
  assert.equal(out.blocks[0].value, '$1');
});

test('list items and table cells are searched, but matches never cross flows', () => {
  const item = {
    type: 'text',
    blocks: [
      { type: 'list', ordered: false, direction: 'ltr', items: [
        { value: 'red', runs: [], level: 0 },
        { value: 'blue', runs: [], level: 0 },
      ] },
      { type: 'table', dir: 'ltr', border: { color: '#333333', width: 1 }, columns: [{ width: 90 }], rows: [
        { height: 24, cells: [{ value: 'red cell', runs: [], align: 'left', direction: 'ltr' }] },
      ] },
    ],
  };
  const re = compileFind('red');
  assert.equal(countInTextItem(item, re), 2);
  assert.equal(replaceInTextItem(item, re, 'green'), 2);
  assert.equal(item.blocks[0].items[0].value, 'green');
  assert.equal(item.blocks[1].rows[0].cells[0].value, 'green cell');
});

test('zero-width regex matches are ignored', () => {
  const blocks = [{ type: 'paragraph', value: 'abc', runs: [], align: 'left', direction: 'ltr' }];
  const re = compileFind('^', { regex: true });
  assert.equal(replaceInBlocks(blocks, re, 'X').count, 0);
});

test('legacy value/runs items are migrated to blocks when replaced', () => {
  const item = { type: 'text', value: 'old', runs: [{ start: 0, end: 3, bold: true }] };
  assert.equal(replaceInTextItem(item, compileFind('old'), 'new'), 1);
  assert.equal(item.value, undefined);
  assert.equal(item.blocks[0].value, 'new');
});
