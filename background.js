/**
 * ============================================
 * Canvascope - Background Service Worker (background.js)
 * ============================================
 * 
 * PURPOSE:
 * - Automatically scans Canvas courses in the background
 * - Triggers when Canvas tabs are detected
 * - Runs periodic updates to keep content fresh
 * - No user interaction required
 * 
 * ============================================
 */

// ============================================
// CONFIGURATION
// ============================================

/**
 * Single source of truth for Canvas domains.
 * Any domain listed here is treated as a Canvas instance.
 * Suffix entries (starting with '.') match any subdomain.
 */
const CANVAS_DOMAIN_SUFFIXES = ['.instructure.com'];
const KNOWN_CANVAS_DOMAINS = [
    'bcourses.berkeley.edu',
    'bruinlearn.ucla.edu',
    'canvas.ucsd.edu',
    'canvas.asu.edu',
    'canvas.mit.edu'
];

// Dynamically detected Canvas domains (stored in chrome.storage)
let customDomains = [];

// Minimum time between scans (in milliseconds) - 5 minutes
const MIN_SCAN_INTERVAL = 5 * 60 * 1000;

// Safety limit for pagination to prevent infinite loops
const MAX_PAGES = 50;

// ============================================
// STATE
// ============================================

let isScanning = false;
let lastScanTime = 0;

// Load custom domains on startup
chrome.storage.local.get(['customDomains']).then(data => {
    customDomains = data.customDomains || [];
    console.log('[Canvascope] Loaded custom domains:', customDomains);
});

// ============================================
// INSTALLATION HANDLER
// ============================================

chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Canvascope] Extension event:', details.reason);

    if (details.reason === 'install') {
        chrome.storage.local.set({
            indexedContent: [],
            settings: {
                version: chrome.runtime.getManifest().version,
                installedAt: new Date().toISOString(),
                lastScanTime: 0
            }
        });
    }

    // Set up periodic alarm for background scanning
    chrome.alarms.create('periodicScan', { periodInMinutes: 30 });
});

// ============================================
// TAB LISTENERS - Auto-scan when Canvas opens
// ============================================

/**
 * Listen for tab updates - trigger scan when Canvas is loaded
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        if (isCanvasDomain(tab.url)) {
            console.log('[Canvascope] Canvas tab detected, checking if scan needed...');
            triggerBackgroundScan(tab.url);
        }
    }
});

/**
 * Listen for tab activation - scan when switching to Canvas
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url && isCanvasDomain(tab.url)) {
            triggerBackgroundScan(tab.url);
        }
    } catch (e) {
        // Tab might not exist
    }
});

// ============================================
// PERIODIC ALARM
// ============================================

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'periodicScan') {
        console.log('[Canvascope] Periodic scan triggered');
        triggerBackgroundScan();
    }
});

// ============================================
// SCAN TRIGGER
// ============================================

/**
 * Check if it's time to scan and start if needed
 */
async function triggerBackgroundScan(tabUrl = null) {
    // Don't start if already scanning
    if (isScanning) {
        console.log('[Canvascope] Scan already in progress, skipping');
        return;
    }

    // Check if enough time has passed since last scan
    const settings = await chrome.storage.local.get(['settings']);
    const storedLastScan = settings?.settings?.lastScanTime || 0;
    const timeSinceLastScan = Date.now() - storedLastScan;

    if (timeSinceLastScan < MIN_SCAN_INTERVAL) {
        console.log(`[Canvascope] Recently scanned (${Math.round(timeSinceLastScan / 1000)}s ago), skipping`);
        return;
    }

    // Determine base URL
    let baseUrl = 'https://bcourses.berkeley.edu'; // Default fallback
    if (tabUrl) {
        try {
            const parsed = new URL(tabUrl);
            if (isCanvasDomain(tabUrl)) {
                baseUrl = `${parsed.protocol}//${parsed.hostname}`;
            }
        } catch (e) { }
    }

    // Start background scan
    performBackgroundScan(baseUrl);
}

// ============================================
// BACKGROUND SCANNING
// ============================================

/**
 * Perform the background scan
 */
