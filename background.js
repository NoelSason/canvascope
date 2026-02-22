/**
 * ============================================
 * Canvascope - Background Service Worker (background.js)
 * ============================================
 * 
 * PURPOSE:
 * - Automatically scans LMS courses in the background
 * - Triggers when supported LMS tabs are detected
 * - Runs periodic updates to keep content fresh
 * - No user interaction required
 * 
 * ============================================
 */

// ============================================

importScripts('lib/fuse.min.js');

// --- SUPABASE INITIALIZATION ---
// Create a single supabase client for the extension
const supabaseUrl = 'https://vcadcdgnwxjlgaoqktkd.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjYWRjZGdud3hqbGdhb3FrdGtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MzU4NDQsImV4cCI6MjA4NzIxMTg0NH0.71j6kwkwwSeG9Jppu4IUyHORM033NFyXKemOd5kuDWk';
const supabaseClient = typeof window !== 'undefined' && window.supabase
    ? window.supabase.createClient(supabaseUrl, supabaseKey)
    : typeof supabase !== 'undefined' ? supabase.createClient(supabaseUrl, supabaseKey) : null;

if (!supabaseClient) {
    console.error('[Canvascope] Supabase client failed to initialize (ensure lib/supabase.js is loaded)');
}

/**
 * Single source of truth for LMS domains.
 * Any domain listed here is treated as a supported LMS instance.
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
const BRIGHTSPACE_DOMAIN_SUFFIXES = ['.brightspace.com', '.d2l.com'];
const KNOWN_BRIGHTSPACE_DOMAINS = [];

const BRIGHTSPACE_DEFAULT_LP_VERSION = '1.49';
const BRIGHTSPACE_DEFAULT_LE_VERSION = '1.82';

// Dynamically detected LMS domains (stored in chrome.storage)
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

    // Set up deadline reminder alarm (every 60 min)
    chrome.alarms.create('deadlineReminder', { periodInMinutes: 60 });
});

// ============================================
// TAB LISTENERS - Auto-scan when LMS opens
// ============================================

/**
 * Listen for tab updates - trigger scan when supported LMS is loaded
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        const context = getLmsContext(tab.url);
        if (context) {
            console.log(`[Canvascope] ${context.platform} tab detected, checking if scan needed...`);
            triggerBackgroundScan(tab.url);
        }
    }
});

/**
 * Listen for tab activation - scan when switching to supported LMS
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url && getLmsContext(tab.url)) {
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
    if (alarm.name === 'deadlineReminder') {
        checkDeadlineReminders();
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

    const target = await resolveScanTarget(tabUrl);
    if (!target) {
        console.log('[Canvascope] No supported LMS tab found, skipping scan');
        return;
    }

    // Start background scan
    performBackgroundScan(target.baseUrl, target.platform);
}

/**
 * Resolve which LMS tab should be scanned.
 * Prefers the triggering tab URL; falls back to any open LMS tab.
 */
async function resolveScanTarget(tabUrl = null) {
    if (tabUrl) {
        const direct = getLmsContext(tabUrl);
        if (direct) return direct;
    }

    try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (!tab?.url) continue;
            const context = getLmsContext(tab.url);
            if (context) return context;
        }
    } catch (e) {
        console.warn('[Canvascope] Could not inspect open tabs for LMS target:', e.message);
    }

    return null;
}

// ============================================
// BACKGROUND SCANNING
// ============================================

/**
 * Perform the background scan
 */
