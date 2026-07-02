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
