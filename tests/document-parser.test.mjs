import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docParserPath = path.resolve(__dirname, '..', 'v8', 'document-parser.js');
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
const matcherPath = path.resolve(__dirname, '..', 'v8', 'semantic-matcher.js');
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
