/**
 * ============================================
 * Canvascope – Canvas Skin Engine (canvas-skin.js)
 * ============================================
 *
 * PURPOSE:
 * Mutates the live Canvas/Brightspace DOM to apply user customization:
 *   - Themes (light/dark catalog + custom CSS variables)
 *   - Custom fonts
 *   - Dashboard card paint (per-course color), gradients, condensed density
 *   - Card background images
 *   - Sidebar tweaks (hide logo, hide recent feedback, hide help)
 *   - Card link override (right-click → choose default landing)
 *   - Assignment / announcement preview on hover
 *   - Dashboard grade pills
 *   - Dark-mode fixer for white-background islands
 *   - OS dark-mode sync, scheduled dark mode
 *
 * STATE:
 * All settings live under chrome.storage.local key `canvasSkin`. Mutations
 * go through applySkin(patch) which merges, persists, and re-renders. A
 * single MutationObserver watches the Canvas SPA for DOM swaps and re-applies.
 *
 * STYLE NAMESPACE:
 * Everything injected by this module uses the `.cs-skin-*` class prefix or
 * `--cs-skin-*` CSS variable prefix to avoid colliding with Canvas or with
 * the existing `.cs-*` classes used by the popup.
 *
 * ============================================
 */

(function canvascopeCanvasSkin() {
  'use strict';

  if (window.__canvascopeCanvasSkinInitialised) return;
  window.__canvascopeCanvasSkinInitialised = true;

  const SKIN_STORAGE_KEY = 'canvasSkin';
  const STYLE_VARS_ID = 'cs-skin-vars';
  const STYLE_RULES_ID = 'cs-skin-rules';
  const STYLE_CARDS_ID = 'cs-skin-cards';
  const STYLE_SIDEBAR_ID = 'cs-skin-sidebar';
  const STYLE_WIDGETS_ID = 'cs-skin-widgets';
  const BODY_ROOT_CLASS = 'cs-skin-root';
  const BODY_MODE_CLASS_PREFIX = 'cs-skin-mode-';
  const PAGE_TITLE_ROW_CLASS = 'cs-skin-page-title-row';
  const PAGE_TITLE_SHELL_CLASS = 'cs-skin-page-title-shell';
  const PAGE_TITLE_TEXT_CLASS = 'cs-skin-page-title-text';
  const DARK_SURFACE_CLASS = 'cs-skin-dark-surface';
  const BRIGHT_CONTENT_CLASS = 'cs-skin-bright-content';
  const PREVIEW_CARD_ID = 'cs-skin-preview-card';
  const DARK_FIXER_EXEMPT_SELECTOR = [
    '.ic-app-nav-toggle-and-crumbs',
    '#breadcrumbs',
    '.ic-Action-header',
    '.ic-Action-header__Primary',
    '.ic-page-header',
    '.page-title',
    'header',
    'h1'
  ].join(',');
  const DARK_FIXER_SCOPE_SELECTOR = [
    '.ic-app-main-content',
    '.ic-Layout-contentMain',
    '.ic-Layout-contentWrapper',
    '.ic-app-main-content__secondary',
    '#content',
    '#main'
  ].join(',');
  const PREVIEW_DELAY_MS = 350;
  const PREVIEW_FETCH_TIMEOUT_MS = 6000;

  const DEFAULT_SKIN = Object.freeze({
    __skinDefaultsVersion: 3,
    enabled: true,
    themeId: 'canvas-default',
    mode: 'auto',            // 'auto' | 'light' | 'dark' | 'system' | 'scheduled'
    customTokens: {},        // partial overrides on top of the chosen theme
    followSystem: false,     // mirror prefers-color-scheme; sets mode to system
    schedule: {              // for mode === 'scheduled'
      enabled: false,
      darkStart: '19:00',
      darkEnd: '07:00'
    },
    font: 'system',          // id from lib/skin-themes.js BUILTIN_FONTS, or 'custom'
    customFont: '',          // free-form font-family string when font === 'custom'
    cardDensity: 'canvas',   // 'canvas' | 'compact' | 'cozy' | 'comfy'
    cardGradient: false,
    cardOverlayDisabled: false,
    cardBackgrounds: {},     // courseId -> dataURL or https URL
    cardColors: {},          // courseId -> hex color override
    cardLinkOverrides: {},   // courseId -> 'home' | 'grades' | 'modules' | 'assignments' | 'announcements'
    hideSidebarLogo: false,
    hideSidebarHelp: false,
    hideRecentFeedback: false,
    darkModeFixer: true,     // MutationObserver that inverts inline white backgrounds
    previewsEnabled: false,
    previewsShowRank: true,
    showGradePills: false
  });

  // -------------------------------------------------------------------------
  // STATE
  // -------------------------------------------------------------------------
  function defaultSkinState() {
    return JSON.parse(JSON.stringify(DEFAULT_SKIN));
  }

  let skin = defaultSkinState();
  let systemDarkMQ = null;
  let scheduleAlarmTimer = null;
  let darkFixerObserver = null;
  let domObserver = null;
  let previewTimer = null;
  let activePreviewLink = null;
  let cachedThemes = null;

  // -------------------------------------------------------------------------
  // HELPERS
  // -------------------------------------------------------------------------

  function getThemes() {
    if (cachedThemes) return cachedThemes;
    cachedThemes = (window.CanvascopeSkinThemes && window.CanvascopeSkinThemes) || null;
    return cachedThemes;
  }

  function deepMerge(target, patch) {
    if (!patch || typeof patch !== 'object') return target;
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        target[k] = deepMerge(target[k] && typeof target[k] === 'object' ? target[k] : {}, v);
      } else {
        target[k] = v;
      }
    }
    return target;
  }

  function ensureStyle(id) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      el.setAttribute('data-cs-skin', '1');
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function removeStyle(id) {
    const el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function hasOwnEntries(obj) {
    return !!obj && typeof obj === 'object' && Object.keys(obj).length > 0;
  }

  function hasThemePaint(mode) {
    return skin.themeId !== 'canvas-default' ||
      mode === 'dark' ||
      skin.font !== 'system' ||
      hasOwnEntries(skin.customTokens);
  }

  function hasCardCustomizations() {
    return skin.cardDensity !== 'canvas' ||
      skin.cardOverlayDisabled ||
      hasOwnEntries(skin.cardColors) ||
      hasOwnEntries(skin.cardBackgrounds) ||
      hasOwnEntries(skin.cardLinkOverrides);
  }

  function hasSidebarCustomizations() {
    return !!(skin.hideSidebarLogo || skin.hideSidebarHelp || skin.hideRecentFeedback);
  }

  function hasWidgetCustomizations() {
    return !!(skin.showGradePills || skin.previewsEnabled);
  }

  function isLegacyStockCandidate(candidate) {
    if (!candidate || candidate.themeId !== 'canvas-default') return false;
    if (!['auto', 'light', undefined, null].includes(candidate.mode)) return false;
    return !hasOwnEntries(candidate.customTokens) &&
      !hasOwnEntries(candidate.cardColors) &&
      !hasOwnEntries(candidate.cardBackgrounds) &&
      !hasOwnEntries(candidate.cardLinkOverrides) &&
      (candidate.font || 'system') === 'system' &&
      !candidate.customFont &&
      !candidate.cardGradient &&
      !candidate.cardOverlayDisabled &&
      !candidate.hideSidebarLogo &&
      !candidate.hideSidebarHelp &&
      !candidate.hideRecentFeedback &&
      candidate.darkModeFixer !== false;
  }

  function migrateStoredSkinState(next, raw) {
    if (!raw || raw.__skinDefaultsVersion >= 3) return next;
    if (isLegacyStockCandidate(next)) {
      next.cardDensity = 'canvas';
      next.showGradePills = false;
      next.previewsEnabled = false;
    }
    next.__skinDefaultsVersion = 3;
    return next;
  }

  function isCanvasStockVisualState(mode) {
    return !hasThemePaint(mode) &&
      !hasCardCustomizations() &&
      !hasSidebarCustomizations() &&
      !hasWidgetCustomizations();
  }

  function teardownVisualStyles() {
    removeStyle(STYLE_VARS_ID);
    removeStyle(STYLE_RULES_ID);
    removeStyle(STYLE_CARDS_ID);
    removeStyle(STYLE_SIDEBAR_ID);
    removeStyle(STYLE_WIDGETS_ID);
    document.documentElement.classList.remove(BODY_ROOT_CLASS);
    document.documentElement.classList.remove(BODY_MODE_CLASS_PREFIX + 'light',
                                              BODY_MODE_CLASS_PREFIX + 'dark');
    stopDarkFixer();
    removeGradePills();
    hidePreview();
    cleanupPageTitleMarkers();
    restoreCardLinks();
    restoreCardBackgrounds();
  }

  function isCanvasDashboardRoute() {
    const p = window.location.pathname || '';
    return p === '/' || p.startsWith('/?') || /\/dashboard($|\/)/.test(p);
  }

  function getEffectiveMode() {
    if (skin.mode === 'light' || skin.mode === 'dark') return skin.mode;
    if (skin.mode === 'system' || skin.followSystem) {
      if (!systemDarkMQ) systemDarkMQ = window.matchMedia('(prefers-color-scheme: dark)');
      return systemDarkMQ.matches ? 'dark' : 'light';
    }
    if (skin.mode === 'scheduled' && skin.schedule?.enabled) {
      return computeScheduledMode(skin.schedule);
    }
    // 'auto' — follow the chosen theme's own mode.
    const themeMode = getThemes()?.getTheme(skin.themeId)?.mode;
    return themeMode === 'dark' ? 'dark' : 'light';
  }

  function computeScheduledMode(sched) {
    const now = new Date();
    const minsNow = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = String(sched.darkStart || '19:00').split(':').map(Number);
    const [eh, em] = String(sched.darkEnd   || '07:00').split(':').map(Number);
    const start = (isFinite(sh) ? sh : 19) * 60 + (isFinite(sm) ? sm : 0);
    const end   = (isFinite(eh) ? eh : 7)  * 60 + (isFinite(em) ? em : 0);
    if (start < end) return (minsNow >= start && minsNow < end) ? 'dark' : 'light';
    // Wraps midnight
    return (minsNow >= start || minsNow < end) ? 'dark' : 'light';
  }

  // -------------------------------------------------------------------------
  // RENDER PIPELINE
  // -------------------------------------------------------------------------

  function renderAll() {
    const mode = getEffectiveMode();

    if (!skin.enabled || isCanvasStockVisualState(mode)) {
      // Stock Canvas means stock Canvas: no classes, no variables, no card
      // padding changes, no grade pills, no dark fixer, and no sidebar edits.
      teardownVisualStyles();
      return;
    }

    document.documentElement.classList.add(BODY_ROOT_CLASS);
    document.documentElement.classList.remove(BODY_MODE_CLASS_PREFIX + 'light',
                                              BODY_MODE_CLASS_PREFIX + 'dark');
    document.documentElement.classList.add(BODY_MODE_CLASS_PREFIX + mode);

    markPageTitleRows();
    renderThemeVars(mode);
    renderGlobalRules(mode);
    renderCardRules();
    renderSidebarRules();
    if (hasWidgetCustomizations()) renderWidgetStyles();
    else removeStyle(STYLE_WIDGETS_ID);
    if (skin.showGradePills) renderGradePills();
    else removeGradePills();
    renderCardBackgrounds();
    renderCardLinkOverrides();

    if (skin.darkModeFixer && mode === 'dark') startDarkFixer();
    else stopDarkFixer();

    startContentContrastEnhancer();
  }

  // -------------------------------------------------------------------------
  // CONTENT CONTRAST ENHANCER
  // -------------------------------------------------------------------------
  // Many courses use instructor-authored HTML with dark inline backgrounds
  // (navy banners, colored panels) but never set a matching text color. In
  // stock Canvas the body color is dark too, so contrast was always poor; our
  // themes make this more visible. Walk every .user_content element with a
  // computed dark background and tag it so a CSS rule forces light text on
  // it and its descendants. Runs on render + on DOM mutations.

  let contentContrastObserver = null;

  function getLuminance(colorStr) {
    if (!colorStr) return null;
    const m = colorStr.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    const [r, g, b] = parts;
    const a = parts[3] ?? 1;
    if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return null;
    if (a < 0.4) return null; // semi-transparent — skip
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function enhanceUserContentContrast(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    const userContents = root.matches?.('.user_content') ? [root] : [];
    root.querySelectorAll('.user_content').forEach(el => userContents.push(el));
    if (!userContents.length) return;
    userContents.forEach(uc => {
      uc.querySelectorAll('*').forEach(el => {
        if (el.matches('img,svg,canvas,video,iframe,picture,source,path,use,br,hr,script,style,link,meta')) return;
        const cs = getComputedStyle(el);
        const lum = getLuminance(cs.backgroundColor);
        if (lum == null) {
          el.classList.remove(BRIGHT_CONTENT_CLASS);
          return;
        }
        if (lum < 120) {
          el.classList.add(BRIGHT_CONTENT_CLASS);
        } else {
          el.classList.remove(BRIGHT_CONTENT_CLASS);
        }
      });
    });
  }

  function startContentContrastEnhancer() {
    enhanceUserContentContrast(document);
    if (contentContrastObserver) return;
    contentContrastObserver = new MutationObserver(muts => {
      let needs = false;
      muts.forEach(m => {
        m.addedNodes && m.addedNodes.forEach(n => {
          if (n.nodeType === 1 && (n.matches?.('.user_content') || n.querySelector?.('.user_content'))) {
            needs = true;
          }
        });
      });
      if (needs) enhanceUserContentContrast(document);
    });
    contentContrastObserver.observe(document.body || document.documentElement, {
      childList: true, subtree: true
    });
  }

  function renderThemeVars(mode) {
    const themesApi = getThemes();
    if (!themesApi) return;
    // Pick the user theme, but coerce its tokens to the active mode when the
    // user has chosen a mode that conflicts (e.g. theme is light, mode is dark
    // → fall back to a built-in dark theme so things stay readable).
    let theme = themesApi.getTheme(skin.themeId) || themesApi.getTheme('canvas-default');
    if (mode === 'dark' && theme.mode !== 'dark') theme = themesApi.getTheme('dim') || theme;
    if (mode === 'light' && theme.mode !== 'light') theme = themesApi.getTheme('canvas-default') || theme;

    // Apply user custom token overrides on top.
    const tokens = { ...theme.tokens, ...(skin.customTokens || {}) };
    const merged = themesApi.normalizeTheme({ ...theme, tokens });

    // Font resolution.
    const fontEntry = themesApi.getFont(skin.font);
    const fontFamily = skin.font === 'custom' && skin.customFont
      ? skin.customFont
      : (fontEntry?.value || themesApi.getFont('system').value);

    const css = `
:root.${BODY_ROOT_CLASS} {
${themesApi.buildCssVariables(merged)}
  --cs-skin-fontfamily: ${fontFamily};
}
`;
    ensureStyle(STYLE_VARS_ID).textContent = css;
  }

  function renderGlobalRules(mode) {
    // Canvas owns its nav, buttons, and native links. Themes only paint the
    // working canvas and a small set of dashboard/sidebar surfaces that we can
    // keep readable. This prevents the contrast failures seen when a theme
    // globally recolors every `a`, `button`, or sidebar node.
    if (!hasThemePaint(mode)) {
      removeStyle(STYLE_RULES_ID);
      return;
    }

    const fontRule = `
.${BODY_ROOT_CLASS} .ic-app-main-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain,
.${BODY_ROOT_CLASS} .ic-Layout-contentWrapper,
.${BODY_ROOT_CLASS} .ic-DashboardCard {
  font-family: var(--cs-skin-fontfamily) !important;
}
`;

    const bgRule = `
.${BODY_ROOT_CLASS} body,
.${BODY_ROOT_CLASS} #wrapper,
.${BODY_ROOT_CLASS} #application,
.${BODY_ROOT_CLASS} #application > .ic-Layout-wrapper,
.${BODY_ROOT_CLASS} .ic-app-main-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain,
.${BODY_ROOT_CLASS} .ic-Layout-contentWrapper {
  background-color: var(--cs-skin-bg) !important;
}
`;

    // Shared surface model for every non-stock theme. This is what makes
    // Paper/Solarized/Rose/etc. feel like complete themes instead of a page
    // background pasted behind Canvas's default white panels. Dark mode gets
    // extra white-island fixing below, but the actual layout chrome is common.
    const sharedSurfaceRules = `
.${BODY_ROOT_CLASS} .ic-Action-header,
.${BODY_ROOT_CLASS} .ic-page-header,
.${BODY_ROOT_CLASS} .page-title,
.${BODY_ROOT_CLASS} #breadcrumbs,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs .ic-app-crumbs,
.${BODY_ROOT_CLASS} .ic-app-crumbs,
.${BODY_ROOT_CLASS} #dashboard_header_container,
.${BODY_ROOT_CLASS} #DashboardOptionsMenu_Container,
.${BODY_ROOT_CLASS} .ic-Dashboard-header,
.${BODY_ROOT_CLASS} .ic-Dashboard-header__layout,
.${BODY_ROOT_CLASS} .ic-dashboard-header,
.${BODY_ROOT_CLASS} .ic-dashboard-header__layout,
.${BODY_ROOT_CLASS} .${PAGE_TITLE_ROW_CLASS},
.${BODY_ROOT_CLASS} .${PAGE_TITLE_SHELL_CLASS} {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
  box-shadow: inset 0 -1px 0 var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs {
  background-color: var(--cs-skin-bg) !important;
}
.${BODY_ROOT_CLASS} #breadcrumbs,
.${BODY_ROOT_CLASS} .ic-app-crumbs,
.${BODY_ROOT_CLASS} .ic-app-crumbs a,
.${BODY_ROOT_CLASS} .ic-app-crumbs span {
  background: transparent !important;
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} #breadcrumbs *,
.${BODY_ROOT_CLASS} .ic-app-crumbs *,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs .ic-app-crumbs *,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs .ellipsible {
  background: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
  text-shadow: none !important;
}
.${BODY_ROOT_CLASS} #breadcrumbs a,
.${BODY_ROOT_CLASS} .ic-app-crumbs a,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs .ic-app-crumbs a {
  color: var(--cs-skin-link) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content h1:not(.ic-DashboardCard__header-title),
.${BODY_ROOT_CLASS} .ic-app-main-content [role="heading"][aria-level="1"],
.${BODY_ROOT_CLASS} .ic-Dashboard-header__title,
.${BODY_ROOT_CLASS} .ic-dashboard-header__title,
.${BODY_ROOT_CLASS} .${PAGE_TITLE_TEXT_CLASS} {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-Action-header :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .ic-page-header :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .page-title :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .ic-Dashboard-header :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .ic-dashboard-header :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .${PAGE_TITLE_ROW_CLASS} :is(h1, h2, h3, [role="heading"], span, button, i, svg),
.${BODY_ROOT_CLASS} .${PAGE_TITLE_SHELL_CLASS} :is(h1, h2, h3, [role="heading"], span, button, i, svg) {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard {
  background-color: var(--cs-skin-surface) !important;
  border: 0 !important;
  border-radius: var(--cs-skin-radius-lg) !important;
  box-shadow: var(--cs-skin-shadow) !important;
  overflow: hidden !important;
  transition: transform 180ms ease, box-shadow 220ms ease !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard:hover {
  transform: translateY(-2px) !important;
  box-shadow: var(--cs-skin-shadow-hi) !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container,
.${BODY_ROOT_CLASS} .ic-DashboardCard__box,
.${BODY_ROOT_CLASS} .ic-DashboardCard__box__container {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border: 0 !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content {
  padding: 14px 16px !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header-title {
  font-weight: 600 !important;
  letter-spacing: 0 !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content a,
.${BODY_ROOT_CLASS} .ic-DashboardCard__header-title,
.${BODY_ROOT_CLASS} .ic-DashboardCard__header-title a,
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content .ic-DashboardCard__header-title {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header-subtitle,
.${BODY_ROOT_CLASS} .ic-DashboardCard__term,
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content .subtitle,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container i,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container svg {
  color: var(--cs-skin-text-dim) !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container a:hover,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container button:hover {
  color: var(--cs-skin-accent) !important;
}
.${BODY_ROOT_CLASS} #right-side-wrapper,
.${BODY_ROOT_CLASS} #right-side,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border: 0 !important;
  border-radius: var(--cs-skin-radius) !important;
  padding: 4px !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Sidebar,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Sidebar__TodoListContainer,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .events_list,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .todo-list,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .panel,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .well,
.${BODY_ROOT_CLASS} #right-side .Sidebar,
.${BODY_ROOT_CLASS} #right-side .Sidebar__TodoListContainer,
.${BODY_ROOT_CLASS} #right-side .events_list,
.${BODY_ROOT_CLASS} #right-side .todo-list,
.${BODY_ROOT_CLASS} #right-side .panel,
.${BODY_ROOT_CLASS} #right-side .well {
  background-color: transparent !important;
  color: var(--cs-skin-text) !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary :is(h2,h3,h4,p,li,span,div):not([class*="icon"]):not(.screenreader-only),
.${BODY_ROOT_CLASS} #right-side :is(h2,h3,h4,p,li,span,div):not([class*="icon"]):not(.screenreader-only) {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a span,
.${BODY_ROOT_CLASS} #right-side a,
.${BODY_ROOT_CLASS} #right-side a span {
  color: var(--cs-skin-link) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]),
.${BODY_ROOT_CLASS} .ic-app-main-content textarea,
.${BODY_ROOT_CLASS} .ic-app-main-content select {
  background-color: transparent !important;
  color: var(--cs-skin-text) !important;
  border: 1px solid var(--cs-skin-border) !important;
  border-radius: var(--cs-skin-radius-sm) !important;
  transition: border-color 160ms ease, box-shadow 160ms ease !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content input:focus,
.${BODY_ROOT_CLASS} .ic-app-main-content textarea:focus,
.${BODY_ROOT_CLASS} .ic-app-main-content select:focus {
  border-color: var(--cs-skin-accent) !important;
  box-shadow: 0 0 0 3px var(--cs-skin-ring-focus) !important;
  outline: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content ::placeholder {
  color: var(--cs-skin-muted) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button,
.${BODY_ROOT_CLASS} .ic-app-main-content button.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content a.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn,
.${BODY_ROOT_CLASS} .ic-app-main-content button.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content a.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content .ui-button,
.${BODY_ROOT_CLASS} .ic-app-main-content .ViewAllLink,
.${BODY_ROOT_CLASS} .ic-app-main-content .Button--secondary,
.${BODY_ROOT_CLASS} .ic-app-main-content .Button--default,
.${BODY_ROOT_CLASS} .ic-app-main-content .Button--link,
.${BODY_ROOT_CLASS} #right-side .Button,
.${BODY_ROOT_CLASS} #right-side a.Button,
.${BODY_ROOT_CLASS} #right-side button.Button,
.${BODY_ROOT_CLASS} #right-side .btn,
.${BODY_ROOT_CLASS} #right-side a.btn,
.${BODY_ROOT_CLASS} #right-side button.btn,
.${BODY_ROOT_CLASS} #right-side .button-sidebar-wide,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary button.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary button.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .button-sidebar-wide {
  background: var(--cs-skin-surface2) !important;
  background-image: none !important;
  color: var(--cs-skin-text) !important;
  border: 1px solid transparent !important;
  border-radius: var(--cs-skin-radius-sm) !important;
  box-shadow: none !important;
  text-shadow: none !important;
  font-weight: 500 !important;
  transition: background 160ms ease, border-color 160ms ease, transform 120ms ease, box-shadow 160ms ease !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content button.Button:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content a.Button:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content button.btn:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content a.btn:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content .ui-button:hover,
.${BODY_ROOT_CLASS} #right-side .Button:hover,
.${BODY_ROOT_CLASS} #right-side .btn:hover,
.${BODY_ROOT_CLASS} #right-side .button-sidebar-wide:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Button:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .btn:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .button-sidebar-wide:hover {
  background: var(--cs-skin-surface) !important;
  border-color: var(--cs-skin-accent) !important;
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button:active,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn:active {
  transform: translateY(1px) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button:focus-visible,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn:focus-visible {
  outline: none !important;
  box-shadow: 0 0 0 3px var(--cs-skin-ring-focus) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button--primary,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn-primary,
.${BODY_ROOT_CLASS} .ic-app-main-content button[type="submit"],
.${BODY_ROOT_CLASS} .ic-app-main-content .ui-button.ui-state-active {
  background: var(--cs-skin-accent) !important;
  color: var(--cs-skin-accent-text) !important;
  border-color: var(--cs-skin-accent) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button--primary:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn-primary:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content button[type="submit"]:hover {
  background: color-mix(in srgb, var(--cs-skin-accent), #000 10%) !important;
  border-color: color-mix(in srgb, var(--cs-skin-accent), #000 10%) !important;
  color: var(--cs-skin-accent-text) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button[disabled],
.${BODY_ROOT_CLASS} .ic-app-main-content .Button:disabled,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn[disabled],
.${BODY_ROOT_CLASS} .ic-app-main-content .btn:disabled {
  background: color-mix(in srgb, var(--cs-skin-surface2), transparent 35%) !important;
  color: var(--cs-skin-muted) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} #section-tabs,
.${BODY_ROOT_CLASS} .ic-app-course-menu,
.${BODY_ROOT_CLASS} .ic-app-course-menu__content,
.${BODY_ROOT_CLASS} .ic-app-course-menu .section,
.${BODY_ROOT_CLASS} #section-tabs li,
.${BODY_ROOT_CLASS} #section-tabs li a {
  background: transparent !important;
  color: var(--cs-skin-link) !important;
  border-color: transparent !important;
}
.${BODY_ROOT_CLASS} #section-tabs li a,
.${BODY_ROOT_CLASS} .ic-app-course-menu a {
  border-radius: var(--cs-skin-radius-sm) !important;
  margin: 2px 6px !important;
  padding: 8px 12px !important;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease !important;
}
.${BODY_ROOT_CLASS} #section-tabs li.section a.active,
.${BODY_ROOT_CLASS} #section-tabs li.section a:hover,
.${BODY_ROOT_CLASS} #section-tabs li a.active,
.${BODY_ROOT_CLASS} #section-tabs li a:hover,
.${BODY_ROOT_CLASS} .ic-app-course-menu a.active,
.${BODY_ROOT_CLASS} .ic-app-course-menu a:hover {
  background: var(--cs-skin-surface2) !important;
  color: var(--cs-skin-text) !important;
  border-left-color: var(--cs-skin-accent) !important;
  font-weight: 600 !important;
}
.${BODY_ROOT_CLASS} #section-tabs li a:not(.active):not(:hover),
.${BODY_ROOT_CLASS} .ic-app-course-menu a:not(.active):not(:hover) {
  opacity: 0.92 !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content-box-mini,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .enhanced,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .pad-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .panel,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .well,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ui-widget-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ui-tabs-panel,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ReactModal__Content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .PageContent,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .course_home_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .course-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .wiki-page-body,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .show-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .page-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain table.ic-Table,
.${BODY_ROOT_CLASS} .ic-app-main-content .header-bar,
.${BODY_ROOT_CLASS} .ic-app-main-content .toolbar,
.${BODY_ROOT_CLASS} .ic-app-main-content .sticky-toolbar,
.${BODY_ROOT_CLASS} .ic-app-main-content .search-bar,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Form-control,
.${BODY_ROOT_CLASS} .ic-app-main-content .form-actions,
.${BODY_ROOT_CLASS} .ic-app-main-content .form-dialog-content,
.${BODY_ROOT_CLASS} .ic-app-main-content .controls,
.${BODY_ROOT_CLASS} .ic-app-main-content .control-group,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Action-header__Secondary,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-thead,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-tbody,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-tr,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-td,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-th {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
}
/* [GOAL FULL-SWEEP] InstUI emotion view spans (css-XXX-view*) MUST stay
   transparent — handled in the artifactReset block below. Keeping a
   foreground-color-only rule here so text inside them stays themed. */
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="css-"][class*="view"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="css-"][class*="View"] {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .select2-container .select2-choice,
.${BODY_ROOT_CLASS} .ic-app-main-content .select2-container .select2-choices,
.${BODY_ROOT_CLASS} .ic-app-main-content .select2-drop,
.${BODY_ROOT_CLASS} .ic-app-main-content .select2-results,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Select__control,
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="select"][class*="control"],
.${BODY_ROOT_CLASS} .ic-app-main-content .input-group-addon,
.${BODY_ROOT_CLASS} .ic-app-main-content .input-group > span,
.${BODY_ROOT_CLASS} .ic-app-main-content .input-group > div,
.${BODY_ROOT_CLASS} .ic-app-main-content .input-prepend > span,
.${BODY_ROOT_CLASS} .ic-app-main-content .input-append > span,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input__prefix,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input__suffix,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input-wrapper,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input__container,
.${BODY_ROOT_CLASS} .ic-app-main-content .form-control-feedback,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput__input,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput__icon,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput span,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput i,
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Search"] span,
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="search"] span,
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Input"][class*="prefix"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Input"][class*="suffix"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Input"][class*="icon"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="input"][class*="icon"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="SearchInput"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Search"][class*="icon"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="search"][class*="icon"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Search"][class*="prefix"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="search"][class*="prefix"] {
  background: var(--cs-skin-surface2) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-container,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-condensed,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-expandable,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-header,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row__layout,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row__content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-info,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-group,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment_group,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .collectionViewItems,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module_item,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-item,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussionTopicIndexList .discussion-topic,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcements-v2__wrapper,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcements-v2__announcement,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussion-entry,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .entry-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .student-assignment-overview,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer__content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-padding,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer-button,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer-button--previous,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer-button--next,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #module_sequence_footer,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #module_navigation_target,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer .Button,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer .btn,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer a,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer button,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #assignments,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #assignment_show,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-index,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-list-body,
.${BODY_ROOT_CLASS} .ic-app-main-content :is(.item-group-container,.item-group-condensed,.item-group-expandable,.ig-list,.ig-header,.ig-row,.ig-row__layout,.ig-row__content,.ig-info,.assignment,.assignment-group,.assignment_group,.assignment-list,.collectionViewItems,.context_module,.context_module_item,.module-item,.discussion-entry,.entry-content,.student-assignment-overview,.module-sequence-footer,.module-sequence-footer-content,.module-sequence-footer__content,.module-sequence-padding,.module-sequence-footer-button,.module-sequence-footer-button--previous,.module-sequence-footer-button--next,.assignment-index,.assignment-list-body) {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row:nth-child(even),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module_item:nth-child(even),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment:nth-child(even) {
  background-color: var(--cs-skin-bg-soft) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row:hover,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module_item:hover,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment:hover,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussion-topic:hover {
  background-color: var(--cs-skin-surface2) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain :is(h1,h2,h3,h4,h5,h6,p,li,dt,dd,label,legend,th,td,div,span):not([class*="icon"]):not(.screenreader-only) {
  color: inherit;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain :is(h1,h2,h3,h4,h5,h6,strong,b,th,label,legend) {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain :is(p,li,dt,dd,td,small,.description,.subtitle,.muted,.ig-details,.ig-info,.ig-row__details) {
  color: var(--cs-skin-text-dim) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain a:not(.Button):not(.btn) {
  color: var(--cs-skin-link) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain a:not(.Button):not(.btn):hover {
  color: var(--cs-skin-accent) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content .enhanceable_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content .content-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content .pad-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content > div,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content section,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content table,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content thead,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content tbody,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content tr,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content td,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content th,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table td,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table tr,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table tbody {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content tr:nth-child(even) td {
  background-color: var(--cs-skin-bg-soft) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content th,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table th,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table thead,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table__header-row {
  background-color: transparent !important;
  color: var(--cs-skin-text) !important;
  border-bottom: 1px solid var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content img,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content svg,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content canvas,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content video,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain iframe {
  background-color: transparent !important;
}
/* Inside instructor-authored user_content, links keep their authored color
   (often blue) instead of being repainted to the theme accent. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content a:not(.Button):not(.btn) {
  color: revert !important;
  text-decoration: underline !important;
  text-decoration-thickness: 1px !important;
  text-underline-offset: 2px !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content a:not(.Button):not(.btn):hover {
  opacity: 0.82 !important;
}
/* JS-applied: elements with a computed dark background get white text so
   instructor-authored navy/dark panels stay readable. Selector is fully
   qualified to outweigh both the layout-contentMain header/paragraph color
   rules and any user_content revert. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .${BRIGHT_CONTENT_CLASS},
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .${BRIGHT_CONTENT_CLASS} :is(h1,h2,h3,h4,h5,h6,p,li,dt,dd,td,th,span,div,strong,b,em,i,label,legend,small,blockquote,a,ul,ol) {
  color: #ffffff !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .${BRIGHT_CONTENT_CLASS} a:not(.Button):not(.btn) {
  color: #ffffff !important;
  text-decoration: underline !important;
}
.${BODY_ROOT_CLASS} .ui-dialog,
.${BODY_ROOT_CLASS} .ui-dialog .ui-dialog-titlebar,
.${BODY_ROOT_CLASS} .ui-dialog .ui-dialog-content,
.${BODY_ROOT_CLASS} .ReactModal__Overlay,
.${BODY_ROOT_CLASS} .ReactModal__Content,
.${BODY_ROOT_CLASS} body > [class*="Tray"],
.${BODY_ROOT_CLASS} body > [class*="tray"],
.${BODY_ROOT_CLASS} body > [id*="Tray"],
.${BODY_ROOT_CLASS} body > [id*="tray"],
.${BODY_ROOT_CLASS} .ReactTray,
.${BODY_ROOT_CLASS} .ReactTrayPortal,
.${BODY_ROOT_CLASS} .ReactTray__Content,
.${BODY_ROOT_CLASS} .ReactTray__Overlay,
.${BODY_ROOT_CLASS} .tray-with-space-for-global-nav,
.${BODY_ROOT_CLASS} [class*="Tray__Content"],
.${BODY_ROOT_CLASS} [class*="tray__content"],
.${BODY_ROOT_CLASS} [role="dialog"]:not(#canvascope-slash-root),
.${BODY_ROOT_CLASS} [role="menu"],
.${BODY_ROOT_CLASS} [role="listbox"] {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} body > [class*="Tray"] a,
.${BODY_ROOT_CLASS} body > [class*="tray"] a,
.${BODY_ROOT_CLASS} .ReactTray a,
.${BODY_ROOT_CLASS} .ReactTrayPortal a,
.${BODY_ROOT_CLASS} .tray-with-space-for-global-nav a,
.${BODY_ROOT_CLASS} [role="dialog"]:not(#canvascope-slash-root) a,
.${BODY_ROOT_CLASS} [role="menu"] a,
.${BODY_ROOT_CLASS} [role="listbox"] a {
  color: var(--cs-skin-link) !important;
}
/* ── Modern polish: rounded surfaces, subtle elevation, refined typography ── */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-container,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-condensed,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-expandable,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-group,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcements-v2__wrapper,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .panel,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .well,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .show-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .page-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .wiki-page-body,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ui-widget-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain table.ic-Table,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .student-assignment-overview,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer {
  border-radius: var(--cs-skin-radius) !important;
  box-shadow: var(--cs-skin-shadow) !important;
  overflow: hidden !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module_item,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussion-topic,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussion-entry {
  transition: background-color 140ms ease, transform 120ms ease !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-header {
  border-bottom: 1px solid var(--cs-skin-border) !important;
  padding: 12px 16px !important;
  font-weight: 600 !important;
  letter-spacing: 0 !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain h1,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain h2,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain h3 {
  letter-spacing: 0 !important;
  font-weight: 600 !important;
}
.${BODY_ROOT_CLASS} .ui-dialog,
.${BODY_ROOT_CLASS} .ReactModal__Content,
.${BODY_ROOT_CLASS} [role="dialog"]:not(#canvascope-slash-root) {
  border-radius: var(--cs-skin-radius-lg) !important;
  box-shadow: var(--cs-skin-shadow-hi) !important;
  overflow: hidden !important;
}
.${BODY_ROOT_CLASS} body > [class*="Tray"],
.${BODY_ROOT_CLASS} body > [class*="tray"] {
  box-shadow: var(--cs-skin-shadow-hi) !important;
}
.${BODY_ROOT_CLASS} [role="menu"],
.${BODY_ROOT_CLASS} [role="listbox"] {
  border-radius: var(--cs-skin-radius) !important;
  box-shadow: var(--cs-skin-shadow-hi) !important;
  overflow: hidden !important;
}
.${BODY_ROOT_CLASS} .ic-Action-header,
.${BODY_ROOT_CLASS} .ic-page-header,
.${BODY_ROOT_CLASS} .${PAGE_TITLE_ROW_CLASS},
.${BODY_ROOT_CLASS} .${PAGE_TITLE_SHELL_CLASS} {
  border-radius: var(--cs-skin-radius) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain {
  scroll-behavior: smooth !important;
  font-feature-settings: "cv11", "ss01", "ss03" !important;
}
.${BODY_ROOT_CLASS} ::selection {
  background: color-mix(in srgb, var(--cs-skin-accent), transparent 70%) !important;
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} ::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}
.${BODY_ROOT_CLASS} ::-webkit-scrollbar-thumb {
  background: var(--cs-skin-border-hi);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: padding-box;
}
.${BODY_ROOT_CLASS} ::-webkit-scrollbar-thumb:hover {
  background: var(--cs-skin-muted);
  background-clip: padding-box;
  border: 3px solid transparent;
}
.${BODY_ROOT_CLASS} ::-webkit-scrollbar-track {
  background: transparent;
}
`;

    const darkExtras = mode === 'dark' ? `
.${BODY_ROOT_CLASS} {
  color-scheme: dark;
}
.${BODY_ROOT_CLASS} .ic-Action-header,
.${BODY_ROOT_CLASS} .ic-page-header,
.${BODY_ROOT_CLASS} .page-title,
.${BODY_ROOT_CLASS} #breadcrumbs,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs .ic-app-crumbs,
.${BODY_ROOT_CLASS} .ic-app-crumbs,
.${BODY_ROOT_CLASS} .ic-app-crumbs a,
.${BODY_ROOT_CLASS} .ic-app-crumbs span,
.${BODY_ROOT_CLASS} #dashboard_header_container,
.${BODY_ROOT_CLASS} #DashboardOptionsMenu_Container,
.${BODY_ROOT_CLASS} .ic-Dashboard-header,
.${BODY_ROOT_CLASS} .ic-Dashboard-header__layout,
.${BODY_ROOT_CLASS} .ic-dashboard-header,
.${BODY_ROOT_CLASS} .ic-dashboard-header__layout,
.${BODY_ROOT_CLASS} .${PAGE_TITLE_ROW_CLASS},
.${BODY_ROOT_CLASS} .${PAGE_TITLE_SHELL_CLASS} {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
  box-shadow: inset 0 -1px 0 var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs {
  background-color: var(--cs-skin-bg) !important;
}
.${BODY_ROOT_CLASS} #breadcrumbs,
.${BODY_ROOT_CLASS} .ic-app-crumbs,
.${BODY_ROOT_CLASS} .ic-app-crumbs a,
.${BODY_ROOT_CLASS} .ic-app-crumbs span {
  background: transparent !important;
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} #breadcrumbs *,
.${BODY_ROOT_CLASS} .ic-app-crumbs *,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs .ic-app-crumbs *,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs .ellipsible {
  background: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
  text-shadow: none !important;
}
.${BODY_ROOT_CLASS} #breadcrumbs a,
.${BODY_ROOT_CLASS} .ic-app-crumbs a,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs .ic-app-crumbs a {
  color: var(--cs-skin-link) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content h1:not(.ic-DashboardCard__header-title),
.${BODY_ROOT_CLASS} .ic-app-main-content [role="heading"][aria-level="1"],
.${BODY_ROOT_CLASS} .ic-Dashboard-header__title,
.${BODY_ROOT_CLASS} .ic-dashboard-header__title,
.${BODY_ROOT_CLASS} .${PAGE_TITLE_TEXT_CLASS} {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-Action-header :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .ic-page-header :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .page-title :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .ic-Dashboard-header :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .ic-dashboard-header :is(h1, h2, h3, span, button, i, svg),
.${BODY_ROOT_CLASS} .${PAGE_TITLE_ROW_CLASS} :is(h1, h2, h3, [role="heading"], span, button, i, svg),
.${BODY_ROOT_CLASS} .${PAGE_TITLE_SHELL_CLASS} :is(h1, h2, h3, [role="heading"], span, button, i, svg) {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard {
  background-color: var(--cs-skin-surface) !important;
  border: 0 !important;
  border-radius: var(--cs-skin-radius-lg) !important;
  box-shadow: var(--cs-skin-shadow) !important;
  overflow: hidden !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard:hover {
  box-shadow: var(--cs-skin-shadow-hi) !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container,
.${BODY_ROOT_CLASS} .ic-DashboardCard__box,
.${BODY_ROOT_CLASS} .ic-DashboardCard__box__container {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border: 0 !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content a,
.${BODY_ROOT_CLASS} .ic-DashboardCard__header-title,
.${BODY_ROOT_CLASS} .ic-DashboardCard__header-title a,
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content .ic-DashboardCard__header-title {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header-subtitle,
.${BODY_ROOT_CLASS} .ic-DashboardCard__term,
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content .subtitle,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container i,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container svg {
  color: var(--cs-skin-text-dim) !important;
}
.${BODY_ROOT_CLASS} #right-side-wrapper,
.${BODY_ROOT_CLASS} #right-side {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border: 0 !important;
  border-radius: var(--cs-skin-radius) !important;
  padding: 4px !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Sidebar__TodoListContainer,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .events_list,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .todo-list,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .panel,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .well,
.${BODY_ROOT_CLASS} #right-side .Sidebar,
.${BODY_ROOT_CLASS} #right-side .Sidebar__TodoListContainer,
.${BODY_ROOT_CLASS} #right-side .events_list,
.${BODY_ROOT_CLASS} #right-side .todo-list,
.${BODY_ROOT_CLASS} #right-side .panel,
.${BODY_ROOT_CLASS} #right-side .well {
  background-color: transparent !important;
  color: var(--cs-skin-text) !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary h2,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary h3,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary h4,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary p,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary li,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary span:not([class*="icon"]) {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a {
  color: var(--cs-skin-link) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a span {
  color: var(--cs-skin-link) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]),
.${BODY_ROOT_CLASS} .ic-app-main-content textarea,
.${BODY_ROOT_CLASS} .ic-app-main-content select {
  background-color: transparent !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content ::placeholder {
  color: var(--cs-skin-muted) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button,
.${BODY_ROOT_CLASS} .ic-app-main-content button.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content a.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn,
.${BODY_ROOT_CLASS} .ic-app-main-content button.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content a.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content .ui-button,
.${BODY_ROOT_CLASS} .ic-app-main-content .ViewAllLink,
.${BODY_ROOT_CLASS} .ic-app-main-content .Button--secondary,
.${BODY_ROOT_CLASS} .ic-app-main-content .Button--default,
.${BODY_ROOT_CLASS} .ic-app-main-content .Button--link {
  background: var(--cs-skin-surface2) !important;
  background-image: none !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
  box-shadow: none !important;
  text-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content button.Button:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content a.Button:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content button.btn:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content a.btn:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content .ui-button:hover {
  background: var(--cs-skin-surface) !important;
  border-color: var(--cs-skin-accent) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button--primary,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn-primary,
.${BODY_ROOT_CLASS} .ic-app-main-content button[type="submit"],
.${BODY_ROOT_CLASS} .ic-app-main-content .ui-button.ui-state-active {
  background: var(--cs-skin-accent) !important;
  color: var(--cs-skin-accent-text) !important;
  border-color: var(--cs-skin-accent) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .Button[disabled],
.${BODY_ROOT_CLASS} .ic-app-main-content .Button:disabled,
.${BODY_ROOT_CLASS} .ic-app-main-content .btn[disabled],
.${BODY_ROOT_CLASS} .ic-app-main-content .btn:disabled {
  background: color-mix(in srgb, var(--cs-skin-surface2), transparent 35%) !important;
  color: var(--cs-skin-muted) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} #section-tabs,
.${BODY_ROOT_CLASS} .ic-app-course-menu,
.${BODY_ROOT_CLASS} .ic-app-course-menu__content,
.${BODY_ROOT_CLASS} .ic-app-course-menu .section,
.${BODY_ROOT_CLASS} #section-tabs li,
.${BODY_ROOT_CLASS} #section-tabs li a {
  background: transparent !important;
  color: var(--cs-skin-link) !important;
  border-color: transparent !important;
}
.${BODY_ROOT_CLASS} #section-tabs li.section a.active,
.${BODY_ROOT_CLASS} #section-tabs li.section a:hover,
.${BODY_ROOT_CLASS} #section-tabs li a.active,
.${BODY_ROOT_CLASS} #section-tabs li a:hover,
.${BODY_ROOT_CLASS} .ic-app-course-menu a.active,
.${BODY_ROOT_CLASS} .ic-app-course-menu a:hover {
  background: var(--cs-skin-surface2) !important;
  color: var(--cs-skin-text) !important;
  border-left-color: var(--cs-skin-accent) !important;
  font-weight: 600 !important;
}
.${BODY_ROOT_CLASS} #section-tabs li a:not(.active):not(:hover),
.${BODY_ROOT_CLASS} .ic-app-course-menu a:not(.active):not(:hover) {
  opacity: 0.92 !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content-box-mini,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .enhanced,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .pad-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .panel,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .well,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ui-widget-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ui-tabs-panel,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ReactModal__Content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .PageContent,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .course_home_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .course-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .wiki-page-body,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .show-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .page-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain table.ic-Table {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .header-bar,
.${BODY_ROOT_CLASS} .ic-app-main-content .toolbar,
.${BODY_ROOT_CLASS} .ic-app-main-content .sticky-toolbar,
.${BODY_ROOT_CLASS} .ic-app-main-content .search-bar,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Form-control,
.${BODY_ROOT_CLASS} .ic-app-main-content .form-actions,
.${BODY_ROOT_CLASS} .ic-app-main-content .form-dialog-content,
.${BODY_ROOT_CLASS} .ic-app-main-content .controls,
.${BODY_ROOT_CLASS} .ic-app-main-content .control-group,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Action-header__Secondary,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-thead,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-tbody,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-tr,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-td,
.${BODY_ROOT_CLASS} .ic-app-main-content .ReactTable .rt-th,
.${BODY_ROOT_CLASS} .ic-app-main-content .css-1y7npps-view,
.${BODY_ROOT_CLASS} .ic-app-main-content .css-1w7r6qz-view {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .select2-container .select2-choice,
.${BODY_ROOT_CLASS} .ic-app-main-content .select2-container .select2-choices,
.${BODY_ROOT_CLASS} .ic-app-main-content .select2-drop,
.${BODY_ROOT_CLASS} .ic-app-main-content .select2-results,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Select__control,
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="select"][class*="control"] {
  background: var(--cs-skin-surface2) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content .input-group-addon,
.${BODY_ROOT_CLASS} .ic-app-main-content .input-group > span,
.${BODY_ROOT_CLASS} .ic-app-main-content .input-group > div,
.${BODY_ROOT_CLASS} .ic-app-main-content .input-prepend > span,
.${BODY_ROOT_CLASS} .ic-app-main-content .input-append > span,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input__prefix,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input__suffix,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input-wrapper,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-Input__container,
.${BODY_ROOT_CLASS} .ic-app-main-content .form-control-feedback,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput__input,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput__icon,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput span,
.${BODY_ROOT_CLASS} .ic-app-main-content .ic-SearchInput i,
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Search"] span,
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="search"] span,
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Input"][class*="prefix"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Input"][class*="suffix"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Input"][class*="icon"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="input"][class*="icon"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="SearchInput"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Search"][class*="icon"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="search"][class*="icon"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="Search"][class*="prefix"],
.${BODY_ROOT_CLASS} .ic-app-main-content [class*="search"][class*="prefix"] {
  background: var(--cs-skin-surface2) !important;
  color: var(--cs-skin-text-dim) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content [style*="background: white"]:not(img):not(svg):not(canvas):not(video),
.${BODY_ROOT_CLASS} .ic-app-main-content [style*="background-color: white"]:not(img):not(svg):not(canvas):not(video),
.${BODY_ROOT_CLASS} .ic-app-main-content [style*="background:#fff"]:not(img):not(svg):not(canvas):not(video),
.${BODY_ROOT_CLASS} .ic-app-main-content [style*="background-color:#fff"]:not(img):not(svg):not(canvas):not(video),
.${BODY_ROOT_CLASS} .ic-app-main-content [style*="background: #fff"]:not(img):not(svg):not(canvas):not(video),
.${BODY_ROOT_CLASS} .ic-app-main-content [style*="background-color: #fff"]:not(img):not(svg):not(canvas):not(video),
.${BODY_ROOT_CLASS} .ic-app-main-content [style*="background: rgb(255"]:not(img):not(svg):not(canvas):not(video),
.${BODY_ROOT_CLASS} .ic-app-main-content [style*="background-color: rgb(255"]:not(img):not(svg):not(canvas):not(video) {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .${DARK_SURFACE_CLASS} {
  background: var(--cs-skin-surface) !important;
  background-color: var(--cs-skin-surface) !important;
  background-image: none !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
  box-shadow: none !important;
  text-shadow: none !important;
}
.${BODY_ROOT_CLASS} .${DARK_SURFACE_CLASS}:is(input, textarea, select),
.${BODY_ROOT_CLASS} .${DARK_SURFACE_CLASS} :is(input, textarea, select) {
  background: var(--cs-skin-surface2) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} .${DARK_SURFACE_CLASS}:is(button, .Button, .btn, .ui-button, a.Button, a.btn),
.${BODY_ROOT_CLASS} .${DARK_SURFACE_CLASS} :is(button, .Button, .btn, .ui-button, a.Button, a.btn) {
  background: var(--cs-skin-surface2) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} .${DARK_SURFACE_CLASS} :is(h1,h2,h3,h4,h5,h6,strong,b,label,legend,th) {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .${DARK_SURFACE_CLASS} :is(p,li,dt,dd,td,small,span,div):not([class*="icon"]):not(.screenreader-only) {
  color: var(--cs-skin-text-dim) !important;
}
.${BODY_ROOT_CLASS} .${DARK_SURFACE_CLASS} a:not(.Button):not(.btn) {
  color: var(--cs-skin-link) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-container,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-condensed,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-expandable,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-header,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row__layout,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row__content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-info,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-group,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment_group,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .collectionViewItems,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module_item,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-item,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussionTopicIndexList .discussion-topic,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcements-v2__wrapper,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcements-v2__announcement,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussion-entry,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .entry-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .student-assignment-overview,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer__content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-padding,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer-button,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer-button--previous,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer-button--next,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #module_sequence_footer,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #module_navigation_target,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer .Button,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer .btn,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer a,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer button,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #assignments,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #assignment_show,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-index,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-list-body {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content :is(.item-group-container,.item-group-condensed,.item-group-expandable,.ig-list,.ig-header,.ig-row,.ig-row__layout,.ig-row__content,.ig-info,.assignment,.assignment-group,.assignment_group,.assignment-list,.collectionViewItems,.context_module,.context_module_item,.module-item,.discussion-entry,.entry-content,.student-assignment-overview,.module-sequence-footer,.module-sequence-footer-content,.module-sequence-footer__content,.module-sequence-padding,.module-sequence-footer-button,.module-sequence-footer-button--previous,.module-sequence-footer-button--next,.assignment-index,.assignment-list-body) {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row:nth-child(even),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module_item:nth-child(even),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment:nth-child(even) {
  background-color: var(--cs-skin-bg-soft) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row:hover,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module_item:hover,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment:hover,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussion-topic:hover {
  background-color: var(--cs-skin-surface2) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain :is(h1,h2,h3,h4,h5,h6,p,li,dt,dd,label,legend,th,td,div,span):not([class*="icon"]):not(.screenreader-only) {
  color: inherit;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain :is(h1,h2,h3,h4,h5,h6,strong,b,th,label,legend) {
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain :is(p,li,dt,dd,td,small,.description,.subtitle,.muted,.ig-details,.ig-info,.ig-row__details) {
  color: var(--cs-skin-text-dim) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain a:not(.Button):not(.btn) {
  color: var(--cs-skin-link) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain a:not(.Button):not(.btn):hover {
  color: var(--cs-skin-accent) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content .enhanceable_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content .content-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content .pad-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content > div,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content section {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content [style*="background: white"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content [style*="background-color: white"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content [style*="background:#fff"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content [style*="background-color:#fff"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content [style*="background: #fff"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content [style*="background-color: #fff"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content [style*="background: rgb(255"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content [style*="background-color: rgb(255"] {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content table,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content thead,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content tbody,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content tr,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content td,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content th {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content tr:nth-child(even) td {
  background-color: var(--cs-skin-bg-soft) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content th {
  background-color: var(--cs-skin-surface2) !important;
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content img,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content svg,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content canvas,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content video,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain iframe {
  background-color: transparent !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table th,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table thead,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table__header-row {
  background-color: var(--cs-skin-surface2) !important;
  color: var(--cs-skin-text) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table td,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table tr,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Table tbody {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text-dim) !important;
  border-color: var(--cs-skin-border) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Sidebar,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary button.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary button.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .button-sidebar-wide,
.${BODY_ROOT_CLASS} #right-side .Button,
.${BODY_ROOT_CLASS} #right-side a.Button,
.${BODY_ROOT_CLASS} #right-side button.Button,
.${BODY_ROOT_CLASS} #right-side .btn,
.${BODY_ROOT_CLASS} #right-side a.btn,
.${BODY_ROOT_CLASS} #right-side button.btn,
.${BODY_ROOT_CLASS} #right-side .button-sidebar-wide {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary button.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary button.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .button-sidebar-wide,
.${BODY_ROOT_CLASS} #right-side .Button,
.${BODY_ROOT_CLASS} #right-side a.Button,
.${BODY_ROOT_CLASS} #right-side button.Button,
.${BODY_ROOT_CLASS} #right-side .btn,
.${BODY_ROOT_CLASS} #right-side a.btn,
.${BODY_ROOT_CLASS} #right-side button.btn,
.${BODY_ROOT_CLASS} #right-side .button-sidebar-wide {
  background: var(--cs-skin-surface2) !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Button:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .btn:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .button-sidebar-wide:hover,
.${BODY_ROOT_CLASS} #right-side .Button:hover,
.${BODY_ROOT_CLASS} #right-side .btn:hover,
.${BODY_ROOT_CLASS} #right-side .button-sidebar-wide:hover {
  background: var(--cs-skin-surface) !important;
  border-color: var(--cs-skin-accent) !important;
}
.${BODY_ROOT_CLASS} .ui-dialog,
.${BODY_ROOT_CLASS} .ui-dialog .ui-dialog-titlebar,
.${BODY_ROOT_CLASS} .ui-dialog .ui-dialog-content,
.${BODY_ROOT_CLASS} .ReactModal__Overlay,
.${BODY_ROOT_CLASS} .ReactModal__Content {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} body > [class*="Tray"],
.${BODY_ROOT_CLASS} body > [class*="tray"],
.${BODY_ROOT_CLASS} body > [id*="Tray"],
.${BODY_ROOT_CLASS} body > [id*="tray"],
.${BODY_ROOT_CLASS} .ReactTray,
.${BODY_ROOT_CLASS} .ReactTrayPortal,
.${BODY_ROOT_CLASS} .ReactTray__Content,
.${BODY_ROOT_CLASS} .ReactTray__Overlay,
.${BODY_ROOT_CLASS} .tray-with-space-for-global-nav,
.${BODY_ROOT_CLASS} [class*="Tray__Content"],
.${BODY_ROOT_CLASS} [class*="tray__content"],
.${BODY_ROOT_CLASS} [role="dialog"]:not(#canvascope-slash-root),
.${BODY_ROOT_CLASS} [role="menu"],
.${BODY_ROOT_CLASS} [role="listbox"] {
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border-color: var(--cs-skin-border-hi) !important;
}
.${BODY_ROOT_CLASS} body > [class*="Tray"] a,
.${BODY_ROOT_CLASS} body > [class*="tray"] a,
.${BODY_ROOT_CLASS} .ReactTray a,
.${BODY_ROOT_CLASS} .ReactTrayPortal a,
.${BODY_ROOT_CLASS} .tray-with-space-for-global-nav a,
.${BODY_ROOT_CLASS} [role="dialog"]:not(#canvascope-slash-root) a,
.${BODY_ROOT_CLASS} [role="menu"] a,
.${BODY_ROOT_CLASS} [role="listbox"] a {
  color: var(--cs-skin-link) !important;
}
` : '';

    const chromeRules = `
/* ── Canvas chrome: keep the far-left global nav and course nav on-theme ── */
.${BODY_ROOT_CLASS} .ic-app-header,
.${BODY_ROOT_CLASS} #global_nav,
.${BODY_ROOT_CLASS} #left-side,
.${BODY_ROOT_CLASS} .ic-app-header__main-navigation,
.${BODY_ROOT_CLASS} .ic-app-header__menu-list {
  background: var(--cs-skin-bg) !important;
  background-color: var(--cs-skin-bg) !important;
  color: var(--cs-skin-text) !important;
  border-color: transparent !important;
  box-shadow: none !important;
  text-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-header a:not(.ic-app-header__logomark),
.${BODY_ROOT_CLASS} .ic-app-header button,
.${BODY_ROOT_CLASS} #global_nav a:not(.ic-app-header__logomark),
.${BODY_ROOT_CLASS} #global_nav button {
  background: transparent !important;
  background-color: transparent !important;
  color: var(--cs-skin-text-dim) !important;
  border: 0 !important;
  box-shadow: none !important;
  text-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-header a:not(.ic-app-header__logomark):hover,
.${BODY_ROOT_CLASS} .ic-app-header button:hover,
.${BODY_ROOT_CLASS} #global_nav a:not(.ic-app-header__logomark):hover,
.${BODY_ROOT_CLASS} #global_nav button:hover,
.${BODY_ROOT_CLASS} .ic-app-header a:not(.ic-app-header__logomark):focus-visible,
.${BODY_ROOT_CLASS} .ic-app-header button:focus-visible,
.${BODY_ROOT_CLASS} #global_nav a:not(.ic-app-header__logomark):focus-visible,
.${BODY_ROOT_CLASS} #global_nav button:focus-visible {
  background: color-mix(in srgb, var(--cs-skin-accent), transparent 84%) !important;
  color: var(--cs-skin-text) !important;
  outline: none !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-header a[aria-current="page"],
.${BODY_ROOT_CLASS} .ic-app-header .ic-app-header__menu-list-link--active,
.${BODY_ROOT_CLASS} .ic-app-header .active > a,
.${BODY_ROOT_CLASS} .ic-app-header a.active,
.${BODY_ROOT_CLASS} #global_nav a[aria-current="page"],
.${BODY_ROOT_CLASS} #global_nav .ic-app-header__menu-list-link--active,
.${BODY_ROOT_CLASS} #global_nav .active > a,
.${BODY_ROOT_CLASS} #global_nav a.active {
  background: var(--cs-skin-surface) !important;
  background-color: var(--cs-skin-surface) !important;
  color: var(--cs-skin-text) !important;
  border: 0 !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-header .ic-avatar,
.${BODY_ROOT_CLASS} .ic-app-header .ic-avatar img,
.${BODY_ROOT_CLASS} #global_nav .ic-avatar,
.${BODY_ROOT_CLASS} #global_nav .ic-avatar img {
  border: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
  background-color: transparent !important;
}
.${BODY_ROOT_CLASS} .ic-app-header :is(svg, i, .menu-item-icon-container, .menu-item__text, .ic-icon-svg),
.${BODY_ROOT_CLASS} #global_nav :is(svg, i, .menu-item-icon-container, .menu-item__text, .ic-icon-svg) {
  color: inherit !important;
  fill: currentColor !important;
  stroke: currentColor !important;
  text-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-header__logomark,
.${BODY_ROOT_CLASS} .ic-app-header__logomark-container,
.${BODY_ROOT_CLASS} #global_nav .ic-app-header__logomark,
.${BODY_ROOT_CLASS} #global_nav .ic-app-header__logomark-container {
  color: var(--cs-skin-accent) !important;
  background-color: transparent !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-header__logomark-container,
.${BODY_ROOT_CLASS} #global_nav .ic-app-header__logomark-container,
.${BODY_ROOT_CLASS} .ic-app-header__logomark,
.${BODY_ROOT_CLASS} #global_nav .ic-app-header__logomark {
  background-color: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  filter: none !important;
}
.${BODY_ROOT_CLASS} .ic-app-header__logomark-container img,
.${BODY_ROOT_CLASS} #global_nav .ic-app-header__logomark-container img,
.${BODY_ROOT_CLASS} .ic-app-header__logomark-container svg,
.${BODY_ROOT_CLASS} #global_nav .ic-app-header__logomark-container svg {
  filter: none !important;
}
`;

    const artifactResetRules = `
/* ── Artifact reset: themes should recolor Canvas, not draw extra guide lines ── */
.${BODY_ROOT_CLASS} .ic-Action-header,
.${BODY_ROOT_CLASS} .ic-page-header,
.${BODY_ROOT_CLASS} .page-title,
.${BODY_ROOT_CLASS} #breadcrumbs,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs,
.${BODY_ROOT_CLASS} .ic-app-nav-toggle-and-crumbs .ic-app-crumbs,
.${BODY_ROOT_CLASS} .ic-app-crumbs,
.${BODY_ROOT_CLASS} #dashboard_header_container,
.${BODY_ROOT_CLASS} #DashboardOptionsMenu_Container,
.${BODY_ROOT_CLASS} .ic-Dashboard-header,
.${BODY_ROOT_CLASS} .ic-Dashboard-header__layout,
.${BODY_ROOT_CLASS} .ic-dashboard-header,
.${BODY_ROOT_CLASS} .ic-dashboard-header__layout,
.${BODY_ROOT_CLASS} .${PAGE_TITLE_ROW_CLASS},
.${BODY_ROOT_CLASS} .${PAGE_TITLE_SHELL_CLASS} {
  background: var(--cs-skin-bg) !important;
  background-color: var(--cs-skin-bg) !important;
  border-width: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-Action-header,
.${BODY_ROOT_CLASS} .ic-page-header,
.${BODY_ROOT_CLASS} .page-title,
.${BODY_ROOT_CLASS} .${PAGE_TITLE_ROW_CLASS},
.${BODY_ROOT_CLASS} .${PAGE_TITLE_SHELL_CLASS} {
  border-radius: 0 !important;
}
.${BODY_ROOT_CLASS} .ic-app-main-content h1:not(.ic-DashboardCard__header-title),
.${BODY_ROOT_CLASS} .ic-app-main-content [role="heading"][aria-level="1"],
.${BODY_ROOT_CLASS} .ic-Dashboard-header__title,
.${BODY_ROOT_CLASS} .ic-dashboard-header__title,
.${BODY_ROOT_CLASS} .${PAGE_TITLE_TEXT_CLASS} {
  background: transparent !important;
  background-color: transparent !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} #right-side-wrapper,
.${BODY_ROOT_CLASS} #right-side,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary {
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} #right-side-wrapper,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary {
  background: transparent !important;
  background-color: transparent !important;
  padding: 0 !important;
}
.${BODY_ROOT_CLASS} #right-side {
  background: var(--cs-skin-bg) !important;
  background-color: var(--cs-skin-bg) !important;
}
.${BODY_ROOT_CLASS} #right-side :is(h2,h3,h4,ul,ol,li,div,section,article),
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary :is(h2,h3,h4,ul,ol,li,div,section,article) {
  border-width: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} #right-side hr,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary hr {
  border-color: transparent !important;
  background: transparent !important;
}
.${BODY_ROOT_CLASS} #section-tabs,
.${BODY_ROOT_CLASS} .ic-app-course-menu,
.${BODY_ROOT_CLASS} .ic-app-course-menu__content,
.${BODY_ROOT_CLASS} .ic-app-course-menu .section,
.${BODY_ROOT_CLASS} #section-tabs li,
.${BODY_ROOT_CLASS} #section-tabs li a,
.${BODY_ROOT_CLASS} .ic-app-course-menu a {
  border: 0 !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} #section-tabs li.section a.active,
.${BODY_ROOT_CLASS} #section-tabs li.section a:hover,
.${BODY_ROOT_CLASS} #section-tabs li a.active,
.${BODY_ROOT_CLASS} #section-tabs li a:hover,
.${BODY_ROOT_CLASS} .ic-app-course-menu a.active,
.${BODY_ROOT_CLASS} .ic-app-course-menu a:hover {
  border: 0 !important;
  border-left-color: transparent !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .content-box-mini,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .enhanced,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .pad-box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .panel,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .well,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ui-widget-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ui-tabs-panel,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .PageContent,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .course_home_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .course-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .wiki-page-body,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .show-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .page-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .student-assignment-overview,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-container,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-condensed,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-expandable,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment-group,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcements-v2__wrapper {
  box-shadow: none !important;
}

/* -- Final visual cleanup: kill every stray sidebar/dashboard border -- */
.${BODY_ROOT_CLASS} #right-side,
.${BODY_ROOT_CLASS} #right-side-wrapper,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary,
.${BODY_ROOT_CLASS} #right-side > *,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary > * {
  background: transparent !important;
  background-color: transparent !important;
}
.${BODY_ROOT_CLASS} #right-side *:not(input):not(textarea):not(select):not(.ic-app-header__logomark),
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary *:not(input):not(textarea):not(select):not(.ic-app-header__logomark) {
  border-color: transparent !important;
  box-shadow: none !important;
}
.${BODY_ROOT_CLASS} #right-side hr,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary hr {
  display: none !important;
}
.${BODY_ROOT_CLASS} #right-side .Button,
.${BODY_ROOT_CLASS} #right-side a.Button,
.${BODY_ROOT_CLASS} #right-side button.Button,
.${BODY_ROOT_CLASS} #right-side .btn,
.${BODY_ROOT_CLASS} #right-side a.btn,
.${BODY_ROOT_CLASS} #right-side button.btn,
.${BODY_ROOT_CLASS} #right-side .button-sidebar-wide,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary button.Button,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary a.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary button.btn,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .button-sidebar-wide {
  border: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
  background-color: color-mix(in srgb, var(--cs-skin-surface), var(--cs-skin-text) 6%) !important;
}
.${BODY_ROOT_CLASS} #right-side .Button:hover,
.${BODY_ROOT_CLASS} #right-side .btn:hover,
.${BODY_ROOT_CLASS} #right-side .button-sidebar-wide:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .Button:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .btn:hover,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .button-sidebar-wide:hover {
  background-color: color-mix(in srgb, var(--cs-skin-surface), var(--cs-skin-text) 14%) !important;
  border: 0 !important;
  border-color: transparent !important;
}
.${BODY_ROOT_CLASS} .Sidebar__TodoListContainer .ToDoSidebar-Item,
.${BODY_ROOT_CLASS} .Sidebar__TodoListContainer li,
.${BODY_ROOT_CLASS} #right-side .events_list li,
.${BODY_ROOT_CLASS} #right-side .todo-list li,
.${BODY_ROOT_CLASS} #right-side ul li,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary ul li {
  border: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
  outline: none !important;
}

/* -- Card contrast boost: lift cards above the page background -- */
.${BODY_ROOT_CLASS} .ic-DashboardCard {
  background-color: color-mix(in srgb, var(--cs-skin-surface), var(--cs-skin-text) 6%) !important;
  border: 0 !important;
  border-color: transparent !important;
  box-shadow: 0 1px 2px rgba(0,0,0,0.08), 0 6px 16px rgba(0,0,0,0.18) !important;
}
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-DashboardCard {
  background-color: #23272f !important;
  box-shadow: 0 2px 6px rgba(0,0,0,0.60), 0 16px 40px rgba(0,0,0,0.65) !important;
}
/* Lighten the colored top stripes in dark themes — soft white wash so the
   brand colors read as light/pastel (pink → light pink, green → light green,
   navy → light blue) while remaining saturated, not washed out. */
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-DashboardCard__header_hero {
  background-image: linear-gradient(rgba(255,255,255,0.28), rgba(255,255,255,0.28)) !important;
}

/* Notification badges (unread_count) — Canvas paints them on a dark-navy pill,
   but the inner number inherits .ic-Layout-contentMain link color (brown in
   paper, etc.) which gives dark-on-dark. Force white text everywhere. */
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-badge,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-badge .unread_count,
.${BODY_ROOT_CLASS} .ic-DashboardCard .unread_count,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-DashboardCard .unread_count,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-DashboardCard__action-badge .unread_count {
  color: #ffffff !important;
  -webkit-text-fill-color: #ffffff !important;
  font-weight: 700 !important;
}

/* -- Course page panel cleanup: Canvas paints many sub-containers with a
      slightly lighter bg ("near-white" cream) that on Paper/Solarized shows
      as a visible inset panel. Force every common inner container to use
      the page bg. -- */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .show-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .user_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .clearfix.user_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .wiki-page-body,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #wiki_page_show,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #course_home_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .course_home_content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .home_courses_announcements,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-announcement-row,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-announcement-row__content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-announcement-row__avatar,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcement-row,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-header,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row__layout,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-empty-msg,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-container,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .item-group-condensed,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .collectionViewItems,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .pages-list-item,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussion,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussion-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussions-container,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussions-container__wrapper,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .events_list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .events-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grade,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grade_summary {
  background: transparent !important;
  background-color: transparent !important;
  border: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
}
/* Alternating-row backgrounds on lists (announcements/assignments/modules):
   zebra-striping looks like extra panels on themed bgs — kill it. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row:nth-child(even),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-row:nth-child(odd),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module_item:nth-child(even),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .context_module_item:nth-child(odd),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment:nth-child(even),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment:nth-child(odd),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-announcement-row:nth-child(even),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-announcement-row:nth-child(odd) {
  background: transparent !important;
  background-color: transparent !important;
}
/* Dashed/dotted empty-state borders — visible on Paper as cream-on-cream. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="empty"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .empty-message,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .empty-list,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-empty,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-empty-msg {
  border: 0 !important;
  border-color: transparent !important;
  background: transparent !important;
  background-color: transparent !important;
}
/* "5/5 pts" highlight pill behind grade scores — Canvas uses a near-white
   pill that's visible on Paper. Strip background, keep just the text. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .score,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grade-summary__score,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .points_possible,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grade,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-info .ig-details,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-details__item,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-details__score {
  background: transparent !important;
  background-color: transparent !important;
}
/* Search input weird border on Paper: Canvas's input has a faint cream
   border that reads as a "weird box" on Paper. Normalize input chrome. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain input[type="search"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain input[type="text"] {
  background-color: transparent !important;
  border: 1px solid var(--cs-skin-border) !important;
  box-shadow: none !important;
}

/* -- Catch-all: every InstUI <View>-style wrapper (emotion class
      "css-XXX-view-*" / "css-XXX-textInput*" / "css-XXX-baseButton*") inside
      the main content area picks up a lighter cream bg from Canvas's default
      "surface" tokens. Force them transparent so the page bg shows through
      cleanly with no visible panels. -- */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="-textInput__facade"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="-baseButton__content"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcements-v2__wrapper,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcements-v2,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussions-v2__wrapper,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .quizzes-v2__wrapper,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .student_assignment_overview,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .gradebook,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grading_box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Action-header,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-Page-header,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .page-content,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grade-summary-content {
  background: transparent !important;
  background-color: transparent !important;
}

/* Score/grade highlight pills (the "5/5 pts" / "76/76 pts" highlighted
   number). Canvas renders the earned-points span with a beige/highlight bg
   that reads as a yellow box on Paper. Strip it. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-info .ig-details span,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grade,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .points_possible,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .score_value,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-DashboardCard__action-badge {
  background: transparent !important;
  background-color: transparent !important;
}

/* Grades / gradebook tables — Canvas's stock tables use zebra-stripe rows
   with a near-white bg that reads as visible bands on Paper. Strip table
   row backgrounds and use only subtle hover state. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain table,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain table tr,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain table tr:nth-child(even),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain table tr:nth-child(odd),
.${BODY_ROOT_CLASS} .ic-Layout-contentMain table td,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain table th,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grade_summary tr,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grade_summary td {
  background: transparent !important;
  background-color: transparent !important;
  border-color: color-mix(in srgb, var(--cs-skin-text), transparent 88%) !important;
}

/* "Previous" / "Next" navigation pill at the bottom of pages — Canvas's
   ".btn" class gives it a beige fill that doesn't match Paper. Match the
   surrounding theme. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer .btn,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer .Button,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .module-sequence-footer button,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain a.btn[href*="previous"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain a.btn[href*="next"] {
  background-color: transparent !important;
  background-image: none !important;
  border: 1px solid var(--cs-skin-border) !important;
  color: var(--cs-skin-text) !important;
  box-shadow: none !important;
}

/* Discussion empty-state dashed borders + "Recent Announcements" panel
   on the course home — both use lighter cream bg + visible dash borders. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussions-v2__container-image,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussions-v2__container,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .discussions-v2,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="discussions-v2__"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .home_courses_announcements,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .home_courses_announcements_box,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #home_courses_announcements,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .announcements-list-item,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .recent-activity-header {
  background: transparent !important;
  background-color: transparent !important;
  border: 0 !important;
  border-style: none !important;
  border-color: transparent !important;
  box-shadow: none !important;
}

/* Any dashed/dotted-border element inside main content — Canvas uses these
   for empty-state placeholders that look noisy on themed bg. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain *[style*="dashed"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain *[style*="dotted"] {
  border-style: solid !important;
  border-color: transparent !important;
}
/* Course title + subtitle + meta text on dark themes: force pure-white text so
   nothing inherits a tinted "rose"/"mauve" link color. The broad
   ".ic-Layout-contentMain a:not(.Button):not(.btn)" rule has specificity
   (0,4,1) so we need at least that to win. */
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-Layout-contentMain .ic-DashboardCard a.ic-DashboardCard__link,
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-Layout-contentMain .ic-DashboardCard .ic-DashboardCard__header_content a,
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-Layout-contentMain .ic-DashboardCard__header-title a,
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-Layout-contentMain .ic-DashboardCard a.ic-DashboardCard__link:hover,
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-Layout-contentMain .ic-DashboardCard a.ic-DashboardCard__link:focus,
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-DashboardCard .ic-DashboardCard__header-title,
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-DashboardCard .ic-DashboardCard__header_content .ic-DashboardCard__header-title,
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-DashboardCard .ic-DashboardCard__header-subtitle,
.${BODY_ROOT_CLASS}.${BODY_MODE_CLASS_PREFIX}dark .ic-DashboardCard .ic-DashboardCard__term {
  color: #ffffff !important;
  -webkit-text-fill-color: #ffffff !important;
}
/* Bump dashboard card title weight/size so it visually competes with subtitle. */
.${BODY_ROOT_CLASS} .ic-DashboardCard .ic-DashboardCard__header-title,
.${BODY_ROOT_CLASS} .ic-DashboardCard .ic-DashboardCard__header-title a,
.${BODY_ROOT_CLASS} .ic-DashboardCard a.ic-DashboardCard__link {
  font-size: 16px !important;
  font-weight: 700 !important;
  line-height: 1.3 !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container,
.${BODY_ROOT_CLASS} .ic-DashboardCard__box,
.${BODY_ROOT_CLASS} .ic-DashboardCard__box__container {
  background-color: transparent !important;
  border: 0 !important;
  border-color: transparent !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard:hover {
  transform: translateY(-2px) !important;
  box-shadow: 0 4px 8px rgba(0,0,0,0.18), 0 16px 36px rgba(0,0,0,0.30) !important;
  border: 0 !important;
}

/* -- [GOAL #2] Dashboard header text "weird border": force header containers
      to the same bg as the page so no panel strip shows behind "Dashboard". -- */
.${BODY_ROOT_CLASS} #dashboard_header_container,
.${BODY_ROOT_CLASS} .ic-Dashboard-header,
.${BODY_ROOT_CLASS} .ic-Dashboard-header__layout,
.${BODY_ROOT_CLASS} .ic-dashboard-header,
.${BODY_ROOT_CLASS} .ic-dashboard-header__layout,
.${BODY_ROOT_CLASS} #DashboardOptionsMenu_Container,
.${BODY_ROOT_CLASS} .ic-Action-header,
.${BODY_ROOT_CLASS} .ic-page-header,
.${BODY_ROOT_CLASS} .page-title {
  background: var(--cs-skin-bg) !important;
  background-color: var(--cs-skin-bg) !important;
  border: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
}

/* -- [GOAL #2 + #4] InstUI <View> wrappers (emotion classes like
      css-xxx-view-flex/flexItem/listItem) get an explicit lighter background
      that doesn't match the page. This causes the "weird border" strip behind
      "Dashboard" and the visible per-item rectangles around To-Do entries.
      Force them all transparent so they blend with the page bg. -- */
.${BODY_ROOT_CLASS} #dashboard_header_container [class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Dashboard-header [class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Dashboard-header__actions [class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Dashboard-header__layout [class*="-view-"],
.${BODY_ROOT_CLASS} .ic-dashboard-app [class*="-view-"],
.${BODY_ROOT_CLASS} #right-side [class*="-view-"],
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary [class*="-view-"],
.${BODY_ROOT_CLASS} #right-side [class*="-list-item"],
.${BODY_ROOT_CLASS} #right-side [class*="ListItem"],
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary [class*="-list-item"],
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary [class*="ListItem"] {
  background: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}
/* InstUI components sometimes render the surface on their inner button/grip
   element. Catch those too. */
.${BODY_ROOT_CLASS} #right-side button[class*="-view-"],
.${BODY_ROOT_CLASS} #right-side a[class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Dashboard-header__actions button[class*="-view-"] {
  background: transparent !important;
  background-color: transparent !important;
}

/* -- [GOAL #1] Course card action icons: kill the assignment-icon "white box"
      so all three icons blend with the card surface. Extra specificity needed
      because the broad ".ic-Layout-contentMain .assignments" rule above also
      matches the .assignments dashboard card icon. -- */
.${BODY_ROOT_CLASS} .ic-DashboardCard .ic-DashboardCard__action-container,
.${BODY_ROOT_CLASS} .ic-DashboardCard .ic-DashboardCard__action,
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container .ic-DashboardCard__action,
.${BODY_ROOT_CLASS} .ic-DashboardCard .ic-DashboardCard__action.announcements,
.${BODY_ROOT_CLASS} .ic-DashboardCard .ic-DashboardCard__action.discussions,
.${BODY_ROOT_CLASS} .ic-DashboardCard .ic-DashboardCard__action.assignments,
.${BODY_ROOT_CLASS} .ic-DashboardCard .ic-DashboardCard__action.files,
.${BODY_ROOT_CLASS} .ic-DashboardCard .ic-DashboardCard__action.todo,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-DashboardCard__action.assignments,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-DashboardCard .assignments {
  background: transparent !important;
  background-color: transparent !important;
  border: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
}

/* -- [GOAL #3] Logo "looks weird / doesn't match Paper": always-transparent
      backplate, no rounded box, no shadow. Canvas's actual Berkeley logo
      (a background-image on .ic-app-header__logomark) shows through directly,
      matching any theme bg including Paper. -- */
.${BODY_ROOT_CLASS} .ic-app-header__logomark,
.${BODY_ROOT_CLASS} #global_nav .ic-app-header__logomark {
  background-color: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  border-radius: 0 !important;
  padding: 0 !important;
}

/* -- [GOAL FULL-SWEEP] Aggressive panel removal — any element inside the
      main content with a lighter-cream bg, page-toolbar shell, sticky bar,
      InstUI heading wrapper, kl_wrapper (Kennedy Library widget), assignment
      detail wrapper, or "Due/Points/Submitting/Available" info pill needs
      to be transparent so it sits flat on the page bg. -- */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #assignment_show,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .assignment.content_underline_links,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain ul.student-assignment-overview,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .student-assignment-overview,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .student-assignment-overview li,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-info,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-details,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-title,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ig-type-icon,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grades_summary,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain #grades_summary,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grades_summary thead,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grades_summary thead tr,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .grades_summary thead th {
  background: transparent !important;
  background-color: transparent !important;
  border: 0 !important;
  border-color: transparent !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

/* InstUI radio-input "toggle" buttons (e.g. SHOW BY DATE / SHOW BY TYPE on the
   assignments page) — Canvas paints the active state with hardcoded green
   #03893d that clashes with Paper. Repaint with the theme accent. */
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="-radioInput__facade"],
.${BODY_ROOT_CLASS} [class*="-radioInput__facade"] {
  background-color: var(--cs-skin-accent) !important;
  color: var(--cs-skin-on-accent, #ffffff) !important;
  border-color: var(--cs-skin-accent) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain label:has(input[type="radio"]:checked) [class*="-radioInput__facade"],
.${BODY_ROOT_CLASS} label:has(input[type="radio"]:checked) [class*="-radioInput__facade"] {
  background-color: var(--cs-skin-accent) !important;
  color: var(--cs-skin-on-accent, #ffffff) !important;
}
.${BODY_ROOT_CLASS} .ic-Layout-contentMain section[class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain h1[class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain h2[class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain h3[class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain h4[class*="-view-"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="-view-heading"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="-view--block"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .sticky-toolbar,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .${PAGE_TITLE_SHELL_CLASS},
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .header-bar,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .page-toolbar,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="page-toolbar"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [class*="header-bar"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [id^="kl_wrapper"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain [id^="kl_section"],
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .kl_flat_sections,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .kl_wrapper,
.${BODY_ROOT_CLASS} .ic-Layout-contentMain .ic-app-main-content__primary {
  background: transparent !important;
  background-color: transparent !important;
  border: 0 !important;
  border-color: transparent !important;
  box-shadow: none !important;
}

/* -- [GOAL #5] Recent Feedback "gradient next to each item": Canvas paints
      a white-to-transparent linear-gradient on .event-details::after as a
      text-fade indicator. It reads as a glowing vertical stripe next to each
      Recent Feedback / To-Do entry. Hide it entirely. -- */
.${BODY_ROOT_CLASS} #right-side .event-details::after,
.${BODY_ROOT_CLASS} #right-side .event-details::before,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .event-details::after,
.${BODY_ROOT_CLASS} .ic-app-main-content__secondary .event-details::before,
.${BODY_ROOT_CLASS} #right-side [class*="-view-listItem"]::after,
.${BODY_ROOT_CLASS} #right-side [class*="-view-listItem"]::before {
  background: transparent !important;
  background-image: none !important;
  display: none !important;
  content: none !important;
}

/* -- Themed scrollbars: skinny + match palette. Applies to the global nav
      sidebar, the right-side panel, and any internal scroll containers. -- */
.${BODY_ROOT_CLASS} #global_nav,
.${BODY_ROOT_CLASS} #global_nav *,
.${BODY_ROOT_CLASS} #left-side,
.${BODY_ROOT_CLASS} #left-side *,
.${BODY_ROOT_CLASS} #right-side,
.${BODY_ROOT_CLASS} #right-side *,
.${BODY_ROOT_CLASS} .ic-app-main-content,
.${BODY_ROOT_CLASS} .ic-app-main-content *,
.${BODY_ROOT_CLASS} body,
.${BODY_ROOT_CLASS} html {
  scrollbar-width: thin !important;
  scrollbar-color: color-mix(in srgb, var(--cs-skin-text), transparent 70%) transparent !important;
}
.${BODY_ROOT_CLASS} *::-webkit-scrollbar {
  width: 6px !important;
  height: 6px !important;
  background: transparent !important;
}
.${BODY_ROOT_CLASS} *::-webkit-scrollbar-track {
  background: transparent !important;
  border: 0 !important;
}
.${BODY_ROOT_CLASS} *::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--cs-skin-text), transparent 75%) !important;
  border-radius: 6px !important;
  border: 0 !important;
}
.${BODY_ROOT_CLASS} *::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--cs-skin-text), transparent 55%) !important;
}
.${BODY_ROOT_CLASS} *::-webkit-scrollbar-corner {
  background: transparent !important;
}
`;

    ensureStyle(STYLE_RULES_ID).textContent = fontRule + bgRule + sharedSurfaceRules + darkExtras + chromeRules + artifactResetRules;
  }

  function cleanupPageTitleMarkers() {
    document.querySelectorAll(`.${PAGE_TITLE_ROW_CLASS}, .${PAGE_TITLE_SHELL_CLASS}, .${PAGE_TITLE_TEXT_CLASS}`).forEach(el => {
      el.classList.remove(PAGE_TITLE_ROW_CLASS, PAGE_TITLE_SHELL_CLASS, PAGE_TITLE_TEXT_CLASS);
    });
  }

  function isVisibleTitleCandidate(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('.ic-DashboardCard, .ic-app-header, #left-side, [aria-hidden="true"]')) return false;
    const text = (el.textContent || '').trim();
    if (!text) return false;
    const rect = el.getBoundingClientRect?.();
    return !!rect && rect.width > 20 && rect.height > 8;
  }

  function markPageTitleRows() {
    cleanupPageTitleMarkers();
    const candidates = Array.from(document.querySelectorAll([
      '.ic-app-main-content h1',
      '.ic-app-main-content [role="heading"][aria-level="1"]',
      '.ic-Layout-contentMain h1',
      '.ic-Layout-contentMain [role="heading"][aria-level="1"]',
      '#content h1',
      '#content [role="heading"][aria-level="1"]',
      '#main h1',
      '#main [role="heading"][aria-level="1"]'
    ].join(','))).filter(isVisibleTitleCandidate);

    for (const title of candidates) {
      title.classList.add(PAGE_TITLE_TEXT_CLASS);
      const titleRect = title.getBoundingClientRect();
      let row = title.closest('.ic-Action-header, .ic-page-header, .page-title, header, section, div') || title.parentElement;
      if (row === title) row = title.parentElement;

      // Walk up a couple of shallow ancestors and mark any compact title shells.
      // The dashboard title's white background often lives on a wrapper above
      // the H1, so styling only the text node leaves a white strip behind.
      let current = row;
      let depth = 0;
      while (current && depth < 4 && !current.matches('body, html, .ic-app-main-content, .ic-Layout-contentMain')) {
        if (!current.closest('.ic-DashboardCard')) {
          const r = current.getBoundingClientRect?.();
          if (r && r.width >= titleRect.width && r.height <= 180) {
            current.classList.add(depth === 0 ? PAGE_TITLE_ROW_CLASS : PAGE_TITLE_SHELL_CLASS);
          }
        }
        current = current.parentElement;
        depth += 1;
      }
    }
  }

  function renderCardRules() {
    if (!hasCardCustomizations()) {
      removeStyle(STYLE_CARDS_ID);
      return;
    }

    const density = skin.cardDensity || 'canvas';
    let densityCss = '';
    if (density === 'compact') {
      densityCss = `
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content {
  padding: 6px 10px !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_image,
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_hero {
  height: 88px !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container {
  min-height: 34px !important;
  padding: 4px 10px !important;
}
`;
    } else if (density === 'cozy') {
      densityCss = `
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content {
  padding: 10px 14px !important;
}
`;
    } else if (density === 'comfy') {
      densityCss = `
.${BODY_ROOT_CLASS} .ic-DashboardCard__header_content {
  padding: 16px 18px !important;
}
.${BODY_ROOT_CLASS} .ic-DashboardCard__action-container {
  min-height: 48px !important;
  padding: 8px 14px !important;
}
`;
    }

    let perCourseCss = '';
    for (const [courseId, color] of Object.entries(skin.cardColors || {})) {
      const safeId = String(courseId).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!safeId || !/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(color))) continue;
      const hex = String(color).startsWith('#') ? color : '#' + color;
      perCourseCss += `
.${BODY_ROOT_CLASS} .ic-DashboardCard[href*="/courses/${safeId}"] .ic-DashboardCard__header_hero,
.${BODY_ROOT_CLASS} a.ic-DashboardCard__link[href*="/courses/${safeId}"] + * .ic-DashboardCard__header_hero,
.${BODY_ROOT_CLASS} .ic-DashboardCard[data-cs-course-id="${safeId}"] .ic-DashboardCard__header_hero {
  background-color: ${hex} !important;
  ${skin.cardGradient ? `background-image: linear-gradient(135deg, ${hex}, ${shiftHue(hex, 35)}) !important;` : ''}
}
`;
    }

    const overlayCss = skin.cardOverlayDisabled
      ? `.${BODY_ROOT_CLASS} .ic-DashboardCard__header_hero { opacity: 1 !important; }
         .${BODY_ROOT_CLASS} .ic-DashboardCard__header_image::before { display: none !important; }`
      : '';

    ensureStyle(STYLE_CARDS_ID).textContent = [densityCss, perCourseCss, overlayCss].filter(Boolean).join('\n');
  }

  function renderSidebarRules() {
    const parts = [];
    if (skin.hideSidebarLogo) {
      parts.push(`.${BODY_ROOT_CLASS} .ic-app-header__logomark-container,
                  .${BODY_ROOT_CLASS} .ic-app-header__logomark { display: none !important; }`);
    }
    if (skin.hideSidebarHelp) {
      parts.push(`.${BODY_ROOT_CLASS} .ic-app-header__menu-list-item--help,
                  .${BODY_ROOT_CLASS} a[href="/help"] { display: none !important; }`);
    }
    if (skin.hideRecentFeedback) {
      parts.push(`.${BODY_ROOT_CLASS} .recent_feedback,
                  .${BODY_ROOT_CLASS} .Sidebar__RecentFeedback,
                  .${BODY_ROOT_CLASS} #recent_feedback { display: none !important; }`);
    }
    ensureStyle(STYLE_SIDEBAR_ID).textContent = parts.join('\n');
  }

  // -------------------------------------------------------------------------
  // WIDGET STYLES (grade pill, preview card) — injected once, independent of theme
  // -------------------------------------------------------------------------

  function renderWidgetStyles() {
    const css = `
.cs-skin-grade-pill {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(0,0,0,0.55);
  color: #fff;
  font-family: 'Geist Mono', ui-monospace, Menlo, monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  pointer-events: none;
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  backdrop-filter: blur(2px);
}
.cs-skin-preview {
  position: fixed;
  width: 440px;
  max-height: 340px;
  overflow: auto;
  background: var(--cs-skin-surface, #1c1b22);
  color: var(--cs-skin-text, #ece9f1);
  border: 1px solid var(--cs-skin-border-hi, rgba(255,255,255,0.10));
  border-radius: 12px;
  box-shadow: 0 18px 40px rgba(0,0,0,0.40);
  font-family: var(--cs-skin-fontfamily, 'Geist','Inter',system-ui,sans-serif);
  font-size: 13px;
  padding: 14px 16px;
  z-index: 2147483640;
  pointer-events: auto;
}
.cs-skin-preview__head {
  display: flex; align-items: baseline; gap: 8px;
  margin-bottom: 6px;
}
.cs-skin-preview__kind {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--cs-skin-accent, #a890e8);
  font-weight: 600;
}
.cs-skin-preview__title {
  font-weight: 600; color: var(--cs-skin-text, #ece9f1);
  flex: 1;
}
.cs-skin-preview__due {
  font-size: 11px; color: var(--cs-skin-text-dim, #b6b0c2);
  margin-bottom: 8px;
}
.cs-skin-preview__rank {
  font-size: 10px; color: var(--cs-skin-muted, #7c7689);
  font-family: 'Geist Mono', ui-monospace, monospace;
  margin-bottom: 8px;
}
.cs-skin-preview__body {
  font-size: 12px; line-height: 1.55;
  color: var(--cs-skin-text-dim, #b6b0c2);
}
.cs-skin-preview__body * { max-width: 100%; }
.cs-skin-preview__body a { color: var(--cs-skin-link, #a890e8); }
.cs-skin-preview__body img { max-width: 100%; height: auto; }
.ic-DashboardCard { position: relative; }
`;
    ensureStyle(STYLE_WIDGETS_ID).textContent = css;
  }

  // -------------------------------------------------------------------------
  // GRADE PILLS (injected onto dashboard cards)
  // -------------------------------------------------------------------------

  function renderGradePills() {
    if (!skin.showGradePills || !isCanvasDashboardRoute()) return;
    chrome.storage.local.get(['canvasGradesByCourse']).then(({ canvasGradesByCourse }) => {
      const grades = canvasGradesByCourse || {};
      document.querySelectorAll('.ic-DashboardCard').forEach(card => {
        const link = card.querySelector('a.ic-DashboardCard__link, a[href*="/courses/"]');
        if (!link) return;
        const m = link.getAttribute('href')?.match(/\/courses\/(\d+)/);
        if (!m) return;
        const courseId = m[1];
        card.setAttribute('data-cs-course-id', courseId);
        const grade = grades[courseId];
        let pill = card.querySelector('.cs-skin-grade-pill');
        if (!grade || !grade.current) {
          if (pill) pill.remove();
          return;
        }
        if (!pill) {
          pill = document.createElement('span');
          pill.className = 'cs-skin-grade-pill';
          card.appendChild(pill);
        }
        pill.textContent = `${grade.letter || ''} ${grade.current}%`.trim();
        pill.title = `As of ${new Date(grade.updatedAt || Date.now()).toLocaleString()}`;
      });
    }).catch(() => { /* ignore */ });
  }

  function removeGradePills() {
    document.querySelectorAll('.cs-skin-grade-pill').forEach(el => el.remove());
  }

  // -------------------------------------------------------------------------
  // CARD BACKGROUND IMAGES
  // -------------------------------------------------------------------------

  function renderCardBackgrounds() {
    if (!isCanvasDashboardRoute()) return;
    const bgs = skin.cardBackgrounds || {};
    document.querySelectorAll('.ic-DashboardCard').forEach(card => {
      const link = card.querySelector('a.ic-DashboardCard__link, a[href*="/courses/"]');
      const m = link?.getAttribute('href')?.match(/\/courses\/(\d+)/);
      if (!m) return;
      const courseId = m[1];
      const hero = card.querySelector('.ic-DashboardCard__header_image, .ic-DashboardCard__header_hero');
      if (!hero) return;
      const url = bgs[courseId];
      if (url && /^(data:image\/|https?:\/\/)/.test(url)) {
        hero.style.setProperty('background-image', `url("${url.replace(/"/g, '%22')}")`, 'important');
        hero.style.setProperty('background-size', 'cover', 'important');
        hero.style.setProperty('background-position', 'center', 'important');
      } else if (hero.style.backgroundImage?.startsWith('url(')) {
        // Only clear if we previously set it.
        if (hero.getAttribute('data-cs-skin-bg-set')) {
          hero.style.removeProperty('background-image');
          hero.removeAttribute('data-cs-skin-bg-set');
        }
      }
      if (url) hero.setAttribute('data-cs-skin-bg-set', '1');
    });
  }

  function restoreCardBackgrounds() {
    document.querySelectorAll('[data-cs-skin-bg-set]').forEach(hero => {
      hero.style.removeProperty('background-image');
      hero.style.removeProperty('background-size');
      hero.style.removeProperty('background-position');
      hero.removeAttribute('data-cs-skin-bg-set');
    });
  }

  // -------------------------------------------------------------------------
  // CARD LINK OVERRIDES
  // -------------------------------------------------------------------------

  function renderCardLinkOverrides() {
    if (!isCanvasDashboardRoute()) return;
    const overrides = skin.cardLinkOverrides || {};
    document.querySelectorAll('.ic-DashboardCard').forEach(card => {
      const link = card.querySelector('a.ic-DashboardCard__link, a[href*="/courses/"]');
      if (!link) return;
      const m = link.getAttribute('href')?.match(/\/courses\/(\d+)/);
      if (!m) return;
      const courseId = m[1];
      const target = overrides[courseId];
      if (!target) {
        const original = link.getAttribute('data-cs-skin-original-href');
        if (original) {
          link.setAttribute('href', original);
          link.removeAttribute('data-cs-skin-original-href');
        }
        return;
      }
      const suffix = {
        home: '',
        grades: '/grades',
        modules: '/modules',
        assignments: '/assignments',
        announcements: '/announcements',
        people: '/users',
        files: '/files'
      }[target] ?? '';
      const newHref = `/courses/${courseId}${suffix}`;
      if (!link.getAttribute('data-cs-skin-original-href')) {
        link.setAttribute('data-cs-skin-original-href', link.getAttribute('href') || '');
      }
      link.setAttribute('href', newHref);
    });
  }

  function restoreCardLinks() {
    document.querySelectorAll('[data-cs-skin-original-href]').forEach(link => {
      const original = link.getAttribute('data-cs-skin-original-href');
      if (original != null) link.setAttribute('href', original);
      link.removeAttribute('data-cs-skin-original-href');
    });
  }

  // -------------------------------------------------------------------------
  // DARK-MODE FIXER (white-island MutationObserver)
  // -------------------------------------------------------------------------

  function parseRgbColor(value) {
    const raw = String(value || '').trim();
    const m = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (!m) return null;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    const a = m[4] == null ? 1 : Number(m[4]);
    if (![r, g, b, a].every(Number.isFinite) || a <= 0.08) return null;
    return { r, g, b, a };
  }

  function isLightSurfaceColor(value) {
    const c = parseRgbColor(value);
    if (!c) return false;
    const avg = (c.r + c.g + c.b) / 3;
    return c.a > 0.2 && avg >= 228 && c.r >= 210 && c.g >= 210 && c.b >= 210;
  }

  function forEachDarkFixerScope(root, callback) {
    const start = root && root.nodeType === 1 ? root : document;
    const scopes = [];
    if (start.matches?.(DARK_FIXER_SCOPE_SELECTOR)) scopes.push(start);
    if (start.querySelectorAll) {
      start.querySelectorAll(DARK_FIXER_SCOPE_SELECTOR).forEach(el => scopes.push(el));
    }
    if (start === document && document.body) {
      scopes.push(document.body);
    } else if (start !== document && !scopes.length && start.closest?.('body')) {
      // Canvas puts trays, popovers, and some InstUI portals outside the main
      // content wrapper. When a newly-added portal is the mutation root, scan it
      // directly so white sheets (Groups/Courses trays, date pickers, menus) do
      // not escape the dark theme.
      scopes.push(start);
    }
    const seen = new Set();
    scopes.forEach(el => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      callback(el);
    });
  }

  function isSurfaceCandidate(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.classList?.contains(DARK_SURFACE_CLASS)) return false;
    if (isDarkFixerExempt(el)) return false;
    if (el.closest?.('.ic-app-header, #left-side, #global_nav, .tox, .CodeMirror, .cs-skin-preview')) return false;
    if (el.matches?.('img,svg,canvas,video,iframe,picture,source,path,use,br,hr,script,style,link,meta')) return false;
    const cs = window.getComputedStyle ? getComputedStyle(el) : null;
    if (!cs) return false;
    if (cs.display === 'inline' || cs.visibility === 'hidden') return false;
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && /url\(/i.test(cs.backgroundImage)) return false;
    const rect = el.getBoundingClientRect?.();
    if (!rect) return false;
    const compactControl = el.matches?.([
      'input', 'textarea', 'select', 'button',
      'a.Button', 'a.btn', '.Button', '.btn', '.ui-button',
      '.ic-Input', '.ic-Input-wrapper', '.ic-Input__container',
      '.input-group-addon', '.ic-Input__prefix', '.ic-Input__suffix',
      '.form-control-feedback',
      '.ic-SearchInput', '.ic-SearchInput__input', '.ic-SearchInput__icon',
      '[class*="Input"][class*="prefix"]', '[class*="Input"][class*="suffix"]',
      '[class*="Input"][class*="icon"]', '[class*="input"][class*="icon"]',
      '[class*="SearchInput"]',
      '[class*="Search"][class*="prefix"]', '[class*="search"][class*="prefix"]',
      '[class*="Search"][class*="icon"]', '[class*="search"][class*="icon"]'
    ].join(','));
    const smallFormChrome = !!el.closest?.([
      'form', '.ic-Form-control', '.control-group', '.controls',
      '.search-bar', '.header-bar', '.toolbar', '.sticky-toolbar',
      '.ic-SearchInput', '[class*="SearchInput"]'
    ].join(','));
    const minWidth = compactControl ? 18 : 56;
    if (rect.height < 18) return false;
    if (rect.width < minWidth && !(smallFormChrome && rect.width >= 12)) return false;
    return isLightSurfaceColor(cs.backgroundColor);
  }

  function markComputedLightSurfaces(root) {
    const selector = [
      'div', 'span', 'i', 'section', 'article', 'main', 'aside', 'nav',
      'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
      'form', 'fieldset', 'label', 'input', 'textarea', 'select',
      'button', 'a.Button', 'a.btn', '.Button', '.btn', '.ui-button',
      '.ic-Input', '.ic-Input-wrapper', '.ic-Input__container',
      '.input-group-addon', '.ic-Input__prefix', '.ic-Input__suffix',
      '.form-control-feedback',
      '.ic-SearchInput', '.ic-SearchInput__input', '.ic-SearchInput__icon',
      '[role="button"]', '[role="row"]', '[role="cell"]', '[role="listitem"]',
      '[class*="css-"][class*="view"]', '[class*="css-"][class*="View"]',
      '[class*="Input"][class*="prefix"]', '[class*="Input"][class*="suffix"]',
      '[class*="Input"][class*="icon"]', '[class*="input"][class*="icon"]',
      '[class*="SearchInput"]',
      '[class*="Search"][class*="prefix"]', '[class*="search"][class*="prefix"]',
      '[class*="Search"][class*="icon"]', '[class*="search"][class*="icon"]'
    ].join(',');

    forEachDarkFixerScope(root, fixerScope => {
      const candidates = [];
      if (fixerScope.matches?.(selector)) candidates.push(fixerScope);
      fixerScope.querySelectorAll?.(selector).forEach(el => candidates.push(el));
      candidates.forEach(el => {
        if (!isSurfaceCandidate(el)) return;
        el.classList.add(DARK_SURFACE_CLASS);
        el.setAttribute('data-cs-skin-computed-fixed', '1');
      });
    });
  }

  function fixWhiteIslands(root) {
    const scope = root && root.querySelectorAll ? root : document;
    cleanupDarkFixerExemptions(scope);
    // Inline style="background: white" / "background-color:#fff" etc.
    forEachDarkFixerScope(scope, fixerScope => {
      fixerScope.querySelectorAll('[style]').forEach(el => {
        if (isDarkFixerExempt(el)) return;
        const s = el.getAttribute('style') || '';
        if (/background(-color)?:\s*(#fff(?:fff)?|white|rgb\(255,\s*255,\s*255\))/i.test(s)) {
          if (!el.hasAttribute('data-cs-skin-original-style')) {
            el.setAttribute('data-cs-skin-original-style', s);
          }
          el.style.setProperty('background-color', 'var(--cs-skin-surface)', 'important');
          el.style.setProperty('color', 'var(--cs-skin-text)', 'important');
          el.setAttribute('data-cs-skin-fixed', 'inline');
        }
      });
    });
    // Discussion entries and embedded iframes commonly have hard-coded white.
    scope.querySelectorAll('.user_content, .discussion-entry, .entry-content').forEach(el => {
      if (isDarkFixerExempt(el)) return;
      el.style.setProperty('background-color', 'transparent', 'important');
      el.style.setProperty('color', 'var(--cs-skin-text)', 'important');
    });
    markComputedLightSurfaces(scope);
  }

  function isDarkFixerExempt(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest?.(DARK_FIXER_EXEMPT_SELECTOR)) return true;
    // The stylesheet themes page-title blocks deliberately. The mutation
    // fixer should not add inline colors there, because inline fixer styles
    // would fight later theme changes and resets.
    return !!el.querySelector?.(':scope > h1, :scope > .ic-Action-header, :scope > .ic-page-header');
  }

  function cleanupDarkFixerExemptions(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[data-cs-skin-fixed]').forEach(el => {
      if (!isDarkFixerExempt(el)) return;
      restoreDarkFixerElement(el);
    });
  }

  function restoreDarkFixerElement(el) {
    if (!el || el.nodeType !== 1) return;
    const original = el.getAttribute('data-cs-skin-original-style');
    if (original != null) {
      el.setAttribute('style', original);
    } else {
      el.style?.removeProperty('background-color');
      el.style?.removeProperty('color');
    }
    el.classList?.remove(DARK_SURFACE_CLASS);
    el.removeAttribute('data-cs-skin-fixed');
    el.removeAttribute('data-cs-skin-computed-fixed');
    el.removeAttribute('data-cs-skin-original-style');
  }

  function cleanupDarkFixerState(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(`[data-cs-skin-fixed], [data-cs-skin-computed-fixed], .${DARK_SURFACE_CLASS}`).forEach(restoreDarkFixerElement);
  }

  function startDarkFixer() {
    if (darkFixerObserver) return;
    fixWhiteIslands(document);
    darkFixerObserver = new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes && m.addedNodes.forEach(n => {
        if (n.nodeType === 1) fixWhiteIslands(n);
      }));
    });
    darkFixerObserver.observe(document.body || document.documentElement, {
      childList: true, subtree: true
    });
  }

  function stopDarkFixer() {
    if (darkFixerObserver) {
      darkFixerObserver.disconnect();
      darkFixerObserver = null;
    }
    cleanupDarkFixerState(document);
  }

  // -------------------------------------------------------------------------
  // ASSIGNMENT / ANNOUNCEMENT PREVIEW HOVER
  // -------------------------------------------------------------------------

  function ensurePreviewCard() {
    let card = document.getElementById(PREVIEW_CARD_ID);
    if (card) return card;
    card = document.createElement('div');
    card.id = PREVIEW_CARD_ID;
    card.className = 'cs-skin-preview';
    card.setAttribute('role', 'dialog');
    card.style.display = 'none';
    document.body.appendChild(card);
    return card;
  }

  function hidePreview() {
    const card = document.getElementById(PREVIEW_CARD_ID);
    if (card) card.style.display = 'none';
    activePreviewLink = null;
  }

  function classifyPreviewLink(href) {
    if (!href) return null;
    const url = (() => { try { return new URL(href, window.location.origin); } catch { return null; } })();
    if (!url) return null;
    const p = url.pathname;
    if (/\/assignments\/\d+/.test(p))     return 'assignment';
    if (/\/discussion_topics\/\d+/.test(p)) return 'announcement';
    if (/\/announcements\/\d+/.test(p))   return 'announcement';
    if (/\/quizzes\/\d+/.test(p))         return 'quiz';
    return null;
  }

  async function fetchPreview(href, kind) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREVIEW_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(href, { credentials: 'include', signal: controller.signal });
      if (!res.ok) throw new Error('Bad status ' + res.status);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const title = doc.querySelector('h1, .assignment-title, .discussion-title')?.textContent?.trim() || 'Untitled';
      const body = doc.querySelector('.user_content, .description, .discussion-section .message')?.innerHTML || '';
      const due = doc.querySelector('.assignment_dates, .due_at, .assignment-date-due')?.textContent?.trim() || '';
      return { kind, title, due, body: sanitizePreviewHtml(body) };
    } finally {
      clearTimeout(timer);
    }
  }

  function sanitizePreviewHtml(html) {
    // Conservative scrub: keep text/markup, drop scripts, iframes, on*= handlers.
    if (!html) return '';
    try {
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      wrap.querySelectorAll('script, iframe, object, embed, link, style').forEach(n => n.remove());
      wrap.querySelectorAll('*').forEach(n => {
        for (const a of Array.from(n.attributes)) {
          if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        }
      });
      // Truncate at ~2000 chars of text to keep the popup small.
      const text = wrap.textContent || '';
      if (text.length > 2200) {
        wrap.innerHTML = wrap.innerHTML.slice(0, 6000) + '…';
      }
      return wrap.innerHTML;
    } catch {
      return '';
    }
  }

  function showPreviewAt(linkEl, data) {
    const card = ensurePreviewCard();
    const kindBadge = ({ assignment: 'Assignment', announcement: 'Announcement', quiz: 'Quiz' })[data.kind] || 'Preview';
    const rankLine = skin.previewsShowRank
      ? `<div class="cs-skin-preview__rank" data-cs-preview-rank></div>`
      : '';
    card.innerHTML = `
      <div class="cs-skin-preview__head">
        <span class="cs-skin-preview__kind">${kindBadge}</span>
        <span class="cs-skin-preview__title">${escapeHtml(data.title)}</span>
      </div>
      ${data.due ? `<div class="cs-skin-preview__due">${escapeHtml(data.due)}</div>` : ''}
      ${rankLine}
      <div class="cs-skin-preview__body">${data.body || '<em>No description.</em>'}</div>
    `;
    const r = linkEl.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 360, Math.max(8, r.bottom + 8));
    const left = Math.min(window.innerWidth - 460, Math.max(8, r.left));
    card.style.top = top + 'px';
    card.style.left = left + 'px';
    card.style.display = 'block';

    if (skin.previewsShowRank) {
      annotatePreviewRank(linkEl, card);
    }
  }

  function annotatePreviewRank(linkEl, card) {
    try {
      const el = card.querySelector('[data-cs-preview-rank]');
      if (!el) return;
      const href = linkEl.getAttribute('href');
      chrome.runtime.sendMessage({ action: 'csSkin.lookupIndexRank', href })
        .then(res => {
          if (!res || !res.found) { el.style.display = 'none'; return; }
          el.textContent = `Indexed · ranked #${res.rank} for "${res.topQuery}"`;
        })
        .catch(() => { el.style.display = 'none'; });
    } catch { /* ignore */ }
  }

  function attachPreviewHandlers() {
    if (window.__canvascopeSkinPreviewAttached) return;
    window.__canvascopeSkinPreviewAttached = true;

    document.addEventListener('mouseover', e => {
      if (!skin.enabled || !skin.previewsEnabled) return;
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      const kind = classifyPreviewLink(href);
      if (!kind) return;
      activePreviewLink = a;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        if (activePreviewLink !== a) return;
        try {
          const data = await fetchPreview(href, kind);
          if (activePreviewLink === a) showPreviewAt(a, data);
        } catch { /* ignore */ }
      }, PREVIEW_DELAY_MS);
    }, true);

    document.addEventListener('mouseout', e => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      if (a === activePreviewLink) {
        clearTimeout(previewTimer);
        // Allow cursor to enter the preview card without closing immediately.
        setTimeout(() => {
          const card = document.getElementById(PREVIEW_CARD_ID);
          if (!card) return;
          if (!card.matches(':hover') && !a.matches(':hover')) hidePreview();
        }, 120);
      }
    }, true);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') hidePreview();
    });
  }

  // -------------------------------------------------------------------------
  // UTIL: hex hue shift for gradient mode
  // -------------------------------------------------------------------------

  function shiftHue(hex, degrees) {
    const m = String(hex).trim().replace('#', '');
    if (!/^([0-9a-f]{6}|[0-9a-f]{3})$/i.test(m)) return hex;
    const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
    const r = parseInt(full.slice(0, 2), 16) / 255;
    const g = parseInt(full.slice(2, 4), 16) / 255;
    const b = parseInt(full.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    h = (h + degrees / 360) % 1;
    if (h < 0) h += 1;
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const rr = Math.round(hue2rgb(p, q, h + 1/3) * 255);
    const gg = Math.round(hue2rgb(p, q, h) * 255);
    const bb = Math.round(hue2rgb(p, q, h - 1/3) * 255);
    return '#' + [rr, gg, bb].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // -------------------------------------------------------------------------
  // PUBLIC API
  // -------------------------------------------------------------------------

  async function applySkin(patch) {
    deepMerge(skin, patch || {});
    skin.__updatedAt = Date.now();
    await chrome.storage.local.set({ [SKIN_STORAGE_KEY]: skin });
    renderAll();
    // Best-effort push to Supabase via background; failures are silent.
    try { chrome.runtime.sendMessage({ action: 'csSkin.push', skin }); } catch { /* ignore */ }
    return skin;
  }

  function getSkin() {
    return JSON.parse(JSON.stringify(skin));
  }

  async function resetSkin() {
    skin = defaultSkinState();
    skin.__updatedAt = Date.now();
    await chrome.storage.local.set({ [SKIN_STORAGE_KEY]: skin });
    renderAll();
    return skin;
  }

  window.CanvascopeSkin = {
    apply: applySkin,
    get: getSkin,
    reset: resetSkin,
    listThemes: () => getThemes()?.listThemes() || [],
    listFonts:  () => getThemes()?.listFonts()  || []
  };

  // -------------------------------------------------------------------------
  // INITIALISATION
  // -------------------------------------------------------------------------

  function attachDomObserver() {
    if (domObserver) return;
    // Canvas SPAs swap parts of the DOM without page navigation. Re-render
    // grade pills and card overrides when major nodes change. Throttle to
    // avoid feedback loops.
    let pending = false;
    domObserver = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        markPageTitleRows();
        if (isCanvasDashboardRoute()) {
          renderGradePills();
          renderCardBackgrounds();
          renderCardLinkOverrides();
        }
      });
    });
    domObserver.observe(document.body || document.documentElement, {
      childList: true, subtree: true
    });
  }

  function attachSystemDarkListener() {
    try {
      systemDarkMQ = window.matchMedia('(prefers-color-scheme: dark)');
      systemDarkMQ.addEventListener('change', () => {
        if (skin.mode === 'system' || skin.followSystem) renderAll();
      });
    } catch { /* ignore */ }
  }

  function attachScheduledModeTicker() {
    if (scheduleAlarmTimer) clearInterval(scheduleAlarmTimer);
    scheduleAlarmTimer = setInterval(() => {
      if (skin.mode === 'scheduled' && skin.schedule?.enabled) renderAll();
    }, 60 * 1000);
  }

  function attachStorageWatcher() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SKIN_STORAGE_KEY]) {
        const raw = changes[SKIN_STORAGE_KEY].newValue || {};
        skin = migrateStoredSkinState(deepMerge(defaultSkinState(), raw), raw);
        renderAll();
      }
      if (changes.canvasGradesByCourse) renderGradePills();
    });
  }

  async function bootstrap() {
    try {
      const { [SKIN_STORAGE_KEY]: stored } = await chrome.storage.local.get([SKIN_STORAGE_KEY]);
      if (stored && typeof stored === 'object') {
        skin = migrateStoredSkinState(deepMerge(defaultSkinState(), stored), stored);
      }
    } catch { /* ignore */ }
    renderAll();
    attachDomObserver();
    attachSystemDarkListener();
    attachScheduledModeTicker();
    attachStorageWatcher();
    attachPreviewHandlers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }

  console.log('[Canvascope Skin] canvas-skin.js loaded.');
})();
