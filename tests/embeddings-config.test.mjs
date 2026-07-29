import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '..', 'src', 'core', 'embeddings-config.js');
const configCode = fs.readFileSync(configPath, 'utf8');

// Evaluate the config IIFE. It self-installs on globalThis.CanvascopeEmbeddingsConfig
// (mirrors the `typeof self !== 'undefined' ? self : globalThis` guard in the file).
new Function(configCode)();

test('CanvascopeEmbeddingsConfig freezes the whole config, including nested THRESHOLDS', () => {
  const CFG = globalThis.CanvascopeEmbeddingsConfig;
  assert.ok(CFG, 'expected config global to be installed');
  assert.ok(Object.isFrozen(CFG), 'top-level config object should be frozen');
  assert.ok(Object.isFrozen(CFG.THRESHOLDS), 'THRESHOLDS should be frozen');
  assert.ok(Object.isFrozen(CFG.THRESHOLDS.hash), 'THRESHOLDS.hash should be frozen');
  assert.ok(Object.isFrozen(CFG.THRESHOLDS.bge), 'THRESHOLDS.bge should be frozen');
});

test('CanvascopeEmbeddingsConfig.THRESHOLDS.hash preserves the legacy 0.15 literals', () => {
  const CFG = globalThis.CanvascopeEmbeddingsConfig;
  assert.equal(CFG.THRESHOLDS.hash.item, 0.15);
  assert.equal(CFG.THRESHOLDS.hash.chunk, 0.15);
  assert.equal(CFG.THRESHOLDS.hash.page, 0.15);
});

test('CanvascopeEmbeddingsConfig pins RRF_K, MODEL_ID, and DIMS', () => {
  const CFG = globalThis.CanvascopeEmbeddingsConfig;
  assert.equal(CFG.RRF_K, 60);
  assert.equal(CFG.MODEL_ID, 'bge-small-en-v1.5-q8');
  assert.equal(CFG.DIMS, 384);
});

test('index sizing constants are numbers and page vectors are explicitly ceilinged', () => {
  const CFG = globalThis.CanvascopeEmbeddingsConfig;
  for (const key of [
    'INDEX_VECTOR_CAP', 'INDEX_MAX_PAGE_VECTORS_PER_ITEM', 'INDEX_MAX_PAGE_VECTORS_TOTAL',
    'INDEX_ITEM_BODY_MAX_CHARS', 'INDEX_PAGE_BODY_MAX_CHARS'
  ]) {
    assert.equal(typeof CFG[key], 'number', `${key} must be a number`);
    assert.ok(CFG[key] > 0, `${key} must be positive`);
  }
  // The manifest declares unlimitedStorage, so the quota-driven pageBudget
  // ratchet never fires — the total ceiling is what actually bounds growth, and
  // it must leave room for the item vectors.
  assert.ok(CFG.INDEX_MAX_PAGE_VECTORS_TOTAL < CFG.INDEX_VECTOR_CAP);
});

test('THRESHOLDS.bge carries a page floor at or above the item floor', () => {
  const bge = globalThis.CanvascopeEmbeddingsConfig.THRESHOLDS.bge;
  assert.equal(typeof bge.page, 'number');
  assert.ok(bge.page > 0 && bge.page < 1);
  // A document is scored by the MAX over its page vectors, so a long PDF gets
  // many more draws at the bar than a short one. The page floor compensates.
  assert.ok(bge.page >= bge.item, 'page floor must not sit below the item floor');
});

// embedding-index.js keeps its own FALLBACK table for when it is loaded without
// the config global (the Phase 3 eval harness). A divergence there silently
// embeds the eval corpus in a different vector space than the extension —
// EMBED_BATCH_SIZE (12 vs 6) and INDEX_WRITE_EVERY_BATCHES (8 vs 40) had already
// drifted that way before this test existed.
test('embedding-index.js FALLBACK matches the config for every shared key', () => {
  const CFG = globalThis.CanvascopeEmbeddingsConfig;
  const indexPath = path.resolve(__dirname, '..', 'src', 'core', 'embedding-index.js');
  const source = fs.readFileSync(indexPath, 'utf8');

  const block = source.match(/const FALLBACK = \{([\s\S]*?)\n {4}\};/);
  assert.ok(block, 'expected to find the FALLBACK table');

  const entries = [...block[1].matchAll(/^\s*([A-Z_]+):\s*(.+?),?\s*$/gm)];
  assert.ok(entries.length >= 10, `expected a populated FALLBACK table, saw ${entries.length}`);

  for (const [, key, rawValue] of entries) {
    assert.ok(key in CFG, `FALLBACK.${key} has no counterpart in embeddings-config.js`);
    const expected = typeof CFG[key] === 'string' ? `'${CFG[key]}'` : String(CFG[key]);
    assert.equal(rawValue.trim(), expected, `FALLBACK.${key} drifted from the config`);
  }
});

