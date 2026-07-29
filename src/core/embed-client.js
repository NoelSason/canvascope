// Canvascope embed client — the only way consumers talk to the offscreen
// embedding host.
//
// Contract: every method resolves; failures resolve to null (callers fall
// back to the hash space). Exactly ONE ensure+retry happens on "receiving
// end does not exist" — the shared-offscreen close/create races are benign
// only because no extra retry loops exist on top of it.
//
// Works in the service worker (direct chrome.offscreen ensure via the
// background's ensureSharedOffscreenDocument global) and in extension pages
// (popup), which cannot touch chrome.offscreen and relay the ensure through
// the background action 'csEmbeddingsEnsureHost'.
(function (globalScope) {
    'use strict';

    if (globalScope.CanvascopeEmbedClient) return;

    function getConfig() {
        return globalScope.CanvascopeEmbeddingsConfig || null;
    }

    // Embed timeouts scale with batch size: a fixed budget makes a large
    // batch time out deterministically, and since the host keeps computing
    // the abandoned job, the next batch queues behind it and times out too.
    function timeoutFor(op, count = 1) {
        const config = getConfig();
        if (op === 'status') return config?.STATUS_TIMEOUT_MS ?? 2000;
        if (op === 'warmup') return config?.WARMUP_TIMEOUT_MS ?? 30000;
        const base = config?.EMBED_TIMEOUT_MS ?? 12000;
        return base + Math.max(0, count - 1) * (config?.EMBED_TIMEOUT_PER_TEXT_MS ?? 1500);
    }

    // "receiving end does not exist" happens when NO context has a listener.
    // From a page, the service worker's listeners always exist but fall
    // through cs-embeddings messages without responding, so a missing
    // offscreen doc surfaces as "message port closed before a response was
    // received" instead — both mean "no host answered; ensure and retry once".
    const NO_RECEIVER_RE = /receiving end does not exist|could not establish connection|message port closed/i;

    function sendToHost(message, timeoutMs) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (!settled) {
                    settled = true;
                    resolve(value);
                }
            };
            const timer = setTimeout(() => finish({ __timeout: true }), timeoutMs);
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    clearTimeout(timer);
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        finish({ __error: String(lastError.message || lastError) });
                        return;
                    }
                    finish(response && typeof response === 'object' ? response : { __error: 'empty response' });
                });
            } catch (error) {
                clearTimeout(timer);
                finish({ __error: String(error?.message || error) });
            }
        });
    }

    async function ensureHost(reason) {
        try {
            if (typeof globalScope.ensureSharedOffscreenDocument === 'function') {
                return Boolean(await globalScope.ensureSharedOffscreenDocument(reason));
            }
            const response = await sendToHost({ action: 'csEmbeddingsEnsureHost', reason }, timeoutFor('warmup'));
            return Boolean(response && response.success);
        } catch (_) {
            return false;
        }
    }

    // A cold host has to build a 21MB WASM runtime and a 34MB ONNX graph before
    // it can answer anything, and with ORT_PROXY=false that happens on the
    // offscreen document's main thread. The normal embed budget is sized for a
    // loaded model and cannot cover that, so ask the host what state it is in
    // and, when it is not ready yet, wait on the warmup budget instead. Callers
    // are debounced and guarded against stale repaints, so a late vector is
    // safe; a prematurely abandoned one is not, because nothing retries it.
    async function budgetFor(op, count) {
        const normal = timeoutFor(op, count);
        if (op === 'status' || op === 'warmup') return normal;
        const probe = await sendToHost({ target: 'cs-embeddings', op: 'status' }, timeoutFor('status'));
        const state = probe && probe.success ? probe.state : null;
        // A probe that fails or times out means the host is absent or wedged on
        // a load — both are the cold case, so take the larger budget.
        if (state === 'ready') return normal;
        return Math.max(normal, timeoutFor('warmup'));
    }

    // One send, one ensure+retry when no host answered, null on anything else.
    async function request(op, payload, reason) {
        const message = { target: 'cs-embeddings', op, ...payload };
        const count = Array.isArray(payload?.texts) ? payload.texts.length : 1;
        const budget = await budgetFor(op, count);
        let response = await sendToHost(message, budget);
        // A timeout resolves {__timeout:true} with NO __error, so testing only
        // __error here silently skipped the retry for the single failure mode
        // that actually occurs in practice — a cold host that overran the
        // budget. Both branches mean "nobody answered": ensure and try once more.
        const noHost = (response.__error && NO_RECEIVER_RE.test(response.__error)) || response.__timeout;
        if (noHost) {
            const ensured = await ensureHost(reason || `embed-${op}`);
            if (!ensured) return null;
            response = await sendToHost(message, Math.max(budget, timeoutFor('warmup')));
        }
        if (response.__error || response.__timeout || !response.success) {
            // Surface WHY in the caller's console. The host runs in the
            // offscreen document, whose console nobody thinks to open — a bare
            // null here made model-load failures undebuggable.
            const why = response.__timeout
                ? `timed out after ${Math.max(budget, timeoutFor('warmup'))}ms (host never became ready)`
                : (response.__error || response.error || 'unknown error');
            globalScope.console?.warn?.(`[Canvascope Embed] ${op} failed: ${why}`);
            return null;
        }
        return response;
    }

    // ------------------------------------------------------------ query LRU

    const queryCache = new Map();

    function lruGet(key) {
        if (!queryCache.has(key)) return null;
        const value = queryCache.get(key);
        queryCache.delete(key);
        queryCache.set(key, value);
        return value;
    }

    function lruSet(key, value) {
        const limit = getConfig()?.QUERY_LRU_SIZE ?? 32;
        if (queryCache.has(key)) queryCache.delete(key);
        queryCache.set(key, value);
        while (queryCache.size > limit) {
            queryCache.delete(queryCache.keys().next().value);
        }
    }

    // -------------------------------------------------------------- public

    // The bge query prefix is applied HOST-side (keyed off kind:'query') so
    // no caller can forget it; the text sent here is the bare query.
    async function embedQuery(text) {
        const clean = String(text || '').trim();
        if (!clean) return null;
        const cached = lruGet(clean);
        if (cached) return cached;
        const response = await request('embedText', { text: clean, kind: 'query' });
        if (!response || !Array.isArray(response.vector)) return null;
        const vector = Float32Array.from(response.vector);
        lruSet(clean, vector);
        return vector;
    }

    async function embedPassages(texts) {
        if (!Array.isArray(texts) || texts.length === 0) return [];
        const response = await request('embedBatch', { texts: texts.map(t => String(t || '')), kind: 'passage' });
        if (!response || !Array.isArray(response.vectors)) return texts.map(() => null);
        return texts.map((_, i) => {
            const vector = response.vectors[i];
            return Array.isArray(vector) ? Float32Array.from(vector) : null;
        });
    }

    async function status() {
        const response = await request('status', {});
        return response || null;
    }

    async function warmup() {
        const response = await request('warmup', {}, 'embed-warmup');
        return response ? true : null;
    }

    async function unload() {
        const response = await request('unload', {});
        return response ? true : null;
    }

    globalScope.CanvascopeEmbedClient = Object.freeze({
        embedQuery,
        embedPassages,
        status,
        warmup,
        unload
    });
})(typeof self !== 'undefined' ? self : globalThis);
