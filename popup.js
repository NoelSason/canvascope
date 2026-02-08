/**
 * ============================================
 * Canvas Search - Popup Script (popup.js)
 * ============================================
 * 
 * PURPOSE:
 * - Displays search UI for indexed Canvas content
 * - Shows sync status from background worker
 * - Allows browsing all indexed content
 * 
 * NOTE: Scanning now happens automatically in the background.
 * This script just displays the results.
 * 
 * ============================================
 */

// ============================================
// CONFIGURATION
// ============================================

const FUSE_OPTIONS = {
  threshold: 0.4,
  includeScore: true,
  includeMatches: true,
  minMatchCharLength: 2,
  keys: [
    { name: 'title', weight: 3.0 },
    { name: 'moduleName', weight: 1.5 },
    { name: 'courseName', weight: 1.2 },
    { name: 'type', weight: 0.5 }
  ]
};

const MAX_RESULTS = 20;
const SEARCH_DEBOUNCE_MS = 150;
const MAX_HISTORY = 10;

// Type boost values for ranking
const TYPE_BOOST = {
  assignment: 0.30,
  quiz: 0.25,
  discussion: 0.20,
  page: 0.15,
  file: 0.10,
  pdf: 0.10,
  video: 0.08,
  externalurl: 0.05
};

// ============================================
// DOM ELEMENTS
// ============================================

const elements = {};

// ============================================
// STATE
// ============================================

let state = {
  fuse: null,
  indexedContent: [],
  filteredContent: [],
  searchTimeout: null,
  isScanning: false,
  filters: {
    course: '',
    type: ''
  },
  searchHistory: [],
  courses: []
};

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Canvas Search] Popup opened');
  initializeElements();
  setupEventListeners();
  await loadContent();
  await loadSearchHistory();
  initializeFuse();
  updateUI();
  elements.searchInput.focus();

  // Request status from background
  getBackgroundStatus();

  // Check if current tab is Canvas and auto-detect domain
  checkCurrentTab();
});

function initializeElements() {
  elements.searchInput = document.getElementById('search-input');
  elements.clearSearchBtn = document.getElementById('clear-search');
  elements.resultsContainer = document.getElementById('results-container');
  elements.emptyState = document.getElementById('empty-state');
  elements.refreshBtn = document.getElementById('refresh-btn');
  elements.clearDataBtn = document.getElementById('clear-data-btn');
  elements.statusText = document.getElementById('status-text');
  elements.statsText = document.getElementById('stats-text');
  elements.statsBtn = document.getElementById('stats-btn');
  elements.statsHint = document.getElementById('stats-hint');
  elements.syncStatus = document.getElementById('sync-status');
  elements.syncIcon = document.getElementById('sync-icon');
  elements.syncText = document.getElementById('sync-text');
  elements.browseModal = document.getElementById('browse-modal');
  elements.closeBrowse = document.getElementById('close-browse');
  elements.browseTabs = document.getElementById('browse-tabs');
  elements.browseContent = document.getElementById('browse-content');

  // Filter elements
  elements.filterCourse = document.getElementById('filter-course');
  elements.filterType = document.getElementById('filter-type');
  elements.searchHistory = document.getElementById('search-history');
}

function setupEventListeners() {
  elements.searchInput.addEventListener('input', handleSearchInput);
  elements.searchInput.addEventListener('focus', showSearchHistory);
  elements.searchInput.addEventListener('blur', () => {
    setTimeout(hideSearchHistory, 150);
  });
  elements.clearSearchBtn.addEventListener('click', clearSearch);
  elements.refreshBtn.addEventListener('click', handleRefresh);
  elements.clearDataBtn.addEventListener('click', handleClearData);
  elements.statsBtn.addEventListener('click', openBrowseModal);
  elements.closeBrowse.addEventListener('click', closeBrowseModal);

  // Filter event listeners
  elements.filterCourse.addEventListener('change', handleFilterChange);
  elements.filterType.addEventListener('change', handleFilterChange);

  // Listen for background updates
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

// ============================================
// BACKGROUND COMMUNICATION
// ============================================

async function getBackgroundStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (response) {
      state.isScanning = response.isScanning;
      updateSyncStatus(response);
    }
  } catch (e) {
    console.log('[Canvas Search] Could not get background status');
  }
}

/**
 * Check current tab for Canvas and auto-detect domain
 */
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    const url = new URL(tab.url);
    const hostname = url.hostname.toLowerCase();

    // Skip if already a known domain pattern
    if (hostname.endsWith('.instructure.com')) return;

    // Try to detect Canvas from URL patterns (content script may not be loaded)
    if (url.pathname.includes('/courses/') ||
      url.pathname.includes('/assignments/') ||
      url.pathname.includes('/modules') ||
      url.pathname.includes('/quizzes')) {
      // Likely Canvas, add domain
      await chrome.runtime.sendMessage({ action: 'addDomain', domain: hostname });
      console.log('[Canvas Search] Auto-detected Canvas domain from URL:', hostname);
    }
  } catch (e) {
    // Silently ignore - this is expected when not on a Canvas page
  }
}

