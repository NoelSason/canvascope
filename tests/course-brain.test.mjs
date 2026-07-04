import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const courseBrainCode = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'core', 'course-brain.js'), 'utf8');

function loadCourseBrain() {
  const rafQueue = [];
  const elements = new Map();
  const viewBrain = { scrollTop: 0, scrollHeight: 1200 };
  const courseSelect = {
    addEventListener() {},
    querySelectorAll() { return []; },
    appendChild() {},
    value: ''
  };
  const corpusStat = { textContent: '' };
  elements.set('view-brain', viewBrain);
  elements.set('brain-course-select', courseSelect);
  elements.set('brain-corpus-stat', corpusStat);

  const context = {
    console,
    chrome: { tabs: { create() {} } },
    RAGCore: { listCourses: async () => [] },
    AIRouter: {},
    document: {
      getElementById(id) { return elements.get(id) || null; },
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          dataset: {},
          className: '',
          title: '',
          innerHTML: '',
          appendChild() {},
          addEventListener() {}
        };
      }
    },
    window: {
      requestAnimationFrame(fn) {
        rafQueue.push(fn);
        return rafQueue.length;
      },
      cancelAnimationFrame(id) {
        rafQueue[id - 1] = null;
      },
      setTimeout(fn) {
        rafQueue.push(fn);
        return rafQueue.length;
      },
      clearTimeout(id) {
        rafQueue[id - 1] = null;
      }
    }
  };
  context.window.document = context.document;
  context.window.chrome = context.chrome;
  vm.createContext(context);
  vm.runInContext(courseBrainCode, context);

  let renderCount = 0;
  context.window.CourseBrain.init({
    markdown(markdown) {
      renderCount += 1;
      return `<p>${markdown}</p>`;
    }
  });

  return {
    brain: context.window.CourseBrain,
    flushFrames() {
      while (rafQueue.length) {
        const frame = rafQueue.shift();
        if (frame) frame();
      }
    },
    get renderCount() { return renderCount; },
    viewBrain
  };
}

function makeBody() {
  let html = '';
  return {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
    querySelector() { return null; }
  };
}

test('CourseBrain renderer coalesces streaming markdown updates into one frame', () => {
  const loaded = loadCourseBrain();
  const body = makeBody();
  const renderer = loaded.brain.__test.createThrottledBrainRenderer(body, [{ n: 1, title: 'Lecture PDF' }]);

  renderer.update('first');
  renderer.update('first second');
  renderer.update('first second [1]');

  assert.equal(loaded.renderCount, 0);
  loaded.flushFrames();

  assert.equal(body.innerHTML, '<p>first second <button class="brain-cite" data-cite="1" title="Lecture PDF">1</button></p>');
  assert.equal(loaded.renderCount, 1);
  assert.equal(loaded.viewBrain.scrollTop, 1200);
});

test('CourseBrain renderer finish cancels pending frame and flushes final answer once', () => {
  const loaded = loadCourseBrain();
  const body = makeBody();
  const renderer = loaded.brain.__test.createThrottledBrainRenderer(body, []);

  renderer.update('partial');
  renderer.finish('complete');
  loaded.flushFrames();

  assert.equal(body.innerHTML, '<p>complete</p>');
  assert.equal(loaded.renderCount, 1);
});

test('CourseBrain renderer skips duplicate streaming DOM writes', () => {
  const loaded = loadCourseBrain();
  const body = makeBody();
  const renderer = loaded.brain.__test.createThrottledBrainRenderer(body, []);

  renderer.update('same answer');
  loaded.flushFrames();
  renderer.update('same answer');
  loaded.flushFrames();

  assert.equal(body.innerHTML, '<p>same answer</p>');
  assert.equal(loaded.renderCount, 1);
});

test('CourseBrain citation decoration leaves unknown markers unchanged', () => {
  const { brain } = loadCourseBrain();
  const html = brain.__test.decorateCitations('Use [1] and [9]', [{ n: 1, title: 'Escaped <Source>' }]);

  assert.equal(html, 'Use <button class="brain-cite" data-cite="1" title="Escaped &lt;Source&gt;">1</button> and [9]');
});

