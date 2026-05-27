# Chrome Web Store Listing — Canvascope

> Last Updated: 2026-05-27

## Store Listing

**Extension Name**
Canvascope

**Short Description**
Instantly search Canvas and Brightspace content, manage tasks, and hand off academic PDFs to Lectra.

**Detailed Description**
Canvascope is a privacy-first, local-first academic companion for Canvas and Brightspace LMS platforms. 

With Canvascope, you can instantly index and search your entire course catalog, syllabus text, assignments, and modules directly from a floating keyboard overlay (Cmd/Ctrl + K). It features a local-first due date planner to keep track of assignments, and injects beautiful custom theme skins (including sleek, high-contrast dark modes) directly into bCourses, BruinLearn, and standard LMS portals to ease eye strain. 

For students using Lectra on iPad, Canvascope acts as a bridge: with a single click, you can send course PDFs securely to your iPad for Apple Pencil annotation, and receive the annotated documents back automatically via browser downloads.

How to use it:
1. Load Canvascope and open your school's LMS tab (Canvas or Brightspace).
2. Tap the extension icon to run the initial fast local scan.
3. Use Cmd/Ctrl + K on any Canvas page to search or check your planner.
4. (Optional) Sign in with Google to send PDFs directly to Lectra on your iPad.

Privacy & Security:
All indexing and search matching is local-first, meaning your academic data stays securely on your device in local storage. Cloud uploads and sync are strictly opt-in and occur only when you explicitly send a PDF to Lectra. No third-party ad networks or analytics trackers are used.

**Category**
Productivity

**Single Purpose**
Index course materials, manage due dates, and securely bridge academic PDFs to Lectra.

**Primary Language**
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `icons/icon128.png` |
| Screenshot 1 (Search Overlay) | 1280×800 | ⬜ Not created | |
| Screenshot 2 (Planner Interface) | 1280×800 | ⬜ Not created | |
| Screenshot 3 (Custom Skin Styling) | 1280×800 | ⬜ Not created | |

### Screenshot Notes
- **Screenshot 1**: Show the Canvascope search overlay active on a Berkeley bCourses assignment list page, displaying abbreviation expansion results.
- **Screenshot 2**: Show the floating due planner interface with tasks, checkmarks, and color-coded priority states.
- **Screenshot 3**: Show the custom dark theme skin active on a standard Canvas dashboard, illustrating high-contrast, premium styling.

---

## Permissions Justification

Every permission and host endpoint declared in `manifest.json` is strictly required to deliver local-first features or secure iPad handoff.

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Enforces local-first indexing by caching course content, planner tasks, styling skin selections, and OAuth metadata securely on-device. |
| `activeTab` | permissions | Grants the temporary rights to detect the current page URL and load the interactive keyboard search overlay upon user action. |
| `tabs` | permissions | Matches active URL structures against supported LMS domains to run auto-sync scans and bootstrap theme skin listeners. |
| `alarms` | permissions | Powers persistent background sync fail-safes and DropBridge realtime channel heartbeat keep-alives in the service worker. |
| `offscreen` | permissions | Hosts a lightweight realtime listener container that receives annotated PDFs from Lectra iPad without requiring an open browser tab. |
| `scripting` | permissions | Programmatically injects custom user theme styles and CSS variable bags into Canvas and Brightspace frame elements. |
| `identity` | permissions | Resolves standard Google OAuth tokens to secure DropBridge uploads and map iPad communication channels to the correct account. |
| `downloads` | permissions | Automatically triggers browser downloads when annotated PDF documents are pushed back to the computer from the iPad companion. |
| `notifications` | permissions | Fires local desktop alert toasts to notify the student when an iPad handoff completes or a sync completes. |
| `https://*/*`, `http://*/*` | host_permissions | Resolves academic file links and course assets across custom student search pages. |
| `file:///*` | host_permissions | Allows scanning and uploading local course PDF materials when opened directly in the browser via file URLs. |
| `https://*.supabase.co/*` | host_permissions | Connects database sync triggers, user profile mappings, and PDF storage bucket uploads. |
| `*://*.instructure.com/*` | host_permissions | Enables search indexing, auto-sync scans, and theme styles on standard Canvas instances. |
| `*://*.brightspace.com/*` | host_permissions | Enables search indexing, auto-sync scans, and theme styles on standard Brightspace instances. |
| `*://*.d2l.com/*` | host_permissions | Enables search indexing, auto-sync scans, and theme styles on standard D2L instances. |
| `*://bcourses.berkeley.edu/*` | host_permissions | Injects Berkeley bCourses custom styling skins and handles Berkeley-scoped search indexing. |
| `*://bruinlearn.ucla.edu/*` | host_permissions | Injects UCLA BruinLearn custom styling skins and handles UCLA-scoped search indexing. |
| `*://canvas.ucsd.edu/*` | host_permissions | Injects UCSD Canvas custom styling skins and handles UCSD-scoped search indexing. |
| `*://canvas.asu.edu/*` | host_permissions | Injects ASU Canvas custom styling skins and ASU-scoped search indexing. |
| `*://canvas.mit.edu/*` | host_permissions | Injects MIT Canvas custom styling skins and MIT-scoped search indexing. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | Yes | Yes (Supabase Auth) | Google OAuth profile validation | No |
| Health info | No | No | | No |
| Financial info | No | No | | No |
| Authentication info | Yes | Yes (Supabase Auth) | Securing Lectra account sync links | No |
| Personal communications | No | No | | No |
| Location | No | No | | No |
| Web history | No | No | | No |
| User activity | Yes | No | Click ranking tiebreaks (stored locally) | No |
| Website content | Yes | Yes (Opt-in) | Transferring valid PDF documents to iPad | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL**
[Canvascope Privacy Policy](https://github.com/canvascope/canvascope-extension/blob/main/app/extension-core/docs/PRIVACY.md)

---

## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free

---

## Developer Info

**Publisher Name**
Canvascope Inc.

**Contact Email**
support@canvascope.com

**Support URL / Email**
[Canvascope Issues Dashboard](https://github.com/canvascope/canvascope-extension/issues)

**Homepage URL**
[Canvascope Home](https://canvascope.com)

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 8.0.0 | 2026-05-27 | Major Release: Integrated local academic companion AI powered by offline Gemini Nano (and secure cloud fallback). Features local hybrid RAG search blending exact lexical matching and semantic concept projection via Reciprocal Rank Fusion (RRF). Added native page-by-page PDF parsing, automatic file caches, dynamic contextual Recommendations, and persistent index-level search over closed documents. | Draft (Ready) |
| 7.0.0 | 2026-05-23 | Introduced customizable dark and high-contrast skin themes for Berkeley bCourses, UCLA BruinLearn, and UCSD Canvas. Reorganized project test structures for streamlined releases. Resolved Node ESM parsing warnings. | Published |
| 6.0.0 | 2026-05-22 | Refined search relevance, RRF hybrid retrieval rankings, and task planner overlay hotkey states. | Published |
| 2.2.0 | 2026-03-07 | Integrated Lectra PDF handoff engine, realtime offscreen receiver, and DropBridge v2 communication bridges. | Published |
