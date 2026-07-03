import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.resolve(__dirname, '..', 'src', 'core', 'character-profile.js');
const srcCode = fs.readFileSync(srcPath, 'utf8');
const sidepanelHtml = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
const sidepanelJs = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'sidepanel', 'sidepanel.js'), 'utf8');

// --- Chrome storage mock (stateful so load/save/clear actually round-trip) ---
let mockStorage = {};
function installChrome(initial = {}) {
  mockStorage = JSON.parse(JSON.stringify(initial));
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          ks.forEach((k) => { if (k in mockStorage) out[k] = mockStorage[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(mockStorage, obj); },
        remove: async (k) => { delete mockStorage[k]; }
      }
    }
  };
}

// The module is an IIFE that attaches to `self`. Bind `self` to a sandbox so
// we can both read the export and inject a sync spy (self.CanvascopeAgentSync).
// RAGCore is intentionally left undefined so gatherSignals exercises its
// "new user / empty corpus" path.
function loadSandbox() {
  const sandbox = {};
  new Function('self', srcCode)(sandbox);
  return sandbox;
}

function withSyncSpy(sandbox) {
  const pushes = [];
  sandbox.CanvascopeAgentSync = { pushKey: (key, value) => pushes.push({ key, value }) };
  return pushes;
}

installChrome();
const SB = loadSandbox();
const CP = SB.CanvascopeCharacterProfile;

test('enabled by default — consents without an explicit opt-in', async () => {
  installChrome();
  const state = await CP.load();
  assert.equal(state.enabled, true, 'enabled must default to true');
  assert.equal(state.paused, false);
});

test('can be turned off — setEnabled(false) stops suggestions', async () => {
  installChrome({ canvasGradesByCourse: { c1: { name: 'BIO 1A', current: 72, letter: 'C-' } } });
  // On by default, so a low grade surfaces immediately.
  assert.ok((await CP.getSuggestions()).length >= 1, 'suggestions flow by default');
  await CP.setEnabled(false);
  assert.deepEqual(await CP.getSuggestions(), [], 'opting out silences suggestions');
});

test('save mirrors the blob to Supabase via the sync glue', async () => {
  installChrome();
  const pushes = withSyncSpy(SB);
  await CP.setPaused(true);
  assert.equal(pushes.length, 1, 'one sync push');
  assert.equal(pushes[0].key, CP.STORAGE_KEY);
  assert.equal(pushes[0].value.paused, true);
  delete SB.CanvascopeAgentSync;
});

test('lms_visit summaries are LMS title-only (no URL, no raw content)', () => {
  const now = Date.UTC(2026, 5, 30, 12, 0, 0);
  const out = CP._lmsVisitSummaries([
    { title: 'CHEM 120 — Module 4', url: 'https://x.instructure.com/courses/9/pages/m4', lastVisit: now },
    { title: '', url: 'https://x.instructure.com/courses/9' }
  ], now);
  assert.equal(out.length, 1, 'untitled visit dropped');
  assert.equal(out[0].kind, 'lms_visit');
  assert.equal(out[0].text, 'CHEM 120 — Module 4');
  assert.ok(!('url' in out[0]), 'no URL persisted to the cloud summary');
  assert.ok(/history/i.test(out[0].sources[0]));
  // The whole synced blob must still pass the no-raw-content invariant.
  CP._assertNoRawContent({ enabled: true, paused: false, dismissed: [], summaries: out, updatedAt: null });
});

test('student profile summaries use short labels and omit name/freeform body', () => {
  const now = Date.UTC(2026, 5, 30, 12, 0, 0);
  const out = CP._studentProfileSummaries({
    facts: {
      who: {
        fullName: 'Noel Sason',
        school: 'UC Berkeley',
        majors: ['Molecular and Cell Biology', 'Data Science'],
        year: 'Junior',
        goals: ['medicine', 'founder']
      },
      how: { studyStyle: 'Long private body that should stay in studentProfile only.' }
    }
  }, now);
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => s.sources.includes('Canvascope Student Profile')));
  assert.ok(out.every((s) => s.text.length <= 160));
  assert.ok(!out.some((s) => /Noel|Long private body/.test(s.text)), 'no name or freeform body in Character Profile summaries');
  CP._assertNoRawContent({ enabled: true, paused: false, dismissed: [], summaries: out, updatedAt: null });
});

