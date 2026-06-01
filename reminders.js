/**
 * ============================================
 * Canvascope – Reminders (reminders.js)
 * ============================================
 *
 * Service-worker side module. Runs inside background.js's globalThis so it
 * shares the same chrome.alarms / chrome.notifications namespaces and the
 * existing storage scope.
 *
 * RESPONSIBILITIES:
 *   - Walk indexedContent + customTodos for items with future due dates.
 *   - Reuse the Radar urgency windows (overdue/24h/3d/7d/14d) as the
 *     reminder schedule instead of inventing a new model. By default we
 *     fire a "24-hours-before" and a "2-hours-before" notification.
 *   - Coalesce: at most one alarm per item per threshold; cleaned up when
 *     the item is completed or its due date moves.
 *   - One-off reminders set via /remind <text> <when> from the slash pack.
 *   - Optional Slack/Discord webhook for power users (per-user URL in
 *     storage; payload sent in addition to chrome.notifications).
 *
 * Wired into background.js by:
 *   importScripts('reminders.js')       // implicit via classic service worker
 *   self.CanvascopeReminders.init();    // called near the existing alarm setup
 *
 * ============================================
 */

(function canvascopeReminders(globalScope) {
  'use strict';

  if (globalScope.__canvascopeRemindersInitialised) return;
  globalScope.__canvascopeRemindersInitialised = true;

  const TICK_ALARM = 'cs.reminders.tick';
  const ONESHOT_PREFIX = 'cs.reminders.oneshot.';
  const ITEM_ALARM_PREFIX = 'cs.reminders.item.';
  const TICK_PERIOD_MIN = 30; // re-evaluate item-based reminders every 30 min
  const NOTIFICATION_ICON = 'icons/icon128.png';

  // Threshold milliseconds before due date — mirrors Radar's 24h + 3d windows.
  const ITEM_THRESHOLDS = [
    { id: '24h', ms: 24 * 60 * 60 * 1000, label: 'due in 24 hours' },
    { id: '2h',  ms: 2  * 60 * 60 * 1000, label: 'due in 2 hours'  }
  ];

  // -----------------------------------------------------------------------
  // Storage helpers
  // -----------------------------------------------------------------------

  async function readStore(keys) {
    try { return await chrome.storage.local.get(keys); } catch { return {}; }
  }

  async function writeStore(obj) {
    try { await chrome.storage.local.set(obj); } catch { /* ignore */ }
  }

  function dueTs(item) {
    if (!item || !item.dueAt) return 0;
    const ts = new Date(item.dueAt).getTime();
    return isNaN(ts) ? 0 : ts;
  }

  function alarmNameForItem(itemId, thresholdId) {
    return `${ITEM_ALARM_PREFIX}${itemId}.${thresholdId}`;
  }

  // -----------------------------------------------------------------------
  // Item-based scheduler
  // -----------------------------------------------------------------------

  async function rescheduleAllItemReminders() {
    const { indexedContent = [], customTodos = [], reminderPrefs = {} } =
      await readStore(['indexedContent', 'customTodos', 'reminderPrefs']);
    if (reminderPrefs.disabled) return { scheduled: 0 };

    const items = [...indexedContent, ...customTodos];
    const now = Date.now();
    const wanted = new Map(); // alarmName -> when (ms)

    for (const it of items) {
      const ts = dueTs(it);
      if (!ts || ts <= now) continue;
      if (it.done) continue;
      const id = canonicalIdForItem(it);
      if (!id) continue;
      for (const thr of ITEM_THRESHOLDS) {
        const fireAt = ts - thr.ms;
        if (fireAt <= now + 60 * 1000) continue; // skip past or imminent
        wanted.set(alarmNameForItem(id, thr.id), fireAt);
      }
    }

    // Sync with the alarm system: clear obsolete, add missing.
    const existing = await chrome.alarms.getAll();
    const existingItem = existing.filter(a => a.name.startsWith(ITEM_ALARM_PREFIX));
    for (const a of existingItem) {
      if (!wanted.has(a.name)) await chrome.alarms.clear(a.name);
    }
    let added = 0;
    for (const [name, when] of wanted.entries()) {
      const cur = existing.find(a => a.name === name);
      if (cur && Math.abs(cur.scheduledTime - when) < 60 * 1000) continue;
      await chrome.alarms.create(name, { when });
      added += 1;
    }

    return { scheduled: wanted.size, added };
  }

  function canonicalIdForItem(item) {
    if (!item) return '';
    if (item.id) return String(item.id);
    if (item.url) return 'u:' + item.url;
    return 't:' + (item.title || '').slice(0, 80);
  }

  // -----------------------------------------------------------------------
  // One-off reminders (from /remind)
  // -----------------------------------------------------------------------

  async function scheduleOneShot({ title, body, at }) {
    const when = Number(at);
    if (!isFinite(when) || when <= Date.now() + 5 * 1000) {
      return { ok: false, message: 'Reminder must be at least 5 seconds in the future.' };
    }
    const id = ONESHOT_PREFIX + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await chrome.alarms.create(id, { when });
    const prefs = (await readStore(['oneShotReminders']))?.oneShotReminders || {};
    prefs[id] = { title: String(title || 'Reminder'), body: body || '', at: when };
    await writeStore({ oneShotReminders: prefs });
    return { ok: true, id, fireAt: when };
  }

  async function cancelOneShot(id) {
    if (!id) return { ok: false };
    await chrome.alarms.clear(id);
    const prefs = (await readStore(['oneShotReminders']))?.oneShotReminders || {};
    delete prefs[id];
    await writeStore({ oneShotReminders: prefs });
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // Notification dispatch
  // -----------------------------------------------------------------------

  async function fireItemReminder(itemId, thresholdId) {
    const { indexedContent = [], customTodos = [], reminderPrefs = {} } =
      await readStore(['indexedContent', 'customTodos', 'reminderPrefs']);
    const items = [...indexedContent, ...customTodos];
    const item = items.find(i => canonicalIdForItem(i) === itemId);
    if (!item) return;
    const thr = ITEM_THRESHOLDS.find(t => t.id === thresholdId);
    if (!thr) return;
    const body = [
      item.courseName ? `[${item.courseName}]` : null,
      thr.label
    ].filter(Boolean).join(' · ');
    await postNotification({
      title: item.title || 'Upcoming work',
      message: body,
      contextMessage: item.dueAt ? new Date(item.dueAt).toLocaleString() : '',
      itemUrl: item.url || null
    }, reminderPrefs);
  }

  async function fireOneShot(id) {
    const prefs = (await readStore(['oneShotReminders']))?.oneShotReminders || {};
    const entry = prefs[id];
    if (!entry) return;
    await postNotification({
      title: entry.title || 'Reminder',
      message: entry.body || 'Canvascope reminder',
      contextMessage: new Date(entry.at).toLocaleString(),
      itemUrl: entry.url || null
    }, (await readStore(['reminderPrefs']))?.reminderPrefs || {});
    delete prefs[id];
    await writeStore({ oneShotReminders: prefs });
  }

  async function notificationsEnabled() {
    // Single user-facing gate (Settings → Notifications). Opt-in: off by
    // default, including on a fresh install where `settings` is undefined.
    const { settings } = await readStore(['settings']);
    return settings?.notificationsEnabled === true;
  }

  async function postNotification({ title, message, contextMessage, itemUrl }, prefs) {
    if (!(await notificationsEnabled())) return;
    try {
      const options = {
        type: 'basic',
        iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
        title: String(title || 'Canvascope reminder').slice(0, 100),
        message: String(message || 'Canvascope reminder').slice(0, 240),
        priority: 1
      };
      if (contextMessage) options.contextMessage = String(contextMessage).slice(0, 80);
      chrome.notifications.create('', options, (notifId) => {
        if (itemUrl && notifId) {
          // Store URL so the click handler in background.js can open it.
          chrome.storage.local.get(['reminderClickMap']).then(({ reminderClickMap = {} }) => {
            reminderClickMap[notifId] = itemUrl;
            chrome.storage.local.set({ reminderClickMap });
          });
        }
      });
    } catch (_) { /* ignore */ }

    const webhook = prefs?.webhookUrl;
    if (webhook && /^https:\/\//.test(webhook)) {
      // Fire-and-forget Slack/Discord-compatible payload. Both platforms
      // accept a {text} payload on incoming webhooks.
      try {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `*${title}*\n${message}\n${contextMessage || ''}` })
        });
      } catch (_) { /* webhook failure is non-fatal */ }
    }
  }

  // -----------------------------------------------------------------------
  // Alarm router (called from background.js's onAlarm handler)
  // -----------------------------------------------------------------------

  function handleAlarm(name) {
    if (!name) return false;
    if (name === TICK_ALARM) {
      rescheduleAllItemReminders().catch(() => { /* ignore */ });
      return true;
    }
    if (name.startsWith(ITEM_ALARM_PREFIX)) {
      // name === ITEM_ALARM_PREFIX + itemId + '.' + thresholdId
      const tail = name.slice(ITEM_ALARM_PREFIX.length);
      const lastDot = tail.lastIndexOf('.');
      if (lastDot < 0) return true;
      const itemId = tail.slice(0, lastDot);
      const thr = tail.slice(lastDot + 1);
      fireItemReminder(itemId, thr).catch(() => { /* ignore */ });
      return true;
    }
    if (name.startsWith(ONESHOT_PREFIX)) {
      fireOneShot(name).catch(() => { /* ignore */ });
      return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Click handler (opens the target URL)
  // -----------------------------------------------------------------------

  function handleNotificationClick(notifId) {
    chrome.storage.local.get(['reminderClickMap']).then(({ reminderClickMap = {} }) => {
      const url = reminderClickMap[notifId];
      if (url) chrome.tabs.create({ url });
      delete reminderClickMap[notifId];
      chrome.storage.local.set({ reminderClickMap });
    }).catch(() => { /* ignore */ });
  }

  // -----------------------------------------------------------------------
  // Boot
  // -----------------------------------------------------------------------

  async function init() {
    try {
      const existing = await chrome.alarms.get(TICK_ALARM);
      if (!existing) {
        await chrome.alarms.create(TICK_ALARM, {
          delayInMinutes: 1,
          periodInMinutes: TICK_PERIOD_MIN
        });
      }
    } catch (_) { /* ignore */ }
    try { await rescheduleAllItemReminders(); } catch (_) { /* ignore */ }
  }

  globalScope.CanvascopeReminders = {
    init,
    handleAlarm,
    handleNotificationClick,
    scheduleOneShot,
    cancelOneShot,
    rescheduleAllItemReminders
  };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
