---
description: How to work on the Canvascope Chrome extension
---

# Canvascope Development Guide

## Overview
Canvascope is a Chrome extension that indexes Canvas LMS content for fast local search.

## Project Structure
```
Canvas Search/
├── manifest.json       # Extension config (MV3)
├── popup.html          # Search popup UI
├── popup.js            # Popup logic, search, filters
├── background.js       # Service worker, auto-sync
├── content.js          # Canvas DOM extraction
├── styles.css          # Red/black themed CSS
└── lib/fuse.min.js     # Fuzzy search library
```

## Key Files

### popup.js
- Handles search UI, Fuse.js initialization
- Filter and history management
- Deduplication of indexed content

### background.js
- Service worker that scans Canvas tabs
- Stores content in `chrome.storage.local`
- Runs periodic sync via alarms API

### content.js
- Extracts course content from Canvas DOM
- Detects Canvas pages for domain learning

## Running Locally
1. Go to `chrome://extensions`
2. Enable Developer Mode
3. Load unpacked → select project folder
4. Click refresh icon after changes

## Testing Checklist
- [ ] Search returns results
- [ ] Filters update properly
- [ ] No duplicate entries
- [ ] Auto-sync triggers on Canvas

## Common Tasks

### Add new content type
1. Update `content.js` extraction logic
2. Add type to `TYPE_BOOST` in `popup.js`
3. Add filter option in `popup.html`

### Debug sync issues
1. Open popup, check console for `[Canvascope]` logs
2. Check background worker in `chrome://extensions`
3. Verify storage: `chrome.storage.local.get(console.log)`
