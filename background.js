/**
 * ============================================
 * Canvascope - Background Service Worker (background.js)
 * ============================================
 * 
 * PURPOSE:
 * - Automatically scans LMS courses in the background
 * - Triggers when supported LMS tabs are detected
 * - Runs periodic updates to keep content fresh
 * - Handles explicit user-triggered PDF handoff to Lectra
 * 
 * ============================================
 */

// ============================================

importScripts('lib/fuse.min.js');

// --- SUPABASE INITIALIZATION ---
// Create a single supabase client for the extension
const supabaseUrl = 'https://vcadcdgnwxjlgaoqktkd.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjYWRjZGdud3hqbGdhb3FrdGtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MzU4NDQsImV4cCI6MjA4NzIxMTg0NH0.71j6kwkwwSeG9Jppu4IUyHORM033NFyXKemOd5kuDWk';
const LECTRA_DOCUMENTS_BUCKET = 'lectra_documents';
const supabaseLib = typeof window !== 'undefined' && window.supabase
    ? window.supabase
    : typeof supabase !== 'undefined' ? supabase : null;

const supabaseAuthStorage = {
    async getItem(key) {
        const data = await chrome.storage.local.get([key]);
        return data?.[key] ?? null;
    },
    async setItem(key, value) {
        await chrome.storage.local.set({ [key]: value });
    },
    async removeItem(key) {
        await chrome.storage.local.remove([key]);
    }
};

const supabaseClient = supabaseLib
    ? supabaseLib.createClient(supabaseUrl, supabaseKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            storage: supabaseAuthStorage
        }
    })
    : null;

if (!supabaseClient) {
    console.error('[Canvascope] Supabase client failed to initialize (ensure lib/supabase.js is loaded)');
}

const AUTH_STATUS_SNAPSHOT_KEY = 'canvascopeAuthStatusSnapshot';

function buildAuthStatusUser(session) {
    if (!session?.user) return null;
    return {
        email: session.user.email,
        name: session.user.user_metadata?.full_name || session.user.user_metadata?.name || 'User',
        avatar_url: session.user.user_metadata?.avatar_url
    };
}

async function persistAuthStatusSnapshot(session) {
    const payload = session?.user
        ? {
            signedIn: true,
            user: buildAuthStatusUser(session),
            userId: session.user.id,
            updatedAt: Date.now()
        }
        : {
            signedIn: false,
            user: null,
            userId: null,
            updatedAt: Date.now()
        };

    try {
        await chrome.storage.local.set({ [AUTH_STATUS_SNAPSHOT_KEY]: payload });
    } catch (error) {
        console.warn('[Canvascope Auth] Failed to persist auth snapshot:', parseErrorMessage(error));
    }
}

async function readAuthStatusSnapshot() {
    try {
        const data = await chrome.storage.local.get([AUTH_STATUS_SNAPSHOT_KEY]);
        const snapshot = data?.[AUTH_STATUS_SNAPSHOT_KEY];
        if (!snapshot || typeof snapshot !== 'object') return null;
        return snapshot;
    } catch (error) {
        console.warn('[Canvascope Auth] Failed to read auth snapshot:', parseErrorMessage(error));
        return null;
    }
}

async function resolveAuthStatus() {
    if (!supabaseClient) {
        const snapshot = await readAuthStatusSnapshot();
        return snapshot?.signedIn
            ? { signedIn: true, user: snapshot.user || null, source: 'snapshot' }
            : { signedIn: false, source: 'none' };
    }

    try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error) {
            console.error('[Canvascope Auth] Error checking session:', error);
        }

        if (session?.user) {
            await persistAuthStatusSnapshot(session);
            return {
                signedIn: true,
                user: buildAuthStatusUser(session),
                source: 'session'
            };
        }
    } catch (error) {
        console.error('[Canvascope Auth] Unhandled session lookup error:', error);
    }

    const snapshot = await readAuthStatusSnapshot();
    if (snapshot?.signedIn && snapshot.user) {
        return {
            signedIn: true,
            user: snapshot.user,
            source: 'snapshot'
        };
    }

    await persistAuthStatusSnapshot(null);
    return { signedIn: false, source: 'none' };
}

if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((event, session) => {
        dropBridgeDebug('auth state change', {
            event,
            userId: session?.user?.id || null
        });

        persistAuthStatusSnapshot(session).catch((error) => {
            console.warn('[Canvascope Auth] Failed to sync auth snapshot after state change:', parseErrorMessage(error));
        });

        if (event === 'SIGNED_OUT') {
            stopDropBridgeV2Loop();
            return;
        }

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
            startDropBridgeV2Loop(`auth-${event.toLowerCase()}`).catch((error) => {
                console.error(`[DropBridge v2] Auth bootstrap failure (${event}):`, parseErrorMessage(error));
            });
        }
    });
}

// --- DROPBRIDGE V2 (ACCOUNT-LINKED, ZERO-PAIRING) ---
const DROPBRIDGE_V2_ENABLED = true;
const DROPBRIDGE_V2_DOWNLOAD_WATCHDOG_INTERVAL_MS = 15 * 1000;
const DROPBRIDGE_V2_DOWNLOAD_MAX_OBSERVE_MS = 30 * 60 * 1000;
const DROPBRIDGE_V2_STORAGE_DEVICE_ID = 'dropBridgeV2DeviceId';
const DROPBRIDGE_MODE_STORAGE_KEY = 'dropBridgeMode';
const DROPBRIDGE_V2_MODE = 'v2';
const DROPBRIDGE_V2_POLL_LIMIT = 5;
const DROPBRIDGE_V2_WAKE_EVENT = 'upload_queued';
const DROPBRIDGE_V2_WAKE_POLL_DEBOUNCE_MS = 1000;
const DROPBRIDGE_V2_RECEIVER_WARMUP_THROTTLE_MS = 15 * 1000;
const DROPBRIDGE_V2_RECEIVER_RESTART_THROTTLE_MS = 5 * 1000;
const DROPBRIDGE_V2_INTENTIONAL_CLOSE_GRACE_MS = 10 * 1000;
const DROPBRIDGE_V2_FALLBACK_ALARM_NAME = 'dropBridgeV2FallbackPoll';
const DROPBRIDGE_V2_FALLBACK_ALARM_MINUTES_MODERN = 0.5;
const DROPBRIDGE_V2_FALLBACK_ALARM_MINUTES_LEGACY = 1;
const DROPBRIDGE_V2_FALLBACK_ALARM_MIN_CHROME_MAJOR = 120;
const DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_PATH);
const DROPBRIDGE_V2_OFFSCREEN_JUSTIFICATION = 'Keep a hidden worker-backed receiver alive for the optional Lectra to Canvascope file delivery flow so queued files can trigger a browser download without opening a visible tab.';
const DROPBRIDGE_V2_DIAGNOSTICS_STORAGE_KEY = 'dropBridgeV2Diagnostics';
const DROPBRIDGE_V2_DIAGNOSTIC_EVENT_LIMIT = 25;
const DROPBRIDGE_V2_DEBUG = false; // enable only for local debugging
const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
    enableSendToLectra: false,
    selectedCourseFilters: []
});
const PDF_VIEWER_OVERLAY_CONTENT_SCRIPT_ID = 'canvascopePdfViewerOverlay';
const PDF_VIEWER_OVERLAY_WEBSITE_ORIGINS = ['https://*/*', 'http://*/*'];
const PDF_VIEWER_OVERLAY_FILE_MATCH = 'file:///*';
const PDF_VIEWER_DEBUG = true;
const STATIC_LMS_CONTENT_SCRIPT_MATCHES = (() => {
    const manifestContentScripts = chrome.runtime.getManifest()?.content_scripts || [];
    return manifestContentScripts
        .filter((entry) => Array.isArray(entry?.js) && entry.js.includes('content.js'))
        .flatMap((entry) => Array.isArray(entry?.matches) ? entry.matches : []);
})();

let dropBridgeV2PollInFlight = false;
let dropBridgeV2QueuedPollReason = null;
let dropBridgeV2QueuedPollTimer = null;
let dropBridgeV2LastPollStartedAt = 0;
let dropBridgeV2EnsureOffscreenPromise = null;
let dropBridgeV2WarmupPromise = null;
let dropBridgeV2LastWarmupAt = 0;
let dropBridgeV2LastRestartAt = 0;
let dropBridgeV2IntentionalOffscreenCloseUntil = 0;
let dropBridgeV2DiagnosticsState = null;
let dropBridgeV2DiagnosticsWritePromise = Promise.resolve();
const dropBridgeV2ActiveUploads = new Set();
let syncIndexedContentPromise = null;
let syncIndexedContentNeedsRerun = false;

function normalizeExtensionSettings(rawSettings) {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    return {
        ...DEFAULT_EXTENSION_SETTINGS,
        ...source
    };
}

async function getExtensionSettings() {
    const stored = await chrome.storage.local.get(['settings']);
    return normalizeExtensionSettings(stored.settings);
}

function permissionsContains(permissions) {
    return new Promise((resolve) => {
        chrome.permissions.contains(permissions, (granted) => {
            resolve(Boolean(granted));
        });
    });
}

function permissionsGetAll() {
    return new Promise((resolve) => {
        chrome.permissions.getAll((granted) => {
            resolve(granted || {});
        });
    });
}

function getAllowedFileSchemeAccess() {
    return new Promise((resolve) => {
        chrome.extension.isAllowedFileSchemeAccess((isAllowed) => {
            resolve(Boolean(isAllowed));
        });
    });
}

async function getGrantedPdfViewerOverlayWebsiteOrigins() {
    return [...PDF_VIEWER_OVERLAY_WEBSITE_ORIGINS];
}

function isStaticallySupportedLmsHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return false;
    return isCanvasHost(host) || isBrightspaceHost(host);
}

function isTabUrlEligibleForPdfViewerOverlay(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'file:') return true;
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        return !isStaticallySupportedLmsHost(parsed.hostname);
    } catch {
        return false;
    }
}

function isUuid(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function generateUuidV4() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function detectBrowserName() {
    const ua = (navigator?.userAgent || '').toLowerCase();
    if (ua.includes('edg/')) return 'Edge';
    if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
    if (ua.includes('brave')) return 'Brave';
    if (ua.includes('arc/')) return 'Arc';
    if (ua.includes('chrome/')) return 'Chrome';
    if (ua.includes('firefox/')) return 'Firefox';
    if (ua.includes('safari/')) return 'Safari';
    return 'Browser';
}

function detectOsName() {
    const ua = (navigator?.userAgent || '').toLowerCase();
    if (ua.includes('mac os x')) return 'macOS';
    if (ua.includes('windows nt')) return 'Windows';
    if (ua.includes('android')) return 'Android';
    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'iOS';
    if (ua.includes('cros')) return 'ChromeOS';
    if (ua.includes('linux')) return 'Linux';
    return 'UnknownOS';
}

function getDropBridgeV2DeviceName() {
    return `${detectBrowserName()} + ${detectOsName()}`.slice(0, 64);
}

function buildPdfStoragePath(userId, rowId, date = new Date()) {
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${userId}/lectra_documents/imported_from_canvascope/${year}/${month}/${rowId}.pdf`;
}

function sanitizeFilename(name) {
    const raw = String(name || 'lectra-file');
    const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').trim();
    return cleaned || `lectra-file-${Date.now()}`;
}

function isDropBridgeUserCanceled(reason) {
    const msg = String(reason || '').toUpperCase();
    return msg.includes('USER_CANCELED') || msg.includes('USER_CANCELLED') || msg.includes('CANCELED') || msg.includes('CANCELLED');
}

function parseErrorMessage(error) {
    if (!error) return 'Unknown error';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message) return error.message;
    return String(error);
}

function pdfViewerDebug(message, details = undefined) {
    if (!PDF_VIEWER_DEBUG) return;
    const prefix = '[Canvascope PDF Viewer][BG]';
    if (details === undefined) {
        console.log(prefix, message);
        return;
    }
    console.log(prefix, message, details);
}

function summarizeDownloadUrl(downloadUrl) {
    if (!downloadUrl) return null;
    try {
        const url = new URL(downloadUrl);
        return {
            origin: url.origin,
            pathname: url.pathname
        };
    } catch (_) {
        return { raw: String(downloadUrl).slice(0, 200) };
    }
}

function sanitizeDropBridgePayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }

    const copy = { ...payload };
    if (Array.isArray(copy.uploads)) {
        copy.uploads = copy.uploads.map((upload) => ({
            id: upload?.id || null,
            uploadId: upload?.uploadId || null,
            fileName: upload?.fileName || null,
            mimeType: upload?.mimeType || null,
            sizeBytes: upload?.sizeBytes ?? null,
            createdAt: upload?.createdAt || null,
            expiresAt: upload?.expiresAt || null,
            downloadUrl: summarizeDownloadUrl(upload?.downloadUrl)
        }));
    }

    return copy;
}

function dropBridgeDebug(message, details = undefined) {
    if (!DROPBRIDGE_V2_DEBUG) return;
    const timestamp = new Date().toISOString();
    if (details === undefined) {
        console.log(`[DropBridge v2][debug][${timestamp}] ${message}`);
        return;
    }
    console.log(`[DropBridge v2][debug][${timestamp}] ${message}`, details);
}

function getChromeMajorVersion(userAgent = navigator?.userAgent || '') {
    const match = String(userAgent).match(/Chrome\/(\d+)/i) || String(userAgent).match(/Chromium\/(\d+)/i);
    const major = Number(match?.[1] || 0);
    return Number.isFinite(major) ? major : 0;
}

function getDropBridgeV2FallbackAlarmPeriodMinutes() {
    const chromeMajor = getChromeMajorVersion();
    return chromeMajor >= DROPBRIDGE_V2_FALLBACK_ALARM_MIN_CHROME_MAJOR
        ? DROPBRIDGE_V2_FALLBACK_ALARM_MINUTES_MODERN
        : DROPBRIDGE_V2_FALLBACK_ALARM_MINUTES_LEGACY;
}

function normalizeDropBridgeV2Diagnostics(rawDiagnostics) {
    const source = rawDiagnostics && typeof rawDiagnostics === 'object' ? rawDiagnostics : {};
    return {
        ...source,
        recentEvents: Array.isArray(source.recentEvents)
            ? source.recentEvents.slice(-DROPBRIDGE_V2_DIAGNOSTIC_EVENT_LIMIT)
            : []
    };
}

async function getDropBridgeV2DiagnosticsState() {
    if (dropBridgeV2DiagnosticsState) {
        return dropBridgeV2DiagnosticsState;
    }

    const stored = await chrome.storage.local.get([DROPBRIDGE_V2_DIAGNOSTICS_STORAGE_KEY]);
    dropBridgeV2DiagnosticsState = normalizeDropBridgeV2Diagnostics(stored?.[DROPBRIDGE_V2_DIAGNOSTICS_STORAGE_KEY]);
    return dropBridgeV2DiagnosticsState;
}

function updateDropBridgeV2Diagnostics(patch = {}, event = null) {
    dropBridgeV2DiagnosticsWritePromise = dropBridgeV2DiagnosticsWritePromise.then(async () => {
        const current = await getDropBridgeV2DiagnosticsState();
        const nowIso = new Date().toISOString();
        const next = {
            ...current,
            ...patch,
            updatedAt: nowIso,
            recentEvents: event
                ? [...current.recentEvents, { at: nowIso, ...event }].slice(-DROPBRIDGE_V2_DIAGNOSTIC_EVENT_LIMIT)
                : current.recentEvents
        };
        dropBridgeV2DiagnosticsState = next;
        await chrome.storage.local.set({
            [DROPBRIDGE_V2_DIAGNOSTICS_STORAGE_KEY]: next
        });
        return next;
    }).catch((error) => {
        console.warn('[DropBridge v2] Failed to update diagnostics:', parseErrorMessage(error));
        return dropBridgeV2DiagnosticsState;
    });

    return dropBridgeV2DiagnosticsWritePromise;
}

function isSupabaseSessionExpired(session, skewSeconds = 30) {
    const expiresAt = Number(session?.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
    const now = Math.floor(Date.now() / 1000);
    return expiresAt <= (now + skewSeconds);
}

async function hydrateDropBridgeV2SessionFromStorage() {
    if (!supabaseClient) return null;
    dropBridgeDebug('hydrate session from storage: begin');

    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) {
        console.error('[DropBridge v2] Failed to load session from storage:', parseErrorMessage(error));
        dropBridgeDebug('hydrate session from storage: getSession error', { error: parseErrorMessage(error) });
        return null;
    }

    if (!session) {
        console.log('[DropBridge v2] No stored Supabase session found at worker start');
        dropBridgeDebug('hydrate session from storage: no session found');
        return null;
    }

    dropBridgeDebug('hydrate session from storage: session found', {
        userId: session?.user?.id || null,
        expiresAtEpoch: session?.expires_at || null
    });

    if (isSupabaseSessionExpired(session) && session.refresh_token) {
        console.log('[DropBridge v2] Stored session expired, attempting refresh');
        dropBridgeDebug('hydrate session from storage: attempting refresh for expired session');
        const { data, error: refreshError } = await supabaseClient.auth.refreshSession({
            refresh_token: session.refresh_token
        });

        if (refreshError) {
            console.error('[DropBridge v2] Session refresh failed:', parseErrorMessage(refreshError));
            dropBridgeDebug('hydrate session from storage: refresh failed', { error: parseErrorMessage(refreshError) });
            return session;
        }

        console.log('[DropBridge v2] Session refresh succeeded at worker start');
        dropBridgeDebug('hydrate session from storage: refresh succeeded', {
            userId: data?.session?.user?.id || null,
            expiresAtEpoch: data?.session?.expires_at || null
        });
        return data?.session || null;
    }

    dropBridgeDebug('hydrate session from storage: session usable without refresh');
    return session;
}

async function getDropBridgeV2AccessToken() {
    if (!supabaseClient) return null;
    dropBridgeDebug('get access token: begin');
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    if (!session) {
        dropBridgeDebug('get access token: no session available');
        return null;
    }

    dropBridgeDebug('get access token: session loaded', {
        userId: session?.user?.id || null,
        expiresAtEpoch: session?.expires_at || null,
        hasRefreshToken: Boolean(session?.refresh_token)
    });

    if (isSupabaseSessionExpired(session)) {
        dropBridgeDebug('get access token: session expired, attempting refresh');
        if (!session.refresh_token) {
            dropBridgeDebug('get access token: session expired but refresh token missing');
            return null;
        }

        const { data, error: refreshError } = await supabaseClient.auth.refreshSession({
            refresh_token: session.refresh_token
        });

        if (refreshError) {
            console.error('[DropBridge v2] Session refresh failed during token fetch:', parseErrorMessage(refreshError));
            dropBridgeDebug('get access token: refresh failed', { error: parseErrorMessage(refreshError) });
            return null;
        }

        dropBridgeDebug('get access token: refresh succeeded', {
            userId: data?.session?.user?.id || null,
            expiresAtEpoch: data?.session?.expires_at || null
        });
        return data?.session?.access_token || null;
    }

    dropBridgeDebug('get access token: returning existing access token');
    return session.access_token || null;
}

async function getSupabaseAccessToken() {
    return getDropBridgeV2AccessToken();
}

async function callCanvascopeSupabaseFunction(functionName, body = {}) {
    if (!supabaseClient) {
        throw new Error('Supabase client unavailable');
    }

    const accessToken = await getSupabaseAccessToken();
    if (!accessToken) {
        throw new Error('Not signed in');
    }

    const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/${functionName}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) {
        throw new Error(payload?.error || `${functionName} failed (${response.status})`);
    }

    return payload;
}

async function getOrCreateDropBridgeV2DeviceId() {
    const stored = await chrome.storage.local.get([DROPBRIDGE_V2_STORAGE_DEVICE_ID, DROPBRIDGE_MODE_STORAGE_KEY]);
    const existingId = stored[DROPBRIDGE_V2_STORAGE_DEVICE_ID];
    if (isUuid(existingId)) {
        dropBridgeDebug('device id: using existing id', {
            deviceId: existingId,
            mode: stored[DROPBRIDGE_MODE_STORAGE_KEY] || null
        });
        if (stored[DROPBRIDGE_MODE_STORAGE_KEY] !== DROPBRIDGE_V2_MODE) {
            await chrome.storage.local.set({ [DROPBRIDGE_MODE_STORAGE_KEY]: DROPBRIDGE_V2_MODE });
            dropBridgeDebug('device id: normalized mode to v2', { deviceId: existingId });
        }
        return existingId;
    }

    const nextId = generateUuidV4();
    await chrome.storage.local.set({
        [DROPBRIDGE_V2_STORAGE_DEVICE_ID]: nextId,
        [DROPBRIDGE_MODE_STORAGE_KEY]: DROPBRIDGE_V2_MODE
    });
    console.log(`[DropBridge v2] Generated stable deviceId: ${nextId}`);
    dropBridgeDebug('device id: generated new id', { deviceId: nextId });
    return nextId;
}

async function callDropBridgeV2Function(functionName, body, accessToken) {
    const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/${functionName}`;
    const startedAtMs = Date.now();
    dropBridgeDebug(`function call -> ${functionName}: request`, {
        endpoint,
        hasAccessToken: Boolean(accessToken),
        body: sanitizeDropBridgePayload(body)
    });

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    dropBridgeDebug(`function call -> ${functionName}: response`, {
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAtMs,
        payload: sanitizeDropBridgePayload(payload)
    });

    if (!response.ok || payload?.error) {
        dropBridgeDebug(`function call -> ${functionName}: throwing error`, {
            status: response.status,
            error: payload?.error || null
        });
        throw new Error(payload?.error || `${functionName} failed (${response.status})`);
    }

    return payload;
}

async function updateDropBridgeV2UploadStatus({ accessToken, deviceId, uploadId, status }) {
    try {
        dropBridgeDebug('status ack: sending', { uploadId, deviceId, status });
        await callDropBridgeV2Function('update-upload-status-v2', {
            deviceId,
            uploadId,
            status,
            clientKind: 'canvascope_extension'
        }, accessToken);
        dropBridgeDebug('status ack: success', { uploadId, deviceId, status });
        void updateDropBridgeV2Diagnostics({
            lastAckAt: new Date().toISOString(),
            lastAckUploadId: uploadId,
            lastAckStatus: status,
            lastAckOk: true
        }, {
            type: 'upload_ack',
            uploadId,
            status,
            ok: true
        });
        return true;
    } catch (error) {
        console.error(`[DropBridge v2] Status update failure for ${uploadId} -> ${status}:`, parseErrorMessage(error));
        dropBridgeDebug('status ack: failure', {
            uploadId,
            deviceId,
            status,
            error: parseErrorMessage(error)
        });
        void updateDropBridgeV2Diagnostics({
            lastAckAt: new Date().toISOString(),
            lastAckUploadId: uploadId,
            lastAckStatus: status,
            lastAckOk: false
        }, {
            type: 'upload_ack',
            uploadId,
            status,
            ok: false,
            error: parseErrorMessage(error)
        });
        return false;
    }
}

function resolveDropBridgeUploadId(upload) {
    return upload?.uploadId || upload?.id || null;
}

async function claimDropBridgeV2UploadById({ accessToken, deviceId, uploadId }) {
    return callDropBridgeV2Function('claim-upload-v2', {
        deviceId,
        uploadId,
        clientKind: 'canvascope_extension'
    }, accessToken);
}

async function tryClaimAndProcessDropBridgeV2UploadById({ uploadId, accessToken = null, deviceId = null, reason = 'targeted-claim' }) {
    const normalizedUploadId = String(uploadId || '').trim();
    if (!isUuid(normalizedUploadId)) {
        dropBridgeDebug('targeted claim: skipped invalid uploadId', {
            uploadId,
            reason
        });
        return false;
    }

    const resolvedAccessToken = accessToken || await getDropBridgeV2AccessToken();
    if (!resolvedAccessToken) {
        dropBridgeDebug('targeted claim: skipped missing access token', {
            uploadId: normalizedUploadId,
            reason
        });
        return false;
    }

    const resolvedDeviceId = deviceId || await getOrCreateDropBridgeV2DeviceId();
    try {
        const payload = await claimDropBridgeV2UploadById({
            accessToken: resolvedAccessToken,
            deviceId: resolvedDeviceId,
            uploadId: normalizedUploadId
        });
        const upload = payload?.upload || null;
        if (!upload) {
            dropBridgeDebug('targeted claim: no upload returned', {
                uploadId: normalizedUploadId,
                reason
            });
            return false;
        }

        dropBridgeDebug('targeted claim: processing claimed upload', {
            uploadId: normalizedUploadId,
            reason
        });
        await processDropBridgeV2Upload(upload, resolvedAccessToken, resolvedDeviceId);
        return true;
    } catch (error) {
        dropBridgeDebug('targeted claim: failed', {
            uploadId: normalizedUploadId,
            reason,
            error: parseErrorMessage(error)
        });
        return false;
    }
}

function shouldRestartDropBridgeReceiverFromStatus(status, reason = null) {
    const normalizedStatus = String(status || '').toLowerCase();
    if (!['error', 'timed_out', 'closed'].includes(normalizedStatus)) {
        return false;
    }

    const normalizedReason = String(reason || '').toLowerCase();
    if (normalizedReason === 'no-context') {
        return false;
    }

    if (Date.now() < dropBridgeV2IntentionalOffscreenCloseUntil) {
        return false;
    }

    return true;
}

async function ensureDropBridgeV2LoopWarm(reason = 'manual', { force = false, restart = false } = {}) {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        return {
            success: false,
            reason: 'disabled'
        };
    }

    const now = Date.now();
    const throttleWindowMs = restart
        ? DROPBRIDGE_V2_RECEIVER_RESTART_THROTTLE_MS
        : DROPBRIDGE_V2_RECEIVER_WARMUP_THROTTLE_MS;
    const lastRunAt = restart ? dropBridgeV2LastRestartAt : dropBridgeV2LastWarmupAt;

    if (!force && lastRunAt > 0 && (now - lastRunAt) < throttleWindowMs) {
        return {
            success: true,
            throttled: true,
            reason
        };
    }

    if (dropBridgeV2WarmupPromise) {
        return dropBridgeV2WarmupPromise;
    }

    if (restart) {
        dropBridgeV2LastRestartAt = now;
    } else {
        dropBridgeV2LastWarmupAt = now;
    }

    dropBridgeV2WarmupPromise = (async () => {
        await startDropBridgeV2Loop(reason);
        return {
            success: true,
            throttled: false,
            reason
        };
    })().finally(() => {
        dropBridgeV2WarmupPromise = null;
    });

    return dropBridgeV2WarmupPromise;
}

