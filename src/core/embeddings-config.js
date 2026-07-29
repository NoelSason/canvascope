// Canvascope embeddings configuration (single source of truth).
//
// Frozen constants for the on-device bge-small embedding engine: model
// identity, storage schema, batching/debounce cadences, and the retrieval
// thresholds keyed by vector space ('hash' = legacy 24-concept fallback,
// 'bge' = real model). Consumers read via:
//   const CFG = (typeof self !== 'undefined' ? self : globalThis).CanvascopeEmbeddingsConfig || null;
//   const x = CFG?.THRESHOLDS?.hash?.chunk ?? 0.15;   // legacy literal preserved where CFG is absent
// The config global never reaches tab-injected scripts (document-parser),
// so the `??` fallback must always carry the legacy value.
(function (globalScope) {
    'use strict';

    if (globalScope.CanvascopeEmbeddingsConfig) return;

    globalScope.CanvascopeEmbeddingsConfig = Object.freeze({
        // MASTER SWITCH for the whole on-device embedding feature: background
        // index sync, popup model warmup, palette rerank, and the rag-core bge
        // path. False makes the extension fall back to the lexical/hash paths
        // everywhere.
        //
        // SHELVED 2026-07-22. The index itself works (4,939 vectors incl. 623
        // page vectors, built in ~2 min with zero failures), but the Cmd+K
        // surface never reliably consumed it and the cost/benefit did not
        // justify further debugging. Everything below stays in the tree and goes
        // dormant behind this flag — nothing was reverted.
        // See docs/EMBEDDINGS_SHELVED.md before switching it back on.
        EMBEDDINGS_ENABLED: false,

        // Vector-space identity. Changing MODEL_ID invalidates the whole
        // persisted index (spaces are never mixed).
        MODEL_ID: 'bge-small-en-v1.5-q8',
        DIMS: 384,

        // Vendored asset locations (resolved via chrome.runtime.getURL in the
        // offscreen host; never fetched remotely).
        TRANSFORMERS_LIB_PATH: 'src/lib/transformers/transformers.min.js',
        TRANSFORMERS_WASM_DIR: 'src/lib/transformers/',
        MODEL_LOCAL_PATH: 'src/lib/models/',
        MODEL_DIR: 'bge-small-en-v1.5',

        // bge asymmetric retrieval: queries are prefixed HOST-side so no
        // consumer can forget it; passages are embedded bare.
        QUERY_PREFIX: 'Represent this sentence for searching relevant passages: ',

        // Persisted index schema.
        INDEX_STORAGE_KEY: 'embeddingIndex',
        INDEX_SCHEMA_VERSION: 1,
        INDEX_VECTOR_CAP: 12000,
        // 50 truncated every real lecture deck in testing — four MCB 102 decks
        // (68/84/88/98 pages) lost 138 pages between them, i.e. over half of one
        // deck was unsearchable. 120 covers every document measured while still
        // bounding one textbook from eating the whole page budget.
        INDEX_MAX_PAGE_VECTORS_PER_ITEM: 120,
        // Hard ceiling on page vectors. NOT redundant with the dynamic pageBudget
        // in embedding-index.js writeStore(): that budget only ratchets down on a
        // QUOTA_BYTES error, and manifest.json declares `unlimitedStorage`, so the
        // quota never fires and page vectors would otherwise grow unchecked to
        // INDEX_VECTOR_CAP. 4.2k item vectors + 3.5k page vectors ≈ 5.5MB, which
        // is the size the whole index was already budgeted for.
        INDEX_MAX_PAGE_VECTORS_TOTAL: 3500,
        // Passage body caps. Item bodies stay at 800 — changing that value
        // re-embeds every item vector (the stored hash covers the final passage
        // text). Page bodies are 1200: bge-small truncates at 512 tokens
        // (~1800 chars incl. the title/course/type/path header, measured p99 190),
        // and over the real corpus 12.4% of pages exceed 800 chars while only
        // 2.7% exceed 1200 — so 1200 recovers most of the tail for no waste.
        INDEX_ITEM_BODY_MAX_CHARS: 800,
        INDEX_PAGE_BODY_MAX_CHARS: 1200,
        INDEX_MIN_RELOAD_INTERVAL_MS: 5000,

        // Background index sync cadence.
        // Batch size trades throughput for responsiveness: inference blocks
        // the offscreen document's main thread (shared with the DropBridge
        // receiver), so smaller batches keep those blocks short during the
        // multi-minute first index build.
        EMBED_BATCH_SIZE: 6,
        INDEX_DEBOUNCE_MS: 30000,
        INDEX_WATCHDOG_MS: 120000,
        // Each incremental write re-serializes the whole index blob (up to
        // ~5MB) and broadcasts storage.onChanged to every context, so write
        // rarely; a killed run only re-embeds since the last write, and the
        // diff makes that cheap.
        INDEX_WRITE_EVERY_BATCHES: 40,

        // Offscreen host lifecycle.
        IDLE_UNLOAD_MS: 300000,
        // ORT execution: with proxy=false, model load and every inference run
        // on the offscreen document's main thread — which it SHARES with the
        // DropBridge realtime receiver, so a long batch stalls file delivery
        // too. proxy=true moves both into a worker (the runtime spawns itself
        // as 'ort-wasm-proxy-worker' from the vendored bundle). Kept false to
        // match the validated spec path; flip when enabling the feature and
        // confirm warmup still reaches 'ready' in the offscreen console.
        ORT_PROXY: false,

        // Embed-client timeouts.
        STATUS_TIMEOUT_MS: 2000,
        EMBED_TIMEOUT_MS: 12000,
        EMBED_TIMEOUT_PER_TEXT_MS: 1500,
        WARMUP_TIMEOUT_MS: 30000,
        QUERY_LRU_SIZE: 32,

        // Cmd+K palette semantic refine.
        PALETTE_SEMANTIC_ENABLED: true,
        PALETTE_MIN_QUERY_LEN: 3,
        // Longer than the 150ms search debounce on purpose: the refine only
        // fires in a typing pause. At 150ms it landed between keystrokes and
        // every mid-word repaint read as flicker.
        PALETTE_SEMANTIC_DEBOUNCE_MS: 350,
        PALETTE_SEMANTIC_TOP_N: 30,
        // Semantic-only recall: how many rows may be introduced when the lexical
        // pass found NOTHING. Deliberately much smaller than TOP_N — with no
        // lexical list to rank-fuse against, every row here is a claim made on
        // similarity alone.
        PALETTE_RECALL_TOP_N: 8,
        // Logs one structured line per refine run (fired / index count / embed
        // latency / items scored / top-5 similarities). The refine has a dozen
        // silent exits on the hot path, which is how a completely dead semantic
        // pass once shipped with a green test suite. Leave off in normal use.
        PALETTE_SEMANTIC_DEBUG: false,
        // Folds PDF body text back into the palette's exact-token recall pass
        // (popup.js getItemBodySearchText / shouldRunBodyContentRecall). Those
        // shipped long ago but were inert because the Canvas scan wipes
        // item.content; course-material hydration refills it. This is a real
        // ranking change, not a no-op — body matching is substring-based and
        // body hits are injected before the re-score loop — so it gets a kill
        // switch until the Phase 3 sweep measures the delta.
        PALETTE_BODY_RECALL_ENABLED: true,
        // #page=N is honored only by Chrome's native PDF viewer. Canvas hands us
        // either the DocViewer preview URL (ignores fragments) or a signed
        // download URL carrying download_frd=1 (Content-Disposition: attachment,
        // so nothing renders). Off until someone confirms on a live Canvas which
        // form renders inline — a visible anchor that does nothing is worse than
        // no anchor.
        PALETTE_PAGE_DEEPLINK_ENABLED: false,

        // RAG chunk retrieval. Injection stays off until the Phase 3 eval
        // sweep proves it; reorder-only is the shipped behavior.
        SEMANTIC_INJECTION_ENABLED: false,

        RRF_K: 60,

        // Similarity thresholds keyed by vector space. hash values are the
        // legacy literals (byte-identical behavior).
        //
        // bge values are a FLOOR, not a relevance bar: candidates above it are
        // sorted by similarity, capped at PALETTE_SEMANTIC_TOP_N, and then
        // rank-fused with the lexical list, so ranking does the real work.
        // Measured in-browser on the shipped q8 model, query "homework 4":
        // the CORRECT item ("HW 4.pdf", Linear Algebra) scored 0.5496 while an
        // unrelated Calculus assignment scored 0.5059 — bge cosines cluster
        // tightly, so a 0.55 bar dropped the right answer. 0.40 keeps real
        // matches in and still floors out noise. Final values come from the
        // Phase 3 sweep.
        //
        // `page` sits ABOVE `item` deliberately, and it is the least-settled
        // number here. A document is scored by the MAX over its page vectors, so
        // a 50-page deck gets 50 draws at the bar while a 1-page handout gets
        // one; in a distribution this tight (0.5496 correct vs 0.5059 unrelated)
        // an equal floor would admit some page of every long PDF on every query.
        // The counter-argument — that ranking, not the floor, should discriminate,
        // and that a higher bar risks re-creating the 0.55 mistake for exactly the
        // content queries page vectors exist to serve — is why `page` gets its own
        // axis in the Phase 3 sweep rather than being assumed correct at 0.45.
        // `recall` is the bar for introducing a result when the lexical pass
        // found nothing at all. Every other bge value is a noise floor that
        // rank-fusion then sorts; this one has no list to fuse with, so it IS
        // the relevance bar, hence well above `item`.
        //
        // It was briefly 0.55 — which is precisely the value the measurement
        // above records as having DROPPED a known-correct match (0.5496). That
        // reintroduced the original bug in a new place. 0.48 keeps the intent
        // (noticeably stricter than the 0.40 noise floor, short list) without
        // sitting on top of the observed correct-match band. Sweep-tunable
        // alongside `page`; PALETTE_SEMANTIC_DEBUG prints the closest miss so a
        // floor that is still too high shows up as evidence rather than silence.
        THRESHOLDS: Object.freeze({
            hash: Object.freeze({ item: 0.15, chunk: 0.15, page: 0.15 }),
            bge: Object.freeze({ item: 0.40, chunk: 0.40, page: 0.45, recall: 0.48, chunkInject: 0.62 })
        })
    });
})(typeof self !== 'undefined' ? self : globalThis);
