// The translation service contract (spec 1.5 §23): the optional fourth argument
// carries `maxWords`, and the word count has a sensible definition for spaced and
// unspaced scripts. Providers are looked up at call time, so the tests can install
// a temporary one without touching the shipped list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countWords, makeTranslationService, translationProviders } from '../src/services/index.js';

test('countWords counts spaced words and ignores punctuation-only tokens', () => {
  assert.equal(countWords('one two three'), 3);
  assert.equal(countWords('  hello,   world!  '), 2);
  assert.equal(countWords('— 123 …'), 1);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});

test('countWords counts CJK characters as words', () => {
  assert.equal(countWords('你好世界'), 4);
  assert.equal(countWords('Hello 世界'), 3);
});

test('makeTranslationService passes maxWords through to the provider', async () => {
  let seen = null;
  translationProviders.__test_hint = {
    label: 'test',
    async translate(_text, _src, _dst, opts) { seen = opts; return { text: 'x' }; },
  };
  try {
    const svc = makeTranslationService({ provider: '__test_hint' });
    const out = await svc.translate('one two three', 'en', 'de', { maxWords: 3 });
    assert.equal(out.text, 'x');
    assert.equal(seen.maxWords, 3);
    assert.equal(seen.provider, '__test_hint');
  } finally {
    delete translationProviders.__test_hint;
  }
});

test('makeTranslationService still accepts the three-argument form', async () => {
  let seen = null;
  translationProviders.__test_plain = {
    label: 'test',
    async translate(_text, _src, _dst, opts) { seen = opts; return { text: 'y' }; },
  };
  try {
    const svc = makeTranslationService({ provider: '__test_plain' });
    await svc.translate('x', 'en', 'de');
    assert.equal(seen.maxWords, undefined);
  } finally {
    delete translationProviders.__test_plain;
  }
});

test('the stub provider honours the call shape and ignores the hint', async () => {
  const svc = makeTranslationService({ provider: 'stub' });
  const out = await svc.translate('Hallo', 'de', 'fr', { maxWords: 99 });
  assert.deepEqual(out, { text: '[fr] Hallo' });
});
