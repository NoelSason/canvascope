import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const normalizerPath = path.resolve(__dirname, '..', 'src', 'core', 'query-normalizer.js');
const normalizerCode = fs.readFileSync(normalizerPath, 'utf8');

// Evaluate the classic-script module and read it off globalThis, same
// pattern as tests/semantic-matcher.test.mjs.
new Function(normalizerCode)();
const { CanvascopeQueryNormalizer } = globalThis;
const { ABBREV_MAP, normalizeText, expandAbbreviations, numberVariants } = CanvascopeQueryNormalizer;

test('expandAbbreviations expands compact abbreviation+number tokens (hw4 -> homework 4)', () => {
  assert.ok(expandAbbreviations('hw4').includes('homework 4'));
});

test('numberVariants covers padded/unpadded forms in both directions', () => {
  const fromUnpadded = numberVariants('homework 4');
  assert.ok(fromUnpadded.includes('homework 4'));
  assert.ok(fromUnpadded.includes('homework 04'));

  const fromPadded = numberVariants('homework 04');
  assert.ok(fromPadded.includes('homework 04'));
  assert.ok(fromPadded.includes('homework 4'));
});

test('normalizeText lowercases and strips punctuation', () => {
  assert.equal(normalizeText('  Homework #4: Due Friday!  '), 'homework 4 due friday');
});

test('expandAbbreviations is idempotent', () => {
  for (const input of ['hw4', 'mt2']) {
    const once = expandAbbreviations(input);
    const twice = expandAbbreviations(once);
    assert.equal(twice, once, `expandAbbreviations should be idempotent for "${input}"`);
  }
});

test('ABBREV_MAP includes the science-subject abbreviations', () => {
  assert.equal(ABBREV_MAP.phys, 'physics');
  assert.equal(ABBREV_MAP.bio, 'biology');
  assert.equal(ABBREV_MAP.biol, 'biology');
  assert.equal(ABBREV_MAP.chem, 'chemistry');
});

test('normalizeForEmbedding matches expandAbbreviations semantics (hw4 -> homework 4)', () => {
  assert.ok(CanvascopeQueryNormalizer.normalizeForEmbedding('hw4').includes('homework 4'));
  assert.equal(
    CanvascopeQueryNormalizer.normalizeForEmbedding('hw4'),
    expandAbbreviations('hw4')
  );
});
