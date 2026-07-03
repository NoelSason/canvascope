/**
 * Canvascope Agent — Persistent Memory
 *
 * One JSON blob per user (chrome.storage.local key `agentState`, mirrored to the
 * Supabase `agent_state` table via the existing csTools sync). Holds standing
 * prefs, the kill-switch flag, the last briefing, dismissed suggestions, and
 * free-form memory notes so the autonomous agent doesn't repeat itself or
 * re-suggest things the user dismissed.
 *
 * compileMemoryBlock() renders a compact, semi-stable text block for the agent
 * system prompt. It must sit in the cached `system` array (never in the user
 * turn) so prompt caching stays effective — see agent-loop.js.
 *
 * Loaded into the service worker via importScripts; attaches to `self`.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'agentState';

  const DEFAULT_STATE = {
    prefs: {
      briefingTime: '08:00',     // local HH:MM the daily briefing targets
      tone: 'concise',
      autoWriteCalendar: true,   // may auto-create study blocks
      autoCreateTodos: true      // may auto-create study todos
    },
    killSwitch: { paused: false, ts: 0 },
    lastBriefing: null,          // { ts, summary, actions: [auditId] }
    dismissedSuggestions: [],    // hashes of suggestions the user dismissed
    memoryNotes: []              // ["Student prefers morning study", ...]
  };

  function deepMerge(base, patch) {
    if (Array.isArray(patch)) return patch.slice();
    if (patch && typeof patch === 'object') {
      const out = { ...base };
      for (const k of Object.keys(patch)) {
        out[k] = deepMerge(base ? base[k] : undefined, patch[k]);
      }
      return out;
    }
    return patch === undefined ? base : patch;
  }

  const AgentMemory = {
    async load() {
      const db = await chrome.storage.local.get([STORAGE_KEY]);
      return deepMerge(DEFAULT_STATE, db[STORAGE_KEY] || {});
    },

    /**
     * Merge a patch into the stored state, persist locally, and trigger the
     * debounced Supabase sync. Returns the merged state.
     */
    async save(patch) {
      const current = await this.load();
      const next = deepMerge(current, patch || {});
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      try {
        self.CanvascopeAgentSync?.pushKey?.(STORAGE_KEY, next);
      } catch (_) { /* sync is best-effort */ }
      return next;
    },

    async isPaused() {
      const state = await this.load();
      return !!state.killSwitch?.paused;
    },

    async setPaused(paused) {
      return this.save({ killSwitch: { paused: !!paused, ts: Date.now() } });
    },

    /**
     * Compact, cache-stable text block for the agent system prompt. Built only
     * from semi-stable fields (prefs + notes + a one-line last-briefing marker)
     * so the cached prefix changes only when memory genuinely changes.
     */
    compileMemoryBlock(state) {
      if (!state) return '';
      const lines = ['# AGENT MEMORY'];
      const p = state.prefs || {};
      lines.push(
        `Preferences: tone=${p.tone || 'concise'}, ` +
        `briefingTime=${p.briefingTime || '08:00'}, ` +
        `autoWriteCalendar=${p.autoWriteCalendar !== false}, ` +
        `autoCreateTodos=${p.autoCreateTodos !== false}.`
      );
      if (Array.isArray(state.memoryNotes) && state.memoryNotes.length) {
        lines.push('Notes about the student:');
        state.memoryNotes.slice(-12).forEach((n) => lines.push(`- ${n}`));
      }
      if (state.lastBriefing?.ts) {
        const d = new Date(state.lastBriefing.ts);
        lines.push(`Last briefing: ${d.toISOString().slice(0, 10)} — ${state.lastBriefing.summary || ''}`.trim());
      }
      if (Array.isArray(state.dismissedSuggestions) && state.dismissedSuggestions.length) {
        lines.push(`The student has dismissed ${state.dismissedSuggestions.length} prior suggestion(s) — do not re-propose dismissed items.`);
      }
      return lines.join('\n');
    },

    STORAGE_KEY
  };

  self.CanvascopeAgentMemory = AgentMemory;
})();
