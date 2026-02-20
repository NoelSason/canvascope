/**
 * ============================================
 * Canvascope - Content Script (content.js)
 * ============================================
 * 
 * PURPOSE:
 * This script runs on Canvas pages and extracts content
 * (links, titles, file names, module names) for indexing.
 * 
 * HOW IT WORKS:
 * 1. Script is injected into Canvas pages (*.instructure.com)
 * 2. Waits for message from popup to start scanning
 * 3. Reads the visible DOM content (NOT hidden APIs)
 * 4. Sends extracted content back to popup
 * 
 * SECURITY PRINCIPLES:
 * - Only runs on verified Canvas domains
 * - Only reads visible content (no API bypass)
 * - Never accesses authentication tokens
 * - Never sends data to external servers
 * - Respects user privacy
 * 
 * ============================================
 */

// ============================================
// CONFIGURATION
// ============================================

// Unified domain lists — mirrors background.js
const CANVAS_DOMAIN_SUFFIXES = ['.instructure.com'];
const KNOWN_CANVAS_DOMAINS = [
    'bcourses.berkeley.edu',
    'bruinlearn.ucla.edu',
    'canvas.ucsd.edu',
    'canvas.asu.edu',
    'canvas.mit.edu'
];
const BRIGHTSPACE_DOMAIN_SUFFIXES = ['.brightspace.com', '.d2l.com'];
const KNOWN_BRIGHTSPACE_DOMAINS = [];
let contentCustomDomains = [];

// Load custom domains from storage so domain checks work for user-added domains
try {
    chrome.storage.local.get(['customDomains']).then(data => {
        contentCustomDomains = data.customDomains || [];
    });
} catch (e) { /* ignore if storage unavailable */ }

/**
 * CSS selectors for Canvas elements
 * 
 * WHY: Canvas has specific class names for different content types.
 * We define them here so they're easy to update if Canvas changes.
 * 
 * These selectors target visible, user-accessible content only.
 */
const CANVAS_SELECTORS = {
    // Module containers
    modules: '.context_module',
    moduleHeader: '.ig-header-title',

    // Module items (individual content pieces)
    moduleItems: '.context_module_item',

    // Different content types
    contentLink: '.ig-title',
    itemType: '.type_icon',

    // File attachments
    fileLinks: 'a.file_download_btn, a.instructure_file_link',

    // Assignment links
    assignmentLinks: '.assignment .ig-title a, a.ig-title',

    // Page links
    pageLinks: '.wiki_page .ig-title a',

    // External links
    externalLinks: '.external_url .ig-title a',

    // Discussion links
    discussionLinks: '.discussion_topic .ig-title a',

    // Quiz links
    quizLinks: '.quiz .ig-title a',

    // Course navigation
    courseNav: '#section-tabs li a',

    // Breadcrumb (for context)
    breadcrumb: '#breadcrumbs li',

    // Course title
    courseTitle: '.mobile-header-title, #breadcrumbs .home span'
};

/**
 * Content type mappings
 * 
 * WHY: We categorize content for better search filtering.
 * This maps CSS classes to human-readable types.
 */
const CONTENT_TYPES = {
    'icon-document': 'pdf',
    'icon-video': 'video',
    'icon-audio': 'audio',
    'icon-image': 'image',
    'icon-powerpoint': 'slides',
    'icon-pdf': 'pdf',
    'icon-word': 'document',
    'icon-excel': 'spreadsheet',
    'icon-assignment': 'assignment',
    'icon-discussion': 'discussion',
    'icon-quiz': 'quiz',
    'icon-link': 'external',
    'icon-page': 'page',
    'icon-module': 'module',
    'icon-folder': 'folder'
};

// ============================================
// DOMAIN VERIFICATION (SECURITY)
// ============================================

/**
 * Verify whether the current page belongs to a supported LMS domain.
 * 
 * SECURITY: Domain checks run before any privileged operations.
 */
function isKnownCanvasHost(hostname) {
    if (CANVAS_DOMAIN_SUFFIXES.some(s => hostname.endsWith(s))) return true;
    if (KNOWN_CANVAS_DOMAINS.includes(hostname)) return true;
    return false;
}

