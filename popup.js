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

const BASE_FUSE_OPTIONS = Object.freeze({
  includeScore: true,
  includeMatches: true,
  minMatchCharLength: 2,
  ignoreLocation: true,
  findAllMatches: true
});

const BASE_FUSE_KEYS = Object.freeze([
  Object.freeze({ name: 'title', weight: 3.0, bucket: 'title' }),
  Object.freeze({ name: 'searchTitleNormalized', weight: 2.5, bucket: 'title' }),
  Object.freeze({ name: 'searchAliases', weight: 2.0, bucket: 'title' }),
  Object.freeze({ name: 'searchPathNormalized', weight: 2.2, bucket: 'context' }),
  Object.freeze({ name: 'searchCourseNormalized', weight: 2.2, bucket: 'context' }),
  Object.freeze({ name: 'folderPath', weight: 1.8, bucket: 'context' }),
  Object.freeze({ name: 'moduleName', weight: 1.5, bucket: 'context' }),
  Object.freeze({ name: 'courseName', weight: 1.2, bucket: 'context' }),
  Object.freeze({ name: 'type', weight: 0.5, bucket: 'type' })
]);

const DEFAULT_CUSTOM_ALGORITHM = Object.freeze({
  enabled: false,
  fuzzyThreshold: 35,
  titleWeight: 100,
  contextWeight: 100,
  recencyBoost: 100,
  courseBoost: 100,
  dueDateBoost: 100,
  typeBoost: 100
});

const CUSTOM_ALGORITHM_LIMITS = Object.freeze({
  fuzzyThreshold: Object.freeze({ min: 15, max: 65 }),
  titleWeight: Object.freeze({ min: 50, max: 180 }),
  contextWeight: Object.freeze({ min: 50, max: 180 }),
  recencyBoost: Object.freeze({ min: 0, max: 200 }),
  courseBoost: Object.freeze({ min: 0, max: 200 }),
  dueDateBoost: Object.freeze({ min: 0, max: 200 }),
  typeBoost: Object.freeze({ min: 0, max: 200 })
});

const CUSTOM_ALGORITHM_WARNING = 'Custom Algorithm is experimental. It changes how Canvascope ranks search results and can make matches less predictable. Enable it anyway?';

const MAX_RESULTS = 20;
const SEARCH_DEBOUNCE_MS = 150;
const OVERLAY_SEARCH_DEBOUNCE_MS = 75;
const MAX_HISTORY = 10;
const SLASH_RESULT_LIMIT = 18;
const DEFAULT_SEARCH_PLACEHOLDER = 'Search · type, title, course';
const SLASH_SEARCH_PLACEHOLDER = 'Type a command or alias'; // Unused — slash moved to in-page overlay
const KEY_LIKE_CONTENT_RE = /\b(?:answer\s+keys?|worked\s+solutions?|solutions?|keys?)\b/i;
const KEY_LIKE_CONTENT_STRIP_RE = /\b(?:answer\s+keys?|worked\s+solutions?|solutions?|keys?)\b/gi;
const EXPLICIT_TASK_QUALIFIER_RE = /\b(pre[\s-]*lab|post[\s-]*lab|quiz|assignment|discussion|homework|worksheet|exam)\b/i;

// Type boost values for ranking
const TYPE_BOOST = {
  syllabus: 0.42,
  assignment: 0.30,
  quiz: 0.25,
  discussion: 0.20,
  folder: 0.18,
  page: 0.15,
  file: 0.10,
  pdf: 0.10,
  video: 0.08,
  externalurl: 0.05
};

function clampAlgorithmValue(key, rawValue) {
  const bounds = CUSTOM_ALGORITHM_LIMITS[key];
  if (!bounds) return DEFAULT_CUSTOM_ALGORITHM[key];

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CUSTOM_ALGORITHM[key];
  }

  return Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)));
}

function normalizeCustomAlgorithm(rawCustomAlgorithm) {
  const source = rawCustomAlgorithm && typeof rawCustomAlgorithm === 'object' ? rawCustomAlgorithm : {};
  const normalized = {
    ...DEFAULT_CUSTOM_ALGORITHM,
    enabled: Boolean(source.enabled)
  };

  for (const key of Object.keys(CUSTOM_ALGORITHM_LIMITS)) {
    normalized[key] = clampAlgorithmValue(key, source[key]);
  }

  return normalized;
}

function getStoredCustomAlgorithm(settings = state.extensionSettings) {
  return normalizeCustomAlgorithm(settings?.customAlgorithm);
}

function getActiveSearchAlgorithm(settings = state.extensionSettings) {
  const stored = getStoredCustomAlgorithm(settings);
  return stored.enabled ? stored : { ...DEFAULT_CUSTOM_ALGORITHM };
}

function getActiveSearchAlgorithmKey(settings = state.extensionSettings) {
  return JSON.stringify(getActiveSearchAlgorithm(settings));
}

function buildFuseOptions({ relaxed = false, settings = state.extensionSettings } = {}) {
  const tuning = getActiveSearchAlgorithm(settings);
  const titleMultiplier = tuning.titleWeight / 100;
  const contextMultiplier = tuning.contextWeight / 100;
  const typeMultiplier = tuning.typeBoost / 100;
  const threshold = Math.min(0.8, (tuning.fuzzyThreshold / 100) + (relaxed ? 0.2 : 0));

  return {
    ...BASE_FUSE_OPTIONS,
    threshold,
    keys: BASE_FUSE_KEYS.map(({ name, weight, bucket }) => {
      let multiplier = 1;
      if (bucket === 'title') multiplier = titleMultiplier;
      if (bucket === 'context') multiplier = contextMultiplier;
      if (bucket === 'type') multiplier = typeMultiplier;

      return {
        name,
        weight: Math.max(0.001, weight * multiplier)
      };
    })
  };
}

function formatCustomAlgorithmValue(key, value) {
  if (key === 'fuzzyThreshold') {
    return `${value}%`;
  }
  return `${value}%`;
}

// ============================================
// INTENT DETECTION
// ============================================

const INTENT_PATTERNS = {
  assignment: /\b(hw|homework|pset|problem\s*set|project|lab|worksheet|due|assn|assign|proj)\b/,
  quiz: /\b(quiz|midterm|exam|final|mt|test)\b/,
  page: /\b(lecture|notes|slides|reading|chapter|lec|ch|chap)\b/,
  file: /\b(pdf|doc|file|handout|document|worksheet|lecture|exam)\b/,
  recency: /\b(latest|newest|recent|last|current)\b/
};

// Intent ↔ item.type mapping
const INTENT_TYPE_MAP = {
  assignment: ['assignment'],
  quiz: ['quiz'],
  page: ['page', 'video', 'slides'],
  file: ['file', 'pdf', 'document'],
  recency: [] // Handled separately in score calculation
};

const INTENT_MAX_BOOST = { assignment: 0.22, quiz: 0.22, page: 0.16, file: 0.20 };
const INTENT_CAP = 0.40;

/**
 * Detect query intent — returns { assignment, quiz, page, file, recency } confidences [0..1]
 */
function detectQueryIntent(normalizedQuery) {
  const intent = { assignment: 0, quiz: 0, page: 0, file: 0, recency: 0 };
  for (const [key, re] of Object.entries(INTENT_PATTERNS)) {
    intent[key] = re.test(normalizedQuery) ? 1.0 : 0;
  }
  return intent;
}

// ============================================
// TEMPORAL QUERY INTENT (today / yesterday / this week / last week)
// ============================================

function levenshteinDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  const prev = new Array(t.length + 1);
  const curr = new Array(t.length + 1);

  for (let j = 0; j <= t.length; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= t.length; j++) prev[j] = curr[j];
  }

  return prev[t.length];
}

function tokenRoughlyMatches(token, target) {
  if (!token || !target) return false;
  const a = token.toLowerCase();
  const b = target.toLowerCase();
  if (a === b) return true;

  // Allow common typos while keeping false positives low.
  const maxDist = b.length >= 7 ? 2 : 1;
  return levenshteinDistance(a, b) <= maxDist;
}

function detectTemporalIntent(normalizedQuery) {
  const tokens = (normalizedQuery || '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: null, strippedQuery: normalizedQuery };

  const weekIdx = tokens.findIndex(t => tokenRoughlyMatches(t, 'week'));
  const thisIdx = tokens.findIndex(t => tokenRoughlyMatches(t, 'this'));
  const lastIdx = tokens.findIndex(t => tokenRoughlyMatches(t, 'last'));
  const todayIdx = tokens.findIndex(t => tokenRoughlyMatches(t, 'today'));
  const yesterdayIdx = tokens.findIndex(t => tokenRoughlyMatches(t, 'yesterday'));

  let kind = null;
  const drop = new Set();

  if (todayIdx !== -1) {
    kind = 'today';
    drop.add(todayIdx);
  } else if (yesterdayIdx !== -1) {
    kind = 'yesterday';
    drop.add(yesterdayIdx);
  } else if (weekIdx !== -1 && lastIdx !== -1) {
    kind = 'last_week';
    drop.add(weekIdx);
    drop.add(lastIdx);
  } else if (weekIdx !== -1 && thisIdx !== -1) {
    kind = 'this_week';
    drop.add(weekIdx);
    drop.add(thisIdx);
  } else if (weekIdx !== -1) {
    // If user just says "week" (or typo), default to this_week behavior.
    kind = 'this_week';
    drop.add(weekIdx);
  }

  if (!kind) {
    return { kind: null, strippedQuery: normalizedQuery };
  }

  const strippedTokens = tokens.filter((_, idx) => !drop.has(idx));
  const strippedQuery = strippedTokens.join(' ').trim();

  return { kind, strippedQuery };
}

function getTemporalWindow(kind) {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (kind === 'today') return { anchorTs: now, radiusMs: 2 * DAY_MS };
  if (kind === 'yesterday') return { anchorTs: now - DAY_MS, radiusMs: 2 * DAY_MS };
  if (kind === 'last_week') return { anchorTs: now - (7 * DAY_MS), radiusMs: 7 * DAY_MS };
  // this_week (default)
  return { anchorTs: now, radiusMs: 7 * DAY_MS };
}

function isTemporalTask(item) {
  const t = String(item?.type || '').toLowerCase();
  return t === 'assignment' || t === 'quiz' || t === 'discussion';
}

function applyTemporalFilter(results, temporalKind) {
  if (!temporalKind) return results;
  const { anchorTs, radiusMs } = getTemporalWindow(temporalKind);

  return results.filter(r => {
    const item = r?.item;
    if (!item) return false;
    
    let ts = null;
    if (isTemporalTask(item) && item.dueAt) {
      ts = new Date(item.dueAt).getTime();
    } else if (item.createdAt || item.updatedAt) {
      ts = new Date(item.updatedAt || item.createdAt).getTime();
    }
    
    if (!ts || !Number.isFinite(ts) || ts <= 0) return false;
    return Math.abs(ts - anchorTs) <= radiusMs;
  });
}

function filterItemsByTemporalWindow(items, temporalKind) {
  if (!temporalKind) return items;
  const { anchorTs, radiusMs } = getTemporalWindow(temporalKind);
  return (items || []).filter(item => {
    let ts = null;
    if (isTemporalTask(item) && item.dueAt) {
      ts = new Date(item.dueAt).getTime();
    } else if (item.createdAt || item.updatedAt) {
      ts = new Date(item.updatedAt || item.createdAt).getTime();
    }
    
    if (!ts || !Number.isFinite(ts) || ts <= 0) return false;
    return Math.abs(ts - anchorTs) <= radiusMs;
  });
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
  const titleNums = titleText instanceof Set ? titleText : new Set(extractNumericTokens(titleText));
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

const STOP_TOKENS = new Set(['the', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'is']);
const BROAD_QUERY_TOKENS = new Set(['lab', 'laboratory', 'chemistry', 'biology', 'physics']);
const GENERIC_RECALL_TOKENS = new Set([
  ...BROAD_QUERY_TOKENS,
  'homework',
  'key',
  'keys',
  'assignment',
  'assignments',
  'quiz',
  'quizzes',
  'discussion',
  'discussions',
  'worksheet',
  'worksheets'
]);

/**
 * Compute fraction of query tokens present in searchable text using boundaries.
 * Checks title and optional context (folderPath, moduleName).
 * Ignores stop words and single-char tokens.
 */
function computeTokenCoverage(normalizedQuery, titleText, contextText) {
  const qTokens = normalizedQuery.split(/\s+/).filter(t => t.length > 0 && !STOP_TOKENS.has(t));
  if (qTokens.length === 0) return 1;
  const combined = ((titleText || '') + ' ' + (contextText || '')).toLowerCase();
  let found = 0;
  for (const t of qTokens) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(combined)) found++;
  }
  return found / qTokens.length;
}

// ============================================
// CLICK FEEDBACK
// ============================================
// ADAPTIVE LEARNING & SEARCH HABITS
// ============================================

let clickFeedbackMap = {}; // Legacy fallback
let searchHabitsSyncTimer = null;
const WEEKLY_HABIT_SLOT_HOURS = 2;
const WEEKLY_HABIT_MIN_STREAK = 3;
const WEEKLY_HABIT_MAX_LOOKAHEAD_WEEKS = 4;
const BACKEND_SUGGESTION_STALE_MS = 60 * 1000;
const ADAPTIVE_SEARCH_TASK_TOKENS = new Set(['lab', 'prelab', 'quiz', 'assignment', 'homework', 'discussion']);

function createEmptySearchHabits() {
  return {
    globalClicks: {},
    queryAffinity: {},
    weeklyQueryPatterns: {}
  };
}

function normalizeSearchHabits(rawHabits) {
  const source = rawHabits && typeof rawHabits === 'object' ? rawHabits : {};
  return {
    ...createEmptySearchHabits(),
    ...source,
    globalClicks: source.globalClicks && typeof source.globalClicks === 'object' ? source.globalClicks : {},
    queryAffinity: source.queryAffinity && typeof source.queryAffinity === 'object' ? source.queryAffinity : {},
    weeklyQueryPatterns: source.weeklyQueryPatterns && typeof source.weeklyQueryPatterns === 'object' ? source.weeklyQueryPatterns : {}
  };
}

function mergeSearchHabits(localHabits, remoteHabits) {
  const merged = normalizeSearchHabits(localHabits);
  const remote = normalizeSearchHabits(remoteHabits);

  for (const [key, remoteEntry] of Object.entries(remote.globalClicks)) {
    const localEntry = merged.globalClicks[key] || {};
    const localOpenCount = Number(localEntry.openCount || 0);
    const remoteOpenCount = Number(remoteEntry?.openCount || 0);
    const localLastOpenedAt = Number(localEntry.lastOpenedAt || 0);
    const remoteLastOpenedAt = Number(remoteEntry?.lastOpenedAt || 0);

    merged.globalClicks[key] = {
      openCount: Math.max(localOpenCount, remoteOpenCount),
      lastOpenedAt: Math.max(localLastOpenedAt, remoteLastOpenedAt)
    };
  }

  for (const [query, remoteAffinity] of Object.entries(remote.queryAffinity)) {
    if (!remoteAffinity || typeof remoteAffinity !== 'object') continue;
    const localAffinity = merged.queryAffinity[query] && typeof merged.queryAffinity[query] === 'object'
      ? merged.queryAffinity[query]
      : {};
    for (const [key, remoteCount] of Object.entries(remoteAffinity)) {
      localAffinity[key] = Math.max(Number(localAffinity[key] || 0), Number(remoteCount || 0));
    }
    merged.queryAffinity[query] = localAffinity;
  }

  for (const [patternKey, remotePattern] of Object.entries(remote.weeklyQueryPatterns)) {
    const localPattern = merged.weeklyQueryPatterns[patternKey];
    const localLastClickedAt = Number(localPattern?.lastClickedAt || 0);
    const remoteLastClickedAt = Number(remotePattern?.lastClickedAt || 0);
    if (!localPattern || remoteLastClickedAt > localLastClickedAt) {
      merged.weeklyQueryPatterns[patternKey] = remotePattern;
    }
  }

  return merged;
}

function getWeeklyHabitSlotKey(timestamp = Date.now()) {
  const { localDayOfWeek, localHourBucket } = getAdaptiveSearchSlotContext(timestamp);
  return `${localDayOfWeek}:${localHourBucket}`;
}

function getContinuousWeekIndex(timestamp = Date.now()) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const date = new Date(timestamp);
  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const mondayOffset = (date.getDay() + 6) % 7; // Monday = 0
  const mondayStart = localMidnight - (mondayOffset * DAY_MS);
  return Math.floor(mondayStart / (7 * DAY_MS));
}

function containsAdaptiveSearchTaskToken(tokens) {
  return (tokens || []).some(token => ADAPTIVE_SEARCH_TASK_TOKENS.has(token));
}

function deriveAdaptiveBaseQuery(normalizedQuery) {
  const cleanQuery = normalizeText(normalizedQuery || '');
  if (!cleanQuery) return '';
  const tokens = cleanQuery.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || !containsAdaptiveSearchTaskToken(tokens)) return '';
  return cleanQuery;
}

function extractAdaptiveSearchPattern(query) {
  const normalized = normalizeText(query || '');
  if (!normalized) return null;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;

  const lastToken = tokens[tokens.length - 1];
  if (!/^\d{1,3}$/.test(lastToken)) return null;

  const baseTokens = tokens.slice(0, -1);
  if (baseTokens.length < 2 || !containsAdaptiveSearchTaskToken(baseTokens)) return null;

  return {
    baseQuery: baseTokens.join(' '),
    weekNumber: Number(lastToken)
  };
}

function extractWeeklyHabitPattern(query) {
  return extractAdaptiveSearchPattern(query);
}

function getAdaptiveSearchSlotContext(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const localDayOfWeek = date.getDay();
  const localHourBucket = Math.floor(date.getHours() / WEEKLY_HABIT_SLOT_HOURS) * WEEKLY_HABIT_SLOT_HOURS;
  let localTimezone = 'UTC';

  try {
    localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (e) { /* ignore timezone lookup errors */ }

  return {
    localTimezone,
    localDayOfWeek,
    localHourBucket,
    localWeekIndex: getContinuousWeekIndex(timestamp),
    slotKey: `${localDayOfWeek}:${localHourBucket}`
  };
}

function buildWeeklyHabitQuery(baseQuery, weekNumber) {
  const normalizedBase = normalizeText(baseQuery || '');
  const normalizedWeek = Number(weekNumber);
  if (!normalizedBase || !Number.isFinite(normalizedWeek) || normalizedWeek <= 0) return '';
  return `${normalizedBase} ${normalizedWeek}`.trim();
}

function recordWeeklyHabitQueryClick(query, timestamp = Date.now()) {
  const pattern = extractAdaptiveSearchPattern(query);
  if (!pattern || !state.searchHabits) return;

  const patternKey = pattern.baseQuery;
  const slotKey = getWeeklyHabitSlotKey(timestamp);
  const currentWeekIndex = getContinuousWeekIndex(timestamp);

  if (!state.searchHabits.weeklyQueryPatterns[patternKey]) {
    state.searchHabits.weeklyQueryPatterns[patternKey] = {
      baseQuery: pattern.baseQuery,
      lastClickedAt: 0,
      slots: {}
    };
  }

  const entry = state.searchHabits.weeklyQueryPatterns[patternKey];
  const slotEntry = entry.slots[slotKey] || {
    totalClicks: 0,
    distinctWeekCount: 0,
    streakCount: 0,
    lastWeekIndex: null,
    lastWeekNumber: null,
    lastClickedAt: 0
  };

  slotEntry.totalClicks += 1;

  if (slotEntry.lastWeekIndex !== currentWeekIndex) {
    slotEntry.distinctWeekCount += 1;
    const expectedNextWeekNumber = Number.isFinite(slotEntry.lastWeekNumber)
      ? slotEntry.lastWeekNumber + 1
      : pattern.weekNumber;
    const isConsecutiveWeek = slotEntry.lastWeekIndex !== null && currentWeekIndex === slotEntry.lastWeekIndex + 1;
    const followsWeeklyProgression = pattern.weekNumber === expectedNextWeekNumber;

    if (isConsecutiveWeek && followsWeeklyProgression) {
      slotEntry.streakCount += 1;
    } else {
      slotEntry.streakCount = 1;
    }

    slotEntry.lastWeekIndex = currentWeekIndex;
  } else if (slotEntry.streakCount === 0) {
    slotEntry.streakCount = 1;
  }

  slotEntry.lastWeekNumber = pattern.weekNumber;
  slotEntry.lastClickedAt = timestamp;

  entry.baseQuery = pattern.baseQuery;
  entry.lastClickedAt = timestamp;
  entry.slots[slotKey] = slotEntry;
}

function getWeeklyHabitSuggestions(nowTs = Date.now()) {
  if (!state.extensionSettings?.enableAdaptiveLearning || !state.searchHabits?.weeklyQueryPatterns) return [];

  const slotKey = getWeeklyHabitSlotKey(nowTs);
  const currentWeekIndex = getContinuousWeekIndex(nowTs);
  const suggestions = [];

  for (const entry of Object.values(state.searchHabits.weeklyQueryPatterns)) {
    const baseQuery = normalizeText(entry?.baseQuery || '');
    const slotEntry = entry?.slots?.[slotKey];
    if (!baseQuery || !slotEntry) continue;
    if ((slotEntry.streakCount || 0) < WEEKLY_HABIT_MIN_STREAK) continue;
    if (!Number.isFinite(slotEntry.lastWeekIndex) || !Number.isFinite(slotEntry.lastWeekNumber)) continue;

    const weeksSinceLast = currentWeekIndex - slotEntry.lastWeekIndex;
    if (weeksSinceLast < 1 || weeksSinceLast > WEEKLY_HABIT_MAX_LOOKAHEAD_WEEKS) continue;

    const predictedWeekNumber = slotEntry.lastWeekNumber + weeksSinceLast;
    const query = buildWeeklyHabitQuery(baseQuery, predictedWeekNumber);
    if (!query) continue;

    const confidence = Math.min(
      10,
      (slotEntry.streakCount * 1.4)
      + Math.min(2, slotEntry.distinctWeekCount * 0.25)
      + Math.min(2, slotEntry.totalClicks * 0.15)
    );

    suggestions.push({
      query,
      baseQuery,
      predictedWeekNumber,
      confidence,
      slotKey,
      lastClickedAt: slotEntry.lastClickedAt || entry.lastClickedAt || 0,
      source: 'local'
    });
  }

  const seen = new Set();
  return suggestions
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if ((b.lastClickedAt || 0) !== (a.lastClickedAt || 0)) return (b.lastClickedAt || 0) - (a.lastClickedAt || 0);
      return a.query.localeCompare(b.query);
    })
    .filter((suggestion) => {
      if (seen.has(suggestion.query)) return false;
      seen.add(suggestion.query);
      return true;
    });
}

function normalizeBackendAdaptiveSuggestions(rawSuggestions) {
  if (!Array.isArray(rawSuggestions)) return [];
  const seen = new Set();
  const normalized = [];

  for (const entry of rawSuggestions) {
    const query = normalizeText(entry?.query || '');
    const baseQuery = normalizeText(entry?.baseQuery || '');
    if (!query || !baseQuery || seen.has(query)) continue;
    seen.add(query);
    normalized.push({
      query,
      baseQuery,
      predictedWeekNumber: Number.isFinite(Number(entry?.predictedSequenceNumber))
        ? Number(entry.predictedSequenceNumber)
        : null,
      confidence: Number.isFinite(Number(entry?.confidence)) ? Number(entry.confidence) : 0,
      slotMatch: entry?.slotMatch !== false,
      source: 'backend'
    });
  }

  return normalized.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.slotMatch !== b.slotMatch) return a.slotMatch ? -1 : 1;
    return a.query.localeCompare(b.query);
  });
}

function getAdaptiveSuggestionEntries(nowTs = Date.now()) {
  const currentSlotKey = getWeeklyHabitSlotKey(nowTs);
  const hasFreshBackendSuggestions = Array.isArray(state.backendAdaptiveSuggestions)
    && state.backendAdaptiveSuggestions.length > 0
    && state.backendAdaptiveSuggestionsSlotKey === currentSlotKey;

  if (hasFreshBackendSuggestions) {
    return state.backendAdaptiveSuggestions;
  }

  return getWeeklyHabitSuggestions(nowTs);
}

function getWeeklyHabitBoostQuery(normalizedQuery) {
  const cleanQuery = normalizeText(normalizedQuery || '');
  if (!cleanQuery) return null;

  const suggestions = getAdaptiveSuggestionEntries();
  const match = suggestions.find((suggestion) => suggestion.baseQuery === cleanQuery);
  return match ? match.query : null;
}

function buildAdaptiveSearchEventPayload(eventKind, rawQuery, overrides = {}) {
  const raw = String(rawQuery || '').trim().slice(0, 240);
  const normalizedQuery = normalizeText(overrides.normalizedQuery || raw);
  const detectedPattern = extractAdaptiveSearchPattern(overrides.baseQuery || normalizedQuery);
  const baseQuery = normalizeText(
    overrides.baseQuery
      || detectedPattern?.baseQuery
      || deriveAdaptiveBaseQuery(normalizedQuery)
  );
  const explicitSequenceNumber = Number(overrides.sequenceNumber);
  const sequenceNumber = Number.isFinite(explicitSequenceNumber)
    ? Math.max(1, Math.trunc(explicitSequenceNumber))
    : (detectedPattern?.weekNumber ?? null);
  const slotContext = getAdaptiveSearchSlotContext(overrides.timestamp || Date.now());

  return {
    eventKind,
    rawQuery: raw,
    normalizedQuery,
    baseQuery,
    sequenceNumber,
    localTimezone: slotContext.localTimezone,
    localDayOfWeek: slotContext.localDayOfWeek,
    localHourBucket: slotContext.localHourBucket,
    localWeekIndex: slotContext.localWeekIndex,
    clickedItemId: overrides.clickedItemId || null,
    clickedItemType: overrides.clickedItemType || null
  };
}

function recordAdaptiveSearchEvent(eventKind, rawQuery, overrides = {}) {
  if (!state.extensionSettings?.enableAdaptiveLearning) return Promise.resolve(false);
  if (!chrome?.runtime?.sendMessage) return Promise.resolve(false);

  const payload = buildAdaptiveSearchEventPayload(eventKind, rawQuery, overrides);
  if (!payload.normalizedQuery) return Promise.resolve(false);

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'recordAdaptiveSearchEvent', event: payload }, (response) => {
        if (chrome.runtime?.lastError) {
          resolve(false);
          return;
        }
        resolve(Boolean(response?.success));
      });
    } catch (e) {
      resolve(false);
    }
  });
}

async function loadBackendAdaptiveSuggestions({ prefix = '', force = false } = {}) {
  if (!state.extensionSettings?.enableAdaptiveLearning || !chrome?.runtime?.sendMessage) {
    state.backendAdaptiveSuggestions = [];
    return [];
  }

  const slotContext = getAdaptiveSearchSlotContext();
  const now = Date.now();
  const normalizedPrefix = normalizeText(prefix || '');
  const cacheIsFresh = !force
    && state.backendAdaptiveSuggestionsLoadedAt
    && (now - state.backendAdaptiveSuggestionsLoadedAt) < BACKEND_SUGGESTION_STALE_MS
    && state.backendAdaptiveSuggestionsSlotKey === slotContext.slotKey
    && state.backendAdaptiveSuggestionsPrefix === normalizedPrefix;

  if (cacheIsFresh) {
    return state.backendAdaptiveSuggestions;
  }

  if (state.backendAdaptiveSuggestionsPending) {
    return state.backendAdaptiveSuggestions || [];
  }

  state.backendAdaptiveSuggestionsPending = true;

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({
        type: 'fetchAdaptiveSearchSuggestions',
        context: {
          localTimezone: slotContext.localTimezone,
          localDayOfWeek: slotContext.localDayOfWeek,
          localHourBucket: slotContext.localHourBucket,
          prefix: normalizedPrefix || undefined
        }
      }, (response) => {
        state.backendAdaptiveSuggestionsPending = false;

        if (chrome.runtime?.lastError || !response?.success) {
          if (force) {
            state.backendAdaptiveSuggestions = [];
            state.backendAdaptiveSuggestionsSlotKey = slotContext.slotKey;
            state.backendAdaptiveSuggestionsPrefix = normalizedPrefix;
            state.backendAdaptiveSuggestionsLoadedAt = now;
          }
          resolve(state.backendAdaptiveSuggestions || []);
          return;
        }

        state.backendAdaptiveSuggestions = normalizeBackendAdaptiveSuggestions(response.suggestions);
        state.backendAdaptiveSuggestionsSlotKey = slotContext.slotKey;
        state.backendAdaptiveSuggestionsPrefix = normalizedPrefix;
        state.backendAdaptiveSuggestionsLoadedAt = now;
        resolve(state.backendAdaptiveSuggestions);
      });
    } catch (e) {
      state.backendAdaptiveSuggestionsPending = false;
      resolve(state.backendAdaptiveSuggestions || []);
    }
  });
}

function reportBackendSuggestionImpressions(suggestions, timestamp = Date.now()) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return;
  if (!state.reportedAdaptiveSuggestionKeys) {
    state.reportedAdaptiveSuggestionKeys = new Set();
  }

  const slotKey = getWeeklyHabitSlotKey(timestamp);
  for (const suggestion of suggestions) {
    if (!suggestion || suggestion.source !== 'backend') continue;
    const impressionKey = `${slotKey}:${suggestion.query}`;
    if (state.reportedAdaptiveSuggestionKeys.has(impressionKey)) continue;
    state.reportedAdaptiveSuggestionKeys.add(impressionKey);
    void recordAdaptiveSearchEvent('suggestion_shown', suggestion.query, {
      baseQuery: suggestion.baseQuery,
      sequenceNumber: suggestion.predictedWeekNumber,
      timestamp
    });
  }
}

function trackAdaptiveQuerySubmission(rawQuery, normalizedQuery) {
  const cleanRawQuery = String(rawQuery || '').trim();
  const cleanNormalizedQuery = normalizeText(normalizedQuery || cleanRawQuery);
  if (!cleanNormalizedQuery) return;

  const now = Date.now();
  const lastSubmission = state.lastAdaptiveSearchSubmission || { query: '', at: 0 };
  if (lastSubmission.query === cleanNormalizedQuery && (now - lastSubmission.at) < 4000) {
    return;
  }

  state.lastAdaptiveSearchSubmission = { query: cleanNormalizedQuery, at: now };
  void recordAdaptiveSearchEvent('query_submitted', cleanRawQuery, {
    normalizedQuery: cleanNormalizedQuery,
    timestamp: now
  });
}

async function loadClickFeedbackMap() {
  try {
    const data = await chrome.storage.local.get(['searchHabits', 'clickFeedback']);
    state.searchHabits = normalizeSearchHabits(data.searchHabits);
    // Migrate old click feedback local cache
    if (data.clickFeedback && Object.keys(data.clickFeedback).length > 0) {
      state.searchHabits.globalClicks = { ...data.clickFeedback, ...state.searchHabits.globalClicks };
      await chrome.storage.local.remove('clickFeedback');
    }

    // Pull legacy fallback state from backend for existing users.
    chrome.runtime.sendMessage({ type: 'fetchAdaptiveSearchState' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.success && response.state) {
        if (response.state.habits) {
          state.searchHabits = mergeSearchHabits(state.searchHabits, response.state.habits);
        }
        if (response.state.enabled !== undefined && state.extensionSettings) {
          state.extensionSettings.enableAdaptiveLearning = response.state.enabled;
          const toggle = document.getElementById('enable-adaptive-learning');
          if (toggle) toggle.checked = state.extensionSettings.enableAdaptiveLearning;
        }
        chrome.storage.local.set({ searchHabits: state.searchHabits });
        debouncedSyncSearchHabits();
      }
    });

  } catch (e) {
    state.searchHabits = createEmptySearchHabits();
  }
}

function debouncedSyncSearchHabits() {
  if (!chrome?.runtime?.sendMessage || !state.searchHabits) return;

  if (searchHabitsSyncTimer) {
    clearTimeout(searchHabitsSyncTimer);
    searchHabitsSyncTimer = null;
  }

  const snapshot = {
    enabled: state.extensionSettings?.enableAdaptiveLearning !== false,
    habits: normalizeSearchHabits(state.searchHabits),
    updatedAt: Date.now()
  };

  try {
    chrome.runtime.sendMessage({ type: 'syncAdaptiveSearchState', state: snapshot }, (response) => {
      if (chrome.runtime?.lastError) return;
      if (response && response.success === false && response.error !== 'Not signed in') {
        console.warn('[Canvascope Adaptive Search] Failed to sync habit snapshot:', response.error);
      }
    });
  } catch (e) {
    // The backend search_events/search_patterns tables remain authoritative.
  }
}

