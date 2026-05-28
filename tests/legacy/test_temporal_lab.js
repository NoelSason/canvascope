/**
 * Cross-dataset test: expandTemporalLabSiblings
 * - Berkeley (2780 items, different Canvas conventions)
 * - UCSD (574 items, original test data)
 *
 * Tests Fix #1 (dynamic course hints) and Fix #2 (resilient lab number extraction)
 * Reports failures and potential issues per dataset.
 */

const fs = require('fs');
const path = require('path');

function resolveFixturePath(filename) {
  const candidates = [
    path.join(__dirname, filename),
    path.join(__dirname, '..', filename)
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

// ── Copied helper functions from popup.js ──

const ABBREV_MAP = {
  hw: 'homework', proj: 'project', assn: 'assignment', assign: 'assignment',
  disc: 'discussion', lec: 'lecture', lab: 'laboratory', mt: 'midterm',
  ch: 'chapter', chap: 'chapter', wk: 'week', phys: 'physics',
  bio: 'biology', biol: 'biology', chem: 'chemistry',
  pset: 'problem set', ps: 'problem set'
};

const COMPACT_TOKEN_RE = /^([a-z]+)(\d{1,3})$/i;

function normalizeText(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

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

// ── Simulated state ──
const state = {
  indexedContent: [],
  filteredContent: [],
  _subjectKeywordsCache: null,
  _subjectKeywordsCacheVersion: null
};

function resetState(data) {
  const allContent = data.indexedContent || [];
  for (const item of allContent) {
    item.searchTitleNormalized = expandAbbreviations(item.title || '');
    item.searchAliases = '';
    item.searchCourseNormalized = expandAbbreviations(item.courseName || '');
  }
  state.indexedContent = allContent;
  state.filteredContent = allContent;
  state._subjectKeywordsCache = null;
  state._subjectKeywordsCacheVersion = null;
}

// ── Dynamic course hint system ──

function getSubjectKeywordIndex() {
  const content = state.indexedContent || [];
  if (state._subjectKeywordsCache && state._subjectKeywordsCacheVersion === content.length) {
    return state._subjectKeywordsCache;
  }

  const MIN_TOKEN_LEN = 3;
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

    const expanded = expandAbbreviations(item.courseName);
    const tokens = expanded.split(/\s+/).filter(Boolean);

    for (const token of tokens) {
      if (token.length < MIN_TOKEN_LEN) continue;
      if (STOP_WORDS.has(token)) continue;
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

function getCourseHintSignals(normalizedQuery) {
  const q = normalizeText(normalizedQuery || '');
  const qTokens = q.split(/\s+/).filter(Boolean);
  if (qTokens.length === 0) return { matchedCourseKeys: new Set(), hasHint: false };

  const subjectIndex = getSubjectKeywordIndex();
  const matchedCourseKeys = new Set();

  for (const token of qTokens) {
    const expanded = expandAbbreviations(token);
    const variants = expanded !== token ? [token, ...expanded.split(/\s+/)] : [token];

    for (const variant of variants) {
      const courses = subjectIndex.get(variant);
      if (courses && courses.size > 0) {
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

// ── Lab helpers ──

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

  const B = '[\\s_|/.:;,#=-]';

  const directPatterns = [
    () => new RegExp(`(?:^|${B})(?:[a-z0-9]{0,8})?(?:pre[\\s-]*lab|prelab|lab(?:oratory)?)\\s*#?\\s*0*(\\d{1,3})(?:[a-z](?:\\.\\d+)?)?(?=$|${B})`, 'ig'),
    () => new RegExp(`(?:^|${B})#?0*(\\d{1,3})\\s*(?:pre[\\s-]*lab|prelab|lab(?:oratory)?)(?=$|${B})`, 'ig')
  ];

  for (const text of texts) {
    for (const pattern of directPatterns) {
      for (const n of collectPatternNumbers(text, pattern)) direct.add(n);
    }
  }

  if (direct.size > 0) return Array.from(direct);

  const weekFallback = new Set();
  for (const text of texts) {
    for (const n of collectPatternNumbers(text, () => new RegExp(`(?:^|${B})week\\s*#?\\s*0*(\\d{1,3})(?=$|${B})`, 'ig'))) {
      weekFallback.add(n);
    }
  }
  if (weekFallback.size > 0) return Array.from(weekFallback);

  if (isLabContextItem(item)) {
    const titleOnly = item?.title || '';
    if (titleOnly) {
      const cleaned = titleOnly.replace(/\d{1,2}[\s]*[-–:]\s*\d{1,2}\s*(?:am|pm|AM|PM)?/g, '')
                                .replace(/\d{1,2}\s*(?:am|pm|AM|PM)/g, '');
      const standaloneNumbers = new Set();
      for (const n of collectPatternNumbers(cleaned, () => new RegExp(`(?:^|${B})#?0*(\\d{1,3})(?=$|${B})`, 'ig'))) {
        standaloneNumbers.add(n);
      }
      if (standaloneNumbers.size === 1) return Array.from(standaloneNumbers);
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

// ═══════════════════════════════════════════════════════════════
// TEST HARNESS
// ═══════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
const warnings = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function warn(label) {
  console.log(`  ⚠️  WARNING: ${label}`);
  warnings.push(label);
}

const SIMULATED_NOW = new Date('2026-03-15T12:00:00Z').getTime();
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function makeTemporalAnchors(courseFilter, titleFilter) {
  return state.filteredContent
    .filter(item => {
      if (!item.courseName?.includes(courseFilter)) return false;
      if (!item.dueAt) return false;
      if (titleFilter) {
        const title = (item.searchTitleNormalized || '').toLowerCase();
        if (!titleFilter(title)) return false;
      }
      const dueTs = new Date(item.dueAt).getTime();
      return Math.abs(dueTs - SIMULATED_NOW) <= WEEK_MS;
    })
    .map(item => ({ item, score: 0.15, prePass: false }));
}

// ── Load data ──
const berkeleyPath = resolveFixturePath('BerkeleyCanvascopeExport.json');
const ucsdPath = resolveFixturePath('UCSDCanvascopeExport.json');
const berkeleyData = JSON.parse(fs.readFileSync(berkeleyPath, 'utf8'));
const ucsdData = JSON.parse(fs.readFileSync(ucsdPath, 'utf8'));

// ═══════════════════════════════════════════════════════════════
// UCSD TESTS
// ═══════════════════════════════════════════════════════════════

console.log('╔' + '═'.repeat(68) + '╗');
console.log('║  UCSD DATASET (' + ucsdData.indexedContent.length + ' items)' + ' '.repeat(68 - 20 - String(ucsdData.indexedContent.length).length) + '║');
console.log('╚' + '═'.repeat(68) + '╝');

resetState(ucsdData);

// Test 1: physics lab this week
console.log('\n── Test: "physics lab this week" ──');
const ucsdPhysAnchors = makeTemporalAnchors('PHYS 1BL', t => t.includes('lab') || t.includes('laboratory') || t.includes('prelab'));
console.log(`  Anchors: ${ucsdPhysAnchors.map(r => `"${r.item.title}" (due ${r.item.dueAt})`).join(', ')}`);

const ucsdPhysExpanded = expandTemporalLabSiblings(ucsdPhysAnchors, expandAbbreviations('physics lab'), null);
const ucsdPhysNew = ucsdPhysExpanded.filter(r => r.temporalLabExpansion);

assert(ucsdPhysAnchors.length >= 1, `At least 1 anchor found (got ${ucsdPhysAnchors.length})`);
assert(ucsdPhysNew.length === 5, `5 Lab 5 siblings expanded (got ${ucsdPhysNew.length})`);

for (const r of ucsdPhysNew) {
  const nums = extractLabSequenceNumbers(r.item);
  console.log(`    ✓ "${r.item.title}" → lab#[${nums}]`);
}

// Test 2: "bild lab this week" — UCSD-specific course prefix
console.log('\n── Test: "bild lab this week" ──');
const ucsdBildAnchors = makeTemporalAnchors('BILD', t => t.includes('lab') || t.includes('laboratory') || t.includes('prelab') || t.includes('pre'));
console.log(`  Anchors: ${ucsdBildAnchors.length} items`);
for (const r of ucsdBildAnchors) console.log(`    "${r.item.title}" (due ${r.item.dueAt})`);

const ucsdBildHints = getCourseHintSignals(expandAbbreviations('bild lab'));
assert(ucsdBildHints.hasHint, '"bild" recognized as course hint');

const ucsdBildExpanded = expandTemporalLabSiblings(ucsdBildAnchors, expandAbbreviations('bild lab'), null);
const ucsdBildNew = ucsdBildExpanded.filter(r => r.temporalLabExpansion);
console.log(`  Expanded: ${ucsdBildNew.length} siblings added`);
for (const r of ucsdBildNew) {
  const nums = extractLabSequenceNumbers(r.item);
  console.log(`    ✓ "${r.item.title}" → lab/week#[${nums}]`);
}

// Test 3: cross-contamination check
console.log('\n── Test: No cross-course contamination ──');
const physOnlyExpanded = expandTemporalLabSiblings(ucsdPhysAnchors, expandAbbreviations('physics lab'), null);
const bildLeak = physOnlyExpanded.filter(r => r.temporalLabExpansion).find(r => r.item.courseName?.includes('BILD'));
assert(!bildLeak, 'BILD items do not leak into physics expansion');

// ═══════════════════════════════════════════════════════════════
// BERKELEY TESTS
// ═══════════════════════════════════════════════════════════════

console.log('\n\n╔' + '═'.repeat(68) + '╗');
console.log('║  BERKELEY DATASET (' + berkeleyData.indexedContent.length + ' items)' + ' '.repeat(68 - 24 - String(berkeleyData.indexedContent.length).length) + '║');
console.log('╚' + '═'.repeat(68) + '╝');

resetState(berkeleyData);

// Test 4: Dynamic hint system with Berkeley course names
console.log('\n── Test: Dynamic course hints with Berkeley names ──');

const berkeleyHintTests = [
  { query: 'chemistry lab', expectCourses: ['chem'], desc: 'chemistry → Chem courses' },
  { query: 'biology lab', expectCourses: ['biology'], desc: 'biology → Bio courses' },
  { query: 'physics lab', expectCourses: ['phys'], desc: 'physics → PHYS courses' },
  { query: 'sociology lab', expectCourses: ['sociology'], desc: 'sociology → Sociology course' },
  { query: 'calculus lab', expectCourses: ['calculus'], desc: 'calculus → Calculus courses' },
];

for (const { query, expectCourses, desc } of berkeleyHintTests) {
  const hints = getCourseHintSignals(expandAbbreviations(query));
  const matchedArr = [...hints.matchedCourseKeys];
  const anyExpectedMatch = expectCourses.some(ec => matchedArr.some(mc => mc.includes(ec)));
  assert(hints.hasHint && anyExpectedMatch, `${desc} (matched ${matchedArr.length} courses)`);
}

// Test 5: Berkeley Bio 1AL — numbered labs (Lab 1 through Lab 6)
console.log('\n── Test: "bio lab this week" (Berkeley Bio 1AL) ──');
const berkBioAnchors = makeTemporalAnchors('Biology 1AL', t => t.includes('lab') || t.includes('laboratory') || t.includes('pre'));
console.log(`  Anchors: ${berkBioAnchors.length} items`);
for (const r of berkBioAnchors) {
  const nums = extractLabSequenceNumbers(r.item);
  console.log(`    "${r.item.title}" (due ${r.item.dueAt}) → lab#[${nums}]`);
}

const berkBioExpanded = expandTemporalLabSiblings(berkBioAnchors, expandAbbreviations('bio lab'), null);
const berkBioNew = berkBioExpanded.filter(r => r.temporalLabExpansion);
console.log(`  Expanded: ${berkBioNew.length} siblings added`);
for (const r of berkBioNew) {
  const nums = extractLabSequenceNumbers(r.item);
  console.log(`    ✓ "${r.item.title}" → lab#[${nums}]`);
}

console.log('\n── Test: synthetic "bio lab" pulls Lab 9 page siblings ──');
const syntheticBioLab9 = {
  indexedContent: [
    {
      title: 'Lab 9 Vertebrate Anatomy Report',
      courseName: '2026 Spring Biology 1AL',
      type: 'assignment',
      url: 'https://example.edu/courses/1/assignments/91',
      dueAt: '2026-03-17T06:59:59Z'
    },
    {
      title: 'Lab 9 Pre-Lab Assessment',
      courseName: '2026 Spring Biology 1AL',
      type: 'assignment',
      url: 'https://example.edu/courses/1/assignments/92',
      dueAt: '2026-03-16T06:59:59Z'
    },
    {
      title: 'Lab 9A - Vertebrate Anatomy Introduction',
      courseName: '2026 Spring Biology 1AL',
      type: 'page',
      url: 'https://example.edu/courses/1/pages/lab-9a'
    },
    {
      title: 'Lab 9B - Rodent Dissection: External Features',
      courseName: '2026 Spring Biology 1AL',
      type: 'page',
      url: 'https://example.edu/courses/1/pages/lab-9b'
    },
    {
      title: 'Lab 9C - Rodent Dissection: Subcutaneous Anatomy',
      courseName: '2026 Spring Biology 1AL',
      type: 'page',
      url: 'https://example.edu/courses/1/pages/lab-9c'
    }
  ]
};
resetState(syntheticBioLab9);
const syntheticBioAnchors = makeTemporalAnchors('Biology 1AL', t => t.includes('lab') || t.includes('laboratory') || t.includes('pre'));
const syntheticBioExpanded = expandTemporalLabSiblings(syntheticBioAnchors, expandAbbreviations('bio lab'), null);
const syntheticBioNewTitles = syntheticBioExpanded
  .filter(r => r.temporalLabExpansion)
  .map(r => r.item.title);
assert(syntheticBioNewTitles.some(title => /Lab 9A/i.test(title)), 'Synthetic Bio Lab 9A page expands from broad "bio lab" query');
assert(syntheticBioNewTitles.some(title => /Lab 9B/i.test(title)), 'Synthetic Bio Lab 9B page expands from broad "bio lab" query');
assert(syntheticBioNewTitles.some(title => /Lab 9C/i.test(title)), 'Synthetic Bio Lab 9C page expands from broad "bio lab" query');

resetState(berkeleyData);

// Test 6: CRITICAL — Berkeley Chem 3BL uses LETTER-based labs ("PreLab B", "Lab A")
console.log('\n── Test: "chem lab this week" (Berkeley Chem 3BL - LETTER-based labs) ──');

// Show what Chem 3BL items look like
const chem3blItems = state.filteredContent.filter(i => i.courseName?.includes('Chem 3BL'));
const chem3blLabItems = chem3blItems.filter(i => isLabContextItem(i));
console.log(`  Chem 3BL: ${chem3blItems.length} total, ${chem3blLabItems.length} lab-context items`);

// Show which ones have extractable numbers
let extractableCount = 0;
let unextractableCount = 0;
const unextractable = [];
for (const item of chem3blLabItems) {
  const nums = extractLabSequenceNumbers(item);
  if (nums.length > 0) {
    extractableCount++;
  } else {
    unextractableCount++;
    unextractable.push(item.title);
  }
}
console.log(`  Extractable lab numbers: ${extractableCount}, Unextractable: ${unextractableCount}`);

if (unextractableCount > 0) {
  warn(`Chem 3BL: ${unextractableCount} lab items have NO extractable sequence number (letter-based labs)`);
  console.log('  Examples of unextractable items:');
  for (const title of unextractable.slice(0, 10)) {
    console.log(`    ✗ "${title}"`);
  }
  if (unextractable.length > 10) console.log(`    ... and ${unextractable.length - 10} more`);
}

// Try the expansion
const berkChemAnchors = makeTemporalAnchors('Chem 3BL', t => t.includes('lab') || t.includes('laboratory') || t.includes('prelab'));
console.log(`\n  Anchors (due this week): ${berkChemAnchors.length} items`);
for (const r of berkChemAnchors) {
  const nums = extractLabSequenceNumbers(r.item);
  console.log(`    "${r.item.title}" (due ${r.item.dueAt}) → lab#[${nums}]`);
}

const berkChemExpanded = expandTemporalLabSiblings(berkChemAnchors, expandAbbreviations('chem lab'), null);
const berkChemNew = berkChemExpanded.filter(r => r.temporalLabExpansion);
console.log(`  Expanded: ${berkChemNew.length} siblings added`);
for (const r of berkChemNew.slice(0, 10)) {
  const nums = extractLabSequenceNumbers(r.item);
  console.log(`    ✓ "${r.item.title}" → lab#[${nums}]`);
}
if (berkChemNew.length > 10) console.log(`    ... and ${berkChemNew.length - 10} more`);

// Test 7: Also check Chem 3AL (Fall 2025) — same letter pattern
console.log('\n── Test: Chem 3AL letter-based labs ──');
const chem3alItems = state.filteredContent.filter(i => i.courseName?.includes('Chem 3AL'));
const chem3alLabItems = chem3alItems.filter(i => isLabContextItem(i));
const chem3alUnextractable = chem3alLabItems.filter(i => extractLabSequenceNumbers(i).length === 0);
console.log(`  Chem 3AL: ${chem3alLabItems.length} lab items, ${chem3alUnextractable.length} unextractable`);
if (chem3alUnextractable.length > 0) {
  warn(`Chem 3AL: ${chem3alUnextractable.length} lab items have NO extractable sequence number`);
  for (const item of chem3alUnextractable.slice(0, 8)) {
    console.log(`    ✗ "${item.title}"`);
  }
  if (chem3alUnextractable.length > 8) console.log(`    ... and ${chem3alUnextractable.length - 8} more`);
}

// Test 8: Chem 1AL — uses "Lab 1: Airbags Prelab Quiz" format (colon after number)
console.log('\n── Test: Chem 1AL "Lab N: Description" format ──');
const chem1alItems = state.filteredContent.filter(i => i.courseName?.includes('Chem 1AL'));
const chem1alLabItems = chem1alItems.filter(i => isLabContextItem(i));
const chem1alExtractable = chem1alLabItems.filter(i => extractLabSequenceNumbers(i).length > 0);
const chem1alUnextractable = chem1alLabItems.filter(i => extractLabSequenceNumbers(i).length === 0);
console.log(`  Chem 1AL: ${chem1alLabItems.length} lab items, ${chem1alExtractable.length} extractable, ${chem1alUnextractable.length} unextractable`);

if (chem1alUnextractable.length > 0) {
  warn(`Chem 1AL: ${chem1alUnextractable.length} lab items unextractable`);
  for (const item of chem1alUnextractable.slice(0, 8)) {
    console.log(`    ✗ "${item.title}" → [${extractLabSequenceNumbers(item)}]`);
  }
}

// Show some extractable ones to verify correctness
for (const item of chem1alExtractable.slice(0, 5)) {
  const nums = extractLabSequenceNumbers(item);
  console.log(`    ✓ "${item.title}" → lab#[${nums}]`);
}

// Test 9: extractLabSequenceNumbers on Berkeley-specific patterns
console.log('\n── Test: extractLabSequenceNumbers on Berkeley patterns ──');

const berkeleyPatternTests = [
  // Letter-based (Chem 3AL/3BL)
  { title: 'PreLab B', expected: [], desc: 'letter-only PreLab (no number)' },
  { title: 'Lab A: IMFs and Acid-Base Chemistry Worksheet', expected: [], desc: 'letter-only Lab A (no number)' },
  { title: 'Lab B Notebook Pages', expected: [], desc: 'letter-only Lab B (no number)' },
  { title: 'Lab F Post-lab Assessment', expected: [], desc: 'letter-only Lab F (no number)' },
  // Numbered (Bio 1AL)
  { title: 'Lab 5 Pre-Lab Assessment ', expected: ['5'], desc: 'Bio 1AL standard numbering' },
  { title: 'Lab 1 Safety, Graphing & Stats Report', expected: ['1'], desc: 'Bio 1AL report' },
  { title: 'Lab 3 Cells Report', expected: ['3'], desc: 'Bio 1AL cells report' },
  { title: 'Lab 9A - Vertebrate Anatomy Introduction', expected: ['9'], desc: 'letter suffix maps to base lab number' },
  { title: 'Lab 9B - Rodent Dissection: External Features', expected: ['9'], desc: 'letter suffix B maps to base lab number' },
  { title: 'Lab 9A.1 - Optional Review Video', expected: ['9'], desc: 'letter suffix with dotted subsection maps to base lab number' },
  // Numbered with colon (Chem 1AL) — colon is now a valid boundary
  { title: 'Lab 1: Airbags Prelab Quiz', expected: ['1'], desc: 'colon after number (Chem 1AL)' },
  { title: 'Lab 2: Smells Prelab Quiz', expected: ['2'], desc: 'colon after number (Chem 1AL)' },
  // Numbered with prefix text
  { title: 'L2.1 Smells lab intro and bond line notation', expected: ['1'], desc: 'L2.1 shorthand — extracts 1 from standalone fallback' },
  { title: 'L11 (or 12) Dyes Lab Fri course capture', expected: [], desc: 'L11 shorthand — multiple numbers, no direct match → []' },
  // Lab Exam with time range — "6th" suffix prevents number extraction, "7-9pm" stripped
  { title: 'Lab Exam (Friday, December 6th 7-9pm)', expected: [], desc: 'Lab Exam — "6th" not a standalone number, time stripped → []' },
  // Zero case
  { title: 'Lab 0', expected: ['0'], desc: 'Lab 0' },
];

for (const { title, expected, desc } of berkeleyPatternTests) {
  const item = { title, moduleName: '', folderPath: '' };
  const result = extractLabSequenceNumbers(item);
  const pass = JSON.stringify(result.sort()) === JSON.stringify(expected.sort());
  if (pass) {
    assert(true, `${desc}: "${title}" → [${result}]`);
  } else {
    assert(false, `${desc}: "${title}" → [${result}] (expected [${expected}])`);
  }
}

// Test 10: Dynamic hints — check for false positives in large dataset
console.log('\n── Test: Dynamic hints — false positive check (Berkeley, 2780 items) ──');
const subjectIndex = getSubjectKeywordIndex();
const totalUniqueCourses = new Set(state.indexedContent.map(i => normalizeText(i.courseName || '')).filter(Boolean)).size;
console.log(`  Unique courses: ${totalUniqueCourses}, Subject keywords indexed: ${subjectIndex.size}`);

// Check that very common words are filtered
const commonWordTests = ['2026', '2025', '2024', 'fall', 'spring'];
for (const word of commonWordTests) {
  const courses = subjectIndex.get(word);
  if (courses && courses.size >= totalUniqueCourses * 0.5) {
    assert(true, `"${word}" filtered (in ${courses.size}/${totalUniqueCourses} courses, >50%)`);
  } else if (!courses) {
    assert(true, `"${word}" not in index (stop word or too short)`);
  } else {
    warn(`"${word}" is in index with ${courses.size} courses — may cause false positives`);
  }
}

// Check that a specific query doesn't match too many courses
const specificHints = getCourseHintSignals(expandAbbreviations('chem lab'));
assert(specificHints.matchedCourseKeys.size > 0 && specificHints.matchedCourseKeys.size <= 10,
  `"chem lab" matches reasonable number of courses (${specificHints.matchedCourseKeys.size})`);

console.log('  Courses matched by "chem lab":');
for (const c of specificHints.matchedCourseKeys) {
  console.log(`    → ${c}`);
}

// ═══════════════════════════════════════════════════════════════
// GUARD RAIL TESTS (both datasets)
// ═══════════════════════════════════════════════════════════════

console.log('\n\n╔' + '═'.repeat(68) + '╗');
console.log('║  GUARD RAIL TESTS                                                 ║');
console.log('╚' + '═'.repeat(68) + '╝');

resetState(ucsdData);
const guardAnchors = makeTemporalAnchors('PHYS 1BL', t => t.includes('prelab'));

assert(expandTemporalLabSiblings(guardAnchors, 'laboratory', null).filter(r => r.temporalLabExpansion).length === 0,
  'No course hint → no expansion');
assert(expandTemporalLabSiblings(guardAnchors, 'physics homework', null).filter(r => r.temporalLabExpansion).length === 0,
  'Non-lab query → no expansion');
assert(expandTemporalLabSiblings([], 'physics laboratory', null).length === 0,
  'Empty input → empty output');

// ═══════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════

console.log('\n\n' + '═'.repeat(70));
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (warnings.length > 0) {
  console.log(`\n⚠️  ${warnings.length} WARNINGS (potential issues to address):`);
  for (let i = 0; i < warnings.length; i++) {
    console.log(`  ${i + 1}. ${warnings[i]}`);
  }
}
console.log('═'.repeat(70));

process.exit(failed > 0 ? 1 : 0);
