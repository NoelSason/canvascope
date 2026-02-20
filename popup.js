/**
 * ============================================
 * Canvascope - Popup Script (popup.js)
 * ============================================
 * 
 * PURPOSE:
 * - Displays search UI for indexed LMS content
 * - Shows sync status from background worker
 * - Allows browsing all indexed content
 * 
 * NOTE: Scanning now happens automatically in the background.
 * This script just displays the results.
 * 
 * ============================================
 */

// ============================================
// CONFIGURATION
// ============================================

// Unified domain lists — mirrors background.js
const CANVAS_DOMAIN_SUFFIXES = ['.instructure.com'];
const KNOWN_CANVAS_DOMAINS = [
  'bcourses.berkeley.edu',
  'bruinlearn.ucla.edu',
  'canvas.ucsd.edu',
  'canvas.asu.edu',
  'canvas.mit.edu'
];
const BRIGHTSPACE_DOMAIN_SUFFIXES = ['.brightspace.com', '.d2l.com'];
const KNOWN_BRIGHTSPACE_DOMAINS = [];
let popupCustomDomains = [];

// Load custom domains so openResult / URL validation work for user-added domains
try {
  chrome.storage.local.get(['customDomains']).then(data => {
    popupCustomDomains = data.customDomains || [];
  });
} catch (e) { /* storage unavailable during tests */ }

const FUSE_OPTIONS = {
  threshold: 0.35,
  includeScore: true,
  includeMatches: true,
  minMatchCharLength: 2,
  ignoreLocation: true,
  findAllMatches: true,
  keys: [
    { name: 'title', weight: 3.0 },
    { name: 'searchTitleNormalized', weight: 2.5 },
    { name: 'searchAliases', weight: 2.0 },
    { name: 'folderPath', weight: 1.8 },
    { name: 'moduleName', weight: 1.5 },
    { name: 'courseName', weight: 1.2 },
    { name: 'type', weight: 0.5 }
  ]
};

const FUSE_OPTIONS_RELAXED = {
  ...FUSE_OPTIONS,
  threshold: 0.55
};

const MAX_RESULTS = 20;
const SEARCH_DEBOUNCE_MS = 150;
const MAX_HISTORY = 10;

// Type boost values for ranking
const TYPE_BOOST = {
  assignment: 0.30,
  quiz: 0.25,
  discussion: 0.20,
  page: 0.15,
  file: 0.10,
  pdf: 0.10,
  video: 0.08,
  externalurl: 0.05
};

// ============================================
// INTENT DETECTION
// ============================================

const INTENT_PATTERNS = {
  assignment: /\b(hw|homework|pset|problem\s*set|project|lab|worksheet|due|assn|assign|proj)\b/,
  quiz: /\b(quiz|midterm|exam|final|mt|test)\b/,
  page: /\b(lecture|notes|slides|reading|chapter|lec|ch|chap)\b/,
  file: /\b(pdf|doc|file|handout|document)\b/
};

// Intent ↔ item.type mapping
const INTENT_TYPE_MAP = {
  assignment: ['assignment'],
  quiz: ['quiz'],
  page: ['page', 'video', 'slides'],
  file: ['file', 'pdf', 'document']
};

const INTENT_MAX_BOOST = { assignment: 0.22, quiz: 0.22, page: 0.16, file: 0.16 };
const INTENT_CAP = 0.25;

/**
 * Detect query intent — returns { assignment, quiz, page, file } confidences [0..1]
 */
function detectQueryIntent(normalizedQuery) {
  const intent = { assignment: 0, quiz: 0, page: 0, file: 0 };
  for (const [key, re] of Object.entries(INTENT_PATTERNS)) {
    intent[key] = re.test(normalizedQuery) ? 1.0 : 0;
  }
  return intent;
}

// ============================================
// NUMERIC TOKEN HELPERS
// ============================================

/**
 * Extract numeric tokens from text as strings.
 */
function extractNumericTokens(text) {
  const matches = (text || '').match(/\b\d{1,4}\b/g);
  return matches ? matches.map(n => n.replace(/^0+/, '') || '0') : [];
}

/**
 * Compute numeric alignment between query numbers and title numbers.
 * Returns { aligned, mismatched, queryHasNumbers }
 */
function computeNumericAlignment(queryNums, titleText) {
  if (queryNums.length === 0) return { aligned: 0, mismatched: 0, queryHasNumbers: false };
  const titleNums = new Set(extractNumericTokens(titleText));
  let aligned = 0, mismatched = 0;
  for (const qn of queryNums) {
    if (titleNums.has(qn)) aligned++;
    else mismatched++;
  }
  return { aligned, mismatched, queryHasNumbers: true };
}

// ============================================
// TOKEN COVERAGE
// ============================================

const STOP_TOKENS = new Set(['a', 'an', 'the', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'is']);

/**
 * Compute fraction of query tokens present in searchable text.
 * Checks title and optional context (folderPath, moduleName).
 * Ignores stop words and single-char tokens.
 */
function computeTokenCoverage(normalizedQuery, titleText, contextText) {
  const qTokens = normalizedQuery.split(/\s+/).filter(t => t.length > 1 && !STOP_TOKENS.has(t));
  if (qTokens.length === 0) return 1;
  const combined = ((titleText || '') + ' ' + (contextText || '')).toLowerCase();
  let found = 0;
  for (const t of qTokens) {
    if (combined.includes(t)) found++;
  }
  return found / qTokens.length;
}

// ============================================
// CLICK FEEDBACK
// ============================================

let clickFeedbackMap = {}; // keyed by canonical path, { openCount, lastOpenedAt }

async function loadClickFeedbackMap() {
  try {
    const data = await chrome.storage.local.get(['clickFeedback']);
    clickFeedbackMap = data.clickFeedback || {};
  } catch (e) { clickFeedbackMap = {}; }
}

async function updateClickFeedback(item) {
  const key = getClickKey(item);
  if (!key) return;
  const entry = clickFeedbackMap[key] || { openCount: 0, lastOpenedAt: 0 };
  entry.openCount++;
  entry.lastOpenedAt = Date.now();
  clickFeedbackMap[key] = entry;
  try {
    await chrome.storage.local.set({ clickFeedback: clickFeedbackMap });
  } catch (e) { /* ignore */ }
}

function getClickKey(item) {
  if (!item || !item.url) return null;
  try {
    const u = new URL(item.url);
    return u.pathname;
  } catch { return null; }
}

function getClickBoost(item) {
  const key = getClickKey(item);
  if (!key || !clickFeedbackMap[key]) return 0;
  const { openCount, lastOpenedAt } = clickFeedbackMap[key];
  // Frequency boost: log-scaled, max ~0.08
  const freqBoost = Math.min(0.08, Math.log2(1 + openCount) * 0.025);
  // Recency boost: decays over 14 days, max 0.05
  const daysSinceOpen = (Date.now() - lastOpenedAt) / (1000 * 60 * 60 * 24);
  const recencyBoost = Math.max(0, 0.05 - daysSinceOpen * 0.0036);
  return Math.min(0.12, freqBoost + recencyBoost);
}

// ============================================
// ACTIVE COURSE CONTEXT
// ============================================

let activeCourseContext = null; // { courseId, courseName }

async function detectActiveCourseContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const m = tab.url.match(/\/courses\/(\d+)/);
    if (m) {
      const cid = parseInt(m[1], 10);
      // Try to find course name from indexed content
      const match = state.indexedContent.find(i => i.courseId === cid);
      activeCourseContext = { courseId: cid, courseName: match?.courseName || null };
    }
  } catch (e) { /* ignore */ }
}

function getActiveCourseBoost(item) {
  if (!activeCourseContext) return 0;
  if (item.courseId && item.courseId === activeCourseContext.courseId) return 0.12;
  if (activeCourseContext.courseName && item.courseName &&
    normalizeText(item.courseName) === normalizeText(activeCourseContext.courseName)) return 0.08;
  return 0;
}

// ============================================
// DUE PLANNER HELPERS
// ============================================

const TASK_TYPES = new Set(['assignment', 'quiz', 'discussion']);

function isTaskType(item) {
  return TASK_TYPES.has((item.type || '').toLowerCase());
}

function parseDueTs(item) {
  if (!item.dueAt) return 0;
  const ts = new Date(item.dueAt).getTime();
  return isNaN(ts) ? 0 : ts;
}

function canonicalTaskId(item) {
  try {
    return new URL(item.url).pathname;
  } catch {
    return (item.url || '') + ':' + (item.title || '');
  }
}