async function updateSearchHabits(item, query = '') {
  if (!state.extensionSettings?.enableAdaptiveLearning) return;
  const key = getClickKey(item);
  if (!key) return;

  if (!state.searchHabits) state.searchHabits = createEmptySearchHabits();

  // 1. Update Global Clicks
  const globalEntry = state.searchHabits.globalClicks[key] || { openCount: 0, lastOpenedAt: 0 };
  globalEntry.openCount++;
  globalEntry.lastOpenedAt = Date.now();
  state.searchHabits.globalClicks[key] = globalEntry;

  // 2. Update Query Affinity
  const cleanQ = (query || '').toLowerCase().trim();
  if (cleanQ) {
    if (!state.searchHabits.queryAffinity[cleanQ]) state.searchHabits.queryAffinity[cleanQ] = {};
    const currentAffinity = state.searchHabits.queryAffinity[cleanQ][key] || 0;
    state.searchHabits.queryAffinity[cleanQ][key] = currentAffinity + 1;
    recordWeeklyHabitQueryClick(cleanQ, globalEntry.lastOpenedAt);
  }

  // Constrain storage size (keep top 500 queries)
  const queryKeys = Object.keys(state.searchHabits.queryAffinity);
  if (queryKeys.length > 500) {
    const toRemove = queryKeys.slice(0, 100); // Remove oldest
    for (const q of toRemove) delete state.searchHabits.queryAffinity[q];
  }

  try {
    await chrome.storage.local.set({ searchHabits: state.searchHabits });
    debouncedSyncSearchHabits();
  } catch (e) { /* ignore quota errors */ }
}

function getClickKey(item) {
  if (!item || !item.url) return null;
  try {
    const u = new URL(item.url);
    return u.pathname;
  } catch { return null; }
}

function getAdaptiveLearningBoost(item, query = '') {
  if (!state.extensionSettings?.enableAdaptiveLearning || !state.searchHabits) return 0;
  const key = getClickKey(item);
  if (!key) return 0;

  let boost = 0;

  // 1. Query-Specific Affinity (Massive Boost)
  const cleanQ = (query || '').toLowerCase().trim();
  if (cleanQ && state.searchHabits.queryAffinity[cleanQ]) {
    const affinityHits = state.searchHabits.queryAffinity[cleanQ][key] || 0;
    if (affinityHits > 0) {
      // Strong behavioral reinflation (e.g., 1 click = +0.6, 3 clicks = +1.2)
      boost += Math.min(2.0, 0.4 + (affinityHits * 0.3));
    }
  }

  // 2. Global Baseline Recency
  const globalEntry = state.searchHabits.globalClicks[key];
  if (globalEntry) {
    const { openCount, lastOpenedAt } = globalEntry;
    const freqBoost = Math.min(0.20, Math.log2(1 + openCount) * 0.05);
    const daysSinceOpen = (Date.now() - lastOpenedAt) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 0.15 - daysSinceOpen * (0.15 / 14));
    boost += Math.min(0.35, freqBoost + recencyBoost);
  }

  return boost;
}

// ============================================
// ACTIVE COURSE CONTEXT
// ============================================

let activeCourseContext = null; // { courseId, courseName }
let starredCourseIds = new Set(); // course IDs from the user's Dashboard (favorited courses)

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

/**
 * Boost items from starred (favorited) courses.
 * If the user has no starred courses, returns 0 (no effect).
 */
function getStarredCourseBoost(item) {
  if (starredCourseIds.size === 0) return 0;
  if (!item.courseId) return 0;
  const cid = String(item.courseId);
  if (starredCourseIds.has(cid)) return 0.20;
  return -0.08; // mild penalty for non-starred courses
}

// ============================================
// DUE PLANNER HELPERS
// ============================================

const TASK_TYPES = new Set(['assignment', 'quiz', 'discussion']);

function isTaskType(item) {
  return TASK_TYPES.has((item.type || '').toLowerCase());
}

function hasConcreteTaskSubmissionEvidence(summary) {
  if (!summary || typeof summary !== 'object') return false;
  if (summary.missing === true) return false;
  if (summary.excused === true) return true;

  const hasAttempt = Number(summary.attempt ?? 0) > 0;
  const hasGrade = summary.score !== null && summary.score !== undefined
    || (typeof summary.grade === 'string' && summary.grade.trim() !== '');
  const hasSubmittedAt = typeof summary.submittedAt === 'string' && summary.submittedAt.trim() !== '';
  const hasSubmissionType = typeof summary.submissionType === 'string' && summary.submissionType.trim() !== '';
  const workflowState = String(summary.workflowState || '').trim().toLowerCase();

  if (hasSubmittedAt || hasAttempt || hasGrade || hasSubmissionType) return true;
  if (summary.late === true) return true;

  return ['submitted', 'graded', 'complete'].includes(workflowState);
}

function isCompletedTask(item) {
  if (!isTaskType(item)) return false;

  if (item?.submission && typeof item.submission === 'object') {
    return hasConcreteTaskSubmissionEvidence(item.submission);
  }

  if (item?.submitted === true) {
    const submissionStatus = String(item?.submissionStatus || '').trim().toLowerCase();
    return ['submitted', 'late', 'excused'].includes(submissionStatus);
  }

  return false;
}

function parseDueTs(item) {
  if (!item.dueAt) return 0;
  const ts = new Date(item.dueAt).getTime();
  return isNaN(ts) ? 0 : ts;
}

/**
 * Classify a task item's submission state for badge display.
 * Returns one of: 'graded' | 'submitted' | 'missing' | 'overdue' | 'upcoming' | null
 *  - 'graded'   → workflow is graded and has a score
 *  - 'submitted' → submission accepted but not yet graded
 *  - 'missing'  → server flagged missing
 *  - 'overdue'  → past due, no submission evidence
 *  - 'upcoming' → due within 48h, no submission yet
 *  - null       → non-task, or no actionable signal to show
 */
function getSubmissionBadgeState(item, now = Date.now()) {
  if (!item || !isTaskType(item)) return null;
  const sub = item.submission;
  if (sub && typeof sub === 'object') {
    if (sub.missing === true) return 'missing';
    const workflow = String(sub.workflowState || '').trim().toLowerCase();
    const hasScore = sub.score !== null && sub.score !== undefined
      || (typeof sub.grade === 'string' && sub.grade.trim() !== '');
    if (workflow === 'graded' && hasScore) return 'graded';
    if (hasConcreteTaskSubmissionEvidence(sub)) return 'submitted';
  }
  // Fall through: no submission object or it's empty.
  const dueTs = parseDueTs(item);
  if (!dueTs) return null;
  if (dueTs < now) return 'overdue';
  if (dueTs - now < 48 * 60 * 60 * 1000) return 'upcoming';
  return null;
}

function formatBadgeScore(submission) {
  if (!submission || typeof submission !== 'object') return null;
  const grade = typeof submission.grade === 'string' ? submission.grade.trim() : '';
  const score = submission.score;
  if (grade && grade !== '0' && /^[A-Za-z+\-]/.test(grade)) return grade; // letter grade
  if (typeof score === 'number' && Number.isFinite(score)) {
    return Number.isInteger(score) ? String(score) : score.toFixed(1);
  }
  if (grade) return grade;
  return null;
}

/**
 * Look up open count for an item from searchHabits.globalClicks.
 * Returns 0 when the user has not opened it (or learning is off).
 */
function getItemOpenCount(item) {
  if (!state.extensionSettings?.enableAdaptiveLearning) return 0;
  if (!state.searchHabits?.globalClicks) return 0;
  return getItemOpenCountFromMap(item, state.searchHabits.globalClicks);
}

function getItemOpenCountFromMap(item, globalClicks) {
  if (!globalClicks) return 0;
  const key = getClickKey(item);
  if (!key) return 0;
  const entry = globalClicks[key];
  return Number(entry?.openCount || 0);
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
  const completed = [];

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const endLookahead = endOfDay.getTime() + (lookaheadDays - 1) * 24 * 60 * 60 * 1000;

  for (const item of items) {
    if (!isTaskType(item)) continue;

    // Respect active course filter
    if (!itemMatchesSelectedCourses(item)) continue;

    // Skip tasks dismissed by the user
    if (state.dismissedTasks.includes(getCanonicalId(item))) continue;

    if (isCompletedTask(item)) {
      completed.push(item);
      continue;
    }

    const dueTs = parseDueTs(item);
    if (dueTs === 0) {
      undated.push(item);
    } else if (dueTs < startOfDay.getTime()) {
      if (dueTs >= startOfDay.getTime() - 30 * 24 * 60 * 60 * 1000) {
        overdue.push(item);
      }
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
  completed.sort((a, b) => {
    const aTs = parseDueTs(a);
    const bTs = parseDueTs(b);
    if (aTs !== bTs) return bTs - aTs;
    return (a.title || '').localeCompare(b.title || '');
  });

  return { overdue, today, next7Days, undated, completed };
}

function formatDueLabel(item) {
  if (isCompletedTask(item)) return 'Completed';
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
  if (isCompletedTask(item)) return 'completed';
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

function buildItemAriaLabel(item, { includeOpenedAt = false } = {}) {
  const parts = [];
  const title = item?.title || 'Untitled';
  parts.push(title);
  if (item?.type) parts.push(formatTypeName(item.type));
  if (item?.courseName) parts.push(item.courseName);
  if (item?.folderPath && (item.type === 'folder' || LEAF_FILE_TYPES.has(String(item.type || '').toLowerCase()))) {
    parts.push(item.folderPath);
  }
  if (item?.dueAt && isTaskType(item)) parts.push(formatDueLabel(item));
  if (includeOpenedAt && item?.openedAt) parts.push(`Opened ${formatRelativeTime(item.openedAt)}`);
  return parts.join(', ');
}

function formatRelativeTime(timestamp) {
  const elapsedMs = Date.now() - Number(timestamp || 0);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 'just now';

  const minutes = Math.round(elapsedMs / (1000 * 60));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderHomeSections() {
  if (!elements.homeSections || state.isOverlayMode) return false;

  const query = elements.searchInput?.value.trim() || '';
  if (query.length > 0) {
    elements.homeSections.classList.add('hidden');
    return false;
  }

  const primaryRecent = state.recentlyOpened[0];
  const additionalRecents = state.recentlyOpened.slice(1, MAX_RECENTS);
  const hasHomeContent = Boolean(primaryRecent || additionalRecents.length > 0);

  elements.continueSection.innerHTML = '';
  elements.recentlyOpenedSection.innerHTML = '';

  if (primaryRecent) {
    const title = document.createElement('div');
    title.className = 'home-section-title';
    title.textContent = 'Continue where you left off';
    elements.continueSection.appendChild(title);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'continue-card';
    button.setAttribute('aria-label', buildItemAriaLabel(primaryRecent, { includeOpenedAt: true }));

    const copy = document.createElement('div');
    copy.className = 'continue-card-copy';
    copy.innerHTML = `
      <span class="continue-card-kicker">Resume</span>
      <div class="continue-card-title"></div>
      <div class="continue-card-meta"></div>
    `;
    copy.querySelector('.continue-card-title').textContent = primaryRecent.title || 'Untitled';
    copy.querySelector('.continue-card-meta').textContent = [
      primaryRecent.courseName || 'Recent item',
      formatRelativeTime(primaryRecent.openedAt)
    ].filter(Boolean).join(' • ');

    const badge = document.createElement('span');
    badge.className = 'continue-card-badge';
    badge.textContent = formatTypeName(primaryRecent.type || 'link');

    button.appendChild(copy);
    button.appendChild(badge);
    button.addEventListener('click', (event) => openResult(primaryRecent, event));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openResult(primaryRecent, event);
      }
    });

    elements.continueSection.appendChild(button);
    elements.continueSection.classList.remove('hidden');
  } else {
    elements.continueSection.classList.add('hidden');
  }

  if (additionalRecents.length > 0) {
    const title = document.createElement('div');
    title.className = 'home-section-title';
    title.textContent = 'Recently opened';
    elements.recentlyOpenedSection.appendChild(title);

    const list = document.createElement('div');
    list.className = 'recent-list';

    additionalRecents.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent-item-card';
      button.setAttribute('aria-label', buildItemAriaLabel(item, { includeOpenedAt: true }));

      const copy = document.createElement('div');
      copy.className = 'recent-item-copy';

      const itemTitle = document.createElement('div');
      itemTitle.className = 'recent-item-title';
      itemTitle.textContent = item.title || 'Untitled';
      copy.appendChild(itemTitle);

      const meta = document.createElement('div');
      meta.className = 'recent-item-meta';
      meta.textContent = [
        item.courseName || 'Recent item',
        formatRelativeTime(item.openedAt)
      ].filter(Boolean).join(' • ');
      copy.appendChild(meta);

      const type = document.createElement('span');
      type.className = 'recent-item-type';
      type.textContent = formatTypeName(item.type || 'link');

      button.appendChild(copy);
      button.appendChild(type);
      button.addEventListener('click', (event) => openResult(item, event));
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openResult(item, event);
        }
      });
      list.appendChild(button);
    });

    elements.recentlyOpenedSection.appendChild(list);
    elements.recentlyOpenedSection.classList.remove('hidden');
  } else {
    elements.recentlyOpenedSection.classList.add('hidden');
  }

  elements.homeSections.classList.toggle('hidden', !hasHomeContent);
  return hasHomeContent;
}

function renderDuePlanner() {
  const planner = elements.duePlanner;
  if (!planner || state.isOverlayMode) return;

  const buckets = bucketTasks(state.indexedContent, Date.now());
  const total = buckets.overdue.length + buckets.today.length + buckets.next7Days.length + buckets.undated.length + buckets.completed.length;

  planner.innerHTML = '';

  if (total === 0) {
    planner.innerHTML = '<div class="due-planner-empty">No upcoming tasks found</div>';
    return;
  }

  const sections = [
    { key: 'overdue', label: '⚠ Overdue', items: buckets.overdue, cls: 'overdue' },
    { key: 'today', label: '📅 Due Today', items: buckets.today, cls: 'today' },
    { key: 'next7Days', label: '📋 Next 7 Days', items: buckets.next7Days, cls: 'upcoming' },
    { key: 'undated', label: '❓ No Due Date', items: buckets.undated, cls: 'undated' },
    { key: 'completed', label: '✓ Completed', items: buckets.completed, cls: 'completed' }
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
      row.setAttribute('tabindex', '0');
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', buildItemAriaLabel(item));

      const left = document.createElement('div');
      left.className = 'due-item-left';

      const title = document.createElement('div');
      title.className = 'due-item-title';
      title.textContent = item.title || 'Untitled';
      left.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'due-item-meta';

      if (item.courseName) {
        const course = document.createElement('span');
        const dot = document.createElement('span');
        dot.className = 'cs-course-dot';
        dot.style.background = csCourseColor(item.courseName);
        course.appendChild(dot);
        course.appendChild(document.createTextNode(csShortCourse(item.courseName)));
        meta.appendChild(course);
      }

      const typeBadge = document.createElement('span');
      typeBadge.className = 'result-type';
      typeBadge.textContent = item.type || 'task';
      meta.appendChild(typeBadge);
      left.appendChild(meta);

      const right = document.createElement('div');
      right.className = 'due-item-right';

      const chip = document.createElement('span');
      chip.className = `due-chip ${dueUrgencyClass(item)}`;
      chip.textContent = formatDueLabel(item);
      right.appendChild(chip);

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'dismiss-task-btn';
      dismissBtn.type = 'button';
      dismissBtn.innerHTML = '&times;';
      dismissBtn.title = "Dismiss task";
      dismissBtn.setAttribute('aria-label', `Dismiss ${item.title || 'task'}`);
      dismissBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); // prevent opening result

        const id = getCanonicalId(item);
        if (!state.dismissedTasks.includes(id)) {
          state.dismissedTasks.push(id);
          await chrome.storage.local.set({ dismissedTasks: state.dismissedTasks });
          renderDuePlanner(); // re-render UI live
        }
      });
      right.appendChild(dismissBtn);

      row.appendChild(left);
      row.appendChild(right);

      row.addEventListener('click', (e) => openResult(item, e));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openResult(item, e);
        }
      });
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
  phys: 'physics',
  bio: 'biology',
  biol: 'biology',
  chem: 'chemistry',
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

function getSearchDebounceMs() {
  return state.isOverlayMode ? OVERLAY_SEARCH_DEBOUNCE_MS : SEARCH_DEBOUNCE_MS;
}

function buildBoundaryMatcher(token) {
  if (!token) return null;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

function buildTokenMatcherMap(tokens) {
  const matchers = new Map();
  for (const token of tokens || []) {
    if (!token || matchers.has(token)) continue;
    const matcher = buildBoundaryMatcher(token);
    if (matcher) matchers.set(token, matcher);
  }
  return matchers;
}

function textIncludesQueryToken(searchableText, token, tokenMatchers = new Map()) {
  if (!searchableText || !token) return false;
  if (token.length === 1 || /^\d+$/.test(token)) {
    return Boolean(tokenMatchers.get(token)?.test(searchableText));
  }
  return searchableText.includes(token);
}

function countMatchedQueryTokens(searchableText, tokens, tokenMatchers = new Map()) {
  if (!Array.isArray(tokens) || tokens.length === 0 || !searchableText) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (textIncludesQueryToken(searchableText, token, tokenMatchers)) {
      hits++;
    }
  }
  return hits;
}

function countBoundaryMatches(searchableText, tokens, tokenMatchers = new Map()) {
  if (!Array.isArray(tokens) || tokens.length === 0 || !searchableText) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (tokenMatchers.get(token)?.test(searchableText)) {
      hits++;
    }
  }
  return hits;
}

function hasSpecificRecallSignal(tokens) {
  return (tokens || []).some(token => !GENERIC_RECALL_TOKENS.has(token));
}

function isKeyLikeContentText(text) {
  return KEY_LIKE_CONTENT_RE.test(String(text || ''));
}

function stripKeyLikeContentText(text) {
  return normalizeText(String(text || '').replace(KEY_LIKE_CONTENT_STRIP_RE, ' '));
}

function wantsKeyLikeQuery(text) {
  return isKeyLikeContentText(text);
}

function buildKeyLikeQueryVariants(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const variants = new Set();
  const replacements = [
    [/\banswer\s+keys?\b/g, 'key'],
    [/\bworked\s+solutions?\b/g, 'solution'],
    [/\bsolutions\b/g, 'solution']
  ];

  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(normalized)) continue;
    variants.add(normalizeText(normalized.replace(pattern, replacement)));
    pattern.lastIndex = 0;
  }

  return Array.from(variants).filter(Boolean);
}

function splitPathSegments(item) {
  if (Array.isArray(item?.pathSegments) && item.pathSegments.length > 0) {
    return item.pathSegments
      .map(segment => String(segment || '').trim())
      .filter(Boolean);
  }

  return String(item?.folderPath || '')
    .split(/\s*>\s*/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function buildPathWindows(segments) {
  const windows = [];
  for (let size = 2; size <= Math.min(3, segments.length); size++) {
    for (let start = 0; start <= segments.length - size; start++) {
      windows.push(segments.slice(start, start + size).join(' '));
    }
  }
  return windows;
}

function addAliasWithVariants(aliases, text) {
  const normalized = normalizeText(text);
  if (!normalized) return;

  aliases.add(numberVariants(normalized));

  const singularized = normalized
    .replace(/\bdiscussions\b/g, 'discussion')
    .replace(/\bfolders\b/g, 'folder')
    .replace(/\bfiles\b/g, 'file');

  if (singularized !== normalized) {
    aliases.add(numberVariants(singularized));
  }
}

function extractWeekHintsFromValue(value) {
  const hints = new Set();
  const text = String(value || '');
  if (!text) return [];

  const regex = /\bweek\s*#?\s*0*(\d{1,3})\b/ig;
  let match = regex.exec(text);
  while (match) {
    const normalized = String(match[1] || '').replace(/^0+/, '') || '0';
    hints.add(normalized);
    match = regex.exec(text);
  }

  return Array.from(hints);
}

function getItemWeekHints(item) {
  if (Array.isArray(item?.weekHints) && item.weekHints.length > 0) {
    return item.weekHints
      .map(value => String(value || '').replace(/^0+/, '') || '0')
      .filter(Boolean);
  }

  return extractWeekHintsFromValue([
    item?.title || '',
    item?.folderPath || '',
    item?.moduleName || ''
  ].join(' '));
}

function buildBreadcrumbAliases(item) {
  const segments = splitPathSegments(item);
  const aliases = new Set();
  const normalizedSegments = segments
    .map(segment => expandAbbreviations(segment))
    .map(segment => normalizeText(segment))
    .filter(Boolean);

  if (normalizedSegments.length > 0) {
    const fullPath = normalizedSegments.join(' ');
    addAliasWithVariants(aliases, fullPath);
    for (const segment of normalizedSegments) {
      addAliasWithVariants(aliases, segment);
    }
    for (const windowText of buildPathWindows(normalizedSegments)) {
      addAliasWithVariants(aliases, windowText);
    }
  }

  const weekHints = getItemWeekHints(item);
  for (const week of weekHints) {
    aliases.add(`week ${week}`);
    aliases.add(`week${week}`);
  }

  if (item?.type === 'syllabus') {
    aliases.add('syllabus');
    aliases.add('course syllabus');
    aliases.add('course outline');
  }

  const excerpt = normalizeText(String(item?.syllabusExcerpt || '').slice(0, 240));
  if (excerpt) {
    aliases.add(excerpt);
  }

  return {
    aliases: Array.from(aliases).filter(Boolean),
    searchPathNormalized: normalizedSegments.join(' ')
  };
}

/**
 * Build searchable fields for an item
 */
function buildSearchFields(item) {
  const normalized = expandAbbreviations(item.title || '');
  const aliases = new Set([numberVariants(normalized)]);
  const normalizedCourse = expandAbbreviations(item.courseName || '');
  const pathInfo = buildBreadcrumbAliases(item);

  for (const alias of pathInfo.aliases) {
    aliases.add(alias);
  }

  if (item.folderPath) {
    aliases.add(normalizeText(item.folderPath));
  }
  if (item.moduleName && item.moduleName !== 'Files') {
    aliases.add(normalizeText(item.moduleName));
  }
  if (item.type === 'folder' && item.containerUrl) {
    aliases.add('folder');
  }

  const aliasText = Array.from(aliases).filter(Boolean).join(' ');

  return {
    searchTitleNormalized: normalized,
    searchAliases: aliasText,
    searchPathNormalized: pathInfo.searchPathNormalized,
    searchCourseNormalized: normalizedCourse,
    searchRuntime: buildItemSearchRuntime(item, {
      searchTitleNormalized: normalized,
      searchAliases: aliasText,
      searchPathNormalized: pathInfo.searchPathNormalized,
      searchCourseNormalized: normalizedCourse
    })
  };
}

function buildItemSearchRuntime(item, fields = {}) {
  const titleText = String(fields.searchTitleNormalized || expandAbbreviations(item?.title || '')).toLowerCase();
  const courseText = String(fields.searchCourseNormalized || expandAbbreviations(item?.courseName || '')).toLowerCase();
  const pathText = normalizeText([
    fields.searchPathNormalized || '',
    item?.folderPath || ''
  ].join(' '));
  const moduleText = normalizeText(item?.moduleName || '');
  const aliasText = normalizeText(fields.searchAliases || '');
  const contextText = normalizeText([
    fields.searchPathNormalized || item?.folderPath || '',
    item?.moduleName || '',
    item?.courseName || ''
  ].join(' '));
  const searchableText = [
    titleText,
    courseText,
    pathText,
    moduleText,
    aliasText
  ].filter(Boolean).join(' ');
  const comparableTitle = stripKeyLikeContentText(titleText);
  const keyLike = isKeyLikeContentText([
    titleText,
    pathText,
    moduleText,
    aliasText
  ].join(' '));

  return {
    titleText,
    courseText,
    pathText,
    moduleText,
    aliasText,
    contextText,
    searchableText,
    pathSearchText: getPathSearchText(item),
    titleNums: new Set(extractNumericTokens(titleText)),
    weekHints: getItemWeekHints(item),
    keyLike,
    comparableTitle
  };
}

function getItemSearchRuntime(item) {
  if (!item || typeof item !== 'object') {
    return {
      titleText: '',
      courseText: '',
      pathText: '',
      moduleText: '',
      aliasText: '',
      contextText: '',
      searchableText: '',
      pathSearchText: '',
      titleNums: new Set(),
      weekHints: [],
      keyLike: false,
      comparableTitle: ''
    };
  }

  if (item.searchRuntime) {
    return item.searchRuntime;
  }

  item.searchRuntime = buildItemSearchRuntime(item, {
    searchTitleNormalized: item.searchTitleNormalized || expandAbbreviations(item.title || ''),
    searchAliases: item.searchAliases || '',
    searchPathNormalized: item.searchPathNormalized || normalizeText(item.folderPath || ''),
    searchCourseNormalized: item.searchCourseNormalized || expandAbbreviations(item.courseName || '')
  });

  return item.searchRuntime;
}

function getSearchTokenVocabulary() {
  const content = state.indexedContent || [];
  if (state._searchVocabularyCache && state._searchVocabularyCacheVersion === content.length) {
    return state._searchVocabularyCache;
  }

  const tokenFreq = new Map();
  const addTokens = (text) => {
    const tokens = normalizeText(text).split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (token.length < 3) continue;
      if (/^\d+$/.test(token)) continue;
      tokenFreq.set(token, (tokenFreq.get(token) || 0) + 1);
    }
  };

  for (const item of content) {
    addTokens(item.searchTitleNormalized || expandAbbreviations(item.title || ''));
    addTokens(item.searchPathNormalized || normalizeText(item.folderPath || ''));
    addTokens(item.searchCourseNormalized || expandAbbreviations(item.courseName || ''));
    addTokens(item.searchAliases || '');
    addTokens(item.folderPath || '');
    addTokens(item.moduleName || '');
  }

  const byInitial = new Map();
  for (const token of tokenFreq.keys()) {
    const initial = token[0];
    if (!byInitial.has(initial)) byInitial.set(initial, []);
    byInitial.get(initial).push(token);
  }

  const cache = { tokenFreq, byInitial };
  state._searchVocabularyCache = cache;
  state._searchVocabularyCacheVersion = content.length;
  return cache;
}

function commonPrefixLength(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const limit = Math.min(left.length, right.length);
  let idx = 0;
  while (idx < limit && left[idx] === right[idx]) idx++;
  return idx;
}

function getTypoDistanceLimit(token) {
  const len = String(token || '').length;
  if (len >= 10) return 3;
  if (len >= 6) return 2;
  if (len >= 4) return 1;
  return 0;
}

function isBetterCorrectionCandidate(candidate, incumbent) {
  if (!incumbent) return true;
  if (candidate.dist !== incumbent.dist) return candidate.dist < incumbent.dist;
  if (candidate.prefixLen !== incumbent.prefixLen) return candidate.prefixLen > incumbent.prefixLen;
  if (candidate.freq !== incumbent.freq) return candidate.freq > incumbent.freq;
  if (candidate.lengthDiff !== incumbent.lengthDiff) return candidate.lengthDiff < incumbent.lengthDiff;
  return candidate.token < incumbent.token;
}

function findClosestIndexedToken(token) {
  const normalizedToken = normalizeText(token);
  if (!normalizedToken || STOP_TOKENS.has(normalizedToken) || /^\d+$/.test(normalizedToken)) return null;

  const { tokenFreq, byInitial } = getSearchTokenVocabulary();
  if (tokenFreq.has(normalizedToken)) return normalizedToken;

  const maxDist = getTypoDistanceLimit(normalizedToken);
  if (maxDist === 0) return null;

  const candidates = byInitial.get(normalizedToken[0]) || [];
  const suffix = normalizedToken.slice(-2);
  let best = null;
  let second = null;

  for (const candidateToken of candidates) {
    const lengthDiff = Math.abs(candidateToken.length - normalizedToken.length);
    if (lengthDiff > maxDist) continue;

    const prefixLen = commonPrefixLength(normalizedToken, candidateToken);
    const suffixMatches = suffix.length === 2 && candidateToken.endsWith(suffix);
    if (prefixLen < 2 && !suffixMatches) continue;

    const dist = levenshteinDistance(normalizedToken, candidateToken);
    if (dist === 0 || dist > maxDist) continue;

    const candidate = {
      token: candidateToken,
      dist,
      prefixLen,
      freq: tokenFreq.get(candidateToken) || 0,
      lengthDiff
    };

    if (isBetterCorrectionCandidate(candidate, best)) {
      second = best;
      best = candidate;
    } else if (isBetterCorrectionCandidate(candidate, second)) {
      second = candidate;
    }
  }

  if (!best) return null;
  if (best.dist >= 2 && best.prefixLen < 3) return null;
  if (second && second.dist === best.dist && second.prefixLen === best.prefixLen && Math.abs(second.freq - best.freq) <= 1) {
    return null;
  }

  return best.token;
}

function buildTypoTolerantQuery(normalizedQuery) {
  const baseQuery = normalizeText(normalizedQuery || '');
  const tokens = baseQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { correctedQuery: baseQuery, corrections: [] };
  }

  const corrections = [];
  const correctedTokens = tokens.map(token => {
    const corrected = findClosestIndexedToken(token);
    if (corrected && corrected !== token) {
      corrections.push({ from: token, to: corrected });
      return corrected;
    }
    return token;
  });

  return {
    correctedQuery: correctedTokens.join(' ').trim(),
    corrections
  };
}

/**
 * Build a set of subject keywords found across all indexed course names.
 * Cached on state._subjectKeywordsCache and invalidated when content changes.
 *
 * Returns a Map<keyword, Set<normalizedCourseName>> so we can look up which
 * courses a keyword belongs to.
 */
function getSubjectKeywordIndex() {
  const content = state.indexedContent || [];
  if (state._subjectKeywordsCache && state._subjectKeywordsCacheVersion === content.length) {
    return state._subjectKeywordsCache;
  }

  // Minimum token length to avoid matching noise like "a", "to", "of"
  const MIN_TOKEN_LEN = 3;
  // Common stop words that appear in course names but aren't subject identifiers
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'intro', 'introduction',
    'topics', 'special', 'section', 'fall', 'winter', 'spring', 'summer',
    'quarter', 'semester', 'online', 'lecture', 'discussion', 'lab', 'laboratory'
  ]);

  const index = new Map();
  const seen = new Set();

  for (const item of content) {
    if (!item.courseName) continue;
    const courseKey = normalizeText(item.courseName);
    if (seen.has(courseKey)) continue;
    seen.add(courseKey);

    // Expand abbreviations so "phys" in a course name becomes "physics", etc.
    const expanded = expandAbbreviations(item.courseName);
    const tokens = expanded.split(/\s+/).filter(Boolean);

    for (const token of tokens) {
      if (token.length < MIN_TOKEN_LEN) continue;
      if (STOP_WORDS.has(token)) continue;
      // Skip pure numbers (course numbers like "101")
      if (/^\d+$/.test(token)) continue;

      if (!index.has(token)) {
        index.set(token, new Set());
      }
      index.get(token).add(courseKey);
    }
  }

  state._subjectKeywordsCache = index;
  state._subjectKeywordsCacheVersion = content.length;
  return index;
}

/**
 * Detect course hint signals from query tokens by matching against actual
 * course names in the user's data. Returns an object with:
 *   matchedCourseKeys: Set<normalizedCourseName> — courses that matched
 *   hasHint: boolean — whether any course hint was detected
 */
function getCourseHintSignals(normalizedQuery) {
  const q = normalizeText(normalizedQuery || '');
  const qTokens = q.split(/\s+/).filter(Boolean);
  if (qTokens.length === 0) return { matchedCourseKeys: new Set(), hasHint: false };

  const subjectIndex = getSubjectKeywordIndex();
  const matchedCourseKeys = new Set();

  for (const token of qTokens) {
    // Also try the expanded form (e.g., user types "bio" → check "biology")
    const expanded = expandAbbreviations(token);
    const variants = expanded !== token ? [token, ...expanded.split(/\s+/)] : [token];

    for (const variant of variants) {
      const courses = subjectIndex.get(variant);
      if (courses && courses.size > 0) {
        // Only count as a hint if the keyword isn't in every single course
        // (otherwise it's a generic word, not a subject differentiator)
        if (courses.size < (state._subjectKeywordsCacheVersion || Infinity) * 0.5) {
          for (const c of courses) matchedCourseKeys.add(c);
        }
      }
    }
  }

  return { matchedCourseKeys, hasHint: matchedCourseKeys.size > 0 };
}

function itemMatchesCourseHints(item, hintSignals) {
  if (!hintSignals.hasHint) return false;
  const itemCourse = normalizeText(item?.courseName || '');
  if (!itemCourse) return false;
  return hintSignals.matchedCourseKeys.has(itemCourse);
}

function itemMatchesCourseScope(item, courseScope) {
  if (!courseScope?.coursePrefix) return false;
  const itemCourse = normalizeText(item?.courseName || '');
  if (!itemCourse) return false;
  return new RegExp(`^${courseScope.coursePrefix}(\\s|$)`).test(itemCourse);
}

function itemMatchesCourseContext(item, courseScope, courseHintSignals) {
  if (courseScope) return itemMatchesCourseScope(item, courseScope);
  if (courseHintSignals?.hasHint) return itemMatchesCourseHints(item, courseHintSignals);
  return true;
}

function isLabLikeQuery(normalizedQuery) {
  const q = String(normalizedQuery || '').toLowerCase();
  return q.includes('lab') || q.includes('laboratory');
}

