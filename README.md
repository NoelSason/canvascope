# Canvas Search

**Instantly search all your Canvas LMS course content using natural language.**

A privacy-first Chrome extension that indexes your Canvas courses and lets you find assignments, files, lectures, and more—all in under 50ms.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Chrome](https://img.shields.io/badge/Chrome-88%2B-green)
![License](https://img.shields.io/badge/license-MIT-purple)

---

## ✨ Features

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
- **Modern UI** — Clean, responsive interface with liquid glass aesthetic
- **Dark Mode Ready** — Follows system preference
- **Keyboard Friendly** — Navigate results with arrow keys
- **Fast** — Sub-50ms search latency

---

## 🚀 Quick Start

### Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the `Canvas Search` folder
5. Pin the extension for easy access

### First Use

1. Navigate to your Canvas LMS (e.g., `yourschool.instructure.com`)
2. Click the Canvas Search icon in your toolbar
3. Click **Refresh Now** to index your courses
4. Start searching!

> 📖 For detailed instructions, see [docs/INSTALL.md](docs/INSTALL.md)

---

## 📁 Project Structure

```
Canvas Search/
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
    ├── PRIVACY.md      # Privacy policy
    ├── SECURITY.md     # Security documentation
    └── TROUBLESHOOTING.md
```

---

## 🗺️ Roadmap

### Phase 1: Search Quality *(Current)*

| Feature | Status |
|---------|--------|
| Filter by course | ✅ Done |
| Filter by content type | ✅ Done |
| Search history | ✅ Done |
| Boost recent content | 🔄 In Progress |
| Date range filter | ⏳ Planned |

---

### Phase 2: Content Extraction *(Coming Soon)*

**PDF Text Extraction**
- Extract searchable text from PDF files
- Index PDF content for full-text search
- Show specific PDF page numbers in results

**Lecture Content**
- Parse lecture slides (PPTX format)
- Extract video transcripts when available
- Index module descriptions and summaries

**Enhanced Metadata**
- Display due dates for assignments
- Show file sizes in results
- Track last modified dates

---

### Phase 3: AI Enhancement *(Future)*

**Semantic Search**
- Embed content using local AI models
- Vector similarity search for conceptual matching
- "Find similar content" feature

**Smart Suggestions**
- Auto-complete search queries
- "You might be looking for..." recommendations
- Related content suggestions based on context

---

## 📊 Performance Targets

| Metric | Target |
|--------|--------|
| Search latency | < 50ms |
| Full sync time | < 30s |
| First-page accuracy | > 80% |

---

## 🔒 Privacy & Security

Canvas Search is designed with privacy as a core principle:

- **Local Storage Only** — All indexed content is stored in Chrome's local storage
- **No External Requests** — The extension never sends data to external servers
- **Domain Verification** — Only operates on legitimate Canvas domains
- **Minimal Permissions** — Only requests necessary Chrome permissions

> 📖 Read our full [Privacy Policy](docs/PRIVACY.md) and [Security Documentation](docs/SECURITY.md)

---

## 🐛 Troubleshooting

Common issues and solutions:

| Issue | Solution |
|-------|----------|
| Extension icon grayed out | Navigate to a Canvas page first |
| No results showing | Click "Refresh Now" to re-sync |
| Sync errors | Check your Canvas login status |

> 📖 See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for more help

---

## 🛠️ Development

### Prerequisites
- Google Chrome 88+
- Basic knowledge of Chrome extensions

### Local Development
1. Make changes to the source files
2. Go to `chrome://extensions`
3. Click the refresh icon on Canvas Search
4. Test your changes

### Testing Checklist
- [ ] Search returns relevant results
- [ ] Filters work correctly
- [ ] Auto-sync triggers on Canvas pages
- [ ] No console errors

---

## 📝 License

MIT License — feel free to use, modify, and distribute.

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Check existing issues before creating new ones
2. Follow the existing code style
3. Test your changes thoroughly
4. Submit a pull request with a clear description

---

<p align="center">
  <strong>Made with ❤️ for students who hate scrolling through Canvas</strong>
</p>