async function performBackgroundScan(baseUrl, platform = 'canvas') {
    console.log(`[Canvascope] Starting ${platform} background scan...`);
    isScanning = true;
    const scanStartMs = performance.now();
    let fastPassDurationMs = 0;
    let fullPassDurationMs = 0;

    // Notify popup that scan is starting
    broadcastMessage({ type: 'scanStarted' });

    try {
        // Fetch course list (with full pagination)
        const courses = platform === 'brightspace'
            ? await fetchBrightspaceCourseList(baseUrl)
            : await fetchCourseList(baseUrl);

        if (courses.length === 0) {
            console.log('[Canvascope] No courses found, user may not be logged in');
            isScanning = false;
            return;
        }

        console.log(`[Canvascope] Found ${courses.length} courses`);
        broadcastMessage({
            type: 'scanProgress',
            progress: 10,
            status: `Optimizing index for ${courses.length} courses...`
        });

        const scanTimestamp = new Date().toISOString();
        const sourceMeta = buildSourceMeta(baseUrl, platform);

        const SCAN_COURSE_CONCURRENCY = 3;
        const allContent = [];

        const existingData = await chrome.storage.local.get(['indexedContent', 'starredCourseIds', 'settings']);
        const existingContent = existingData.indexedContent || [];

        // Helper for progressive yield
        const incrementalSave = async (newContent) => {
            if (!newContent || newContent.length === 0) return;
            allContent.push(...newContent);

            const scannedCourseKeys = new Set(allContent.map(getCourseKey).filter(Boolean));
            const preservedItems = existingContent.filter(item => {
                const key = getCourseKey(item);
                return !key || !scannedCourseKeys.has(key);
            });

            // Single dedup pass over the stitched array
            const mergedContent = deduplicateCrossType(deduplicateContent([...preservedItems, ...allContent]));

            await chrome.storage.local.set({ indexedContent: mergedContent });
        };

        // --- PHASE 1: Fast Pass ---
        console.log(`[Canvascope] Starting Fast Pass`);
        let fastCount = 0;
        const fastStartMs = performance.now();
        const fastTasks = courses.map(course => async () => {
            try {
                let courseContent = [];
                if (platform === 'brightspace') {
                    courseContent = await fetchBrightspaceCourseContent(baseUrl, course);
                } else {
                    courseContent = await fetchFastEndpoints(baseUrl, course, sourceMeta, scanTimestamp);
                }
                fastCount++;
                const progress = 10 + Math.round((fastCount / courses.length) * 40); // 10% to 50%
                broadcastMessage({
                    type: 'scanProgress',
                    progress,
                    status: `Fast indexing ${fastCount}/${courses.length} courses`
                });

                await incrementalSave(courseContent);
            } catch (e) {
                console.warn(`[Canvascope] Fast Phase Error on ${course.name}:`, e.message);
            }
        });

        // Execute phase 1
        await processPool(fastTasks, SCAN_COURSE_CONCURRENCY);
        fastPassDurationMs = performance.now() - fastStartMs;

        // --- PHASE 2: Deep Pass ---
        if (platform === 'canvas') {
            console.log(`[Canvascope] Starting Deep Pass`);
            let deepCount = 0;
            const deepTasks = courses.map(course => async () => {
                try {
                    const courseContent = await fetchHeavyEndpoints(baseUrl, course, sourceMeta, scanTimestamp);
                    deepCount++;
                    const progress = 50 + Math.round((deepCount / courses.length) * 40); // 50% to 90%
                    broadcastMessage({
                        type: 'scanProgress',
                        progress,
                        status: `Deep indexing ${deepCount}/${courses.length} courses`
                    });

                    await incrementalSave(courseContent);
                } catch (e) {
                    console.warn(`[Canvascope] Deep Phase Error on ${course.name}:`, e.message);
                }
            });
            await processPool(deepTasks, SCAN_COURSE_CONCURRENCY);
        }

        fullPassDurationMs = performance.now() - scanStartMs;

        // --- FINAL MERGE & SAVE ---
        broadcastMessage({ type: 'scanProgress', progress: 95, status: `Finalizing index...` });

        const scannedCourseKeys = new Set(allContent.map(getCourseKey).filter(Boolean));
        const preservedItems = existingContent.filter(item => {
            const key = getCourseKey(item);
            return !key || !scannedCourseKeys.has(key);
        });

        // Strict final deduplication match
        const finalDeduped = deduplicateCrossType(deduplicateContent([...preservedItems, ...allContent]));

        const starredCourseIds = [...new Set(
            finalDeduped
                .filter(item => item.type === 'course' && item.courseId)
                .map(item => item.courseId)
        )];

        await chrome.storage.local.set({
            indexedContent: finalDeduped,
            starredCourseIds: starredCourseIds.length > 0 ? starredCourseIds : (existingData.starredCourseIds || []),
            settings: {
                ...(existingData.settings || {}),
                lastScanTime: Date.now(),
                version: chrome.runtime.getManifest().version,
                scanMetrics: {
                    lastScanDurationMs: Math.round(fullPassDurationMs),
                    fastPassDurationMs: Math.round(fastPassDurationMs),
                    courseCount: courses.length
                }
            }
        });

        const newItemsDelta = finalDeduped.length - deduplicateCrossType(existingContent).length;
        console.log(`[Canvascope] Scan complete! Total: ${finalDeduped.length}, Delta: ${newItemsDelta}`);

        broadcastMessage({
            type: 'scanComplete',
            totalItems: finalDeduped.length,
            newItems: Math.max(0, newItemsDelta)
        });

        // Auto-sync to Supabase if user is signed in
        syncIndexedContentToSupabase().then(result => {
            if (result.success && result.synced > 0) {
                console.log(`[Canvascope Sync] Auto-synced ${result.synced} items after scan.`);
            }
        }).catch(() => { /* Not signed in or sync failed silently */ });

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
 * Resilient fetch wrapper with exponential backoff for 429/5xx and network errors.
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            const resp = await fetch(url, options);
            if (resp.ok) return resp;

            // Handle rate limiting and server errors
            if (resp.status === 429 || resp.status >= 500) {
                attempt++;
                if (attempt >= maxRetries) return resp; // Return the failed resp to let caller handle it

                let delayMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;

                // Respect Retry-After if present
                const retryAfter = resp.headers.get('Retry-After');
                if (retryAfter) {
                    const parsed = parseInt(retryAfter, 10);
                    if (!isNaN(parsed)) delayMs = parsed * 1000;
                }

                console.warn(`[Canvascope] HTTP ${resp.status} on ${url}. Retrying in ${Math.round(delayMs)}ms...`);
                await sleep(delayMs);
                continue;
            }
            // For 401/403/404, fail immediately without retry
            return resp;
        } catch (e) {
            // Network failures (e.g. failed to fetch)
            attempt++;
            if (attempt >= maxRetries) throw e;
            const delayMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;
            console.warn(`[Canvascope] Network error on ${url}: ${e.message}. Retrying in ${Math.round(delayMs)}ms...`);
            await sleep(delayMs);
        }
    }
    throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts`);
}

/**
 * Helper to process promises with a concurrency limit.
 */
async function processPool(tasks, concurrency) {
    const results = [];
    const pool = new Set();
    for (const task of tasks) {
        const p = task().then(res => {
            pool.delete(p);
            return res;
        });
        pool.add(p);
        results.push(p);
        if (pool.size >= concurrency) {
            await Promise.race(pool);
        }
    }
    return Promise.allSettled(results);
}

/**
 * Fetch all pages from a paginated Canvas API endpoint.
 * Follows `Link: rel="next"` headers automatically.
 * Uses `fetchWithRetry` for resilience.
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
        const resp = await fetchWithRetry(nextUrl, { credentials: 'include' });
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
            `${baseUrl}/api/v1/courses?per_page=100&enrollment_state=active`
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

async function fetchFastEndpoints(baseUrl, course, sourceMeta, scanTimestamp) {
    const content = [];
    const promises = [
        // Fetch assignments
        fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/assignments?per_page=100`).then(items => {
            for (const item of items) {
                content.push({
                    title: item.name || '',
                    url: item.html_url || '',
                    type: 'assignment',
                    moduleName: 'Assignments',
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: scanTimestamp,
                    dueAt: item.due_at || null,
                    unlockAt: item.unlock_at || null,
                    lockAt: item.lock_at || null
                });
            }
        }),
        // Fetch pages
        fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/pages?per_page=100`).then(items => {
            for (const item of items) {
                content.push({
                    title: item.title || '',
                    url: item.html_url || '',
                    type: 'page',
                    moduleName: 'Pages',
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: scanTimestamp
                });
            }
        }),
        // Fetch quizzes
        fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/quizzes?per_page=100`).then(items => {
            for (const item of items) {
                content.push({
                    title: item.title || '',
                    url: item.html_url || '',
                    type: 'quiz',
                    moduleName: 'Quizzes',
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: scanTimestamp,
                    dueAt: item.due_at || null,
                    unlockAt: item.unlock_at || null,
                    lockAt: item.lock_at || null
                });
            }
        }),
        // Fetch discussions
        fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/discussion_topics?per_page=100`).then(items => {
            for (const item of items) {
                const asgn = item.assignment || null;
                content.push({
                    title: item.title || '',
                    url: item.html_url || '',
                    type: 'discussion',
                    moduleName: 'Discussions',
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: scanTimestamp,
                    dueAt: asgn?.due_at || null,
                    unlockAt: asgn?.unlock_at || null,
                    lockAt: asgn?.lock_at || null
                });
            }
        })
    ];

    await Promise.allSettled(promises);
    return content;
}

async function fetchHeavyEndpoints(baseUrl, course, sourceMeta, scanTimestamp) {
    const content = [];

    // Modules
    const fetchModules = fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/modules?per_page=50&include[]=items`).then(modules => {
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
                            ...sourceMeta,
                            scannedAt: scanTimestamp
                        });
                    }
                }
            }
        }
    });

    // Media Gallery
    const fetchMedia = fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/media_objects?per_page=100&sort=title&exclude[]=sources&exclude[]=tracks`).then(items => {
        for (const item of items) {
            const title = item.user_entered_title || item.title || 'Untitled Video';
            if (title.match(/^[a-z0-9-]{30,}/)) continue;
            const mediaUrl = `${baseUrl}/courses/${course.id}/media_download?entryId=${item.media_id}&redirect=1`;
            content.push({
                title: title,
                url: mediaUrl,
                type: 'video',
                moduleName: 'Media Gallery',
                courseName: course.name,
                courseId: course.id,
                ...sourceMeta,
                scannedAt: scanTimestamp
            });
        }
    });

    // Folders -> Files (Sequential dependency)
    const fetchFiles = (async () => {
        const folderMap = new Map();
        try {
            const folders = await fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/folders?per_page=100`);
            for (const f of folders) {
                const fullName = (f.full_name || '')
                    .replace(/^course files\/?/i, '')
                    .replace(/\//g, ' > ');
                folderMap.set(f.id, { name: f.name || '', fullName });
            }
        } catch (e) { }

        try {
            const items = await fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/files?per_page=100`);
            for (const item of items) {
                const ext = (item.display_name || '').split('.').pop()?.toLowerCase();
                let type = 'file';
                if (ext === 'pdf') type = 'pdf';
                if (['ppt', 'pptx'].includes(ext)) type = 'slides';
                if (['mp4', 'mov', 'webm'].includes(ext)) type = 'video';
                if (['doc', 'docx'].includes(ext)) type = 'document';

                const folder = folderMap.get(item.folder_id);
                const folderName = folder?.name || 'Files';
                const folderPath = folder?.fullName || '';

                content.push({
                    title: item.display_name || '',
                    url: item.url || `${baseUrl}/courses/${course.id}/files/${item.id}`,
                    type,
                    moduleName: folderName,
                    folderPath,
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: scanTimestamp
                });
            }
        } catch (e) { }
    })();

    await Promise.allSettled([fetchModules, fetchMedia, fetchFiles]);
    return content;
}
// BRIGHTSPACE API FUNCTIONS
// ============================================

const brightspaceVersionCache = new Map();

async function fetchBrightspaceApiVersions(baseUrl) {
    const cacheKey = normalizeBaseUrl(baseUrl);
    if (cacheKey && brightspaceVersionCache.has(cacheKey)) {
        return brightspaceVersionCache.get(cacheKey);
    }

    const fallback = {
        lpVersion: BRIGHTSPACE_DEFAULT_LP_VERSION,
        leVersion: BRIGHTSPACE_DEFAULT_LE_VERSION
    };

    try {
        const resp = await fetch(`${baseUrl}/d2l/api/versions/`, { credentials: 'include' });
        if (!resp.ok) {
            if (cacheKey) brightspaceVersionCache.set(cacheKey, fallback);
            return fallback;
        }

        const products = await resp.json();
        const lpVersion = findLatestBrightspaceVersion(products, 'lp') || BRIGHTSPACE_DEFAULT_LP_VERSION;
        const leVersion = findLatestBrightspaceVersion(products, 'le') || BRIGHTSPACE_DEFAULT_LE_VERSION;
        const resolved = { lpVersion, leVersion };

        if (cacheKey) brightspaceVersionCache.set(cacheKey, resolved);
        return resolved;
    } catch (e) {
        console.warn('[Canvascope] Could not resolve Brightspace API versions, using defaults:', e.message);
        if (cacheKey) brightspaceVersionCache.set(cacheKey, fallback);
        return fallback;
    }
}

function findLatestBrightspaceVersion(products, productCode) {
    if (!Array.isArray(products)) return null;
    const code = (productCode || '').toLowerCase();
    const product = products.find(p => String(p?.ProductCode || '').toLowerCase() === code);
    if (!product) return null;

    const explicitLatest = product.LatestVersion;
    if (typeof explicitLatest === 'string' && explicitLatest.trim()) {
        return explicitLatest.trim();
    }

    const supported = Array.isArray(product.SupportedVersions)
        ? product.SupportedVersions
            .map(v => String(v || '').trim())
            .filter(Boolean)
        : [];
    if (supported.length === 0) return null;
    supported.sort(compareApiVersionsDesc);
    return supported[0];
}

function compareApiVersionsDesc(a, b) {
    const aParts = String(a || '').split('.').map(n => Number.parseInt(n, 10) || 0);
    const bParts = String(b || '').split('.').map(n => Number.parseInt(n, 10) || 0);
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
        const diff = (bParts[i] || 0) - (aParts[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function extractBrightspaceItems(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.Items)) return payload.Items;
    if (Array.isArray(payload.Objects)) return payload.Objects;
    if (Array.isArray(payload.Results)) return payload.Results;
    if (Array.isArray(payload.items)) return payload.items;
    return [];
}

function extractBrightspaceBookmark(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const pagingInfo = payload.PagingInfo || payload.pagingInfo || payload.Paging || payload.paging;
    const bookmark = pagingInfo?.Bookmark ?? pagingInfo?.bookmark ?? payload.Bookmark ?? payload.bookmark ?? null;
    if (!bookmark) return null;
    return String(bookmark);
}

async function fetchBrightspacePagedResult(urlBuilder) {
    const allItems = [];
    let bookmark = null;
    let page = 0;

    while (page < MAX_PAGES) {
        page++;
        const url = urlBuilder(bookmark);
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) break;

        const payload = await resp.json();
        const items = extractBrightspaceItems(payload);
        if (!items.length) break;

        allItems.push(...items);

        const nextBookmark = extractBrightspaceBookmark(payload);
        if (!nextBookmark || nextBookmark === bookmark) break;
        bookmark = nextBookmark;
    }

    if (page >= MAX_PAGES) {
        console.warn('[Canvascope] Hit Brightspace pagination safety limit');
    }

    return allItems;
}

function isLikelyBrightspaceCourse(orgUnit) {
    if (!orgUnit || typeof orgUnit !== 'object') return false;
    const typeCode = String(orgUnit?.Type?.Code || '').toLowerCase();
    const typeName = String(orgUnit?.Type?.Name || '').toLowerCase();
    const homeUrl = String(orgUnit?.HomeUrl || '');

    if (typeCode.includes('course') || typeName.includes('course')) return true;
    if (/\/d2l\/home\/\d+/.test(homeUrl)) return true;
    return false;
}

async function fetchBrightspaceCourseList(baseUrl) {
    const { lpVersion } = await fetchBrightspaceApiVersions(baseUrl);
    const seenCourseIds = new Set();

    const enrollments = await fetchBrightspacePagedResult((bookmark) => {
        const url = new URL(`${baseUrl}/d2l/api/lp/${lpVersion}/enrollments/myenrollments/`);
        url.searchParams.set('canAccess', 'true');
        url.searchParams.set('isActive', 'true');
        if (bookmark) url.searchParams.set('bookmark', bookmark);
        return url.toString();
    });

    const courses = [];
    for (const enrollment of enrollments) {
        const org = enrollment?.OrgUnit;
        const access = enrollment?.Access || {};
        if (!org?.Id || !org?.Name) continue;
        if (access.CanAccess === false || access.IsActive === false) continue;
        if (!isLikelyBrightspaceCourse(org)) continue;

        const courseId = String(org.Id);
        if (seenCourseIds.has(courseId)) continue;
        seenCourseIds.add(courseId);

        courses.push({
            id: courseId,
            name: org.Name,
            code: org.Code || '',
            homeUrl: normalizeBrightspaceUrl(baseUrl, org.HomeUrl || `/d2l/home/${courseId}`)
        });
    }

    return courses;
}

function normalizeBrightspaceUrl(baseUrl, maybeRelativeUrl) {
    const value = String(maybeRelativeUrl || '').trim();
    if (!value) return '';
    if (value.startsWith('javascript:') || value.startsWith('data:')) return '';
    try {
        return new URL(value, baseUrl).toString();
    } catch {
        return '';
    }
}

function inferBrightspaceTopicType(topic, resolvedUrl) {
    const activity = String(topic?.ActivityType || '').toLowerCase();
    const typeIdentifier = String(topic?.TypeIdentifier || '').toLowerCase();
    const url = String(resolvedUrl || '').toLowerCase();

    if (activity.includes('dropbox') || activity.includes('assignment') || url.includes('/dropbox/')) return 'assignment';
    if (activity.includes('quiz') || url.includes('/quizzing/')) return 'quiz';
    if (activity.includes('discussion') || url.includes('/discussions/')) return 'discussion';
    if (activity.includes('link') || activity.includes('external') || url.includes('/external/')) return 'external';
    if (activity.includes('video')) return 'video';
    if (typeIdentifier.includes('file') || url.includes('/managefiles/')) return 'file';

    const extMatch = url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
    if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        if (ext === 'pdf') return 'pdf';
        if (['ppt', 'pptx'].includes(ext)) return 'slides';
        if (['doc', 'docx'].includes(ext)) return 'document';
        if (['mp4', 'mov', 'webm'].includes(ext)) return 'video';
    }

    return 'page';
}

function flattenBrightspaceModules(modules, trail = []) {
    const topics = [];
    if (!Array.isArray(modules)) return topics;

    for (const module of modules) {
        const moduleTitle = (module?.Title || module?.ShortTitle || '').trim();
        const nextTrail = moduleTitle ? [...trail, moduleTitle] : trail;

        if (Array.isArray(module?.Topics)) {
            for (const topic of module.Topics) {
                topics.push({ topic, moduleTrail: nextTrail });
            }
        }
        if (Array.isArray(module?.Modules) && module.Modules.length > 0) {
            topics.push(...flattenBrightspaceModules(module.Modules, nextTrail));
        }
    }

    return topics;
}

function toIsoOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

async function fetchBrightspaceCourseContent(baseUrl, course) {
    const content = [];
    const sourceMeta = buildSourceMeta(baseUrl, 'brightspace');
    const { leVersion } = await fetchBrightspaceApiVersions(baseUrl);
    const fallbackCourseUrl = normalizeBrightspaceUrl(baseUrl, course.homeUrl || `/d2l/home/${course.id}`);

    // Content topics
    try {
        const resp = await fetch(
            `${baseUrl}/d2l/api/le/${leVersion}/${course.id}/content/toc?ignoreDateRestrictions=false`,
            { credentials: 'include' }
        );
        if (resp.ok) {
            const toc = await resp.json();
            const flattened = flattenBrightspaceModules(toc?.Modules || []);

            for (const entry of flattened) {
                const topic = entry.topic;
                if (!topic || topic.IsHidden === true) continue;

                const title = (topic.Title || topic.ShortTitle || '').trim();
                const topicUrl = normalizeBrightspaceUrl(baseUrl, topic.Url);
                if (!title || !topicUrl) continue;

                content.push({
                    title,
                    url: topicUrl,
                    type: inferBrightspaceTopicType(topic, topicUrl),
                    moduleName: entry.moduleTrail.join(' > ') || 'Content',
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: new Date().toISOString(),
                    dueAt: toIsoOrNull(topic.DueDate),
                    unlockAt: toIsoOrNull(topic.StartDate),
                    lockAt: toIsoOrNull(topic.EndDate)
                });
            }
        }
    } catch (e) {
        console.warn(`[Canvascope] Brightspace TOC scan failed for course ${course.id}:`, e.message);
    }

    // Assignments (Dropbox folders)
    try {
        const resp = await fetch(
            `${baseUrl}/d2l/api/le/${leVersion}/${course.id}/dropbox/folders/`,
            { credentials: 'include' }
        );
        if (resp.ok) {
            const folders = extractBrightspaceItems(await resp.json());
            for (const folder of folders) {
                if (!folder?.Id || !folder?.Name) continue;
                const folderUrl = normalizeBrightspaceUrl(
                    baseUrl,
                    `/d2l/lms/dropbox/user/folder_submit.d2l?ou=${course.id}&db=${folder.Id}`
                ) || fallbackCourseUrl;

                content.push({
                    title: folder.Name,
                    url: folderUrl,
                    type: 'assignment',
                    moduleName: 'Assignments',
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: new Date().toISOString(),
                    dueAt: toIsoOrNull(folder.DueDate),
                    unlockAt: toIsoOrNull(folder?.Availability?.StartDate),
                    lockAt: toIsoOrNull(folder?.Availability?.EndDate)
                });
            }
        }
    } catch (e) {
        console.warn(`[Canvascope] Brightspace assignment scan failed for course ${course.id}:`, e.message);
    }

    // Quizzes
    try {
        const resp = await fetch(
            `${baseUrl}/d2l/api/le/${leVersion}/${course.id}/quizzes/`,
            { credentials: 'include' }
        );
        if (resp.ok) {
            const quizzes = extractBrightspaceItems(await resp.json());
            for (const quiz of quizzes) {
                if (!quiz?.QuizId || !quiz?.Name) continue;
                const quizUrl = normalizeBrightspaceUrl(
                    baseUrl,
                    `/d2l/lms/quizzing/user/quiz_summary.d2l?ou=${course.id}&qi=${quiz.QuizId}`
                ) || fallbackCourseUrl;

                content.push({
                    title: quiz.Name,
                    url: quizUrl,
                    type: 'quiz',
                    moduleName: 'Quizzes',
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: new Date().toISOString(),
                    dueAt: toIsoOrNull(quiz.DueDate),
                    unlockAt: toIsoOrNull(quiz.StartDate),
                    lockAt: toIsoOrNull(quiz.EndDate)
                });
            }
        }
    } catch (e) {
        console.warn(`[Canvascope] Brightspace quiz scan failed for course ${course.id}:`, e.message);
    }

    // Discussion topics
    try {
        const forumsResp = await fetch(
            `${baseUrl}/d2l/api/le/${leVersion}/${course.id}/discussions/forums/`,
            { credentials: 'include' }
        );
        if (forumsResp.ok) {
            const forums = extractBrightspaceItems(await forumsResp.json());
            for (const forum of forums) {
                if (!forum?.ForumId) continue;

                const topicsResp = await fetch(
                    `${baseUrl}/d2l/api/le/${leVersion}/${course.id}/discussions/forums/${forum.ForumId}/topics/`,
                    { credentials: 'include' }
                );
                if (!topicsResp.ok) continue;

                const topics = extractBrightspaceItems(await topicsResp.json());
                for (const topic of topics) {
                    if (!topic?.TopicId || !topic?.Name) continue;
                    const topicUrl = normalizeBrightspaceUrl(
                        baseUrl,
                        `/d2l/lms/discussions/list.d2l?ou=${course.id}&forumId=${forum.ForumId}&topicId=${topic.TopicId}`
                    ) || fallbackCourseUrl;

                    content.push({
                        title: topic.Name,
                        url: topicUrl,
                        type: 'discussion',
                        moduleName: forum?.Name || 'Discussions',
                        courseName: course.name,
                        courseId: course.id,
                        ...sourceMeta,
                        scannedAt: new Date().toISOString(),
                        dueAt: toIsoOrNull(topic.DueDate),
                        unlockAt: toIsoOrNull(topic.StartDate),
                        lockAt: toIsoOrNull(topic.EndDate)
                    });
                }
            }
        }
    } catch (e) {
        console.warn(`[Canvascope] Brightspace discussion scan failed for course ${course.id}:`, e.message);
    }

    // Announcements (News)
    try {
        const newsResp = await fetch(
            `${baseUrl}/d2l/api/le/${leVersion}/${course.id}/news/`,
            { credentials: 'include' }
        );
        if (newsResp.ok) {
            const newsItems = extractBrightspaceItems(await newsResp.json());
            for (const item of newsItems) {
                if (!item?.Id || !item?.Title) continue;
                const newsUrl = normalizeBrightspaceUrl(
                    baseUrl,
                    `/d2l/lms/news/main.d2l?ou=${course.id}&newsItemId=${item.Id}`
                ) || fallbackCourseUrl;

                content.push({
                    title: item.Title,
                    url: newsUrl,
                    type: 'announcement',
                    moduleName: 'Announcements',
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: new Date().toISOString()
                });
            }
        }
    } catch (e) {
        console.warn(`[Canvascope] Brightspace news scan failed for course ${course.id}:`, e.message);
    }

    return content;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function normalizeBaseUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.hostname}`.toLowerCase();
    } catch {
        return '';
    }
}

