/**
 * ============================================
 * Canvascope – Skin Themes Catalog
 * ============================================
 *
 * Single source of truth for Canvas page theming. Used by:
 *   - canvas-skin.js          → applies themes to the live Canvas DOM
 *   - slash-commands-pack.js  → autocompletes `/theme <name>`
 *   - popup.js (future)       → renders theme picker previews
 *
 * Each theme is a flat token bag. canvas-skin.js maps token names to a CSS
 * variable namespace under `--cs-skin-*` and injects them into a single
 * <style data-cs-skin-vars> element on every Canvas page.
 *
 * Adding a theme: append to BUILTIN_THEMES. Adding a token: extend
 * normalizeTheme defaults below AND consume it in canvas-skin.js.
 * ============================================
 */

(function (root) {
  'use strict';

  // Token bag schema. Anything not provided by a theme falls back to these
  // defaults so partial themes are valid. Keep keys short — they become
  // `--cs-skin-<key>` variables in injected CSS.
  const DEFAULT_TOKENS = Object.freeze({
    bg:           '#fafafb',   // page background
    bgSoft:       '#f4f4f7',   // secondary surfaces (cards, panels)
    surface:      '#ffffff',   // raised surfaces
    surface2:     '#f1f1f5',   // sidebar / sub-surfaces
    border:       'rgba(15,17,28,0.08)',
    borderHi:     'rgba(15,17,28,0.14)',
    text:         '#15161d',
    textDim:      '#525361',
    muted:        '#8a8a9a',
    accent:       '#6c5ce7',
    accentText:   '#ffffff',
    link:         '#4f46e5',
    danger:       '#e25b5b',
    ok:           '#3ea66c',
    warn:         '#d49a4a',
    cardOverlay:  '0.85',      // alpha multiplier on card header overlay
    fontFamily:   "var(--cs-skin-fontfamily-default)",
    // Modern aesthetic tokens
    radius:       '12px',      // base corner radius for surfaces
    radiusSm:     '8px',       // inputs, buttons
    radiusLg:     '16px',      // cards, modals
    shadow:       '0 1px 2px rgba(15,17,28,0.04), 0 6px 18px rgba(15,17,28,0.06)',
    shadowHi:     '0 4px 12px rgba(15,17,28,0.08), 0 16px 32px rgba(15,17,28,0.10)',
    ringFocus:    'rgba(108,92,231,0.30)'
  });

  const BUILTIN_THEMES = [
    // ── Light / neutral ──────────────────────────────
    {
      id: 'canvas-default',
      name: 'Canvas Default',
      mode: 'light',
      tags: ['stock', 'neutral'],
      tokens: { /* uses defaults */ }
    },
    {
      id: 'paper',
      name: 'Paper',
      mode: 'light',
      tags: ['warm', 'minimal'],
      tokens: {
        bg:       '#f8f4ea',
        bgSoft:   '#efe9d8',
        surface:  '#fdfaf2',
        surface2: '#ece4ce',
        text:     '#2d2925',
        textDim:  '#6b5f4d',
        muted:    '#9b8f78',
        accent:   '#b87333',
        accentText:'#fffaf2',
        link:     '#a05a23',
        border:   'rgba(94,71,45,0.10)',
        borderHi: 'rgba(94,71,45,0.18)',
        ringFocus:'rgba(184,115,51,0.30)'
      }
    },
    {
      id: 'solarized-light',
      name: 'Solarized Light',
      mode: 'light',
      tags: ['classic'],
      tokens: {
        bg:       '#fdf6e3',
        bgSoft:   '#f5edd2',
        surface:  '#fffaec',
        surface2: '#eee8d5',
        text:     '#3a4c52',
        textDim:  '#5b6f78',
        muted:    '#93a1a1',
        accent:   '#268bd2',
        accentText:'#fdf6e3',
        link:     '#2aa198',
        border:   'rgba(101,123,131,0.16)',
        borderHi: 'rgba(101,123,131,0.26)',
        ringFocus:'rgba(38,139,210,0.30)'
      }
    },

    // ── Dark family ──────────────────────────────────
    {
      id: 'dim',
      name: 'Dim',
      mode: 'dark',
      tags: ['easy-on-eyes', 'default-dark'],
      tokens: {
        bg:       '#1a1b23',
        bgSoft:   '#1f2029',
        surface:  '#26272f',
        surface2: '#2d2e38',
        text:     '#ecedf3',
        textDim:  '#b4b6c4',
        muted:    '#7a7b8c',
        accent:   '#c4a8ff',
        accentText:'#1a1b23',
        link:     '#9bcdff',
        border:   'rgba(255,255,255,0.06)',
        borderHi: 'rgba(255,255,255,0.12)',
        shadow:   '0 1px 2px rgba(0,0,0,0.30), 0 8px 24px rgba(0,0,0,0.40)',
        shadowHi: '0 4px 16px rgba(0,0,0,0.40), 0 24px 48px rgba(0,0,0,0.50)',
        ringFocus:'rgba(196,168,255,0.35)'
      }
    },
    {
      id: 'oled-pure',
      name: 'OLED Pure',
      mode: 'dark',
      tags: ['battery', 'amoled'],
      tokens: {
        bg:       '#000000',
        bgSoft:   '#080809',
        surface:  '#0e0e10',
        surface2: '#16161a',
        text:     '#f3f3f6',
        textDim:  '#c4c4d1',
        muted:    '#8e8ea3',
        accent:   '#ffc857',
        accentText:'#000000',
        link:     '#7dd3fc',
        border:   'rgba(255,255,255,0.06)',
        borderHi: 'rgba(255,255,255,0.12)',
        shadow:   '0 1px 0 rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.60)',
        shadowHi: '0 1px 0 rgba(255,255,255,0.06), 0 24px 48px rgba(0,0,0,0.80)',
        ringFocus:'rgba(255,200,87,0.35)'
      }
    },
    {
      id: 'midnight',
      name: 'Midnight',
      mode: 'dark',
      tags: ['blue'],
      tokens: {
        bg:       '#0b1224',
        bgSoft:   '#101a31',
        surface:  '#16213d',
        surface2: '#1d2a4a',
        text:     '#e9eefa',
        textDim:  '#a8b4d0',
        muted:    '#7686a4',
        accent:   '#7aa2ff',
        accentText:'#0b1224',
        link:     '#9cc1ff',
        border:   'rgba(122,162,255,0.10)',
        borderHi: 'rgba(122,162,255,0.20)',
        shadow:   '0 1px 2px rgba(0,0,0,0.40), 0 8px 24px rgba(8,16,40,0.55)',
        shadowHi: '0 4px 16px rgba(0,0,0,0.50), 0 24px 48px rgba(8,16,40,0.65)',
        ringFocus:'rgba(122,162,255,0.35)'
      }
    },
    {
      id: 'forest',
      name: 'Forest',
      mode: 'dark',
      tags: ['green', 'cozy'],
      tokens: {
        bg:       '#0e1d18',
        bgSoft:   '#13261f',
        surface:  '#1a3329',
        surface2: '#214034',
        text:     '#e8f1ea',
        textDim:  '#b8d0c4',
        muted:    '#85a193',
        accent:   '#7ee3a4',
        accentText:'#0e1d18',
        link:     '#9bdfb7',
        border:   'rgba(126,227,164,0.10)',
        borderHi: 'rgba(126,227,164,0.20)',
        shadow:   '0 1px 2px rgba(0,0,0,0.35), 0 8px 24px rgba(6,30,20,0.55)',
        shadowHi: '0 4px 16px rgba(0,0,0,0.50), 0 24px 48px rgba(6,30,20,0.70)',
        ringFocus:'rgba(126,227,164,0.35)'
      }
    },
    {
      id: 'solarized-dark',
      name: 'Solarized Dark',
      mode: 'dark',
      tags: ['classic'],
      tokens: {
        bg:       '#002b36',
        bgSoft:   '#053742',
        surface:  '#0a3f4c',
        surface2: '#0e4956',
        text:     '#eee8d5',
        textDim:  '#a2b3b3',
        muted:    '#7c8f8f',
        accent:   '#268bd2',
        accentText:'#fdf6e3',
        link:     '#2aa198',
        border:   'rgba(147,161,161,0.16)',
        borderHi: 'rgba(147,161,161,0.28)',
        shadow:   '0 1px 2px rgba(0,0,0,0.30), 0 8px 24px rgba(0,30,40,0.55)',
        shadowHi: '0 4px 16px rgba(0,0,0,0.40), 0 24px 48px rgba(0,30,40,0.65)',
        ringFocus:'rgba(38,139,210,0.35)'
      }
    },
    {
      id: 'rose',
      name: 'Rose',
      mode: 'dark',
      tags: ['warm', 'pink'],
      tokens: {
        bg:       '#1c1218',
        bgSoft:   '#251820',
        surface:  '#2e1f29',
        surface2: '#3b2734',
        text:     '#f5e7ee',
        textDim:  '#cdaab7',
        muted:    '#9c7a89',
        accent:   '#f59cbf',
        accentText:'#1c1218',
        link:     '#f0a9c6',
        border:   'rgba(245,156,191,0.10)',
        borderHi: 'rgba(245,156,191,0.20)',
        shadow:   '0 1px 2px rgba(0,0,0,0.35), 0 8px 24px rgba(36,10,22,0.55)',
        shadowHi: '0 4px 16px rgba(0,0,0,0.45), 0 24px 48px rgba(36,10,22,0.70)',
        ringFocus:'rgba(245,156,191,0.35)'
      }
    },
    {
      id: 'high-contrast',
      name: 'High Contrast',
      mode: 'dark',
      tags: ['accessibility'],
      tokens: {
        bg:       '#000000',
        bgSoft:   '#0a0a0a',
        surface:  '#101010',
        surface2: '#1c1c1c',
        text:     '#ffffff',
        textDim:  '#ebebeb',
        muted:    '#c4c4c4',
        accent:   '#ffd60a',
        accentText:'#000000',
        link:     '#7ee0ff',
        border:   'rgba(255,255,255,0.28)',
        borderHi: 'rgba(255,255,255,0.55)',
        shadow:   '0 0 0 1px rgba(255,255,255,0.10)',
        shadowHi: '0 0 0 2px rgba(255,255,255,0.20)',
        ringFocus:'rgba(255,214,10,0.55)'
      }
    }
  ];

  // Font stack catalog. `value` is the literal CSS font-family string.
  const BUILTIN_FONTS = [
    { id: 'system',   name: 'System Default',  value: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
    { id: 'geist',    name: 'Geist',           value: '"Geist", "Inter", system-ui, sans-serif' },
    { id: 'inter',    name: 'Inter',           value: '"Inter", system-ui, sans-serif' },
    { id: 'ibm',      name: 'IBM Plex Sans',   value: '"IBM Plex Sans", system-ui, sans-serif' },
    { id: 'serif',    name: 'Source Serif',    value: '"Source Serif Pro", Georgia, "Times New Roman", serif' },
    { id: 'mono',     name: 'JetBrains Mono',  value: '"JetBrains Mono", "Geist Mono", ui-monospace, Menlo, monospace' },
    { id: 'rounded',  name: 'Rounded',         value: '"SF Pro Rounded", "Nunito", system-ui, sans-serif' },
    { id: 'dyslexic', name: 'OpenDyslexic',    value: '"OpenDyslexic", "Comic Sans MS", system-ui, sans-serif' }
  ];

  function normalizeTheme(theme) {
    if (!theme) return null;
    const tokens = { ...DEFAULT_TOKENS, ...(theme.tokens || {}) };
    return {
      id: String(theme.id || '').trim() || 'unnamed',
      name: theme.name || theme.id || 'Unnamed Theme',
      mode: theme.mode === 'dark' ? 'dark' : 'light',
      tags: Array.isArray(theme.tags) ? [...theme.tags] : [],
      tokens
    };
  }

  function getTheme(id) {
    const t = BUILTIN_THEMES.find(t => t.id === id);
    return t ? normalizeTheme(t) : null;
  }

  function getFont(id) {
    return BUILTIN_FONTS.find(f => f.id === id) || null;
  }

  function listThemes() {
    return BUILTIN_THEMES.map(normalizeTheme);
  }

  function listFonts() {
    return BUILTIN_FONTS.slice();
  }

  // Build the CSS variable block from a normalized theme. Output is the
  // body of a `:root, .cs-skin-root { ... }` rule.
  function buildCssVariables(theme) {
    if (!theme) return '';
    const t = theme.tokens || {};
    const lines = Object.keys(t).map(k => {
      const cssVar = '--cs-skin-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
      return `  ${cssVar}: ${t[k]};`;
    });
    return lines.join('\n');
  }

  const api = {
    DEFAULT_TOKENS,
    BUILTIN_THEMES: BUILTIN_THEMES.map(normalizeTheme),
    BUILTIN_FONTS,
    getTheme,
    getFont,
    listThemes,
    listFonts,
    normalizeTheme,
    buildCssVariables
  };

  // UMD-ish export so both content scripts (browser globals) and Node tests
  // can consume this.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CanvascopeSkinThemes = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
