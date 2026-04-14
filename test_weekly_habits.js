const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function createHabitsHarness() {
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
    performance: { now: () => 0 },
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
          set: async () => ({}),
          remove: async () => ({})
        }
      },
      tabs: { create() {}, update() {} },
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

    globalThis.__recordWeeklyHabit = (query, isoString) => {
      recordWeeklyHabitQueryClick(query, new Date(isoString).getTime());
    };

    globalThis.__weeklySuggestions = (isoString) => getWeeklyHabitSuggestions(new Date(isoString).getTime()).map(entry => entry.query);

    globalThis.__weeklyBoost = (query, isoString) => {
      Date.now = () => new Date(isoString).getTime();
      return getWeeklyHabitBoostQuery(query);
    };
  `, context);

  return {
    record(query, isoString) {
      return vm.runInContext(`__recordWeeklyHabit(${JSON.stringify(query)}, ${JSON.stringify(isoString)})`, context);
    },
    suggestionsAt(isoString) {
      return vm.runInContext(`__weeklySuggestions(${JSON.stringify(isoString)})`, context);
    },
    boostQuery(query, isoString) {
      return vm.runInContext(`__weeklyBoost(${JSON.stringify(query)}, ${JSON.stringify(isoString)})`, context);
    }
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const harness = createHabitsHarness();

harness.record('chem lab 1', '2026-03-02T20:15:00-08:00');
harness.record('chem lab 2', '2026-03-09T20:05:00-07:00');
harness.record('chem lab 3', '2026-03-16T20:20:00-07:00');

const mondayNightSuggestions = harness.suggestionsAt('2026-03-23T20:10:00-07:00');
assert(mondayNightSuggestions[0] === 'chem lab 4', 'Expected Monday-night weekly habits to suggest "chem lab 4" after three weeks of clicks.');

const offSlotSuggestions = harness.suggestionsAt('2026-03-23T10:10:00-07:00');
assert(offSlotSuggestions.length === 0, 'Expected weekly habit suggestions to stay scoped to the learned time-of-week slot.');

const boostQuery = harness.boostQuery('chem lab', '2026-03-23T20:10:00-07:00');
assert(boostQuery === 'chem lab 4', 'Expected weekly habit ranking boost to target the predicted next-week query.');

console.log('PASS test_weekly_habits');
