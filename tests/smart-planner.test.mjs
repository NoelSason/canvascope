import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const smartPlannerCode = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'core', 'smart-planner.js'), 'utf8');

function createTestElement(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    style: {},
    innerHTML: '',
    textContent: '',
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    querySelector() { return null; }
  };
}

function loadSmartPlanner(options = {}) {
  const elements = options.elements || {};
  const context = {
    console,
    RAGCore: { buildCorpus: async () => [] },
    AIRouter: {},
    chrome: { tabs: { create() {} }, storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { sendMessage() {} } },
    document: {
      getElementById(id) { return elements[id] || null; },
      createElement(tag) { return createTestElement(tag); }
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

test('SmartPlanner findRelevantDeadlineForBlock matches model blocks to assignment deadlines', () => {
  const planner = loadSmartPlanner();
  const quizDeadline = new Date('2026-07-10T12:00:00-07:00').getTime();
  const projectDeadline = new Date('2026-07-14T23:59:00-07:00').getTime();

  const match = planner.__test.findRelevantDeadlineForBlock(
    { title: 'Practice graph quiz questions', course: 'CS 61B' },
    [
      { title: 'Graph traversal quiz', courseName: 'CS 61B', ts: quizDeadline },
      { title: 'Final project milestone', courseName: 'CS 61B', ts: projectDeadline }
    ]
  );

  assert.equal(match.title, 'Graph traversal quiz');
});

test('SmartPlanner normalizeStudyBlocks drops blocks scheduled after their matched assignment deadline', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T09:00:00-07:00').getTime();
  const quizDeadline = new Date('2026-07-10T12:00:00-07:00').getTime();
  const projectDeadline = new Date('2026-07-14T23:59:00-07:00').getTime();

  const blocks = planner.__test.normalizeStudyBlocks([
    { title: 'Practice graph quiz questions', startAt: '2026-07-10T13:00:00-07:00', minutes: 60, course: 'CS 61B' },
    { title: 'Outline final project milestone', startAt: '2026-07-10T13:00:00-07:00', minutes: 60, course: 'CS 61B' }
  ], [
    { title: 'Graph traversal quiz', courseName: 'CS 61B', ts: quizDeadline },
    { title: 'Final project milestone', courseName: 'CS 61B', ts: projectDeadline }
  ], now);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, 'Outline final project milestone');
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

  const practical = planner.__test.classifyDeadline({
    title: 'Biology practicum checkoff',
    description: 'Lab practical on microscopy and technique stations.',
    ts: new Date('2026-07-11T15:00:00-07:00').getTime()
  }, now);
  assert.equal(practical.urgency, 'soon');
  assert.equal(practical.effort, 'high');

  const discussion = planner.__test.classifyDeadline({
    title: 'Discussion check-in',
    ts: new Date('2026-07-12T09:00:00-07:00').getTime()
  }, now);
  assert.equal(discussion.urgency, 'soon');
  assert.equal(discussion.effort, 'quick');
});

test('SmartPlanner inferEstimatedWorkMinutes prefers explicit workload and otherwise uses assignment heuristics', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();

  assert.equal(planner.__test.inferEstimatedWorkMinutes({
    title: 'Project checkpoint',
    description: 'Budget 2.5 hours for implementation and Gradescope submission.',
    ts: new Date('2026-07-11T12:00:00-07:00').getTime()
  }, now), 150);

  assert.equal(planner.__test.inferEstimatedWorkMinutes({
    title: 'Reading quiz',
    description: 'Short 10 points check-in.',
    ts: new Date('2026-07-11T12:00:00-07:00').getTime()
  }, now), 30);

  assert.equal(planner.__test.inferEstimatedWorkMinutes({
    title: 'Final project milestone',
    description: '100 points, include implementation report and presentation.',
    ts: new Date('2026-07-11T12:00:00-07:00').getTime()
  }, now), 270);
});

test('SmartPlanner formatPlannerDueLabel includes an explicit timezone', () => {
  const planner = loadSmartPlanner();
  const label = planner.__test.formatPlannerDueLabel(new Date('2026-07-10T18:00:00-07:00').getTime());

  assert.match(label, /\b(?:GMT|UTC|[ECMP][SD]T)\b|GMT[+-]\d{1,2}/);
});

test('SmartPlanner buildPlannerPrompt includes triage hints and source notes', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Final project milestone',
      courseName: 'CS 61B',
      ts: new Date('2026-07-10T18:00:00-07:00').getTime(),
      description: 'Submit design doc, implementation notes, and test evidence from the starter repo at https://github.com/example/starter.'
    },
    {
      title: 'Reading reflection',
      courseName: 'History',
      ts: new Date('2026-07-13T09:00:00-07:00').getTime(),
      text: 'Two paragraph response on the assigned chapter.'
    }
  ], now);

  assert.match(prompt, /urgency=today, effort=high/);
  assert.match(prompt, /resources: repo https:\/\/github\.com\/example\/starter/);
  assert.match(prompt, /notes: Submit design doc, implementation notes/);
  assert.match(prompt, /Prioritize overdue\/today items first/);
  assert.match(prompt, /use the notes as source grounding/);
  assert.match(prompt, /Return ONLY a valid JSON array/);
});

test('SmartPlanner inferAmbiguousAssignmentTitleHints flags vague Canvas titles', () => {
  const planner = loadSmartPlanner();

  assert.deepEqual(JSON.parse(JSON.stringify(planner.__test.inferAmbiguousAssignmentTitleHints({
    title: 'Module 7'
  }))), [
    'vague title: open Canvas details',
    'module label needs spec check'
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(planner.__test.inferAmbiguousAssignmentTitleHints({
    title: 'Project',
    description: 'See attached rubric'
  }))), [
    'vague title: open Canvas details',
    'details likely hidden in attachment'
  ]);
});

test('SmartPlanner buildPlannerPrompt includes ambiguous-title guardrails', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Homework 4',
      courseName: 'CS 61B',
      ts: new Date('2026-07-11T23:59:00-07:00').getTime()
    }
  ], now);

  assert.match(prompt, /ambiguous title: vague title: open Canvas details/);
  assert.match(prompt, /no source notes: verify requirements/);
});

test('SmartPlanner compactDeadlineText trims noisy source notes', () => {
  const planner = loadSmartPlanner();
  const snippet = planner.__test.compactDeadlineText({ description: 'Alpha\n\nBeta   Gamma Delta' }, 16);
  assert.equal(snippet, 'Alpha Beta Gamm…');
});

test('SmartPlanner buildAssignmentBriefMarkdown creates a copyable sourced assignment summary', () => {
  const planner = loadSmartPlanner();
  const brief = planner.__test.buildAssignmentBriefMarkdown({
    title: 'Project 2 GitHub checkpoint',
    courseName: 'CS 61B',
    sourceTitle: 'Module 4',
    url: 'https://canvas.instructure.com/courses/123/assignments/456',
    description: 'Push your repo at https://github.com/example/cs61b-proj2, run unit tests, submit to Gradescope, and include a README write-up. Covers graph traversal and Big-O analysis.'
  }, '2026-07-14T23:59:00.000Z');

  assert.match(brief, /Assignment: Project 2 GitHub checkpoint/);
  assert.match(brief, /Course: CS 61B/);
  assert.match(brief, /Due: 2026-07-14T23:59:00\.000Z/);
  assert.match(brief, /Grounding: high/);
  assert.match(brief, /- repo: https:\/\/github\.com\/example\/cs61b-proj2/);
  assert.match(brief, /- \[ \] push repo/);
  assert.match(brief, /Review focus: Big-O\/runtime, graph traversal/);
  assert.match(brief, /Questions to ask or self-test:/);
});

test('SmartPlanner inferSubmissionChecklist adds AI source verification for study tools', () => {
  const planner = loadSmartPlanner();
  const checklist = planner.__test.inferSubmissionChecklist({
    title: 'Final exam study pack',
    description: 'Use ChatGPT study mode, NotebookLM, and Anki spaced repetition flashcards, then compare every answer with the official slides.'
  });

  assert.ok(checklist.includes('verify AI study output against source'));
});

test('SmartPlanner inferAssignmentResourceLinks surfaces starter, submission, and AI study URLs', () => {
  const planner = loadSmartPlanner();
  const links = planner.__test.inferAssignmentResourceLinks({
    description: 'Clone https://github.com/example/cs61b-proj2, use starter files at https://course.edu/proj2-starter.zip, submit https://www.gradescope.com/courses/123/assignments/456, and review the AI study guide at https://notebooklm.google.com/notebook/demo.'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { label: 'repo', url: 'https://github.com/example/cs61b-proj2' },
    { label: 'starter/material', url: 'https://course.edu/proj2-starter.zip' },
    { label: 'autograder', url: 'https://www.gradescope.com/courses/123/assignments/456' },
    { label: 'ai study guide', url: 'https://notebooklm.google.com/notebook/demo' }
  ]);
});

test('SmartPlanner inferAssignmentResourceLinks recognizes classroom launch URLs', () => {
  const planner = loadSmartPlanner();
  const links = planner.__test.inferAssignmentResourceLinks({
    description: 'Open the attached materials in https://classroom.google.com/c/NzIy/sa/NjA before building the practice set in https://quizlet.com/latest-set.'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { label: 'classroom', url: 'https://classroom.google.com/c/NzIy/sa/NjA' },
    { label: 'ai study guide', url: 'https://quizlet.com/latest-set' }
  ]);
});

test('SmartPlanner inferAssignmentResourceLinks recognizes hosted coding notebooks and IDE starters', () => {
  const planner = loadSmartPlanner();
  const links = planner.__test.inferAssignmentResourceLinks({
    description: 'Use the Colab starter https://colab.research.google.com/drive/abc123 and debug in https://replit.com/@course/lab-template before checking the spec in https://github.dev/example/course.'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { label: 'starter/material', url: 'https://colab.research.google.com/drive/abc123' },
    { label: 'starter/material', url: 'https://replit.com/@course/lab-template' },
    { label: 'starter/material', url: 'https://github.dev/example/course' }
  ]);
});

test('SmartPlanner inferAssignmentResourceLinks recognizes AI tutor workspaces', () => {
  const planner = loadSmartPlanner();
  const links = planner.__test.inferAssignmentResourceLinks({
    description: 'Use study mode in https://chatgpt.com/g/g-study-helper for hints, compare with guided learning at https://gemini.google.com/app, and keep the final explanation in https://claude.ai/project/abc.'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { label: 'ai tutor', url: 'https://chatgpt.com/g/g-study-helper' },
    { label: 'ai tutor', url: 'https://gemini.google.com/app' },
    { label: 'ai tutor', url: 'https://claude.ai/project/abc' }
  ]);
});

test('SmartPlanner inferAssignmentResourceLinks recognizes lecture video resources', () => {
  const planner = loadSmartPlanner();
  const links = planner.__test.inferAssignmentResourceLinks({
    description: 'Review the lecture recording at https://youtu.be/abc123 and captions in https://course.host/kaltura/media before generating practice questions.'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { label: 'lecture/video', url: 'https://youtu.be/abc123' },
    { label: 'lecture/video', url: 'https://course.host/kaltura/media' }
  ]);
});

test('SmartPlanner inferAssignmentResourceLinks recognizes Canvas, discussion, and AI transcript URLs', () => {
  const planner = loadSmartPlanner();
  const links = planner.__test.inferAssignmentResourceLinks({
    description: 'Open https://canvas.instructure.com/courses/123/assignments/456, ask followups in https://edstem.org/us/courses/789/discussion/42, and review notes at https://otter.ai/u/demo.'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { label: 'canvas', url: 'https://canvas.instructure.com/courses/123/assignments/456' },
    { label: 'discussion/help', url: 'https://edstem.org/us/courses/789/discussion/42' },
    { label: 'ai notes/transcript', url: 'https://otter.ai/u/demo' }
  ]);
});

test('SmartPlanner inferAssignmentResourceLinks recognizes newer AI note-taking and study tools', () => {
  const planner = loadSmartPlanner();
  const links = planner.__test.inferAssignmentResourceLinks({
    description: 'Review the Read AI recap at https://read.ai/meetings/demo, compare the Supernormal notes https://supernormal.com/notes/demo, and turn the Notion study page https://notion.so/class-study-guide into practice questions.'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { label: 'ai notes/transcript', url: 'https://read.ai/meetings/demo' },
    { label: 'ai notes/transcript', url: 'https://supernormal.com/notes/demo' },
    { label: 'ai study guide', url: 'https://notion.so/class-study-guide' }
  ]);
});

test('SmartPlanner inferAssignmentResourceLinks recognizes current study and transcript tools', () => {
  const planner = loadSmartPlanner();
  const links = planner.__test.inferAssignmentResourceLinks({
    description: 'Use Knowt flashcards at https://knowt.com/note/demo, StudyFetch notes https://www.studyfetch.com/course/demo, Tactiq transcript https://tactiq.io/r/demo, and Limitless meeting memory https://limitless.ai/app/demo.'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(links)), [
    { label: 'ai study guide', url: 'https://knowt.com/note/demo' },
    { label: 'ai study guide', url: 'https://www.studyfetch.com/course/demo' },
    { label: 'ai notes/transcript', url: 'https://tactiq.io/r/demo' },
    { label: 'ai notes/transcript', url: 'https://limitless.ai/app/demo' }
  ]);
});