function getDownloadItemById(downloadId) {
    return new Promise((resolve) => {
        chrome.downloads.search({ id: downloadId }, (results) => {
            resolve(Array.isArray(results) && results.length > 0 ? results[0] : null);
        });
    });
}

async function triggerDropBridgeDownload(upload) {
    const uploadId = resolveDropBridgeUploadId(upload) || 'unknown-upload';
    const downloadUrl = upload?.downloadUrl;
    const fileName = sanitizeFilename(upload?.fileName);
    dropBridgeDebug('download: begin', {
        uploadId,
        fileName,
        sizeBytes: upload?.sizeBytes ?? null,
        downloadUrl: summarizeDownloadUrl(downloadUrl)
    });

    if (!downloadUrl) {
        dropBridgeDebug('download: missing downloadUrl -> queued', { uploadId });
        void updateDropBridgeV2Diagnostics({
            lastDownloadAt: new Date().toISOString(),
            lastDownloadUploadId: uploadId,
            lastDownloadStatus: 'queued',
            lastDownloadReason: 'Missing downloadUrl'
        }, {
            type: 'download_finalized',
            uploadId,
            status: 'queued',
            reason: 'Missing downloadUrl'
        });
        return { status: 'queued', reason: 'Missing downloadUrl' };
    }

    return new Promise((resolve) => {
        let done = false;
        let downloadId = null;
        let timeoutId = null;
        const startedAt = Date.now();

        const finalize = (result) => {
            if (done) return;
            done = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (downloadId !== null) {
                chrome.downloads.onChanged.removeListener(onChanged);
                chrome.downloads.onErased.removeListener(onErased);
            }
            dropBridgeDebug('download: finalize', {
                uploadId,
                downloadId,
                result,
                elapsedMs: Date.now() - startedAt
            });
            void updateDropBridgeV2Diagnostics({
                lastDownloadAt: new Date().toISOString(),
                lastDownloadUploadId: uploadId,
                lastDownloadStatus: result.status,
                lastDownloadReason: result.reason || null
            }, {
                type: 'download_finalized',
                uploadId,
                status: result.status,
                reason: result.reason || null
            });
            resolve(result);
        };

        const onChanged = (delta) => {
            if (delta.id !== downloadId) return;
            dropBridgeDebug('download: onChanged', {
                uploadId,
                downloadId,
                deltaState: delta?.state?.current || null,
                deltaError: delta?.error?.current || null,
                bytesReceived: delta?.bytesReceived?.current ?? null
            });

            if (delta.state?.current === 'complete') {
                finalize({ status: 'downloaded' });
                return;
            }

            if (delta.state?.current === 'interrupted') {
                const reason = delta.error?.current || 'DOWNLOAD_INTERRUPTED';
                if (isDropBridgeUserCanceled(reason)) {
                    finalize({ status: 'canceled', reason });
                } else {
                    finalize({ status: 'queued', reason });
                }
            }
        };

        const onErased = (erasedId) => {
            if (erasedId === downloadId) {
                dropBridgeDebug('download: onErased -> canceled', { uploadId, downloadId });
                finalize({ status: 'canceled', reason: 'USER_CANCELED' });
            }
        };

        const scheduleWatchdogCheck = () => {
            timeoutId = setTimeout(async () => {
                const item = await getDownloadItemById(downloadId);
                dropBridgeDebug('download: watchdog tick', {
                    uploadId,
                    downloadId,
                    elapsedMs: Date.now() - startedAt,
                    itemState: item?.state || null,
                    paused: item?.paused ?? null,
                    error: item?.error || null
                });
                if (!item) {
                    finalize({ status: 'queued', reason: 'DOWNLOAD_ITEM_MISSING' });
                    return;
                }

                if (item.state === 'complete') {
                    finalize({ status: 'downloaded' });
                    return;
                }

                if (item.state === 'interrupted') {
                    const reason = item.error || 'DOWNLOAD_INTERRUPTED';
                    if (isDropBridgeUserCanceled(reason)) {
                        finalize({ status: 'canceled', reason });
                    } else {
                        finalize({ status: 'queued', reason });
                    }
                    return;
                }

                const isStillActive = item.state === 'in_progress' || item.paused === true;
                const elapsedMs = Date.now() - startedAt;
                if (isStillActive && elapsedMs < DROPBRIDGE_V2_DOWNLOAD_MAX_OBSERVE_MS) {
                    scheduleWatchdogCheck();
                    return;
                }

                if (isStillActive) {
                    finalize({ status: 'queued', reason: 'DOWNLOAD_TIMEOUT' });
                    return;
                }

                finalize({
                    status: 'queued',
                    reason: `DOWNLOAD_STATE_${String(item.state || 'UNKNOWN').toUpperCase()}`
                });
            }, DROPBRIDGE_V2_DOWNLOAD_WATCHDOG_INTERVAL_MS);
        };

        chrome.downloads.download(
            {
                url: downloadUrl,
                filename: fileName,
                saveAs: false,
                conflictAction: 'uniquify'
            },
            (id) => {
                const startError = chrome.runtime.lastError?.message;
                dropBridgeDebug('download: chrome.downloads.download callback', {
                    uploadId,
                    returnedDownloadId: typeof id === 'number' ? id : null,
                    startError: startError || null
                });
                if (startError || typeof id !== 'number') {
                    if (isDropBridgeUserCanceled(startError)) {
                        finalize({ status: 'canceled', reason: startError || 'USER_CANCELED' });
                    } else {
                        finalize({ status: 'queued', reason: startError || 'DOWNLOAD_START_FAILED' });
                    }
                    return;
                }

                downloadId = id;
                chrome.downloads.onChanged.addListener(onChanged);
                chrome.downloads.onErased.addListener(onErased);
                dropBridgeDebug('download: listener attached', { uploadId, downloadId });
                scheduleWatchdogCheck();
            }
        );
    });
}

async function processDropBridgeV2Upload(upload, accessToken, deviceId) {
    const uploadId = resolveDropBridgeUploadId(upload);
    dropBridgeDebug('process upload: begin', {
        uploadId,
        deviceId,
        hasAccessToken: Boolean(accessToken),
        upload
    });
    if (!uploadId) {
        console.warn('[DropBridge v2] Skipping upload with missing uploadId field');
        dropBridgeDebug('process upload: skipped missing uploadId');
        return;
    }
    if (dropBridgeV2ActiveUploads.has(uploadId)) {
        dropBridgeDebug('process upload: skipped already active', { uploadId, deviceId });
        return;
    }

    const startedAtMs = Date.now();
    dropBridgeV2ActiveUploads.add(uploadId);
    dropBridgeDebug('process upload: marked active', {
        uploadId,
        deviceId,
        activeCount: dropBridgeV2ActiveUploads.size
    });
    void updateDropBridgeV2Diagnostics({
        lastClaimedAt: new Date().toISOString(),
        lastClaimedUploadId: uploadId
    }, {
        type: 'upload_processing_started',
        uploadId,
        deviceId
    });
    try {
        const result = await triggerDropBridgeDownload(upload);
        if (result.status === 'downloaded') {
            console.log(`[DropBridge v2] Download success for ${uploadId}`);
        } else {
            console.warn(`[DropBridge v2] Download ${result.status} for ${uploadId}: ${result.reason || 'no-reason'}`);
        }

        await updateDropBridgeV2UploadStatus({
            accessToken,
            deviceId,
            uploadId,
            status: result.status
        });
        dropBridgeDebug('process upload: ack attempted', {
            uploadId,
            deviceId,
            status: result.status,
            durationMs: Date.now() - startedAtMs
        });
    } catch (error) {
        console.error(`[DropBridge v2] Download failure for ${uploadId}:`, parseErrorMessage(error));
        await updateDropBridgeV2UploadStatus({
            accessToken,
            deviceId,
            uploadId,
            status: 'queued'
        });
        dropBridgeDebug('process upload: exception path acked queued', {
            uploadId,
            deviceId,
            error: parseErrorMessage(error),
            durationMs: Date.now() - startedAtMs
        });
    } finally {
        dropBridgeV2ActiveUploads.delete(uploadId);
        dropBridgeDebug('process upload: finished', {
            uploadId,
            deviceId,
            activeCount: dropBridgeV2ActiveUploads.size
        });
    }
}

function buildDropBridgeV2WakeTopic(userId, deviceId) {
    return `dropbridge:user:${userId}:device:${deviceId}`;
}

function clearDropBridgeV2QueuedPoll() {
    if (dropBridgeV2QueuedPollTimer) {
        clearTimeout(dropBridgeV2QueuedPollTimer);
        dropBridgeV2QueuedPollTimer = null;
    }
    dropBridgeV2QueuedPollReason = null;
}

async function hasDropBridgeV2OffscreenDocument() {
    if (!chrome.offscreen) {
        return false;
    }

    if (typeof chrome.runtime.getContexts === 'function') {
        try {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_URL]
            });
            return Array.isArray(contexts) && contexts.length > 0;
        } catch (error) {
            dropBridgeDebug('offscreen: getContexts failed', { error: parseErrorMessage(error) });
        }
    }

    if (self.clients && typeof self.clients.matchAll === 'function') {
        const clients = await self.clients.matchAll();
        return clients.some((client) => client.url === DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_URL);
    }

    return false;
}

async function ensureDropBridgeV2OffscreenReceiver(reason = 'startup') {
    if (!DROPBRIDGE_V2_ENABLED) return false;
    if (!chrome.offscreen) {
        console.warn('[DropBridge v2] chrome.offscreen is unavailable; falling back to alarm-only receive mode.');
        void updateDropBridgeV2Diagnostics({
            receiverStatus: 'unsupported',
            receiverStatusAt: new Date().toISOString(),
            receiverError: 'chrome.offscreen unavailable'
        }, {
            type: 'receiver_status',
            status: 'unsupported',
            reason
        });
        return false;
    }

    if (dropBridgeV2EnsureOffscreenPromise) {
        return dropBridgeV2EnsureOffscreenPromise;
    }

    dropBridgeV2EnsureOffscreenPromise = (async () => {
        if (await hasDropBridgeV2OffscreenDocument()) {
            void updateDropBridgeV2Diagnostics({
                receiverStatus: 'existing',
                receiverStatusAt: new Date().toISOString()
            }, {
                type: 'receiver_status',
                status: 'existing',
                reason
            });
            return true;
        }

        void updateDropBridgeV2Diagnostics({
            receiverStatus: 'creating',
            receiverStatusAt: new Date().toISOString(),
            receiverError: null
        }, {
            type: 'receiver_status',
            status: 'creating',
            reason
        });

        try {
            await chrome.offscreen.createDocument({
                url: DROPBRIDGE_V2_OFFSCREEN_DOCUMENT_PATH,
                reasons: [chrome.offscreen.Reason?.WORKERS || 'WORKERS'],
                justification: DROPBRIDGE_V2_OFFSCREEN_JUSTIFICATION
            });
            void updateDropBridgeV2Diagnostics({
                receiverStatus: 'created',
                receiverStatusAt: new Date().toISOString(),
                receiverError: null
            }, {
                type: 'receiver_status',
                status: 'created',
                reason
            });
            return true;
        } catch (error) {
            const message = parseErrorMessage(error);
            const lowered = message.toLowerCase();
            const alreadyExists = lowered.includes('single offscreen document') || lowered.includes('already exists');
            if (alreadyExists) {
                void updateDropBridgeV2Diagnostics({
                    receiverStatus: 'existing',
                    receiverStatusAt: new Date().toISOString(),
                    receiverError: null
                }, {
                    type: 'receiver_status',
                    status: 'existing',
                    reason
                });
                return true;
            }

            void updateDropBridgeV2Diagnostics({
                receiverStatus: 'error',
                receiverStatusAt: new Date().toISOString(),
                receiverError: message
            }, {
                type: 'receiver_status',
                status: 'error',
                reason,
                error: message
            });
            throw error;
        } finally {
            dropBridgeV2EnsureOffscreenPromise = null;
        }
    })();

    return dropBridgeV2EnsureOffscreenPromise;
}

async function closeDropBridgeV2OffscreenReceiver(reason = 'stop') {
    if (!chrome.offscreen) {
        return false;
    }

    const hasDocument = await hasDropBridgeV2OffscreenDocument();
    if (!hasDocument) {
        return false;
    }

    dropBridgeV2IntentionalOffscreenCloseUntil = Date.now() + DROPBRIDGE_V2_INTENTIONAL_CLOSE_GRACE_MS;
    await chrome.offscreen.closeDocument();
    void updateDropBridgeV2Diagnostics({
        receiverStatus: 'closed',
        receiverStatusAt: new Date().toISOString()
    }, {
        type: 'receiver_status',
        status: 'closed',
        reason
    });
    return true;
}

async function ensureDropBridgeV2FallbackAlarm(reason = 'startup') {
    const periodInMinutes = getDropBridgeV2FallbackAlarmPeriodMinutes();
    const existing = await chrome.alarms.get(DROPBRIDGE_V2_FALLBACK_ALARM_NAME);
    const shouldRecreate = !existing || Number(existing.periodInMinutes) !== periodInMinutes;

    if (shouldRecreate) {
        await chrome.alarms.create(DROPBRIDGE_V2_FALLBACK_ALARM_NAME, {
            when: Date.now() + Math.max(1000, Math.round(periodInMinutes * 60 * 1000)),
            periodInMinutes
        });
    }

    void updateDropBridgeV2Diagnostics({
        fallbackAlarmPeriodMinutes: periodInMinutes,
        fallbackAlarmEnsuredAt: new Date().toISOString()
    }, {
        type: 'fallback_alarm',
        reason,
        periodInMinutes
    });
    return periodInMinutes;
}

async function clearDropBridgeV2FallbackAlarm(reason = 'stop') {
    await chrome.alarms.clear(DROPBRIDGE_V2_FALLBACK_ALARM_NAME);
    void updateDropBridgeV2Diagnostics({
        fallbackAlarmClearedAt: new Date().toISOString()
    }, {
        type: 'fallback_alarm_cleared',
        reason
    });
}

