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

const CANVAS_DOMAINS = [
    '.instructure.com'
];

// Dynamically detected Canvas domains (stored in chrome.storage)
let customDomains = [];

// Minimum time between scans (in milliseconds) - 5 minutes
const MIN_SCAN_INTERVAL = 5 * 60 * 1000;

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
    let baseUrl = 'https://bcourses.berkeley.edu';
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
        // Fetch course list
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

        // Merge with existing content
        const existingData = await chrome.storage.local.get(['indexedContent']);
        const existingContent = existingData.indexedContent || [];
        const existingUrls = new Set(existingContent.map(item => item.url));

        const newItems = allContent.filter(item => !existingUrls.has(item.url));
        const mergedContent = [...existingContent, ...newItems];

        // Save to storage
        await chrome.storage.local.set({
            indexedContent: mergedContent,
            settings: {
                lastScanTime: Date.now(),
                version: chrome.runtime.getManifest().version
            }
        });

        console.log(`[Canvascope] Scan complete! Total: ${mergedContent.length}, New: ${newItems.length}`);

        broadcastMessage({
            type: 'scanComplete',
            totalItems: mergedContent.length,
            newItems: newItems.length
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

async function fetchCourseList(baseUrl) {
    const courses = [];

    try {
        const response = await fetch(`${baseUrl}/api/v1/courses?per_page=50&enrollment_state=active`, {
            credentials: 'include'
        });

        if (response.ok) {
            const data = await response.json();
            for (const course of data) {
                if (course.id && course.name) {
                    courses.push({
                        id: course.id,
                        name: course.name,
                        code: course.course_code || ''
                    });
                }
            }
        }
    } catch (e) {
        console.warn('[Canvascope] Could not fetch courses:', e.message);
    }

    return courses;
}

async function fetchCourseContent(baseUrl, course) {
    const content = [];

    // Fetch assignments
    try {
        const response = await fetch(
            `${baseUrl}/api/v1/courses/${course.id}/assignments?per_page=100`,
            { credentials: 'include' }
        );
        if (response.ok) {
            const items = await response.json();
            for (const item of items) {
                content.push({
                    title: item.name,
                    url: item.html_url,
                    type: 'assignment',
                    moduleName: 'Assignments',
                    courseName: course.name,
                    courseId: course.id,
                    scannedAt: new Date().toISOString()
                });
            }
        }
    } catch (e) { }

    // Fetch files
    try {
        const response = await fetch(
            `${baseUrl}/api/v1/courses/${course.id}/files?per_page=100`,
            { credentials: 'include' }
        );
        if (response.ok) {
            const items = await response.json();
            for (const item of items) {
                const ext = (item.display_name || '').split('.').pop()?.toLowerCase();
                let type = 'file';
                if (ext === 'pdf') type = 'pdf';
                if (['ppt', 'pptx'].includes(ext)) type = 'slides';
                if (['mp4', 'mov', 'webm'].includes(ext)) type = 'video';
                if (['doc', 'docx'].includes(ext)) type = 'document';

                content.push({
                    title: item.display_name,
                    url: item.url || `${baseUrl}/courses/${course.id}/files/${item.id}`,
                    type,
                    moduleName: 'Files',
                    courseName: course.name,
                    courseId: course.id,
                    scannedAt: new Date().toISOString()
                });
            }
        }
    } catch (e) { }

    // Fetch pages
    try {
        const response = await fetch(
            `${baseUrl}/api/v1/courses/${course.id}/pages?per_page=100`,
            { credentials: 'include' }
        );
        if (response.ok) {
            const items = await response.json();
            for (const item of items) {
                content.push({
                    title: item.title,
                    url: item.html_url,
                    type: 'page',
                    moduleName: 'Pages',
                    courseName: course.name,
                    courseId: course.id,
                    scannedAt: new Date().toISOString()
                });
            }
        }
    } catch (e) { }

    // Fetch modules
    try {
        const modResponse = await fetch(
            `${baseUrl}/api/v1/courses/${course.id}/modules?per_page=50&include[]=items`,
            { credentials: 'include' }
        );
        if (modResponse.ok) {
            const modules = await modResponse.json();
            for (const mod of modules) {
                if (mod.items) {
                    for (const item of mod.items) {
                        if (item.html_url) {
                            content.push({
                                title: item.title,
                                url: item.html_url,
                                type: item.type?.toLowerCase() || 'link',
                                moduleName: mod.name,
                                courseName: course.name,
                                courseId: course.id,
                                scannedAt: new Date().toISOString()
                            });
                        }
                    }
                }
            }
        }
    } catch (e) { }

    // Fetch quizzes
    try {
        const response = await fetch(
            `${baseUrl}/api/v1/courses/${course.id}/quizzes?per_page=100`,
            { credentials: 'include' }
        );
        if (response.ok) {
            const items = await response.json();
            for (const item of items) {
                content.push({
                    title: item.title,
                    url: item.html_url,
                    type: 'quiz',
                    moduleName: 'Quizzes',
                    courseName: course.name,
                    courseId: course.id,
                    scannedAt: new Date().toISOString()
                });
            }
        }
    } catch (e) { }

    // Fetch discussions
    try {
        const response = await fetch(
            `${baseUrl}/api/v1/courses/${course.id}/discussion_topics?per_page=100`,
            { credentials: 'include' }
        );
        if (response.ok) {
            const items = await response.json();
            for (const item of items) {
                content.push({
                    title: item.title,
                    url: item.html_url,
                    type: 'discussion',
                    moduleName: 'Discussions',
                    courseName: course.name,
                    courseId: course.id,
                    scannedAt: new Date().toISOString()
                });
            }
        }
    } catch (e) { }

    return content;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function isCanvasDomain(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        // Check known Canvas patterns
        if (CANVAS_DOMAINS.some(domain => hostname.endsWith(domain))) {
            return true;
        }
        // Check custom domains
        if (customDomains.includes(hostname)) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
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
        const domain = message.domain.toLowerCase();
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
                const hostname = new URL(url).hostname.toLowerCase();
                if (!isCanvasDomain(url)) {
                    // Check if we should add this domain
                    // For now, just trigger a scan if user explicitly requests
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
});

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