async function performBackgroundScan(baseUrl) {
    console.log('[Canvascope] Starting background scan...');
    isScanning = true;

    // Notify popup that scan is starting
    broadcastMessage({ type: 'scanStarted' });

    try {
        // Fetch course list (with full pagination)
        const courses = await fetchCourseList(baseUrl);

        if (courses.length === 0) {
            console.log('[Canvascope] No courses found, user may not be logged in');
            isScanning = false;
            return;
        }

        console.log(`[Canvascope] Found ${courses.length} courses`);
        broadcastMessage({
            type: 'scanProgress',
            progress: 10,
            status: `Scanning ${courses.length} courses...`
        });

        // Fetch content from each course
        const allContent = [];
        for (let i = 0; i < courses.length; i++) {
            const course = courses[i];

            try {
                const courseContent = await fetchCourseContent(baseUrl, course);
                allContent.push(...courseContent);
            } catch (e) {
                console.warn(`[Canvascope] Error scanning ${course.name}:`, e.message);
            }

            // Update progress
            const progress = 10 + Math.round(((i + 1) / courses.length) * 80);
            broadcastMessage({
                type: 'scanProgress',
                progress,
                status: `Scanned ${i + 1}/${courses.length} courses`
            });

            // Brief pause to avoid rate limiting
            await sleep(50);
        }

        // Deduplicate scanned content before merging
        // Same item can appear from multiple API endpoints (e.g. /assignments and /modules/items)
        const dedupedContent = deduplicateContent(allContent);

        // ── Snapshot-aware merge ──────────────────────────────
        // Items from courses we just scanned are REPLACED wholesale,
        // which naturally removes stale / deleted items.
        // Items from courses we did NOT scan (e.g. another domain) are preserved.
        const existingData = await chrome.storage.local.get(['indexedContent']);
        const existingContent = existingData.indexedContent || [];

        const scannedCourseIds = new Set(
            dedupedContent.map(i => i.courseId).filter(Boolean)
        );

        // Preserve items that belong to courses we did NOT scan this run
        const preservedItems = existingContent.filter(item =>
            !item.courseId || !scannedCourseIds.has(item.courseId)
        );

        const mergedContent = [...preservedItems, ...dedupedContent];

        // Save to storage
        await chrome.storage.local.set({
            indexedContent: mergedContent,
            settings: {
                lastScanTime: Date.now(),
                version: chrome.runtime.getManifest().version
            }
        });

        const newItemsDelta = mergedContent.length - existingContent.length;
        console.log(`[Canvascope] Scan complete! Total: ${mergedContent.length}, Delta: ${newItemsDelta}`);

        broadcastMessage({
            type: 'scanComplete',
            totalItems: mergedContent.length,
            newItems: Math.max(0, newItemsDelta)
        });

    } catch (error) {
        console.error('[Canvascope] Background scan error:', error);
        broadcastMessage({ type: 'scanError', error: error.message });
    } finally {
        isScanning = false;
        lastScanTime = Date.now();
    }
}

// ============================================
// CANVAS API FUNCTIONS
// ============================================

/**
 * Parse the `Link` header to extract the `rel="next"` URL.
 * Canvas uses RFC-5988 style: <https://...?page=2&per_page=50>; rel="next"
 *
 * @param {string|null} linkHeader - The Link header value
 * @returns {string|null} The next page URL, or null
 */
function parseLinkNext(linkHeader) {
    if (!linkHeader) return null;
    const parts = linkHeader.split(',');
    for (const part of parts) {
        const match = part.match(/<([^>]+)>;\s*rel="next"/);
        if (match) return match[1];
    }
    return null;
}

/**
 * Fetch all pages from a paginated Canvas API endpoint.
 * Follows `Link: rel="next"` headers automatically.
 *
 * @param {string} url - Initial API URL (should include per_page)
 * @returns {Promise<Array>} All items across all pages
 */
async function fetchAllPages(url) {
    const allItems = [];
    let nextUrl = url;
    let page = 0;

    while (nextUrl && page < MAX_PAGES) {
        page++;
        const resp = await fetch(nextUrl, { credentials: 'include' });
        if (!resp.ok) break;

        const items = await resp.json();
        if (!Array.isArray(items) || items.length === 0) break;

        allItems.push(...items);
        nextUrl = parseLinkNext(resp.headers.get('Link'));
    }

    if (page >= MAX_PAGES) {
        console.warn(`[Canvascope] Hit pagination safety limit (${MAX_PAGES} pages) for ${url}`);
    }

    return allItems;
}

async function fetchCourseList(baseUrl) {
    const courses = [];

    try {
        const data = await fetchAllPages(
            `${baseUrl}/api/v1/courses?per_page=50&enrollment_state=active`
        );

        for (const course of data) {
            if (course.id && course.name) {
                courses.push({
                    id: course.id,
                    name: course.name,
                    code: course.course_code || ''
                });
            }
        }
    } catch (e) {
        console.warn('[Canvascope] Could not fetch courses:', e.message);
    }

    return courses;
}