async function buildDropBridgeV2ReceiverContext() {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        return {
            success: true,
            enabled: false,
            signedIn: false
        };
    }

    const accessToken = await getDropBridgeV2AccessToken();
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) {
        throw error;
    }

    const userId = session?.user?.id || null;
    if (!userId || !accessToken) {
        return {
            success: true,
            enabled: true,
            signedIn: false,
            userId,
            accessToken: null,
            deviceId: null,
            topic: null,
            supabaseUrl,
            supabaseKey,
            wakeEvent: DROPBRIDGE_V2_WAKE_EVENT
        };
    }

    const deviceId = await getOrCreateDropBridgeV2DeviceId();
    return {
        success: true,
        enabled: true,
        signedIn: true,
        userId,
        accessToken,
        deviceId,
        topic: buildDropBridgeV2WakeTopic(userId, deviceId),
        supabaseUrl,
        supabaseKey,
        wakeEvent: DROPBRIDGE_V2_WAKE_EVENT,
        debug: DROPBRIDGE_V2_DEBUG
    };
}

async function requestDropBridgeV2Poll(reason = 'manual') {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        return;
    }

    if (dropBridgeV2PollInFlight) {
        dropBridgeV2QueuedPollReason = reason;
        dropBridgeDebug('poll request: queued behind in-flight poll', { reason });
        return;
    }

    const isWakeDriven = reason !== 'alarm';
    const sinceLastPollStartMs = Date.now() - dropBridgeV2LastPollStartedAt;
    if (isWakeDriven && sinceLastPollStartMs < DROPBRIDGE_V2_WAKE_POLL_DEBOUNCE_MS) {
        dropBridgeV2QueuedPollReason = reason;
        if (!dropBridgeV2QueuedPollTimer) {
            const delayMs = DROPBRIDGE_V2_WAKE_POLL_DEBOUNCE_MS - sinceLastPollStartMs;
            dropBridgeV2QueuedPollTimer = setTimeout(() => {
                const nextReason = dropBridgeV2QueuedPollReason || `${reason}-delayed`;
                dropBridgeV2QueuedPollTimer = null;
                dropBridgeV2QueuedPollReason = null;
                requestDropBridgeV2Poll(nextReason).catch((error) => {
                    console.error('[DropBridge v2] Delayed poll failure:', parseErrorMessage(error));
                });
            }, delayMs);
            dropBridgeDebug('poll request: debounced wake poll', { reason, delayMs });
        }
        return;
    }

    await pollDropBridgeV2Once(reason);
}

