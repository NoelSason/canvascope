import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ragCorePath = path.resolve(__dirname, '..', 'src', 'core', 'rag-core.js');
const ragCoreCode = fs.readFileSync(ragCorePath, 'utf8');

// Set up Chrome API mocks
let mockTabUrl = 'https://instructure.com/courses/1';
let mockTabTitle = 'CS 101: Introduction to RAG';
let mockScrapedResult = 'Canvas Syllabus: Homework 10 is due soon.';
let mockStorage = {
  indexedContent: [
    { title: 'Homework 10: Advanced RAG', courseName: 'CS 101', dueAt: '2026-06-01T12:00:00.000Z' },
    { title: 'Midterm Exam Study Guide', courseName: 'CS 101', dueAt: null }
  ],
  customTodos: [
    { text: 'Finish reading RAG paper', courseName: 'Personal To-Do', dueDate: '2026-05-28T12:00:00.000Z' }
  ],
  dashboardNotes: [
    { title: 'Office Hours Memo', content: 'Prof office hours are at 3pm', courseName: 'CS 101' }
  ]
};

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 123, url: mockTabUrl, title: mockTabTitle }]
  },
  scripting: {
    executeScript: async () => [{ result: mockScrapedResult }]
  },
  storage: {
    local: {
      get: async () => mockStorage
    }
  }
};

// Evaluate the SemanticMatcher first to enable hybrid retrieval testing
const matcherPath = path.resolve(__dirname, '..', 'src', 'core', 'semantic-matcher.js');
const matcherCode = fs.readFileSync(matcherPath, 'utf8');
new Function(matcherCode + '\nglobalThis.SemanticMatcher = SemanticMatcher;')();

// Evaluate the RAGCore class and bind it to globalThis
new Function(ragCoreCode + '\nglobalThis.RAGCore = RAGCore;')();

test('RAGCore.scrapeActiveTab retrieves active LMS page content within supported domains', async () => {
  // Scenario 1: Supported LMS Domain
  mockTabUrl = 'https://mit.instructure.com/courses/2';
  const lmsResult = await RAGCore.scrapeActiveTab();
  assert.equal(lmsResult, 'Canvas Syllabus: Homework 10 is due soon.');

  // Scenario 2: Unsupported Domain
  mockTabUrl = 'https://google.com';
  const unsupportedResult = await RAGCore.scrapeActiveTab();
  assert.equal(unsupportedResult, '');
});

test('RAGCore.retrieveLocalContext scores and returns top relevant matches', async () => {
  // Search for homework related entries
  const matches = await RAGCore.retrieveLocalContext('When is Homework 10 due?');
  
  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, 'Homework 10: Advanced RAG');
  assert.equal(matches[0].courseName, 'CS 101');
  assert.equal(matches[0].type, 'assignment');
});

test('RAGCore.retrieveLocalContext matches both custom to-dos and dashboard notes', async () => {
  // Search for personal reading todo
  const matchesTodo = await RAGCore.retrieveLocalContext('reading paper details');
  assert.ok(matchesTodo.length >= 1);
  assert.equal(matchesTodo[0].title, 'Finish reading RAG paper');
  assert.equal(matchesTodo[0].type, 'to-do');

  // Search for note
  const matchesNote = await RAGCore.retrieveLocalContext('Office Hours');
  assert.equal(matchesNote.length, 1);
  assert.equal(matchesNote[0].title, 'Office Hours Memo');
  assert.equal(matchesNote[0].type, 'note');
});

test('RAGCore.retrieveLocalContext returns empty array for non-matching queries', async () => {
  const matches = await RAGCore.retrieveLocalContext('Cooking lasagna recipe');
  assert.equal(matches.length, 0);
});

test('RAGCore.hasScheduleIntent recognizes task/schedule questions', () => {
  assert.equal(RAGCore.hasScheduleIntent("what's on my to-do list?"), true);
  assert.equal(RAGCore.hasScheduleIntent('what do I have to do this week?'), true);
  assert.equal(RAGCore.hasScheduleIntent('show me my tasks'), true);
  assert.equal(RAGCore.hasScheduleIntent('what assignments are due?'), true);
  assert.equal(RAGCore.hasScheduleIntent('explain the quadratic formula'), false);
});