function handleBackgroundMessage(message) {
  console.log('[Canvas Search] Background message:', message.type);

  switch (message.type) {
    case 'scanStarted':
      state.isScanning = true;
      showScanningStatus();
      break;

    case 'scanProgress':
      updateScanProgress(message.progress, message.status);
      break;

    case 'scanComplete':
      state.isScanning = false;
      loadContent().then(() => {
        initializeFuse();
        updateUI();
        showSyncedStatus(`Added ${message.newItems} new items`);
      });
      break;

    case 'scanError':
      state.isScanning = false;
      showErrorStatus(message.error);
      break;
  }
}

// ============================================
// SYNC STATUS UI
// ============================================

function updateSyncStatus(status) {
  if (status.isScanning) {
    showScanningStatus();
  } else {
    const lastScan = status.lastScan;
    if (lastScan > 0) {
      const ago = getTimeAgo(lastScan);
      showSyncedStatus(`Last synced ${ago}`);
    } else {
      showSyncedStatus('Open Canvas to sync');
    }
  }
}

function showScanningStatus() {
  elements.syncIcon.textContent = '⟳';
  elements.syncIcon.classList.add('spinning');
  elements.syncText.textContent = 'Syncing...';
  elements.syncStatus.className = 'sync-status syncing';
}

function showSyncedStatus(text = 'Synced') {
  elements.syncIcon.textContent = '✓';
  elements.syncIcon.classList.remove('spinning');
  elements.syncText.textContent = text;
  elements.syncStatus.className = 'sync-status synced';
}

function showErrorStatus(text = 'Sync failed') {
  elements.syncIcon.textContent = '!';
  elements.syncIcon.classList.remove('spinning');
  elements.syncText.textContent = text;
  elements.syncStatus.className = 'sync-status error';
}

function updateScanProgress(progress, status) {
  elements.syncText.textContent = status || `Syncing... ${progress}%`;
}

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ============================================
// SEARCH FUNCTIONALITY
// ============================================

function initializeFuse() {
  applyFilters();
  if (state.filteredContent.length > 0) {
    state.fuse = new Fuse(state.filteredContent, FUSE_OPTIONS);
  } else {
    state.fuse = null;
  }
  populateCourseFilter();
}

function applyFilters() {
  state.filteredContent = state.indexedContent.filter(item => {
    if (state.filters.course && item.courseName !== state.filters.course) return false;
    if (state.filters.type && item.type !== state.filters.type) return false;
    return true;
  });
}

function handleFilterChange() {
  state.filters.course = elements.filterCourse.value;
  state.filters.type = elements.filterType.value;
  initializeFuse();

  // Re-run search if there's a query
  const query = elements.searchInput.value.trim();
  if (query.length > 0) {
    performSearch(query);
  }
}

function populateCourseFilter() {
  // Get unique courses
  const courses = [...new Set(state.indexedContent.map(item => item.courseName).filter(Boolean))];
  courses.sort();
  state.courses = courses;

  // Clear and repopulate
  elements.filterCourse.innerHTML = '<option value="">All Courses</option>';
  courses.forEach(course => {
    const option = document.createElement('option');
    option.value = course;
    option.textContent = course.length > 30 ? course.substring(0, 30) + '...' : course;
    elements.filterCourse.appendChild(option);
  });
}

function handleSearchInput(event) {
  const query = event.target.value.trim();
  elements.clearSearchBtn.classList.toggle('visible', query.length > 0);
  hideSearchHistory();

  if (state.searchTimeout) {
    clearTimeout(state.searchTimeout);
  }

  if (query.length === 0) {
    showEmptyState();
    return;
  }

  state.searchTimeout = setTimeout(() => {
    performSearch(query);
  }, SEARCH_DEBOUNCE_MS);
}

function performSearch(query) {
  if (!state.fuse) {
    showNoResults('No content indexed yet. Browse Canvas to sync!');
    return;
  }

  let results = state.fuse.search(query, { limit: MAX_RESULTS * 2 });

  if (results.length === 0) {
    showNoResults(`No results for "${query}"`);
    return;
  }

  // Apply custom ranking
  results = rankResults(results);
  results = results.slice(0, MAX_RESULTS);

  displayResults(results);

  // Save to history
  saveSearchToHistory(query);
}

/**
 * Calculate custom score combining Fuse score with type and recency boosts
 */