async function registerDropBridgeV2Device(reason = 'startup', accessToken = null) {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) return false;
    const token = accessToken || await getDropBridgeV2AccessToken();
    console.log(`[DropBridge v2] Access token ${token ? 'present' : 'absent'} before register (${reason})`);
    dropBridgeDebug('register device: token check', {
        reason,
        hasToken: Boolean(token)
    });
    if (!token) return false;

    const deviceId = await getOrCreateDropBridgeV2DeviceId();
    const deviceName = getDropBridgeV2DeviceName();
    const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/register-device-v2`;
    dropBridgeDebug('register device: request', { reason, deviceId, deviceName, endpoint });
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            deviceId,
            deviceName,
            clientKind: 'canvascope_extension'
        })
    });

    const payload = await response.json().catch(() => ({}));
    const errorPayload = payload?.error || payload?.message || null;
    console.log(`[DropBridge v2] register-device-v2 status=${response.status} error=${errorPayload || 'none'}`);
    dropBridgeDebug('register device: response', {
        reason,
        deviceId,
        status: response.status,
        ok: response.ok,
        payload: sanitizeDropBridgePayload(payload)
    });

    if (!response.ok || payload?.error) {
        throw new Error(payload?.error || `register-device-v2 failed (${response.status})`);
    }

    console.log(`[DropBridge v2] Registered device (${reason}) as "${deviceName}"`);
    void updateDropBridgeV2Diagnostics({
        receiverDeviceId: deviceId,
        receiverRegisteredAt: new Date().toISOString()
    }, {
        type: 'device_registered',
        reason,
        deviceId
    });
    return true;
}

async function pollDropBridgeV2Once(reason = 'alarm') {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        dropBridgeDebug('poll: skipped', {
            reason,
            enabled: DROPBRIDGE_V2_ENABLED,
            hasSupabaseClient: Boolean(supabaseClient),
            inFlight: dropBridgeV2PollInFlight
        });
        return;
    }

    if (dropBridgeV2PollInFlight) {
        dropBridgeV2QueuedPollReason = reason;
        dropBridgeDebug('poll: already in flight, queued follow-up', { reason });
        return;
    }

    const pollStartedAtMs = Date.now();
    dropBridgeV2LastPollStartedAt = pollStartedAtMs;
    dropBridgeDebug('poll: begin', { reason });
    dropBridgeV2PollInFlight = true;
    void updateDropBridgeV2Diagnostics({
        lastPollStartedAt: new Date(pollStartedAtMs).toISOString(),
        lastPollReason: reason
    }, {
        type: 'poll_started',
        reason
    });

    try {
        const accessToken = await getDropBridgeV2AccessToken();
        if (!accessToken) {
            dropBridgeDebug('poll: no access token, exiting', { reason });
            void updateDropBridgeV2Diagnostics({
                lastPollFinishedAt: new Date().toISOString(),
                lastPollResult: 'no_access_token',
                lastPollUploadCount: 0
            }, {
                type: 'poll_finished',
                reason,
                result: 'no_access_token'
            });
            return;
        }

        const deviceId = await getOrCreateDropBridgeV2DeviceId();
        const payload = await callDropBridgeV2Function('list-pending-v2', {
            deviceId,
            limit: DROPBRIDGE_V2_POLL_LIMIT,
            clientKind: 'canvascope_extension'
        }, accessToken);

        const uploads = Array.isArray(payload?.uploads) ? payload.uploads : [];
        console.log(`[DropBridge v2] Poll (${reason}) returned ${uploads.length} upload(s)`);
        dropBridgeDebug('poll: uploads ready', {
            reason,
            deviceId,
            uploadCount: uploads.length,
            uploads
        });
        void updateDropBridgeV2Diagnostics({
            lastPollUploadCount: uploads.length,
            lastPollResult: 'ok'
        }, {
            type: 'poll_uploads_ready',
            reason,
            uploadCount: uploads.length
        });

        for (let index = 0; index < uploads.length; index += 1) {
            const upload = uploads[index];
            const uploadId = resolveDropBridgeUploadId(upload);
            dropBridgeDebug('poll: processing upload', {
                reason,
                deviceId,
                index,
                total: uploads.length,
                uploadId
            });
            void updateDropBridgeV2Diagnostics({
                lastClaimedAt: new Date().toISOString(),
                lastClaimedUploadId: uploadId
            }, {
                type: 'upload_claimed',
                reason,
                uploadId
            });
            await processDropBridgeV2Upload(upload, accessToken, deviceId);
        }
    } catch (error) {
        console.error(`[DropBridge v2] Poll failure (${reason}):`, parseErrorMessage(error));
        dropBridgeDebug('poll: failure', {
            reason,
            error: parseErrorMessage(error)
        });
        void updateDropBridgeV2Diagnostics({
            lastPollResult: 'error',
            lastPollError: parseErrorMessage(error)
        }, {
            type: 'poll_error',
            reason,
            error: parseErrorMessage(error)
        });
    } finally {
        dropBridgeV2PollInFlight = false;
        const finishedAtIso = new Date().toISOString();
        dropBridgeDebug('poll: end', {
            reason,
            durationMs: Date.now() - pollStartedAtMs
        });
        void updateDropBridgeV2Diagnostics({
            lastPollFinishedAt: finishedAtIso,
            lastPollDurationMs: Date.now() - pollStartedAtMs
        }, {
            type: 'poll_finished',
            reason,
            durationMs: Date.now() - pollStartedAtMs
        });

        if (dropBridgeV2QueuedPollReason && !dropBridgeV2QueuedPollTimer) {
            const nextReason = dropBridgeV2QueuedPollReason;
            dropBridgeV2QueuedPollReason = null;
            requestDropBridgeV2Poll(`${nextReason}-followup`).catch((error) => {
                console.error('[DropBridge v2] Follow-up poll failure:', parseErrorMessage(error));
            });
        }
    }
}

function stopDropBridgeV2Loop() {
    dropBridgeDebug('loop: stop requested', {
        activeUploads: dropBridgeV2ActiveUploads.size
    });
    clearDropBridgeV2QueuedPoll();
    clearDropBridgeV2FallbackAlarm('loop-stop').catch((error) => {
        console.warn('[DropBridge v2] Failed to clear fallback alarm:', parseErrorMessage(error));
    });
    closeDropBridgeV2OffscreenReceiver('loop-stop').catch((error) => {
        console.warn('[DropBridge v2] Failed to close offscreen receiver:', parseErrorMessage(error));
    });
    dropBridgeV2ActiveUploads.clear();
    dropBridgeDebug('loop: stopped');
}

async function startDropBridgeV2Loop(reason = 'startup') {
    if (!DROPBRIDGE_V2_ENABLED || !supabaseClient) {
        dropBridgeDebug('loop: start skipped', {
            reason,
            enabled: DROPBRIDGE_V2_ENABLED,
            hasSupabaseClient: Boolean(supabaseClient)
        });
        return;
    }
    dropBridgeDebug('loop: start begin', { reason });

    try {
        const accessToken = await getDropBridgeV2AccessToken();
        if (!accessToken) {
            dropBridgeDebug('loop: start no token, stopping receiver services', { reason });
            stopDropBridgeV2Loop();
            return;
        }

        const registered = await registerDropBridgeV2Device(reason, accessToken);
        if (!registered) {
            dropBridgeDebug('loop: start register returned false', { reason });
            return;
        }

        await ensureDropBridgeV2FallbackAlarm(reason);
        await ensureDropBridgeV2OffscreenReceiver(reason);

        await requestDropBridgeV2Poll(`${reason}-immediate`);
        dropBridgeDebug('loop: start finished', { reason });
    } catch (error) {
        console.error(`[DropBridge v2] Startup failure (${reason}):`, parseErrorMessage(error));
        dropBridgeDebug('loop: start failed', { reason, error: parseErrorMessage(error) });
    }
}

async function bootstrapDropBridgeV2FromWorkerStart(reason = 'worker-start') {
    dropBridgeDebug('bootstrap: begin', { reason });
    await hydrateDropBridgeV2SessionFromStorage();
    await startDropBridgeV2Loop(reason);
    dropBridgeDebug('bootstrap: end', { reason });
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
const PDF_HEADER_CHECK_BYTES = 1024;
const PDF_SEND_MAX_BYTES = 25 * 1024 * 1024; // 25MB
const PDF_CONTEXT_TIMEOUT_MS = 1800;

const PDF_CONFIDENCE_RANK = {
    none: 0,
    weak: 1,
    strong: 2,
    definitive: 3
};

// Dynamically detected LMS domains (stored in chrome.storage)
let customDomains = [];

async function getPdfViewerOverlayRegistrationMatches() {
    const matches = [...PDF_VIEWER_OVERLAY_WEBSITE_ORIGINS];
    pdfViewerDebug('Website overlay origins enabled', matches);

    const fileAccessAllowed = await getAllowedFileSchemeAccess();
    pdfViewerDebug('File scheme access allowed', fileAccessAllowed);
    if (fileAccessAllowed) {
        matches.push(PDF_VIEWER_OVERLAY_FILE_MATCH);
    }

    pdfViewerDebug('Computed overlay registration matches', matches);
    return matches;
}

async function unregisterPdfViewerOverlayContentScript() {
    try {
        await chrome.scripting.unregisterContentScripts({
            ids: [PDF_VIEWER_OVERLAY_CONTENT_SCRIPT_ID]
        });
        pdfViewerDebug('Unregistered overlay content script');
    } catch (error) {
        const message = parseErrorMessage(error);
        if (!/nonexistent|unknown|not found/i.test(message)) {
            console.warn('[Canvascope PDF Viewer] Failed to unregister overlay content script:', message);
        }
    }
}

async function injectPdfViewerOverlayIntoOpenTabs(reason = 'manual', matches = []) {
    const allowFile = matches.includes(PDF_VIEWER_OVERLAY_FILE_MATCH);
    const tabs = await chrome.tabs.query({});
    pdfViewerDebug('Attempting open-tab overlay injection pass', {
        reason,
        matches,
        tabCount: tabs.length
    });
    const injections = tabs
        .map(async (tab) => {
            try {
                if (!Number.isFinite(tab?.id) || !isTabUrlEligibleForPdfViewerOverlay(tab?.url)) {
                    pdfViewerDebug('Skipping tab during injection eligibility check', {
                        tabId: tab?.id || null,
                        url: tab?.url || null,
                        eligible: false
                    });
                    return;
                }

                const protocol = new URL(tab.url).protocol;
                if (protocol === 'file:' && !allowFile) {
                    pdfViewerDebug('Skipping file tab due to missing file access', {
                        tabId: tab.id,
                        url: tab.url
                    });
                    return;
                }

                pdfViewerDebug('Injecting overlay content script into tab', {
                    tabId: tab.id,
                    url: tab.url,
                    reason
                });
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['pdf-viewer-content.js']
                });
                pdfViewerDebug('Overlay injection succeeded', {
                    tabId: tab.id,
                    url: tab.url
                });
            } catch (error) {
                const message = parseErrorMessage(error);
                pdfViewerDebug('Overlay injection threw', {
                    tabId: tab?.id || null,
                    url: tab?.url || null,
                    error: message
                });
                if (!/cannot access|missing host permission|cannot be scripted|frame with id 0 was removed/i.test(message.toLowerCase())) {
                    console.warn('[Canvascope PDF Viewer] Failed to inject overlay into tab', {
                        reason,
                        tabId: tab.id,
                        error: message
                    });
                }
            }
        });

    await Promise.all(injections);
}

async function syncPdfViewerOverlayRegistration(reason = 'manual') {
    const settings = await getExtensionSettings();
    pdfViewerDebug('syncPdfViewerOverlayRegistration start', {
        reason,
        enableSendToLectra: settings.enableSendToLectra
    });
    if (!settings.enableSendToLectra) {
        await unregisterPdfViewerOverlayContentScript();
        pdfViewerDebug('syncPdfViewerOverlayRegistration end: feature disabled');
        return {
            success: true,
            enabled: false,
            matches: [],
            reason: 'feature_disabled'
        };
    }

    const matches = await getPdfViewerOverlayRegistrationMatches();
    if (matches.length === 0) {
        await unregisterPdfViewerOverlayContentScript();
        pdfViewerDebug('syncPdfViewerOverlayRegistration end: no registration matches');
        return {
            success: true,
            enabled: false,
            matches: [],
            reason: 'no_registration_matches'
        };
    }

    await unregisterPdfViewerOverlayContentScript();
    await chrome.scripting.registerContentScripts([{
        id: PDF_VIEWER_OVERLAY_CONTENT_SCRIPT_ID,
        js: ['pdf-viewer-content.js'],
        matches,
        excludeMatches: STATIC_LMS_CONTENT_SCRIPT_MATCHES,
        runAt: 'document_idle',
        persistAcrossSessions: true
    }]);
    pdfViewerDebug('Registered overlay content script', {
        matches,
        excludeMatches: STATIC_LMS_CONTENT_SCRIPT_MATCHES
    });
    await injectPdfViewerOverlayIntoOpenTabs(reason, matches);
    pdfViewerDebug('syncPdfViewerOverlayRegistration end: enabled', {
        matches,
        reason
    });

    return {
        success: true,
        enabled: true,
        matches,
        reason
    };
}

function supportsPdfViewerHostAccessRequests() {
    return typeof chrome.permissions?.addHostAccessRequest === 'function'
        && typeof chrome.permissions?.removeHostAccessRequest === 'function';
}

function resolvePdfViewerHostAccessUrl(rawUrl) {
    return parsePdfViewerSrcFromTabUrl(rawUrl) || rawUrl || '';
}

function buildPdfViewerHostAccessPattern(rawUrl) {
    try {
        const parsed = new URL(resolvePdfViewerHostAccessUrl(rawUrl));
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return `${parsed.origin}/*`;
    } catch {
        return null;
    }
}

async function hasPdfViewerOriginAccess(rawUrl) {
    const pattern = buildPdfViewerHostAccessPattern(rawUrl);
    if (!pattern) return false;
    const hasAccess = await permissionsContains({ origins: [pattern] });
    pdfViewerDebug('Origin access check', {
        url: rawUrl,
        pattern,
        hasAccess
    });
    return hasAccess;
}

function isLikelyPdfViewerCandidateUrl(rawUrl) {
    const targetUrl = resolvePdfViewerHostAccessUrl(rawUrl);
    return Boolean(parsePdfViewerSrcFromTabUrl(rawUrl) || isLikelyPdfHint(targetUrl));
}

async function clearPdfViewerHostAccessRequest(tabId) {
    if (!supportsPdfViewerHostAccessRequests() || !Number.isFinite(tabId)) return;
    try {
        await chrome.permissions.removeHostAccessRequest({ tabId });
        pdfViewerDebug('Cleared host access request', { tabId });
    } catch {
        // Ignore; the request may not exist anymore.
    }
}

async function syncPdfViewerHostAccessRequestForTab(tab) {
    const tabId = tab?.id;
    if (!supportsPdfViewerHostAccessRequests() || !Number.isFinite(tabId)) return;

    const settings = await getExtensionSettings();
    pdfViewerDebug('syncPdfViewerHostAccessRequestForTab start', {
        tabId,
        url: tab?.url || null,
        enableSendToLectra: settings.enableSendToLectra
    });
    if (!settings.enableSendToLectra) {
        await clearPdfViewerHostAccessRequest(tabId);
        return;
    }

    if (!isTabUrlEligibleForPdfViewerOverlay(tab?.url) || !isLikelyPdfViewerCandidateUrl(tab?.url)) {
        pdfViewerDebug('Tab not eligible for host access request', {
            tabId,
            url: tab?.url || null
        });
        await clearPdfViewerHostAccessRequest(tabId);
        return;
    }

    if (await hasPdfViewerOriginAccess(tab.url)) {
        pdfViewerDebug('Tab already has host access', {
            tabId,
            url: tab.url
        });
        await clearPdfViewerHostAccessRequest(tabId);
        return;
    }

    const pattern = buildPdfViewerHostAccessPattern(tab.url);
    if (!pattern) {
        pdfViewerDebug('No host access pattern could be built for tab', {
            tabId,
            url: tab?.url || null
        });
        await clearPdfViewerHostAccessRequest(tabId);
        return;
    }

    try {
        pdfViewerDebug('Adding host access request', {
            tabId,
            url: tab.url,
            pattern
        });
        await chrome.permissions.addHostAccessRequest({
            tabId,
            pattern
        });
        pdfViewerDebug('Host access request added', {
            tabId,
            pattern
        });
    } catch (error) {
        pdfViewerDebug('Host access request failed', {
            tabId,
            url: tab?.url || null,
            error: parseErrorMessage(error)
        });
        console.warn('[Canvascope PDF Viewer] Failed to add host access request:', parseErrorMessage(error));
    }
}

async function syncPdfViewerHostAccessRequestsForOpenTabs() {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => syncPdfViewerHostAccessRequestForTab(tab)));
}

async function runPdfViewerActiveTabDiagnostics() {
    const tab = await resolveTargetTabForPdfMode('active_tab', null);
    const settings = await getExtensionSettings();
    const websiteOrigins = await getGrantedPdfViewerOverlayWebsiteOrigins();
    const fileAccessAllowed = await getAllowedFileSchemeAccess();
    const registeredContentScripts = await chrome.scripting.getRegisteredContentScripts()
        .catch((error) => {
            pdfViewerDebug('getRegisteredContentScripts failed', parseErrorMessage(error));
            return [];
        });

    const diagnostics = {
        tab: tab ? {
            id: tab.id ?? null,
            url: tab.url || null,
            title: tab.title || null
        } : null,
        enableSendToLectra: settings.enableSendToLectra,
        websiteOrigins,
        fileAccessAllowed,
        registrationMatches: await getPdfViewerOverlayRegistrationMatches(),
        registeredContentScripts: registeredContentScripts.map((entry) => ({
            id: entry.id,
            matches: entry.matches || [],
            js: entry.js || [],
            runAt: entry.runAt || null
        })),
        tabEligible: isTabUrlEligibleForPdfViewerOverlay(tab?.url),
        likelyPdfViewerCandidate: isLikelyPdfViewerCandidateUrl(tab?.url),
        overlayContext: tab ? await resolvePdfViewerOverlayContextForTab(tab) : null,
        initialPing: null,
        directInjectionProbe: null,
        postInjectionPing: null
    };

    if (!tab?.id) {
        return diagnostics;
    }

    diagnostics.initialPing = await sendMessageToTab(tab.id, {
        action: 'canvascopePdfViewerDebugPing'
    });

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const payload = {
                    href: window.location.href,
                    title: document.title,
                    contentType: document.contentType || null
                };
                console.log('[Canvascope PDF Viewer][Probe] bare executeScript ran', payload);
                return payload;
            }
        });
        diagnostics.directInjectionProbe = {
            success: true,
            results: Array.isArray(results) ? results.map((entry) => ({
                frameId: entry.frameId,
                result: entry.result
            })) : []
        };
    } catch (error) {
        diagnostics.directInjectionProbe = {
            success: false,
            error: parseErrorMessage(error)
        };
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['pdf-viewer-content.js']
        });
        diagnostics.directOverlayInjection = {
            success: true
        };
    } catch (error) {
        diagnostics.directOverlayInjection = {
            success: false,
            error: parseErrorMessage(error)
        };
    }

    await sleep(120);
    diagnostics.postInjectionPing = await sendMessageToTab(tab.id, {
        action: 'canvascopePdfViewerDebugPing'
    });
    pdfViewerDebug('Active tab diagnostics snapshot', diagnostics);
    return diagnostics;
}

// Minimum time between scans (in milliseconds) - 5 minutes
const MIN_SCAN_INTERVAL = 5 * 60 * 1000;

// Safety limit for pagination to prevent infinite loops
const MAX_PAGES = 50;
const COURSE_CATALOG_STORAGE_KEY = 'courseCatalog';
const COURSE_SNAPSHOTS_STORAGE_KEY = 'courseSnapshots';
const COURSE_CATALOG_ITEM_TYPE = 'canvascope_course_catalog_v1';
const COURSE_SNAPSHOT_ITEM_TYPE = 'canvascope_course_snapshot_v1';
const COURSE_SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_TEXT_CHAR_LIMIT = 2000;
const SYLLABUS_TEXT_CHAR_LIMIT = 8000;
const SNAPSHOT_PAGE_BODY_CONCURRENCY = 4;
const EXTENSION_SYNC_BATCH_SIZE = 50;
const EXTENSION_SYNC_READ_PAGE_SIZE = 1000;

const LEGACY_EXTENSION_ITEM_TYPES = new Set([
    'announcement',
    'assignment',
    'course',
    'discussion',
    'document',
    'externaltool',
    'externalurl',
    'file',
    'link',
    'page',
    'pdf',
    'quiz',
    'slides',
    'video'
]);

// ============================================
// STATE
// ============================================

let isScanning = false;
let lastScanTime = 0;
const pdfSendInFlightKeys = new Set();

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
            [COURSE_CATALOG_STORAGE_KEY]: [],
            [COURSE_SNAPSHOTS_STORAGE_KEY]: [],
            settings: {
                ...DEFAULT_EXTENSION_SETTINGS,
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

    syncPdfViewerOverlayRegistration(`runtime-installed-${details.reason}`).catch((error) => {
        console.warn('[Canvascope PDF Viewer] Failed to sync overlay registration on install:', parseErrorMessage(error));
    });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.settings) return;
    syncPdfViewerOverlayRegistration('settings-changed').catch((error) => {
        console.warn('[Canvascope PDF Viewer] Failed to sync overlay registration after settings change:', parseErrorMessage(error));
    });
});

chrome.permissions.onAdded.addListener(() => {
    syncPdfViewerOverlayRegistration('permissions-added').catch((error) => {
        console.warn('[Canvascope PDF Viewer] Failed to sync overlay registration after permission grant:', parseErrorMessage(error));
    });
});

chrome.permissions.onRemoved.addListener(() => {
    syncPdfViewerOverlayRegistration('permissions-removed').catch((error) => {
        console.warn('[Canvascope PDF Viewer] Failed to sync overlay registration after permission removal:', parseErrorMessage(error));
    });
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
            void ensureDropBridgeV2LoopWarm('tab-updated-lms').catch((error) => {
                console.warn('[DropBridge v2] LMS tab warmup failed:', parseErrorMessage(error));
            });
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
            void ensureDropBridgeV2LoopWarm('tab-activated-lms').catch((error) => {
                console.warn('[DropBridge v2] LMS tab activation warmup failed:', parseErrorMessage(error));
            });
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
    if (alarm.name === DROPBRIDGE_V2_FALLBACK_ALARM_NAME) {
        requestDropBridgeV2Poll('alarm').catch((error) => {
            console.error('[DropBridge v2] Alarm-triggered poll failure:', parseErrorMessage(error));
        });
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

        const existingData = await chrome.storage.local.get([
            'indexedContent',
            'starredCourseIds',
            'settings',
            COURSE_CATALOG_STORAGE_KEY,
            COURSE_SNAPSHOTS_STORAGE_KEY
        ]);
        const existingContent = existingData.indexedContent || [];
        const existingSnapshots = Array.isArray(existingData[COURSE_SNAPSHOTS_STORAGE_KEY])
            ? existingData[COURSE_SNAPSHOTS_STORAGE_KEY]
            : [];
        const courseSnapshotMap = new Map();
        const targetCourseKeys = new Set(
            courses
                .map((course) => getStructuredCourseKey(course, sourceMeta))
                .filter(Boolean)
        );

        const ensureCourseSnapshot = (course) => {
            const courseKey = getStructuredCourseKey(course, sourceMeta);
            if (!courseKey) return null;
            if (!courseSnapshotMap.has(courseKey)) {
                courseSnapshotMap.set(courseKey, buildCourseSnapshotBase(course, sourceMeta, scanTimestamp));
            }
            return courseSnapshotMap.get(courseKey);
        };

        const persistCourseArtifacts = async () => {
            const nextArtifacts = prepareCourseArtifactsForStorage(courseSnapshotMap);
            const freshKeys = new Set(
                nextArtifacts.courseSnapshots
                    .map((snapshot) => snapshot?.courseKey)
                    .filter(Boolean)
            );

            const preservedSnapshots = existingSnapshots.filter((snapshot) => {
                const courseKey = snapshot?.courseKey || null;
                return courseKey && !targetCourseKeys.has(courseKey) && !freshKeys.has(courseKey);
            });

            const mergedCourseSnapshots = [...preservedSnapshots, ...nextArtifacts.courseSnapshots]
                .sort((lhs, rhs) => (lhs?.course?.courseName || '').localeCompare(rhs?.course?.courseName || ''));
            const mergedCourseCatalog = mergedCourseSnapshots
                .map(buildCourseCatalogEntryFromSnapshot)
                .sort((lhs, rhs) => (lhs.courseName || '').localeCompare(rhs.courseName || ''));

            try {
                await chrome.storage.local.set({
                    [COURSE_CATALOG_STORAGE_KEY]: mergedCourseCatalog,
                    [COURSE_SNAPSHOTS_STORAGE_KEY]: mergedCourseSnapshots
                });
            } catch (error) {
                console.warn('[Canvascope] Could not persist course snapshot artifacts:', error?.message || error);
            }

            return {
                courseCatalog: mergedCourseCatalog,
                courseSnapshots: mergedCourseSnapshots
            };
        };

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
                const snapshot = ensureCourseSnapshot(course);
                let courseContent = [];
                if (platform === 'brightspace') {
                    courseContent = await fetchBrightspaceCourseContent(baseUrl, course);
                    if (snapshot) {
                        for (const item of courseContent) {
                            recordSnapshotItem(snapshot, buildSnapshotItemBase(course, sourceMeta, scanTimestamp, item));
                        }
                    }
                } else {
                    if (snapshot) {
                        await hydrateCanvasCourseSnapshotBase(baseUrl, course, snapshot);
                    }
                    courseContent = await fetchFastEndpoints(baseUrl, course, sourceMeta, scanTimestamp, snapshot);
                }
                fastCount++;
                const progress = 10 + Math.round((fastCount / courses.length) * 40); // 10% to 50%
                broadcastMessage({
                    type: 'scanProgress',
                    progress,
                    status: `Fast indexing ${fastCount}/${courses.length} courses`
                });

                if (snapshot) {
                    await persistCourseArtifacts();
                }
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
                    const snapshot = ensureCourseSnapshot(course);
                    const courseContent = await fetchHeavyEndpoints(baseUrl, course, sourceMeta, scanTimestamp, snapshot);
                    deepCount++;
                    const progress = 50 + Math.round((deepCount / courses.length) * 40); // 50% to 90%
                    broadcastMessage({
                        type: 'scanProgress',
                        progress,
                        status: `Deep indexing ${deepCount}/${courses.length} courses`
                    });

                    if (snapshot) {
                        await persistCourseArtifacts();
                    }
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
        const finalArtifacts = await persistCourseArtifacts();

        const starredCourseIds = [...new Set(
            finalDeduped
                .filter(item => item.type === 'course' && item.courseId)
                .map(item => item.courseId)
        )];

        try {
            await chrome.storage.local.set({
                indexedContent: finalDeduped,
                [COURSE_CATALOG_STORAGE_KEY]: finalArtifacts.courseCatalog,
                [COURSE_SNAPSHOTS_STORAGE_KEY]: finalArtifacts.courseSnapshots,
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
        } catch (storageError) {
            console.warn('[Canvascope] Final snapshot persistence exceeded local storage budget, falling back to lightweight index only:', storageError?.message || storageError);
            await chrome.storage.local.set({
                indexedContent: finalDeduped,
                [COURSE_CATALOG_STORAGE_KEY]: finalArtifacts.courseCatalog,
                [COURSE_SNAPSHOTS_STORAGE_KEY]: [],
                starredCourseIds: starredCourseIds.length > 0 ? starredCourseIds : (existingData.starredCourseIds || []),
                settings: {
                    ...(existingData.settings || {}),
                    lastScanTime: Date.now(),
                    version: chrome.runtime.getManifest().version,
                    scanMetrics: {
                        lastScanDurationMs: Math.round(fullPassDurationMs),
                        fastPassDurationMs: Math.round(fastPassDurationMs),
                        courseCount: courses.length,
                        courseSnapshotFallback: true
                    }
                }
            });
        }

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
                    code: course.course_code || '',
                    defaultView: course.default_view || null,
                    workflowState: course.workflow_state || null,
                    enrollmentState: course.enrollment_state || null,
                    startAt: course.start_at || null,
                    endAt: course.end_at || null,
                    termName: course.term?.name || null,
                    imageUrl: course.image_download_url || course.image || null
                });
            }
        }
    } catch (e) {
        console.warn('[Canvascope] Could not fetch courses:', e.message);
    }

    return courses;
}

async function hydrateCanvasCourseSnapshotBase(baseUrl, course, snapshot) {
    if (!snapshot || !course?.id) return;

    try {
        const resp = await fetchWithRetry(
            `${baseUrl}/api/v1/courses/${course.id}?include[]=term&include[]=teachers&include[]=syllabus_body`,
            { credentials: 'include' }
        );

        if (resp.ok) {
            const detail = await resp.json();
            const { text: syllabusText, truncated: syllabusTruncated } = normalizeRichText(detail?.syllabus_body, SYLLABUS_TEXT_CHAR_LIMIT);

            snapshot.course = {
                ...snapshot.course,
                courseCode: detail?.course_code || snapshot.course.courseCode || '',
                termName: detail?.term?.name || snapshot.course.termName || null,
                startAt: detail?.start_at || snapshot.course.startAt || null,
                endAt: detail?.end_at || snapshot.course.endAt || null,
                defaultView: detail?.default_view || snapshot.course.defaultView || null,
                workflowState: detail?.workflow_state || snapshot.course.workflowState || null,
                enrollmentState: detail?.enrollment_state || snapshot.course.enrollmentState || null,
                imageUrl: detail?.image_download_url || detail?.image || snapshot.course.imageUrl || null,
                syllabusText: syllabusText || snapshot.course.syllabusText || null
            };

            snapshot.teacherSummaries = buildTeacherSummaries(detail?.teachers);
            snapshot.scanStats.syllabusTruncated = snapshot.scanStats.syllabusTruncated || syllabusTruncated;
        }
    } catch (e) {
        snapshot.scanStats.detailFetchFailures += 1;
        console.warn(`[Canvascope] Could not fetch Canvas course details for ${course.id}:`, e.message);
    }

    try {
        const groups = await fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/assignment_groups?per_page=100`);
        mergeCourseAssignmentGroups(snapshot, groups);
    } catch (e) {
        snapshot.scanStats.detailFetchFailures += 1;
        console.warn(`[Canvascope] Could not fetch assignment groups for ${course.id}:`, e.message);
    }
}

async function fetchCanvasPageDetail(baseUrl, courseId, pageSlugOrId) {
    const encoded = encodeURIComponent(pageSlugOrId);
    const resp = await fetchWithRetry(`${baseUrl}/api/v1/courses/${courseId}/pages/${encoded}`, {
        credentials: 'include'
    });

    if (!resp.ok) {
        throw new Error(`Page detail failed (${resp.status})`);
    }

    return resp.json();
}

function normalizeIndexedTextValue(value) {
    return String(value || '')
        .replace(/[_/]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function splitIndexedPathSegments(rawPath) {
    return String(rawPath || '')
        .split(/\s*>\s*|\//)
        .map(segment => segment.trim())
        .filter(Boolean);
}

function extractExplicitWeekHints(values) {
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

function buildIndexedPathMetadata(rawPath, fallbackTitle = '') {
    const segments = splitIndexedPathSegments(rawPath);
    if (segments.length === 0 && fallbackTitle) {
        segments.push(String(fallbackTitle).trim());
    }

    const folderPath = segments.join(' > ');
    return {
        folderPath,
        pathSegments: segments,
        pathDepth: segments.length,
        weekHints: extractExplicitWeekHints([folderPath, fallbackTitle])
    };
}

function buildCanvasFolderHtmlUrl(baseUrl, courseId, folder) {
    const existingUrl = String(folder?.html_url || '').trim();
    if (existingUrl) {
        try {
            const parsed = new URL(existingUrl);
            parsed.hash = '';
            return parsed.toString();
        } catch {
            return existingUrl;
        }
    }

    // Try path-based routing first since bare IDs often fail on Canvas
    if (folder?.full_name) {
        const path = String(folder.full_name).replace(/^course files\/?/i, '').trim();
        if (path) {
            const encodedPath = path.split('/').map(encodeURIComponent).join('/');
            return `${baseUrl}/courses/${courseId}/files/folder/${encodedPath}`;
        }
    }

    if (folder?.id !== undefined && folder?.id !== null && folder.id !== '') {
        return `${baseUrl}/courses/${courseId}/files/folder/${folder.id}`;
    }

    return `${baseUrl}/courses/${courseId}/files`;
}

function buildCanvasSyllabusUrl(baseUrl, courseId) {
    return `${baseUrl}/courses/${courseId}/assignments/syllabus`;
}

function buildCanvasSyllabusItem(baseUrl, course, sourceMeta, scanTimestamp, snapshot = null) {
    const syllabusExcerpt = String(snapshot?.course?.syllabusText || '').trim();
    return {
        title: course?.name ? `${course.name} Syllabus` : 'Syllabus',
        url: buildCanvasSyllabusUrl(baseUrl, course.id),
        type: 'syllabus',
        moduleName: 'Course Navigation',
        courseName: course.name,
        courseId: course.id,
        syllabusExcerpt: syllabusExcerpt ? syllabusExcerpt.slice(0, 400) : '',
        ...sourceMeta,
        scannedAt: scanTimestamp
    };
}

async function fetchFastEndpoints(baseUrl, course, sourceMeta, scanTimestamp, snapshot = null) {
    const content = [];
    const submissionByAssignmentId = new Map();
    const assignmentProcessingPromise = fetchAllPages(
        `${baseUrl}/api/v1/courses/${course.id}/assignments?per_page=100&include[]=submission`
    ).then((items) => {
        for (const item of items) {
            const submissionFields = buildAssignmentSubmissionFields({
                assignmentId: item.id,
                submission: item.submission,
                hasSubmittedSubmissions: item.has_submitted_submissions ?? null
            });

            if (submissionFields.assignmentId) {
                submissionByAssignmentId.set(
                    submissionFields.assignmentId,
                    copyAssignmentSubmissionFields(submissionFields)
                );
            }

            const lightweight = {
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
                lockAt: item.lock_at || null,
                ...copyAssignmentSubmissionFields(submissionFields)
            };

            content.push(lightweight);

            if (snapshot) {
                const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, {
                    ...lightweight,
                    assignmentGroupId: item.assignment_group_id ?? null,
                    assignmentGroupName: getAssignmentGroupName(snapshot, item.assignment_group_id),
                    pointsPossible: item.points_possible ?? null,
                    submissionTypes: Array.isArray(item.submission_types) ? item.submission_types.slice() : [],
                    allowedExtensions: Array.isArray(item.allowed_extensions) ? item.allowed_extensions.slice() : [],
                    published: item.published ?? null,
                    updatedAt: item.updated_at || null
                });
                addRichTextField(richItem, 'instructions', item.description, snapshot.scanStats);
                recordSnapshotItem(snapshot, richItem);
            }
        }
    });

    const promises = [
        assignmentProcessingPromise,
        Promise.resolve().then(() => {
            const lightweight = buildCanvasSyllabusItem(baseUrl, course, sourceMeta, scanTimestamp, snapshot);
            content.push(lightweight);

            if (snapshot) {
                const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, lightweight);
                addRichTextField(richItem, 'body', snapshot?.course?.syllabusText || '', snapshot.scanStats);
                recordSnapshotItem(snapshot, richItem);
            }
        }),
        // Fetch pages
        fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/pages?per_page=100`).then(items => {
            for (const item of items) {
                const lightweight = {
                    title: item.title || '',
                    url: item.html_url || '',
                    type: 'page',
                    moduleName: 'Pages',
                    courseName: course.name,
                    courseId: course.id,
                    ...sourceMeta,
                    scannedAt: scanTimestamp
                };

                content.push(lightweight);

                if (snapshot) {
                    const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, {
                        ...lightweight,
                        published: item.published ?? null,
                        updatedAt: item.updated_at || null
                    });
                    recordSnapshotItem(snapshot, richItem);
                }
            }
        }),
        // Fetch quizzes
        fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/quizzes?per_page=100`).then(async items => {
            await assignmentProcessingPromise;
            for (const item of items) {
                const submissionFields = resolveAssignmentSubmissionFields(submissionByAssignmentId, item.assignment_id);
                const lightweight = {
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
                    lockAt: item.lock_at || null,
                    ...submissionFields
                };

                content.push(lightweight);

                if (snapshot) {
                    const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, {
                        ...lightweight,
                        assignmentGroupId: item.assignment_group_id ?? null,
                        assignmentGroupName: getAssignmentGroupName(snapshot, item.assignment_group_id),
                        pointsPossible: item.points_possible ?? null,
                        published: item.published ?? null,
                        updatedAt: item.updated_at || null
                    });
                    addRichTextField(richItem, 'instructions', item.description, snapshot.scanStats);
                    recordSnapshotItem(snapshot, richItem);
                }
            }
        }),
        // Fetch discussions
        fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/discussion_topics?per_page=100`).then(async items => {
            await assignmentProcessingPromise;
            for (const item of items) {
                const asgn = item.assignment || null;
                const submissionFields = resolveAssignmentSubmissionFields(submissionByAssignmentId, asgn?.id);
                const lightweight = {
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
                    lockAt: asgn?.lock_at || null,
                    ...submissionFields
                };

                content.push(lightweight);

                if (snapshot) {
                    const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, {
                        ...lightweight,
                        published: item.published ?? null,
                        updatedAt: item.updated_at || null
                    });
                    addRichTextField(richItem, 'body', item.message, snapshot.scanStats);
                    recordSnapshotItem(snapshot, richItem);
                }
            }
        })
    ];

    await Promise.allSettled(promises);
    return content;
}

async function fetchHeavyEndpoints(baseUrl, course, sourceMeta, scanTimestamp, snapshot = null) {
    const content = [];

    // Modules
    const fetchModules = fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/modules?per_page=50&include[]=items&include[]=content_details`).then(modules => {
        if (snapshot) {
            mergeCourseModules(snapshot, modules);
        }
        for (const mod of modules) {
            if (mod.items) {
                for (const item of mod.items) {
                    if (item.html_url) {
                        const lightweight = {
                            title: item.title || '',
                            url: item.html_url,
                            type: item.type?.toLowerCase() || 'link',
                            moduleName: mod.name || '',
                            courseName: course.name,
                            courseId: course.id,
                            ...sourceMeta,
                            scannedAt: scanTimestamp
                        };
                        content.push(lightweight);

                        if (snapshot) {
                            const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, {
                                ...lightweight,
                                published: item.published ?? mod.published ?? null,
                                dueAt: item.content_details?.due_at || lightweight.dueAt || null,
                                unlockAt: item.content_details?.unlock_at || mod.unlock_at || lightweight.unlockAt || null,
                                lockAt: item.content_details?.lock_at || lightweight.lockAt || null,
                                pointsPossible: item.content_details?.points_possible ?? null
                            });
                            recordSnapshotItem(snapshot, richItem);
                        }
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
            const lightweight = {
                title: title,
                url: mediaUrl,
                type: 'video',
                moduleName: 'Media Gallery',
                courseName: course.name,
                courseId: course.id,
                ...sourceMeta,
                scannedAt: scanTimestamp
            };
            content.push(lightweight);

            if (snapshot) {
                const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, lightweight);
                recordSnapshotItem(snapshot, richItem);
            }
        }
    });

    // Folders -> Files (Sequential dependency)
    const fetchFiles = (async () => {
        const folderMap = new Map();
        try {
            const folders = await fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/folders?per_page=100`);
            for (const f of folders) {
                const isRootFolder = /^course files?$/i.test(String(f.name || '').trim());
                const fullName = String(f.full_name || '')
                    .replace(/^course files\/?/i, '')
                    .trim();
                const pathMeta = buildIndexedPathMetadata(fullName, isRootFolder ? '' : (f.name || ''));
                const folderUrl = buildCanvasFolderHtmlUrl(baseUrl, course.id, f);
                const folderRecord = {
                    id: f.id,
                    name: isRootFolder ? 'Files' : (f.name || pathMeta.pathSegments[pathMeta.pathSegments.length - 1] || ''),
                    fullName: pathMeta.folderPath,
                    url: folderUrl,
                    pathSegments: pathMeta.pathSegments,
                    pathDepth: pathMeta.pathDepth,
                    weekHints: pathMeta.weekHints,
                    createdAt: f.created_at || null,
                    updatedAt: f.updated_at || f.modified_at || null
                };
                folderMap.set(f.id, folderRecord);

                if (!pathMeta.folderPath) continue;

                const lightweight = {
                    title: folderRecord.name || 'Folder',
                    url: folderUrl,
                    type: 'folder',
                    moduleName: pathMeta.pathSegments[0] || 'Files',
                    folderPath: pathMeta.folderPath,
                    pathSegments: pathMeta.pathSegments.slice(),
                    pathDepth: pathMeta.pathDepth,
                    weekHints: pathMeta.weekHints.slice(),
                    containerUrl: folderUrl,
                    courseName: course.name,
                    courseId: course.id,
                    createdAt: folderRecord.createdAt,
                    updatedAt: folderRecord.updatedAt,
                    ...sourceMeta,
                    scannedAt: scanTimestamp
                };
                content.push(lightweight);

                if (snapshot) {
                    const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, {
                        ...lightweight,
                        lockedForUser: f.locked_for_user ?? null,
                        hiddenForUser: f.hidden_for_user ?? null
                    });
                    recordSnapshotItem(snapshot, richItem);
                }
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

                const lightweight = {
                    title: item.display_name || '',
                    url: item.url || `${baseUrl}/courses/${course.id}/files/${item.id}`,
                    type,
                    moduleName: folderName,
                    folderPath,
                    pathSegments: Array.isArray(folder?.pathSegments) ? folder.pathSegments.slice() : [],
                    pathDepth: folder?.pathDepth || 0,
                    weekHints: Array.isArray(folder?.weekHints) ? folder.weekHints.slice() : extractExplicitWeekHints([item.display_name || '', folderPath]),
                    containerUrl: folder?.url || null,
                    courseName: course.name,
                    courseId: course.id,
                    createdAt: item.created_at || null,
                    updatedAt: item.updated_at || item.modified_at || null,
                    ...sourceMeta,
                    scannedAt: scanTimestamp
                };
                content.push(lightweight);

                if (snapshot) {
                    const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, {
                        ...lightweight,
                        contentType: item['content-type'] || item.content_type || null,
                        sizeBytes: item.size ?? null,
                        updatedAt: item.updated_at || item.modified_at || null,
                        lockedForUser: item.locked_for_user ?? null,
                        hiddenForUser: item.hidden_for_user ?? null,
                        published: item.published ?? null
                    });
                    recordSnapshotItem(snapshot, richItem);
                }
            }
        } catch (e) { }
    })();

    const fetchPageBodies = snapshot
        ? fetchAllPages(`${baseUrl}/api/v1/courses/${course.id}/pages?per_page=100`).then(async (pages) => {
            const tasks = pages.map((page) => async () => {
                const slugOrId = page?.url || page?.page_id || page?.title;
                if (!slugOrId) return;

                try {
                    const detail = await fetchCanvasPageDetail(baseUrl, course.id, slugOrId);
                    const richItem = buildSnapshotItemBase(course, sourceMeta, scanTimestamp, {
                        title: detail?.title || page?.title || '',
                        url: detail?.html_url || page?.html_url || '',
                        type: 'page',
                        moduleName: 'Pages',
                        published: detail?.published ?? page?.published ?? null,
                        updatedAt: detail?.updated_at || page?.updated_at || null
                    });
                    addRichTextField(richItem, 'body', detail?.body, snapshot.scanStats);
                    recordSnapshotItem(snapshot, richItem);
                } catch (e) {
                    snapshot.scanStats.pageBodyFetchFailures += 1;
                }
            });

            await processPool(tasks, SNAPSHOT_PAGE_BODY_CONCURRENCY);
        })
        : Promise.resolve();

    await Promise.allSettled([fetchModules, fetchMedia, fetchFiles, fetchPageBodies]);
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

function normalizeWhitespace(value) {
    return String(value || '')
        .replace(/\r/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function decodeHtmlEntities(value) {
    const named = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        nbsp: ' ',
        quot: '"'
    };

    return String(value || '')
        .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match)
        .replace(/&#(\d+);/g, (_, code) => {
            const parsed = Number.parseInt(code, 10);
            return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : '';
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
            const parsed = Number.parseInt(code, 16);
            return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : '';
        });
}

function stripHtmlToText(value) {
    const withoutMarkup = String(value || '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<\/h[1-6]>/gi, '\n')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');

    return normalizeWhitespace(decodeHtmlEntities(withoutMarkup));
}

function normalizeRichText(value, maxChars = SNAPSHOT_TEXT_CHAR_LIMIT) {
    const stripped = stripHtmlToText(value);
    if (!stripped) {
        return { text: null, truncated: false };
    }

    if (stripped.length <= maxChars) {
        return { text: stripped, truncated: false };
    }

    return {
        text: `${stripped.slice(0, maxChars).trimEnd()}…`,
        truncated: true
    };
}

function addRichTextField(target, key, value, scanStats, maxChars = SNAPSHOT_TEXT_CHAR_LIMIT) {
    const { text, truncated } = normalizeRichText(value, maxChars);
    if (text) {
        target[key] = text;
    }
    if (truncated && scanStats) {
        scanStats.truncatedTextFieldCount = (scanStats.truncatedTextFieldCount || 0) + 1;
    }
}

function getStructuredCourseKey(course, sourceMeta) {
    if (!course?.id) return null;
    const platform = String(sourceMeta?.platform || 'canvas').toLowerCase();
    const platformDomain = String(sourceMeta?.platformDomain || '').toLowerCase();
    return `${platform}:${platformDomain}:${course.id}`;
}

function buildTeacherSummaries(teachers) {
    if (!Array.isArray(teachers)) return [];

    return teachers
        .map((teacher) => ({
            id: teacher?.id ?? null,
            name: teacher?.display_name || teacher?.short_name || teacher?.name || null
        }))
        .filter((teacher) => teacher.name)
        .sort((lhs, rhs) => lhs.name.localeCompare(rhs.name));
}

function buildCourseSnapshotBase(course, sourceMeta, scanTimestamp) {
    return {
        schemaVersion: COURSE_SNAPSHOT_SCHEMA_VERSION,
        sourceApp: 'canvascope_extension',
        sourceKind: 'course_snapshot',
        platform: sourceMeta?.platform || 'canvas',
        platformDomain: sourceMeta?.platformDomain || '',
        scannedAt: scanTimestamp,
        courseKey: getStructuredCourseKey(course, sourceMeta),
        course: {
            courseId: course?.id ?? null,
            courseName: course?.name || '',
            courseCode: course?.code || '',
            termName: course?.termName || null,
            startAt: course?.startAt || null,
            endAt: course?.endAt || null,
            defaultView: course?.defaultView || null,
            workflowState: course?.workflowState || null,
            enrollmentState: course?.enrollmentState || null,
            imageUrl: course?.imageUrl || null,
            syllabusText: course?.syllabusText || null
        },
        teacherSummaries: Array.isArray(course?.teacherSummaries) ? course.teacherSummaries.slice() : [],
        assignmentGroups: [],
        modules: [],
        indexedContent: [],
        scanStats: {
            itemCount: 0,
            typeCounts: {},
            truncatedTextFieldCount: 0,
            syllabusTruncated: false,
            pageBodyFetchFailures: 0,
            detailFetchFailures: 0
        }
    };
}

function buildCourseCatalogEntryFromSnapshot(snapshot) {
    return {
        schemaVersion: snapshot?.schemaVersion || COURSE_SNAPSHOT_SCHEMA_VERSION,
        sourceApp: 'canvascope_extension',
        courseId: snapshot?.course?.courseId ?? null,
        courseName: snapshot?.course?.courseName || '',
        courseCode: snapshot?.course?.courseCode || '',
        termName: snapshot?.course?.termName || null,
        startAt: snapshot?.course?.startAt || null,
        endAt: snapshot?.course?.endAt || null,
        defaultView: snapshot?.course?.defaultView || null,
        workflowState: snapshot?.course?.workflowState || null,
        enrollmentState: snapshot?.course?.enrollmentState || null,
        imageUrl: snapshot?.course?.imageUrl || null,
        teacherSummaries: Array.isArray(snapshot?.teacherSummaries) ? snapshot.teacherSummaries.slice() : [],
        platform: snapshot?.platform || 'canvas',
        platformDomain: snapshot?.platformDomain || '',
        scannedAt: snapshot?.scannedAt || null
    };
}

function copyModuleRequirement(requirement) {
    if (!requirement || typeof requirement !== 'object') return null;
    return {
        type: requirement.type || null,
        completed: requirement.completed ?? null,
        minScore: requirement.min_score ?? null,
        minPercentage: requirement.min_percentage ?? null
    };
}

function copyModuleContentDetails(details) {
    if (!details || typeof details !== 'object') return null;
    return {
        dueAt: details.due_at || null,
        unlockAt: details.unlock_at || null,
        lockAt: details.lock_at || null,
        pointsPossible: details.points_possible ?? null
    };
}

function normalizeCanvasIdentifier(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function cloneSubmissionSummary(summary) {
    if (!summary || typeof summary !== 'object') return null;
    return {
        workflowState: summary.workflowState ?? null,
        submittedAt: summary.submittedAt ?? null,
        attempt: summary.attempt ?? null,
        late: summary.late ?? null,
        missing: summary.missing ?? null,
        excused: summary.excused ?? null,
        grade: summary.grade ?? null,
        score: summary.score ?? null,
        submissionType: summary.submissionType ?? null,
        hasSubmittedSubmissions: summary.hasSubmittedSubmissions ?? null,
        gradeMatchesCurrentSubmission: summary.gradeMatchesCurrentSubmission ?? null
    };
}

function hasMeaningfulSubmissionSummary(summary) {
    if (!summary || typeof summary !== 'object') return false;
    return Object.values(summary).some((value) => value !== undefined && value !== null && value !== '');
}

function buildSubmissionSummary(submission, hasSubmittedSubmissions = null) {
    const summary = cloneSubmissionSummary({
        workflowState: submission?.workflow_state || null,
        submittedAt: submission?.submitted_at || null,
        attempt: submission?.attempt ?? null,
        late: submission?.late ?? null,
        missing: submission?.missing ?? null,
        excused: submission?.excused ?? null,
        grade: submission?.grade ?? null,
        score: submission?.score ?? null,
        submissionType: submission?.submission_type || null,
        hasSubmittedSubmissions: hasSubmittedSubmissions ?? null,
        gradeMatchesCurrentSubmission: submission?.grade_matches_current_submission ?? null
    });

    return hasMeaningfulSubmissionSummary(summary) ? summary : null;
}

function hasConcreteSubmissionEvidence(summary) {
    if (!summary || typeof summary !== 'object') return false;
    if (summary.missing === true) return false;
    if (summary.excused === true) return true;

    const hasAttempt = Number(summary.attempt ?? 0) > 0;
    const hasGrade = summary.score !== null && summary.score !== undefined
        || (typeof summary.grade === 'string' && summary.grade.trim() !== '');
    const hasSubmittedAt = typeof summary.submittedAt === 'string' && summary.submittedAt.trim() !== '';
    const hasSubmissionType = typeof summary.submissionType === 'string' && summary.submissionType.trim() !== '';
    const workflowState = String(summary.workflowState || '').trim().toLowerCase();

    if (hasSubmittedAt || hasAttempt || hasGrade || hasSubmissionType) return true;
    if (summary.late === true) return true;

    return ['submitted', 'graded', 'complete'].includes(workflowState);
}

function isSubmittedFromSummary(summary) {
    return hasConcreteSubmissionEvidence(summary);
}

function normalizeSubmissionStatus(summary) {
    if (!summary) return 'not_submitted';
    if (summary.excused === true) return 'excused';
    if (summary.missing === true) return 'missing';
    if (hasConcreteSubmissionEvidence(summary)) {
        return summary.late === true ? 'late' : 'submitted';
    }
    const workflowState = String(summary.workflowState || '').trim().toLowerCase();
    if (['unsubmitted', 'untaken', 'new', 'pending_review'].includes(workflowState)) {
        return 'not_submitted';
    }
    return summary.workflowState ? 'unknown' : 'not_submitted';
}

function normalizeStoredSubmissionFields(item) {
    if (!item || typeof item !== 'object') return item;
    const summary = cloneSubmissionSummary(item.submission);
    if (!summary && item.submitted === undefined && item.submissionStatus === undefined) {
        return item;
    }

    return {
        ...item,
        submitted: isSubmittedFromSummary(summary),
        submissionStatus: normalizeSubmissionStatus(summary),
        submission: summary
    };
}

function normalizeStoredCourseSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    return {
        ...snapshot,
        indexedContent: Array.isArray(snapshot.indexedContent)
            ? snapshot.indexedContent.map((item) => normalizeStoredSubmissionFields(item))
            : []
    };
}

function buildAssignmentSubmissionFields({ assignmentId = null, submission = null, hasSubmittedSubmissions = null } = {}) {
    const normalizedAssignmentId = normalizeCanvasIdentifier(assignmentId);
    if (!normalizedAssignmentId) {
        return {
            assignmentId: null,
            submitted: null,
            submissionStatus: null,
            submission: null
        };
    }

    const submissionSummary = buildSubmissionSummary(submission, hasSubmittedSubmissions);
    return {
        assignmentId: normalizedAssignmentId,
        submitted: isSubmittedFromSummary(submissionSummary),
        submissionStatus: normalizeSubmissionStatus(submissionSummary),
        submission: submissionSummary
    };
}

function copyAssignmentSubmissionFields(fields) {
    return {
        assignmentId: fields?.assignmentId ?? null,
        submitted: fields?.submitted ?? null,
        submissionStatus: fields?.submissionStatus ?? null,
        submission: cloneSubmissionSummary(fields?.submission)
    };
}

function resolveAssignmentSubmissionFields(submissionByAssignmentId, assignmentId) {
    const normalizedAssignmentId = normalizeCanvasIdentifier(assignmentId);
    if (!normalizedAssignmentId) {
        return buildAssignmentSubmissionFields();
    }

    const existing = submissionByAssignmentId?.get(normalizedAssignmentId);
    if (existing) {
        return copyAssignmentSubmissionFields(existing);
    }

    return buildAssignmentSubmissionFields({ assignmentId: normalizedAssignmentId });
}

function mergeSubmissionSummary(winner, loser) {
    if (!winner || !loser) return winner || loser || null;

    const fields = [
        'workflowState',
        'submittedAt',
        'attempt',
        'late',
        'missing',
        'excused',
        'grade',
        'score',
        'submissionType',
        'hasSubmittedSubmissions',
        'gradeMatchesCurrentSubmission'
    ];

    for (const field of fields) {
        if ((winner[field] === undefined || winner[field] === null || winner[field] === '')
            && loser[field] !== undefined && loser[field] !== null && loser[field] !== '') {
            winner[field] = loser[field];
        }
    }

    return winner;
}

function mergeCourseAssignmentGroups(snapshot, groups) {
    if (!snapshot || !Array.isArray(groups)) return;

    snapshot.assignmentGroups = groups
        .map((group) => ({
            id: group?.id ?? null,
            name: group?.name || null,
            position: group?.position ?? null,
            groupWeight: group?.group_weight ?? null,
            rules: group?.rules || null
        }))
        .filter((group) => group.id && group.name)
        .sort((lhs, rhs) => {
            const lhsPos = lhs.position ?? Number.MAX_SAFE_INTEGER;
            const rhsPos = rhs.position ?? Number.MAX_SAFE_INTEGER;
            if (lhsPos === rhsPos) {
                return lhs.name.localeCompare(rhs.name);
            }
            return lhsPos - rhsPos;
        });
}

function mergeCourseModules(snapshot, modules) {
    if (!snapshot || !Array.isArray(modules)) return;

    snapshot.modules = modules
        .map((module) => ({
            id: module?.id ?? null,
            name: module?.name || '',
            position: module?.position ?? null,
            unlockAt: module?.unlock_at || null,
            published: module?.published ?? null,
            items: Array.isArray(module?.items)
                ? module.items.map((item) => ({
                    id: item?.id ?? null,
                    title: item?.title || '',
                    type: item?.type ? String(item.type).toLowerCase() : null,
                    url: item?.html_url || item?.external_url || null,
                    pageUrl: item?.page_url || null,
                    contentId: item?.content_id ?? null,
                    position: item?.position ?? null,
                    published: item?.published ?? null,
                    completionRequirement: copyModuleRequirement(item?.completion_requirement),
                    contentDetails: copyModuleContentDetails(item?.content_details)
                }))
                : []
        }))
        .filter((module) => module.id && module.name)
        .sort((lhs, rhs) => {
            const lhsPos = lhs.position ?? Number.MAX_SAFE_INTEGER;
            const rhsPos = rhs.position ?? Number.MAX_SAFE_INTEGER;
            if (lhsPos === rhsPos) {
                return lhs.name.localeCompare(rhs.name);
            }
            return lhsPos - rhsPos;
        });
}

function getAssignmentGroupName(snapshot, assignmentGroupId) {
    if (!snapshot || !assignmentGroupId) return null;
    const match = (snapshot.assignmentGroups || []).find((group) => group.id === assignmentGroupId);
    return match?.name || null;
}

function buildSnapshotItemBase(course, sourceMeta, scanTimestamp, overrides = {}) {
    return {
        sourceApp: 'canvascope_extension',
        title: overrides.title || '',
        url: overrides.url || '',
        type: overrides.type || 'unknown',
        moduleName: overrides.moduleName || '',
        courseName: course?.name || '',
        courseId: course?.id ?? null,
        platform: sourceMeta?.platform || 'canvas',
        platformDomain: sourceMeta?.platformDomain || '',
        scannedAt: scanTimestamp,
        ...overrides
    };
}

function recordSnapshotItem(snapshot, item) {
    if (!snapshot || !item) return;
    snapshot.indexedContent.push(item);
}

function mergeIndexedContentFields(winner, loser) {
    if (!winner || !loser) return;

    const scalarFields = [
        'assignmentId',
        'assignmentGroupId',
        'assignmentGroupName',
        'contentType',
        'containerUrl',
        'courseId',
        'courseName',
        'createdAt',
        'dueAt',
        'folderPath',
        'hiddenForUser',
        'lockAt',
        'lockedForUser',
        'moduleName',
        'pathDepth',
        'platform',
        'platformDomain',
        'pointsPossible',
        'published',
        'scannedAt',
        'sizeBytes',
        'sourceApp',
        'submitted',
        'submissionStatus',
        'syllabusExcerpt',
        'unlockAt',
        'updatedAt'
    ];

    for (const field of scalarFields) {
        if ((winner[field] === undefined || winner[field] === null || winner[field] === '')
            && loser[field] !== undefined && loser[field] !== null && loser[field] !== '') {
            winner[field] = loser[field];
        }
    }

    const preferredTextFields = ['instructions', 'description', 'body', 'content', 'text'];
    for (const field of preferredTextFields) {
        const winnerValue = typeof winner[field] === 'string' ? winner[field] : '';
        const loserValue = typeof loser[field] === 'string' ? loser[field] : '';
        if (!winnerValue && loserValue) {
            winner[field] = loserValue;
        } else if (loserValue.length > winnerValue.length) {
            winner[field] = loserValue;
        }
    }

    if ((!Array.isArray(winner.submissionTypes) || winner.submissionTypes.length === 0) && Array.isArray(loser.submissionTypes)) {
        winner.submissionTypes = loser.submissionTypes.slice();
    }

    if ((!Array.isArray(winner.allowedExtensions) || winner.allowedExtensions.length === 0) && Array.isArray(loser.allowedExtensions)) {
        winner.allowedExtensions = loser.allowedExtensions.slice();
    }

    if ((!Array.isArray(winner.pathSegments) || winner.pathSegments.length === 0) && Array.isArray(loser.pathSegments)) {
        winner.pathSegments = loser.pathSegments.slice();
    }

    if ((!Array.isArray(winner.weekHints) || winner.weekHints.length === 0) && Array.isArray(loser.weekHints)) {
        winner.weekHints = loser.weekHints.slice();
    }

    if (!winner.submission && loser.submission) {
        winner.submission = cloneSubmissionSummary(loser.submission);
    } else if (winner.submission && loser.submission) {
        mergeSubmissionSummary(winner.submission, loser.submission);
    }
}

function prepareCourseArtifactsForStorage(courseSnapshotMap) {
    const courseSnapshots = Array.from(courseSnapshotMap.values())
        .filter(Boolean)
        .map((snapshot) => {
            snapshot.indexedContent = deduplicateCrossType(deduplicateContent(snapshot.indexedContent || []));
            snapshot.scanStats.itemCount = snapshot.indexedContent.length;
            snapshot.scanStats.typeCounts = snapshot.indexedContent.reduce((acc, item) => {
                const type = String(item?.type || 'unknown').toLowerCase();
                acc[type] = (acc[type] || 0) + 1;
                return acc;
            }, {});
            return snapshot;
        })
        .sort((lhs, rhs) => {
            const lhsName = lhs?.course?.courseName || '';
            const rhsName = rhs?.course?.courseName || '';
            return lhsName.localeCompare(rhsName);
        });

    const courseCatalog = courseSnapshots
        .map(buildCourseCatalogEntryFromSnapshot)
        .sort((lhs, rhs) => (lhs.courseName || '').localeCompare(rhs.courseName || ''));

    return { courseCatalog, courseSnapshots };
}

function flattenSnapshotItems(courseSnapshots) {
    if (!Array.isArray(courseSnapshots)) return [];
    const items = [];
    for (const snapshot of courseSnapshots) {
        if (!Array.isArray(snapshot?.indexedContent)) continue;
        items.push(...snapshot.indexedContent);
    }
    return deduplicateCrossType(deduplicateContent(items));
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

function getIndexedTypeSpecificity(type) {
    const priorities = {
        syllabus: 0,
        assignment: 1,
        quiz: 2,
        discussion: 3,
        folder: 4,
        page: 5,
        file: 6,
        pdf: 6,
        document: 6,
        slides: 6,
        video: 7,
        course: 8,
        navigation: 9,
        link: 10,
        external: 10,
        externalurl: 10
    };
    return priorities[String(type || '').toLowerCase()] ?? 50;
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
            if (getIndexedTypeSpecificity(item.type) < getIndexedTypeSpecificity(existing.type)) {
                winner = item;
                seen.set(key, item);
            } else if (newIsCanonical && !existingIsCanonical) {
                winner = item;
                seen.set(key, item);
            } else if (newIsCanonical === existingIsCanonical &&
                (item.url || '').length < (existing.url || '').length) {
                winner = item;
                seen.set(key, item);
            }

            // Merge due-date fields from either copy (prefer non-null)
            const loser = winner === item ? existing : item;
            mergeIndexedContentFields(winner, loser);
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
    const MERGEABLE_TYPES = new Set(['assignment', 'quiz', 'discussion']);
    const groups = new Map();

    for (const item of content) {
        if (!item || !item.title) continue;

        const normalizedType = String(item.type || '').toLowerCase();
        if (!MERGEABLE_TYPES.has(normalizedType)) {
            groups.set(`unique:${getCanonicalId(item)}`, item);
            continue;
        }

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
            mergeIndexedContentFields(winner, loser);
        }
    }

    return Array.from(groups.values());
}

function isHttpsUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function isPdfSupportedFetchProtocol(protocol) {
    return protocol === 'https:' || protocol === 'http:' || protocol === 'file:';
}

function decodePossiblyEncodedUrl(value) {
    if (!value) return null;
    let decoded = String(value);
    for (let i = 0; i < 2; i += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch {
            break;
        }
    }
    return decoded;
}

function parsePdfViewerSrcFromTabUrl(tabUrl) {
    if (!tabUrl) return null;
    try {
        const parsed = new URL(tabUrl);
        const src = parsed.searchParams.get('src');
        if (!src) return null;
        const decoded = decodePossiblyEncodedUrl(src);
        if (!decoded) return null;
        return normalizePdfCandidateUrl(decoded);
    } catch {
        return null;
    }
}

function normalizePdfCandidateUrl(url, baseUrl = null) {
    if (!url) return null;
    try {
        const parsed = new URL(String(url), baseUrl || undefined);
        if (!isPdfSupportedFetchProtocol(parsed.protocol)) return null;
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return null;
    }
}

function isKnownLmsOrCustomHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return false;
    return isCanvasHost(host) || isBrightspaceHost(host) || customDomains.includes(host);
}

function isLikelyCanvasFileUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const path = parsed.pathname.toLowerCase();
        if (path.includes('/files/folder/')) return false;
        if (/\/courses\/\d+\/files\/\d+(?:\/|$)/i.test(path)) return true;
        if (/\/files\/\d+(?:\/|$)/i.test(path)) return true;
        if (path.endsWith('/download')) return true;
        const preview = parsed.searchParams.get('preview');
        if (preview && /^\d+$/.test(preview)) return true;
        if (parsed.searchParams.has('download') && !path.includes('/files/folder/')) return true;
        return false;
    } catch {
        return false;
    }
}

function isLikelyPdfHint(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const path = parsed.pathname.toLowerCase();
        const query = parsed.search.toLowerCase();
        return path.endsWith('.pdf')
            || query.includes('content_type=application%2fpdf')
            || query.includes('content-type=application%2fpdf')
            || query.includes('mime=application%2fpdf');
    } catch {
        return false;
    }
}

function deriveCanvasDownloadCandidates(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const path = parsed.pathname;
        const courseMatch = path.match(/\/courses\/(\d+)\/files\//i);
        const courseId = courseMatch?.[1] || null;

        const candidates = [];
        const seen = new Set();
        const add = (fileId) => {
            const id = String(fileId || '').trim();
            if (!/^\d+$/.test(id)) return;
            const variants = [];
            if (courseId) {
                variants.push(
                    `${parsed.origin}/courses/${courseId}/files/${id}/download`,
                    `${parsed.origin}/courses/${courseId}/files/${id}/download?download_frd=1`,
                    `${parsed.origin}/courses/${courseId}/files/${id}/download?wrap=1`
                );
            }
            variants.push(
                `${parsed.origin}/files/${id}/download`,
                `${parsed.origin}/files/${id}/download?download_frd=1`,
                `${parsed.origin}/files/${id}/download?wrap=1`
            );

            for (const candidate of variants) {
                if (seen.has(candidate)) continue;
                seen.add(candidate);
                candidates.push(candidate);
            }
        };

        const previewId = parsed.searchParams.get('preview');
        add(previewId);

        const idMatch = path.match(/\/courses\/\d+\/files\/(\d+)(?:\/|$)/i);
        if (idMatch?.[1]) add(idMatch[1]);

        return candidates;
    } catch {
        return [];
    }
}

function deriveDownloadUrlVariants(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const match = parsed.pathname.match(/\/(?:courses\/(\d+)\/)?files\/(\d+)\/download/i);
        if (!match?.[2]) return [];

        const courseId = match[1] || null;
        const fileId = match[2];
        const baseCandidates = [];
        if (courseId) {
            baseCandidates.push(`${parsed.origin}/courses/${courseId}/files/${fileId}/download`);
        }
        baseCandidates.push(`${parsed.origin}/files/${fileId}/download`);

        const variants = [];
        const seen = new Set();
        for (const base of baseCandidates) {
            for (const suffix of ['', '?download_frd=1', '?wrap=1']) {
                const variant = `${base}${suffix}`;
                if (seen.has(variant)) continue;
                seen.add(variant);
                variants.push(variant);
            }
        }
        return variants;
    } catch {
        return [];
    }
}

function hasPdfSignature(bytes) {
    if (!bytes || bytes.length < 5) return false;
    const max = Math.min(bytes.length, PDF_HEADER_CHECK_BYTES);
    for (let i = 0; i <= max - 5; i += 1) {
        if (
            bytes[i] === 0x25 &&
            bytes[i + 1] === 0x50 &&
            bytes[i + 2] === 0x44 &&
            bytes[i + 3] === 0x46 &&
            bytes[i + 4] === 0x2d
        ) {
            return true;
        }
    }
    return false;
}

function extractFilenameFromContentDisposition(header) {
    if (!header) return null;
    const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
        return decodePossiblyEncodedUrl(utf8Match[1]).replace(/^["']|["']$/g, '');
    }

    const plainMatch = header.match(/filename\s*=\s*("?)([^";]+)\1/i);
    if (plainMatch?.[2]) {
        return plainMatch[2].trim();
    }

    return null;
}

function filenameFromUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const segments = parsed.pathname.split('/').filter(Boolean);
        const name = segments.pop();
        return name ? decodePossiblyEncodedUrl(name) : null;
    } catch {
        return null;
    }
}

function cleanFilenameHint(name) {
    const raw = cleanTitle(name);
    if (!raw) return '';
    const strippedQuery = raw.split('?')[0].split('#')[0];
    const leaf = strippedQuery.split('/').filter(Boolean).pop() || strippedQuery;
    return cleanTitle(decodePossiblyEncodedUrl(leaf) || leaf);
}

function isGenericPdfFilenameHint(name) {
    const cleaned = cleanFilenameHint(name);
    if (!cleaned) return true;
    const lowered = cleaned.toLowerCase().replace(/\.pdf$/i, '');
    return lowered === 'download'
        || lowered === 'file'
        || lowered === 'files'
        || lowered === 'preview'
        || lowered === 'document'
        || lowered === 'pdf'
        || lowered === 'index';
}

function extractFilenameHintFromUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const queryKeys = ['filename', 'file_name', 'file', 'name', 'title'];
        for (const key of queryKeys) {
            const value = parsed.searchParams.get(key);
            if (!value) continue;
            const cleaned = cleanFilenameHint(value);
            if (!isGenericPdfFilenameHint(cleaned)) return cleaned;
        }

        const fromPath = cleanFilenameHint(filenameFromUrl(parsed.toString()));
        if (!isGenericPdfFilenameHint(fromPath)) return fromPath;
        return '';
    } catch {
        return '';
    }
}

function parseCourseIdFromUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const match = parsed.pathname.match(/\/courses\/(\d+)/i);
        if (!match?.[1]) return null;
        const id = Number.parseInt(match[1], 10);
        return Number.isFinite(id) ? id : null;
    } catch {
        return null;
    }
}

function prioritizePdfCandidates(candidates, pageUrl = null) {
    let pageHost = '';
    try {
        pageHost = pageUrl ? new URL(pageUrl).hostname.toLowerCase() : '';
    } catch {
        pageHost = '';
    }

    return [...candidates].sort((a, b) => {
        const score = (candidate) => {
            let s = 0;
            const confidence = String(candidate?.hintConfidence || 'weak').toLowerCase();
            if (confidence === 'definitive') s += 300;
            else if (confidence === 'strong') s += 200;
            else s += 100;

            try {
                const host = new URL(candidate.url).hostname.toLowerCase();
                if (host === pageHost) s += 70;
                if (isKnownLmsOrCustomHost(host)) s += 40;
            } catch {
                // no-op
            }

            if (isLikelyCanvasFileUrl(candidate.url)) s += 20;
            if (isLikelyPdfHint(candidate.url)) s += 15;
            if (candidate?.source === 'viewer_src') s += 10;
            return s;
        };

        return score(b) - score(a);
    });
}

function withTimeout(promise, timeoutMs, fallbackValue) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(fallbackValue);
        }, timeoutMs);

        promise.then((result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        }).catch(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(fallbackValue);
        });
    });
}

function sendMessageToTab(tabId, message) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            const err = chrome.runtime.lastError;
            if (err) {
                resolve({ success: false, error: err.message || 'No receiver' });
                return;
            }
            resolve(response || { success: false, error: 'No response' });
        });
    });
}

async function collectPdfCandidatesFromTab(tabId) {
    if (typeof tabId !== 'number') {
        return { success: false, candidates: [], reason: 'invalid_tab' };
    }

    const fallback = { success: false, candidates: [], reason: 'timeout' };
    const response = await withTimeout(
        sendMessageToTab(tabId, { action: 'collectPdfCandidates' }),
        PDF_CONTEXT_TIMEOUT_MS,
        fallback
    );

    if (!response || response.success !== true || !Array.isArray(response.candidates)) {
        return {
            success: false,
            candidates: [],
            pageUrl: response?.pageUrl || null,
            titleHint: response?.titleHint || null,
            reason: response?.error || response?.reason || 'no_candidates'
        };
    }

    return {
        success: true,
        candidates: response.candidates,
        pageUrl: response.pageUrl || null,
        titleHint: response.titleHint || null
    };
}

async function resolveTargetTabForPdfMode(mode, sender) {
    if (mode === 'sender_tab' && sender?.tab) {
        return sender.tab;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null;
}

async function probePdfCandidate(candidateUrl) {
    const normalized = normalizePdfCandidateUrl(candidateUrl);
    if (!normalized) {
        return {
            ok: false,
            confidence: 'none',
            reason: 'invalid_url',
            contentType: null
        };
    }

    let contentType = null;
    let candidateProtocol = '';
    try {
        candidateProtocol = new URL(normalized).protocol;
    } catch {
        candidateProtocol = '';
    }
    const isFileCandidate = candidateProtocol === 'file:';

    if (!isFileCandidate) {
        try {
            const headResp = await fetch(normalized, {
                method: 'HEAD',
                credentials: 'include',
                redirect: 'follow'
            });
            if (headResp?.headers) {
                contentType = headResp.headers.get('content-type') || null;
            }
        } catch {
            // HEAD often fails on LMS file routes; GET range remains authoritative.
        }
    }

    const sniffWithHeaders = async (headers = {}) => {
        const options = {
            method: 'GET',
            redirect: 'follow',
            headers
        };
        if (!isFileCandidate) {
            options.credentials = 'include';
        }
        return fetch(normalized, options);
    };

    try {
        let sniffResp;
        try {
            sniffResp = await sniffWithHeaders({
                Range: `bytes=0-${PDF_HEADER_CHECK_BYTES - 1}`
            });
            if (sniffResp.status === 416) {
                sniffResp = await sniffWithHeaders();
            }
        } catch {
            sniffResp = await sniffWithHeaders();
        }

        if (!sniffResp.ok) {
            if (sniffResp.status === 401 || sniffResp.status === 403) {
                return {
                    ok: false,
                    confidence: 'none',
                    reason: 'unauthorized',
                    statusCode: sniffResp.status,
                    contentType
                };
            }
            return {
                ok: false,
                confidence: 'none',
                reason: `http_${sniffResp.status}`,
                statusCode: sniffResp.status,
                contentType
            };
        }

        const sniffContentType = sniffResp.headers.get('content-type');
        if (!contentType && sniffContentType) {
            contentType = sniffContentType;
        }

        const raw = new Uint8Array(await sniffResp.arrayBuffer());
        const sniff = raw.subarray(0, Math.min(raw.length, PDF_HEADER_CHECK_BYTES));
        const signatureMatch = hasPdfSignature(sniff);
        const contentTypePdf = String(contentType || '').toLowerCase().includes('application/pdf');

        if (signatureMatch) {
            return {
                ok: true,
                confidence: 'definitive',
                reason: 'pdf_header',
                contentType
            };
        }

        if (contentTypePdf) {
            return {
                ok: true,
                confidence: 'strong',
                reason: 'content_type_pdf',
                contentType
            };
        }

        if (isLikelyPdfHint(normalized)) {
            return {
                ok: true,
                confidence: 'weak',
                reason: 'url_hint_only',
                contentType
            };
        }

        return {
            ok: false,
            confidence: 'none',
            reason: 'not_pdf',
            contentType
        };
    } catch (error) {
        return {
            ok: false,
            confidence: 'none',
            reason: `network_error:${parseErrorMessage(error)}`,
            contentType
        };
    }
}

function normalizePdfViewerTitleHint(rawTitle) {
    const cleaned = cleanTitle(rawTitle);
    if (!cleaned) return '';

    const explicitPdf = cleaned.match(/([^|]+?\.pdf)\b/i);
    if (explicitPdf?.[1]) {
        return cleanTitle(explicitPdf[1]);
    }

    return cleanTitle(cleaned.replace(/\s*:\s*\d+\s*$/i, ''));
}

function derivePdfViewerOverlayTitleHint(tabTitle, candidateUrl) {
    const tabHint = normalizePdfViewerTitleHint(tabTitle);
    if (!isGenericPdfTitleHint(tabHint)) {
        return tabHint;
    }

    const urlHint = cleanTitle(extractFilenameHintFromUrl(candidateUrl));
    if (urlHint && !isGenericPdfFilenameHint(urlHint)) {
        return urlHint;
    }

    return tabHint || urlHint || '';
}

async function resolvePdfViewerOverlayContextForTab(tab) {
    if (!tab?.url) {
        pdfViewerDebug('resolvePdfViewerOverlayContextForTab: no tab url');
        return {
            success: true,
            showButton: false,
            candidateUrl: null,
            sourcePageUrl: null,
            titleHint: null,
            reason: 'no_tab_url'
        };
    }

    const viewerSrcUrl = parsePdfViewerSrcFromTabUrl(tab.url);
    const normalizedTabUrl = normalizePdfCandidateUrl(tab.url, tab.url);
    pdfViewerDebug('Resolving overlay context for tab', {
        tabId: tab.id || null,
        tabUrl: tab.url,
        title: tab.title || null,
        viewerSrcUrl,
        normalizedTabUrl
    });
    const attempts = [];
    const seen = new Set();
    const tabCandidates = await collectPdfCandidatesFromTab(tab.id);
    const queueAttempt = (url, sourcePageUrl, reason) => {
        const normalized = normalizePdfCandidateUrl(url, tab.url);
        const normalizedSource = normalizePdfCandidateUrl(sourcePageUrl || normalized, tab.url);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        attempts.push({
            url: normalized,
            sourcePageUrl: normalizedSource || normalized,
            reason
        });
    };

    if (viewerSrcUrl) {
        queueAttempt(viewerSrcUrl, viewerSrcUrl, 'viewer_src');
    }

    if (normalizedTabUrl) {
        queueAttempt(normalizedTabUrl, normalizedTabUrl, 'tab_url');
    }

    if (tabCandidates.success) {
        for (const candidate of tabCandidates.candidates) {
            queueAttempt(
                candidate?.url,
                tabCandidates.pageUrl || candidate?.url || normalizedTabUrl || tab.url,
                candidate?.source || 'content_script'
            );
        }
    }

    if (attempts.length === 0) {
        pdfViewerDebug('Overlay context: no candidate attempts');
        return {
            success: true,
            showButton: false,
            candidateUrl: null,
            sourcePageUrl: null,
            titleHint: null,
            reason: 'unsupported_tab_scheme'
        };
    }

    for (const attempt of attempts) {
        const probe = await probePdfCandidate(attempt.url);
        pdfViewerDebug('Overlay probe result', {
            tabUrl: tab.url,
            attempt,
            probe
        });
        if (probe.ok && PDF_CONFIDENCE_RANK[probe.confidence] >= PDF_CONFIDENCE_RANK.strong) {
            const resolved = {
                success: true,
                showButton: true,
                candidateUrl: attempt.url,
                sourcePageUrl: attempt.sourcePageUrl,
                titleHint: tabCandidates.titleHint || derivePdfViewerOverlayTitleHint(tab.title || '', attempt.url) || null,
                reason: probe.reason || attempt.reason
            };
            pdfViewerDebug('Overlay context resolved: show button', resolved);
            return {
                ...resolved
            };
        }
    }

    const fallback = attempts[0];
    const rejected = {
        success: true,
        showButton: false,
        candidateUrl: fallback?.url || null,
        sourcePageUrl: fallback?.sourcePageUrl || null,
        titleHint: fallback ? (tabCandidates.titleHint || derivePdfViewerOverlayTitleHint(tab.title || '', fallback.url) || null) : null,
        reason: 'top_level_not_pdf'
    };
    pdfViewerDebug('Overlay context resolved: hide button', rejected);
    return {
        ...rejected
    };
}

async function buildPdfContextForTab(tab) {
    if (!tab?.url) {
        return {
            hasPdf: false,
            confidence: 'none',
            candidateUrl: null,
            sourcePageUrl: null,
            titleHint: null,
            reason: 'no_tab_url'
        };
    }

    const viewerSrcUrl = parsePdfViewerSrcFromTabUrl(tab.url);
    const candidates = [];
    const seen = new Set();

    const addCandidate = (url, source, hintConfidence = 'weak') => {
        const normalized = normalizePdfCandidateUrl(url, tab.url);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        candidates.push({
            url: normalized,
            source,
            hintConfidence
        });
    };

    if (viewerSrcUrl) {
        addCandidate(viewerSrcUrl, 'viewer_src', 'strong');
    }

    const derivedCanvasDownloads = deriveCanvasDownloadCandidates(tab.url);
    for (const candidate of derivedCanvasDownloads) {
        addCandidate(candidate, 'canvas_preview_download', 'strong');
    }

    const tabCandidates = await collectPdfCandidatesFromTab(tab.id);
    if (tabCandidates.success) {
        for (const candidate of tabCandidates.candidates) {
            addCandidate(candidate?.url, candidate?.source || 'content_script', candidate?.hintConfidence || 'weak');
        }
    }

    const normalizedTabUrl = normalizePdfCandidateUrl(tab.url, tab.url);
    if (normalizedTabUrl) {
        const hasDirectPdfHint = isLikelyCanvasFileUrl(tab.url) || isLikelyPdfHint(tab.url);
        addCandidate(normalizedTabUrl, 'active_tab_url', hasDirectPdfHint ? 'strong' : 'weak');
    }

    if (candidates.length === 0) {
        return {
            hasPdf: false,
            confidence: 'none',
            candidateUrl: null,
            sourcePageUrl: normalizePdfCandidateUrl(tab.url, tab.url),
            titleHint: tab.title || null,
            reason: 'no_candidate_urls'
        };
    }

    const sourcePageUrl = normalizePdfCandidateUrl(
        tabCandidates.pageUrl || normalizedTabUrl || viewerSrcUrl,
        tab.url
    );

    const prioritized = prioritizePdfCandidates(candidates, sourcePageUrl || tab.url);
    let best = {
        confidence: 'none',
        candidateUrl: prioritized[0]?.url || null,
        reason: 'candidate_not_verified'
    };

    for (const candidate of prioritized.slice(0, 6)) {
        const probe = await probePdfCandidate(candidate.url);
        if (!probe.ok && PDF_CONFIDENCE_RANK[probe.confidence] === 0) {
            continue;
        }

        const probeRank = PDF_CONFIDENCE_RANK[probe.confidence] ?? 0;
        const bestRank = PDF_CONFIDENCE_RANK[best.confidence] ?? 0;
        if (probeRank > bestRank) {
            best = {
                confidence: probe.confidence,
                candidateUrl: candidate.url,
                reason: probe.reason || 'probe_success'
            };
        }

        if (probe.confidence === 'definitive') {
            break;
        }
    }

    if (best.confidence === 'none') {
        const localFileHint = prioritized.find((candidate) => {
            if (!String(candidate?.url || '').startsWith('file:')) return false;
            return isLikelyPdfHint(candidate.url);
        });
        if (localFileHint) {
            best = {
                confidence: 'strong',
                candidateUrl: localFileHint.url,
                reason: 'file_url_hint'
            };
        }
    }

    if (best.confidence === 'none' && prioritized.length > 0) {
        const hintedFallback = prioritized[0];
        const hintedConfidence = String(hintedFallback?.hintConfidence || 'weak').toLowerCase();
        const fallbackConfidence = PDF_CONFIDENCE_RANK[hintedConfidence] > 0 ? hintedConfidence : 'weak';
        best = {
            confidence: fallbackConfidence,
            candidateUrl: hintedFallback.url,
            reason: 'hint_only'
        };
    }

    return {
        hasPdf: PDF_CONFIDENCE_RANK[best.confidence] >= PDF_CONFIDENCE_RANK.strong,
        confidence: best.confidence,
        candidateUrl: best.candidateUrl,
        sourcePageUrl,
        titleHint: tabCandidates.titleHint || tab.title || null,
        reason: best.reason
    };
}

async function downloadAndVerifyPdf(candidateUrl) {
    const normalized = normalizePdfCandidateUrl(candidateUrl);
    if (!normalized) {
        return { ok: false, code: 'invalid_url', message: 'Invalid PDF URL.' };
    }

    let candidateProtocol = '';
    try {
        candidateProtocol = new URL(normalized).protocol;
    } catch {
        candidateProtocol = '';
    }
    const isFileCandidate = candidateProtocol === 'file:';

    try {
        const fetchOptions = {
            method: 'GET',
            redirect: 'follow'
        };
        if (!isFileCandidate) {
            fetchOptions.credentials = 'include';
        }

        const response = await fetch(normalized, fetchOptions);

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return { ok: false, code: 'pdf_access_denied', message: 'Can’t access this PDF from this tab. Open it directly and try again.' };
            }
            if (response.status === 404) {
                return { ok: false, code: 'pdf_not_found', message: 'No PDF detected on this page.' };
            }
            return {
                ok: false,
                code: 'pdf_download_failed',
                message: `PDF download failed (${response.status}).`
            };
        }

        const contentDisposition = response.headers.get('content-disposition') || '';
        const responseUrl = response.url || normalized;
        const filename = extractFilenameFromContentDisposition(contentDisposition)
            || filenameFromUrl(responseUrl)
            || filenameFromUrl(normalized);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length === 0) {
            return { ok: false, code: 'pdf_empty', message: 'Downloaded file is empty.' };
        }
        if (bytes.length > PDF_SEND_MAX_BYTES) {
            return { ok: false, code: 'pdf_too_large', message: 'PDF is too large (25 MB max).' };
        }

        const headerSlice = bytes.subarray(0, Math.min(bytes.length, 2048));
        if (!hasPdfSignature(headerSlice)) {
            return { ok: false, code: 'pdf_invalid_header', message: 'This file is not a valid PDF.' };
        }

        return {
            ok: true,
            bytes,
            filename,
            responseUrl,
            contentType: response.headers.get('content-type') || null
        };
    } catch (error) {
        if (isFileCandidate) {
            return {
                ok: false,
                code: 'file_url_access_required',
                message: 'Enable "Allow access to file URLs" for Canvascope in Extensions settings, then try again.'
            };
        }
        return {
            ok: false,
            code: 'pdf_network_error',
            message: `Network error: ${parseErrorMessage(error)}`
        };
    }
}

function cleanTitle(title) {
    const text = String(title || '').trim();
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
}

function isGenericPdfTitleHint(title) {
    const cleaned = cleanTitle(title);
    if (!cleaned) return true;

    const lowered = cleaned.toLowerCase().replace(/\s+/g, ' ');
    if (lowered === 'file' || lowered === 'files') return true;
    if (lowered === 'file preview' || lowered === 'preview') return true;
    if (lowered === 'document' || lowered === 'pdf') return true;
    if (lowered === 'download' || lowered === 'open file') return true;
    if (lowered === 'canvas') return true;
    return false;
}

function derivePdfTitle({ titleHint, fallbackFilename, sourcePageTitle, candidateUrl, sourceUrl, responseUrl }) {
    const cleanedTitleHint = cleanTitle(titleHint);
    const cleanedFallbackFilename = cleanTitle(fallbackFilename);
    const cleanedSourcePageTitle = cleanTitle(sourcePageTitle);
    const urlFilenameHint = extractFilenameHintFromUrl(responseUrl)
        || extractFilenameHintFromUrl(candidateUrl)
        || extractFilenameHintFromUrl(sourceUrl);

    const preferredFilename = !isGenericPdfFilenameHint(cleanedFallbackFilename)
        ? cleanedFallbackFilename
        : (!isGenericPdfFilenameHint(urlFilenameHint) ? urlFilenameHint : '');

    const preferred = (!isGenericPdfTitleHint(cleanedTitleHint) ? cleanedTitleHint : '')
        || preferredFilename
        || (!isGenericPdfTitleHint(cleanedSourcePageTitle) ? cleanedSourcePageTitle : '');
    if (!preferred) {
        return `Imported PDF ${new Date().toISOString().slice(0, 10)}`;
    }

    return preferred.replace(/\.pdf$/i, '').trim() || preferred;
}

async function uploadPdfToLectraViaDropBridgeV2({ accessToken, bytes, filename, metadata }) {
    const deviceId = await getOrCreateDropBridgeV2DeviceId();
    const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/upload-file-v2`;
    const sanitizedFilename = sanitizeFilename(filename || `canvascope-import-${Date.now()}.pdf`);
    const finalFilename = /\.pdf$/i.test(sanitizedFilename) ? sanitizedFilename : `${sanitizedFilename}.pdf`;
    const formData = new FormData();
    formData.append('receiverKind', 'lectra_ipad');
    formData.append('senderKind', 'canvascope_extension');
    formData.append('senderDeviceId', deviceId);
    formData.append('metadata', JSON.stringify(metadata || {}));
    formData.append('file', new Blob([bytes], { type: 'application/pdf' }), finalFilename);

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${accessToken}`
        },
        body: formData
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) {
        throw new Error(payload?.error || `upload-file-v2 failed (${response.status})`);
    }

    return payload;
}

async function wakeLectraForSyncedItem({ syncedItemId, accessToken }) {
    const token = accessToken || await getDropBridgeV2AccessToken();
    if (!token) {
        throw new Error('Missing access token for wake-lectra-v2');
    }

    return callDropBridgeV2Function('wake-lectra-v2', {
        syncedItemId,
        reason: 'synced_item_inserted'
    }, token);
}

async function resolvePdfContextFromMessage({ mode, sender }) {
    const tab = await resolveTargetTabForPdfMode(mode, sender);
    if (!tab) {
        return {
            success: true,
            hasPdf: false,
            confidence: 'none',
            candidateUrl: null,
            sourcePageUrl: null,
            titleHint: null,
            reason: 'no_active_tab'
        };
    }

    const context = await buildPdfContextForTab(tab);
    return {
        success: true,
        hasPdf: context.hasPdf,
        confidence: context.confidence,
        candidateUrl: context.candidateUrl,
        sourcePageUrl: context.sourcePageUrl,
        titleHint: context.titleHint,
        reason: context.reason
    };
}

function hasStrongPdfSendContext(context) {
    const confidence = String(context?.confidence || 'none').toLowerCase();
    return Boolean(context?.hasPdf) && (confidence === 'definitive' || confidence === 'strong');
}

function resolvePdfSendRequestPayload({ liveContext, fallbackCandidateUrl, fallbackSourcePageUrl, fallbackTitleHint }) {
    const liveCandidateUrl = normalizePdfCandidateUrl(
        liveContext?.candidateUrl,
        liveContext?.sourcePageUrl || fallbackSourcePageUrl || undefined
    );
    const liveSourcePageUrl = normalizePdfCandidateUrl(
        liveContext?.sourcePageUrl || liveCandidateUrl,
        liveCandidateUrl || fallbackSourcePageUrl || undefined
    );
    const liveTitleHint = cleanTitle(liveContext?.titleHint || '');

    if (hasStrongPdfSendContext(liveContext) && liveCandidateUrl) {
        return {
            candidateUrl: liveCandidateUrl,
            sourcePageUrl: liveSourcePageUrl || liveCandidateUrl,
            titleHint: liveTitleHint || cleanTitle(fallbackTitleHint || '') || null,
            source: 'live_context'
        };
    }

    const fallbackCandidate = normalizePdfCandidateUrl(
        fallbackCandidateUrl,
        fallbackSourcePageUrl || liveSourcePageUrl || undefined
    );
    const fallbackSource = normalizePdfCandidateUrl(
        fallbackSourcePageUrl || fallbackCandidate,
        fallbackCandidate || liveSourcePageUrl || undefined
    );
    const fallbackTitle = cleanTitle(fallbackTitleHint || '');

    return {
        candidateUrl: fallbackCandidate || liveCandidateUrl || null,
        sourcePageUrl: fallbackSource || liveSourcePageUrl || fallbackCandidate || liveCandidateUrl || null,
        titleHint: fallbackTitle || liveTitleHint || null,
        source: fallbackCandidate ? 'fallback_message' : 'unresolved'
    };
}

async function sendPdfToLectraFromMessage({ trigger, candidateUrl, sourcePageUrl, titleHint, sender }) {
    const extensionSettings = await getExtensionSettings();
    if (!extensionSettings.enableSendToLectra) {
        return {
            success: false,
            code: 'feature_disabled',
            message: 'Enable Send to Lectra in Canvascope settings to send PDFs.'
        };
    }

    if (!supabaseClient) {
        return {
            success: false,
            code: 'supabase_unavailable',
            message: 'Sync unavailable right now.'
        };
    }

    const activeMode = sender?.tab ? 'sender_tab' : 'active_tab';
    const context = await resolvePdfContextFromMessage({ mode: activeMode, sender });
    const resolvedRequest = resolvePdfSendRequestPayload({
        liveContext: context,
        fallbackCandidateUrl: candidateUrl,
        fallbackSourcePageUrl: sourcePageUrl,
        fallbackTitleHint: titleHint
    });
    const resolvedCandidateUrl = resolvedRequest.candidateUrl;
    const resolvedSourceUrl = resolvedRequest.sourcePageUrl;

    if (!resolvedCandidateUrl || (resolvedRequest.source === 'unresolved' && !hasStrongPdfSendContext(context))) {
        return {
            success: false,
            code: 'no_pdf_detected',
            message: 'No PDF detected on this page.'
        };
    }

    const inFlightKey = `${sender?.tab?.id || 'active'}:${resolvedCandidateUrl}`;
    if (pdfSendInFlightKeys.has(inFlightKey)) {
        return {
            success: false,
            code: 'send_in_progress',
            message: 'A send is already in progress for this PDF.'
        };
    }
    pdfSendInFlightKeys.add(inFlightKey);

    try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError) {
            return {
                success: false,
                code: 'auth_error',
                message: sessionError.message || 'Sign in to Canvascope to send PDFs to Lectra.'
            };
        }

        if (!session?.user?.id) {
            return {
                success: false,
                code: 'not_signed_in',
                message: 'Sign in to Canvascope to send PDFs to Lectra.'
            };
        }

        const attemptUrls = [];
        const seenAttemptUrls = new Set();
        const queueAttempt = (url) => {
            const normalized = normalizePdfCandidateUrl(url, resolvedSourceUrl || resolvedCandidateUrl);
            if (!normalized || seenAttemptUrls.has(normalized)) return;
            seenAttemptUrls.add(normalized);
            attemptUrls.push(normalized);
        };

        queueAttempt(resolvedCandidateUrl);
        for (const variant of deriveDownloadUrlVariants(resolvedCandidateUrl || '')) {
            queueAttempt(variant);
        }
        for (const variant of deriveCanvasDownloadCandidates(resolvedSourceUrl || '')) {
            queueAttempt(variant);
        }

        let downloaded = null;
        let selectedCandidateUrl = resolvedCandidateUrl;
        for (const attemptUrl of attemptUrls) {
            const attempt = await downloadAndVerifyPdf(attemptUrl);
            if (attempt.ok) {
                downloaded = attempt;
                selectedCandidateUrl = attemptUrl;
                break;
            }
            downloaded = attempt;
        }

        if (!downloaded?.ok) {
            return {
                success: false,
                code: downloaded?.code || 'pdf_download_failed',
                message: downloaded?.message || 'Failed to download PDF.'
            };
        }

        const rowId = generateUuidV4();
        const storagePath = buildPdfStoragePath(session.user.id, rowId);
        const uploadData = downloaded.bytes.buffer.slice(
            downloaded.bytes.byteOffset,
            downloaded.bytes.byteOffset + downloaded.bytes.byteLength
        );

        const { error: uploadError } = await supabaseClient.storage
            .from(LECTRA_DOCUMENTS_BUCKET)
            .upload(storagePath, uploadData, {
                contentType: 'application/pdf',
                upsert: false
            });

        if (uploadError) {
            const uploadMessage = String(uploadError.message || '');
            const bucketMissing = /bucket\s+not\s+found/i.test(uploadMessage);
            console.warn('[Canvascope PDF Sync] Upload failed', {
                candidateUrl: selectedCandidateUrl,
                storagePath,
                error: uploadError
            });
            return {
                success: false,
                code: bucketMissing ? 'storage_bucket_missing' : 'upload_failed',
                message: bucketMissing
                    ? `Upload failed: bucket "${LECTRA_DOCUMENTS_BUCKET}" does not exist yet. Run the storage migration for Lectra PDF sync.`
                    : (uploadError.message ? `Upload failed: ${uploadError.message}` : 'Upload failed. Please retry.')
            };
        }

        const sourceForCourse = resolvedSourceUrl || selectedCandidateUrl;
        const courseId = parseCourseIdFromUrl(sourceForCourse);
        const resolvedTitle = derivePdfTitle({
            titleHint: resolvedRequest.titleHint || context.titleHint,
            fallbackFilename: downloaded.filename,
            sourcePageTitle: context.titleHint,
            candidateUrl: selectedCandidateUrl,
            sourceUrl: sourceForCourse,
            responseUrl: downloaded.responseUrl
        });

        const rowPayload = {
            id: rowId,
            user_id: session.user.id,
            item_type: 'pdf_document',
            item_data: {
                title: resolvedTitle,
                courseId: courseId ?? null,
                sourceUrl: sourceForCourse || null,
                storagePath,
                annotatedStoragePath: null,
                status: 'pending_annotation',
                sourcePlatform: 'canvascope_extension',
                sourceKind: 'canvas_pdf_import'
            },
            sync_status: 'synced'
        };

        const { error: insertError } = await supabaseClient
            .from('synced_items')
            .insert(rowPayload);

        if (insertError) {
            console.warn('[Canvascope PDF Sync] Row insert failed', {
                candidateUrl: selectedCandidateUrl,
                storagePath,
                error: insertError
            });
            await supabaseClient.storage
                .from(LECTRA_DOCUMENTS_BUCKET)
                .remove([storagePath])
                .catch(() => {
                    // Best effort cleanup only.
                });

            return {
                success: false,
                code: 'row_insert_failed',
                message: insertError.message ? `Uploaded, but failed to register in Lectra: ${insertError.message}` : 'Uploaded, but failed to register in Lectra. Retry send.'
            };
        }

        void wakeLectraForSyncedItem({
            syncedItemId: rowId,
            accessToken: session.access_token || null
        }).catch((error) => {
            console.warn('[Canvascope PDF Sync] Wake hint failed', {
                rowId,
                error: parseErrorMessage(error)
            });
        });

        console.log('[Canvascope PDF Sync] Sent PDF to Lectra', {
            trigger: trigger || 'unknown',
            rowId,
            storagePath,
            bytes: downloaded.bytes.byteLength
        });

        return {
            success: true,
            code: 'ok',
            message: 'Sent to Lectra ✓',
            rowId,
            storagePath,
            bytesUploaded: downloaded.bytes.byteLength,
            itemType: 'pdf_document'
        };
    } finally {
        pdfSendInFlightKeys.delete(inFlightKey);
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
                                }).then(async ({ error: sessionError }) => {
                                    if (sessionError) {
                                        console.error('[Canvascope Auth] Error setting session:', sessionError);
                                        dropBridgeDebug('auth: setSession failed after OAuth', {
                                            error: parseErrorMessage(sessionError)
                                        });
                                        sendResponse({ success: false, error: sessionError.message });
                                    } else {
                                        console.log('[Canvascope Auth] Successfully authenticated!');
                                        const { data: { session } } = await supabaseClient.auth.getSession();
                                        await persistAuthStatusSnapshot(session || null);
                                        dropBridgeDebug('auth: OAuth success, starting DropBridge loop');
                                        startDropBridgeV2Loop('post-login').catch((error) => {
                                            console.error('[DropBridge v2] Post-login bootstrap failure:', parseErrorMessage(error));
                                        });
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

        return true;

    }
});

// Add message handler to check auth status on popup load
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'checkAuthStatus') {
        (async () => {
            const status = await resolveAuthStatus();
            sendResponse({
                signedIn: Boolean(status?.signedIn),
                user: status?.user || null
            });
        })();
        return true;
    } else if (message.type === 'fetchUserData') {
        (async () => {
            try {
                const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
                if (sessionError) throw sessionError;
                if (!session) { sendResponse({ success: false, error: 'Not signed in' }); return; }

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
                dropBridgeDebug('auth: signOut requested, stopping DropBridge loop');
                const { error } = await supabaseClient.auth.signOut();
                if (error) throw error;
                stopDropBridgeV2Loop();
                sendResponse({ success: true });
            } catch (err) {
                console.error('[Canvascope Auth] Error signing out:', err);
                dropBridgeDebug('auth: signOut failed', { error: parseErrorMessage(err) });
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
    } else if (message.type === 'recordAdaptiveSearchEvent') {
        (async () => {
            try {
                if (!message.event || typeof message.event !== 'object') {
                    sendResponse({ success: false, error: 'Missing adaptive search event payload' });
                    return;
                }

                const payload = await callCanvascopeSupabaseFunction('record-search-event', message.event);
                sendResponse({
                    success: true,
                    pattern: payload?.pattern || null
                });
            } catch (err) {
                console.error('[Canvascope Adaptive Search] Error recording event:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    } else if (message.type === 'fetchAdaptiveSearchSuggestions') {
        (async () => {
            try {
                const slotContext = message.context && typeof message.context === 'object' ? message.context : {};
                const payload = await callCanvascopeSupabaseFunction('get-search-suggestions', slotContext);
                sendResponse({
                    success: true,
                    suggestions: Array.isArray(payload?.suggestions) ? payload.suggestions : []
                });
            } catch (err) {
                console.error('[Canvascope Adaptive Search] Error fetching suggestions:', err);
                sendResponse({ success: false, error: err.message, suggestions: [] });
            }
        })();
        return true;
    } else if (message.type === 'syncAdaptiveSearchState') {
        (async () => {
            try {
                const { data: { session } } = await supabaseClient.auth.getSession();
                if (!session) {
                    sendResponse({ success: false, error: 'Not signed in' });
                    return;
                }
                const { data, error } = await supabaseClient.from('synced_items')
                    .select('id')
                    .eq('user_id', session.user.id)
                    .eq('item_type', 'adaptive_search_habits')
                    .order('updated_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                if (error) throw error;
                
                const payload = {
                    user_id: session.user.id,
                    item_type: 'adaptive_search_habits',
                    item_data: message.state,
                    sync_status: 'synced',
                    updated_at: new Date().toISOString()
                };

                if (data) {
                    const { error: updateError } = await supabaseClient.from('synced_items')
                        .update(payload).eq('id', data.id);
                    if (updateError) throw updateError;
                } else {
                    const { error: insertError } = await supabaseClient.from('synced_items')
                        .insert([payload]);
                    if (insertError) throw insertError;
                }
                sendResponse({ success: true });
            } catch (err) {
                console.error('[Canvascope Sync] Error syncing adaptive habits:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    } else if (message.type === 'fetchAdaptiveSearchState') {
        (async () => {
            try {
                const { data: { session } } = await supabaseClient.auth.getSession();
                if (!session) {
                    sendResponse({ success: false, error: 'Not signed in' });
                    return;
                }
                const { data, error } = await supabaseClient.from('synced_items')
                    .select('item_data')
                    .eq('user_id', session.user.id)
                    .eq('item_type', 'adaptive_search_habits')
                    .order('updated_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                
                if (error) {
                    throw error;
                }
                sendResponse({ success: true, state: data ? data.item_data : null });
            } catch (err) {
                console.error('[Canvascope Sync] Error fetching adaptive habits:', err);
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
function isExtensionOwnedSyncedRow(row, legacyItemTypes) {
    const itemType = String(row?.item_type || '').toLowerCase();
    if (!itemType || itemType === 'pdf_document' || itemType.startsWith('course_brain_') || itemType === 'adaptive_search_habits') {
        return false;
    }

    if (itemType === COURSE_CATALOG_ITEM_TYPE || itemType === COURSE_SNAPSHOT_ITEM_TYPE) {
        return true;
    }

    const itemData = row?.item_data && typeof row.item_data === 'object' ? row.item_data : null;
    if (itemData?.sourceApp === 'canvascope_extension' || itemData?.sourcePlatform === 'canvascope_extension') {
        return true;
    }

    if (!legacyItemTypes.has(itemType)) {
        return false;
    }

    return Boolean(
        itemData?.platform ||
        itemData?.platformDomain ||
        itemData?.courseId ||
        itemData?.courseName
    );
}

async function clearExtensionOwnedSyncedItems(userId, legacyItems = []) {
    const existingRows = [];
    for (let offset = 0; ; offset += EXTENSION_SYNC_READ_PAGE_SIZE) {
        const { data: pageRows, error } = await supabaseClient
            .from('synced_items')
            .select('id, item_type, item_data')
            .eq('user_id', userId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(offset, offset + EXTENSION_SYNC_READ_PAGE_SIZE - 1);

        if (error) {
            throw error;
        }

        const rows = Array.isArray(pageRows) ? pageRows : [];
        existingRows.push(...rows);

        if (rows.length < EXTENSION_SYNC_READ_PAGE_SIZE) {
            break;
        }
    }

    const legacyItemTypes = new Set(LEGACY_EXTENSION_ITEM_TYPES);
    for (const item of legacyItems) {
        const type = String(item?.type || '').toLowerCase().trim();
        if (type) {
            legacyItemTypes.add(type);
        }
    }

    const rowIds = (existingRows || [])
        .filter((row) => isExtensionOwnedSyncedRow(row, legacyItemTypes))
        .map((row) => row.id)
        .filter(Boolean);

    for (let index = 0; index < rowIds.length; index += EXTENSION_SYNC_BATCH_SIZE) {
        const batch = rowIds.slice(index, index + EXTENSION_SYNC_BATCH_SIZE);
        const { error: deleteError } = await supabaseClient
            .from('synced_items')
            .delete()
            .eq('user_id', userId)
            .in('id', batch);

        if (deleteError) {
            throw deleteError;
        }
    }

    return rowIds.length;
}

async function insertSyncedRowsInBatches(rows, label) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    let totalInserted = 0;
    for (let index = 0; index < rows.length; index += EXTENSION_SYNC_BATCH_SIZE) {
        const batch = rows.slice(index, index + EXTENSION_SYNC_BATCH_SIZE);
        const { error } = await supabaseClient
            .from('synced_items')
            .insert(batch);

        if (error) {
            console.error(`[Canvascope Sync] ${label} batch insert error at offset ${index}:`, error);
            continue;
        }

        totalInserted += batch.length;
    }

    return totalInserted;
}

async function performSyncIndexedContentToSupabase() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return { success: false, error: 'Not signed in' };

    const userId = session.user.id;

    const storageData = await chrome.storage.local.get([
        'indexedContent',
        COURSE_CATALOG_STORAGE_KEY,
        COURSE_SNAPSHOTS_STORAGE_KEY
    ]);
    const lightweightItems = storageData.indexedContent || [];
    const courseCatalog = Array.isArray(storageData[COURSE_CATALOG_STORAGE_KEY])
        ? storageData[COURSE_CATALOG_STORAGE_KEY]
        : [];
    const courseSnapshots = Array.isArray(storageData[COURSE_SNAPSHOTS_STORAGE_KEY])
        ? storageData[COURSE_SNAPSHOTS_STORAGE_KEY].map((snapshot) => normalizeStoredCourseSnapshot(snapshot))
        : [];
    const richSnapshotItems = flattenSnapshotItems(courseSnapshots);
    const legacyItems = richSnapshotItems.length > 0
        ? richSnapshotItems
        : lightweightItems.map((item) => normalizeStoredSubmissionFields({ sourceApp: 'canvascope_extension', ...item }));

    if (legacyItems.length === 0 && courseCatalog.length === 0 && courseSnapshots.length === 0) {
        return { success: true, synced: 0, message: 'No items to sync' };
    }

    console.log(`[Canvascope Sync] Syncing ${legacyItems.length} legacy items, ${courseSnapshots.length} course snapshots...`);

    let deletedCount = 0;
    try {
        deletedCount = await clearExtensionOwnedSyncedItems(userId, [...legacyItems, ...lightweightItems]);
    } catch (deleteError) {
        console.error('[Canvascope Sync] Error clearing old items:', deleteError);
    }

    const legacyRows = legacyItems.map((item) => ({
        user_id: userId,
        item_type: item.type || 'unknown',
        item_data: {
            sourceApp: 'canvascope_extension',
            ...item
        },
        sync_status: 'synced'
    }));

    const catalogRows = courseCatalog.length > 0
        ? [{
            user_id: userId,
            item_type: COURSE_CATALOG_ITEM_TYPE,
            item_data: {
                schemaVersion: COURSE_SNAPSHOT_SCHEMA_VERSION,
                sourceApp: 'canvascope_extension',
                generatedAt: new Date().toISOString(),
                courseCatalog
            },
            sync_status: 'synced'
        }]
        : [];

    const snapshotRows = courseSnapshots.map((snapshot) => ({
        user_id: userId,
        item_type: COURSE_SNAPSHOT_ITEM_TYPE,
        item_data: snapshot,
        sync_status: 'synced'
    }));

    const legacySynced = await insertSyncedRowsInBatches(legacyRows, 'legacy');
    const catalogSynced = await insertSyncedRowsInBatches(catalogRows, 'catalog');
    const snapshotSynced = await insertSyncedRowsInBatches(snapshotRows, 'snapshot');
    const totalSynced = legacySynced + catalogSynced + snapshotSynced;

    console.log(`[Canvascope Sync] Done! Synced ${totalSynced} rows after clearing ${deletedCount} extension-owned rows.`);
    return {
        success: true,
        synced: totalSynced,
        deleted: deletedCount,
        legacySynced,
        catalogSynced,
        snapshotSynced,
        totalLegacyItems: legacyItems.length,
        totalCourseSnapshots: courseSnapshots.length
    };
}

async function syncIndexedContentToSupabase() {
    if (syncIndexedContentPromise) {
        syncIndexedContentNeedsRerun = true;
        return syncIndexedContentPromise;
    }

    syncIndexedContentPromise = (async () => {
        let lastResult = null;
        do {
            syncIndexedContentNeedsRerun = false;
            lastResult = await performSyncIndexedContentToSupabase();
        } while (syncIndexedContentNeedsRerun);
        return lastResult;
    })();

    try {
        return await syncIndexedContentPromise;
    } finally {
        syncIndexedContentPromise = null;
        syncIndexedContentNeedsRerun = false;
    }
}

/**
 * Wipe extension-owned synced_items for the authenticated user in Supabase.
 * Triggered when the user clears their local data.
 */
