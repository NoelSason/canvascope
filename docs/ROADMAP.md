# Canvascope - Development Roadmap

## Current State (v10.1.0)

- Custom skin themes (Berkeley bCourses, UCLA BruinLearn, UCSD, MIT, etc.)
- Hybrid local search (Fuse + lexical fusion)
- Course-scoped queries + abbreviation/course-code expansion
- Calendar-aware Cmd/Ctrl + K material ranking for today/yesterday/this-week searches
- Due planner + keyboard overlay
- Optional Google sign-in with persistent Supabase sessions and no RISC event-driven forced sign-out
- Lectra PDF handoff (`Send to Lectra`)
- DropBridge v3 PDF transport for iPad pickup, realtime wake receipts, and browser download return flow
- Canvas `courseCatalog` + `courseSnapshots` sync for Lectra Course Brain
- Character Profile suggestions from due dates, grades, recent searches, and recent supported LMS pages
- Paste assignment button for user-clicked clipboard reads in the side panel
- Date-grounded RAG material summaries using Canvas file paths, module names, week labels, and sparse file-list evidence

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
- Course-code aliases are preserved on indexed items and enriched from `courseCatalog`/`courseSnapshots`

### Phase 2: Advanced Ranking and UX (v2.1)
- Course-scope detection (prefix/suffix)
- RRF hybrid retrieval and diversity balancing
- Due planner and overlay UX

### Phase 2.5: Lectra Bridge (v2.2)
- Canvas PDF detection pipeline
- Floating and popup send actions
- PDF validation + DropBridge v2 upload flow (25 MB)
- Realtime wake subscription + 60s fallback polling
- Namespaced Course Brain sync rows: `canvascope_course_catalog_v1` and `canvascope_course_snapshot_v1`
- Bounded Canvas syllabus / assignment / page / discussion text sync for Lectra

### Phase 2.6: Custom Skin Styling & Themes (v7.0.0)
- Local styling system (`canvas-skin.js` and `lib/skin-themes.js`)
- Dynamic theme styles injected directly into active Canvas/Brightspace LMS instances
- Interactive popup-based theme configurations and settings persistence
- Seamless theme sync across popup, content script, and service worker contexts
- Kaltura Media Gallery / standalone player skin coverage, including background `webNavigation` CSS injection for POST-loaded LTI iframes

### Phase 2.7: Character Profile (v10.1.0)
- Enabled-by-default personalized "what to work on next" suggestions with visible source/why copy
- Side panel suggestion surface with run/open, dismiss, and pause controls
- Profile controls view for enable/disable, pause/unpause, inspect, delete, and sync status
- Settings account row opens the editable Student Profile for manual name, grade/year, major, career plan, and notes
- Last-writer-wins pull merge so a newer local opt-out is not overwritten by an older synced profile
- Resume-page suggestions from recent supported LMS browsing history
- Paste assignment side-panel control using `clipboardRead` only inside the click handler
- Supabase `character_profile` sync table deployed with RLS for account-linked summaries and settings
- Removed unused historical MedMatch Supabase tables from the Canvascope/Lectra database contract

### Phase 2.8: Ask / RAG Grounding
- Current-date grounding is included in compiled prompts so both local and cloud AI routes answer relative-date questions against the real day
- Broad material-summary questions surface recent/course-scoped Canvas files even when only title/path/week/date metadata has been indexed
- Course-material indexer discovers the active Canvas course's visible/API-listed PDFs, parses text/OCR from the authenticated Canvas tab, and stores local document/page chunks for RAG
- Optional Supabase `course_material_documents` and `course_material_chunks` tables provide account-linked full-text search when the user enables extracted-text sync
- Quick Ask answers hide sources behind a compact disclosure and bias "this week" questions toward topic explanations instead of source-number summaries

---

## Next Up

### Character Profile Follow-Up
- [x] Add a full profile controls view for inspect, unpause, clear/delete, and sync status
- [x] Restore Settings access to the manual Student Profile fields that feed personalization context
- [ ] Add manual extension QA for install permission warnings, paste-button focus behavior, and resume-page opening
- [ ] Reconcile store listing screenshots/copy after the required `history` and `clipboardRead` permissions ship
- [ ] Keep GitHub, Google Workspace, and mail/calendar sources out of the shipped product until connector-specific consent, deletion, and review plans exist

### Phase 3: Content Extraction
- [x] PDF text extraction and indexing
- [ ] Slide/deck parsing improvements
- [x] OCR / binary document text extraction for Canvas PDFs

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
