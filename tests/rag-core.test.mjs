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

test('RAGCore.retrieveLocalContext finds dashboard notes by body-only details', async () => {
  const matches = await RAGCore.retrieveLocalContext('prof 3pm');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, 'Office Hours Memo');
  assert.equal(matches[0].type, 'note');
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

test('RAGCore.hasAssignmentBriefIntent recognizes lab handoff requests cheaply', () => {
  assert.equal(RAGCore.hasAssignmentBriefIntent('make an assignment pre-brief with deliverables and rubric'), true);
  assert.equal(RAGCore.hasAssignmentBriefIntent('what should I do first for this lab spec?'), true);
  assert.equal(RAGCore.hasAssignmentBriefIntent('explain binary search complexity'), false);
});

test('RAGCore.hasStudyNotesIntent recognizes portable cited note requests cheaply', () => {
  assert.equal(RAGCore.hasStudyNotesIntent('make study notes with key concepts and citations'), true);
  assert.equal(RAGCore.hasStudyNotesIntent('create a Lectra handoff from this PDF'), true);
  assert.equal(RAGCore.hasStudyNotesIntent('what assignments are due tomorrow?'), false);
});

test('RAGCore.corpusItemRevision uses precomputed PDF revision for fast cache keys', () => {
  const item = {
    title: 'Operating Systems Slides',
    courseName: 'CS 111',
    type: 'file',
    pages: ['process scheduling '.repeat(1000), 'virtual memory '.repeat(1000)],
    sourceRevision: 'pdf:v1:2:32000:fast'
  };

  assert.equal(RAGCore.corpusItemRevision(item), 'pdf:v1:2:32000:fast');
  const key = RAGCore.chunkIndexCacheKey([item], 'CS 111');
  assert.ok(key.includes('pdf:v1:2:32000:fast'));
  assert.ok(!key.includes('process scheduling'));
});

test('RAGCore.compileUnifiedPrompt adds portable Markdown guidance for study-note requests', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const prevUrl = mockTabUrl;
  mockTabUrl = 'https://google.com';
  mockStorage.indexedContent = [
    {
      title: 'Cache Locality Lecture',
      courseName: 'CS 101',
      type: 'file',
      content: 'Spatial locality improves cache hit rates when programs access nearby memory addresses.'
    }
  ];

  try {
    const { prompt } = await RAGCore.compileUnifiedPrompt('make study notes with a worked example and citations');
    assert.ok(prompt.includes('portable Markdown'));
    assert.ok(prompt.includes('Evidence/Citations'));
    assert.ok(prompt.includes('Lectra Handoff'));
    assert.ok(prompt.includes('Citation-first note contract'));
    assert.ok(prompt.includes('citation missing/uncertain'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevUrl;
  }
});

test('RAGCore.citationFirstStudyNoteContract adapts to page metadata', () => {
  const withPages = RAGCore.citationFirstStudyNoteContract([{ n: 1, page: 7 }]);
  const withoutPages = RAGCore.citationFirstStudyNoteContract([{ n: 1 }]);

  assert.ok(withPages.includes('page/slide numbers'));
  assert.ok(withPages.includes('exact supporting quote'));
  assert.ok(withoutPages.includes('shortest exact quote'));
});

test('RAGCore.lectraContextPackTemplate gives a stable notebook handoff scaffold', () => {
  const template = RAGCore.lectraContextPackTemplate();

  assert.ok(template.includes('# Project/Course Context Pack'));
  assert.ok(template.includes('## Commands or Checks'));
  assert.ok(template.includes('## Edge Cases'));
  assert.ok(template.includes('## Paste into Lectra'));
  assert.ok(template.length < 700);
});

test('RAGCore.compileUnifiedPrompt includes context-pack scaffold for handoff requests', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const prevUrl = mockTabUrl;
  mockTabUrl = 'https://google.com';
  mockStorage.indexedContent = [
    {
      title: 'Malloc Lab Spec',
      courseName: 'CS 101',
      type: 'assignment',
      content: 'Implement malloc, free, and realloc. Optimize throughput and utilization.'
    }
  ];

  try {
    const { prompt } = await RAGCore.compileUnifiedPrompt('make a lab brief and Lectra handoff for this spec');
    assert.ok(prompt.includes('Lectra context pack format'));
    assert.ok(prompt.includes('## Deliverables'));
    assert.ok(prompt.includes('## Commands or Checks'));
    assert.ok(prompt.includes('## Paste into Lectra'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevUrl;
  }
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

test('RAGCore.compileRAGPrompt caps oversized active page context for responsiveness', async () => {
  const prevUrl = mockTabUrl;
  const prevScraped = mockScrapedResult;
  mockTabUrl = 'https://mit.instructure.com/courses/2/pages/huge-reading';
  mockScrapedResult = 'Canvas reading '.repeat(600);

  try {
    const compiled = await RAGCore.compileRAGPrompt('summarize this page into study notes');
    assert.ok(compiled.includes('Source excerpt truncated for speed'));
    assert.ok(compiled.length < mockScrapedResult.length + 1200);
  } finally {
    mockTabUrl = prevUrl;
    mockScrapedResult = prevScraped;
  }
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

test('RAGCore.queryTokens reuses the shared stop-word set on the hot path', () => {
  const stopWords = RAGCore.queryStopWords;
  const tokens = RAGCore.queryTokens('please explain this graph algorithm for me');

  assert.equal(RAGCore.queryStopWords, stopWords);
  assert.deepEqual(tokens, ['graph', 'algorithm']);
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

test('RAGCore.capSourceText trims oversized active page context with a speed hint', () => {
  const capped = RAGCore.capSourceText('x'.repeat(200), 80);
  assert.ok(capped.length < 220);
  assert.ok(capped.startsWith('x'.repeat(80)));
  assert.ok(capped.includes('truncated for speed'));
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

test('RAGCore.compileUnifiedPrompt caps large active page excerpts before appending chunks', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const prevUrl = mockTabUrl;
  const prevScraped = mockScrapedResult;
  mockTabUrl = 'https://mit.instructure.com/courses/2';
  mockScrapedResult = 'ACTIVE-CONTEXT '.repeat(600);
  mockStorage.indexedContent = [
    {
      title: 'Runtime Lab',
      courseName: 'CS 101',
      type: 'file',
      content: 'algorithm complexity runtime benchmark notes'
    }
  ];

  try {
    const { prompt } = await RAGCore.compileUnifiedPrompt('runtime algorithm complexity');
    assert.ok(prompt.includes('truncated for speed'));
    assert.ok(prompt.includes('Runtime Lab'));
    assert.ok(prompt.length < mockScrapedResult.length + 2000);
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevUrl;
    mockScrapedResult = prevScraped;
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

test('RAGCore.compileUnifiedPrompt adds Lectra-ready checklist guidance for assignment pre-briefs', async () => {
  const { prompt } = await RAGCore.compileUnifiedPrompt('make an assignment pre-brief with deliverables and starter files');
  assert.ok(prompt.includes('Objective, Deliverables, Constraints/Rubric'));
  assert.ok(prompt.includes('Lectra handoff checklist'));
  assert.ok(prompt.includes('Keep every course-specific item cited'));
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

test('RAGCore.chunkTextWindow preserves tail concepts without increasing chunk size', () => {
  const longPage = `intro ${'filler '.repeat(500)}rare-tail-concept`;
  const windowed = RAGCore.chunkTextWindow(longPage, 120);

  assert.ok(windowed.length <= 125, windowed);
  assert.ok(windowed.includes('intro'));
  assert.ok(windowed.includes('rare-tail-concept'));
  assert.ok(windowed.includes('…'));
});

test('RAGCore.retrieveBrainChunks can find concepts near the end of long PDF pages', async () => {
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    {
      title: 'Long Systems PDF',
      courseName: 'CS 101',
      type: 'file',
      url: 'https://mit.instructure.com/files/systems.pdf',
      pages: [
        {
          pageNum: 8,
          text: `Operating systems overview. ${'background filler '.repeat(300)} rare-tail-concept scheduler trap`
        }
      ]
    }
  ];
  RAGCore.chunkIndexCache.clear();

  try {
    const chunks = await RAGCore.retrieveBrainChunks('rare-tail-concept scheduler trap', {
      courseName: 'CS 101'
    });

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].title, 'Long Systems PDF');
    assert.equal(chunks[0].page, 8);
    assert.ok(chunks[0].text.includes('rare-tail-concept'));
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
    assert.ok(prompt.includes('Citation-first note contract'));
    assert.ok(prompt.includes('page/slide numbers'));
    assert.ok(prompt.includes('cache locality and LRU'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
  }
});

test('RAGCore.compileStudyPackPrompt cites persisted string PDF pages', async () => {
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    {
      title: 'Project 2 Spec',
      courseName: 'CS 101',
      type: 'file',
      url: 'https://mit.instructure.com/files/project2.pdf',
      pages: [
        'Implement Dijkstra with a priority queue and document runtime complexity.',
        'Submit tests covering disconnected graphs and equal-weight edges.'
      ]
    }
  ];
  RAGCore.chunkIndexCache.clear();

  try {
    const chunks = await RAGCore.buildChunkIndex('CS 101');
    const specChunks = chunks.filter(chunk => chunk.title === 'Project 2 Spec');
    assert.equal(specChunks.length, 2);
    assert.deepEqual(specChunks.map(chunk => chunk.page), [1, 2]);

    const { prompt, sources } = await RAGCore.compileStudyPackPrompt('dijkstra runtime disconnected graphs', { courseName: 'CS 101' });

    assert.equal(sources.length, 1);
    assert.ok([1, 2].includes(sources[0].page));
    assert.ok(prompt.includes('Project 2 Spec (CS 101 — page'));
    assert.ok(prompt.includes(sources[0].page === 1 ? 'priority queue' : 'disconnected graphs'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
    RAGCore.chunkIndexCache.clear();
  }
});

test('RAGCore.compileCourseCorpus includes persisted string PDF pages', async () => {
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    {
      title: 'Project 2 Spec',
      courseName: 'CS 101',
      type: 'file',
      url: 'https://mit.instructure.com/files/project2.pdf',
      pages: [
        'Implement Dijkstra with a priority queue and document runtime complexity.',
        'Submit tests covering disconnected graphs and equal-weight edges.'
      ]
    }
  ];

  try {
    const { corpus, sources } = await RAGCore.compileCourseCorpus('CS 101');

    const specSources = sources.filter(source => source.title === 'Project 2 Spec');
    assert.equal(specSources.length, 2);
    assert.deepEqual(specSources.map(source => source.page), [1, 2]);
    assert.ok(corpus.includes('Dijkstra'));
    assert.ok(corpus.includes('disconnected graphs'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
  }
});

test('RAGCore.retrieveBrainChunks tolerates sparse chunk metadata without blocking Ask', async () => {
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    {
      title: 'Sparse PDF page',
      type: 'file',
      pages: [
        { pageNum: 2, text: 'cache locality benchmark edge case notes' }
      ]
    }
  ];
  RAGCore.chunkIndexCache.clear();

  try {
    const chunks = await RAGCore.retrieveBrainChunks('cache benchmark edge case');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].title, 'Sparse PDF page');
    assert.equal(chunks[0].courseName, 'General');
  } finally {
    mockStorage.indexedContent = prevIndexed;
    RAGCore.chunkIndexCache.clear();
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

test('RAGCore.compileUnifiedPrompt de-duplicates active PDF against indexed page chunks', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const prevUrl = mockTabUrl;
  const prevTitle = mockTabTitle;
  const prevScraped = mockScrapedResult;
  mockTabUrl = 'https://mit.instructure.com/files/cache-notes.pdf?download=1';
  mockTabTitle = 'CS 101: Cache Notes PDF';
  mockScrapedResult = '=== ACTIVE PDF DOCUMENT PAGES ===\nFile: cache-notes.pdf\n--- Page 1 ---\nLRU cache notes and benchmark traps.';
  mockStorage.indexedContent = [
    {
      title: 'Cache Notes PDF',
      courseName: 'CS 101',
      type: 'file',
      url: 'https://mit.instructure.com/files/cache-notes.pdf#page=1',
      pages: [
        { pageNum: 1, text: 'LRU cache notes and benchmark traps.' },
        { pageNum: 2, text: 'Cache locality examples and edge cases.' }
      ]
    }
  ];
  RAGCore.chunkIndexCache.clear();

  try {
    const { prompt, sources } = await RAGCore.compileUnifiedPrompt('cache locality LRU benchmark traps');

    assert.equal(sources.length, 1, 'active PDF should not be repeated once per indexed page');
    assert.equal(sources[0].type, 'page');
    assert.ok(prompt.includes('ACTIVE PDF DOCUMENT PAGES'));
    assert.ok(!prompt.includes('[2] Cache Notes PDF'), 'indexed PDF pages should not inflate the active-document prompt');
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevUrl;
    mockTabTitle = prevTitle;
    mockScrapedResult = prevScraped;
    RAGCore.chunkIndexCache.clear();
  }
});