async function clearIndexedContentFromSupabase() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return { success: false, error: 'Not signed in' };

    const userId = session.user.id;
    console.log(`[Canvascope Sync] Clearing extension synced_items for user ${userId}...`);

    const storageData = await chrome.storage.local.get([
        'indexedContent',
        COURSE_SNAPSHOTS_STORAGE_KEY
    ]);
    const localItems = Array.isArray(storageData.indexedContent) ? storageData.indexedContent : [];
    const snapshotItems = flattenSnapshotItems(storageData[COURSE_SNAPSHOTS_STORAGE_KEY]);

    try {
        const deleted = await clearExtensionOwnedSyncedItems(userId, [...localItems, ...snapshotItems]);
        return { success: true, deleted };
    } catch (deleteError) {
        console.error('[Canvascope Sync] Error clearing items from Supabase:', deleteError);
        return { success: false, error: deleteError.message };
    }
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

    // Slash overlay: fetch full indexed content array. Merges in user-authored
    // custom todos and dashboard notes so they are searchable in the slash
    // palette alongside Canvas content (mirrors popup.js's loadContent merge).
    if (message.action === 'getIndexedContent') {
        chrome.storage.local.get(['indexedContent', 'customTodos', 'dashboardNotes']).then(data => {
            const base = Array.isArray(data.indexedContent) ? data.indexedContent.slice() : [];
            const todos = Array.isArray(data.customTodos) ? data.customTodos : [];
            const notes = Array.isArray(data.dashboardNotes) ? data.dashboardNotes : [];
            for (const t of todos) {
                if (!t || !t.id) continue;
                base.push({
                    id: 'todo:' + t.id,
                    type: 'todo',
                    title: t.title || 'Untitled todo',
                    url: '#cs-todo-' + t.id,
                    dueAt: t.dueAt || null,
                    courseName: t.courseName || '',
                    moduleName: 'My todos',
                    searchAliases: ['todo', 'task']
                });
            }
            for (const n of notes) {
                if (!n || !n.id) continue;
                base.push({
                    id: 'note:' + n.id,
                    type: 'note',
                    title: n.title || 'Untitled note',
                    url: '#cs-note-' + n.id,
                    moduleName: 'Notes',
                    folderPath: (n.body || '').slice(0, 240),
                    searchAliases: ['note']
                });
            }
            sendResponse({ items: base });
        });
        return true;
    }

    // Slash overlay: fetch extension settings
    if (message.action === 'getExtensionSettings') {
        getExtensionSettings().then(settings => {
            sendResponse({ settings });
        }).catch(() => {
            sendResponse({ settings: DEFAULT_EXTENSION_SETTINGS });
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

    if (message.action === 'dropbridgeGetReceiverContext') {
        (async () => {
            try {
                const payload = await buildDropBridgeV2ReceiverContext();
                sendResponse(payload);
            } catch (error) {
                sendResponse({
                    success: false,
                    enabled: DROPBRIDGE_V2_ENABLED,
                    signedIn: false,
                    error: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'dropbridgeReceiverWake') {
        (async () => {
            try {
                const wakeReason = String(message.reason || 'offscreen');
                const topic = message.topic ? String(message.topic) : null;
                const uploadId = message.uploadId ? String(message.uploadId) : null;
                void updateDropBridgeV2Diagnostics({
                    lastWakeAt: new Date().toISOString(),
                    lastWakeReason: wakeReason,
                    lastWakeTopic: topic
                }, {
                    type: 'receiver_wake',
                    reason: wakeReason,
                    topic,
                    uploadId
                });
                let handledByTargetedClaim = false;
                if (uploadId) {
                    handledByTargetedClaim = await tryClaimAndProcessDropBridgeV2UploadById({
                        uploadId,
                        reason: `offscreen-${wakeReason}`
                    });
                }

                if (!handledByTargetedClaim) {
                    await requestDropBridgeV2Poll(`offscreen-${wakeReason}`);
                }
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'dropbridgeReceiverStatus') {
        (async () => {
            try {
                const status = String(message.status || 'unknown').toLowerCase();
                const reason = message.reason ? String(message.reason) : null;
                const patch = {
                    receiverStatus: status,
                    receiverStatusAt: new Date().toISOString(),
                    receiverTopic: message.topic ? String(message.topic) : null,
                    receiverError: message.error ? String(message.error) : (status === 'subscribed' ? null : undefined)
                };
                if (status === 'subscribed') {
                    patch.receiverSubscribedAt = patch.receiverStatusAt;
                }
                await updateDropBridgeV2Diagnostics(patch, {
                    type: 'receiver_status',
                    status,
                    reason,
                    topic: patch.receiverTopic,
                    error: message.error ? String(message.error) : null
                });

                if (shouldRestartDropBridgeReceiverFromStatus(status, reason)) {
                    void ensureDropBridgeV2LoopWarm(`receiver-status-${status}`, {
                        force: true,
                        restart: true
                    }).catch((error) => {
                        console.warn('[DropBridge v2] Receiver restart after status failed:', parseErrorMessage(error));
                    });
                }
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'ensureDropBridgeReceiver') {
        (async () => {
            try {
                const reason = String(message.reason || 'manual-warmup');
                const result = await ensureDropBridgeV2LoopWarm(reason, {
                    force: Boolean(message.force),
                    restart: Boolean(message.restart)
                });
                sendResponse({
                    success: true,
                    ...result
                });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'resolvePdfContext') {
        (async () => {
            try {
                const mode = message.mode === 'sender_tab' ? 'sender_tab' : 'active_tab';
                const payload = await resolvePdfContextFromMessage({ mode, sender });
                sendResponse(payload);
            } catch (error) {
                sendResponse({
                    success: false,
                    hasPdf: false,
                    confidence: 'none',
                    candidateUrl: null,
                    sourcePageUrl: null,
                    titleHint: null,
                    reason: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'resolvePdfViewerOverlayContext') {
        (async () => {
            try {
                const tab = sender?.tab
                    ? sender.tab
                    : await resolveTargetTabForPdfMode('active_tab', sender);
                pdfViewerDebug('Message: resolvePdfViewerOverlayContext', {
                    senderTabId: sender?.tab?.id || null,
                    resolvedTabId: tab?.id || null,
                    resolvedTabUrl: tab?.url || null
                });
                const payload = await resolvePdfViewerOverlayContextForTab(tab);
                sendResponse(payload);
            } catch (error) {
                pdfViewerDebug('Message: resolvePdfViewerOverlayContext failed', parseErrorMessage(error));
                sendResponse({
                    success: false,
                    showButton: false,
                    candidateUrl: null,
                    sourcePageUrl: null,
                    titleHint: null,
                    reason: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'syncPdfViewerOverlayRegistration') {
        (async () => {
            try {
                pdfViewerDebug('Message: syncPdfViewerOverlayRegistration', {
                    reason: message.reason || 'message'
                });
                const payload = await syncPdfViewerOverlayRegistration(message.reason || 'message');
                sendResponse(payload);
            } catch (error) {
                pdfViewerDebug('Message: syncPdfViewerOverlayRegistration failed', parseErrorMessage(error));
                sendResponse({
                    success: false,
                    enabled: false,
                    matches: [],
                    reason: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'debugPdfViewerOverlayActiveTab') {
        (async () => {
            try {
                const payload = await runPdfViewerActiveTabDiagnostics();
                sendResponse({
                    success: true,
                    diagnostics: payload
                });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: parseErrorMessage(error)
                });
            }
        })();
        return true;
    }

    if (message.action === 'sendPdfToLectra') {
        (async () => {
            try {
                const result = await sendPdfToLectraFromMessage({
                    trigger: message.trigger || 'unknown',
                    candidateUrl: message.candidateUrl || null,
                    sourcePageUrl: message.sourcePageUrl || null,
                    titleHint: message.titleHint || null,
                    sender
                });
                sendResponse(result);
            } catch (error) {
                sendResponse({
                    success: false,
                    code: 'unexpected_error',
                    message: parseErrorMessage(error)
                });
            }
        })();
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

chrome.runtime.onStartup.addListener(() => {
    dropBridgeDebug('runtime.onStartup fired');
    bootstrapDropBridgeV2FromWorkerStart('runtime-startup').catch((error) => {
        console.error('[DropBridge v2] Runtime startup failure:', parseErrorMessage(error));
    });
    syncPdfViewerOverlayRegistration('runtime-startup').catch((error) => {
        console.warn('[Canvascope PDF Viewer] Failed to sync overlay registration on startup:', parseErrorMessage(error));
    });
});

dropBridgeDebug('service worker immediate bootstrap call');
bootstrapDropBridgeV2FromWorkerStart('service-worker-start').catch((error) => {
    console.error('[DropBridge v2] Service worker bootstrap failure:', parseErrorMessage(error));
});
syncPdfViewerOverlayRegistration('service-worker-start').catch((error) => {
    console.warn('[Canvascope PDF Viewer] Failed to sync overlay registration on worker start:', parseErrorMessage(error));
});