test('RAGCore.hasProgrammingStudyIntent recognizes CS workflow questions cheaply', () => {
  assert.equal(RAGCore.hasProgrammingStudyIntent('trace this algorithm and give edge cases'), true);
  assert.equal(RAGCore.hasProgrammingStudyIntent('what pytest should I run from terminal?'), true);
  assert.equal(RAGCore.hasProgrammingStudyIntent('summarize the reading due tomorrow'), false);
});

test('RAGCore.compileUnifiedPrompt adds runnable CS-answer guidance for programming questions', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const prevUrl = mockTabUrl;
  const prevScraped = mockScrapedResult;
  mockTabUrl = 'https://google.com';
  mockScrapedResult = '';
  mockStorage.indexedContent = [
    {
      title: 'Sorting Notes',
      courseName: 'CS 101',
      type: 'file',
      content: 'Merge sort splits arrays recursively and merges sorted halves in linear time.'
    }
  ];

  try {
    const { prompt } = await RAGCore.compileUnifiedPrompt('Explain merge sort Big-O with edge cases');
    assert.ok(prompt.includes('tiny runnable example or pseudocode'));
    assert.ok(prompt.includes('edge case/test'));
    assert.ok(prompt.includes('Big-O or performance'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevUrl;
    mockScrapedResult = prevScraped;
  }
});

test('RAGCore.compileUnifiedPrompt keeps non-code answers compact', async () => {
  const { prompt } = await RAGCore.compileUnifiedPrompt('summarize the reading due tomorrow');
  assert.ok(!prompt.includes('tiny runnable example or pseudocode'));
});

test('RAGCore.retrieveLocalContext surfaces tasks for schedule queries with no keyword match', async () => {
  // "what do I need to do?" does not lexically match any stored title/course,
  // but the context-aware fallback should still surface the pending to-do.
  const matches = await RAGCore.retrieveLocalContext('what do I need to do?');
  assert.ok(matches.length >= 1, 'expected at least one task surfaced');
  assert.ok(matches.some(m => m.type === 'to-do' && m.title === 'Finish reading RAG paper'));
});

test('RAGCore.retrieveLocalContext keyword precision still wins over fallback', async () => {
  // Even though "due" signals schedule intent, a strong keyword match should
  // return only the precise match (not the whole agenda).
  const matches = await RAGCore.retrieveLocalContext('When is Homework 10 due?');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, 'Homework 10: Advanced RAG');
});

test('RAGCore.compileRAGPrompt emits a tasks section for schedule queries', async () => {
  mockTabUrl = 'https://google.com'; // no page context
  const compiled = await RAGCore.compileRAGPrompt('what is on my to-do list?');
  assert.ok(compiled.includes("THE STUDENT'S TASKS & DEADLINES"));
  assert.ok(compiled.includes('Finish reading RAG paper'));
});

test('RAGCore.compileRAGPrompt formats active page context and scheduler context correctly', async () => {
  mockTabUrl = 'https://mit.instructure.com/courses/2';
  const compiled = await RAGCore.compileRAGPrompt('What about Homework 10?');

  assert.ok(compiled.includes('=== CONTEXT FROM THE ACTIVE PAGE ==='));
  assert.ok(compiled.includes('Canvas Syllabus: Homework 10 is due soon.'));
  assert.ok(compiled.includes('=== RELEVANT COURSE DETAILS ==='));
  assert.ok(compiled.includes('[ASSIGNMENT] Homework 10: Advanced RAG (CS 101)'));
  assert.ok(compiled.includes('=== QUESTION ==='));
  assert.ok(compiled.includes('What about Homework 10?'));
});

