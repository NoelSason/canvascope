# <img src="docs/assets/icon-128.png" height="40" valign="bottom"> Canvascope

**Search your LMS content fast and hand off PDFs to Lectra for Apple Pencil annotation.**

Canvascope is a local-first Chrome extension for Canvas and Brightspace. It indexes course content for fast search, supports course-scoped queries and planner workflows, and can optionally push selected PDFs to Lectra (iPad) through Supabase.

![Version](https://img.shields.io/badge/version-7.0.0-orange)
![Chrome](https://img.shields.io/badge/Chrome-88%2B-green)
![License](https://img.shields.io/badge/license-MIT-purple)

> [!IMPORTANT]
> **v7.0.0 is now available.**
>
> This release brings a modernized student assistant experience, refined theme styling support, faster local indexing performance, and robust local search capabilities.

---

## Features

### Search and Planner
- Instant search with Fuse.js + lexical fusion ranking
- Auto-sync on supported LMS tabs
- Course-scoped search queries
- Due date planner with dismissable tasks
- Keyboard overlay (Cmd/Ctrl + K) on Canvas pages
- Optional Google sign-in for account-linked sync features

### Lectra PDF Handoff (v7.0.0)
- `Send to Lectra` button appears on supported Canvas PDF pages
- Popup fallback button: `Send PDF to Lectra`
- Validates PDF signatures and enforces 25 MB size limit
- Uploads selected PDF to Supabase Storage bucket `lectra_documents`
- Registers `pdf_document` rows in `synced_items` for Lectra pickup
- Receives Lectra-origin files through DropBridge v2 with an offscreen realtime receiver plus alarm fallback

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

> Direction split: Canvascope -> Lectra uses `lectra_documents` + `synced_items`. Lectra -> Canvascope uses DropBridge v2 queue delivery and automatic browser downloads.

> Detailed setup docs: [docs/INSTALL.md](docs/INSTALL.md)

---

## Project Structure

```text
Canvascope/
├── manifest.json
├── popup.html
├── popup.js
├── content.js
├── background.js
├── background-wrapper.js
├── offscreen.html
├── offscreen.js
├── styles.css
├── oauth-callback.html
├── oauth-callback.js
├── lib/
│   ├── fuse.min.js
│   └── supabase.js
├── icons/
├── scripts/
│   ├── add-school.sh
│   ├── add_school.py
│   ├── benchmark_indexing.js
│   └── sync_google_form_responses.py
├── supabase/
│   ├── config.toml
│   └── migrations/
│       └── 20260304211400_add_lectra_documents_storage.sql
└── docs/
    ├── INSTALL.md
    ├── ROADMAP.md
    ├── PRIVACY.md
    ├── SECURITY.md
    ├── TROUBLESHOOTING.md
    └── BUG_FORM_SYNC_SETUP.md
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
- Lectra PDF push bridge (v2.2 - v7.0.0)

### Next
- PDF text extraction for in-extension full text search
- Expanded content extraction (slides/transcripts/module text)
- Optional semantic search layer

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