test('SmartPlanner inferSpecDeltaHints detects changed assignment instructions', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferSpecDeltaHints({
    title: 'Project 3 revised spec',
    description: 'Updated requirements: new README section added, removed the demo video, and the deadline changed to Friday.'
  });

  assert.deepEqual(Array.from(hints), ['diff assignment spec', 'capture new requirements', 'remove stale tasks']);
});

test('SmartPlanner buildPlannerPrompt includes spec delta hints for revised coursework', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Revised project spec',
      courseName: 'CS 61B',
      ts: new Date('2026-07-11T23:59:00-07:00').getTime(),
      description: 'Clarification posted: updated assignment instructions added a required benchmark table and removed the old screenshot requirement.'
    }
  ], now);

  assert.match(prompt, /spec delta: diff assignment spec, capture new requirements, remove stale tasks/);
});

test('SmartPlanner inferMilestoneDecompositionHints detects multi-part deliverables', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferMilestoneDecompositionHints({
    title: 'Multi-part final project checkpoint',
    description: 'First submit the proposal, then implement the prototype, run tests, and upload the final demo with required rubric deliverables.'
  });

  assert.deepEqual(Array.from(hints), ['break into milestones', 'make deliverable checklist', 'order dependent steps']);
});

test('SmartPlanner buildPlannerPrompt includes milestone decomposition hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Capstone milestone',
      courseName: 'CS 194',
      ts: new Date('2026-07-13T23:59:00-07:00').getTime(),
      description: 'Multi-part checkpoint: include required proposal, implementation, tests, and final demo deliverables.'
    }
  ], now);

  assert.match(prompt, /milestone decomposition: break into milestones, make deliverable checklist, separate build\/test\/polish/);
});

test('SmartPlanner inferSubmissionChecklist detects CS workflow requirements', () => {
  const planner = loadSmartPlanner();
  const checklist = planner.__test.inferSubmissionChecklist({
    title: 'Project 2 GitHub checkpoint',
    description: 'Push your repo, run unit tests, submit to Gradescope, and include a README write-up.'
  });

  assert.deepEqual(Array.from(checklist), ['push repo', 'submit autograder', 'attach write-up', 'run tests']);
});

test('SmartPlanner buildPlannerPrompt includes submission checklist and concept review hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Programming project',
      courseName: 'CS 61B',
      ts: new Date('2026-07-10T18:00:00-07:00').getTime(),
      description: 'Push the GitHub repo, run pytest, submit on Gradescope, and attach the PDF write-up. The project covers graph BFS/DFS runtime complexity.'
    }
  ], now);

  assert.match(prompt, /checklist: push repo, submit autograder, attach write-up, run tests/);
  assert.match(prompt, /review: Big-O\/runtime, graph traversal/);
});

test('SmartPlanner inferConceptReviewHints detects CS weak-spot topics', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferConceptReviewHints({
    title: 'Concurrency debugging lab',
    description: 'Fix race conditions with locks and explain heap vs stack memory behavior.'
  });

  assert.deepEqual(Array.from(hints), ['concurrency pitfalls', 'memory model']);
});

test('SmartPlanner inferWeakConceptBacklogHints turns confusion and misses into review actions', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferWeakConceptBacklogHints({
    title: 'Graphs office hours prep',
    description: 'I am stuck and confused by BFS mistakes from the last practice set; ask the TA on EdStem.'
  });

  assert.deepEqual(Array.from(hints), ['mark weak concept', 'add mistake to review queue', 'prepare help question']);
});

test('SmartPlanner buildPlannerPrompt includes weak concept backlog hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Algorithms weak spots review',
      courseName: 'CS 61B',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Review confusing graph traversal misses and prepare questions for office hours.'
    }
  ], now);

  assert.match(prompt, /weak concept backlog: mark weak concept, add mistake to review queue, prepare help question/);
});

test('SmartPlanner inferStudyPhases starts open-note exams with source-pack building', () => {
  const planner = loadSmartPlanner();
  const phases = planner.__test.inferStudyPhases({
    title: 'Open-note algorithms midterm',
    description: 'Notes allowed. Bring a one-page reference sheet and use the study guide to prepare.'
  });

  assert.deepEqual(Array.from(phases), ['Build source pack', 'Active recall drill', 'Practice problems']);
});

test('SmartPlanner inferExecutionPlanHints breaks CS projects into safe work blocks', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const hints = planner.__test.inferExecutionPlanHints({
    title: 'Programming project milestone',
    ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
    description: 'Clone the GitHub starter repo, implement the core parser, run tests, and submit to Gradescope.'
  }, now);

  assert.deepEqual(Array.from(hints), ['read spec and clone starter', 'implement core path', 'test and submit early', 'submit safety buffer']);
});

test('SmartPlanner buildPlannerPrompt includes execution-plan hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'CS compiler project',
      courseName: 'CS 164',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Use the starter repo, implement parsing, run pytest, and submit to the autograder.'
    }
  ], now);

  assert.match(prompt, /execution plan: read spec and clone starter, implement core path, test and submit early, submit safety buffer/);
});

test('SmartPlanner inferCsWorkflowHints flags invariant and fuzz testing work', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferCsWorkflowHints({
    title: 'Parser project randomized tests',
    description: 'Implement the AST parser, list edge cases, add property-based fuzzing for invariants, then run unit tests before the autograder.'
  });

  assert.deepEqual(Array.from(hints), ['read spec first', 'implement core path', 'list edge cases', 'add invariant tests']);
});

test('SmartPlanner inferCommandSnippetHints detects runnable CS assignment commands', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferCommandSnippetHints({
    title: 'Project setup and tests',
    description: 'Run `npm install`, then `npm test`. Include sample input/stdout and update the README with how to run it.'
  });

  assert.deepEqual(Array.from(hints), ['extract runnable commands', 'verify command sequence', 'save terminal evidence']);
});

test('SmartPlanner buildPlannerPrompt includes command-snippet study hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'CLI lab',
      courseName: 'CS 61C',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Follow the Makefile, run `make test`, capture terminal output, and submit the README.'
    }
  ], now);

  assert.match(prompt, /command snippets: extract runnable commands, verify command sequence, save terminal evidence/);
});

test('SmartPlanner inferConceptReviewHints detects networking and security review topics', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferConceptReviewHints({
    title: 'Internet protocols and auth review',
    description: 'Trace TCP, HTTP, DNS routing, encryption, OAuth, and hashing before the quiz.'
  });

  assert.deepEqual(Array.from(hints), ['networking fundamentals', 'security model']);
});

test('SmartPlanner inferConceptReviewHints detects systems and compiler review topics', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferConceptReviewHints({
    title: 'Compiler and OS project review',
    description: 'Trace parser AST output, type checking, kernel syscalls, paging, and scheduler tradeoffs.'
  });

  assert.deepEqual(Array.from(hints), ['operating systems', 'compilers/parsing']);
});

test('SmartPlanner inferActiveRecallQuestions creates systems-specific prompts', () => {
  const planner = loadSmartPlanner();
  const questions = planner.__test.inferActiveRecallQuestions({
    title: 'Raft and virtual memory lab',
    description: 'Compare consensus replication failures with OS paging and kernel process scheduling.'
  }, 4);

  assert.match(questions.join('\n'), /Which OS abstraction, invariant, or resource tradeoff explains Raft and virtual memory lab\?/);
  assert.match(questions.join('\n'), /What failure mode or consistency tradeoff should you test for Raft and virtual memory lab\?/);
});

test('SmartPlanner inferTutorContextPackHints detects materials to gather for AI tutoring', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferTutorContextPackHints({
    title: 'Project 3 revision',
    description: 'Use the rubric, starter code examples, and previous TA feedback before resubmitting.'
  });

  assert.deepEqual(Array.from(hints), ['attach rubric', 'include examples', 'include prior feedback']);
});

test('SmartPlanner inferEvidencePackHints prepares source-grounded AI study packets', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferEvidencePackHints({
    title: 'NotebookLM literature review',
    description: 'Collect research paper quotes with DOI citations, then map each thesis claim to sources before asking an AI assistant.'
  });

  assert.deepEqual(Array.from(hints), ['collect quotable snippets', 'capture citation metadata', 'map claims to sources']);
});

test('SmartPlanner inferFeedbackLoopHints detects AI tutor practice feedback loops', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferFeedbackLoopHints({
    title: 'Mock exam correction pass',
    description: 'Take the practice exam before notes, compare missed answers to the official solutions, and schedule a retry with flashcards.'
  });

  assert.deepEqual(Array.from(hints), ['compare against exemplar', 'log missed pattern', 'schedule retry pass']);
});

test('SmartPlanner buildPlannerPrompt includes feedback loop hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Diagnostic quiz review',
      courseName: 'CS 70',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Review wrong answers against the answer key, then retry the probability quiz without notes.'
    }
  ], now);

  assert.match(prompt, /feedback loop: compare against exemplar, log missed pattern, schedule retry pass/);
});

test('SmartPlanner inferAiQuizGenerationHints detects note-to-practice workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAiQuizGenerationHints({
    title: 'Coconote lecture quiz cleanup',
    description: 'Convert transcript notes into AI practice questions with answer explanations, then retry weak spots with spaced repetition.'
  });

  assert.deepEqual(Array.from(hints), ['generate practice set', 'convert notes to quiz', 'include answer explanations']);
});

test('SmartPlanner buildPlannerPrompt includes AI quiz-generation hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI study-mode lecture review',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Use Coconote or Quizlet to turn slides and lecture notes into practice questions with answer explanations.'
    }
  ], now);

  assert.match(prompt, /AI quiz generation: generate practice set, convert notes to quiz, include answer explanations/);
});

test('SmartPlanner inferAiQuizGenerationHints asks AI quizzes to verify source-grounded answers', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAiQuizGenerationHints({
    title: 'NotebookLM source-grounded quiz',
    description: 'Generate AI self-quiz questions from slide 12 and timestamped lecture notes, then fact-check each answer against citations.'
  });

  assert.deepEqual(Array.from(hints), ['generate practice set', 'convert notes to quiz', 'verify against source notes']);
});

test('SmartPlanner buildPlannerPrompt includes AI quiz source verification hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI quiz citation check',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Turn transcript notes into practice questions and verify answers against cited slide sources.'
    }
  ], now);

  assert.match(prompt, /AI quiz generation: generate practice set, convert notes to quiz, verify against source notes/);
});

test('SmartPlanner inferNotebookLmStudyPlanHints detects source-grounded personalized study plans', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferNotebookLmStudyPlanHints({
    title: 'NotebookLM personalized study plan',
    description: 'Upload textbook chapters and lecture notes, adapt the plan to my weak spots and target grade, then choose flashcards or an audio overview.'
  });

  assert.deepEqual(Array.from(hints), ['create source-grounded study plan', 'bundle textbook and lecture notes', 'adapt plan to learner profile']);
});

test('SmartPlanner buildPlannerPrompt includes NotebookLM study-plan hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'NotebookLM exam study plan',
      courseName: 'CS 188',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Use Gemini with textbook chapters and lecture notes to create a personalized study plan for weak spots.'
    }
  ], now);

  assert.match(prompt, /NotebookLM study plan: create source-grounded study plan, bundle textbook and lecture notes, adapt plan to learner profile/);
});

test('SmartPlanner inferDueDateAmbiguityHints detects tentative and timezone-sensitive deadlines', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferDueDateAmbiguityHints({
    title: 'Project checkpoint TBD',
    description: 'Instructor says the due time is end of day in PDT, with a separate Canvas lock date after the grace period.'
  });

  assert.deepEqual(Array.from(hints), ['confirm tentative deadline', 'verify exact due time', 'check timezone']);
});

test('SmartPlanner buildPlannerPrompt includes due-date ambiguity guardrails', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Tentative lab submission',
      courseName: 'CS 61C',
      ts: new Date('2026-07-11T23:59:00-07:00').getTime(),
      description: 'Due date is approximate and may be extended; verify midnight server time versus local time before submitting.'
    }
  ], now);

  assert.match(prompt, /due-date ambiguity: confirm tentative deadline, verify exact due time, check timezone/);
});

test('SmartPlanner inferNextClassPrepHints prepares tomorrow class materials', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const hints = planner.__test.inferNextClassPrepHints({
    title: 'AI seminar lecture prep',
    ts: new Date('2026-07-11T09:00:00-07:00').getTime(),
    description: 'Skim chapter 4 slides, bring one discussion question, and download the worksheet before class.'
  }, now);

  assert.deepEqual(Array.from(hints), ['prep before next class', 'skim assigned material', 'write one question to bring']);
});

test('SmartPlanner buildPlannerPrompt includes next-class prep hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Machine learning lecture prep',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T09:00:00-07:00').getTime(),
      description: 'Before class, skim the slides and prepare one question for discussion.'
    }
  ], now);

  assert.match(prompt, /next-class prep: prep before next class, skim assigned material, write one question to bring/);
});

test('SmartPlanner inferDueDateConfidenceLabel distinguishes Canvas, inferred, and ambiguous dates', () => {
  const planner = loadSmartPlanner();

  assert.equal(planner.__test.inferDueDateConfidenceLabel({ dueAt: '2026-07-11T23:59:00-07:00', dueSource: 'canvas_api' }), 'confirmed from Canvas');
  assert.equal(planner.__test.inferDueDateConfidenceLabel({ ts: Date.now(), description: 'Submit by 11:59 PM on Friday.' }), 'parsed from text');
  assert.equal(planner.__test.inferDueDateConfidenceLabel({ ts: Date.now(), description: 'Tentative deadline with a separate lock date after grace period.' }), 'verify due vs availability');
  assert.equal(planner.__test.inferDueDateConfidenceLabel({ title: 'Practice set' }), 'missing due date');
});

