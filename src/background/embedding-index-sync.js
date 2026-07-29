// Canvascope embedding index sync — background add-on module (reminders.js
// pattern: separate file, registers its own listeners, loaded by
// background-wrapper.js after the core modules).
//
// Keeps the persisted embeddingIndex in step with the corpus: any write to a
// corpus storage key schedules a one-shot alarm 30s out (same-name
// chrome.alarms.create REPLACES the pending alarm, so a multi-write course
// scan debounces to one sync ~30s after its LAST write). The sync itself is
// diff-based and incrementally written, so a service-worker death mid-run
// costs nothing — the pending watchdog alarm survives and the next run only
// embeds what's still missing. No sync state is persisted anywhere: the
// stored text-hashes ARE the resume state, the pending alarm IS the
// "work remains" bit.
(function (globalScope) {
    'use strict';

    if (globalScope.__canvascopeEmbeddingIndexSyncInit) return;
    globalScope.__canvascopeEmbeddingIndexSyncInit = true;

    const LOG_PREFIX = '[Canvascope Embedding Sync]';
    const ALARM_NAME = 'cs.embeddingIndex.sync';
    // courseMaterialChunks is a corpus input now (buildCorpus hydrates page text
    // from it), so a PDF parse must schedule a resync. Deliberately NOT
    // courseMaterialDocuments: setDocumentStatus rewrites that on every status
    // flip, which would schedule syncs for no text change. writeIndex persists
    // both in one set, so nothing is missed.
    const CORPUS_KEYS = ['indexedContent', 'customTodos', 'dashboardNotes', 'syllabusMemory', 'courseMaterialChunks'];

    function getConfig() {
        return globalScope.CanvascopeEmbeddingsConfig || null;
    }

    let running = false;
    let rerun = false;
    let failRuns = 0;

    function scheduleSync(delayMs) {
        try {
            chrome.alarms.create(ALARM_NAME, { when: Date.now() + delayMs });
        } catch (error) {
            console.warn(`${LOG_PREFIX} failed to schedule:`, error);
        }
    }

    function armWatchdog() {
        scheduleSync(getConfig()?.INDEX_WATCHDOG_MS ?? 120000);
    }

    // Exponential backoff 5m → 60m; after 8 consecutive failed runs stop
    // rescheduling entirely (a missing model dir must not drain battery) —
    // the next corpus change or browser startup re-enters fresh.
    function handleFailure() {
        failRuns += 1;
        if (failRuns > 8) {
            console.warn(`${LOG_PREFIX} giving up after ${failRuns - 1} failed runs; waiting for next trigger.`);
            try { chrome.alarms.clear(ALARM_NAME); } catch (_) { /* nothing pending */ }
            return;
        }
        const delay = Math.min(5 * 60000 * Math.pow(2, failRuns - 1), 60 * 60000);
        scheduleSync(delay);
    }

    async function runSync(reason) {
        if (running) {
            rerun = true;
            return;
        }
        running = true;
        try {
            console.log(`${LOG_PREFIX} run start (reason=${reason})`);

            const EI = globalScope.CanvascopeEmbeddingIndex;
            const client = globalScope.CanvascopeEmbedClient;
            const RAG = globalScope.RAGCore;
            if (!EI || !client || !RAG) {
                // A missing global is a load-order/wiring bug, not a transient
                // condition — retrying on a timer would wake the worker
                // forever and log nothing. Stop and say why.
                console.warn(`${LOG_PREFIX} missing globals; sync disabled this session.`, {
                    index: Boolean(EI), client: Boolean(client), ragCore: Boolean(RAG)
                });
                try { chrome.alarms.clear(ALARM_NAME); } catch (_) { /* nothing pending */ }
                return;
            }

            // Only arm the resume watchdog once there is a real work path —
            // otherwise an early return leaves a 2-minute wake alarm cycling
            // for the life of the profile.
            armWatchdog();

            // warmup is idempotent (no-op on a loaded pipeline) and performs
            // the offscreen ensure via the client's single retry path.
            const warm = await client.warmup();
            if (warm === null) {
                console.warn(`${LOG_PREFIX} model host warmup failed; backing off. Check the offscreen document console for the real error.`);
                handleFailure();
                return;
            }

            const corpus = await RAG.buildCorpus();
            console.log(`${LOG_PREFIX} building index over ${corpus.length} corpus items…`);
            const startedAt = Date.now();
            const result = await EI.sync(corpus, texts => client.embedPassages(texts), {
                onProgress: ({ embedded, remaining }) => {
                    armWatchdog();
                    const elapsed = Math.round((Date.now() - startedAt) / 1000);
                    console.log(`${LOG_PREFIX} embedded ${embedded}, ~${remaining} to go (${elapsed}s elapsed)`);
                }
            });

            if (result.aborted) {
                console.warn(`${LOG_PREFIX} run aborted (host unavailable); ${result.remaining} entries remaining.`);
                handleFailure();
                return;
            }

            if (result.embedded || result.pruned || result.failed) {
                console.log(`${LOG_PREFIX} ${reason}: embedded ${result.embedded}, skipped ${result.skipped}, pruned ${result.pruned}, failed ${result.failed}.`);
            }
            // Always report the plan, even on a pure-skip run. Page truncation is
            // silent inside computeWantedEntries, and a silent zero here is
            // exactly how an index of 4245 items with 0 page vectors shipped
            // without anyone noticing.
            if (result.plan) {
                const { itemCount, pageCandidates, pagesTaken, pageBudget } = result.plan;
                const dropped = (pageCandidates || 0) - (pagesTaken || 0);
                console.log(
                    `${LOG_PREFIX} plan: ${itemCount} item vectors, ${pagesTaken}/${pageCandidates} page vectors`
                    + ` (budget ${pageBudget === null ? 'unbounded' : pageBudget}${dropped > 0 ? `, ${dropped} dropped` : ''}).`
                );
            }
            if (result.failed > 0) {
                // Per-entry failures back off exactly like aborted runs — a
                // deterministic single-batch failure (e.g. one batch that
                // always times out) would otherwise re-run every 30s forever
                // with no give-up. Any progress made was already persisted.
                handleFailure();
            } else {
                failRuns = 0;
                if (rerun) {
                    rerun = false;
                    scheduleSync(getConfig()?.INDEX_DEBOUNCE_MS ?? 30000);
                } else {
                    try { chrome.alarms.clear(ALARM_NAME); } catch (_) { /* nothing pending */ }
                }
            }
        } catch (error) {
            console.warn(`${LOG_PREFIX} run failed:`, error);
            handleFailure();
        } finally {
            running = false;
        }
    }

    // Missing index or modelId mismatch (e.g. a fine-tuned model shipped in
    // an update) → full rebuild. On browser startup also schedule a catch-up
    // diff for corpus drift while the browser was closed — it no-ops in
    // milliseconds when nothing changed.
    async function checkIndexFreshness(trigger) {
        try {
            const EI = globalScope.CanvascopeEmbeddingIndex;
            if (!EI) return;
            const index = await EI.load();
            if (!index) {
                scheduleSync(getConfig()?.INDEX_DEBOUNCE_MS ?? 30000);
            } else if (trigger === 'startup') {
                scheduleSync(60000);
            }
        } catch (error) {
            console.warn(`${LOG_PREFIX} freshness check failed:`, error);
        }
    }

    const featureEnabled = getConfig()?.EMBEDDINGS_ENABLED === true;
    if (!featureEnabled) {
        console.log(`${LOG_PREFIX} disabled (EMBEDDINGS_ENABLED=false); no listeners registered.`);
        globalScope.CanvascopeEmbeddingIndexSync = Object.freeze({ runSync, checkIndexFreshness, enabled: false });
        return;
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!CORPUS_KEYS.some(key => Object.prototype.hasOwnProperty.call(changes, key))) return;
        if (running) {
            rerun = true;
            return;
        }
        scheduleSync(getConfig()?.INDEX_DEBOUNCE_MS ?? 30000);
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name !== ALARM_NAME) return;
        void runSync('alarm');
    });

    if (chrome.runtime.onInstalled) {
        chrome.runtime.onInstalled.addListener(() => void checkIndexFreshness('installed'));
    }
    if (chrome.runtime.onStartup) {
        chrome.runtime.onStartup.addListener(() => void checkIndexFreshness('startup'));
    }

    console.log(`${LOG_PREFIX} module loaded; listeners registered.`);
    globalScope.CanvascopeEmbeddingIndexSync = Object.freeze({
        runSync,
        checkIndexFreshness,
        enabled: true
    });
})(typeof self !== 'undefined' ? self : globalThis);
