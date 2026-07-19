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
  assert.match(sidepanelHtml, /Exam Day Prep/);
  assert.match(sidepanelHtml, /exam-day readiness checklist/);
  assert.match(sidepanelHtml, /allowed materials, logistics, timing, weak-topic review plan/);
  assert.match(sidepanelHtml, /Office Hours Prep/);
  assert.match(sidepanelHtml, /office-hours prep sheet/);
  assert.match(sidepanelHtml, /CS debugging or repro details/);
  assert.match(sidepanelHtml, /Teach It Back/);
  assert.match(sidepanelHtml, /Run a teach-back study check/);
  assert.match(sidepanelHtml, /hint-first feedback/);
  assert.match(sidepanelHtml, /Avoid revealing graded answers/);
  assert.match(sidepanelHtml, /Study Guide/);
  assert.match(sidepanelHtml, /source-aware study guide/);
  assert.match(sidepanelHtml, /source sections to reread/);
  assert.match(sidepanelHtml, /verify AI-generated notes before submitting work/);
  assert.match(sidepanelHtml, /AI help can be wrong/);
});