test('SmartPlanner buildPlannerPrompt includes due-date confidence labels', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Canvas confirmed lab',
      courseName: 'CS 61C',
      ts: new Date('2026-07-11T23:59:00-07:00').getTime(),
      dueSource: 'canvas_assignment_api'
    }
  ], now);

  assert.match(prompt, /due-date confidence: confirmed from Canvas/);
});

test('SmartPlanner inferHiddenDeadlineHints detects interim and live checkoff dates', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferHiddenDeadlineHints({
    title: 'Final project hidden milestones',
    description: 'Draft due before class, peer review opens Tuesday, and a demo slot checkoff must be booked before the Canvas hard deadline.'
  });

  assert.deepEqual(Array.from(hints), ['extract interim dates', 'schedule peer-review window', 'book live checkoff time']);
});

test('SmartPlanner buildPlannerPrompt includes hidden deadline extraction hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Capstone launch window',
      courseName: 'CS 194',
      ts: new Date('2026-07-14T23:59:00-07:00').getTime(),
      description: 'Proposal milestone due Monday; app opens on Friday and closes Sunday, with team code review before submission.'
    }
  ], now);

  assert.match(prompt, /hidden deadlines: extract interim dates, schedule peer-review window, separate open and close dates/);
});

test('SmartPlanner inferAssignmentQuestionQueueHints captures unresolved spec questions', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAssignmentQuestionQueueHints({
    title: 'Project spec clarification',
    description: 'I am stuck on an ambiguous rubric requirement; ask the TA in EdStem and record the answered clarification.'
  });

  assert.deepEqual(Array.from(hints), ['write unresolved question', 'quote exact spec line', 'route to help channel']);
});

test('SmartPlanner buildPlannerPrompt includes assignment question queue hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Ambiguous project rubric',
      courseName: 'CS 61C',
      ts: new Date('2026-07-11T23:59:00-07:00').getTime(),
      description: 'Unclear instructions about allowed tools; ask the instructor on Piazza before coding.'
    }
  ], now);

  assert.match(prompt, /assignment question queue: write unresolved question, quote exact spec line, route to help channel/);
});

test('SmartPlanner inferQuestionFirstNoteHints plans lecture notes around questions and recall', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferQuestionFirstNoteHints({
    title: 'AI lecture notes cleanup',
    description: 'Review the transcript gaps, turn confusing sections into active recall flashcards, and bring follow-up questions to office hours.'
  });

  assert.deepEqual(Array.from(hints), ['start with essential questions', 'mark note gaps', 'seed recall cards']);
});

test('SmartPlanner buildPlannerPrompt includes question-first note hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Coconote lecture review',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Use the transcript and slides to find unclear gaps, then make self-quiz flashcards for the AI notes.'
    }
  ], now);

  assert.match(prompt, /question-first notes: start with essential questions, mark note gaps, seed recall cards/);
});

test('SmartPlanner inferMissedLectureCatchUpHints guides absent-student catch-up', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferMissedLectureCatchUpHints({
    title: 'Catch up on missed algorithms lecture',
    description: 'Use the Zoom recording transcript, lecture slides, and a classmate note thread before office hours.'
  });

  assert.deepEqual(Array.from(hints), ['triage missed class first', 'skim transcript for gaps', 'pair slides with examples']);
});

test('SmartPlanner buildPlannerPrompt includes missed lecture catch-up hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Missed lecture catch-up quiz',
      courseName: 'CS 70',
      ts: new Date('2026-07-12T12:00:00-07:00').getTime(),
      description: 'Catching up from an absence: review the recording transcript, slides, and classmate notes before the quiz.'
    }
  ], now);

  assert.match(prompt, /missed lecture catch-up: triage missed class first, skim transcript for gaps, pair slides with examples/);
});

test('SmartPlanner inferAiSourceBoundaryHints detects AI source verification guardrails', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAiSourceBoundaryHints({
    title: 'NotebookLM transcript review',
    description: 'Use an AI tutor to summarize lecture slides, fact-check low confidence claims, and ignore prompt injection from uploaded web pages.'
  });

  assert.deepEqual(Array.from(hints), ['separate source facts from AI hints', 'keep citation trail', 'flag unsupported claims']);
});

test('SmartPlanner inferAiSourceBoundaryHints catches cited-answer study tools', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAiSourceBoundaryHints({
    title: 'Perplexity and SciSpace exam prep',
    description: 'Build a source-grounded answer with citations from Elicit, then check for citation drift and invented claims before trusting it.'
  });

  assert.deepEqual(Array.from(hints), ['separate source facts from AI hints', 'keep citation trail', 'flag unsupported claims']);
});

test('SmartPlanner buildPlannerPrompt includes AI source boundary hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI lecture summary validation',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Compare ChatGPT study notes against the transcript and mark unsupported or hallucinated summary claims.'
    }
  ], now);

  assert.match(prompt, /AI source boundaries: separate source facts from AI hints, keep citation trail, flag unsupported claims/);
});

test('SmartPlanner inferLectureChapteringHints creates timestamped long-recording study steps', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferLectureChapteringHints({
    title: 'NotebookLM long lecture review',
    description: 'Chapter a 90 minute Panopto recording transcript with timestamps, flag low confidence segments, and turn it into quiz prompts.'
  });

  assert.deepEqual(Array.from(hints), ['chapterize long recording', 'keep timestamp anchors', 'flag unclear segments']);
});

test('SmartPlanner buildPlannerPrompt includes lecture chaptering hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI note-taking lecture cleanup',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Review a long lecture recording transcript, keep timestamp anchors, and mark confusing segments before making flashcards.'
    }
  ], now);

  assert.match(prompt, /lecture chaptering: chapterize long recording, keep timestamp anchors, flag unclear segments/);
});

test('SmartPlanner inferDiscussionReplyPrepHints detects peer discussion workflow', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferDiscussionReplyPrepHints({
    title: 'Week 6 discussion replies',
    description: 'Post a response citing the reading, then reply to two peers. Use AI only for a rough draft.'
  });

  assert.deepEqual(Array.from(hints), ['draft discussion reply', 'anchor reply in course evidence', 'schedule peer-response pass']);
});

test('SmartPlanner buildPlannerPrompt includes discussion reply preparation hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI ethics forum post',
      courseName: 'CS 195',
      ts: new Date('2026-07-11T20:00:00-07:00').getTime(),
      description: 'Draft a discussion board reply with evidence from lecture slides, then respond to classmates.'
    }
  ], now);

  assert.match(prompt, /discussion reply prep: draft discussion reply, anchor reply in course evidence/);
});

test('SmartPlanner inferTeachBackHints detects explain-aloud study needs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferTeachBackHints({
    title: 'Midterm concept review',
    description: 'Practice explaining the protocol model to a study group and find weak spots.'
  });

  assert.deepEqual(Array.from(hints), ['explain aloud', 'teach key concepts', 'find explanation gaps']);
});

test('SmartPlanner inferPrivacyConsentHints detects AI notetaker consent and data-sharing needs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferPrivacyConsentHints({
    title: 'AI note-taking lecture capture for group discussion',
    description: 'Record the seminar transcript with classmates in Zoom, anonymize sensitive student data, and upload notes to an LLM assistant.'
  });

  assert.deepEqual(Array.from(hints), ['confirm recording consent', 'avoid private peer details', 'check AI data sharing']);
});

test('SmartPlanner inferPrivacyConsentHints flags named AI note tools for data-sharing review', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferPrivacyConsentHints({
    title: 'Granola and Read AI lecture recap cleanup',
    description: 'Compare Fireflies, Fathom, Tactiq, and MeetGeek notes before sharing the group-study summary.'
  });

  assert.deepEqual(Array.from(hints), ['avoid private peer details', 'check AI data sharing']);
});

test('SmartPlanner inferAiNoteQualityAuditHints detects summary verification loops', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAiNoteQualityAuditHints({
    title: 'AI lecture summary review',
    description: 'Verify the transcript summary against slide citations, then turn confusing gaps into recall questions.'
  });

  assert.deepEqual(Array.from(hints), ['verify summary against source', 'convert summary to recall prompts', 'tag unanswered questions']);
});

test('SmartPlanner inferSourceCoverageAuditHints detects AI note coverage gaps', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferSourceCoverageAuditHints({
    title: 'Coconote transcript audit',
    description: 'Compare the AI summary with lecture slides and learning objectives; flag missing or low confidence sections.'
  });

  assert.deepEqual(Array.from(hints), ['audit source coverage', 'cross-check against primary materials', 'flag coverage gaps']);
});

test('SmartPlanner buildPlannerPrompt includes source coverage audit hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI lecture summary coverage check',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Audit the NotebookLM summary against the lecture deck and mark any unsupported or omitted concepts.'
    }
  ], now);

  assert.match(prompt, /source coverage audit: audit source coverage, cross-check against primary materials, flag coverage gaps/);
});

test('SmartPlanner buildPlannerPrompt includes privacy and consent hints for recorded study workflows', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Recorded study-group transcript review',
      courseName: 'Psych',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Use an AI note-taker to transcribe classmates discussing interview data; redact confidential details before uploading.'
    }
  ], now);

  assert.match(prompt, /privacy\/consent: confirm recording consent, avoid private peer details, check AI data sharing/);
});

test('SmartPlanner inferAccessibilityStudyHints detects accessible AI note-study assets', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAccessibilityStudyHints({
    title: 'Lecture capture accessibility cleanup',
    description: 'Fix caption errors in the transcript, add alt text for slide diagrams, and respect accommodation notes.'
  });

  assert.deepEqual(Array.from(hints), ['keep transcript accessible', 'respect accommodations', 'add visual descriptions']);
});

test('SmartPlanner buildPlannerPrompt includes accessibility hints for transcript workflows', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Accessible AI lecture notes',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Clean up caption errors in the transcript and add visual descriptions for slide diagrams before review.'
    }
  ], now);

  assert.match(prompt, /accessibility: keep transcript accessible, respect accommodations, add visual descriptions/);
});

test('SmartPlanner buildPlannerPrompt includes AI note audit hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI lecture summary cleanup',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Compare the transcript summary to cited slides and write recall prompts for confusing weak spots.'
    }
  ], now);

  assert.match(prompt, /AI note audit: verify summary against source, convert summary to recall prompts, tag unanswered questions/);
});

test('SmartPlanner inferSocraticStudyHints prefers guided tutoring over answer dumping', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferSocraticStudyHints({
    title: 'AI tutor help for stuck problem set',
    description: 'I am confused by a failed attempt and want hints, not the solution key.'
  });

  assert.deepEqual(Array.from(hints), ['ask guiding questions first', 'diagnose misconception before answer', 'prefer hints over solutions']);
});

test('SmartPlanner buildPlannerPrompt includes Socratic tutor mode hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Calculus problem set office hours',
      courseName: 'Math',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Bring stuck homework attempts and ask the TA for hints before seeing full solutions.'
    }
  ], now);

  assert.match(prompt, /Socratic tutor mode: ask guiding questions first, diagnose misconception before answer, prefer hints over solutions/);
});

test('SmartPlanner inferSocraticStudyHints catches answer-withholding AI tutor workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferSocraticStudyHints({
    title: 'Aporium-style AI tutor review',
    description: 'Practice with a tutor that refuses to give answers until I show my scratch work and initial attempt.'
  });

  assert.deepEqual(Array.from(hints), ['prefer hints over solutions', 'require learner attempt first']);
});

test('SmartPlanner inferSocraticStudyHints recognizes guided-learning study modes', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferSocraticStudyHints({
    title: 'Gemini Guided Learning review',
    description: 'Use guided learning with Khanmigo-style coaching so the tutor asks hints instead of giving final answers.'
  });

  assert.deepEqual(Array.from(hints), ['prefer hints over solutions']);
});

test('SmartPlanner buildPlannerPrompt includes teach-back hints for active recall', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Algorithms oral exam',
      courseName: 'CS 170',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Review theorem definitions and explain proof ideas aloud before office hours.'
    }
  ], now);

  assert.match(prompt, /teach-back: explain aloud, teach key concepts, find explanation gaps/);
});

test('SmartPlanner buildPlannerPrompt includes tutor context pack hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Essay revision',
      courseName: 'Writing',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Revise using the prompt, rubric, sample essay, and instructor feedback.'
    }
  ], now);

  assert.match(prompt, /tutor context pack: attach rubric, include examples, include prior feedback/);
});

test('SmartPlanner buildPlannerPrompt includes evidence-pack hints for grounded AI study', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI-assisted research synthesis',
      courseName: 'Writing',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Use research articles with DOI citations to compare claims and ask source-grounded questions.'
    }
  ], now);

  assert.match(prompt, /evidence pack: collect quotable snippets, capture citation metadata, map claims to sources/);
});

test('SmartPlanner inferPortabilityBackupHints detects export and backup workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferPortabilityBackupHints({
    title: 'Final project portfolio export',
    description: 'Download the Canvas export as JSON and save Markdown notes to the GitHub repo before submission.'
  });

  assert.deepEqual(Array.from(hints), ['export Markdown summary', 'keep structured JSON copy', 'save portable notes']);
});

