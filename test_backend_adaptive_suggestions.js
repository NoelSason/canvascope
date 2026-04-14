const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Keep this legacy popup regression deterministic in CI, which runs in UTC.
process.env.TZ = 'America/Los_Angeles';

const Fuse = require('./lib/fuse.min.js');

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

async function createHarness() {
  const sentMessages = [];
  const FIXED_NOW = new Date('2026-03-23T20:10:00-07:00').getTime();

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
    Promise,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    Intl,
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
          set: async () => ({}),
          remove: async () => ({})
        }
      },
      tabs: { create() {}, update() {} },
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          sentMessages.push(message);
          if (message.type === 'fetchAdaptiveSearchSuggestions') {
            callback?.({
              success: true,
              suggestions: [
                {
                  query: 'chem lab 4',
                  baseQuery: 'chem lab',
                  predictedSequenceNumber: 4,
                  confidence: 0.93,
                  slotMatch: true
                }
              ]
            });
            return;
          }
          if (message.type === 'recordAdaptiveSearchEvent') {
            callback?.({ success: true });
            return;
          }
          callback?.({ success: false });
        },
        onMessage: { addListener() {} }
      }
    }
  };

  context.window = context;
  context.self = context;
  context.Date.now = () => FIXED_NOW;

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

    elements.searchInput = { value: '' };
    elements.searchHistory = stub();
    elements.emptyState = stub();
    elements.homeSections = stub();
    elements.duePlanner = stub();
    elements.resultsContainer = stub();

    state.extensionSettings = {
      enableAdaptiveLearning: true,
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
    state.searchHabits = createEmptySearchHabits();

    globalThis.__loadBackendSuggestions = async () => await loadBackendAdaptiveSuggestions({ force: true });
    globalThis.__boostQuery = (query) => getWeeklyHabitBoostQuery(query);
    globalThis.__buildEvent = (kind, query) => buildAdaptiveSearchEventPayload(kind, query);
    globalThis.__recordEvent = async (kind, query, overrides) => await recordAdaptiveSearchEvent(kind, query, overrides || {});
  `, context);

  return {
    sentMessages,
    async loadBackendSuggestions() {
      return await vm.runInContext('__loadBackendSuggestions()', context);
    },
    boostQuery(query) {
      return vm.runInContext(`__boostQuery(${JSON.stringify(query)})`, context);
    },
    buildEvent(kind, query) {
      return vm.runInContext(`__buildEvent(${JSON.stringify(kind)}, ${JSON.stringify(query)})`, context);
    },
    async recordEvent(kind, query, overrides = {}) {
      return await vm.runInContext(`__recordEvent(${JSON.stringify(kind)}, ${JSON.stringify(query)}, ${JSON.stringify(overrides)})`, context);
    }
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

(async () => {
  const harness = await createHarness();

  const suggestions = await harness.loadBackendSuggestions();
  assert(Array.isArray(suggestions) && suggestions.length === 1, 'Expected one backend adaptive suggestion.');
  assert(suggestions[0].query === 'chem lab 4', 'Expected backend suggestion query to be "chem lab 4".');

  const boostQuery = harness.boostQuery('chem lab');
  assert(boostQuery === 'chem lab 4', 'Expected backend suggestion cache to drive the weekly habit boost query.');

  const eventPayload = harness.buildEvent('result_clicked', 'chem lab 4');
  assert(eventPayload.baseQuery === 'chem lab', 'Expected adaptive event payload to normalize "chem lab 4" to base query "chem lab".');
  assert(eventPayload.sequenceNumber === 4, 'Expected adaptive event payload to keep the predicted sequence number.');
  assert(eventPayload.localDayOfWeek === 1, 'Expected Monday local day-of-week metadata.');
  assert(eventPayload.localHourBucket === 20, 'Expected Monday-night searches to bucket into the 20:00 slot.');

  await harness.recordEvent('suggestion_clicked', 'chem lab 4', { baseQuery: 'chem lab', sequenceNumber: 4 });
  const recordMessage = harness.sentMessages.find((message) => message.type === 'recordAdaptiveSearchEvent');
  assert(recordMessage, 'Expected popup adaptive events to go through the background bridge.');
  assert(recordMessage.event.eventKind === 'suggestion_clicked', 'Expected the recorded adaptive event kind to be "suggestion_clicked".');
  assert(recordMessage.event.baseQuery === 'chem lab', 'Expected the recorded adaptive event to preserve the base query.');

  console.log('PASS test_backend_adaptive_suggestions');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
