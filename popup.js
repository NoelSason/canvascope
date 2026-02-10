/**
 * ============================================
 * Canvascope - Popup Script (popup.js)
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
  console.log('[Canvascope] Popup opened');
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

  // Check if running in overlay mode
  checkOverlayMode();
});

function checkOverlayMode() {
  // Check if running in iframe
  if (window.self !== window.top) {
    document.body.classList.add('in-overlay');

    // Listen for messages from parent
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'FOCUS_INPUT') {
        setTimeout(() => elements.searchInput.focus(), 50);
      }
    });

    // Handle Escape key to close overlay
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, '*');
      }
    });
  }
}

function initializeElements() {
  elements.searchInput = document.getElementById('search-input');
  elements.clearSearchBtn = document.getElementById('clear-search');
  elements.resultsContainer = document.getElementById('results-container');
  elements.emptyState = document.getElementById('empty-state');
  elements.refreshBtn = document.getElementById('refresh-btn');
  elements.clearDataBtn = document.getElementById('clear-data-btn');
  elements.statusText = document.getElementById('status-text');
  elements.statsText = document.getElementById('stats-text');
  elements.statsHint = document.getElementById('stats-hint');
  elements.statsBtn = document.getElementById('stats-btn');

  // Browsing Modal Elements
  elements.browseModal = document.getElementById('browse-modal');
  elements.closeBrowse = document.getElementById('close-browse');
  elements.browseTabs = document.getElementById('browse-tabs');
  elements.browseContent = document.getElementById('browse-content');

  // Sync Status Elements
  elements.syncStatus = document.getElementById('sync-status');
  elements.syncIcon = document.getElementById('sync-icon');
  elements.syncText = document.getElementById('sync-text');

  // Custom Dropdown Elements
  elements.courseWrapper = document.getElementById('course-select-wrapper');
  elements.courseTrigger = document.getElementById('course-trigger');
  elements.courseOptions = document.getElementById('course-options');
  elements.courseText = document.getElementById('course-text');

  elements.typeWrapper = document.getElementById('type-select-wrapper');
  elements.typeTrigger = document.getElementById('type-trigger');
  elements.typeOptions = document.getElementById('type-options');
  elements.typeText = document.getElementById('type-text');

  elements.searchHistory = document.getElementById('search-history');
}

function setupEventListeners() {
  elements.searchInput.addEventListener('input', handleSearchInput);
  elements.searchInput.addEventListener('focus', showSearchHistory);
  elements.searchInput.addEventListener('blur', () => {
    // Delay hiding to allow clicking on history items
    setTimeout(() => {
      // Don't hide if we clicked a history item (handled by click event)
    }, 200);
  });

  // Press Enter to open first result
  elements.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const firstResult = elements.resultsContainer.querySelector('.result-item');
      if (firstResult) {
        firstResult.click();
      }
    }
  });

  // Close search history when clicking outside
  document.addEventListener('click', (e) => {
    if (!elements.searchHistory.contains(e.target) && e.target !== elements.searchInput) {
      hideSearchHistory();
    }

    // Close custom dropdowns when clicking outside
    if (!elements.courseWrapper.contains(e.target)) {
      elements.courseWrapper.classList.remove('open');
    }
    if (!elements.typeWrapper.contains(e.target)) {
      elements.typeWrapper.classList.remove('open');
    }
  });

  elements.clearSearchBtn.addEventListener('click', clearSearch);
  elements.refreshBtn.addEventListener('click', handleRefresh);
  if (elements.clearDataBtn) elements.clearDataBtn.addEventListener('click', handleClearData);
  if (elements.statsBtn) elements.statsBtn.addEventListener('click', openBrowseModal);
  if (elements.closeBrowse) elements.closeBrowse.addEventListener('click', closeBrowseModal);

  // Custom Dropdown Listeners
  setupCustomDropdown(elements.courseWrapper, elements.courseTrigger, elements.courseOptions, 'course');
  setupCustomDropdown(elements.typeWrapper, elements.typeTrigger, elements.typeOptions, 'type');

  // Listen for background updates
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

/**
 * Setup custom dropdown behavior
 */