test('SmartPlanner buildPlannerPrompt includes portability backup hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Capstone portfolio handoff',
      courseName: 'CS 198',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Archive deliverables, keep JSON metadata, and save a Markdown README before the demo.'
    }
  ], now);

  assert.match(prompt, /portability backup: export Markdown summary, keep structured JSON copy, save portable notes/);
});

test('SmartPlanner inferAiHandoffHints detects AI-study context export needs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAiHandoffHints({
    title: 'Cursor debugging lab',
    description: 'Use Copilot only with the rubric constraints, starter repo, failing tests, and Canvas assignment page source.'
  });

  assert.deepEqual(Array.from(hints), ['copy assignment brief', 'include constraints', 'include failing context']);
});

test('SmartPlanner buildPlannerPrompt includes AI handoff hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI-assisted project debug',
      courseName: 'CS 61B',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Use ChatGPT with the rubric constraints and starter code tests from the Canvas assignment page.'
    }
  ], now);

  assert.match(prompt, /AI handoff: copy assignment brief, include constraints, include failing context/);
});

test('SmartPlanner inferRequirementClarificationHints detects confusing assignment prompts', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferRequirementClarificationHints({
    title: 'Ambiguous project prompt',
    description: 'Confusing requirements: not sure where to start. Use the sample template and rubric to identify expected deliverables.'
  });

  assert.deepEqual(Array.from(hints), ['rewrite prompt in plain steps', 'separate asks from context', 'identify first deliverable']);
});

test('SmartPlanner buildPlannerPrompt includes requirement clarification hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Unclear systems lab',
      courseName: 'CS 162',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'The spec is ambiguous and hard to parse; separate the requirements from the starter-code context before coding.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /clarify requirements: rewrite prompt in plain steps, separate asks from context/);
});

test('SmartPlanner recommendNextStudyAction prioritizes high-effort urgent work transparently', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const recommendation = planner.__test.recommendNextStudyAction([
    {
      title: 'Discussion reply',
      courseName: 'History',
      ts: new Date('2026-07-10T16:00:00-07:00').getTime()
    },
    {
      title: 'Project milestone checkpoint',
      courseName: 'CS 61B',
      description: 'Draft implementation plan and run starter tests.',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime()
    }
  ], now);

  assert.equal(recommendation.title, 'Project milestone checkpoint');
  assert.equal(recommendation.course, 'CS 61B');
  assert.equal(recommendation.effort, 'high');
  assert.match(recommendation.action, /^Do a 45-minute deep-work sprint/);
  assert.match(recommendation.reason, /due soon/);
  assert.match(recommendation.reason, /high effort/);
  assert.match(recommendation.reason, /needs progress/);
});

test('SmartPlanner recommendTopStudyActions surfaces a ranked next-three triage list', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const recommendations = planner.__test.recommendTopStudyActions([
    {
      title: 'Already submitted project',
      courseName: 'CS 61B',
      description: 'Large project milestone.',
      submitted: true,
      ts: new Date('2026-07-10T12:00:00-07:00').getTime()
    },
    {
      title: 'Capstone design review',
      courseName: 'CS 198',
      description: 'Draft milestone with 150 points and starter repo notes.',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime()
    },
    {
      title: 'Reading quiz',
      courseName: 'History',
      description: 'Quick quiz worth 5 points.',
      ts: new Date('2026-07-10T20:00:00-07:00').getTime()
    },
    {
      title: 'Optional worksheet',
      courseName: 'Math',
      ts: new Date('2026-07-13T12:00:00-07:00').getTime()
    }
  ], now, 3);

  assert.equal(recommendations.length, 3);
  assert.equal(recommendations[0].title, 'Capstone design review');
  assert.match(recommendations[0].reason, /high effort/);
  assert.equal(recommendations[1].title, 'Reading quiz');
  assert.ok(recommendations.every(item => item.title !== 'Already submitted project'));
});

test('SmartPlanner recommendTopStudyActions boosts recently changed Canvas items', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const recommendations = planner.__test.recommendTopStudyActions([
    {
      title: 'Normal worksheet',
      courseName: 'Math',
      description: 'Practice worksheet.',
      ts: new Date('2026-07-12T12:00:00-07:00').getTime()
    },
    {
      title: 'Revised lab instructions',
      courseName: 'CS 61B',
      description: 'Updated instructions posted with new files and a due date changed notice.',
      ts: new Date('2026-07-12T12:00:00-07:00').getTime()
    }
  ], now, 2);

  assert.equal(recommendations[0].title, 'Revised lab instructions');
  assert.match(recommendations[0].reason, /changed instructions/);
});

test('SmartPlanner recommendNextStudyAction ignores completed or undated work', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();

  assert.equal(planner.__test.recommendNextStudyAction([
    { title: 'Done lab', done: true, ts: new Date('2026-07-10T12:00:00-07:00').getTime() },
    { title: 'No due date' }
  ], now), null);
});

test('SmartPlanner classifyActionBucket groups Canvas assignments by needs-action state', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();

  assert.equal(planner.__test.classifyActionBucket({ title: 'Past lab', ts: new Date('2026-07-09T23:59:00-07:00').getTime() }, now), 'overdue');
  assert.equal(planner.__test.classifyActionBucket({ title: 'Project', ts: new Date('2026-07-12T23:59:00-07:00').getTime() }, now), 'due soon');
  assert.equal(planner.__test.classifyActionBucket({ title: 'Optional reading' }, now), 'no due date');
  assert.equal(planner.__test.classifyActionBucket({ title: 'Submitted quiz', ts: new Date('2026-07-10T23:59:00-07:00').getTime(), submission: { submitted_at: '2026-07-10T09:30:00-07:00' } }, now), 'submitted');
});

test('SmartPlanner recommendNextStudyAction de-prioritizes already submitted work', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const recommendation = planner.__test.recommendNextStudyAction([
    {
      title: 'Submitted final project',
      courseName: 'CS 61B',
      description: 'Large final project milestone.',
      ts: new Date('2026-07-10T12:00:00-07:00').getTime(),
      submitted: true
    },
    {
      title: 'Unsubmitted discussion',
      courseName: 'History',
      ts: new Date('2026-07-10T16:00:00-07:00').getTime()
    }
  ], now);

  assert.equal(recommendation.title, 'Unsubmitted discussion');
});

test('SmartPlanner buildPlannerPrompt includes action bucket guidance', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Submitted quiz review',
      courseName: 'CS 162',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      submitted: true
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /action bucket: submitted/);
  assert.match(prompt, /Prioritize action buckets in this order: overdue, due soon, no due date, later/);
  assert.match(prompt, /skip or de-prioritize submitted work/);
});

test('SmartPlanner inferAudioReviewHints detects lecture audio recap opportunities', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAudioReviewHints({
    title: 'Final review lecture audio overview',
    description: 'Use the transcript and recorded summary for a commute review before the cumulative exam.'
  });

  assert.deepEqual(Array.from(hints), ['queue audio recap', 'convert lecture to recap', 'listen before practice']);
});

test('SmartPlanner buildPlannerPrompt includes audio review guidance', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Missed lecture recording',
      courseName: 'CS 162',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Review the transcript and audio recap before the quiz.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /audio review: queue audio recap, convert lecture to recap, listen before practice/);
});

test('SmartPlanner inferTranscriptStudyGuideHints anchors AI note guides to transcripts', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferTranscriptStudyGuideHints({
    title: 'NotebookLM transcript study guide',
    description: 'Build chapter timestamps from the recorded lecture transcript, verify the AI summary, and flag inaudible caption errors.'
  });

  assert.deepEqual(Array.from(hints), ['anchor notes to timestamps', 'split into topic chapters', 'verify AI summary against transcript']);
});

test('SmartPlanner buildPlannerPrompt includes transcript study guide guidance', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Coconote lecture transcript cleanup',
      courseName: 'CS 188',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Use chapter timestamps to turn the class recording transcript into an AI study guide.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /transcript study guide: anchor notes to timestamps, split into topic chapters, verify AI summary against transcript/);
});

test('SmartPlanner inferPlannerRiskFlags surfaces high-value assignments from Canvas points', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const flags = planner.__test.inferPlannerRiskFlags({
    title: 'Capstone design review',
    description: 'Submit the design deck and demo notes.',
    pointsPossible: 150,
    ts: new Date('2026-07-12T18:00:00-07:00').getTime()
  }, [], now);

  assert.ok(flags.includes('large point value'));
});

test('SmartPlanner inferPlannerRiskFlags can read point value from assignment text', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const flags = planner.__test.inferPlannerRiskFlags({
    title: 'Project submission',
    description: 'This is worth 120 points and requires a GitHub repo upload.',
    ts: new Date('2026-07-15T18:00:00-07:00').getTime()
  }, [], now);

  assert.ok(flags.includes('large point value'));
  assert.ok(flags.includes('submission check'));
});

test('SmartPlanner buildPlannerPrompt includes changed-deadline risk hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Algorithms homework update',
      courseName: 'CS 170',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Announcement: deadline moved earlier; the problem set is now due Saturday instead of Monday.'
    }
  ], now);

  assert.match(prompt, /risk: recheck changed deadline/);
});

test('SmartPlanner buildPlannerPrompt includes large point-value risk hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Final project',
      courseName: 'CS 61B',
      pointsPossible: 200,
      ts: new Date('2026-07-13T18:00:00-07:00').getTime(),
      description: 'Implement the final feature and upload the report.'
    }
  ], now);

  assert.match(prompt, /risk: large point value/);
});

test('SmartPlanner buildFallbackStudyBlocks creates deadline-safe blocks when model output is unusable', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const deadline = new Date('2026-07-10T15:00:00-07:00').getTime();

  const blocks = planner.__test.buildFallbackStudyBlocks([
    { title: 'Final project checkpoint', courseName: 'CS 61B', ts: deadline }
  ], now);

  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].title, 'Outline and unblock: Final project checkpoint');
  assert.equal(blocks[0].course, 'CS 61B');
  assert.equal(blocks[0].minutes, 90);
  assert.equal(new Date(blocks[0].startAt).getTime(), new Date('2026-07-10T10:30:00-07:00').getTime());
  assert.equal(blocks[1].title, 'Build or solve: Final project checkpoint');
  assert.equal(blocks[2].title, 'Test and submit: Final project checkpoint');
  assert.ok(new Date(blocks[2].startAt).getTime() + blocks[2].minutes * 60 * 1000 <= deadline - 30 * 60 * 1000);
});

test('SmartPlanner inferStudyPhases favors active recall and workflow-specific phases', () => {
  const planner = loadSmartPlanner();

  assert.deepEqual(Array.from(planner.__test.inferStudyPhases({
    title: 'Data structures midterm',
    description: 'Covers trees, heaps, graph traversals, and runtime analysis.'
  })), ['Active recall drill', 'Practice problems', 'Review weak spots']);

  assert.deepEqual(Array.from(planner.__test.inferStudyPhases({
    title: 'Research paper draft',
    description: 'Submit annotated citations and a polished write-up.'
  })), ['Outline argument', 'Draft', 'Revise and cite']);

  assert.deepEqual(Array.from(planner.__test.inferStudyPhases({
    title: 'Algorithms problem set',
    description: 'Practice shortest path and dynamic programming homework problems.'
  })), ['Attempt first pass', 'Check examples', 'Log mistakes']);
});

test('SmartPlanner buildPlannerPrompt includes study phase hints for model grounding', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Algorithms midterm',
      courseName: 'CS 170',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Practice graph shortest path and dynamic programming problems.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /suggested phases: Active recall drill, Practice problems, Review weak spots/);
});

test('SmartPlanner inferLearningStrategyHints detects active recall and CS workflow strategies', () => {
  const planner = loadSmartPlanner();

  assert.deepEqual(Array.from(planner.__test.inferLearningStrategyHints({
    title: 'Algorithms final exam',
    description: 'Review lecture notes, practice problem set mistakes, and rerun graph drills.'
  })), ['active recall', 'spaced review', 'practice reps']);

  assert.deepEqual(Array.from(planner.__test.inferLearningStrategyHints({
    title: 'Autograder debugging lab',
    description: 'Push the GitHub repo after documenting wrong answers in an error analysis.'
  })), ['debug log', 'mistake review']);
});

test('SmartPlanner inferFocusSprintHints detects deep-work setup cues', () => {
  const planner = loadSmartPlanner();

  assert.deepEqual(Array.from(planner.__test.inferFocusSprintHints({
    title: 'Large capstone project checkpoint',
    description: 'Outline next steps, time-box a focus sprint, and make progress on the starter implementation.'
  })), ['start focus sprint', 'protect attention', 'define done for block']);
});

test('SmartPlanner buildPlannerPrompt includes focus sprint hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Research paper draft',
      courseName: 'Writing',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Timebox a deep work sprint to outline the draft and make progress on sources.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /focus sprint: start focus sprint, protect attention, define done for block/);
});

test('SmartPlanner inferEnergyAwareSessionHints detects sustainable study-session cues', () => {
  const planner = loadSmartPlanner();

  assert.deepEqual(Array.from(planner.__test.inferEnergyAwareSessionHints({
    title: 'Late night final exam cram',
    description: 'I am tired after a mock exam; take a recovery break before the next focus sprint.'
  })), ['choose low-energy review', 'avoid last-minute overload', 'plan recovery break']);
});

test('SmartPlanner buildPlannerPrompt includes energy-aware session hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Compiler project deep work',
      courseName: 'CS 164',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Schedule peak focus for implementation, avoid burnout, and plan a reset break after debugging.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /energy-aware session: choose low-energy review, schedule peak-focus work, plan recovery break/);
});

