# Canvascope - Development Roadmap

## Current State (v2.2.0)

- Hybrid local search (Fuse + lexical fusion)
- Course-scoped queries + abbreviation expansion
- Due planner + keyboard overlay
- Optional Google sign-in
- Lectra PDF handoff (`Send to Lectra`)
- Supabase-backed `pdf_document` sync contract for iPad pickup
- Canvas `courseCatalog` + `courseSnapshots` sync for Lectra Course Brain

---

## Completed

### Phase 1: Search Quality
- Fuzzy search foundation
- Type/course filtering
- Search history and ranking weights

### Phase 1.5: Query Relevance (v2.0)
- Abbreviation and compact token expansion
- Suffix/phrase-position boosts
- Two-pass strict/relaxed query strategy

### Phase 2: Advanced Ranking and UX (v2.1)
- Course-scope detection (prefix/suffix)
- RRF hybrid retrieval and diversity balancing
- Due planner and overlay UX

### Phase 2.5: Lectra Bridge (v2.2)
- Canvas PDF detection pipeline
- Floating and popup send actions
- PDF validation + upload flow (25 MB)
- `synced_items` registration as `pdf_document`
- `lectra_documents` storage bucket migration
- Namespaced Course Brain sync rows: `canvascope_course_catalog_v1` and `canvascope_course_snapshot_v1`
- Bounded Canvas syllabus / assignment / page / discussion text sync for Lectra

---

## Next Up

### Phase 3: Content Extraction
- [ ] PDF text extraction and indexing
- [ ] Slide/deck parsing improvements
- [ ] OCR / binary document text extraction beyond bounded Canvas API text

### Phase 4: Intelligent Retrieval
- [ ] Semantic embeddings (local or managed)
- [ ] Hybrid semantic + lexical ranking
- [ ] Query suggestions and related content

---

## Success Metrics

| Metric | Target |
|---|---|
| Search latency | < 50 ms |
| Full sync time | < 30 s |
| First-page relevance | > 80% |
| Lectra send success | > 95% on valid PDFs |
