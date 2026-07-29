# Embeddings Upgrade — Handoff Prompts

Copy-paste the prompt for the model you're launching. Spec:
`docs/EMBEDDINGS_UPGRADE_SPEC.md` (approved 2026-07-21).

---

## Phase 2 — Opus 4.8 (extension integration)

> You are Opus 4.8, Lead Implementer for the Canvascope embeddings upgrade.
> Read `docs/EMBEDDINGS_UPGRADE_SPEC.md` fully — it is the approved Phase 1
> architecture spec and this task is assigned to you (Phase 2, W1–W7).
> Implement in order: W1 vendor transformers.js v3 + bge-small q8 assets
> (§2), W2 new core modules, W3 shared-offscreen merge (the DropBridge
> lifecycle refactor in §1 is the riskiest part — `tests/dropbridge-v2
> .test.mjs` must stay green), W4 background index sync, W5 consumers
> (5a popup palette rerank, 5b/5c rag-core), W7 tests + release-gate
> additions. W6 manifest = verify no changes needed. Delegate the three §4
> tasks to Sonnet 5 as scoped subtasks. Constraints: no bundler, no new
> runtime dependencies, classic-script/globalThis patterns only, hash
> fallback must remain byte-identical and every step independently
> shippable. v1 scope is the Cmd+K interface only — the sidepanel is
> deprecated, slash-overlay.js is orphaned; touch neither. You own the
> engineering calls within this spec; flag deviations in your summary.

## Phase 2b — Sonnet 5 (issued BY Opus, one per task)

> You are Sonnet 5, Scoped Executor. Implement exactly one task from §4 of
> `docs/EMBEDDINGS_UPGRADE_SPEC.md`: [task 1 query-normalizer / task 2
> threshold extraction / task 3 int8 codec]. Follow the exact interface in
> the spec, zero behavior change beyond it, add the specified unit test,
> run `npm run test:node`. Do not touch anything outside the listed files.

## Phase 3 — GPT-5.6-Sol (eval + fine-tuning grind)

> Read `docs/EMBEDDINGS_UPGRADE_SPEC.md` §5–§6 — the eval harness and
> fine-tuning pipeline are assigned to you. Execute in stages: (0) scaffold
> `scripts/eval/` (lib/ids, text-normalize synced to popup.js:1733 NOT the
> stale eval_search.js copy, metrics + unit tests); (1) gold set from the
> two ADMIN dumps in `scripts/eval/data/dumps/` (deterministic recipes seed
> 42; the nl/cross_type/pdf_page paraphrase queries YOU author yourself by
> reading the dumps — do NOT call any paid LLM API; plus the user labeling
> flow; freeze gold.jsonl); (2) backends S1–S5, threshold sweep, emit the
> gate table → Phase 2 ship verdict; (3) `scripts/finetune/` data prep with
> leakage rules — deterministic recipes first, agent-authored topic pairs
> capped per §6; (4) train MNRL on the Mac (MPS), export ONNX q8 with
> parity hard-fails, re-run the Node harness, evaluate gates F1–F6.
> Standing rules: never commit anything under data/, reports/, runs/; all
> randomness seeded 42; every report embeds git hash + gold sha256; the
> extension never fetches models at runtime; zero metered-API spend.
>
> Prerequisites the user must provide first: the two `[ADMIN]EXPORTALLDATA`
> dumps (Berkeley + UCSD) placed in `scripts/eval/data/dumps/`, and
> `huggingface-cli login` done locally. No LLM API key needed.