test('SmartPlanner buildPlannerPrompt includes learning strategy hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Systems quiz',
      courseName: 'CS 162',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Read the lecture notes and turn them into practice questions before the quiz.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /learning strategy: active recall, spaced review, practice reps/);
});

test('SmartPlanner inferRetrievalCalibrationHints detects confidence and interleaving cues', () => {
  const planner = loadSmartPlanner();

  assert.deepEqual(Array.from(planner.__test.inferRetrievalCalibrationHints({
    title: 'Cumulative algorithms final review',
    description: 'Work a mock exam, track wrong answers, and revisit weak spots across multiple chapters.'
  })), ['rate confidence before answers', 'log why misses happened', 'mark red/yellow/green topics']);

  assert.ok(planner.__test.inferRetrievalCalibrationHints({
    title: 'Comprehensive systems review',
    description: 'Interleaving threads, memory, and networking modules.'
  }).includes('interleave old and new topics'));
});

test('SmartPlanner buildPlannerPrompt includes retrieval calibration hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Cumulative CS final',
      courseName: 'CS 162',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Mock exam with wrong answers from multiple modules and weak spots to review.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /retrieval calibration: rate confidence before answers, log why misses happened, mark red\/yellow\/green topics/);
});

test('SmartPlanner inferExamConstraintHints detects allowed-material and proctoring setup needs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferExamConstraintHints({
    title: 'Data science final exam',
    description: 'Open notes and calculator allowed. Respondus LockDown Browser with webcam room scan required.'
  });

  assert.deepEqual(Array.from(hints), ['prepare allowed references', 'verify permitted tools', 'run proctoring setup check']);
});

test('SmartPlanner inferExamConstraintHints detects timed in-person exam logistics', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferExamConstraintHints({
    title: 'Operating systems midterm exam',
    description: 'Timed 75 minutes in-person in Lecture Hall B. Bring student ID and a pencil.'
  });

  assert.deepEqual(Array.from(hints), ['simulate time limit', 'confirm exam logistics']);
});

test('SmartPlanner buildPlannerPrompt includes exam constraint hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Closed-book algorithms midterm',
      courseName: 'CS 170',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'No notes. Scratch paper only; proctored ID check before the assessment.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /exam constraints: practice from memory, run proctoring setup check/);
});

test('SmartPlanner inferExamSignalHints detects professor emphasis and common mistakes', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferExamSignalHints({
    title: 'Lecture 8 review notes',
    description: 'This is on the midterm. Important: students often make a common mistake with Big-O proofs. Practice problems are posted.'
  });

  assert.deepEqual(Array.from(hints), ['pin likely testable clue', 'prioritize professor emphasis', 'practice common mistake']);
});

test('SmartPlanner buildPlannerPrompt includes exam signal hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Graph traversal review sheet',
      courseName: 'CS 61B',
      ts: new Date('2026-07-12T23:59:00-07:00').getTime(),
      description: 'Key idea: BFS edge cases are testable and the professor said to remember this for the quiz.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /exam signals: pin likely testable clue, prioritize professor emphasis/);
});

test('SmartPlanner inferPlannerRiskFlags surfaces deadline and submission risks', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const sharedDay = new Date('2026-07-11T18:00:00-07:00').getTime();
  const item = {
    title: 'Final project Gradescope upload',
    courseName: 'CS 61B',
    ts: sharedDay
  };

  const flags = planner.__test.inferPlannerRiskFlags(item, [
    item,
    { title: 'Reading quiz', ts: new Date('2026-07-11T09:00:00-07:00').getTime() },
    { title: 'Lab report', ts: new Date('2026-07-11T12:00:00-07:00').getTime() }
  ], now);

  assert.deepEqual(Array.from(flags), ['start now', 'link notes', 'busy day']);
});

test('SmartPlanner buildPlannerPrompt includes planner risk flags', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Final project Gradescope upload',
      courseName: 'CS 61B',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime()
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /risk: start now, link notes, submission check/);
});

test('SmartPlanner inferRecurringRoutineHints detects repeated course cadences', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferRecurringRoutineHints({
    title: 'Weekly lab checkpoint',
    description: 'Every Thursday discussion follows the same format as last week: reading quiz, worksheet, and progress update.'
  });

  assert.deepEqual(Array.from(hints), ['reuse weekly routine', 'prep recurring section', 'template repeat task']);
});

test('SmartPlanner buildPlannerPrompt includes recurring routine hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Week 4 lab quiz',
      courseName: 'CS 61B',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Recurring weekly lab section with the same worksheet pattern as previous weeks.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /recurring routine: reuse weekly routine, prep recurring section, template repeat task/);
});

test('SmartPlanner inferTimeEstimateCalibrationHints detects estimate and buffer cues', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferTimeEstimateCalibrationHints({
    title: 'Large project implementation estimate',
    description: 'Timebox the first pass because last week the similar lab took too long and we underestimated the workload.'
  });

  assert.deepEqual(Array.from(hints), ['record time estimate', 'add planning buffer', 'compare estimate to actual']);
});

test('SmartPlanner buildPlannerPrompt includes time estimate calibration hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Research paper planning pass',
      courseName: 'Writing',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Estimate the duration, add buffer, and compare against the actual time from the previous draft.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /time estimate: record time estimate, add planning buffer, compare estimate to actual/);
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

test('SmartPlanner buildWorkloadTimeline buckets upcoming deadlines by local day', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const timeline = planner.__test.buildWorkloadTimeline([
    { title: 'Project milestone', ts: new Date('2026-07-10T18:00:00-07:00').getTime() },
    { title: 'Reading quiz', ts: new Date('2026-07-11T09:00:00-07:00').getTime() },
    { title: 'Done lab', done: true, ts: new Date('2026-07-11T12:00:00-07:00').getTime() },
    { title: 'Future exam', ts: new Date('2026-07-20T12:00:00-07:00').getTime() }
  ], now, 3);

  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].count, 1);
  assert.equal(timeline[0].highEffort, 1);
  assert.equal(timeline[0].estimatedMinutes, 150);
  assert.equal(timeline[0].estimatedHours, 2.5);
  assert.equal(timeline[0].load, 'medium');
  assert.equal(timeline[1].count, 1);
  assert.equal(timeline[1].quick, 1);
  assert.equal(timeline[1].estimatedMinutes, 30);
  assert.equal(timeline[1].load, 'light');
  assert.equal(timeline[2].count, 0);
  assert.equal(timeline[2].load, 'empty');
});

test('SmartPlanner inferSubmissionStatusFlags detects Canvas submission states', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();

  assert.deepEqual(Array.from(planner.__test.inferSubmissionStatusFlags({
    title: 'Lab assignment',
    description: 'Submit the lab report to Canvas.',
    ts: new Date('2026-07-09T23:59:00-07:00').getTime(),
    submission: { workflow_state: 'unsubmitted' }
  }, now)), ['missing submission']);

  assert.deepEqual(Array.from(planner.__test.inferSubmissionStatusFlags({
    title: 'Essay draft',
    ts: new Date('2026-07-11T23:59:00-07:00').getTime(),
    submission: { submitted_at: '2026-07-10T09:30:00-07:00' }
  }, now)), ['awaiting grade']);
});

test('SmartPlanner buildPlannerPrompt includes missing submission risk hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Project upload',
      courseName: 'CS 61B',
      ts: new Date('2026-07-09T23:59:00-07:00').getTime(),
      submission: { workflow_state: 'unsubmitted' },
      description: 'Submit the project repo and report.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /risk: missing submission/);
});

test('SmartPlanner inferPracticeArtifactHints detects active-practice study assets', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferPracticeArtifactHints({
    title: 'Algorithms final exam review',
    description: 'Redo the released practice exam, update the formula sheet, and drill wrong answers from the error log.'
  });

  assert.deepEqual(Array.from(hints), ['generate practice questions', 'redo past exam', 'build study sheet']);
});

test('SmartPlanner buildPlannerPrompt includes practice asset hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Systems quiz',
      courseName: 'CS 162',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Review Quizlet flashcards and missed questions before the quiz.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /practice assets: generate practice questions, review flashcards, drill missed questions/);
});

test('SmartPlanner inferAcademicIntegrityHints flags AI-policy and citation requirements', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAcademicIntegrityHints({
    title: 'AI study app research brief',
    description: 'Follow the course AI policy, disclose any ChatGPT help, include citations and a bibliography, and document partner contributions.'
  });

  assert.deepEqual(Array.from(hints), ['check AI policy', 'cite sources', 'document collaboration']);
});

test('SmartPlanner buildPlannerPrompt includes academic integrity hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Research paper draft',
      courseName: 'Writing',
      ts: new Date('2026-07-13T18:00:00-07:00').getTime(),
      description: 'Use sources with citations and note whether generative AI tools are allowed.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /integrity: check AI policy, cite sources/);
});

test('SmartPlanner inferAiStudySessionSetupHints detects source-backed AI study sessions', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAiStudySessionSetupHints({
    title: 'NotebookLM study mode review',
    description: 'Attach lecture slides and notes, generate a self-quiz audio recap, then focus on weak spots.'
  });

  assert.deepEqual(Array.from(hints), ['start with learning goal', 'attach source packet', 'choose study artifact']);
});

test('SmartPlanner buildPlannerPrompt includes AI study session setup hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI tutor final review',
      courseName: 'CS 162',
      ts: new Date('2026-07-12T12:00:00-07:00').getTime(),
      description: 'Use ChatGPT study mode with lecture transcripts and practice questions for confusing weak spots.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /AI study session: start with learning goal, attach source packet, choose study artifact/);
});

test('SmartPlanner guided-learning prompts keep current AI study sessions grounded', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Guided Learning final review',
      courseName: 'Biology',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Use Gemini Guided Learning or Khanmigo with lecture slides and transcript citations to make a personalized study plan.'
    }
  ], now);

  assert.match(prompt, /Socratic tutor mode: prefer hints over solutions/);
  assert.match(prompt, /AI study session: start with learning goal, attach source packet/);
  assert.match(prompt, /NotebookLM study plan: create source-grounded study plan, bundle textbook and lecture notes/);
  assert.match(prompt, /AI source boundaries: separate source facts from AI hints, keep citation trail/);
});

test('SmartPlanner inferConceptMapBridgeHints detects source-backed topic mapping', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferConceptMapBridgeHints({
    title: 'Build a graph algorithms concept map',
    description: 'Connect BFS, DFS, and shortest paths to the lecture slides and textbook PDF. Flag weak spots where source support is missing.'
  });

  assert.deepEqual(Array.from(hints), ['build course concept map', 'link concepts to source pages', 'flag missing source support']);
});

test('SmartPlanner buildPlannerPrompt includes concept map bridge hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Systems concept map review',
      courseName: 'CS 162',
      ts: new Date('2026-07-12T12:00:00-07:00').getTime(),
      description: 'Make a knowledge graph connecting previous lecture notes, Canvas modules, and weak spots before the quiz.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /concept map bridge: build course concept map, link concepts to source pages, order prerequisite topics/);
});

test('SmartPlanner inferStudyRecoveryHints protects sleep and reset breaks', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const hints = planner.__test.inferStudyRecoveryHints({
    title: 'Final exam cram review',
    ts: new Date('2026-07-11T08:00:00-07:00').getTime(),
    description: 'Avoid an all-nighter; use flashcards and practice problems after a long session.'
  }, now);

  assert.deepEqual(Array.from(hints), ['protect sleep window', 'plan recovery break', 'add reset breaks']);
});

test('SmartPlanner buildPlannerPrompt includes recovery guardrails', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Midterm late-night review',
      courseName: 'CS 70',
      ts: new Date('2026-07-11T09:00:00-07:00').getTime(),
      description: 'Do not cram overnight; finish with active recall from the study guide.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /recovery guardrail: protect sleep window, plan recovery break, end with light recall/);
});

test('SmartPlanner inferCalendarConflictHints detects scheduling collisions and buffers', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferCalendarConflictHints({
    title: 'Group project demo slot conflict',
    description: 'The presentation slot overlaps a work shift; reschedule to an alternate time with the team and account for the across-campus commute.'
  });

  assert.deepEqual(Array.from(hints), ['check calendar conflicts', 'add transition buffer', 'pick alternate study slot']);
});

test('SmartPlanner buildPlannerPrompt includes calendar conflict hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI notes group demo',
      courseName: 'CS 160',
      ts: new Date('2026-07-12T15:00:00-07:00').getTime(),
      description: 'Demo slot has a calendar conflict with a back-to-back lab section; use the recording or office hours as an alternate.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /calendar conflicts: check calendar conflicts, add transition buffer, pick alternate study slot/);
});

test('SmartPlanner inferCodeDebugHints detects explicit code and error workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferCodeDebugHints({
    title: 'React API debugging lab',
    description: 'Fix the TypeError stack trace, rerun npm test, and explain the async endpoint flow.'
  });

  assert.deepEqual(Array.from(hints), ['explain error', 'write debug notes', 'trace API flow']);
});

test('SmartPlanner buildPlannerPrompt includes code/debug hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Backend failing tests checkpoint',
      courseName: 'CS 169',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Debug the pytest failure, verify the CLI commands, and document the API regression.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /code\/debug: explain error, write debug notes, trace API flow/);
});

test('SmartPlanner inferMinimalReproHints prepares AI and TA debugging handoffs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferMinimalReproHints({
    title: 'Cursor autograder wrong-answer help',
    description: 'Use an AI assistant after isolating the failing pytest case with sample input, expected output, and the actual traceback.'
  });

  assert.deepEqual(Array.from(hints), ['make minimal repro', 'record expected vs actual', 'isolate one failing test']);
});

