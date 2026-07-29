# Embeddings Upgrade — Architecture Spec (v1)

Status: **approved 2026-07-21** (Phase 1 output, Fable 5).
Full plan mirror: `~/.claude/plans/we-are-adding-an-agile-pond.md`.

| Phase | Work | Owner |
|-------|------|-------|
| 1 | This spec | Fable 5 (done) |
| 2 | Extension integration (W1–W7 below) | **Opus 4.8** |
| 2b | query-normalizer, threshold extraction, int8 codec | **Sonnet 5** (delegated by Opus) |
| 3 | Eval harness, gold set, fine-tune grind | **GPT-5.6-Sol** |

Before starting any task below, confirm it is assigned to your model. If
not, stop and tell the user to run it with the correct model.

## Context

Canvascope's "semantic" matching is fake today: `src/core/local-embeddings.js`
is a 24-concept keyword hash projected to 384 dims (effective rank ≤ 24), and
the live Cmd+K palette doesn't even use it — it's pure Fuse.js lexical
(`popup.js performSearch`). This upgrade puts a real on-device embedding
model (bge-small-en-v1.5, ONNX q8, via transformers.js WASM) into the
extension: fully bundled, zero API cost, all course data stays on-device.
The hash stays as the offline/failure safety net.

Locked decisions (user-confirmed 2026-07-21):
- Ship **q8 quantized weights bundled in the zip** (34MB; payload 18→~66MB).
- Fine-tuning runs **locally on the user's Mac** (MPS); Hugging Face account
  used only for private dataset/model artifact repos. The extension NEVER
  pulls from HF at runtime.
- Training/eval data = `[ADMIN]EXPORTALLDATA` dumps from the Berkeley + UCSD
  accounts + synthetic queries. No real query logs exist. **No paid LLM API
  for query generation (user decision 7/22):** synthetic queries come from
  deterministic recipes (code), from the executing agent writing them
  in-session, or from local Gemini Nano — never from a metered API.
- **v1 scope = the Cmd+K interface only**: (a) semantic rerank on palette
  search, (b) real embeddings for the RAG retrieval behind Ask-in-Cmd+K
  (popup.js:9576 → `RAGCore.compileUnifiedPrompt`). **The sidepanel is
  deprecated — do not spend work on it.** PDF page ranking (document-parser,
  tab-injected) and SW agent consumers keep their current paths in v1.
  `src/content/slash-overlay.js` + `slash-commands-pack.js` are orphaned
  (not injected anywhere) — ignore them.

## 1. Architecture summary

**Inference host: the existing offscreen document, made shared.** SW is
ruled out (classic worker + ESM-only transformers.js + known ORT-in-SW
failures + 30s idle death). Popup-hosted is ruled out as primary (popup is
ephemeral — every Cmd+K open would pay the 1.5–3s model load; multiple
contexts would each hold ~200–400MB ORT). The offscreen doc gives ONE warm
engine reachable from popup + SW via `chrome.runtime.sendMessage`; it's an
extension page so CSP `'wasm-unsafe-eval'` (manifest.json:163) applies and
`chrome.runtime.getURL` fetches need no `web_accessible_resources`.

**DropBridge coexistence (the hard part):** Chrome allows ONE offscreen doc;
today DropBridge v2 owns it (`src/offscreen/offscreen.js`, created
background.js:1507, and `stopDropBridgeV2Loop` background.js:2517-2533
CLOSES the whole document). Refactor to message-driven responsibilities:
- DropBridge stop → soft disconnect message (`dropbridgeReceiverDisconnect`
  sets a `receiverEnabled=false` latch in offscreen.js) instead of doc
  close; close the doc only if embeddings are also unloaded.
- DropBridge start → always send `dropbridgeReceiverConnect` after ensure
  (background.js:2572), since load-time-only auto-connect breaks once the
  embeddings side may have created the doc first.
- Embeddings idle-unload after 5 min (`pipe.dispose()`), notify background,
  which closes the doc only if DropBridge is also inactive.
- Keep the already-exists tolerance (background.js:1524-1541) and
  intentional-close grace (:1566); `tests/dropbridge-v2.test.mjs` must stay
  green.

**Vector index: precomputed + persisted** (today NOTHING is persisted —
every query re-vectorizes the whole corpus, impossible with a real model).
`chrome.storage.local` key `embeddingIndex`: int8 + per-vector scale,
base64 (~512B/vector; 5000 vectors ≈ 3MB; cosine error <0.5% after
re-normalize). Schema:

