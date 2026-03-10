# Canvascope v2.2.0 - Troubleshooting Guide

Common issues and fixes for search, sync, and Lectra PDF handoff.

---

## Extension Not Working

### "Please navigate to Canvas first"
Cause: Current page is not recognized as a supported LMS route.

Fix:
1. Open a supported LMS domain.
2. Refresh the page.
3. Reopen popup.

Supported hosts include `*.instructure.com`, `*.brightspace.com`, `*.d2l.com`, and configured custom domains.

### Extension icon does nothing
Cause: Popup failed to initialize.

Fix:
1. Right-click icon -> **Inspect popup**.
2. Check Console errors.
3. Reload extension in `chrome://extensions`.

---

## Scan and Search Issues

### Re-scan fails
Cause: Content script/background state mismatch.

Fix:
1. Refresh LMS tab.
2. Wait for full page load.
3. Click **Re-scan** again.

### No search results
Cause: No indexed content yet or query too narrow.

Fix:
1. Run **Re-scan**.
2. Try broader query terms.
3. Confirm stats in popup are non-zero.

### Results look off
Cause: Abbreviation expansion and fuzzy ranking are active.

Tip examples:
- `hw4` -> Homework 4
- `proj2` -> Project 2
- `chem 3a hw a` -> course-scoped query

---

## Send to Lectra Issues

### "No PDF detected on this page"
Cause: Current page does not expose a strong PDF candidate URL.

Fix:
1. Open the PDF viewer page directly.
2. Wait a second for candidate refresh.
3. Retry from floating button or popup.

### "Sign in to Canvascope to send PDFs to Lectra"
Cause: No active authenticated session.

Fix:
1. Open popup.
2. Sign in with Google.
3. Retry send.

### "No active Lectra receiver found. Open Lectra on iPad and try again."
Cause: No signed-in `lectra_ipad` device is currently registered for DropBridge v2.

Fix:
1. Open Lectra on the iPad.
2. Confirm it is signed into the same account as Canvascope.
3. Retry send.

### "PDF is too large (25 MB max)"
Cause: File exceeds enforced size limit.

Fix:
1. Compress PDF.
2. Send a smaller file.

### "Enable Allow access to file URLs"
Cause: Sending from a `file://` source without Chrome permission.

Fix:
1. Open `chrome://extensions`.
2. Open Canvascope details.
3. Enable **Allow access to file URLs**.

---

## Custom Domain Setup

Add custom LMS domains with:

```bash
bash scripts/add-school.sh https://yourschool.instructure.com
```

Then reload Canvascope in `chrome://extensions`.

---

## Common Console Errors

| Error | Cause | Fix |
|---|---|---|
| `Fuse is not defined` | Missing library file | Verify `lib/fuse.min.js` exists |
| `chrome.storage is undefined` | Extension context broken | Reload/reinstall extension |
| `Receiving end does not exist` | Content script not connected | Refresh LMS tab |

---

## Performance

### Popup opens slowly
Cause: Large local index.

Fix:
1. Clear old/unneeded data.
2. Re-scan only active courses.

### Browser feels slow
Cause: Heavy tab load or large LMS pages.

Fix:
1. Close heavy tabs.
2. Reopen browser.
3. Re-scan selectively.

---

## Still Need Help

When reporting an issue, include:
- Chrome version (`chrome://version`)
- Extension version (`2.2.0`)
- Repro steps
- Console logs (popup/content/background)
