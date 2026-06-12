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