test('pause stops suggestions without erasing consent', async () => {
  installChrome({ canvasGradesByCourse: { c1: { name: 'BIO 1A', current: 72, letter: 'C-' } } });
  await CP.setPaused(true);
  assert.equal(await CP.isActive(), false);
  assert.deepEqual(await CP.getSuggestions(), [], 'paused yields no suggestions');
  await CP.setPaused(false);
  assert.ok((await CP.getSuggestions()).length >= 1);
  assert.equal((await CP.load()).enabled, true, 'pause must not clear consent');
});

test('clear wipes local AND tombstones the synced row', async () => {
  installChrome();
  const pushes = withSyncSpy(SB);
  await CP.setPaused(true);
  await CP.clear();
  assert.equal(CP.STORAGE_KEY in mockStorage, false, 'clear removes the local key');
  const tombstone = pushes[pushes.length - 1];
  assert.equal(tombstone.key, CP.STORAGE_KEY);
  assert.equal(tombstone.value.enabled, false, 'remote row overwritten with disabled state');
  assert.deepEqual(tombstone.value.summaries, [], 'no summaries survive on the server');
  delete SB.CanvascopeAgentSync;
});

test('getSuggestions persists content-light source-attributed summaries', async () => {
  installChrome({ canvasGradesByCourse: { c1: { name: 'BIO 1A', current: 68, letter: 'D+' } } });
  await CP.getSuggestions();
  const stored = mockStorage[CP.STORAGE_KEY];
  assert.ok(Array.isArray(stored.summaries) && stored.summaries.length >= 1, 'summaries persisted');
  const s = stored.summaries[0];
  assert.ok(s.sources.every((src) => /Canvascope/.test(src)), 'summary names a first-party source');
  assert.ok(s.text.length <= 160, 'summary is a short label, not a body');
  CP._assertNoRawContent(stored);
});

test('inspect returns only content-light profile state and current suggestions', async () => {
  installChrome({ canvasGradesByCourse: { c1: { name: 'BIO 1A', current: 68, letter: 'D+' } } });
  await CP.dismiss('cp_123abc');
  const view = await CP.inspect();
  assert.equal(view.enabled, true);
  assert.equal(view.paused, false);
  assert.equal(view.dismissedCount, 1);
  assert.equal(view.synced, true);
  assert.ok(Array.isArray(view.summaries), 'summaries are visible for inspection');
  assert.ok(Array.isArray(view.suggestions), 'suggestions are visible for inspection');
  CP._assertNoRawContent(mockStorage[CP.STORAGE_KEY]);
});

test('dismiss hides a suggestion and persists only its id', async () => {
  installChrome({ canvasGradesByCourse: { c1: { name: 'BIO 1A', current: 72, letter: 'C-' } } });
  const [s] = await CP.getSuggestions();
  assert.ok(s, 'have a suggestion to dismiss');
  await CP.dismiss(s.id);
  const after = await CP.getSuggestions();
  assert.ok(!after.find((x) => x.id === s.id), 'dismissed suggestion no longer appears');
  CP._assertNoRawContent(mockStorage[CP.STORAGE_KEY]);
});

test('the no-raw-content invariant rejects bodies and bad shapes', () => {
  const base = { enabled: true, paused: false, dismissed: [], summaries: [], updatedAt: null };
  assert.doesNotThrow(() => CP._assertNoRawContent(base));
  // An unexpected key (e.g. a raw page body) is rejected.
  assert.throws(() => CP._assertNoRawContent({ ...base, pageText: 'lecture notes...' }));
  // A dismissed entry that is content rather than an id is rejected.
  assert.throws(() => CP._assertNoRawContent({ ...base, dismissed: ['chem lab notes'] }));
  // A summary longer than the label cap (a smuggled body) is rejected.
  assert.throws(() => CP._assertNoRawContent({ ...base, summaries: [{ kind: 'x', text: 'a'.repeat(500), sources: ['Canvascope'] }] }));
  // A summary without named sources is rejected.
  assert.throws(() => CP._assertNoRawContent({ ...base, summaries: [{ kind: 'x', text: 'ok', sources: 'Canvascope' }] }));
});

