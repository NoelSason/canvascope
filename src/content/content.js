/**
 * ============================================
 * Canvascope - Content Script (content.js)
 * ============================================
 * 
 * PURPOSE:
 * This script runs on supported LMS pages and extracts Canvas content
 * (links, titles, file names, module names) for indexing.
 * 
 * HOW IT WORKS:
 * 1. Script is injected on supported LMS domains from manifest rules
 * 2. Waits for message from popup to start scanning
 * 3. Reads the visible DOM content (NOT hidden APIs)
 * 4. Sends extracted content back to popup
 * 
 * SECURITY PRINCIPLES:
 * - Privileged indexing operations run only on verified Canvas domains
 * - Only reads visible content (no API bypass)
 * - Never accesses authentication tokens
 * - Does not directly post collected content to third-party analytics endpoints
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
const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
    enableSendToLectra: false,
    autopilotAutoPrompt: true,
    selectedCourseFilters: []
});
const LECTRA_BUTTON_POSITION_STORAGE_KEY = 'lectraSendButtonPositions';
const LECTRA_BUTTON_POSITION_SLOT = 'canvas';
const LECTRA_BUTTON_HOLD_TO_DRAG_MS = 350;
const LECTRA_BUTTON_DRAG_CANCEL_DISTANCE_PX = 12;
const LECTRA_BUTTON_DEFAULT_RIGHT_PX = 20;
const LECTRA_BUTTON_DEFAULT_BOTTOM_PX = 96;
const LECTRA_BUTTON_EDGE_PADDING_PX = 12;
const LECTRA_BUTTON_DEFAULT_TRANSITION = 'transform 0.15s ease, opacity 0.2s ease';
const COURSE_MATERIAL_DISCOVERY_MIN_MS = 10 * 60 * 1000;
const COURSE_MATERIAL_DISCOVERY_MAX_PAGES = 8;
let contentExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
let courseMaterialDiscoveryTimer = null;
const courseMaterialDiscoveryLastAt = new Map();

// Load custom domains from storage so domain checks work for user-added domains
try {
    chrome.storage.local.get(['customDomains', 'settings', LECTRA_BUTTON_POSITION_STORAGE_KEY]).then(data => {
        contentCustomDomains = data.customDomains || [];
        contentExtensionSettings = normalizeExtensionSettings(data.settings);
        lectraSendButtonPosition = normalizeLectraButtonPosition(data?.[LECTRA_BUTTON_POSITION_STORAGE_KEY]?.[LECTRA_BUTTON_POSITION_SLOT]);
        scheduleLectraPdfContextRefresh(0);
    });
} catch (e) { /* ignore if storage unavailable */ }

try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;

        if (changes.customDomains) {
            contentCustomDomains = changes.customDomains.newValue || [];
        }

        if (changes.settings) {
            contentExtensionSettings = normalizeExtensionSettings(changes.settings.newValue);
            scheduleLectraPdfContextRefresh(0);
            // Toggling the proactive prompt off should hide a visible card immediately;
            // toggling on should re-evaluate the current page.
            scheduleSyllabusPromptCheck(0);
        }

        if (changes[LECTRA_BUTTON_POSITION_STORAGE_KEY]) {
            lectraSendButtonPosition = normalizeLectraButtonPosition(
                changes[LECTRA_BUTTON_POSITION_STORAGE_KEY]?.newValue?.[LECTRA_BUTTON_POSITION_SLOT]
            );
            if (lectraSendButton && lectraSendButton.isConnected) {
                applyLectraSendButtonPosition(lectraSendButton);
            }
        }
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

