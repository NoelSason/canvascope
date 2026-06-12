import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const embeddingsPath = path.resolve(__dirname, '..', 'src', 'core', 'local-embeddings.js');
const embeddingsCode = fs.readFileSync(embeddingsPath, 'utf8');

// Evaluate in Node mock environment
new Function(embeddingsCode + '\nglobalThis.LocalEmbeddingsController = LocalEmbeddingsController;')();

test('LocalEmbeddingsController.generateFallbackEmbedding dimensions and length', () => {
  const controller = new LocalEmbeddingsController();
  
  // Empty text should return a zero vector
  const zeroVec = controller.generateFallbackEmbedding('');
  assert.equal(zeroVec.length, 384);
  assert.ok(zeroVec.every(v => v === 0));

  // Regular text should return a normalized vector
  const vec = controller.generateFallbackEmbedding('When is the biology midterm exam due?');
  assert.equal(vec.length, 384);

  // Calculate Euclidean length to confirm normalization
  let sumSq = 0;
  for (let i = 0; i < 384; i++) {
    sumSq += vec[i] * vec[i];
  }
  const len = Math.sqrt(sumSq);
  assert.ok(Math.abs(len - 1.0) < 1e-5, 'Dense fallback vector should be normalized to length 1.0');
});

test('LocalEmbeddingsController hashSign is deterministic', () => {
  const controller = new LocalEmbeddingsController();
  const sign1 = controller.hashSign(10, 5);
  const sign2 = controller.hashSign(10, 5);
  const sign3 = controller.hashSign(12, 5);

  assert.equal(sign1, sign2, 'Hash signs should be deterministic for identical coordinates');
  assert.ok(sign1 === 1 || sign1 === -1, 'Sign must be +1 or -1');
  assert.ok(sign3 === 1 || sign3 === -1, 'Sign must be +1 or -1');
});