function setupCustomDropdown(wrapper, trigger, optionsContainer, filterType) {
  // Make trigger focusable
  trigger.setAttribute('tabindex', '0');

  // Toggle dropdown
  trigger.addEventListener('click', () => {
    const wasOpen = wrapper.classList.contains('open');

    // Close other dropdowns
    document.querySelectorAll('.custom-select-wrapper').forEach(el => {
      if (el !== wrapper) el.classList.remove('open');
    });

    if (!wasOpen) {
      wrapper.classList.add('open');
      // Scroll to selected option
      const selected = optionsContainer.querySelector('.selected');
      if (selected) {
        selected.scrollIntoView({ block: 'nearest' });
      }
    } else {
      wrapper.classList.remove('open');
    }
  });

  // Handle option selection
  optionsContainer.addEventListener('click', (e) => {
    const option = e.target.closest('.custom-option');
    if (!option) return;
    selectOption(option, wrapper, optionsContainer, filterType);
  });

  // Keyboard Navigation
  let searchString = '';
  let searchTimeout = null;

  trigger.addEventListener('keydown', (e) => {
    // Navigate with arrows
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // If closed, open it
      if (!wrapper.classList.contains('open')) {
        wrapper.classList.add('open');
      }

      const options = Array.from(optionsContainer.querySelectorAll('.custom-option'));
      const currentIndex = options.findIndex(opt => opt.classList.contains('selected'));
      let nextIndex = 0;

      if (currentIndex !== -1) {
        if (e.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, options.length - 1);
        else nextIndex = Math.max(currentIndex - 1, 0);
      }

      const nextOption = options[nextIndex];
      if (nextOption) {
        // Just highlight/scroll to it, don't select yet until Enter? 
        // Or select immediately like native select? Native select updates immediately.
        selectOption(nextOption, wrapper, optionsContainer, filterType, false); // false = don't close
        nextOption.scrollIntoView({ block: 'nearest' });
      }
      return;
    }

    // Select with Enter
    if (e.key === 'Enter') {
      if (wrapper.classList.contains('open')) {
        e.preventDefault();
        wrapper.classList.remove('open');
      } else {
        wrapper.classList.add('open');
      }
      return;
    }

    // Close with Escape
    if (e.key === 'Escape') {
      wrapper.classList.remove('open');
      trigger.focus();
      return;
    }

    // Type to search
    // Allow alphanumerics, spaces, dashes, periods
    if (e.key.length === 1 && e.key.match(/^[a-z0-9\s.-]$/i)) {
      clearTimeout(searchTimeout);
      searchString += e.key.toLowerCase();

      const options = Array.from(optionsContainer.querySelectorAll('.custom-option'));
      const match = options.find(opt => opt.textContent.toLowerCase().startsWith(searchString));

      if (match) {
        if (!wrapper.classList.contains('open')) {
          wrapper.classList.add('open');
        }
        selectOption(match, wrapper, optionsContainer, filterType, false);
        match.scrollIntoView({ block: 'nearest' });
      }

      searchTimeout = setTimeout(() => {
        searchString = '';
      }, 3000); // Reset search after 3 seconds for slower typists
    }

    // Handle Backspace
    if (e.key === 'Backspace') {
      clearTimeout(searchTimeout);
      searchString = searchString.slice(0, -1);
      searchTimeout = setTimeout(() => {
        searchString = '';
      }, 3000);
    }
  });
}

function selectOption(option, wrapper, optionsContainer, filterType, close = true) {
  // Remove selected class from siblings
  optionsContainer.querySelectorAll('.custom-option').forEach(el => {
    el.classList.remove('selected');
  });

  // Select this option
  option.classList.add('selected');

  // Update text and value
  const value = option.dataset.value;
  const text = option.textContent;

  wrapper.querySelector('span').textContent = text;

  if (close) {
    wrapper.classList.remove('open');
  }

  // Update state and trigger filter
  // Only trigger update if value changed
  if (state.filters[filterType] !== value) {
    state.filters[filterType] = value;
    handleFilterChange();
  }
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
    console.log('[Canvascope] Could not get background status');
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
    if (hostname.endsWith('.instructure.com') ||
      hostname === 'bcourses.berkeley.edu' ||
      hostname === 'bruinlearn.ucla.edu' ||
      hostname === 'canvas.ucsd.edu') return;

    // Try to detect Canvas from URL patterns (content script may not be loaded)
    if (url.pathname.includes('/courses/') ||
      url.pathname.includes('/assignments/') ||
      url.pathname.includes('/modules') ||
      url.pathname.includes('/quizzes')) {
      // Likely Canvas, add domain
      await chrome.runtime.sendMessage({ action: 'addDomain', domain: hostname });
      console.log('[Canvascope] Auto-detected Canvas domain from URL:', hostname);
    }
  } catch (e) {
    // Silently ignore - this is expected when not on a Canvas page
  }
}

function handleBackgroundMessage(message) {
  console.log('[Canvascope] Background message:', message.type);

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
    // Course filter - use includes for partial matching
    if (state.filters.course) {
      const itemCourse = (item.courseName || '').toLowerCase();
      const filterCourse = state.filters.course.toLowerCase();
      // Allow exact match or partial match
      if (itemCourse !== filterCourse && !itemCourse.includes(filterCourse)) {
        return false;
      }
    }
    // Type filter - exact match
    if (state.filters.type && item.type !== state.filters.type) {
      return false;
    }
    return true;
  });
  console.log(`[Canvascope] Filtered: ${state.filteredContent.length} of ${state.indexedContent.length} items`);
}

