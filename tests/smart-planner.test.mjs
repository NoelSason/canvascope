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

test('SmartPlanner inferTeachBackHints detects explain-aloud study needs', () => {
  const planner = loadSmartPlanner();
  const hints = planner.__test.inferTeachBackHints({
    title: 'Midterm concept review',
    description: 'Practice explaining the protocol model to a study group and find weak spots.'
  });

  assert.deepEqual(Array.from(hints), ['explain aloud', 'teach key concepts', 'find explanation gaps']);
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

test('SmartPlanner recommendNextStudyAction ignores completed or undated work', () => {
  const planner = loadSmartPlanner();
  const now = new Date('2026-07-10T10:00:00-07:00').getTime();

  assert.equal(planner.__test.recommendNextStudyAction([
    { title: 'Done lab', done: true, ts: new Date('2026-07-10T12:00:00-07:00').getTime() },
    { title: 'No due date' }
  ], now), null);
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