function bucketTasks(items, now, lookaheadDays = 7) {
  const overdue = [];
  const today = [];
  const next7Days = [];
  const undated = [];

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const endLookahead = endOfDay.getTime() + (lookaheadDays - 1) * 24 * 60 * 60 * 1000;

  for (const item of items) {
    if (!isTaskType(item)) continue;

    // Respect active course filter
    if (state.filters.course) {
      const ic = (item.courseName || '').toLowerCase();
      const fc = state.filters.course.toLowerCase();
      if (ic !== fc && !ic.includes(fc)) continue;
    }

    const dueTs = parseDueTs(item);
    if (dueTs === 0) {
      undated.push(item);
    } else if (dueTs < startOfDay.getTime()) {
      overdue.push(item);
    } else if (dueTs <= endOfDay.getTime()) {
      today.push(item);
    } else if (dueTs <= endLookahead) {
      next7Days.push(item);
    }
    // Items further than lookaheadDays are not shown
  }

  // Sort by urgency (earliest first)
  const byDue = (a, b) => parseDueTs(a) - parseDueTs(b);
  overdue.sort(byDue);
  today.sort(byDue);
  next7Days.sort(byDue);
  // Undated: alphabetical
  undated.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  return { overdue, today, next7Days, undated };
}

function formatDueLabel(item) {
  const ts = parseDueTs(item);
  if (ts === 0) return 'No due date';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = ts - now.getTime();
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

  if (diffMs < 0) {
    const absDays = Math.abs(diffDays);
    if (absDays === 0) return 'Overdue today';
    return `${absDays}d overdue`;
  }
  if (diffDays === 0) {
    const hrs = Math.round(diffMs / (60 * 60 * 1000));
    return hrs <= 1 ? 'Due soon' : `Due in ${hrs}h`;
  }
  if (diffDays === 1) return 'Due tomorrow';
  // Show date
  return `Due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function dueUrgencyClass(item) {
  const ts = parseDueTs(item);
  if (ts === 0) return 'undated';
  const now = Date.now();
  if (ts < now) return 'overdue';
  const diffMs = ts - now;
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  if (ts <= endOfDay.getTime()) return 'today';
  return 'upcoming';
}

function renderDuePlanner() {
  const planner = elements.duePlanner;
  if (!planner || state.isOverlayMode) return;

  const buckets = bucketTasks(state.indexedContent, Date.now());
  const total = buckets.overdue.length + buckets.today.length + buckets.next7Days.length + buckets.undated.length;

  planner.innerHTML = '';

  if (total === 0) {
    planner.innerHTML = '<div class="due-planner-empty">No upcoming tasks found</div>';
    return;
  }

  const sections = [
    { key: 'overdue', label: '⚠ Overdue', items: buckets.overdue, cls: 'overdue' },
    { key: 'today', label: '📅 Due Today', items: buckets.today, cls: 'today' },
    { key: 'next7Days', label: '📋 Next 7 Days', items: buckets.next7Days, cls: 'upcoming' },
    { key: 'undated', label: '❓ No Due Date', items: buckets.undated, cls: 'undated' }
  ];

  for (const sec of sections) {
    if (sec.items.length === 0) continue;

    const sectionEl = document.createElement('div');
    sectionEl.className = 'due-section';

    const header = document.createElement('div');
    header.className = `due-section-header ${sec.cls}`;
    header.textContent = `${sec.label} (${sec.items.length})`;
    sectionEl.appendChild(header);

    for (const item of sec.items) {
      const row = document.createElement('div');
      row.className = 'due-item';

      const left = document.createElement('div');
      left.className = 'due-item-left';

      const title = document.createElement('div');
      title.className = 'due-item-title';
      title.textContent = item.title || 'Untitled';
      left.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'due-item-meta';

      const typeBadge = document.createElement('span');
      typeBadge.className = 'result-type';
      typeBadge.textContent = item.type || 'task';
      meta.appendChild(typeBadge);

      if (item.courseName) {
        const course = document.createElement('span');
        course.textContent = item.courseName;
        meta.appendChild(course);
      }
      left.appendChild(meta);

      const right = document.createElement('div');
      right.className = 'due-item-right';

      const chip = document.createElement('span');
      chip.className = `due-chip ${dueUrgencyClass(item)}`;
      chip.textContent = formatDueLabel(item);
      right.appendChild(chip);

      row.appendChild(left);
      row.appendChild(right);

      row.addEventListener('click', () => openResult(item));
      sectionEl.appendChild(row);
    }

    planner.appendChild(sectionEl);
  }
}

// ============================================
// DIVERSITY RE-RANK
// ============================================

/**
 * Greedy diversity re-rank for top-N results.
 * Penalizes over-represented types and courses when score deltas are small.
 */
function applyDiversityRerank(scoredResults, limit = 15) {
  if (scoredResults.length <= 3) return scoredResults;

  const topN = scoredResults.slice(0, Math.min(scoredResults.length, limit));
  const rest = scoredResults.slice(limit);
  const picked = [];
  const typeCounts = {};
  const courseCounts = {};

  while (topN.length > 0) {
    let bestIdx = 0;
    let bestAdjScore = -Infinity;

    for (let i = 0; i < topN.length; i++) {
      const r = topN[i];
      let adj = r.finalScore;
      const t = r.item.type || 'other';
      const c = normalizeText(r.item.courseName || '');

      // Penalty for over-representation (only if score delta from top is small)
      const topScore = picked.length > 0 ? picked[0].finalScore : adj;
      if (topScore - adj < 0.3) {
        if ((typeCounts[t] || 0) >= 2) adj -= 0.04 * ((typeCounts[t] || 0) - 1);
        if ((courseCounts[c] || 0) >= 2) adj -= 0.03 * ((courseCounts[c] || 0) - 1);
      }

      if (adj > bestAdjScore) {
        bestAdjScore = adj;
        bestIdx = i;
      }
    }

    const chosen = topN.splice(bestIdx, 1)[0];
    const t = chosen.item.type || 'other';
    const c = normalizeText(chosen.item.courseName || '');
    typeCounts[t] = (typeCounts[t] || 0) + 1;
    courseCounts[c] = (courseCounts[c] || 0) + 1;
    picked.push(chosen);
  }

  return [...picked, ...rest];
}

// ============================================
// SEARCH NORMALIZATION HELPERS
// ============================================

const ABBREV_MAP = {
  hw: 'homework',
  proj: 'project',
  assn: 'assignment',
  assign: 'assignment',
  disc: 'discussion',
  lec: 'lecture',
  lab: 'laboratory',
  mt: 'midterm',
  ch: 'chapter',
  chap: 'chapter',
  wk: 'week',
  pset: 'problem set',
  ps: 'problem set'
};

// Regex to split compact tokens like hw4, proj2, quiz10
const COMPACT_TOKEN_RE = /^([a-z]+)(\d{1,3})$/i;

/**
 * Normalize text: lowercase, strip punctuation, collapse whitespace
 */
function normalizeText(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Expand abbreviations and split compact forms (hw4 → homework 4)
 */
function expandAbbreviations(text) {
  const tokens = normalizeText(text).split(' ');
  const expanded = [];

  for (const token of tokens) {
    const compactMatch = token.match(COMPACT_TOKEN_RE);
    if (compactMatch) {
      const [, letters, digits] = compactMatch;
      const expandedWord = ABBREV_MAP[letters] || letters;
      expanded.push(expandedWord, digits.replace(/^0+/, '') || '0');
    } else {
      expanded.push(ABBREV_MAP[token] || token);
    }
  }

  return expanded.join(' ');
}

/**
 * Generate number variants: for each number token, include both padded and unpadded
 * "homework 4" → "homework 4 homework 04"
 */
function numberVariants(text) {
  const tokens = text.split(' ');
  const variants = [text];
  let hasVariant = false;

  const altTokens = tokens.map(t => {
    if (/^\d{1,3}$/.test(t)) {
      hasVariant = true;
      const unpadded = t.replace(/^0+/, '') || '0';
      const padded = unpadded.padStart(2, '0');
      return unpadded === t ? padded : unpadded;
    }
    return t;
  });

  if (hasVariant) {
    variants.push(altTokens.join(' '));
  }

  return variants.join(' ');
}

/**
 * Build searchable fields for an item
 */
function buildSearchFields(item) {
  const normalized = expandAbbreviations(item.title || '');
  let aliases = numberVariants(normalized);
  // Include folder path in aliases so folder names are searchable
  if (item.folderPath) {
    aliases += ' ' + normalizeText(item.folderPath);
  }
  if (item.moduleName && item.moduleName !== 'Files') {
    aliases += ' ' + normalizeText(item.moduleName);
  }
  return {
    searchTitleNormalized: normalized,
    searchAliases: aliases
  };
}

/**
 * Detect if query starts with a course name, enabling course-scoped search.
 * E.g., "chem 3b plws 10" → { coursePrefix: "chem 3b", remainingQuery: "plws 10" }
 */
function detectCourseScope(query) {
  const normQuery = normalizeText(query);
  if (!normQuery || normQuery.length < 3) return null;

  // Build course candidates: full name + short form (without semester)
  const candidates = [];
  const seen = new Set();

  for (const item of state.indexedContent) {
    if (!item.courseName) continue;
    const original = item.courseName.trim();
    const full = normalizeText(original);

    // Short form: strip parenthetical suffix like "(Fall 2025)"
    const short = normalizeText(original.replace(/\s*\(.*\)\s*$/, ''));

    if (short && short.length >= 3 && !seen.has(short)) {
      seen.add(short);
      candidates.push({ norm: short, original });
    }
    if (full && !seen.has(full)) {
      seen.add(full);
      candidates.push({ norm: full, original });
    }
  }

  // Sort longest first for greedy matching
  candidates.sort((a, b) => b.norm.length - a.norm.length);

  for (const { norm, original } of candidates) {
    if (normQuery.startsWith(norm + ' ') && normQuery.length > norm.length + 1) {
      const remaining = normQuery.slice(norm.length + 1).trim();
      if (remaining.length >= 1) {
        return { coursePrefix: norm, courseName: original, remainingQuery: remaining };
      }
    }
  }

  return null;
}

// ============================================
// DOM ELEMENTS
// ============================================

const elements = {};

// ============================================
// STATE
// ============================================

const MAX_RECENTS = 5;

let state = {
  fuse: null,
  indexedContent: [],
  filteredContent: [],
  searchTimeout: null,
  isScanning: false,
  filters: {
    course: '',
    type: ''
  },
  searchHistory: [],
  courses: [],
  isOverlayMode: false,
  overlayHighlightIndex: 0,
  lastSearchTimeMs: 0,
  lastResultCount: 0,
  recentlyOpened: []
};

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Canvascope] Popup opened');
  initializeElements();
  setupEventListeners();
  await loadContent();
  await loadSearchHistory();
  await loadRecentlyOpened();
  await loadClickFeedbackMap();
  await detectActiveCourseContext();
  initializeFuse();
  updateUI();
  renderDuePlanner();
  elements.searchInput.focus();

  // Request status from background
  getBackgroundStatus();

  // Check if current tab is a supported LMS and auto-detect domain
  checkCurrentTab();

  // Check if running in overlay mode
  checkOverlayMode();
});

function checkOverlayMode() {
  // Check if running in iframe (overlay mode via Cmd+K)
  if (window.self !== window.top) {
    state.isOverlayMode = true;
    document.body.classList.add('in-overlay');

    // Inject ⌘ icon before the search input
    const cmdIcon = document.createElement('span');
    cmdIcon.className = 'overlay-cmd-icon';
    cmdIcon.textContent = '⌘';
    const searchWrapper = elements.searchInput.parentElement;
    searchWrapper.insertBefore(cmdIcon, elements.searchInput);

    // Inject ⌘K shortcut badge after the search input
    const badge = document.createElement('span');
    badge.className = 'overlay-shortcut-badge';
    badge.textContent = '⌘K';
    searchWrapper.appendChild(badge);

    // Create overlay footer
    const footer = document.createElement('div');
    footer.className = 'overlay-footer';
    footer.innerHTML = `
      <span class="overlay-footer-left" id="overlay-result-count"></span>
      <span class="overlay-footer-right"><kbd>↵</kbd> to open</span>
    `;
    document.querySelector('.container').appendChild(footer);
    elements.overlayResultCount = document.getElementById('overlay-result-count');

    // Show recently opened items in the empty state
    showOverlayRecents();

    // Listen for messages from parent
    window.addEventListener('message', (event) => {
      // Strict origin/source check: only accept messages from our extension's parent
      if (event.source !== window.parent) return;
      const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
      if (event.origin !== extensionOrigin) return;

      if (event.data && event.data.type === 'FOCUS_INPUT') {
        setTimeout(() => elements.searchInput.focus(), 50);
      }
    });

    // Handle Escape key to close overlay
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
        window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, extensionOrigin);
      }
    });
  }
}

function initializeElements() {
  elements.searchInput = document.getElementById('search-input');
  elements.clearSearchBtn = document.getElementById('clear-search');
  elements.resultsContainer = document.getElementById('results-container');
  elements.emptyState = document.getElementById('empty-state');
  elements.refreshBtn = document.getElementById('refresh-btn');
  elements.clearDataBtn = document.getElementById('clear-data-btn');
  elements.statusText = document.getElementById('status-text');
  elements.statsText = document.getElementById('stats-text');
  elements.statsHint = document.getElementById('stats-hint');
  elements.statsBtn = document.getElementById('stats-btn');

  // Browsing Modal Elements
  elements.browseModal = document.getElementById('browse-modal');
  elements.closeBrowse = document.getElementById('close-browse');
  elements.browseTabs = document.getElementById('browse-tabs');
  elements.browseContent = document.getElementById('browse-content');

  // Sync Status Elements
  elements.syncStatus = document.getElementById('sync-status');
  elements.syncIcon = document.getElementById('sync-icon');
  elements.syncText = document.getElementById('sync-text');

  // Custom Dropdown Elements
  elements.courseWrapper = document.getElementById('course-select-wrapper');
  elements.courseTrigger = document.getElementById('course-trigger');
  elements.courseOptions = document.getElementById('course-options');
  elements.courseText = document.getElementById('course-text');

  elements.typeWrapper = document.getElementById('type-select-wrapper');
  elements.typeTrigger = document.getElementById('type-trigger');
  elements.typeOptions = document.getElementById('type-options');
  elements.typeText = document.getElementById('type-text');

  elements.searchHistory = document.getElementById('search-history');

  // Due Planner
  elements.duePlanner = document.getElementById('due-planner');
}

function setupEventListeners() {
  elements.searchInput.addEventListener('input', handleSearchInput);
  elements.searchInput.addEventListener('focus', showSearchHistory);
  elements.searchInput.addEventListener('blur', () => {
    // Delay hiding to allow clicking on history items
    setTimeout(() => {
      // Don't hide if we clicked a history item (handled by click event)
    }, 200);
  });

  // Keyboard navigation for search results
  elements.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.isOverlayMode) {
        // Open the currently highlighted result
        const items = elements.resultsContainer.querySelectorAll('.result-item');
        if (items.length > 0 && items[state.overlayHighlightIndex]) {
          items[state.overlayHighlightIndex].click();
        }
      } else {
        const firstResult = elements.resultsContainer.querySelector('.result-item');
        if (firstResult) {
          firstResult.click();
        }
      }
    }

    // Arrow key navigation (overlay mode)
    if (state.isOverlayMode && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const items = elements.resultsContainer.querySelectorAll('.result-item');
      if (items.length === 0) return;

      // Remove current highlight
      items[state.overlayHighlightIndex]?.classList.remove('overlay-highlighted');

      if (e.key === 'ArrowDown') {
        state.overlayHighlightIndex = Math.min(state.overlayHighlightIndex + 1, items.length - 1);
      } else {
        state.overlayHighlightIndex = Math.max(state.overlayHighlightIndex - 1, 0);
      }

      // Apply new highlight and scroll into view
      items[state.overlayHighlightIndex]?.classList.add('overlay-highlighted');
      items[state.overlayHighlightIndex]?.scrollIntoView({ block: 'nearest' });
    }
  });

  // Close search history when clicking outside
  document.addEventListener('click', (e) => {
    if (!elements.searchHistory.contains(e.target) && e.target !== elements.searchInput) {
      hideSearchHistory();
    }

    // Close custom dropdowns when clicking outside
    if (!elements.courseWrapper.contains(e.target)) {
      elements.courseWrapper.classList.remove('open');
    }
    if (!elements.typeWrapper.contains(e.target)) {
      elements.typeWrapper.classList.remove('open');
    }
  });

  elements.clearSearchBtn.addEventListener('click', clearSearch);
  elements.refreshBtn.addEventListener('click', handleRefresh);
  if (elements.clearDataBtn) elements.clearDataBtn.addEventListener('click', handleClearData);
  if (elements.statsBtn) elements.statsBtn.addEventListener('click', openBrowseModal);
  if (elements.closeBrowse) elements.closeBrowse.addEventListener('click', closeBrowseModal);

  // Custom Dropdown Listeners
  setupCustomDropdown(elements.courseWrapper, elements.courseTrigger, elements.courseOptions, 'course');
  setupCustomDropdown(elements.typeWrapper, elements.typeTrigger, elements.typeOptions, 'type');

  // Listen for background updates
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

/**
 * Setup custom dropdown behavior
 */
function setupCustomDropdown(wrapper, trigger, optionsContainer, filterType) {
  // Make trigger focusable
  trigger.setAttribute('tabindex', '0');

  // Toggle dropdown
  trigger.addEventListener('click', () => {
    const wasOpen = wrapper.classList.contains('open');

    // Close other dropdowns
    document.querySelectorAll('.custom-select-wrapper').forEach(el => {
      if (el !== wrapper) el.classList.remove('open');
    });

    if (!wasOpen) {
      wrapper.classList.add('open');
      // Scroll to selected option
      const selected = optionsContainer.querySelector('.selected');
      if (selected) {
        selected.scrollIntoView({ block: 'nearest' });
      }
    } else {
      wrapper.classList.remove('open');
    }
  });

  // Handle option selection
  optionsContainer.addEventListener('click', (e) => {
    const option = e.target.closest('.custom-option');
    if (!option) return;
    selectOption(option, wrapper, optionsContainer, filterType);
  });

  // Keyboard Navigation
  let searchString = '';
  let searchTimeout = null;

  trigger.addEventListener('keydown', (e) => {
    // Navigate with arrows
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // If closed, open it
      if (!wrapper.classList.contains('open')) {
        wrapper.classList.add('open');
      }

      const options = Array.from(optionsContainer.querySelectorAll('.custom-option'));
      const currentIndex = options.findIndex(opt => opt.classList.contains('selected'));
      let nextIndex = 0;

      if (currentIndex !== -1) {
        if (e.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, options.length - 1);
        else nextIndex = Math.max(currentIndex - 1, 0);
      }

      const nextOption = options[nextIndex];
      if (nextOption) {
        // Just highlight/scroll to it, don't select yet until Enter? 
        // Or select immediately like native select? Native select updates immediately.
        selectOption(nextOption, wrapper, optionsContainer, filterType, false); // false = don't close
        nextOption.scrollIntoView({ block: 'nearest' });
      }
      return;
    }

    // Select with Enter
    if (e.key === 'Enter') {
      if (wrapper.classList.contains('open')) {
        e.preventDefault();
        wrapper.classList.remove('open');
      } else {
        wrapper.classList.add('open');
      }
      return;
    }

    // Close with Escape
    if (e.key === 'Escape') {
      wrapper.classList.remove('open');
      trigger.focus();
      return;
    }

    // Type to search
    // Allow alphanumerics, spaces, dashes, periods
    if (e.key.length === 1 && e.key.match(/^[a-z0-9\s.-]$/i)) {
      clearTimeout(searchTimeout);
      searchString += e.key.toLowerCase();

      const options = Array.from(optionsContainer.querySelectorAll('.custom-option'));
      const match = options.find(opt => opt.textContent.toLowerCase().startsWith(searchString));

      if (match) {
        if (!wrapper.classList.contains('open')) {
          wrapper.classList.add('open');
        }
        selectOption(match, wrapper, optionsContainer, filterType, false);
        match.scrollIntoView({ block: 'nearest' });
      }

      searchTimeout = setTimeout(() => {
        searchString = '';
      }, 3000); // Reset search after 3 seconds for slower typists
    }

    // Handle Backspace
    if (e.key === 'Backspace') {
      clearTimeout(searchTimeout);
      searchString = searchString.slice(0, -1);
      searchTimeout = setTimeout(() => {
        searchString = '';
      }, 3000);
    }
  });
}

function selectOption(option, wrapper, optionsContainer, filterType, close = true) {
  // Remove selected class from siblings
  optionsContainer.querySelectorAll('.custom-option').forEach(el => {
    el.classList.remove('selected');
  });

  // Select this option
  option.classList.add('selected');

  // Update text and value
  const value = option.dataset.value;
  const text = option.textContent;

  wrapper.querySelector('span').textContent = text;

  if (close) {
    wrapper.classList.remove('open');
  }

  // Update state and trigger filter
  // Only trigger update if value changed
  if (state.filters[filterType] !== value) {
    state.filters[filterType] = value;
    handleFilterChange();
  }
}

// ============================================
// BACKGROUND COMMUNICATION
// ============================================

async function getBackgroundStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (response) {
      state.isScanning = response.isScanning;
      updateSyncStatus(response);
    }
  } catch (e) {
    console.log('[Canvascope] Could not get background status');
  }
}

/**
 * Check current tab for supported LMS and auto-detect custom domain
 */
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    const url = new URL(tab.url);
    const hostname = url.hostname.toLowerCase();

    // Skip if already a known domain (use unified check)
    if (isKnownLmsHost(hostname)) return;

    const path = url.pathname.toLowerCase();
    const looksCanvas = path.includes('/courses/') ||
      path.includes('/assignments/') ||
      path.includes('/modules') ||
      path.includes('/quizzes');
    const looksBrightspace = path.includes('/d2l/');

    if (looksCanvas || looksBrightspace) {
      // Likely LMS, add domain
      await chrome.runtime.sendMessage({ action: 'addDomain', domain: hostname });
      popupCustomDomains.push(hostname);
      console.log('[Canvascope] Auto-detected LMS domain from URL:', hostname);
    }
  } catch (e) {
    // Silently ignore - this is expected when not on a supported LMS page
  }
}

function handleBackgroundMessage(message) {
  console.log('[Canvascope] Background message:', message.type);

  switch (message.type) {
    case 'scanStarted':
      state.isScanning = true;
      showScanningStatus();
      break;

    case 'scanProgress':
      updateScanProgress(message.progress, message.status);
      break;

    case 'scanComplete':
      state.isScanning = false;
      loadContent().then(() => {
        initializeFuse();
        updateUI();
        showSyncedStatus(`Added ${message.newItems} new items`);
      });
      break;

    case 'scanError':
      state.isScanning = false;
      showErrorStatus(message.error);
      break;
  }
}

// ============================================
// SYNC STATUS UI
// ============================================

function updateSyncStatus(status) {
  if (status.isScanning) {
    showScanningStatus();
  } else {
    const lastScan = status.lastScan;
    if (lastScan > 0) {
      const ago = getTimeAgo(lastScan);
      showSyncedStatus(`Last synced ${ago}`);
    } else {
      showSyncedStatus('Open Canvas or Brightspace to sync');
    }
  }
}

function showScanningStatus() {
  elements.syncIcon.textContent = '⟳';
  elements.syncIcon.classList.add('spinning');
  elements.syncText.textContent = 'Syncing...';
  elements.syncStatus.className = 'sync-status syncing';
}

function showSyncedStatus(text = 'Synced') {
  elements.syncIcon.textContent = '✓';
  elements.syncIcon.classList.remove('spinning');
  elements.syncText.textContent = text;
  elements.syncStatus.className = 'sync-status synced';
}

function showErrorStatus(text = 'Sync failed') {
  elements.syncIcon.textContent = '!';
  elements.syncIcon.classList.remove('spinning');
  elements.syncText.textContent = text;
  elements.syncStatus.className = 'sync-status error';
}

function updateScanProgress(progress, status) {
  elements.syncText.textContent = status || `Syncing... ${progress}%`;
}

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ============================================
// SEARCH FUNCTIONALITY
// ============================================

function initializeFuse() {
  applyFilters();

  // Enrich items with normalized search fields
  for (const item of state.filteredContent) {
    const fields = buildSearchFields(item);
    item.searchTitleNormalized = fields.searchTitleNormalized;
    item.searchAliases = fields.searchAliases;
  }

  if (state.filteredContent.length > 0) {
    state.fuse = new Fuse(state.filteredContent, FUSE_OPTIONS);
    state.fuseRelaxed = new Fuse(state.filteredContent, FUSE_OPTIONS_RELAXED);
  } else {
    state.fuse = null;
    state.fuseRelaxed = null;
  }
  populateCourseFilter();
}

function applyFilters() {
  state.filteredContent = state.indexedContent.filter(item => {
    // Course filter - use includes for partial matching
    if (state.filters.course) {
      const itemCourse = (item.courseName || '').toLowerCase();
      const filterCourse = state.filters.course.toLowerCase();
      // Allow exact match or partial match
      if (itemCourse !== filterCourse && !itemCourse.includes(filterCourse)) {
        return false;
      }
    }
    // Type filter - exact match
    if (state.filters.type && item.type !== state.filters.type) {
      return false;
    }
    return true;
  });
  console.log(`[Canvascope] Filtered: ${state.filteredContent.length} of ${state.indexedContent.length} items`);
}

function handleFilterChange() {
  // State is already updated by the click handler in setupCustomDropdown
  initializeFuse();

  // Re-run search if there's a query
  const query = elements.searchInput.value.trim();
  if (query.length > 0) {
    performSearch(query);
  } else {
    updateUI(); // Show all filtered results if no query
  }
}

function populateCourseFilter() {
  const courses = new Set();

  // Extract unique courses
  state.indexedContent.forEach(item => {
    if (item.courseName) {
      courses.add(item.courseName.trim());
    }
  });

  // Clear existing options (except "All Courses")
  // Note: first child is "All Courses"
  const allCoursesOption = elements.courseOptions.firstElementChild;
  elements.courseOptions.innerHTML = '';
  if (allCoursesOption) {
    elements.courseOptions.appendChild(allCoursesOption);
  } else {
    // Recreate if missing
    const opt = document.createElement('div');
    opt.className = 'custom-option selected';
    opt.dataset.value = '';
    opt.textContent = 'All Courses';
    elements.courseOptions.appendChild(opt);
  }

  // Add course options
  Array.from(courses).sort().forEach(course => {
    // Skip invalid course names
    if (course === 'Dashboard' || course.startsWith('Announcements - ') || course.includes(' - ')) return;

    const option = document.createElement('div');
    option.className = 'custom-option';
    if (course === state.filters.course) {
      option.classList.add('selected');
    }
    option.dataset.value = course;
    option.textContent = course;
    elements.courseOptions.appendChild(option);
  });

  // Update trigger text if valid
  if (state.filters.course) {
    const selectedOption = Array.from(elements.courseOptions.children).find(opt => opt.dataset.value === state.filters.course);
    if (selectedOption) {
      elements.courseText.textContent = selectedOption.textContent;
    } else {
      // Reset if course not found
      state.filters.course = '';
      elements.courseText.textContent = 'All Courses';
      handleFilterChange();
    }
  }
}

function handleSearchInput(event) {
  const query = event.target.value.trim();
  elements.clearSearchBtn.classList.toggle('visible', query.length > 0);
  hideSearchHistory();

  if (state.searchTimeout) {
    clearTimeout(state.searchTimeout);
  }

  if (query.length === 0) {
    showEmptyState();
    if (state.isOverlayMode) showOverlayRecents();
    return;
  }

  state.searchTimeout = setTimeout(() => {
    performSearch(query);
  }, SEARCH_DEBOUNCE_MS);
}

function performSearch(query) {
  if (!state.fuse) {
    showNoResults('No content indexed yet. Open Canvas or Brightspace to sync!');
    updateOverlayFooter(0, 0);
    return;
  }

  // Detect course-scoped search (e.g., "chem 3b plws 10" → search "plws 10" in Chem 3B)
  const courseScope = detectCourseScope(query);

  let effectiveQuery, normalizedQuery;
  if (courseScope) {
    effectiveQuery = courseScope.remainingQuery;
    normalizedQuery = expandAbbreviations(courseScope.remainingQuery);
    console.log(`[Canvascope] Course-scoped search: "${courseScope.coursePrefix}" → "${effectiveQuery}"`);
  } else {
    effectiveQuery = query;
    normalizedQuery = expandAbbreviations(query);
  }

  // Derive search metadata once
  const intent = detectQueryIntent(normalizedQuery);
  const queryNums = extractNumericTokens(normalizedQuery);

  const searchStart = performance.now();

  // ── Exact/prefix pre-pass ──────────────────────────
  const normQ = normalizedQuery.toLowerCase();
  const prePassHits = [];
  const prePassUrls = new Set();
  for (const item of state.filteredContent) {
    const nt = (item.searchTitleNormalized || normalizeText(item.title || '')).toLowerCase();
    if (nt === normQ || nt.startsWith(normQ + ' ') || nt.startsWith(normQ)) {
      prePassHits.push({ item, score: 0, prePass: true });
      prePassUrls.add(item.url);
    }
  }

  // ── Fuse pass A: strict ────────────────────────────
  let fuseResults = state.fuse.search(normalizedQuery, { limit: MAX_RESULTS * 3 });

  // Also search with effective query and merge unique results
  if (normalizedQuery !== normalizeText(effectiveQuery)) {
    const origResults = state.fuse.search(effectiveQuery, { limit: MAX_RESULTS * 3 });
    const seenUrls = new Set(fuseResults.map(r => r.item.url));
    for (const r of origResults) {
      if (!seenUrls.has(r.item.url)) {
        fuseResults.push(r);
        seenUrls.add(r.item.url);
      }
    }
  }

  // ── Fuse pass B: relaxed fallback ──────────────────
  if (fuseResults.length === 0 && state.fuseRelaxed) {
    fuseResults = state.fuseRelaxed.search(normalizedQuery, { limit: MAX_RESULTS * 3 });
    if (fuseResults.length === 0) {
      fuseResults = state.fuseRelaxed.search(effectiveQuery, { limit: MAX_RESULTS * 3 });
    }
  }

  // ── Merge pre-pass + Fuse (dedup by URL) ───────────
  let results = [...prePassHits];
  for (const r of fuseResults) {
    if (!prePassUrls.has(r.item.url)) {
      results.push(r);
    }
  }

  // If course-scoped, ensure items from the target course are in the pool
  if (courseScope) {
    const prefix = courseScope.coursePrefix;
    const seenUrls = new Set(results.map(r => r.item.url));

    // Secondary recall: scan target course items for query token matches
    // in title + folderPath + moduleName (catches folder-name matches)
    const qTokens = normalizedQuery.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    if (qTokens.length > 0) {
      for (const item of state.filteredContent) {
        if (seenUrls.has(item.url)) continue;
        const itemCourse = normalizeText(item.courseName || '');
        if (!itemCourse.includes(prefix)) continue;

        // Check if enough query tokens appear across searchable text
        const searchableText = [
          (item.searchTitleNormalized || normalizeText(item.title || '')),
          normalizeText(item.folderPath || ''),
          normalizeText(item.moduleName || '')
        ].join(' ').toLowerCase();

        let hits = 0;
        for (const t of qTokens) {
          if (searchableText.includes(t)) hits++;
        }
        // Require at least half the tokens to match
        if (hits >= Math.ceil(qTokens.length / 2)) {
          results.push({ item, score: 0.5, prePass: false, courseRecall: true });
          seenUrls.add(item.url);
        }
      }
    }

    // Now filter to only course-scoped results
    const scopedResults = results.filter(r => {
      const itemCourse = normalizeText(r.item.courseName || '');
      return itemCourse.includes(prefix);
    });
    if (scopedResults.length > 0) {
      results = scopedResults;
    }
  }

  const searchTimeMs = Math.round(performance.now() - searchStart);

  if (results.length === 0) {
    showNoResults(`No results for "${query}"`);
    updateOverlayFooter(0, searchTimeMs);
    return;
  }

  // Apply full ranking pipeline (intent, numeric, coverage, click, due, diversity)
  results = rankResults(results, normalizedQuery, intent, queryNums);
  results = results.slice(0, MAX_RESULTS);

  state.lastSearchTimeMs = searchTimeMs;
  state.lastResultCount = results.length;

  displayResults(results);
  updateOverlayFooter(results.length, searchTimeMs);

  // Single-line diagnostic
  console.log(`[Canvascope] query="${query}" intent=${JSON.stringify(intent)} nums=[${queryNums}] results=${results.length} ${searchTimeMs}ms`);

  // Save to history (original query, not normalized)
  saveSearchToHistory(query);
}

/**
 * Calculate custom score combining Fuse score with type, recency, position,
 * intent, numeric, coverage, click-feedback, due-date, and active-course boosts.
 */
function calculateScore(item, fuseScore, normalizedQuery, intent, queryNums, isPrePass) {
  // Base: invert Fuse score. Pre-pass items start at 1.0 (perfect match)
  let score = isPrePass ? 1.0 : (1 - fuseScore);

  // ── Type boost (0.05–0.30) ──────────────────────
  score += TYPE_BOOST[item.type] || 0;

  // ── Recency boost (scannedAt) ───────────────────
  const ts = item.scannedAt ? new Date(item.scannedAt).getTime() : 0;
  if (ts > 0) {
    const daysAgo = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 0.15 - (daysAgo * 0.005));
  }

  // ── Suffix / position boost ─────────────────────
  if (normalizedQuery && normalizedQuery.length > 0) {
    const normTitle = (item.searchTitleNormalized || normalizeText(item.title || '')).toLowerCase();
    const normQ = normalizedQuery.toLowerCase();

    if (normTitle.endsWith(normQ)) {
      score += 0.60;
    } else if (normTitle.includes(normQ)) {
      score += 0.35;
    } else {
      const qTokens = normQ.split(' ').filter(Boolean);
      let lastIdx = -1, allInOrder = true;
      for (const qt of qTokens) {
        const idx = normTitle.indexOf(qt, lastIdx + 1);
        if (idx === -1) { allInOrder = false; break; }
        lastIdx = idx;
      }
      if (allInOrder && qTokens.length > 0) score += 0.20;
    }
  }

  // ── Intent boost (capped at INTENT_CAP = 0.25) ──
  if (intent) {
    let intentBoost = 0;
    for (const [key, confidence] of Object.entries(intent)) {
      if (confidence > 0 && INTENT_TYPE_MAP[key]) {
        const matches = INTENT_TYPE_MAP[key].includes(item.type);
        if (matches) intentBoost += INTENT_MAX_BOOST[key] * confidence;
      }
    }
    score += Math.min(intentBoost, INTENT_CAP);
  }

  // ── Numeric alignment ───────────────────────────
  if (queryNums && queryNums.length > 0) {
    const titleText = (item.searchTitleNormalized || normalizeText(item.title || '')).toLowerCase();
    const { aligned, mismatched } = computeNumericAlignment(queryNums, titleText);
    if (aligned > 0) score += 0.10 * (aligned / queryNums.length);
    if (mismatched > 0) score -= 0.18 * (mismatched / queryNums.length);
  }

  // ── Token coverage ──────────────────────────────
  if (normalizedQuery) {
    const titleText = (item.searchTitleNormalized || normalizeText(item.title || '')).toLowerCase();
    const contextText = normalizeText((item.folderPath || '') + ' ' + (item.moduleName || ''));
    const coverage = computeTokenCoverage(normalizedQuery, titleText, contextText);
    const qTokenCount = normalizedQuery.split(/\s+/).filter(t => t.length > 1 && !STOP_TOKENS.has(t)).length;
    if (coverage >= 0.8) {
      score += 0.12;
    } else if (coverage < 0.5 && qTokenCount >= 2) {
      score -= 0.15 * (1 - coverage);
    }
  }

  // ── Active-course prior ─────────────────────────
  score += getActiveCourseBoost(item);

  // ── Folder-context boost ────────────────────────
  // Boost items whose folder/module name matches query tokens
  if (normalizedQuery && (item.folderPath || item.moduleName)) {
    const folderText = normalizeText((item.folderPath || '') + ' ' + (item.moduleName || ''));
    const normQ = normalizedQuery.toLowerCase();
    const qTokens = normQ.split(/\s+/).filter(t => t.length > 1 && !STOP_TOKENS.has(t));
    if (qTokens.length > 0) {
      let folderHits = 0;
      for (const t of qTokens) {
        if (folderText.includes(t)) folderHits++;
      }
      if (folderHits > 0) {
        // Proportional boost, max +0.35
        score += Math.min(0.35, 0.25 * (folderHits / qTokens.length));
      }
    }
  }

  // ── Click-feedback boost ────────────────────────
  score += getClickBoost(item);

  // ── Due-date-aware freshness ────────────────────
  if (item.dueAt && (intent?.assignment > 0 || intent?.quiz > 0)) {
    const dueTs = new Date(item.dueAt).getTime();
    if (dueTs > 0) {
      const daysUntilDue = (dueTs - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysUntilDue >= 0 && daysUntilDue <= 14) {
        // Upcoming: boost more the closer the due date
        score += Math.max(0, 0.18 - daysUntilDue * 0.012);
      } else if (daysUntilDue < 0 && daysUntilDue > -30) {
        // Recently past: mild decay
        score += Math.max(0, 0.05 + daysUntilDue * 0.002);
      }
    }
  }

  return score;
}

/**
 * Re-rank results using full scoring pipeline + diversity pass
 */
function rankResults(results, normalizedQuery, intent, queryNums) {
  const scored = results
    .map(r => ({
      ...r,
      finalScore: calculateScore(r.item, r.score, normalizedQuery, intent, queryNums, !!r.prePass)
    }))
    .sort((a, b) => b.finalScore - a.finalScore);

  return applyDiversityRerank(scored);
}

// ============================================
// SEARCH HISTORY
// ============================================

async function loadSearchHistory() {
  try {
    const result = await chrome.storage.local.get(['searchHistory']);
    state.searchHistory = result.searchHistory || [];
  } catch (e) {
    state.searchHistory = [];
  }
}

async function saveSearchToHistory(query) {
  if (!query || query.length < 2) return;

  // Remove duplicates and add to front
  state.searchHistory = state.searchHistory.filter(h => h.query.toLowerCase() !== query.toLowerCase());
  state.searchHistory.unshift({ query, timestamp: Date.now() });

  // Keep only last MAX_HISTORY
  state.searchHistory = state.searchHistory.slice(0, MAX_HISTORY);

  try {
    await chrome.storage.local.set({ searchHistory: state.searchHistory });
  } catch (e) {
    console.log('[Canvascope] Could not save search history');
  }
}

function showSearchHistory() {
  const query = elements.searchInput.value.trim();
  if (query.length > 0 || state.searchHistory.length === 0) {
    hideSearchHistory();
    return;
  }

  elements.searchHistory.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'history-header';
  header.innerHTML = '<span>Recent Searches</span><button class="history-clear">Clear</button>';
  header.querySelector('.history-clear').addEventListener('click', clearSearchHistory);
  elements.searchHistory.appendChild(header);

  state.searchHistory.forEach(item => {
    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';
    historyItem.textContent = item.query;
    historyItem.addEventListener('click', () => {
      elements.searchInput.value = item.query;
      hideSearchHistory();
      performSearch(item.query);
    });
    elements.searchHistory.appendChild(historyItem);
  });

  elements.searchHistory.classList.remove('hidden');
}

function hideSearchHistory() {
  elements.searchHistory.classList.add('hidden');
}

async function clearSearchHistory() {
  state.searchHistory = [];
  await chrome.storage.local.set({ searchHistory: [] });
  hideSearchHistory();
}

function displayResults(results) {
  clearResultsContainer();
  elements.emptyState.classList.add('hidden');

  // Hide planner when showing search results
  if (elements.duePlanner) elements.duePlanner.classList.add('hidden');

  // Hide recents section when showing search results
  const recents = document.getElementById('overlay-recents');
  if (recents) recents.remove();

  // Reset highlight index
  state.overlayHighlightIndex = 0;

  results.forEach((result, index) => {
    const item = result.item;

    const resultElement = document.createElement('div');
    resultElement.className = 'result-item';
    resultElement.setAttribute('tabindex', '0');
    resultElement.setAttribute('role', 'button');

    // Auto-highlight first result in overlay mode
    if (state.isOverlayMode && index === 0) {
      resultElement.classList.add('overlay-highlighted');
    }

    // In overlay mode: title + course on left, type badge on right
    if (state.isOverlayMode) {
      const textCol = document.createElement('div');
      textCol.className = 'overlay-result-text';

      const titleElement = document.createElement('div');
      titleElement.className = 'result-title';
      titleElement.textContent = item.title || 'Untitled';
      textCol.appendChild(titleElement);

      if (item.courseName) {
        const courseEl = document.createElement('div');
        courseEl.className = 'overlay-result-course';
        courseEl.textContent = item.courseName;
        // Append color-coded due label
        if (item.dueAt && isTaskType(item)) {
          const sep = document.createTextNode('  ·  ');
          courseEl.appendChild(sep);
          const dueSpan = document.createElement('span');
          dueSpan.className = `due-chip-search ${dueUrgencyClass(item)}`;
          dueSpan.textContent = formatDueLabel(item);
          courseEl.appendChild(dueSpan);
        }
        textCol.appendChild(courseEl);
      }

      resultElement.appendChild(textCol);

      const typeBadge = document.createElement('span');
      typeBadge.className = `overlay-type-badge type-${(item.type || 'link').toLowerCase()}`;
      typeBadge.textContent = formatOverlayType(item.type || 'link');
      resultElement.appendChild(typeBadge);
    } else {
      // Normal popup mode — title then meta row
      const titleElement = document.createElement('div');
      titleElement.className = 'result-title';
      titleElement.textContent = item.title || 'Untitled';
      resultElement.appendChild(titleElement);

      const metaElement = document.createElement('div');
      metaElement.className = 'result-meta';

      const typeElement = document.createElement('span');
      typeElement.className = 'result-type';
      typeElement.textContent = item.type || 'link';

      const courseElement = document.createElement('span');
      courseElement.className = 'result-module';
      courseElement.textContent = item.courseName || '';

      metaElement.appendChild(typeElement);
      if (item.courseName) {
        metaElement.appendChild(courseElement);
      }

      // Due-date chip for task items in search results
      if (item.dueAt && isTaskType(item)) {
        const dueChip = document.createElement('span');
        dueChip.className = `due-chip-search ${dueUrgencyClass(item)}`;
        dueChip.textContent = formatDueLabel(item);
        metaElement.appendChild(dueChip);
      }

      resultElement.appendChild(metaElement);
    }

    resultElement.addEventListener('click', () => openResult(item));
    resultElement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openResult(item);
    });

    elements.resultsContainer.appendChild(resultElement);
  });
}

/**
 * Format type name for overlay badge display
 */
function formatOverlayType(type) {
  const names = {
    'assignment': 'ASSIGNMENT',
    'quiz': 'QUIZ',
    'discussion': 'DISCUSSION',
    'page': 'PAGE',
    'file': 'FILE',
    'pdf': 'FILE',
    'slides': 'FILE',
    'document': 'FILE',
    'video': 'VIDEO',
    'course': 'COURSE',
    'navigation': 'NAV',
    'link': 'LINK',
    'external': 'LINK',
    'externalurl': 'LINK'
  };
  return names[type] || type.toUpperCase();
}

/**
 * Update overlay footer with result count and timing
 */
function updateOverlayFooter(count, timeMs) {
  if (!state.isOverlayMode || !elements.overlayResultCount) return;
  if (count === 0) {
    elements.overlayResultCount.textContent = '';
  } else {
    elements.overlayResultCount.textContent = `${count} result${count !== 1 ? 's' : ''} in ${timeMs}ms`;
  }
}

function openResult(item) {
  if (item.url && isValidLmsUrl(item.url)) {
    // Save to recently opened + update click feedback
    saveToRecents(item);
    updateClickFeedback(item);

    chrome.tabs.update({ url: item.url });

    // If in overlay mode, tell parent to close (use strict origin)
    if (window.self !== window.top) {
      const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
      window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, extensionOrigin);
    } else {
      window.close(); // Close popup after navigation
    }
  }
}

// ============================================
// RECENTLY OPENED
// ============================================

async function loadRecentlyOpened() {
  try {
    const result = await chrome.storage.local.get(['recentlyOpened']);
    state.recentlyOpened = result.recentlyOpened || [];
  } catch (e) {
    state.recentlyOpened = [];
  }
}

async function saveToRecents(item) {
  // Remove if already exists (by URL)
  state.recentlyOpened = state.recentlyOpened.filter(r => r.url !== item.url);

  // Add to front
  state.recentlyOpened.unshift({
    title: item.title,
    url: item.url,
    type: item.type,
    courseName: item.courseName,
    openedAt: Date.now()
  });

  // Cap at MAX_RECENTS
  state.recentlyOpened = state.recentlyOpened.slice(0, MAX_RECENTS);

  try {
    await chrome.storage.local.set({ recentlyOpened: state.recentlyOpened });
  } catch (e) {
    console.log('[Canvascope] Could not save recents');
  }
}

/**
 * Show recently opened items in the overlay empty state
 */
function showOverlayRecents() {
  if (!state.isOverlayMode || state.recentlyOpened.length === 0) return;

  // Remove existing recents section if any
  const existing = document.getElementById('overlay-recents');
  if (existing) existing.remove();

  const recentsSection = document.createElement('div');
  recentsSection.id = 'overlay-recents';
  recentsSection.className = 'overlay-recents';

  const header = document.createElement('div');
  header.className = 'overlay-recents-header';
  header.textContent = 'Recently Opened';
  recentsSection.appendChild(header);

  state.recentlyOpened.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'result-item overlay-recent-item';
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');

    const textCol = document.createElement('div');
    textCol.className = 'overlay-result-text';

    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = item.title || 'Untitled';
    textCol.appendChild(title);

    if (item.courseName) {
      const course = document.createElement('div');
      course.className = 'overlay-result-course';
      course.textContent = item.courseName;
      textCol.appendChild(course);
    }

    el.appendChild(textCol);

    const typeBadge = document.createElement('span');
    typeBadge.className = `overlay-type-badge type-${(item.type || 'link').toLowerCase()}`;
    typeBadge.textContent = formatOverlayType(item.type || 'link');
    el.appendChild(typeBadge);

    el.addEventListener('click', () => openResult(item));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openResult(item);
    });

    recentsSection.appendChild(el);
  });

  // Insert after results container (which shows empty state)
  elements.resultsContainer.after(recentsSection);
}

/**
 * Check if a hostname is a known supported LMS host (unified check).
 * @param {string} hostname - lowercase hostname
 * @returns {boolean}
 */
function isKnownCanvasHost(hostname) {
  if (CANVAS_DOMAIN_SUFFIXES.some(s => hostname.endsWith(s))) return true;
  if (KNOWN_CANVAS_DOMAINS.includes(hostname)) return true;
  return false;
}

function isKnownBrightspaceHost(hostname) {
  if (BRIGHTSPACE_DOMAIN_SUFFIXES.some(s => hostname.endsWith(s))) return true;
  if (KNOWN_BRIGHTSPACE_DOMAINS.includes(hostname)) return true;
  return false;
}

function isKnownLmsHost(hostname) {
  if (isKnownCanvasHost(hostname)) return true;
  if (isKnownBrightspaceHost(hostname)) return true;
  if (popupCustomDomains.includes(hostname)) return true;
  return false;
}

function isValidLmsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return isKnownLmsHost(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Backward-compatible alias used by older call-sites.
function isValidCanvasUrl(url) {
  return isValidLmsUrl(url);
}

function clearSearch() {
  elements.searchInput.value = '';
  elements.clearSearchBtn.classList.remove('visible');
  showEmptyState();
  elements.searchInput.focus();
}

function showEmptyState() {
  clearResultsContainer();
  elements.emptyState.classList.remove('hidden');
  updateOverlayFooter(0, 0);

  // Show Due Planner when search is empty (popup mode only)
  if (elements.duePlanner && !state.isOverlayMode) {
    renderDuePlanner();
    const hasTasks = elements.duePlanner.innerHTML.trim().length > 0;
    elements.duePlanner.classList.toggle('hidden', !hasTasks);
    if (hasTasks) {
      elements.emptyState.classList.add('hidden');
    }
  }
}

function showNoResults(message) {
  clearResultsContainer();
  elements.emptyState.classList.add('hidden');

  const noResultsElement = document.createElement('div');
  noResultsElement.className = 'no-results';
  noResultsElement.textContent = message;
  elements.resultsContainer.appendChild(noResultsElement);
}

function clearResultsContainer() {
  const children = Array.from(elements.resultsContainer.children);
  children.forEach(child => {
    if (child.id !== 'empty-state' && child.id !== 'due-planner') {
      child.remove();
    }
  });
}

// ============================================
// DATA MANAGEMENT
// ============================================

async function loadContent() {
  try {
    const result = await chrome.storage.local.get(['indexedContent']);
    let content = result.indexedContent || [];

    // Deduplicate by normalizing URLs (strip module_item_id)
    content = deduplicateCrossType(deduplicateContent(content));

    state.indexedContent = content;
    console.log(`[Canvascope] Loaded ${state.indexedContent.length} items (after dedup)`);
  } catch (error) {
    console.error('[Canvascope] Error loading content:', error);
    state.indexedContent = [];
  }
}

/**
 * Derive a stable canonical identity key for a content item.
 * Prefers URL-based identity (origin + pathname).
 * Keeps stable query keys for Brightspace URLs where IDs are query-based.
 * Falls back to title|course|type hash.
 */
function getCanonicalId(item) {
  if (!item || typeof item !== 'object') return '__invalid__';

  if (item.url && typeof item.url === 'string') {
    try {
      const u = new URL(item.url);
      const host = u.hostname.toLowerCase();
      const isBrightspace = BRIGHTSPACE_DOMAIN_SUFFIXES.some(s => host.endsWith(s)) ||
        KNOWN_BRIGHTSPACE_DOMAINS.includes(host) ||
        u.pathname.toLowerCase().includes('/d2l/');
      if (isBrightspace) {
        const keepKeys = ['ou', 'db', 'qi', 'forumid', 'topicid', 'newsitemid', 'id', 'itemid'];
        const kept = [];
        for (const key of keepKeys) {
          const value = u.searchParams.get(key);
          if (value) kept.push(`${key}=${value}`);
        }
        if (kept.length) {
          return `${u.origin}${u.pathname}?${kept.join('&')}`;
        }
      }
      return `${u.origin}${u.pathname}`;
    } catch { /* fall through */ }
  }

  const raw = `${(item.title || '').trim()}|${(item.courseName || '').trim()}|${item.type || ''}`;
  return `__hash__${raw}`;
}

/**
 * Remove duplicate entries using canonical ID.
 * Prefers canonical URLs (e.g. /assignments/123) over module item URLs.
 */
function deduplicateContent(content) {
  const seen = new Map();

  for (const item of content) {
    // Null guard: skip malformed items
    if (!item || typeof item !== 'object') continue;

    const key = getCanonicalId(item);

    if (!seen.has(key)) {
      seen.set(key, item);
    } else {
      const existing = seen.get(key);

      const isCanonical = (url) => {
        if (!url || typeof url !== 'string') return false;
        return url.includes('/assignments/') ||
          url.includes('/quizzes/') ||
          url.includes('/files/') ||
          url.includes('/discussion_topics/') ||
          url.includes('/dropbox/') ||
          url.includes('/quizzing/') ||
          url.includes('/discussions/');
      };

      const existingIsCanonical = isCanonical(existing.url);
      const newIsCanonical = isCanonical(item.url);

      let winner = existing;
      if (newIsCanonical && !existingIsCanonical) {
        winner = item;
        seen.set(key, item);
      } else if (newIsCanonical === existingIsCanonical) {
        if ((item.url || '').length < (existing.url || '').length) {
          winner = item;
          seen.set(key, item);
        }
      }

      // Merge due-date fields from either copy (prefer non-null)
      const loser = winner === item ? existing : item;
      if (!winner.dueAt && loser.dueAt) winner.dueAt = loser.dueAt;
      if (!winner.unlockAt && loser.unlockAt) winner.unlockAt = loser.unlockAt;
      if (!winner.lockAt && loser.lockAt) winner.lockAt = loser.lockAt;
    }
  }

  return Array.from(seen.values());
}

/**
 * Second-pass dedup: merge items with identical title + course but different types.
 * Prefers assignment > quiz > discussion, merges due-date fields.
 */
function deduplicateCrossType(content) {
  const TYPE_PRIORITY = { assignment: 0, quiz: 1, discussion: 2 };
  const groups = new Map();

  for (const item of content) {
    if (!item || !item.title) continue;
    const key = `${(item.title || '').trim().toLowerCase()}|${(item.courseName || '').trim().toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, item);
    } else {
      const existing = groups.get(key);
      const existingPri = TYPE_PRIORITY[(existing.type || '').toLowerCase()] ?? 99;
      const newPri = TYPE_PRIORITY[(item.type || '').toLowerCase()] ?? 99;

      let winner = existing;
      if (newPri < existingPri) {
        winner = item;
        groups.set(key, item);
      }
      const loser = winner === item ? existing : item;
      if (!winner.dueAt && loser.dueAt) winner.dueAt = loser.dueAt;
      if (!winner.unlockAt && loser.unlockAt) winner.unlockAt = loser.unlockAt;
      if (!winner.lockAt && loser.lockAt) winner.lockAt = loser.lockAt;
    }
  }

  return Array.from(groups.values());
}

