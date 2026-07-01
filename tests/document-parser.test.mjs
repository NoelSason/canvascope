import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docParserPath = path.resolve(__dirname, '..', 'src', 'core', 'document-parser.js');
const docParserCode = fs.readFileSync(docParserPath, 'utf8');

// Define chrome mocks
let mockStorage = {};
globalThis.chrome = {
  runtime: {
    getURL: (p) => `chrome-extension://mock-id/${p}`
  },
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        for (const k of keys) {
          out[k] = mockStorage[k];
        }
        return out;
      },
      set: async (obj) => {
        mockStorage = { ...mockStorage, ...obj };
      }
    }
  }
};

// Define pdfjsLib mock
globalThis.window = globalThis;
globalThis.pdfjsLib = {
  GlobalWorkerOptions: {
    workerSrc: ''
  },
  getDocument: () => {
    return {
      promise: Promise.resolve({
        numPages: 3,
        getPage: async (pageNum) => {
          return {
            getTextContent: async () => {
              return {
                items: [
                  { str: `This is text content on page ${pageNum}.` },
                  { str: pageNum === 2 ? 'Biodiesel synthesis kinetics.' : 'General outline.' }
                ]
              };
            }
          };
        }
      })
    };
  }
};

// Evaluate the SemanticMatcher first to enable hybrid retrieval testing
const matcherPath = path.resolve(__dirname, '..', 'src', 'core', 'semantic-matcher.js');
const matcherCode = fs.readFileSync(matcherPath, 'utf8');
new Function(matcherCode + '\nglobalThis.SemanticMatcher = SemanticMatcher;')();

// Evaluate the DocumentParser code
new Function(docParserCode + '\nglobalThis.DocumentParser = DocumentParser;')();

test('DocumentParser.extractTextFromPdf extracts page-by-page text content', async () => {
  const pagesText = await DocumentParser.extractTextFromPdf(new ArrayBuffer(10));
  assert.equal(pagesText.length, 3);
  assert.ok(pagesText[0].includes('page 1'));
  assert.ok(pagesText[1].includes('Biodiesel'));
});

test('DocumentParser.extractTextFromPdf supports page ranges and progress callbacks for large PDFs', async () => {
  const progress = [];
  const pagesText = await DocumentParser.extractTextFromPdf(new ArrayBuffer(10), {
    startPage: 2,
    endPage: 3,
    onProgress: (event) => progress.push(event)
  });

  assert.equal(pagesText.length, 2);
  assert.ok(pagesText[0].includes('page 2'));
  assert.ok(pagesText[1].includes('page 3'));
  assert.deepEqual(progress.map(event => event.pageNum), [2, 3]);
  assert.deepEqual(progress.map(event => event.total), [2, 2]);
});

test('DocumentParser.normalizePageSelection clamps and de-duplicates explicit PDF scopes', () => {
  assert.deepEqual(DocumentParser.normalizePageSelection(5, { pages: [4, 2, 2, 99, -3] }), [1, 2, 4, 5]);
  assert.deepEqual(DocumentParser.normalizePageSelection(3, { startPage: 3, endPage: 2 }), [2, 3]);
});

test('DocumentParser.fetchAndParsePdf utilizes storage caches', async () => {
  mockStorage = {};
  const mockUrl = 'https://mit.edu/syllabus.pdf';
  
  // Set mock network fetch
  globalThis.fetch = async () => {
    return {
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(20)
    };
  };

  // 1. First run: cache miss
  const pages1 = await DocumentParser.fetchAndParsePdf(mockUrl);
  assert.equal(pages1.length, 3);
  
  const cacheKey = 'doc_cache_pdf:https://mit.edu/syllabus.pdf';
  assert.ok(mockStorage[cacheKey]);

  // 2. Second run: cache hit (should skip fetch entirely)
  globalThis.fetch = () => { throw new Error('Fetch should have been bypassed!'); };
  const pages2 = await DocumentParser.fetchAndParsePdf(mockUrl);
  assert.equal(pages2.length, 3);
});

test('DocumentParser.fetchAndParsePdf keeps scoped PDF cache separate from full index', async () => {
  mockStorage = { indexedContent: [] };
  const mockUrl = 'https://mit.edu/large-textbook.pdf';
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return {
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(20)
    };
  };

  const scoped = await DocumentParser.fetchAndParsePdf(mockUrl, 'Large Textbook', 'CS 101', { startPage: 2, endPage: 2 });
  assert.equal(scoped.length, 1);
  assert.equal(fetches, 1);
  assert.equal(mockStorage.indexedContent.length, 0);
  assert.ok(mockStorage['doc_cache_pdf:https://mit.edu/large-textbook.pdf:range:2-2']);
  assert.equal(mockStorage['doc_cache_pdf:https://mit.edu/large-textbook.pdf'], undefined);

  const cachedScoped = await DocumentParser.fetchAndParsePdf(mockUrl, 'Large Textbook', 'CS 101', { startPage: 2, endPage: 2 });
  assert.equal(cachedScoped.length, 1);
  assert.equal(fetches, 1);
});

