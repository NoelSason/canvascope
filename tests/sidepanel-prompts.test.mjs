import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sidepanelHtml = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'sidepanel', 'sidepanel.html'), 'utf8');

test('sidepanel exposes assignment-context prompt chips for planning and rubric review', () => {
  assert.match(sidepanelHtml, /Make Work Plan/);
  assert.match(sidepanelHtml, /Turn this assignment into a step-by-step work plan with deliverables, dependencies, and a safe submission buffer/);
  assert.match(sidepanelHtml, /Rubric Risks/);
  assert.match(sidepanelHtml, /Extract rubric risks, hidden requirements, allowed-tool constraints, and pre-submit checks from this page/);
  assert.match(sidepanelHtml, /Office Hours Prep/);
  assert.match(sidepanelHtml, /office-hours prep sheet/);
  assert.match(sidepanelHtml, /CS debugging or repro details/);
});
