/**
 * ============================================
 * Canvascope - DocViewer Skin Sync
 * ============================================
 *
 * Canvas renders PDF previews inside a sandboxed Canvadocs iframe. The parent
 * Canvas page cannot style that frame, so light themes such as Paper can end up
 * with a dark PDF toolbar and low-contrast title text. This all-frame content
 * script runs inside the viewer frame and paints only the viewer chrome around
 * the PDF, not the PDF page/canvas itself.
 * ============================================
 */
(() => {
  'use strict';

  const STYLE_ID = 'canvascope-docviewer-skin';
  const PARENT_STYLE_ID = 'canvascope-docviewer-parent-skin';

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
    accentText: '#fffaf2'
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
    accentText: '#181226'
  });

  function isDocViewerFrame() {
    return /(^|\.)canvadocs\./i.test(location.hostname) ||
      /\/sessions\/[^/]+\/documents\//i.test(location.pathname) ||
      /\/docviewer\//i.test(location.pathname);
  }

  function hasDocViewerChildFrame() {
    return Boolean(document.querySelector(
      'iframe[src*="canvadoc"], iframe[src*="/file_preview"], iframe[src*="inline_view"], #file-preview-iframe'
    ));
  }

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
        mode,
        tokens: {
          ...(mode === 'dark' ? DARK_FALLBACK_TOKENS : FALLBACK_TOKENS),
          ...(skin.customTokens || {})
        }
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

    return { mode, tokens: normalized.tokens || (mode === 'dark' ? DARK_FALLBACK_TOKENS : FALLBACK_TOKENS) };
  }

  function cssValue(value, fallback) {
    return String(value || fallback).replace(/[;\n\r]/g, '');
  }

  function ensureStyle(id) {
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      style.setAttribute('data-canvascope-docviewer-skin', '1');
      (document.head || document.documentElement).appendChild(style);
    }
    return style;
  }

  function removeStyle(id) {
    const style = document.getElementById(id);
    if (style?.parentNode) style.parentNode.removeChild(style);
  }

  function buildVars(tokens, mode) {
    return `
      --csdv-mode: ${mode};
      --csdv-bg: ${cssValue(tokens.bg, FALLBACK_TOKENS.bg)};
      --csdv-bg-soft: ${cssValue(tokens.bgSoft, FALLBACK_TOKENS.bgSoft)};
      --csdv-surface: ${cssValue(tokens.surface, FALLBACK_TOKENS.surface)};
      --csdv-surface-2: ${cssValue(tokens.surface2, FALLBACK_TOKENS.surface2)};
      --csdv-border: ${cssValue(tokens.border, FALLBACK_TOKENS.border)};
      --csdv-border-hi: ${cssValue(tokens.borderHi, FALLBACK_TOKENS.borderHi)};
      --csdv-text: ${cssValue(tokens.text, FALLBACK_TOKENS.text)};
      --csdv-text-dim: ${cssValue(tokens.textDim, FALLBACK_TOKENS.textDim)};
      --csdv-muted: ${cssValue(tokens.muted, FALLBACK_TOKENS.muted)};
      --csdv-accent: ${cssValue(tokens.accent, FALLBACK_TOKENS.accent)};
      --csdv-accent-text: ${cssValue(tokens.accentText, FALLBACK_TOKENS.accentText)};
    `;
  }

  function renderDocViewerStyles(tokens, mode) {
    document.documentElement.classList.add('cs-docviewer-skin');
    document.documentElement.classList.toggle('cs-docviewer-skin-light', mode === 'light');
    document.documentElement.classList.toggle('cs-docviewer-skin-dark', mode === 'dark');

    ensureStyle(STYLE_ID).textContent = `
:root.cs-docviewer-skin {
${buildVars(tokens, mode)}
  color-scheme: ${mode};
}

:root.cs-docviewer-skin,
:root.cs-docviewer-skin body {
  background: var(--csdv-bg) !important;
  color: var(--csdv-text) !important;
}

:root.cs-docviewer-skin body,
:root.cs-docviewer-skin #app,
:root.cs-docviewer-skin #viewer,
:root.cs-docviewer-skin #document_preview,
:root.cs-docviewer-skin .document-preview,
:root.cs-docviewer-skin .document_preview,
:root.cs-docviewer-skin .docviewer,
:root.cs-docviewer-skin [class*="DocViewer"],
:root.cs-docviewer-skin [class*="docViewer"],
:root.cs-docviewer-skin [class*="docviewer"],
:root.cs-docviewer-skin [class*="viewer"],
:root.cs-docviewer-skin [class*="Viewer"] {
  background-color: var(--csdv-bg) !important;
}

:root.cs-docviewer-skin header:not(button):not([role="button"]):not(a):not(i):not(span):not(img):not(svg):not(input):not(select),
:root.cs-docviewer-skin nav:not(button):not([role="button"]):not(a):not(i):not(span):not(img):not(svg):not(input):not(select),
:root.cs-docviewer-skin [role="toolbar"]:not(button):not([role="button"]):not(a):not(i):not(span):not(img):not(svg):not(input):not(select),
:root.cs-docviewer-skin [class*="toolbar"]:not(button):not([role="button"]):not(a):not(i):not(span):not(img):not(svg):not(input):not(select),
:root.cs-docviewer-skin [class*="Toolbar"]:not(button):not([role="button"]):not(a):not(i):not(span):not(img):not(svg):not(input):not(select),
:root.cs-docviewer-skin [class*="header"]:not(button):not([role="button"]):not(a):not(i):not(span):not(img):not(svg):not(input):not(select),
:root.cs-docviewer-skin [class*="Header"]:not(button):not([role="button"]):not(a):not(i):not(span):not(img):not(svg):not(input):not(select) {
  background: var(--csdv-surface) !important;
  background-image: none !important;
  color: var(--csdv-text) !important;
  border-color: var(--csdv-border-hi) !important;
  box-shadow: inset 0 -1px 0 var(--csdv-border) !important;
}

:root.cs-docviewer-skin header *,
:root.cs-docviewer-skin nav *,
:root.cs-docviewer-skin [role="toolbar"] *,
:root.cs-docviewer-skin [class*="toolbar"] *,
:root.cs-docviewer-skin [class*="Toolbar"] *,
:root.cs-docviewer-skin [class*="header"] *,
:root.cs-docviewer-skin [class*="Header"] * {
  color: var(--csdv-text) !important;
  border-color: var(--csdv-border-hi) !important;
}

:root.cs-docviewer-skin [class*="title"],
:root.cs-docviewer-skin [class*="Title"],
:root.cs-docviewer-skin [class*="filename"],
:root.cs-docviewer-skin [class*="Filename"],
:root.cs-docviewer-skin [class*="fileName"],
:root.cs-docviewer-skin [class*="documentName"] {
  color: var(--csdv-text) !important;
  text-shadow: none !important;
}

/*
 * The DocViewer toolbar (canvadocs.instructure.com .ViewerControls /
 * .DocumentControls) should blend into the page rather than read as a separate
 * strip, so paint the bar with the page background and keep only a hairline
 * bottom edge to separate it from the document.
 */
:root.cs-docviewer-skin [class*="ViewerControls"],
:root.cs-docviewer-skin [class*="DocumentControls"] {
  background: var(--csdv-bg) !important;
  background-image: none !important;
  border-color: var(--csdv-border) !important;
}

/*
 * Buttons sit lightly on the bar: a subtle raised surface and a soft border are
 * enough to read as controls now that the icons themselves are high-contrast
 * (see the fill:currentColor rule below). No heavy shadow, so nothing stands out
 * as a stark box against the page.
 */
:root.cs-docviewer-skin button,
:root.cs-docviewer-skin [role="button"],
:root.cs-docviewer-skin select,
:root.cs-docviewer-skin input {
  background-color: var(--csdv-surface) !important;
  color: var(--csdv-text) !important;
  border: 1px solid var(--csdv-border-hi) !important;
  box-shadow: none !important;
}

/*
 * Recolor toolbar icons to the text color directly rather than inverting them.
 * The canvadocs viewer (loaded with ?theme=dark) draws most icons near-white but
 * a few (e.g. the rotate/refresh control) already dark; a blanket invert(1)
 * flips those the wrong way and leaves them faint. fill:currentColor recolors
 * every monochrome SVG deterministically in both light and dark modes.
 */
:root.cs-docviewer-skin button svg,
:root.cs-docviewer-skin button svg *,
:root.cs-docviewer-skin [role="button"] svg,
:root.cs-docviewer-skin [role="button"] svg *,
:root.cs-docviewer-skin [role="toolbar"] svg,
:root.cs-docviewer-skin [role="toolbar"] svg * {
  filter: none !important;
  fill: currentColor !important;
}

/* Raster icons (e.g. <img>) can't be recolored via fill; invert in light mode. */
:root.cs-docviewer-skin-light button img,
:root.cs-docviewer-skin-light [role="button"] img {
  filter: invert(1) !important;
}

:root.cs-docviewer-skin button:hover,
:root.cs-docviewer-skin [role="button"]:hover {
  background-color: var(--csdv-bg-soft) !important;
  color: var(--csdv-text) !important;
}

:root.cs-docviewer-skin button:focus,
:root.cs-docviewer-skin [role="button"]:focus,
:root.cs-docviewer-skin select:focus,
:root.cs-docviewer-skin input:focus {
  outline: 2px solid var(--csdv-accent) !important;
  outline-offset: 1px !important;
}

:root.cs-docviewer-skin [role="toolbar"] svg,
:root.cs-docviewer-skin [class*="toolbar"] svg,
:root.cs-docviewer-skin [class*="Toolbar"] svg,
:root.cs-docviewer-skin header svg,
:root.cs-docviewer-skin [role="toolbar"] svg *,
:root.cs-docviewer-skin [class*="toolbar"] svg *,
:root.cs-docviewer-skin [class*="Toolbar"] svg *,
:root.cs-docviewer-skin header svg * {
  color: currentColor !important;
  stroke: currentColor !important;
}

/*
 * The grey area around the PDF page is pdf.js's scroll region (the viewer is
 * pdf.js-based). Paint the scroll/viewer containers with bg-soft — one step
 * darker than the page background — so the gutter matches the theme while still
 * being distinguishable from the document page. Deliberately NOT targeting
 * .page/.canvasWrapper/.textLayer so the actual pages stay their real colour.
 */
:root.cs-docviewer-skin [class*="pageContainer"],
:root.cs-docviewer-skin [class*="PageContainer"],
:root.cs-docviewer-skin [class*="page-container"],
:root.cs-docviewer-skin [class*="document-container"],
:root.cs-docviewer-skin [class*="DocumentContainer"],
:root.cs-docviewer-skin [class*="DocumentView"],
:root.cs-docviewer-skin [class*="documentView"],
:root.cs-docviewer-skin [class*="Pages"],
:root.cs-docviewer-skin [class*="scroll"],
:root.cs-docviewer-skin [class*="Scroll"],
:root.cs-docviewer-skin #outerContainer,
:root.cs-docviewer-skin #mainContainer,
:root.cs-docviewer-skin #viewerContainer,
:root.cs-docviewer-skin #viewer,
:root.cs-docviewer-skin .pdfViewer,
:root.cs-docviewer-skin [class*="pdfViewer"],
:root.cs-docviewer-skin [class*="viewerContainer"],
:root.cs-docviewer-skin [class*="ViewerContainer"] {
  background-color: var(--csdv-bg-soft) !important;
}
`;
  }

  function renderParentStyles(tokens, mode) {
    if (!hasDocViewerChildFrame()) {
      removeStyle(PARENT_STYLE_ID);
      return;
    }

    ensureStyle(PARENT_STYLE_ID).textContent = `
:root {
${buildVars(tokens, mode)}
}

#file-preview,
#file_preview,
#file-preview-container,
#file_preview_container,
#preview_frame,
.file_preview,
.file-preview,
.ef-file-preview {
  background-color: var(--csdv-bg) !important;
}

#file-preview-iframe,
iframe[src*="canvadoc"],
iframe[src*="/file_preview"],
iframe[src*="inline_view"] {
  background-color: var(--csdv-bg) !important;
  color-scheme: ${mode};
}

/*
 * Canvas renders the full-screen file preview as an Instructure UI Modal whose
 * emotion class names end in -modal/-modalHeader/-modalBody/-modalFooter. That
 * chrome lives in this (parent) page, not the canvadocs frame, so the dark
 * navy header/footer survive light themes unless we repaint them here. Scope to
 * the modal that actually wraps the preview iframe so other dialogs are left be.
 */
[class*="-modal"]:has(#file-preview-iframe),
[class*="-modal"]:has(#file-preview-iframe) [class*="modalHeader"],
[class*="-modal"]:has(#file-preview-iframe) [class*="modalFooter"] {
  background: var(--csdv-surface) !important;
  background-image: none !important;
  color: var(--csdv-text) !important;
  border-color: var(--csdv-border-hi) !important;
}

[class*="-modal"]:has(#file-preview-iframe) [class*="modalBody"] {
  background: var(--csdv-bg) !important;
  color: var(--csdv-text) !important;
}

[class*="-modal"]:has(#file-preview-iframe) [class*="modalHeader"] *,
[class*="-modal"]:has(#file-preview-iframe) [class*="modalFooter"] * {
  color: var(--csdv-text) !important;
  border-color: var(--csdv-border-hi) !important;
}

[class*="-modal"]:has(#file-preview-iframe) [class*="modalHeader"] svg,
[class*="-modal"]:has(#file-preview-iframe) [class*="modalFooter"] svg {
  fill: currentColor !important;
  color: var(--csdv-text) !important;
}
${mode === 'light' ? `
/* The "Alternative formats" (Ally) control is a fixed light-colored <img>, so
 * color/fill cannot darken it. Invert it for legibility on a light header. */
[class*="-modal"]:has(#file-preview-iframe) [class*="modalHeader"] img {
  filter: invert(1) brightness(0.4) !important;
}
` : ''}
`;
  }

  async function loadSkin() {
    try {
      const data = await chrome.storage.local.get(['canvasSkin']);
      return deepMerge(JSON.parse(JSON.stringify(DEFAULT_SKIN)), data.canvasSkin || {});
    } catch (_) {
      return JSON.parse(JSON.stringify(DEFAULT_SKIN));
    }
  }

  async function render() {
    const skin = await loadSkin();
    if (!skin.enabled) {
      removeStyle(STYLE_ID);
      removeStyle(PARENT_STYLE_ID);
      return;
    }

    const mode = getEffectiveMode(skin);
    const { tokens } = resolveTokens(skin, mode);
    if (isDocViewerFrame()) renderDocViewerStyles(tokens, mode);
    else renderParentStyles(tokens, mode);
  }

  function observeParentForPreviewFrame() {
    if (isDocViewerFrame()) return;
    if (!document.documentElement) return;
    const observer = new MutationObserver(() => { void render(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  void render();
  observeParentForPreviewFrame();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.canvasSkin) void render();
    });
  } catch (_) {
    // Non-extension test contexts do not expose chrome.storage.
  }
})();
