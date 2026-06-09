import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localAiPath = path.resolve(__dirname, '..', 'v8', 'local-ai.js');
const localAiCode = fs.readFileSync(localAiPath, 'utf8');

new Function(localAiCode + '\nglobalThis.LocalAIController = LocalAIController;')();

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
