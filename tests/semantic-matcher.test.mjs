import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const matcherPath = path.resolve(__dirname, '..', 'v8', 'semantic-matcher.js');
const matcherCode = fs.readFileSync(matcherPath, 'utf8');

// Evaluate the SemanticMatcher code and bind it to globalThis
new Function(matcherCode + '\nglobalThis.SemanticMatcher = SemanticMatcher;')();

test('SemanticMatcher.vectorize generates normalized concept vectors', () => {
  // Empty text should return a zero vector
  const emptyVec = SemanticMatcher.vectorize('');
  assert.equal(emptyVec.EVALUATION, 0);
  assert.equal(emptyVec.MATERIAL, 0);
  assert.equal(emptyVec.TIME, 0);
  assert.equal(emptyVec.COMMUNICATION, 0);

  // Synonyms of EVALUATION
  const evalVec = SemanticMatcher.vectorize('midterm quiz final exam');
  assert.ok(evalVec.EVALUATION > 0);
  assert.equal(evalVec.MATERIAL, 0);
  assert.equal(evalVec.TIME, 0);
  assert.equal(evalVec.COMMUNICATION, 0);

  // Calculate Euclidean length to confirm normalization
  let sumSq = 0;
  for (const k in evalVec) {
    sumSq += evalVec[k] * evalVec[k];
  }
  const len = Math.sqrt(sumSq);
  assert.ok(Math.abs(len - 1.0) < 1e-6, 'Vector should be normalized to length 1.0');
});

test('SemanticMatcher.cosineSimilarity computes similarity index', () => {
  const v1 = SemanticMatcher.vectorize('When is the chemistry midterm exam due?'); // Evaluative + Temporal
  const v2 = SemanticMatcher.vectorize('Final quiz deadline schedule'); // Evaluative + Temporal
  const v3 = SemanticMatcher.vectorize('Zoom office hours email contact'); // Communication

  const sim12 = SemanticMatcher.cosineSimilarity(v1, v2);
  const sim13 = SemanticMatcher.cosineSimilarity(v1, v3);

  assert.ok(sim12 > 0.5, 'Expect high similarity for overlapping concepts');
  assert.equal(sim13, 0, 'Expect zero similarity for non-overlapping concepts');
});

test('SemanticMatcher.rrfMerge blends rank listings correctly', () => {
  const listA = [
    { title: 'Math Midterm', courseName: 'Math 101' }, // Rank 1
    { title: 'Physics Homework', courseName: 'Physics 2A' } // Rank 2
  ];

  const listB = [
    { title: 'Physics Homework', courseName: 'Physics 2A' }, // Rank 1
    { title: 'Math Midterm', courseName: 'Math 101' } // Rank 2
  ];

  const merged = SemanticMatcher.rrfMerge(listA, listB);

  // Both should be included and deduped
  assert.equal(merged.length, 2);
  
  // Since both items have the exact same sum of ranks (1st and 2nd in both lists),
  // their RRF scores are identical: 1/(60+1) + 1/(60+2) = 1/61 + 1/62.
  // The merge output order is stable.
  assert.ok(merged.some(item => item.title === 'Math Midterm'));
  assert.ok(merged.some(item => item.title === 'Physics Homework'));
});

test('SemanticMatcher.rrfMerge prefers items ranked highly across multiple lists', () => {
  const lexicalList = [
    { title: 'Math Midterm', courseName: 'Math' },      // 1
    { title: 'Biology Quiz', courseName: 'Bio' },       // 2
    { title: 'Syllabus Notes', courseName: 'General' }  // 3
  ];

  const semanticList = [
    { title: 'Biology Quiz', courseName: 'Bio' },       // 1 (Strong semantic match)
    { title: 'Math Midterm', courseName: 'Math' },      // 2 (Secondary semantic match)
    { title: 'Personal Gym', courseName: 'Personal' }   // 3 (Weak semantic match)
  ];

  const merged = SemanticMatcher.rrfMerge(lexicalList, semanticList);

  // Biology Quiz rank sum is 2 (lexical) + 1 (semantic) -> RRF Score: 1/62 + 1/61
  // Math Midterm rank sum is 1 (lexical) + 2 (semantic) -> RRF Score: 1/61 + 1/62 (identical to Biology Quiz)
  // Let's assert all items are present and merged
  assert.equal(merged.length, 4);
  assert.equal(merged[0].title, 'Math Midterm'); // Order preserved due to lexical list order dominance
  assert.equal(merged[1].title, 'Biology Quiz');
  assert.equal(merged[2].title, 'Syllabus Notes');
  assert.equal(merged[3].title, 'Personal Gym');
});