test('DocumentParser.fetchAndParsePdf coalesces concurrent parses for the same PDF scope', async () => {
  mockStorage = { indexedContent: [] };
  DocumentParser._fetchParseInFlight = new Map();
  const mockUrl = 'https://ucla.edu/concurrent-notes.pdf';
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return {
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(20)
    };
  };

  const [first, second] = await Promise.all([
    DocumentParser.fetchAndParsePdf(mockUrl, 'Concurrent Notes', 'CS 180', { startPage: 1, endPage: 2 }),
    DocumentParser.fetchAndParsePdf(mockUrl, 'Concurrent Notes', 'CS 180', { startPage: 1, endPage: 2 })
  ]);

  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  assert.equal(fetches, 1);
  assert.equal(DocumentParser._fetchParseInFlight.size, 0);
});

test('DocumentParser.scoreDocumentPages ranks relevant pages and chunks appropriately', () => {
  const pages = [
    'Lecture 1 covers basic thermodynamics and heat transfer.',
    'Lecture 2 covers chemical kinetics and biodiesel synthesis.',
    'Lecture 3 is a general wrap-up of organic chemistry lab safety guidelines.'
  ];

  // Search for kinetics and biodiesel
  const scored = DocumentParser.scoreDocumentPages(pages, 'Tell me about chemical kinetics or biodiesel.');
  assert.equal(scored.length, 1);
  assert.equal(scored[0].pageNum, 2);
  assert.ok(scored[0].text.includes('biodiesel'));

  // Default fallback returns first 3 pages if no tokens match
  const fallback = DocumentParser.scoreDocumentPages(pages, '');
  assert.equal(fallback.length, 3);
  assert.equal(fallback[0].pageNum, 1);
});

test('DocumentParser.scoreDocumentPages is resilient to pasted repeated prompts', () => {
  const pages = [
    'Stacks queues heaps and graphs.',
    'Dynamic programming memoization and recurrence examples.',
    null
  ];

  const scored = DocumentParser.scoreDocumentPages(pages, 'memoization memoization recurrence recurrence');
  assert.equal(scored[0].pageNum, 2);
  assert.ok(scored[0].text.includes('memoization'));

  const fallback = DocumentParser.scoreDocumentPages(pages, null);
  assert.equal(fallback.length, 3);
  assert.equal(fallback[2].text, null);
});

test('DocumentParser.scoreDocumentPages caches semantic page vectors for follow-up questions', () => {
  const pages = [
    'Lecture notes on dynamic programming memoization recurrence examples.',
    'PDF notes about graph traversal, breadth first search, and depth first search.'
  ];
  const originalVectorize = SemanticMatcher.vectorize;
  let pageVectorizations = 0;
  SemanticMatcher.vectorize = (text) => {
    if (pages.includes(text)) {
      pageVectorizations += 1;
    }
    return originalVectorize.call(SemanticMatcher, text);
  };
  DocumentParser._pageVectorCache = new Map();

  try {
    DocumentParser.scoreDocumentPages(pages, 'lecture notes dynamic programming memoization');
    const afterFirstQuestion = pageVectorizations;
    DocumentParser.scoreDocumentPages(pages, 'pdf notes graph traversal');
    assert.equal(pageVectorizations, afterFirstQuestion);
  } finally {
    SemanticMatcher.vectorize = originalVectorize;
  }

  assert.equal(pageVectorizations, 2);
  assert.ok(DocumentParser._pageVectorCache.size >= 2);
});

test('DocumentParser.persistPdfToIndex saves PDF persistently to indexedContent', async () => {
  mockStorage = { indexedContent: [] };
  const mockUrl = 'https://ucla.edu/syllabus.pdf';
  const pagesText = ['Page 1 outline.', 'Page 2 schedule.'];

  await DocumentParser.persistPdfToIndex(mockUrl, 'Syllabus', 'CS 101', pagesText);

  const indexed = mockStorage.indexedContent;
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].title, 'Syllabus');
  assert.equal(indexed[0].courseName, 'CS 101');
  assert.equal(indexed[0].content, 'Page 1 outline.\nPage 2 schedule.');
  assert.deepEqual(indexed[0].pages, pagesText);
});

test('DocumentParser.persistPdfToIndex skips identical PDF rewrites', async () => {
  let writes = 0;
  const existing = {
    title: 'Algorithms Notes',
    courseName: 'CS 101',
    url: 'https://ucla.edu/algorithms.pdf?download=1',
    type: 'file',
    content: 'Page 1 graph search.\nPage 2 dynamic programming.',
    pages: ['Page 1 graph search.', 'Page 2 dynamic programming.'],
    indexedAt: 12345
  };
  mockStorage = { indexedContent: [existing] };
  const originalSet = chrome.storage.local.set;
  chrome.storage.local.set = async (obj) => {
    writes += 1;
    return originalSet(obj);
  };

  try {
    await DocumentParser.persistPdfToIndex(
      'https://ucla.edu/algorithms.pdf?download=2',
      'Algorithms Notes',
      'CS 101',
      ['Page 1 graph search.', 'Page 2 dynamic programming.']
    );
  } finally {
    chrome.storage.local.set = originalSet;
  }

  assert.equal(writes, 0);
  assert.equal(mockStorage.indexedContent.length, 1);
  assert.equal(mockStorage.indexedContent[0].indexedAt, 12345);
});
