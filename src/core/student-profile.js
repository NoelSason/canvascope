/**
 * Canvascope v10 — Student Profile.
 * A small, durable layer of facts about the student (who/what/how + an
 * auto-captured layer) that personalizes Chat, Course Brain, and Smart
 * Planner. Source of truth is the Supabase student_profile row (synced via
 * background messages); chrome.storage.local.studentProfile is the instant,
 * offline cache — the same dual pattern the corpus uses.
 *
 * The compiled block is ALWAYS injected via the AI route's `system` argument,
 * never the `corpus` block: corpus must stay byte-identical across questions
 * so claude-proxy's prompt cache keeps hitting.
 */
(() => {
  const CACHE_KEY = 'studentProfile';
  const listeners = new Set();

  const EMPTY_FACTS = () => ({
    who: { fullName: '', school: '', majors: [], year: '', goals: [] },
    what: { courses: [], tools: [] },
    how: { tone: '', verbosity: '', studyStyle: '' },
    _auto: {}
  });

  let facts = EMPTY_FACTS();
  let updatedAt = null; // ISO string of last local mutation
  let loaded = false;

  function emit() {
    listeners.forEach((fn) => {
      try { fn(get()); } catch (_) { /* listener errors are not ours */ }
    });
  }

  function sendMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        void chrome.runtime.lastError;
        resolve(response || { success: false });
      });
    });
  }

  /** Normalize an unknown stored shape into the canonical facts object. */
  function normalize(raw) {
    const base = EMPTY_FACTS();
    if (!raw || typeof raw !== 'object') return base;
    return {
      who: { ...base.who, ...(raw.who || {}) },
      what: { ...base.what, ...(raw.what || {}) },
      how: { ...base.how, ...(raw.how || {}) },
      _auto: (raw._auto && typeof raw._auto === 'object') ? raw._auto : {}
    };
  }

  function isEmptyValue(v) {
    if (Array.isArray(v)) return v.length === 0;
    return v == null || String(v).trim() === '';
  }

  /** True when no manual (user-entered) fact is set; ignores the auto layer. */
  function isManualEmpty() {
    return ![
      ...Object.values(facts.who),
      ...Object.values(facts.what),
      ...Object.values(facts.how)
    ].some(v => !isEmptyValue(v));
  }

  /** True when no manual fact and no auto fact is set. */
  function isEmpty() {
    return isManualEmpty() && Object.keys(facts._auto).length === 0;
  }

  async function writeCache() {
    await chrome.storage.local.set({ [CACHE_KEY]: { facts, updatedAt } });
  }

  /**
   * Load the cached profile immediately, then reconcile with the remote row.
   * Remote wins when its updated_at is newer; a newer local copy (offline
   * edits) is pushed back up.
   */
  async function load() {
    const db = await chrome.storage.local.get([CACHE_KEY]);
    const cached = db[CACHE_KEY];
    if (cached && cached.facts) {
      facts = normalize(cached.facts);
      updatedAt = cached.updatedAt || null;
    }
    loaded = true;
    emit();

    // Reconcile with Supabase in the background; never block the UI on it.
    const remote = await sendMessage({ type: 'getStudentProfile' });
    if (remote.success && remote.signedIn) {
      const remoteTime = remote.updatedAt ? Date.parse(remote.updatedAt) : 0;
      const localTime = updatedAt ? Date.parse(updatedAt) : 0;
      if (remote.facts && remoteTime >= localTime) {
        facts = normalize(remote.facts);
        updatedAt = remote.updatedAt;
        await writeCache();
        emit();
      } else if (localTime > remoteTime && !isEmpty()) {
        await sendMessage({ type: 'saveStudentProfile', facts });
      }
    }
    return get();
  }

  /**
   * Merge a partial edit into the manual who/what/how layers and persist.
   * @param {{who?: object, what?: object, how?: object}} patch
   */
  async function save(patch = {}) {
    facts = {
      ...facts,
      who: { ...facts.who, ...(patch.who || {}) },
      what: { ...facts.what, ...(patch.what || {}) },
      how: { ...facts.how, ...(patch.how || {}) }
    };
    updatedAt = new Date().toISOString();
    await writeCache();
    emit();
    await sendMessage({ type: 'saveStudentProfile', facts });
    return get();
  }

  /**
   * Derive facts from signals the extension already has. Writes ONLY to the
   * _auto layer with provenance — a field the user edited is never clobbered.
   * Cheap enough to run on every sidepanel open.
   */
  async function autoCapture() {
    let changed = false;
    const now = new Date().toISOString();

    // 1. Current course load from the indexed corpus.
    try {
      if (typeof RAGCore !== 'undefined') {
        const courses = await RAGCore.listCourses();
        if (courses.length > 0) {
          const names = courses.map(c => c.courseName);
          const prev = facts._auto.courses;
          if (!prev || JSON.stringify(prev.value) !== JSON.stringify(names)) {
            facts._auto.courses = { value: names, source: 'indexedContent', confidence: 0.9, updatedAt: now };
            changed = true;
          }
        }
      }
    } catch (e) {
      console.warn('[Canvascope Profile] Course auto-capture failed:', e);
    }

    // 2. Workload signal from pending to-dos (count only — no titles leak in).
    //    A zero count is dropped entirely so an untouched profile stays empty.
    try {
      const db = await chrome.storage.local.get(['customTodos']);
      const todos = Array.isArray(db.customTodos) ? db.customTodos : [];
      const pending = todos.filter(t => t && !t.done).length;
      const prev = facts._auto.pendingTodos;
      if (pending > 0 ? (!prev || prev.value !== pending) : !!prev) {
        if (pending > 0) {
          facts._auto.pendingTodos = { value: pending, source: 'todos', confidence: 1, updatedAt: now };
        } else {
          delete facts._auto.pendingTodos;
        }
        changed = true;
      }
    } catch (e) {
      console.warn('[Canvascope Profile] Todo auto-capture failed:', e);
    }

    // 3. First name from the signed-in account (display only, manual wins).
    try {
      const auth = await sendMessage({ type: 'checkAuthStatus' });
      const fullName = auth?.user?.user_metadata?.full_name || auth?.user?.full_name || '';
      if (fullName && !facts._auto.fullName) {
        facts._auto.fullName = { value: fullName, source: 'account', confidence: 1, updatedAt: now };
        changed = true;
      }
    } catch (_) { /* signed out is fine */ }

    if (changed) {
      updatedAt = now;
      await writeCache();
      emit();
      await sendMessage({ type: 'saveStudentProfile', facts });
    }
    return changed;
  }

  /** Remove a single auto-captured fact (the panel's per-item dismiss). */
  async function dismissAuto(key) {
    if (!(key in facts._auto)) return;
    delete facts._auto[key];
    updatedAt = new Date().toISOString();
    await writeCache();
    emit();
    await sendMessage({ type: 'saveStudentProfile', facts });
  }

  /**
   * Render the compact "ABOUT THE STUDENT" block for the system prompt.
   * Returns '' when nothing is known so prompts are unchanged for new users.
   */
  function compileContextBlock() {
    if (isEmpty()) return '';

    const lines = [];
    const name = facts.who.fullName || facts._auto.fullName?.value || '';
    const idBits = [
      name ? `Name: ${name}` : '',
      facts.who.school,
      facts.who.majors.length ? facts.who.majors.join(' + ') : '',
      facts.who.year,
      facts.who.goals.length ? `goal: ${facts.who.goals.join(', ')}` : ''
    ].filter(Boolean);
    if (idBits.length) lines.push(idBits.join(' · '));

    const courses = facts.what.courses.length
      ? facts.what.courses
      : (facts._auto.courses?.value || []);
    if (courses.length) lines.push(`Current courses: ${courses.slice(0, 12).join(', ')}`);

    if (facts.what.tools.length) lines.push(`Tools they use: ${facts.what.tools.join(', ')}`);

    const howBits = [facts.how.tone, facts.how.verbosity, facts.how.studyStyle].filter(Boolean);
    if (howBits.length) lines.push(`Prefers: ${howBits.join(', ')}`);

    const pending = facts._auto.pendingTodos?.value;
    if (typeof pending === 'number' && pending > 0) lines.push(`Open to-dos right now: ${pending}`);

    if (!lines.length) return '';

    return `\n\n=== ABOUT THE STUDENT ===\n${lines.join('\n')}\n(Silently use this to tailor tone and examples. Never restate, list, or mention the student's profile back to them — not as a section, a header, or an aside.)`;
  }

  /** Wipe the profile locally and remotely. */
  async function clear() {
    facts = EMPTY_FACTS();
    updatedAt = new Date().toISOString();
    await chrome.storage.local.remove(CACHE_KEY);
    emit();
    await sendMessage({ type: 'saveStudentProfile', clear: true });
  }

  function get() {
    return {
      facts: JSON.parse(JSON.stringify(facts)),
      updatedAt,
      loaded,
      empty: isEmpty(),
      manualEmpty: isManualEmpty()
    };
  }

  window.StudentProfile = {
    load,
    save,
    autoCapture,
    dismissAuto,
    compileContextBlock,
    clear,
    get,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
  };
})();