test('RAGCore.retrieveLocalContext finds a closed PDF by a word in its body only', async () => {
  // Simulate a PDF that DocumentParser.persistPdfToIndex saved into indexedContent:
  // the matching term ("chemoselectivity") appears ONLY in the body content, never the title.
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    {
      title: 'Lab G Handout',
      courseName: 'Chem 3BL',
      type: 'file',
      url: 'https://bcourses.berkeley.edu/files/123/download',
      content: 'Procedure overview. In this experiment we explore chemoselectivity of the reagent toward aldehydes over ketones.'
    }
  ];
  try {
    const matches = await RAGCore.retrieveLocalContext('chemoselectivity reagent');
    assert.ok(matches.length > 0, 'should retrieve the PDF via its body content');
    assert.equal(matches[0].title, 'Lab G Handout');
  } finally {
    mockStorage.indexedContent = prevIndexed;
  }
});

test('RAGCore.queryTokens drops duplicate filler words for faster local scoring', () => {
  assert.deepEqual(RAGCore.queryTokens('Please explain explain the cache, cache locality with examples'), ['cache', 'locality', 'examples']);
});

test('RAGCore.retrieveLocalContext skips body scans for filler-only non-schedule queries', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const slowContent = {
    toString() {
      throw new Error('content should not be normalized for filler-only prompts');
    }
  };
  mockStorage.indexedContent = [
    {
      title: 'Lecture Cache Notes',
      courseName: 'CS 101',
      type: 'file',
      content: slowContent
    }
  ];

  try {
    const matches = await RAGCore.retrieveLocalContext('please explain this for me');
    assert.deepEqual(matches, []);
  } finally {
    mockStorage.indexedContent = prevIndexed;
  }
});

test('RAGCore.scoreCorpusItem checks large content lazily after title/course tokens', () => {
  const score = RAGCore.scoreCorpusItem(
    { title: 'Cache Lab', courseName: 'CS 101', content: 'LRU eviction benchmark notes' },
    ['cache', 'lru']
  );
  assert.equal(score, 12);
});

test('RAGCore.semanticPreviewText caps body text for responsive semantic scoring', () => {
  const preview = RAGCore.semanticPreviewText({
    title: 'Graph Search Notes',
    courseName: 'CS 101',
    type: 'file',
    content: 'a'.repeat(900)
  });

  assert.ok(preview.startsWith('Graph Search Notes CS 101 file '));
  assert.equal(preview.includes('a'.repeat(650)), false);
  assert.ok(preview.length <= 'Graph Search Notes CS 101 file '.length + 600);
});

