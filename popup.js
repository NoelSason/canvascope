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
    if (!item || !isTemporalTask(item) || !item.dueAt) return false;
    const dueTs = new Date(item.dueAt).getTime();
    if (!Number.isFinite(dueTs) || dueTs <= 0) return false;
    return Math.abs(dueTs - anchorTs) <= radiusMs;
  });
}

function filterItemsByTemporalWindow(items, temporalKind) {
  if (!temporalKind) return items;
  const { anchorTs, radiusMs } = getTemporalWindow(temporalKind);
  return (items || []).filter(item => {
    if (!isTemporalTask(item) || !item.dueAt) return false;
    const dueTs = new Date(item.dueAt).getTime();
    if (!Number.isFinite(dueTs) || dueTs <= 0) return false;
    return Math.abs(dueTs - anchorTs) <= radiusMs;
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

const STOP_TOKENS = new Set(['the', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'is']);

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
  // Frequency boost: log-scaled, max ~0.15
  const freqBoost = Math.min(0.15, Math.log2(1 + openCount) * 0.05);
  // Recency boost: decays over 14 days, max 0.10
  const daysSinceOpen = (Date.now() - lastOpenedAt) / (1000 * 60 * 60 * 24);
  const recencyBoost = Math.max(0, 0.10 - daysSinceOpen * (0.10 / 14));
  return Math.min(0.25, freqBoost + recencyBoost);
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

    // Skip tasks dismissed by the user
    if (state.dismissedTasks.includes(getCanonicalId(item))) continue;

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

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'dismiss-task-btn';
      dismissBtn.innerHTML = '&times;';
      dismissBtn.title = "Dismiss task";
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
  const q = normalizeText(normalizedQuery || '');
  if (!q) return 0;

  const qTokens = q.split(/\s+/).filter(Boolean);
  const itemCourse = normalizeText(item.courseName || '');
  if (!itemCourse) return 0;

  const hasBioHint = qTokens.some(t => t === 'bio' || t === 'biol' || t === 'biology');
  const hasChemHint = qTokens.some(t => t === 'chem' || t === 'chemistry');

  let boost = 0;

  if (hasBioHint) {
    if (itemCourse.includes('biology') || itemCourse.includes('biol') || /\bbio\b/.test(itemCourse)) {
      boost += 0.55;
    } else {
      boost -= 0.22;
    }
  }

  if (hasChemHint) {
    if (itemCourse.includes('chem') || itemCourse.includes('chemistry')) {
      boost += 0.45;
    } else {
      boost -= 0.18;
    }
  }

  return boost;
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
  recentlyOpened: [],
  isSignedIn: false,
  user: null,
  activePdfContext: null,
  _courseCandidatesCache: null,
  _courseCandidatesVersion: 0,
  dismissedTasks: []
};

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  // Check if we're in overlay mode
  const urlParams = new URLSearchParams(window.location.search);
  state.isOverlayMode = urlParams.get('mode') === 'overlay';

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

  // Check auth status
  chrome.runtime.sendMessage({ type: 'checkAuthStatus' }, (response) => {
    if (response && response.signedIn) {
      state.isSignedIn = true;
      state.user = response.user;
      if (elements.googleSignInBtn) {
        elements.googleSignInBtn.querySelector('.btn-text').textContent = 'Signed in ✓';
        elements.googleSignInBtn.style.backgroundColor = 'var(--success-color, #4CAF50)';
        elements.googleSignInBtn.style.color = '#fff';
        elements.googleSignInBtn.style.borderColor = 'rgba(76, 175, 80, 0.35)';
      }
    }
  });

  // Check if current tab is a supported LMS and auto-detect domain
  checkCurrentTab();

  if (!state.isOverlayMode) {
    await refreshPdfFallbackAvailability();
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
      <span class="overlay-footer-left" id="overlay-result-count"></span>
      <span class="overlay-footer-right"><kbd>↵</kbd> to open</span>
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
  elements.searchInput = document.getElementById('search-input');
  elements.clearSearchBtn = document.getElementById('clear-search');
  elements.resultsContainer = document.getElementById('results-container');
  elements.emptyState = document.getElementById('empty-state');
  elements.refreshBtn = document.getElementById('refresh-btn');
  elements.sendPdfBtn = document.getElementById('send-pdf-btn');
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

  // Auth Integration
  elements.googleSignInBtn = document.getElementById('google-signin-btn');
  elements.accountModal = document.getElementById('account-modal');
  elements.closeAccountModalBtn = document.getElementById('close-account-modal');
  elements.accountNameDisplay = document.getElementById('account-name-display');
  elements.accountEmailDisplay = document.getElementById('account-email-display');
  elements.accountAvatarPlaceholder = document.getElementById('account-avatar-placeholder');
  elements.logoutBtn = document.getElementById('logout-btn');
  elements.accountDbContent = document.getElementById('account-db-content');
  elements.syncDbBtn = document.getElementById('sync-db-btn');

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

function setupEventListeners() {
  elements.searchInput.addEventListener('input', handleSearchInput);
  elements.searchInput.addEventListener('focus', showSearchHistory);
  elements.searchInput.addEventListener('blur', () => {
    // Delay hiding to allow clicking on history items
    setTimeout(() => {
      // Don't hide if we clicked a history item (handled by click event)
    }, 200);
  });

  // Auth Integration
  if (elements.googleSignInBtn) {
    elements.googleSignInBtn.addEventListener('click', () => {
      // If already signed in, open the account modal instead of re-authenticating
      if (state.isSignedIn) {
        showAccountModal();
        return;
      }

      elements.googleSignInBtn.querySelector('.btn-text').textContent = 'Signing in...';
      elements.googleSignInBtn.disabled = true;

      chrome.runtime.sendMessage({ type: 'signInWithGoogle' }, (response) => {
        elements.googleSignInBtn.disabled = false;
        if (response && response.success) {
          // Fetch the new user session
          chrome.runtime.sendMessage({ type: 'checkAuthStatus' }, (statusRes) => {
            if (statusRes && statusRes.signedIn) {
              state.isSignedIn = true;
              state.user = statusRes.user;
              elements.googleSignInBtn.querySelector('.btn-text').textContent = 'Signed in ✓';
              elements.googleSignInBtn.style.backgroundColor = 'var(--success-color, #4CAF50)';
              elements.googleSignInBtn.style.color = '#fff';
              elements.googleSignInBtn.style.borderColor = 'rgba(76, 175, 80, 0.35)';
            }
          });
        } else {
          elements.googleSignInBtn.querySelector('.btn-text').textContent = 'Sign in error';
          elements.googleSignInBtn.style.backgroundColor = '';
          elements.googleSignInBtn.style.color = '';
          elements.googleSignInBtn.style.borderColor = 'var(--glass-border)';
          console.error('Sign in failed:', response?.error);
          setTimeout(() => {
            if (elements.googleSignInBtn) {
              elements.googleSignInBtn.querySelector('.btn-text').textContent = 'Sign in';
              elements.googleSignInBtn.style.backgroundColor = '';
              elements.googleSignInBtn.style.color = '';
              elements.googleSignInBtn.style.borderColor = 'var(--glass-border)';
            }
          }, 3000);
        }
      });
    });
  }

  // Account Modal Interaction
  if (elements.closeAccountModalBtn) {
    elements.closeAccountModalBtn.addEventListener('click', () => {
      elements.accountModal.classList.add('hidden');
    });
  }

  if (elements.syncDbBtn) {
    elements.syncDbBtn.addEventListener('click', () => {
      elements.syncDbBtn.disabled = true;
      elements.syncDbBtn.querySelector('.btn-text').textContent = 'Syncing...';

      chrome.runtime.sendMessage({ type: 'syncIndexedContent' }, (response) => {
        elements.syncDbBtn.disabled = false;
        if (response && response.success) {
          elements.syncDbBtn.querySelector('.btn-text').textContent = `Synced ${response.synced} items \u2713`;
          elements.syncDbBtn.style.backgroundColor = 'rgba(76, 175, 80, 0.1)';
          elements.syncDbBtn.style.color = '#4CAF50';
          elements.syncDbBtn.style.borderColor = 'rgba(76, 175, 80, 0.2)';

          // Refresh the DB view
          showAccountModal();

          // Reset button after 3s
          setTimeout(() => {
            if (elements.syncDbBtn) {
              elements.syncDbBtn.querySelector('.btn-text').textContent = 'Sync to Database';
              elements.syncDbBtn.style.backgroundColor = 'rgba(33, 150, 243, 0.1)';
              elements.syncDbBtn.style.color = '#2196F3';
              elements.syncDbBtn.style.borderColor = 'rgba(33, 150, 243, 0.2)';
            }
          }, 3000);
        } else {
          elements.syncDbBtn.querySelector('.btn-text').textContent = 'Sync failed';
          console.error('Sync failed:', response?.error);
          setTimeout(() => {
            if (elements.syncDbBtn) {
              elements.syncDbBtn.querySelector('.btn-text').textContent = 'Sync to Database';
            }
          }, 3000);
        }
      });
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
          state.isSignedIn = false;
          state.user = null;

          // Reset Main Sign in Button
          elements.googleSignInBtn.querySelector('.btn-text').textContent = 'Sign in';
          elements.googleSignInBtn.style.backgroundColor = '';
          elements.googleSignInBtn.style.color = '';
          elements.googleSignInBtn.style.borderColor = 'var(--glass-border)';

          // Hide account modal
          elements.accountModal.classList.add('hidden');
        } else {
          console.error('Sign out failed:', response?.error);
        }
      });
    });
  }

  // Keyboard navigation for search results
  elements.searchInput.addEventListener('keydown', (e) => {
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
  if (elements.sendPdfBtn) elements.sendPdfBtn.addEventListener('click', handleSendPdfFallback);
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
 * Show and populate the account profile modal
 */
function showAccountModal() {
  if (!state.user || !elements.accountModal) return;

  const user = state.user;
  const name = user.name || 'User';
  const email = user.email || '';

  if (elements.accountNameDisplay) elements.accountNameDisplay.textContent = name;
  if (elements.accountEmailDisplay) elements.accountEmailDisplay.textContent = email;

  if (elements.accountAvatarPlaceholder) {
    if (user.avatar_url) {
      elements.accountAvatarPlaceholder.innerHTML = `<img src="${user.avatar_url}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
      elements.accountAvatarPlaceholder.style.backgroundColor = 'transparent';
    } else {
      elements.accountAvatarPlaceholder.innerHTML = name.charAt(0).toUpperCase();
      elements.accountAvatarPlaceholder.style.backgroundColor = 'var(--border-color)';
    }
  }

  // Show loading state for DB content
  if (elements.accountDbContent) {
    elements.accountDbContent.innerHTML = '<p style="color: var(--text-secondary); font-size: 12px; text-align: center;">Loading database content...</p>';
  }

  elements.accountModal.classList.remove('hidden');

  // Fetch database content
  chrome.runtime.sendMessage({ type: 'fetchUserData' }, (response) => {
    if (!elements.accountDbContent) return;

    if (!response || !response.success) {
      elements.accountDbContent.innerHTML = `<p style="color: #f44336; font-size: 12px; text-align: center;">Error: ${response?.error || 'Failed to load'}</p>`;
      return;
    }

    let html = '';
    const tables = response.tables;
    const tableNames = { users: 'Users', preferences: 'Preferences', synced_items: 'Synced Items' };
    const tableIcons = { users: '👤', preferences: '⚙️', synced_items: '🔄' };

    for (const [key, label] of Object.entries(tableNames)) {
      const table = tables[key];
      const icon = tableIcons[key];
      const rowCount = table.data?.length || 0;

      html += `<div style="margin-bottom: 12px;">`;
      html += `<div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border-color);">`;
      html += `<span style="font-size: 14px;">${icon}</span>`;
      html += `<span style="font-weight: 600; font-size: 13px; color: var(--text-color);">${label}</span>`;
      html += `<span style="margin-left: auto; font-size: 11px; color: var(--text-secondary); background: var(--card-bg); padding: 1px 7px; border-radius: 10px;">${rowCount} row${rowCount !== 1 ? 's' : ''}</span>`;
      html += `</div>`;

      if (table.error) {
        html += `<p style="color: #ff9800; font-size: 11px; padding: 4px 8px;">⚠ ${table.error}</p>`;
      } else if (rowCount === 0) {
        html += `<p style="color: var(--text-secondary); font-size: 11px; padding: 4px 8px; font-style: italic;">No data yet</p>`;
      } else {
        for (const row of table.data) {
          html += `<div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; font-size: 11px; word-break: break-all;">`;
          for (const [field, value] of Object.entries(row)) {
            // Skip internal IDs for cleaner display
            const displayVal = (value === null || value === undefined) ? '<em style="color: var(--text-secondary);">null</em>' :
              (typeof value === 'object' ? `<code style="background: rgba(255,255,255,0.05); padding: 1px 4px; border-radius: 3px; font-size: 10px;">${JSON.stringify(value)}</code>` :
                String(value));
            html += `<div style="display: flex; gap: 6px; padding: 2px 0; line-height: 1.4;">`;
            html += `<span style="color: var(--text-secondary); min-width: 90px; flex-shrink: 0; font-weight: 500;">${field}</span>`;
            html += `<span style="color: var(--text-color);">${displayVal}</span>`;
            html += `</div>`;
          }
          html += `</div>`;
        }
      }

      html += `</div>`;
    }

    elements.accountDbContent.innerHTML = html;
  });
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
      elements.sendPdfBtn.title = 'Open a PDF tab to send.';
    }
  } catch (e) {
    state.activePdfContext = null;
    elements.sendPdfBtn.classList.remove('hidden');
    resetSendPdfButtonState();
    elements.sendPdfBtn.title = 'Open a PDF tab to send.';
  }
}

