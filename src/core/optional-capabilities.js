/**
 * Canvascope — Capabilities for the `history` and `clipboardRead` permissions
 *
 * Thin wrappers around two Chrome permissions declared in `permissions`
 * (granted at install). The `has()` guards are defensive — they keep each
 * capability a clean no-op if the permission is ever absent (e.g. a future
 * build moves them back to `optional_permissions`).
 *
 *   history      → "Resume where you left off": reads recent LMS/course page
 *                  visits to suggest re-opening a page the student was on.
 *                  Only short {title, url, lastVisit} summaries are used; the
 *                  full history is never copied or stored.
 *
 *   clipboardRead → "Paste assignment": when the student clicks the Paste
 *                  button in the side panel, reads the clipboard ONCE (a user
 *                  gesture) so they can drop in assignment text to search/ask
 *                  about. Never read ambiently or in the background.
 *
 * Loaded in the service worker (history) and the side panel (clipboard);
 * attaches to `self` (=== window in the panel).
 */
(function () {
  'use strict';

  // Hosts whose visits are relevant to a study "resume" suggestion. Kept in
  // sync with the spirit of manifest host_permissions / content_scripts.
  const LMS_HOST_RE = /(instructure\.com|brightspace\.com|d2l\.com|bcourses\.berkeley\.edu|bruinlearn\.ucla\.edu|canvas\.(ucsd|asu|mit)\.edu)/i;

  const OptionalCapabilities = {
    /** True if the named Chrome permission is currently granted. */
    async has(permission) {
      try {
        return await chrome.permissions.contains({ permissions: [permission] });
      } catch (_) { return false; }
    },

    /**
     * Legacy helper for builds that move a permission back to optional.
     * Required-permission builds should not call this in normal UI.
     */
    async request(permission) {
      try {
        return await chrome.permissions.request({ permissions: [permission] });
      } catch (_) { return false; }
    },

    /** Legacy helper for optional-permission builds. */
    async remove(permission) {
      try {
        return await chrome.permissions.remove({ permissions: [permission] });
      } catch (_) { return false; }
    },

    /**
     * Recent LMS/course page visits, newest first. Returns [] unless the
     * `history` permission is granted. Only the fields needed for a "resume"
     * suggestion are returned — nothing is persisted here.
     * @param {{maxItems?: number, sinceDays?: number}} [opts]
     */
    async getRecentLmsHistory(opts) {
      if (!(await this.has('history'))) return [];
      if (!chrome.history?.search) return [];
      const maxItems = (opts && opts.maxItems) || 10;
      const sinceDays = (opts && opts.sinceDays) || 7;
      const startTime = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
      const raw = await new Promise((resolve) => {
        try {
          chrome.history.search({ text: '', startTime, maxResults: 200 }, (items) => resolve(items || []));
        } catch (_) { resolve([]); }
      });
      return raw
        .filter((h) => h && h.url && LMS_HOST_RE.test(h.url))
        .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))
        .slice(0, maxItems)
        .map((h) => ({ title: h.title || h.url, url: h.url, lastVisit: h.lastVisitTime || 0 }));
    },

    /**
     * Read the clipboard ONCE in response to a user gesture (a "Paste
     * assignment" button). Requires the `clipboardRead` permission and a
     * document context (the side panel — not the service worker). Returns ''
     * if not granted or unavailable. The caller decides what to do with the
     * text; this helper never stores it.
     */
    async readClipboardText() {
      if (!(await this.has('clipboardRead'))) return '';
      try {
        const clip = self.navigator?.clipboard;
        if (clip?.readText) {
          return (await clip.readText()) || '';
        }
      } catch (_) { /* denied or no focus */ }
      return '';
    },

    LMS_HOST_RE
  };

  self.CanvascopeOptionalCapabilities = OptionalCapabilities;
})();