function isKnownBrightspaceHost(hostname) {
    if (BRIGHTSPACE_DOMAIN_SUFFIXES.some(s => hostname.endsWith(s))) return true;
    if (KNOWN_BRIGHTSPACE_DOMAINS.includes(hostname)) return true;
    return false;
}

function looksLikeBrightspacePath(pathname) {
    const path = (pathname || '').toLowerCase();
    return path.startsWith('/d2l/') || path.includes('/d2l/');
}

function isCanvasDomain() {
    const hostname = window.location.hostname.toLowerCase();

    if (isKnownCanvasHost(hostname)) {
        return true;
    }

    // Custom domains default to Canvas unless path strongly indicates Brightspace.
    if (contentCustomDomains.includes(hostname) && !looksLikeBrightspacePath(window.location.pathname)) {
        return true;
    }

    return false;
}

function isSupportedLmsDomain() {
    const hostname = window.location.hostname.toLowerCase();
    if (isKnownCanvasHost(hostname)) return true;
    if (isKnownBrightspaceHost(hostname)) return true;
    if (contentCustomDomains.includes(hostname)) return true;
    return false;
}

// ============================================
// MESSAGE HANDLING
// ============================================

/**
 * Listen for messages from the popup
 * 
 * WHY: Chrome extensions use message passing between components.
 * The popup can't directly access page content, so it sends us messages.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Canvascope Content] Received message:', message.action);

    // Special case: lightweight LMS detection (works without strict domain verification)
    if (message.action === 'checkIfCanvas') {
        const isCanvas = detectCanvasPage();
        sendResponse({
            isCanvas,
            isSupported: isCanvas || detectBrightspacePage()
        });
        return true;
    }

    // SECURITY: Verify we're on Canvas before doing anything else
    if (!isCanvasDomain()) {
        sendResponse({ error: 'Not on a Canvas page' });
        return true;
    }

    switch (message.action) {
        case 'startScan':
            // Start the scanning process
            handleStartScan();
            sendResponse({ success: true });
            break;

        case 'ping':
            // Health check from popup
            sendResponse({ alive: true });
            break;

        default:
            sendResponse({ error: 'Unknown action' });
    }

    // Return true to indicate async response
    return true;
});

/**
 * Detect if current page is Canvas by checking DOM elements
 */
function detectCanvasPage() {
    // Check for Canvas-specific elements
    const canvasIndicators = [
        '#application.ic-app',
        '.ic-app-header',
        '#dashboard',
        '.ic-DashboardCard',
        '#breadcrumbs',
        '.context_module',
        '#section-tabs',
        'meta[name="viewport"][content*="canvas"]'
    ];

    for (const selector of canvasIndicators) {
        if (document.querySelector(selector)) {
            return true;
        }
    }

    // Check for Canvas in page title or URL
    if (document.title.toLowerCase().includes('canvas') ||
        window.location.pathname.includes('/courses/')) {
        return true;
    }

    return false;
}

/**
 * Detect if current page is Brightspace by checking URL + known shell elements.
 */
function detectBrightspacePage() {
    const path = window.location.pathname.toLowerCase();
    if (looksLikeBrightspacePath(path)) return true;

    const brightspaceIndicators = [
        'd2l-navigation',
        'd2l-dropdown',
        '[data-d2l-app-id]',
        '.d2l-page-main',
        '#d2l_body'
    ];

    for (const selector of brightspaceIndicators) {
        if (document.querySelector(selector)) {
            return true;
        }
    }

    if (document.title.toLowerCase().includes('brightspace')) {
        return true;
    }

    return false;
}

// ============================================
// SCANNING FUNCTIONALITY
// ============================================

/**
 * Main scanning entry point
 * 
 * This orchestrates the entire scanning process:
 * 1. Get course context (title, current module)
 * 2. Find all content on the page
 * 3. Extract information from each item
 * 4. Send results back to popup
 */
