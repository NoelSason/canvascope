const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Fuse = require('./lib/fuse.min.js');

function resolveFixturePath(filename) {
  const candidates = [
    path.join(__dirname, filename),
    path.join(__dirname, '..', filename)
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

const EXPORT_PATH = resolveFixturePath('BerkeleyCanvascopeExport.json');
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
        url: r.item.url,
        course: r.item.courseName,
        type: r.item.type,
        dueAt: r.item.dueAt || null,
        folderPath: r.item.folderPath || null
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

    globalThis.__runOverlayInput = (query) => {
      state.isOverlayMode = true;
      elements.searchInput.value = query;
      globalThis.__lastResults = null;
      handleSearchInput({ target: { value: query } });
      const snapshot = {
        resultCount: Array.isArray(globalThis.__lastResults) ? globalThis.__lastResults.length : 0,
        firstTitle: Array.isArray(globalThis.__lastResults) && globalThis.__lastResults[0] ? globalThis.__lastResults[0].title : null,
        searchTimeoutActive: Boolean(state.searchTimeout),
        sideEffectTimeoutActive: Boolean(state.searchSideEffectTimeout)
      };
      clearScheduledSearch();
      clearScheduledSearchSideEffects();
      return snapshot;
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
    input(query) {
      return vm.runInContext(`__runOverlayInput(${JSON.stringify(query)})`, context);
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

function dueTs(result) {
  const ts = Date.parse(result?.dueAt || '');
  return Number.isFinite(ts) ? ts : 0;
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
const chemLabDueWindow = chemLabResults
  .slice(0, 7)
  .map(dueTs)
  .filter(ts => ts > 0);
assert(chemLabDueWindow.length >= 5, 'Expected multiple dated chemistry lab results near the top.');
assert(chemLabDueWindow.every((ts, index) => index === 0 || chemLabDueWindow[index - 1] <= ts), 'Expected "chem lab" to prioritize nearer due dates before later ones.');
const preLabGIndex = chemLabResults.findIndex(r => r.title === 'PreLab G');
const futureLabGIndex = chemLabResults.findIndex(r => /Lab G\.[A-Z]/.test(r.title));
assert(preLabGIndex !== -1 && futureLabGIndex !== -1 && preLabGIndex < futureLabGIndex, 'Expected current-week "PreLab G" to rank ahead of later Lab G analysis variants.');

const chemLabWeekResults = harness.run('chem lab this week');
assert(Array.isArray(chemLabWeekResults) && chemLabWeekResults.length > 0, 'Expected weekly chemistry lab results.');
assert(chemLabWeekResults[0].course.includes('Chem'), 'Expected "chem lab this week" to rank a chemistry course first.');
assert(chemLabWeekResults.slice(0, 5).every(r => r.course.includes('Chem')), 'Expected top weekly chemistry lab results to stay within chemistry courses.');

const syntheticBioLabHarness = createSearchHarness([
  {
    title: 'Lab 9 Pre-Lab Assessment',
    url: 'https://example.edu/courses/1/assignments/1',
    type: 'assignment',
    courseName: '2026 Spring Biology 1AL',
    dueAt: '2026-03-16T06:59:59Z'
  },
  {
    title: 'Lab 9 Vertebrate Anatomy Report',
    url: 'https://example.edu/courses/1/assignments/2',
    type: 'assignment',
    courseName: '2026 Spring Biology 1AL',
    dueAt: '2026-03-17T06:59:59Z'
  },
  {
    title: 'Lab 9A - Vertebrate Anatomy Introduction',
    url: 'https://example.edu/courses/1/pages/lab-9a',
    type: 'page',
    courseName: '2026 Spring Biology 1AL'
  },
  {
    title: 'Lab 9B - Rodent Dissection: External Features',
    url: 'https://example.edu/courses/1/pages/lab-9b',
    type: 'page',
    courseName: '2026 Spring Biology 1AL'
  },
  {
    title: 'Lab 9C - Rodent Dissection: Subcutaneous Anatomy',
    url: 'https://example.edu/courses/1/pages/lab-9c',
    type: 'page',
    courseName: '2026 Spring Biology 1AL'
  }
]);
const syntheticBioLabResults = syntheticBioLabHarness.run('bio lab');
assert(Array.isArray(syntheticBioLabResults) && syntheticBioLabResults.length >= 5, 'Expected synthetic "bio lab" results.');
assert(syntheticBioLabResults.slice(0, 5).some(r => /Lab 9A/.test(r.title)), 'Expected synthetic "bio lab" to surface Lab 9A pages without typing the suffix.');
assert(syntheticBioLabResults.slice(0, 5).some(r => /Lab 9B/.test(r.title)), 'Expected synthetic "bio lab" to surface Lab 9B pages without typing the suffix.');
assert(syntheticBioLabResults.slice(0, 5).some(r => /Lab 9C/.test(r.title)), 'Expected synthetic "bio lab" to surface Lab 9C pages without typing the suffix.');

const syntheticChemQuizHarness = createSearchHarness([
  {
    title: 'Quiz 7',
    url: 'https://example.edu/courses/2/quizzes/7',
    type: 'quiz',
    courseName: 'Chem 3B (Spring 2026)',
    dueAt: '2026-03-16T18:00:00Z'
  },
  {
    title: 'Quiz 8',
    url: 'https://example.edu/courses/2/quizzes/8',
    type: 'quiz',
    courseName: 'Chem 3B (Spring 2026)',
    dueAt: '2026-03-18T18:00:00Z'
  },
  {
    title: 'Quiz 9',
    url: 'https://example.edu/courses/2/quizzes/9',
    type: 'quiz',
    courseName: 'Chem 3B (Spring 2026)',
    dueAt: '2026-03-27T18:00:00Z'
  },
  {
    title: 'Quiz 10',
    url: 'https://example.edu/courses/2/quizzes/10',
    type: 'quiz',
    courseName: 'Chem 3B (Spring 2026)',
    dueAt: '2026-04-03T18:00:00Z'
  }
]);
const syntheticChemQuizResults = syntheticChemQuizHarness.run('chem quiz');
assert(Array.isArray(syntheticChemQuizResults) && syntheticChemQuizResults.length >= 4, 'Expected synthetic "chem quiz" results.');
assert(syntheticChemQuizResults[0].title === 'Quiz 7', 'Expected broad "chem quiz" to surface the earliest current-week quiz first.');
assert(syntheticChemQuizResults[1].title === 'Quiz 8', 'Expected broad "chem quiz" to keep the rest of the current-week quiz cluster ahead of later quizzes.');
assert(dueTs(syntheticChemQuizResults[1]) < dueTs(syntheticChemQuizResults[2]), 'Expected later quizzes to trail the current-week quiz cluster.');

const syntheticSelfAssessmentHarness = createSearchHarness([
  {
    title: 'Week 15 Self-Assessment',
    url: 'https://example.edu/courses/bio1a/assignments/week-15-self-assessment',
    type: 'assignment',
    courseName: '2026 Spring Biology 1A',
    dueAt: '2026-03-22T06:59:59Z'
  },
  {
    title: 'Week 14 Self-Assessment',
    url: 'https://example.edu/courses/bio1a/assignments/week-14-self-assessment',
    type: 'assignment',
    courseName: '2026 Spring Biology 1A',
    dueAt: '2026-03-15T22:00:00Z',
    submitted: false,
    submissionStatus: 'not_submitted',
    submission: null
  },
  {
    title: 'Week 13 Self-Assessment',
    url: 'https://example.edu/courses/bio1a/assignments/week-13-self-assessment',
    type: 'assignment',
    courseName: '2026 Spring Biology 1A',
    dueAt: '2026-03-08T06:59:59Z',
    submitted: true,
    submissionStatus: 'submitted',
    submission: {
      workflowState: 'submitted',
      submittedAt: '2026-03-07T05:00:00Z'
    }
  }
]);
const selfAssessmentResults = syntheticSelfAssessmentHarness.run('self a');
assert(Array.isArray(selfAssessmentResults) && selfAssessmentResults.length >= 3, 'Expected synthetic self-assessment results for "self a".');
assert(selfAssessmentResults[0].title === 'Week 14 Self-Assessment', 'Expected the incomplete self-assessment due soonest to rank first for "self a".');
assert(selfAssessmentResults[1].title === 'Week 15 Self-Assessment', 'Expected later upcoming self-assessment to follow the due-soon item.');
assert(selfAssessmentResults[2].title === 'Week 13 Self-Assessment', 'Expected completed self-assessment to stay behind unfinished work.');

const homeworkKeyPreferenceHarness = createSearchHarness([
  {
    title: 'W. Epoxides as electrophiles (Chem 3A - ...)',
    url: 'https://example.edu/courses/chem3a/files/homework-w',
    type: 'file',
    courseName: 'Chem 3A (Spring 2025)',
    folderPath: '1. Homework > 4. Unit 3'
  },
  {
    title: 'W. Epoxides as electrophiles (Chem 3A - ...)',
    url: 'https://example.edu/courses/chem3a/files/homework-w-key',
    type: 'file',
    courseName: 'Chem 3A (Spring 2025)',
    folderPath: '1. Homework > 4. Unit 3 > Unit 3 Homework Keys'
  },
  {
    title: '1. Homework',
    url: 'https://example.edu/courses/chem3a/folders/homework',
    type: 'folder',
    courseName: 'Chem 3A (Spring 2025)',
    folderPath: '1. Homework'
  },
  {
    title: 'Unit 3 Homework Keys',
    url: 'https://example.edu/courses/chem3a/folders/homework-keys',
    type: 'folder',
    courseName: 'Chem 3A (Spring 2025)',
    folderPath: '1. Homework > 4. Unit 3 > Unit 3 Homework Keys'
  }
]);
const homeworkVsKeyResults = homeworkKeyPreferenceHarness.run('chem 3a homework w');
assert(Array.isArray(homeworkVsKeyResults) && homeworkVsKeyResults.length >= 4, 'Expected synthetic homework-vs-key results.');
assert(homeworkVsKeyResults[0].url === 'https://example.edu/courses/chem3a/files/homework-w', 'Expected the non-key homework file to rank first for "chem 3a homework w".');
const homeworkFolderIndex = homeworkVsKeyResults.findIndex(r => r.url === 'https://example.edu/courses/chem3a/folders/homework');
assert(homeworkFolderIndex > 0, 'Expected the generic homework folder to remain visible without outranking the matching homework file.');
const explicitKeyResults = homeworkKeyPreferenceHarness.run('chem 3a homework key w');
assert(Array.isArray(explicitKeyResults) && explicitKeyResults.length >= 2, 'Expected explicit key results for "chem 3a homework key w".');
assert(explicitKeyResults[0].url === 'https://example.edu/courses/chem3a/files/homework-w-key', 'Expected the key-like homework file to rank first when the query explicitly asks for a key.');
const explicitAnswerKeyResults = homeworkKeyPreferenceHarness.run('chem 3a answer key w');
assert(Array.isArray(explicitAnswerKeyResults) && explicitAnswerKeyResults.length > 0, 'Expected explicit answer-key results for "chem 3a answer key w".');
const answerKeyFileIndex = explicitAnswerKeyResults.findIndex(r => r.url === 'https://example.edu/courses/chem3a/files/homework-w-key');
const answerKeyNonKeyIndex = explicitAnswerKeyResults.findIndex(r => r.url === 'https://example.edu/courses/chem3a/files/homework-w');
assert(answerKeyFileIndex !== -1, 'Expected the key-like homework file to remain visible for "chem 3a answer key w".');
assert(answerKeyNonKeyIndex === -1 || answerKeyFileIndex < answerKeyNonKeyIndex, 'Expected the key-like homework file to outrank the non-key homework file for "chem 3a answer key w".');

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

const pdfBodyRecallHarness = createSearchHarness([
  {
    title: '3BL Lab Exam Seating Arrangements - Spring 2026.pdf',
    url: 'https://example.edu/courses/chem3bl/files/seating-arrangements',
    type: 'file',
    courseName: 'Chem 3BL: Organic Chemistry Laboratory (Spring 2026)',
    content: 'Students should check the balcony seating chart and bring a non-programmable calculator.'
  },
  {
    title: 'Organic Chemistry Lab Manual',
    url: 'https://example.edu/courses/chem3bl/files/manual',
    type: 'file',
    courseName: 'Chem 3BL: Organic Chemistry Laboratory (Spring 2026)',
    folderPath: 'Course Documents'
  }
]);
const pdfBodyRecallResults = pdfBodyRecallHarness.run('balcony seating chart');
assert(Array.isArray(pdfBodyRecallResults) && pdfBodyRecallResults.length > 0, 'Expected body-only PDF content recall results.');
assert(pdfBodyRecallResults[0].title === '3BL Lab Exam Seating Arrangements - Spring 2026.pdf', 'Expected Cmd+K search to find a PDF by text that exists only in its persisted body content.');

const overlaySchedulerHarness = createSearchHarness([
  {
    title: 'PLWS 10',
    url: 'https://example.edu/courses/chem3b/assignments/plws-10',
    type: 'assignment',
    courseName: 'Chem 3B (Fall 2025)',
    folderPath: 'Assignments'
  },
  {
    title: 'Practice Lecture Worksheet',
    url: 'https://example.edu/courses/chem3b/files/practice-worksheet',
    type: 'file',
    courseName: 'Chem 3B (Fall 2025)',
    folderPath: 'Files'
  }
]);
const oneCharOverlayInput = overlaySchedulerHarness.input('p');
assert(oneCharOverlayInput.resultCount > 0, 'Expected one-character Cmd+K input to render a fast preview.');
assert(oneCharOverlayInput.searchTimeoutActive === false, 'Expected one-character Cmd+K input to skip the full Fuse/ranking search.');
assert(oneCharOverlayInput.sideEffectTimeoutActive === false, 'Expected hot Cmd+K input to avoid storage/network side effects.');
const twoCharOverlayInput = overlaySchedulerHarness.input('pl');
assert(twoCharOverlayInput.resultCount > 0, 'Expected two-character Cmd+K input to render a fast preview immediately.');
assert(twoCharOverlayInput.searchTimeoutActive === true, 'Expected two-character Cmd+K input to schedule, not synchronously run, the full search.');
assert(twoCharOverlayInput.sideEffectTimeoutActive === false, 'Expected scheduled Cmd+K search input to defer side effects until after the full search settles.');

console.log('PASS test_search_regressions');