```json
{ "schemaVersion": 1, "modelId": "bge-small-en-v1.5-q8", "dims": 384,
  "updatedAt": 0,
  "vectors": { "<itemKey or itemKey#pN>": {"h": "<fnv1a of embedded text>",
               "s": "<scale>", "v": "<base64 int8>", "t": "<ts>"} } }
```

- `itemKey(item) = [type, courseId||courseName, url, title].join('|')`;
  page chunks `+'#p'+pageNum` (aligned with `buildChunkIndex`,
  rag-core.js:704-744).
- `h` = incremental-update key: text unchanged → skip re-embed.
- **Never mix vector spaces:** `modelId` mismatch → whole index treated as
  absent (hash fallback) + background re-embed. Items missing a vector are
  excluded from the semantic list, never hash-substituted.
- Quota: same `/quota/i` catch pattern as document-parser.js:186-201; evict
  oldest 25% of page vectors, cap 8000 vectors.
- Index build: background add-on module listens to `chrome.storage.onChanged`
  on `indexedContent`/`customTodos`/`dashboardNotes`/`syllabusMemory`,
  debounces via one-shot `chrome.alarms` (survives SW death), then
  buildCorpus → diff → `embedBatch` (batches of 12) → incremental writes.
  Resumable by construction. First full run (~3000 embeds) ≈ 4–8 min
  background.