async function handleSendPdfFallback() {
  if (!elements.sendPdfBtn) return;

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
    setUiState(state.isScanning ? UI_STATE.SCAN_SYNCING : UI_STATE.READY);
    showEmptyState(); // Ensure the planner reappears immediately
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

  // Derive search metadata once
  const intent = detectQueryIntent(normalizedQuery);
  const queryNums = extractNumericTokens(normalizedQuery);

  // Temporal-first retrieval: when query has a time intent, scope the corpus
  // before lexical ranking so relevant due items are never dropped by early truncation.
  const searchCorpus = temporalIntent.kind
    ? filterItemsByTemporalWindow(state.filteredContent, temporalIntent.kind)
    : state.filteredContent;

  if (searchCorpus.length === 0) {
    showNoResults(`No results for "${query}"`);
    updateOverlayFooter(0, 0);
    return;
  }

  const activeFuse = temporalIntent.kind ? new Fuse(searchCorpus, FUSE_OPTIONS) : state.fuse;
  const activeFuseRelaxed = temporalIntent.kind ? new Fuse(searchCorpus, FUSE_OPTIONS_RELAXED) : state.fuseRelaxed;

  const searchStart = performance.now();

  // ── Exact/prefix pre-pass ──────────────────────────
  const normQ = normalizedQuery.toLowerCase();
  const rawQ = normalizeText(effectiveQuery).toLowerCase();
  const queryVariants = normQ === rawQ ? [normQ] : [normQ, rawQ];

  const prePassHits = [];
  const prePassUrls = new Set();

  for (const item of searchCorpus) {
    const nt = (item.searchTitleNormalized || normalizeText(item.title || '')).toLowerCase();

    let bestBaseScore = null;

    // Check against both expanded and raw query versions
    for (const q of queryVariants) {
      if (!q) continue;

      const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const exactWordRe = new RegExp(`\\b${escapedQ}\\b`, 'i');

      let score = null;
      if (nt === q) {
        score = 0.0;
      } else if (nt.startsWith(q + ' ') || nt.startsWith(q)) {
        score = 0.05;
      } else if (exactWordRe.test(nt)) {
        score = 0.1;
      } else if (nt.includes(q)) {
        score = 0.15;
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
  let fuseResults = activeFuse.search(normalizedQuery, { limit: MAX_RESULTS * 3 });

  // Also search with effective query and merge unique results
  if (normalizedQuery !== normalizeText(effectiveQuery)) {
    const origResults = activeFuse.search(effectiveQuery, { limit: MAX_RESULTS * 3 });
    const seenUrls = new Set(fuseResults.map(r => r.item.url));
    for (const r of origResults) {
      if (!seenUrls.has(r.item.url)) {
        fuseResults.push(r);
        seenUrls.add(r.item.url);
      }
    }
  }

  // ── Fuse pass B: relaxed fallback ──────────────────
  if (fuseResults.length === 0 && activeFuseRelaxed) {
    fuseResults = activeFuseRelaxed.search(normalizedQuery, { limit: MAX_RESULTS * 3 });
    if (fuseResults.length === 0) {
      fuseResults = activeFuseRelaxed.search(effectiveQuery, { limit: MAX_RESULTS * 3 });
    }
  }

  // ── Merge pre-pass + Fuse (dedup by URL) ───────────
  let results = [...prePassHits];
  for (const r of fuseResults) {
    if (!prePassUrls.has(r.item.url)) {
      results.push(r);
    }
  }

  // ── Lexical Fallback pass & RRF Fusion ─────────────
  // If we have a lot of items, hybrid retrieval using exact literal matching
  // helps with hard token boundaries.
  const lexicalResults = [];
  const lexScores = new Map();
  const qTokens = normalizedQuery.toLowerCase().split(/\s+/).filter(t => t.length > 0 && (t.length > 1 || !STOP_TOKENS.has(t)));
  if (qTokens.length > 0) {
    for (const item of searchCorpus) {
      if (prePassUrls.has(item.url)) continue;
      const searchableText = `${item.searchTitleNormalized} ${item.folderPath || ''} ${item.moduleName || ''}`.toLowerCase();
      let matchedTokens = 0;
      for (const t of qTokens) {
        if (t.length === 1) {
          if (new RegExp(`\\b${t}\\b`).test(searchableText)) matchedTokens++;
        } else {
          if (searchableText.includes(t)) matchedTokens++;
        }
      }
      if (matchedTokens === qTokens.length) { // AND boolean query basically
        lexicalResults.push({ item, score: 0.2, prePass: false });
      }
    }

    // Sort lexical results by length of title to prefer shorter matching titles (Occam's razor)
    lexicalResults.sort((a, b) => (a.item.searchTitleNormalized?.length || 0) - (b.item.searchTitleNormalized?.length || 0));

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

    // Secondary recall: scan target course items for query token matches
    // in title + folderPath + moduleName (catches folder-name matches)
    const qTokens = normalizedQuery.toLowerCase().split(/\s+/).filter(t => t.length > 0 && (t.length > 1 || !STOP_TOKENS.has(t)));
    if (qTokens.length > 0) {
      for (const item of searchCorpus) {
        if (seenUrls.has(item.url)) continue;
        const itemCourse = normalizeText(item.courseName || '');
        // Require word boundary after prefix to prevent "chem 3al" matching "chem 3a"
        if (!new RegExp(`^${prefix}(\\s|$)`).test(itemCourse)) continue;

        // Check if enough query tokens appear across searchable text
        const searchableText = [
          (item.searchTitleNormalized || normalizeText(item.title || '')),
          normalizeText(item.folderPath || ''),
          normalizeText(item.moduleName || '')
        ].join(' ').toLowerCase();

        let hits = 0;
        for (const t of qTokens) {
          if (t.length === 1) {
            if (new RegExp(`\\b${t}\\b`).test(searchableText)) hits++;
          } else {
            if (searchableText.includes(t)) hits++;
          }
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
      return new RegExp(`^${prefix}(\\s|$)`).test(itemCourse);
    });
    if (scopedResults.length > 0) {
      results = scopedResults;
    }
  }

  if (temporalIntent.kind) {
    let temporalResults = applyTemporalFilter(results, temporalIntent.kind);

    // Ensure broad temporal queries (e.g. "lab this week") don't lose relevant items
    // due to retrieval/ranking truncation.
    const broadTokens = (normalizedQuery || '').split(/\s+/).filter(t => t.length > 0 && !STOP_TOKENS.has(t));
    if (broadTokens.length <= 1) {
      const recallSeed = [];
      for (const item of searchCorpus) {
        const searchable = [
          item.searchTitleNormalized || normalizeText(item.title || ''),
          normalizeText(item.folderPath || ''),
          normalizeText(item.moduleName || '')
        ].join(' ').toLowerCase();

        const matchesBroadToken = broadTokens.length === 0 || broadTokens.every(t => searchable.includes(t));
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
      const temporalSeed = state.filteredContent.map(item => ({ item, score: 0.5, prePass: false }));
      temporalResults = applyTemporalFilter(temporalSeed, temporalIntent.kind);
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
  results = rankResults(results, normalizedQuery, intent, queryNums);

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

  // General-query recency mode (no explicit assignment number/specifier):
  // prefer the most recent assignment-like item first.
  // BUT: skip if the top result is an exact/prefix match (pre-pass hit)
  // so that exact matches like "PreLab E" don't get overridden by "PreLab F".
  const generalTokens = (normalizedQuery || '').split(/\s+/).filter(t => t.length > 0 && !STOP_TOKENS.has(t));
  const isGeneralQuery = !temporalIntent.kind && queryNums.length === 0 && generalTokens.length <= 3;
  const topIsExactMatch = results.length > 0 && results[0].prePass;

  if (isGeneralQuery && !topIsExactMatch) {
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

    // Most recent due date first (newest assignment-like item at top)
    recencyCandidates.sort((a, b) => b.dueTs - a.dueTs);
    results = [...recencyCandidates.map(x => x.r), ...otherResults];
  }

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
    if (mismatched > 0) score -= 0.50 * (mismatched / queryNums.length); // Severe penalty for mismatch
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

  // ── Starred-course boost ────────────────────────
  score += getStarredCourseBoost(item);

  // ── Query course-hint boost (e.g., "bio lab this week") ──
  score += getQueryCourseHintBoost(item, normalizedQuery);

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

  // ── Dismissed Tasks penalty ─────────────────────
  if (state.dismissedTasks && state.dismissedTasks.includes(item.url)) {
    score -= 0.4;
  }

  // ── Due-date-aware freshness (future > overdue) ────────────────────
  if (item.dueAt && (intent?.assignment > 0 || intent?.quiz > 0)) {
    const dueTs = new Date(item.dueAt).getTime();
    if (dueTs > 0) {
      const daysUntilDue = (dueTs - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysUntilDue >= 0 && daysUntilDue <= 21) {
        // Upcoming: strong boost, especially near-term
        score += Math.max(0.08, 0.34 - daysUntilDue * 0.015);
      } else if (daysUntilDue < 0 && daysUntilDue > -30) {
        // Overdue: explicit penalty so future tasks sort above overdue ones
        score -= Math.min(0.55, 0.22 + Math.abs(daysUntilDue) * 0.03);
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
    .map(r => {
      const finalScore = calculateScore(r.item, r.score, normalizedQuery, intent, queryNums, !!r.prePass);
      return {
        ...r,
        finalScore
      };
    })
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
  if (!state.isOverlayMode) return;

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

  // Hide empty state and planner, show history in its place
  if (elements.emptyState) elements.emptyState.classList.add('hidden');
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
        textCol.appendChild(courseEl);
      }

      // Due date on its own row so it's always visible
      if (item.dueAt && isTaskType(item)) {
        const dueRow = document.createElement('div');
        dueRow.className = 'overlay-result-due';
        const dueSpan = document.createElement('span');
        dueSpan.className = `due-chip-search ${dueUrgencyClass(item)}`;
        dueSpan.textContent = formatDueLabel(item);
        dueRow.appendChild(dueSpan);
        textCol.appendChild(dueRow);
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

    resultElement.addEventListener('click', (e) => openResult(item, e));
    resultElement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openResult(item, e);
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

function openResult(item, event) {
  if (item.url && isValidLmsUrl(item.url)) {
    // Save to recently opened + update click feedback
    saveToRecents(item);
    updateClickFeedback(item);

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

    el.addEventListener('click', (e) => openResult(item, e));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openResult(item, e);
    });

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
  elements.searchInput.value = '';
  elements.clearSearchBtn.classList.remove('visible');

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
      const hasTasks = elements.duePlanner.innerHTML.trim().length > 0;
      elements.duePlanner.classList.toggle('hidden', !hasTasks);
      if (hasTasks) {
        elements.emptyState.classList.add('hidden');
      }
    } else {
      elements.duePlanner.classList.add('hidden');
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
    if (child.id !== 'empty-state' && child.id !== 'due-planner' && child.id !== 'overlay-recents') {
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