async function handleStartScan() {
    console.log('[Canvascope Content] Starting scan...');

    try {
        // Report starting
        sendProgress(0, 'Analyzing page structure...');

        // Get course context
        const courseContext = getCourseContext();
        console.log('[Canvascope Content] Course context:', courseContext);

        sendProgress(10, 'Finding content...');

        // Scan all content
        const content = scanPageContent(courseContext);

        sendProgress(80, 'Processing results...');

        // Remove duplicates
        const uniqueContent = removeDuplicates(content);

        sendProgress(100, `Found ${uniqueContent.length} items!`);

        // Send results to popup
        chrome.runtime.sendMessage({
            type: 'scanComplete',
            content: uniqueContent
        });

        console.log(`[Canvascope Content] Scan complete. Found ${uniqueContent.length} items.`);

    } catch (error) {
        console.error('[Canvascope Content] Scan error:', error);

        chrome.runtime.sendMessage({
            type: 'scanError',
            error: error.message
        });
    }
}

/**
 * Get course context information
 * 
 * WHY: Knowing which course we're in helps with search relevance.
 * 
 * @returns {Object} Course context (title, url)
 */
function getCourseContext() {
    let courseTitle = '';
    let courseUrl = '';

    // Try to get course title from breadcrumb
    const breadcrumbs = document.querySelectorAll(CANVAS_SELECTORS.breadcrumb);
    if (breadcrumbs.length >= 2) {
        // Usually: Home > Course Name > Current Page
        const courseLink = breadcrumbs[1]?.querySelector('a');
        if (courseLink) {
            courseTitle = safeGetText(courseLink);
            courseUrl = courseLink.href;
        }
    }

    // Fallback: try mobile header
    if (!courseTitle) {
        const mobileHeader = document.querySelector(CANVAS_SELECTORS.courseTitle);
        if (mobileHeader) {
            courseTitle = safeGetText(mobileHeader);
        }
    }

    // Extract course ID from URL
    const urlMatch = window.location.pathname.match(/\/courses\/(\d+)/);
    const courseId = urlMatch ? urlMatch[1] : null;

    return {
        title: courseTitle,
        url: courseUrl,
        id: courseId
    };
}

/**
 * Scan all content on the page
 * 
 * WHY: We look for different types of content in different places.
 * This function coordinates all the sub-scanners.
 * 
 * @param {Object} courseContext - The course context information
 * @returns {Array} All found content items
 */
function scanPageContent(courseContext) {
    const content = [];

    // Check if we're on the dashboard
    const isDashboard = window.location.pathname === '/' ||
        window.location.pathname.includes('/dashboard') ||
        document.querySelector('.ic-DashboardCard__header');

    if (isDashboard) {
        // Scan dashboard for course cards
        const dashboardContent = scanDashboard();
        content.push(...dashboardContent);
        console.log(`[Canvascope Content] Dashboard scan found ${dashboardContent.length} items`);
    }

    // Scan modules (main source of content on course pages)
    const moduleContent = scanModules(courseContext);
    content.push(...moduleContent);

    // Scan course navigation
    const navContent = scanCourseNavigation(courseContext);
    content.push(...navContent);

    // Scan for any other links on the page
    const otherContent = scanOtherLinks(courseContext);
    content.push(...otherContent);

    // Scan all visible Canvas links as fallback
    const genericContent = scanGenericLinks(courseContext);
    content.push(...genericContent);

    return content;
}

/**
 * Scan Canvas modules for content
 * 
 * WHY: Modules are the main organizational structure in Canvas.
 * Most course content lives inside modules.
 * 
 * @param {Object} courseContext - The course context
 * @returns {Array} Content items from modules
 */
