/**
 * Canvascope — early skin replay (anti-FOUC).
 *
 * Runs at document_start, before the browser's first paint. canvas-skin.js
 * does its real work at document_idle after an async chrome.storage read, so
 * without this the page paints Canvas's stock theme for a beat before the skin
 * swaps in. To avoid that flash we replay the *last rendered* skin CSS, which
 * canvas-skin.js mirrors into the page-origin localStorage on every render.
 *
 * This is a best-effort pre-paint approximation: canvas-skin.js then renders
 * the authoritative styles at idle, removes our early <style>, and refreshes
 * the cache for next time. Keys/class names must stay in sync with
 * canvas-skin.js (SKIN_CSS_CACHE_KEY, BODY_ROOT_CLASS, BODY_MODE_CLASS_PREFIX).
 */
(() => {
  const CACHE_KEY = 'cs-skin-css-cache-v1';
  const ROOT_CLASS = 'cs-skin-root';
  const MODE_PREFIX = 'cs-skin-mode-';
  const EARLY_STYLE_ID = 'cs-skin-early';

  // In subframes, only paint the same-origin LTI tool *launch* page
  // (/external_tools/...) — a near-blank white auto-submit document that
  // otherwise shows white inside the themed page while the real tool loads.
  // Other Canvas subframes (canvadocs/docviewer, speedgrader) are themed by
  // their own scripts and must not get the full Canvas skin replayed into them.
  if (window.top !== window.self && !location.pathname.includes('/external_tools/')) {
    return;
  }

  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || !data.active || !data.css) return;

    const root = document.documentElement;
    root.classList.add(ROOT_CLASS);
    root.classList.remove(MODE_PREFIX + 'light', MODE_PREFIX + 'dark');
    if (data.mode === 'light' || data.mode === 'dark') {
      root.classList.add(MODE_PREFIX + data.mode);
    }

    const style = document.createElement('style');
    style.id = EARLY_STYLE_ID;
    style.setAttribute('data-cs-skin', '1');
    style.textContent = data.css;
    (document.head || document.documentElement).appendChild(style);
  } catch (_) {
    /* sandboxed localStorage, malformed cache, or quota — fall back to the
       idle-time render with its (one-time) flash. */
  }
})();
