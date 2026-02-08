# ![Icon](docs/assets/icon-128.png) Canvascope

**Instantly search all your Canvas LMS course content using natural language.**

A privacy-first Chrome extension that indexes your Canvas courses and lets you find assignments, files, lectures, and more—all in under 50ms.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Chrome](https://img.shields.io/badge/Chrome-88%2B-green)
![License](https://img.shields.io/badge/license-MIT-purple)

---

## Features

### Core Functionality
- **Instant Search** — Fuzzy search powered by Fuse.js finds content even with typos
- **Auto-Sync** — Automatically indexes your courses when Canvas tabs are detected
- **Smart Filters** — Filter by course, content type (assignments, quizzes, files, etc.)
- **Search History** — Quick access to recent and frequent searches
- **4600+ Items** — Capable of indexing thousands of items across all your courses

### Privacy First
- **100% Local** — All data stays on your device, never sent to external servers
- **No Tracking** — Zero analytics, no telemetry
- **Secure** — Only runs on verified Canvas domains

### User Experience
- **Modern UI** — Clean, responsive interface with red/black aesthetic
- **Keyboard Friendly** — Navigate results with arrow keys
- **Fast** — Sub-50ms search latency

---

## Quick Start

### Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the extension folder
5. Pin the extension for easy access

### First Use

1. Navigate to your Canvas LMS (e.g., `yourschool.instructure.com`)
2. Click the Canvascope icon in your toolbar
3. Click **Refresh Now** to index your courses
4. Start searching!

> For detailed instructions, see [docs/INSTALL.md](docs/INSTALL.md)

---

## Project Structure

```
Canvascope/
├── manifest.json       # Extension configuration
├── popup.html          # Search interface
├── popup.js            # UI logic and search handling
├── background.js       # Auto-sync and background scanning
├── content.js          # Canvas page content extraction
├── styles.css          # UI styling
├── lib/
│   └── fuse.min.js     # Fuzzy search library
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── docs/
    ├── INSTALL.md      # Installation guide
    ├── ROADMAP.md      # Development roadmap
    └── PRIVACY.md      # Privacy policy
```

---

## Roadmap

### ~~Phase 1: Search Quality (Completed)~~
- ~~Filter by course~~
- ~~Filter by content type~~
- ~~Search history~~
- ~~Better ranking algorithm~~

### Phase 2: Content Extraction *(In Progress)*
- PDF text extraction
- Lecture slides parsing
- Enhanced metadata

### Phase 3: AI Enhancement
- Semantic search
- Smart suggestions

---

## Privacy & Security

- **Local Storage Only** — All indexed content is stored in Chrome's local storage
- **No External Requests** — The extension never sends data to external servers
- **Domain Verification** — Only operates on legitimate Canvas domains

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Extension icon grayed out | Navigate to a Canvas page first |
| No results showing | Click "Refresh Now" to re-sync |
| Sync errors | Check your Canvas login status |

---

## License

MIT License — feel free to use, modify, and distribute.

---

<p align="center">
  <strong>Made with ❤️ for students who hate scrolling through Canvas</strong>
</p>