test('CourseBrain study notes prompt is citation-first and Lectra-ready', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildStudyNotesPrompt('CS 101 PDF pages 4-6');

  assert.match(prompt, /CS 101 PDF pages 4-6/);
  assert.match(prompt, /citation like \[1\]/);
  assert.match(prompt, /Edge cases \/ common mistakes/);
  assert.match(prompt, /Confusion checkpoint/);
  assert.match(prompt, /Lectra handoff/);
  assert.match(prompt, /if the sources are thin, say what is missing/i);
});

test('CourseBrain selection study note prompt is structured and citation preserving', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildSelectionStudyNotePrompt(
    'Dynamic programming stores overlapping subproblem answers.',
    { title: 'Week 5 Slides', page: 12, url: 'https://canvas.example/courses/1/files/2' }
  );

  assert.match(prompt, /selected Canvas\/PDF passage/);
  assert.match(prompt, /Process only the selected excerpt first/);
  assert.match(prompt, /Week 5 Slides \(p\. 12 · https:\/\/canvas\.example\/courses\/1\/files\/2\)/);
  assert.match(prompt, /Dynamic programming stores overlapping/);
  assert.match(prompt, /Worked example/);
  assert.match(prompt, /Edge case \/ common mistake/);
  assert.match(prompt, /Citation chip/);
  assert.match(prompt, /Lectra handoff/);
  assert.match(prompt, /Do not invent facts/);
});

test('CourseBrain selection study note prompt clips long selections for responsiveness', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildSelectionStudyNotePrompt('x'.repeat(2600), { title: 'Long PDF' });

  assert.match(prompt, /clipped for speed/);
  assert.ok(prompt.length < 3300);
});

test('CourseBrain practice quiz prompt requires source citations and integrity reminder', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildPracticeQuizPrompt('CS 61B');

  assert.match(prompt, /CS 61B/);
  assert.match(prompt, /citation like \[1\]/);
  assert.match(prompt, /source-backed question/);
  assert.match(prompt, /academic integrity reminder/);
  assert.match(prompt, /verify AI-generated study aids/);
});

test('CourseBrain assignment bridge prompt turns course context into Lectra action plan', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildAssignmentBridgePrompt(
    'Implement Dijkstra and compare it against BFS on weighted graphs.',
    { title: 'Project 3 PDF', course: 'CS 201', page: 4, url: 'https://canvas.example/project3.pdf' }
  );

  assert.match(prompt, /Canvas\/PDF assignment context/);
  assert.match(prompt, /Project 3 PDF \(CS 201 · p\. 4 · https:\/\/canvas\.example\/project3\.pdf\)/);
  assert.match(prompt, /Implement Dijkstra/);
  assert.match(prompt, /Edge cases \/ tests/);
  assert.match(prompt, /Commands or files to inspect/);
  assert.match(prompt, /Performance \/ lag audit/);
  assert.match(prompt, /Lectra handoff/);
  assert.match(prompt, /Do not invent rubric details/);
});

test('CourseBrain assignment bridge prompt clips long assignment text for responsiveness', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildAssignmentBridgePrompt('x'.repeat(2500), { title: 'Long Assignment' });

  assert.match(prompt, /clipped for speed/);
  assert.ok(prompt.length < 3100);
});

test('CourseBrain concept drill prompt makes fast active recall Lectra handoff', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildConceptDrillPrompt(
    'Hash tables trade memory for expected O(1) lookup using a hash function and collision handling.',
    { title: 'Week 7 Notes', course: 'CS 201', page: 8, url: 'https://canvas.example/hash.pdf' }
  );

  assert.match(prompt, /active-recall drill/);
  assert.match(prompt, /Use only the selected excerpt first/);
  assert.match(prompt, /Week 7 Notes \(CS 201 · p\. 8 · https:\/\/canvas\.example\/hash\.pdf\)/);
  assert.match(prompt, /Tiny worked example/);
  assert.match(prompt, /Recall questions/);
  assert.match(prompt, /Performance \/ lag hook/);
  assert.match(prompt, /Lectra drill handoff/);
  assert.match(prompt, /do not invent facts/i);
});

