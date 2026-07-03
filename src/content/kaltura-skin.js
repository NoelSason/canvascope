/**
 * ============================================
 * Canvascope - Kaltura Skin Sync
 * ============================================
 *
 * Canvas surfaces Kaltura media through the institution's hosted Kaltura
 * (KAF) site — e.g. the "Media Gallery" course-nav tool embeds
 * kaf.<institution>.edu in a cross-origin iframe, and clicking a video opens
 * a standalone kaf.<institution>.edu/media/... page in its own tab. Neither
 * canvas-skin (top Canvas frame only) nor docviewer-skin (Canvas domains only)
 * reaches these, so they render stock white under a dark/Paper theme.
 *
 * This content script matches Kaltura hosts and runs in every frame, so the
 * same code paints both the embedded gallery iframe and the full-page player.
 * It is deliberately conservative: it paints the page background + text and
 * neutralizes white container surfaces, but never recolors the video player,
 * thumbnails, or accent call-to-action buttons (e.g. "Add Media").
 * ============================================
 */
(() => {
  'use strict';

  const STYLE_ID = 'canvascope-kaltura-skin';
  const ROOT_CLASS = 'cs-kaltura-skin';
  // Page-origin localStorage cache replayed by kaltura-skin-early.js at
  // document_start to kill the white flash on load. Keep this key + ROOT_CLASS
  // in sync with kaltura-skin-early.js. Mirrors the Canvas skin-early pattern.
  const CACHE_KEY = 'cs-kaltura-css-cache-v1';

  const DEFAULT_SKIN = Object.freeze({
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

  const FALLBACK_TOKENS = Object.freeze({
    bg: '#f8f4ea',
    bgSoft: '#efe9d8',
    surface: '#fdfaf2',
    surface2: '#ece4ce',
    border: 'rgba(94,71,45,0.10)',
    borderHi: 'rgba(94,71,45,0.18)',
    text: '#2d2925',
    textDim: '#6b5f4d',
    muted: '#9b8f78',
    accent: '#b87333',
    accentText: '#fffaf2',
    link: '#b87333'
  });

  const DARK_FALLBACK_TOKENS = Object.freeze({
    bg: '#0a0a0d',
    bgSoft: '#0e0e12',
    surface: '#14141a',
    surface2: '#1b1b22',
    border: '#22222a',
    borderHi: '#32323c',
    text: '#ececef',
    textDim: '#9b9ba6',
    muted: '#65656f',
    accent: '#b9a5ff',
    accentText: '#181226',
    link: '#b9a5ff'
  });

  function deepMerge(target, patch) {
    if (!patch || typeof patch !== 'object') return target;
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        target[key] = deepMerge(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
      } else {
        target[key] = value;
      }
    }
    return target;
  }

  function computeScheduledMode(schedule) {
    const now = new Date();
    const minsNow = now.getHours() * 60 + now.getMinutes();
    const [startHour, startMinute] = String(schedule?.darkStart || '19:00').split(':').map(Number);
    const [endHour, endMinute] = String(schedule?.darkEnd || '07:00').split(':').map(Number);
    const start = (Number.isFinite(startHour) ? startHour : 19) * 60 + (Number.isFinite(startMinute) ? startMinute : 0);
    const end = (Number.isFinite(endHour) ? endHour : 7) * 60 + (Number.isFinite(endMinute) ? endMinute : 0);
    if (start < end) return minsNow >= start && minsNow < end ? 'dark' : 'light';
    return minsNow >= start || minsNow < end ? 'dark' : 'light';
  }

  function getThemesApi() {
    return window.CanvascopeSkinThemes || null;
  }

  function getEffectiveMode(skin) {
    if (skin.mode === 'light' || skin.mode === 'dark') return skin.mode;
    if (skin.mode === 'system' || skin.followSystem) {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    if (skin.mode === 'scheduled' && skin.schedule?.enabled) {
      return computeScheduledMode(skin.schedule);
    }
    const themeMode = getThemesApi()?.getTheme(skin.themeId)?.mode;
    return themeMode === 'dark' ? 'dark' : 'light';
  }

  function resolveTokens(skin, mode) {
    const themesApi = getThemesApi();
    if (!themesApi) {
      return {
        ...(mode === 'dark' ? DARK_FALLBACK_TOKENS : FALLBACK_TOKENS),
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

    return normalized.tokens || (mode === 'dark' ? DARK_FALLBACK_TOKENS : FALLBACK_TOKENS);
  }

  function cssValue(value, fallback) {
    return String(value || fallback).replace(/[;{}<>\n\r]/g, '');
  }

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-canvascope-kaltura-skin', '1');
      (document.head || document.documentElement).appendChild(style);
    } else if (style.parentNode !== (document.head || document.documentElement)) {
      (document.head || document.documentElement).appendChild(style);
    }
    return style;
  }

  function removeStyle() {
    const style = document.getElementById(STYLE_ID);
    if (style?.parentNode) style.parentNode.removeChild(style);
  }

  function buildCss(tokens, mode) {
    const bg = cssValue(tokens.bg, FALLBACK_TOKENS.bg);
    const surface = cssValue(tokens.surface, FALLBACK_TOKENS.surface);
    const border = cssValue(tokens.border, FALLBACK_TOKENS.border);
    const borderHi = cssValue(tokens.borderHi, FALLBACK_TOKENS.borderHi);
    const text = cssValue(tokens.text, FALLBACK_TOKENS.text);
    const muted = cssValue(tokens.muted, FALLBACK_TOKENS.muted);
    const accent = cssValue(tokens.accent, FALLBACK_TOKENS.accent);

    return `
:root.cs-kaltura-skin, :root.cs-kaltura-skin body {
  background-color: ${bg} !important;
  background-image: none !important;
  color: ${text} !important;
  color-scheme: ${mode};
}
/* Neutralize Kaltura's white panel/container surfaces so the themed page shows
   through. Backgrounds only — never touches the player, thumbnails, or video. */
:root.cs-kaltura-skin #contentContainer,
:root.cs-kaltura-skin .contentContainer,
:root.cs-kaltura-skin .tlh-container,
:root.cs-kaltura-skin .page-wrap,
:root.cs-kaltura-skin main,
:root.cs-kaltura-skin .eventplatform,
:root.cs-kaltura-skin .gallery,
:root.cs-kaltura-skin [class*="galleryContainer"],
:root.cs-kaltura-skin [class*="GalleryContainer"],
:root.cs-kaltura-skin [class*="pageContainer"],
:root.cs-kaltura-skin [class*="PageContainer"],
:root.cs-kaltura-skin [class*="container"],
:root.cs-kaltura-skin [class*="Container"],
:root.cs-kaltura-skin [class*="wrapper"],
:root.cs-kaltura-skin [class*="Wrapper"],
:root.cs-kaltura-skin .panel,
:root.cs-kaltura-skin .panel-body,
:root.cs-kaltura-skin .well,
:root.cs-kaltura-skin .tab-content,
:root.cs-kaltura-skin .row {
  background-color: transparent !important;
  background-image: none !important;
}
/* Deliberately NO blanket heading/title/meta/link recolor here. Kaltura's UI is
   designed for a white page, so its text and links are already dark/colored and
   stay readable on the (light) themed background via the inherited body color
   above. Force-recoloring instead breaks the text and links Kaltura draws white
   ON TOP OF video imagery (entry title, description, duration, and the engaged
   counts/links in the stats bar) — e.g. a recolored comment-count link turned
   accent-red over the poster. Links keep Kaltura's own color except where
   re-whitened by the over-media rule below. */
:root.cs-kaltura-skin input,
:root.cs-kaltura-skin select,
:root.cs-kaltura-skin textarea,
:root.cs-kaltura-skin .form-control,
:root.cs-kaltura-skin [class*="searchInput"],
:root.cs-kaltura-skin [class*="SearchInput"],
:root.cs-kaltura-skin [class*="searchForm"] {
  background-color: ${surface} !important;
  color: ${text} !important;
  border-color: ${borderHi} !important;
}
:root.cs-kaltura-skin input::placeholder,
:root.cs-kaltura-skin textarea::placeholder { color: ${muted} !important; }
:root.cs-kaltura-skin hr,
:root.cs-kaltura-skin .nav-tabs,
:root.cs-kaltura-skin [class*="divider"],
:root.cs-kaltura-skin [class*="Divider"] {
  border-color: ${border} !important;
}
:root.cs-kaltura-skin .nav-tabs > li.active > a,
:root.cs-kaltura-skin .nav-tabs > li > a:hover {
  border-bottom-color: ${accent} !important;
  color: ${text} !important;
}
/* Secondary/default buttons blend into the theme; primary/accent buttons keep
   their own color so calls-to-action stay recognizable. */
:root.cs-kaltura-skin .btn-default,
:root.cs-kaltura-skin .btn:not(.btn-primary):not([class*="primary"]):not([class*="Primary"]) {
  background-color: ${surface} !important;
  color: ${text} !important;
  border-color: ${borderHi} !important;
}
/* Text Kaltura overlays on video imagery — thumbnail titles in the gallery and
   the entry title/description/duration over the player poster — must stay light
   with a shadow for legibility on the (dark) frame, in every theme. Scoped to
   text inside a thumbnail / poster / player / video / media / hero container so
   that titles sitting on the themed page background keep their normal color. */
:root.cs-kaltura-skin [class*="humbnail"] [class*="itle"],
:root.cs-kaltura-skin [class*="humbnail"] [class*="ntryName"],
:root.cs-kaltura-skin [class*="humbnail"] [class*="uration"],
:root.cs-kaltura-skin [class*="humbnail"] [class*="escription"],
:root.cs-kaltura-skin [class*="humbnail"] a,
:root.cs-kaltura-skin [class*="humb"] [class*="itle"],
:root.cs-kaltura-skin [class*="_tile"] [class*="itle"],
:root.cs-kaltura-skin [class*="oster"] [class*="itle"],
:root.cs-kaltura-skin [class*="oster"] [class*="ntryName"],
:root.cs-kaltura-skin [class*="oster"] [class*="escription"],
:root.cs-kaltura-skin [class*="oster"] [class*="uration"],
:root.cs-kaltura-skin [class*="oster"] a,
:root.cs-kaltura-skin [class*="layerContainer"] [class*="itle"],
:root.cs-kaltura-skin [class*="layerContainer"] [class*="ntryName"],
:root.cs-kaltura-skin [class*="layerContainer"] [class*="escription"],
:root.cs-kaltura-skin [class*="layerContainer"] [class*="uration"],
:root.cs-kaltura-skin [class*="layerContainer"] a,
:root.cs-kaltura-skin [class*="mediaContainer"] [class*="itle"],
:root.cs-kaltura-skin [class*="mediaContainer"] [class*="ntryName"],
:root.cs-kaltura-skin [class*="mediaContainer"] [class*="escription"],
:root.cs-kaltura-skin [class*="mediaContainer"] [class*="uration"],
:root.cs-kaltura-skin [class*="mediaContainer"] a,
:root.cs-kaltura-skin [class*="oster"] [class*="ount"],
:root.cs-kaltura-skin [class*="layerContainer"] [class*="ount"],
:root.cs-kaltura-skin [class*="mediaContainer"] [class*="ount"],
:root.cs-kaltura-skin [class*="ngagement"] a,
:root.cs-kaltura-skin [class*="ngagement"] [class*="ount"],
:root.cs-kaltura-skin [class*="ntryStats"] a,
:root.cs-kaltura-skin [class*="ntryStats"] [class*="ount"],
:root.cs-kaltura-skin .photo-group [class*="itle"],
:root.cs-kaltura-skin .photo-group .name,
:root.cs-kaltura-skin .entry-title,
:root.cs-kaltura-skin a.entry-title,
:root.cs-kaltura-skin .cb-entry-title {
  color: #ffffff !important;
  text-shadow: 0 1px 3px rgba(0,0,0,0.9) !important;
}
`;
  }

  // Cached in memory and refreshed by the storage listener so render() (which
  // can run on mutation) never awaits a chrome.storage round-trip.
  let cachedSkin = null;

  async function loadSkin() {
    if (cachedSkin) return cachedSkin;
    try {
      const data = await chrome.storage.local.get(['canvasSkin']);
      cachedSkin = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SKIN)), data.canvasSkin || {});
    } catch (_) {
      cachedSkin = JSON.parse(JSON.stringify(DEFAULT_SKIN));
    }
    return cachedSkin;
  }

  // Mirror the rendered CSS into page-origin localStorage so the early replay
  // (kaltura-skin-early.js) can paint it before first paint on the next load.
  function persistCache(css, mode) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ active: true, css, mode }));
    } catch (_) {
      // sandboxed/quota — the next load just flashes once.
    }
  }

  function clearCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ active: false })); } catch (_) {}
  }

  function removeBackgroundEarlyCss() {
    try {
      const maybePromise = chrome.runtime.sendMessage({ action: 'csKaltura.removeEarlyFrameCss' });
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
    } catch (_) {
      // Background script may be unavailable in tests or transient reloads.
    }
  }

  async function render() {
    const skin = await loadSkin();
    if (!skin.enabled) {
      document.documentElement.classList.remove(ROOT_CLASS);
      removeStyle();
      clearCache();
      removeBackgroundEarlyCss();
      return;
    }
    const mode = getEffectiveMode(skin);
    const tokens = resolveTokens(skin, mode);
    const css = buildCss(tokens, mode);
    document.documentElement.classList.add(ROOT_CLASS);
    ensureStyle().textContent = css;
    // Authoritative styles are in place; drop the early pre-paint replay.
    const early = document.getElementById('canvascope-kaltura-skin-early');
    if (early?.parentNode) early.parentNode.removeChild(early);
    persistCache(css, mode);
    removeBackgroundEarlyCss();
  }

  void render();

  // Kaltura's SPA re-renders aggressively and notably overwrites <html>'s
  // className during boot, which strips our ROOT_CLASS so the (class-scoped)
  // styles stop matching and the page flashes back to white. Re-assert BOTH the
  // class and the <style> whenever either goes missing. Watch the html element's
  // attributes (class wipes) and the subtree (head/style removal). Batched.
  if (document.documentElement) {
    let scheduled = false;
    const reassert = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!cachedSkin || !cachedSkin.enabled) return;
        const missingStyle = !document.getElementById(STYLE_ID);
        const missingClass = !document.documentElement.classList.contains(ROOT_CLASS);
        if (missingStyle || missingClass) void render();
      });
    };
    // Two scopes: <html>'s own class attribute (the wipe), and subtree childList
    // (head/<style> removal). Kept separate so we don't watch class mutations
    // across the whole SPA subtree, which would be needlessly heavy.
    new MutationObserver(reassert).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
    new MutationObserver(reassert).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.canvasSkin) {
        cachedSkin = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SKIN)), changes.canvasSkin.newValue || {});
        void render();
      }
    });
  } catch (_) {
    // Non-extension test contexts do not expose chrome.storage.
  }
})();
