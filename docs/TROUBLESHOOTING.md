# Canvascope v2.1.0 - Troubleshooting Guide

Common issues and how to fix them.

---

## 🔴 Extension Not Working

### "Please navigate to Canvas first"

**Cause**: You're not on a supported Canvas/Brightspace domain.

**Solutions**:
1. Navigate to your Canvas LMS (e.g., `yourschool.instructure.com`)
2. Make sure the URL matches a supported domain (see below)
3. If your school uses a custom domain, run `bash scripts/add_school.sh` to add it

**Supported domains**: `*.instructure.com`, `bcourses.berkeley.edu`, `bruinlearn.ucla.edu`, `canvas.ucsd.edu`, `canvas.asu.edu`, `canvas.mit.edu`

### Extension icon is grayed out

**Cause**: The extension is disabled or not loaded properly.

**Solutions**:
1. Go to `chrome://extensions`
2. Make sure Canvascope is enabled (toggle is blue)
3. If there are errors, click "Errors" to see details
4. Try clicking the refresh icon (↻) on the extension card

### Clicking extension does nothing

**Cause**: Popup failed to load.

**Solutions**:
1. Right-click the extension icon → "Inspect popup"
2. Check the Console tab for errors
3. Reload the extension from `chrome://extensions`

---

## 🔴 Scanning Issues

### "Re-scan Canvas" button doesn't work

**Cause**: Content script not loaded.

**Solutions**:
1. Refresh the Canvas page (Ctrl/Cmd + R)
2. Wait for the page to fully load
3. Try scanning again

### Scan completes but finds 0 items

**Cause**: You may need to navigate to a course page first.

**Solutions**:
1. Navigate to a **specific course page** (not just the dashboard)
2. Canvascope auto-syncs via background — wait a few seconds and check again
3. Click **Re-scan** to force a manual refresh

### Scan is stuck or very slow

**Cause**: Very large page or browser issue.

**Solutions**:
1. Wait up to 30 seconds
2. Close other heavy tabs
3. Refresh the page and try again
4. Check browser console for errors

---

## 🔴 Search Issues

### No search results

**Cause**: Content not indexed or search query too specific.

**Solutions**:
1. Click "Re-scan Canvas" to index current page
2. Try broader search terms
3. Check if any content is indexed (see stats at bottom)

### Search results don't match what I typed

**Cause**: Fuzzy search is designed to handle typos, and abbreviations auto-expand.

**Note**: Canvascope expands abbreviations automatically (e.g., `hw` → "homework", `lec` → "lecture"). This is expected behavior.

**Tips for better results**:
- Use **course-scoped search**: `chem 3a hw a` or `hw a chem 3a`
- Single letters work as identifiers: `hw g` finds "Homework G"
- Abbreviation cheat sheet: `hw`, `proj`, `lec`, `lab`, `assn`, `ch`, `disc`

### Clicking a result opens wrong page

**Cause**: The linked content may have moved in Canvas.

**Solutions**:
1. Re-scan the course to update links
2. Clear data and re-scan

---

## 🔴 Data Issues

### "Clear All Data" doesn't work

**Cause**: Storage permission issue.

**Solutions**:
1. Try refreshing the popup
2. Reinstall the extension
3. Check for Chrome updates

### Data persists after clearing

**Cause**: Browser caching.

**Solutions**:
1. Close and reopen Chrome
2. Check if data is actually cleared (stats should show 0)

### Indexed content is outdated

**Cause**: Canvas content changed after scanning.

**Solution**: Re-scan the affected course pages regularly.

---

## 🔴 Custom Domain Setup

If your school uses a custom Canvas domain (not `*.instructure.com`):

### Step 1: Edit manifest.json

Open `manifest.json` and find the `host_permissions` section:

```json
"host_permissions": [
  "*://*.instructure.com/*"
]
```

### Step 2: Add your domain

Add your school's domain:

```json
"host_permissions": [
  "*://*.instructure.com/*",
  "*://*.yourschool.edu/*"
]
```

### Step 3: Update content_scripts