test('CourseBrain concept drill prompt clips long excerpts for responsiveness', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildConceptDrillPrompt('x'.repeat(2200), { title: 'Long Concept' });

  assert.match(prompt, /clipped for speed/);
  assert.ok(prompt.length < 2800);
});

test('CourseBrain code trace prompt creates Lectra-ready debug handoff', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildCodeTracePrompt(
    'FAILED test_graph.py::test_empty_graph - AssertionError: expected [] got null',
    { title: 'Graph Lab', course: 'CS 201', page: 3, url: 'https://canvas.example/graph-lab.pdf' }
  );

  assert.match(prompt, /code trace/);
  assert.match(prompt, /Graph Lab \(CS 201 · p\. 3 · https:\/\/canvas\.example\/graph-lab\.pdf\)/);
  assert.match(prompt, /FAILED test_graph/);
  assert.match(prompt, /Minimal reproduction/);
  assert.match(prompt, /Edge-case test/);
  assert.match(prompt, /Performance \/ lag audit/);
  assert.match(prompt, /Lectra debug handoff/);
  assert.match(prompt, /do not invent hidden requirements/i);
});

test('CourseBrain code trace prompt clips long logs for responsiveness', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildCodeTracePrompt('trace\n'.repeat(500), { title: 'Long Log' });

  assert.match(prompt, /clipped for speed/);
  assert.ok(prompt.length < 2800);
});

test('CourseBrain citation decoration handles repeated markers without linear source scans', () => {
  const { brain } = loadCourseBrain();
  const sources = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, title: `Source ${i + 1}` }));
  const html = brain.__test.decorateCitations('Compare [12] with [12] and [1]', sources);

  assert.equal(
    html,
    'Compare <button class="brain-cite" data-cite="12" title="Source 12">12</button> with <button class="brain-cite" data-cite="12" title="Source 12">12</button> and <button class="brain-cite" data-cite="1" title="Source 1">1</button>'
  );
});

test('CourseBrain exam sprint prompt creates fast cited Lectra handoffs', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildExamSprintPrompt(
    'Midterm covers BFS, Dijkstra, and shortest-path edge cases.',
    { title: 'Exam Review PDF', course: 'CS 201', page: 9, url: 'https://canvas.example/exam-review.pdf' }
  );

  assert.match(prompt, /25-minute exam sprint/);
  assert.match(prompt, /Exam Review PDF \(CS 201 · p\. 9 · https:\/\/canvas\.example\/exam-review\.pdf\)/);
  assert.match(prompt, /5-minute skim plan/);
  assert.match(prompt, /active recall drill/);
  assert.match(prompt, /worked example or trace/);
  assert.match(prompt, /Lectra handoff/);
  assert.match(prompt, /performance\/lag angle/);
  assert.match(prompt, /instead of inventing facts/i);
});

test('CourseBrain exam sprint prompt clips long contexts for responsiveness', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildExamSprintPrompt('chapter '.repeat(500), { title: 'Huge Review Packet' });

  assert.match(prompt, /clipped for speed/);
  assert.ok(prompt.length < 2300);
});

test('CourseBrain office hours prep prompt creates cited help-seeking plan', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildOfficeHoursPrepPrompt(
    'Project 4 autograder fails hidden tests and the rubric says analyze edge cases before Friday.',
    { title: 'Project 4 Rubric', course: 'CS 201', page: 2, url: 'https://canvas.example/project4' }
  );

  assert.match(prompt, /office-hours prep sheet/);
  assert.match(prompt, /Project 4 Rubric \(CS 201 · p\. 2 · https:\/\/canvas\.example\/project4\)/);
  assert.match(prompt, /Top 3 questions to ask/);
  assert.match(prompt, /citation like \[1\]/);
  assert.match(prompt, /already tried/);
  assert.match(prompt, /Assignment, grade, or deadline risk/);
  assert.match(prompt, /CS debugging\/repro detail/);
  assert.match(prompt, /Lectra handoff/);
  assert.match(prompt, /Canvas page, rubric, grade item, or lecture note is missing/);
});