function isLabContextItem(item) {
  const raw = `${item?.title || ''} ${item?.folderPath || ''} ${item?.moduleName || ''}`;
  const normalized = `${item?.searchTitleNormalized || normalizeText(item?.title || '')} ${normalizeText(item?.folderPath || '')} ${normalizeText(item?.moduleName || '')}`.toLowerCase();
  return /(?:pre[\s-]*lab|prelab|lab(?:oratory)?)(?:\s*#?\s*\d+)?/i.test(raw) || normalized.includes('laboratory');
}

function collectPatternNumbers(text, regexFactory) {
  const value = String(text || '');
  if (!value) return [];

  const numbers = [];
  const regex = regexFactory();
  let match = regex.exec(value);
  while (match) {
    const num = String(match[1] || '').replace(/^0+/, '') || '0';
    numbers.push(num);
    match = regex.exec(value);
  }
  return numbers;
}

function extractLabSequenceNumbers(item) {
  const texts = [item?.title, item?.folderPath, item?.moduleName];
  const direct = new Set();

  // Boundary character class: characters that act as word boundaries in titles.
  // Includes colon so "Lab 1: Airbags" works, and common delimiters.
  const B = '[\\s_|/.:;,#=-]';

  const directPatterns = [
    // "Lab 5", "Lab 9A", "Lab 9A.1", "prelab5", "1BLprelab5", "Lab #05", "Lab 1: Airbags", etc.
    () => new RegExp(`(?:^|${B})(?:[a-z0-9]{0,8})?(?:pre[\\s-]*lab|prelab|lab(?:oratory)?)\\s*#?\\s*0*(\\d{1,3})(?:[a-z](?:\\.\\d+)?)?(?=$|${B})`, 'ig'),
    // Reverse: "5 Lab", "#5 lab" — number before the lab keyword
    () => new RegExp(`(?:^|${B})#?0*(\\d{1,3})\\s*(?:pre[\\s-]*lab|prelab|lab(?:oratory)?)(?=$|${B})`, 'ig')
  ];

  for (const text of texts) {
    for (const pattern of directPatterns) {
      for (const n of collectPatternNumbers(text, pattern)) direct.add(n);
    }
  }

  if (direct.size > 0) {
    return Array.from(direct);
  }

  // Fallback 1: "week N" pattern (e.g., "Week 5 Pre-Lab Questions")
  const weekFallback = new Set();
  for (const text of texts) {
    for (const n of collectPatternNumbers(text, () => new RegExp(`(?:^|${B})week\\s*#?\\s*0*(\\d{1,3})(?=$|${B})`, 'ig'))) {
      weekFallback.add(n);
    }
  }
  if (weekFallback.size > 0) return Array.from(weekFallback);

  // Fallback 2: If the item is a lab-context item (confirmed by caller) but
  // the number is detached from the lab keyword, extract any standalone number
  // from the TITLE ONLY (not module/folder which can contain noisy numbers).
  // Only use this if the title contains exactly one distinct number to avoid
  // ambiguity (e.g., "Experiment 5 Report" in a lab course).
  // Skip numbers that look like times (e.g., "7-9pm", "7:30") or dates.
  if (isLabContextItem(item)) {
    const titleOnly = item?.title || '';
    if (titleOnly) {
      // Strip time-like patterns (e.g., "7-9pm", "7:30am", "12:00") before extracting
      const cleaned = titleOnly.replace(/\d{1,2}[\s]*[-–:]\s*\d{1,2}\s*(?:am|pm|AM|PM)?/g, '')
                                .replace(/\d{1,2}\s*(?:am|pm|AM|PM)/g, '');
      const standaloneNumbers = new Set();
      for (const n of collectPatternNumbers(cleaned, () => new RegExp(`(?:^|${B})#?0*(\\d{1,3})(?=$|${B})`, 'ig'))) {
        standaloneNumbers.add(n);
      }
      if (standaloneNumbers.size === 1) {
        return Array.from(standaloneNumbers);
      }
    }
  }

  return [];
}

function expandTemporalLabSiblings(results, normalizedQuery, courseScope) {
  if (!Array.isArray(results) || results.length === 0) return results;
  if (!isLabLikeQuery(normalizedQuery)) return results;

  const hintSignals = getCourseHintSignals(normalizedQuery);
  if (!courseScope && !hintSignals.hasHint) return results;

  const anchorCourseNumbers = new Map();
  for (const result of results) {
    const item = result?.item;
    if (!item) continue;

    const matchesScopedCourse = courseScope ? itemMatchesCourseScope(item, courseScope) : itemMatchesCourseHints(item, hintSignals);
    if (!matchesScopedCourse) continue;

    const sequenceNumbers = extractLabSequenceNumbers(item);
    if (sequenceNumbers.length === 0) continue;

    const courseKey = normalizeText(item.courseName || '');
    if (!courseKey) continue;

    if (!anchorCourseNumbers.has(courseKey)) {
      anchorCourseNumbers.set(courseKey, new Set());
    }
    const bucket = anchorCourseNumbers.get(courseKey);
    for (const n of sequenceNumbers) bucket.add(n);
  }

  if (anchorCourseNumbers.size === 0) return results;

  const expanded = [...results];
  const seenUrls = new Set(results.map(r => r.item?.url).filter(Boolean));

  for (const item of state.filteredContent) {
    if (!item?.url || seenUrls.has(item.url)) continue;

    const courseKey = normalizeText(item.courseName || '');
    const targetNumbers = anchorCourseNumbers.get(courseKey);
    if (!targetNumbers || targetNumbers.size === 0) continue;
    if (!isLabContextItem(item)) continue;

    const itemNumbers = extractLabSequenceNumbers(item);
    if (itemNumbers.length === 0) continue;

    const overlapsAnchor = itemNumbers.some(n => targetNumbers.has(n));
    if (!overlapsAnchor) continue;

    expanded.push({ item, score: 0.18, prePass: false, temporalLabExpansion: true });
    seenUrls.add(item.url);
  }

  return expanded;
}

function getLabSequenceGroupKey(item) {
  const courseKey = normalizeText(item?.courseName || '');
  const sequenceNumbers = extractLabSequenceNumbers(item)
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));

  if (!courseKey || sequenceNumbers.length === 0) return '';
  return `${courseKey}::${sequenceNumbers.join('|')}`;
}

const IMPLICIT_CURRENT_WEEK_TASK_TOKENS = new Set([
  'lab',
  'laboratory',
  'prelab',
  'quiz',
  'assignment',
  'homework',
  'discussion'
]);
const IMPLICIT_CURRENT_WEEK_EXCLUDED_SUBJECT_TOKENS = new Set([
  'latest',
  'newest',
  'recent',
  'current',
  'today',
  'yesterday',
  'week',
  'last',
  'module',
  'page',
  'file',
  'folder'
]);

function getImplicitCurrentWeekTaskFamily(token) {
  if (token === 'lab' || token === 'laboratory' || token === 'prelab') return 'lab';
  if (token === 'quiz') return 'quiz';
  if (token === 'discussion') return 'discussion';
  if (token === 'assignment' || token === 'homework') return 'assignment';
  return null;
}

function tokenMatchesCourseHint(token, hintSignals) {
  if (!hintSignals?.hasHint || !token) return false;

  const subjectIndex = getSubjectKeywordIndex();
  const expanded = expandAbbreviations(token);
  const variants = expanded !== token ? [token, ...expanded.split(/\s+/)] : [token];

  for (const variant of variants) {
    const matchingCourses = subjectIndex.get(variant);
    if (!matchingCourses || matchingCourses.size === 0) continue;
    for (const courseKey of hintSignals.matchedCourseKeys) {
      if (matchingCourses.has(courseKey)) return true;
    }
  }

  return false;
}

function detectImplicitCurrentWeekMode(normalizedQuery, queryNums, courseScope, courseHintSignals, temporalKind) {
  if (temporalKind || (queryNums && queryNums.length > 0)) {
    return { enabled: false, taskFamily: null, tokens: [] };
  }

  const tokens = getMeaningfulQueryTokens(normalizedQuery);
  if (tokens.length === 0 || tokens.length > 3) {
    return { enabled: false, taskFamily: null, tokens };
  }

  const nonTaskTokens = tokens.filter(token => !IMPLICIT_CURRENT_WEEK_TASK_TOKENS.has(token));
  const broadSubjectTaskFallback = !courseScope
    && !courseHintSignals?.hasHint
    && tokens.length === 2
    && nonTaskTokens.length === 1
    && !IMPLICIT_CURRENT_WEEK_EXCLUDED_SUBJECT_TOKENS.has(nonTaskTokens[0]);

  if (!courseScope && !courseHintSignals?.hasHint && !broadSubjectTaskFallback) {
    return { enabled: false, taskFamily: null, tokens };
  }

  const taskFamilies = new Set();
  for (const token of tokens) {
    if (!IMPLICIT_CURRENT_WEEK_TASK_TOKENS.has(token)) continue;
    const family = getImplicitCurrentWeekTaskFamily(token);
    if (family) taskFamilies.add(family);
  }

  if (taskFamilies.size !== 1) {
    return { enabled: false, taskFamily: null, tokens };
  }

  const taskFamily = [...taskFamilies][0];
  if (tokens.includes('prelab') && !tokens.includes('lab') && !tokens.includes('laboratory')) {
    return { enabled: false, taskFamily: null, tokens, specificTokens: [] };
  }
  const specificTokens = tokens.filter((token) => {
    if (IMPLICIT_CURRENT_WEEK_TASK_TOKENS.has(token)) return false;
    if (courseScope) return true;
    if (broadSubjectTaskFallback && token === nonTaskTokens[0]) return false;
    if (courseHintSignals?.hasHint && tokens.length <= 2) return false;
    return !tokenMatchesCourseHint(token, courseHintSignals);
  });

  if (specificTokens.length > 0) {
    return { enabled: false, taskFamily: null, tokens, specificTokens };
  }

  return { enabled: true, taskFamily, tokens, specificTokens: [] };
}

function getItemSearchContext(item) {
  return normalizeText([
    item?.searchTitleNormalized || normalizeText(item?.title || ''),
    item?.searchPathNormalized || normalizeText(item?.folderPath || ''),
    item?.moduleName || '',
    item?.courseName || '',
    item?.type || ''
  ].join(' '));
}

function matchesImplicitCurrentWeekTask(item, implicitMode) {
  if (!implicitMode?.enabled || !isTaskType(item)) return false;

  const searchable = getItemSearchContext(item);
  switch (implicitMode.taskFamily) {
    case 'lab':
      return isLabContextItem(item);
    case 'quiz':
      return String(item?.type || '').toLowerCase() === 'quiz' || /\bquiz\b/.test(searchable);
    case 'discussion':
      return String(item?.type || '').toLowerCase() === 'discussion' || /\bdiscussion\b/.test(searchable);
    case 'assignment':
      return String(item?.type || '').toLowerCase() === 'assignment' || /\b(homework|assignment|problem set)\b/.test(searchable);
    default:
      return false;
  }
}

function mergeResultMetadata(existing, incoming) {
  if (!incoming) return existing;

  existing.score = Math.min(
    Number.isFinite(existing.score) ? existing.score : 1,
    Number.isFinite(incoming.score) ? incoming.score : 1
  );
  existing.prePass = existing.prePass || incoming.prePass;
  existing.implicitCurrentWeekAnchor = existing.implicitCurrentWeekAnchor || incoming.implicitCurrentWeekAnchor;
  existing.implicitCurrentWeekSibling = existing.implicitCurrentWeekSibling || incoming.implicitCurrentWeekSibling;
  existing.implicitCurrentWeekRelatedTask = existing.implicitCurrentWeekRelatedTask || incoming.implicitCurrentWeekRelatedTask;
  existing.implicitCurrentWeekGroupKey = existing.implicitCurrentWeekGroupKey || incoming.implicitCurrentWeekGroupKey || '';
  return existing;
}

function mergeSearchResults(results, additions) {
  const merged = new Map();

  for (const result of results || []) {
    if (!result?.item?.url) continue;
    merged.set(result.item.url, { ...result });
  }

  for (const addition of additions || []) {
    if (!addition?.item?.url) continue;
    if (merged.has(addition.item.url)) {
      mergeResultMetadata(merged.get(addition.item.url), addition);
    } else {
      merged.set(addition.item.url, { ...addition });
    }
  }

  return Array.from(merged.values());
}

function buildImplicitCurrentWeekContext(searchCorpus, rankingQuery, courseScope, courseHintSignals, implicitMode) {
  if (!implicitMode?.enabled) {
    return { enabled: false, extraResults: [], anchorGroupOrder: new Map(), anchorGroupMeta: new Map() };
  }

  const weeklyCandidates = filterItemsByTemporalWindow(searchCorpus, 'this_week');
  const anchorResults = [];

  for (const item of weeklyCandidates) {
    if (!itemMatchesCourseContext(item, courseScope, courseHintSignals)) continue;
    if (!matchesImplicitCurrentWeekTask(item, implicitMode)) continue;

    const groupKey = getLabSequenceGroupKey(item) || `task::${canonicalTaskId(item)}`;
    anchorResults.push({
      item,
      score: 0.24,
      prePass: false,
      implicitCurrentWeekAnchor: true,
      implicitCurrentWeekGroupKey: groupKey
    });
  }

  if (anchorResults.length === 0) {
    return { enabled: false, extraResults: [], anchorGroupOrder: new Map(), anchorGroupMeta: new Map() };
  }

  const groupMeta = new Map();
  const nowTs = Date.now();
  for (const result of anchorResults) {
    const groupKey = result.implicitCurrentWeekGroupKey;
    const dueTs = parseDueTs(result.item);
    if (!groupMeta.has(groupKey)) {
      groupMeta.set(groupKey, {
        earliestFutureDueTs: Number.MAX_SAFE_INTEGER,
        latestOverdueDueTs: 0,
        hasFutureAnchor: false
      });
    }

    const meta = groupMeta.get(groupKey);
    if (dueTs > 0 && dueTs >= nowTs) {
      meta.hasFutureAnchor = true;
      meta.earliestFutureDueTs = Math.min(meta.earliestFutureDueTs, dueTs);
    } else if (dueTs > 0) {
      meta.latestOverdueDueTs = Math.max(meta.latestOverdueDueTs, dueTs);
    }
  }

  const anchorGroupOrder = new Map(
    Array.from(groupMeta.entries())
      .sort((a, b) => {
        const left = a[1];
        const right = b[1];
        if (left.hasFutureAnchor !== right.hasFutureAnchor) return left.hasFutureAnchor ? -1 : 1;
        if (left.hasFutureAnchor && right.hasFutureAnchor) {
          return left.earliestFutureDueTs - right.earliestFutureDueTs;
        }
        return right.latestOverdueDueTs - left.latestOverdueDueTs;
      })
      .map(([groupKey], index) => [groupKey, index])
  );

  let extraResults = anchorResults.slice();

  if (implicitMode.taskFamily === 'lab') {
    const anchorUrls = new Set(anchorResults.map(result => result.item.url));
    const expandedResults = expandTemporalLabSiblings(anchorResults, rankingQuery, courseScope);
    const expandedAdditions = [];

    for (const result of expandedResults) {
      if (!result?.item?.url || anchorUrls.has(result.item.url)) continue;

      const groupKey = getLabSequenceGroupKey(result.item);
      if (!groupKey || !anchorGroupOrder.has(groupKey)) continue;

      expandedAdditions.push({
        ...result,
        score: 0.28,
        prePass: false,
        implicitCurrentWeekGroupKey: groupKey,
        implicitCurrentWeekSibling: !isTaskType(result.item),
        implicitCurrentWeekRelatedTask: isTaskType(result.item)
      });
    }

    extraResults = mergeSearchResults(extraResults, expandedAdditions);
  }

  return { enabled: true, extraResults, anchorGroupOrder, anchorGroupMeta: groupMeta };
}

function applyImplicitCurrentWeekOrdering(results, implicitContext) {
  if (!implicitContext?.enabled) return results;

  const nowTs = Date.now();
  const groupOrder = implicitContext.anchorGroupOrder || new Map();
  const groupMeta = implicitContext.anchorGroupMeta || new Map();

  const descriptorFor = (result) => {
    const item = result?.item || {};
    const dueTs = parseDueTs(item);
    const hasDue = dueTs > 0;
    const completed = isCompletedTask(item);
    const future = hasDue && dueTs >= nowTs;
    const groupKey = result?.implicitCurrentWeekGroupKey || '';
    const grouped = groupKey && groupOrder.has(groupKey);
    const groupIdx = grouped ? groupOrder.get(groupKey) : Number.MAX_SAFE_INTEGER;
    const groupInfo = grouped ? groupMeta.get(groupKey) : null;
    const groupIsFuture = Boolean(groupInfo?.hasFutureAnchor);

    if (completed) {
      return [5, groupIdx, dueTs || Number.MAX_SAFE_INTEGER, 0];
    }

    if (result?.implicitCurrentWeekAnchor && future) {
      return [0, groupIdx, dueTs || Number.MAX_SAFE_INTEGER, 0];
    }

    if (result?.implicitCurrentWeekSibling && grouped && groupIsFuture) {
      return [0, groupIdx, Number.MAX_SAFE_INTEGER, 1];
    }

    if (future) {
      return [1, groupIdx, dueTs, result?.implicitCurrentWeekRelatedTask ? 0 : 1];
    }

    if (!hasDue) {
      return [2, groupIdx, Number.MAX_SAFE_INTEGER, result?.implicitCurrentWeekRelatedTask ? 0 : 1];
    }

    if (result?.implicitCurrentWeekAnchor && grouped && !groupIsFuture) {
      return [3, groupIdx, -dueTs, 0];
    }

    if (result?.implicitCurrentWeekSibling && grouped && !groupIsFuture) {
      return [3, groupIdx, Number.MAX_SAFE_INTEGER, 1];
    }

    return [3, groupIdx, -dueTs, 0];
  };

  return [...results].sort((left, right) => {
    const leftDescriptor = descriptorFor(left);
    const rightDescriptor = descriptorFor(right);

    for (let index = 0; index < leftDescriptor.length; index++) {
      if (leftDescriptor[index] !== rightDescriptor[index]) {
        return leftDescriptor[index] - rightDescriptor[index];
      }
    }

    if ((right.finalScore || 0) !== (left.finalScore || 0)) {
      return (right.finalScore || 0) - (left.finalScore || 0);
    }

    return String(left.item?.title || '').localeCompare(String(right.item?.title || ''));
  });
}

/**
 * Build course-scope aliases from a course name.
 * Example: "Chem 3AL: Organic Chemistry Laboratory" -> ["chem 3al"]
 */
function getCourseScopeAliases(courseName) {
  const aliases = [];
  const norm = normalizeText(courseName || '');
  if (!norm) return aliases;

  // "chem 3al ..." form
  const spacedCode = norm.match(/^([a-z]{2,8})\s+(\d{1,4}[a-z]{0,4})(?:\s|$)/i);
  if (spacedCode) {
    aliases.push(`${spacedCode[1]} ${spacedCode[2]}`.toLowerCase());
  }

  // "chem3al ..." form
  const compactCode = norm.match(/^([a-z]{2,8})(\d{1,4}[a-z]{0,4})(?:\s|$)/i);
  if (compactCode) {
    aliases.push(`${compactCode[1]} ${compactCode[2]}`.toLowerCase());
  }

  return aliases;
}

/**
 * Detect if query starts or ends with a course name, enabling course-scoped search.
 * E.g., "chem 3b plws 10" → { coursePrefix: "chem 3b", remainingQuery: "plws 10" }
 * E.g., "plws 10 chem 3b" → { coursePrefix: "chem 3b", remainingQuery: "plws 10" }
 */
function detectCourseScope(query) {
  const normQuery = normalizeText(query);
  if (!normQuery || normQuery.length < 3) return null;

  const candidates = [];
  const seen = new Set();

  for (const item of state.indexedContent) {
    if (!item.courseName) continue;
    const original = item.courseName.trim();
    const full = normalizeText(original);

    // Short form: strip parenthetical suffix like "(Fall 2025)"
    const short = normalizeText(original.replace(/\s*\(.*\)\s*$/, ''));

    // Code aliases: "chem 3al", "math 1a", etc.
    const codeAliases = getCourseScopeAliases(original);

    if (short && short.length >= 3 && !seen.has(short)) {
      seen.add(short);
      candidates.push({ norm: short, original });
    }
    if (full && !seen.has(full)) {
      seen.add(full);
      candidates.push({ norm: full, original });
    }
    for (const alias of codeAliases) {
      if (alias.length >= 3 && !seen.has(alias)) {
        seen.add(alias);
        candidates.push({ norm: alias, original });
      }
    }
  }

  // Cache candidates arrays to avoid O(N) generation on every keystroke
  state._courseCandidatesCache = candidates.sort((a, b) => b.norm.length - a.norm.length);
  state._courseCandidatesVersion = state.indexedContent.length;

  const finalCandidates = state._courseCandidatesCache;

  // Pass 1: Check if query STARTS with a course name (prefix)
  for (const { norm, original } of finalCandidates) {
    if (normQuery.startsWith(norm + ' ') && normQuery.length > norm.length + 1) {
      const remaining = normQuery.slice(norm.length + 1).trim();
      if (remaining.length >= 1) {
        return { coursePrefix: norm, courseName: original, remainingQuery: remaining };
      }
    }
  }

  // Pass 2: Check if query ENDS with a course name (suffix)
  for (const { norm, original } of finalCandidates) {
    if (normQuery.endsWith(' ' + norm) && normQuery.length > norm.length + 1) {
      const remaining = normQuery.slice(0, normQuery.length - norm.length - 1).trim();
      if (remaining.length >= 1) {
        return { coursePrefix: norm, courseName: original, remainingQuery: remaining };
      }
    }
  }

  return null;
}

function getQueryCourseHintBoost(item, normalizedQuery) {
  const hintSignals = getCourseHintSignals(normalizedQuery);
  if (!hintSignals.hasHint) return 0;

  const itemCourse = normalizeText(item?.courseName || '');
  if (!itemCourse) return 0;

  if (hintSignals.matchedCourseKeys.has(itemCourse)) {
    return 0.50;
  }

  // Penalty for items not in any hinted course
  return -0.18;
}

const FILE_SPECIFIC_QUERY_TOKENS = new Set([
  'pdf', 'doc', 'docx', 'file', 'files', 'worksheet', 'handout', 'document',
  'slides', 'slide', 'notes', 'download', 'ppt', 'pptx'
]);

const PATH_ORIENTED_QUERY_TOKENS = new Set([
  'week', 'module', 'folder', 'folders', 'files', 'discussion', 'discussions',
  'unit', 'chapter', 'syllabus'
]);

const LEAF_FILE_TYPES = new Set(['file', 'pdf', 'document', 'slides']);

function getMeaningfulQueryTokens(normalizedQuery) {
  return String(normalizedQuery || '')
    .split(/\s+/)
    .filter(token => token.length > 0 && (token.length > 1 || /^\d+$/.test(token)))
    .filter(token => !STOP_TOKENS.has(token));
}

function buildSearchQueryMetadata({ effectiveQuery, normalizedQuery, rankingQuery, weeklyHabitBoostQuery = '' }) {
  const normalizedRankingQuery = String(rankingQuery || '').toLowerCase();
  const normalizedExpandedQuery = String(normalizedQuery || '').toLowerCase();
  const rawEffectiveQuery = normalizeText(effectiveQuery).toLowerCase();
  const keyLikeVariants = buildKeyLikeQueryVariants(normalizedRankingQuery);
  const searchQueries = Array.from(new Set([
    weeklyHabitBoostQuery ? String(weeklyHabitBoostQuery).toLowerCase() : '',
    normalizedRankingQuery,
    normalizedExpandedQuery,
    rawEffectiveQuery,
    ...keyLikeVariants
  ].filter(Boolean)));
  const searchTokens = normalizedRankingQuery
    .split(/\s+/)
    .filter(token => token.length > 0 && (token.length > 1 || !STOP_TOKENS.has(token)));
  const meaningfulTokens = getMeaningfulQueryTokens(normalizedRankingQuery);
  const generalTokens = normalizedRankingQuery
    .split(/\s+/)
    .filter(token => token.length > 0 && !STOP_TOKENS.has(token));

  return {
    normalizedQuery: normalizedExpandedQuery,
    rankingQuery: normalizedRankingQuery,
    rawEffectiveQuery,
    searchQueries,
    searchTokens,
    meaningfulTokens,
    generalTokens,
    searchTokenMatchers: buildTokenMatcherMap(searchTokens.filter(token => token.length === 1 || /^\d+$/.test(token))),
    meaningfulTokenMatchers: buildTokenMatcherMap(meaningfulTokens),
    queryNums: extractNumericTokens(normalizedRankingQuery),
    queryLooksFileSpecific: isFileSpecificQuery(normalizedRankingQuery),
    queryLooksPathOriented: isPathOrientedQuery(normalizedRankingQuery),
    queryWeekHints: extractWeekHintsFromValue(normalizedRankingQuery),
    wantsKeyLikeContent: wantsKeyLikeQuery(normalizedRankingQuery),
    hasExplicitTaskQualifier: EXPLICIT_TASK_QUALIFIER_RE.test(normalizedRankingQuery),
    hasSpecificRecallSignal: hasSpecificRecallSignal(searchTokens)
  };
}

function isFileSpecificQuery(normalizedQuery) {
  return getMeaningfulQueryTokens(normalizedQuery).some(token => FILE_SPECIFIC_QUERY_TOKENS.has(token));
}

function isPathOrientedQuery(normalizedQuery) {
  const tokens = getMeaningfulQueryTokens(normalizedQuery);
  if (tokens.length >= 3) return true;
  if (tokens.some(token => PATH_ORIENTED_QUERY_TOKENS.has(token))) return true;
  const numericCount = tokens.filter(token => /^\d+$/.test(token)).length;
  return numericCount > 0 && tokens.length >= 2;
}

function isSyllabusQuery(normalizedQuery) {
  return /\bsyllabus\b/i.test(String(normalizedQuery || ''));
}

function normalizeSlashAlias(value) {
  return String(value || '')
    .trim()
    .replace(/^\//, '')
    .toLowerCase();
}

function buildSlashCommandLookup(commands) {
  const lookup = new Map();

  for (const command of Array.isArray(commands) ? commands : []) {
    const aliases = [command?.primaryAlias, ...(Array.isArray(command?.aliases) ? command.aliases : [])];
    for (const alias of aliases) {
      const normalized = normalizeSlashAlias(alias);
      if (!normalized || lookup.has(normalized)) continue;
      lookup.set(normalized, command);
    }
  }

  return lookup;
}

function scoreSlashCommandMatch(command, query) {
  const normalizedQuery = normalizeSlashAlias(query);
  if (!normalizedQuery) return 1;

  const aliases = [command?.primaryAlias, ...(Array.isArray(command?.aliases) ? command.aliases : [])]
    .map(normalizeSlashAlias)
    .filter(Boolean);
  const title = normalizeText(command?.title || '');
  const description = normalizeText(command?.description || '');
  const keywords = (Array.isArray(command?.keywords) ? command.keywords : [])
    .map(keyword => normalizeText(keyword))
    .filter(Boolean);

  let score = -Infinity;

  for (const alias of aliases) {
    if (alias === normalizedQuery) return 200;
    if (alias.startsWith(normalizedQuery)) score = Math.max(score, 150 - alias.length);
    if (alias.includes(normalizedQuery)) score = Math.max(score, 132 - alias.length);
  }

  if (title === normalizedQuery) score = Math.max(score, 126);
  if (title.startsWith(normalizedQuery)) score = Math.max(score, 112);
  if (title.includes(normalizedQuery)) score = Math.max(score, 98);
  if (description.includes(normalizedQuery)) score = Math.max(score, 74);

  for (const keyword of keywords) {
    if (keyword === normalizedQuery) score = Math.max(score, 104);
    if (keyword.startsWith(normalizedQuery)) score = Math.max(score, 92);
    if (keyword.includes(normalizedQuery)) score = Math.max(score, 84);
  }

  return score;
}

function rankSlashCommands(commands, query) {
  const normalizedQuery = normalizeSlashAlias(query);
  const entries = [];

  for (const command of Array.isArray(commands) ? commands : []) {
    const score = scoreSlashCommandMatch(command, normalizedQuery);
    if (normalizedQuery && !Number.isFinite(score)) continue;
    entries.push({ command, score });
  }

  return entries
    .sort((lhs, rhs) => {
      if (rhs.score !== lhs.score) return rhs.score - lhs.score;
      return (lhs.command?.order || 0) - (rhs.command?.order || 0);
    })
    .map(entry => entry.command);
}

function parseSlashCommandText(rawValue, commandLookup = new Map()) {
  const rawText = String(rawValue || '');
  if (!rawText.startsWith('/')) {
    return {
      active: false,
      commandQuery: '',
      commandToken: '',
      argumentText: '',
      hasTrailingSpace: false,
      exactCommand: null,
      mode: 'inactive'
    };
  }

  const body = rawText.slice(1);
  const firstWhitespaceIndex = body.search(/\s/);
  const hasWhitespace = firstWhitespaceIndex !== -1;
  const commandToken = hasWhitespace ? body.slice(0, firstWhitespaceIndex) : body;
  const commandQuery = commandToken.trim().toLowerCase();
  const argumentText = hasWhitespace ? body.slice(firstWhitespaceIndex + 1) : '';
  const hasTrailingSpace = /\s$/.test(body);
  const exactCommand = commandLookup.get(commandQuery) || null;
  const mode = exactCommand && hasWhitespace ? 'results' : 'commands';

  return {
    active: true,
    commandQuery,
    commandToken,
    argumentText,
    hasTrailingSpace,
    exactCommand,
    mode
  };
}

function isSlashPdfEligibleItem(item) {
  const normalizedType = String(item?.type || '').toLowerCase();
  if (normalizedType === 'pdf') return true;
  if (normalizedType !== 'file') return false;

  const title = String(item?.title || '').toLowerCase();
  const url = String(item?.url || '').toLowerCase();
  return title.includes('.pdf') || url.includes('.pdf');
}

// Slash commands moved to in-page overlay (slash-overlay.js).
// This stub is kept so references to state.slashMode don't throw.
function createDefaultSlashModeState() {
  return Object.freeze({
    active: false,
    rawValue: '',
    parsed: null,
    highlightedIndex: 0,
    results: [],
    feedback: null
  });
}

function countTokenHits(tokens, searchableText, tokenMatchers = new Map()) {
  if (!tokens.length || !searchableText) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (token.length === 1 || /^\d+$/.test(token)) {
      if (tokenMatchers.get(token)?.test(searchableText)) hits++;
    } else if (searchableText.includes(token)) {
      hits++;
    }
  }
  return hits;
}

function getPathSearchText(item) {
  return normalizeText([
    item?.courseName || '',
    item?.folderPath || '',
    Array.isArray(item?.pathSegments) ? item.pathSegments.join(' ') : '',
    item?.moduleName || '',
    item?.type === 'syllabus' ? 'syllabus' : ''
  ].join(' '));
}

function shouldShowPathContext(item) {
  return Boolean(item?.folderPath) &&
    (item?.type === 'folder' || LEAF_FILE_TYPES.has(String(item?.type || '').toLowerCase()));
}

// ============================================
// UI STATE MACHINE
// ============================================

const UI_STATE = {
  BOOT_LOADING: 'boot_loading',
  SCAN_SYNCING: 'scan_syncing',
  READY: 'ready',
  SEARCHING: 'searching',
  ERROR: 'error'
};

let currentUiState = UI_STATE.BOOT_LOADING;

function setUiState(newState, message = '') {
  currentUiState = newState;

  // Hide all dynamic states first
  elements.loadingShell.classList.add('hidden');
  elements.emptyState.classList.add('hidden');
  elements.resultsContainer.classList.remove('hidden');
  elements.scanProgress.classList.add('hidden');

  if (elements.duePlanner && !state.isOverlayMode) {
    elements.duePlanner.classList.add('hidden');
  }

  switch (newState) {
    case UI_STATE.BOOT_LOADING:
      if (!state.isOverlayMode) {
        elements.loadingShell.classList.remove('hidden');
      }
      elements.statusText.textContent = 'Loading Canvascope...';
      break;

    case UI_STATE.SCAN_SYNCING:
      if (state.indexedContent && state.indexedContent.length > 0 && !(elements.searchInput && elements.searchInput.value)) {
        showEmptyState();
      } else if (!state.indexedContent || state.indexedContent.length === 0) {
        if (!state.isOverlayMode) {
          elements.loadingShell.classList.remove('hidden');
        }
      }
      elements.statusText.textContent = message || 'Syncing content...';
      elements.scanProgress.classList.remove('hidden');
      if (elements.scanProgress.value === 100) elements.scanProgress.value = 0;
      break;

    case UI_STATE.READY:
      elements.statusText.textContent = 'Search your course content';
      showEmptyState(); // Handles due planner vs empty icon
      break;

    case UI_STATE.SEARCHING:
      elements.statusText.textContent = 'Search your course content';
      // Results container handles its own display
      break;

    case UI_STATE.ERROR:
      elements.statusText.textContent = message || 'Error';
      showEmptyState();
      break;
  }
}

// ============================================
// DOM ELEMENTS
// ============================================

const elements = {};

// ============================================
// STATE
// ============================================

const MAX_RECENTS = 5;
const PDF_VIEWER_DEBUG = true;
const POPUP_UI_STORAGE_KEY = 'popupUi';
const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
  enableSendToLectra: false,
  enableAdaptiveLearning: true,
  selectedCourseFilters: [],
  customAlgorithm: DEFAULT_CUSTOM_ALGORITHM
});
const DEFAULT_POPUP_UI = Object.freeze({
  walkthroughSeen: false
});

