import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const smartPlannerCode = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'core', 'smart-planner.js'), 'utf8');

function loadSmartPlanner() {
  const context = {
    console,
    RAGCore: { buildCorpus: async () => [] },
    AIRouter: {},
    chrome: { tabs: { create() {} }, storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { sendMessage() {} } },
    document: {
      getElementById() { return null; },
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          className: '',
          style: {},
          innerHTML: '',
          appendChild() {},
          addEventListener() {},
          querySelector() { return null; }
        };
      }
    },
    window: {}
  };
  context.window.document = context.document;
  context.window.chrome = context.chrome;
  vm.createContext(context);
  vm.runInContext(smartPlannerCode, context);
  return context.window.SmartPlanner;
}

test('SmartPlanner normalizeStudyBlocks repairs past starts and clamps duration', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const deadline = new Date('2026-07-12T23:59:00-07:00').getTime();

  const blocks = planner.__test.normalizeStudyBlocks([
    { title: '  Replay graph traversal ', startAt: '2026-07-09T12:00:00-07:00', minutes: 240, course: ' CS 61B ' }
  ], [{ ts: deadline }], now);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, 'Replay graph traversal');
  assert.equal(blocks[0].minutes, 120);
  assert.equal(blocks[0].course, 'CS 61B');
  assert.equal(new Date(blocks[0].startAt).getTime(), now + 30 * 60 * 1000);
});

test('SmartPlanner normalizeStudyBlocks drops model blocks scheduled after last deadline', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T22:30:00-07:00').getTime();
  const deadline = new Date('2026-07-11T12:00:00-07:00').getTime();

  const blocks = planner.__test.normalizeStudyBlocks([
    { title: 'Too late', startAt: '2026-07-12T09:00:00-07:00', minutes: 60, course: 'Bio' },
    { title: 'Valid morning sprint', startAt: '2026-07-11T09:00:00-07:00', minutes: 20, course: 'Bio' }
  ], [{ ts: deadline }], now);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, 'Valid morning sprint');
  assert.equal(blocks[0].minutes, 30);
});

test('SmartPlanner normalizeStudyBlocks staggers repaired starts to avoid calendar collisions', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const deadline = new Date('2026-07-12T23:59:00-07:00').getTime();

  const blocks = planner.__test.normalizeStudyBlocks([
    { title: 'Outline project', startAt: '2026-07-09T12:00:00-07:00', minutes: 60, course: 'CS 61B' },
    { title: 'Implement project', startAt: 'not-a-date', minutes: 90, course: 'CS 61B' },
    { title: 'Review tests', startAt: '2026-07-10T10:45:00-07:00', minutes: 30, course: 'CS 61B' }
  ], [{ ts: deadline }], now);

  assert.equal(blocks.length, 3);
  assert.equal(new Date(blocks[0].startAt).getTime(), now + 30 * 60 * 1000);
  assert.equal(new Date(blocks[1].startAt).getTime(), now + 105 * 60 * 1000);
  assert.equal(new Date(blocks[2].startAt).getTime(), now + 210 * 60 * 1000);
});

test('SmartPlanner normalizeStudyBlocks moves late-night repaired starts to next morning', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T20:45:00-07:00').getTime();
  const deadline = new Date('2026-07-12T23:59:00-07:00').getTime();

  const blocks = planner.__test.normalizeStudyBlocks([
    { title: 'Morning review', startAt: 'invalid', minutes: 45, course: 'Math' }
  ], [{ ts: deadline }], now);

  assert.equal(blocks.length, 1);
  assert.equal(new Date(blocks[0].startAt).getTime(), new Date('2026-07-11T09:00:00-07:00').getTime());
});

test('SmartPlanner normalizeStudyBlocks keeps submission buffer before deadlines', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const deadline = new Date('2026-07-10T12:00:00-07:00').getTime();

  const blocks = planner.__test.normalizeStudyBlocks([
    { title: 'Finish and submit lab', startAt: '2026-07-10T11:00:00-07:00', minutes: 90, course: 'CS 61B' },
    { title: 'Too close to deadline', startAt: '2026-07-10T11:45:00-07:00', minutes: 30, course: 'CS 61B' }
  ], [{ ts: deadline }], now);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, 'Finish and submit lab');
  assert.equal(blocks[0].minutes, 30);
  assert.equal(new Date(blocks[0].startAt).getTime(), new Date('2026-07-10T11:00:00-07:00').getTime());
});

test('SmartPlanner classifyDeadline labels urgency and likely effort', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();

  const project = planner.__test.classifyDeadline({
    title: 'Final project milestone',
    ts: new Date('2026-07-10T18:00:00-07:00').getTime()
  }, now);
  assert.equal(project.urgency, 'today');
  assert.equal(project.effort, 'high');

  const discussion = planner.__test.classifyDeadline({
    title: 'Discussion check-in',
    ts: new Date('2026-07-12T09:00:00-07:00').getTime()
  }, now);
  assert.equal(discussion.urgency, 'soon');
  assert.equal(discussion.effort, 'quick');
});

test('SmartPlanner buildPlannerPrompt includes triage hints and source notes', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Final project milestone',
      courseName: 'CS 61B',
      ts: new Date('2026-07-10T18:00:00-07:00').getTime(),
      description: 'Submit design doc, implementation notes, and test evidence from the starter repo.'
    },
    {
      title: 'Reading reflection',
      courseName: 'History',
      ts: new Date('2026-07-13T09:00:00-07:00').getTime(),
      text: 'Two paragraph response on the assigned chapter.'
    }
  ], now);

  assert.match(prompt, /urgency=today, effort=high/);
  assert.match(prompt, /notes: Submit design doc, implementation notes/);
  assert.match(prompt, /Prioritize overdue\/today items first/);
  assert.match(prompt, /use the notes as source grounding/);
  assert.match(prompt, /Return ONLY a valid JSON array/);
});

test('SmartPlanner compactDeadlineText trims noisy source notes', () => {
  const planner = loadSmartPlanner();
  const snippet = planner.__test.compactDeadlineText({ description: 'Alpha\n\nBeta   Gamma Delta' }, 16);
  assert.equal(snippet, 'Alpha Beta Gamm…');
});

test('SmartPlanner buildFallbackStudyBlocks creates deadline-safe blocks when model output is unusable', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const deadline = new Date('2026-07-10T15:00:00-07:00').getTime();

  const blocks = planner.__test.buildFallbackStudyBlocks([
    { title: 'Final project checkpoint', courseName: 'CS 61B', ts: deadline }
  ], now);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].title, 'Outline and unblock: Final project checkpoint');
  assert.equal(blocks[0].course, 'CS 61B');
  assert.equal(blocks[0].minutes, 90);
  assert.equal(new Date(blocks[0].startAt).getTime(), new Date('2026-07-10T10:30:00-07:00').getTime());
  assert.equal(blocks[1].title, 'Deep work: Final project checkpoint');
  assert.ok(new Date(blocks[1].startAt).getTime() + blocks[1].minutes * 60 * 1000 <= deadline - 30 * 60 * 1000);
});

test('SmartPlanner buildFallbackStudyBlocks skips impossible same-day deadlines', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const deadline = new Date('2026-07-10T10:45:00-07:00').getTime();

  const blocks = planner.__test.buildFallbackStudyBlocks([
    { title: 'Quick quiz', courseName: 'Physics', ts: deadline }
  ], now);

  assert.equal(blocks.length, 0);
});
