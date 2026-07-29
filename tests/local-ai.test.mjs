import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localAiPath = path.resolve(__dirname, '..', 'src', 'core', 'local-ai.js');
const localAiCode = fs.readFileSync(localAiPath, 'utf8');

new Function(localAiCode + '\nglobalThis.LocalAIController = LocalAIController;\nglobalThis.__parseProxyError = parseProxyError;')();

test('LocalAIController.normalizeAvailability handles current and legacy Prompt API statuses', () => {
  const controller = new LocalAIController();

  assert.equal(controller.normalizeAvailability('available'), 'available');
  assert.equal(controller.normalizeAvailability('readily'), 'available');
  assert.equal(controller.normalizeAvailability('downloadable'), 'downloadable');
  assert.equal(controller.normalizeAvailability('after-download'), 'downloadable');
  assert.equal(controller.normalizeAvailability('downloading'), 'downloading');
  assert.equal(controller.normalizeAvailability('unavailable'), 'unavailable');
  assert.equal(controller.normalizeAvailability('no'), 'unavailable');
  assert.equal(controller.normalizeAvailability({ available: 'downloadable' }), 'downloadable');
  assert.equal(controller.normalizeAvailability(true), 'available');
  assert.equal(controller.normalizeAvailability(false), 'unavailable');
});

test('LocalAIController resolves sampling parameters within advertised model limits', () => {
  const controller = new LocalAIController();
  controller.modelParams = {
    maxTemperature: 0.4,
    maxTopK: 2
  };

  assert.equal(controller.resolveTemperature(), 0.4);
  assert.equal(controller.resolveTopK(), 2);
});

// --- Typed proxy errors ---

test('parseProxyError carries the server error copy and typed code', async () => {
  const err = await globalThis.__parseProxyError({
    status: 503,
    json: async () => ({ error: 'The AI service is busy.', code: 'UPSTREAM_BUSY' })
  });
  assert.equal(err.message, 'The AI service is busy.');
  assert.equal(err.code, 'UPSTREAM_BUSY');
});

test('parseProxyError without a code leaves err.code unset', async () => {
  const err = await globalThis.__parseProxyError({
    status: 500,
    json: async () => ({ error: 'Something went wrong.' })
  });
  assert.equal(err.message, 'Something went wrong.');
  assert.equal(err.code, undefined);
});

test('parseProxyError falls back to the HTTP status when the body is not JSON', async () => {
  const err = await globalThis.__parseProxyError({
    status: 429,
    json: async () => { throw new Error('not json'); }
  });
  assert.equal(err.message, 'Server responded with status 429');
  assert.equal(err.code, undefined);
});