async function fetchCourseContent(baseUrl, course) {
    const content = [];

    // Fetch assignments (paginated)
    try {
        const items = await fetchAllPages(
            `${baseUrl}/api/v1/courses/${course.id}/assignments?per_page=100`
        );
        for (const item of items) {
            content.push({
                title: item.name || '',
                url: item.html_url || '',
                type: 'assignment',
                moduleName: 'Assignments',
                courseName: course.name,
                courseId: course.id,
                scannedAt: new Date().toISOString(),
                dueAt: item.due_at || null,
                unlockAt: item.unlock_at || null,
                lockAt: item.lock_at || null
            });
        }
    } catch (e) { }

    // Fetch files (paginated)
    try {
        const items = await fetchAllPages(
            `${baseUrl}/api/v1/courses/${course.id}/files?per_page=100`
        );
        for (const item of items) {
            const ext = (item.display_name || '').split('.').pop()?.toLowerCase();
            let type = 'file';
            if (ext === 'pdf') type = 'pdf';
            if (['ppt', 'pptx'].includes(ext)) type = 'slides';
            if (['mp4', 'mov', 'webm'].includes(ext)) type = 'video';
            if (['doc', 'docx'].includes(ext)) type = 'document';

            content.push({
                title: item.display_name || '',
                url: item.url || `${baseUrl}/courses/${course.id}/files/${item.id}`,
                type,
                moduleName: 'Files',
                courseName: course.name,
                courseId: course.id,
                scannedAt: new Date().toISOString()
            });
        }
    } catch (e) { }

    // Fetch pages (paginated)
    try {
        const items = await fetchAllPages(
            `${baseUrl}/api/v1/courses/${course.id}/pages?per_page=100`
        );
        for (const item of items) {
            content.push({
                title: item.title || '',
                url: item.html_url || '',
                type: 'page',
                moduleName: 'Pages',
                courseName: course.name,
                courseId: course.id,
                scannedAt: new Date().toISOString()
            });
        }
    } catch (e) { }

    // Fetch modules (paginated)
    try {
        const modules = await fetchAllPages(
            `${baseUrl}/api/v1/courses/${course.id}/modules?per_page=50&include[]=items`
        );
        for (const mod of modules) {
            if (mod.items) {
                for (const item of mod.items) {
                    if (item.html_url) {
                        content.push({
                            title: item.title || '',
                            url: item.html_url,
                            type: item.type?.toLowerCase() || 'link',
                            moduleName: mod.name || '',
                            courseName: course.name,
                            courseId: course.id,
                            scannedAt: new Date().toISOString()
                        });
                    }
                }
            }
        }
    } catch (e) { }

    // Fetch quizzes (paginated)
    try {
        const items = await fetchAllPages(
            `${baseUrl}/api/v1/courses/${course.id}/quizzes?per_page=100`
        );
        for (const item of items) {
            content.push({
                title: item.title || '',
                url: item.html_url || '',
                type: 'quiz',
                moduleName: 'Quizzes',
                courseName: course.name,
                courseId: course.id,
                scannedAt: new Date().toISOString()
            });
        }
    } catch (e) { }

    // Fetch discussions (paginated)
    try {
        const items = await fetchAllPages(
            `${baseUrl}/api/v1/courses/${course.id}/discussion_topics?per_page=100`
        );
        for (const item of items) {
            content.push({
                title: item.title || '',
                url: item.html_url || '',
                type: 'discussion',
                moduleName: 'Discussions',
                courseName: course.name,
                courseId: course.id,
                scannedAt: new Date().toISOString()
            });
        }
    } catch (e) { }

    // Fetch media objects (paginated)
    try {
        const items = await fetchAllPages(
            `${baseUrl}/api/v1/courses/${course.id}/media_objects?per_page=100&sort=title&exclude[]=sources&exclude[]=tracks`
        );
        for (const item of items) {
            // Determine the best title
            const title = item.user_entered_title || item.title || 'Untitled Video';

            // Skip if title looks like a filename ID (common in automated uploads)
            if (title.match(/^[a-z0-9-]{30,}/)) continue;

            const mediaUrl = `${baseUrl}/courses/${course.id}/media_download?entryId=${item.media_id}&redirect=1`;

            content.push({
                title: title,
                url: mediaUrl,
                type: 'video',
                moduleName: 'Media Gallery',
                courseName: course.name,
                courseId: course.id,
                scannedAt: new Date().toISOString()
            });
        }
    } catch (e) {
        console.warn(`[Canvascope] Error fetching media for course ${course.id}:`, e);
    }

    return content;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Check if a URL belongs to a known Canvas instance.
 * Uses the unified KNOWN_CANVAS_DOMAINS + CANVAS_DOMAIN_SUFFIXES arrays,
 * plus any user-added customDomains.
 *
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isCanvasDomain(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();

        // Check suffix patterns (e.g. .instructure.com)
        if (CANVAS_DOMAIN_SUFFIXES.some(s => hostname.endsWith(s))) {
            return true;
        }

        // Check exact known domains
        if (KNOWN_CANVAS_DOMAINS.includes(hostname)) {
            return true;
        }

        // Check user-added custom domains
        if (customDomains.includes(hostname)) {
            return true;
        }

        return false;
    } catch {
        return false;
    }
}

