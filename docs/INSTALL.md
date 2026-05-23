# Canvascope - Installation Guide

## Prerequisites

- Google Chrome 116+
- Access to your LMS (Canvas or Brightspace)
- Optional for Lectra sync: Google sign-in inside Canvascope

---

## Step-by-Step Installation

### 1. Confirm Core Files

Make sure `extension-core` contains:

```text
extension-core/
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
└── icons/
```

### 2. Open Chrome Extensions

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.

### 3. Load Unpacked

1. Click **Load unpacked**.
2. Select this `extension-core` folder.

### 4. Verify Install

You should see:
- `Canvascope` in your extension list
- Version `7.0.0`
- No load errors

---

## First-Time Setup

### 1. Open LMS

Navigate to a supported domain such as:
- `*.instructure.com`
- `*.brightspace.com`
- `*.d2l.com`
- `bcourses.berkeley.edu`, `bruinlearn.ucla.edu`, `canvas.ucsd.edu`, `canvas.asu.edu`, `canvas.mit.edu`

### 2. Run Initial Sync

1. Open Canvascope popup.
2. Wait for auto-sync or click **Re-scan**.
3. Verify items appear in search.

### 3. Optional: Enable Lectra PDF Handoff

1. In popup, sign in with Google.
2. Open a Canvas PDF page.
3. Click **Send to Lectra** (floating button) or **Send PDF to Lectra** in popup.
4. Confirm the prompt.

If successful, Canvascope uploads the PDF to `lectra_documents` and writes a `pdf_document` entry to `synced_items`.
Lectra -> Canvascope delivery still uses DropBridge v2, with an offscreen realtime receiver and an alarm fallback in the browser.

---

## Custom LMS Domain

Use the helper script:

```bash
bash scripts/add-school.sh https://yourschool.instructure.com
```

This updates supported-domain references in the extension source.

---

## Updating Canvascope

1. Pull latest changes.
2. Open `chrome://extensions`.
3. Click refresh on Canvascope.

Indexed local content is preserved unless you clear data.

---

## Backend Migration Note (Developers)

If you run your own Supabase backend for Lectra handoff, ensure migrations include:

- `supabase/migrations/20260227190124_dropbridge_install.sql`
- `supabase/migrations/20260227190125_dropbridge_v2_account_link.sql`
- `supabase/migrations/20260302005800_dropbridge_v2_client_kind_lectra_ipad.sql`
- `supabase/migrations/20260309120000_dropbridge_v2_wake_metadata_push.sql`
- `supabase/migrations/20260304211400_add_lectra_documents_storage.sql`

The DropBridge wake migration covers Lectra -> Canvascope receive.
The `lectra_documents` migration covers Canvascope -> Lectra PDF handoff storage and RLS.

---

## Uninstall

1. Open `chrome://extensions`.
2. Remove `Canvascope`.

Optional before uninstall:
1. Open Canvascope popup.
2. Click **Clear All Data**.

---

## Common Install Errors

### "Manifest file is missing or unreadable"
Select the folder that directly contains `manifest.json`.

### "service_worker must be a valid file"
Verify `background-wrapper.js` exists.

### Extension icon is inactive
Open a supported LMS page first.

For more issues, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