let state = {
  fuse: null,
  indexedContent: [],
  filteredContent: [],
  searchTimeout: null,
  isScanning: false,
  filters: {
    course: [],
    type: ''
  },
  searchHistory: [],
  courses: [],
  isOverlayMode: false,
  overlayHighlightIndex: 0,
  lastSearchTimeMs: 0,
  lastResultCount: 0,
  recentlyOpened: [],
  isSignedIn: false,
  user: null,
  activePdfContext: null,
  extensionSettings: { ...DEFAULT_EXTENSION_SETTINGS },
  popupUi: { ...DEFAULT_POPUP_UI },
  settingsModalOpen: false,
  helpModalOpen: false,
  lastModalTrigger: null,
  slashMode: createDefaultSlashModeState(),
  _courseCandidatesCache: null,
  _courseCandidatesVersion: 0,
  dismissedTasks: [],
  backendAdaptiveSuggestions: [],
  backendAdaptiveSuggestionsLoadedAt: 0,
  backendAdaptiveSuggestionsSlotKey: '',
  backendAdaptiveSuggestionsPrefix: '',
  backendAdaptiveSuggestionsPending: false,
  lastAdaptiveSearchSubmission: { query: '', at: 0 },
  reportedAdaptiveSuggestionKeys: new Set()
};
let selectedCourseFilterWritePromise = Promise.resolve();

function normalizeExtensionSettings(rawSettings) {
  const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  const selectedCourseFilters = Array.isArray(source.selectedCourseFilters)
    ? [...new Set(source.selectedCourseFilters
      .map(value => String(value || '').trim())
      .filter(Boolean))]
    : [];
  return {
    ...DEFAULT_EXTENSION_SETTINGS,
    ...source,
    enableSendToLectra: Boolean(source.enableSendToLectra),
    enableAdaptiveLearning: source.enableAdaptiveLearning !== false,
    selectedCourseFilters,
    customAlgorithm: normalizeCustomAlgorithm(source.customAlgorithm)
  };
}

function normalizePopupUi(rawPopupUi) {
  const source = rawPopupUi && typeof rawPopupUi === 'object' ? rawPopupUi : {};
  return {
    ...DEFAULT_POPUP_UI,
    walkthroughSeen: Boolean(source.walkthroughSeen)
  };
}

async function loadExtensionSettings() {
  try {
    const result = await chrome.storage.local.get(['settings']);
    state.extensionSettings = normalizeExtensionSettings(result.settings);
  } catch (error) {
    console.warn('[Canvascope] Could not load settings:', error);
    state.extensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
  }

  syncCourseFiltersFromSettings();
  applyExtensionSettingsUi();
}

async function loadPopupUiState() {
  try {
    const result = await chrome.storage.local.get([POPUP_UI_STORAGE_KEY]);
    state.popupUi = normalizePopupUi(result[POPUP_UI_STORAGE_KEY]);
  } catch (error) {
    console.warn('[Canvascope] Could not load popup UI state:', error);
    state.popupUi = { ...DEFAULT_POPUP_UI };
  }
}

async function updatePopupUiState(patch) {
  const current = normalizePopupUi(state.popupUi);
  const next = normalizePopupUi({
    ...current,
    ...patch
  });
  state.popupUi = next;
  await chrome.storage.local.set({ [POPUP_UI_STORAGE_KEY]: next });
  return next;
}

function applyExtensionSettingsUi() {
  if (elements.enableSendToLectraToggle) {
    elements.enableSendToLectraToggle.checked = Boolean(state.extensionSettings.enableSendToLectra);
  }

  if (elements.enableAdaptiveLearningToggle) {
    elements.enableAdaptiveLearningToggle.checked = Boolean(state.extensionSettings.enableAdaptiveLearning);
  }

  const customAlgorithm = getStoredCustomAlgorithm();

  if (elements.enableCustomAlgorithmToggle) {
    elements.enableCustomAlgorithmToggle.checked = customAlgorithm.enabled;
  }

  if (elements.customAlgorithmPanel) {
    elements.customAlgorithmPanel.classList.toggle('hidden', !customAlgorithm.enabled);
  }

  if (elements.customAlgorithmSliders) {
    for (const slider of elements.customAlgorithmSliders) {
      const key = slider.dataset.algorithmSetting;
      if (!key || !(key in customAlgorithm)) continue;
      slider.value = String(customAlgorithm[key]);
      updateCustomAlgorithmValueLabel(key, customAlgorithm[key]);
    }
  }

  if (state.slashMode.active) {
    renderSlashCommandSheet();
  }
}

function updateAuthButtonUi({ label = null, disabled = false } = {}) {
  if (!elements.googleSignInBtn) return;

  const text = label ?? (state.isSignedIn ? 'Account' : 'Sign in');
  const buttonLabel = label
    ? text
    : (state.isSignedIn ? 'Open account and sign-out controls' : 'Sign in with Google');

  elements.googleSignInBtn.disabled = disabled;
  elements.googleSignInBtn.setAttribute('aria-label', buttonLabel);
  elements.googleSignInBtn.querySelector('.btn-text').textContent = text;

  const googleIcon = elements.googleSignInBtn.querySelector('.auth-icon-google');
  const accountIcon = elements.googleSignInBtn.querySelector('.auth-icon-account');
  if (googleIcon) googleIcon.classList.toggle('hidden', state.isSignedIn);
  if (accountIcon) accountIcon.classList.toggle('hidden', !state.isSignedIn);

  elements.googleSignInBtn.style.backgroundColor = '';
  elements.googleSignInBtn.style.borderColor = 'var(--glass-border)';
}

function updateSettingsAccountUi() {
  if (elements.settingsProfile) {
    elements.settingsProfile.classList.toggle('hidden', !state.isSignedIn);
  }

  // Hide the setting-accounts card if the user is already signed in.
  if (elements.settingsAccountState) {
    elements.settingsAccountState.classList.toggle('hidden', state.isSignedIn);
  }

  if (elements.settingsModalFooter) {
    elements.settingsModalFooter.classList.toggle('hidden', !state.isSignedIn);
  }
}

async function updateExtensionSettings(patch) {
  const result = await chrome.storage.local.get(['settings']);
  const nextSettings = normalizeExtensionSettings({
    ...(result.settings || {}),
    ...patch
  });

  await chrome.storage.local.set({ settings: nextSettings });
  state.extensionSettings = nextSettings;
  syncCourseFiltersFromSettings();
  applyExtensionSettingsUi();
  return nextSettings;
}

function getAllowedFileSchemeAccess() {
  return new Promise((resolve) => {
    chrome.extension.isAllowedFileSchemeAccess((allowed) => {
      resolve(Boolean(allowed));
    });
  });
}

async function warmDropBridgeReceiver(reason = 'popup-open') {
  try {
    await chrome.runtime.sendMessage({
      action: 'ensureDropBridgeReceiver',
      reason
    });
  } catch (error) {
    console.warn('[Canvascope] Failed to warm DropBridge receiver:', error?.message || error);
  }
}

async function syncPdfViewerOverlayRegistration(reason = 'popup') {
  try {
    return await chrome.runtime.sendMessage({
      action: 'syncPdfViewerOverlayRegistration',
      reason
    });
  } catch (error) {
    console.warn('[Canvascope] Failed to sync PDF viewer overlay registration:', error);
    return {
      success: false,
      enabled: false,
      matches: [],
      reason: error?.message || 'sync_failed'
    };
  }
}

async function runPdfViewerDebugProbe(reason = 'popup') {
  if (!PDF_VIEWER_DEBUG) return null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = String(tab?.url || '');
    const looksPdf = url.startsWith('file:')
      || url.toLowerCase().includes('.pdf')
      || url.toLowerCase().includes('/pdf/');

    if (!looksPdf) {
      return null;
    }

    const response = await chrome.runtime.sendMessage({
      action: 'debugPdfViewerOverlayActiveTab',
      reason
    });
    console.log('[Canvascope PDF Viewer][Popup] Active-tab diagnostics', response);
    return response;
  } catch (error) {
    console.warn('[Canvascope PDF Viewer][Popup] Debug probe failed', error);
    return null;
  }
}

async function getPdfFallbackDisabledTitle() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (String(tab?.url || '').startsWith('file:')) {
      const fileAccessAllowed = await getAllowedFileSchemeAccess();
      if (!fileAccessAllowed) {
        return 'Enable "Allow access to file URLs" in Manage Extension to send local PDFs.';
      }
    }
  } catch (error) {
    console.warn('[Canvascope] Could not inspect active tab for PDF fallback hint:', error);
  }

  return 'Open a PDF tab to send.';
}

async function updateCustomAlgorithmSettings(patch) {
  const current = getStoredCustomAlgorithm();
  return updateExtensionSettings({
    customAlgorithm: {
      ...current,
      ...patch
    }
  });
}

function updateCustomAlgorithmValueLabel(key, value) {
  const label = elements.customAlgorithmValueLabels?.[key];
  if (!label) return;
  label.textContent = formatCustomAlgorithmValue(key, value);
}

function rerunSearchWithCurrentQuery() {
  initializeFuse();

  if (state.slashMode.active) {
    renderSlashCommandSheet();
    return;
  }

  const activeQuery = elements.searchInput?.value.trim();
  if (activeQuery) {
    performSearch(activeQuery);
  }
}

function normalizeSelectedCourseFilters(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function selectedCourseFiltersKey(values) {
  return normalizeSelectedCourseFilters(values).join('||');
}

function syncCourseFiltersFromSettings() {
  state.filters.course = normalizeSelectedCourseFilters(state.extensionSettings.selectedCourseFilters);
  updateCourseFilterTriggerText();
}

function updateCourseFilterTriggerText() {
  if (!elements.courseText) return;

  const selectedCourses = normalizeSelectedCourseFilters(state.filters.course);
  if (selectedCourses.length === 0) {
    elements.courseText.textContent = 'All Courses';
    return;
  }

  if (selectedCourses.length === 1) {
    elements.courseText.textContent = selectedCourses[0];
    return;
  }

  elements.courseText.textContent = `${selectedCourses.length} Classes`;
}

function itemMatchesSelectedCourses(item, selectedCourses = state.filters.course) {
  const normalizedSelections = normalizeSelectedCourseFilters(selectedCourses);
  if (normalizedSelections.length === 0) return true;

  const itemCourse = normalizeText(item?.courseName || '');
  if (!itemCourse) return false;

  return normalizedSelections.some(course => normalizeText(course) === itemCourse);
}

function isCourseSelected(courseName, selectedCourses = state.filters.course) {
  if (!courseName) return false;
  return normalizeSelectedCourseFilters(selectedCourses)
    .some(course => normalizeText(course) === normalizeText(courseName));
}

function buildCourseOption(label, { value = label, selected = false, doneness = null } = {}) {
  const option = document.createElement('div');
  option.className = 'custom-option custom-option-multiselect';
  option.dataset.value = value;
  option.dataset.label = label;

  if (selected) {
    option.classList.add('selected');
  }

  const checkbox = document.createElement('span');
  checkbox.className = 'custom-option-checkbox';
  checkbox.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'custom-option-label';
  text.textContent = label;

  option.appendChild(checkbox);
  option.appendChild(text);

  if (doneness && doneness.total > 0) {
    const pct = doneness.done / doneness.total;
    const tone = pct >= 0.85 ? 'go' : pct >= 0.5 ? 'mid' : 'low';
    const pill = document.createElement('span');
    pill.className = `cs-doneness-pill cs-doneness-pill--${tone}`;
    pill.textContent = `${doneness.done}/${doneness.total}`;
    pill.title = `${doneness.done} of ${doneness.total} graded assignments complete`;
    pill.setAttribute('aria-label', pill.title);
    option.appendChild(pill);
  }
  return option;
}

/**
 * Roll up assignment completion across indexedContent, keyed by courseName.
 * Counts only assignments with a real dueAt and submission record (skips items
 * without a server-side gradebook signal so the ratio is honest).
 * Returns { [courseName]: { done, total } }.
 */
function computeCourseDoneness() {
  const map = new Map();
  if (!Array.isArray(state.indexedContent)) return map;
  for (const item of state.indexedContent) {
    if (!item || item.type !== 'assignment') continue;
    if (!item.courseName) continue;
    if (!item.submission || typeof item.submission !== 'object') continue;
    // Skip practice/optional shells where the server didn't return any grading hooks
    const sub = item.submission;
    const workflow = String(sub.workflowState || '').trim().toLowerCase();
    if (!workflow && sub.attempt == null && sub.score == null && !sub.submittedAt && sub.missing !== true) continue;

    const key = item.courseName.trim();
    const entry = map.get(key) || { done: 0, total: 0 };
    entry.total += 1;
    if (isCompletedTask(item)) entry.done += 1;
    map.set(key, entry);
  }
  return map;
}

async function setSelectedCourseFilters(nextSelectedCourses) {
  const normalizedSelection = normalizeSelectedCourseFilters(nextSelectedCourses);
  const previousSelection = selectedCourseFiltersKey(state.filters.course);
  const nextSelection = selectedCourseFiltersKey(normalizedSelection);

  if (previousSelection === nextSelection) return;

  state.filters.course = normalizedSelection;
  handleFilterChange();

  try {
    selectedCourseFilterWritePromise = selectedCourseFilterWritePromise
      .catch(() => {
        // Keep the queue alive so the latest selection still persists.
      })
      .then(async () => {
        if (selectedCourseFiltersKey(state.filters.course) !== nextSelection) return;
        await updateExtensionSettings({ selectedCourseFilters: normalizedSelection });
      });

    await selectedCourseFilterWritePromise;
  } catch (error) {
    console.error('[Canvascope] Failed to save selected classes:', error);
    await loadExtensionSettings();
    handleFilterChange();
  }
}

// ============================================
// INITIALIZATION
// ============================================

// ============================================================================
// v2 — TACTICAL HUD MODULE
// Pinned items · Hero (Up Next / Radar / Timeline) · Overflow menu · Lock-on
// ============================================================================
const csV2 = (() => {
  const PIN_STORAGE_KEY = 'pinnedItems';
  const TIMELINE_SEEN_KEY = 'timelineSeenAt';
  const TIMELINE_LIMIT = 30;

  let countdownTimer = null;
  let resultsObserver = null;
  let pinDecorateRaf = 0;
  let radarRenderToken = 0;

  // ---- Pinned items ---------------------------------------------------------
  state.pinnedItems = new Set();
  state.heroView = 'next';
  state.timelineSeenAt = 0;

  async function loadPinnedItems() {
    try {
      const result = await chrome.storage.local.get([PIN_STORAGE_KEY, TIMELINE_SEEN_KEY]);
      const ids = Array.isArray(result[PIN_STORAGE_KEY]) ? result[PIN_STORAGE_KEY] : [];
      state.pinnedItems = new Set(ids.filter(Boolean).map(String));
      state.timelineSeenAt = Number(result[TIMELINE_SEEN_KEY] || 0);
    } catch (e) {
      state.pinnedItems = new Set();
      state.timelineSeenAt = 0;
    }
  }

  async function persistPinnedItems() {
    try {
      await chrome.storage.local.set({ [PIN_STORAGE_KEY]: Array.from(state.pinnedItems) });
    } catch (e) {
      console.warn('[Canvascope] Could not persist pinned items:', e);
    }
  }

  async function persistTimelineSeenAt() {
    state.timelineSeenAt = Date.now();
    try {
      await chrome.storage.local.set({ [TIMELINE_SEEN_KEY]: state.timelineSeenAt });
    } catch (e) { /* non-fatal */ }
  }

  function isPinned(item) {
    if (!item) return false;
    return state.pinnedItems.has(getCanonicalId(item));
  }

  function findPinnedItem(id) {
    if (!Array.isArray(state.indexedContent)) return null;
    for (const item of state.indexedContent) {
      if (getCanonicalId(item) === id) return item;
    }
    // Fallback: pinned items may have been removed from index since pin time.
    // Look in recently opened.
    if (Array.isArray(state.recentlyOpened)) {
      for (const item of state.recentlyOpened) {
        if (getCanonicalId(item) === id) return item;
      }
    }
    return null;
  }

  async function togglePin(item, { fromButton = null } = {}) {
    if (!item) return;
    const id = getCanonicalId(item);
    if (state.pinnedItems.has(id)) {
      state.pinnedItems.delete(id);
    } else {
      state.pinnedItems.add(id);
      if (fromButton) {
        fromButton.classList.remove('is-flash');
        // Force reflow to restart animation
        void fromButton.offsetWidth;
        fromButton.classList.add('is-flash');
      }
    }
    await persistPinnedItems();
    renderPinnedRow();
    syncPinTogglesInDom();
  }

  // ---- Hero view dispatch ---------------------------------------------------
  function selectHeroView(view) {
    if (!['next', 'radar', 'timeline'].includes(view)) view = 'next';
    state.heroView = view;

    document.querySelectorAll('.cs-hero-tab').forEach(tab => {
      const isActive = tab.dataset.csHeroTab === view;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    const panels = {
      next:     document.getElementById('cs-hero-next'),
      radar:    document.getElementById('cs-hero-radar'),
      timeline: document.getElementById('cs-hero-timeline')
    };
    Object.entries(panels).forEach(([k, el]) => {
      if (!el) return;
      el.classList.toggle('hidden', k !== view);
    });

    // Body class drives layout: in radar/timeline tabs we hide the lower
    // results pane so the hero panel can take the room it needs.
    document.body.classList.remove('cs-hero-mode-next', 'cs-hero-mode-radar', 'cs-hero-mode-timeline');
    document.body.classList.add(`cs-hero-mode-${view}`);

    renderHero();

    // Re-fire bracket lock-on animation each time the hero view switches
    replayBracketSnap();

    if (view === 'timeline') void persistTimelineSeenAt();
  }

  function replayBracketSnap() {
    const brackets = document.querySelectorAll('.cs-bracket');
    brackets.forEach(b => {
      b.style.animation = 'none';
      void b.offsetWidth;
      b.style.animation = '';
    });
  }

  function renderHero() {
    if (state.isOverlayMode) return;
    if (state.heroView === 'next') renderUpNext();
    else if (state.heroView === 'radar') renderRadarPanel();
    else if (state.heroView === 'timeline') renderTimeline();
  }

  // ---- Selectors over the existing data model ------------------------------
  function getNextUp() {
    if (!Array.isArray(state.indexedContent) || state.indexedContent.length === 0) return null;
    const buckets = bucketTasks(state.indexedContent, Date.now());
    const candidates = [...buckets.overdue, ...buckets.today, ...buckets.next7Days];
    return candidates.length ? candidates[0] : null;
  }

  function getRecentItems(limit = TIMELINE_LIMIT) {
    if (!Array.isArray(state.indexedContent)) return [];
    const items = state.indexedContent
      .filter(item => item && item.url)
      .slice()
      .sort((a, b) => {
        const at = Number(a.lastSeenAt || a.indexedAt || a.scrapedAt || a.updatedAt || 0);
        const bt = Number(b.lastSeenAt || b.indexedAt || b.scrapedAt || b.updatedAt || 0);
        return bt - at;
      });
    return items.slice(0, limit);
  }

  function getRadarItems(limit = 18) {
    if (!Array.isArray(state.indexedContent)) return [];
    const buckets = bucketTasks(state.indexedContent, Date.now(), 14);
    return [...buckets.overdue, ...buckets.today, ...buckets.next7Days].slice(0, limit);
  }

  /**
   * Predict the item the user is most likely to want next, based on their open
   * history. Score = openCount × log(1+x) + recency decay. Excludes completed
   * tasks (they don't need re-opening) and the currently-urgent item.
   *
   * Returns null when habit data is too thin to be confident (no item with
   * >=2 opens within last 30d).
   */
  function getLikelyNextItem(excludeUrl = null) {
    if (!state.extensionSettings?.enableAdaptiveLearning) return null;
    const habits = state.searchHabits;
    if (!habits || !habits.globalClicks) return null;
    if (!Array.isArray(state.indexedContent) || state.indexedContent.length === 0) return null;

    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const indexByPath = new Map();
    for (const item of state.indexedContent) {
      const key = getClickKey(item);
      if (key) indexByPath.set(key, item);
    }

    let best = null;
    let bestScore = 0;
    for (const [path, click] of Object.entries(habits.globalClicks)) {
      const item = indexByPath.get(path);
      if (!item) continue;
      if (excludeUrl && item.url === excludeUrl) continue;
      // Skip done tasks — re-opening a graded assignment isn't actionable
      if (isTaskType(item) && isCompletedTask(item)) continue;
      // Respect active course filter
      if (typeof itemMatchesSelectedCourses === 'function' && !itemMatchesSelectedCourses(item)) continue;

      const openCount = Number(click?.openCount || 0);
      const lastOpenedAt = Number(click?.lastOpenedAt || 0);
      if (openCount < 1 || !lastOpenedAt) continue;
      const ageMs = now - lastOpenedAt;
      if (ageMs > THIRTY_DAYS) continue;

      // Frequency: log scaled so 1→1, 2→1.6, 4→2.3, 8→3.2
      const freq = Math.log2(1 + openCount);
      // Recency: decay across 14 days, 0..1
      const recency = Math.max(0, 1 - ageMs / (14 * 24 * 60 * 60 * 1000));
      const score = freq * (0.4 + 0.6 * recency);

      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    // Confidence threshold: at least one item with 2+ opens, or a single very recent open
    return bestScore >= 1.0 ? best : null;
  }

  // ---- UP NEXT --------------------------------------------------------------
  function renderUpNext() {
    const mount = document.getElementById('cs-hero-next');
    if (!mount) return;

    const item = getNextUp();

    // Clear running countdown
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }

    if (!item) {
      // Prefer the predicted "likely next" item (uses click habits) over the raw
      // most-recent recentlyOpened entry. Fall back to recentlyOpened only when
      // habit signal is too thin.
      const predicted = getLikelyNextItem();
      const recentRaw = (state.recentlyOpened && state.recentlyOpened[0]) || null;
      const fallback = predicted || recentRaw;
      const usingPrediction = !!predicted && predicted !== recentRaw;
      mount.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'cs-upnext-empty';
      wrap.innerHTML = `
        <span class="cs-upnext-empty-kicker"><span class="cs-status-dot"></span>${usingPrediction ? 'Likely next · habit signal' : 'All clear · no targets'}</span>
        <span class="cs-upnext-empty-title">${fallback ? (usingPrediction ? 'You keep coming back to this' : 'Pick up where you left off') : 'Nothing on the radar'}</span>
        <span class="cs-upnext-empty-copy">${fallback
          ? escapeHtml(fallback.title || 'Untitled') + ' <span class="cs-upnext-empty-sep">·</span> ' + escapeHtml(fallback.courseName || '')
          : 'Sync a course to populate your scope.'}</span>
        ${fallback ? '<span class="cs-upnext-empty-cta">Open ↗</span>' : ''}
      `;
      if (fallback) {
        wrap.style.cursor = 'pointer';
        wrap.addEventListener('click', (e) => openResult(fallback, e));
      }
      mount.appendChild(wrap);
      return;
    }

    const tone = dueTone(item);
    const renderCard = () => {
      const readout = computeCountdown(item);
      mount.innerHTML = `
        <div class="cs-upnext cs-upnext--simple">
          <div class="cs-upnext-head">
            <span class="cs-upnext-kicker tone-${tone}"><span class="cs-status-dot"></span><span class="cs-upnext-kicker-label"></span></span>
            <button class="cs-upnext-dismiss" type="button" data-cs-upnext-dismiss>Dismiss</button>
          </div>
          <span class="cs-upnext-title"></span>
          <span class="cs-upnext-meta">
            <span class="cs-upnext-course"></span>
            <span class="cs-upnext-typechip"></span>
            <span class="cs-upnext-due tone-${tone}" data-cs-countdown></span>
          </span>
          <div class="cs-upnext-actions">
            <button class="cs-btn cs-btn--primary" type="button" data-cs-upnext-open>
              Open
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M9 7h8v8" stroke-linecap="round"/></svg>
            </button>
            <button class="cs-btn cs-btn--ghost" type="button" data-cs-upnext-pin>
              ${isPinned(item) ? '★ Pinned' : '☆ Pin'}
            </button>
          </div>
        </div>
      `;
      mount.querySelector('.cs-upnext-kicker-label').textContent = readout.label;
      mount.querySelector('.cs-upnext-title').textContent = item.title || 'Untitled';
      mount.querySelector('.cs-upnext-course').textContent = item.courseName || '—';
      mount.querySelector('.cs-upnext-typechip').textContent = formatTypeName(item.type || '') || 'Item';
      mount.querySelector('[data-cs-countdown]').textContent = formatUpNextDue(readout);

      mount.querySelector('[data-cs-upnext-open]').addEventListener('click', (e) => openResult(item, e));
      mount.querySelector('[data-cs-upnext-pin]').addEventListener('click', async (e) => {
        e.preventDefault();
        const btn = e.currentTarget;
        await togglePin(item);
        btn.textContent = isPinned(item) ? '★ Pinned' : '☆ Pin';
      });
      mount.querySelector('[data-cs-upnext-dismiss]').addEventListener('click', async (e) => {
        e.preventDefault();
        await dismissUpNextItem(item);
      });
    };

    renderCard();

    // Tick countdown — update only the readout value
    countdownTimer = setInterval(() => {
      const node = mount.querySelector('[data-cs-countdown]');
      if (!node) return;
      const readout = computeCountdown(item);
      node.textContent = formatUpNextDue(readout);
      const labelNode = mount.querySelector('.cs-upnext-kicker-label');
      if (labelNode) labelNode.textContent = readout.label;
    }, 30000);
  }

  function formatUpNextDue(readout) {
    if (!readout) return '';
    const unit = readout.unit === 'HRS:MIN' ? 'left' : readout.unit.toLowerCase();
    return `${readout.value} ${unit}`;
  }

  async function dismissUpNextItem(item) {
    if (!item) return;
    const id = getCanonicalId(item);
    if (!state.dismissedTasks.includes(id)) {
      state.dismissedTasks.push(id);
      await chrome.storage.local.set({ dismissedTasks: state.dismissedTasks });
    }
    renderUpNext();
    renderDuePlanner();
  }

  function dueTone(item) {
    const klass = dueUrgencyClass(item);
    if (klass === 'overdue') return 'stop';
    if (klass === 'today')   return 'warn';
    if (klass === 'upcoming') return 'go';
    return 'go';
  }

  function computeCountdown(item) {
    const ts = parseDueTs(item);
    if (!ts) return { value: '—', unit: 'NO DUE', label: 'Pending' };
    const diffMs = ts - Date.now();
    const abs = Math.abs(diffMs);
    const days  = Math.floor(abs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((abs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const mins  = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000));

    let value, unit;
    if (abs >= 24 * 60 * 60 * 1000) {
      value = `${days}d ${hours.toString().padStart(2, '0')}h`;
      unit = diffMs < 0 ? 'OVERDUE' : 'TO DUE';
    } else {
      value = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
      unit = diffMs < 0 ? 'OVERDUE' : 'HRS:MIN';
    }

    const label = diffMs < 0 ? 'Locked · overdue' :
                  abs <= 24 * 60 * 60 * 1000 ? 'Lock-on · today' : 'Tracking';
    return { value, unit, label };
  }

  // ---- TIMELINE -------------------------------------------------------------
  function renderTimeline() {
    const mount = document.getElementById('cs-hero-timeline');
    if (!mount) return;
    const items = getRecentItems();
    if (items.length === 0) {
      mount.innerHTML = `<div class="cs-radar-empty">— no synced items yet —</div>`;
      return;
    }

    const groups = groupTimeline(items, state.timelineSeenAt || 0);
    mount.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'cs-timeline';

    groups.forEach(group => {
      if (!group.items.length) return;
      const groupEl = document.createElement('div');
      groupEl.className = 'cs-timeline-group';

      const label = document.createElement('div');
      label.className = 'cs-timeline-group-label';
      label.textContent = group.label;
      groupEl.appendChild(label);

      group.items.forEach(({ item, isNew, ts }) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'cs-timeline-row';
        row.setAttribute('aria-label', buildItemAriaLabel(item));

        const dot = document.createElement('span');
        dot.className = 'cs-timeline-dot' + (isNew ? ' is-new' : '');
        row.appendChild(dot);

        const text = document.createElement('span');
        text.className = 'cs-timeline-text';
        const title = document.createElement('span');
        title.className = 'cs-timeline-title';
        title.textContent = item.title || 'Untitled';
        const meta = document.createElement('span');
        meta.className = 'cs-timeline-meta';
        meta.textContent = [
          (item.courseName || '').toUpperCase(),
          formatTypeName(item.type || '')
        ].filter(Boolean).join(' · ');
        text.appendChild(title);
        text.appendChild(meta);
        row.appendChild(text);

        const time = document.createElement('span');
        time.className = 'cs-timeline-time';
        time.textContent = ts ? formatRelativeTime(ts).toUpperCase() : '';
        row.appendChild(time);

        row.addEventListener('click', (e) => openResult(item, e));
        groupEl.appendChild(row);
      });

      list.appendChild(groupEl);
    });

    mount.appendChild(list);
  }

  function groupTimeline(items, seenAt) {
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const startOfYday  = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const startOfWeek  = new Date(startOfToday.getTime() - 7 * 24 * 60 * 60 * 1000);

    const buckets = {
      today:    { label: 'TODAY',     items: [] },
      yesterday:{ label: 'YESTERDAY', items: [] },
      week:     { label: 'THIS WEEK', items: [] },
      earlier:  { label: 'EARLIER',   items: [] }
    };

    items.forEach(item => {
      const ts = Number(item.lastSeenAt || item.indexedAt || item.scrapedAt || item.updatedAt || 0);
      const isNew = ts > seenAt;
      const entry = { item, ts, isNew };
      if (ts >= startOfToday.getTime())      buckets.today.items.push(entry);
      else if (ts >= startOfYday.getTime())  buckets.yesterday.items.push(entry);
      else if (ts >= startOfWeek.getTime())  buckets.week.items.push(entry);
      else                                    buckets.earlier.items.push(entry);
    });

    return [buckets.today, buckets.yesterday, buckets.week, buckets.earlier];
  }

  // ---- RADAR ----------------------------------------------------------------
  function renderRadarPanel() {
    const mount = document.getElementById('cs-hero-radar');
    if (!mount) return;
    if (typeof window.CanvascopeRadar?.render !== 'function') {
      mount.innerHTML = `<div class="cs-radar-empty">— radar unavailable —</div>`;
      return;
    }
    const items = getRadarItems();
    radarRenderToken += 1;
    const myToken = radarRenderToken;
    const windowToQuery = {
      overdue: 'overdue',
      h24:     'due today',
      d3:      'due this week',
      d7:      'due this week',
      d14:     'due'
    };
    window.CanvascopeRadar.render(mount, {
      items,
      now: Date.now(),
      onOpen: (item, evt) => {
        if (myToken !== radarRenderToken) return;
        openResult(item, evt);
      },
      onFilterCourse: (courseName) => {
        if (myToken !== radarRenderToken) return;
        const input = elements.searchInput;
        if (!input) return;
        const label = (courseName || '').toString().trim();
        if (!label) return;
        input.value = label;
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      onFilterCourseWindow: (courseName, windowKey) => {
        if (myToken !== radarRenderToken) return;
        const input = elements.searchInput;
        if (!input) return;
        const courseLabel = (courseName || '').toString().trim();
        const winQ = windowToQuery[windowKey] || '';
        const q = [winQ, courseLabel].filter(Boolean).join(' ');
        input.value = q;
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      isPinned: (item) => isPinned(item),
      onTogglePin: async (item) => {
        await togglePin(item);
        return isPinned(item);
      }
    });
    renderRadarResume(mount);
  }

  function renderRadarResume(mount) {
    const nextUp = getNextUp();
    const predicted = getLikelyNextItem(nextUp?.url || null);
    if (!predicted) return;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cs-radar-resume';
    chip.title = 'Predicted from your open habits';
    chip.innerHTML = `
      <span class="cs-radar-resume-kicker">Resume</span>
      <span class="cs-radar-resume-title"></span>
      <span class="cs-radar-resume-arrow" aria-hidden="true">↗</span>
    `;
    chip.querySelector('.cs-radar-resume-title').textContent = predicted.title || 'Untitled';
    chip.addEventListener('click', (e) => openResult(predicted, e));
    mount.appendChild(chip);
  }

  // ---- PINNED ROW -----------------------------------------------------------
  function renderPinnedRow() {
    const row = document.getElementById('cs-pinned-row');
    if (!row || state.isOverlayMode) return;
    row.innerHTML = '';

    const ids = Array.from(state.pinnedItems);
    const items = ids.map(findPinnedItem).filter(Boolean);

    if (items.length === 0) {
      row.classList.add('hidden');
      return;
    }
    row.classList.remove('hidden');

    items.slice(0, 12).forEach(item => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'cs-pin-pill';
      pill.setAttribute('aria-label', `Open pinned: ${item.title || 'Untitled'}`);

      const star = document.createElement('span');
      star.className = 'cs-pin-pill-star';
      star.textContent = '★';

      const title = document.createElement('span');
      title.className = 'cs-pin-pill-title';
      title.textContent = item.title || 'Untitled';

      const unpin = document.createElement('span');
      unpin.className = 'cs-pin-pill-unpin';
      unpin.setAttribute('role', 'button');
      unpin.setAttribute('aria-label', 'Unpin');
      unpin.textContent = '×';
      unpin.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        await togglePin(item);
      });

      pill.appendChild(star);
      pill.appendChild(title);
      pill.appendChild(unpin);
      pill.addEventListener('click', (e) => openResult(item, e));
      row.appendChild(pill);
    });
  }

  // ---- PIN TOGGLES ON RESULT ROWS (via MutationObserver) -------------------
  function attachPinTogglesToResults() {
    const container = document.getElementById('results-container');
    if (!container || resultsObserver) return;
    decoratePinsIn(container);
    resultsObserver = new MutationObserver(() => {
      if (pinDecorateRaf) return;
      pinDecorateRaf = requestAnimationFrame(() => {
        pinDecorateRaf = 0;
        decoratePinsIn(container);
      });
    });
    resultsObserver.observe(container, { childList: true, subtree: true });
  }

  function decoratePinsIn(root) {
    if (!root) return;
    const candidates = root.querySelectorAll('.result-item:not([data-cs-pin-decorated]), .due-item:not([data-cs-pin-decorated]), .browse-item:not([data-cs-pin-decorated])');
    candidates.forEach(node => {
      node.dataset.csPinDecorated = '1';
      const item = guessItemFromNode(node);
      if (!item) return;
      const toggle = makePinToggle(item);
      node.appendChild(toggle);
    });
  }

  function makePinToggle(item) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cs-pin-toggle' + (isPinned(item) ? ' is-pinned' : '');
    btn.setAttribute('aria-label', isPinned(item) ? 'Unpin item' : 'Pin item');
    btn.textContent = isPinned(item) ? '★' : '☆';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await togglePin(item, { fromButton: btn });
      const pinned = isPinned(item);
      btn.classList.toggle('is-pinned', pinned);
      btn.textContent = pinned ? '★' : '☆';
      btn.setAttribute('aria-label', pinned ? 'Unpin item' : 'Pin item');
    });
    return btn;
  }

  // Find the item the row was rendered from. Falls back to URL match in indexedContent.
  function guessItemFromNode(node) {
    // result rows store __item via property on the dataset's hidden anchor or via `_item` JS property
    if (node.__csItem) return node.__csItem;
    if (node._csItem) return node._csItem;
    const url = node.dataset?.url || node.getAttribute('data-url') || (node.querySelector('[data-url]')?.dataset?.url);
    if (url && Array.isArray(state.indexedContent)) {
      const match = state.indexedContent.find(i => i.url === url);
      if (match) return match;
    }
    // Fallback: match by title text + course meta — best effort
    const title = node.querySelector('.result-title, .due-item-title, .browse-item-title, .recent-item-title, .continue-card-title')?.textContent?.trim();
    if (title && Array.isArray(state.indexedContent)) {
      const match = state.indexedContent.find(i => (i.title || '').trim() === title);
      if (match) return match;
    }
    return null;
  }

  function syncPinTogglesInDom() {
    document.querySelectorAll('.cs-pin-toggle').forEach(btn => {
      const node = btn.closest('[data-cs-pin-decorated]');
      const item = guessItemFromNode(node);
      if (!item) return;
      const pinned = isPinned(item);
      btn.classList.toggle('is-pinned', pinned);
      btn.textContent = pinned ? '★' : '☆';
    });
  }

  // ---- OVERFLOW MENU --------------------------------------------------------
  function bindOverflowMenu() {
    const trigger = document.getElementById('cs-overflow-btn');
    const menu = document.getElementById('cs-overflow-menu');
    if (!trigger || !menu) return;

    const close = () => {
      menu.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      menu.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'true');
    };

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.contains('hidden') ? open() : close();
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== trigger) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    // Proxy to legacy buttons (popup.js binds those)
    const proxy = (id, legacyId) => {
      const item = document.getElementById(id);
      if (!item) return;
      item.addEventListener('click', () => {
        close();
        const legacy = document.getElementById(legacyId);
        if (legacy) legacy.click();
      });
    };
    proxy('cs-overflow-refresh', 'refresh-btn');
    proxy('cs-overflow-send-pdf', 'send-pdf-btn');
    proxy('cs-overflow-signin', 'google-signin-btn');

    // Reflect signed-in label
    const updateSignInLabel = () => {
      const lbl = document.getElementById('cs-overflow-signin-label');
      if (!lbl) return;
      lbl.textContent = state.isSignedIn ? 'Account' : 'Sign in with Google';
    };
    updateSignInLabel();
    document.addEventListener('cs:auth-changed', updateSignInLabel);

    // Reflect refresh busy state
    const refreshBtn = document.getElementById('refresh-btn');
    const refreshItem = document.getElementById('cs-overflow-refresh');
    if (refreshBtn && refreshItem) {
      const obs = new MutationObserver(() => {
        refreshItem.classList.toggle('is-busy', refreshBtn.disabled);
      });
      obs.observe(refreshBtn, { attributes: true, attributeFilter: ['disabled'] });
    }
  }

  // ---- HERO TABS ------------------------------------------------------------
  function bindHeroTabs() {
    document.querySelectorAll('.cs-hero-tab').forEach(tab => {
      tab.addEventListener('click', () => selectHeroView(tab.dataset.csHeroTab));
    });
  }

  // ---- Listen for content/auth events to refresh hero -----------------------
  function bindStateRefreshHooks() {
    // Re-render hero when indexedContent updates (storage broadcast)
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes.indexedContent || changes.recentlyOpened || changes.dismissedTasks) {
          renderHero();
          renderPinnedRow();
        }
        if (changes[PIN_STORAGE_KEY]) {
          const ids = Array.isArray(changes[PIN_STORAGE_KEY].newValue) ? changes[PIN_STORAGE_KEY].newValue : [];
          state.pinnedItems = new Set(ids.map(String));
          renderPinnedRow();
          syncPinTogglesInDom();
        }
      });
    } catch (e) { /* extension restart edge cases */ }
  }

  function bindSearchEscape() {
    // Radar grid clicks write into the search field programmatically; flip back
    // to the standard results layout so the filtered results are visible.
    const input = document.getElementById('search-input');
    if (!input) return;
    input.addEventListener('input', () => {
      const q = (input.value || '').trim();
      if (q.length === 0) return;
      if (state.heroView !== 'next') selectHeroView('next');
    });
  }

  // ---- Public init ----------------------------------------------------------
  async function init() {
    if (state.isOverlayMode) return; // Overlay mode bypasses the v2 home
    await loadPinnedItems();
    bindHeroTabs();
    bindOverflowMenu();
    bindSearchEscape();
    attachPinTogglesToResults();
    bindStateRefreshHooks();
    renderPinnedRow();
    selectHeroView('next');
  }

  // ---- Util -----------------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return {
    init,
    renderHero,
    renderPinnedRow,
    selectHeroView,
    togglePin,
    isPinned
  };
})();