function calculateScore(item, fuseScore) {
  // Convert Fuse score (0 = perfect, 1 = worst) to (1 = best, 0 = worst)
  let score = 1 - fuseScore;

  // Type boost
  const typeBoost = TYPE_BOOST[item.type] || 0;
  score += typeBoost;

  // Recency boost (if item has indexedAt timestamp)
  if (item.indexedAt) {
    const daysAgo = (Date.now() - item.indexedAt) / (1000 * 60 * 60 * 24);
    // Boost decays over 30 days from 0.15 to 0
    score += Math.max(0, 0.15 - (daysAgo * 0.005));
  }

  return score;
}

/**
 * Re-rank results using custom scoring
 */
function rankResults(results) {
  return results
    .map(r => ({
      ...r,
      finalScore: calculateScore(r.item, r.score)
    }))
    .sort((a, b) => b.finalScore - a.finalScore);
}

// ============================================
// SEARCH HISTORY
// ============================================

async function loadSearchHistory() {
  try {
    const result = await chrome.storage.local.get(['searchHistory']);
    state.searchHistory = result.searchHistory || [];
  } catch (e) {
    state.searchHistory = [];
  }
}

async function saveSearchToHistory(query) {
  if (!query || query.length < 2) return;

  // Remove duplicates and add to front
  state.searchHistory = state.searchHistory.filter(h => h.query.toLowerCase() !== query.toLowerCase());
  state.searchHistory.unshift({ query, timestamp: Date.now() });

  // Keep only last MAX_HISTORY
  state.searchHistory = state.searchHistory.slice(0, MAX_HISTORY);

  try {
    await chrome.storage.local.set({ searchHistory: state.searchHistory });
  } catch (e) {
    console.log('[Canvas Search] Could not save search history');
  }
}

function showSearchHistory() {
  const query = elements.searchInput.value.trim();
  if (query.length > 0 || state.searchHistory.length === 0) {
    hideSearchHistory();
    return;
  }

  elements.searchHistory.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'history-header';
  header.innerHTML = '<span>Recent Searches</span><button class="history-clear">Clear</button>';
  header.querySelector('.history-clear').addEventListener('click', clearSearchHistory);
  elements.searchHistory.appendChild(header);

  state.searchHistory.forEach(item => {
    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';
    historyItem.textContent = item.query;
    historyItem.addEventListener('click', () => {
      elements.searchInput.value = item.query;
      hideSearchHistory();
      performSearch(item.query);
    });
    elements.searchHistory.appendChild(historyItem);
  });

  elements.searchHistory.classList.remove('hidden');
}

function hideSearchHistory() {
  elements.searchHistory.classList.add('hidden');
}

async function clearSearchHistory() {
  state.searchHistory = [];
  await chrome.storage.local.set({ searchHistory: [] });
  hideSearchHistory();
}

function displayResults(results) {
  clearResultsContainer();
  elements.emptyState.classList.add('hidden');

  results.forEach((result, index) => {
    const item = result.item;

    const resultElement = document.createElement('div');
    resultElement.className = 'result-item';
    resultElement.setAttribute('tabindex', '0');
    resultElement.setAttribute('role', 'button');

    const titleElement = document.createElement('div');
    titleElement.className = 'result-title';
    titleElement.textContent = item.title || 'Untitled';

    const metaElement = document.createElement('div');
    metaElement.className = 'result-meta';

    const typeElement = document.createElement('span');
    typeElement.className = 'result-type';
    typeElement.textContent = item.type || 'link';

    const courseElement = document.createElement('span');
    courseElement.className = 'result-module';
    courseElement.textContent = item.courseName || '';

    metaElement.appendChild(typeElement);
    if (item.courseName) {
      metaElement.appendChild(courseElement);
    }

    resultElement.appendChild(titleElement);
    resultElement.appendChild(metaElement);

    resultElement.addEventListener('click', () => openResult(item));
    resultElement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openResult(item);
    });

    elements.resultsContainer.appendChild(resultElement);
  });
}

function openResult(item) {
  if (item.url && isValidCanvasUrl(item.url)) {
    chrome.tabs.create({ url: item.url });
  }
}

function isValidCanvasUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname.endsWith('.instructure.com') ||
      hostname === 'bcourses.berkeley.edu';
  } catch {
    return false;
  }
}

function clearSearch() {
  elements.searchInput.value = '';
  elements.clearSearchBtn.classList.remove('visible');
  showEmptyState();
  elements.searchInput.focus();
}

function showEmptyState() {
  clearResultsContainer();
  elements.emptyState.classList.remove('hidden');
}

function showNoResults(message) {
  clearResultsContainer();
  elements.emptyState.classList.add('hidden');

  const noResultsElement = document.createElement('div');
  noResultsElement.className = 'no-results';
  noResultsElement.textContent = message;
  elements.resultsContainer.appendChild(noResultsElement);
}

function clearResultsContainer() {
  const children = Array.from(elements.resultsContainer.children);
  children.forEach(child => {
    if (child.id !== 'empty-state') {
      child.remove();
    }
  });
}

