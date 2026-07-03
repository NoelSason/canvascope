# Canvascope - Privacy Policy

**Last Updated**: July 1, 2026
**Version**: 10.1.0

---

## Summary

Canvascope is local-first for search indexing. Most lightweight search metadata stays on your device.

Canvascope also includes optional cloud-connected features:
- Google sign-in
- Course Brain sync for Lectra
- Lectra PDF handoff (`Send to Lectra`)
- Optional extracted course-material sync for AI search
- Personalized suggestions (Character Profile)
- Bug-report sync workflows (project-maintainer tooling)

No analytics SDKs or ad trackers are used.

---

## Data We Process

### Local Search Index (default behavior)
When you scan LMS content, Canvascope stores local metadata such as:

| Data Type | Example | Purpose | Storage |
|---|---|---|---|
| Link titles | "Week 3 Lecture Slides" | Search indexing | `chrome.storage.local` |
| Link URLs | `https://school.instructure.com/...` | Open results | `chrome.storage.local` |
| Course/module labels | "Module 2" | Context + ranking | `chrome.storage.local` |
| Content types | `assignment`, `pdf`, `video` | Filters + ranking | `chrome.storage.local` |
| Due dates | ISO timestamp | Due planner | `chrome.storage.local` |
| Click feedback | URL + timestamp | Ranking tiebreaks | `chrome.storage.local` |
| Extracted PDF/OCR page text | lecture slide text, scanned PDF text | Course-material RAG answers | `chrome.storage.local` |

### Local Course Snapshot Cache
Canvas scans also keep bounded course-structure data for Lectra/Course Brain:

| Data Type | Example | Purpose | Storage |
|---|---|---|---|
| Course catalog | course code, term, teacher summaries | Course-level navigation/context | `chrome.storage.local` |
| Course snapshots | assignment groups, modules, file metadata | Lectra Course Brain sync | `chrome.storage.local` |
| Bounded plain-text bodies | syllabus text, assignment instructions, page/discussion body excerpts | Assignment workspace + concept/topic inference | `chrome.storage.local` |

### Optional Account Data
If you sign in, Canvascope may read/store:

| Data Type | Purpose | Storage |
|---|---|---|
| Email + display name | Account profile display | Local extension storage + Supabase auth session |
| OAuth session tokens | Authenticated features | Local extension storage via Supabase auth adapter |

### Optional Lectra/Course Brain Sync
If you sign in, Canvascope may sync course data for Lectra:

| Data Type | Purpose | Destination |
|---|---|---|
| Course catalog (`courseCatalog`) | Lectra course picker and course context | Supabase table `synced_items` |
| Course snapshots (`courseSnapshots`) | Course Brain graph, assignment workspace, topic/concept inference | Supabase table `synced_items` |
| Enriched item metadata (`instructions`, `body`, points, file metadata) | Lectra Course Brain enrichment | Supabase table `synced_items` |

Text synced for Course Brain is bounded plain text, not raw HTML and not file OCR output.

### Optional Extracted Course-Material Sync
By default, parsed PDF/OCR text stays on your device. If you sign in and enable **Sync extracted course text** in Settings, Canvascope syncs normalized course-material rows for account-linked search:

| Data Type | Purpose | Destination |
|---|---|---|
| Course material document metadata | Course/week scoping, source links, parse status | Supabase table `course_material_documents` |
| Extracted PDF/OCR text chunks | Cross-device full-text retrieval for AI answers | Supabase table `course_material_chunks` |

These rows are protected with row-level security and are scoped to your authenticated user. Turning the setting off stops future sync, but already-synced rows remain until cleared through account/backend deletion workflows.

### Personalized Suggestions (Character Profile)

Canvascope offers a small set of "what to work on next" suggestions on your dashboard — for example, the assignment due soonest, a course whose grade could use attention, or a search you started but did not finish. Each suggestion explains *why* it appeared and which of your own Canvascope activity it came from, and you can dismiss any of them.

**This is turned on by default.** You can pause it, dismiss individual suggestions, or clear it entirely at any time from the profile controls. Clearing it also removes the synced copy described below.

| Data Type | Example | Purpose | Storage |
|---|---|---|---|
| Suggestion settings | on/off, paused, dismissed suggestions | Remember your choices | `chrome.storage.local` |
| Derived summaries | "Due soonest: Lab 7 Report", "Lowest grade: BIO 1A" | Power the suggestions | `chrome.storage.local` |

