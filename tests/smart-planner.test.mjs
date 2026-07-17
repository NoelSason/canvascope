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

test('SmartPlanner inferStudyPhases starts open-note exams with source-pack building', () => {
  const planner = loadSmartPlanner();
  const phases = planner.__test.inferStudyPhases({
    title: 'Open-note algorithms midterm',
    description: 'Notes allowed. Bring a one-page reference sheet and use the study guide to prepare.'
  });

  assert.deepEqual(Array.from(phases), ['Build source pack', 'Active recall drill', 'Practice problems']);
});

test('SmartPlanner inferConceptReviewHints detects networking and security review topics', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferConceptReviewHints({
    title: 'Internet protocols and auth review',
    description: 'Trace TCP, HTTP, DNS routing, encryption, OAuth, and hashing before the quiz.'
  });

  assert.deepEqual(Array.from(hints), ['networking fundamentals', 'security model']);
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

test('SmartPlanner inferAiNoteQualityAuditHints detects summary verification loops', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferAiNoteQualityAuditHints({
    title: 'AI lecture summary review',
    description: 'Verify the transcript summary against slide citations, then turn confusing gaps into recall questions.'
  });

  assert.deepEqual(Array.from(hints), ['verify summary against source', 'convert summary to recall prompts', 'tag unanswered questions']);
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
  assert.equal(timeline[0].load, 'medium');
  assert.equal(timeline[1].count, 1);
  assert.equal(timeline[1].quick, 1);
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
    description: 'Coordinate with your partner, merge the shared GitHub branch, rehearse the slide walkthrough, and close peer review feedback.'
  });

  assert.deepEqual(Array.from(hints), ['confirm owners', 'sync branch early', 'rehearse demo handoff']);
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

  assert.match(prompt, /source grounding: keep answers source-backed, compare source claims, build cited study guide/);
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

  assert.deepEqual(Array.from(hints), ['map work to rubric', 'prioritize high-point parts', 'separate required vs bonus']);
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

  assert.match(prompt, /rubric scoring: map work to rubric, prioritize high-point parts, separate required vs bonus/);
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
