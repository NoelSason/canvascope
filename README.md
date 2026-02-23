# <img src="docs/assets/icon-128.png" height="40" valign="bottom"> Canvascope

**Instantly search all your Canvas & Brightspace course content using natural language.**

A privacy-first Chrome extension that indexes your LMS courses and lets you find assignments, files, lectures, and more — powered by intelligent search with abbreviation expansion, course-scoped queries, and a due-date planner.

![Version](https://img.shields.io/badge/version-2.1.0-orange)
![Chrome](https://img.shields.io/badge/Chrome-88%2B-green)
![License](https://img.shields.io/badge/license-MIT-purple)

> [!IMPORTANT]
> **v2.1.0 is now available!**
>
> We are currently onboarding beta testers. To get started and help us improve Canvascope, please fill out the onboarding form below:
>
> 👉 **[Beta Tester Onboarding Form](https://forms.gle/f1f1JEmobmM1bapT6)**

---

## Features

### Core Functionality
- **Instant Search** — Fuzzy search powered by Fuse.js finds content even with typos, under 50ms
- **Auto-Sync** — Automatically indexes your courses when Canvas or Brightspace tabs are detected
- **Smart Filters** — Filter by course, content type (assignments, quizzes, files, etc.)
- **Due Date Planner** — At-a-glance view of overdue, today, and upcoming assignments
- **⌘K Overlay** — Spotlight-style search overlay accessible from any Canvas page via keyboard shortcut
- **Google Sign-In** — Optional authentication for syncing bug reports and preferences
- **Multi-LMS Support** — Works with Canvas (Instructure) and custom Canvas domains (Berkeley, UCLA, UCSD, ASU, MIT)

### Smart Search (v2.0+)
- **Abbreviation Expansion** — Type `hw4` to find "Homework 4", `proj2` for "Project 2", `lec` for "Lecture", and more
- **Number Normalization** — Matches both padded and unpadded numbers (e.g., `hw4` finds "Homework 04" and "Homework 4")
- **Course-Scoped Queries** — Prefix or suffix your query with a course name to scope results (e.g., `chem 3a hw g` or `hw g chem 3a`)
- **Intent Detection** — Automatically infers content type from query context (e.g., `hw` boosts assignments)
- **Suffix & Position Matching** — Queries like "Quiz 3" strongly prefer titles ending with that exact phrase
- **Token Coverage Scoring** — Ranks results by how many query tokens appear in the title and folder path
- **Click Feedback** — Recently opened items get a subtle relevance boost as a tiebreaker

### Ranking Pipeline (v2.1.0)
- **Exact/Prefix Pre-Pass** — Exact title matches are promoted above all fuzzy results
- **Hybrid Retrieval (RRF Fusion)** — Combines Fuse.js fuzzy results with lexical token matching for robust recall
- **Diversity Re-Ranking** — Prevents over-representation of any single course or content type
- **Numeric & Single-Letter Matching** — Correctly handles single-letter identifiers (Homework A, Lab G) and numeric tokens
- **Folder-Path Awareness** — Results are boosted when query tokens match folder names in the file hierarchy

### Privacy First
- **100% Local** — All data stays on your device, never sent to external servers
- **No Tracking** — Zero analytics, no telemetry
- **Secure** — Only runs on verified Canvas domains with strict Content Security Policy

### User Experience
- **Modern UI** — Clean, responsive interface with red/black aesthetic and glassmorphism
- **Keyboard Friendly** — Navigate results with arrow keys, Enter to open
- **Recently Opened** — Quick access to recently opened items in the ⌘K overlay
- **Dismissable Tasks** — Hide completed tasks from the due planner

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
3. Content will auto-sync in the background — or click **Re-scan** to force a refresh
4. Start searching!

> For detailed instructions, see [docs/INSTALL.md](docs/INSTALL.md)

---

## Project Structure

```
Canvascope/
├── manifest.json           # Extension configuration (MV3)
├── popup.html              # Search interface
├── popup.js                # UI logic, search pipeline, ranking engine
├── background.js           # Background sync worker + Canvas API integration
├── background-wrapper.js   # Service worker entry point
├── content.js              # Canvas page content extraction + ⌘K overlay injection
├── styles.css              # UI styling (dark theme, glassmorphism)
├── oauth-callback.html     # Google Sign-In callback page
├── oauth-callback.js       # OAuth flow handler
├── eval_search.js          # Offline search relevance evaluation harness
├── test_rank.js            # Ranking algorithm test suite
├── lib/
│   ├── fuse.min.js         # Fuzzy search library
│   └── supabase.js         # Supabase client (bug report sync)
├── icons/
│   └── icon*.png           # Extension icons (16, 32, 48, 128)
├── scripts/
│   ├── add_school.sh       # Add new school domain automatically
│   └── benchmark_indexing.js # Performance benchmarking
├── supabase/
│   ├── config.toml         # Supabase project configuration
│   └── migrations/         # Database schema migrations
└── docs/
    ├── INSTALL.md           # Installation guide
    ├── ROADMAP.md           # Development roadmap
    ├── PRIVACY.md           # Privacy policy
    ├── SECURITY.md          # Security documentation
    ├── TROUBLESHOOTING.md   # Common issues & fixes
    └── BUG_FORM_SYNC_SETUP.md # Google Form → GitHub sync
```

---

## Roadmap

### ~~Phase 1: Search Quality (Completed)~~
- ~~Fuzzy search with Fuse.js~~
- ~~Course and content type filters~~
- ~~Search history and recent items~~
- ~~Type-weighted ranking algorithm~~

### ~~Phase 1.5: Search Relevance (Completed — v2.0)~~
- ~~Abbreviation & compact-number expansion (hw4, proj2, etc.)~~
- ~~Suffix/phrase-position boosting for precise ranking~~
- ~~Two-pass strict/relaxed search pipeline~~
- ~~Smarter deduplication across Canvas API endpoints~~

### ~~Phase 2: Advanced Ranking & UX (Completed — v2.1.0)~~
- ~~Course-scoped search (prefix and suffix)~~
- ~~Single-letter and numeric token matching (Homework A, Lab G)~~
- ~~Hybrid RRF fusion retrieval (Fuse + lexical)~~
- ~~Click-feedback boosting with balanced weight~~
- ~~Due date planner with dismissable tasks~~
- ~~⌘K overlay for in-page search~~
- ~~Diversity re-ranking~~

### Phase 3: Content Extraction *(Up Next)*
- PDF text extraction and indexing
- Lecture slides parsing
- Enhanced metadata (file sizes, last modified)

### Phase 4: AI Enhancement
- Semantic search with sentence-transformer embeddings
- Smart suggestions and auto-complete
- "Find similar" content recommendations

---

## Supported Schools

Canvascope works out-of-the-box with:

| Domain | School |
|--------|--------|
| `*.instructure.com` | All standard Canvas instances |
| `bcourses.berkeley.edu` | UC Berkeley |
| `bruinlearn.ucla.edu` | UCLA |
| `canvas.ucsd.edu` | UC San Diego |
| `canvas.asu.edu` | Arizona State University |
| `canvas.mit.edu` | MIT |

To add your school, run: `bash scripts/add_school.sh https://yourschool.instructure.com`

---

## Privacy & Security

- **Local Storage Only** — All indexed content lives in Chrome's local storage
- **No External Requests** — The extension never sends your academic data to external servers
- **Domain Verification** — Only operates on legitimate LMS domains
- **Strict CSP** — No inline scripts, no eval, no remote code

For full details, see [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/SECURITY.md](docs/SECURITY.md).

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Extension icon grayed out | Navigate to a Canvas page first |
| No results showing | Click **Re-scan** to re-sync, or wait for auto-sync |
| Wrong course results | Use course-scoped search: `chem 3a hw 4` |
| Sync errors | Check your Canvas login status |

For comprehensive help, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## Bug Report Sync

Google Form bug submissions can be synced into this repository automatically.

- Setup guide: [docs/BUG_FORM_SYNC_SETUP.md](docs/BUG_FORM_SYNC_SETUP.md)
- Synced output: [docs/bug-reports/google-form-responses.json](docs/bug-reports/google-form-responses.json)

---

## About Canvascope Inc.

Canvascope is the flagship product of **Canvascope Inc.**, a student-focused EdTech company building privacy-first productivity tools for higher education.

**Mission:** Help students securely and efficiently access academic resources through intelligent, privacy-first tools.

**Team:** Founded by Noel Sason with Warren Park (CPO), Eric Kim (CFO), and Kevin Rhee (CMO).

---

## License

MIT License — feel free to use, modify, and distribute.

---

<p align="center">
  <strong>Made with ❤️ for students who hate scrolling through Canvas</strong>
</p>