// True while this content script can still reach the extension's runtime.
// After the user reloads/upgrades the extension, every chrome.runtime.* call
// from a previously-injected content script throws "Extension context
// invalidated"; guard hot paths (Cmd+K, Lectra polling) with this.
let extensionContextInvalidatedNoticeShown = false;
function isExtensionContextValid() {
    try {
        return Boolean(chrome?.runtime?.id);
    } catch (_) {
        return false;
    }
}
function notifyExtensionContextInvalidated() {
    if (extensionContextInvalidatedNoticeShown) return;
    extensionContextInvalidatedNoticeShown = true;
    try {
        const el = document.createElement('div');
        el.id = 'canvascope-context-invalidated-toast';
        el.textContent = 'Canvascope was updated — refresh this page to keep using it.';
        el.style.cssText = `
            position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
            z-index: 2147483647; padding: 10px 16px; border-radius: 8px;
            background: #11141d; color: #edf0f8; border: 1px solid #32384a;
            font: 500 13px 'Geist', -apple-system, system-ui, sans-serif;
            box-shadow: 0 12px 32px rgba(0,0,0,0.45);
        `;
        document.body?.appendChild(el);
        setTimeout(() => el.remove(), 8000);
    } catch (_) { /* DOM may be gone */ }
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
    // Special case: lightweight LMS detection (works without strict domain verification)
    if (message.action === 'checkIfCanvas') {
        const isCanvas = detectCanvasPage();
        sendResponse({
            isCanvas,
            isSupported: isCanvas || detectBrightspacePage()
        });
        return true;
    }

    if (message.action === 'collectPdfCandidates') {
        sendResponse(collectPdfCandidates());
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

        case 'discoverCourseMaterials':
            discoverAndSendCourseMaterials(message.reason || 'message')
                .then(sendResponse)
                .catch(error => sendResponse({ success: false, error: error?.message || String(error) }));
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
// SHARED SPA NAVIGATION WATCHER
// Wraps history exactly once and fans URL-change events out to subscribers
// (Lectra button refresh, PDF auto-index). Replaces per-feature polling and
// duplicate history wrapping.
// ============================================

const canvascopeNavSubscribers = new Set();
let canvascopeNavHooksInstalled = false;

function subscribeToNavigation(callback) {
    canvascopeNavSubscribers.add(callback);
    if (canvascopeNavHooksInstalled) return;
    canvascopeNavHooksInstalled = true;

    const notify = () => {
        canvascopeNavSubscribers.forEach(cb => {
            try { cb(); } catch (_) { /* subscriber errors stay local */ }
        });
    };
    window.addEventListener('popstate', notify);
    window.addEventListener('hashchange', notify);
    ['pushState', 'replaceState'].forEach((method) => {
        const original = history[method];
        if (typeof original !== 'function') return;
        history[method] = function wrappedHistoryState(...args) {
            const result = original.apply(this, args);
            notify();
            return result;
        };
    });
}

// ============================================
// LECTRA PDF SEND UI + CANDIDATE DISCOVERY
// ============================================

let lectraPdfContext = null;
let lectraSendButton = null;
let lectraSendButtonBusy = false;
let lectraPdfRefreshTimer = null;
let lectraHooksInstalled = false;
let lectraSendButtonPosition = null;
let lectraSendButtonDragState = null;
let lectraSuppressNextSendButtonClick = false;

function normalizeExtensionSettings(rawSettings) {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    return {
        ...DEFAULT_EXTENSION_SETTINGS,
        ...source,
        enableSendToLectra: Boolean(source.enableSendToLectra),
        // Proactive syllabus prompt is on unless the user explicitly turns it off.
        autopilotAutoPrompt: source.autopilotAutoPrompt !== false,
        selectedCourseFilters: Array.isArray(source.selectedCourseFilters) ? source.selectedCourseFilters : []
    };
}

function isSendToLectraEnabled() {
    return Boolean(contentExtensionSettings.enableSendToLectra);
}

function normalizeLectraButtonPosition(rawValue) {
    if (!rawValue || typeof rawValue !== 'object') return null;
    const left = Number(rawValue.left);
    const top = Number(rawValue.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
        return null;
    }
    return {
        left: Math.round(left),
        top: Math.round(top)
    };
}

function clampLectraButtonPosition(position, button = lectraSendButton) {
    if (!position || !button) return null;
    const rect = button.getBoundingClientRect();
    const maxLeft = Math.max(LECTRA_BUTTON_EDGE_PADDING_PX, window.innerWidth - rect.width - LECTRA_BUTTON_EDGE_PADDING_PX);
    const maxTop = Math.max(LECTRA_BUTTON_EDGE_PADDING_PX, window.innerHeight - rect.height - LECTRA_BUTTON_EDGE_PADDING_PX);
    return {
        left: Math.min(Math.max(LECTRA_BUTTON_EDGE_PADDING_PX, Math.round(position.left)), Math.round(maxLeft)),
        top: Math.min(Math.max(LECTRA_BUTTON_EDGE_PADDING_PX, Math.round(position.top)), Math.round(maxTop))
    };
}

function applyLectraSendButtonPosition(button = lectraSendButton) {
    if (!button) return;

    if (!lectraSendButtonPosition) {
        button.style.left = 'auto';
        button.style.top = 'auto';
        button.style.right = `${LECTRA_BUTTON_DEFAULT_RIGHT_PX}px`;
        button.style.bottom = `${LECTRA_BUTTON_DEFAULT_BOTTOM_PX}px`;
        return;
    }

    const clamped = clampLectraButtonPosition(lectraSendButtonPosition, button);
    if (!clamped) return;
    lectraSendButtonPosition = clamped;
    button.style.left = `${clamped.left}px`;
    button.style.top = `${clamped.top}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
}

async function persistLectraSendButtonPosition(position) {
    try {
        const stored = await chrome.storage.local.get([LECTRA_BUTTON_POSITION_STORAGE_KEY]);
        const positions = stored?.[LECTRA_BUTTON_POSITION_STORAGE_KEY] && typeof stored[LECTRA_BUTTON_POSITION_STORAGE_KEY] === 'object'
            ? { ...stored[LECTRA_BUTTON_POSITION_STORAGE_KEY] }
            : {};
        positions[LECTRA_BUTTON_POSITION_SLOT] = position;
        await chrome.storage.local.set({ [LECTRA_BUTTON_POSITION_STORAGE_KEY]: positions });
    } catch {
        // Ignore storage failures; dragging should still work for the current page.
    }
}

function clearLectraDragHoldTimer() {
    if (lectraSendButtonDragState?.holdTimer) {
        clearTimeout(lectraSendButtonDragState.holdTimer);
        lectraSendButtonDragState.holdTimer = null;
    }
}

function beginLectraSendButtonDrag() {
    if (!lectraSendButton || !lectraSendButtonDragState || lectraSendButtonBusy) return;

    const rect = lectraSendButton.getBoundingClientRect();
    lectraSendButtonDragState.dragging = true;
    lectraSendButtonDragState.startLeft = rect.left;
    lectraSendButtonDragState.startTop = rect.top;
    lectraSuppressNextSendButtonClick = true;

    lectraSendButton.style.transition = 'none';
    lectraSendButton.style.transform = 'translateY(0)';
    lectraSendButton.style.cursor = 'grabbing';
    lectraSendButton.style.left = `${Math.round(rect.left)}px`;
    lectraSendButton.style.top = `${Math.round(rect.top)}px`;
    lectraSendButton.style.right = 'auto';
    lectraSendButton.style.bottom = 'auto';
    document.documentElement.style.userSelect = 'none';
}

function finishLectraSendButtonDrag({ persist = true } = {}) {
    if (!lectraSendButtonDragState) return;
    clearLectraDragHoldTimer();

    if (lectraSendButton && lectraSendButtonDragState.dragging) {
        const finalPosition = clampLectraButtonPosition({
            left: lectraSendButtonDragState.currentLeft,
            top: lectraSendButtonDragState.currentTop
        }, lectraSendButton);
        if (finalPosition) {
            lectraSendButtonPosition = finalPosition;
            applyLectraSendButtonPosition(lectraSendButton);
            if (persist) {
                void persistLectraSendButtonPosition(finalPosition);
            }
        }
        lectraSendButton.style.transition = LECTRA_BUTTON_DEFAULT_TRANSITION;
        lectraSendButton.style.cursor = lectraSendButtonBusy ? 'default' : 'pointer';
    }

    document.documentElement.style.userSelect = '';
    lectraSendButtonDragState = null;
}

function handleLectraSendButtonPointerDown(event) {
    if (!lectraSendButton || lectraSendButtonBusy) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const rect = lectraSendButton.getBoundingClientRect();
    lectraSendButtonDragState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        currentLeft: rect.left,
        currentTop: rect.top,
        dragging: false,
        holdTimer: null
    };

    lectraSendButtonDragState.holdTimer = setTimeout(() => {
        beginLectraSendButtonDrag();
    }, LECTRA_BUTTON_HOLD_TO_DRAG_MS);

    try {
        lectraSendButton.setPointerCapture(event.pointerId);
    } catch {
        // Ignore browsers that reject pointer capture for this element.
    }
}

function handleLectraSendButtonPointerMove(event) {
    if (!lectraSendButton || !lectraSendButtonDragState || lectraSendButtonDragState.pointerId !== event.pointerId) {
        return;
    }

    const deltaX = event.clientX - lectraSendButtonDragState.startClientX;
    const deltaY = event.clientY - lectraSendButtonDragState.startClientY;
    if (!lectraSendButtonDragState.dragging) {
        if (Math.hypot(deltaX, deltaY) > LECTRA_BUTTON_DRAG_CANCEL_DISTANCE_PX) {
            clearLectraDragHoldTimer();
        }
        return;
    }

    event.preventDefault();
    const nextPosition = clampLectraButtonPosition({
        left: lectraSendButtonDragState.startLeft + deltaX,
        top: lectraSendButtonDragState.startTop + deltaY
    }, lectraSendButton);
    if (!nextPosition) return;
    lectraSendButtonDragState.currentLeft = nextPosition.left;
    lectraSendButtonDragState.currentTop = nextPosition.top;
    lectraSendButton.style.left = `${nextPosition.left}px`;
    lectraSendButton.style.top = `${nextPosition.top}px`;
}

function handleLectraSendButtonPointerEnd(event) {
    if (!lectraSendButtonDragState || lectraSendButtonDragState.pointerId !== event.pointerId) {
        return;
    }

    if (lectraSendButtonDragState.dragging) {
        event.preventDefault();
    }

    try {
        lectraSendButton?.releasePointerCapture?.(event.pointerId);
    } catch {
        // Ignore pointer-capture cleanup failures.
    }

    finishLectraSendButtonDrag({ persist: true });
}

function normalizePdfCandidateUrl(rawUrl, baseUrl = window.location.href) {
    if (!rawUrl) return null;
    try {
        const parsed = new URL(rawUrl, baseUrl);
        if (parsed.protocol !== 'https:') return null;
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return null;
    }
}

function isCanvasFilePath(pathname) {
    const path = String(pathname || '').toLowerCase();
    return path.includes('/courses/') && path.includes('/files/');
}

function cleanTitleHint(title) {
    return String(title || '').replace(/\s+/g, ' ').trim();
}

function isGenericPdfTitleHint(title) {
    const cleaned = cleanTitleHint(title);
    if (!cleaned) return true;

    const lowered = cleaned.toLowerCase();
    if (lowered === 'file' || lowered === 'files') return true;
    if (lowered === 'file preview' || lowered === 'preview') return true;
    if (lowered === 'document' || lowered === 'pdf') return true;
    if (lowered === 'download' || lowered === 'open file') return true;
    if (lowered === 'canvas') return true;
    return false;
}

function normalizeDocumentTitleForPdf(rawTitle) {
    const cleaned = cleanTitleHint(rawTitle);
    if (!cleaned) return '';

    const explicitPdf = cleaned.match(/([^|]+?\.pdf)\b/i);
    if (explicitPdf?.[1]) {
        return cleanTitleHint(explicitPdf[1]);
    }

    return cleanTitleHint(
        cleaned
            .replace(/\s+[|:-]\s*(instructure|canvas)(?:\s+files?)?.*$/i, '')
            .replace(/\s+-\s+files?$/i, '')
    );
}

function resolvePdfTitleHint() {
    const selectors = [
        '.ef-name-col__text',
        '.ef-name-col .ellipsible',
        '.file-header h1',
        '.ef-header h1',
        '[data-testid="file-name"]',
        'h1'
    ];

    for (const selector of selectors) {
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
            const candidate = normalizeDocumentTitleForPdf(node?.textContent || '');
            if (!isGenericPdfTitleHint(candidate)) {
                return candidate;
            }
        }
    }

    const docTitle = normalizeDocumentTitleForPdf(document.title || '');
    if (!isGenericPdfTitleHint(docTitle)) {
        return docTitle;
    }

    return '';
}

function collectPdfCandidates() {
    const candidates = [];
    const seen = new Set();
    const addCandidate = (url, source, hintConfidence = 'weak') => {
        const normalized = normalizePdfCandidateUrl(url);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        candidates.push({ url: normalized, source, hintConfidence });
    };

    if (isCanvasFilePath(window.location.pathname)) {
        addCandidate(window.location.href, 'page_url', 'weak');
    }

    const pdfLikeEmbeds = document.querySelectorAll('embed[src], object[data], iframe[src]');
    pdfLikeEmbeds.forEach((element) => {
        const typeAttr = String(element.getAttribute('type') || '').toLowerCase();
        const rawUrl = element.getAttribute('src') || element.getAttribute('data');
        const url = normalizePdfCandidateUrl(rawUrl);
        if (!url) return;

        const isPdfTyped = typeAttr.includes('pdf');
        const looksLikeFileRoute = url.includes('/files/') || url.includes('/download');
        const hint = isPdfTyped ? 'definitive' : (looksLikeFileRoute ? 'strong' : 'weak');
        addCandidate(url, `${element.tagName.toLowerCase()}_embed`, hint);
    });

    const lowerPath = window.location.pathname.toLowerCase();
    const isFolderListingView = lowerPath.includes('/files/folder/');
    const includeBroaderFileRoutes = isCanvasFilePath(window.location.pathname)
        || lowerPath.includes('/files');
    const linkSelector = includeBroaderFileRoutes
        ? 'a.file_download_btn[href], a.instructure_file_link[href], a[href*="/files/"][data-api-endpoint], a[href*="/download"][data-api-endpoint]'
        : 'a.file_download_btn[href], a.instructure_file_link[href]';
    const fileLinks = isFolderListingView ? [] : document.querySelectorAll(linkSelector);
    fileLinks.forEach((link) => {
        const linkText = `${link.textContent || ''} ${link.getAttribute('title') || ''}`.toLowerCase();
        const classText = String(link.className || '').toLowerCase();
        const hasPdfHint = linkText.includes('pdf') || classText.includes('pdf');
        addCandidate(link.href, 'file_link', hasPdfHint ? 'strong' : 'weak');
    });

    if (String(document.contentType || '').toLowerCase().includes('application/pdf')) {
        addCandidate(window.location.href, 'document_content_type', 'strong');
    }

    const titleHint = resolvePdfTitleHint();

    return {
        success: true,
        pageUrl: window.location.href,
        titleHint,
        candidates
    };
}

function ensureLectraSendButton() {
    if (lectraSendButton && lectraSendButton.isConnected) {
        return lectraSendButton;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'canvascope-send-to-lectra-btn';
    button.textContent = 'Send to Lectra';
    button.style.cssText = `
        position: fixed;
        right: 20px;
        bottom: 96px;
        z-index: 2147483000;
        padding: 10px 14px;
        border-radius: 6px;
        border: 1px solid #32384a;
        background: #11141d;
        color: #edf0f8;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 16px 42px rgba(0, 0, 0, 0.38);
        cursor: pointer;
        transition: ${LECTRA_BUTTON_DEFAULT_TRANSITION};
        touch-action: none;
    `;
    button.title = 'Send to Lectra. Press and hold to move.';
    button.addEventListener('mouseenter', () => {
        if (!lectraSendButtonBusy && !lectraSendButtonDragState?.dragging) {
            button.style.transform = 'translateY(-1px)';
        }
    });
    button.addEventListener('mouseleave', () => {
        if (!lectraSendButtonDragState?.dragging) {
            button.style.transform = 'translateY(0)';
        }
    });
    button.addEventListener('pointerdown', handleLectraSendButtonPointerDown);
    button.addEventListener('pointermove', handleLectraSendButtonPointerMove);
    button.addEventListener('pointerup', handleLectraSendButtonPointerEnd);
    button.addEventListener('pointercancel', handleLectraSendButtonPointerEnd);
    button.addEventListener('click', handleLectraSendButtonClick);

    document.body.appendChild(button);
    lectraSendButton = button;
    applyLectraSendButtonPosition(button);
    return button;
}

function removeLectraSendButton() {
    if (lectraSendButton && lectraSendButton.parentNode) {
        lectraSendButton.parentNode.removeChild(lectraSendButton);
    }
    clearLectraDragHoldTimer();
    document.documentElement.style.userSelect = '';
    lectraSendButton = null;
    lectraSendButtonBusy = false;
    lectraSendButtonDragState = null;
}

function setLectraSendButtonState(text, state = 'idle') {
    const button = ensureLectraSendButton();
    button.textContent = text;

    if (state === 'sending') {
        lectraSendButtonBusy = true;
        button.disabled = true;
        button.style.opacity = '0.8';
        button.style.cursor = 'default';
    } else if (state === 'success') {
        lectraSendButtonBusy = false;
        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
        button.style.background = '#101b16';
        button.style.borderColor = 'rgba(111, 206, 154, 0.45)';
        button.style.color = '#6fce9a';
    } else if (state === 'error') {
        lectraSendButtonBusy = false;
        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
        button.style.background = '#211216';
        button.style.borderColor = 'rgba(229, 115, 115, 0.45)';
        button.style.color = '#e57373';
    } else {
        lectraSendButtonBusy = false;
        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
        button.style.background = '#11141d';
        button.style.borderColor = '#32384a';
        button.style.color = '#edf0f8';
    }
}

function scheduleLectraPdfContextRefresh(delayMs = 0) {
    if (lectraPdfRefreshTimer) {
        clearTimeout(lectraPdfRefreshTimer);
    }
    lectraPdfRefreshTimer = setTimeout(refreshLectraPdfContext, delayMs);
}

function refreshLectraPdfContext() {
    if (!isCanvasDomain() || !isSendToLectraEnabled()) {
        removeLectraSendButton();
        return;
    }

    if (!isExtensionContextValid()) {
        removeLectraSendButton();
        if (lectraPdfRefreshTimer) {
            clearTimeout(lectraPdfRefreshTimer);
            lectraPdfRefreshTimer = null;
        }
        return;
    }

    try {
        chrome.runtime.sendMessage({ action: 'resolvePdfContext', mode: 'sender_tab' }, (response) => {
            if (chrome.runtime.lastError) {
                removeLectraSendButton();
                return;
            }

            lectraPdfContext = response || null;
            const confidence = String(response?.confidence || 'none').toLowerCase();
            const shouldShow = Boolean(response?.hasPdf) && (confidence === 'definitive' || confidence === 'strong');

            if (!shouldShow) {
                removeLectraSendButton();
                return;
            }

            setLectraSendButtonState('Send to Lectra', 'idle');
        });
    } catch (err) {
        removeLectraSendButton();
        notifyExtensionContextInvalidated();
        if (lectraPdfRefreshTimer) {
            clearTimeout(lectraPdfRefreshTimer);
            lectraPdfRefreshTimer = null;
        }
    }
}

function handleLectraSendButtonClick() {
    if (lectraSuppressNextSendButtonClick) {
        lectraSuppressNextSendButtonClick = false;
        return;
    }
    if (lectraSendButtonBusy) return;
    if (!isSendToLectraEnabled()) {
        removeLectraSendButton();
        return;
    }

    const candidateUrl = lectraPdfContext?.candidateUrl || null;
    if (!candidateUrl) {
        scheduleLectraPdfContextRefresh(0);
        return;
    }

    const confirmed = window.confirm('Send this PDF to Lectra?');
    if (!confirmed) return;

    setLectraSendButtonState('Sending…', 'sending');

    chrome.runtime.sendMessage({
        action: 'sendPdfToLectra',
        trigger: 'floating_button',
        candidateUrl,
        sourcePageUrl: lectraPdfContext?.sourcePageUrl || window.location.href,
        titleHint: lectraPdfContext?.titleHint || document.title || ''
    }, (response) => {
        if (chrome.runtime.lastError) {
            setLectraSendButtonState('Failed', 'error');
            const runtimeMessage = chrome.runtime.lastError.message || 'Send failed.';
            if (runtimeMessage) {
                window.alert(runtimeMessage);
            }
            setTimeout(() => {
                if (lectraSendButton) {
                    setLectraSendButtonState('Send to Lectra', 'idle');
                }
            }, 1800);
            return;
        }

        if (response?.success) {
            setLectraSendButtonState('Sent ✓', 'success');
            setTimeout(() => {
                if (lectraSendButton) {
                    setLectraSendButtonState('Send to Lectra', 'idle');
                }
            }, 1800);
            return;
        }

        setLectraSendButtonState('Failed', 'error');
        if (response?.message) {
            window.alert(String(response.message));
        }
        setTimeout(() => {
            if (lectraSendButton) {
                setLectraSendButtonState('Send to Lectra', 'idle');
            }
        }, 2200);
    });
}

function installLectraNavigationHooks() {
    if (lectraHooksInstalled) return;
    lectraHooksInstalled = true;

    subscribeToNavigation(() => scheduleLectraPdfContextRefresh(40));

    const observer = new MutationObserver(() => {
        // The feature is off by default; without this guard the observer
        // schedules a refresh for every DOM mutation on every Canvas page.
        if (!isSendToLectraEnabled()) return;
        if (!document.body || !lectraSendButton || !lectraSendButton.isConnected) {
            scheduleLectraPdfContextRefresh(120);
        }
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

function initializeLectraPdfSendUi() {
    if (!isCanvasDomain()) return;
    installLectraNavigationHooks();
    scheduleLectraPdfContextRefresh(0);
    setTimeout(() => scheduleLectraPdfContextRefresh(120), 120);
    window.addEventListener('resize', () => {
        if (lectraSendButton && lectraSendButton.isConnected && lectraSendButtonPosition) {
            applyLectraSendButtonPosition(lectraSendButton);
        }
    });
}

// ============================================
// SYLLABUS AUTOPILOT AUTO-PROMPT
// ============================================
//
// Proactively offers Syllabus Autopilot when the user lands on a page that is
// clearly a syllabus, instead of requiring them to discover the /autopilot
// slash command. Detection is deliberately conservative (strong signals only)
// to avoid false positives; the prompt remembers dismissals so it never nags.

const SYLLABUS_AUTOPILOT_DISMISS_KEY = 'syllabusAutopilotDismissals';
let syllabusPromptTimer = null;
let syllabusPromptHooksInstalled = false;
const syllabusPromptShownThisSession = new Set();
const syllabusMemoryParsedThisSession = new Set();

// Strong syllabus phrases. Course home/landing pages are only treated as syllabi
// when several of these appear, so we don't nag on Modules/Home pages that aren't.
const SYLLABUS_KEYWORDS = [
    'office hours', 'grading', 'academic integrity', 'academic honesty',
    'prerequisite', 'course description', 'course schedule', 'learning objectives',
    'learning outcomes', 'attendance', 'required text', 'textbook', 'late policy',
    'course policies', 'grade breakdown', 'weekly schedule'
];

// True when a clearly-labeled "syllabus" heading/title is present, or the page body
// reads like a syllabus (several strong keywords over a meaningful amount of prose).
function pageLooksLikeSyllabus() {
    if (document.getElementById('course_syllabus')) return true;
    if (/\bsyllab/i.test(document.title || '')) return true;

    const headings = document.querySelectorAll('h1, h2, h3, .page-title, [role="heading"]');
    for (const h of headings) {
        if (/\bsyllab/i.test(h.textContent || '')) return true;
    }

    const content = document.querySelector(
        '#course_syllabus, .user_content, #wiki_page_show, #content, main'
    );
    const text = String(content?.innerText || '').toLowerCase();
    if (text.length > 400) {
        let hits = 0;
        for (const kw of SYLLABUS_KEYWORDS) {
            if (text.includes(kw)) { hits++; if (hits >= 3) return true; }
        }
    }
    return false;
}

// Returns { pdfUrl, key } when the current page is clearly a syllabus, else null.
function detectSyllabusContext() {
    if (!isCanvasDomain()) return null;

    const path = window.location.pathname;
    const courseMatch = path.match(/\/courses\/(\d+)/);

    // 1. Canvas Syllabus tab: /courses/<id>/assignments/syllabus (HTML page text path).
    if (isCanvasSyllabusUrl(window.location.href)) {
        const courseId = courseMatch ? courseMatch[1] : 'unknown';
        return { pdfUrl: null, key: `course/${courseId}/syllabus` };
    }

    // 2. A Canvas file named "syllabus" (file preview or PDF download page).
    const fileMatch = path.match(/\/files\/(\d+)/);
    if (fileMatch) {
        let decodedPath = '';
        try { decodedPath = decodeURIComponent(path); } catch (_) { decodedPath = path; }
        const haystack = `${document.title || ''} ${decodedPath}`;
        if (/\bsyllab/i.test(haystack)) {
            const pdfUrl = `${window.location.origin}/files/${fileMatch[1]}/download?download_frd=1`;
            return { pdfUrl, key: `file/${fileMatch[1]}` };
        }
    }

    // 3. Course home/front page or a Page (e.g. /courses/<id>, /courses/<id>/pages/<slug>,
    //    /courses/<id>/wiki) whose content actually reads like a syllabus. Many instructors
    //    set the course home page to be the syllabus, so this is a common real case.
    if (courseMatch) {
        const isHomeOrPage =
            /^\/courses\/\d+\/?$/.test(path) ||
            /^\/courses\/\d+\/(pages|wiki|front_page)\b/i.test(path);
        if (isHomeOrPage && pageLooksLikeSyllabus()) {
            // Key off the page path so re-prompts are remembered per page.
            return { pdfUrl: null, key: `page${path.replace(/\/$/, '')}` };
        }
    }

    return null;
}

function isAutopilotAutoPromptEnabled() {
    return contentExtensionSettings.autopilotAutoPrompt !== false;
}

function removeSyllabusPrompt() {
    try { window.CanvascopeAcademicTools?.removeSyllabusAutopilotPrompt?.(); } catch (_) {}
}

// Read the syllabus body text from the DOM (HTML syllabus pages). Used to feed
// the background memory parser without re-fetching the page.
function readSyllabusDomText() {
    const sel = document.querySelector(
        '#course_syllabus, .syllabus_course_summary, #wiki_page_show, .user_content, #content, main'
    );
    let text = sel ? sel.innerText : '';
    if (!text || text.length < 60) text = document.body ? document.body.innerText : '';
    return String(text || '').slice(0, 16000);
}

// Minimal, self-removing toast (no shadow DOM dependency).
function showCanvascopeToast(message) {
    try {
        const el = document.createElement('div');
        el.textContent = message;
        el.style.cssText = [
            'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
            'background:#11141d', 'color:#e8ebf2', 'padding:10px 14px',
            'border-radius:10px', 'font:500 13px/1.3 system-ui,sans-serif',
            'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'opacity:0',
            'transition:opacity .2s ease'
        ].join(';');
        document.body.appendChild(el);
        requestAnimationFrame(() => { el.style.opacity = '1'; });
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 2600);
    } catch (_) { /* non-critical */ }
}

// Parse the detected syllabus into structured memory in the background. Fires
// once per syllabus per session; the background dedupes token spend by content
// hash. Runs regardless of the calendar prompt setting — the syllabus is saved
// even if the user declines adding deadlines to their calendar.
function maybeAutoParseSyllabusToMemory(ctx) {
    if (!ctx || !isExtensionContextValid()) return;
    if (syllabusMemoryParsedThisSession.has(ctx.key)) return;
    const courseMatch = window.location.pathname.match(/\/courses\/(\d+)/);
    const courseId = courseMatch ? courseMatch[1] : null;
    if (!courseId) return; // need a course to key the memory entry
    syllabusMemoryParsedThisSession.add(ctx.key);

    const course = getCourseContext();
    const payload = {
        action: 'parseSyllabusToMemory',
        courseId,
        courseName: course.title || '',
        host: window.location.hostname,
        pdfUrl: ctx.pdfUrl || null,
        syllabusText: ctx.pdfUrl ? null : readSyllabusDomText()
    };
    try {
        chrome.runtime.sendMessage(payload, (res) => {
            void chrome.runtime.lastError; // swallow service-worker disconnects
            if (res && res.success && res.firstParse) showCanvascopeToast('Syllabus saved');
        });
    } catch (_) { /* extension context invalidated */ }
}

async function maybeShowSyllabusPrompt() {
    if (!isExtensionContextValid()) return;

    const ctx = detectSyllabusContext();
    if (!ctx) { removeSyllabusPrompt(); return; }

    // Always parse the syllabus into memory on detection — independent of the
    // calendar autopilot prompt below.
    maybeAutoParseSyllabusToMemory(ctx);

    if (!isAutopilotAutoPromptEnabled()) { removeSyllabusPrompt(); return; }

    // Already shown this session for this syllabus → leave the existing card alone.
    if (syllabusPromptShownThisSession.has(ctx.key)) return;

    // Previously dismissed or synced (persisted across sessions) → never re-prompt.
    let dismissed = false;
    try {
        const { [SYLLABUS_AUTOPILOT_DISMISS_KEY]: map } =
            await chrome.storage.local.get([SYLLABUS_AUTOPILOT_DISMISS_KEY]);
        dismissed = Boolean(map && map[ctx.key]);
    } catch (_) {}
    if (dismissed) return;

    const tools = window.CanvascopeAcademicTools;
    if (!tools || typeof tools.showSyllabusAutopilotPrompt !== 'function') return;

    syllabusPromptShownThisSession.add(ctx.key);
    tools.showSyllabusAutopilotPrompt(ctx);
}

function scheduleSyllabusPromptCheck(delayMs = 0) {
    if (syllabusPromptTimer) clearTimeout(syllabusPromptTimer);
    syllabusPromptTimer = setTimeout(() => { maybeShowSyllabusPrompt(); }, delayMs);
}

function installSyllabusPromptHooks() {
    if (syllabusPromptHooksInstalled) return;
    syllabusPromptHooksInstalled = true;
    subscribeToNavigation(() => scheduleSyllabusPromptCheck(120));
}

function initializeSyllabusAutopilotPrompt() {
    if (!isCanvasDomain()) return;
    installSyllabusPromptHooks();
    scheduleSyllabusPromptCheck(0);
    setTimeout(() => scheduleSyllabusPromptCheck(120), 120);
    // Home/front-page syllabus content can render a beat after idle; re-check once
    // it has settled so the keyword scan sees the full page body.
    setTimeout(() => scheduleSyllabusPromptCheck(0), 700);
}

// Dev helper: forget every dismissed/synced syllabus (persisted + this-session)
// so the prompt can fire again on a page you already responded to. Exposed on
// window so the gated /resetsyllabus slash command can call it without a reload.
async function clearSyllabusAutopilotMemory() {
    syllabusPromptShownThisSession.clear();
    try { await chrome.storage.local.remove(SYLLABUS_AUTOPILOT_DISMISS_KEY); } catch (_) {}
    removeSyllabusPrompt();
    scheduleSyllabusPromptCheck(0);
}
window.__canvascopeClearSyllabusMemory = clearSyllabusAutopilotMemory;

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
        scheduleCourseMaterialDiscovery(250, 'scan');

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

function normalizeCanvasItemUrl(rawUrl, baseUrl = window.location.href) {
    if (!rawUrl) return '';
    try {
        const parsed = new URL(rawUrl, baseUrl);
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function normalizeCanvasText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getCanvasBreadcrumbSegments() {
    return Array.from(document.querySelectorAll(CANVAS_SELECTORS.breadcrumb))
        .map(node => safeGetText(node.querySelector('a') || node))
        .map(text => text.trim())
        .filter(Boolean);
}

function extractWeekHintsFromTextParts(values) {
    const hints = new Set();
    const inputs = Array.isArray(values) ? values : [values];

    for (const value of inputs) {
        const text = String(value || '');
        if (!text) continue;

        const regex = /\bweek\s*#?\s*0*(\d{1,3})\b/ig;
        let match = regex.exec(text);
        while (match) {
            const normalized = String(match[1] || '').replace(/^0+/, '') || '0';
            hints.add(normalized);
            match = regex.exec(text);
        }
    }

    return Array.from(hints);
}

function isCanvasSyllabusUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl, window.location.href);
        return /\/courses\/\d+\/assignments\/syllabus(?:\/|$)/i.test(parsed.pathname);
    } catch {
        return false;
    }
}

function getCanvasFileBrowserContext(courseContext) {
    const path = String(window.location.pathname || '').toLowerCase();
    if (!path.includes('/courses/') || !path.includes('/files')) {
        return null;
    }

    const breadcrumbSegments = getCanvasBreadcrumbSegments();
    const normalizedCourse = normalizeCanvasText(courseContext?.title || '');
    let pathSegments = [];

    if (breadcrumbSegments.length > 0) {
        const courseIndex = normalizedCourse
            ? breadcrumbSegments.findIndex(segment => normalizeCanvasText(segment) === normalizedCourse)
            : -1;

        if (courseIndex >= 0) {
            pathSegments = breadcrumbSegments.slice(courseIndex + 1);
        }
    }

    if (!path.includes('/files/folder/')) {
        pathSegments = [];
    } else if (pathSegments.length === 0) {
        const heading = safeGetText(document.querySelector('h1'));
        if (heading) {
            pathSegments = [heading.trim()];
        }
    }

    return {
        url: normalizeCanvasItemUrl(window.location.href),
        isFolderRoute: path.includes('/files/folder/'),
        pathSegments,
        folderPath: pathSegments.join(' > '),
        currentTitle: pathSegments[pathSegments.length - 1] || 'Files',
        moduleName: pathSegments[0] || 'Files',
        weekHints: extractWeekHintsFromTextParts(pathSegments)
    };
}

function buildCanvasFileBrowserItem(courseContext, title, url, pathSegments) {
    const normalizedUrl = normalizeCanvasItemUrl(url);
    const segments = Array.isArray(pathSegments)
        ? pathSegments.map(segment => String(segment || '').trim()).filter(Boolean)
        : [];

    return {
        title: String(title || '').trim(),
        url: normalizedUrl,
        type: 'folder',
        moduleName: segments[0] || 'Files',
        folderPath: segments.join(' > '),
        pathSegments: segments,
        pathDepth: segments.length,
        weekHints: extractWeekHintsFromTextParts(segments),
        containerUrl: normalizedUrl,
        courseName: courseContext.title,
        courseId: courseContext.id,
        scannedAt: new Date().toISOString()
    };
}

function scanCanvasFileBrowser(courseContext) {
    const browserContext = getCanvasFileBrowserContext(courseContext);
    if (!browserContext) return [];

    const content = [];
    const seen = new Set();
    const addItem = (item) => {
        if (!item?.url || !item?.title || seen.has(item.url)) return;
        seen.add(item.url);
        content.push(item);
    };

    if (browserContext.isFolderRoute && browserContext.folderPath) {
        addItem(buildCanvasFileBrowserItem(
            courseContext,
            browserContext.currentTitle,
            browserContext.url,
            browserContext.pathSegments
        ));
    }

    const folderLinks = document.querySelectorAll(
        '#content a[href*="/files/folder/"], main a[href*="/files/folder/"], a[href*="/files/folder/"]'
    );

    folderLinks.forEach(link => {
        if (!link.href || !isCanvasUrl(link.href)) return;
        if (link.closest('nav, header, footer, #breadcrumbs, #section-tabs')) return;

        const title = safeGetText(link) || link.getAttribute('title') || link.getAttribute('aria-label');
        if (!title) return;

        const rowSegments = [...browserContext.pathSegments, title.trim()];
        addItem(buildCanvasFileBrowserItem(courseContext, title, link.href, rowSegments));
    });

    return content;
}

function parseCanvasLinkNext(linkHeader) {
    const header = String(linkHeader || '');
    if (!header) return '';
    for (const part of header.split(',')) {
        const section = part.trim();
        if (!/rel="?next"?/i.test(section)) continue;
        const match = section.match(/<([^>]+)>/);
        if (match) return match[1];
    }
    return '';
}

async function fetchCanvasApiPaginated(pathOrUrl, maxPages = COURSE_MATERIAL_DISCOVERY_MAX_PAGES) {
    const out = [];
    let nextUrl = new URL(pathOrUrl, window.location.origin).toString();
    let pages = 0;

    while (nextUrl && pages < maxPages) {
        const response = await fetch(nextUrl, {
            credentials: 'include',
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) break;
        const data = await response.json();
        if (Array.isArray(data)) out.push(...data);
        else if (data && typeof data === 'object') out.push(data);
        nextUrl = parseCanvasLinkNext(response.headers.get('Link'));
        pages += 1;
    }

    return out;
}

function canvasFolderSegments(folder, courseTitle = '') {
    const raw = normalizeCanvasText(folder?.full_name || folder?.name || '');
    const parts = String(folder?.full_name || folder?.name || '')
        .split('/')
        .map(part => part.trim())
        .filter(Boolean);
    const normalizedCourse = normalizeCanvasText(courseTitle);
    return parts.filter((part, index) => {
        const normalized = normalizeCanvasText(part);
        if (!normalized) return false;
        if (normalizedCourse && normalized === normalizedCourse) return false;
        if (index === 0 && (normalized === 'course files' || normalized === 'files')) return false;
        if (raw === normalized && normalized === 'course files') return false;
        return true;
    });
}

function buildModuleNameByFileId(modules) {
    const byId = new Map();
    for (const module of Array.isArray(modules) ? modules : []) {
        const moduleName = normalizeCanvasText(module?.name || module?.title || '');
        const items = Array.isArray(module?.items) ? module.items : [];
        for (const item of items) {
            const urlFileId = String(item?.html_url || '').match(/\/files\/(\d+)/)?.[1] || '';
            const id = item?.content_id || item?.file_id || urlFileId;
            if (!id || !moduleName) continue;
            byId.set(String(id), moduleName);
        }
    }
    return byId;
}

function normalizeCanvasFileTitle(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .replace(/\s*(download|preview|open)\s*$/i, '')
        .trim();
}

function collectVisibleCanvasFileDocuments(courseContext) {
    const browserContext = getCanvasFileBrowserContext(courseContext);
    const docs = [];
    const seen = new Set();
    const links = document.querySelectorAll(
        'a[href*="/files/"], a[href*="preview="], a.instructure_file_link, a.file_download_btn'
    );

    links.forEach(link => {
        if (!link.href || !isCanvasUrl(link.href)) return;
        if (link.closest('nav, header, footer, #breadcrumbs, #section-tabs')) return;
        const fileId = link.href.match(/[?&]preview=(\d+)/)?.[1] || link.href.match(/\/files\/(\d+)/)?.[1] || '';
        if (!fileId) return;
        const title = normalizeCanvasFileTitle(
            link.getAttribute('title') || link.getAttribute('aria-label') || safeGetText(link)
        );
        if (!title) return;
        const key = `${fileId}|${title}`;
        if (seen.has(key)) return;
        seen.add(key);
        const sourceUrl = `${window.location.origin}/courses/${courseContext.id}/files/${fileId}`;
        const pathSegments = browserContext?.pathSegments || [];
        docs.push({
            courseId: courseContext.id,
            courseName: courseContext.title,
            canvasFileId: fileId,
            title,
            url: sourceUrl,
            sourceUrl,
            downloadUrl: `${window.location.origin}/files/${fileId}/download`,
            folderPath: browserContext?.folderPath || '',
            pathSegments,
            moduleName: browserContext?.moduleName || 'Files',
            weekHints: extractWeekHintsFromTextParts([...(pathSegments || []), title]),
            discoveredAt: new Date().toISOString()
        });
    });

    return docs;
}

async function discoverCourseMaterialDocuments(courseContext) {
    if (!courseContext?.id) return [];

    const docs = collectVisibleCanvasFileDocuments(courseContext);
    const seenIds = new Set(docs.map(doc => doc.canvasFileId).filter(Boolean));

    let files = [];
    let folders = [];
    let modules = [];
    try {
        [files, folders, modules] = await Promise.all([
            fetchCanvasApiPaginated(`/api/v1/courses/${courseContext.id}/files?per_page=100`),
            fetchCanvasApiPaginated(`/api/v1/courses/${courseContext.id}/folders?per_page=100`),
            fetchCanvasApiPaginated(`/api/v1/courses/${courseContext.id}/modules?include[]=items&per_page=100`)
        ]);
    } catch (error) {
        console.warn('[Canvascope CourseMaterials] Canvas API discovery failed, using visible file links only:', error);
    }

    const folderById = new Map();
    folders.forEach(folder => {
        if (folder?.id != null) folderById.set(String(folder.id), folder);
    });
    const moduleByFileId = buildModuleNameByFileId(modules);

    for (const file of files) {
        const fileId = file?.id != null ? String(file.id) : '';
        if (!fileId || seenIds.has(fileId)) continue;
        const title = normalizeCanvasFileTitle(file.display_name || file.filename || file.name || '');
        if (!title) continue;
        const mimeType = file['content-type'] || file.content_type || file.mime_class || '';
        const folder = folderById.get(String(file.folder_id || ''));
        const pathSegments = canvasFolderSegments(folder, courseContext.title);
        const sourceUrl = `${window.location.origin}/courses/${courseContext.id}/files/${fileId}`;
        const moduleName = moduleByFileId.get(fileId) || pathSegments[0] || 'Files';
        seenIds.add(fileId);
        docs.push({
            courseId: courseContext.id,
            courseName: courseContext.title,
            canvasFileId: fileId,
            title,
            url: sourceUrl,
            sourceUrl,
            downloadUrl: `${window.location.origin}/files/${fileId}/download`,
            mimeType,
            folderPath: pathSegments.join(' > '),
            pathSegments,
            moduleName,
            weekHints: extractWeekHintsFromTextParts([...pathSegments, moduleName, title]),
            modifiedAt: file.modified_at || file.updated_at || file.created_at || null,
            discoveredAt: new Date().toISOString()
        });
    }

    return docs;
}

async function discoverAndSendCourseMaterials(reason = 'auto') {
    if (!isCanvasDomain()) return { success: false, error: 'not_canvas' };
    const courseContext = getCourseContext();
    if (!courseContext?.id) return { success: false, error: 'no_course' };

    const docs = await discoverCourseMaterialDocuments(courseContext);
    if (!docs.length) return { success: true, discovered: 0 };

    const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
            action: 'courseMaterialsDiscovered',
            reason,
            courseId: courseContext.id,
            courseName: courseContext.title,
            documents: docs
        }, (res) => resolve(res || { success: false, error: chrome.runtime.lastError?.message || 'no-response' }));
    });

    console.log(`[Canvascope CourseMaterials] discovered ${docs.length} course files (${reason})`, response);
    return { success: !!response.success, discovered: docs.length, queued: response.queued || 0, response };
}

function scheduleCourseMaterialDiscovery(delayMs = 1200, reason = 'auto') {
    if (courseMaterialDiscoveryTimer) clearTimeout(courseMaterialDiscoveryTimer);
    courseMaterialDiscoveryTimer = setTimeout(() => {
        try {
            if (!isCanvasDomain()) return;
            const courseContext = getCourseContext();
            if (!courseContext?.id) return;
            const last = courseMaterialDiscoveryLastAt.get(courseContext.id) || 0;
            if (Date.now() - last < COURSE_MATERIAL_DISCOVERY_MIN_MS && reason !== 'message') return;
            courseMaterialDiscoveryLastAt.set(courseContext.id, Date.now());
            discoverAndSendCourseMaterials(reason).catch(error => {
                console.warn('[Canvascope CourseMaterials] auto discovery failed:', error);
            });
        } catch (error) {
            console.warn('[Canvascope CourseMaterials] discovery scheduler failed:', error);
        }
    }, delayMs);
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

    // Scan file-browser folders and current breadcrumb container
    const fileBrowserContent = scanCanvasFileBrowser(courseContext);
    content.push(...fileBrowserContent);

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
        const url = normalizeCanvasItemUrl(link.href);

        if (title && url) {
            const isSyllabus = isCanvasSyllabusUrl(url) || /\bsyllabus\b/i.test(title);
            content.push({
                title: isSyllabus && courseContext.title
                    ? `${courseContext.title} Syllabus`
                    : title.trim(),
                url: url,
                type: isSyllabus ? 'syllabus' : 'navigation',
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
    const browserContext = getCanvasFileBrowserContext(courseContext);

    // Look for file download links
    const fileLinks = document.querySelectorAll(CANVAS_SELECTORS.fileLinks);

    fileLinks.forEach(link => {
        const title = safeGetText(link) || link.getAttribute('title') ||
            getFilenameFromUrl(link.href);
        const url = normalizeCanvasItemUrl(link.href);

        if (title && url && isCanvasUrl(url)) {
            content.push({
                title: title.trim(),
                url: url,
                type: 'file',
                moduleName: browserContext?.currentTitle || 'Files',
                folderPath: browserContext?.folderPath || '',
                pathSegments: Array.isArray(browserContext?.pathSegments) ? browserContext.pathSegments.slice() : [],
                pathDepth: browserContext?.pathSegments?.length || 0,
                weekHints: Array.isArray(browserContext?.weekHints) ? browserContext.weekHints.slice() : [],
                containerUrl: browserContext?.url || null,
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
    const browserContext = getCanvasFileBrowserContext(courseContext);

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
            const url = normalizeCanvasItemUrl(link.href);
            const lowerUrl = url.toLowerCase();

            if (lowerUrl.includes('/assignments/syllabus')) type = 'syllabus';
            else if (lowerUrl.includes('/assignments/')) type = 'assignment';
            else if (lowerUrl.includes('/quizzes/')) type = 'quiz';
            else if (lowerUrl.includes('/discussion_topics/')) type = 'discussion';
            else if (lowerUrl.includes('/pages/')) type = 'page';
            else if (lowerUrl.includes('/files/folder/')) type = 'folder';
            else if (lowerUrl.includes('/files/')) type = 'file';
            else if (lowerUrl.includes('/modules/')) type = 'module';
            else if (lowerUrl.includes('/announcements/')) type = 'announcement';
            else if (lowerUrl.includes('/grades')) type = 'grades';

            // IMPORTANT: Check if this link belongs to the current course context
            const linkCourseId = extractCourseId(url);
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
                title: type === 'syllabus' && courseContext.title
                    ? `${courseContext.title} Syllabus`
                    : title.trim(),
                url,
                type: type,
                moduleName: type === 'folder'
                    ? (browserContext?.moduleName || 'Files')
                    : itemModuleName,
                folderPath: type === 'folder'
                    ? [...(browserContext?.pathSegments || []), title.trim()].join(' > ')
                    : '',
                pathSegments: type === 'folder'
                    ? [...(browserContext?.pathSegments || []), title.trim()]
                    : [],
                pathDepth: type === 'folder'
                    ? [...(browserContext?.pathSegments || []), title.trim()].length
                    : 0,
                weekHints: type === 'folder'
                    ? extractWeekHintsFromTextParts([...(browserContext?.pathSegments || []), title.trim()])
                    : [],
                containerUrl: type === 'folder' ? url : null,
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
    initializeLectraPdfSendUi();
    initializeSyllabusAutopilotPrompt();
} else {
    console.log('[Canvascope Content] Not a supported LMS page, staying dormant');
}

// ============================================
// SEARCH OVERLAY (Cmd+K)
// ============================================

let overlayContainer = null;
let overlayIframe = null;
let overlayVisible = false;
let overlayAskActive = false; // popup is showing an inline answer — keep it open

/**
 * Create and inject the search overlay
 */
function createOverlay() {
    if (overlayContainer) return;

    // Resolve the popup URL FIRST so we fail fast if the extension was reloaded
    // (chrome.runtime.getURL throws once the runtime context is invalidated).
    let popupUrl;
    try {
        popupUrl = chrome.runtime.getURL('src/popup/popup.html?mode=overlay');
    } catch (err) {
        notifyExtensionContextInvalidated();
        return;
    }

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
        align-items: flex-start;
        justify-content: center;
        padding-top: 12vh;
        background: rgba(0, 0, 0, 0.40);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
    `;

    // Create iframe
    overlayIframe = document.createElement('iframe');
    overlayIframe.src = popupUrl;
    overlayIframe.allow = "clipboard-write"; // Allow copying
    overlayIframe.style.cssText = `
        width: min(640px, calc(100vw - 32px));
        height: min(620px, 78vh);
        border: none;
        border-radius: 8px;
        box-shadow:
            0 24px 60px rgba(0, 0, 0, 0.55),
            0 0 0 1px rgba(255, 255, 255, 0.10);
        background: transparent;
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
        transform: scale(0.96);
        opacity: 0;
    `;

    // Close on click outside — unless an inline answer is showing, in which
    // case the conversation stays open (Escape inside the popup goes back).
    overlayContainer.addEventListener('click', (e) => {
        if (e.target === overlayContainer && !overlayAskActive) {
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
    if (!overlayContainer) return; // createOverlay bailed (extension context gone)

    if (overlayVisible) {
        hideOverlay();
    } else {
        showOverlay();
    }
}

function showOverlay() {
    if (!overlayContainer) createOverlay();
    if (!overlayContainer) return;

    overlayVisible = true;
    overlayContainer.style.display = 'flex';
    document.body.style.overflow = 'hidden'; // Prevent background scrolling

    // Focus iframe
    requestAnimationFrame(() => {
        overlayIframe.style.transform = 'scale(1)';
        overlayIframe.style.opacity = '1';
        overlayIframe.focus();
        // Send message to popup to focus input (with delay for re-open cases)
        setTimeout(() => {
            overlayIframe.contentWindow.postMessage({ type: 'FOCUS_INPUT' }, '*');
        }, 100);
    });
}

function hideOverlay() {
    if (!overlayContainer) return;

    overlayVisible = false;
    overlayAskActive = false;

    // Tell the iframe to clear its search input
    if (overlayIframe && overlayIframe.contentWindow) {
        overlayIframe.contentWindow.postMessage({ type: 'CLEAR_SEARCH' }, '*');
    }
    // CRITICAL FIX: Chrome focus-trapping bug workaround.
    // Detaching the iframe completely destroys its focus context instantly
    // and guarantees keyboard events return to the parent document.
    let parent = null;
    if (overlayIframe && overlayIframe.parentNode) {
        parent = overlayIframe.parentNode;
        parent.removeChild(overlayIframe);
    }

    // Fade out the backdrop
    overlayContainer.style.opacity = '0';
    document.body.style.overflow = ''; // Restore page scroll

    setTimeout(() => {
        overlayContainer.style.display = 'none';
        overlayContainer.style.opacity = '';

        // Reset state for next open and re-attach
        if (overlayIframe && parent) {
            overlayIframe.style.transform = 'scale(0.95)';
            overlayIframe.style.opacity = '0';
            parent.appendChild(overlayIframe);
        }
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

// ============================================
// AUTO-INDEX PDFs ON VIEW (persistent full-text search)
// When a student opens a Canvas file/PDF, parse its text once and persist it into
// indexedContent so the body stays searchable from the Cmd+K and "/" overlays even
// after the tab is closed. The heavy pdf.js parse is delegated to the background,
// which injects the parser into this tab only when a PDF is actually present.
// ============================================

let __canvascopeAutoIndexLastUrl = '';
const __canvascopeAutoIndexed = new Set();

function detectCanvasFileId() {
    try {
        const u = new URL(window.location.href);
        const preview = u.searchParams.get('preview');
        if (preview && /^\d+$/.test(preview)) return preview;
        const m = u.pathname.match(/\/files\/(\d+)(?:\/|$)/);
        if (m) return m[1];
        return null;
    } catch (_) { return null; }
}

function resolveCourseNameHint() {
    const selectors = [
        '#breadcrumbs li:nth-child(2) a .ellipsible',
        '#breadcrumbs li:nth-child(2) a',
        '.ic-app-course-menu .ellipsible',
        '#course_name'
    ];
    for (const s of selectors) {
        const el = document.querySelector(s);
        const t = (el?.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length > 1 && t.toLowerCase() !== 'home') return t.slice(0, 120);
    }
    return null;
}

function fileTitleHintForId(fileId) {
    if (fileId) {
        const link = document.querySelector(`a[href*="preview=${fileId}"], a[href*="/files/${fileId}"]`);
        const t = cleanTitleHint(link?.textContent || '');
        if (t && !isGenericPdfTitleHint(t)) return t;
    }
    const hint = resolvePdfTitleHint();
    return hint && !isGenericPdfTitleHint(hint) ? hint : null;
}

function maybeAutoIndexPdf() {
    try {
        if (!(isSupportedLmsDomain() || detectCanvasPage())) return;
        const href = window.location.href;
        const fileId = detectCanvasFileId();

        let pdfUrl = null;
        let key = null;
        if (fileId) {
            pdfUrl = `${window.location.origin}/files/${fileId}/download`;
            key = `id:${fileId}`;
        } else if (String(document.contentType || '').toLowerCase().includes('application/pdf')) {
            pdfUrl = href;
            key = `url:${href.split('?')[0]}`;
        }
        if (!pdfUrl || !key || __canvascopeAutoIndexed.has(key)) return;
        __canvascopeAutoIndexed.add(key);

        const titleHint = fileTitleHintForId(fileId);
        const courseName = resolveCourseNameHint();
        chrome.runtime.sendMessage({
            action: 'autoIndexPdf',
            pdfUrl,
            titleHint: titleHint || null,
            courseName: courseName || null
        }, () => { void chrome.runtime.lastError; });
        console.log('[Canvascope AutoIndex] requested indexing for', pdfUrl, '(title:', titleHint, ')');
    } catch (e) {
        console.warn('[Canvascope AutoIndex] detection failed:', e);
    }
}

// Run shortly after load (give Canvas time to render the file name), then watch for
// SPA route changes (opening a file preview swaps ?preview=<id> without a full reload).
// Event-driven via the shared navigation watcher — no polling.
(function startAutoIndexWatcher() {
    __canvascopeAutoIndexLastUrl = window.location.href;
    setTimeout(maybeAutoIndexPdf, 1800);
    subscribeToNavigation(() => {
        if (window.location.href === __canvascopeAutoIndexLastUrl) return;
        __canvascopeAutoIndexLastUrl = window.location.href;
        setTimeout(maybeAutoIndexPdf, 1500);
    });
})();

(function startCourseMaterialDiscoveryWatcher() {
    if (!isCanvasDomain()) return;
    scheduleCourseMaterialDiscovery(2200, 'page-load');
    subscribeToNavigation(() => scheduleCourseMaterialDiscovery(1800, 'navigation'));
})();

function isCmdKEvent(e) {
    if (!e || !(e.metaKey || e.ctrlKey)) return false;
    if (e.altKey) return false;
    const key = String(e.key || '').toLowerCase();
    return e.code === 'KeyK' || key === 'k';
}

// Listen for Command+K (Mac) or Ctrl+K (Windows)
document.addEventListener('keydown', (e) => {
    // Check for Cmd+K (Mac) or Ctrl+K (Windows/Linux)
    if (isCmdKEvent(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') {
            e.stopImmediatePropagation();
        }

        // Ensure we are on a valid page (double check)
        if (isSupportedLmsDomain() || detectCanvasPage() || detectBrightspacePage()) {
            toggleOverlay();
        }
    }

    // `/` opens the same Cmd+K palette (the standalone slash menu is retired).
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !overlayVisible) {
        if (isEditableTarget(document.activeElement)) return;
        if (isSupportedLmsDomain() || detectCanvasPage() || detectBrightspacePage()) {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            showOverlay();
        }
    }

    // Close on Escape if overlay is open
    if (e.key === 'Escape') {
        if (overlayVisible) {
            e.preventDefault();
            e.stopPropagation();
            hideOverlay();
        }
    }
}, true);

// After a refresh, Chrome often leaves keyboard focus in the omnibox or inside a
// Canvas subframe, so the top-document keydown listener above never fires until the
// user clicks the page. Reclaim focus to the top document on load (and whenever the
// tab becomes visible again) so Cmd+K / `/` work immediately without a click first.
(function ensurePageFocusForShortcuts() {
    function reclaimFocus() {
        try {
            // Only on the pages where the palette actually runs.
            if (!(isSupportedLmsDomain() || detectCanvasPage() || detectBrightspacePage())) return;
            // Don't yank focus away from a field the user is (or could be) typing in.
            if (isEditableTarget(document.activeElement)) return;
            if (document.hasFocus()) return;
            window.focus();
        } catch (_) { /* best effort */ }
    }

    // Initial reclaim (the script runs at document_idle, but retry a couple of times
    // in case Canvas focuses a subframe slightly after we load).
    reclaimFocus();
    setTimeout(reclaimFocus, 250);
    setTimeout(reclaimFocus, 1000);

    // Reclaim when the user switches back to this tab.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reclaimFocus();
    });
    window.addEventListener('focus', reclaimFocus);
})();

// True when focus is in a field where `/` should type literally, not open Cmd+K.
function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute && el.getAttribute('role') === 'textbox') return true;
    return false;
}

// Listen for messages from the iframe/popup (strict origin + source check)
window.addEventListener('message', (event) => {
    const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
    if (event.origin !== extensionOrigin) return;
    if (!overlayIframe || event.source !== overlayIframe.contentWindow) return;

    if (event.data && event.data.type === 'CLOSE_OVERLAY') {
        hideOverlay();
    }

    if (event.data && event.data.type === 'CS_ASK_ACTIVE') {
        overlayAskActive = !!event.data.active;
    }

    if (event.data && event.data.type === 'CANVASCOPE_RUN_ACTION') {
        runOverlayAction(event.data.action, event.data.arg);
    }
});

// Parse a trailing "in 1h" / "in 30m" / "tomorrow 9am" out of a reminder phrase.
function parseReminderWhen(q) {
    const inMatch = q.match(/\bin\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)\b/i);
    if (inMatch) {
        const n = Number(inMatch[1]);
        const unit = inMatch[2].toLowerCase();
        const ms = /m/.test(unit) && !/h|d/.test(unit) ? n * 60 * 1000
                 : /h/.test(unit) ? n * 3600 * 1000
                 : n * 86400 * 1000;
        return { at: Date.now() + ms, start: inMatch.index };
    }
    const tomMatch = q.match(/\btomorrow(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b/i);
    if (tomMatch) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const hr = tomMatch[1]
            ? Number(tomMatch[1]) + (tomMatch[3]?.toLowerCase() === 'pm' && Number(tomMatch[1]) < 12 ? 12 : 0)
            : 9;
        d.setHours(hr, tomMatch[2] ? Number(tomMatch[2]) : 0, 0, 0);
        return { at: d.getTime(), start: tomMatch.index };
    }
    return null;
}

// Run a Cmd+K command that targets in-page tooling (academic tools / background),
// then close the overlay. These globals live in the same content-script world.
function runOverlayAction(action, arg) {
    const tools = window.CanvascopeAcademicTools || null;
    const text = String(arg || '').trim();
    try {
        switch (action) {
            case 'gpa':       tools?.openGpaCalculator?.(text || undefined); break;
            case 'grades':    tools?.openGradesSummary?.(); break;
            case 'zen':       tools?.openZenSpace?.(); break;
            case 'notes':     tools?.openNotesBrowser?.(); break;
            case 'note':      if (text) tools?.quickCaptureNote?.(text); break;
            case 'todo':      if (text) tools?.addTodo?.(text); break;
            case 'autopilot': tools?.openSyllabusAutopilot?.(); break;
            case 'sync':
                chrome.runtime.sendMessage({ action: 'csSync.forceAll' }, () => void chrome.runtime.lastError);
                break;
            case 'remind': {
                if (!text) break;
                const when = parseReminderWhen(text);
                const subject = when ? text.slice(0, when.start).trim() : text;
                chrome.runtime.sendMessage({
                    action: 'csReminders.scheduleOnce',
                    title: subject || text,
                    body: 'Canvascope reminder',
                    at: when?.at || (Date.now() + 60 * 60 * 1000)
                }, () => void chrome.runtime.lastError);
                break;
            }
            default: break;
        }
    } catch (err) {
        console.warn('[Canvascope] overlay action failed:', action, err);
    }
    hideOverlay();
}

// Also listen to runtime messages just in case
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'closeOverlay') {
        hideOverlay();
    }
    // The popup's AI button opens Cmd+K on this tab instead of the side panel.
    if (message.action === 'openOverlay') {
        if (isSupportedLmsDomain() || detectCanvasPage() || detectBrightspacePage()) {
            showOverlay();
            sendResponse?.({ ok: true });
        } else {
            sendResponse?.({ ok: false });
        }
        return true;
    }
});