function getHostnameFromUrl(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function isCanvasHost(hostname) {
    if (!hostname) return false;
    if (CANVAS_DOMAIN_SUFFIXES.some(s => hostname.endsWith(s))) return true;
    if (KNOWN_CANVAS_DOMAINS.includes(hostname)) return true;
    return false;
}

function isBrightspaceHost(hostname) {
    if (!hostname) return false;
    if (BRIGHTSPACE_DOMAIN_SUFFIXES.some(s => hostname.endsWith(s))) return true;
    if (KNOWN_BRIGHTSPACE_DOMAINS.includes(hostname)) return true;
    return false;
}

function looksLikeCanvasPath(pathname) {
    const path = String(pathname || '').toLowerCase();
    return path.includes('/courses/') ||
        path.includes('/modules') ||
        path.includes('/assignments/') ||
        path.includes('/quizzes');
}

function looksLikeBrightspacePath(pathname) {
    const path = String(pathname || '').toLowerCase();
    return path.startsWith('/d2l/') || path.includes('/d2l/');
}

function getLmsContext(url) {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();

        let platform = null;
        if (isCanvasHost(hostname)) {
            platform = 'canvas';
        } else if (isBrightspaceHost(hostname)) {
            platform = 'brightspace';
        } else if (customDomains.includes(hostname)) {
            if (looksLikeBrightspacePath(pathname) || hostname.includes('brightspace') || hostname.includes('d2l')) {
                platform = 'brightspace';
            } else {
                platform = 'canvas';
            }
        }

        if (!platform) return null;
        return {
            platform,
            hostname,
            baseUrl: `${parsed.protocol}//${parsed.hostname}`
        };
    } catch {
        return null;
    }
}