test('RAGCore.semanticPreviewText keeps semantic topics near the front retrievable', async () => {
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    {
      title: 'Lecture 7 Concept Notes',
      courseName: 'CS 101',
      type: 'file',
      content: `${'algorithm '.repeat(10)} ${'padding '.repeat(1000)}`
    }
  ];

  try {
    const matches = await RAGCore.retrieveLocalContext('runtime complexity algorithm');
    assert.ok(matches.some(m => m.title === 'Lecture 7 Concept Notes'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
  }
});

test('RAGCore.contextBudgetSection gives cheap source-ledger diagnostics', () => {
  const section = RAGCore.contextBudgetSection([{ n: 1 }, { n: 2 }], 'a'.repeat(120), { label: 'Ask source ledger', targetTokenBudget: 20 });
  assert.ok(section.includes('=== ASK SOURCE LEDGER ==='));
  assert.ok(section.includes('Sources: 2'));
  assert.ok(section.includes('120 chars / ~30 tokens'));
  assert.ok(section.includes('large; narrow course/source scope'));
});

test('RAGCore.canAppendPromptBlock caps latency-sensitive Ask context cheaply', () => {
  assert.equal(RAGCore.canAppendPromptBlock('abc', 'def', 6), true);
  assert.equal(RAGCore.canAppendPromptBlock('abc', 'defg', 6), false);
});

test('RAGCore.compileUnifiedPrompt includes source ledger diagnostics for scoped Ask', async () => {
  const { prompt } = await RAGCore.compileUnifiedPrompt('Explain merge sort Big-O with edge cases');
  assert.ok(prompt.includes('=== ASK SOURCE LEDGER ==='));
  assert.ok(prompt.includes('approx context:'));
  assert.ok(prompt.includes('Use this as a source ledger'));
});

test('RAGCore.buildChunkIndex reuses cached chunks until indexed metadata changes', async () => {
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    {
      title: 'Lecture 1 Notes',
      courseName: 'CS 101',
      type: 'file',
      url: 'https://mit.instructure.com/files/lecture1.pdf',
      content: 'Big-O notation and loop invariants.'
    }
  ];
  RAGCore.chunkIndexCache.clear();

  try {
    const first = await RAGCore.buildChunkIndex('CS 101');
    const second = await RAGCore.buildChunkIndex('CS 101');
    assert.equal(second, first, 'unchanged corpus should hit the worker-local chunk cache');

    mockStorage.indexedContent = [
      { ...mockStorage.indexedContent[0], content: `${mockStorage.indexedContent[0].content} Extra theorem.` }
    ];
    const third = await RAGCore.buildChunkIndex('CS 101');
    assert.notEqual(third, first, 'content length change should invalidate cached chunks');
    assert.ok(third[0].text.includes('Extra theorem'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
    RAGCore.chunkIndexCache.clear();
  }
});

test('RAGCore.compileStudyPackPrompt emits cited actionable Markdown sections', async () => {
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    {
      title: 'Lecture 4 Slides',
      courseName: 'CS 101',
      type: 'file',
      url: 'https://mit.instructure.com/files/lecture4.pdf',
      pages: [
        { pageNum: 12, text: 'Cache locality improves performance by reusing nearby memory addresses and reducing cache misses.' },
        { pageNum: 13, text: 'LRU replacement evicts the least recently used cache line when the cache is full.' }
      ]
    }
  ];

  try {
    const { prompt, sources } = await RAGCore.compileStudyPackPrompt('cache locality and LRU', { courseName: 'CS 101' });

    assert.equal(sources.length, 1);
    assert.ok([12, 13].includes(sources[0].page));
    assert.ok(prompt.includes('=== COURSE SOURCES (cite as [n]) ==='));
    assert.ok(prompt.includes('[1] Lecture 4 Slides (CS 101 — page'));
    assert.ok(prompt.includes('## Key Concepts'));
    assert.ok(prompt.includes('## Worked Examples & Edge Cases'));
    assert.ok(prompt.includes('counterexamples the student can test'));
    assert.ok(prompt.includes('## Likely Quiz Questions'));
    assert.ok(prompt.includes('## Flashcards'));
    assert.ok(prompt.includes('## Lectra Handoff'));
    assert.ok(prompt.includes('runnable check/example'));
    assert.ok(prompt.includes('## Review Checklist'));
    assert.ok(prompt.includes('preserve citation fidelity'));
    assert.ok(prompt.includes('cache locality and LRU'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
  }
});

test('RAGCore.compileUnifiedPrompt de-duplicates active page already present in indexed corpus', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const prevUrl = mockTabUrl;
  const prevTitle = mockTabTitle;
  const prevScraped = mockScrapedResult;
  mockTabUrl = 'https://mit.instructure.com/courses/2/pages/cache-systems?module_item_id=99';
  mockTabTitle = 'CS 101: Cache Systems';
  mockScrapedResult = 'Cache systems lecture page explains LRU and cache misses.';
  mockStorage.indexedContent = [
    {
      title: 'Cache Systems',
      courseName: 'CS 101',
      type: 'page',
      url: 'https://mit.instructure.com/courses/2/pages/cache-systems#top',
      content: 'Cache systems lecture page explains LRU and cache misses.'
    }
  ];

  try {
    const { prompt, sources } = await RAGCore.compileUnifiedPrompt('Explain cache misses');

    assert.equal(sources.length, 1, 'indexed duplicate should not be added as a second source');
    assert.equal(sources[0].type, 'page');
    assert.ok(prompt.includes('Cache systems lecture page explains LRU'));
    assert.ok(!prompt.includes('[2] Cache Systems'), 'duplicate indexed source should not get a second citation number');
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevUrl;
    mockTabTitle = prevTitle;
    mockScrapedResult = prevScraped;
  }
});