These suggestions are built from Canvascope activity already on your device (your search history, your synced course/assignment due dates, and your current grades) plus recent visits to supported LMS/course pages for "Resume where you left off." Canvascope does **not** store the full text of your searches, documents, pages, or chat prompts in your profile — only short, labeled summaries.

If you are signed in, your suggestion settings and these short summaries sync to your account so the experience follows you across devices:

| Data Type | Purpose | Destination |
|---|---|---|
| Suggestion settings + derived summaries (`profile_json`) | Cross-device personalization | Supabase table `character_profile` (one row per user, row-level security) |

Signed-out use stays entirely on your device.

Two related features use a browser permission:

| Feature | Permission | What it does |
|---|---|---|
| Resume where you left off | Browsing history | Suggests re-opening a course page you recently visited. Only visits to supported LMS/course sites are looked at, on your device; only a short page title/link summary is kept. |
| Paste assignment | Clipboard | Your clipboard is read **only** the moment you click the **Paste assignment** button, so you can drop copied assignment text in to search or ask about it. It is never read in the background, and the text is not stored. |

### Optional Lectra PDF Handoff
If you explicitly choose **Send to Lectra** for a PDF:

| Data Type | Purpose | Destination |
|---|---|---|
| Selected PDF file (max 25 MB) | iPad annotation workflow | Supabase Storage bucket `lectra_documents` |
| PDF metadata (`title`, `courseId`, `sourceUrl`, `storagePath`, `sourcePlatform`, `sourceKind`) | Lectra sync coordination | Supabase table `synced_items` |

This upload is user-initiated and tied to your authenticated account.
Reverse-direction Lectra -> Canvascope delivery uses DropBridge v2 queue metadata plus short-lived download URLs to trigger browser downloads. For this optional receive flow, Canvascope may create a hidden Chrome offscreen document that keeps a Supabase Realtime worker connected so queued files can wake the extension without opening a visible tab. If the offscreen receiver is unavailable, Canvascope falls back to periodic alarm-based polling.

---

## What We Do Not Do

- No ad targeting
- No third-party analytics trackers
- No selling academic data
- No scraping of passwords or LMS credentials

---

## Third-Party Services

| Service | Used | Why |
|---|---|---|
| LMS endpoints (Canvas/Brightspace) | Yes | Fetch course metadata for indexing/sync |
| Supabase Auth | Optional | Sign-in/session for account-linked features |
| Supabase Database/Storage | Optional | Lectra Course Brain sync + PDF handoff + personalized-suggestion sync + opted-in course-material text search |
| Google OAuth | Optional | User sign-in flow |

---

## Retention and Deletion

### Local data
- Stored until cleared by user.
- Use **Clear All Data** in popup to remove local index data.
- Uninstalling the extension removes extension-local storage.

### Cloud data (if you use sign-in / Lectra / extracted-text sync features)
- Course snapshot rows and PDF metadata persist in Supabase database until deleted through backend workflows.
- Opted-in extracted course-material document/chunk rows persist in Supabase database until deleted through backend workflows.
- Uploaded PDFs persist in Supabase Storage until deleted through backend workflows.
- Removal is governed by project database/storage policies.

### Personalized suggestions (Character Profile)
- Stored on your device until you clear it.
- When signed in, your settings and derived summaries are also kept in your `character_profile` row.
- **Clear** removes both the on-device copy and the synced row.
- Pausing stops new suggestions without deleting anything; deleting your account removes the row automatically.

---

## Security Controls (High Level)

- Manifest V3 + strict extension CSP
- Restricted host permissions for supported LMS domains and Supabase
- RLS-backed Supabase storage policies for user-owned Lectra files

See [SECURITY.md](./SECURITY.md) for full details.

---

## Changes to This Policy

When this policy changes, we update:
1. `Last Updated` date
2. Version reference
3. Documentation bundled with the extension

---

## Contact

For privacy questions:
1. Review this repository source
2. Open a repository issue
3. Include extension version and reproducible steps

---

## Consent

By using Canvascope, you consent to this policy, including optional cloud processing when you explicitly use sign-in, extracted course-material sync, or Lectra handoff features.
