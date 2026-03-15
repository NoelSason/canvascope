const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Fuse = require('./lib/fuse.min.js');

const EXPORT_PATH = path.join(__dirname, '..', 'BerkeleyCanvascopeExport.json');
const FIXED_NOW = '2026-03-15T12:00:00-07:00';

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
    console,
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
    performance: {
      now: (() => {
        const start = Date.now();
        return () => Date.now() - start;
      })()
    },
    setTimeout,
    clearTimeout,
    window: null,
    self: null,
    document: {
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return makeElement(); },
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
      tabs: { create() {} },
      runtime: {
        sendMessage() {},
        onMessage: { addListener() {} }
      }
    }
  };

  context.window = context;
  context.self = context;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8'), context);

  vm.runInContext(`
    const stub = () => ({
      classList: { add() {}, remove() {}, toggle() {} },
      innerHTML: '',
      textContent: '',
      value: '',
      appendChild() {},
      addEventListener() {},
      querySelector() { return stub(); },
      querySelectorAll() { return []; }
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

    Date.now = () => new Date(${JSON.stringify(FIXED_NOW)}).getTime();
    starredCourseIds = new Set();
    clickFeedbackMap = {};
    populateCourseFilter = () => {};
    saveSearchToHistory = () => {};
    updateOverlayFooter = () => {};
    showNoResults = (msg) => { globalThis.__lastResults = { none: msg }; };
    displayResults = (results) => {
      globalThis.__lastResults = results.map(r => ({
        title: r.item.title,
        course: r.item.courseName,
        type: r.item.type,
        dueAt: r.item.dueAt || null
      }));
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
      globalThis.__lastResults = null;
      performSearch(query);
      return globalThis.__lastResults;
    };

    globalThis.__describeTask = (title, courseName = null) => {
      const item = state.indexedContent.find((candidate) => {
        if (candidate.title !== title) return false;
        if (!courseName) return true;
        return candidate.courseName === courseName;
      });
      if (!item) return null;
      return {
        completed: isCompletedTask(item),
        label: formatDueLabel(item),
        urgency: dueUrgencyClass(item),
        submitted: item.submitted ?? null,
        submissionStatus: item.submissionStatus ?? null
      };
    };
  `, context);

  return {
    run(query) {
      return vm.runInContext(`__runSearch(${JSON.stringify(query)})`, context);
    },
    describeTask(title, courseName = null) {
      return vm.runInContext(`__describeTask(${JSON.stringify(title)}, ${JSON.stringify(courseName)})`, context);
    }
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

if (!fs.existsSync(EXPORT_PATH)) {
  throw new Error(`Missing export file: ${EXPORT_PATH}`);
}

const indexedContent = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8')).indexedContent || [];
const harness = createSearchHarness(indexedContent);

const bioReportResults = harness.run('bio lab report');
assert(Array.isArray(bioReportResults) && bioReportResults.length >= 6, 'Expected multiple Biology lab reports for "bio lab report".');
assert(bioReportResults[0].course === '2026 Spring Biology 1AL', 'Expected Biology 1AL to rank first for "bio lab report".');
assert(bioReportResults.slice(0, 6).every(r => r.course === '2026 Spring Biology 1AL' && /report/i.test(r.title)), 'Expected top Biology report results to stay in Biology 1AL.');

const bioTypoResults = harness.run('bio lab reporrt');
assert(Array.isArray(bioTypoResults) && bioTypoResults.length >= 6, 'Expected typo-tolerant biology report results for "bio lab reporrt".');
assert(bioTypoResults[0].course === '2026 Spring Biology 1AL', 'Expected a misspelled "bio lab reporrt" query to still prioritize Biology 1AL.');

const biologyTypoResults = harness.run('biolgy lab report');
assert(Array.isArray(biologyTypoResults) && biologyTypoResults.length >= 6, 'Expected typo-tolerant biology results for "biolgy lab report".');
assert(biologyTypoResults[0].course === '2026 Spring Biology 1AL', 'Expected "biolgy lab report" to recover the Biology 1AL reports.');

const chemPrelabResults = harness.run('chem prelab');
assert(Array.isArray(chemPrelabResults) && chemPrelabResults.length > 0, 'Expected results for "chem prelab".');
assert(chemPrelabResults[0].title === 'PreLab G', 'Expected "PreLab G" to rank first for "chem prelab".');
assert(chemPrelabResults[0].course === 'Chem 3BL: Organic Chemistry Laboratory (Spring 2026)', 'Expected "chem prelab" to prioritize Chem 3BL.');

const chemTypoResults = harness.run('chem prelqb');
assert(Array.isArray(chemTypoResults) && chemTypoResults.length > 0, 'Expected typo-tolerant chemistry prelab results for "chem prelqb".');
assert(chemTypoResults[0].title === 'PreLab G', 'Expected "chem prelqb" to recover "PreLab G".');

const chemLabResults = harness.run('chem lab');
assert(Array.isArray(chemLabResults) && chemLabResults.slice(0, 5).some(r => r.title === 'PreLab G'), 'Expected "PreLab G" to remain visible near the top for "chem lab".');

const chemLabWeekResults = harness.run('chem lab this week');
assert(Array.isArray(chemLabWeekResults) && chemLabWeekResults.length > 0, 'Expected weekly chemistry lab results.');
assert(chemLabWeekResults[0].course.includes('Chem'), 'Expected "chem lab this week" to rank a chemistry course first.');
assert(chemLabWeekResults.slice(0, 5).every(r => r.course.includes('Chem')), 'Expected top weekly chemistry lab results to stay within chemistry courses.');

const completedBioLab = harness.describeTask('Lab 5 Post-Lab Assessment', '2026 Spring Biology 1AL');
assert(completedBioLab?.completed === true, 'Expected Lab 5 Post-Lab Assessment to be detected as completed.');
assert(completedBioLab?.label === 'Completed', 'Expected completed tasks to show a Completed label.');
assert(completedBioLab?.urgency === 'completed', 'Expected completed tasks to use the completed chip style.');

const incompleteChemPrelab = harness.describeTask('PreLab G', 'Chem 3BL: Organic Chemistry Laboratory (Spring 2026)');
assert(incompleteChemPrelab?.completed === false, 'Expected PreLab G to remain incomplete when Canvas reports it as unsubmitted.');
assert(incompleteChemPrelab?.label !== 'Completed', 'Expected PreLab G to keep a due-date label instead of Completed.');

const incompleteChemData = harness.describeTask('Lab F Data Analysis', 'Chem 3BL: Organic Chemistry Laboratory (Spring 2026)');
assert(incompleteChemData?.completed === false, 'Expected Lab F Data Analysis to remain incomplete without concrete submission evidence.');

const completionPriorityHarness = createSearchHarness([
  {
    title: 'Lab 5 Post-Lab Assessment',
    url: 'https://example.edu/courses/1/assignments/1',
    type: 'assignment',
    courseName: '2026 Spring Biology 1AL',
    dueAt: '2026-03-16T06:59:59Z',
    submitted: true,
    submissionStatus: 'submitted',
    submission: {
      workflowState: 'graded',
      submittedAt: '2026-03-15T04:00:00Z',
      score: 3
    }
  },
  {
    title: 'Lab 6 Post-Lab Assessment',
    url: 'https://example.edu/courses/1/assignments/2',
    type: 'assignment',
    courseName: '2026 Spring Biology 1AL',
    dueAt: '2026-03-17T06:59:59Z',
    submitted: false,
    submissionStatus: 'not_submitted',
    submission: null
  }
]);
const completionPriorityResults = completionPriorityHarness.run('bio lab this week');
assert(Array.isArray(completionPriorityResults) && completionPriorityResults.length === 2, 'Expected synthetic completion-priority results.');
assert(completionPriorityResults[0].title === 'Lab 6 Post-Lab Assessment', 'Expected unfinished biology work to rank above the completed lab.');
assert(completionPriorityResults[1].title === 'Lab 5 Post-Lab Assessment', 'Expected completed biology work to be demoted behind unfinished work.');

console.log('PASS test_search_regressions');