document.addEventListener('DOMContentLoaded', async () => {
  // Check if we're in overlay mode
  const urlParams = new URLSearchParams(window.location.search);
  state.isOverlayMode = urlParams.get('mode') === 'overlay';

  // Apply overlay mode IMMEDIATELY, before any rendering
  if (state.isOverlayMode || window.self !== window.top) {
    state.isOverlayMode = true;
    document.body.classList.add('in-overlay');
  }

  // Pre-load elements into cache
  elements.searchInput = document.getElementById('search-input');
  elements.clearSearchBtn = document.getElementById('clear-search');
  elements.statusText = document.getElementById('status-text');
  elements.resultsContainer = document.getElementById('results-container');
  elements.emptyState = document.getElementById('empty-state');
  elements.syncStatus = document.getElementById('sync-status');
  elements.syncIcon = document.getElementById('sync-icon');
  elements.syncText = document.getElementById('sync-text');
  elements.scanProgress = document.getElementById('scan-progress');
  elements.refreshBtn = document.getElementById('refresh-btn');
  elements.settingsBtn = document.getElementById('settings-btn');
  elements.loadingShell = document.getElementById('loading-shell');
  elements.searchHistory = document.getElementById('search-history');
  elements.duePlanner = document.getElementById('due-planner');

  // Start in boot loading state
  setUiState(UI_STATE.BOOT_LOADING);
  console.log('[Canvascope] Popup opened');
  initializeElements();
  applySlashModeUi();
  setupEventListeners();
  await loadExtensionSettings();
  await loadPopupUiState();
  await loadContent();
  await loadSearchHistory();
  await loadRecentlyOpened();
  await loadClickFeedbackMap();
  void loadBackendAdaptiveSuggestions({ force: true });
  await detectActiveCourseContext();
  initializeFuse();
  updateUI();
  renderDuePlanner();
  renderHomeSections();
  await csV2.init();
  csV2.renderHero();
  updateAuthButtonUi();
  updateSettingsModalContent();
  updateSearchFieldAffordances();
  elements.searchInput.focus();

  // Request status from background
  getBackgroundStatus();
  void warmDropBridgeReceiver('popup-open');

  // Check auth status
  chrome.runtime.sendMessage({ type: 'checkAuthStatus' }, (response) => {
    if (response && response.signedIn) {
      handleSignedInState(response.user);
    } else {
      handleSignedOutState();
    }
  });

  // Check if current tab is a supported LMS and auto-detect domain
  await checkCurrentTab();
  void requestActiveTabContentScan();

  if (!state.isOverlayMode) {
    await refreshPdfFallbackAvailability();
  }

  void maybeShowWalkthrough();

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.settings) return;

      const previousCourseKey = selectedCourseFiltersKey(state.filters.course);
      const previousSendToLectra = Boolean(state.extensionSettings.enableSendToLectra);
      const previousAlgorithmKey = getActiveSearchAlgorithmKey(state.extensionSettings);

      state.extensionSettings = normalizeExtensionSettings(changes.settings.newValue);
      syncCourseFiltersFromSettings();
      applyExtensionSettingsUi();

      const algorithmChanged = previousAlgorithmKey !== getActiveSearchAlgorithmKey(state.extensionSettings);

      if (!state.isOverlayMode && previousSendToLectra !== Boolean(state.extensionSettings.enableSendToLectra)) {
        refreshPdfFallbackAvailability();
      }

      if (previousCourseKey !== selectedCourseFiltersKey(state.filters.course)) {
        handleFilterChange();
      } else if (algorithmChanged) {
        rerunSearchWithCurrentQuery();
      }
    });
  } catch (error) {
    console.warn('[Canvascope] Could not subscribe to settings updates:', error);
  }

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
      <span class="overlay-footer-left"><span id="overlay-result-count"></span>Canvascope</span>
      <span class="overlay-footer-right"><kbd>↑↓</kbd> navigate <kbd>↵</kbd> select <kbd>esc</kbd> close</span>
    `;
    document.querySelector('.container').appendChild(footer);
    elements.overlayResultCount = document.getElementById('overlay-result-count');

    // Show recently opened items in the empty state
    showOverlayRecents();

    // Listen for messages from parent
    window.addEventListener('message', (event) => {
      // Only accept messages from our parent frame
      if (event.source !== window.parent) return;

      if (event.data && event.data.type === 'FOCUS_INPUT') {
        setTimeout(() => {
          elements.searchInput.focus();
          // Re-show recently opened if search is empty
          if (!elements.searchInput.value.trim()) {
            showOverlayRecents();
          }
        }, 50);
      }

      if (event.data && event.data.type === 'CLEAR_SEARCH') {
        if (elements.searchInput) {
          elements.searchInput.value = '';
          clearSearch();
        }
      }
    });

    // Handle Escape key to close overlay (capture phase to ensure it fires first)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Clear the search input before closing
        if (elements.searchInput) {
          elements.searchInput.value = '';
          clearSearch();
        }
        window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, '*');
      }
    }, true); // capture: true
  }
}

function initializeElements() {
  elements.helpBtn = document.getElementById('help-btn');
  elements.settingsBtn = document.getElementById('settings-btn');
  elements.searchSection = document.querySelector('.search-section');
  elements.searchWrapper = document.querySelector('.search-wrapper');
  elements.searchInput = document.getElementById('search-input');
  elements.clearSearchBtn = document.getElementById('clear-search');
  // Slash DOM elements removed — slash commands live in in-page overlay now
  elements.resultsContainer = document.getElementById('results-container');
  elements.emptyState = document.getElementById('empty-state');
  elements.refreshBtn = document.getElementById('refresh-btn');
  elements.sendPdfBtn = document.getElementById('send-pdf-btn');
  elements.clearDataBtn = document.getElementById('clear-data-btn');
  elements.statusText = document.getElementById('status-text');
  elements.statsText = document.getElementById('stats-text');
  elements.statsHint = document.getElementById('stats-hint');
  elements.statsBtn = document.getElementById('stats-btn');
  elements.homeSections = document.getElementById('home-sections');
  elements.continueSection = document.getElementById('continue-section');
  elements.recentlyOpenedSection = document.getElementById('recently-opened-section');

  // Browsing Modal Elements
  elements.browseModal = document.getElementById('browse-modal');
  elements.closeBrowse = document.getElementById('close-browse');
  elements.browseTabs = document.getElementById('browse-tabs');
  elements.browseContent = document.getElementById('browse-content');

  // Auth Integration
  elements.googleSignInBtn = document.getElementById('google-signin-btn');
  elements.accountModal = document.getElementById('account-modal');
  elements.closeAccountModalBtn = document.getElementById('close-account-modal');
  elements.settingsProfile = document.getElementById('settings-profile');
  elements.settingsAccountState = document.getElementById('settings-account-state');
  elements.settingsSigninBtn = document.getElementById('settings-signin-btn');
  elements.settingsModalFooter = document.getElementById('settings-modal-footer');
  elements.accountNameDisplay = document.getElementById('account-name-display');
  elements.accountEmailDisplay = document.getElementById('account-email-display');
  elements.accountAvatarPlaceholder = document.getElementById('account-avatar-placeholder');
  elements.enableSendToLectraToggle = document.getElementById('enable-send-to-lectra');
  elements.enableAdaptiveLearningToggle = document.getElementById('enable-adaptive-learning');
  elements.adaptiveLearningPanel = document.getElementById('adaptive-learning-panel');
  elements.clearSearchHabitsBtn = document.getElementById('clear-search-habits');
  elements.enableCustomAlgorithmToggle = document.getElementById('enable-custom-algorithm');
  elements.customAlgorithmPanel = document.getElementById('custom-algorithm-panel');
  elements.resetCustomAlgorithmBtn = document.getElementById('reset-custom-algorithm');
  elements.customAlgorithmSliders = Array.from(document.querySelectorAll('[data-algorithm-setting]'));
  elements.customAlgorithmValueLabels = Object.fromEntries(
    Array.from(document.querySelectorAll('[data-algorithm-value-for]'))
      .map(node => [node.dataset.algorithmValueFor, node])
  );
  elements.logoutBtn = document.getElementById('logout-btn');
  elements.helpModal = document.getElementById('help-modal');
  elements.closeHelpModalBtn = document.getElementById('close-help-modal');
  elements.exampleSearchButtons = Array.from(document.querySelectorAll('[data-example-query]'));

  // Sync Status Elements
  elements.syncStatus = document.getElementById('sync-status');
  elements.syncIcon = document.getElementById('sync-icon');
  elements.syncText = document.getElementById('sync-text');

  // Custom Dropdown Elements
  elements.courseWrapper = document.getElementById('course-select-wrapper');
  elements.courseTrigger = document.getElementById('course-trigger');
  elements.courseOptions = document.getElementById('course-options');
  elements.courseText = document.getElementById('course-text');
  elements.filterBar = document.getElementById('filter-bar');

  elements.typeWrapper = document.getElementById('type-select-wrapper');
  elements.typeTrigger = document.getElementById('type-trigger');
  elements.typeOptions = document.getElementById('type-options');
  elements.typeText = document.getElementById('type-text');

  elements.searchHistory = document.getElementById('search-history');

  // Due Planner
  elements.duePlanner = document.getElementById('due-planner');
}

function sanitizeAdminExport(data) {
  // Deep clone first so we never mutate runtime state.
  const cloned = JSON.parse(JSON.stringify(data || {}));

  // Remove known top-level sensitive payloads.
  delete cloned.canvascope_supabase_session;
  delete cloned.supabase_session;
  delete cloned.supabaseSession;
  delete cloned.session;
  delete cloned.auth;

  // Recursively scrub token-like fields everywhere.
  const sensitiveKeys = new Set([
    'access_token',
    'refresh_token',
    'provider_token',
    'provider_refresh_token',
    'token',
    'jwt',
    'authorization',
    'apikey',
    'secret'
  ]);

  function scrub(node) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) scrub(item);
      return;
    }

    for (const key of Object.keys(node)) {
      const lower = key.toLowerCase();
      if (sensitiveKeys.has(lower) || lower.includes('token') || lower.includes('secret')) {
        delete node[key];
        continue;
      }
      scrub(node[key]);
    }
  }

  scrub(cloned);
  return cloned;
}

function openPopupModal(stateKey, modalElement, trigger = null, initialFocusElement = null) {
  if (!modalElement) return;

  state.lastModalTrigger = trigger || document.activeElement;
  modalElement.classList.remove('hidden');
  if (stateKey) state[stateKey] = true;

  window.requestAnimationFrame(() => {
    const focusTarget = initialFocusElement
      || modalElement.querySelector('button, [href], input, [tabindex]:not([tabindex="-1"])');
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }
  });
}

function closePopupModal(stateKey, modalElement) {
  if (!modalElement || modalElement.classList.contains('hidden')) return;

  modalElement.classList.add('hidden');
  if (stateKey) state[stateKey] = false;

  const trigger = state.lastModalTrigger;
  state.lastModalTrigger = null;
  if (trigger && typeof trigger.focus === 'function') {
    trigger.focus();
  }
}

async function maybeShowWalkthrough() {
  if (state.isOverlayMode || state.popupUi.walkthroughSeen) return;
  await updatePopupUiState({ walkthroughSeen: true });
  showHelpModal(elements.helpBtn, { autoOpen: true });
}

function showHelpModal(trigger = null, { autoOpen = false } = {}) {
  if (!elements.helpModal) return;
  openPopupModal('helpModalOpen', elements.helpModal, trigger, elements.closeHelpModalBtn);
  if (!autoOpen && !state.popupUi.walkthroughSeen) {
    void updatePopupUiState({ walkthroughSeen: true });
  }
}

function updateSettingsModalContent() {
  updateSettingsAccountUi();

  if (!state.isSignedIn) {
    return;
  }

  const user = state.user || {};
  const name = user.name || 'User';
  const email = user.email || '';

  if (elements.accountNameDisplay) elements.accountNameDisplay.textContent = name;
  if (elements.accountEmailDisplay) elements.accountEmailDisplay.textContent = email;

  if (elements.accountAvatarPlaceholder) {
    if (user.avatar_url) {
      elements.accountAvatarPlaceholder.innerHTML = `<img src="${user.avatar_url}" alt="" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
      elements.accountAvatarPlaceholder.style.backgroundColor = 'transparent';
    } else {
      elements.accountAvatarPlaceholder.innerHTML = name.charAt(0).toUpperCase();
      elements.accountAvatarPlaceholder.style.backgroundColor = 'var(--glass-border)';
    }
  }
}

function showSettingsModal(trigger = null) {
  if (!elements.accountModal) return;
  updateSettingsModalContent();
  applyExtensionSettingsUi();
  openPopupModal('settingsModalOpen', elements.accountModal, trigger, elements.closeAccountModalBtn);
}

function closeTopModal() {
  if (state.helpModalOpen) {
    closePopupModal('helpModalOpen', elements.helpModal);
    return true;
  }

  if (state.settingsModalOpen) {
    closePopupModal('settingsModalOpen', elements.accountModal);
    return true;
  }

  if (elements.browseModal && !elements.browseModal.classList.contains('hidden')) {
    closeBrowseModal();
    return true;
  }

  return false;
}

function handleSignedInState(user) {
  state.isSignedIn = true;
  state.user = user || null;
  updateAuthButtonUi();
  updateSettingsModalContent();
  if (state.slashMode.active) {
    renderSlashCommandSheet();
  }
  document.dispatchEvent(new CustomEvent('cs:auth-changed'));
  void warmDropBridgeReceiver('popup-post-login');
}

function handleSignedOutState() {
  state.isSignedIn = false;
  state.user = null;
  updateAuthButtonUi();
  updateSettingsModalContent();
  if (state.slashMode.active) {
    renderSlashCommandSheet();
  }
  document.dispatchEvent(new CustomEvent('cs:auth-changed'));
}

function getPopupErrorMessage(error, fallback = 'Action failed.') {
  const message = error?.message ? String(error.message) : '';
  return message || fallback;
}

function updateSearchFieldAffordances() {
  if (!elements.clearSearchBtn || !elements.searchInput) return;
  const hasInput = Boolean(elements.searchInput.value);
  elements.clearSearchBtn.classList.toggle('visible', state.slashMode.active || hasInput);
}

function applySlashModeUi() {
  const active = Boolean(state.slashMode.active) && !state.isOverlayMode;

  document.body.classList.toggle('slash-mode-active', active);

  if (elements.slashSearchPrefix) {
    elements.slashSearchPrefix.classList.toggle('hidden', !active);
  }

  if (elements.slashSheet) {
    elements.slashSheet.classList.toggle('hidden', !active);
  }

  if (elements.searchInput) {
    elements.searchInput.placeholder = active ? SLASH_SEARCH_PLACEHOLDER : DEFAULT_SEARCH_PLACEHOLDER;
    elements.searchInput.setAttribute('aria-expanded', active ? 'true' : 'false');
    elements.searchInput.setAttribute('aria-controls', active ? 'slash-results' : 'results-container');
    if (!active) {
      elements.searchInput.removeAttribute('aria-activedescendant');
    }
  }

  if (active) {
    hideSearchHistory();
    elements.courseWrapper?.classList.remove('open');
    elements.typeWrapper?.classList.remove('open');
  }

  updateSearchFieldAffordances();
}

function createSlashResultEntry({
  key,
  kind = 'candidate',
  title,
  subtitle = '',
  meta = '',
  badge = '',
  badgeClass = '',
  ariaLabel = '',
  onSelect = null
}) {
  return {
    key,
    kind,
    title,
    subtitle,
    meta,
    badge,
    badgeClass,
    ariaLabel: ariaLabel || [title, subtitle, meta, badge].filter(Boolean).join(', '),
    onSelect
  };
}

function getSlashItemSortTitle(item) {
  return String(item?.title || '').trim().toLowerCase();
}

function sortSlashItemsAlphabetically(items) {
  return [...items].sort((lhs, rhs) => getSlashItemSortTitle(lhs).localeCompare(getSlashItemSortTitle(rhs)));
}

function sortSlashItemsByRecency(items) {
  return [...items].sort((lhs, rhs) => {
    const lhsTs = lhs?.scannedAt ? new Date(lhs.scannedAt).getTime() : 0;
    const rhsTs = rhs?.scannedAt ? new Date(rhs.scannedAt).getTime() : 0;
    if (rhsTs !== lhsTs) return rhsTs - lhsTs;
    return getSlashItemSortTitle(lhs).localeCompare(getSlashItemSortTitle(rhs));
  });
}

function buildSlashItemSearchBlob(item) {
  return normalizeText([
    item?.searchTitleNormalized || expandAbbreviations(item?.title || ''),
    item?.searchCourseNormalized || expandAbbreviations(item?.courseName || ''),
    item?.searchPathNormalized || normalizeText(item?.folderPath || ''),
    normalizeText(item?.moduleName || ''),
    Array.isArray(item?.searchAliases) ? item.searchAliases.join(' ') : '',
    normalizeText(item?.url || '')
  ].join(' '));
}

function scoreSlashItemMatch(item, query) {
  const normalizedQuery = expandAbbreviations(query || '');
  const meaningfulTokens = getMeaningfulQueryTokens(normalizedQuery);
  if (!normalizedQuery || meaningfulTokens.length === 0) return 0;

  const titleText = String(item?.searchTitleNormalized || expandAbbreviations(item?.title || '')).toLowerCase();
  const courseText = String(item?.searchCourseNormalized || expandAbbreviations(item?.courseName || '')).toLowerCase();
  const pathText = String(item?.searchPathNormalized || normalizeText(item?.folderPath || '')).toLowerCase();
  const haystack = buildSlashItemSearchBlob(item);

  let score = 0;

  if (titleText === normalizedQuery) score += 170;
  else if (titleText.startsWith(normalizedQuery)) score += 132;
  else if (titleText.includes(normalizedQuery)) score += 112;

  if (courseText.includes(normalizedQuery)) score += 28;
  if (pathText.includes(normalizedQuery)) score += 22;

  let matchedTokens = 0;
  for (const token of meaningfulTokens) {
    if (titleText.includes(token)) {
      score += 22;
      matchedTokens += 1;
      continue;
    }
    if (courseText.includes(token)) {
      score += 14;
      matchedTokens += 1;
      continue;
    }
    if (pathText.includes(token)) {
      score += 12;
      matchedTokens += 1;
      continue;
    }
    if (haystack.includes(token)) {
      score += 8;
      matchedTokens += 1;
    }
  }

  if (matchedTokens === meaningfulTokens.length) {
    score += 28;
  } else {
    score -= (meaningfulTokens.length - matchedTokens) * 16;
  }

  return score;
}

function filterSlashItems(items, query, { defaultSort = sortSlashItemsAlphabetically, extraScore = null } = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const normalizedQuery = String(query || '').trim();

  if (!normalizedQuery) {
    return defaultSort(sourceItems).slice(0, SLASH_RESULT_LIMIT);
  }

  const scored = [];
  for (const item of sourceItems) {
    let score = scoreSlashItemMatch(item, normalizedQuery);
    if (typeof extraScore === 'function') {
      score += Number(extraScore(item, normalizedQuery) || 0);
    }
    if (score <= 0) continue;
    scored.push({ item, score });
  }

  return scored
    .sort((lhs, rhs) => {
      if (rhs.score !== lhs.score) return rhs.score - lhs.score;
      return getSlashItemSortTitle(lhs.item).localeCompare(getSlashItemSortTitle(rhs.item));
    })
    .slice(0, SLASH_RESULT_LIMIT)
    .map(entry => entry.item);
}

function getSlashDueItems() {
  const now = Date.now();
  return state.indexedContent
    .filter(item => isTaskType(item) && parseDueTs(item) > 0 && !isCompletedTask(item))
    .sort((lhs, rhs) => {
      const lhsTs = parseDueTs(lhs);
      const rhsTs = parseDueTs(rhs);
      const lhsOverdue = lhsTs < now;
      const rhsOverdue = rhsTs < now;

      if (lhsOverdue !== rhsOverdue) return lhsOverdue ? -1 : 1;
      if (lhsOverdue && rhsOverdue) return rhsTs - lhsTs;
      return lhsTs - rhsTs;
    });
}

function getSlashLectraAvailability() {
  if (!state.isSignedIn) {
    return {
      available: false,
      title: 'Sign in to use /ls',
      reason: 'Open Settings to sign in, then turn on Send to Lectra before using Lectra Send.',
      cta: 'Press Enter to open Settings.',
      badge: 'Setup',
      onSelect: () => {
        exitSlashMode({ clearInput: true, focusInput: false });
        showSettingsModal(elements.searchInput);
      }
    };
  }

  if (!state.extensionSettings.enableSendToLectra) {
    return {
      available: false,
      title: 'Enable Send to Lectra',
      reason: 'Turn on “Enable Send to Lectra” in Settings to make /ls available.',
      cta: 'Press Enter to open Settings.',
      badge: 'Setup',
      onSelect: () => {
        exitSlashMode({ clearInput: true, focusInput: false });
        showSettingsModal(elements.searchInput);
      }
    };
  }

  return { available: true };
}

function createSlashGuidanceEntry(command, availability) {
  return createSlashResultEntry({
    key: `guidance:${command.id}`,
    kind: 'guidance',
    title: availability.title || `${command.title} needs setup`,
    subtitle: availability.reason || 'Finish setup in Settings to use this command.',
    meta: availability.cta || 'Press Enter to open Settings.',
    badge: availability.badge || 'Setup',
    badgeClass: 'badge-setup',
    onSelect: typeof availability.onSelect === 'function' ? availability.onSelect : null
  });
}

function createSlashItemEntry(command, item, {
  subtitle = '',
  meta = '',
  badge = '',
  badgeClass = ''
} = {}) {
  return createSlashResultEntry({
    key: `${command.id}:${getCanonicalId(item)}`,
    kind: 'candidate',
    title: item?.title || 'Untitled',
    subtitle,
    meta,
    badge,
    badgeClass,
    ariaLabel: buildItemAriaLabel(item),
    onSelect: () => command.execute(command, { item })
  });
}

function createSlashActionEntry(command, {
  keySuffix,
  title,
  subtitle,
  meta = '',
  badge = '',
  badgeClass = '',
  ariaLabel = ''
}) {
  return createSlashResultEntry({
    key: `${command.id}:${keySuffix}`,
    kind: 'candidate',
    title,
    subtitle,
    meta,
    badge,
    badgeClass,
    ariaLabel,
    onSelect: () => command.execute(command, {})
  });
}

function buildSlashLectraEntries(command, argumentText, availability) {
  if (!availability.available) {
    return [createSlashGuidanceEntry(command, availability)];
  }

  const pdfItems = state.indexedContent.filter(isSlashPdfEligibleItem);
  const filtered = filterSlashItems(pdfItems, argumentText, {
    defaultSort: sortSlashItemsByRecency
  });

  return filtered.map(item => createSlashItemEntry(command, item, {
    subtitle: item?.courseName || 'Indexed PDF',
    meta: item?.folderPath || 'Send straight to Lectra',
    badge: 'PDF'
  }));
}

function buildSlashCourseEntries(command, argumentText) {
  const courseItems = state.indexedContent.filter(item => String(item?.type || '').toLowerCase() === 'course');
  const filtered = filterSlashItems(courseItems, argumentText, {
    defaultSort: sortSlashItemsAlphabetically
  });

  return filtered.map(item => createSlashItemEntry(command, item, {
    subtitle: 'Open this course in the current LMS tab',
    meta: item?.moduleName && item.moduleName !== item.title ? item.moduleName : (item?.url || ''),
    badge: 'Course'
  }));
}

function buildSlashDueEntries(command, argumentText) {
  const dueItems = getSlashDueItems();
  const filtered = argumentText
    ? filterSlashItems(dueItems, argumentText, {
      defaultSort: (items) => items,
      extraScore: (item) => {
        const dueTs = parseDueTs(item);
        if (dueTs <= 0) return 0;
        return Math.max(0, 24 - ((dueTs - Date.now()) / (1000 * 60 * 60 * 24)));
      }
    })
    : dueItems.slice(0, SLASH_RESULT_LIMIT);

  return filtered.map(item => createSlashItemEntry(command, item, {
    subtitle: `${formatTypeName(item?.type || 'task')} • ${item?.courseName || 'Task'}`,
    meta: item?.folderPath || item?.moduleName || 'Open this due item',
    badge: formatDueLabel(item)
  }));
}

function buildSlashRefreshEntries(command) {
  return [
    createSlashActionEntry(command, {
      keySuffix: 'run',
      title: 'Refresh Now',
      subtitle: 'Start a fresh Canvascope sync for the active LMS tab.',
      meta: 'The popup will return to the dashboard once sync starts.',
      badge: 'Sync'
    })
  ];
}

function buildSlashBrowseEntries(command) {
  return [
    createSlashActionEntry(command, {
      keySuffix: 'open',
      title: 'Browse All Indexed Content',
      subtitle: 'Open the full Canvascope browser for everything already indexed.',
      meta: `${state.indexedContent.length} indexed item${state.indexedContent.length === 1 ? '' : 's'} available`,
      badge: 'Browse'
    })
  ];
}

function buildSlashGradescopeEntries(command) {
  return [
    createSlashActionEntry(command, {
      keySuffix: 'open',
      title: 'Open Gradescope',
      subtitle: 'Launch gradescope.com in a new tab.',
      meta: 'This opens Gradescope outside your LMS tab.',
      badge: 'Open'
    })
  ];
}

