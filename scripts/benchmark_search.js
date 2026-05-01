const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Fuse = require('../lib/fuse.min.js');

const RUNS = Number.parseInt(process.env.SEARCH_BENCH_RUNS || '15', 10);
const COURSE_COUNT = 20;
const UNIT_COUNT = 12;
const ITEMS_PER_UNIT = 30;

function makeElement() {
  return {
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    innerHTML: '',
    textContent: '',
    value: '',
    appendChild() {},
    removeChild() {},
    replaceChildren() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    focus() {},
    blur() {},
    closest() { return null; },
    contains() { return false; },
    cloneNode() { return makeElement(); }
  };
}

function createSearchHarness(indexedContent) {
  const context = {
    console: {
      log() {},
      warn: console.warn,
      error: console.error
    },
    Fuse,
    URL,
    Date,
    Math,
    JSON,
    RegExp,
    Set,
    Map,
    WeakMap,
    WeakSet,
    Array,
    Object,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    isNaN,
    performance,
    setTimeout,
    clearTimeout,
    window: null,
    self: null,
    document: {
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return makeElement(); },
      querySelector() { return makeElement(); },
      querySelectorAll() { return []; },
      createElement() { return makeElement(); },
      body: makeElement()
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({}),
          set: async () => ({})
        }
      },
      tabs: {
        create() {},
        update() {}
      },
      runtime: {
        sendMessage() {},
        onMessage: { addListener() {} },
        getURL() { return 'chrome-extension://benchmark/'; }
      }
    }
  };

  context.window = context;
  context.self = context;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), context);

  vm.runInContext(`
    const stub = () => ({
      classList: { add() {}, remove() {}, toggle() {} },
      style: {},
      innerHTML: '',
      textContent: '',
      value: '',
      appendChild() {},
      removeChild() {},
      addEventListener() {},
      querySelector() { return stub(); },
      querySelectorAll() { return []; },
      setAttribute() {},
      focus() {}
    });

    elements.loadingShell = stub();
    elements.emptyState = stub();
    elements.resultsContainer = stub();
    elements.scanProgress = { ...stub(), value: 0 };
    elements.duePlanner = stub();
    elements.statusText = stub();
    elements.searchInput = { value: '' };
    elements.searchHistory = stub();
    elements.courseOptions = stub();
    elements.courseText = stub();
    elements.typeOptions = stub();
    elements.typeText = stub();
    elements.statsText = stub();
    elements.statsHint = stub();
    elements.syncStatus = stub();
    elements.syncIcon = stub();
    elements.syncText = stub();
    elements.overlayFooter = stub();
    elements.overlayResultCount = stub();
    elements.overlaySearchTime = stub();
    elements.clearSearchBtn = stub();

    starredCourseIds = new Set();
    clickFeedbackMap = {};
    populateCourseFilter = () => {};
    saveSearchToHistory = () => {};
    updateOverlayFooter = () => {};
    showNoResults = () => {};
    displayResults = (results) => {
      globalThis.__lastResultCount = results.length;
    };

    state.indexedContent = ${JSON.stringify(indexedContent)};
    state.filters = { course: [], type: '' };
    state.extensionSettings = {
      enableSendToLectra: false,
      selectedCourseFilters: [],
      customAlgorithm: {
        enabled: false,
        fuzzyThreshold: 35,
        titleWeight: 100,
        contextWeight: 100,
        recencyBoost: 100,
        courseBoost: 100,
        dueDateBoost: 100,
        typeBoost: 100
      }
    };
    state.dismissedTasks = [];
    state.isOverlayMode = true;

    initializeFuse();

    globalThis.__runSearch = (query) => {
      globalThis.__lastResultCount = 0;
      performSearch(query);
      return globalThis.__lastResultCount;
    };
  `, context);

  return {
    run(query) {
      return vm.runInContext(`__runSearch(${JSON.stringify(query)})`, context);
    }
  };
}

function createSyntheticCorpus() {
  const items = [];

  for (let courseIdx = 1; courseIdx <= COURSE_COUNT; courseIdx++) {
    const courseName = `Chem ${courseIdx}A (Spring 2025)`;

    for (let unitIdx = 1; unitIdx <= UNIT_COUNT; unitIdx++) {
      for (let itemIdx = 0; itemIdx < ITEMS_PER_UNIT; itemIdx++) {
        const letter = String.fromCharCode(65 + (itemIdx % 26));
        const isFolder = itemIdx % 5 === 0;
        const isKeyLike = itemIdx % 7 === 0;

        items.push({
          title: `${letter}. Topic ${unitIdx}-${itemIdx}`,
          url: `https://example.edu/${courseIdx}/${unitIdx}/${itemIdx}`,
          type: isFolder ? 'folder' : 'file',
          courseName,
          folderPath: isKeyLike
            ? `1. Homework > ${unitIdx}. Unit ${unitIdx} > Unit ${unitIdx} Homework Keys`
            : `1. Homework > ${unitIdx}. Unit ${unitIdx}`,
          moduleName: isFolder ? 'Files' : 'Unit Materials',
          scannedAt: '2026-04-20T12:00:00Z'
        });
      }
    }
  }

  return items;
}

function summarize(times) {
  const sorted = [...times].sort((lhs, rhs) => lhs - rhs);
  const avg = times.reduce((sum, value) => sum + value, 0) / times.length;
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    avgMs: Number(avg.toFixed(2)),
    p95Ms: Number(sorted[p95Index].toFixed(2))
  };
}

function main() {
  const corpus = createSyntheticCorpus();
  const harness = createSearchHarness(corpus);
  const queries = [
    'chem 3a homework w',
    'chem 12a topic 8',
    'topic 4-1',
    'homework keys',
    'chem 7a homework'
  ];

  console.log(`Synthetic search benchmark: ${corpus.length} items, ${RUNS} runs/query`);

  for (const query of queries) {
    harness.run(query);

    const times = [];
    let resultCount = 0;
    for (let run = 0; run < RUNS; run++) {
      const start = performance.now();
      resultCount = harness.run(query);
      times.push(performance.now() - start);
    }

    const { avgMs, p95Ms } = summarize(times);
    console.log(JSON.stringify({
      query,
      resultCount,
      avgMs,
      p95Ms
    }));
  }
}

main();
