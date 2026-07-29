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

test('RAGCore.buildCorpus preserves Canvas file metadata for RAG material summaries', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const nowIso = new Date().toISOString();
  mockStorage.indexedContent = [
    {
      title: 'Membrane transport slides',
      courseName: 'MCB 102 (Summer 2026)',
      type: 'file',
      url: 'https://bcourses.berkeley.edu/courses/102/files/777',
      moduleName: 'Week 3',
      folderPath: 'Course Materials > Week 3 (June 30)',
      pathSegments: ['Course Materials', 'Week 3 (June 30)'],
      weekHints: ['3'],
      scannedAt: nowIso
    }
  ];

  try {
    const corpus = await RAGCore.buildCorpus();
    const item = corpus.find(entry => entry.title === 'Membrane transport slides');
    assert.ok(item, 'expected file item in normalized corpus');
    assert.equal(item.moduleName, 'Week 3');
    assert.equal(item.folderPath, 'Course Materials > Week 3 (June 30)');
    assert.deepEqual(item.weekHints, ['3']);
    assert.equal(item.scannedAt, nowIso);
  } finally {
    mockStorage.indexedContent = prevIndexed;
  }
});

test('RAGCore.retrieveBrainChunks surfaces recent course materials for broad this-week study questions', async () => {
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    {
      title: 'Membrane transport slides',
      courseName: 'MCB 102 (Summer 2026)',
      type: 'file',
      url: 'https://bcourses.berkeley.edu/courses/102/files/777',
      folderPath: 'Course Materials > June 30',
      scannedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    },
    {
      title: 'Protein trafficking worksheet',
      courseName: 'MCB 102 (Summer 2026)',
      type: 'file',
      url: 'https://bcourses.berkeley.edu/courses/102/files/778',
      folderPath: 'Course Materials > July 1',
      scannedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    }
  ];

  try {
    const chunks = await RAGCore.retrieveBrainChunks('what did we study this week?', { limit: 4 });
    assert.ok(chunks.length >= 2, 'expected recent material chunks even without lexical topic overlap');
    assert.ok(chunks.some(chunk => chunk.title === 'Membrane transport slides'));
    assert.ok(chunks.some(chunk => chunk.text.includes('Course Materials > June 30')));
  } finally {
    mockStorage.indexedContent = prevIndexed;
  }
});

test('RAGCore.compileUnifiedPrompt gives local AI date grounding and sparse file-list evidence', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const prevTabUrl = mockTabUrl;
  mockTabUrl = 'https://google.com';
  mockStorage.indexedContent = [
    {
      title: 'Week 3 - Signal transduction lecture',
      courseName: 'MCB 102 (Summer 2026)',
      type: 'file',
      url: 'https://bcourses.berkeley.edu/courses/102/files/779',
      moduleName: 'Week 3',
      folderPath: 'Course Materials > Week 3 (June 30 - July 2)',
      pathSegments: ['Course Materials', 'Week 3 (June 30 - July 2)'],
      weekHints: ['3'],
      scannedAt: new Date().toISOString()
    }
  ];

  try {
    const compiled = await RAGCore.compileUnifiedPrompt('what did we study in MCB 102 this week?');
    assert.match(compiled.prompt, /=== CURRENT CONTEXT ===/);
    assert.match(compiled.prompt, /Today's date is /);
    assert.match(compiled.prompt, /do not claim the course has not started/i);
    assert.match(compiled.prompt, /Week 3 - Signal transduction lecture/);
    assert.match(compiled.prompt, /Course Materials > Week 3 \(June 30 - July 2\)/);
    assert.equal(compiled.sources.length, 1);
    assert.equal(compiled.sources[0].title, 'Week 3 - Signal transduction lecture');
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevTabUrl;
  }
});

// The Canvas scan strips `pages` and `content` off every rescanned item, so the
// only durable copy of PDF body text is courseMaterialChunks. buildCorpus
// re-attaches it on read — which is what puts page text in front of the
// embedding index, since computeWantedEntries turns each page into its own
// vector. Without course-materials.js loaded, buildCorpus must no-op cleanly
// (that is the case for every context that doesn't load it).
test('RAGCore.buildCorpus hydrates PDF page text from courseMaterialChunks', async () => {
  const prevIndexed = mockStorage.indexedContent;
  const scannedItem = {
    title: 'Lecture 3.pdf',
    courseName: 'Math 1A',
    courseId: '1550636',
    type: 'pdf',
    url: 'https://bcourses.berkeley.edu/courses/1550636/files/93606933'
    // note: no `pages`, no `content` — exactly what a fresh scan leaves behind
  };
  mockStorage.indexedContent = [scannedItem];
  mockStorage.courseMaterialChunks = [
    {
      chunkId: 'course-material:abcd1234:p1:0',
      documentId: 'course-material:abcd1234',
      canvasFileId: '93606933',
      courseId: '1550636',
      title: 'Lecture 3.pdf',
      url: 'https://bcourses.berkeley.edu/files/93606933/download',
      pageStart: 1, pageEnd: 1, chunkIndex: 0,
      text: 'The chain rule states that the derivative of a composite function...'
    },
    {
      chunkId: 'course-material:abcd1234:p2:0',
      documentId: 'course-material:abcd1234',
      canvasFileId: '93606933',
      courseId: '1550636',
      title: 'Lecture 3.pdf',
      url: 'https://bcourses.berkeley.edu/files/93606933/download',
      pageStart: 2, pageEnd: 2, chunkIndex: 1,
      text: 'Worked example: differentiate sin(x^2).'
    }
  ];
  mockStorage.courseMaterialDocuments = [];

  try {
    // Without CanvascopeCourseMaterials present this is a silent no-op.
    const bare = await RAGCore.buildCorpus();
    const bareItem = bare.find(i => i.title === 'Lecture 3.pdf');
    assert.equal(bareItem.pages, null, 'no hydration when course-materials.js is absent');

    const cmPath = path.resolve(__dirname, '..', 'src', 'core', 'course-materials.js');
    new Function(fs.readFileSync(cmPath, 'utf8'))();
    assert.ok(globalThis.CanvascopeCourseMaterials, 'course-materials installed on globalThis');

    const corpus = await RAGCore.buildCorpus();
    const hydrated = corpus.find(i => i.title === 'Lecture 3.pdf');

    assert.deepEqual(hydrated.pages.map(p => p.pageNum), [1, 2]);
    assert.match(hydrated.pages[0].text, /chain rule/);
    assert.match(hydrated.content, /sin\(x\^2\)/);
    // The five itemKey inputs must survive hydration untouched.
    for (const field of ['title', 'url', 'type', 'courseId', 'courseName']) {
      assert.equal(hydrated[field], scannedItem[field]);
    }
  } finally {
    mockStorage.indexedContent = prevIndexed;
    delete mockStorage.courseMaterialChunks;
    delete mockStorage.courseMaterialDocuments;
    delete globalThis.CanvascopeCourseMaterials;
  }
});