function getSlashCommandRegistry() {
  return [
    {
      order: 0,
      id: 'lectra-send',
      primaryAlias: 'ls',
      aliases: ['lectra', 'lectra-send'],
      title: 'Lectra Send',
      description: 'Find an indexed PDF and send it straight to Lectra.',
      keywords: ['pdf', 'send', 'lectra', 'annotate'],
      badge: 'Send',
      needsArgument: true,
      availability: getSlashLectraAvailability,
      getResults: buildSlashLectraEntries,
      execute: executeSlashLectraSend
    },
    {
      order: 1,
      id: 'gradescope',
      primaryAlias: 'gs',
      aliases: ['gradescope'],
      title: 'Open Gradescope',
      description: 'Open gradescope.com in a new tab.',
      keywords: ['gradescope', 'grade', 'open'],
      badge: 'Open',
      needsArgument: false,
      availability: () => ({ available: true }),
      getResults: buildSlashGradescopeEntries,
      execute: executeSlashGradescopeOpen
    },
    {
      order: 2,
      id: 'course',
      primaryAlias: 'course',
      aliases: ['class', 'courses'],
      title: 'Open Course',
      description: 'Jump straight into one of your indexed courses.',
      keywords: ['course', 'class', 'dashboard', 'open'],
      badge: 'Go',
      needsArgument: true,
      availability: () => ({ available: true }),
      getResults: buildSlashCourseEntries,
      execute: executeSlashCourseOpen
    },
    {
      order: 3,
      id: 'due',
      primaryAlias: 'due',
      aliases: ['todo', 'tasks'],
      title: 'Due Items',
      description: 'Browse upcoming and overdue work from your dashboard.',
      keywords: ['due', 'todo', 'task', 'assignment', 'quiz'],
      badge: 'View',
      needsArgument: true,
      availability: () => ({ available: true }),
      getResults: buildSlashDueEntries,
      execute: executeSlashDueOpen
    },
    {
      order: 4,
      id: 'refresh',
      primaryAlias: 'refresh',
      aliases: ['sync'],
      title: 'Refresh Index',
      description: 'Kick off a fresh Canvascope sync for the current LMS tab.',
      keywords: ['refresh', 'sync', 'scan', 'index'],
      badge: 'Sync',
      needsArgument: false,
      availability: () => ({ available: true }),
      getResults: buildSlashRefreshEntries,
      execute: executeSlashRefresh
    },
    {
      order: 5,
      id: 'browse',
      primaryAlias: 'browse',
      aliases: ['all'],
      title: 'Browse All Indexed Content',
      description: 'Open the all-content browser without leaving the popup.',
      keywords: ['browse', 'all', 'index', 'content'],
      badge: 'Browse',
      needsArgument: false,
      availability: () => ({ available: true }),
      getResults: buildSlashBrowseEntries,
      execute: executeSlashBrowse
    }
  ];
}

function getSlashCommandLookup() {
  return buildSlashCommandLookup(getSlashCommandRegistry());
}

function buildSlashCommandPaletteEntry(command) {
  const availability = typeof command.availability === 'function'
    ? command.availability()
    : { available: true };
  const subtitle = availability.available
    ? command.description
    : `${command.description} ${availability.reason || ''}`.trim();
  const meta = availability.available
    ? (command.needsArgument
      ? 'Press Enter or type a space to browse results.'
      : 'Press Enter to run this command.')
    : (availability.cta || 'Press Enter to open Settings.');

  return createSlashResultEntry({
    key: `command:${command.id}`,
    kind: 'command',
    title: `/${command.primaryAlias}`,
    subtitle,
    meta,
    badge: command.badge || 'Run',
    badgeClass: availability.available ? '' : 'badge-setup',
    ariaLabel: [`/${command.primaryAlias}`, command.title, subtitle, meta].filter(Boolean).join(', '),
    onSelect: () => handleSlashCommandPaletteSelect(command)
  });
}

function getSlashEmptyCopy(command, argumentText) {
  switch (command?.id) {
    case 'lectra-send':
      return argumentText.trim()
        ? `No indexed PDFs matched "${argumentText.trim()}".`
        : 'No indexed PDFs are ready to send yet.';
    case 'course':
      return argumentText.trim()
        ? `No indexed courses matched "${argumentText.trim()}".`
        : 'No indexed courses are available yet.';
    case 'due':
      return argumentText.trim()
        ? `No due items matched "${argumentText.trim()}".`
        : 'No upcoming due items are available right now.';
    default:
      return 'No slash results available.';
  }
}

function renderSlashFeedback() {
  if (!elements.slashFeedback) return;

  const feedback = state.slashMode.feedback;
  if (!feedback?.message) {
    elements.slashFeedback.classList.add('hidden');
    elements.slashFeedback.textContent = '';
    elements.slashFeedback.className = 'slash-feedback hidden';
    return;
  }

  elements.slashFeedback.className = `slash-feedback tone-${feedback.tone || 'info'}`;
  elements.slashFeedback.textContent = feedback.message;
  elements.slashFeedback.classList.remove('hidden');
}

function setSlashFeedback(message, tone = 'info') {
  state.slashMode.feedback = {
    message: String(message || '').trim(),
    tone
  };
  renderSlashFeedback();
}

function clearSlashFeedback() {
  state.slashMode.feedback = null;
  renderSlashFeedback();
}

function scrollSlashHighlightIntoView() {
  if (!elements.slashResults) return;
  const items = elements.slashResults.querySelectorAll('.slash-result-item');
  const activeItem = items[state.slashMode.highlightedIndex];
  activeItem?.scrollIntoView({ block: 'nearest' });
}

function renderSlashCommandSheet() {
  if (!state.slashMode.active || !elements.slashSheet || !elements.slashResults) {
    return;
  }

  const parsed = state.slashMode.parsed || parseSlashCommandText(state.slashMode.rawValue, getSlashCommandLookup());
  const commands = getSlashCommandRegistry();

  let title = 'Slash commands';
  let subtitle = 'Type a command or alias to jump into dashboard actions.';
  let entries = [];
  let emptyCopy = 'No commands matched that.';

  if (parsed.mode === 'commands') {
    const matchingCommands = rankSlashCommands(commands, parsed.commandQuery);
    entries = matchingCommands.map(buildSlashCommandPaletteEntry);
    if (parsed.commandQuery) {
      subtitle = 'Press Enter to run the highlighted command or open its result picker.';
      emptyCopy = `No commands matched "/${parsed.commandQuery}".`;
    }
  } else if (parsed.exactCommand) {
    const command = parsed.exactCommand;
    const availability = typeof command.availability === 'function'
      ? command.availability()
      : { available: true };
    title = `/${command.primaryAlias}`;
    subtitle = availability.available
      ? command.description
      : (availability.reason || command.description);
    entries = command.getResults(command, parsed.argumentText, availability) || [];
    emptyCopy = getSlashEmptyCopy(command, parsed.argumentText);
  }

  state.slashMode.results = entries;
  state.slashMode.highlightedIndex = entries.length > 0
    ? Math.max(0, Math.min(state.slashMode.highlightedIndex, entries.length - 1))
    : 0;

  if (elements.slashSheetTitle) elements.slashSheetTitle.textContent = title;
  if (elements.slashSheetSubtitle) elements.slashSheetSubtitle.textContent = subtitle;
  renderSlashFeedback();

  elements.slashResults.innerHTML = '';

  entries.forEach((entry, index) => {
    const itemButton = document.createElement('button');
    itemButton.type = 'button';
    itemButton.id = `slash-result-${index}`;
    itemButton.className = `slash-result-item kind-${entry.kind}${index === state.slashMode.highlightedIndex ? ' is-active' : ''}`;
    itemButton.setAttribute('role', 'option');
    itemButton.setAttribute('aria-selected', index === state.slashMode.highlightedIndex ? 'true' : 'false');
    itemButton.setAttribute('aria-label', entry.ariaLabel || entry.title);
    itemButton.addEventListener('mousedown', (event) => event.preventDefault());
    itemButton.addEventListener('click', () => {
      state.slashMode.highlightedIndex = index;
      renderSlashCommandSheet();
      void executeSlashEntry(entry);
    });

    const copy = document.createElement('div');
    copy.className = 'slash-result-copy';

    const titleRow = document.createElement('div');
    titleRow.className = 'slash-result-title-row';

    const titleEl = document.createElement('span');
    titleEl.className = 'slash-result-title';
    titleEl.textContent = entry.title || 'Untitled';
    titleRow.appendChild(titleEl);
    copy.appendChild(titleRow);

    if (entry.subtitle) {
      const subtitleEl = document.createElement('div');
      subtitleEl.className = 'slash-result-subtitle';
      subtitleEl.textContent = entry.subtitle;
      copy.appendChild(subtitleEl);
    }

    if (entry.meta) {
      const metaEl = document.createElement('div');
      metaEl.className = 'slash-result-meta';
      metaEl.textContent = entry.meta;
      copy.appendChild(metaEl);
    }

    itemButton.appendChild(copy);

    if (entry.badge) {
      const badgeEl = document.createElement('span');
      badgeEl.className = `slash-result-badge${entry.badgeClass ? ` ${entry.badgeClass}` : ''}`;
      badgeEl.textContent = entry.badge;
      itemButton.appendChild(badgeEl);
    }

    elements.slashResults.appendChild(itemButton);
  });

  if (entries.length > 0) {
    elements.slashResults.classList.remove('hidden');
    elements.slashEmpty.classList.add('hidden');
    elements.slashEmpty.textContent = '';
    const activeId = `slash-result-${state.slashMode.highlightedIndex}`;
    elements.searchInput?.setAttribute('aria-activedescendant', activeId);
    window.requestAnimationFrame(scrollSlashHighlightIntoView);
  } else {
    elements.slashResults.classList.add('hidden');
    elements.slashEmpty.classList.remove('hidden');
    elements.slashEmpty.textContent = emptyCopy;
    elements.searchInput?.removeAttribute('aria-activedescendant');
  }
}

function syncSlashModeFromRawInput(rawValue) {
  if (state.isOverlayMode) return false;

  const incomingValue = String(rawValue ?? '');
  if (!state.slashMode.active && !incomingValue.startsWith('/')) {
    return false;
  }

  if (state.searchTimeout) {
    clearTimeout(state.searchTimeout);
    state.searchTimeout = null;
  }

  const displayValue = incomingValue.startsWith('/') ? incomingValue.slice(1) : incomingValue;
  const nextRawValue = `/${displayValue}`;
  const previousRawValue = state.slashMode.rawValue;

  state.slashMode.active = true;
  state.slashMode.rawValue = nextRawValue;
  state.slashMode.parsed = parseSlashCommandText(nextRawValue, getSlashCommandLookup());

  if (incomingValue.startsWith('/')) {
    elements.searchInput.value = displayValue;
  }

  if (previousRawValue !== nextRawValue) {
    state.slashMode.highlightedIndex = 0;
    clearSlashFeedback();
  }

  applySlashModeUi();
  renderSlashCommandSheet();
  return true;
}

function exitSlashMode({ clearInput = true, focusInput = true } = {}) {
  const wasActive = state.slashMode.active;
  state.slashMode = createDefaultSlashModeState();

  if (state.searchTimeout) {
    clearTimeout(state.searchTimeout);
    state.searchTimeout = null;
  }

  if (clearInput && elements.searchInput) {
    elements.searchInput.value = '';
  }

  applySlashModeUi();
  clearSlashFeedback();

  if (wasActive) {
    if (clearInput || !elements.searchInput?.value.trim()) {
      if (!state.isScanning) {
        setUiState(UI_STATE.READY);
      } else {
        setUiState(UI_STATE.SCAN_SYNCING);
      }
    } else {
      performSearch(elements.searchInput.value.trim());
    }
  }

  if (focusInput) {
    elements.searchInput?.focus();
  }
}

function moveSlashHighlight(delta) {
  const count = state.slashMode.results.length;
  if (count === 0) return;

  state.slashMode.highlightedIndex = Math.max(0, Math.min(state.slashMode.highlightedIndex + delta, count - 1));
  renderSlashCommandSheet();
}

async function executeSlashEntry(entry) {
  if (!entry || typeof entry.onSelect !== 'function') return;
  try {
    await entry.onSelect();
  } catch (error) {
    console.error('[Canvascope] Slash command execution failed:', error);
    setSlashFeedback(getPopupErrorMessage(error, 'Slash command failed.'), 'error');
  }
}

async function executeSlashHighlightedEntry() {
  const entry = state.slashMode.results[state.slashMode.highlightedIndex];
  if (!entry) return;
  await executeSlashEntry(entry);
}