async function handleRefresh() {
  if (state.isScanning) return;

  elements.refreshBtn.disabled = true;
  showScanningStatus();

  try {
    await chrome.runtime.sendMessage({ action: 'forceScan' });
  } catch (e) {
    showErrorStatus('Could not start sync');
    elements.refreshBtn.disabled = false;
  }

  // Re-enable after a short delay
  setTimeout(() => {
    elements.refreshBtn.disabled = false;
  }, 2000);
}

async function handleClearData() {
  const confirmed = confirm(
    'Delete all indexed content?\n\nYour content will re-sync automatically when you browse Canvas or Brightspace.'
  );

  if (!confirmed) return;

  try {
    await chrome.storage.local.set({ indexedContent: [] });
    state.indexedContent = [];
    state.fuse = null;
    updateUI();
    showEmptyState();
    clearSearch();
    showSyncedStatus('Data cleared');
  } catch (error) {
    console.error('[Canvascope] Error clearing data:', error);
  }
}

// ============================================
// UI UPDATES
// ============================================

function updateUI() {
  updateStats();
}

function updateStats() {
  const count = state.indexedContent.length;

  if (count === 0) {
    elements.statsBtn.classList.add('empty');
    elements.statsText.textContent = 'No content indexed';
    elements.statsHint.textContent = 'Open Canvas or Brightspace to sync';
  } else {
    elements.statsBtn.classList.remove('empty');
    elements.statsText.textContent = `${count} items`;
    elements.statsHint.textContent = 'Click to browse';
  }
}