/**
 * Derive a stable canonical identity for a content item.
 * Prefers URL-based identity (origin + pathname, no query params).
 * Falls back to a string hash of title|courseName|type.
 *
 * @param {Object} item - Content item
 * @returns {string} Canonical identity key
 */
function getCanonicalId(item) {
    if (!item || typeof item !== 'object') return '__invalid__';

    if (item.url && typeof item.url === 'string') {
        try {
            const u = new URL(item.url);
            return `${u.origin}${u.pathname}`;
        } catch {
            // URL is not valid, fall through to hash
        }
    }

    // Fallback: deterministic key from fields
    const raw = `${(item.title || '').trim()}|${(item.courseName || '').trim()}|${item.type || ''}`;
    return `__hash__${raw}`;
}

/**
 * Deduplicate content by canonical ID.
 * Prefers canonical URLs (e.g. /assignments/123) over module item URLs.
 *
 * @param {Array} content - Array of content items
 * @returns {Array} Deduplicated array
 */
function deduplicateContent(content) {
    const seen = new Map();

    for (const item of content) {
        // Null guard: skip malformed items
        if (!item || typeof item !== 'object') continue;

        const key = getCanonicalId(item);

        if (!seen.has(key)) {
            seen.set(key, item);
        } else {
            const existing = seen.get(key);

            const isCanonical = (url) => {
                if (!url || typeof url !== 'string') return false;
                return url.includes('/assignments/') ||
                    url.includes('/quizzes/') ||
                    url.includes('/files/') ||
                    url.includes('/discussion_topics/');
            };

            const existingIsCanonical = isCanonical(existing.url);
            const newIsCanonical = isCanonical(item.url);

            if (newIsCanonical && !existingIsCanonical) {
                seen.set(key, item);
            } else if (newIsCanonical === existingIsCanonical &&
                (item.url || '').length < (existing.url || '').length) {
                seen.set(key, item);
            }
        }
    }

    return Array.from(seen.values());
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Broadcast message to popup (if open)
 */
function broadcastMessage(message) {
    chrome.runtime.sendMessage(message).catch(() => {
        // Popup not open, ignore
    });
}

// ============================================
// MESSAGE HANDLER - for popup requests
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getStatus') {
        chrome.storage.local.get(['indexedContent', 'settings']).then(data => {
            sendResponse({
                itemCount: data.indexedContent?.length || 0,
                lastScan: data.settings?.lastScanTime || 0,
                isScanning
            });
        });
        return true;
    }

    if (message.action === 'forceScan') {
        // Reset last scan time and trigger
        chrome.storage.local.get(['settings']).then(data => {
            chrome.storage.local.set({
                settings: { ...data.settings, lastScanTime: 0 }
            }).then(() => {
                triggerBackgroundScan();
                sendResponse({ started: true });
            });
        });
        return true;
    }

    if (message.action === 'addDomain') {
        const domain = (message.domain || '').toLowerCase().trim();
        if (!domain) {
            sendResponse({ success: false, error: 'Empty domain' });
            return true;
        }
        if (!customDomains.includes(domain)) {
            customDomains.push(domain);
            chrome.storage.local.set({ customDomains }).then(() => {
                console.log('[Canvascope] Added custom domain:', domain);
                sendResponse({ success: true });
            });
        } else {
            sendResponse({ success: true, existing: true });
        }
        return true;
    }

    if (message.action === 'checkAndScan') {
        // Check if URL looks like Canvas and add domain if so
        const url = message.url;
        if (url) {
            try {
                if (!isCanvasDomain(url)) {
                    sendResponse({ isCanvas: false });
                } else {
                    triggerBackgroundScan(url);
                    sendResponse({ isCanvas: true });
                }
            } catch {
                sendResponse({ isCanvas: false });
            }
        }
        return true;
    }

    if (message.action === 'getCanvasDomains') {
        // Allow popup/content scripts to request the domain list
        sendResponse({
            suffixes: CANVAS_DOMAIN_SUFFIXES,
            domains: KNOWN_CANVAS_DOMAINS,
            custom: customDomains
        });
        return true;
    }

    if (message.action === 'scanFrames') {
        // Received request to scan all frames in the current tab (for LTI tools like Kaltura)
        const tabId = sender.tab?.id;
        if (!tabId) return true;

        console.log('[Canvascope] Scanning frames for tab', tabId);

        chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            func: scanFrameForVideos
        }).then(results => {
            // Process results from all frames
            const foundVideos = [];
            for (const result of results) {
                if (result.result && Array.isArray(result.result) && result.result.length > 0) {
                    foundVideos.push(...result.result);
                }
            }

            if (foundVideos.length > 0) {
                console.log('[Canvascope] Found videos in frames:', foundVideos.length);
                // Save these videos to storage
                saveScrapedVideos(foundVideos);
                sendResponse({ success: true, count: foundVideos.length });
            } else {
                sendResponse({ success: true, count: 0 });
            }
        }).catch(err => {
            console.error('[Canvascope] Frame scan error:', err);
            sendResponse({ error: err.message });
        });

        return true;
    }
});