function handleFilterChange() {
  // State is already updated by the click handler in setupCustomDropdown
  initializeFuse();

  // Re-run search if there's a query
  const query = elements.searchInput.value.trim();
  if (query.length > 0) {
    performSearch(query);
  } else {
    updateUI(); // Show all filtered results if no query
  }
}

function populateCourseFilter() {
  const courses = new Set();

  // Extract unique courses
  state.indexedContent.forEach(item => {
    if (item.courseName) {
      courses.add(item.courseName.trim());
    }
  });

  // Clear existing options (except "All Courses")
  // Note: first child is "All Courses"
  const allCoursesOption = elements.courseOptions.firstElementChild;
  elements.courseOptions.innerHTML = '';
  if (allCoursesOption) {
    elements.courseOptions.appendChild(allCoursesOption);
  } else {
    // Recreate if missing
    const opt = document.createElement('div');
    opt.className = 'custom-option selected';
    opt.dataset.value = '';
    opt.textContent = 'All Courses';
    elements.courseOptions.appendChild(opt);
  }

  // Add course options
  Array.from(courses).sort().forEach(course => {
    // Skip invalid course names
    if (course === 'Dashboard' || course.startsWith('Announcements - ') || course.includes(' - ')) return;

    const option = document.createElement('div');
    option.className = 'custom-option';
    if (course === state.filters.course) {
      option.classList.add('selected');
    }
    option.dataset.value = course;
    option.textContent = course;
    elements.courseOptions.appendChild(option);
  });

  // Update trigger text if valid
  if (state.filters.course) {
    const selectedOption = Array.from(elements.courseOptions.children).find(opt => opt.dataset.value === state.filters.course);
    if (selectedOption) {
      elements.courseText.textContent = selectedOption.textContent;
    } else {
      // Reset if course not found
      state.filters.course = '';
      elements.courseText.textContent = 'All Courses';
      handleFilterChange();
    }
  }
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
    console.log('[Canvascope] Could not save search history');
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
    chrome.tabs.update({ url: item.url });

    // If in overlay mode, tell parent to close
    if (window.self !== window.top) {
      window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, '*');
    } else {
      window.close(); // Close popup after navigation
    }
  }
}

function isValidCanvasUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname.endsWith('.instructure.com') ||
      hostname === 'bcourses.berkeley.edu' ||
      hostname === 'bruinlearn.ucla.edu' ||
      hostname === 'canvas.ucsd.edu';
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
    let content = result.indexedContent || [];

    // Deduplicate by normalizing URLs (strip module_item_id)
    content = deduplicateContent(content);

    state.indexedContent = content;
    console.log(`[Canvascope] Loaded ${state.indexedContent.length} items (after dedup)`);
  } catch (error) {
    console.error('[Canvascope] Error loading content:', error);
    state.indexedContent = [];
  }
}

/**
 * Remove duplicate entries with same base URL
 * URLs like /assignments/123?module_item_id=456 should match /assignments/123
 */
function deduplicateContent(content) {
  const seen = new Map();

  for (const item of content) {
    // Create a strict key based on Title + Course + Type
    // This merges "PLWS 10" from "Chem 3A" regardless of the URL
    // We include type to avoid merging a file named "Syllabus" with a page named "Syllabus"
    const key = `${item.title.trim()}|${item.courseName.trim()}|${item.type}`;

    if (!seen.has(key)) {
      seen.set(key, item);
    } else {
      // If we already have this item, check if the new one has a "better" URL
      const existing = seen.get(key);

      // Prefer canonical URLs (e.g. /assignments/123) over module item URLs (/courses/123/modules/items/456)
      const isCanonical = (url) => {
        return url.includes('/assignments/') ||
          url.includes('/quizzes/') ||
          url.includes('/files/') ||
          url.includes('/discussion_topics/');
      };

      const existingIsCanonical = isCanonical(existing.url);
      const newIsCanonical = isCanonical(item.url);

      if (newIsCanonical && !existingIsCanonical) {
        // Replace with new item if it has a better URL
        seen.set(key, item);
      } else if (newIsCanonical === existingIsCanonical) {
        // If both are same "quality", prefer the shorter URL
        if (item.url.length < existing.url.length) {
          seen.set(key, item);
        }
      }
    }
  }

  return Array.from(seen.values());
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
    console.error('[Canvascope] Error clearing data:', error);
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
