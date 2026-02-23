# Canvascope - Development Roadmap

## Current State (v2.1.0)
- Local fuzzy + hybrid search with Fuse.js and lexical retrieval
- Auto-sync when Canvas or Brightspace tabs detected
- Course-scoped search (prefix and suffix)
- Abbreviation expansion, single-letter/numeric token matching
- ⌘K overlay for in-page search
- Due date planner with dismissable tasks
- Click-feedback and diversity re-ranking
- Google Sign-In integration
- Multi-school support (Berkeley, UCLA, UCSD, ASU, MIT + custom domains)

---

## ~~Phase 1: Search Quality (Completed)~~

### ~~1.1 Better Ranking~~
- ~~Boost recent content in results~~
- ~~Weight by content type (assignments > files)~~
- ~~Add recency decay factor~~

### ~~1.2 Search Filters~~
- ~~Filter by course~~
- ~~Filter by content type~~

### ~~1.3 Search History~~
- ~~Save recent searches~~
- ~~Quick access to frequent searches~~

---

## ~~Phase 1.5: Search Relevance (Completed — v2.0)~~

### ~~1.4 Query Normalization~~
- ~~Abbreviation expansion (hw → homework, proj → project, etc.)~~
- ~~Compact token splitting (hw4 → homework 4)~~
- ~~Number variant generation (4 ↔ 04)~~

### ~~1.5 Advanced Ranking~~
- ~~Suffix/phrase-position boosting~~
- ~~Two-pass strict/relaxed search pipeline~~
- ~~Smarter deduplication across Canvas API endpoints~~

---

## ~~Phase 2: Advanced Ranking & UX (Completed — v2.1.0)~~

### ~~2.1 Course-Scoped Search~~
- ~~Detect course names at start or end of query~~
- ~~Filter results to target course with word-boundary matching~~
- ~~Secondary recall pass for course items~~

### ~~2.2 Hybrid Retrieval~~
- ~~Lexical fallback with AND-boolean token matching~~
- ~~Reciprocal Rank Fusion (RRF) merging Fuse + lexical~~
- ~~Single-letter token matching with word boundaries~~

### ~~2.3 UX Improvements~~
- ~~⌘K overlay injected into Canvas pages~~
- ~~Due date planner (overdue, today, next 7 days)~~
- ~~Dismissable tasks with persistent state~~
- ~~Recently opened items in overlay~~
- ~~Click-feedback boost (balanced, max 0.25)~~
- ~~Diversity re-ranking for result variety~~

### ~~2.4 Infrastructure~~
- ~~Google Sign-In with OAuth2~~
- ~~Supabase integration for bug report sync~~
- ~~Automated school domain addition script~~
- ~~Offline search relevance evaluation harness~~

---

## Phase 3: Content Extraction *(Up Next)*

### 3.1 PDF Text Extraction
- [ ] Extract text from PDF files via pdf.js
- [ ] Index PDF content for full-text search
- [ ] Show matched page/section in results

### 3.2 Lecture Content
- [ ] Parse lecture slides (PPTX)
- [ ] Extract video transcripts if available
- [ ] Index module descriptions and page content

### 3.3 Better Metadata
- [ ] Display file sizes in results
- [ ] Show last modified dates
- [ ] Assignment point values

---

## Phase 4: AI Enhancement

### 4.1 Semantic Search
- [ ] Embed content with local model (all-MiniLM-L6-v2)
- [ ] Vector similarity search via FAISS/hnswlib
- [ ] Hybrid ranking (AI + Fuse.js + lexical)

### 4.2 Smart Suggestions
- [ ] Auto-complete queries
- [ ] "You might be looking for..." recommendations
- [ ] Related content discovery

---

## Success Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Search latency | < 50ms | ✅ ~40ms avg |
| Sync time (full) | < 30s | ✅ ~15s |
| Result accuracy | > 80% first-page | ✅ ~90% |
| Daily active users | 50+ (beta) | 🔄 In progress |