function handleSearchInputKeydown(e) {
  if (state.slashMode.active && !state.isOverlayMode) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void executeSlashHighlightedEntry();
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSlashHighlight(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
  }

  if (e.key === 'Enter') {
    e.preventDefault();

    // ADMIN COMMAND: Export local storage state
    if (elements.searchInput.value.trim() === '[ADMIN]EXPORTALLDATA') {
      elements.searchInput.value = '';
      chrome.storage.local.get(null, (allData) => {
        const sanitized = sanitizeAdminExport(allData);
        const dataStr = JSON.stringify(sanitized, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `canvascope_data_export_sanitized_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log('[Canvascope] Admin export generated (sanitized)');
      });
      return;
    }

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
}

function handleSlashCommandPaletteSelect(command) {
  if (!command) return;

  const availability = typeof command.availability === 'function'
    ? command.availability()
    : { available: true };

  if (command.needsArgument || !availability.available) {
    elements.searchInput.value = `${command.primaryAlias} `;
    syncSlashModeFromRawInput(elements.searchInput.value);
    return;
  }

  void command.execute(command, {});
}

async function executeSlashLectraSend(command, { item } = {}) {
  if (!item) return;

  setSlashFeedback(`Sending "${item.title || 'PDF'}" to Lectra...`, 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'sendPdfToLectra',
      trigger: 'popup_slash_ls',
      candidateUrl: item?.url || null,
      sourcePageUrl: item?.url || null,
      titleHint: item?.title || null
    });

    if (response?.success) {
      setSlashFeedback(`Sent "${item.title || 'PDF'}" to Lectra.`, 'success');
      showSyncedStatus('PDF sent to Lectra');
      return;
    }

    const failureMessage = String(response?.message || 'Send failed');
    showErrorStatus(failureMessage);
    setSlashFeedback(failureMessage, 'error');
  } catch (error) {
    const failureMessage = getPopupErrorMessage(error, 'Send failed');
    showErrorStatus(failureMessage);
    setSlashFeedback(failureMessage, 'error');
  }
}

async function executeSlashGradescopeOpen() {
  await chrome.tabs.create({ url: 'https://www.gradescope.com/', active: true });
  window.close();
}

function executeSlashCourseOpen(command, { item } = {}) {
  if (!item) return;
  openResult(item);
}

function executeSlashDueOpen(command, { item } = {}) {
  if (!item) return;
  openResult(item);
}

async function executeSlashRefresh() {
  if (state.isScanning) {
    setSlashFeedback('A refresh is already in progress.', 'info');
    return;
  }

  setSlashFeedback('Refreshing your dashboard index...', 'info');
  await handleRefresh();
  window.setTimeout(() => {
    exitSlashMode({ clearInput: true, focusInput: true });
  }, 320);
}

function executeSlashBrowse() {
  exitSlashMode({ clearInput: true, focusInput: false });
  openBrowseModal(elements.searchInput);
}

function handleResultsContainerClick(event) {
  const row = event.target.closest('.result-item');
  if (!row || !elements.resultsContainer.contains(row)) return;
  if (event.target.closest('.cs-pin-toggle, button, a, input, select, textarea')) return;
  if (row.__csItem) openResult(row.__csItem, event);
}

function handleResultsContainerKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('.result-item');
  if (!row || !elements.resultsContainer.contains(row)) return;
  if (!row.__csItem) return;
  event.preventDefault();
  openResult(row.__csItem, event);
}

function beginGoogleSignIn() {
  updateAuthButtonUi({ label: 'Signing in...', disabled: true });

  chrome.runtime.sendMessage({ type: 'signInWithGoogle' }, (response) => {
    if (response && response.success) {
      chrome.runtime.sendMessage({ type: 'checkAuthStatus' }, (statusRes) => {
        if (statusRes && statusRes.signedIn) {
          handleSignedInState(statusRes.user);
          return;
        }
        handleSignedOutState();
      });
      return;
    }

    console.error('Sign in failed:', response?.error);
    updateAuthButtonUi({ label: 'Sign in error' });
    setTimeout(() => updateAuthButtonUi(), 3000);
  });
}

function setupEventListeners() {
  elements.searchInput.addEventListener('input', handleSearchInput);
  elements.searchInput.addEventListener('focus', () => {
    showSearchHistory();
  });
  elements.searchInput.addEventListener('blur', () => {
    // Delay hiding to allow clicking on history items
    setTimeout(() => {
      // Don't hide if we clicked a history item (handled by click event)
    }, 200);
  });

  // Auth Integration
  if (elements.helpBtn) {
    elements.helpBtn.addEventListener('click', () => showHelpModal(elements.helpBtn));
  }

  if (elements.settingsBtn) {
    elements.settingsBtn.addEventListener('click', () => showSettingsModal(elements.settingsBtn));
  }

  if (elements.googleSignInBtn) {
    elements.googleSignInBtn.addEventListener('click', () => {
      if (state.isSignedIn) {
        showSettingsModal(elements.googleSignInBtn);
        return;
      }
      beginGoogleSignIn();
    });
  }

  // Account Modal Interaction
  if (elements.closeAccountModalBtn) {
    elements.closeAccountModalBtn.addEventListener('click', () => {
      closePopupModal('settingsModalOpen', elements.accountModal);
    });
  }

  if (elements.closeHelpModalBtn) {
    elements.closeHelpModalBtn.addEventListener('click', () => {
      closePopupModal('helpModalOpen', elements.helpModal);
    });
  }

  if (elements.settingsSigninBtn) {
    elements.settingsSigninBtn.addEventListener('click', () => {
      closePopupModal('settingsModalOpen', elements.accountModal);
      beginGoogleSignIn();
    });
  }

  if (elements.enableSendToLectraToggle) {
    elements.enableSendToLectraToggle.addEventListener('change', async (event) => {
      const toggle = event.currentTarget;
      const enabled = Boolean(toggle.checked);
      toggle.disabled = true;

      try {
        let fileAccessAllowed = false;

        if (enabled) {
          fileAccessAllowed = await getAllowedFileSchemeAccess();
        }

        await updateExtensionSettings({ enableSendToLectra: enabled });
        const syncResult = await syncPdfViewerOverlayRegistration(enabled ? 'popup-send-to-lectra-enabled' : 'popup-send-to-lectra-disabled');
        await refreshPdfFallbackAvailability();

        if (enabled) {
          if (syncResult?.enabled) {
            showSyncedStatus(
              fileAccessAllowed
                ? 'Website PDF viewer button enabled'
                : 'Website PDF button enabled. Local PDFs still need file URL access.'
            );
          } else {
            showErrorStatus(
              fileAccessAllowed
                ? 'PDF viewer overlay failed to register.'
                : 'PDF viewer overlay failed to register. Local PDFs also need file URL access.'
            );
          }
        }
      } catch (error) {
        console.error('[Canvascope] Failed to update settings:', error);
        applyExtensionSettingsUi();
      } finally {
        toggle.disabled = false;
      }
    });
  }

  if (elements.enableAdaptiveLearningToggle) {
    elements.enableAdaptiveLearningToggle.addEventListener('change', async (event) => {
      const toggle = event.currentTarget;
      const enabled = Boolean(toggle.checked);
      toggle.disabled = true;

      try {
        await updateExtensionSettings({ enableAdaptiveLearning: enabled });
        if (typeof debouncedSyncSearchHabits === 'function') {
          debouncedSyncSearchHabits();
        }
        if (typeof rerunSearchWithCurrentQuery === 'function') {
          rerunSearchWithCurrentQuery();
        }
      } catch (error) {
        console.error('[Canvascope] Failed to update adaptive learning setting:', error);
        applyExtensionSettingsUi();
      } finally {
        toggle.disabled = false;
      }
    });
  }

  if (elements.clearSearchHabitsBtn) {
    elements.clearSearchHabitsBtn.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      const prevText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Clearing...';

      try {
        const emptyHabits = createEmptySearchHabits();
        await chrome.storage.local.set({ searchHabits: emptyHabits });
        if (typeof state !== 'undefined' && state) {
          state.searchHabits = emptyHabits;
        }
        btn.textContent = 'Habits Cleared!';
        if (typeof debouncedSyncSearchHabits === 'function') {
          debouncedSyncSearchHabits();
        }
        if (typeof rerunSearchWithCurrentQuery === 'function') {
          rerunSearchWithCurrentQuery();
        }
        setTimeout(() => {
          btn.textContent = prevText;
          btn.disabled = false;
        }, 1500);
      } catch (error) {
        console.error('[Canvascope] Failed to wipe habits:', error);
        btn.textContent = 'Failed';
        setTimeout(() => {
          btn.textContent = prevText;
          btn.disabled = false;
        }, 1500);
      }
    });
  }

  if (elements.enableCustomAlgorithmToggle) {
    elements.enableCustomAlgorithmToggle.addEventListener('change', async (event) => {
      const toggle = event.currentTarget;
      const enabled = Boolean(toggle.checked);

      if (enabled && !window.confirm(CUSTOM_ALGORITHM_WARNING)) {
        toggle.checked = false;
        return;
      }

      toggle.disabled = true;

      try {
        await updateCustomAlgorithmSettings({ enabled });
        rerunSearchWithCurrentQuery();
      } catch (error) {
        console.error('[Canvascope] Failed to update custom algorithm settings:', error);
        applyExtensionSettingsUi();
      } finally {
        toggle.disabled = false;
      }
    });
  }

  if (elements.customAlgorithmSliders) {
    for (const slider of elements.customAlgorithmSliders) {
      slider.addEventListener('input', (event) => {
        const input = event.currentTarget;
        updateCustomAlgorithmValueLabel(input.dataset.algorithmSetting, Number(input.value));
      });

      slider.addEventListener('change', async (event) => {
        const input = event.currentTarget;
        const key = input.dataset.algorithmSetting;
        if (!key) return;

        input.disabled = true;

        try {
          await updateCustomAlgorithmSettings({ [key]: Number(input.value) });
          rerunSearchWithCurrentQuery();
        } catch (error) {
          console.error('[Canvascope] Failed to persist custom algorithm slider:', error);
          applyExtensionSettingsUi();
        } finally {
          input.disabled = false;
        }
      });
    }
  }

  if (elements.resetCustomAlgorithmBtn) {
    elements.resetCustomAlgorithmBtn.addEventListener('click', async () => {
      elements.resetCustomAlgorithmBtn.disabled = true;

      try {
        await updateCustomAlgorithmSettings({
          ...DEFAULT_CUSTOM_ALGORITHM,
          enabled: true
        });
        rerunSearchWithCurrentQuery();
      } catch (error) {
        console.error('[Canvascope] Failed to reset custom algorithm settings:', error);
        applyExtensionSettingsUi();
      } finally {
        elements.resetCustomAlgorithmBtn.disabled = false;
      }
    });
  }

  if (elements.logoutBtn) {
    elements.logoutBtn.addEventListener('click', () => {
      elements.logoutBtn.disabled = true;
      elements.logoutBtn.querySelector('.btn-text').textContent = 'Signing out...';

      chrome.runtime.sendMessage({ type: 'signOut' }, (response) => {
        elements.logoutBtn.disabled = false;
        elements.logoutBtn.querySelector('.btn-text').textContent = 'Sign out';

        if (response && response.success) {
          handleSignedOutState();
          closePopupModal('settingsModalOpen', elements.accountModal);
        } else {
          console.error('Sign out failed:', response?.error);
        }
      });
    });
  }

  // Keyboard navigation for search results
  elements.searchInput.addEventListener('keydown', handleSearchInputKeydown);
  elements.resultsContainer.addEventListener('click', handleResultsContainerClick);
  elements.resultsContainer.addEventListener('keydown', handleResultsContainerKeydown);

  // Close search history when clicking outside
  document.addEventListener('click', (e) => {
    // Slash click-outside handling removed — slash is now an in-page overlay

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

  elements.clearSearchBtn.addEventListener('click', () => {
    clearSearch();
  });
  elements.refreshBtn.addEventListener('click', handleRefresh);
  if (elements.sendPdfBtn) elements.sendPdfBtn.addEventListener('click', handleSendPdfFallback);
  if (elements.clearDataBtn) elements.clearDataBtn.addEventListener('click', handleClearData);
  if (elements.statsBtn) elements.statsBtn.addEventListener('click', openBrowseModal);
  if (elements.closeBrowse) elements.closeBrowse.addEventListener('click', closeBrowseModal);
  if (elements.exampleSearchButtons) {
    elements.exampleSearchButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const query = String(button.dataset.exampleQuery || '').trim();
        if (!query) return;
        closePopupModal('helpModalOpen', elements.helpModal);
        elements.searchInput.value = query;
        elements.clearSearchBtn.classList.add('visible');
        performSearch(query);
        elements.searchInput.focus();
      });
    });
  }

  // Custom Dropdown Listeners
  setupCustomDropdown(elements.courseWrapper, elements.courseTrigger, elements.courseOptions, 'course');
  setupCustomDropdown(elements.typeWrapper, elements.typeTrigger, elements.typeOptions, 'type');

  // Listen for background updates
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && closeTopModal()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
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
    if (filterType === 'course') {
      e.stopPropagation();

      const value = String(option.dataset.value || '').trim();
      const nextSelectedCourses = value
        ? (() => {
          const selectedCourses = new Set(normalizeSelectedCourseFilters(state.filters.course));
          if (selectedCourses.has(value)) {
            selectedCourses.delete(value);
          } else {
            selectedCourses.add(value);
          }
          return Array.from(selectedCourses);
        })()
        : [];

      void setSelectedCourseFilters(nextSelectedCourses);
      return;
    }

    selectOption(option, wrapper, optionsContainer, filterType);
  });

  // Keyboard Navigation
  let searchString = '';
  let searchTimeout = null;

  trigger.addEventListener('keydown', (e) => {
    if (filterType === 'course') {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        wrapper.classList.toggle('open');
        return;
      }

      if (e.key === 'Escape') {
        wrapper.classList.remove('open');
        trigger.focus();
      }
      return;
    }

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
  const text = option.dataset.label || option.textContent;

  if (filterType === 'course') {
    updateCourseFilterTriggerText();
  } else if (filterType === 'type' && elements.typeText) {
    elements.typeText.textContent = text;
  } else {
    wrapper.querySelector('span').textContent = text;
  }

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

async function mergeScannedContentIntoIndex(scannedContent) {
  if (!Array.isArray(scannedContent) || scannedContent.length === 0) return 0;

  const merged = deduplicateCrossType(deduplicateContent([
    ...state.indexedContent,
    ...scannedContent
  ]));
  const addedCount = Math.max(0, merged.length - state.indexedContent.length);

  state.indexedContent = merged;
  await chrome.storage.local.set({ indexedContent: merged });

  initializeFuse();
  updateUI();
  renderDuePlanner();
  renderHomeSections();

  return addedCount;
}

async function requestActiveTabContentScan() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !isValidLmsUrl(tab.url)) return;
    await chrome.tabs.sendMessage(tab.id, { action: 'startScan' });
  } catch (error) {
    console.log('[Canvascope] Active-tab content scan unavailable');
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

function resetSendPdfButtonState() {
  if (!elements.sendPdfBtn) return;
  elements.sendPdfBtn.disabled = false;
  elements.sendPdfBtn.querySelector('.btn-text').textContent = 'Send PDF to Lectra';
  elements.sendPdfBtn.style.backgroundColor = '';
  elements.sendPdfBtn.style.color = '';
  elements.sendPdfBtn.style.borderColor = '';
}

function setSendPdfButtonStatus(text, status = 'idle') {
  if (!elements.sendPdfBtn) return;

  elements.sendPdfBtn.querySelector('.btn-text').textContent = text;

  if (status === 'sending') {
    elements.sendPdfBtn.disabled = true;
    elements.sendPdfBtn.style.backgroundColor = 'rgba(33, 150, 243, 0.14)';
    elements.sendPdfBtn.style.borderColor = 'rgba(33, 150, 243, 0.35)';
    elements.sendPdfBtn.style.color = '#90CAF9';
    return;
  }

  if (status === 'success') {
    elements.sendPdfBtn.disabled = false;
    elements.sendPdfBtn.style.backgroundColor = 'rgba(76, 175, 80, 0.14)';
    elements.sendPdfBtn.style.borderColor = 'rgba(76, 175, 80, 0.35)';
    elements.sendPdfBtn.style.color = '#81C784';
    return;
  }

  if (status === 'error') {
    elements.sendPdfBtn.disabled = false;
    elements.sendPdfBtn.style.backgroundColor = 'rgba(244, 67, 54, 0.14)';
    elements.sendPdfBtn.style.borderColor = 'rgba(244, 67, 54, 0.35)';
    elements.sendPdfBtn.style.color = '#EF9A9A';
    return;
  }

  resetSendPdfButtonState();
}

async function refreshPdfFallbackAvailability() {
  if (!elements.sendPdfBtn) return;
  if (state.isOverlayMode) {
    elements.sendPdfBtn.classList.add('hidden');
    return;
  }

  if (!state.extensionSettings.enableSendToLectra) {
    state.activePdfContext = null;
    elements.sendPdfBtn.classList.add('hidden');
    elements.sendPdfBtn.title = '';
    resetSendPdfButtonState();
    return;
  }

  elements.sendPdfBtn.classList.remove('hidden');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'resolvePdfContext',
      mode: 'active_tab'
    });

    state.activePdfContext = response || null;
    const confidence = String(response?.confidence || 'none').toLowerCase();
    const hasPdf = Boolean(response?.hasPdf) && (confidence === 'definitive' || confidence === 'strong');
    if (hasPdf) {
      resetSendPdfButtonState();
      elements.sendPdfBtn.title = '';
    } else {
      resetSendPdfButtonState();
      elements.sendPdfBtn.title = await getPdfFallbackDisabledTitle();
      await runPdfViewerDebugProbe('refresh-pdf-fallback-no-context');
    }
  } catch (e) {
    state.activePdfContext = null;
    elements.sendPdfBtn.classList.remove('hidden');
    resetSendPdfButtonState();
    elements.sendPdfBtn.title = await getPdfFallbackDisabledTitle();
    await runPdfViewerDebugProbe('refresh-pdf-fallback-error');
  }
}

async function handleSendPdfFallback() {
  if (!elements.sendPdfBtn) return;
  if (!state.extensionSettings.enableSendToLectra) return;

  let context = state.activePdfContext;
  const confidence = String(context?.confidence || 'none').toLowerCase();
  const hasPdfContext = Boolean(context?.hasPdf) && (confidence === 'definitive' || confidence === 'strong');

  if (!hasPdfContext) {
    await refreshPdfFallbackAvailability();
    context = state.activePdfContext;
  }

  const refreshedConfidence = String(context?.confidence || 'none').toLowerCase();
  const hasPdf = Boolean(context?.hasPdf) && (refreshedConfidence === 'definitive' || refreshedConfidence === 'strong');
  if (!hasPdf) {
    setSendPdfButtonStatus('No PDF detected', 'error');
    setTimeout(() => resetSendPdfButtonState(), 1600);
    return;
  }

  const confirmed = confirm('Send this PDF to Lectra?');
  if (!confirmed) return;

  setSendPdfButtonStatus('Sending...', 'sending');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'sendPdfToLectra',
      trigger: 'popup_fallback',
      candidateUrl: context?.candidateUrl || null,
      sourcePageUrl: context?.sourcePageUrl || null,
      titleHint: context?.titleHint || null
    });

    if (response?.success) {
      setSendPdfButtonStatus('Sent to Lectra ✓', 'success');
      showSyncedStatus('PDF sent to Lectra');
      setTimeout(() => resetSendPdfButtonState(), 1800);
      return;
    }

    const failureMessage = String(response?.message || 'Send failed');
    console.warn('[Canvascope PDF Send] Failed', {
      code: response?.code || 'unknown',
      message: failureMessage
    });
    showErrorStatus(failureMessage);
    setSendPdfButtonStatus('Send failed', 'error');
    setTimeout(() => {
      resetSendPdfButtonState();
      refreshSyncStatus();
    }, 2600);
  } catch (e) {
    const failureMessage = e?.message ? String(e.message) : 'Send failed';
    console.warn('[Canvascope PDF Send] Unexpected failure', failureMessage);
    showErrorStatus(failureMessage);
    setSendPdfButtonStatus('Send failed', 'error');
    setTimeout(() => {
      resetSendPdfButtonState();
      refreshSyncStatus();
    }, 2600);
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
      if (Array.isArray(message.content)) {
        mergeScannedContentIntoIndex(message.content).then((addedCount) => {
          const statusCopy = addedCount > 0
            ? `Indexed ${addedCount} current-page item${addedCount === 1 ? '' : 's'}`
            : 'Current page checked';
          showSyncedStatus(statusCopy);
          if (state.slashMode.active) {
            renderSlashCommandSheet();
          }
        });
      } else {
        loadContent().then(() => {
          initializeFuse();
          updateUI();
          showSyncedStatus(`Added ${message.newItems} new items`);
          if (state.slashMode.active) {
            renderSlashCommandSheet();
          }
        });
      }
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
    if (elements.searchInput && elements.searchInput.value.trim() === '') {
      setUiState(UI_STATE.SCAN_SYNCING, 'Updating course index...');
    }
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
  state.isScanning = true;
  elements.syncIcon.textContent = '⟳';
  elements.syncIcon.classList.add('spinning');
  elements.syncText.textContent = 'Syncing...';
  elements.syncStatus.className = 'sync-status syncing';

  updateStats(); // Force stats UI to reflect scanning state

  if (elements.searchInput && elements.searchInput.value.trim() === '') {
    setUiState(UI_STATE.SCAN_SYNCING, 'Updating course index...');
  }
}

function showSyncedStatus(text = 'Synced') {
  state.isScanning = false;
  elements.syncIcon.textContent = '✓';
  elements.syncIcon.classList.remove('spinning');
  elements.syncText.textContent = text;
  elements.syncStatus.className = 'sync-status synced';

  if (elements.scanProgress) {
    elements.scanProgress.classList.add('hidden');
    elements.scanProgress.value = 0;
  }

  // Return to ready state if we were showing the scan loader
  if (currentUiState === UI_STATE.SCAN_SYNCING || currentUiState === UI_STATE.BOOT_LOADING) {
    setTimeout(() => {
      if (!state.isScanning && elements.searchInput.value.trim() === '') {
        setUiState(UI_STATE.READY);
      }
    }, 300); // 300ms minimum visible delay for flicker prevention
  }
}

function showErrorStatus(text = 'Sync failed') {
  elements.syncIcon.textContent = '!';
  elements.syncIcon.classList.remove('spinning');
  elements.syncText.textContent = text;
  elements.syncStatus.className = 'sync-status error';

  if (elements.scanProgress) elements.scanProgress.classList.add('hidden');

  if (currentUiState === UI_STATE.SCAN_SYNCING || currentUiState === UI_STATE.BOOT_LOADING) {
    setUiState(UI_STATE.ERROR, text);
  }
}

function updateScanProgress(progress, status) {
  elements.syncText.textContent = status || `Syncing... ${Math.round(progress)}%`;

  if (elements.scanProgress) {
    elements.scanProgress.classList.remove('hidden');
    elements.scanProgress.value = progress;
  }

  if (currentUiState === UI_STATE.SCAN_SYNCING) {
    elements.statusText.textContent = status || `Indexing courses...`;
  }
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
    item.searchPathNormalized = fields.searchPathNormalized;
    item.searchCourseNormalized = fields.searchCourseNormalized;
    item.searchRuntime = fields.searchRuntime;
  }

  if (state.filteredContent.length > 0) {
    const strictFuseOptions = buildFuseOptions();
    const relaxedFuseOptions = buildFuseOptions({ relaxed: true });
    state.fuse = new Fuse(state.filteredContent, strictFuseOptions);
    state.fuseRelaxed = new Fuse(state.filteredContent, relaxedFuseOptions);
  } else {
    state.fuse = null;
    state.fuseRelaxed = null;
  }
  populateCourseFilter();
}

function applyFilters() {
  state.filteredContent = state.indexedContent.filter(item => {
    if (!itemMatchesSelectedCourses(item)) return false;

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
    updateUI();
    showEmptyState();
  }
}

function populateCourseFilter() {
  const courses = new Set(normalizeSelectedCourseFilters(state.filters.course));

  // Extract unique courses
  state.indexedContent.forEach(item => {
    if (item.courseName) {
      courses.add(item.courseName.trim());
    }
  });

  // Pre-compute per-course assignment doneness (e.g., "12/14" graded/submitted)
  const doneness = computeCourseDoneness();

  // Rebuild the full option list so the checkbox state always matches the
  // persisted course selection, including classes that are currently saved
  // but may not be present in the latest index yet.
  elements.courseOptions.innerHTML = '';
  elements.courseOptions.appendChild(
    buildCourseOption('All Courses', {
      value: '',
      selected: state.filters.course.length === 0
    })
  );

  // Add course options
  Array.from(courses).sort().forEach(course => {
    // Skip invalid course names
    const isPersistedSelection = state.filters.course.includes(course);
    if (
      !isPersistedSelection &&
      (course === 'Dashboard' || course.startsWith('Announcements - ') || course.includes(' - '))
    ) return;

    elements.courseOptions.appendChild(
      buildCourseOption(course, {
        selected: state.filters.course.includes(course),
        doneness: doneness.get(course) || null
      })
    );
  });

  updateCourseFilterTriggerText();
}

function handleSearchInput(event) {
  const rawValue = String(event.target.value || '');

  const query = rawValue.trim();
  updateSearchFieldAffordances();
  hideSearchHistory();
  renderQuerySuggestions(query);

  if (state.searchTimeout) {
    clearTimeout(state.searchTimeout);
  }

  if (query.length === 0) {
    setUiState(state.isScanning ? UI_STATE.SCAN_SYNCING : UI_STATE.READY);
    showEmptyState(); // Ensure the planner reappears immediately
    if (state.isOverlayMode) showOverlayRecents();
    return;
  }

  state.searchTimeout = setTimeout(() => {
    performSearch(query);
  }, getSearchDebounceMs());
}

/**
 * Compute up to N historical queries that match the current input prefix.
 * Sourced from queryAffinity (highest aggregate click affinity wins).
 */
function getQuerySuggestions(prefix, limit = 3) {
  if (!state.extensionSettings?.enableAdaptiveLearning) return [];
  const habits = state.searchHabits;
  if (!habits || !habits.queryAffinity) return [];
  const cleanPrefix = String(prefix || '').toLowerCase().trim();
  if (cleanPrefix.length < 1) return [];

  const candidates = [];
  for (const [q, urlMap] of Object.entries(habits.queryAffinity)) {
    if (q === cleanPrefix) continue;            // skip exact match
    if (!q.startsWith(cleanPrefix)) continue;
    if (q.length < cleanPrefix.length + 1) continue;
    let score = 0;
    if (urlMap && typeof urlMap === 'object') {
      for (const v of Object.values(urlMap)) score += Number(v) || 0;
    }
    if (score <= 0) continue;
    candidates.push({ query: q, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.query.length - b.query.length);
  return candidates.slice(0, limit);
}

function renderQuerySuggestions(prefix) {
  const row = document.getElementById('cs-suggest-row');
  if (!row) return;
  if (state.isOverlayMode) { // overlay has its own results UI; skip noise
    row.classList.add('hidden');
    row.replaceChildren();
    return;
  }
  const suggestions = getQuerySuggestions(prefix, 3);
  if (suggestions.length === 0) {
    row.classList.add('hidden');
    row.replaceChildren();
    return;
  }
  row.replaceChildren();
  const cleanPrefix = String(prefix || '').toLowerCase().trim();
  for (const { query: q, score } of suggestions) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cs-suggest-chip';
    chip.setAttribute('role', 'option');
    chip.dataset.suggestion = q;

    // Match prefix gets muted; the rest is emphasized so the user sees what's new
    const matchSpan = document.createElement('span');
    matchSpan.className = 'cs-suggest-prefix';
    matchSpan.textContent = q.slice(0, cleanPrefix.length);
    chip.appendChild(matchSpan);

    const restSpan = document.createElement('span');
    restSpan.className = 'cs-suggest-rest';
    restSpan.textContent = q.slice(cleanPrefix.length);
    chip.appendChild(restSpan);

    if (score >= 2) {
      const meta = document.createElement('span');
      meta.className = 'cs-suggest-score';
      meta.textContent = `${score}×`;
      meta.title = `Opened ${score} time${score === 1 ? '' : 's'} from this query`;
      chip.appendChild(meta);
    }

    chip.addEventListener('click', () => applyQuerySuggestion(q));
    row.appendChild(chip);
  }
  row.classList.remove('hidden');
}

function applyQuerySuggestion(query) {
  if (!elements.searchInput) return;
  elements.searchInput.value = query;
  elements.searchInput.focus();
  if (elements.clearSearchBtn) elements.clearSearchBtn.classList.add('visible');
  hideQuerySuggestions();
  performSearch(query);
}

function hideQuerySuggestions() {
  const row = document.getElementById('cs-suggest-row');
  if (!row) return;
  row.classList.add('hidden');
  row.replaceChildren();
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

  // Detect temporal intent (with typo tolerance), then strip the time phrase
  // from the text query so lexical matching focuses on the actual subject tokens.
  const temporalIntent = detectTemporalIntent(normalizedQuery);
  if (temporalIntent.kind) {
    const stripped = temporalIntent.strippedQuery;
    if (stripped) {
      effectiveQuery = stripped;
      normalizedQuery = expandAbbreviations(stripped);
    }
  }

  const typoTolerantQuery = buildTypoTolerantQuery(normalizedQuery);
  const rankingQuery = typoTolerantQuery.corrections.length ? typoTolerantQuery.correctedQuery : normalizedQuery;
  const weeklyHabitBoostQuery = !temporalIntent.kind ? getWeeklyHabitBoostQuery(rankingQuery) : null;
  const queryMeta = buildSearchQueryMetadata({
    effectiveQuery,
    normalizedQuery,
    rankingQuery,
    weeklyHabitBoostQuery
  });
  trackAdaptiveQuerySubmission(query, queryMeta.rankingQuery);
  void loadBackendAdaptiveSuggestions();
  if (typoTolerantQuery.corrections.length > 0) {
    const correctionSummary = typoTolerantQuery.corrections.map(c => `${c.from}->${c.to}`).join(', ');
    console.log(`[Canvascope] Typo-tolerant query rewrite: "${normalizedQuery}" => "${rankingQuery}" (${correctionSummary})`);
  }

  // Derive search metadata once
  const intent = detectQueryIntent(queryMeta.rankingQuery);
  const queryNums = queryMeta.queryNums;
  const courseHintSignals = courseScope ? null : getCourseHintSignals(queryMeta.rankingQuery);
  const implicitCurrentWeekMode = detectImplicitCurrentWeekMode(
    queryMeta.rankingQuery,
    queryNums,
    courseScope,
    courseHintSignals,
    temporalIntent.kind
  );

  // Temporal-first retrieval: when query has a time intent, scope the corpus
  // before lexical ranking so relevant due items are never dropped by early truncation.
  // Fall back to the full corpus if temporal pre-filtering yields nothing, so the
  // subsequent temporal fallback paths at applyTemporalFilter still have items to work with.
  let temporalCorpus;
  if (temporalIntent.kind) {
    const filtered = filterItemsByTemporalWindow(state.filteredContent, temporalIntent.kind);
    temporalCorpus = filtered.length > 0 ? filtered : state.filteredContent;
  } else {
    temporalCorpus = state.filteredContent;
  }
  const searchCorpus = courseScope
    ? temporalCorpus.filter(item => itemMatchesCourseScope(item, courseScope))
    : temporalCorpus;

  if (searchCorpus.length === 0) {
    showNoResults(`No results for "${query}"`);
    updateOverlayFooter(0, 0);
    return;
  }

  const useScopedFuse = Boolean(temporalIntent.kind || courseScope);
  const activeFuse = useScopedFuse ? new Fuse(searchCorpus, buildFuseOptions()) : state.fuse;
  const activeFuseRelaxed = useScopedFuse ? new Fuse(searchCorpus, buildFuseOptions({ relaxed: true })) : state.fuseRelaxed;
  const fuseResultLimit = temporalIntent.kind ? (MAX_RESULTS * 20) : (MAX_RESULTS * 12);

  const searchStart = performance.now();

  // ── Exact/prefix pre-pass ──────────────────────────
  const prePassHits = [];
  const prePassUrls = new Set();

  for (const item of searchCorpus) {
    const runtime = getItemSearchRuntime(item);
    const nt = runtime.titleText;

    let bestBaseScore = null;

    // Check against the corrected, expanded, and raw query variants.
    for (const q of queryMeta.searchQueries) {
      if (!q) continue;

      let score = null;
      if (nt === q) {
        score = 0.0;
      } else if (nt.startsWith(q + ' ') || nt.startsWith(q)) {
        score = 0.05;
      }

      if (score !== null && (bestBaseScore === null || score < bestBaseScore)) {
        bestBaseScore = score;
      }
    }

    if (bestBaseScore !== null) {
      prePassHits.push({ item, score: bestBaseScore, prePass: true });
      prePassUrls.add(item.url);
    }
  }

  // ── Fuse pass A: strict ────────────────────────────
  let fuseResults = [];
  const seenFuseUrls = new Set();
  const appendFuseResults = (fuseInstance) => {
    for (const q of queryMeta.searchQueries) {
      // Pull more broadly for temporal searches, but keep the default live-search
      // window smaller because lexical recall already fills gaps for harder queries.
      const nextResults = fuseInstance.search(q, { limit: fuseResultLimit });
      for (const r of nextResults) {
        if (!seenFuseUrls.has(r.item.url)) {
          fuseResults.push(r);
          seenFuseUrls.add(r.item.url);
        }
      }
    }
  };
  appendFuseResults(activeFuse);

  // ── Fuse pass B: relaxed fallback ──────────────────
  if (fuseResults.length === 0 && activeFuseRelaxed) {
    appendFuseResults(activeFuseRelaxed);
  }

  // ── Merge pre-pass + Fuse (dedup by URL) ───────────
  let results = [...prePassHits];
  for (const r of fuseResults) {
    if (!prePassUrls.has(r.item.url)) {
      results.push(r);
    }
  }

  const shouldRunExhaustiveRecall = queryMeta.searchTokens.length >= 3
    || Boolean(courseScope)
    || queryMeta.queryLooksPathOriented
    || (queryMeta.hasExplicitTaskQualifier && queryMeta.hasSpecificRecallSignal)
    || results.length < MAX_RESULTS;

  // ── Lexical Fallback pass & RRF Fusion ─────────────
  // Only run the full-corpus literal scan when the main retrieval path is likely
  // to need help. This keeps Cmd+K responsive on short queries.
  if (queryMeta.searchTokens.length > 0 && shouldRunExhaustiveRecall) {
    const lexicalResults = [];
    for (const item of searchCorpus) {
      if (prePassUrls.has(item.url)) continue;
      const runtime = getItemSearchRuntime(item);
      const matchedTokens = countMatchedQueryTokens(
        runtime.searchableText,
        queryMeta.searchTokens,
        queryMeta.searchTokenMatchers
      );
      if (matchedTokens === queryMeta.searchTokens.length) {
        lexicalResults.push({ item, score: 0.2, prePass: false });
      }
    }

    // Sort lexical results by length of title to prefer shorter matching titles (Occam's razor)
    lexicalResults.sort((a, b) => {
      const aTitleLength = getItemSearchRuntime(a.item).titleText.length;
      const bTitleLength = getItemSearchRuntime(b.item).titleText.length;
      return aTitleLength - bTitleLength;
    });

    // RRF Fusion: Fuse vs Lexical
    const RRF_K = 60;
    const rrfScores = new Map();

    // Fuse Ranks
    fuseResults.forEach((r, i) => {
      rrfScores.set(r.item.url, (rrfScores.get(r.item.url) || 0) + (1 / (RRF_K + i + 1)));
    });

    // Lexical Ranks
    lexicalResults.forEach((r, i) => {
      rrfScores.set(r.item.url, (rrfScores.get(r.item.url) || 0) + (1 / (RRF_K + i + 1)));
    });

    const shouldInjectLexicalRecall = queryMeta.searchTokens.length >= 3
      || queryMeta.searchTokens.some(t => !BROAD_QUERY_TOKENS.has(t));
    if (shouldInjectLexicalRecall) {
      const seenResultUrls = new Set(results.map(r => r.item.url));
      for (const r of lexicalResults) {
        if (!seenResultUrls.has(r.item.url)) {
          results.push(r);
          seenResultUrls.add(r.item.url);
        }
      }
    }

    // Re-assign unified scores to the mapped fuse results before they enter standard ranker
    for (const r of results) {
      if (r.prePass) continue; // let exact prefix match sail through
      const rrfMatchScore = rrfScores.get(r.item.url);
      if (rrfMatchScore !== undefined) {
        // scale RRF (max ~0.033) to behave somewhat like fuse score (0.0 to 1.0)
        // roughly RRF * 30 will map top rank to ~0.9
        r.score = Math.max(0, 1.0 - (rrfMatchScore * 20));
      }
    }
  }

  // If course-scoped, ensure items from the target course are in the pool
  if (courseScope) {
    const prefix = courseScope.coursePrefix;
    const seenUrls = new Set(results.map(r => r.item.url));
    const coursePrefixMatcher = new RegExp(`^${prefix}(\\s|$)`);

    // Secondary recall: scan target course items for query token matches
    // in title + folderPath + moduleName (catches folder-name matches)
    if (queryMeta.searchTokens.length > 0 && shouldRunExhaustiveRecall) {
      for (const item of searchCorpus) {
        if (seenUrls.has(item.url)) continue;
        const runtime = getItemSearchRuntime(item);
        const itemCourse = runtime.courseText;
        // Require word boundary after prefix to prevent "chem 3al" matching "chem 3a"
        if (!coursePrefixMatcher.test(itemCourse)) continue;

        const hits = countMatchedQueryTokens(
          runtime.searchableText,
          queryMeta.searchTokens,
          queryMeta.searchTokenMatchers
        );
        // Require at least half the tokens to match
        if (hits >= Math.ceil(queryMeta.searchTokens.length / 2)) {
          results.push({ item, score: 0.5, prePass: false, courseRecall: true });
          seenUrls.add(item.url);
        }
      }
    }

    // Now filter to only course-scoped results
    const scopedResults = results.filter(r => {
      const itemCourse = getItemSearchRuntime(r.item).courseText;
      return coursePrefixMatcher.test(itemCourse);
    });
    if (scopedResults.length > 0) {
      results = scopedResults;
    }
  }

  if (!courseScope && courseHintSignals?.hasHint) {
    const hintedResults = results.filter(r => itemMatchesCourseHints(r.item, courseHintSignals));
    if (hintedResults.length > 0) {
      results = hintedResults;
    }
  }

  const implicitCurrentWeekContext = !temporalIntent.kind
    ? buildImplicitCurrentWeekContext(searchCorpus, queryMeta.rankingQuery, courseScope, courseHintSignals, implicitCurrentWeekMode)
    : { enabled: false, extraResults: [], anchorGroupOrder: new Map() };

  if (implicitCurrentWeekContext.enabled) {
    results = mergeSearchResults(results, implicitCurrentWeekContext.extraResults);
  }

  if (temporalIntent.kind) {
    let temporalResults = applyTemporalFilter(results, temporalIntent.kind);

    // Ensure broad temporal queries (e.g. "lab this week") don't lose relevant items
    // due to retrieval/ranking truncation.
    const broadTokens = queryMeta.generalTokens;
    if (broadTokens.length <= 1) {
      const recallSeed = [];
      for (const item of searchCorpus) {
        const runtime = getItemSearchRuntime(item);
        const searchable = [runtime.titleText, runtime.pathText, runtime.moduleText].filter(Boolean).join(' ');

        const matchesBroadToken = broadTokens.length === 0
          || broadTokens.every(t => textIncludesQueryToken(searchable, t, queryMeta.searchTokenMatchers));
        if (matchesBroadToken) {
          recallSeed.push({ item, score: 0.55, prePass: false, temporalRecall: true });
        }
      }

      const merged = new Map();
      for (const r of temporalResults) merged.set(r.item.url, r);
      for (const r of recallSeed) {
        if (!merged.has(r.item.url)) merged.set(r.item.url, r);
      }
      temporalResults = Array.from(merged.values());
    }

    // If user queried only a time phrase (e.g., "this week"), search pipeline may
    // have little/no lexical signal. Fall back to all indexed items, then filter by time.
    if (temporalResults.length === 0 && (!normalizedQuery || normalizedQuery.length === 0)) {
      const temporalSeed = searchCorpus.map(item => ({ item, score: 0.5, prePass: false }));
      temporalResults = applyTemporalFilter(temporalSeed, temporalIntent.kind);
    }

    temporalResults = expandTemporalLabSiblings(temporalResults, queryMeta.rankingQuery, courseScope);

    if (courseScope) {
      temporalResults = temporalResults.filter(r => itemMatchesCourseScope(r.item, courseScope));
    } else if (courseHintSignals?.hasHint) {
      const hintedTemporalResults = temporalResults.filter(r => itemMatchesCourseHints(r.item, courseHintSignals));
      if (hintedTemporalResults.length > 0) {
        temporalResults = hintedTemporalResults;
      }
    }

    results = temporalResults;
  }

  const searchTimeMs = Math.round(performance.now() - searchStart);

  // Transition to searching state
  if (currentUiState !== UI_STATE.SEARCHING) {
    setUiState(UI_STATE.SEARCHING);
  }

  if (results.length === 0) {
    showNoResults(`No results for "${query}"`);
    updateOverlayFooter(0, searchTimeMs);
    return;
  }

  // Apply full ranking pipeline (intent, numeric, coverage, click, due, diversity)
  results = rankResults(results, queryMeta, intent);

  // Hard ordering rule for temporal queries: upcoming/future items before overdue.
  if (temporalIntent.kind) {
    const nowTs = Date.now();
    const withDue = [];
    const noDue = [];

    for (const r of results) {
      const dueTs = parseDueTs(r.item);
      if (dueTs > 0) withDue.push({ r, dueTs });
      else noDue.push(r);
    }

    withDue.sort((a, b) => {
      const aCompleted = isCompletedTask(a.r.item);
      const bCompleted = isCompletedTask(b.r.item);
      if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;

      const aFuture = a.dueTs >= nowTs;
      const bFuture = b.dueTs >= nowTs;

      if (aFuture !== bFuture) return aFuture ? -1 : 1; // future first

      // both future: sooner due first
      if (aFuture && bFuture) return a.dueTs - b.dueTs;

      // both overdue: less overdue first
      return b.dueTs - a.dueTs;
    });

    results = [...withDue.map(x => x.r), ...noDue];
  }

  const isGeneralQuery = !temporalIntent.kind
    && queryNums.length === 0
    && queryMeta.generalTokens.length <= 3
    && !queryMeta.hasExplicitTaskQualifier;
  const topIsExactMatch = results.length > 0 && results[0].prePass;

  if (implicitCurrentWeekContext.enabled) {
    results = applyImplicitCurrentWeekOrdering(results, implicitCurrentWeekContext);
  } else if (isGeneralQuery && !topIsExactMatch) {
    // Preserve the older broad-query sort for non-implicit searches.
    const recencyCandidates = [];
    const otherResults = [];

    for (const r of results) {
      const type = String(r.item?.type || '').toLowerCase();
      const dueTs = parseDueTs(r.item);
      const isTaskLike = type === 'assignment' || type === 'quiz' || type === 'discussion';
      if (isTaskLike && dueTs > 0) {
        recencyCandidates.push({ r, dueTs });
      } else {
        otherResults.push(r);
      }
    }

    // Actionable due order: unfinished upcoming work first, sooner before later.
    // Completed items still stay behind unfinished work.
    const nowTs = Date.now();
    recencyCandidates.sort((a, b) => {
      const aCompleted = isCompletedTask(a.r.item);
      const bCompleted = isCompletedTask(b.r.item);
      if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;

      const aFuture = a.dueTs >= nowTs;
      const bFuture = b.dueTs >= nowTs;
      if (aFuture !== bFuture) return aFuture ? -1 : 1;
      if (aFuture) return a.dueTs - b.dueTs;
      return b.dueTs - a.dueTs;
    });
    results = [...recencyCandidates.map(x => x.r), ...otherResults];
  }

  results = results.slice(0, MAX_RESULTS);

  state.lastSearchTimeMs = searchTimeMs;
  state.lastResultCount = results.length;

  displayResults(results);
  updateOverlayFooter(results.length, searchTimeMs);

  // Single-line diagnostic
  console.log(`[Canvascope] query="${query}" intent=${JSON.stringify(intent)} nums=[${queryNums}] implicitWeek=${implicitCurrentWeekContext.enabled} weeklyBoost="${weeklyHabitBoostQuery || ''}" results=${results.length} ${searchTimeMs}ms`);

  // Save to history (original query, not normalized)
  saveSearchToHistory(query);
}

/**
 * Calculate custom score combining Fuse score with type, recency, position,
 * intent, numeric, coverage, click-feedback, due-date, and active-course boosts.
 */
function calculateScore(item, fuseScore, queryMeta, intent, isPrePass, algorithm) {
  const tuning = algorithm || getActiveSearchAlgorithm();
  const typeMultiplier = tuning.typeBoost / 100;
  const recencyMultiplier = tuning.recencyBoost / 100;
  const courseMultiplier = tuning.courseBoost / 100;
  const dueDateMultiplier = tuning.dueDateBoost / 100;
  const contextMultiplier = tuning.contextWeight / 100;
  const runtime = getItemSearchRuntime(item);
  const normalizedQuery = queryMeta?.rankingQuery || '';
  const queryNums = queryMeta?.queryNums || [];
  const queryTokens = queryMeta?.meaningfulTokens || [];
  const pathSearchText = runtime.pathSearchText || getPathSearchText(item);
  const pathCoverage = queryTokens.length > 0
    ? (countTokenHits(queryTokens, pathSearchText, queryMeta?.meaningfulTokenMatchers) / queryTokens.length)
    : 0;
  const queryLooksFileSpecific = Boolean(queryMeta?.queryLooksFileSpecific);
  const queryLooksPathOriented = Boolean(queryMeta?.queryLooksPathOriented);
  const queryWeekHints = queryMeta?.queryWeekHints || [];
  const itemWeekHints = runtime.weekHints?.length ? runtime.weekHints : getItemWeekHints(item);

  // Base: invert Fuse score. Pre-pass items use their calculated baseScore (0.0 is perfect)
  let score;
  if (isPrePass && fuseScore !== undefined) {
    // Exact/prefix match tier: massive 10.0 base score so they always beat fuzzy matches
    score = 10.0 - fuseScore;
  } else {
    // Fuzzy match tier: 1.0 base score
    score = 1.0 - fuseScore;
  }

  // ── Type boost (0.05–0.30) ──────────────────────
  score += (TYPE_BOOST[item.type] || 0) * typeMultiplier;

  // ── Recency boost (scannedAt) ───────────────────
  const ts = item.scannedAt ? Date.parse(item.scannedAt) : 0;
  if (ts > 0) {
    const daysAgo = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 0.15 - (daysAgo * 0.005)) * recencyMultiplier;
  }

  // ── Suffix / position boost ─────────────────────
  if (normalizedQuery && normalizedQuery.length > 0) {
    const normTitle = runtime.titleText;
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

  // ── Intent boost (capped at INTENT_CAP = 0.40) ──
  if (intent) {
    let intentBoost = 0;
    for (const [key, confidence] of Object.entries(intent)) {
      if (key === 'recency') continue;
      if (confidence > 0 && INTENT_TYPE_MAP[key]) {
        const matches = INTENT_TYPE_MAP[key].includes(item.type);
        if (matches) intentBoost += INTENT_MAX_BOOST[key] * confidence;
      }
    }
    score += Math.min(intentBoost, INTENT_CAP);

    // ── Explicit Recency Boost ("latest", "newest") ──
    if (intent.recency > 0) {
      let fileTs = null;
      if (item.createdAt || item.updatedAt) {
        fileTs = Date.parse(item.updatedAt || item.createdAt);
      } else if (item.dueAt) {
        fileTs = Date.parse(item.dueAt);
      }

      if (fileTs && fileTs > 0 && fileTs <= Date.now()) {
        const daysAgo = (Date.now() - fileTs) / (1000 * 60 * 60 * 24);
        // Aggressive curve: files under 7 days old get massive boost
        if (daysAgo <= 7) {
          score += 0.50 + Math.max(0, 0.40 * (1 - daysAgo / 7));
        } else if (daysAgo <= 30) {
          score += 0.20 + Math.max(0, 0.30 * (1 - (daysAgo - 7) / 23));
        } else {
          score += Math.max(0, 0.20 * (365 - daysAgo) / 365);
        }
      }
    }
  }

  // ── Numeric alignment ───────────────────────────
  if (queryNums && queryNums.length > 0) {
    const { aligned, mismatched } = computeNumericAlignment(queryNums, runtime.titleNums);
    if (aligned > 0) score += 0.10 * (aligned / queryNums.length);
    if (mismatched > 0) score -= 0.50 * (mismatched / queryNums.length); // Severe penalty for mismatch
  }

  // ── Token coverage ──────────────────────────────
  if (normalizedQuery) {
    const coverage = queryTokens.length > 0
      ? (countBoundaryMatches(
        `${runtime.titleText} ${runtime.contextText}`,
        queryTokens,
        queryMeta?.meaningfulTokenMatchers
      ) / queryTokens.length)
      : 1;
    const qTokenCount = queryTokens.length;
    if (coverage >= 0.8) {
      score += 0.12;
    } else if (coverage < 0.5 && qTokenCount >= 2) {
      score -= 0.15 * (1 - coverage);
    }
  }

  // ── Active-course prior ─────────────────────────
  score += getActiveCourseBoost(item) * courseMultiplier;

  // ── Starred-course boost ────────────────────────
  score += getStarredCourseBoost(item) * courseMultiplier;

  // ── Query course-hint boost (e.g., "bio lab this week") ──
  score += getQueryCourseHintBoost(item, normalizedQuery) * courseMultiplier;

  // ── Folder-context boost ────────────────────────
  if (normalizedQuery && queryTokens.length > 0 && (item.folderPath || item.moduleName || item.type === 'syllabus')) {
    if (pathCoverage > 0) {
      score += Math.min(0.38, 0.30 * pathCoverage) * contextMultiplier;
    }

    if (queryLooksPathOriented) {
      if (item.type === 'folder' && pathCoverage >= 0.45) {
        score += (0.72 + (pathCoverage * 0.18)) * contextMultiplier;
      } else if (LEAF_FILE_TYPES.has(String(item.type || '').toLowerCase()) && pathCoverage >= 0.45 && !queryLooksFileSpecific) {
        score -= 0.18;
      }
    }

    if (queryLooksFileSpecific && LEAF_FILE_TYPES.has(String(item.type || '').toLowerCase())) {
      score += 0.26;
    } else if (queryLooksFileSpecific && item.type === 'folder') {
      score -= 0.10;
    }
  }

  // ── Key-like content preference ─────────────────
  if (runtime.keyLike) {
    if (queryMeta?.wantsKeyLikeContent) {
      score += 0.08;
    } else {
      score -= 0.18;
    }
  }

  // ── Explicit week matching + weak timestamp fallback ─────────────
  if (queryWeekHints.length > 0) {
    const overlapsWeekHint = itemWeekHints.some(hint => queryWeekHints.includes(hint));
    if (overlapsWeekHint) {
      score += item.type === 'folder' ? 0.34 : 0.18;
    } else if (itemWeekHints.length > 0) {
      score -= 0.25;
    } else if (item.createdAt || item.updatedAt) {
      score += 0.03;
    }
  }

  // ── Syllabus intent boost ───────────────────────
  if (isSyllabusQuery(normalizedQuery)) {
    if (item.type === 'syllabus') {
      score += 1.1;
    } else if (item.type === 'course' || item.type === 'navigation' || item.type === 'page') {
      score -= 0.18;
    }
  }

  // ── Un-clicked Files/Folders Penalty ────────────
  // Penalize folders and documents by default so interactive elements (assignments/quizzes) stay on top,
  // until the adaptive algorithm's query behavior provides enough boost (2+ clicks).
  if (['folder', 'file', 'pdf', 'video', 'externalurl'].includes(item.type)) {
    score -= 0.65;
  }

  // ── Adaptive Learning ML & Click-Feedback ────────
  score += getAdaptiveLearningBoost(item, normalizedQuery);

  // ── Dismissed Tasks penalty ─────────────────────
  if (state.dismissedTasks && state.dismissedTasks.includes(item.url)) {
    score -= 0.4;
  }

  // ── Completed-task penalty ──────────────────────
  if (isCompletedTask(item)) {
    score -= 0.9;
  }

  // ── Due-date-aware freshness (future > overdue) ────────────────────
  if (item.dueAt) {
    const dueTs = Date.parse(item.dueAt);
    if (dueTs > 0) {
      const daysUntilDue = (dueTs - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysUntilDue >= 0 && daysUntilDue <= 21) {
        // Upcoming: overwhelming boost so generic queries show actionable items first (up to 1.4 for today)
        score += Math.max(0.20, 1.4 - daysUntilDue * 0.08) * dueDateMultiplier;
      } else if (daysUntilDue < 0 && daysUntilDue > -30) {
        // Overdue: explicit penalty so future tasks sort above overdue ones
        score -= Math.min(0.55, 0.22 + Math.abs(daysUntilDue) * 0.03) * dueDateMultiplier;
      }
    }
  }

  return score;
}

function areNearIdenticalCourseResults(leftItem, rightItem) {
  const leftRuntime = getItemSearchRuntime(leftItem);
  const rightRuntime = getItemSearchRuntime(rightItem);
  if (!leftRuntime.courseText || leftRuntime.courseText !== rightRuntime.courseText) return false;

  const leftComparable = leftRuntime.comparableTitle || leftRuntime.titleText;
  const rightComparable = rightRuntime.comparableTitle || rightRuntime.titleText;
  if (!leftComparable || !rightComparable) return false;

  if (leftRuntime.titleText === rightRuntime.titleText) return true;
  if (leftComparable === rightComparable) return true;

  const shorter = leftComparable.length <= rightComparable.length ? leftComparable : rightComparable;
  const longer = shorter === leftComparable ? rightComparable : leftComparable;
  return shorter.length >= 18 && longer.includes(shorter);
}

function compareRankedSearchResults(left, right, queryMeta) {
  const leftRuntime = getItemSearchRuntime(left.item);
  const rightRuntime = getItemSearchRuntime(right.item);
  const preferredKeyLikeState = Boolean(queryMeta?.wantsKeyLikeContent);

  if (leftRuntime.keyLike !== rightRuntime.keyLike
    && areNearIdenticalCourseResults(left.item, right.item)
    && Math.abs(left.finalScore - right.finalScore) < 0.35) {
    return leftRuntime.keyLike === preferredKeyLikeState ? -1 : 1;
  }

  if (right.finalScore !== left.finalScore) {
    return right.finalScore - left.finalScore;
  }

  return leftRuntime.titleText.localeCompare(rightRuntime.titleText);
}

/**
 * Re-rank results using full scoring pipeline + diversity pass
 */
function rankResults(results, queryMeta, intent) {
  const algorithm = getActiveSearchAlgorithm();
  const scored = results
    .map(r => {
      const finalScore = calculateScore(r.item, r.score, queryMeta, intent, !!r.prePass, algorithm);
      return {
        ...r,
        finalScore
      };
    })
    .sort((a, b) => compareRankedSearchResults(a, b, queryMeta));

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

function appendSearchHistoryEntry(container, query, { badgeText = '', suggestionMeta = null } = {}) {
  const historyItem = document.createElement('div');
  historyItem.className = 'history-item';
  historyItem.setAttribute('tabindex', '0');
  historyItem.setAttribute('role', 'button');

  if (badgeText) {
    const label = document.createElement('span');
    label.textContent = query;
    historyItem.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'history-badge';
    badge.textContent = badgeText;
    historyItem.appendChild(badge);
  } else {
    historyItem.textContent = query;
  }

  const runQuery = () => {
    if (suggestionMeta) {
      void recordAdaptiveSearchEvent('suggestion_clicked', query, {
        baseQuery: suggestionMeta.baseQuery,
        sequenceNumber: suggestionMeta.predictedWeekNumber
      });
    }
    elements.searchInput.value = query;
    hideSearchHistory();
    performSearch(query);
  };

  historyItem.addEventListener('click', runQuery);
  historyItem.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      runQuery();
    }
  });

  container.appendChild(historyItem);
}

function showSearchHistory() {
  if (state.slashMode.active) return;
  if (!state.isOverlayMode) return;

  const query = elements.searchInput.value.trim();
  const slotKey = getWeeklyHabitSlotKey();
  const shouldRefreshBackendSuggestions = query.length === 0
    && !state.backendAdaptiveSuggestionsPending
    && (
      !state.backendAdaptiveSuggestionsLoadedAt
      || (Date.now() - state.backendAdaptiveSuggestionsLoadedAt) > BACKEND_SUGGESTION_STALE_MS
      || state.backendAdaptiveSuggestionsSlotKey !== slotKey
    );

  if (shouldRefreshBackendSuggestions) {
    void loadBackendAdaptiveSuggestions().then(() => {
      if (elements.searchInput && elements.searchInput.value.trim() === '') {
        showSearchHistory();
      }
    });
  }

  const suggestionEntries = getAdaptiveSuggestionEntries()
    .filter((entry, index, all) => entry && all.findIndex(candidate => candidate.query === entry.query) === index);
  const suggestedQueries = suggestionEntries.map((entry) => entry.query);

  if (query.length > 0 || (state.searchHistory.length === 0 && suggestedQueries.length === 0)) {
    hideSearchHistory();
    return;
  }

  elements.searchHistory.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'history-header';
  header.innerHTML = '<span>Recent Searches</span><button class="history-clear">Clear</button>';
  header.querySelector('.history-clear').addEventListener('click', clearSearchHistory);

  if (suggestedQueries.length > 0) {
    const suggestionHeader = document.createElement('div');
    suggestionHeader.className = 'history-header';
    suggestionHeader.innerHTML = '<span>Suggested This Week</span>';
    elements.searchHistory.appendChild(suggestionHeader);

    for (const suggestion of suggestionEntries.slice(0, 4)) {
      appendSearchHistoryEntry(elements.searchHistory, suggestion.query, {
        badgeText: 'Suggested',
        suggestionMeta: suggestion.source === 'backend' ? suggestion : null
      });
    }
  }

  elements.searchHistory.appendChild(header);

  const seenHistoryQueries = new Set(suggestedQueries);
  state.searchHistory.forEach(item => {
    if (!item?.query || seenHistoryQueries.has(item.query)) return;
    appendSearchHistoryEntry(elements.searchHistory, item.query);
  });

  reportBackendSuggestionImpressions(suggestionEntries);

  // Hide empty state and planner, show history in its place
  if (elements.emptyState) elements.emptyState.classList.add('hidden');
  if (elements.homeSections) elements.homeSections.classList.add('hidden');
  if (elements.duePlanner) elements.duePlanner.classList.add('hidden');

  elements.searchHistory.classList.remove('hidden');
}

function hideSearchHistory() {
  elements.searchHistory.classList.add('hidden');

  // Restore empty state / planner if no search results are showing
  if (elements.searchInput && elements.searchInput.value.trim() === '') {
    // Force transition to reset planner visibility properly
    setUiState(state.isScanning ? UI_STATE.SCAN_SYNCING : UI_STATE.READY);
  }
}

async function clearSearchHistory() {
  state.searchHistory = [];
  await chrome.storage.local.set({ searchHistory: [] });
  hideSearchHistory();
}

function displayResults(results) {
  clearResultsContainer();
  elements.emptyState.classList.add('hidden');
  if (elements.homeSections) elements.homeSections.classList.add('hidden');

  // Hide planner when showing search results
  if (elements.duePlanner) elements.duePlanner.classList.add('hidden');

  // Hide recents section when showing search results
  const recents = document.getElementById('overlay-recents');
  if (recents) recents.remove();

  // Reset highlight index
  state.overlayHighlightIndex = 0;

  // Render into a fragment first so we only touch the live DOM once.
  const fragment = document.createDocumentFragment();
  // Cache hot-path lookups so we don't re-resolve them per row.
  const inOverlay = state.isOverlayMode;
  const adaptiveOn = !!state.extensionSettings?.enableAdaptiveLearning;
  const globalClicks = adaptiveOn ? (state.searchHabits?.globalClicks || null) : null;
  const nowMs = Date.now();

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const item = result.item;

    const resultElement = document.createElement('div');
    resultElement.className = 'result-item';
    resultElement.tabIndex = 0;
    resultElement.setAttribute('role', 'button');
    resultElement.setAttribute('aria-label', buildItemAriaLabel(item));

    if (inOverlay && index === 0) {
      resultElement.classList.add('overlay-highlighted');
    }

    const submissionState = getSubmissionBadgeState(item, nowMs);
    const openCount = globalClicks ? getItemOpenCountFromMap(item, globalClicks) : 0;

    // In overlay mode: title + course on left, type badge on right
    if (inOverlay) {
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
        textCol.appendChild(courseEl);
      }

      if (shouldShowPathContext(item)) {
        const contextEl = document.createElement('div');
        contextEl.className = 'overlay-result-context';
        contextEl.textContent = item.folderPath;
        textCol.appendChild(contextEl);
      }

      // Due date on its own row so it's always visible
      if (item.dueAt && isTaskType(item)) {
        const dueRow = document.createElement('div');
        dueRow.className = 'overlay-result-due';
        const dueSpan = document.createElement('span');
        dueSpan.className = `due-chip-search ${dueUrgencyClass(item)}`;
        dueSpan.textContent = formatDueLabel(item);
        dueRow.appendChild(dueSpan);
        if (submissionState) {
          dueRow.appendChild(buildSubmissionBadge(submissionState, item));
        }
        textCol.appendChild(dueRow);
      } else if (submissionState) {
        const stateRow = document.createElement('div');
        stateRow.className = 'overlay-result-due';
        stateRow.appendChild(buildSubmissionBadge(submissionState, item));
        textCol.appendChild(stateRow);
      }

      resultElement.appendChild(textCol);

      const rightCol = document.createElement('div');
      rightCol.className = 'overlay-result-right';

      const typeBadge = document.createElement('span');
      typeBadge.className = `overlay-type-badge type-${(item.type || 'link').toLowerCase()}`;
      typeBadge.textContent = formatOverlayType(item.type || 'link');
      rightCol.appendChild(typeBadge);

      if (openCount > 0) {
        rightCol.appendChild(buildOpenCountChip(openCount));
      }

      resultElement.appendChild(rightCol);
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
      typeElement.textContent = formatOverlayType(item.type || 'link');

      const courseElement = document.createElement('span');
      courseElement.className = 'result-module';
      courseElement.textContent = item.courseName || '';

      metaElement.appendChild(typeElement);
      if (item.courseName) {
        metaElement.appendChild(courseElement);
      }

      if (submissionState) {
        metaElement.appendChild(buildSubmissionBadge(submissionState, item));
      }

      // Due-date chip for task items in search results
      if (item.dueAt && isTaskType(item)) {
        const dueChip = document.createElement('span');
        dueChip.className = `due-chip-search ${dueUrgencyClass(item)}`;
        dueChip.textContent = formatDueLabel(item);
        metaElement.appendChild(dueChip);
      }

      if (openCount > 0) {
        metaElement.appendChild(buildOpenCountChip(openCount));
      }

      resultElement.appendChild(metaElement);

      if (shouldShowPathContext(item)) {
        const contextElement = document.createElement('div');
        contextElement.className = 'result-context';
        contextElement.textContent = item.folderPath;
        resultElement.appendChild(contextElement);
      }
    }

    resultElement.__csItem = item;
    fragment.appendChild(resultElement);
  }

  // One reflow instead of N
  elements.resultsContainer.appendChild(fragment);
}

/**
 * Build a submission-status badge element (graded / submitted / missing / overdue / upcoming).
 */
function buildSubmissionBadge(stateName, item) {
  const span = document.createElement('span');
  span.className = `cs-status-pill cs-status-pill--${stateName}`;
  let label;
  switch (stateName) {
    case 'graded': {
      const score = formatBadgeScore(item.submission);
      label = score ? `Graded · ${score}` : 'Graded';
      break;
    }
    case 'submitted': label = 'Submitted'; break;
    case 'missing':   label = 'Missing'; break;
    case 'overdue':   label = 'Overdue'; break;
    case 'upcoming':  label = 'Due soon'; break;
    default:          label = stateName;
  }
  span.textContent = label;
  span.title = label;
  return span;
}

/**
 * Build a small "opened N×" chip for results the user has clicked before.
 * Shows nothing for 0; subtle for 1; emphasized once you've opened it 3+ times.
 */
function buildOpenCountChip(count) {
  const span = document.createElement('span');
  span.className = 'cs-opens-chip' + (count >= 3 ? ' is-frequent' : '');
  span.textContent = `${count}×`;
  span.title = `Opened ${count} time${count === 1 ? '' : 's'}`;
  span.setAttribute('aria-label', span.title);
  return span;
}

/**
 * Format type name for overlay badge display
 */
function formatOverlayType(type) {
  const names = {
    'syllabus': 'SYLLABUS',
    'assignment': 'ASSIGNMENT',
    'quiz': 'QUIZ',
    'discussion': 'DISCUSSION',
    'folder': 'FOLDER',
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
  // Intentionally blank to save space in the Command K footer
  elements.overlayResultCount.textContent = '';
}

function openResult(item, event) {
  if (item.url && isValidLmsUrl(item.url)) {
    // Save to recently opened + update click feedback
    saveToRecents(item);
    const currentQuery = elements.searchInput ? elements.searchInput.value : '';
    updateSearchHabits(item, currentQuery);
    void recordAdaptiveSearchEvent('result_clicked', currentQuery, {
      clickedItemId: getClickKey(item),
      clickedItemType: item.type || '',
      timestamp: Date.now()
    });

    const isNewTab = event && (event.metaKey || event.ctrlKey);
    if (isNewTab) {
      chrome.tabs.create({ url: item.url, active: false });
    } else {
      chrome.tabs.update({ url: item.url });

      // If in overlay mode, tell parent to close (use strict origin)
      if (window.self !== window.top) {
        const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
        window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, '*');
      } else {
        window.close(); // Close popup after navigation
      }
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
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', buildItemAriaLabel(item, { includeOpenedAt: true }));
    el.__csItem = item;

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

    recentsSection.appendChild(el);
  });

  // Insert inside results container instead of after it, 
  // so the container's padding correctly wraps it and search results.
  elements.resultsContainer.appendChild(recentsSection);
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
  if (state.slashMode.active) {
    exitSlashMode({ clearInput: true, focusInput: true });
    return;
  }

  elements.searchInput.value = '';
  updateSearchFieldAffordances();
  hideQuerySuggestions();

  if (!state.isScanning) {
    setUiState(UI_STATE.READY);
  } else {
    setUiState(UI_STATE.SCAN_SYNCING);
  }

  elements.searchInput.focus();
}

function showEmptyState() {
  // Handled by UI State machine, but we keep this function for backwards compatibility
  // and layout configuration when empty state IS active.
  clearResultsContainer();

  const query = elements.searchInput.value.trim();
  const hasHomeSections = renderHomeSections();
  let hasPlannerContent = false;

  // Show empty state text only if there is no query
  if (query.length === 0 && (currentUiState === UI_STATE.READY || currentUiState === UI_STATE.ERROR || currentUiState === UI_STATE.SCAN_SYNCING)) {
    elements.emptyState.classList.remove('hidden');
  } else {
    elements.emptyState.classList.add('hidden');
  }

  updateOverlayFooter(0, 0);

  // Show Due Planner when search is empty (popup mode only)
  if (elements.duePlanner && !state.isOverlayMode) {
    if (query.length === 0 && (currentUiState === UI_STATE.READY || currentUiState === UI_STATE.SCAN_SYNCING)) {
      renderDuePlanner();
      hasPlannerContent = elements.duePlanner.innerHTML.trim().length > 0;
      elements.duePlanner.classList.toggle('hidden', !hasPlannerContent);
    } else {
      elements.duePlanner.classList.add('hidden');
    }
  }

  elements.emptyState.classList.toggle('hidden', hasHomeSections || hasPlannerContent || query.length > 0);
}

function showNoResults(message) {
  clearResultsContainer();
  elements.emptyState.classList.add('hidden');
  if (elements.homeSections) elements.homeSections.classList.add('hidden');
  if (elements.duePlanner) elements.duePlanner.classList.add('hidden');

  if (state.isOverlayMode) {
    const noResultsElement = document.createElement('div');
    noResultsElement.className = 'no-results';
    noResultsElement.textContent = message;
    elements.resultsContainer.appendChild(noResultsElement);
    return;
  }

  const noResultsElement = document.createElement('div');
  noResultsElement.className = 'no-results';

  const title = document.createElement('div');
  title.className = 'no-results-title';
  title.textContent = 'No matches yet';
  noResultsElement.appendChild(title);

  const copy = document.createElement('div');
  copy.className = 'no-results-copy';
  copy.textContent = message;
  noResultsElement.appendChild(copy);

  const actions = document.createElement('div');
  actions.className = 'no-results-actions';

  const hasIndexedContent = state.indexedContent.length > 0;

  if (hasIndexedContent && activeCourseContext?.courseName && !isCourseSelected(activeCourseContext.courseName)) {
    const courseBtn = document.createElement('button');
    courseBtn.type = 'button';
    courseBtn.className = 'no-results-action';
    courseBtn.textContent = 'Try this course only';
    courseBtn.addEventListener('click', async () => {
      await setSelectedCourseFilters([activeCourseContext.courseName]);
    });
    actions.appendChild(courseBtn);
  }

  if (hasIndexedContent) {
    const dueBtn = document.createElement('button');
    dueBtn.type = 'button';
    dueBtn.className = 'no-results-action';
    dueBtn.textContent = 'Show due items';
    dueBtn.addEventListener('click', () => clearSearch());
    actions.appendChild(dueBtn);

    const browseBtn = document.createElement('button');
    browseBtn.type = 'button';
    browseBtn.className = 'no-results-action';
    browseBtn.textContent = 'Browse all indexed content';
    browseBtn.addEventListener('click', () => openBrowseModal());
    actions.appendChild(browseBtn);
  }

  if (actions.children.length > 0) {
    noResultsElement.appendChild(actions);
  }

  elements.resultsContainer.appendChild(noResultsElement);
}

function clearResultsContainer() {
  const children = Array.from(elements.resultsContainer.children);
  children.forEach(child => {
    if (
      child.id !== 'empty-state'
      && child.id !== 'due-planner'
      && child.id !== 'overlay-recents'
      && child.id !== 'home-sections'
      && child.id !== 'search-history'
      && child.id !== 'loading-shell'
    ) {
      child.remove();
    }
  });
}

// ============================================
// DATA MANAGEMENT
// ============================================

async function loadContent() {
  try {
    const result = await chrome.storage.local.get(['indexedContent', 'starredCourseIds', 'dismissedTasks']);
    let content = result.indexedContent || [];

    // Deduplicate by normalizing URLs (strip module_item_id)
    content = deduplicateCrossType(deduplicateContent(content));

    state.indexedContent = content;
    state.dismissedTasks = result.dismissedTasks || [];
    const rawStarred = result.starredCourseIds || [];
    starredCourseIds = new Set(rawStarred.map(String));

    // Invalidate course candidates
    state._courseCandidatesCache = null;
    state._courseCandidatesVersion = 0;

    console.log(`[Canvascope] Loaded ${state.indexedContent.length} items (after dedup), ${starredCourseIds.size} starred courses`);

    // Initialize Fuse in place now that data is loaded
    initializeFuse();
    if (state.slashMode.active) {
      renderSlashCommandSheet();
    }

    // Set UI to Ready mode after a small flicker-prevention delay
    setTimeout(() => {
      if (currentUiState === UI_STATE.BOOT_LOADING) {
        setUiState(UI_STATE.READY);
      }
    }, 150);

  } catch (error) {
    console.error('[Canvascope] Error loading content:', error);
    state.indexedContent = [];
  }
}

function clonePopupSubmissionSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    workflowState: summary.workflowState ?? null,
    submittedAt: summary.submittedAt ?? null,
    attempt: summary.attempt ?? null,
    late: summary.late ?? null,
    missing: summary.missing ?? null,
    excused: summary.excused ?? null,
    grade: summary.grade ?? null,
    score: summary.score ?? null,
    submissionType: summary.submissionType ?? null,
    hasSubmittedSubmissions: summary.hasSubmittedSubmissions ?? null,
    gradeMatchesCurrentSubmission: summary.gradeMatchesCurrentSubmission ?? null
  };
}

function mergePopupSubmissionState(winner, loser) {
  if (!winner || !loser) return;

  for (const field of ['assignmentId', 'submitted', 'submissionStatus']) {
    if ((winner[field] === undefined || winner[field] === null || winner[field] === '')
      && loser[field] !== undefined && loser[field] !== null && loser[field] !== '') {
      winner[field] = loser[field];
    }
  }

  if (!winner.submission && loser.submission) {
    winner.submission = clonePopupSubmissionSummary(loser.submission);
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

function getPopupTypeSpecificity(type) {
  const priorities = {
    syllabus: 0,
    assignment: 1,
    quiz: 2,
    discussion: 3,
    folder: 4,
    page: 5,
    file: 6,
    pdf: 6,
    document: 6,
    slides: 6,
    video: 7,
    course: 8,
    navigation: 9,
    link: 10,
    external: 10,
    externalurl: 10
  };
  return priorities[String(type || '').toLowerCase()] ?? 50;
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
      if (getPopupTypeSpecificity(item.type) < getPopupTypeSpecificity(existing.type)) {
        winner = item;
        seen.set(key, item);
      } else if (newIsCanonical && !existingIsCanonical) {
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
      mergePopupSubmissionState(winner, loser);
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
  const MERGEABLE_TYPES = new Set(['assignment', 'quiz', 'discussion']);
  const groups = new Map();

  for (const item of content) {
    if (!item || !item.title) continue;
    const normalizedType = String(item.type || '').toLowerCase();
    if (!MERGEABLE_TYPES.has(normalizedType)) {
      groups.set(`unique:${getCanonicalId(item)}`, item);
      continue;
    }
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
      mergePopupSubmissionState(winner, loser);
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
    await chrome.storage.local.set({
      indexedContent: [],
      courseCatalog: [],
      courseSnapshots: []
    });
    state.indexedContent = [];
    state.fuse = null;
    updateUI();
    showEmptyState();
    clearSearch();

    // Simultaneously wipe remote items in Supabase if logged in
    chrome.runtime.sendMessage({ action: 'clearSupabaseData' }, (response) => {
      if (response && response.error) {
        console.warn('[Canvascope] Supabase clear fell back:', response.error);
      } else {
        console.log('[Canvascope] Supabase data successfully cleared');
      }
    });

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
  const count = state.indexedContent ? state.indexedContent.length : 0;

  if (count === 0) {
    elements.statsBtn.classList.add('empty');
    if (state.isScanning) {
      elements.statsText.textContent = 'Syncing in progress...';
      elements.statsHint.textContent = 'Please wait while we index your courses';
      // Disable click to browse during early sync
      elements.statsBtn.style.pointerEvents = 'none';
    } else {
      elements.statsText.textContent = 'No content indexed';
      elements.statsHint.textContent = 'Open Canvas or Brightspace to sync';
      elements.statsBtn.style.pointerEvents = 'none';
    }
  } else {
    elements.statsBtn.classList.remove('empty');
    elements.statsText.textContent = `${count} items`;
    elements.statsHint.textContent = 'Click to browse';
    elements.statsBtn.style.pointerEvents = 'auto';
  }
}

// ============================================
// BROWSE MODAL
// ============================================

function openBrowseModal(trigger = null) {
  if (state.indexedContent.length === 0) {
    return;
  }

  const resolvedTrigger = trigger?.currentTarget || trigger || document.activeElement;

  const grouped = groupContentByType(state.indexedContent);
  buildBrowseTabs(grouped);
  showBrowseCategory('all', state.indexedContent);
  openPopupModal(null, elements.browseModal, resolvedTrigger, elements.closeBrowse);
}

function closeBrowseModal() {
  closePopupModal(null, elements.browseModal);
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
    tab.type = 'button';

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
    'syllabus': 'Syllabus',
    'assignment': 'Assignments',
    'quiz': 'Quizzes',
    'discussion': 'Discussions',
    'folder': 'Folders',
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
    itemEl.setAttribute('tabindex', '0');
    itemEl.setAttribute('role', 'button');
    itemEl.setAttribute('aria-label', buildItemAriaLabel(item));

    const title = document.createElement('div');
    title.className = 'browse-item-title';
    title.textContent = item.title || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'browse-item-meta';
    const parts = [];
    if (item.type && type === 'all') parts.push(formatOverlayType(item.type));
    if (item.courseName) parts.push(item.courseName);
    if (shouldShowPathContext(item)) parts.push(item.folderPath);
    meta.textContent = parts.join(' • ');

    itemEl.appendChild(title);
    if (parts.length > 0) itemEl.appendChild(meta);

    itemEl.addEventListener('click', () => {
      if (isValidLmsUrl(item.url)) {
        chrome.tabs.create({ url: item.url });
      }
    });
    itemEl.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && isValidLmsUrl(item.url)) {
        event.preventDefault();
        chrome.tabs.create({ url: item.url });
      }
    });

    elements.browseContent.appendChild(itemEl);
  });
}

// ============================================
// DIRECTION B — Calm Productivity enhancements
// ============================================
(function csDirectionB() {
  'use strict';

  const COURSE_PALETTE = [
    '#4ea874', // green
    '#d18b4a', // orange
    '#5d8bd9', // blue
    '#a070d0', // purple
    '#d05c7a', // pink
    '#e8b87a', // amber
    '#7cc296', // mint
    '#a890e8', // plum
    '#e88a8a', // coral
    '#5fbac4', // teal
  ];

  function hashStr(s) {
    let h = 0;
    s = String(s || '');
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  window.csCourseColor = function csCourseColor(name) {
    if (!name) return 'var(--accent)';
    return COURSE_PALETTE[hashStr(name) % COURSE_PALETTE.length];
  };

  // Short course label: "2026 Spring Biology 1A" -> "BIO 1A"
  //                    "Chem 3BL — Organic Chemistry Lab" -> "CHEM 3BL"
  //                    "CS 61A — Structure & Interp." -> "CS 61A"
  window.csShortCourse = function csShortCourse(name) {
    if (!name) return '';
    const raw = String(name).split(/[—\-:|]/)[0].trim();
    const stripped = raw.replace(/^(\d{4}\s+)?(spring|fall|summer|winter|autumn)\s+/i, '').trim();
    const tokenMatch = stripped.match(/([A-Za-z]{2,8})\s*([0-9][A-Za-z0-9]{0,4})/);
    if (tokenMatch) {
      return (tokenMatch[1].toUpperCase() + ' ' + tokenMatch[2]).trim();
    }
    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length === 0) return raw.slice(0, 18);
    if (words.length === 1) return words[0].slice(0, 12);
    return (words[0].slice(0, 6) + ' ' + words[1].slice(0, 6)).toUpperCase();
  };

  // ── Greeting headline ─────────────────────────────────────────────
  function timeBasedGreeting() {
    const h = new Date().getHours();
    if (h < 5)  return 'Working late';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function formatGreetingDate() {
    const d = new Date();
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function getFirstName() {
    try {
      const u = (typeof state !== 'undefined' && state && state.user) || null;
      if (u && (u.name || u.displayName)) {
        const full = String(u.name || u.displayName);
        return full.split(/\s+/)[0];
      }
    } catch (_) { /* noop */ }
    return null;
  }

  function countOverdueToday() {
    try {
      if (typeof state === 'undefined' || !state || !Array.isArray(state.indexedContent)) {
        return { overdue: 0, today: 0 };
      }
      const TASK_TYPES = new Set(['assignment', 'quiz', 'discussion']);
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const dismissed = new Set(Array.isArray(state.dismissedTasks) ? state.dismissedTasks : []);
      let overdue = 0, today = 0;
      for (const it of state.indexedContent) {
        const t = String(it.type || '').toLowerCase();
        if (!TASK_TYPES.has(t)) continue;
        if (!it.dueAt) continue;
        const ts = new Date(it.dueAt).getTime();
        if (!ts || isNaN(ts)) continue;
        const id = (typeof getCanonicalId === 'function') ? getCanonicalId(it) : null;
        if (id && dismissed.has(id)) continue;
        const diff = ts - now;
        if (diff < 0 && diff > -30 * dayMs) overdue++;
        else if (diff >= 0 && diff < dayMs) today++;
      }
      return { overdue, today };
    } catch (_) {
      return { overdue: 0, today: 0 };
    }
  }

  function renderGreeting() {
    const dateEl  = document.getElementById('cs-greeting-date');
    const titleEl = document.getElementById('cs-greeting-title');
    const metaEl  = document.getElementById('cs-greeting-meta');
    if (!dateEl || !titleEl || !metaEl) return;

    dateEl.textContent = formatGreetingDate();

    const firstName = getFirstName();
    titleEl.textContent = firstName
      ? `${timeBasedGreeting()}, ${firstName}.`
      : `${timeBasedGreeting()}.`;

    const { overdue, today } = countOverdueToday();
    metaEl.innerHTML = '';
    if (overdue > 0 && today > 0) {
      metaEl.append('You have ');
      const bad = document.createElement('span');
      bad.className = 'cs-bad';
      bad.textContent = `${overdue} overdue`;
      metaEl.appendChild(bad);
      metaEl.append(` · ${today} due today.`);
    } else if (overdue > 0) {
      metaEl.append('You have ');
      const bad = document.createElement('span');
      bad.className = 'cs-bad';
      bad.textContent = `${overdue} overdue`;
      metaEl.appendChild(bad);
      metaEl.append('.');
    } else if (today > 0) {
      const ok = document.createElement('span');
      ok.className = 'cs-ok';
      ok.textContent = `${today} due today`;
      metaEl.appendChild(ok);
      metaEl.append(' · all caught up otherwise.');
    } else {
      metaEl.append('All caught up — nothing due today.');
    }
  }

  // ── Filter chips ──────────────────────────────────────────────────
  function setChipActive(value) {
    document.querySelectorAll('#cs-chip-row .cs-chip').forEach(el => {
      const isActive = el.dataset.csFilter === value;
      el.classList.toggle('is-active', isActive);
      el.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  function setLegacyTypeFilter(typeValue) {
    try {
      if (typeof state !== 'undefined' && state && state.filters) {
        state.filters.type = typeValue || '';
      }
      const typeText = document.getElementById('type-text');
      if (typeText) typeText.textContent = typeValue ? labelForType(typeValue) : 'All Types';
      const options = document.querySelectorAll('#type-options .custom-option');
      options.forEach(o => o.classList.toggle('selected', (o.dataset.value || '') === (typeValue || '')));
    } catch (_) { /* noop */ }
  }

  function labelForType(t) {
    switch ((t || '').toLowerCase()) {
      case 'assignment': return 'Assignments';
      case 'quiz': return 'Quizzes';
      case 'discussion': return 'Discussions';
      case 'page': return 'Pages';
      case 'file': return 'Files';
      default: return 'All Types';
    }
  }

  function applyAgendaFilter(filter) {
    const planner = document.getElementById('due-planner');
    if (!planner) return;

    switch (filter) {
      case 'all':
        setLegacyTypeFilter('');
        planner.removeAttribute('data-cs-view');
        break;
      case 'due':
        setLegacyTypeFilter('');
        planner.setAttribute('data-cs-view', 'due');
        break;
      case 'assignment':
        setLegacyTypeFilter('assignment');
        planner.removeAttribute('data-cs-view');
        break;
      case 'quiz':
        setLegacyTypeFilter('quiz');
        planner.removeAttribute('data-cs-view');
        break;
      case 'pinned':
        setLegacyTypeFilter('');
        planner.setAttribute('data-cs-view', 'pinned');
        break;
    }

    if (typeof renderDuePlanner === 'function') {
      try { renderDuePlanner(); } catch (_) { /* noop */ }
    }
    if (typeof applyClientFilters === 'function') {
      try { applyClientFilters(); } catch (_) { /* noop */ }
    }
    csFilterPlannerRows(filter);
  }

  function csFilterPlannerRows(filter) {
    const planner = document.getElementById('due-planner');
    if (!planner) return;

    if (filter === 'pinned') {
      const pins = new Set(((typeof state !== 'undefined' && state && Array.isArray(state.pinnedItems))
        ? state.pinnedItems : []).map(String));

      planner.querySelectorAll('.due-item').forEach(row => {
        const title = (row.querySelector('.due-item-title')?.textContent || '').trim();
        const isPinned = pins.size > 0 && Array.from(pins).some(id => id.includes(title) || title.includes(id));
        row.style.display = isPinned ? '' : 'none';
      });
    } else {
      planner.querySelectorAll('.due-item').forEach(row => { row.style.display = ''; });
    }

    // hide section headers whose body is empty
    planner.querySelectorAll('.due-section').forEach(sec => {
      const anyVisible = Array.from(sec.querySelectorAll('.due-item')).some(r => r.style.display !== 'none');
      sec.style.display = anyVisible ? '' : 'none';
    });
  }

  function wireChipRow() {
    const row = document.getElementById('cs-chip-row');
    if (!row) return;
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('.cs-chip');
      if (!btn) return;
      const value = btn.dataset.csFilter || 'all';
      setChipActive(value);
      applyAgendaFilter(value);
    });
  }

  // ── Top-bar control overrides ─────────────────────────────────────
  function wireTopBarSearch() {
    // The "search" icon (formerly help-btn) focuses the search input on the popup.
    // In overlay mode this is hidden, so it's only the main-popup interaction.
    const helpBtn = document.getElementById('help-btn');
    if (!helpBtn) return;
    helpBtn.addEventListener('click', (e) => {
      const input = document.getElementById('search-input');
      if (input) {
        e.preventDefault();
        e.stopPropagation();
        input.focus();
        input.select();
      }
    }, true);
  }

  function wireThemeBtn() {
    const btn = document.getElementById('cs-theme-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      // Decorative — flash the icon as feedback
      btn.style.transform = 'rotate(60deg)';
      setTimeout(() => { btn.style.transform = ''; }, 220);
    });
  }

  // ── Stats line — compact "items · courses" ────────────────────────
  function refreshStatsCompact() {
    const txt = document.getElementById('stats-text');
    const hint = document.getElementById('stats-hint');
    if (!txt) return;
    try {
      if (typeof state === 'undefined' || !state || !Array.isArray(state.indexedContent)) return;
      const items = state.indexedContent.length;
      const courses = new Set(state.indexedContent.map(i => i.courseName).filter(Boolean)).size;
      txt.textContent = `${items.toLocaleString()} items`;
      if (hint) hint.textContent = `· ${courses} courses`;
    } catch (_) { /* noop */ }
  }

  // ── Init + refresh hooks ──────────────────────────────────────────
  function init() {
    renderGreeting();
    wireChipRow();
    wireTopBarSearch();
    wireThemeBtn();
    refreshStatsCompact();

    // Refresh greeting every minute (in case hour rolls over)
    setInterval(renderGreeting, 60_000);
  }

  // Periodically refresh greeting + stats once data loads
  function watchData() {
    let lastCount = 0;
    setInterval(() => {
      try {
        if (typeof state === 'undefined' || !state) return;
        const c = Array.isArray(state.indexedContent) ? state.indexedContent.length : 0;
        if (c !== lastCount) {
          lastCount = c;
          renderGreeting();
          refreshStatsCompact();
        }
      } catch (_) { /* noop */ }
    }, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); watchData(); });
  } else {
    init();
    watchData();
  }

  // ── Bulletproof Escape handler for overlay (cmd+K) ──
  // The existing handler at popup.js:4490 can throw before postMessage fires
  // (e.g. if clearSearch errors). Attach a parallel handler that *only*
  // postMessages, so Escape always closes the overlay.
  function isInOverlay() {
    return window.self !== window.top
      || new URLSearchParams(window.location.search).get('mode') === 'overlay';
  }
  if (isInOverlay()) {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        try { window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, '*'); } catch (_) { /* noop */ }
      }
    }, true);
  }
})();
