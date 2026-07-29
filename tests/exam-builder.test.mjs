import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.resolve(__dirname, '..', 'src', 'core', 'exam-builder.js');
const srcCode = fs.readFileSync(srcPath, 'utf8');

// --- Chrome storage mock (same pattern as character-profile.test.mjs) ---
let mockStorage = {};
function installChrome(initial = {}) {
  mockStorage = JSON.parse(JSON.stringify(initial));
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          ks.forEach((k) => { if (k in mockStorage) out[k] = mockStorage[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(mockStorage, obj); },
        remove: async (k) => { delete mockStorage[k]; }
      }
    }
  };
}

// The module is an IIFE that attaches to `window` and reads the RAGCore /
// AIRouter globals at call time, so tests can swap them per-case.
function loadSandbox() {
  const sandbox = {};
  new Function('window', srcCode)(sandbox);
  return sandbox.CanvascopeExamBuilder;
}

const FIXED_CORPUS = 'You are Canvascope. Sources:\n[1] Lecture 1 notes\n[2] Homework 2 spec\n';

function installRouter(chunks = ['## Practice Exam\n', '1. Q [1]\n']) {
  const calls = [];
  globalThis.AIRouter = {
    stream: (prompt, opts) => {
      calls.push({ prompt, opts });
      return (async function* () { for (const c of chunks) yield c; })();
    }
  };
  return calls;
}

function installRag(corpus = FIXED_CORPUS) {
  const calls = [];
  globalThis.RAGCore = {
    compileCourseCorpus: async (scope) => {
      calls.push(scope);
      return corpus === null
        ? { corpus: '', sources: [] }
        : { corpus, sources: [{ id: 1, title: 'Lecture 1 notes' }, { id: 2, title: 'Homework 2 spec' }] };
    }
  };
  return calls;
}

function cleanupGlobals() {
  delete globalThis.RAGCore;
  delete globalThis.AIRouter;
}

installChrome();
const EB = loadSandbox();

test('byte-stability: two builds send byte-identical system and corpus strings', async (t) => {
  t.after(cleanupGlobals);
  installChrome();
  installRag();
  const calls = installRouter();

  await EB.build({ courseName: 'CS 61A' });
  await EB.build({ courseName: 'CS 61A' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.system, calls[1].opts.system, 'system must be byte-identical across builds');
  assert.equal(calls[0].opts.corpus, calls[1].opts.corpus, 'corpus must be byte-identical across builds');
  assert.equal(calls[0].opts.corpus, FIXED_CORPUS, 'corpus must be passed through verbatim — no prepend/append');
  assert.equal(calls[0].opts.system, EB.EXAM_SYSTEM_PROMPT, 'system must be the exported constant, untouched');
});

test('exam parameters live ONLY in the user prompt — system/corpus unaffected', async (t) => {
  t.after(cleanupGlobals);
  installChrome();
  installRag();
  const calls = installRouter();

  await EB.build({ courseName: 'CS 61A', questionCount: 5 });
  await EB.build({ courseName: 'CS 61A', questionCount: 12, focusTopic: 'recursion trees' });

  assert.notEqual(calls[0].prompt, calls[1].prompt, 'user prompt is the only string allowed to vary');
  assert.equal(calls[0].opts.system, calls[1].opts.system);
  assert.equal(calls[0].opts.corpus, calls[1].opts.corpus);
  assert.ok(calls[1].prompt.includes('recursion trees'), 'focus topic rides the user prompt');
  assert.ok(!calls[1].opts.system.includes('recursion trees'), 'focus topic must never enter system');
  assert.ok(calls[0].prompt.includes('5-question'));
  assert.ok(calls[1].prompt.includes('12-question'));
});

test('EXAM_SYSTEM_PROMPT is a fixed constant across module loads (no init-time interpolation)', () => {
  const again = loadSandbox();
  assert.equal(again.EXAM_SYSTEM_PROMPT, EB.EXAM_SYSTEM_PROMPT);
  assert.ok(EB.EXAM_SYSTEM_PROMPT.length > 200, 'sanity: full prompt exported');
});

test('buildUserPrompt clamps the question count into [3, 25], default 10', () => {
  assert.ok(EB.buildUserPrompt({ questionCount: 0 }).includes('3-question'));
  assert.ok(EB.buildUserPrompt({ questionCount: 100 }).includes('25-question'));
  assert.ok(EB.buildUserPrompt({}).includes('10-question'));
  assert.ok(EB.buildUserPrompt({ questionCount: Number.NaN }).includes('10-question'));
});

test('empty course corpus: friendly error, nothing persisted', async (t) => {
  t.after(cleanupGlobals);
  installChrome();
  installRag(null); // compileCourseCorpus yields empty corpus/sources
  installRouter();

  await assert.rejects(EB.build({ courseName: 'Empty 101' }), /No indexed course materials/);
  assert.equal(mockStorage.lastExamByCourse, undefined);
});

test('finished exams persist per course and round-trip via loadLastExam', async (t) => {
  t.after(cleanupGlobals);
  installChrome();
  installRag();
  installRouter(['# Exam A\n', 'body']);

  const { markdown } = await EB.build({ courseName: 'CS 61A' });
  assert.equal(markdown, '# Exam A\nbody');
  assert.equal(mockStorage.lastExamByCourse['CS 61A'].markdown, markdown);
  assert.equal(mockStorage.lastExamByCourse['CS 61A'].courseName, 'CS 61A');

  // '' scope maps to the shared __all__ bucket
  await EB.build({ courseName: '' });
  assert.ok(mockStorage.lastExamByCourse.__all__);

  const saved = await EB.loadLastExam('CS 61A');
  assert.equal(saved.markdown, markdown);
  assert.equal(await EB.loadLastExam('Never Built 999'), null);
});

test('typed proxy errors from the stream propagate with their code intact', async (t) => {
  t.after(cleanupGlobals);
  installChrome();
  installRag();
  globalThis.AIRouter = {
    stream: () => (async function* () {
      const err = new Error('The AI service is busy.');
      err.code = 'UPSTREAM_BUSY';
      throw err;
      yield ''; // unreachable; keeps the generator shape
    })()
  };

  await assert.rejects(
    EB.build({ courseName: 'CS 61A' }),
    (err) => err.code === 'UPSTREAM_BUSY'
  );
});
