# Canvascope - Improvement Roadmap

## Current State
- Local fuzzy search with Fuse.js
- Auto-sync when Canvas tabs detected
- 4600+ items indexed across courses

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

## Phase 2: Content Extraction *(In Progress - Started Feb 11)*

### 2.1 PDF Text Extraction
- [ ] Extract text from PDF files
- [ ] Index PDF content for search
- [ ] Show PDF page in results

### 2.2 Lecture Content
- [ ] Parse lecture slides (PPTX)
- [ ] Extract video transcripts if available
- [ ] Index module descriptions

### 2.3 Better Metadata
- [ ] Due dates for assignments
- [ ] File sizes
- [ ] Last modified dates

---

## Phase 3: AI Enhancement (Week 5-8)

### 3.1 Semantic Search
- [ ] Embed content with local model
- [ ] Vector similarity search
- [ ] "Find similar" feature

### 3.2 Smart Suggestions
- [ ] Auto-complete queries
- [ ] "You might be looking for..."
- [ ] Related content recommendations

---

## Early Testing Plan

### Internal Testing (Now)
1. **Install locally** and use daily
2. **Log issues** in a simple text file
3. **Track metrics**:
   - Search success rate (found what you wanted?)
   - Time to find content
   - Sync errors

### Alpha Testing (Week 2)
1. Share with **3-5 classmates**
2. Create simple feedback form:
   - What worked?
   - What broke?
   - What's missing?
3. Watch them use it (screen share)

### Beta Testing (Week 4)
1. Expand to **10-20 users**
2. Add **anonymous analytics**:
   - Search query patterns
   - Most clicked results
   - Error rates
3. Set up Discord/Slack for feedback

---

## Quick Wins (This Week)

1. **Keyboard shortcuts** - Cmd+K to open
2. **Result preview** - Show snippet on hover
3. **Copy link** - Right-click to copy URL
4. **Dark/Light toggle** - System preference

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Search latency | < 50ms |
| Sync time (full) | < 30s |
| Result accuracy | > 80% first-page |
| Daily active users | 50+ (beta) |