Also update the `matches` in `content_scripts`:

```json
"content_scripts": [
  {
    "matches": [
      "*://*.instructure.com/*",
      "*://*.yourschool.edu/*"
    ],
    ...
  }
]
```

### Step 4: Reload extension

1. Go to `chrome://extensions`
2. Click the refresh icon on Canvascope

### Step 5: Update content.js (optional)

For full security, also update `isCanvasDomain()` in `content.js`:

```javascript
function isCanvasDomain() {
  const hostname = window.location.hostname.toLowerCase();
  if (hostname.endsWith('.instructure.com')) return true;
  if (hostname.endsWith('.yourschool.edu')) return true;
  return false;
}
```

---

## 🔴 ⌘K Overlay Issues

### ⌘K shortcut doesn't work

**Cause**: Content script may not be loaded on the page.

**Solutions**:
1. Refresh the Canvas page (⌘R / Ctrl+R)
2. Make sure you're on a supported Canvas domain
3. Check if another extension is intercepting the shortcut

### Overlay opens but shows no results

**Cause**: Content hasn't been indexed yet.

**Solution**: Wait for auto-sync to complete, or click Re-scan in the popup first.

---

## 🔴 Due Date Planner Issues

### Due dates not showing

**Cause**: Assignments without due dates in Canvas won't appear in the planner.

**Solution**: Only assignments with due dates set by your instructor will appear.

### Dismissed tasks reappearing

**Cause**: Data cleared or extension reloaded.

**Solution**: Dismissed state is stored locally. Clearing all data will reset dismissals.

---

## 🔴 Error Messages

### "Receiving end does not exist"

**Cause**: Content script not loaded on the page.

**Solution**: Refresh the Canvas page.

### "Extension context invalidated"

**Cause**: The `background-wrapper.js` file is missing or has a typo.

**Solution**: Verify `background-wrapper.js` exists in the extension folder. Refresh Canvas pages.

### Console errors in popup

**How to view**:
1. Right-click extension icon
2. Click "Inspect popup"
3. Go to Console tab

**Common errors and fixes**:

| Error | Cause | Fix |
|-------|-------|-----|
| `Fuse is not defined` | Library not loaded | Check `lib/fuse.min.js` exists |
| `Cannot read property of null` | DOM element missing | Reload extension |
| `chrome.storage is undefined` | Permission issue | Reinstall extension |

---

## 🔴 Performance Issues

### Extension makes browser slow

**Cause**: Too much indexed content.

**Solutions**:
1. Clear old data periodically
2. Only sync courses you actively use
3. Check for memory leaks in DevTools

### Popup takes long to open

**Cause**: Large amount of indexed content.

**Solutions**:
1. This is normal with 5000+ items
2. Wait for it to load
3. Consider clearing unused course data

---

## 🛠️ Debug Mode

For advanced troubleshooting:

### Enable console logging

All modules log to console with prefix `[Canvascope]`.

**To view logs**:
1. Popup: Right-click icon → Inspect popup → Console
2. Content script: Open Canvas page → F12 → Console
3. Background: Go to `chrome://extensions` → Canvascope → "service worker" link

### Common log patterns

```
[Canvascope] Popup initialized          // Popup loaded OK
[Canvascope Content] Content script loaded  // Content script OK
[Canvascope] Service worker started     // Background OK
[Canvascope] Course-scoped search: "chem 3a" → "hw g"  // Course scope detected
```

---

## 📧 Still Need Help?

If none of these solutions work:

1. **Check Chrome version**: Update Chrome to latest
2. **Try incognito mode**: Enable "Allow in incognito" in `chrome://extensions`
3. **Disable other extensions**: Remove conflicts
4. **Reinstall fresh**: Remove extension and install again

### Reporting Issues

When reporting a bug, please include:
- Chrome version (`chrome://version`)
- Extension version (2.1.0 — visible in `chrome://extensions`)
- Steps to reproduce
- Console error messages (if any)
- Screenshot (if visual issue)

You can also submit bugs via the [Google Form](https://forms.gle/f1f1JEmobmM1bapT6).
