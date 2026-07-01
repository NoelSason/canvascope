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

test('CourseBrain citation decoration leaves unknown markers unchanged', () => {
  const { brain } = loadCourseBrain();
  const html = brain.__test.decorateCitations('Use [1] and [9]', [{ n: 1, title: 'Escaped <Source>' }]);

  assert.equal(html, 'Use <button class="brain-cite" data-cite="1" title="Escaped &lt;Source&gt;">1</button> and [9]');
});