test('CourseBrain office hours prep prompt clips long contexts for responsiveness', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildOfficeHoursPrepPrompt('debug log\n'.repeat(400), { title: 'Long Help Request' });

  assert.match(prompt, /clipped for speed/);
  assert.ok(prompt.length < 2600);
});

test('CourseBrain mistake replay prompt creates Lectra-ready retest plan', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildMistakeReplayPrompt(
    'Hidden tests fail when the graph has a disconnected node; feedback says revisit BFS invariants.',
    { title: 'Autograder Feedback', course: 'CS 201', page: 1, url: 'https://canvas.example/feedback' }
  );

  assert.match(prompt, /mistake-replay journal/);
  assert.match(prompt, /Autograder Feedback \(CS 201 · p\. 1 · https:\/\/canvas\.example\/feedback\)/);
  assert.match(prompt, /What went wrong/);
  assert.match(prompt, /Minimal replay/);
  assert.match(prompt, /Corrective move/);
  assert.match(prompt, /Retest checklist/);
  assert.match(prompt, /Lectra save/);
  assert.match(prompt, /disconnected node/);
  assert.match(prompt, /instead of inventing facts/);
});

test('CourseBrain mistake replay prompt clips long feedback for responsiveness', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildMistakeReplayPrompt('stack trace\n'.repeat(400), { title: 'Long Failure Log' });

  assert.match(prompt, /clipped for speed/);
  assert.ok(prompt.length < 2700);
});

test('CourseBrain prompt clipping preserves complete source lines when possible', () => {
  const { brain } = loadCourseBrain();
  const clipped = brain.__test.clipForPrompt([
    'Definition: heaps preserve a parent ordering invariant.',
    'Example: insert 7, 3, 9 and bubble the 9 upward.',
    'This third line should be omitted instead of cut halfway.'
  ].join('\n'), 95);

  assert.equal(clipped.clipped, true);
  assert.equal(clipped.text, 'Definition: heaps preserve a parent ordering invariant.');
  assert.doesNotMatch(clipped.text, /Example: insert 7, 3/);
  assert.doesNotMatch(clipped.text, /halfway/);
});

test('CourseBrain practice quiz prompt adds spaced review and Lectra save guidance', () => {
  const { brain } = loadCourseBrain();
  const prompt = brain.__test.buildPracticeQuizPrompt('CS 201');

  assert.match(prompt, /4-question practice quiz/);
  assert.match(prompt, /CS 201/);
  assert.match(prompt, /Base every question on the sources/);
  assert.match(prompt, /Review next/);
  assert.match(prompt, /short-answer warmup/);
  assert.match(prompt, /retry today/);
  assert.match(prompt, /revisit tomorrow/);
  assert.match(prompt, /interleaved transfer question/);
  assert.match(prompt, /neighboring concept/);
  assert.match(prompt, /likely misconception or trap answer/);
  assert.match(prompt, /save into Lectra/);
  assert.match(prompt, /instead of inventing facts/i);
});

test('CourseBrain grade target parser handles for-a-letter phrasing', () => {
  const { brain } = loadCourseBrain();

  assert.equal(brain.__test.parseTargetLetter('what do I need for a B+ in CS 201?'), 'B+');
  assert.equal(brain.__test.parseTargetLetter('what score do I need to get an A-?'), 'A-');
});

test('CourseBrain course normalization strips terms and reuses cached labels', () => {
  const { brain } = loadCourseBrain();

  assert.equal(brain.__test.normName('Organic Chemistry Laboratory (Spring 2026)'), 'organic chemistry laboratory');
  assert.equal(brain.__test.normName('CS-201: Data Structures — Fall 2026'), 'cs 201 data structures');
  assert.equal(brain.__test.normName('CS-201: Data Structures — Fall 2026'), 'cs 201 data structures');
  assert.equal(brain.__test.nameMatch('CS 201 Data Structures (Fall 2026)', 'Data Structures'), true);
});