test('SmartPlanner buildPlannerPrompt includes minimal repro hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI-assisted autograder debug',
      courseName: 'CS 61B',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Before asking ChatGPT, isolate the failing unit test and compare expected versus actual output for the wrong answer.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /minimal repro: make minimal repro, record expected vs actual, isolate one failing test/);
});

test('SmartPlanner inferPlannerRiskFlags surfaces setup and help-seeking blockers', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const flags = planner.__test.inferPlannerRiskFlags({
    title: 'ML project environment checkpoint',
    description: 'Clone the starter repo, download the dataset, set up the API key, and ask on EdStem or office hours if blocked.',
    ts: new Date('2026-07-13T18:00:00-07:00').getTime()
  }, [], now);

  assert.ok(flags.includes('setup first'));
  assert.ok(flags.includes('ask for help'));
});

test('SmartPlanner buildPlannerPrompt includes setup blocker risk hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI study app prototype',
      courseName: 'CS 188',
      ts: new Date('2026-07-13T18:00:00-07:00').getTime(),
      description: 'Install the environment, load credentials, and coordinate with your project partner.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /risk: setup first, ask for help/);
});
test('SmartPlanner inferOfficeHoursPrepHints builds a concise help-prep checklist', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferOfficeHoursPrepHints({
    title: 'Gradescope wrong answer help',
    description: 'I am stuck on the recursion lab after a partial attempt. Bring the failing autograder error and the rubric requirement to TA office hours.'
  });

  assert.deepEqual(Array.from(hints), ['write specific question', 'bring error trace', 'summarize what you tried']);
});

test('SmartPlanner inferCollaborationHandoffHints detects group project handoffs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferCollaborationHandoffHints({
    title: 'Team demo checkpoint',
    description: 'Coordinate with your partner, split frontend/backend roles, merge the shared GitHub branch during the integration handoff, rehearse the slide walkthrough, and close peer review feedback.'
  });

  assert.deepEqual(Array.from(hints), ['confirm owners', 'write role checklist', 'sync branch early', 'schedule integration handoff']);
});

test('SmartPlanner buildPlannerPrompt includes collaboration handoff hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Group AI study app presentation',
      courseName: 'CS 188',
      ts: new Date('2026-07-13T18:00:00-07:00').getTime(),
      description: 'Partner project with a shared repo, PR merge, and demo slides.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /collaboration handoff: confirm owners, sync branch early, rehearse demo handoff/);
});

test('SmartPlanner buildPlannerPrompt includes office-hours prep hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Recursion lab blocker',
      courseName: 'CS 61B',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Stuck after trying the starter code; ask a TA at office hours with the traceback and rubric requirement.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /office hours prep: write specific question, bring error trace, summarize what you tried/);
});

test('SmartPlanner inferLectureCaptureHints detects lecture transcript workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferLectureCaptureHints({
    title: 'Recorded lecture catch-up before quiz',
    description: 'Review the class transcript, extract action items from announcements, and mark unclear moments before the quiz.'
  });

  assert.deepEqual(Array.from(hints), ['summarize lecture notes', 'extract action items', 'mark unclear moments']);
});

test('SmartPlanner buildPlannerPrompt includes lecture capture hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Lecture recording review',
      courseName: 'CS 188',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Use the transcript and slides to create follow-up action items for the review session.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /lecture capture: summarize lecture notes, extract action items, turn transcript into quiz/);
});

test('SmartPlanner inferLectureActionChecklistHints detects dated lecture tasks', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferLectureActionChecklistHints({
    title: 'Lecture announcements and Canvas follow-ups',
    description: 'Transcript says the graph worksheet is due Friday, the next reading is in Canvas, and office-hour questions should be queued.'
  });

  assert.deepEqual(Array.from(hints), ['extract dated task checklist', 'capture mentioned deadlines', 'link tasks to Canvas items']);
});

test('SmartPlanner buildPlannerPrompt includes lecture action checklist hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Recorded lecture action review',
      courseName: 'CS 188',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Class recording transcript assigned a Canvas lab due Friday plus follow-up reading questions.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /lecture action checklist: extract dated task checklist, capture mentioned deadlines, link tasks to Canvas items/);
});

test('SmartPlanner inferMultimodalStudyAssetHints detects visual and audio study assets', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferMultimodalStudyAssetHints({
    title: 'Systems architecture lecture capture',
    description: 'Review the whiteboard diagram, transcript captions, and sequence diagram from the demo recording.'
  });

  assert.deepEqual(Array.from(hints), ['capture visual diagram', 'pair transcript with notes', 'make concept map']);
});

test('SmartPlanner buildPlannerPrompt includes multimodal study asset hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Design review study pack',
      courseName: 'CS 160',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Prepare screenshots, a Figma prototype walkthrough, and a concept map for the interface critique.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /multimodal study assets: capture visual diagram, attach screenshots, make concept map/);
});

test('SmartPlanner inferSourceGroundingHints detects citation-first study workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferSourceGroundingHints({
    title: 'Open-book AI ethics synthesis',
    description: 'Compare multiple readings, cite evidence from the source packet, and verify unsupported claims in the study guide.'
  });

  assert.deepEqual(Array.from(hints), ['keep answers source-backed', 'compare source claims', 'build cited study guide']);
});

test('SmartPlanner buildPlannerPrompt includes source grounding hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'NotebookLM-style paper synthesis',
      courseName: 'CS 188',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Synthesize two papers with citations, compare conflicting perspectives, and keep the notebook source-grounded.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /source grounding: keep answers source-backed, compare source claims, cross-check AI notes/);
});

test('SmartPlanner inferSourceGroundingHints cross-checks AI lecture notes against class sources', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferSourceGroundingHints({
    title: 'AI lecture summary review',
    description: 'Use generated notes from the recording transcript and slides before the quiz.'
  });

  assert.deepEqual(Array.from(hints), ['cross-check AI notes']);
});

test('SmartPlanner inferSourceGroundingHints catches citation-anchor gaps in AI notes', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferSourceGroundingHints({
    title: 'AI answer audit',
    description: 'Review AI summary claims with page numbers, timestamps, and flag any uncited hallucination before using them.'
  });

  assert.deepEqual(Array.from(hints), ['cross-check AI notes', 'anchor claims to citations', 'verify unsupported claims']);
});

test('SmartPlanner inferStudyWrapUpHints detects post-session capture needs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferStudyWrapUpHints({
    title: 'Recorded systems lecture review before quiz',
    description: 'Review slides and transcript, add spaced repetition flashcards, and bring confusing missed questions to office hours.'
  });

  assert.deepEqual(Array.from(hints), ['save summary notes', 'schedule next review', 'capture open questions']);
});

test('SmartPlanner buildPlannerPrompt includes study wrap-up hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Autograder debug lab',
      courseName: 'CS 61B',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Debug the GitHub project after the failing Gradescope autograder and log the next step.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /wrap-up: log next debugging step/);
});

test('SmartPlanner inferRubricScoringHints detects grading-focused planning cues', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferRubricScoringHints({
    title: 'Project milestone rubric review',
    description: 'Map each deliverable to the rubric, prioritize the 100 point required section before bonus work, and run final tests.'
  });

  assert.deepEqual(Array.from(hints), ['turn rubric into checklist', 'map work to rubric', 'prioritize high-point parts', 'separate required vs bonus']);
});

test('SmartPlanner buildPlannerPrompt includes rubric scoring hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Portfolio checkpoint',
      courseName: 'CS 169',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Use the grading criteria, required deliverables, and self-check tests before submitting.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /rubric scoring: turn rubric into checklist, map work to rubric, prioritize high-point parts, separate required vs bonus/);
});

test('SmartPlanner inferPreSubmitVerificationHints detects final submission safeguards', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferPreSubmitVerificationHints({
    title: 'Final project Canvas upload',
    description: 'Submit the PDF report and zip on Gradescope after pushing the final GitHub commit before the due deadline.'
  });

  assert.deepEqual(Array.from(hints), ['verify correct file', 'confirm submission receipt', 'push final commit']);
});

test('SmartPlanner buildPlannerPrompt includes pre-submit verification hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Autograder submission',
      courseName: 'CS 61B',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Push the repo, upload the ZIP artifact, submit to Gradescope, and save the due-time confirmation receipt.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /pre-submit: verify correct file, confirm submission receipt, push final commit/);
});

test('SmartPlanner inferSubmissionReceiptHints detects LMS receipt follow-up', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferSubmissionReceiptHints({
    title: 'Project 2 Gradescope resubmission',
    description: 'Submit the latest attempt to the autograder, review feedback, and request a regrade if needed.',
    submission: {
      workflow_state: 'submitted',
      submitted_at: '2026-07-10T17:45:00-07:00'
    }
  });

  assert.deepEqual(Array.from(hints), ['capture submission receipt', 'verify latest attempt is active', 'check grader feedback']);
});

test('SmartPlanner buildPlannerPrompt includes submission receipt hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Canvas lab upload',
      courseName: 'CS 61B',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Upload the lab to Canvas, confirm the submission receipt, and check autograder feedback before the deadline.',
      submission: { submitted_at: '2026-07-10T17:45:00-07:00' }
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /submission receipt: capture submission receipt, check grader feedback, record submitted timestamp/);
});

test('SmartPlanner inferAvailabilityWindowHints detects LMS lock windows and timed attempts', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAvailabilityWindowHints({
    title: 'Timed Canvas quiz',
    description: 'Available until the lock date with one attempt, a 50 minute time limit, and no late submissions after the grace period.'
  });

  assert.deepEqual(Array.from(hints), ['check availability window', 'submit before lock', 'budget timed attempt']);
});

test('SmartPlanner buildPlannerPrompt includes availability window hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Locked Canvas final quiz',
      courseName: 'CS 70',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Available from noon until the lock date. Timed one-attempt quiz with a late penalty after the grace period.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /availability window: check availability window, submit before lock, budget timed attempt/);
});

test('SmartPlanner inferNotebookStudyPackHints detects source-grounded study pack cues', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferNotebookStudyPackHints({
    title: 'Open-book midterm study guide',
    description: 'Use NotebookLM with the lecture transcript, assigned readings, and cited evidence to make a self-quiz.'
  });

  assert.deepEqual(Array.from(hints), ['assemble source pack', 'ground answers in notes', 'generate self-quiz']);
});

test('SmartPlanner buildPlannerPrompt includes notebook study pack hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Research synthesis exam review',
      courseName: 'History',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Build a source packet from articles and citations, then compare claims in a study guide before the quiz.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /notebook study pack: assemble source pack, generate self-quiz, trace claims to citations/);
});

test('SmartPlanner inferCsWorkflowHints decomposes programming assignments safely', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferCsWorkflowHints({
    title: 'Programming lab Gradescope submission',
    description: 'Clone the starter repo, implement the graph API, run pytest, push commits, and submit to the autograder.'
  });

  assert.deepEqual(Array.from(hints), ['read spec first', 'set up starter code', 'implement core path', 'run tests before submit']);
});

test('SmartPlanner inferCsWorkflowHints calls out edge-case planning for CS specs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferCsWorkflowHints({
    title: 'Parser implementation checkpoint',
    description: 'Read the spec, implement input/output handling, cover empty input, null tokens, and boundary cases with tests.'
  });

  assert.deepEqual(Array.from(hints), ['read spec first', 'implement core path', 'list edge cases', 'run tests before submit']);
});

test('SmartPlanner buildPlannerPrompt includes CS workflow hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Programming lab Gradescope submission',
      courseName: 'CS 61B',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Clone the starter repo, implement the graph API, run pytest, push commits, and submit to the autograder.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /CS workflow: read spec first, set up starter code, implement core path, run tests before submit/);
});

test('SmartPlanner inferAssignmentSpecExtractionHints extracts CS assignment key facts', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAssignmentSpecExtractionHints({
    title: 'Parser project spec',
    description: 'Requirements: implement Parser class methods, read JSON input/output format, obey time complexity constraints and collaboration policy.'
  });

  assert.deepEqual(Array.from(hints), ['extract required deliverables', 'capture input/output contract', 'list code touchpoints']);
});

test('SmartPlanner buildPlannerPrompt includes assignment spec extraction hints', () => {
  const planner = loadSmartPlanner();
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'API assignment specification',
      courseName: 'CS 186',
      ts: new Date('2026-07-11T12:00:00-07:00').getTime(),
      description: 'Deliverables include endpoint methods, expected CSV input/output, memory limits, and a late policy.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.match(prompt, /assignment spec: extract required deliverables, capture input\/output contract, list code touchpoints/);
});

test('SmartPlanner inferActivePracticeLoopHints turns notes into active study loops', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferActivePracticeLoopHints({
    title: 'Lecture notes and Quizlet review',
    description: 'Use the transcript summary, flashcards, and missed questions to prepare for the quiz.'
  });

  assert.deepEqual(Array.from(hints), ['convert notes to quiz', 'mix flashcards with problems', 'redo misses tomorrow']);
});

test('SmartPlanner buildPlannerPrompt includes active practice loop hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Recorded lecture study guide',
      courseName: 'CS',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Turn transcript notes into practice questions and grade the problem set attempts.'
    }
  ], now);

  assert.match(prompt, /active practice loop: convert notes to quiz, grade practice immediately/);
});