test('every suggestion carries a why and named sources (provenance)', () => {
  const now = Date.UTC(2026, 5, 30, 12, 0, 0);
  const suggestions = CP._deriveSuggestions({
    searches: [
      { query: 'thermo problem set', timestamp: now - 2 * 86400000 },
      { query: 'thermo problem set 2', timestamp: now - 1 * 86400000 }
    ],
    upcoming: [
      { title: 'Lab 7 Report', courseName: 'CHEM 120', type: 'assignment', dueAt: new Date(now + 2 * 86400000).toISOString() }
    ],
    grades: [{ course: 'BIO 1A', percent: 68, letter: 'D+' }]
  }, { now });

  assert.equal(suggestions.length, 3, 'one of each kind');
  for (const s of suggestions) {
    assert.ok(s.id.startsWith('cp_'), 'stable id');
    assert.ok(s.why && s.why.length > 0, `${s.kind} has a why`);
    assert.ok(Array.isArray(s.sources) && s.sources.length > 0, `${s.kind} names its source`);
    assert.ok(s.sources.every((src) => /Canvascope/.test(src)), 'sources are first-party Canvascope');
    assert.deepEqual(s.controls, ['not_useful', 'pause', 'delete']);
  }
  assert.deepEqual(suggestions.map((s) => s.kind), ['deadline', 'grade', 'resume_search']);
});

test('deriveSuggestions is deterministic and respects the dismissed set', () => {
  const now = Date.UTC(2026, 5, 30, 12, 0, 0);
  const signals = { grades: [{ course: 'BIO 1A', percent: 70, letter: 'C-' }] };
  const a = CP._deriveSuggestions(signals, { now });
  const b = CP._deriveSuggestions(signals, { now });
  assert.deepEqual(a, b, 'pure: same input, same output');
  const dropped = CP._deriveSuggestions(signals, { now, dismissed: [a[0].id] });
  assert.equal(dropped.length, 0, 'dismissed id is filtered out');
});

test('grade suggestion only fires below the attention threshold', () => {
  const now = Date.now();
  assert.equal(CP._deriveSuggestions({ grades: [{ course: 'X', percent: 95, letter: 'A' }] }, { now }).length, 0);
  assert.equal(CP._deriveSuggestions({ grades: [{ course: 'X', percent: 80, letter: 'B-' }] }, { now }).length, 1);
});

test('resume_page suggestion appears only when history signal is present', () => {
  const now = Date.UTC(2026, 5, 30, 12, 0, 0);
  const withHistory = CP._deriveSuggestions({
    recentPages: [{ title: 'CHEM 120 — Module 4', url: 'https://x.instructure.com/courses/9/pages/m4', lastVisit: now - 3600000 }],
    grades: [{ course: 'BIO 1A', percent: 70, letter: 'C-' }]
  }, { now });
  const resume = withHistory.find((s) => s.kind === 'resume_page');
  assert.ok(resume, 'history signal yields a resume_page suggestion');
  assert.ok(/history/i.test(resume.sources[0]), 'source names browsing history');
  assert.equal(resume.targetUrl, 'https://x.instructure.com/courses/9/pages/m4', 'URL is returned for the live UI only');
  // Ordered right after the deadline tier (no deadline here → first).
  assert.equal(withHistory[0].kind, 'resume_page');
  // No history signal → no resume_page.
  const without = CP._deriveSuggestions({ grades: [{ course: 'BIO 1A', percent: 70, letter: 'C-' }] }, { now });
  assert.ok(!without.find((s) => s.kind === 'resume_page'));
});

test('deadlines outside the 7-day window are not surfaced', () => {
  const now = Date.UTC(2026, 5, 30, 12, 0, 0);
  const far = { upcoming: [{ title: 'Final', courseName: 'CHEM 120', type: 'assignment', dueAt: new Date(now + 30 * 86400000).toISOString() }] };
  assert.equal(CP._deriveSuggestions(far, { now }).length, 0, 'far deadline excluded');
});

test('side panel exposes top-level Character Profile controls', () => {
  assert.match(sidepanelHtml, /id="character-profile-controls"/);
  assert.match(sidepanelHtml, /id="cpf-enabled"[^>]*type="checkbox"/);
  assert.match(sidepanelHtml, /id="cpf-paused"[^>]*type="checkbox"/);
  assert.match(sidepanelHtml, /id="cpf-summaries"/);
  assert.match(sidepanelHtml, /id="cpf-clear"/);
});

test('side panel controls call the Character Profile state API', () => {
  assert.match(sidepanelJs, /characterProfile\.inspect\(\)/);
  assert.match(sidepanelJs, /characterProfile\.setEnabled\(cpfEnabled\.checked\)/);
  assert.match(sidepanelJs, /characterProfile\.setPaused\(cpfPaused\.checked\)/);
  assert.match(sidepanelJs, /characterProfile\.clear\(\)/);
  assert.match(sidepanelJs, /refreshCharacterSuggestions\s*=\s*render/);
});