function scanModules(courseContext) {
    const content = [];
    const modules = document.querySelectorAll(CANVAS_SELECTORS.modules);

    console.log(`[Canvascope Content] Found ${modules.length} modules`);

    modules.forEach((module, moduleIndex) => {
        // Get module name
        const headerElement = module.querySelector(CANVAS_SELECTORS.moduleHeader);
        const moduleName = headerElement ? safeGetText(headerElement) : `Module ${moduleIndex + 1}`;

        // Get all items in this module
        const items = module.querySelectorAll(CANVAS_SELECTORS.moduleItems);

        items.forEach(item => {
            const contentItem = extractModuleItem(item, moduleName, courseContext);
            if (contentItem) {
                content.push(contentItem);
            }
        });

        // Update progress
        const progress = 10 + Math.round((moduleIndex / modules.length) * 60);
        sendProgress(progress, `Scanning: ${moduleName}`);
    });

    return content;
}

/**
 * Extract information from a single module item
 * 
 * @param {Element} item - The module item element
 * @param {string} moduleName - The parent module name
 * @param {Object} courseContext - The course context
 * @returns {Object|null} The extracted content item
 */
function extractModuleItem(item, moduleName, courseContext) {
    // Find the main link
    const link = item.querySelector('a.ig-title') ||
        item.querySelector('.title a') ||
        item.querySelector('a[href]');

    if (!link || !link.href) {
        return null;
    }

    // Get the title
    const title = safeGetText(link) || safeGetText(item.querySelector('.title'));

    if (!title) {
        return null;
    }

    // Determine content type
    const type = determineContentType(item);

    // Build the content item
    return {
        title: title.trim(),
        url: link.href,
        type: type,
        moduleName: moduleName,
        courseName: courseContext.title,
        courseId: courseContext.id,
        scannedAt: new Date().toISOString()
    };
}

/**
 * Determine the type of content (pdf, video, assignment, etc.)
 * 
 * @param {Element} item - The module item element
 * @returns {string} The content type
 */
function determineContentType(item) {
    // Check for type icons
    const typeIcon = item.querySelector('.type_icon, [class*="icon-"]');

    if (typeIcon) {
        const classList = typeIcon.className;

        // Check against known types
        for (const [iconClass, type] of Object.entries(CONTENT_TYPES)) {
            if (classList.includes(iconClass)) {
                return type;
            }
        }
    }

    // Check URL for type hints
    const link = item.querySelector('a[href]');
    if (link?.href) {
        const url = link.href.toLowerCase();

        if (url.includes('/files/') || url.includes('download')) {
            // Try to get extension from URL
            const extMatch = url.match(/\.(\w{2,4})(?:\?|$)/);
            if (extMatch) {
                const ext = extMatch[1];
                if (['pdf', 'ppt', 'pptx'].includes(ext)) return 'slides';
                if (['doc', 'docx'].includes(ext)) return 'document';
                if (['mp4', 'mov', 'avi'].includes(ext)) return 'video';
                if (['mp3', 'wav'].includes(ext)) return 'audio';
            }
            return 'file';
        }

        if (url.includes('/assignments/')) return 'assignment';
        if (url.includes('/quizzes/')) return 'quiz';
        if (url.includes('/discussion_topics/')) return 'discussion';
        if (url.includes('/pages/')) return 'page';
        if (url.includes('/modules/')) return 'module';
        if (url.includes('youtube.com') || url.includes('vimeo.com')) return 'video';
    }

    return 'link';
}

/**
 * Scan course navigation sidebar
 * 
 * @param {Object} courseContext - The course context
 * @returns {Array} Content items from navigation
 */
function scanCourseNavigation(courseContext) {
    const content = [];
    const navLinks = document.querySelectorAll(CANVAS_SELECTORS.courseNav);

    navLinks.forEach(link => {
        const title = safeGetText(link);
        const url = link.href;

        if (title && url) {
            content.push({
                title: title.trim(),
                url: url,
                type: 'navigation',
                moduleName: 'Course Navigation',
                courseName: courseContext.title,
                courseId: courseContext.id,
                scannedAt: new Date().toISOString()
            });
        }
    });

    return content;
}

/**
 * Scan for other links on the page
 * 
 * WHY: Catch any Canvas links not in modules or navigation.
 * Be very conservative here to avoid noise.
 * 
 * @param {Object} courseContext - The course context
 * @returns {Array} Other content items
 */
