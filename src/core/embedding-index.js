// Canvascope embedding index — persisted int8 vector store for the on-device
// bge-small embedding engine.
//
// Storage layout (chrome.storage.local, key CanvascopeEmbeddingsConfig
// .INDEX_STORAGE_KEY):
//   { schemaVersion: 1, modelId, dims, updatedAt, pageBudget?,
//     vectors: { "<itemKey or itemKey#pN>": { h, s, v, t } } }
// where h = FNV-1a hash of the embedded text (incremental-sync key),
// s = per-vector dequant scale (string), v = base64 int8 payload,
// t = embed timestamp (quota-eviction ordering).
//
// Vector spaces are never mixed: a modelId mismatch makes load() return null
// (callers fall back to the hash path) and sync() rebuild from empty.
//
// Loaded as a classic script in the service worker (importScripts), the popup
// (script tag), and node tests / the eval harness (new Function). chrome.* is
// therefore only touched behind existence guards, and nothing here has load
// side effects beyond the listener registration below.
(function (globalScope) {
    'use strict';

    if (globalScope.CanvascopeEmbeddingIndex) return;

    function getConfig() {
        return globalScope.CanvascopeEmbeddingsConfig || null;
    }

    // Used only when the config global is absent — i.e. this file loaded
    // standalone (the Phase 3 eval harness). Every value MUST match
    // embeddings-config.js: a divergence here silently embeds the eval corpus
    // in a different vector space than the extension. tests/embeddings-config
    // pins them equal. (EMBED_BATCH_SIZE and INDEX_WRITE_EVERY_BATCHES had
    // already drifted to 12/8 against the config's 6/40 before that test existed.)
    const FALLBACK = {
        MODEL_ID: 'bge-small-en-v1.5-q8',
        DIMS: 384,
        INDEX_STORAGE_KEY: 'embeddingIndex',
        INDEX_SCHEMA_VERSION: 1,
        INDEX_VECTOR_CAP: 12000,
        INDEX_MAX_PAGE_VECTORS_PER_ITEM: 120,
        INDEX_MAX_PAGE_VECTORS_TOTAL: 3500,
        INDEX_ITEM_BODY_MAX_CHARS: 800,
        INDEX_PAGE_BODY_MAX_CHARS: 1200,
        INDEX_MIN_RELOAD_INTERVAL_MS: 5000,
        EMBED_BATCH_SIZE: 6,
        INDEX_WRITE_EVERY_BATCHES: 40
    };

    function cfg(name) {
        const config = getConfig();
        return (config && config[name] !== undefined) ? config[name] : FALLBACK[name];
    }

    // ---------------------------------------------------------------- keys

    function itemKey(item) {
        const course = (item.courseId !== null && item.courseId !== undefined && item.courseId !== '')
            ? String(item.courseId)
            : String(item.courseName || '');
        return [String(item.type || ''), course, String(item.url || ''), String(item.title || '')].join('|');
    }

    function pageKey(item, pageNum) {
        return itemKey(item) + '#p' + pageNum;
    }

    // Chunks from RAGCore.buildChunkIndex carry no key string — they carry the
    // provenance fields, so the key is reconstructed. page === null (bodyless
    // items, legacy string pages) resolves to the base item key.
    function keyForChunk(chunk) {
        if (Number.isFinite(chunk.page) && chunk.page > 0) {
            return itemKey(chunk) + '#p' + chunk.page;
        }
        return itemKey(chunk);
    }

    // FNV-1a 32-bit, 8-char hex (same algorithm as course-materials.js
    // stableHash, which is IIFE-private and not importable).
    function textHash(text) {
        let h = 0x811c9dc5;
        const str = String(text || '');
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }

    // ------------------------------------------------------- canonical text

    // THE canonical passage text. The Phase 3 eval harness loads this exact
    // file to embed corpus items — any change here changes the vector space
    // in practice, so treat edits like a MODEL_ID bump.
    function cleanField(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function passageText(item) {
        const course = item.courseCode || item.courseName || '';
        const path = item.folderPath || item.moduleName || '';
        const body = String(item.content || '').slice(0, cfg('INDEX_ITEM_BODY_MAX_CHARS'));
        return [item.title, course, item.type, path, body]
            .map(cleanField)
            .filter(Boolean)
            .join('\n');
    }

    // Page bodies get a larger cap than item bodies: an item body is a summary
    // field, a page body is the payload. See INDEX_PAGE_BODY_MAX_CHARS.
    function passagePageText(item, pageText) {
        const course = item.courseCode || item.courseName || '';
        const path = item.folderPath || item.moduleName || '';
        const body = String(pageText || '').slice(0, cfg('INDEX_PAGE_BODY_MAX_CHARS'));
        return [item.title, course, item.type, path, body]
            .map(cleanField)
            .filter(Boolean)
            .join('\n');
    }

    // ------------------------------------------------------------ int8 codec

    // String.fromCharCode.apply blows the stack past ~65k args; chunking keeps
    // the codec safe for arbitrary payloads (a single 384-dim vector is one
    // chunk anyway).
    const B64_CHUNK = 0x2000;

    function bytesToBase64(u8) {
        let binary = '';
        for (let i = 0; i < u8.length; i += B64_CHUNK) {
            binary += String.fromCharCode.apply(null, u8.subarray(i, i + B64_CHUNK));
        }
        return btoa(binary);
    }

    function base64ToBytes(b64) {
        const binary = atob(b64);
        const u8 = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
        return u8;
    }

    function quantize(vector) {
        let maxAbs = 1e-8;
        for (let i = 0; i < vector.length; i++) {
            const a = Math.abs(vector[i]);
            if (a > maxAbs) maxAbs = a;
        }
        const s = maxAbs / 127;
        const q = new Int8Array(vector.length);
        for (let i = 0; i < vector.length; i++) {
            q[i] = Math.max(-127, Math.min(127, Math.round(vector[i] / s)));
        }
        return { s: s.toPrecision(8), v: bytesToBase64(new Uint8Array(q.buffer)) };
    }

    // Dequantize + renormalize to unit length (keeps cosine error <0.5%).
    function dequantize(entry) {
        const bytes = base64ToBytes(entry.v);
        const int8 = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
        const scale = Number(entry.s);
        const f = new Float32Array(int8.length);
        let norm = 0;
        for (let i = 0; i < int8.length; i++) {
            const value = int8[i] * scale;
            f[i] = value;
            norm += value * value;
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < f.length; i++) f[i] /= norm;
        }
        return f;
    }

    // ------------------------------------------------------------- load()

    const cache = { promise: null, loadedAt: 0, dirty: false };

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            if (Object.prototype.hasOwnProperty.call(changes, cfg('INDEX_STORAGE_KEY'))) {
                cache.dirty = true;
            }
        });
    }

    async function readRawStore() {
        const key = cfg('INDEX_STORAGE_KEY');
        const db = await chrome.storage.local.get([key]);
        const raw = db[key];
        return (raw && typeof raw === 'object') ? raw : null;
    }

    function isCurrentSpace(raw) {
        return Boolean(raw
            && raw.schemaVersion === cfg('INDEX_SCHEMA_VERSION')
            && raw.modelId === cfg('MODEL_ID')
            && raw.dims === cfg('DIMS')
            && raw.vectors && typeof raw.vectors === 'object');
    }

    async function decodeStore() {
        const raw = await readRawStore(); // throws on storage failure — see load()
        if (!isCurrentSpace(raw)) return null;

        const dims = cfg('DIMS');
        const keys = Object.keys(raw.vectors);
        const byKey = new Map();
        // Derived here so consumers can reach an item's page vectors without
        // carrying item.pages: popup.js builds its corpus straight from
        // state.indexedContent and has no pages array to probe against.
        const pagesByItem = new Map(); // baseItemKey -> [{ page, row }]
        const matrix = new Float32Array(keys.length * dims);
        let row = 0;
        for (const key of keys) {
            const entry = raw.vectors[key];
            let f;
            try {
                f = dequantize(entry);
            } catch (_) {
                continue;
            }
            if (f.length !== dims) continue;
            matrix.set(f, row * dims);
            byKey.set(key, row);
            // Split on the LAST '#p' followed by digits only. itemKey embeds a
            // url and a title, either of which may contain '#p' — a mis-split
            // would produce a base key no corpus item ever looks up, so the
            // failure mode is a wasted map entry, never a wrong row. Registered
            // after the dequantize `continue` above, so rows stay aligned with
            // the compaction for free.
            const marker = key.lastIndexOf('#p');
            if (marker > 0) {
                const suffix = key.slice(marker + 2);
                if (/^\d+$/.test(suffix)) {
                    const page = Number(suffix);
                    if (page > 0) {
                        const base = key.slice(0, marker);
                        const list = pagesByItem.get(base);
                        if (list) list.push({ page, row });
                        else pagesByItem.set(base, [{ page, row }]);
                    }
                }
            }
            keys[row] = key;
            row++;
        }
        keys.length = row;
        // Object.keys order follows store insertion, which prune/re-add churn
        // permutes; sorting keeps the reported page number stable across
        // repaints when two pages tie on cosine.
        for (const list of pagesByItem.values()) list.sort((a, b) => a.page - b.page);
        return {
            modelId: raw.modelId,
            dims,
            updatedAt: raw.updatedAt || 0,
            count: row,
            keys,
            byKey,
            pagesByItem,
            matrix,
            raw
        };
    }

    // Cached singleton. Serves a ≤5s-stale decoded handle while a background
    // sync is streaming incremental writes so the popup never re-decodes the
    // full store more than once per interval, and never on the keystroke path.
    function load(options = {}) {
        const now = Date.now();
        if (cache.promise && !options.force) {
            if (!cache.dirty) return cache.promise;
            if (now - cache.loadedAt < cfg('INDEX_MIN_RELOAD_INTERVAL_MS')) return cache.promise;
        }
        cache.dirty = false;
        cache.loadedAt = now;
        cache.promise = decodeStore().catch(() => {
            // Transient storage failure must never be cached: a legit-absent
            // index only changes via an embeddingIndex write (which flips
            // dirty), but a failed READ would otherwise pin null for the
            // whole context lifetime. Clearing the promise makes the next
            // load() retry instead.
            cache.promise = null;
            return null;
        });
        return cache.promise;
    }

    function cosineRow(handle, row, query) {
        const dims = handle.dims;
        const base = row * dims;
        let dot = 0;
        for (let i = 0; i < dims; i++) dot += handle.matrix[base + i] * query[i];
        return dot;
    }

    // ------------------------------------------------- wanted-entry planning

    function itemRecency(item) {
        return item.indexedAt || item.scannedAt || item.updatedAt || item.createdAt || 0;
    }

    // Every corpus item gets an item-level vector; items with numbered pages
    // additionally get page vectors mirroring buildChunkIndex's iteration
    // (rag-core.js buildChunkIndex — string pages / missing pageNum produce
    // page:null chunks there, which resolve to the item vector via
    // keyForChunk, so they deliberately get no page entry here).
    function computeWantedEntries(corpus, options = {}) {
        const wanted = new Map();
        const pageEntries = [];
        const maxPagesPerItem = cfg('INDEX_MAX_PAGE_VECTORS_PER_ITEM');

        for (const item of corpus) {
            if (!item || !item.title) continue;
            const key = itemKey(item);
            const recency = itemRecency(item);
            if (!wanted.has(key)) {
                wanted.set(key, { key, kind: 'item', text: passageText(item), recency });
            }
            if (!Array.isArray(item.pages) || item.pages.length === 0) continue;
            let pagesTaken = 0;
            for (const page of item.pages) {
                if (pagesTaken >= maxPagesPerItem) break;
                const text = typeof page === 'string' ? page : ((page && page.text) ? String(page.text) : '');
                if (!text.trim()) continue;
                const pageNum = typeof page === 'string' ? null : (page.pageNum || null);
                if (!Number.isFinite(pageNum) || pageNum <= 0) continue;
                pageEntries.push({
                    key: pageKey(item, pageNum),
                    kind: 'page',
                    text: passagePageText(item, text),
                    recency
                });
                pagesTaken++;
            }
        }

        // Item vectors always win; page vectors fill the remaining budget
        // newest-item-first. Deterministic: identical corpus → identical
        // truncation set → no add/evict churn.
        //
        // INDEX_MAX_PAGE_VECTORS_TOTAL is the load-bearing limit, not the
        // dynamic pageBudget: that only ratchets down on a QUOTA_BYTES error,
        // and `unlimitedStorage` means the quota never fires.
        const itemCount = wanted.size;
        const cap = cfg('INDEX_VECTOR_CAP');
        const hardPageCap = cfg('INDEX_MAX_PAGE_VECTORS_TOTAL');
        const pageBudget = Math.min(
            Number.isFinite(options.pageBudget) ? options.pageBudget : Infinity,
            Number.isFinite(hardPageCap) ? hardPageCap : Infinity,
            cap - itemCount
        );
        pageEntries.sort((a, b) => b.recency - a.recency);
        let taken = 0;
        for (const entry of pageEntries) {
            if (taken >= pageBudget) break;
            if (wanted.has(entry.key)) continue;
            wanted.set(entry.key, { key: entry.key, kind: 'page', text: entry.text, recency: entry.recency });
            taken++;
        }
        // Truncation here is silent by nature, and a silent zero is exactly how
        // "4245 vectors, 0 pages" shipped unnoticed. Report the numbers so the
        // sync log can name them.
        if (options.stats && typeof options.stats === 'object') {
            options.stats.itemCount = itemCount;
            options.stats.pageCandidates = pageEntries.length;
            options.stats.pagesTaken = taken;
            options.stats.pageBudget = Number.isFinite(pageBudget) ? pageBudget : null;
        }
        return wanted;
    }

    // --------------------------------------------------------------- sync()

    async function writeStore(vectors, pageBudget) {
        const key = cfg('INDEX_STORAGE_KEY');
        const payload = {
            schemaVersion: cfg('INDEX_SCHEMA_VERSION'),
            modelId: cfg('MODEL_ID'),
            dims: cfg('DIMS'),
            updatedAt: Date.now(),
            vectors
        };
        if (Number.isFinite(pageBudget)) payload.pageBudget = pageBudget;
        try {
            await chrome.storage.local.set({ [key]: payload });
            return { pageBudget };
        } catch (writeErr) {
            const msg = String(writeErr?.message || writeErr || '');
            if (!/quota/i.test(msg)) throw writeErr;
            // Same pattern as document-parser.js PDF-cache eviction: drop the
            // 25% of page vectors with the OLDEST item recency (item vectors
            // are immune) and retry once. Recency, not embed time: within a
            // build run pages are embedded newest-item-first, so evicting by
            // embed timestamp would delete exactly the pages ranked highest.
            // The shrunken pageBudget is persisted so the next sync's wanted
            // set stays inside it instead of re-adding what we evict.
            const pageKeys = Object.keys(vectors)
                .filter(k => k.includes('#p'))
                .sort((a, b) => (vectors[a].r ?? vectors[a].t ?? 0) - (vectors[b].r ?? vectors[b].t ?? 0));
            if (pageKeys.length === 0) throw writeErr; // nothing evictable — item vectors alone exceed quota
            const evictCount = Math.max(1, Math.ceil(pageKeys.length / 4));
            for (let i = 0; i < evictCount; i++) delete vectors[pageKeys[i]];
            const newBudget = pageKeys.length - evictCount;
            console.warn(`[Canvascope Embeddings] Storage quota hit; evicted ${evictCount} page vectors (budget now ${newBudget}).`);
            payload.vectors = vectors;
            payload.pageBudget = newBudget;
            payload.updatedAt = Date.now();
            await chrome.storage.local.set({ [key]: payload });
            return { pageBudget: newBudget, evicted: true };
        }
    }

    // Diff-based incremental sync. Resumable by construction: every
    // incremental write is a complete, valid index, and a killed run's
    // remaining work is rediscovered by the next diff (stored h ≠ textHash).
    async function sync(corpus, embedPassagesFn, options = {}) {
        const result = { embedded: 0, skipped: 0, pruned: 0, failed: 0, remaining: 0, aborted: false };

        // A transient storage-read failure aborts the run (caller backs off)
        // rather than being mistaken for "no index" — starting fresh would
        // re-embed thousands of entries and clobber a healthy store with a
        // partial one on the first incremental write.
        let vectors = {};
        let pageBudget = null;
        const raw = await readRawStore();
        if (isCurrentSpace(raw)) {
            vectors = raw.vectors;
            pageBudget = Number.isFinite(raw.pageBudget) ? raw.pageBudget : null;
        }

        const planStats = {};
        const wanted = computeWantedEntries(corpus, { pageBudget, stats: planStats });
        result.plan = planStats;

        for (const key of Object.keys(vectors)) {
            if (!wanted.has(key)) {
                delete vectors[key];
                result.pruned++;
            }
        }

        const todo = [];
        for (const entry of wanted.values()) {
            const existing = vectors[entry.key];
            if (existing && existing.h === textHash(entry.text)) {
                result.skipped++;
            } else {
                todo.push(entry);
            }
        }

        const batchSize = cfg('EMBED_BATCH_SIZE');
        const writeEvery = cfg('INDEX_WRITE_EVERY_BATCHES');
        let batchesSinceWrite = 0;
        let consecutiveNullBatches = 0;
        let dirty = result.pruned > 0;
        let quotaEvicted = false;

        for (let offset = 0; offset < todo.length; offset += batchSize) {
            let batch = todo.slice(offset, offset + batchSize);
            if (quotaEvicted) {
                // Post-eviction: stop adding page vectors this run; the next
                // run replans against the persisted pageBudget.
                batch = batch.filter(entry => entry.kind !== 'page');
                if (batch.length === 0) continue;
            }
            const embeddings = await embedPassagesFn(batch.map(entry => entry.text));
            let nullCount = 0;
            for (let i = 0; i < batch.length; i++) {
                const vector = embeddings && embeddings[i];
                if (!vector || vector.length !== cfg('DIMS')) {
                    nullCount++;
                    result.failed++;
                    continue;
                }
                const quantized = quantize(vector);
                vectors[batch[i].key] = {
                    h: textHash(batch[i].text),
                    s: quantized.s,
                    v: quantized.v,
                    t: Date.now(),
                    r: batch[i].recency || 0
                };
                result.embedded++;
                dirty = true;
            }
            if (nullCount === batch.length) {
                consecutiveNullBatches++;
                if (consecutiveNullBatches >= 3) {
                    result.aborted = true;
                    result.remaining = todo.length - offset - batch.length;
                    break;
                }
            } else {
                consecutiveNullBatches = 0;
            }
            batchesSinceWrite++;
            if (batchesSinceWrite >= writeEvery && dirty) {
                const written = await writeStore(vectors, pageBudget);
                pageBudget = written.pageBudget;
                if (written.evicted) quotaEvicted = true;
                batchesSinceWrite = 0;
                if (typeof options.onProgress === 'function') {
                    options.onProgress({ embedded: result.embedded, remaining: todo.length - offset - batch.length });
                }
            }
        }

        if (dirty) {
            // pageBudget is otherwise a one-way ratchet: an early quota hit
            // during a fresh rebuild would lock a tiny budget forever. A run
            // that finished without eviction earns a modest raise; a future
            // quota error simply ratchets it back down.
            if (!quotaEvicted && Number.isFinite(pageBudget)) {
                pageBudget = Math.min(cfg('INDEX_VECTOR_CAP'), pageBudget + Math.max(8, Math.floor(pageBudget / 4)));
            }
            const written = await writeStore(vectors, pageBudget);
            pageBudget = written.pageBudget;
        }
        return result;
    }

    globalScope.CanvascopeEmbeddingIndex = Object.freeze({
        itemKey,
        pageKey,
        keyForChunk,
        textHash,
        passageText,
        passagePageText,
        quantize,
        dequantize,
        bytesToBase64,
        base64ToBytes,
        load,
        cosineRow,
        computeWantedEntries,
        sync
    });
})(typeof self !== 'undefined' ? self : globalThis);