function isCanvasDomain(url) {
    return getLmsContext(url)?.platform === 'canvas';
}

function buildSourceMeta(baseUrl, platform) {
    return {
        platform: platform || 'canvas',
        platformDomain: getHostnameFromUrl(baseUrl)
    };
}

function getCourseKey(item) {
    if (!item || typeof item !== 'object') return null;
    const courseId = item.courseId !== undefined && item.courseId !== null
        ? String(item.courseId).trim()
        : '';
    if (!courseId) return null;

    const platform = String(item.platform || '').toLowerCase() ||
        (getLmsContext(item.url || '')?.platform || 'canvas');
    const platformDomain = String(item.platformDomain || '').toLowerCase() ||
        getHostnameFromUrl(item.url || '');

    return `${platform}:${platformDomain}:${courseId}`;
}

/**
 * Derive a stable canonical identity for a content item.
 * Prefers URL-based identity (origin + pathname).
 * For Brightspace item URLs that encode identity in query params,
 * keeps a small set of stable query keys.
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
            if (isBrightspaceHost(u.hostname.toLowerCase()) || looksLikeBrightspacePath(u.pathname)) {
                const keepKeys = ['ou', 'db', 'qi', 'forumid', 'topicid', 'newsitemid', 'id', 'itemid'];
                const kept = [];
                for (const key of keepKeys) {
                    const value = u.searchParams.get(key);
                    if (value) kept.push(`${key}=${value}`);
                }
                if (kept.length) {
                    return `${u.origin}${u.pathname}?${kept.join('&')}`;
                }
            }
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

            let winner = existing;
            if (newIsCanonical && !existingIsCanonical) {
                winner = item;
                seen.set(key, item);
            } else if (newIsCanonical === existingIsCanonical &&
                (item.url || '').length < (existing.url || '').length) {
                winner = item;
                seen.set(key, item);
            }

            // Merge due-date fields from either copy (prefer non-null)
            const loser = winner === item ? existing : item;
            if (!winner.dueAt && loser.dueAt) winner.dueAt = loser.dueAt;
            if (!winner.unlockAt && loser.unlockAt) winner.unlockAt = loser.unlockAt;
            if (!winner.lockAt && loser.lockAt) winner.lockAt = loser.lockAt;
        }
    }

    return Array.from(seen.values());
}

/**
 * Second-pass dedup: merge items with identical core properties but different types
 * (e.g. Canvas creates both /assignments/X and /quizzes/Y for the same quiz).
 * Uses canonical identity.
 */
