// Canvascope embeddings host — runs the on-device bge-small model inside the
// shared offscreen document (co-resident with the DropBridge receiver in
// offscreen.js).
//
// Protocol: any extension context sends {target:'cs-embeddings', op, ...};
// ops are status | warmup | unload | embedText {text, kind} | embedBatch
// {texts, kind}. The bge query prefix is applied HERE for kind 'query' so no
// consumer can forget it. Everything except status goes through one FIFO
// queue; status is answered synchronously from any state and NEVER touches
// the queue or the idle timer — background's close probe must not be a
// keep-alive, or probe→alive→no-close would livelock the shared-doc close.
//
// States: unloaded → loading → ready → disposing → unloaded. Jobs are
// accepted in every state (mid-dispose arrivals re-enter loading once the
// dispose settles), preserving the invariant that state 'unloaded' with a
// non-empty queue never persists — so background's close decision stays
// sound. After 5 idle minutes the pipeline is disposed (WASM memory never
// shrinks; closing/unloading is the only reclaim) and background is notified
// via {action:'csEmbeddingsIdleUnloaded'} — that sendMessage wakes the
// service worker if it's asleep, same as the DropBridge wake path.
(function (globalScope) {
    'use strict';

    if (globalScope.CanvascopeEmbeddingsHost) return;

    const LOG_PREFIX = '[Canvascope Embeddings Host]';

    function getConfig() {
        return globalScope.CanvascopeEmbeddingsConfig || null;
    }

    function cfg(name, fallback) {
        const config = getConfig();
        return (config && config[name] !== undefined) ? config[name] : fallback;
    }

    let state = 'unloaded';
    let pipe = null;
    let loadPromise = null;
    let disposePromise = null;
    let activeJob = null;
    let idleTimer = null;
    let lastUsedAt = 0;
    let lastError = null;
    const queue = [];

    // Injectable seam: tests replace this with a mock pipeline factory.
    let loadPipeline = async function defaultLoadPipeline() {
        const lib = await import(chrome.runtime.getURL(
            cfg('TRANSFORMERS_LIB_PATH', 'src/lib/transformers/transformers.min.js')));
        const { pipeline, env } = lib;
        // allowLocalModels defaults to FALSE in the web build (true only in
        // Node). Without this, disabling remote models leaves both sources
        // off and pipeline() throws "both local and remote models are
        // disabled" — the model never loads.
        env.allowLocalModels = true;
        env.allowRemoteModels = false;
        // The model is already bundled in the extension; letting the runtime
        // also copy it into the Cache API just duplicates 34MB on disk.
        env.useBrowserCache = false;
        env.localModelPath = chrome.runtime.getURL(cfg('MODEL_LOCAL_PATH', 'src/lib/models/'));
        env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL(
            cfg('TRANSFORMERS_WASM_DIR', 'src/lib/transformers/'));
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = cfg('ORT_PROXY', false) === true;
        return pipeline('feature-extraction', cfg('MODEL_DIR', 'bge-small-en-v1.5'), { dtype: 'q8' });
    };

    function clearIdleTimer() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }

    function armIdleTimer() {
        clearIdleTimer();
        if (state !== 'ready' || queue.length > 0 || activeJob) return;
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (state === 'ready' && queue.length === 0 && !activeJob) {
                void disposePipeline('idle');
            }
        }, cfg('IDLE_UNLOAD_MS', 300000));
    }

    function notifyBackground(reason) {
        try {
            chrome.runtime.sendMessage({ action: 'csEmbeddingsIdleUnloaded', reason }, () => {
                void chrome.runtime.lastError;
            });
        } catch (_) { /* doc may be shutting down */ }
    }

    async function disposePipeline(reason) {
        if (state !== 'ready' || !pipe) return;
        state = 'disposing';
        clearIdleTimer();
        const dying = pipe;
        disposePromise = (async () => {
            try {
                await dying.dispose();
            } catch (error) {
                console.warn(`${LOG_PREFIX} dispose failed:`, error);
            }
        })();
        await disposePromise;
        pipe = null;
        disposePromise = null;
        state = 'unloaded';
        notifyBackground(reason);
        // Jobs that arrived mid-dispose re-enter loading now — the invariant
        // "unloaded ⇒ queue empty" is restored by the immediate pump.
        pump();
    }

    async function ensurePipeline() {
        if (pipe) return pipe;
        if (!loadPromise) {
            state = 'loading';
            loadPromise = (async () => {
                try {
                    const loaded = await loadPipeline();
                    pipe = loaded;
                    state = 'ready';
                    lastError = null;
                    return loaded;
                } catch (error) {
                    state = 'unloaded';
                    lastError = { message: String(error?.message || error), at: Date.now() };
                    console.error(`${LOG_PREFIX} model load failed:`, error);
                    throw error;
                } finally {
                    loadPromise = null;
                }
            })();
        }
        return loadPromise;
    }

    function failQueuedJobs(errorMessage) {
        while (queue.length > 0) {
            queue.shift().resolve({ success: false, error: errorMessage });
        }
    }

    function prepareTexts(texts, kind) {
        const prefix = cfg('QUERY_PREFIX', 'Represent this sentence for searching relevant passages: ');
        return texts.map(text => kind === 'query' ? prefix + String(text || '') : String(text || ''));
    }

    async function embed(texts, kind) {
        const pipeline = await ensurePipeline();
        const prepared = prepareTexts(texts, kind);
        const output = await pipeline(prepared, { pooling: 'mean', normalize: true });
        const dims = cfg('DIMS', 384);
        const vectors = [];
        for (let i = 0; i < prepared.length; i++) {
            vectors.push(Array.from(output.data.slice(i * dims, (i + 1) * dims)));
        }
        return vectors;
    }

    async function runJob(job) {
        try {
            if (job.op === 'warmup') {
                await ensurePipeline();
                return { success: true, state };
            }
            if (job.op === 'unload') {
                clearIdleTimer();
                if (state === 'ready' && pipe) {
                    await disposePipeline('unload');
                }
                return { success: true, state };
            }
            if (job.op === 'embedText') {
                const vectors = await embed([job.text], job.kind);
                return { success: true, vector: vectors[0] };
            }
            if (job.op === 'embedBatch') {
                const vectors = await embed(job.texts, job.kind);
                return { success: true, vectors };
            }
            return { success: false, error: `Unknown op: ${job.op}` };
        } catch (error) {
            const message = String(error?.message || error);
            lastError = { message, at: Date.now() };
            // A failed model load takes the whole queue down with it — every
            // queued job would just re-fail the same load; clients null-
            // fallback and the next incoming job may retry fresh. Notify
            // background too: the idle-dispose path never runs from here
            // (armIdleTimer only arms in 'ready'), and without the notify an
            // embeddings-only doc whose load failed would linger until the
            // next DropBridge stop/bootstrap sweep.
            if (state !== 'ready') {
                failQueuedJobs(message);
                if (!pipe && queue.length === 0) notifyBackground('load-failed');
            }
            return { success: false, error: message };
        }
    }

    function pump() {
        if (activeJob || queue.length === 0) return;
        if (state === 'disposing') return; // re-pumped when the dispose settles
        activeJob = queue.shift();
        const job = activeJob;
        runJob(job).then((response) => {
            job.resolve(response);
        }).catch((error) => {
            job.resolve({ success: false, error: String(error?.message || error) });
        }).finally(() => {
            activeJob = null;
            lastUsedAt = Date.now();
            armIdleTimer();
            pump();
        });
    }

    function enqueue(job) {
        clearIdleTimer();
        return new Promise((resolve) => {
            queue.push({ ...job, resolve });
            pump();
        });
    }

    function statusResponse() {
        return {
            success: true,
            state,
            modelId: cfg('MODEL_ID', 'bge-small-en-v1.5-q8'),
            queueLength: queue.length + (activeJob ? 1 : 0),
            lastUsedAt,
            lastError: lastError ? lastError.message : null
        };
    }

    function handleMessage(message) {
        const op = message.op;
        if (op === 'status') return Promise.resolve(statusResponse());
        if (op === 'warmup' || op === 'unload') return enqueue({ op });
        if (op === 'embedText') {
            return enqueue({ op, text: String(message.text || ''), kind: message.kind || 'passage' });
        }
        if (op === 'embedBatch') {
            const texts = Array.isArray(message.texts) ? message.texts : [];
            return enqueue({ op, texts, kind: message.kind || 'passage' });
        }
        return Promise.resolve({ success: false, error: `Unknown op: ${op}` });
    }

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (!message || message.target !== 'cs-embeddings') return false;
            handleMessage(message)
                .then(sendResponse)
                .catch((error) => sendResponse({ success: false, error: String(error?.message || error) }));
            return true;
        });
    }

    globalScope.CanvascopeEmbeddingsHost = Object.freeze({
        handleMessage,
        getState: () => state,
        setLoadPipeline: (fn) => { loadPipeline = fn; }
    });
})(typeof self !== 'undefined' ? self : globalThis);