function scanOtherLinks(courseContext) {
    const content = [];

    // Look for file download links
    const fileLinks = document.querySelectorAll(CANVAS_SELECTORS.fileLinks);

    fileLinks.forEach(link => {
        const title = safeGetText(link) || link.getAttribute('title') ||
            getFilenameFromUrl(link.href);
        const url = link.href;

        if (title && url && isCanvasUrl(url)) {
            content.push({
                title: title.trim(),
                url: url,
                type: 'file',
                moduleName: 'Files',
                courseName: courseContext.title,
                courseId: courseContext.id,
                scannedAt: new Date().toISOString()
            });
        }
    });

    return content;
}

/**
 * Scan Dashboard for course cards
 * 
 * @returns {Array} Content items from dashboard
 */
function scanDashboard() {
    const content = [];

    // Dashboard course cards (new Canvas UI)
    const courseCards = document.querySelectorAll('.ic-DashboardCard, [class*="DashboardCard"]');

    console.log(`[Canvascope Content] Found ${courseCards.length} dashboard cards`);

    courseCards.forEach(card => {
        // Get course link
        const link = card.querySelector('a[href*="/courses/"]');
        if (!link) return;

        // Get course title from various possible locations
        const titleElement = card.querySelector('.ic-DashboardCard__header-title, [class*="DashboardCard__header-title"], .ic-DashboardCard__header-subtitle');
        const title = titleElement ? safeGetText(titleElement) : '';

        // Also try getting subtitle (course code)
        const subtitleElement = card.querySelector('.ic-DashboardCard__header-subtitle, [class*="header-subtitle"]');
        const subtitle = subtitleElement ? safeGetText(subtitleElement) : '';

        // Get the full display title
        const displayTitle = title || safeGetText(link);

        if (displayTitle && link.href) {
            content.push({
                title: displayTitle.trim(),
                url: link.href,
                type: 'course',
                moduleName: subtitle || 'Dashboard',
                courseName: displayTitle.trim(),
                courseId: extractCourseId(link.href),
                scannedAt: new Date().toISOString()
            });
        }
    });

    // Also scan for course list links (alternate dashboard views)
    const courseListLinks = document.querySelectorAll('.course-list-table-row a[href*="/courses/"], #my_courses_table a[href*="/courses/"]');

    courseListLinks.forEach(link => {
        const title = safeGetText(link);
        if (title && link.href) {
            content.push({
                title: title.trim(),
                url: link.href,
                type: 'course',
                moduleName: 'Course List',
                courseName: title.trim(),
                courseId: extractCourseId(link.href),
                scannedAt: new Date().toISOString()
            });
        }
    });

    // Scan sidebar "To Do" items
    const todoItems = document.querySelectorAll('.to-do-list li a, [class*="todo"] a[href*="/courses/"]');

    todoItems.forEach(link => {
        const title = safeGetText(link);
        if (title && link.href && isCanvasUrl(link.href)) {
            content.push({
                title: title.trim(),
                url: link.href,
                type: 'todo',
                moduleName: 'To Do',
                courseName: '',
                courseId: extractCourseId(link.href),
                scannedAt: new Date().toISOString()
            });
        }
    });

    return content;
}

/**
 * Extract course ID from URL
 * 
 * @param {string} url - The URL containing course ID
 * @returns {string|null} The course ID or null
 */
function extractCourseId(url) {
    const match = url.match(/\/courses\/(\d+)/);
    return match ? match[1] : null;
}

/**
 * Scan for generic Canvas links as fallback
 * 
 * @param {Object} courseContext - The course context
 * @returns {Array} Content items from generic links
 */
