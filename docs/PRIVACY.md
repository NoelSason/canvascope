# Canvascope - Privacy Policy

**Last Updated**: March 7, 2026  
**Version**: 2.2.0

---

## Summary

Canvascope is local-first for search indexing. Most lightweight search metadata stays on your device.

Canvascope also includes optional cloud-connected features:
- Google sign-in
- Course Brain sync for Lectra
- Lectra PDF handoff (`Send to Lectra`)
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

### Optional Lectra PDF Handoff
If you explicitly choose **Send to Lectra** for a PDF:

| Data Type | Purpose | Destination |
|---|---|---|
| Selected PDF file (max 25 MB) | iPad annotation workflow | DropBridge private storage bucket `drops` (via Edge Function) |
| PDF metadata (`title`, `courseId`, `sourceUrl`, `sourcePlatform`, `sourceKind`) | Lectra sync coordination | DropBridge queue row `uploads.metadata` (via Edge Function) |

This upload is user-initiated and tied to your authenticated account.

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
| Supabase Database/Storage | Optional | Lectra Course Brain sync + PDF handoff |
| Google OAuth | Optional | User sign-in flow |

---

## Retention and Deletion

### Local data
- Stored until cleared by user.
- Use **Clear All Data** in popup to remove local index data.
- Uninstalling the extension removes extension-local storage.

### Cloud data (if you use sign-in / Lectra features)
- Course snapshot rows and PDF metadata persist in Supabase database until deleted through backend workflows.
- Uploaded PDFs persist in Supabase Storage until deleted through backend workflows.
- Removal is governed by project database/storage policies.

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

By using Canvascope, you consent to this policy, including optional cloud processing when you explicitly use sign-in or Lectra handoff features.
