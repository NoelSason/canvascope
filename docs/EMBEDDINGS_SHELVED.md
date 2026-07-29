# On-device embeddings — shelved 2026-07-22

The bge-small on-device semantic search feature is **built, tested, and turned off**.
Nothing was reverted. `EMBEDDINGS_ENABLED: false` in `src/core/embeddings-config.js` is the
single switch; every consumer is gated behind it and falls back to the lexical / hash paths.

Read this before turning it back on.

## Why it's off

The index works. The search surface never reliably consumed it.

A full build produced **4,939 vectors — 4,316 item + 623 page — in about two minutes with
zero failures**, verified in storage. But across two rounds of live testing on nine queries,
the Cmd+K palette never rendered a single page hint, and content-only queries
("succinate dehydrogenase", "collagen", "zwitterion") kept returning "No results". Each
round found real, distinct defects, fixed them, and surfaced more. The remaining suspects
sit in offscreen-document lifecycle and cold-model-load timing — the least observable part
of the stack — and the cost of chasing them stopped being worth the payoff.

## What still works with it off

These landed alongside the embeddings work, are **independent of the model**, and stay live:

- **Course-material hydration** (`CanvascopeCourseMaterials.hydrateItems`) — re-attaches PDF
  page text and `content` to corpus items at read time. A full Canvas scan wipes
  `indexedContent[].pages`/`.content` (`background.js` `writeIndexedContentSnapshot`), so
  before this, exactly **one** item out of 68 cached PDFs still had its text. This is what
  makes any body-text search possible at all, semantic or not.
- **Lexical body recall** (`PALETTE_BODY_RECALL_ENABLED`) — exact-token matching inside PDF
  body text. Shipped long ago but was inert because `content` was always empty; hydration
  revives it. Covers roughly the first 12,000 characters of a document.
- **The `handleParsePdfText` injection fix** — that path omitted `course-materials.js`, so
  Syllabus Autopilot PDFs never produced durable chunks (68 cached PDFs, only 55 with
  chunks). Both parse paths now also agree on title/course hints, so one file yields one
  `documentId` instead of two.
- **Short-token boundary matching** — `"pH"` no longer substring-matches *ph*otos / *Ph*ysics.
- Test-list reconciliation (both runners now run all 23 files; they had drifted in both
  directions) and the `FALLBACK`-vs-config drift guard.

## What goes dormant

Background index sync, the offscreen model host, popup warmup, the palette semantic refine
(page hints, max-over-pages scoring), and the `rag-core` bge retrieval path. The code stays;
it just returns early.

## Dead weight to decide on

`src/lib/models` (33MB) and `src/lib/transformers` (22MB) — **55MB of vendored assets** that
ship in the extension package while the feature is off, and are not gitignored. Options:

- **Keep** — re-enabling is a one-line flag flip. Costs every user 55MB of download.
- **Remove** — re-vendor from `@huggingface/transformers@3.8.1` when needed. Note the runtime
  is the `.jsep` build (`ort-wasm-simd-threaded.jsep.{mjs,wasm}`); the spec's "no `.jsep`
  files" claim is wrong, transformers.js ≥3.3 ships only that.

Also: a shelved install keeps a ~5MB `embeddingIndex` blob in `chrome.storage.local` that
nothing will prune while the flag is off. Harmless, but worth clearing if you remove the
assets.

## If you turn it back on

Set `EMBEDDINGS_ENABLED: true`, and set `PALETTE_SEMANTIC_DEBUG: true` **first** — the
palette refine has a dozen exits on the hot path and the debug line is the only thing that
distinguishes them. Its console output goes to the `popup.html?mode=overlay` **iframe**
frame, not the page. `scripts/dev/export-page-vectors.js` dumps which documents actually
have page vectors and what text was embedded, so you can write queries with known answers.

**Start here — the two unresolved suspects, both in lifecycle rather than in retrieval:**

1. **Does the model ever become ready for the palette?** The service worker embeds
   thousands of vectors fine; the palette is the only caller on a bounded budget. Watch for
   `[Canvascope Embeddings] Prewarm ready in Ns.` in the service-worker console after
   pressing ⌘K. If that never appears, nothing downstream can work.
2. **Offscreen document lifecycle.** `enableSendToLectra` is false by default, so every
   service-worker cold start runs `maybeCloseSharedOffscreenDocument`. A freshly created
   host reports `state: 'unloaded'` (`embeddings-host.js:37`) until it takes its first job,
   which made an earlier grace-window guard close brand-new documents on sight. That is
   fixed, and the timestamp now persists in `storage.session`, but this area is where the
   remaining failure most likely lives.

Known-good facts worth not re-deriving: itemKeys computed in the popup **do** match those
written by the background sync (verified against a real 3,866-item dump — only 4 mismatches
corpus-wide, all notes/to-dos). `ORT_PROXY` is `false`, so model load and inference run on
the offscreen document's main thread and it cannot answer a status probe while loading;
flipping it to `true` is untested and the proxy worker is spawned from the bundle, which the
extension-page CSP may block.

Thresholds were never validated by the Phase 3 eval sweep. `THRESHOLDS.bge.recall` must not
be set to `0.55` — that is the value measured as dropping a known-correct match (0.5496);
there is a test pinning this.

## Background

`docs/EMBEDDINGS_UPGRADE_SPEC.md` and `docs/EMBEDDINGS_UPGRADE_HANDOFF.md` hold the original
design. Two spec claims are wrong and cost real time: `doc_cache_pdf:<url>` stores a bare
`Array<string>`, not an object keyed by page number; and the durable per-page text store is
`courseMaterialChunks`, not `indexedContent[].pages`.
