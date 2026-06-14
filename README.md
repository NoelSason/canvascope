# <img src="assets/icons/logo.png" height="40" valign="bottom"> Canvascope

**Search your LMS content fast and hand off PDFs to Lectra for Apple Pencil annotation.**

Canvascope is a local-first Chrome extension for Canvas and Brightspace. It indexes course content for fast search, supports course-scoped queries and planner workflows, and can optionally push selected PDFs to Lectra (iPad) through Supabase.

![Version](https://img.shields.io/badge/version-10.0.0-orange)
![Chrome](https://img.shields.io/badge/Chrome-116%2B-green)
![License](https://img.shields.io/badge/license-MIT-purple)

> [!IMPORTANT]
> **v10.0.0 is now available.**
>
> This major release brings a highly organized source layout, a local AI-powered RAG chat assistant (offline Gemini Nano + Supabase fallback), offline PDF text extraction and image OCR search (Tesseract.js), and DropBridge v3 with realtime receipts.

---

## Features

### Search and Planner
- Instant search with Fuse.js + lexical fusion ranking
- Auto-sync on supported LMS tabs
- Course-scoped search queries
- Due date planner with dismissable tasks
- Keyboard overlay (Cmd/Ctrl + K) on Canvas pages
- Optional Google sign-in for account-linked sync features

### Local AI & Hybrid RAG Assistant
- In-browser chat companion (offline Gemini Nano or online Supabase fallback)
- Scrapes active LMS page content to dynamically supplement context
- Local lexical keyword frequency scorer that retrieves stored assignments, custom tasks, and user notes
- Lexically-gated semantic reranking: the on-device concept matcher only **reorders** lexically-relevant chunks, never injects off-topic material, so cited sources stay on-topic
- Silent personalization: the student profile tailors tone and examples but is never restated back in answers
- Auto-surfaces upcoming schedule tasks on calendar queries with fallback heuristics

### Offline PDF & Image OCR Search
- Extracts and indexes PDF text content locally for instant searching
- Offline OCR (via Tesseract.js) scans text inside scanned PDFs and images
- Caches parsed pages to `chrome.storage.local` for fast future hits

### Lectra PDF Handoff & DropBridge v3
- `Send to Lectra` floating action button appears on Canvas syllabus and assignment PDF pages
- Validates PDF signatures and enforces a 25 MB file size limit
- Uploads documents to Supabase Storage bucket `lectra_documents` and creates sync rows
- Realtime DropBridge v3 receiver via an offscreen document, featuring immediate delivery, receipt logging, and alarm-based polling fallbacks

### Privacy Model
- Local-first indexing: search corpus stays in `chrome.storage.local`
- No analytics or ad tracking
- Academic PDF upload occurs only when you explicitly send to Lectra

---

## Quick Start

### Installation
1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this `extension-core` folder.
5. Pin Canvascope for quick access.

### First Use
1. Open your LMS (Canvas or Brightspace).
2. Open Canvascope from the toolbar.
3. Let auto-sync run, or click **Re-scan**.
4. Search your content.

### Send a PDF to Lectra
1. Open a Canvas page that contains a PDF.
2. Click **Send to Lectra** (floating button) or **Send PDF to Lectra** in popup.
3. Confirm the send action.
4. The extension uploads the file and writes a `pdf_document` row for Lectra.

> Direction split: Canvascope -> Lectra uses `lectra_documents` + `synced_items`. Lectra -> Canvascope uses DropBridge v3 queue delivery, realtime receipts, and automatic browser downloads.

> Detailed setup docs: [docs/INSTALL.md](docs/INSTALL.md)

---

## Project Structure

```text
Canvascope/
├── manifest.json                  # Root configurations
├── package.json
├── package-lock.json
├── README.md
├── CHROMEWEBSTORE.md
├── .gitignore
├── .mcp.json
├── _locales/                      # Localization (LMS page inject matching)
├── assets/                        # Extension assets & icons
│   └── icons/
├── docs/                          # Guides and architecture docs
├── supabase/                      # Database local configurations & migrations
├── tests/                         # Verification suites
└── src/                           # All organized source code
    ├── background/                # Service workers
    ├── content/                   # Content scripts injected into Canvas/Brightspace
    ├── popup/                     # Toolbar browser action popup
    ├── sidepanel/                 # Chat assistant & planner sidepanel
    ├── offscreen/                 # Realtime receiver helper
    ├── oauth/                     # Google/Supabase OAuth handlers
    ├── core/                      # Core business logic, planners & RAG controllers
    ├── lib/                       # Consolidated third-party dependencies (Fuse, PDF.js, Tesseract)
    └── components/                # Modular client components (Targeting grid)
```

---

## Lectra Data Contract

When `Send to Lectra` succeeds, Canvascope inserts a `synced_items` row with:

```json
{
  "item_type": "pdf_document",
  "item_data": {
    "title": "...",
    "courseId": 123456,
    "sourceUrl": "https://...",
    "storagePath": "<user-id>/lectra_documents/imported_from_canvascope/<yyyy>/<mm>/<row-id>.pdf",
    "annotatedStoragePath": null,
    "status": "pending_annotation",
    "sourcePlatform": "canvascope_extension",
    "sourceKind": "canvas_pdf_import"
  }
}
```

This contract aligns with the Lectra workspace specs in `../..` (`lectra [IN PROGRESS]`).

---

## Roadmap Snapshot

### Completed
- Search quality, relevance, and styling skin support (v2.0 - v7.0.0)
- Planner + overlay UX
- Optional Google auth
- Lectra PDF push bridge & DropBridge v3 (v10.0.0)
- Local AI chat assistant with active-tab hybrid RAG pipeline (v8.0.0)
- Offline PDF text parsing & image OCR search (v9.0.0)
- RAG retrieval relevance floor (semantic layer reorders only, no off-topic citations), silent profile personalization, and Ask sidepanel UI cleanup (inline header, locked horizontal scroll)

### Next
- Expanded content extraction (LMS slides, video transcripts, module text)
- Multi-device calendar/planner synchronization

See [docs/ROADMAP.md](docs/ROADMAP.md) for full status.

---

## Supported Domains

Default support includes:
- `*.instructure.com`
- `*.brightspace.com`
- `*.d2l.com`
- `bcourses.berkeley.edu`
- `bruinlearn.ucla.edu`
- `canvas.ucsd.edu`
- `canvas.asu.edu`
- `canvas.mit.edu`

To add a custom LMS domain:

```bash
bash scripts/add-school.sh https://yourschool.instructure.com
```

---

## Privacy and Security

- Search indexing is local-first.
- LMS API calls are required for scanning and sync.
- Supabase is used for account-linked features and Lectra PDF handoff.
- No analytics SDKs or ad trackers are included.

Read the full policies:
- [docs/PRIVACY.md](docs/PRIVACY.md)
- [docs/SECURITY.md](docs/SECURITY.md)

---

## Troubleshooting and Bug Sync

- Troubleshooting: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- Google Form bug sync setup: [docs/BUG_FORM_SYNC_SETUP.md](docs/BUG_FORM_SYNC_SETUP.md)

---

## About Canvascope Inc.

Canvascope is a privacy-first academic productivity platform. Lectra is the iPad Apple Pencil companion for document annotation in the same ecosystem.

---

## License

MIT License.