test('SmartPlanner inferInterleavedPracticeHints detects mixed-practice review plans', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferInterleavedPracticeHints({
    title: 'Cumulative final exam practice set',
    description: 'Shuffle practice problems across multiple units, choose the right algorithm pattern, and revisit missed questions.'
  });

  assert.deepEqual(Array.from(hints), ['mix old and new topics', 'shuffle problem types', 'practice choosing the method']);
});

test('SmartPlanner buildPlannerPrompt includes interleaved practice hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Comprehensive algorithms final',
      courseName: 'CS',
      ts: new Date('2026-07-15T18:00:00-07:00').getTime(),
      description: 'Mixed review from all topics with sample exam problems and strategy choice practice.'
    }
  ], now);

  assert.match(prompt, /interleaved practice: mix old and new topics, shuffle problem types, practice choosing the method/);
});

test('SmartPlanner inferMetacognitiveCalibrationHints detects confidence tracking workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferMetacognitiveCalibrationHints({
    title: 'Mock exam reflection',
    description: 'Predict your score, mark confidence on each question, then compare wrong answers to the rubric feedback.'
  });

  assert.deepEqual(Array.from(hints), ['predict score before grading', 'mark confidence per question', 'compare confidence to misses']);
});

test('SmartPlanner buildPlannerPrompt includes metacognitive calibration hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Practice exam calibration',
      courseName: 'CS',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Take the practice test, rate confidence before grading, review feedback, and update weak spots.'
    }
  ], now);

  assert.match(prompt, /metacognitive calibration: predict score before grading, mark confidence per question, compare confidence to misses/);
});

test('SmartPlanner renderDeadlineList surfaces metacognitive calibration in deadline rows', () => {
  const deadlineList = createTestElement('div');
  const deadlineCount = createTestElement('span');
  const planner = loadSmartPlanner({
    elements: {
      'plan-deadline-list': deadlineList,
      'plan-deadline-count': deadlineCount
    }
  });

  planner.__test.renderDeadlineList([
    {
      title: 'Confidence calibration checkpoint',
      courseName: 'CS 61B',
      ts: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).getTime(),
      description: 'Self-assessment: mark confidence and uncertainty before checking answers.'
    }
  ]);

  const rendered = deadlineList.children.map(child => child.innerHTML).join('\n');
  assert.match(rendered, /Calibration: mark confidence per question/);
  assert.match(rendered, /metacognitive calibration: mark confidence per question/);
  assert.equal(deadlineCount.textContent, '1 dated');
});

test('SmartPlanner inferSpacedReviewPlan suggests spaced reviews before the due date', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();

  assert.deepEqual(Array.from(planner.__test.inferSpacedReviewPlan({
    title: 'Algorithms final exam review',
    ts: new Date('2026-07-18T10:00:00-07:00').getTime()
  }, now)), ['review +1d', 'review +3d', 'review +7d']);

  assert.deepEqual(Array.from(planner.__test.inferSpacedReviewPlan({
    title: 'Systems quiz notes',
    ts: new Date('2026-07-11T18:00:00-07:00').getTime()
  }, now)), ['review +1d']);

  assert.deepEqual(Array.from(planner.__test.inferSpacedReviewPlan({
    title: 'Project submission',
    ts: new Date('2026-07-18T10:00:00-07:00').getTime()
  }, now)), []);
});

test('SmartPlanner buildPlannerPrompt includes spaced review plan hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Recorded lecture study guide',
      courseName: 'CS',
      ts: new Date('2026-07-18T10:00:00-07:00').getTime(),
      description: 'Review lecture notes and flashcards before the final exam.'
    }
  ], now);

  assert.match(prompt, /spaced review plan: review \+1d, review \+3d, review \+7d/);
});

test('SmartPlanner inferExamCountdownHints adapts to exam distance', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();

  assert.deepEqual(Array.from(planner.__test.inferExamCountdownHints({
    title: 'Comprehensive algorithms final exam',
    ts: new Date('2026-07-18T10:00:00-07:00').getTime()
  }, now)), ['map topics now', 'schedule spaced reps', 'mix old units']);

  assert.deepEqual(Array.from(planner.__test.inferExamCountdownHints({
    title: 'Midterm practice exam',
    ts: new Date('2026-07-12T10:00:00-07:00').getTime(),
    description: 'Use the released practice exam.'
  }, now)), ['interleave weak topics', 'simulate exam timing', 'redo past exam']);
});

test('SmartPlanner buildPlannerPrompt includes exam countdown hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Comprehensive systems final exam',
      courseName: 'CS',
      ts: new Date('2026-07-18T10:00:00-07:00').getTime(),
      description: 'Cumulative final covering all units plus a released practice exam.'
    }
  ], now);

  assert.match(prompt, /exam countdown: map topics now, schedule spaced reps, mix old units/);
});


test('SmartPlanner inferPeerStudyAccountabilityHints detects peer and body-doubling workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferPeerStudyAccountabilityHints({
    title: 'Group project demo rehearsal',
    description: 'Book a Discord study room for body doubling, post a checkpoint update, and practice the demo with a partner.'
  });

  assert.deepEqual(Array.from(hints), ['schedule peer check-in', 'use accountability block', 'share progress update']);
});

test('SmartPlanner buildPlannerPrompt includes peer accountability hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Pair programming checkpoint',
      courseName: 'CS',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Use a coworking accountability block and send a progress update before the milestone.'
    }
  ], now);

  assert.match(prompt, /peer accountability: schedule peer check-in, use accountability block, share progress update/);
});

test('SmartPlanner inferBlockedDependencyHints detects access and asset blockers', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferBlockedDependencyHints({
    title: 'ML lab setup',
    description: 'Waiting on API key permission before you can download the dataset and starter repo.'
  });

  assert.deepEqual(Array.from(hints), ['resolve blocker first', 'collect required assets', 'verify access early']);
});

test('SmartPlanner buildPlannerPrompt includes dependency blocker hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Team project integration',
      courseName: 'CS',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Blocked by teammate approval and SSH key access before merging the starter repo.'
    }
  ], now);

  assert.match(prompt, /dependency blockers: resolve blocker first, collect required assets, verify access early/);
});


test('SmartPlanner inferGradeImpactHints surfaces point value and recovery signals', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferGradeImpactHints({
    title: 'Project resubmission',
    pointsPossible: 120,
    description: 'Late penalty applies after the grace period, but revisions can recover points.'
  });

  assert.deepEqual(Array.from(hints), ['120 pts: high grade impact', 'grade recovery path', 'protect against penalties']);
});

test('SmartPlanner recommendNextStudyAction boosts high point assignments', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const recommendation = planner.__test.recommendNextStudyAction([
    {
      title: 'Tiny discussion check-in',
      courseName: 'History',
      ts: new Date('2026-07-10T16:00:00-07:00').getTime(),
      pointsPossible: 5
    },
    {
      title: 'Capstone project milestone',
      courseName: 'CS',
      ts: new Date('2026-07-11T10:00:00-07:00').getTime(),
      pointsPossible: 150
    }
  ], now);

  assert.equal(recommendation.title, 'Capstone project milestone');
  assert.match(recommendation.reason, /high grade impact/);
});

test('SmartPlanner buildPlannerPrompt includes grade impact hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Final project submission',
      courseName: 'CS',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Worth 150 points with a late penalty after the grace period.'
    }
  ], now);

  assert.match(prompt, /grade impact: 150 pts: high grade impact, protect against penalties/);
});

test('SmartPlanner inferAutograderFeedbackHints summarizes CS grader feedback workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAutograderFeedbackHints({
    title: 'Gradescope retry',
    description: 'Hidden tests failed with a traceback and rubric comments mention partial credit before resubmission deadline.'
  });

  assert.deepEqual(Array.from(hints), ['summarize failing tests', 'capture error evidence', 'map feedback to fixes']);
});

test('SmartPlanner inferRubricFeedbackDigest separates wins, fixes, review, and evidence', () => {
  const planner = loadSmartPlanner();
  const digest = planner.__test.inferRubricFeedbackDigest({
    title: 'Project 2 feedback',
    description: 'Great job on the design. Rubric comments show partial credit lost for hidden tests and edge cases; review the lecture notes before resubmit.'
  });

  assert.deepEqual(Array.from(digest), [
    'What went well: preserve the approach that earned credit',
    'Fix next time: convert deductions into a short correction checklist',
    'Review next: tie each comment back to the matching rubric criterion or course topic',
    'Evidence to keep: save failing tests, edge cases, and the final passing run'
  ]);
});

test('SmartPlanner assignment brief includes rubric feedback digest when available', () => {
  const planner = loadSmartPlanner();
  const brief = planner.__test.buildAssignmentBriefMarkdown({
    title: 'Lab revision',
    description: 'Rubric feedback: missing boundary case tests cost partial credit.'
  });

  assert.match(brief, /Feedback digest:/);
  assert.match(brief, /Fix next time: convert deductions into a short correction checklist/);
  assert.match(brief, /Evidence to keep: save failing tests, edge cases, and the final passing run/);
});

test('SmartPlanner buildPlannerPrompt includes autograder feedback hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Lab 4 autograder fix',
      courseName: 'CS',
      ts: new Date('2026-07-11T18:00:00-07:00').getTime(),
      description: 'Gradescope public tests show wrong answer, stderr has an exception, and the rubric says lost points can be recovered on retry.'
    }
  ], now);

  assert.match(prompt, /autograder feedback: summarize failing tests, capture error evidence, map feedback to fixes/);
});

test('SmartPlanner inferWorkedExampleHints detects scaffolded example workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferWorkedExampleHints({
    title: 'Recursion proof practice',
    description: 'Review the worked example, then complete the faded example template and transfer the method to a similar problem.'
  });

  assert.deepEqual(Array.from(hints), ['study worked example', 'fade scaffolding', 'reconstruct steps']);
});

test('SmartPlanner buildPlannerPrompt includes worked example ladder hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Proof practice set',
      courseName: 'CS',
      ts: new Date('2026-07-13T18:00:00-07:00').getTime(),
      description: 'Use the sample solution walkthrough, fill-in scaffold, and explain each step before trying a variant.'
    }
  ], now);

  assert.match(prompt, /worked example ladder: study worked example, fade scaffolding, reconstruct steps/);
});

test('SmartPlanner inferWorkedExampleHints detects CS practice ladders', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferWorkedExampleHints({
    title: 'Data structures lab practice',
    description: 'Dry run the code, implement a small function, add failing tests, then estimate Big-O time complexity.'
  });

  assert.deepEqual(Array.from(hints), ['trace code before running', 'write tiny implementation', 'add failing test case']);
});

test('SmartPlanner buildPlannerPrompt includes CS practice ladder hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Array algorithms lab',
      courseName: 'CS',
      ts: new Date('2026-07-13T18:00:00-07:00').getTime(),
      description: 'Practice by dry run code, implement the algorithm, adding unit tests, and explaining space complexity.'
    }
  ], now);

  assert.match(prompt, /worked example ladder: trace code before running, write tiny implementation, add failing test case/);
});

test('SmartPlanner inferEvidenceConfidenceHints detects source confidence guardrails', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferEvidenceConfidenceHints({
    title: 'Research comparison',
    description: 'Use citations from lecture notes, flag unsupported claims, and separate evidence from inference when sources conflict.'
  });

  assert.deepEqual(Array.from(hints), ['show source confidence', 'flag unsupported answers', 'separate evidence from inference']);
});

test('SmartPlanner buildPlannerPrompt includes evidence confidence hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'NotebookLM source-grounded review',
      courseName: 'History',
      ts: new Date('2026-07-13T18:00:00-07:00').getTime(),
      description: 'Ask the AI tutor to compare readings, cite evidence, and say when notes are insufficient.'
    }
  ], now);

  assert.match(prompt, /evidence confidence: show source confidence, separate evidence from inference, say when notes are insufficient/);
});

test('SmartPlanner inferConfusionCaptureHints detects timestamped lecture questions', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferConfusionCaptureHints({
    title: 'Recorded lecture review',
    description: 'Rewatch the transcript, mark confusing timestamped moments, and bring questions to office hours with the AI tutor context.'
  });

  assert.deepEqual(Array.from(hints), ['capture confusion points', 'save timestamped questions', 'bring questions to help session']);
});

test('SmartPlanner buildPlannerPrompt includes confusion capture hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Lecture transcript catch-up',
      courseName: 'CS 188',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Use captions from the recording, save timestamp questions for unclear probability topics, then ask the AI tutor from exact notes.'
    }
  ], now);

  assert.match(prompt, /confusion capture: capture confusion points, save timestamped questions, bring questions to help session/);
});

test('SmartPlanner inferChangeAwarenessHints detects Canvas change signals', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferChangeAwarenessHints({
    title: 'Project update announcement',
    description: 'The instructor posted revised instructions, uploaded new files, extended the deadline, and feedback was returned.'
  });

  assert.deepEqual(Array.from(hints), ['review changed instructions', 'check new course materials', 're-plan around new date']);
});

test('SmartPlanner buildPlannerPrompt includes change awareness hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Updated lab module',
      courseName: 'CS 61C',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'New files posted after a due date changed clarification; review the revised instructions before coding.'
    }
  ], now);

  assert.match(prompt, /change awareness: review changed instructions, check new course materials, re-plan around new date/);
});

