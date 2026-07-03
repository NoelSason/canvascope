/**
 * ============================================
 * Canvascope – Background extras (background-cs-extras.js)
 * ============================================
 *
 * Service-worker side glue for the new skin / tools / reminders modules.
 * Loaded after background.js by background-wrapper.js so it can rely on:
 *   - supabaseClient (from background.js)
 *   - chrome.alarms.onAlarm already wired (we ADD a listener; the new
 *     listener silently no-ops for alarm names it does not recognize)
 *   - the Supabase auth session resolution helpers
 *
 * This file owns:
 *   - csSkin.push / csSkin.pull / csSkin.lookupIndexRank
 *   - csTools.push / csTools.pull / csTools.fetchGrades
 *   - csReminders.scheduleOnce (delegates to reminders.js)
 *   - csSync.forceAll
 *   - chrome.notifications.onClicked → reminders.handleNotificationClick
 *   - csGradesSync periodic alarm (cs.grades.sync, every 30 min)
 *
 * It is intentionally self-contained: no edits to background.js needed.
 * ============================================
 */

(function () {
  'use strict';

  if (self.__canvascopeBackgroundExtrasInitialised) return;
  self.__canvascopeBackgroundExtrasInitialised = true;

  try {
    if (!self.CanvascopeSkinThemes) importScripts('../lib/skin-themes.js');
  } catch (_) { /* fall back to local tokens below */ }

  const GRADES_ALARM = 'cs.grades.sync';
  const GRADES_PERIOD_MIN = 30;
  const KALTURA_EARLY_FRAME_DEFAULT_SKIN = Object.freeze({
    enabled: true,
    themeId: 'canvas-default',
    mode: 'auto',
    customTokens: {},
    followSystem: false,
    schedule: {
      enabled: false,
      darkStart: '19:00',
      darkEnd: '07:00'
    }
  });
  const KALTURA_EARLY_FRAME_FALLBACK_TOKENS = Object.freeze({
    bg: '#f8f4ea',
    surface: '#fdfaf2',
    border: 'rgba(94,71,45,0.10)',
    borderHi: 'rgba(94,71,45,0.18)',
    text: '#2d2925',
    muted: '#9b8f78',
    accent: '#b87333'
  });
  const kalturaEarlyFrameCssByFrame = new Map();
  let kalturaEarlyFrameCss = buildKalturaEarlyFrameCss(KALTURA_EARLY_FRAME_FALLBACK_TOKENS, 'light');
  let kalturaEarlyFrameEnabled = true;
  let kalturaEarlyFrameRefreshPromise = null;

  // -----------------------------------------------------------------------
  // Supabase helpers
  // -----------------------------------------------------------------------

  function getSupabase() {
    return (typeof self !== 'undefined' && self.supabaseClient)
      ? self.supabaseClient
      : (typeof supabaseClient !== 'undefined' ? supabaseClient : null);
  }

  async function currentUserId() {
    const sb = getSupabase();
    if (!sb) return null;
    try {
      const { data: { session } } = await sb.auth.getSession();
      return session?.user?.id || null;
    } catch { return null; }
  }

  // -----------------------------------------------------------------------
  // Skin sync (chrome.storage.local.canvasSkin ↔ user_skin_prefs)
  // -----------------------------------------------------------------------

  let skinPushTimer = null;
  function pushSkinDebounced(skin) {
    clearTimeout(skinPushTimer);
    skinPushTimer = setTimeout(() => pushSkinNow(skin).catch(() => { /* ignore */ }), 1500);
  }

  async function pushSkinNow(skin) {
    const sb = getSupabase(); if (!sb) return { ok: false, reason: 'no-supabase' };
    const uid = await currentUserId();
    if (!uid) return { ok: false, reason: 'no-auth' };
    let body = skin;
    if (!body) {
      const { canvasSkin } = await chrome.storage.local.get(['canvasSkin']);
      body = canvasSkin || null;
    }
    if (!body) return { ok: false, reason: 'no-data' };
    const { error } = await sb.from('user_skin_prefs').upsert({
      user_id: uid,
      skin_json: body,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  }

  async function pullSkin() {
    const sb = getSupabase(); if (!sb) return { ok: false, reason: 'no-supabase' };
    const uid = await currentUserId();
    if (!uid) return { ok: false, reason: 'no-auth' };
    const { data, error } = await sb.from('user_skin_prefs')
      .select('skin_json, updated_at').eq('user_id', uid).maybeSingle();
    if (error) return { ok: false, reason: error.message };
    if (!data?.skin_json) return { ok: true, updated: false };
    const { canvasSkin: local } = await chrome.storage.local.get(['canvasSkin']);
    // Only overwrite local if remote is newer (or local missing).
    const localStamp = local?.__updatedAt || 0;
    const remoteStamp = data.updated_at ? new Date(data.updated_at).getTime() : Date.now();
    if (local && localStamp > remoteStamp) return { ok: true, updated: false };
    await chrome.storage.local.set({ canvasSkin: { ...data.skin_json, __updatedAt: remoteStamp } });
    return { ok: true, updated: true };
  }

  // -----------------------------------------------------------------------
  // Kaltura embedded LTI anti-FOUC
  // -----------------------------------------------------------------------

  function normalizeKalturaEarlyFrameSkin(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      ...KALTURA_EARLY_FRAME_DEFAULT_SKIN,
      ...source,
      customTokens: source.customTokens && typeof source.customTokens === 'object'
        ? source.customTokens
        : {},
      schedule: {
        ...KALTURA_EARLY_FRAME_DEFAULT_SKIN.schedule,
        ...(source.schedule && typeof source.schedule === 'object' ? source.schedule : {})
      }
    };
  }

  function computeKalturaScheduledMode(schedule) {
    const now = new Date();
    const minsNow = now.getHours() * 60 + now.getMinutes();
    const [startHour, startMinute] = String(schedule?.darkStart || '19:00').split(':').map(Number);
    const [endHour, endMinute] = String(schedule?.darkEnd || '07:00').split(':').map(Number);
    const start = (Number.isFinite(startHour) ? startHour : 19) * 60 + (Number.isFinite(startMinute) ? startMinute : 0);
    const end = (Number.isFinite(endHour) ? endHour : 7) * 60 + (Number.isFinite(endMinute) ? endMinute : 0);
    if (start < end) return minsNow >= start && minsNow < end ? 'dark' : 'light';
    return minsNow >= start || minsNow < end ? 'dark' : 'light';
  }

  function getKalturaEarlyFrameMode(skin) {
    if (skin.mode === 'light' || skin.mode === 'dark') return skin.mode;
    if (skin.mode === 'scheduled' && skin.schedule?.enabled) {
      return computeKalturaScheduledMode(skin.schedule);
    }
    const themeMode = self.CanvascopeSkinThemes?.getTheme(skin.themeId)?.mode;
    return themeMode === 'dark' ? 'dark' : 'light';
  }

  function resolveKalturaEarlyFrameTokens(skin, mode) {
    const themesApi = self.CanvascopeSkinThemes || null;
    if (!themesApi) {
      return {
        ...KALTURA_EARLY_FRAME_FALLBACK_TOKENS,
        ...(skin.customTokens || {})
      };
    }

    let theme = themesApi.getTheme(skin.themeId) || themesApi.getTheme('canvas-default');
    if (mode === 'dark' && theme?.mode !== 'dark') theme = themesApi.getTheme('dim') || theme;
    if (mode === 'light' && theme?.mode !== 'light') theme = themesApi.getTheme('canvas-default') || theme;

    const normalized = themesApi.normalizeTheme({
      ...theme,
      tokens: {
        ...(theme?.tokens || {}),
        ...(skin.customTokens || {})
      }
    });

    return normalized?.tokens || KALTURA_EARLY_FRAME_FALLBACK_TOKENS;
  }

  function cssValue(value, fallback) {
    return String(value || fallback).replace(/[;{}<>\n\r]/g, '');
  }

  function buildKalturaEarlyFrameCss(tokens, mode) {
    const bg = cssValue(tokens.bg, KALTURA_EARLY_FRAME_FALLBACK_TOKENS.bg);
    const surface = cssValue(tokens.surface, KALTURA_EARLY_FRAME_FALLBACK_TOKENS.surface);
    const border = cssValue(tokens.border, KALTURA_EARLY_FRAME_FALLBACK_TOKENS.border);
    const borderHi = cssValue(tokens.borderHi, KALTURA_EARLY_FRAME_FALLBACK_TOKENS.borderHi);
    const text = cssValue(tokens.text, KALTURA_EARLY_FRAME_FALLBACK_TOKENS.text);
    const muted = cssValue(tokens.muted, KALTURA_EARLY_FRAME_FALLBACK_TOKENS.muted);
    const accent = cssValue(tokens.accent, KALTURA_EARLY_FRAME_FALLBACK_TOKENS.accent);
    const colorScheme = mode === 'dark' ? 'dark' : 'light';

    return `
html,
body {
  background: ${bg} !important;
  background-color: ${bg} !important;
  background-image: none !important;
  color: ${text} !important;
  color-scheme: ${colorScheme};
}
body,
body > div,
#root,
#app,
#__next,
#contentContainer,
.contentContainer,
.tlh-container,
.page-wrap,
main,
.eventplatform,
.gallery,
[class*="galleryContainer"],
[class*="GalleryContainer"],
[class*="pageContainer"],
[class*="PageContainer"],
[class*="container"],
[class*="Container"],
[class*="wrapper"],
[class*="Wrapper"],
.panel,
.panel-body,
.well,
.tab-content,
.row,
[style*="background: white"],
[style*="background-color: white"],
[style*="background-color:#fff"],
[style*="background-color: #fff"],
[style*="background-color: rgb(255, 255, 255)"] {
  background-color: transparent !important;
}
input,
select,
textarea,
.form-control,
[class*="searchInput"],
[class*="SearchInput"],
[class*="searchForm"] {
  background-color: ${surface} !important;
  color: ${text} !important;
  border-color: ${borderHi} !important;
}
input::placeholder,
textarea::placeholder {
  color: ${muted} !important;
}
hr,
.nav-tabs,
[class*="divider"],
[class*="Divider"] {
  border-color: ${border} !important;
}
.nav-tabs > li.active > a,
.nav-tabs > li > a:hover {
  border-bottom-color: ${accent} !important;
  color: ${text} !important;
}
.btn-default,
.btn:not(.btn-primary):not([class*="primary"]):not([class*="Primary"]) {
  background-color: ${surface} !important;
  color: ${text} !important;
  border-color: ${borderHi} !important;
}
[class*="humbnail"] [class*="itle"],
[class*="humbnail"] [class*="ntryName"],
[class*="humbnail"] [class*="uration"],
[class*="humbnail"] [class*="escription"],
[class*="humbnail"] a,
[class*="humb"] [class*="itle"],
[class*="_tile"] [class*="itle"],
[class*="oster"] [class*="itle"],
[class*="oster"] [class*="ntryName"],
[class*="oster"] [class*="escription"],
[class*="oster"] [class*="uration"],
[class*="oster"] [class*="ount"],
[class*="oster"] a,
[class*="layerContainer"] [class*="itle"],
[class*="layerContainer"] [class*="ntryName"],
[class*="layerContainer"] [class*="escription"],
[class*="layerContainer"] [class*="uration"],
[class*="layerContainer"] [class*="ount"],
[class*="layerContainer"] a,
[class*="mediaContainer"] [class*="itle"],
[class*="mediaContainer"] [class*="ntryName"],
[class*="mediaContainer"] [class*="escription"],
[class*="mediaContainer"] [class*="uration"],
[class*="mediaContainer"] [class*="ount"],
[class*="mediaContainer"] a,
[class*="ngagement"] a,
[class*="ngagement"] [class*="ount"],
[class*="ntryStats"] a,
[class*="ntryStats"] [class*="ount"],
.photo-group [class*="itle"],
.photo-group .name,
.entry-title,
a.entry-title,
.cb-entry-title {
  color: #ffffff !important;
  text-shadow: 0 1px 3px rgba(0,0,0,0.9) !important;
}
`;
  }

  async function refreshKalturaEarlyFrameCss() {
    try {
      const { canvasSkin } = await chrome.storage.local.get(['canvasSkin']);
      const skin = normalizeKalturaEarlyFrameSkin(canvasSkin);
      kalturaEarlyFrameEnabled = skin.enabled !== false;
      if (!kalturaEarlyFrameEnabled) return;
      const mode = getKalturaEarlyFrameMode(skin);
      const tokens = resolveKalturaEarlyFrameTokens(skin, mode);
      kalturaEarlyFrameCss = buildKalturaEarlyFrameCss(tokens, mode);
    } catch (error) {
      console.warn('[Canvascope Kaltura Skin] Failed to refresh early-frame CSS:', String(error?.message || error));
    }
  }

  function queueKalturaEarlyFrameCssRefresh() {
    if (!kalturaEarlyFrameRefreshPromise) {
      kalturaEarlyFrameRefreshPromise = refreshKalturaEarlyFrameCss()
        .finally(() => { kalturaEarlyFrameRefreshPromise = null; });
    }
    return kalturaEarlyFrameRefreshPromise;
  }

  function isKalturaFrameUrl(rawUrl) {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      return host === 'kaf.berkeley.edu'
        || host === 'kaf.kaltura.com'
        || host.endsWith('.kaf.kaltura.com')
        || host === 'mediaspace.kaltura.com'
        || host.endsWith('.mediaspace.kaltura.com');
    } catch {
      return false;
    }
  }

  function kalturaFrameKey(tabId, frameId) {
    return `${tabId}:${frameId}`;
  }

  async function injectKalturaEarlyFrameCss(details) {
    if (!kalturaEarlyFrameEnabled || !kalturaEarlyFrameCss) return;
    const tabId = Number(details?.tabId);
    const frameId = Number(details?.frameId);
    if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(frameId) || frameId < 0) return;

    const css = kalturaEarlyFrameCss;
    try {
      await chrome.scripting.insertCSS({
        target: { tabId, frameIds: [frameId] },
        css,
        origin: 'USER'
      });
      kalturaEarlyFrameCssByFrame.set(kalturaFrameKey(tabId, frameId), css);
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!/cannot access|missing host permission|cannot be scripted|frame with id|no tab with id/i.test(message)) {
        console.warn('[Canvascope Kaltura Skin] Failed to inject early-frame CSS:', message);
      }
    }
  }

  async function removeKalturaEarlyFrameCss(sender) {
    const tabId = Number(sender?.tab?.id);
    const frameId = Number(sender?.frameId);
    if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(frameId) || frameId < 0) {
      return { ok: false, reason: 'missing-frame' };
    }

    const key = kalturaFrameKey(tabId, frameId);
    const css = kalturaEarlyFrameCssByFrame.get(key);
    if (!css) return { ok: true, removed: false };

    try {
      await chrome.scripting.removeCSS({
        target: { tabId, frameIds: [frameId] },
        css,
        origin: 'USER'
      });
      kalturaEarlyFrameCssByFrame.delete(key);
      return { ok: true, removed: true };
    } catch (error) {
      const message = String(error?.message || error || '');
      if (/frame with id|no tab with id|cannot access|missing host permission/i.test(message)) {
        kalturaEarlyFrameCssByFrame.delete(key);
        return { ok: true, removed: false };
      }
      return { ok: false, reason: message };
    }
  }

  function attachKalturaEarlyFrameCssInjection() {
    if (!chrome.webNavigation?.onCommitted || !chrome.scripting?.insertCSS) return;
    chrome.webNavigation.onCommitted.addListener((details) => {
      if (!isKalturaFrameUrl(details?.url)) return;
      void injectKalturaEarlyFrameCss(details);
    }, {
      url: [
        { schemes: ['http', 'https'], hostEquals: 'kaf.berkeley.edu' },
        { schemes: ['http', 'https'], hostContains: 'kaf.kaltura.com' },
        { schemes: ['http', 'https'], hostContains: 'mediaspace.kaltura.com' }
      ]
    });
    chrome.tabs?.onRemoved?.addListener?.((tabId) => {
      const prefix = `${tabId}:`;
      for (const key of Array.from(kalturaEarlyFrameCssByFrame.keys())) {
        if (key.startsWith(prefix)) kalturaEarlyFrameCssByFrame.delete(key);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Tools sync (notes / todos / GPA scenarios)
  // -----------------------------------------------------------------------

  const TOOLS_TABLES = {
    dashboardNotes:    { table: 'user_dashboard_notes',   column: 'notes_json' },
    customTodos:       { table: 'user_custom_todos',      column: 'todos_json' },
    gpaScenarios:      { table: 'user_gpa_scenarios',     column: 'scenarios_json' },
    reminderPrefs:     { table: 'user_reminder_prefs',    column: 'prefs_json'   },
    // Autonomous agent state (prefs, kill switch, last briefing, memory notes).
    // Rides the existing pull-on-login / debounced-push sync for free.
    agentState:        { table: 'agent_state',            column: 'state_json'   },
    // Parsed syllabus memory (grading scheme, cutoffs, schedule), keyed by
    // courseId. Powers the grade-target calculator + schedule Q&A.
    syllabusMemory:    { table: 'user_syllabi',           column: 'syllabi_json' },
    // Character Profile: consent flags + dismissed ids + source-attributed
    // derived summaries (content-light). Local-first, synced when signed in.
    characterProfile:  { table: 'character_profile',      column: 'profile_json' }
  };

  let toolsPushTimers = {};
  function pushToolsDebounced(key, value) {
    if (!TOOLS_TABLES[key]) return;
    clearTimeout(toolsPushTimers[key]);
    toolsPushTimers[key] = setTimeout(
      () => pushToolsNow(key, value).catch(() => { /* ignore */ }),
      1500
    );
  }

  async function pushToolsNow(key, value) {
    const cfg = TOOLS_TABLES[key];
    if (!cfg) return { ok: false, reason: 'unknown-key' };
    const sb = getSupabase(); if (!sb) return { ok: false, reason: 'no-supabase' };
    const uid = await currentUserId();
    if (!uid) return { ok: false, reason: 'no-auth' };
    let body = value;
    if (body === undefined) {
      const all = await chrome.storage.local.get([key]);
      body = all[key];
    }
    const { error } = await sb.from(cfg.table).upsert({
      user_id: uid,
      [cfg.column]: body ?? null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  }

  function timestampMs(value) {
    if (!value) return 0;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  function resolveToolPullValue(key, local, remote, remoteUpdatedAt) {
    if (remote == null) return { action: 'skip' };
    if (key !== 'characterProfile') return { action: 'applyRemote', value: remote };

    const hasLocal = local && typeof local === 'object';
    if (!hasLocal) return { action: 'applyRemote', value: remote };

    const localMs = timestampMs(local.updatedAt);
    const remoteMs = Math.max(timestampMs(remote?.updatedAt), timestampMs(remoteUpdatedAt));
    if (localMs > remoteMs) {
      return { action: 'keepLocal', value: local, reason: 'local-newer' };
    }
    if (localMs === remoteMs && local.enabled === false && remote?.enabled !== false) {
      return { action: 'keepLocal', value: local, reason: 'local-opt-out-tie' };
    }
    return { action: 'applyRemote', value: remote };
  }

  async function pullTools() {
    const sb = getSupabase(); if (!sb) return { ok: false, reason: 'no-supabase' };
    const uid = await currentUserId();
    if (!uid) return { ok: false, reason: 'no-auth' };
    const updates = {};
    const keptLocal = [];
    for (const [key, cfg] of Object.entries(TOOLS_TABLES)) {
      const { data, error } = await sb.from(cfg.table)
        .select(`${cfg.column}, updated_at`).eq('user_id', uid).maybeSingle();
      if (error || !data) continue;
      const remote = data[cfg.column];
      const local = key === 'characterProfile'
        ? (await chrome.storage.local.get([key]))[key]
        : undefined;
      const resolved = resolveToolPullValue(key, local, remote, data.updated_at);
      if (resolved.action === 'applyRemote') {
        updates[key] = resolved.value;
      } else if (resolved.action === 'keepLocal') {
        keptLocal.push(key);
        await pushToolsNow(key, resolved.value);
      }
    }
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
    return { ok: true, pulled: Object.keys(updates), keptLocal };
  }

  // -----------------------------------------------------------------------
  // Agent sync glue — exposed for the agent modules (agent-loop / agent-tools).
  // pushKey reuses the debounced tools sync; appendAudit inserts an immutable
  // row into agent_audit (insert, not upsert).
  // -----------------------------------------------------------------------
  async function appendAuditRemote(entry) {
    const sb = getSupabase(); if (!sb) return { ok: false, reason: 'no-supabase' };
    const uid = await currentUserId();
    if (!uid) return { ok: false, reason: 'no-auth' };
    const { error } = await sb.from('agent_audit').insert({
      user_id: uid,
      run_id: entry.runId || null,
      ts: entry.ts ? new Date(entry.ts).toISOString() : new Date().toISOString(),
      tool: entry.tool || null,
      input: entry.input ?? null,
      result: entry.result ?? null,
      status: entry.status || null,
      undoable: !!entry.undoable,
      undo_ref: entry.undo_ref ?? null
    });
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  }

  self.CanvascopeAgentSync = {
    pushKey: (key, value) => pushToolsDebounced(key, value),
    appendAudit: (entry) => appendAuditRemote(entry).catch(() => { /* best-effort */ }),
    _resolveToolPullValue: resolveToolPullValue
  };

  // -----------------------------------------------------------------------
  // csTools.fetchGrades — scrape current grades from Canvas
  // -----------------------------------------------------------------------
  //
  // Strategy: use the authenticated user's own session by hitting Canvas's
  // own API endpoint /api/v1/courses?enrollment_state=active&include[]=total_scores
  // on each known Canvas host. We do NOT collect Canvas API tokens — the
  // request is just a cookie-bearing fetch from the service worker.
  //
  async function fetchGradesAllHosts() {
    const hosts = await knownCanvasHosts();
    const results = [];
    const byCourse = {};
    for (const host of hosts) {
      try {
        const list = await fetchGradesForHost(host);
        for (const c of list) {
          byCourse[c.courseId] = {
            name: c.name,
            current: c.percent,
            letter: c.letter,
            updatedAt: Date.now()
          };
          results.push(c);
        }
      } catch (_) { /* ignore per-host failures */ }
    }
    if (results.length > 0) {
      const { canvasGradesByCourse = {} } = await chrome.storage.local.get(['canvasGradesByCourse']);
      const merged = { ...canvasGradesByCourse, ...byCourse };
      await chrome.storage.local.set({ canvasGradesByCourse: merged });
    }
    return { ok: true, courses: results };
  }

  async function fetchGradesForHost(host) {
    const url = `https://${host}/api/v1/courses?enrollment_state=active&include[]=total_scores&per_page=100`;
    const res = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('bad status ' + res.status);
    const text = await res.text();
    // Canvas API responses are sometimes prefixed with `while(1);` for XSSI.
    const cleaned = text.startsWith('while(1);') ? text.slice(9) : text;
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { throw new Error('parse failed'); }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(c => {
      const enr = (c.enrollments || []).find(e => e.computed_current_score != null) || c.enrollments?.[0];
      const pct = enr?.computed_current_score;
      const letter = enr?.computed_current_grade || percentToLetter(pct);
      return {
        courseId: String(c.id),
        name: c.name,
        percent: pct,
        letter
      };
    }).filter(c => c.name);
  }

  // -----------------------------------------------------------------------
  // csTools.fetchGradebook — per-assignment grades for ONE course
  // -----------------------------------------------------------------------
  //
  // The overall-grade scrape above only yields the course's computed total.
  // The grade-target calculator ("what do I need to get an A") needs the
  // per-assignment scores + assignment-group structure so it can apply the
  // syllabus weights and drop-lowest rules. Same cookie-bearing strategy.
  //
  function parseNextLink(linkHeader) {
    if (!linkHeader) return null;
    const part = linkHeader.split(',').find(s => /rel="next"/.test(s));
    if (!part) return null;
    const m = part.match(/<([^>]+)>/);
    return m ? m[1] : null;
  }

  async function fetchCanvasJsonAll(url) {
    const out = [];
    let next = url;
    let guard = 0;
    while (next && guard < 40) {
      guard++;
      const res = await fetch(next, { credentials: 'include', headers: { 'Accept': 'application/json' } });
      if (!res.ok) break;
      const text = await res.text();
      const cleaned = text.startsWith('while(1);') ? text.slice(9) : text;
      let arr;
      try { arr = JSON.parse(cleaned); } catch { break; }
      if (!Array.isArray(arr) || arr.length === 0) break;
      out.push(...arr);
      next = parseNextLink(res.headers.get('Link'));
    }
    return out;
  }

  async function fetchCourseGradebook(host, courseId) {
    const base = `https://${host}/api/v1/courses/${courseId}`;
    const [assignmentsRaw, groupsRaw] = await Promise.all([
      fetchCanvasJsonAll(`${base}/assignments?include[]=submission&per_page=100`),
      fetchCanvasJsonAll(`${base}/assignment_groups?per_page=100`)
    ]);
    const assignments = assignmentsRaw.map(a => ({
      id: a.id,
      name: a.name,
      assignment_group_id: a.assignment_group_id,
      points_possible: a.points_possible,
      omit_from_final_grade: !!a.omit_from_final_grade,
      due_at: a.due_at || null,
      score: (a.submission && a.submission.score != null) ? a.submission.score : null
    }));
    const groups = groupsRaw.map(g => ({
      id: g.id,
      name: g.name,
      group_weight: g.group_weight,
      rules: g.rules || null
    }));
    return { ok: true, host, courseId: String(courseId), assignments, groups };
  }

  // Resolve the host (if the caller didn't supply one) by trying each known
  // Canvas host until a course returns gradebook data.
  async function fetchGradebookAnyHost(courseId, host) {
    const hosts = host ? [host] : await knownCanvasHosts();
    for (const h of hosts) {
      try {
        const r = await fetchCourseGradebook(h, courseId);
        if (r.assignments.length || r.groups.length) return r;
      } catch (_) { /* try next host */ }
    }
    return { ok: false, courseId: String(courseId), assignments: [], groups: [], message: 'no gradebook found' };
  }

  function percentToLetter(p) {
    if (p == null) return '';
    if (p >= 93) return 'A';  if (p >= 90) return 'A-';
    if (p >= 87) return 'B+'; if (p >= 83) return 'B';  if (p >= 80) return 'B-';
    if (p >= 77) return 'C+'; if (p >= 73) return 'C';  if (p >= 70) return 'C-';
    if (p >= 67) return 'D+'; if (p >= 63) return 'D';  if (p >= 60) return 'D-';
    return 'F';
  }

  async function knownCanvasHosts() {
    // Derive hosts from the user's open Canvas tabs + customDomains in storage.
    const out = new Set();
    try {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (!t.url) continue;
        try {
          const u = new URL(t.url);
          if (/instructure\.com$/i.test(u.hostname) ||
              /(berkeley|ucla|ucsd|asu|mit)\.edu$/i.test(u.hostname) ||
              /canvas\./i.test(u.hostname)) {
            out.add(u.hostname);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    try {
      const { customDomains } = await chrome.storage.local.get(['customDomains']);
      (customDomains || []).forEach(d => {
        try { out.add(new URL(/^https?:\/\//.test(d) ? d : 'https://' + d).hostname); }
        catch { out.add(String(d).replace(/^https?:\/\//, '').split('/')[0]); }
      });
    } catch { /* ignore */ }
    return Array.from(out);
  }

  // -----------------------------------------------------------------------
  // csSkin.lookupIndexRank — answers the preview card's "ranked #N" line
  // -----------------------------------------------------------------------

  async function lookupIndexRank(href) {
    try {
      const target = String(href || '');
      if (!target) return { found: false };
      const { indexedContent = [], searchHabits = {} } = await chrome.storage.local.get(['indexedContent', 'searchHabits']);
      const match = indexedContent.find(it => it.url && (it.url === target || it.url.endsWith(target)));
      if (!match) return { found: false };
      // Find a recent query whose ranked results would have included this item.
      const queries = Object.entries(searchHabits?.queries || {})
        .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0))
        .map(([q]) => q);
      if (!queries.length) return { found: true, rank: 1, topQuery: match.title || 'this item' };
      return { found: true, rank: 1, topQuery: queries[0] };
    } catch {
      return { found: false };
    }
  }

  // -----------------------------------------------------------------------
  // Message routing
  // -----------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.action) return false;
    switch (msg.action) {
      case 'csSkin.push': {
        pushSkinDebounced(msg.skin);
        sendResponse({ ok: true, queued: true });
        return false;
      }
      case 'csSkin.pull': {
        pullSkin().then(sendResponse).catch(err => sendResponse({ ok: false, message: String(err) }));
        return true;
      }
      case 'csSkin.lookupIndexRank': {
        lookupIndexRank(msg.href).then(sendResponse).catch(() => sendResponse({ found: false }));
        return true;
      }
      case 'csKaltura.removeEarlyFrameCss': {
        removeKalturaEarlyFrameCss(_sender).then(sendResponse).catch(err => sendResponse({ ok: false, message: String(err) }));
        return true;
      }
      case 'csTools.push': {
        pushToolsDebounced(msg.key, msg.value);
        sendResponse({ ok: true, queued: true });
        return false;
      }
      case 'csTools.pull': {
        pullTools().then(sendResponse).catch(err => sendResponse({ ok: false, message: String(err) }));
        return true;
      }
      case 'csTools.fetchGrades': {
        fetchGradesAllHosts().then(sendResponse).catch(err => sendResponse({ ok: false, message: String(err) }));
        return true;
      }
      case 'csTools.fetchGradebook': {
        fetchGradebookAnyHost(msg.courseId, msg.host)
          .then(sendResponse)
          .catch(err => sendResponse({ ok: false, message: String(err) }));
        return true;
      }
      case 'csReminders.scheduleOnce': {
        const api = self.CanvascopeReminders;
        if (!api) { sendResponse({ ok: false, message: 'Reminders not loaded' }); return false; }
        api.scheduleOneShot({ title: msg.title, body: msg.body, at: msg.at })
          .then(sendResponse)
          .catch(err => sendResponse({ ok: false, message: String(err) }));
        return true;
      }
      case 'csSync.forceAll': {
        (async () => {
          const skin = await pushSkinNow();
          const pulled = await pullSkin();
          const tools = await pullTools();
          // Push each tool key so cross-device merge works both ways.
          const keys = Object.keys(TOOLS_TABLES);
          const pushedTools = [];
          for (const k of keys) {
            const r = await pushToolsNow(k);
            if (r?.ok) pushedTools.push(k);
          }
          sendResponse({
            ok: skin.ok || pulled.ok || tools.ok || pushedTools.length > 0,
            skin, pulled, tools, pushedTools
          });
        })();
        return true;
      }
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.canvasSkin) {
      queueKalturaEarlyFrameCssRefresh().catch(() => { /* ignore */ });
    }
  });

  // -----------------------------------------------------------------------
  // Alarm router (adds a listener; built-in alarms are still handled by
  // background.js's listener — Chrome dispatches to every listener).
  // -----------------------------------------------------------------------

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || !alarm.name) return;
    const remApi = self.CanvascopeReminders;
    if (remApi && remApi.handleAlarm(alarm.name)) return;
    if (alarm.name === GRADES_ALARM) {
      fetchGradesAllHosts().catch(() => { /* ignore */ });
    }
  });

  chrome.notifications?.onClicked?.addListener?.((notifId) => {
    const remApi = self.CanvascopeReminders;
    if (remApi) remApi.handleNotificationClick(notifId);
  });

  // -----------------------------------------------------------------------
  // Auth-change → pull latest cloud state
  // -----------------------------------------------------------------------

  function attachAuthHook() {
    const sb = getSupabase();
    if (!sb) { setTimeout(attachAuthHook, 1500); return; }
    sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        pullSkin().catch(() => { /* ignore */ });
        pullTools().catch(() => { /* ignore */ });
      }
    });
  }
  attachAuthHook();

  // -----------------------------------------------------------------------
  // Boot: ensure grades alarm + reminders init
  // -----------------------------------------------------------------------

  (async () => {
    attachKalturaEarlyFrameCssInjection();
    queueKalturaEarlyFrameCssRefresh().catch(() => { /* keep fallback CSS */ });
    try {
      const existing = await chrome.alarms.get(GRADES_ALARM);
      if (!existing) {
        await chrome.alarms.create(GRADES_ALARM, {
          delayInMinutes: 2,
          periodInMinutes: GRADES_PERIOD_MIN
        });
      }
    } catch { /* ignore */ }
    if (self.CanvascopeReminders && typeof self.CanvascopeReminders.init === 'function') {
      try { await self.CanvascopeReminders.init(); } catch { /* ignore */ }
    }
  })();

  console.log('[Canvascope] background-cs-extras.js loaded.');
})();