// --- Behavior-preservation check -------------------------------------------------
// rag-core.js must behave identically when CanvascopeEmbeddingsConfig is absent
// (the real-world case in every context that doesn't load this config script,
// e.g. node tests, and previously the tab-injected document-parser). Load
// rag-core.js in a sandbox where the config global was never installed and
// confirm retrieveBrainChunks still ranks and returns chunks via the `?? 0.15`
// legacy fallback, using the same chrome mock + SemanticMatcher load pattern
// as tests/rag-core.test.mjs.
test('retrieveBrainChunks still works when CanvascopeEmbeddingsConfig is absent (legacy fallback path)', async () => {
  // The freeze/threshold tests above intentionally loaded the real config
  // into this process's globalThis. node:test runs a file's top-level tests
  // sequentially in one process, so undo that here to reproduce the sandbox
  // every non-config-loading context (node tests, tab-injected scripts) sees.
  delete globalThis.CanvascopeEmbeddingsConfig;
  assert.equal(
    typeof globalThis.CanvascopeEmbeddingsConfig,
    'undefined',
    'CanvascopeEmbeddingsConfig must be absent for this sandbox check'
  );

  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1, url: 'https://instructure.com/courses/1', title: 'CS 101' }]
    },
    scripting: {
      executeScript: async () => [{ result: '' }]
    },
    storage: {
      local: {
        get: async () => ({
          indexedContent: [
            { title: 'Homework 10: Advanced RAG', courseName: 'CS 101', type: 'assignment', dueAt: '2026-06-01T12:00:00.000Z' },
            { title: 'Midterm Exam Study Guide', courseName: 'CS 101', type: 'assignment', dueAt: null }
          ],
          customTodos: [],
          dashboardNotes: []
        })
      }
    }
  };

  const matcherPath = path.resolve(__dirname, '..', 'src', 'core', 'semantic-matcher.js');
  const matcherCode = fs.readFileSync(matcherPath, 'utf8');
  new Function(matcherCode + '\nglobalThis.SemanticMatcher = SemanticMatcher;')();

  const ragCorePath = path.resolve(__dirname, '..', 'src', 'core', 'rag-core.js');
  const ragCoreCode = fs.readFileSync(ragCorePath, 'utf8');
  new Function(ragCoreCode + '\nglobalThis.RAGCore = RAGCore;')();

  const chunks = await globalThis.RAGCore.retrieveBrainChunks('When is Homework 10 due?', { limit: 4 });
  assert.ok(chunks.length >= 1, 'expected at least one ranked chunk via the legacy 0.15 fallback');
  assert.ok(chunks.some(chunk => chunk.title === 'Homework 10: Advanced RAG'));
});

test('rag-core.js and document-parser.js can share one classic-script scope (sidepanel.html loads both)', async () => {
  const { default: vm } = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const docParserSource = readFileSync(new URL('../src/core/document-parser.js', import.meta.url), 'utf8');
  const ragCoreSource = readFileSync(new URL('../src/core/rag-core.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    console,
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { sendMessage: () => {} } }
  });
  // Top-level const/class in classic scripts share one global lexical scope —
  // a duplicated identifier makes whichever file loads second throw a
  // SyntaxError and never define its globals (this killed RAGCore in the
  // sidepanel when both files declared `const CFG`).
  vm.runInContext(docParserSource, context);
  vm.runInContext(ragCoreSource, context);
  assert.equal(vm.runInContext('typeof RAGCore', context), 'function');
});

test('EMBEDDINGS_ENABLED master switch gates every consumer', async () => {
  const { readFileSync } = await import('node:fs');
  // An earlier test deletes the global to exercise the legacy fallback path.
  const configCode = readFileSync(new URL('../src/core/embeddings-config.js', import.meta.url), 'utf8');
  const sandbox = {};
  new Function('self', configCode).call(sandbox, sandbox);
  const cfg = sandbox.CanvascopeEmbeddingsConfig;
  assert.equal(typeof cfg.EMBEDDINGS_ENABLED, 'boolean', 'master switch exists');

  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  // Each consumer must consult the master switch, or "disabled" would still
  // load a 34MB model / run a background sync.
  assert.match(read('../src/background/embedding-index-sync.js'),
    /EMBEDDINGS_ENABLED\s*===\s*true/, 'background sync gated');
  assert.match(read('../src/popup/popup.js'),
    /CanvascopeEmbeddingsConfig\?\.EMBEDDINGS_ENABLED\s*!==\s*true/, 'popup warmup gated');
  assert.match(read('../src/popup/popup.js'),
    /CFG\?\.EMBEDDINGS_ENABLED\s*!==\s*true/, 'palette refine gated');
  assert.match(read('../src/core/rag-core.js'),
    /RAG_CFG\?\.EMBEDDINGS_ENABLED\s*===\s*true/, 'rag-core bge path gated');
  assert.match(read('../src/core/local-embeddings.js'),
    /EMBEDDINGS_ENABLED\s*===\s*true/, 'local-embeddings warmup gated');
});

test('RAGCore and SemanticMatcher are reachable as global properties', async () => {
  const { default: vm } = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const context = vm.createContext({
    console,
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { sendMessage: () => {} } }
  });
  vm.runInContext(readFileSync(new URL('../src/core/semantic-matcher.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../src/core/rag-core.js', import.meta.url), 'utf8'), context);
  // A bare classic-script `class` is a lexical binding, NOT a globalThis
  // property — modules that look these up by property (the background sync
  // add-on) silently no-op without an explicit export.
  assert.equal(vm.runInContext('typeof globalThis.RAGCore', context), 'function');
  assert.equal(vm.runInContext('typeof globalThis.SemanticMatcher', context), 'function');
});
