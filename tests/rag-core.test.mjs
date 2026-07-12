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

test('RAGCore.tokenize returns defensive copies from its cache', () => {
  const first = RAGCore.tokenize('Make Lectra study notes from this PDF');
  first.push('mutated');
  const second = RAGCore.tokenize('Make Lectra study notes from this PDF');
  assert.deepEqual(second, ['make', 'lectra', 'study', 'notes', 'from', 'this', 'pdf']);
});

test('RAGCore.tokenize avoids retaining huge scraped source blobs', () => {
  RAGCore._tokenCache = new Map();
  const huge = `${'recursion '.repeat(1600)}dynamic programming`;
  const tokens = RAGCore.tokenize(huge);

  assert.ok(tokens.includes('recursion'));
  assert.ok(tokens.includes('dynamic'));
  assert.equal(RAGCore._tokenCache.size, 0);
});

test('RAGCore.compileRAGPrompt adds Lectra handoff guidance when requested', async () => {
  mockTabUrl = 'https://google.com';
  const compiled = await RAGCore.compileRAGPrompt('make this into Lectra iPad study notes');
  assert.ok(compiled.includes('Lectra handoff'));
  assert.ok(compiled.includes('source/page citations'));
});

test('RAGCore active recall guidance creates flashcard-style Lectra review loops', async () => {
  mockTabUrl = 'https://google.com';
  assert.equal(RAGCore.hasActiveRecallIntent('make Anki flashcards for this lecture'), true);
  assert.equal(RAGCore.hasActiveRecallIntent('summarize this lecture'), false);

  const compiled = await RAGCore.compileRAGPrompt('make flashcards for this PDF');
  assert.match(compiled, /5-8 quick retrieval prompts/);
  assert.match(compiled, /cloze-style card/);
  assert.match(compiled, /Lectra-ready review loop/);
});

test('RAGCore unified prompts include active recall guidance for quiz requests', async () => {
  mockTabUrl = 'https://google.com';
  const compiled = await RAGCore.compileUnifiedPrompt('quiz me with spaced repetition prompts');

  assert.match(compiled.prompt, /5-8 quick retrieval prompts/);
  assert.match(compiled.prompt, /what to quiz tomorrow/);
});

test('RAGCore study plan guidance creates timeboxed blocks for planning requests', async () => {
  mockTabUrl = 'https://google.com';
  assert.equal(RAGCore.hasStudyPlanIntent('make me a Pomodoro study plan for this class'), true);
  assert.equal(RAGCore.hasStudyPlanIntent('explain recursion'), false);

  const compiled = await RAGCore.compileUnifiedPrompt('make me a Pomodoro study plan for this class');
  assert.match(compiled.prompt, /short timeboxed blocks/);
  assert.match(compiled.prompt, /active-recall check/);
  assert.match(compiled.prompt, /next-session carryover/);
});

test('RAGCore legacy RAG prompts include study plan guidance', async () => {
  mockTabUrl = 'https://google.com';
  const compiled = await RAGCore.compileRAGPrompt('schedule study blocks for my homework');
  assert.match(compiled, /exact source\/task to open/);
});

test('RAGCore course brain prompts include study plan guidance', async () => {
  const compiled = await RAGCore.compileBrainPrompt('build a study sprint plan for my quiz');
  assert.match(compiled.prompt, /short timeboxed blocks/);
});

test('RAGCore source audit guidance separates evidence strength for grounded study notes', async () => {
  mockTabUrl = 'https://google.com';
  assert.equal(RAGCore.hasSourceAuditIntent('make source-backed study notes with an evidence checklist'), true);
  assert.equal(RAGCore.hasSourceAuditIntent('which sources mention recursion?'), false);

  const compiled = await RAGCore.compileUnifiedPrompt('make source-backed study notes with an evidence checklist');
  assert.match(compiled.prompt, /source\/evidence audit/);
  assert.match(compiled.prompt, /source-backed facts/);
  assert.match(compiled.prompt, /weakly supported assumptions/);
});

test('RAGCore.retrieveLocalContext surfaces tasks for schedule queries with no keyword match', async () => {
  // "what do I need to do?" does not lexically match any stored title/course,
  // but the context-aware fallback should still surface the pending to-do.
  const matches = await RAGCore.retrieveLocalContext('what do I need to do?');
  assert.ok(matches.length >= 1, 'expected at least one task surfaced');
  assert.ok(matches.some(m => m.type === 'to-do' && m.title === 'Finish reading RAG paper'));
});