// ============================================
// DATA MANAGEMENT
// ============================================

async function loadContent() {
  try {
    const result = await chrome.storage.local.get(['indexedContent']);
    state.indexedContent = result.indexedContent || [];
    console.log(`[Canvas Search] Loaded ${state.indexedContent.length} items`);
  } catch (error) {
    console.error('[Canvas Search] Error loading content:', error);
    state.indexedContent = [];
  }
}

async function handleRefresh() {
  if (state.isScanning) return;

  elements.refreshBtn.disabled = true;
  showScanningStatus();

  try {
    await chrome.runtime.sendMessage({ action: 'forceScan' });
  } catch (e) {
    showErrorStatus('Could not start sync');
    elements.refreshBtn.disabled = false;
  }

  // Re-enable after a short delay
  setTimeout(() => {
    elements.refreshBtn.disabled = false;
  }, 2000);
}

async function handleClearData() {
  const confirmed = confirm(
    'Delete all indexed content?\n\nYour content will re-sync automatically when you browse Canvas.'
  );

  if (!confirmed) return;

  try {
    await chrome.storage.local.set({ indexedContent: [] });
    state.indexedContent = [];
    state.fuse = null;
    updateUI();
    showEmptyState();
    clearSearch();
    showSyncedStatus('Data cleared');
  } catch (error) {
    console.error('[Canvas Search] Error clearing data:', error);
  }
}

// ============================================
// UI UPDATES
// ============================================

function updateUI() {
  updateStats();
}

function updateStats() {
  const count = state.indexedContent.length;

  if (count === 0) {
    elements.statsText.textContent = 'No content indexed';
    elements.statsHint.textContent = 'Browse Canvas to sync';
  } else {
    elements.statsText.textContent = `${count} items`;
    elements.statsHint.textContent = 'Click to browse';
  }
}

// ============================================
// BROWSE MODAL
// ============================================

function openBrowseModal() {
  if (state.indexedContent.length === 0) {
    return;
  }

  const grouped = groupContentByType(state.indexedContent);
  buildBrowseTabs(grouped);
  showBrowseCategory('all', state.indexedContent);
  elements.browseModal.classList.remove('hidden');
}

function closeBrowseModal() {
  elements.browseModal.classList.add('hidden');
}

function groupContentByType(content) {
  const grouped = { all: content };

  content.forEach(item => {
    const type = item.type || 'other';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(item);
  });

  return grouped;
}

function buildBrowseTabs(grouped) {
  elements.browseTabs.innerHTML = '';

  const types = Object.keys(grouped).sort((a, b) => {
    if (a === 'all') return -1;
    if (b === 'all') return 1;
    return grouped[b].length - grouped[a].length;
  });

  types.forEach(type => {
    const tab = document.createElement('button');
    tab.className = 'browse-tab' + (type === 'all' ? ' active' : '');

    const label = document.createElement('span');
    label.textContent = formatTypeName(type);

    const countSpan = document.createElement('span');
    countSpan.className = 'tab-count';
    countSpan.textContent = grouped[type].length;

    tab.appendChild(label);
    tab.appendChild(countSpan);

    tab.addEventListener('click', () => {
      elements.browseTabs.querySelectorAll('.browse-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      showBrowseCategory(type, grouped[type]);
    });

    elements.browseTabs.appendChild(tab);
  });
}

function formatTypeName(type) {
  const names = {
    'all': 'All',
    'assignment': 'Assignments',
    'quiz': 'Quizzes',
    'discussion': 'Discussions',
    'page': 'Pages',
    'file': 'Files',
    'pdf': 'PDFs',
    'slides': 'Slides',
    'video': 'Videos',
    'document': 'Documents',
    'externalurl': 'Links',
    'other': 'Other'
  };
  return names[type] || type;
}

function showBrowseCategory(type, items) {
  elements.browseContent.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'browse-empty';
    empty.textContent = 'No items';
    elements.browseContent.appendChild(empty);
    return;
  }

  const sorted = [...items].sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  sorted.forEach(item => {
    const itemEl = document.createElement('div');
    itemEl.className = 'browse-item';

    const title = document.createElement('div');
    title.className = 'browse-item-title';
    title.textContent = item.title || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'browse-item-meta';
    const parts = [];
    if (item.type && type === 'all') parts.push(item.type.toUpperCase());
    if (item.courseName) parts.push(item.courseName);
    meta.textContent = parts.join(' • ');

    itemEl.appendChild(title);
    if (parts.length > 0) itemEl.appendChild(meta);

    itemEl.addEventListener('click', () => {
      if (isValidCanvasUrl(item.url)) {
        chrome.tabs.create({ url: item.url });
      }
    });

    elements.browseContent.appendChild(itemEl);
  });
}
