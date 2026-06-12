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

  const GRADES_ALARM = 'cs.grades.sync';
  const GRADES_PERIOD_MIN = 30;

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
  // Tools sync (notes / todos / GPA scenarios)
  // -----------------------------------------------------------------------

  const TOOLS_TABLES = {
    dashboardNotes:    { table: 'user_dashboard_notes',   column: 'notes_json' },
    customTodos:       { table: 'user_custom_todos',      column: 'todos_json' },
    gpaScenarios:      { table: 'user_gpa_scenarios',     column: 'scenarios_json' },
    reminderPrefs:     { table: 'user_reminder_prefs',    column: 'prefs_json'   }
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

  async function pullTools() {
    const sb = getSupabase(); if (!sb) return { ok: false, reason: 'no-supabase' };
    const uid = await currentUserId();
    if (!uid) return { ok: false, reason: 'no-auth' };
    const updates = {};
    for (const [key, cfg] of Object.entries(TOOLS_TABLES)) {
      const { data, error } = await sb.from(cfg.table)
        .select(`${cfg.column}, updated_at`).eq('user_id', uid).maybeSingle();
      if (error || !data) continue;
      const remote = data[cfg.column];
      if (remote != null) updates[key] = remote;
    }
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
    return { ok: true, pulled: Object.keys(updates) };
  }

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
