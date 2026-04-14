/**
 * ============================================
 * Canvascope – Slash Command Overlay
 * ============================================
 *
 * PURPOSE:
 * Injects a Spotlight-style slash command overlay into LMS pages.
 * Activated by pressing `/` when no text input is focused.
 * Completely self-contained: own shadow DOM, CSS, state, and
 * communication with the background service worker.
 *
 * ============================================
 */

(function canvascopeSlashOverlay() {
  'use strict';

  // Guard: only initialise once
  if (window.__canvascopeSlashOverlayInitialised) return;
  window.__canvascopeSlashOverlayInitialised = true;

  // ============================================
  // CONSTANTS
  // ============================================

  const SLASH_RESULT_LIMIT = 18;
  const ANIMATION_DURATION_MS = 180;

  // ============================================
  // SLASH COMMAND REGISTRY
  // ============================================

  function normalizeSlashAlias(value) {
    return String(value || '').trim().replace(/^\//, '').toLowerCase();
  }

  function buildSlashCommandLookup(commands) {
    const lookup = new Map();
    for (const cmd of Array.isArray(commands) ? commands : []) {
      const aliases = [cmd?.primaryAlias, ...(Array.isArray(cmd?.aliases) ? cmd.aliases : [])];
      for (const alias of aliases) {
        const n = normalizeSlashAlias(alias);
        if (!n || lookup.has(n)) continue;
        lookup.set(n, cmd);
      }
    }
    return lookup;
  }

  function scoreSlashCommandMatch(command, query) {
    const nq = normalizeSlashAlias(query);
    if (!nq) return 1;

    const aliases = [command?.primaryAlias, ...(Array.isArray(command?.aliases) ? command.aliases : [])]
      .map(normalizeSlashAlias).filter(Boolean);
    const title = (command?.title || '').toLowerCase();
    const description = (command?.description || '').toLowerCase();
    const keywords = (Array.isArray(command?.keywords) ? command.keywords : [])
      .map(k => (k || '').toLowerCase()).filter(Boolean);

    let score = -Infinity;
    for (const alias of aliases) {
      if (alias === nq) return 200;
      if (alias.startsWith(nq)) score = Math.max(score, 150 - alias.length);
      if (alias.includes(nq)) score = Math.max(score, 132 - alias.length);
    }
    if (title === nq) score = Math.max(score, 126);
    if (title.startsWith(nq)) score = Math.max(score, 112);
    if (title.includes(nq)) score = Math.max(score, 98);
    if (description.includes(nq)) score = Math.max(score, 74);
    for (const kw of keywords) {
      if (kw === nq) score = Math.max(score, 104);
      if (kw.startsWith(nq)) score = Math.max(score, 92);
      if (kw.includes(nq)) score = Math.max(score, 84);
    }
    return score;
  }

  function rankSlashCommands(commands, query) {
    const nq = normalizeSlashAlias(query);
    const entries = [];
    for (const cmd of Array.isArray(commands) ? commands : []) {
      const score = scoreSlashCommandMatch(cmd, nq);
      if (nq && !Number.isFinite(score)) continue;
      entries.push({ command: cmd, score });
    }
    return entries
      .sort((a, b) => b.score !== a.score ? b.score - a.score : (a.command?.order || 0) - (b.command?.order || 0))
      .map(e => e.command);
  }

  function parseSlashInput(rawValue, commandLookup) {
    const raw = String(rawValue || '');
    if (!raw.startsWith('/')) {
      return { active: false, commandQuery: '', commandToken: '', argumentText: '', exactCommand: null, mode: 'inactive' };
    }
    const body = raw.slice(1);
    const ws = body.search(/\s/);
    const hasWs = ws !== -1;
    const commandToken = hasWs ? body.slice(0, ws) : body;
    const commandQuery = commandToken.trim().toLowerCase();
    const argumentText = hasWs ? body.slice(ws + 1) : '';
    const exactCommand = commandLookup.get(commandQuery) || null;
    const mode = exactCommand && hasWs ? 'results' : 'commands';
    return { active: true, commandQuery, commandToken, argumentText, exactCommand, mode };
  }

  // ============================================
  // ITEM HELPERS
  // ============================================

  function isSlashPdfEligible(item) {
    const t = String(item?.type || '').toLowerCase();
    if (t === 'pdf') return true;
    if (t !== 'file') return false;
    const title = String(item?.title || '').toLowerCase();
    const url = String(item?.url || '').toLowerCase();
    return title.includes('.pdf') || url.includes('.pdf');
  }

  // ── Text normalisation ────────────────────────────
  const NORM_CACHE = new Map();
  function normalizeText(text) {
    if (!text) return '';
    let cached = NORM_CACHE.get(text);
    if (cached !== undefined) return cached;
    cached = text
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/['']/g, "'")
      .replace(/[""]/g, '"')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (NORM_CACHE.size > 2000) NORM_CACHE.clear();
    NORM_CACHE.set(text, cached);
    return cached;
  }

  // ── Searchable fields ─────────────────────────────
  function getSearchTitle(item) {
    return (item?.searchTitleNormalized || normalizeText(item?.title || '')).toLowerCase();
  }

  function getSearchContext(item) {
    return [
      item?.searchPathNormalized || normalizeText(item?.folderPath || ''),
      normalizeText(item?.moduleName || ''),
      normalizeText(item?.courseName || ''),
      ...(Array.isArray(item?.searchAliases) ? item.searchAliases : [])
    ].join(' ').toLowerCase();
  }

  function getFullSearchBlob(item) {
    return getSearchTitle(item) + ' ' + getSearchContext(item) + ' ' + (item?.type || '');
  }

  // ── Numeric helpers ───────────────────────────────
  function extractNumbers(text) {
    const matches = (text || '').match(/\b\d{1,4}\b/g);
    return matches ? matches.map(n => n.replace(/^0+/, '') || '0') : [];
  }

  // ── Multi-signal scorer ───────────────────────────
  const STOP_WORDS = new Set(['the', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'is', 'a', 'an']);

  function scoreItemMatch(item, query) {
    if (!query) return 1;
    const qLower = query.toLowerCase().trim();
    if (!qLower) return 1;
    const qTokens = qLower.split(/\s+/).filter(t => t.length > 0 && !STOP_WORDS.has(t));
    if (qTokens.length === 0) return 1;

    const title = getSearchTitle(item);
    const context = getSearchContext(item);
    const blob = title + ' ' + context;

    // ── 1. Token coverage (AND-ish) ──────────────────
    let tokenHits = 0;
    for (const t of qTokens) {
      if (blob.includes(t)) tokenHits++;
    }
    const coverage = tokenHits / qTokens.length;
    if (coverage === 0) return 0; // no tokens matched at all

    let score = coverage;

    // ── 2. Title-focused scoring ─────────────────────
    if (title === qLower) {
      score += 2.0;
    } else if (title.startsWith(qLower)) {
      score += 1.5;
    } else if (title.includes(qLower)) {
      score += 1.0;
    } else {
      // Check if all tokens appear in title specifically
      let titleHits = 0;
      for (const t of qTokens) {
        if (title.includes(t)) titleHits++;
      }
      if (titleHits === qTokens.length) {
        score += 0.8;
      } else if (titleHits > 0) {
        score += 0.3 * (titleHits / qTokens.length);
      }
    }

    // ── 3. Numeric alignment ─────────────────────────
    const queryNums = extractNumbers(query);
    if (queryNums.length > 0) {
      const titleNums = new Set(extractNumbers(title));
      const contextNums = new Set(extractNumbers(context));
      let aligned = 0, mismatched = 0;
      for (const qn of queryNums) {
        if (titleNums.has(qn)) aligned++;
        else if (contextNums.has(qn)) aligned += 0.5;
        else mismatched++;
      }
      if (aligned > 0) score += 0.4 * (aligned / queryNums.length);
      if (mismatched > 0) score -= 0.6 * (mismatched / queryNums.length);
    }

    // ── 4. Path/context coverage boost ───────────────
    if (context) {
      let contextHits = 0;
      for (const t of qTokens) {
        if (context.includes(t)) contextHits++;
      }
      if (contextHits > 0) {
        score += 0.25 * (contextHits / qTokens.length);
      }
    }

    // ── 5. Word boundary exactness bonus ─────────────
    let boundaryHits = 0;
    for (const t of qTokens) {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        if (new RegExp(`\\b${escaped}\\b`).test(blob)) boundaryHits++;
      } catch { /* regex safety */ }
    }
    if (boundaryHits === qTokens.length) {
      score += 0.3;
    }

    // ── 6. Prefer shorter titles (Occam's razor) ─────
    if (title.length < 30) score += 0.05;
    if (title.length > 80) score -= 0.05;

    return Math.max(0, score);
  }

  function filterItems(items, query, limit) {
    if (!query || !query.trim()) {
      return items.slice(0, limit);
    }
    return items
      .map(item => ({ item, score: scoreItemMatch(item, query) }))
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(e => e.item);
  }

  const TASK_TYPES = new Set(['assignment', 'quiz', 'discussion']);
  function isTaskType(item) { return TASK_TYPES.has((item?.type || '').toLowerCase()); }

  function parseDueTs(item) {
    if (!item?.dueAt) return 0;
    const ts = new Date(item.dueAt).getTime();
    return isNaN(ts) ? 0 : ts;
  }

  function formatDueLabel(item) {
    const ts = parseDueTs(item);
    if (ts === 0) return 'No due date';
    const now = Date.now();
    const diffMs = ts - now;
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
    if (diffMs < 0) {
      const abs = Math.abs(diffDays);
      return abs === 0 ? 'Overdue today' : `${abs}d overdue`;
    }
    if (diffDays === 0) {
      const hrs = Math.round(diffMs / (60 * 60 * 1000));
      return hrs <= 1 ? 'Due soon' : `Due in ${hrs}h`;
    }
    if (diffDays === 1) return 'Due tomorrow';
    return `Due ${new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }

  // ============================================
  // BACKGROUND BRIDGE
  // ============================================

  async function fetchIndexedContent() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getIndexedContent' });
      return res?.items || [];
    } catch { return []; }
  }

  async function fetchExtensionSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getExtensionSettings' });
      return res?.settings || {};
    } catch { return {}; }
  }

  async function fetchAuthStatus() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'checkAuthStatus' });
      return res || { signedIn: false };
    } catch { return { signedIn: false }; }
  }

  async function sendPdfToLectra(item) {
    return chrome.runtime.sendMessage({
      action: 'sendPdfToLectra',
      trigger: 'slash_overlay_ls',
      candidateUrl: item?.url || null,
      sourcePageUrl: item?.url || null,
      titleHint: item?.title || null
    });
  }

  async function triggerForceScan() {
    return chrome.runtime.sendMessage({ action: 'forceScan' });
  }

  // ============================================
  // COMMAND DEFINITIONS
  // ============================================

  function getCommandRegistry() {
    return [
      {
        order: 0, id: 'lectra-send', primaryAlias: 'ls',
        aliases: ['lectra', 'lectra-send'],
        title: 'Lectra Send',
        description: 'Find an indexed PDF and send it straight to Lectra.',
        keywords: ['pdf', 'send', 'lectra', 'annotate'],
        icon: '📄', badge: 'Send', needsArgument: true
      },
      {
        order: 1, id: 'gradescope', primaryAlias: 'gs',
        aliases: ['gradescope'],
        title: 'Open Gradescope',
        description: 'Open gradescope.com in a new tab.',
        keywords: ['gradescope', 'grade', 'open'],
        icon: '🎓', badge: 'Open', needsArgument: false
      },
      {
        order: 2, id: 'course', primaryAlias: 'course',
        aliases: ['class', 'courses'],
        title: 'Open Course',
        description: 'Jump straight into one of your indexed courses.',
        keywords: ['course', 'class', 'dashboard', 'open'],
        icon: '📚', badge: 'Go', needsArgument: true
      },
      {
        order: 3, id: 'due', primaryAlias: 'due',
        aliases: ['todo', 'tasks'],
        title: 'Due Items',
        description: 'Browse upcoming and overdue work.',
        keywords: ['due', 'todo', 'task', 'assignment', 'quiz'],
        icon: '📅', badge: 'View', needsArgument: true
      },
      {
        order: 4, id: 'refresh', primaryAlias: 'refresh',
        aliases: ['sync'],
        title: 'Refresh Index',
        description: 'Kick off a fresh Canvascope sync.',
        keywords: ['refresh', 'sync', 'scan', 'index'],
        icon: '🔄', badge: 'Sync', needsArgument: false
      },
      {
        order: 5, id: 'browse', primaryAlias: 'browse',
        aliases: ['all'],
        title: 'Browse All Content',
        description: 'Open all indexed content in the popup.',
        keywords: ['browse', 'all', 'index', 'content'],
        icon: '📖', badge: 'Browse', needsArgument: false
      }
    ];
  }

  // ============================================
  // OVERLAY STATE
  // ============================================

  let overlayRoot = null;
  let shadowRoot = null;
  let isOpen = false;
  let indexedContent = [];
  let extensionSettings = {};
  let authStatus = { signedIn: false };
  let highlightedIndex = 0;
  let currentEntries = [];
  let feedbackMessage = null;
  let feedbackTone = 'info';

  // ============================================
  // SHADOW DOM + CSS
  // ============================================

  const OVERLAY_CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    :host {
      all: initial;
      display: block;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    .slash-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      opacity: 0;
      transition: opacity ${ANIMATION_DURATION_MS}ms ease;
      pointer-events: none;
    }

    .slash-backdrop.visible {
      opacity: 1;
      pointer-events: auto;
    }

    .slash-container {
      position: fixed;
      top: 18%;
      left: 50%;
      transform: translateX(-50%) scale(0.92);
      z-index: 2147483647;
      width: 640px;
      max-width: calc(100vw - 40px);
      opacity: 0;
      transition: opacity ${ANIMATION_DURATION_MS}ms ease, transform ${ANIMATION_DURATION_MS}ms cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      color: rgba(255, 255, 255, 0.92);
      -webkit-font-smoothing: antialiased;
    }

    .slash-container.visible {
      opacity: 1;
      transform: translateX(-50%) scale(1);
      pointer-events: auto;
    }

    .slash-panel {
      background: linear-gradient(
        145deg,
        rgba(32, 10, 10, 0.95) 0%,
        rgba(20, 8, 8, 0.96) 45%,
        rgba(38, 10, 10, 0.94) 100%
      );
      border: 1px solid rgba(239, 68, 68, 0.35);
      border-radius: 20px;
      box-shadow:
        0 24px 56px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.04) inset,
        0 1px 0 rgba(255, 255, 255, 0.07) inset;
      backdrop-filter: blur(28px) saturate(1.5);
      -webkit-backdrop-filter: blur(28px) saturate(1.5);
      overflow: hidden;
      position: relative;
    }

    .slash-panel::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 20px;
      background:
        radial-gradient(circle at 20% 0%, rgba(239, 68, 68, 0.12), transparent 40%),
        radial-gradient(circle at 80% 100%, rgba(239, 68, 68, 0.06), transparent 30%);
      pointer-events: none;
    }

    /* ---------- SEARCH BAR ---------- */
    .slash-search-bar {
      position: relative;
      display: flex;
      align-items: center;
      padding: 0 18px;
      gap: 12px;
      border-bottom: 1px solid rgba(239, 68, 68, 0.16);
    }

    .slash-prefix {
      flex-shrink: 0;
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      border: 1px solid rgba(248, 113, 113, 0.35);
      background: rgba(239, 68, 68, 0.14);
      color: #f87171;
      font-size: 1.05rem;
      font-weight: 700;
      line-height: 1;
      box-shadow: 0 0 12px rgba(239, 68, 68, 0.15);
    }

    .slash-input {
      flex: 1;
      background: none;
      border: none;
      outline: none;
      color: rgba(255, 255, 255, 0.95);
      font-size: 1.08rem;
      font-family: inherit;
      font-weight: 500;
      padding: 18px 0;
      caret-color: #f87171;
    }

    .slash-input::placeholder {
      color: rgba(255, 255, 255, 0.32);
      font-weight: 400;
    }

    .slash-close-btn {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.5);
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .slash-close-btn:hover {
      background: rgba(239, 68, 68, 0.18);
      border-color: rgba(248, 113, 113, 0.3);
      color: rgba(255, 255, 255, 0.9);
    }

    /* ---------- RESULTS ---------- */
    .slash-body {
      max-height: 380px;
      overflow-y: auto;
      padding: 8px;
      position: relative;
      z-index: 1;
    }

    .slash-body::-webkit-scrollbar {
      width: 4px;
    }
    .slash-body::-webkit-scrollbar-track {
      background: transparent;
    }
    .slash-body::-webkit-scrollbar-thumb {
      background: rgba(239, 68, 68, 0.25);
      border-radius: 4px;
    }

    .slash-section-label {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.4);
      padding: 10px 10px 6px;
    }

    .slash-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 11px 12px;
      border-radius: 14px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: all 0.12s ease;
      width: 100%;
      text-align: left;
      background: none;
      color: inherit;
      font-family: inherit;
      font-size: inherit;
    }

    .slash-item:hover,
    .slash-item.active {
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(248, 113, 113, 0.22);
    }

    .slash-item.active {
      background: rgba(239, 68, 68, 0.16);
      border-color: rgba(248, 113, 113, 0.32);
    }

    .slash-item-icon {
      width: 36px;
      height: 36px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 1.1rem;
    }

    .slash-item-copy {
      flex: 1;
      min-width: 0;
    }

    .slash-item-title {
      font-size: 0.92rem;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.94);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .slash-item-subtitle {
      font-size: 0.78rem;
      color: rgba(255, 255, 255, 0.45);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }

    .slash-item-badge {
      flex-shrink: 0;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      padding: 4px 10px;
      border-radius: 20px;
      background: rgba(239, 68, 68, 0.14);
      color: #f87171;
      border: 1px solid rgba(248, 113, 113, 0.2);
    }

    .slash-item-badge.badge-setup {
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.45);
      border-color: rgba(255, 255, 255, 0.1);
    }

    /* ---------- FEEDBACK ---------- */
    .slash-feedback {
      margin: 8px 8px 0;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 0.8rem;
      line-height: 1.45;
      border: 1px solid transparent;
    }
    .slash-feedback.hidden { display: none; }
    .slash-feedback.tone-success {
      background: rgba(74, 222, 128, 0.1);
      border-color: rgba(74, 222, 128, 0.22);
      color: rgba(210, 255, 225, 0.9);
    }
    .slash-feedback.tone-error {
      background: rgba(248, 113, 113, 0.12);
      border-color: rgba(248, 113, 113, 0.24);
      color: rgba(255, 220, 220, 0.9);
    }
    .slash-feedback.tone-info {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.8);
    }

    /* ---------- EMPTY STATE ---------- */
    .slash-empty {
      padding: 28px 16px;
      text-align: center;
      font-size: 0.85rem;
      color: rgba(255, 255, 255, 0.35);
    }

    /* ---------- FOOTER ---------- */
    .slash-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 18px;
      border-top: 1px solid rgba(239, 68, 68, 0.1);
      font-size: 0.72rem;
      color: rgba(255, 255, 255, 0.28);
      position: relative;
      z-index: 1;
    }

    .slash-footer-keys {
      display: flex;
      gap: 8px;
    }

    .slash-footer-keys kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      padding: 2px 6px;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.05);
      font-family: inherit;
      font-size: 0.68rem;
      color: rgba(255, 255, 255, 0.44);
    }

    @media (prefers-reduced-motion: reduce) {
      .slash-backdrop,
      .slash-container,
      .slash-item {
        transition: none !important;
      }
    }
  `;

  // ============================================
  // BUILD OVERLAY DOM
  // ============================================

  function createOverlayDOM() {
    overlayRoot = document.createElement('div');
    overlayRoot.id = 'canvascope-slash-root';
    shadowRoot = overlayRoot.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    shadowRoot.appendChild(style);

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'slash-backdrop';
    backdrop.addEventListener('click', closeOverlay);
    shadowRoot.appendChild(backdrop);

    // Container
    const container = document.createElement('div');
    container.className = 'slash-container';
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-modal', 'true');
    container.setAttribute('aria-label', 'Canvascope slash commands');

    const panel = document.createElement('div');
    panel.className = 'slash-panel';

    // Search bar
    const searchBar = document.createElement('div');
    searchBar.className = 'slash-search-bar';

    const prefix = document.createElement('span');
    prefix.className = 'slash-prefix';
    prefix.textContent = '/';
    searchBar.appendChild(prefix);

    const input = document.createElement('input');
    input.className = 'slash-input';
    input.type = 'text';
    input.placeholder = 'Type a command…';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', 'Slash command input');
    searchBar.appendChild(input);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'slash-close-btn';
    closeBtn.innerHTML = 'esc';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', closeOverlay);
    searchBar.appendChild(closeBtn);

    panel.appendChild(searchBar);

    // Feedback
    const feedback = document.createElement('div');
    feedback.className = 'slash-feedback hidden';
    panel.appendChild(feedback);

    // Body (results)
    const body = document.createElement('div');
    body.className = 'slash-body';
    body.setAttribute('role', 'listbox');
    body.setAttribute('aria-label', 'Slash command results');
    panel.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'slash-footer';

    const brand = document.createElement('span');
    brand.textContent = 'Canvascope';

    const keys = document.createElement('div');
    keys.className = 'slash-footer-keys';
    keys.innerHTML = '<kbd>↑↓</kbd> navigate <kbd>↵</kbd> select <kbd>esc</kbd> close';

    footer.appendChild(brand);
    footer.appendChild(keys);
    panel.appendChild(footer);

    container.appendChild(panel);
    shadowRoot.appendChild(container);

    // Wire input events
    input.addEventListener('input', onInputChange);
    input.addEventListener('keydown', onInputKeydown);

    document.body.appendChild(overlayRoot);
  }

  // ============================================
  // GET SHADOW DOM ELEMENTS
  // ============================================

  function getBackdrop() { return shadowRoot?.querySelector('.slash-backdrop'); }
  function getContainer() { return shadowRoot?.querySelector('.slash-container'); }
  function getInput() { return shadowRoot?.querySelector('.slash-input'); }
  function getBody() { return shadowRoot?.querySelector('.slash-body'); }
  function getFeedback() { return shadowRoot?.querySelector('.slash-feedback'); }

  // ============================================
  // OPEN / CLOSE
  // ============================================

  async function openOverlay() {
    if (isOpen) return;
    if (!overlayRoot) createOverlayDOM();

    isOpen = true;
    highlightedIndex = 0;
    currentEntries = [];
    feedbackMessage = null;

    // Fetch data in parallel
    const [content, settings, auth] = await Promise.all([
      fetchIndexedContent(),
      fetchExtensionSettings(),
      fetchAuthStatus()
    ]);
    indexedContent = content;
    extensionSettings = settings;
    authStatus = auth;

    // Show with animation
    const backdrop = getBackdrop();
    const container = getContainer();
    const input = getInput();

    if (backdrop) backdrop.classList.add('visible');
    if (container) container.classList.add('visible');
    if (input) {
      input.value = '';
      requestAnimationFrame(() => input.focus());
    }

    document.body.style.overflow = 'hidden';
    renderResults();
  }

  function closeOverlay() {
    if (!isOpen) return;
    isOpen = false;

    const backdrop = getBackdrop();
    const container = getContainer();

    if (backdrop) backdrop.classList.remove('visible');
    if (container) container.classList.remove('visible');

    document.body.style.overflow = '';

    // Clear after animation
    setTimeout(() => {
      const input = getInput();
      if (input) input.value = '';
      const body = getBody();
      if (body) body.innerHTML = '';
      clearFeedback();
    }, ANIMATION_DURATION_MS);
  }

  // ============================================
  // INPUT HANDLING
  // ============================================

  function onInputChange() {
    highlightedIndex = 0;
    clearFeedback();
    renderResults();
  }

  function onInputKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentEntries.length > 0) {
        highlightedIndex = Math.min(highlightedIndex + 1, currentEntries.length - 1);
        renderHighlight();
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentEntries.length > 0) {
        highlightedIndex = Math.max(highlightedIndex - 1, 0);
        renderHighlight();
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const entry = currentEntries[highlightedIndex];
      if (entry) executeEntry(entry);
      return;
    }

    if (e.key === 'Backspace') {
      const input = getInput();
      if (input && input.value === '') {
        e.preventDefault();
        closeOverlay();
      }
    }
  }

  // ============================================
  // RENDERING
  // ============================================

  function renderResults() {
    const body = getBody();
    if (!body) return;

    const input = getInput();
    const rawValue = '/' + (input?.value || '');
    const commands = getCommandRegistry();
    const lookup = buildSlashCommandLookup(commands);
    const parsed = parseSlashInput(rawValue, lookup);

    let entries = [];

    if (parsed.mode === 'commands') {
      // Show command palette
      const matching = rankSlashCommands(commands, parsed.commandQuery);
      entries = matching.map(cmd => ({
        kind: 'command',
        command: cmd,
        title: `/${cmd.primaryAlias}`,
        subtitle: cmd.description,
        icon: cmd.icon,
        badge: cmd.badge,
        onSelect: () => selectCommand(cmd)
      }));
    } else if (parsed.exactCommand) {
      const cmd = parsed.exactCommand;
      entries = buildCommandResults(cmd, parsed.argumentText);
    }

    currentEntries = entries;
    highlightedIndex = entries.length > 0 ? Math.min(highlightedIndex, entries.length - 1) : 0;

    body.innerHTML = '';

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'slash-empty';
      empty.textContent = parsed.mode === 'commands'
        ? `No commands matched "/${parsed.commandQuery}".`
        : getEmptyCopy(parsed.exactCommand, parsed.argumentText);
      body.appendChild(empty);
      return;
    }

    // Section label
    const label = document.createElement('div');
    label.className = 'slash-section-label';
    label.textContent = parsed.mode === 'commands' ? 'Commands' : `/${parsed.exactCommand.primaryAlias}`;
    body.appendChild(label);

    entries.forEach((entry, idx) => {
      const btn = document.createElement('button');
      btn.className = `slash-item${idx === highlightedIndex ? ' active' : ''}`;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', idx === highlightedIndex ? 'true' : 'false');
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => {
        highlightedIndex = idx;
        executeEntry(entry);
      });
      btn.addEventListener('mouseenter', () => {
        highlightedIndex = idx;
        renderHighlight();
      });

      const iconEl = document.createElement('span');
      iconEl.className = 'slash-item-icon';
      iconEl.textContent = entry.icon || '⚡';
      btn.appendChild(iconEl);

      const copy = document.createElement('div');
      copy.className = 'slash-item-copy';

      const titleEl = document.createElement('div');
      titleEl.className = 'slash-item-title';
      titleEl.textContent = entry.title;
      copy.appendChild(titleEl);

      if (entry.subtitle) {
        const subEl = document.createElement('div');
        subEl.className = 'slash-item-subtitle';
        subEl.textContent = entry.subtitle;
        copy.appendChild(subEl);
      }
      btn.appendChild(copy);

      if (entry.badge) {
        const badgeEl = document.createElement('span');
        badgeEl.className = `slash-item-badge${entry.badgeClass ? ' ' + entry.badgeClass : ''}`;
        badgeEl.textContent = entry.badge;
        btn.appendChild(badgeEl);
      }

      body.appendChild(btn);
    });

    scrollHighlightIntoView();
  }

  function renderHighlight() {
    const body = getBody();
    if (!body) return;
    const items = body.querySelectorAll('.slash-item');
    items.forEach((el, idx) => {
      el.classList.toggle('active', idx === highlightedIndex);
      el.setAttribute('aria-selected', idx === highlightedIndex ? 'true' : 'false');
    });
    scrollHighlightIntoView();
  }

  function scrollHighlightIntoView() {
    const body = getBody();
    if (!body) return;
    const items = body.querySelectorAll('.slash-item');
    const active = items[highlightedIndex];
    active?.scrollIntoView({ block: 'nearest' });
  }

  // ============================================
  // BUILD COMMAND-SPECIFIC RESULTS
  // ============================================

  function buildCommandResults(cmd, argumentText) {
    switch (cmd.id) {
      case 'lectra-send': return buildLectraResults(cmd, argumentText);
      case 'gradescope': return buildGradescopeResults(cmd);
      case 'course': return buildCourseResults(cmd, argumentText);
      case 'due': return buildDueResults(cmd, argumentText);
      case 'refresh': return buildRefreshResults(cmd);
      case 'browse': return buildBrowseResults(cmd);
      default: return [];
    }
  }

  function buildLectraResults(cmd, query) {
    const lectraEnabled = extensionSettings?.enableSendToLectra;
    const signedIn = authStatus?.signedIn;

    if (!signedIn || !lectraEnabled) {
      const reason = !signedIn
        ? 'Sign in to Canvascope to use Lectra Send.'
        : 'Enable "Send to Lectra" in Settings first.';
      return [{
        kind: 'guidance', command: cmd, title: reason,
        subtitle: 'Open the popup → Settings to configure.',
        icon: '⚠️', badge: 'Setup', badgeClass: 'badge-setup',
        onSelect: () => setFeedbackMsg(reason, 'info')
      }];
    }

    const pdfs = indexedContent.filter(isSlashPdfEligible);
    const filtered = filterItems(pdfs, query, SLASH_RESULT_LIMIT);
    return filtered.map(item => ({
      kind: 'item', command: cmd, item,
      title: item.title || 'Untitled PDF',
      subtitle: [item.courseName, item.moduleName].filter(Boolean).join(' › '),
      icon: '📄', badge: 'Send',
      onSelect: () => executeLectraSend(item)
    }));
  }

  function buildGradescopeResults(cmd) {
    return [{
      kind: 'action', command: cmd,
      title: 'Open Gradescope',
      subtitle: 'Launch gradescope.com in a new tab.',
      icon: '🎓', badge: 'Open',
      onSelect: () => executeGradescope()
    }];
  }

  function buildCourseResults(cmd, query) {
    const courses = indexedContent.filter(i => (i.type || '').toLowerCase() === 'course');
    const filtered = filterItems(courses, query, SLASH_RESULT_LIMIT);
    return filtered.map(item => ({
      kind: 'item', command: cmd, item,
      title: item.title || 'Untitled Course',
      subtitle: item.moduleName || '',
      icon: '📚', badge: 'Go',
      onSelect: () => executeOpenUrl(item.url)
    }));
  }

  function buildDueResults(cmd, query) {
    const tasks = indexedContent.filter(i => isTaskType(i) && parseDueTs(i) > 0);
    tasks.sort((a, b) => parseDueTs(a) - parseDueTs(b));

    const now = Date.now();
    const relevant = tasks.filter(i => {
      const ts = parseDueTs(i);
      // Show overdue (last 30 days) + upcoming (next 14 days)
      return ts > now - 30 * 24 * 60 * 60 * 1000;
    });

    const filtered = filterItems(relevant, query, SLASH_RESULT_LIMIT);
    return filtered.map(item => ({
      kind: 'item', command: cmd, item,
      title: item.title || 'Untitled',
      subtitle: [item.courseName, formatDueLabel(item)].filter(Boolean).join(' · '),
      icon: '📅', badge: formatDueLabel(item),
      onSelect: () => executeOpenUrl(item.url)
    }));
  }

  function buildRefreshResults(cmd) {
    return [{
      kind: 'action', command: cmd,
      title: 'Refresh Canvascope Index',
      subtitle: 'Trigger a fresh sync for the current LMS tab.',
      icon: '🔄', badge: 'Sync',
      onSelect: () => executeRefresh()
    }];
  }

  function buildBrowseResults(cmd) {
    return [{
      kind: 'action', command: cmd,
      title: 'Browse All Indexed Content',
      subtitle: 'Open the all-content browser in the popup.',
      icon: '📖', badge: 'Browse',
      onSelect: () => executeBrowse()
    }];
  }

  function getEmptyCopy(cmd, query) {
    const q = (query || '').trim();
    switch (cmd?.id) {
      case 'lectra-send': return q ? `No PDFs matched "${q}".` : 'No indexed PDFs found.';
      case 'course': return q ? `No courses matched "${q}".` : 'No indexed courses found.';
      case 'due': return q ? `No due items matched "${q}".` : 'No upcoming due items.';
      default: return 'No results.';
    }
  }

  // ============================================
  // COMMAND EXECUTION
  // ============================================

  function selectCommand(cmd) {
    const input = getInput();
    if (!input) return;

    if (cmd.needsArgument) {
      input.value = `${cmd.primaryAlias} `;
      highlightedIndex = 0;
      clearFeedback();
      renderResults();
      input.focus();
    } else {
      // Immediately show results for non-argument commands
      input.value = `${cmd.primaryAlias} `;
      highlightedIndex = 0;
      clearFeedback();
      renderResults();
      // Auto-execute if only one result
      if (currentEntries.length === 1) {
        executeEntry(currentEntries[0]);
      }
    }
  }

  function executeEntry(entry) {
    if (entry && typeof entry.onSelect === 'function') {
      entry.onSelect();
    }
  }

  async function executeLectraSend(item) {
    setFeedbackMsg(`Sending "${item.title || 'PDF'}" to Lectra…`, 'info');
    try {
      const res = await sendPdfToLectra(item);
      if (res?.success) {
        setFeedbackMsg(`Sent "${item.title || 'PDF'}" to Lectra ✓`, 'success');
        setTimeout(closeOverlay, 1200);
      } else {
        setFeedbackMsg(res?.message || 'Send failed.', 'error');
      }
    } catch (err) {
      setFeedbackMsg('Send failed. Try again.', 'error');
    }
  }

  async function executeGradescope() {
    await chrome.tabs.create({ url: 'https://www.gradescope.com/', active: true });
    closeOverlay();
  }

  function executeOpenUrl(url) {
    if (url) {
      window.open(url, '_blank');
    }
    closeOverlay();
  }

  async function executeRefresh() {
    setFeedbackMsg('Refreshing index…', 'info');
    await triggerForceScan();
    setFeedbackMsg('Sync started ✓', 'success');
    setTimeout(closeOverlay, 1000);
  }

  function executeBrowse() {
    // Can't open popup browse modal from content script; open popup instead
    setFeedbackMsg('Open the Canvascope popup to browse content.', 'info');
    setTimeout(closeOverlay, 1500);
  }

  // ============================================
  // FEEDBACK
  // ============================================

  function setFeedbackMsg(message, tone) {
    feedbackMessage = message;
    feedbackTone = tone || 'info';
    const el = getFeedback();
    if (!el) return;
    el.textContent = message;
    el.className = `slash-feedback tone-${feedbackTone}`;
  }

  function clearFeedback() {
    feedbackMessage = null;
    const el = getFeedback();
    if (!el) return;
    el.textContent = '';
    el.className = 'slash-feedback hidden';
  }

  // ============================================
  // ACTIVATION: LISTEN FOR `/` KEYPRESS
  // ============================================

  function isInputElement(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute?.('role') === 'textbox') return true;
    return false;
  }

  document.addEventListener('keydown', (e) => {
    // Don't intercept if slash overlay is already open (let inner input handle it)
    if (isOpen) return;

    // Only trigger on `/` key
    if (e.key !== '/') return;

    // Don't trigger if user is typing in an input field
    if (isInputElement(document.activeElement)) return;

    // Don't trigger if any modifier keys are held
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Don't trigger if the Cmd+K overlay is open
    const cmdKOverlay = document.getElementById('canvascope-overlay-container');
    if (cmdKOverlay && cmdKOverlay.style.display !== 'none') return;

    e.preventDefault();
    e.stopPropagation();
    openOverlay();
  }, true);

  console.log('[Canvascope Slash] Overlay script loaded.');
})();