// ============================================
// BROWSE MODAL
// ============================================

function openBrowseModal() {
  if (state.indexedContent.length === 0) {
    return;
  }

  const grouped = groupContentByType(state.indexedContent);
  buildBrowseTabs(grouped);
  showBrowseCategory('all', state.indexedContent);
  elements.browseModal.classList.remove('hidden');
}

function closeBrowseModal() {
  elements.browseModal.classList.add('hidden');
}

function groupContentByType(content) {
  const grouped = { all: content };

  content.forEach(item => {
    const type = item.type || 'other';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(item);
  });

  return grouped;
}

function buildBrowseTabs(grouped) {
  elements.browseTabs.innerHTML = '';

  const types = Object.keys(grouped).sort((a, b) => {
    if (a === 'all') return -1;
    if (b === 'all') return 1;
    return grouped[b].length - grouped[a].length;
  });

  types.forEach(type => {
    const tab = document.createElement('button');
    tab.className = 'browse-tab' + (type === 'all' ? ' active' : '');

    const label = document.createElement('span');
    label.textContent = formatTypeName(type);

    const countSpan = document.createElement('span');
    countSpan.className = 'tab-count';
    countSpan.textContent = grouped[type].length;

    tab.appendChild(label);
    tab.appendChild(countSpan);

    tab.addEventListener('click', () => {
      elements.browseTabs.querySelectorAll('.browse-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      showBrowseCategory(type, grouped[type]);
    });

    elements.browseTabs.appendChild(tab);
  });
}

function formatTypeName(type) {
  const names = {
    'all': 'All',
    'assignment': 'Assignments',
    'quiz': 'Quizzes',
    'discussion': 'Discussions',
    'page': 'Pages',
    'file': 'Files',
    'pdf': 'PDFs',
    'slides': 'Slides',
    'video': 'Videos',
    'document': 'Documents',
    'externalurl': 'Links',
    'other': 'Other'
  };
  return names[type] || type;
}

function showBrowseCategory(type, items) {
  elements.browseContent.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'browse-empty';
    empty.textContent = 'No items';
    elements.browseContent.appendChild(empty);
    return;
  }

  const sorted = [...items].sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  sorted.forEach(item => {
    const itemEl = document.createElement('div');
    itemEl.className = 'browse-item';

    const title = document.createElement('div');
    title.className = 'browse-item-title';
    title.textContent = item.title || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'browse-item-meta';
    const parts = [];
    if (item.type && type === 'all') parts.push(item.type.toUpperCase());
    if (item.courseName) parts.push(item.courseName);
    meta.textContent = parts.join(' • ');

    itemEl.appendChild(title);
    if (parts.length > 0) itemEl.appendChild(meta);

    itemEl.addEventListener('click', () => {
      if (isValidLmsUrl(item.url)) {
        chrome.tabs.create({ url: item.url });
      }
    });

    elements.browseContent.appendChild(itemEl);
  });
}
