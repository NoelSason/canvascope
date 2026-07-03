/**
 * Canvascope — early Kaltura skin replay (anti-FOUC).
 *
 * Runs at document_start, before the browser's first paint. kaltura-skin.js
 * does its real work at document_idle after an async chrome.storage read, so
 * without this the Kaltura page (Media Gallery / standalone player) paints stock
 * white for a beat before the skin swaps in. To avoid that flash we replay the
 * *last rendered* skin CSS, which kaltura-skin.js mirrors into the page-origin
 * localStorage on every render.
 *
 * Best-effort pre-paint approximation: kaltura-skin.js then renders the
 * authoritative styles at idle and refreshes the cache for next time. The cache
 * key + class name must stay in sync with kaltura-skin.js (CACHE_KEY,
 * ROOT_CLASS). Mirrors src/content/skin-early.js for the Canvas side.
 */
(() => {
  const CACHE_KEY = 'cs-kaltura-css-cache-v1';
  const ROOT_CLASS = 'cs-kaltura-skin';
  const EARLY_STYLE_ID = 'canvascope-kaltura-skin-early';

  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || !data.active || !data.css) return;

    document.documentElement.classList.add(ROOT_CLASS);

    const style = document.createElement('style');
    style.id = EARLY_STYLE_ID;
    style.setAttribute('data-cs-kaltura-skin', '1');
    style.textContent = data.css;
    (document.head || document.documentElement).appendChild(style);
  } catch (_) {
    /* sandboxed localStorage, malformed cache, or quota — fall back to the
       idle-time render with its (one-time) flash. */
  }
})();
