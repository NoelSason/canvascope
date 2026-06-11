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
  const BODY_SEARCH_LIMIT = 12000;
  const BODY_RECALL_MIN_TOKEN_LENGTH = 5;

  // ============================================
  // SLASH COMMAND REGISTRY
  // ============================================

  function normalizeSlashAlias(value) {
    return String(value || '').trim().replace(/^\//, '').toLowerCase();
  }

  function buildSlashCommandLookup(commands) {
    const lookup = new Map();
    const list = Array.isArray(commands) ? commands : [];
    // Primary aliases are canonical commands and should win over someone
    // else's secondary alias. Example: external `/sync` must not be shadowed
    // by the built-in `/refresh` command's `sync` alias.
    for (const cmd of list) {
      const n = normalizeSlashAlias(cmd?.primaryAlias);
      if (n) lookup.set(n, cmd);
    }
    for (const cmd of list) {
      const aliases = Array.isArray(cmd?.aliases) ? cmd.aliases : [];
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

    const primaryAlias = normalizeSlashAlias(command?.primaryAlias);
    const aliases = (Array.isArray(command?.aliases) ? command.aliases : [])
      .map(normalizeSlashAlias).filter(Boolean);
    const title = (command?.title || '').toLowerCase();
    const description = (command?.description || '').toLowerCase();
    const keywords = (Array.isArray(command?.keywords) ? command.keywords : [])
      .map(k => (k || '').toLowerCase()).filter(Boolean);

    let score = -Infinity;
    if (primaryAlias) {
      if (primaryAlias === nq) return 240;
      if (primaryAlias.startsWith(nq)) score = Math.max(score, 170 - primaryAlias.length);
      if (primaryAlias.includes(nq)) score = Math.max(score, 140 - primaryAlias.length);
    }
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
      // Hidden commands are listed only when the user types something that
      // matches them (by alias/title/etc.), never in the default command
      // browser. Power users can still invoke them by name.
      if (cmd?.hidden && !nq) continue;
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
  const BODY_SEARCH_CACHE = new WeakMap();
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

  function getItemBodySearchText(item) {
    if (!item || typeof item !== 'object' || !item.content) return '';
    const raw = String(item.content || '');
    if (!raw) return '';

    const cacheKey = `${raw.length}:${raw.slice(0, 64)}`;
    const cached = BODY_SEARCH_CACHE.get(item);
    if (cached?.cacheKey === cacheKey) return cached.text;

    const text = normalizeText(raw.slice(0, BODY_SEARCH_LIMIT)).toLowerCase();
    BODY_SEARCH_CACHE.set(item, { cacheKey, text });
    return text;
  }

  function shouldRunBodyRecall(tokens, query) {
    if (!tokens.length) return false;
    if (tokens.some(token => token.length >= BODY_RECALL_MIN_TOKEN_LENGTH)) return true;
    return tokens.length >= 3 && String(query || '').length >= 8;
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

    // ── 6. Semantic Type Aliasing & Recency ──────────
    const itType = String(item?.type || '').toLowerCase();
    
    // Recency words
    const recencyKeys = ['latest', 'newest', 'recent', 'last', 'current'];
    const wantsRecency = recencyKeys.some(r => qTokens.includes(r));
    if (wantsRecency) {
      let fileTs = null;
      if (item.createdAt || item.updatedAt) fileTs = new Date(item.updatedAt || item.createdAt).getTime();
      else if (item.dueAt) fileTs = new Date(item.dueAt).getTime();
      
      if (fileTs && fileTs > 0 && fileTs <= Date.now()) {
        const daysAgo = (Date.now() - fileTs) / (1000 * 60 * 60 * 24);
        if (daysAgo <= 7) score += 0.50 + Math.max(0, 0.40 * (1 - daysAgo / 7));
        else if (daysAgo <= 30) score += 0.20 + Math.max(0, 0.30 * (1 - (daysAgo - 7) / 23));
      }
    }

    // Type checking
    if (qTokens.includes('worksheet') && ['file', 'assignment', 'pdf', 'document'].includes(itType)) score += 0.20;
    if ((qTokens.includes('lecture') || qTokens.includes('slide') || qTokens.includes('slides')) && ['file', 'page', 'pdf', 'slides', 'video'].includes(itType)) score += 0.20;
    if ((qTokens.includes('midterm') || qTokens.includes('exam')) && ['quiz', 'assignment', 'file', 'pdf'].includes(itType)) score += 0.20;

    // ── 7. Prefer shorter titles (Occam's razor) ─────
    if (title.length < 30) score += 0.05;
    if (title.length > 80) score -= 0.05;

    return Math.max(0, score);
  }

  function filterItems(items, query, limit) {
    if (!query || !query.trim()) {
      return items.slice(0, limit);
    }
    const qLower = query.toLowerCase().trim();
    const qTokens = qLower.split(/\s+/).filter(t => t.length > 0 && !STOP_WORDS.has(t));

    // 1. Lexical matching and scoring
    const lexicalRanked = items
      .map(item => ({ item, score: scoreItemMatch(item, query) }))
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(e => e.item);

    let literalRanked = lexicalRanked;
    if (shouldRunBodyRecall(qTokens, qLower)) {
      const seen = new Set(lexicalRanked.map(item => (item.id || item.url || item.title) + '|' + (item.courseName || '')));
      const bodyRanked = [];
      for (const item of items) {
        const key = (item.id || item.url || item.title) + '|' + (item.courseName || '');
        if (seen.has(key)) continue;
        const body = getItemBodySearchText(item);
        if (!body) continue;
        let hits = 0;
        for (const token of qTokens) {
          if (body.includes(token)) hits += 1;
        }
        if (hits === qTokens.length) {
          bodyRanked.push(item);
          seen.add(key);
        }
      }
      literalRanked = lexicalRanked.concat(bodyRanked);
    }

    // 2. Semantic matching and scoring (if SemanticMatcher is available)
    let semanticRanked = [];
    if (typeof SemanticMatcher !== 'undefined') {
      const queryVector = SemanticMatcher.vectorize(query);
      const hasConcepts = Object.values(queryVector).some(val => val > 0);

      if (hasConcepts) {
        const scoredSemantic = items.map(item => {
          const itemText = `${item.title || ''} ${item.courseName || ''} ${item.type || ''}`;
          const itemVector = SemanticMatcher.vectorize(itemText);
          const similarity = SemanticMatcher.cosineSimilarity(queryVector, itemVector);
          return { item, similarity };
        });

        semanticRanked = scoredSemantic
          .filter(x => x.similarity > 0.15)
          .sort((a, b) => b.similarity - a.similarity)
          .map(x => x.item);
      }
    }

    // 3. Blend rankings using Reciprocal Rank Fusion (RRF)
    let merged;
    if (typeof SemanticMatcher !== 'undefined' && (literalRanked.length > 0 || semanticRanked.length > 0)) {
      merged = SemanticMatcher.rrfMerge(
        literalRanked,
        semanticRanked,
        (item) => (item.id || item.url || item.title) + '|' + (item.courseName || '')
      );
    } else {
      merged = literalRanked;
    }

    return merged.slice(0, limit);
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

  async function fetchCustomTodos() {
    try {
      const { customTodos: todos } = await chrome.storage.local.get(['customTodos']);
      return Array.isArray(todos) ? todos : [];
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
      if (res?.signedIn) return res;

      await new Promise((resolve) => setTimeout(resolve, 120));
      const retry = await chrome.runtime.sendMessage({ type: 'checkAuthStatus' });
      return retry || res || { signedIn: false };
    } catch { return { signedIn: false }; }
  }

  async function fetchPinnedIds() {
    try {
      const result = await chrome.storage.local.get(['pinnedItems']);
      const ids = Array.isArray(result.pinnedItems) ? result.pinnedItems : [];
      return new Set(ids.filter(Boolean).map(String));
    } catch { return new Set(); }
  }

  async function persistPinnedIds(ids) {
    try {
      await chrome.storage.local.set({ pinnedItems: Array.from(ids) });
    } catch (e) { /* non-fatal */ }
  }

  function canonicalIdForItem(item) {
    if (!item || !item.url) return '__hash__' + ((item?.title || '') + '|' + (item?.courseName || '') + '|' + (item?.type || ''));
    try {
      const u = new URL(item.url);
      return `${u.origin}${u.pathname}`;
    } catch { return item.url; }
  }

  async function togglePinFromOverlay(item, btn) {
    if (!item) return;
    const id = canonicalIdForItem(item);
    if (pinnedIds.has(id)) {
      pinnedIds.delete(id);
    } else {
      pinnedIds.add(id);
      if (btn) {
        btn.classList.remove('is-flash');
        void btn.offsetWidth;
        btn.classList.add('is-flash');
      }
    }
    await persistPinnedIds(pinnedIds);
    // Re-render to refresh pinned section visibility + star states
    renderResults();
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

  // External command pack registry. Other content scripts (e.g.
  // slash-commands-pack.js) call window.__canvascopeRegisterSlashCommands(cmds)
  // to add commands without editing this file. Each external command may
  // provide a buildResults(argumentText, ctx) function returning entries with
  // { kind, title, subtitle, icon, badge, onSelect }.
  const EXTERNAL_COMMANDS = [];
  const EXTERNAL_COMMAND_IDS = new Set();

  function registerExternalSlashCommands(commands) {
    if (!Array.isArray(commands)) return false;
    let added = 0;
    for (const cmd of commands) {
      if (!cmd || typeof cmd !== 'object') continue;
      const id = String(cmd.id || cmd.primaryAlias || '').trim();
      if (!id || EXTERNAL_COMMAND_IDS.has(id)) continue;
      EXTERNAL_COMMAND_IDS.add(id);
      EXTERNAL_COMMANDS.push({ ...cmd, id });
      added += 1;
    }
    if (added > 0 && isOpen) {
      try { renderResults(); } catch (_) { /* ignore */ }
    }
    return added > 0;
  }

  // Expose globally so other content scripts can register their own commands.
  try {
    window.__canvascopeRegisterSlashCommands = registerExternalSlashCommands;
  } catch (_) { /* ignore */ }

  function getSlashContext() {
    return {
      indexedContent,
      customTodos,
      extensionSettings,
      authStatus,
      pinnedIds,
      setFeedbackMsg,
      clearFeedback,
      closeOverlay,
      executeOpenUrl,
      filterItems,
      parseDueTs,
      formatDueLabel,
      SLASH_RESULT_LIMIT
    };
  }

  function getCommandRegistry() {
    const builtIns = [
      {
        order: 0, id: 'lectra-send', primaryAlias: 'ls',
        aliases: ['lectra', 'lectra-send'],
        title: 'Send to Lectra',
        description: 'Find an indexed PDF and send it to Lectra.',
        keywords: ['pdf', 'send', 'lectra', 'annotate'],
        icon: 'pdf', badge: 'Send', needsArgument: true
      },
      {
        order: 1, id: 'gradescope', primaryAlias: 'gs',
        aliases: ['gradescope'],
        title: 'Gradescope',
        description: 'Open gradescope.com in a new tab.',
        keywords: ['gradescope', 'grade', 'open'],
        icon: 'cap', badge: 'Open', needsArgument: false
      },
      {
        order: 2, id: 'course', primaryAlias: 'course',
        aliases: ['class', 'courses'],
        title: 'Jump to course',
        description: 'Open one of your indexed courses.',
        keywords: ['course', 'class', 'dashboard', 'open'],
        icon: 'books', badge: 'Go', needsArgument: true
      },
      {
        order: 3, id: 'due', primaryAlias: 'due',
        aliases: ['tasks'],
        title: 'Planner',
        description: 'Browse upcoming and overdue work.',
        keywords: ['due', 'task', 'assignment', 'quiz'],
        icon: 'cal', badge: 'View', needsArgument: true
      },
      {
        order: 4, id: 'refresh', primaryAlias: 'refresh',
        aliases: ['sync'],
        title: 'Re-sync',
        description: 'Kick off a fresh Canvascope sync.',
        keywords: ['refresh', 'sync', 'scan', 'index'],
        icon: 'sync', badge: 'Sync', needsArgument: false
      },
      {
        order: 5, id: 'browse', primaryAlias: 'browse',
        aliases: ['all'],
        title: 'Browse all',
        description: 'Open all indexed content in the popup.',
        keywords: ['browse', 'all', 'index', 'content'],
        icon: 'book', badge: 'Browse', needsArgument: false
      },
      {
        order: 6, id: 'pin', primaryAlias: 'pin',
        aliases: ['pinned', 'pins'],
        title: 'View pinned',
        description: "Show everything you've pinned.",
        keywords: ['pin', 'pinned', 'favorite', 'starred'],
        icon: 'pin', badge: 'View', needsArgument: false
      },
      {
        order: 7, id: 'dash', primaryAlias: 'dash',
        aliases: ['home', 'dashboard'],
        title: 'Canvas dashboard',
        description: 'Jump to your LMS home.',
        keywords: ['dashboard', 'home', 'canvas'],
        icon: 'home', badge: 'Open', needsArgument: false
      }
    ];
    // Merge external commands (registered via window.__canvascopeRegisterSlashCommands).
    // External commands are pushed after built-ins so their default `order` slots them
    // below built-ins unless they specify a lower value.
    return [...builtIns, ...EXTERNAL_COMMANDS];
  }

  // Lightweight inline SVG icon set matching Direction B
  const ICON_SVGS = {
    pdf:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h7l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v4h4"/><path d="M9 14h6M9 17h4"/></svg>',
    cap:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-4 9 4-9 4z"/><path d="M7 11v4c0 1.5 2.5 3 5 3s5-1.5 5-3v-4"/></svg>',
    books: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h5v16H4zM10 4h5v16h-5z"/><path d="m16 5 4 1-3 14-4-1z"/></svg>',
    cal:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    sync:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
    book:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 1 2-2h13"/></svg>',
    pin:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l-1 5 3 4H7l3-4z"/></svg>',
    home:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/></svg>',
    star:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8L6.7 19.6l1-6L3.3 9.4l6-.9z"/></svg>',
    warn:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 10 18H2z"/><path d="M12 9v4M12 17h.01"/></svg>',
    bolt:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>'
  };

  function getIconMarkup(name) {
    return ICON_SVGS[name] || ICON_SVGS.bolt;
  }

  // ============================================
  // OVERLAY STATE
  // ============================================

  let overlayRoot = null;
  let shadowRoot = null;
  let isOpen = false;
  let indexedContent = [];
  let customTodos = [];
  let extensionSettings = {};
  let authStatus = { signedIn: false };
  let pinnedIds = new Set();
  let highlightedIndex = 0;
  let currentEntries = [];
  let feedbackMessage = null;
  let feedbackTone = 'info';

  // ============================================
  // SHADOW DOM + CSS
  // ============================================

  const OVERLAY_CSS = `
    :host {
      all: initial;
      display: block;
      --bg:           #0a0a0d;
      --bg-soft:      #0e0e12;
      --surface:      #14141a;
      --surface-2:    #1b1b22;
      --surface-3:    #22222a;
      --border:       #22222a;
      --border-hi:    #32323c;
      --border-hot:   rgba(185, 165, 255, 0.34);
      --text:         #ececef;
      --text-dim:     #9b9ba6;
      --muted:        #65656f;
      --dim:          #4b4b55;
      --accent:       #b9a5ff;
      --accent-sat:   #c9b9ff;
      --accent-bg:    rgba(185, 165, 255, 0.14);
      --accent-bg-hi: rgba(185, 165, 255, 0.20);
      --on-accent:    #181226;
      --ok:           #6fce9a;
      --warn:         #e8b770;
      --bad:          #e57373;
      --r-1: 2px;
      --r-2: 4px;
      --r-3: 6px;
      --r-4: 8px;
      --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, ui-sans-serif, system-ui, sans-serif;
      --font-mono: 'Geist Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace;
    }

    /* Light surface — applied when the host carries .cs-slash-theme-light
       (set from the live Canvas skin mode). Mirrors the popup's light ramp so
       the palette reads as the same product UI, not a dark box on a light page. */
    :host(.cs-slash-theme-light) {
      --bg:           #f5f5f8;
      --bg-soft:      #ffffff;
      --surface:      #f3f2f8;
      --surface-2:    #ecebf4;
      --surface-3:    #e3e2ec;
      --border:       #e6e5ef;
      --border-hi:    #d2d0e0;
      --border-hot:   rgba(122, 92, 240, 0.34);
      --text:         #1a1a22;
      --text-dim:     #4e4e5c;
      --muted:        #74747f;
      --dim:          #9b9ba6;
      --accent:       #7a5cf0;
      --accent-sat:   #6847e0;
      --accent-bg:    rgba(122, 92, 240, 0.10);
      --accent-bg-hi: rgba(122, 92, 240, 0.16);
      --on-accent:    #ffffff;
      --ok:           #2e9e67;
      --warn:         #b07c28;
      --bad:          #cc4f4f;
    }
    :host(.cs-slash-theme-light) .slash-backdrop {
      background: rgba(20, 18, 40, 0.22);
    }
    :host(.cs-slash-theme-light) .slash-panel {
      box-shadow:
        0 24px 60px rgba(20, 18, 40, 0.20),
        0 2px 8px rgba(20, 18, 40, 0.08),
        0 0 0 1px rgba(20, 18, 40, 0.05);
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
      background: rgba(0, 0, 0, 0.40);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
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
      top: 12vh;
      left: 50%;
      transform: translateX(-50%) scale(0.96);
      z-index: 2147483647;
      width: 720px;
      max-width: calc(100vw - 32px);
      opacity: 0;
      transition: opacity ${ANIMATION_DURATION_MS}ms ease,
                  transform ${ANIMATION_DURATION_MS}ms cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      font-family: var(--font-sans);
      font-size: 14px;
      color: var(--text);
      letter-spacing: 0;
      -webkit-font-smoothing: antialiased;
      font-variant-numeric: tabular-nums;
    }

    .slash-container.visible {
      opacity: 1;
      transform: translateX(-50%) scale(1);
      pointer-events: auto;
    }

    .slash-panel {
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: var(--r-4);
      box-shadow:
        0 24px 70px rgba(0, 0, 0, 0.48),
        0 0 0 1px rgba(255, 255, 255, 0.02);
      overflow: hidden;
      position: relative;
    }

    /* ---------- SEARCH BAR ---------- */
    .slash-search-bar {
      position: relative;
      display: flex;
      align-items: center;
      height: 56px;
      padding: 0 18px;
      gap: 12px;
      border-bottom: 1px solid var(--border);
    }

    .slash-prefix {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--r-2);
      background: var(--accent);
      color: var(--on-accent);
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 600;
      line-height: 1;
    }

    .slash-input {
      flex: 1;
      background: none;
      border: none;
      outline: none;
      color: var(--text);
      font-size: 15px;
      font-family: var(--font-mono);
      font-weight: 500;
      letter-spacing: 0;
      padding: 0;
      caret-color: var(--accent);
    }

    .slash-input::placeholder {
      color: var(--muted);
      font-weight: 400;
    }

    .slash-close-btn {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      height: 18px;
      padding: 0 6px;
      border: 1px solid var(--border-hi);
      border-radius: var(--r-1);
      background: var(--surface-2);
      color: var(--text-dim);
      font-family: var(--font-mono);
      font-size: 10.5px;
      letter-spacing: 0;
      text-transform: lowercase;
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
    }

    .slash-close-btn:hover {
      background: var(--surface-3);
      border-color: var(--border-hot);
      color: var(--accent);
    }

    /* ---------- RESULTS ---------- */
    .slash-body {
      max-height: min(520px, calc(78vh - 100px));
      overflow-y: auto;
      padding: 8px 0;
      position: relative;
      z-index: 1;
    }

    .slash-body::-webkit-scrollbar {
      width: 6px;
    }
    .slash-body::-webkit-scrollbar-track {
      background: transparent;
    }
    .slash-body::-webkit-scrollbar-thumb {
      background: var(--border-hi);
      border-radius: var(--r-1);
    }
    .slash-body::-webkit-scrollbar-thumb:hover {
      background: var(--muted);
    }

    .slash-section-label {
      font-family: var(--font-sans);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0;
      text-transform: none;
      color: var(--muted);
      padding: 8px 18px 4px;
      display: block;
    }

    @keyframes slash-row-in {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .slash-item { animation: none !important; }
    }

    .slash-item {
      display: grid;
      grid-template-columns: 36px 1fr auto;
      column-gap: 14px;
      row-gap: 0;
      align-items: center;
      padding: 12px 18px;
      margin: 0;
      border-radius: 0;
      border: none;
      cursor: pointer;
      transition: background 120ms cubic-bezier(.2,.8,.2,1);
      width: 100%;
      text-align: left;
      background: none;
      color: inherit;
      font-family: inherit;
      font-size: inherit;
      position: relative;
      animation: slash-row-in 160ms cubic-bezier(.2,.8,.2,1) backwards;
    }
    .slash-item:nth-child(2)  { animation-delay: 18ms; }
    .slash-item:nth-child(3)  { animation-delay: 36ms; }
    .slash-item:nth-child(4)  { animation-delay: 54ms; }
    .slash-item:nth-child(5)  { animation-delay: 72ms; }
    .slash-item:nth-child(6)  { animation-delay: 90ms; }
    .slash-item:nth-child(n+7) { animation-delay: 104ms; }

    .slash-item:hover {
      background: var(--surface);
    }
    .slash-item.active {
      background: var(--surface);
    }

    .slash-item-icon {
      width: 36px;
      height: 36px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--r-3);
      background: var(--surface-2);
      border: none;
      color: var(--text-dim);
      font-size: 16px;
      grid-row: 1 / 2;
      grid-column: 1 / 2;
    }
    .slash-item.active .slash-item-icon {
      background: var(--accent-bg);
      color: var(--accent);
    }

    .slash-item-copy {
      grid-row: 1 / 2;
      grid-column: 2 / 3;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .slash-item-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
      letter-spacing: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .slash-item-title::first-line { color: var(--text); }

    /* When title contains "/alias Label" pattern, the first token gets mono+accent on active.
       The renderer concatenates "/<alias>  <Label>" with a span split below. */
    .slash-item-title .slash-cmd-alias {
      font-family: var(--font-mono);
      font-size: 13.5px;
      color: var(--text);
    }
    .slash-item.active .slash-item-title .slash-cmd-alias {
      color: var(--accent);
    }
    .slash-item-title .slash-cmd-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
    }

    .slash-item-subtitle {
      font-family: var(--font-sans);
      font-size: 11.5px;
      color: var(--muted);
      letter-spacing: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .slash-item-badge {
      display: none;
    }

    .slash-item-enter {
      grid-row: 1 / 2;
      grid-column: 3 / 4;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--accent);
      opacity: 0;
      transition: opacity 120ms ease;
      align-self: center;
    }
    .slash-item.active .slash-item-enter {
      opacity: 1;
    }

    /* ---------- PIN TOGGLE ---------- */
    .slash-pin-toggle {
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: var(--dim);
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      border-radius: 4px;
      grid-row: 1 / 2;
      grid-column: 3 / 4;
      transition: color 120ms cubic-bezier(.2,.8,.2,1),
                  background 120ms cubic-bezier(.2,.8,.2,1),
                  transform 200ms cubic-bezier(.2,.8,.2,1);
    }
    .slash-pin-toggle:hover {
      color: var(--accent);
      background: var(--surface-2);
    }
    .slash-pin-toggle.is-pinned {
      color: var(--accent);
    }
    .slash-pin-toggle svg {
      width: 13px;
      height: 13px;
      display: block;
      stroke-width: 1.7;
    }
    .slash-pin-toggle.is-flash {
      animation: slash-pin-flash 360ms cubic-bezier(.2,.8,.2,1);
    }
    @keyframes slash-pin-flash {
      0%   { transform: scale(1);    color: var(--dim); }
      40%  { transform: scale(1.3);  color: var(--warn); }
      100% { transform: scale(1);    color: var(--accent); }
    }

    /* ---------- FEEDBACK ---------- */
    .slash-feedback {
      margin: 8px 18px 0;
      padding: 10px 14px;
      border-radius: var(--r-3);
      font-size: 12.5px;
      line-height: 1.45;
      border: 1px solid transparent;
    }
    .slash-feedback.hidden { display: none; }
    .slash-feedback.tone-success {
      background: rgba(124, 194, 150, 0.10);
      border-color: rgba(124, 194, 150, 0.22);
      color: var(--ok);
    }
    .slash-feedback.tone-error {
      background: rgba(232, 138, 138, 0.10);
      border-color: rgba(232, 138, 138, 0.24);
      color: var(--bad);
    }
    .slash-feedback.tone-info {
      background: var(--surface);
      border-color: var(--border);
      color: var(--text-dim);
    }

    /* ---------- EMPTY STATE ---------- */
    .slash-empty {
      padding: 40px 20px;
      text-align: center;
      font-size: 12.5px;
      color: var(--muted);
    }

    /* ---------- FOOTER ---------- */
    .slash-footer {
      display: flex;
      align-items: center;
      gap: 14px;
      height: 44px;
      padding: 0 18px;
      border-top: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 10.5px;
      letter-spacing: 0;
      text-transform: uppercase;
      color: var(--muted);
      position: relative;
      z-index: 1;
    }

    .slash-footer-brand {
      color: var(--accent);
      font-weight: 500;
    }

    .slash-footer-keys {
      display: flex;
      gap: 14px;
      align-items: center;
      margin-left: auto;
    }

    .slash-footer-key-group {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--muted);
    }

    .slash-footer-keys kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: var(--r-1);
      border: 1px solid var(--border-hi);
      background: var(--surface-2);
      font-family: var(--font-mono);
      font-size: 10.5px;
      color: var(--text-dim);
      line-height: 1;
    }

    .slash-item-badge.badge-setup {
      display: inline-flex;
      background: var(--surface-2);
      color: var(--warn);
      border: 1px solid var(--border-hi);
      padding: 3px 7px;
      border-radius: var(--r-2);
      font-size: 10px;
      letter-spacing: 0;
      text-transform: uppercase;
      font-family: var(--font-mono);
      align-self: center;
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

    // Footer (Direction B)
    const footer = document.createElement('div');
    footer.className = 'slash-footer';

    const brand = document.createElement('span');
    brand.className = 'slash-footer-brand';
    brand.textContent = 'Canvascope';
    footer.appendChild(brand);

    const keys = document.createElement('div');
    keys.className = 'slash-footer-keys';
    keys.innerHTML = `
      <span class="slash-footer-key-group"><kbd>↑↓</kbd>Navigate</span>
      <span class="slash-footer-key-group"><kbd>↵</kbd>Run</span>
      <span class="slash-footer-key-group"><kbd>esc</kbd>Close</span>
    `;
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

  // The overlay lives in a closed shadow root, so it can't inherit the page's
  // theme. canvas-skin.js resolves the effective Canvas mode (incl.
  // auto/system/scheduled) and reflects it as a class on <html>; we read that
  // so the palette matches the page it's drawn over. No skin class → stock
  // Canvas/LMS, which is light.
  function resolveOverlayThemeMode() {
    const cls = document.documentElement.classList;
    if (cls.contains('cs-skin-mode-dark')) return 'dark';
    if (cls.contains('cs-skin-mode-light')) return 'light';
    return 'light';
  }

  function applyOverlayTheme() {
    if (!overlayRoot) return;
    overlayRoot.classList.toggle('cs-slash-theme-light', resolveOverlayThemeMode() === 'light');
  }

  async function openOverlay() {
    if (isOpen) return;
    if (!overlayRoot) createOverlayDOM();
    applyOverlayTheme();

    isOpen = true;
    highlightedIndex = 0;
    currentEntries = [];
    feedbackMessage = null;

    // Fetch data in parallel
    const [content, settings, auth, pins, todos] = await Promise.all([
      fetchIndexedContent(),
      fetchExtensionSettings(),
      fetchAuthStatus(),
      fetchPinnedIds(),
      fetchCustomTodos()
    ]);
    indexedContent = content;
    extensionSettings = settings;
    authStatus = auth;
    pinnedIds = pins;
    customTodos = todos;

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

  function getPinnedEntries() {
    if (!pinnedIds || pinnedIds.size === 0) return [];
    if (!Array.isArray(indexedContent) || indexedContent.length === 0) return [];
    const byId = new Map();
    indexedContent.forEach(item => byId.set(canonicalIdForItem(item), item));
    const out = [];
    pinnedIds.forEach(id => {
      const item = byId.get(id);
      if (!item) return;
      out.push({
        kind: 'item',
        item,
        title: item.title || 'Untitled',
        subtitle: [item.courseName, item.moduleName].filter(Boolean).join(' › '),
        icon: 'star',
        badge: 'Pinned',
        onSelect: () => executeOpenUrl(item.url)
      });
    });
    return out.slice(0, 12);
  }

  function renderResults() {
    const body = getBody();
    if (!body) return;

    const input = getInput();
    const rawValue = '/' + (input?.value || '');
    const commands = getCommandRegistry();
    const lookup = buildSlashCommandLookup(commands);
    const parsed = parseSlashInput(rawValue, lookup);

    let primaryEntries = [];
    let primaryLabel = '';

    if (parsed.mode === 'commands') {
      const matching = rankSlashCommands(commands, parsed.commandQuery);
      primaryEntries = matching.map(cmd => ({
        kind: 'command',
        command: cmd,
        title: `/${cmd.primaryAlias}`,
        commandLabel: cmd.title || '',
        subtitle: cmd.description,
        icon: cmd.icon,
        badge: null,
        onSelect: () => selectCommand(cmd)
      }));
      primaryLabel = 'Commands';
    } else if (parsed.exactCommand) {
      primaryEntries = buildCommandResults(parsed.exactCommand, parsed.argumentText);
      primaryLabel = `/${parsed.exactCommand.primaryAlias}`;
    }

    // Pinned section is shown only when input is empty (the bare "/" case)
    const showPinned = parsed.mode === 'commands' && !parsed.commandQuery;
    const pinnedEntries = showPinned ? getPinnedEntries() : [];

    const sections = [];
    if (pinnedEntries.length > 0) sections.push({ label: 'Pinned', entries: pinnedEntries });
    if (primaryEntries.length > 0) sections.push({ label: primaryLabel, entries: primaryEntries });

    const flatEntries = sections.flatMap(s => s.entries);
    currentEntries = flatEntries;
    highlightedIndex = flatEntries.length > 0 ? Math.min(highlightedIndex, flatEntries.length - 1) : 0;

    body.innerHTML = '';

    if (flatEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'slash-empty';
      empty.textContent = parsed.mode === 'commands'
        ? `No commands matched "/${parsed.commandQuery}".`
        : getEmptyCopy(parsed.exactCommand, parsed.argumentText);
      body.appendChild(empty);
      return;
    }

    let runningIdx = 0;
    sections.forEach(section => {
      const label = document.createElement('div');
      label.className = 'slash-section-label';
      label.textContent = section.label;
      body.appendChild(label);

      section.entries.forEach(entry => {
        const idx = runningIdx++;
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
        const iconKey = entry.icon || 'bolt';
        iconEl.innerHTML = getIconMarkup(iconKey);
        btn.appendChild(iconEl);

        const copy = document.createElement('div');
        copy.className = 'slash-item-copy';

        const titleEl = document.createElement('div');
        titleEl.className = 'slash-item-title';
        if (entry.kind === 'command' && entry.commandLabel) {
          const alias = document.createElement('span');
          alias.className = 'slash-cmd-alias';
          alias.textContent = entry.title;
          titleEl.appendChild(alias);
          const label = document.createElement('span');
          label.className = 'slash-cmd-label';
          label.textContent = entry.commandLabel;
          titleEl.appendChild(label);
        } else {
          titleEl.textContent = entry.title;
        }
        copy.appendChild(titleEl);

        if (entry.subtitle) {
          const subEl = document.createElement('div');
          subEl.className = 'slash-item-subtitle';
          subEl.textContent = entry.subtitle;
          copy.appendChild(subEl);
        }
        btn.appendChild(copy);

        // Direction B: hide the badge chips for normal rows; only show
        // for setup-warning rows (badge_setup styling).
        if (entry.badge && entry.badgeClass === 'badge-setup') {
          const badgeEl = document.createElement('span');
          badgeEl.className = 'slash-item-badge ' + entry.badgeClass;
          badgeEl.textContent = entry.badge;
          btn.appendChild(badgeEl);
        } else if (!(entry.kind === 'item' && entry.item && entry.item.url)) {
          // Enter indicator — visible only on active row via CSS
          const enterEl = document.createElement('span');
          enterEl.className = 'slash-item-enter';
          enterEl.textContent = '↵';
          btn.appendChild(enterEl);
        }

        // Pin toggle on real item rows (skip commands / actions / guidance)
        if (entry.kind === 'item' && entry.item && entry.item.url) {
          const id = canonicalIdForItem(entry.item);
          const pinned = pinnedIds.has(id);
          const pinBtn = document.createElement('button');
          pinBtn.type = 'button';
          pinBtn.className = 'slash-pin-toggle' + (pinned ? ' is-pinned' : '');
          pinBtn.innerHTML = getIconMarkup('star');
          pinBtn.setAttribute('aria-label', pinned ? 'Unpin item' : 'Pin item');
          pinBtn.addEventListener('mousedown', e => e.preventDefault());
          pinBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await togglePinFromOverlay(entry.item, pinBtn);
          });
          btn.appendChild(pinBtn);
        }

        body.appendChild(btn);
      });
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
      case 'dash': return buildDashResults(cmd);
      default: {
        // External commands provide their own buildResults handler.
        if (typeof cmd.buildResults === 'function') {
          try {
            const entries = cmd.buildResults(argumentText, getSlashContext()) || [];
            return Array.isArray(entries) ? entries : [];
          } catch (err) {
            console.error('[Canvascope Slash] External command failed:', cmd?.id, err);
            return [{
              kind: 'guidance', command: cmd,
              title: 'Command failed to load',
              subtitle: String(err?.message || err),
              icon: 'bolt'
            }];
          }
        }
        return [];
      }
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
        icon: 'warn', badge: 'Setup', badgeClass: 'badge-setup',
        onSelect: () => setFeedbackMsg(reason, 'info')
      }];
    }

    const pdfs = indexedContent.filter(isSlashPdfEligible);
    const filtered = filterItems(pdfs, query, SLASH_RESULT_LIMIT);
    return filtered.map(item => ({
      kind: 'item', command: cmd, item,
      title: item.title || 'Untitled PDF',
      subtitle: [item.courseName, item.moduleName].filter(Boolean).join(' › '),
      icon: 'pdf', badge: 'Send',
      onSelect: () => executeLectraSend(item)
    }));
  }

  function buildGradescopeResults(cmd) {
    return [{
      kind: 'action', command: cmd,
      title: 'Open Gradescope',
      subtitle: 'Launch gradescope.com in a new tab.',
      icon: 'cap', badge: 'Open',
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
      icon: 'books', badge: 'Go',
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
      icon: 'cal', badge: formatDueLabel(item),
      onSelect: () => executeOpenUrl(item.url)
    }));
  }

  function buildRefreshResults(cmd) {
    return [{
      kind: 'action', command: cmd,
      title: 'Refresh Canvascope Index',
      subtitle: 'Trigger a fresh sync for the current LMS tab.',
      icon: 'sync', badge: 'Sync',
      onSelect: () => executeRefresh()
    }];
  }

  function buildDashResults(cmd) {
    let dashUrl = '';
    try { dashUrl = window.location.origin + '/'; } catch (_) { dashUrl = ''; }
    let host = '';
    try { host = window.location.hostname; } catch (_) { host = ''; }
    return [{
      kind: 'action', command: cmd,
      title: 'Open LMS dashboard',
      subtitle: dashUrl ? `Go to ${host || dashUrl}` : 'Open this LMS at its root URL.',
      icon: 'home', badge: 'Open',
      onSelect: () => {
        if (dashUrl) {
          try { window.location.href = dashUrl; }
          catch (_) { executeOpenUrl(dashUrl); }
        }
      }
    }];
  }

  function buildBrowseResults(cmd) {
    return [{
      kind: 'action', command: cmd,
      title: 'Browse All Indexed Content',
      subtitle: 'Open the all-content browser in the popup.',
      icon: 'book', badge: 'Browse',
      onSelect: () => executeBrowse()
    }];
  }

  function getEmptyCopy(cmd, query) {
    const q = (query || '').trim();
    switch (cmd?.id) {
      case 'lectra-send': return q ? `No PDFs matched "${q}".` : 'No indexed PDFs found.';
      case 'course': return q ? `No courses matched "${q}".` : 'No indexed courses found.';
      case 'due': return q ? `No due items matched "${q}".` : 'No upcoming due items.';
      default:
        if (typeof cmd?.emptyCopy === 'function') {
          try { return cmd.emptyCopy(q) || 'No results.'; } catch (_) { return 'No results.'; }
        }
        return cmd?.emptyCopy || 'No results.';
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
      Promise.resolve(entry.onSelect()).catch((error) => {
        console.error('[Canvascope Slash] Command execution failed:', error);
        setFeedbackMsg('Command failed. Try again.', 'error');
      });
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
    window.open('https://www.gradescope.com/', '_blank', 'noopener,noreferrer');
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