test('SmartPlanner inferQuestionBankHints detects source-grounded active recall workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferQuestionBankHints({
    title: 'Lecture transcript exam review',
    description: 'Turn timestamped notes and slide citations into practice questions, then promote wrong answers to weak spot review.'
  });

  assert.deepEqual(Array.from(hints), ['turn notes into question bank', 'tag questions by topic', 'anchor answers to source location']);
});

test('SmartPlanner buildPlannerPrompt includes question bank hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Recorded lecture final review',
      courseName: 'CS 188',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Use the transcript timestamps and slide sources to make self-quiz questions for the final exam.'
    }
  ], now);

  assert.match(prompt, /question bank: turn notes into question bank, tag questions by topic, anchor answers to source location/);
});

test('SmartPlanner inferCsWorkflowHints detects AI coding review checkpoints', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferCsWorkflowHints({
    title: 'Copilot-assisted programming lab',
    description: 'Use Cursor to generate a patch, review the model changes, run pytest, then push the PR.'
  });

  assert.deepEqual(Array.from(hints), ['read spec first', 'review AI diff', 'run tests before submit', 'leave autograder buffer']);
});

test('SmartPlanner buildPlannerPrompt includes AI coding review guardrails', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI pair-programming project',
      courseName: 'CS 61B',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Use Copilot for the implementation, review the generated patch, run unit tests, and submit the repo.'
    }
  ], now);

  assert.match(prompt, /CS workflow: read spec first, review AI diff, implement core path, run tests before submit/);
});

test('SmartPlanner inferFreshnessGuardHints detects stale or conflicting course sources', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferFreshnessGuardHints({
    title: 'Project clarification announcement',
    description: 'Instructor email says the old syllabus deadline conflicts with the latest Canvas update and revised instructions.'
  });

  assert.deepEqual(Array.from(hints), ['verify latest Canvas update', 'check for stale source', 'resolve instruction conflict']);
});

test('SmartPlanner buildPlannerPrompt includes freshness guard hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Updated lab clarification',
      courseName: 'CS 61C',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Latest Canvas announcement revised the old instructions; an EdStem post mentions a different deadline.'
    }
  ], now);

  assert.match(prompt, /freshness guard: verify latest Canvas update, check for stale source, resolve instruction conflict/);
});

test('SmartPlanner inferStudyPackArtifactHints detects compact study-pack outputs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferStudyPackArtifactHints({
    title: 'Lecture transcript exam review',
    description: 'Turn the lecture notes into flashcards and practice quiz questions; include confusing weak spots for office hours.'
  });

  assert.deepEqual(Array.from(hints), ['make key-term summary', 'draft recall questions', 'export flashcards']);
});

test('SmartPlanner buildPlannerPrompt includes study pack artifact hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'NotebookLM-style lecture review',
      courseName: 'CS 188',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Use the lecture transcript and slides to make a study guide, flashcards, and self-test questions for the final.'
    }
  ], now);

  assert.match(prompt, /study pack artifacts: make key-term summary, draft recall questions, export flashcards/);
});

test('SmartPlanner inferThreeTwoOneReviewHints detects lecture review recap workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferThreeTwoOneReviewHints({
    title: 'Recorded algorithms lecture review',
    description: 'Use the transcript summary to prep for the quiz, tag confusing weak spots, and choose what to review next.'
  });

  assert.deepEqual(Array.from(hints), ['3 key ideas', '2 likely test questions', '1 next review target']);
});

test('SmartPlanner buildPlannerPrompt includes 3-2-1 review hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Recorded lecture recap',
      courseName: 'CS 188',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Review the lecture transcript summary, prepare for the quiz, and mark confusing weak spots.'
    }
  ], now);

  assert.match(prompt, /3-2-1 review: 3 key ideas, 2 likely test questions, 1 next review target/);
});

test('SmartPlanner inferReadingTriageHints detects dense source triage workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferReadingTriageHints({
    title: 'Seminar reading packet',
    description: 'Read the dense journal article: skim abstract, introduction, figures, and definitions before citing claims in discussion.'
  });

  assert.deepEqual(Array.from(hints), ['skim structure first', 'extract landmarks', 'make mini glossary']);
});

test('SmartPlanner buildPlannerPrompt includes reading triage hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'AI-assisted paper reading',
      courseName: 'History',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Long reading packet with an abstract, section headings, figures, and glossary terms for a response post.'
    }
  ], now);

  assert.match(prompt, /reading triage: skim structure first, extract landmarks, make mini glossary/);
});

test('SmartPlanner inferLectureQuestionQueueHints detects lecture question workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferLectureQuestionQueueHints({
    title: 'AI lecture note review',
    description: 'Summarize the lecture transcript, tag unclear moments, and bring questions to TA office hours.'
  });

  assert.deepEqual(Array.from(hints), ['queue lecture questions', 'tag unclear moments', 'route questions to help channel']);
});

test('SmartPlanner buildPlannerPrompt includes lecture question queue hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Recorded lecture catch-up',
      courseName: 'CS 188',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Review the lecture recording transcript with NotebookLM, capture confusing parts, and prep office hours questions.'
    }
  ], now);

  assert.match(prompt, /lecture question queue: queue lecture questions, tag unclear moments, route questions to help channel/);
});

test('SmartPlanner inferPersonalizedMemoryHints detects durable learner context workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferPersonalizedMemoryHints({
    title: 'AI tutor memory refresh',
    description: 'Update the learning profile with mistake journal patterns, weak spots, and rubric goals before the next study mode session.'
  });

  assert.deepEqual(Array.from(hints), ['update learning profile', 'carry forward mistake patterns', 'align to stated goals']);
});

test('SmartPlanner buildPlannerPrompt includes personalized memory hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Personalized AI tutor prep',
      courseName: 'CS 70',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Before using study mode, reuse prior tutor context, mistake journal notes, and target grade goals.'
    }
  ], now);

  assert.match(prompt, /personalized memory: update learning profile, carry forward mistake patterns, align to stated goals/);
});

test('SmartPlanner inferFirstStudyStepHints suggests active pre-work actions', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();
  const hints = planner.__test.inferFirstStudyStepHints({
    title: 'Programming project exam review',
    ts: new Date('2026-07-13T18:00:00-07:00').getTime(),
    description: 'Use the GitHub starter code, pytest failures, and office hours notes to prepare.'
  }, now);

  assert.deepEqual(Array.from(hints), ['blank-page recall first', 'state target skill', 'describe I/O before coding']);
});

test('SmartPlanner inferAiSourceBoundaryHints verifies external study sources against course sources', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAiSourceBoundaryHints({
    title: 'AI-assisted debugging review',
    description: 'Use ChatGPT with web search, Stack Overflow, and a blog post, then compare claims with the assignment spec.'
  });

  assert.deepEqual(Array.from(hints), ['separate source facts from AI hints', 'verify against course source']);
});

test('SmartPlanner buildPlannerPrompt includes first study step hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'CS lab checkpoint',
      courseName: 'CS 61B',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Before coding, read the assignment spec, explain the target skill, and prepare a question if stuck.'
    }
  ], now);

  assert.match(prompt, /first study step: state target skill, write one help question, pick 10-minute starter task/);
});

test('SmartPlanner inferErrorNotebookHints detects mistake-pattern workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferErrorNotebookHints({
    title: 'Autograder error notebook',
    description: 'After failed tests, tag the root cause and retry similar edge cases with confidence notes.'
  });

  assert.deepEqual(Array.from(hints), ['log misses by pattern', 'tag root cause', 'schedule targeted retry']);
});

test('SmartPlanner buildPlannerPrompt includes error notebook hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'CS autograder recovery',
      courseName: 'CS 61B',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Hidden tests failed with a traceback. Keep an error log, tag root cause, and retry edge cases.'
    }
  ], now);

  assert.match(prompt, /error notebook: log misses by pattern, tag root cause, schedule targeted retry/);
});

test('SmartPlanner buildDeadlineStudyPack preserves source metadata for AI study handoff', () => {
  const planner = loadSmartPlanner();
  const pack = planner.__test.buildDeadlineStudyPack([
    {
      id: 'assign-42',
      title: 'Graph traversal project',
      courseName: 'CS 61B',
      moduleName: 'Module 8 algorithms',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      url: 'https://canvas.example/courses/1/assignments/42',
      description: 'Submit the GitHub repo, README write-up, and tests. Review BFS and DFS complexity notes.'
    }
  ], new Date('2026-07-10T10:00:00-07:00'));

  assert.equal(pack.generatedAt, '2026-07-10T17:00:00.000Z');
  assert.equal(pack.cards.length, 1);
  assert.equal(pack.cards[0].id, 'assign-42');
  assert.equal(pack.cards[0].course, 'CS 61B');
  assert.equal(pack.cards[0].generatedFrom, 'CS 61B · Module 8 algorithms · due 2026-07-13T01:00:00.000Z · Canvas source link');
  assert.equal(pack.cards[0].groundingConfidence, 'high — Canvas link, source title, course, due date');
  assert.match(pack.cards[0].citation, /CS 61B \| due 2026-07-13T01:00:00\.000Z \| https:\/\/canvas\.example/);
  assert.deepEqual(JSON.parse(JSON.stringify(pack.cards[0].tags)), ['cs-61b', 'big-o-runtime', 'graph-traversal', 'push-repo', 'attach-write-up']);
  assert.deepEqual(JSON.parse(JSON.stringify(pack.cards[0].recallQuestions)), [
    'Trace the graph algorithm ideas in Graph traversal project on a tiny example.',
    'What runtime or space-complexity claim would you defend for Graph traversal project?',
    'What is the smallest end-to-end path you can implement and test for Graph traversal project?'
  ]);
  assert.match(pack.markdown, /# Canvascope Study Pack/);
  assert.match(pack.markdown, /Generated from: CS 61B · Module 8 algorithms · due 2026-07-13T01:00:00\.000Z · Canvas source link/);
  assert.match(pack.markdown, /Grounding: high — Canvas link, source title, course, due date/);
  assert.match(pack.markdown, /Notes: Submit the GitHub repo, README write-up, and tests/);
  assert.match(pack.markdown, /Recall questions:\n- Trace the graph algorithm ideas/);
  assert.deepEqual(JSON.parse(JSON.stringify(pack.cards[0].reviewSchedule)), [
    'today: answer from memory, then verify source',
    '2 days: spaced recall pass',
    '1 day before due: final check',
    'project mode: retest edge case'
  ]);
  assert.match(pack.markdown, /Review schedule:\n- today: answer from memory, then verify source/);
});

test('SmartPlanner buildStudyPackReviewSchedule adapts to exam and overdue timing', () => {
  const planner = loadSmartPlanner();

  assert.deepEqual(JSON.parse(JSON.stringify(planner.__test.buildStudyPackReviewSchedule({
    title: 'Cumulative final exam',
    description: 'Practice exam and flashcards allowed.'
  }, '2026-07-25T17:00:00.000Z', '2026-07-10T17:00:00.000Z'))), [
    'today: answer from memory, then verify source',
    '2 days: spaced recall pass',
    '1 week: interleaved review',
    '1 day before due: final check'
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(planner.__test.buildStudyPackReviewSchedule({
    title: 'Past due quiz correction',
    description: 'Review wrong answers and source notes.'
  }, '2026-07-09T17:00:00.000Z', '2026-07-10T17:00:00.000Z'))), [
    'now: final source check',
    'after submit: log misses'
  ]);
});

test('SmartPlanner buildDeadlineStudyPack labels unknown sources transparently', () => {
  const planner = loadSmartPlanner();
  const pack = planner.__test.buildDeadlineStudyPack({
    title: 'Untitled review item',
    description: 'Review lecture notes and write one self-check question.'
  }, new Date('2026-07-10T10:00:00-07:00'));

  assert.equal(pack.cards[0].generatedFrom, 'selected Canvas course material');
  assert.equal(pack.cards[0].groundingConfidence, 'low — missing Canvas source metadata; verify against the assignment page');
  assert.match(pack.markdown, /Generated from: selected Canvas course material/);
  assert.match(pack.markdown, /Grounding: low — missing Canvas source metadata; verify against the assignment page/);
});

test('SmartPlanner inferActiveRecallQuestions falls back to generic source-grounded prompts', () => {
  const planner = loadSmartPlanner();
  const questions = planner.__test.inferActiveRecallQuestions({
    title: 'Week 4 lecture notes',
    description: 'Review the slides and transcript before section.'
  }, 2);

  assert.deepEqual(JSON.parse(JSON.stringify(questions)), [
    'Explain the main idea of Week 4 lecture notes without looking at the notes, then verify against the source.',
    'What are the key requirements or learning objectives for Week 4 lecture notes?'
  ]);
});

test('SmartPlanner inferRubricRevisionLoopHints detects redo and regrade workflows', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferRubricRevisionLoopHints({
    title: 'Project resubmission revision memo',
    description: 'Use grader feedback, rubric score breakdown, lost points, office hours notes, and a change log before requesting a regrade.'
  });

  assert.deepEqual(Array.from(hints), ['compare feedback to rubric', 'list lost-point causes', 'write revision memo']);
});

test('SmartPlanner buildPlannerPrompt includes revision loop hints', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00');
  const prompt = planner.__test.buildPlannerPrompt([
    {
      title: 'Lab correction resubmission',
      courseName: 'CS 61B',
      ts: new Date('2026-07-12T18:00:00-07:00').getTime(),
      description: 'Revise from TA feedback, compare the score breakdown against the rubric, and include a revision memo.'
    }
  ], now);

  assert.match(prompt, /revision loop: compare feedback to rubric, list lost-point causes, write revision memo/);
});