function scanGenericLinks(courseContext) {
    const content = [];

    // Find all links that point to Canvas content
    const allLinks = document.querySelectorAll('a[href*="/courses/"]');

    allLinks.forEach(link => {
        // Skip if already processed or not a Canvas URL
        if (!link.href || !isCanvasUrl(link.href)) return;

        // Skip navigation and UI elements
        if (link.closest('nav, header, footer, .ic-app-header')) return;

        // Get title from link text or title attribute
        const title = safeGetText(link) || link.getAttribute('title') || link.getAttribute('aria-label');

        if (title && title.length > 2 && title.length < 200) {
            // Determine type from URL
            let type = 'link';
            const url = link.href.toLowerCase();

            if (url.includes('/assignments/')) type = 'assignment';
            else if (url.includes('/quizzes/')) type = 'quiz';
            else if (url.includes('/discussion_topics/')) type = 'discussion';
            else if (url.includes('/pages/')) type = 'page';
            else if (url.includes('/files/')) type = 'file';
            else if (url.includes('/modules/')) type = 'module';
            else if (url.includes('/announcements/')) type = 'announcement';
            else if (url.includes('/grades')) type = 'grades';

            // IMPORTANT: Check if this link belongs to the current course context
            const linkCourseId = extractCourseId(link.href);
            let itemCourseName = courseContext.title || '';
            let itemModuleName = courseContext.title || 'Canvas';

            // If the link is for a different course (e.g. from "To Do" sidebar),
            // don't attribute it to the current course name unless IDs match
            if (courseContext.id && linkCourseId && courseContext.id !== linkCourseId) {
                // It's from another course. We don't know the name easily.
                // Leave it empty so it doesn't get incorrectly filtered.
                itemCourseName = '';
                itemModuleName = 'Other Course';
            }

            content.push({
                title: title.trim(),
                url: link.href,
                type: type,
                moduleName: itemModuleName,
                courseName: itemCourseName,
                courseId: linkCourseId || courseContext.id,
                scannedAt: new Date().toISOString()
            });
        }
    });

    return content;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Safely get text content from an element
 * 
 * WHY: Prevents errors if element is null and trims whitespace.
 * 
 * @param {Element} element - The DOM element
 * @returns {string} The text content or empty string
 */
function safeGetText(element) {
    if (!element) {
        return '';
    }

    // Use textContent (safe, no HTML parsing)
    return (element.textContent || '').trim();
}

/**
 * Check if URL is a Canvas URL
 * 
 * @param {string} url - The URL to check
 * @returns {boolean} True if Canvas URL
 */
function isCanvasUrl(url) {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();

        // Check suffix patterns
        if (CANVAS_DOMAIN_SUFFIXES.some(s => hostname.endsWith(s))) return true;

        // Check exact known domains
        if (KNOWN_CANVAS_DOMAINS.includes(hostname)) return true;

        // Check user-added custom domains
        if (contentCustomDomains.includes(hostname)) return true;

        return false;
    } catch {
        return false;
    }
}

/**
 * Extract filename from URL
 * 
 * @param {string} url - The file URL
 * @returns {string} The extracted filename
 */
function getFilenameFromUrl(url) {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname;
        const segments = path.split('/');
        const filename = segments.pop() || segments.pop(); // Handle trailing slash
        return decodeURIComponent(filename || '');
    } catch {
        return '';
    }
}

/**
 * Remove duplicate content items
 * 
 * @param {Array} content - Array of content items
 * @returns {Array} Deduplicated array
 */
function removeDuplicates(content) {
    const seen = new Set();

    return content.filter(item => {
        if (seen.has(item.url)) {
            return false;
        }
        seen.add(item.url);
        return true;
    });
}

/**
 * Send progress update to popup
 * 
 * @param {number} percent - Progress percentage (0-100)
 * @param {string} status - Status message
 */
function sendProgress(percent, status) {
    chrome.runtime.sendMessage({
        type: 'scanProgress',
        progress: percent,
        status: status
    }).catch(() => {
        // Ignore errors if popup is closed
    });
}

// ============================================
// INITIALIZATION
// ============================================

/**
 * Verify domain and log status
 * 
 * WHY: We log a message when the content script loads
 * so developers can verify it's running correctly.
 */
if (isSupportedLmsDomain() || detectCanvasPage() || detectBrightspacePage()) {
    console.log('[Canvascope Content] Content script loaded on supported LMS page');
} else {
    console.log('[Canvascope Content] Not a supported LMS page, staying dormant');
}