/**
 * Function injected into frames to find videos
 * NOTE: This runs in the context of the page/iframe!
 */
function scanFrameForVideos() {
    const videos = [];
    try {
        // 1. Kaltura Media Gallery Selectors
        const kalturaItems = document.querySelectorAll('.photo-group, .entry-title, .cb-entry-title, li.media-item');

        kalturaItems.forEach(item => {
            const titleEl = item.querySelector('.name, h3, h2, .title, a[title]');
            const linkEl = item.querySelector('a');

            if (titleEl && linkEl) {
                let title = (titleEl.textContent || titleEl.getAttribute('title') || '').trim();
                if (title && title.length > 3) {
                    videos.push({
                        title: title,
                        url: linkEl.href || window.location.href,
                        type: 'video'
                    });
                }
            }
        });

        // 2. Generic "Video" finding in iframes
        if (videos.length === 0) {
            const potentialVideos = document.querySelectorAll('a[href*="video"], a[class*="video"]');
            potentialVideos.forEach(link => {
                const title = link.textContent.trim() || link.getAttribute('title');
                if (title && title.length > 3) {
                    videos.push({
                        title: title,
                        url: link.href,
                        type: 'video'
                    });
                }
            });
        }

    } catch (e) {
        // Ignore errors in restricted frames
    }
    return videos;
}

async function saveScrapedVideos(videos) {
    if (videos.length === 0) return;

    const data = await chrome.storage.local.get(['indexedContent']);
    let content = data.indexedContent || [];
    const seen = new Set(content.map(c => (c.url || '') + (c.title || '')));

    let addedCount = 0;
    for (const v of videos) {
        // Generate a pseudo-url if needed since LTI links are often javascript:void(0)
        let finalUrl = v.url;
        if (!finalUrl || finalUrl.startsWith('javascript') || finalUrl === 'about:blank') {
            continue;
        }

        const key = finalUrl + (v.title || '');
        if (!seen.has(key)) {
            content.push({
                title: v.title || '',
                url: finalUrl,
                type: 'video',
                moduleName: 'Media Gallery',
                courseName: 'Current Course',
                scannedAt: new Date().toISOString()
            });
            seen.add(key);
            addedCount++;
        }
    }

    if (addedCount > 0) {
        await chrome.storage.local.set({ indexedContent: content });
        // Notify popup
        chrome.runtime.sendMessage({ type: 'scanComplete', newItems: addedCount });
    }
}


// ============================================
// STARTUP
// ============================================

console.log('[Canvascope] Background service worker started');

// Check if we should scan on startup
chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
        if (tab.url && isCanvasDomain(tab.url)) {
            triggerBackgroundScan(tab.url);
            break;
        }
    }
});
