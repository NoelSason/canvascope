/**
 * Canvascope — Character Profile (Phase 1: Canvascope-only)
 *
 * A user-owned personalization layer that predicts the next thing the student
 * may want to work on, using Canvascope-owned signals that already live on the
 * device plus narrowly scoped browser affordances disclosed in the manifest:
 *   - search history          (chrome.storage.local `searchHistory`)
 *   - search click affinity   (chrome.storage.local `searchHabits`)
 *   - current grades          (chrome.storage.local `canvasGradesByCourse`)
 *   - upcoming work + to-dos  (RAGCore.getUpcomingItems over the local corpus)
 *   - recent LMS pages        (chrome.history, LMS/course hosts only)
 *   - dismissed Up Next tasks (chrome.storage.local `dismissedTasks`)
 *
 * Phase-1 guardrails (see characterProfile/ROADMAP.md + AGENT_WORKFLOW.md):
 *   - Local-first. Only source-attributed summaries sync when signed in.
 *   - Enabled by default, with pause, dismiss, clear, and delete controls.
 *   - Suggestions only — never submits or alters work; user clicks are explicit.
 *   - Every suggestion carries a plain-language `why` and named `sources`.
 *   - The stored blob holds NO raw content (no query bodies, no document text):
 *     only consent flags, dismissed ids, and short derived summaries. Raw
 *     signals are read live from their existing stores and never copied in.
 *   - Full controls: inspect, pause, dismiss (per-item), and clear/delete.
 *
 * Loaded into the service worker via importScripts AND the side panel via a
 * <script> tag; attaches to `self` (=== window in the panel).
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'characterProfile';

  // The ONLY keys the blob may hold. It carries the consent flags, dismissed
  // suggestion ids, and a capped list of SOURCE-ATTRIBUTED derived summaries —
  // never raw page/document/prompt bodies. _assertNoRawContent enforces this.
  const ALLOWED_KEYS = ['enabled', 'paused', 'dismissed', 'summaries', 'updatedAt'];

  const DEFAULT_STATE = {
    enabled: true,    // on by default (see docs/TERMS.md + docs/PRIVACY.md)
    paused: false,    // temporary pause; consent stays, suggestions stop
    dismissed: [],     // ids of suggestions the user marked "not useful"
    summaries: [],     // [{ kind, text, sources, ts }] — derived, content-light
    updatedAt: null
  };

  const MAX_SUGGESTIONS = 3;
  const MAX_SUMMARIES = 20;           // cap the synced derived-summary history
  const SUMMARY_TEXT_CAP = 160;       // a summary is a short label, not a body
  const GRADE_ATTENTION_PCT = 80;     // a current grade at/below this is flagged
  const DEADLINE_WINDOW_DAYS = 7;     // only surface deadlines this close
  const SEARCH_LOOKBACK_DAYS = 14;    // "recent" window for repeated searches
  const DAY_MS = 24 * 60 * 60 * 1000;

  // ---- Pure helpers (no I/O — unit tested directly) ------------------------

  /** Deterministic, collision-resistant-enough id for a suggestion. */
  function hashSuggestion(key) {
    let h = 0x811c9dc5; // FNV-1a 32-bit
    const s = String(key);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return 'cp_' + (h >>> 0).toString(36);
  }

  /** Human "due ..." phrasing relative to now. */
  function relativeDue(dueAt, now) {
    const t = new Date(dueAt).getTime();
    if (Number.isNaN(t)) return 'soon';
    const days = Math.round((t - now) / DAY_MS);
    if (days < 0) return 'overdue';
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days <= 7) return `in ${days} days`;
    return `on ${new Date(t).toISOString().slice(0, 10)}`;
  }

  /** Collapse "Chem Lab 4" / "chem lab" into a base query for repeat-counting. */
  function baseQueryOf(query) {
    return String(query || '')
      .toLowerCase()
      .replace(/\d+/g, '')
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Content-light "which search topic does the student keep clicking back
   * into" signal, derived from searchHabits.queryAffinity (query -> {
   * resultKey: clickCount }). Informational only — not an actionable card.
   */
  function searchAffinitySummaries(searchHabits, now) {
    const affinity = searchHabits && searchHabits.queryAffinity;
    if (!affinity || typeof affinity !== 'object') return [];
    let best = null;
    for (const [query, clicksByKey] of Object.entries(affinity)) {
      if (!clicksByKey || typeof clicksByKey !== 'object') continue;
      const total = Object.values(clicksByKey).reduce((sum, n) => sum + (Number(n) || 0), 0);
      if (total >= 2 && (!best || total > best.total)) best = { query, total };
    }
    if (!best) return [];
    return [{
      kind: 'search_affinity',
      text: `Frequently returns to search results for "${best.query}"`.slice(0, SUMMARY_TEXT_CAP),
      sources: ['Canvascope search click activity'],
      ts: now
    }];
  }

  /**
   * Content-light count of to-dos/assignments dismissed from Up Next — a
   * disengagement signal for future profile tuning. dismissedTasks stores
   * ids only (no timestamps), so this is a total count, not a time-windowed
   * figure.
   */
  function disengagementSummaries(dismissedTasks, now) {
    const n = Array.isArray(dismissedTasks) ? dismissedTasks.length : 0;
    if (!n) return [];
    return [{
      kind: 'disengagement',
      text: `${n} task${n === 1 ? '' : 's'} dismissed from Up Next`.slice(0, SUMMARY_TEXT_CAP),
      sources: ['Canvascope Up Next dismissals'],
      ts: now
    }];
  }

  /**
   * Derive the candidate suggestions from already-collected signals. Pure:
   * deterministic given (signals, opts). Returns at most MAX_SUGGESTIONS,
   * highest-confidence first, with dismissed ids removed.
   *
   * @param {{searches?: Array<{query:string,timestamp:number}>,
   *          upcoming?: Array<{title:string,courseName:string,type:string,dueAt:?string}>,
   *          grades?: Array<{course:string,percent:number,letter:string}>}} signals
   * @param {{now?: number, dismissed?: string[]}} [opts]
   */
  function deriveSuggestions(signals, opts) {
    const now = (opts && opts.now) || Date.now();
    const dismissed = new Set((opts && opts.dismissed) || []);
    const out = [];

    // 1. Nearest deadline within the window (weight 3 — most actionable).
    const dated = (signals.upcoming || [])
      .filter((i) => i && i.type === 'assignment' && i.dueAt)
      .map((i) => ({ ...i, _t: new Date(i.dueAt).getTime() }))
      .filter((i) => !Number.isNaN(i._t) && i._t >= now - DAY_MS && i._t <= now + DEADLINE_WINDOW_DAYS * DAY_MS)
      .sort((a, b) => a._t - b._t);
    if (dated.length) {
      const i = dated[0];
      out.push({
        kind: 'deadline',
        weight: 3,
        label: `Work on "${i.title}"${i.courseName ? ` for ${i.courseName}` : ''}`,
        why: `It's due ${relativeDue(i.dueAt, now)} — the soonest deadline in your synced courses.`,
        sources: ['Canvascope assignment metadata']
      });
    }

    // 1b. Resume the most recent LMS page the student was on. The history
    //     helper only returns supported LMS/course hosts and no-ops if the
    //     permission is unavailable.
    const recent = (signals.recentPages || [])
      .filter((p) => p && p.url)
      .sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0));
    if (recent.length) {
      const p = recent[0];
      out.push({
        kind: 'resume_page',
        weight: 2.5,
        label: `Resume "${p.title || p.url}"`,
        why: 'This is the most recent course page you visited — pick up where you left off.',
        sources: ['Your browsing history on supported course sites'],
        targetUrl: p.url
      });
    }

    // 2. Lowest grade that needs attention (weight 2).
    const ranked = (signals.grades || [])
      .filter((g) => g && Number.isFinite(g.percent))
      .sort((a, b) => a.percent - b.percent);
    const low = ranked.find((g) => g.percent <= GRADE_ATTENTION_PCT);
    if (low) {
      out.push({
        kind: 'grade',
        weight: 2,
        label: `Review ${low.course}`,
        why: `Your current grade in ${low.course} is ${low.percent}%${low.letter ? ` (${low.letter})` : ''} — your lowest right now.`,
        sources: ['Canvascope grades']
      });
    }

    // 3. A search the student repeated recently but may not have finished
    //    (weight 1). Counts repeats of the same base query in the lookback.
    const cutoff = now - SEARCH_LOOKBACK_DAYS * DAY_MS;
    const counts = new Map(); // base -> { n, lastQuery }
    (signals.searches || []).forEach((s) => {
      if (!s || !s.query || !(s.timestamp >= cutoff)) return;
      const base = baseQueryOf(s.query);
      if (base.length < 3) return;
      const cur = counts.get(base) || { n: 0, lastQuery: s.query };
      cur.n += 1;
      counts.set(base, cur);
    });
    const repeated = [...counts.entries()]
      .filter(([, v]) => v.n >= 2)
      .sort((a, b) => b[1].n - a[1].n)[0];
    if (repeated) {
      const [, v] = repeated;
      out.push({
        kind: 'resume_search',
        weight: 1,
        label: `Pick up your search for "${v.lastQuery}"`,
        why: `You searched for this ${v.n} times in the last ${SEARCH_LOOKBACK_DAYS} days.`,
        sources: ['Canvascope searches']
      });
    }

    return out
      .map((s) => ({
        id: hashSuggestion(`${s.kind}:${s.label}`),
        kind: s.kind,
        label: s.label,
        why: s.why,
        sources: s.sources,
        targetUrl: s.targetUrl,
        controls: ['not_useful', 'pause', 'delete']
      }))
      .filter((s) => !dismissed.has(s.id))
      .slice(0, MAX_SUGGESTIONS); // already weight-ordered by push order
  }

  /** Build the content-light, source-attributed summaries from suggestions. */
  function summariesFromSuggestions(suggestions, now) {
    return (suggestions || []).map((s) => ({
      kind: s.kind,
      text: String(s.label || '').slice(0, SUMMARY_TEXT_CAP),
      sources: Array.isArray(s.sources) ? s.sources.slice() : [],
      ts: now
    }));
  }

  /**
   * Bounded "browser history" for the profile: short summaries of recent
   * SUPPORTED COURSE-SITE visits only. Stores the page TITLE only — never the
   * URL, never non-LMS history, never raw page content. This is the cross-
   * device signal behind "Resume where you left off"; the live URL to actually
   * open a page stays on-device (signals.recentPages), out of the cloud.
   */
  function lmsVisitSummaries(recentPages, now) {
    return (recentPages || [])
      .filter((p) => p && (p.title || p.url))
      .slice(0, 8)
      .map((p) => ({
        kind: 'lms_visit',
        text: String(p.title || '').slice(0, SUMMARY_TEXT_CAP),
        sources: ['Your browsing history on supported course sites'],
        ts: p.lastVisit || now
      }))
      .filter((s) => s.text);
  }

  /** Short, non-name profile labels from the user-edited Student Profile. */
  function studentProfileSummaries(studentProfile, now) {
    const facts = studentProfile?.facts || {};
    const who = facts.who || {};
    const out = [];
    const schoolBits = [
      who.year ? String(who.year) : '',
      Array.isArray(who.majors) && who.majors.length ? `major: ${who.majors.slice(0, 3).join(', ')}` : '',
      who.school ? String(who.school) : ''
    ].filter(Boolean);
    if (schoolBits.length) {
      out.push({
        kind: 'student_profile',
        text: schoolBits.join(' · ').slice(0, SUMMARY_TEXT_CAP),
        sources: ['Canvascope Student Profile'],
        ts: now
      });
    }
    if (Array.isArray(who.goals) && who.goals.length) {
      out.push({
        kind: 'student_goal',
        text: `Career goal: ${who.goals.slice(0, 3).join(', ')}`.slice(0, SUMMARY_TEXT_CAP),
        sources: ['Canvascope Student Profile'],
        ts: now
      });
    }
    return out;
  }

  /**
   * Invariant check used by tests + before every cloud sync: the persisted
   * blob may only contain the allowed keys, `dismissed` must be a list of
   * short ids, and `summaries` must be short source-attributed strings — never
   * raw query/document/prompt bodies.
   */
  function assertNoRawContent(state) {
    if (!state || typeof state !== 'object') return true;
    for (const k of Object.keys(state)) {
      if (!ALLOWED_KEYS.includes(k)) {
        throw new Error(`character-profile: unexpected stored key "${k}" — raw content must not be persisted`);
      }
    }
    const ids = state.dismissed || [];
    if (!Array.isArray(ids)) throw new Error('character-profile: dismissed must be an array');
    for (const id of ids) {
      if (typeof id !== 'string' || !/^cp_[0-9a-z]+$/.test(id)) {
        throw new Error('character-profile: dismissed entries must be suggestion ids, not content');
      }
    }
    const summaries = state.summaries || [];
    if (!Array.isArray(summaries)) throw new Error('character-profile: summaries must be an array');
    for (const s of summaries) {
      if (!s || typeof s !== 'object' || !Array.isArray(s.sources)) {
        throw new Error('character-profile: each summary must be a source-attributed object');
      }
      if (typeof s.text !== 'string' || s.text.length > SUMMARY_TEXT_CAP) {
        throw new Error('character-profile: summary text must be a short derived label, not a body');
      }
    }
    return true;
  }

  // ---- Stateful API (chrome.storage.local; synced when signed in) ----------

  function normalize(raw) {
    const base = { ...DEFAULT_STATE };
    if (!raw || typeof raw !== 'object') return base;
    return {
      // `enabled` defaults to true, so only an explicit `false` turns it off.
      enabled: raw.enabled !== false,
      paused: !!raw.paused,
      dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.slice() : [],
      summaries: Array.isArray(raw.summaries) ? raw.summaries.slice(-MAX_SUMMARIES) : [],
      updatedAt: raw.updatedAt || null
    };
  }

  const CharacterProfile = {
    async load() {
      const db = await chrome.storage.local.get([STORAGE_KEY]);
      return normalize(db[STORAGE_KEY]);
    },

    /**
     * Persist a patch locally AND mirror it to Supabase (`character_profile`
     * table) via the existing debounced csTools sync, so the profile follows
     * the signed-in student across devices. The no-raw-content invariant is
     * asserted before anything is written.
     */
    async save(patch) {
      const current = await this.load();
      const next = normalize({ ...current, ...(patch || {}), updatedAt: new Date().toISOString() });
      assertNoRawContent(next);
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      try {
        self.CanvascopeAgentSync?.pushKey?.(STORAGE_KEY, next);
      } catch (_) { /* sync is best-effort; signed-out stays local */ }
      return next;
    },

    async isEnabled() {
      return (await this.load()).enabled;
    },

    /** The consent gate. Turning it off does not erase the blob; clear() does. */
    async setEnabled(enabled) {
      return this.save({ enabled: !!enabled });
    },

    async setPaused(paused) {
      return this.save({ paused: !!paused });
    },

    /** Active = consented AND not paused. Suggestions only flow when active. */
    async isActive() {
      const s = await this.load();
      return s.enabled && !s.paused;
    },

    async dismiss(id) {
      const s = await this.load();
      if (!id || s.dismissed.includes(id)) return s;
      return this.save({ dismissed: s.dismissed.concat(id) });
    },

    /**
     * Real deletion: removes the local blob AND tombstones the synced row so
     * the derived summaries do not survive on the server or other devices.
     */
    async clear() {
      await chrome.storage.local.remove(STORAGE_KEY);
      try {
        // Push an empty, disabled state to overwrite the remote row.
        self.CanvascopeAgentSync?.pushKey?.(STORAGE_KEY, { ...DEFAULT_STATE, enabled: false, updatedAt: new Date().toISOString() });
      } catch (_) { /* best-effort remote clear */ }
      return { ...DEFAULT_STATE };
    },

    /**
     * Read the live first-party signals from their existing stores. Nothing
     * here is persisted into the profile blob.
     */
    async gatherSignals() {
      const signals = {
        searches: [], upcoming: [], grades: [], recentPages: [], studentProfile: null,
        searchHabits: null, dismissedTasks: []
      };
      try {
        const db = await chrome.storage.local.get([
          'searchHistory', 'canvasGradesByCourse', 'studentProfile',
          'searchHabits', 'dismissedTasks'
        ]);
        signals.searches = Array.isArray(db.searchHistory) ? db.searchHistory : [];
        const gradeMap = db.canvasGradesByCourse || {};
        signals.grades = Object.values(gradeMap).map((g) => ({
          course: g.name, percent: g.current, letter: g.letter
        }));
        signals.studentProfile = db.studentProfile || null;
        signals.searchHabits = db.searchHabits || null;
        signals.dismissedTasks = Array.isArray(db.dismissedTasks) ? db.dismissedTasks : [];
      } catch (_) { /* storage read is best-effort */ }
      try {
        if (typeof RAGCore !== 'undefined') {
          const corpus = await RAGCore.buildCorpus();
          signals.upcoming = RAGCore.getUpcomingItems(corpus, 25);
        }
      } catch (_) { /* corpus may be empty for new users */ }
      try {
        if (self.CanvascopeOptionalCapabilities) {
          signals.recentPages = await self.CanvascopeOptionalCapabilities.getRecentLmsHistory({ maxItems: 5 });
        }
      } catch (_) { /* history is unavailable */ }
      return signals;
    },

    /**
     * The Phase-1 product surface: a small set of explained suggestions.
     * Returns [] unless the feature is enabled and not paused. As a side
     * effect, the derived (content-light, source-attributed) summaries are
     * persisted and synced so the profile carries across devices — but only
     * when they actually changed, to avoid sync churn.
     */
    async getSuggestions(now) {
      const state = await this.load();
      if (!state.enabled || state.paused) return [];
      const ts = now || Date.now();
      const signals = await this.gatherSignals();
      const suggestions = deriveSuggestions(signals, { now: ts, dismissed: state.dismissed });

      // Synced summaries = the rendered suggestions + a capped list of recent
      // course-site visit titles (bounded "browser history"; LMS-only, titles
      // only, no URLs/clipboard/raw content). Dedupe by text.
      const merged = [];
      const seenText = new Set();
      [
        ...summariesFromSuggestions(suggestions, ts),
        ...lmsVisitSummaries(signals.recentPages, ts),
        ...studentProfileSummaries(signals.studentProfile, ts),
        ...searchAffinitySummaries(signals.searchHabits, ts),
        ...disengagementSummaries(signals.dismissedTasks, ts)
      ]
        .forEach((s) => { if (s.text && !seenText.has(s.text)) { seenText.add(s.text); merged.push(s); } });

      const prevKey = JSON.stringify((state.summaries || []).map((s) => s.text));
      const nextKey = JSON.stringify(merged.map((s) => s.text));
      if (merged.length && prevKey !== nextKey) {
        // save() asserts the no-raw-content invariant and triggers the sync.
        await this.save({ summaries: merged });
      }
      return suggestions;
    },

    /** Everything the user can see about their profile (content-light). */
    async inspect() {
      const state = await this.load();
      return {
        enabled: state.enabled,
        paused: state.paused,
        dismissedCount: state.dismissed.length,
        summaries: state.summaries,
        synced: true, // mirrored to Supabase `character_profile` when signed in
        updatedAt: state.updatedAt,
        suggestions: (state.enabled && !state.paused) ? await this.getSuggestions() : []
      };
    },

    // Exposed for tests.
    STORAGE_KEY,
    DEFAULT_STATE,
    _deriveSuggestions: deriveSuggestions,
    _summariesFromSuggestions: summariesFromSuggestions,
    _lmsVisitSummaries: lmsVisitSummaries,
    _studentProfileSummaries: studentProfileSummaries,
    _searchAffinitySummaries: searchAffinitySummaries,
    _disengagementSummaries: disengagementSummaries,
    _hashSuggestion: hashSuggestion,
    _relativeDue: relativeDue,
    _baseQueryOf: baseQueryOf,
    _assertNoRawContent: assertNoRawContent
  };

  self.CanvascopeCharacterProfile = CharacterProfile;
})();
