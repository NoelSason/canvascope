/**
 * Canvascope v10 — UI theme bootstrap.
 * Applies [data-theme] on <html> before first paint. localStorage mirrors the
 * canonical chrome.storage value so the synchronous read avoids a theme flash;
 * the async read then reconciles and keeps the mirror fresh.
 * Themes: 'dark' (default) | 'light'. A legacy stored 'auto' is no longer
 * valid and coerces to the default below.
 */
(() => {
  const KEY = 'cs-ui-theme';
  const VALID = new Set(['dark', 'light']);

  const apply = (theme) => {
    const t = VALID.has(theme) ? theme : 'dark';
    document.documentElement.dataset.theme = t;
  };

  let cached = null;
  try { cached = localStorage.getItem(KEY); } catch (_) { /* sandboxed */ }
  apply(cached);

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get('canvasSkin', ({ canvasSkin }) => {
      const theme = canvasSkin?.uiTheme;
      if (VALID.has(theme) && theme !== cached) {
        apply(theme);
        try { localStorage.setItem(KEY, theme); } catch (_) { /* ignore */ }
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.canvasSkin) return;
      const theme = changes.canvasSkin.newValue?.uiTheme;
      if (VALID.has(theme)) {
        apply(theme);
        try { localStorage.setItem(KEY, theme); } catch (_) { /* ignore */ }
      }
    });
  }

  // Expose for settings UI / slash commands.
  window.__canvascopeSetUiTheme = (theme) => {
    if (!VALID.has(theme)) return false;
    apply(theme);
    try { localStorage.setItem(KEY, theme); } catch (_) { /* ignore */ }
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get('canvasSkin', ({ canvasSkin }) => {
        const next = Object.assign({}, canvasSkin || {}, { uiTheme: theme, __updatedAt: Date.now() });
        chrome.storage.local.set({ canvasSkin: next });
      });
    }
    return true;
  };
})();