function deduplicateCrossType(content) {
    const TYPE_PRIORITY = { assignment: 0, quiz: 1, discussion: 2 };
    const groups = new Map();

    for (const item of content) {
        if (!item || !item.title) continue;

        // Exact mapping to match popup.js logic
        const key = `${(item.title || '').trim().toLowerCase()}|${(item.courseName || '').trim().toLowerCase()}`;

        if (!groups.has(key)) {
            groups.set(key, item);
        } else {
            const existing = groups.get(key);
            const existingPri = TYPE_PRIORITY[(existing.type || '').toLowerCase()] ?? 99;
            const newPri = TYPE_PRIORITY[(item.type || '').toLowerCase()] ?? 99;

            let winner = existing;
            if (newPri < existingPri) {
                winner = item;
                groups.set(key, item);
            }

            const loser = winner === item ? existing : item;
            if (!winner.dueAt && loser.dueAt) winner.dueAt = loser.dueAt;
            if (!winner.unlockAt && loser.unlockAt) winner.unlockAt = loser.unlockAt;
            if (!winner.lockAt && loser.lockAt) winner.lockAt = loser.lockAt;
        }
    }

    return Array.from(groups.values());
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
// AUTHENTICATION FLOW
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'signInWithGoogle') {
        (async () => {
            try {
                const redirectUrl = chrome.identity.getRedirectURL();
                console.log('[Canvascope Auth] Starting Google OAuth flow. Redirect URL:', redirectUrl);

                // Get the OAuth URL from Supabase
                const { data, error } = await supabaseClient.auth.signInWithOAuth({
                    provider: 'google',
                    options: {
                        redirectTo: redirectUrl,
                        queryParams: {
                            access_type: 'offline',
                            prompt: 'consent',
                        },
                        skipBrowserRedirect: true
                    }
                });

                if (error) {
                    console.error('[Canvascope Auth] Supabase OAuth error:', error);
                    sendResponse({ success: false, error: error.message });
                    return;
                }

                if (!data || !data.url) {
                    throw new Error('No OAuth URL returned from Supabase');
                }

                console.log('[Canvascope Auth] OAuth URL generated:', data.url);

                // Use chrome.identity for proper HTTPS OAuth flow
                chrome.identity.launchWebAuthFlow(
                    { url: data.url, interactive: true },
                    (callbackUrl) => {
                        if (chrome.runtime.lastError) {
                            console.error('[Canvascope Auth] launchWebAuthFlow error:', chrome.runtime.lastError);
                            sendResponse({ success: false, error: chrome.runtime.lastError.message });
                            return;
                        }

                        if (!callbackUrl) {
                            sendResponse({ success: false, error: 'No callback URL received' });
                            return;
                        }

                        // Parse tokens from the callback URL hash
                        try {
                            const url = new URL(callbackUrl);
                            const hashFragment = url.hash.substring(1);
                            const hashParams = new URLSearchParams(hashFragment);

                            if (hashParams.has('error_description')) {
                                console.error('[Canvascope Auth] OAuth error:', hashParams.get('error_description'));
                                sendResponse({ success: false, error: hashParams.get('error_description') });
                                return;
                            }

                            const accessToken = hashParams.get('access_token');
                            const refreshToken = hashParams.get('refresh_token');

                            if (accessToken && refreshToken) {
                                supabaseClient.auth.setSession({
                                    access_token: accessToken,
                                    refresh_token: refreshToken
                                }).then(({ error: sessionError }) => {
                                    if (sessionError) {
                                        console.error('[Canvascope Auth] Error setting session:', sessionError);
                                        sendResponse({ success: false, error: sessionError.message });
                                    } else {
                                        console.log('[Canvascope Auth] Successfully authenticated!');
                                        // Auto-sync indexed content to Supabase after login
                                        syncIndexedContentToSupabase().then(result => {
                                            console.log('[Canvascope Sync] Auto-sync after login:', result);
                                        }).catch(err => {
                                            console.error('[Canvascope Sync] Auto-sync failed:', err);
                                        });
                                        sendResponse({ success: true });
                                    }
                                });
                            } else {
                                sendResponse({ success: false, error: 'Tokens missing from callback' });
                            }
                        } catch (parseErr) {
                            console.error('[Canvascope Auth] Error parsing callback URL:', parseErr);
                            sendResponse({ success: false, error: parseErr.message });
                        }
                    }
                );
            } catch (err) {
                console.error('[Canvascope Auth] Unhandled error during sign in:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();

    }

    return true; // Keep message channel open for async response
});

// Add message handler to check auth status on popup load
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'checkAuthStatus') {
        (async () => {
            try {
                const { data: { session }, error } = await supabaseClient.auth.getSession();
                if (error) throw error;

                if (session && session.user) {
                    sendResponse({
                        signedIn: true,
                        user: {
                            email: session.user.email,
                            name: session.user.user_metadata?.full_name || session.user.user_metadata?.name || 'User',
                            avatar_url: session.user.user_metadata?.avatar_url
                        }
                    });
                } else {
                    sendResponse({ signedIn: false });
                }
            } catch (err) {
                console.error('[Canvascope Auth] Error checking session:', err);
                sendResponse({ signedIn: false });
            }
        })();
        return true;
    } else if (message.type === 'fetchUserData') {
        (async () => {
            try {
                const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
                if (sessionError) throw sessionError;
                if (!session) { sendResponse({ success: false, error: 'Not signed in' }); return; }

                // Fetch from all 3 tables in parallel
                const [usersRes, prefsRes, syncedRes] = await Promise.all([
                    supabaseClient.from('users').select('*').eq('id', session.user.id),
                    supabaseClient.from('preferences').select('*').eq('user_id', session.user.id),
                    supabaseClient.from('synced_items').select('*').eq('user_id', session.user.id)
                ]);

                sendResponse({
                    success: true,
                    tables: {
                        users: { data: usersRes.data || [], error: usersRes.error?.message || null },
                        preferences: { data: prefsRes.data || [], error: prefsRes.error?.message || null },
                        synced_items: { data: syncedRes.data || [], error: syncedRes.error?.message || null }
                    }
                });
            } catch (err) {
                console.error('[Canvascope Auth] Error fetching user data:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    } else if (message.type === 'signOut') {
        (async () => {
            try {
                const { error } = await supabaseClient.auth.signOut();
                if (error) throw error;
                sendResponse({ success: true });
            } catch (err) {
                console.error('[Canvascope Auth] Error signing out:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    } else if (message.type === 'syncIndexedContent') {
        (async () => {
            try {
                const result = await syncIndexedContentToSupabase();
                sendResponse(result);
            } catch (err) {
                console.error('[Canvascope Sync] Error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }
});

/**
 * Sync all locally indexed content to Supabase synced_items table.
 * Each item is stored as a row with item_type from the content type
 * and item_data containing the full item object.
 */
async function syncIndexedContentToSupabase() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return { success: false, error: 'Not signed in' };

    const userId = session.user.id;

    // Read local indexed content
    const storageData = await chrome.storage.local.get(['indexedContent']);
    const items = storageData.indexedContent || [];

    if (items.length === 0) {
        return { success: true, synced: 0, message: 'No items to sync' };
    }

    console.log(`[Canvascope Sync] Syncing ${items.length} indexed items to Supabase...`);

    // First, delete existing synced_items for this user to do a full refresh
    const { error: deleteError } = await supabaseClient
        .from('synced_items')
        .delete()
        .eq('user_id', userId);

    if (deleteError) {
        console.error('[Canvascope Sync] Error clearing old items:', deleteError);
    }

    // Batch insert in chunks of 50
    const BATCH_SIZE = 50;
    let totalSynced = 0;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const rows = batch.map(item => ({
            user_id: userId,
            item_type: item.type || 'unknown',
            item_data: item,
            sync_status: 'synced'
        }));

        const { error: insertError } = await supabaseClient
            .from('synced_items')
            .insert(rows);

        if (insertError) {
            console.error(`[Canvascope Sync] Batch insert error at offset ${i}:`, insertError);
        } else {
            totalSynced += batch.length;
        }
    }

    console.log(`[Canvascope Sync] Done! Synced ${totalSynced}/${items.length} items.`);
    return { success: true, synced: totalSynced, total: items.length };
}

/**
 * Wipe all synced_items for the authenticated user in Supabase.
 * Triggered when the user clears their local data.
 */
async function clearIndexedContentFromSupabase() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return { success: false, error: 'Not signed in' };

    const userId = session.user.id;
    console.log(`[Canvascope Sync] Clearing synced_items for user ${userId}...`);

    const { error: deleteError } = await supabaseClient
        .from('synced_items')
        .delete()
        .eq('user_id', userId);

    if (deleteError) {
        console.error('[Canvascope Sync] Error clearing items from Supabase:', deleteError);
        return { success: false, error: deleteError.message };
    }

    return { success: true };
}

// ============================================
// MESSAGE PASSING (Popup/Content Script to Background)
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

    if (message.action === 'clearSupabaseData') {
        clearIndexedContentFromSupabase().then(res => {
            sendResponse(res);
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
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
        // Check if URL looks like a supported LMS and scan if so
        const url = message.url;
        if (url) {
            try {
                const context = getLmsContext(url);
                if (!context) {
                    sendResponse({ isCanvas: false, isSupported: false });
                } else {
                    triggerBackgroundScan(url);
                    sendResponse({
                        isCanvas: context.platform === 'canvas',
                        isSupported: true,
                        platform: context.platform
                    });
                }
            } catch {
                sendResponse({ isCanvas: false, isSupported: false });
            }
        }
        return true;
    }

    if (message.action === 'getCanvasDomains') {
        // Allow popup/content scripts to request the domain list
        sendResponse({
            suffixes: CANVAS_DOMAIN_SUFFIXES,
            domains: KNOWN_CANVAS_DOMAINS,
            custom: customDomains,
            brightspaceSuffixes: BRIGHTSPACE_DOMAIN_SUFFIXES,
            brightspaceDomains: KNOWN_BRIGHTSPACE_DOMAINS
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
// DEADLINE REMINDERS
// ============================================

const REMINDER_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h dedup window
const REMINDER_LOOKAHEAD_MS = 24 * 60 * 60 * 1000; // 24h lookahead
const MAX_NOTIFICATIONS_PER_CYCLE = 3;

async function checkDeadlineReminders() {
    try {
        const data = await chrome.storage.local.get(['indexedContent', 'reminderState']);
        const items = data.indexedContent || [];
        const state = data.reminderState || {};
        const now = Date.now();
        const notifications = [];

        for (const item of items) {
            if (!item.dueAt) continue;
            const type = (item.type || '').toLowerCase();
            if (!['assignment', 'quiz', 'discussion'].includes(type)) continue;

            const dueTs = new Date(item.dueAt).getTime();
            if (isNaN(dueTs)) continue;

            const taskId = canonicalBgTaskId(item);
            const timeUntilDue = dueTs - now;

            // Upcoming: due within 24h in the future
            if (timeUntilDue > 0 && timeUntilDue <= REMINDER_LOOKAHEAD_MS) {
                const windowKey = `${taskId}:upcoming`;
                if (!state[windowKey] || (now - state[windowKey]) > REMINDER_WINDOW_MS) {
                    const hoursLeft = Math.round(timeUntilDue / (60 * 60 * 1000));
                    notifications.push({
                        id: windowKey,
                        title: `⏰ Due in ${hoursLeft}h: ${item.title}`,
                        message: `${item.courseName || 'Course'} — ${type}`,
                        taskId: windowKey
                    });
                }
            }
            // Overdue: past due within last 24h
            if (timeUntilDue < 0 && timeUntilDue > -REMINDER_LOOKAHEAD_MS) {
                const windowKey = `${taskId}:overdue`;
                if (!state[windowKey] || (now - state[windowKey]) > REMINDER_WINDOW_MS) {
                    notifications.push({
                        id: windowKey,
                        title: `⚠ Overdue: ${item.title}`,
                        message: `${item.courseName || 'Course'} — ${type}`,
                        taskId: windowKey
                    });
                }
            }
        }

        // Fire at most MAX_NOTIFICATIONS_PER_CYCLE
        const toFire = notifications.slice(0, MAX_NOTIFICATIONS_PER_CYCLE);
        for (const n of toFire) {
            try {
                chrome.notifications.create(n.id, {
                    type: 'basic',
                    iconUrl: 'icons/icon128.png',
                    title: n.title,
                    message: n.message
                });
                state[n.taskId] = now;
            } catch (e) {
                console.warn('[Canvascope] Notification error:', e);
            }
        }

        // Prune old state entries (older than 48h)
        for (const key of Object.keys(state)) {
            if ((now - state[key]) > 48 * 60 * 60 * 1000) {
                delete state[key];
            }
        }

        if (toFire.length > 0) {
            await chrome.storage.local.set({ reminderState: state });
            console.log(`[Canvascope] Sent ${toFire.length} deadline reminder(s)`);
        }
    } catch (e) {
        console.warn('[Canvascope] Deadline reminder error:', e);
    }
}

function canonicalBgTaskId(item) {
    return getCanonicalId(item);
}

// ============================================
// STARTUP
// ============================================

console.log('[Canvascope] Background service worker started');

// Check if we should scan on startup
chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
        if (tab.url && getLmsContext(tab.url)) {
            triggerBackgroundScan(tab.url);
            break;
        }
    }
});