test('RAGCore.retrieveLocalContext schedule fallback includes upcoming quizzes and discussions', async () => {
  const prevIndexed = mockStorage.indexedContent;
  mockStorage.indexedContent = [
    ...prevIndexed,
    {
      title: 'Chapter 5 readiness quiz',
      courseName: 'Biology',
      type: 'quiz',
      dueAt: '2099-01-10T12:00:00.000Z'
    },
    {
      title: 'Project proposal discussion',
      courseName: 'CS 101',
      type: 'discussion',
      dueAt: '2099-01-11T12:00:00.000Z'
    }
  ];

  try {
    const matches = await RAGCore.retrieveLocalContext('what is coming up?');
    assert.ok(matches.some(m => m.type === 'quiz' && m.title === 'Chapter 5 readiness quiz'));
    assert.ok(matches.some(m => m.type === 'discussion' && m.title === 'Project proposal discussion'));
  } finally {
    mockStorage.indexedContent = prevIndexed;
  }
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

test('RAGCore prompts add worked examples and edge cases for CS practice questions', async () => {
  assert.equal(RAGCore.hasExampleDrillIntent('help me study recursion with examples and edge cases'), true);
  assert.equal(RAGCore.hasExampleDrillIntent('summarize what we studied this week'), false);

  const prevIndexed = mockStorage.indexedContent;
  const prevTabUrl = mockTabUrl;
  mockTabUrl = 'https://google.com';
  mockStorage.indexedContent = [
    {
      title: 'Recursion worksheet',
      courseName: 'CS 61A',
      type: 'file',
      content: 'Base cases, recursive calls, and tree recursion examples.'
    }
  ];

  try {
    const compiled = await RAGCore.compileUnifiedPrompt('help me study recursion with examples and edge cases');
    assert.match(compiled.prompt, /one small worked example/i);
    assert.match(compiled.prompt, /edge\/corner case/i);
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevTabUrl;
  }
});

test('RAGCore prompts add Big-O guidance for CS complexity questions', async () => {
  assert.equal(RAGCore.hasComplexityIntent('what is the Big-O runtime?'), true);
  assert.equal(RAGCore.hasComplexityIntent('summarize the reading'), false);

  const prevIndexed = mockStorage.indexedContent;
  const prevTabUrl = mockTabUrl;
  mockTabUrl = 'https://google.com';
  mockStorage.indexedContent = [
    {
      title: 'Graph traversal notes',
      courseName: 'CS 61B',
      type: 'file',
      content: 'Breadth-first search visits vertices and edges.'
    }
  ];

  try {
    const compiled = await RAGCore.compileUnifiedPrompt('what is the time complexity of BFS?');
    assert.match(compiled.prompt, /time and space complexity/i);
    assert.match(compiled.prompt, /input variables/i);
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevTabUrl;
  }
});

test('RAGCore prompts structure concept maps and prerequisite gap checks', async () => {
  assert.equal(RAGCore.hasConceptMapIntent('make a concept map of trees and heaps'), true);
  assert.equal(RAGCore.hasConceptMapIntent('what are my knowledge gaps before the midterm?'), true);
  assert.equal(RAGCore.hasConceptMapIntent('summarize the reading'), false);

  const prevIndexed = mockStorage.indexedContent;
  const prevTabUrl = mockTabUrl;
  mockTabUrl = 'https://google.com';
  mockStorage.indexedContent = [
    {
      title: 'Trees and heaps notes',
      courseName: 'CS 61B',
      type: 'file',
      content: 'Binary trees, heaps, priority queues, and traversal invariants.'
    }
  ];

  try {
    const compiled = await RAGCore.compileUnifiedPrompt('make a concept map and gap check for heaps');
    assert.match(compiled.prompt, /Core concepts/);
    assert.match(compiled.prompt, /How they connect/);
    assert.match(compiled.prompt, /Prerequisites to review/);
    assert.match(compiled.prompt, /Next study action/);
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevTabUrl;
  }
});

test('RAGCore prompts build prioritized cram plans for upcoming assessments', async () => {
  assert.equal(RAGCore.hasExamCramIntent('make a last-minute midterm study plan for tonight'), true);
  assert.equal(RAGCore.hasExamCramIntent('review this quiz before class'), true);
  assert.equal(RAGCore.hasExamCramIntent('summarize the reading'), false);

  const prevIndexed = mockStorage.indexedContent;
  const prevTabUrl = mockTabUrl;
  mockTabUrl = 'https://google.com';
  mockStorage.indexedContent = [
    {
      title: 'Dynamic programming review sheet',
      courseName: 'CS 170',
      type: 'file',
      content: 'Optimal substructure, recurrence design, memoization, and tabulation practice.'
    }
  ];

  try {
    const compiled = await RAGCore.compileUnifiedPrompt('make a last-minute final cram plan for dynamic programming tonight');
    assert.match(compiled.prompt, /prioritized cram plan/i);
    assert.match(compiled.prompt, /20-30 minute blocks/i);
    assert.match(compiled.prompt, /active-recall checks/i);
    assert.match(compiled.prompt, /what to skip if time runs short/i);
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevTabUrl;
  }
});

test('RAGCore prompts add teach-back coaching for check-my-understanding requests', async () => {
  assert.equal(RAGCore.hasTeachBackIntent('use the Feynman technique to check my understanding'), true);
  assert.equal(RAGCore.hasTeachBackIntent('can I explain this back for an oral exam?'), true);
  assert.equal(RAGCore.hasTeachBackIntent('summarize the reading'), false);

  const prevIndexed = mockStorage.indexedContent;
  const prevTabUrl = mockTabUrl;
  mockTabUrl = 'https://google.com';
  mockStorage.indexedContent = [
    {
      title: 'Red-black tree lecture',
      courseName: 'CS 61B',
      type: 'file',
      content: 'Balancing invariants, rotations, black-height, and insertion fix-up cases.'
    }
  ];

  try {
    const compiled = await RAGCore.compileUnifiedPrompt('check my understanding with a Feynman teach-back for red-black trees');
    assert.match(compiled.prompt, /Socratic study coach/i);
    assert.match(compiled.prompt, /60-second explanation/i);
    assert.match(compiled.prompt, /likely gaps or misconceptions/i);
    assert.match(compiled.prompt, /simple rubric/i);
    assert.match(compiled.prompt, /follow-up question to test transfer/i);
  } finally {
    mockStorage.indexedContent = prevIndexed;
    mockTabUrl = prevTabUrl;
  }
});