**Message protocol** (any context → offscreen; discriminator
`target:'cs-embeddings'` so background's onMessage chains fall through):
ops `embedText` (kind `query`|`passage`), `embedBatch`, `status`, `warmup`,
`unload`. bge query prefix ("Represent this sentence for searching relevant
passages: ") applied HOST-side so no consumer can forget it. Client
timeouts (status 2s, embed 12s, warmup 30s), one ensure+retry on "receiving
end does not exist", any failure → `null` → caller falls back to hash.
Never throws into consumer code. Pages can't call `chrome.offscreen` →
background relay action `csEmbeddingsEnsureHost`.

**Query path:** embed ONLY the query at search time (normalized via the new
query-normalizer + host-side prefix), cosine against persisted vectors,
150ms debounce in the palette. Budgets: warm-load ≤3s (off UI path via
warmup), query embed ~20–60ms (target ≤80ms), WASM SIMD single-thread
(`numThreads:1` — no crossOriginIsolation → no SAB). WebGPU = later opt-in.

**Thresholds re-tuned:** cosine>0.15 + RRF k=60 are hash-era constants
(rag-core.js:554,:823; document-parser.js:273; semantic-matcher.js:107).
bge cosines cluster ~0.6–0.9 → 0.15 passes everything. All thresholds move
to config keyed by space (`hash` vs `bge`), initial bge guesses ~0.55,
final values from the eval sweep (§5).

## 2. Vendored assets (W1 — no code)

- `src/lib/transformers/`: `transformers.min.js` (pinned
  @huggingface/transformers v3 ESM build + VERSION.txt + LICENSE),
  `ort-wasm-simd-threaded.mjs` + `.wasm` (~12.5MB). NO `.jsep.*` (WebGPU)
  files in v1.
- `src/lib/models/bge-small-en-v1.5/`: `config.json`, `tokenizer.json`,
  `tokenizer_config.json`, `special_tokens_map.json`,
  `onnx/model_quantized.onnx` (34MB) from Xenova/bge-small-en-v1.5.
  Filenames must match what the pinned transformers.js requests for
  `dtype:'q8'` (verify once with DevTools network panel).
- Mirrors the Tesseract precedent (`src/core/ocr-worker.js:22-36`).

## 3. New/modified files (Phase 2, Opus 4.8)

New core modules (classic scripts on globalThis, repo pattern):
- `src/core/embeddings-config.js` — frozen config: model id/dir/paths,
  dims 384, prefix, timeouts, batch 12, idle-unload 5min, debounce 30s
  (index) / 150ms (palette), THRESHOLDS {hash, bge}, RRF_K,
  `SEMANTIC_INJECTION_ENABLED:false`, palette flag + min query len 3.
- `src/core/embedding-index.js` — itemKey/pageKey/textHash(FNV-1a),
  int8 quantize/dequantize (chunked base64, SW-safe), `load()` (null on
  modelId mismatch; storage.onChanged cache invalidation),
  `computeWantedEntries(corpus)`, `sync(corpus, embedBatchFn)` (diff-based,
  incremental, quota eviction), `cosine`.
- `src/core/embed-client.js` — embedQuery/embedPassages/status/warmup +
  `ensureEmbeddingsOffscreenHost()` (direct in SW, relay from pages),
  timeouts/retry/null-fallback, 32-entry query LRU.
- `src/offscreen/embeddings-host.js` — state machine + FIFO queue;
  `await import(chrome.runtime.getURL(TRANSFORMERS_LIB_PATH))`;
  `env.allowRemoteModels=false; env.localModelPath=getURL('src/lib/models/');
  env.backends.onnx.wasm.wasmPaths=getURL('src/lib/transformers/');
  numThreads=1; proxy=false`; `pipeline('feature-extraction', dir,
  {dtype:'q8'})`; `pipe(texts,{pooling:'mean',normalize:true})`; idle
  dispose. Injectable `loadPipeline` seam for tests.
- `src/background/embedding-index-sync.js` — the alarm-debounced index
  builder (add-on module pattern; keeps background.js diff minimal).
  Also on SW startup: modelId-mismatch/missing-index → schedule re-embed.

Modified:
- `src/offscreen/offscreen.html` — add config + embeddings-host script tags.
- `src/offscreen/offscreen.js` — `receiverEnabled` latch +
  connect/disconnect message handlers; gate startup IIFE + scheduleReconnect.
- `src/background/background.js` — soft-stop in `stopDropBridgeV2Loop`
  (:2517), connect message in `startDropBridgeV2Loop` (:2572),
  `csEmbeddingsEnsureHost`/`csEmbeddingsIdleUnloaded` handlers, updated
  offscreen justification string.
- `src/background/background-wrapper.js` — importScripts: config,
  query-normalizer, embedding-index, embed-client (before rag-core at :27),
  embedding-index-sync after.
- `src/core/local-embeddings.js` — keep class + hash byte-identical;
  `initPipeline()` → fire-and-forget warmup + `this.ready`; `getEmbedding`
  routes through embed-client, null → fallback (interface unchanged);
  delete dead `pipelineInstance` branch (:41-52). Call `initPipeline()` in
  popup init (~1s deferred) so the palette's first semantic query is warm.
- `src/popup/popup.js` — **Step 5a (flagship):** `scheduleSemanticRefine()`
  at the end of `performSearch` (:8303+): debounced, gated on flag/index/
  min-length; query vector + persisted item vectors → filter ≥
  THRESHOLDS.bge.item → `SemanticMatcher.rrfMerge` with the Fuse list →
  re-render only if the `searchGeneration` guard (:8304) still matches and
  order changed. Unavailable → exact current behavior.
- `src/core/rag-core.js` — **Step 5b:** `retrieveLocalContext` (:504-585)
  tries bge path (persisted vectors + query embed) before the existing hash
  block (unchanged as fallback). **Step 5c:** `retrieveBrainChunks`
  (:753-861) same at chunk granularity; KEEP the reorder-only constraint;
  relaxation (semantic injection at `chunkInject` threshold) behind
  `SEMANTIC_INJECTION_ENABLED`, flipped only after eval. These two power
  Ask-in-Cmd+K (popup.js:9576) — the v1 RAG scope. SW `search_corpus`
  (agent-tools.js:155) upgrades automatically via embed-client.
- `src/core/document-parser.js` — NO semantic change in v1 (tab-injected
  context, no model access; keeps us out of web_accessible_resources).
  Literal 0.15 → config constant only.

**Manifest: zero changes needed** (CSP `wasm-unsafe-eval`, offscreen,
unlimitedStorage, alarms all already present). Version bump at release only.

Implementation order: W1 vendor → W2 core modules → W3 offscreen merge →
W4 index sync → W5 consumers (5a palette, 5b/5c rag-core — each
independently shippable) → W6 manifest check (no-op) → W7 tests. Each step
leaves the extension fully working with hash fallback.

## 4. Phase 2b — Sonnet 5 delegations (exact interfaces)

1. `src/core/query-normalizer.js`: move `ABBREV_MAP`/`COMPACT_TOKEN_RE`/
   `normalizeText`/`expandAbbreviations`/`numberVariants` out of
   popup.js:1735-1812 into `globalThis.CanvascopeQueryNormalizer` with
   `normalizeForEmbedding(text)`; popup keeps thin delegating wrappers;
   delete the stale duplicate in `src/core/eval_search.js:38-105` (it lacks
   phys/bio/chem). Unit test: hw4→"homework 4", 4↔04, idempotence.
2. Threshold/config literal extraction (rag-core.js:554/:823,
   document-parser.js:273, semantic-matcher.js:107 k=60) → config reads
   with legacy-value guards for tab contexts. Zero behavior change + test.
3. Int8 codec + FNV-1a pure functions with round-trip tests (cosine >
   0.999), if Opus stubs them.

## 5. Eval harness + acceptance gates (gates Phase 2 ship)

Extends the EXISTING harness pattern (`src/core/eval_search.js` — cases as
data, items keyed by url, node-runnable; note the stale-path bug precedent
`scripts/benchmark_search.js:98`). New layout `scripts/eval/` with
`lib/{ids,text-normalize,metrics}.js`, `backends/{fuse,hash,bge,fused}.js`,
`generate_gold.mjs`, `run_eval.mjs`, `sweep_thresholds.mjs`; `data/` and
`reports/` GITIGNORED (personal course data — never commit; private HF
dataset repo only). `@huggingface/transformers` as devDependency only.

- **Canonical `passageText(item)`** = title + courseCode/courseName + type +
  folderPath/moduleName + content[:800] — defined ONCE, identical in the
  extension index builder and the harness.
- **Dump data locations (verified on the real Berkeley dump 7/22):**
  `indexedContent` (3,866 items, 56 courses) carries titles/paths/types but
  almost NO body text in the dump. PDF text lives in separate top-level
  keys: `doc_cache_pdf:<url>` (object keyed by page number → page text;
  69 PDFs in the Berkeley dump) and `courseMaterialChunks` (685 chunks with
  `text`, `title`, `courseName`, `pageStart/pageEnd`, `sourceUrl`).
  `generate_gold.mjs` and `prepare_data.py` MUST read these keys for the
  cross_type/pdf_page slices and topic pairs — not `indexedContent[].pages`.
  Dumps live in `scripts/eval/data/dumps/{berkeley,ucsd}.json` (BOTH placed
  7/22; dir is gitignored). The UCSD dump (3/15 export, 574 items,
  8 courses) has NO PDF text or chunks — the "both dumps ≥30% per slice"
  rule applies only to the title-based slices (abbrev, nl, title_frag);
  cross_type/pdf_page slices are Berkeley-only.
- **Gold set** (~180–290 pairs, JSONL `{qid, query, expected_item_id,
  expected_page, slice, source, course_key, hard_negative_item_ids,
  ambiguous_ok_item_ids}`): slices = abbrev (60–80, inverse-ABBREV_MAP
  recipes: "Homework 04"→hw4), nl (50–80, paraphrases), title_frag
  (30–50), cross_type/topic→PDF (20–40, topic NOT in title), pdf_page
  (20–40). Deterministic seed 42; both dumps ≥30% per slice.
  **Paraphrase sourcing (no API spend):** the nl/cross_type/pdf_page
  queries are AUTHORED BY THE EXECUTING AGENT in-session (read the dump,
  write student-style queries into the gold JSONL by hand — ~100-160 rows
  is an hour of agent grind, zero API cost), plus 30–60 user-labeled real
  queries via the `--label` flow. Same review rules apply (≤10 words, no
  copying >2 consecutive title tokens).
- **Systems:** S1 fuse, S2 hash, S3 bge-pure, S4 shipped fuse+hash@0.15/k60,
  S5 fuse+bge@swept, (S6 fine-tuned later). Metrics: Recall@1/5, MRR@10
  per slice + PageRecall@3 for pdf_page + latency p50/p95 + build s/1000.
- **Gates (ALL must pass to ship stock bge):** G1 S3 ≥ S2+15pts R@5 and
  S5 ≥ S4+5; G2 S5 ≥ S1+3 overall; G3 abbrev slice: S5 ≥ S1−1 (fusion must
  not dilute the alias strength; if it fails, add abbreviation-routing to
  lexical-dominant weights and re-run); G4 S5 ≥ S1+8 on nl and cross_type;
  G5 fusion ≥ max(parts); G6 embed p95 ≤150ms, build ≤90s/1000, bundle
  ≤45MB of model artifacts.
- **Sweep:** τ ∈ {0…0.60 step .05} × k ∈ {10…100} × RRF weight
  {1:1,2:1,1:2}, 50/50 tune/test stratified split, maximize MRR@10 s.t. no
  slice >2pts below its max; separate sweep for item vs page flows; overfit
  check (test within 3pts of tune).

## 6. Phase 3 — fine-tuning pipeline (GPT-5.6-Sol, local Mac)

`scripts/finetune/` (Python 3.11: sentence-transformers≥3, torch≥2.3,
optimum[onnxruntime]; `data/`+`runs/` gitignored; HF private repos
`canvascope-retrieval-data` + `canvascope-bge-small-canvas-v1`; no tokens
in git).
- **Data:** 6–10k query↔passage pairs from the dumps, deterministic-first
  (abbrev_inverse ~2–4k, number_variant, path_context, due_phrase ≤800,
  title_frag ~1–2k — all pure code, zero cost). Topic pairs (the old
  topic_llm bucket) are agent-authored in-session and CAPPED at what the
  executing agent can write without a metered API (~500–1500); if that's
  too thin, fine-tune on deterministic pairs only — they target the
  abbreviation failure mode, which is the main fine-tune win anyway. Hard
  negatives on 30–50% (same-course-different-number is the money class).
  **Leakage rules:**
  gold items/queries excluded from training; 2 held-out courses per dump
  (generalization slice); val split by item_id.
- **Train:** MNRL on BAAI/bge-small-en-v1.5, query prefix baked into
  training examples exactly as runtime; start batch 64 (MPS: 32 +
  CachedMNRL), lr 2e-5, 1–3 epochs, warmup 10%, seed 42; sweep epochs×lr.
- **Export:** optimum → ONNX → dynamic q8 (QUInt8 per-channel) in
  Xenova-compatible layout; **parity hard-fail**: cosine(py, onnx-fp32) >
  0.999, (py, q8) > 0.99, sim-matrix Spearman > 0.995 on a 64-sentence
  non-personal probe set.
- **Gates:** F1 S6 ≥ S5+3pts overall R@5; F2 no slice −2pts; F3 held-out
  courses ≥ S5−1 (no memorization); F5 embedding-space sanity (no collapse:
  mean pairwise cosine <0.75, norms 1.0±1e-3, no NaN); F6 re-sweep τ/k for
  S6. F1 fail + rest pass → keep stock model, record, stop.
- Shipping numbers always come from the NODE harness on the exported ONNX
  (`run_eval.mjs --model-dir …`); drop-in = copy folder to
  `src/lib/models/`, bump `EMBEDDINGS_MODEL_ID` (auto-invalidates index).

## 7. Verification

Automated (extend the sandbox-eval node:test pattern):
- `tests/embedding-index.test.mjs`: int8 round-trip cosine >0.999, itemKey
  stability, sync diff (unchanged/changed/stale), modelId invalidation,
  quota eviction.
- `tests/embeddings-host.test.mjs`: protocol shapes, query-prefixing,
  target filtering, status transitions, idle dispose (mock loadPipeline).
- Extend `tests/local-embeddings.test.mjs` (fallback path keeps passing);
  keep `tests/dropbridge-v2.test.mjs` green.
- Add embedding tests + local-embeddings + semantic-matcher to
  `scripts/run-release-tests.js` (they're currently OUTSIDE the release
  gate).
- `scripts/eval/run_eval.mjs` gate table = the ship decision (§5).

Manual QA (load-unpacked; manual reload required — no auto-reload):
1. Reload → warmup reaches `ready` ≤3s (second load).
2. Course scan → 30s → `embeddingIndex` populated with current modelId.
3. Cmd+K on Canvas: type "hw" progressively → lexical instant, order
   refines ≤300ms, no flicker (generation guard). Ask a question → RAG
   answer quality with semantic retrieval.
4. DropBridge: sign-in/out cycles across the shared offscreen doc
   (disconnect-not-close when embeddings loaded; doc closes when both
   idle).
5. Kill test: rename `src/lib/models/` → exact current behavior, no errors.
6. Model-swap test: bump `EMBEDDINGS_MODEL_ID` → old index ignored until
   re-embed completes.
7. Memory: offscreen RSS back to baseline after 6+ min idle.

Top risks: DropBridge lifecycle regression (latch + tests + QA4); ORT
memory (idle unload); threshold mis-tuning (config per space, injection off
by default, eval-first); vector-space mixing (modelId choke point);
first-run battery/SW-death mid-sync (alarm-debounced, diff-resumable).