// ============================================
// SEARCH OVERLAY (Cmd+K)
// ============================================

let overlayContainer = null;
let overlayIframe = null;
let overlayVisible = false;

/**
 * Create and inject the search overlay
 */
function createOverlay() {
    if (overlayContainer) return;

    // Create container
    overlayContainer = document.createElement('div');
    overlayContainer.id = 'canvascope-overlay-container';
    overlayContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        z-index: 2147483647; /* Max z-index */
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(3px);
    `;

    // Create iframe
    overlayIframe = document.createElement('iframe');
    overlayIframe.src = chrome.runtime.getURL('popup.html?mode=overlay');
    overlayIframe.allow = "clipboard-write"; // Allow copying
    overlayIframe.style.cssText = `
        width: 420px;
        height: 550px;
        border: none;
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.4);
        background: transparent;
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
        transform: scale(0.95);
        opacity: 0;
    `;

    // Close on click outside
    overlayContainer.addEventListener('click', (e) => {
        if (e.target === overlayContainer) {
            hideOverlay();
        }
    });

    overlayContainer.appendChild(overlayIframe);
    document.body.appendChild(overlayContainer);
}

/**
 * Toggle overlay visibility
 */
function toggleOverlay() {
    if (!overlayContainer) createOverlay();

    if (overlayVisible) {
        hideOverlay();
    } else {
        showOverlay();
    }
}

function showOverlay() {
    if (!overlayContainer) createOverlay();

    overlayVisible = true;
    overlayContainer.style.display = 'flex';
    document.body.style.overflow = 'hidden'; // Prevent background scrolling

    // Focus iframe
    requestAnimationFrame(() => {
        overlayIframe.style.transform = 'scale(1)';
        overlayIframe.style.opacity = '1';
        overlayIframe.focus();
        // Send message to popup to focus input (use extension origin, not '*')
        const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
        overlayIframe.contentWindow.postMessage({ type: 'FOCUS_INPUT' }, extensionOrigin);
    });
}

function hideOverlay() {
    if (!overlayContainer) return;

    overlayVisible = false;
    overlayIframe.style.transform = 'scale(0.95)';
    overlayIframe.style.opacity = '0';
    document.body.style.overflow = '';

    setTimeout(() => {
        overlayContainer.style.display = 'none';
        // Reset iframe src to reset state? No, keep it for speed.
    }, 200);
}

// ============================================
// LTI / EXTERNAL TOOL SCANNING (e.g. Media Gallery)
// ============================================

function checkForLtiPage() {
    // Check if we are on an external tool page
    // URL pattern: /courses/:id/external_tools/:id
    if (window.location.pathname.includes('/external_tools/')) {
        console.log('[Canvascope Content] LTI Tool page detected, requesting frame scan...');

        // Wait a bit for iframes to load
        setTimeout(() => {
            chrome.runtime.sendMessage({ action: 'scanFrames' });
        }, 2000); // 2 second delay to allow iframe to load
    }
}

// Run LTI check on load
checkForLtiPage();

// Listen for Command+K (Mac) or Ctrl+K (Windows)
document.addEventListener('keydown', (e) => {
    // Check for Cmd+K (Mac) or Ctrl+K (Windows/Linux)
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();

        // Ensure we are on a valid page (double check)
        if (isSupportedLmsDomain() || detectCanvasPage() || detectBrightspacePage()) {
            toggleOverlay();
        }
    }

    // Close on Escape if overlay is open
    if (e.key === 'Escape' && overlayVisible) {
        e.preventDefault();
        e.stopPropagation();
        hideOverlay();
    }
});

// Listen for messages from the iframe/popup (strict origin + source check)
window.addEventListener('message', (event) => {
    const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
    if (event.origin !== extensionOrigin) return;
    if (!overlayIframe || event.source !== overlayIframe.contentWindow) return;

    if (event.data && event.data.type === 'CLOSE_OVERLAY') {
        hideOverlay();
    }
});

// Also listen to runtime messages just in case
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'closeOverlay') {
        hideOverlay();
    }
});
