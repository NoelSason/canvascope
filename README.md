# <img src="docs/assets/icon-128.png" height="40" valign="bottom"> Canvascope

**Search your LMS content fast and hand off PDFs to Lectra for Apple Pencil annotation.**

Canvascope is a local-first Chrome extension for Canvas and Brightspace. It indexes course content for fast search, supports course-scoped queries and planner workflows, and can optionally push selected PDFs to Lectra (iPad) through Supabase.

![Version](https://img.shields.io/badge/version-2.2.0-orange)
![Chrome](https://img.shields.io/badge/Chrome-88%2B-green)
![License](https://img.shields.io/badge/license-MIT-purple)

> [!IMPORTANT]
> **v2.2.0 is now available.**
>
> This release adds the Lectra PDF handoff flow (`Send to Lectra`) and updates the privacy/security model to reflect explicit cloud sync for that feature.

---

## Features

### Search and Planner
- Instant search with Fuse.js + lexical fusion ranking
- Auto-sync on supported LMS tabs
- Course-scoped search queries
- Due date planner with dismissable tasks
- Keyboard overlay (Cmd/Ctrl + K) on Canvas pages
- Optional Google sign-in for account-linked sync features

### Lectra PDF Handoff (v2.2.0)
- `Send to Lectra` button appears on supported Canvas PDF pages
- Popup fallback button: `Send PDF to Lectra`
- Validates PDF signatures and enforces 25 MB size limit
- Uploads selected PDFs to DropBridge v2 via `upload-file-v2`
- Preserves PDF handoff metadata in `uploads.metadata` for Lectra pickup
- Builds `courseCatalog` + bounded `courseSnapshots` for Lectra Course Brain
- Dual-writes enriched course rows plus namespaced snapshot rows to `synced_items` when signed in

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
4. The extension uploads the file through DropBridge v2 for Lectra.

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

When `Send to Lectra` succeeds, Canvascope uploads the PDF through DropBridge v2 with metadata:

```json
{
  "receiverKind": "lectra_ipad",
  "senderKind": "canvascope_extension",
  "metadata": {
    "title": "...",
    "courseId": 123456,
    "sourceUrl": "https://...",
    "sourcePlatform": "canvascope_extension",
    "sourceKind": "canvas_pdf_import"
  }
}
```

The backend persists this metadata in `uploads.metadata` and wakes the target receiver via private realtime hints.

Canvas course scans now also persist:

- Local storage keys: `courseCatalog`, `courseSnapshots`
- `synced_items.item_type = "canvascope_course_catalog_v1"` for the current course catalog snapshot
- `synced_items.item_type = "canvascope_course_snapshot_v1"` for per-course Course Brain payloads

Each course snapshot stores bounded plain-text course context for Lectra, including course metadata, teacher summaries, assignment groups, module structure, and enriched `indexedContent` items with fields such as `instructions`, `body`, `pointsPossible`, `submissionTypes`, `contentType`, and `sizeBytes`.

---

## Roadmap Snapshot

### Completed
- Search quality and relevance upgrades (v2.0-v2.1)
- Planner + overlay UX
- Optional Google auth
- Lectra PDF handoff on DropBridge v2

### Next
- PDF text extraction for in-extension full text search
- Expanded extraction beyond bounded Canvas text snapshots (PDF OCR, transcripts)
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
