# Canvascope - Installation Guide

## Prerequisites

- **Google Chrome** (version 88 or newer)
- Basic familiarity with browser extensions (don't worry, we'll guide you!)

---

## Step-by-Step Installation

### Step 1: Download the Extension

Make sure you have the `Canvascope` folder with these core files:
```
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
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

### Step 2: Open Chrome Extensions Page

1. Open Google Chrome
2. Type `chrome://extensions` in the address bar
3. Press **Enter**

### Step 3: Enable Developer Mode

1. Look at the **top-right corner** of the page
2. Find the toggle switch labeled **"Developer mode"**
3. **Turn it ON** (the toggle should turn blue)

> 💡 **Why Developer Mode?**
> This allows you to load your own extensions that aren't from the Chrome Web Store.
> It's completely safe for extensions you trust!

### Step 4: Load the Extension

1. Click the **"Load unpacked"** button (appears after enabling Developer mode)
2. Navigate to the `extension-core` folder
3. Select the folder and click **"Select"** or **"Open"**

### Step 5: Verify Installation

You should see:
- ✅ "Canvascope" appears in your extensions list with version 2.1.0
- ✅ No error messages (red text)
- ✅ The extension icon appears in your Chrome toolbar

> 💡 **Can't see the icon?**
> Click the puzzle piece icon (🧩) in the toolbar, then pin Canvascope!

---

## First-Time Setup

### 1. Navigate to Canvas

Open your school's Canvas LMS in a new tab:
- Usually something like `yourschool.instructure.com`
- Supported custom domains: `bcourses.berkeley.edu`, `bruinlearn.ucla.edu`, `canvas.ucsd.edu`, `canvas.asu.edu`, `canvas.mit.edu`

### 2. Auto-Sync

Canvascope will automatically detect the Canvas tab and begin indexing your courses in the background. You'll see a sync progress bar in the popup.

### 3. Click the Extension Icon

Click the Canvascope icon in your toolbar to open the search popup.

### 4. Start Searching!

Type anything in the search box. Try these:
- `hw 4` — finds Homework 4
- `chem 3a hw a` — finds Homework A in Chem 3A
- `lab b lecture` — finds Lab B Lecture materials

### 5. Use ⌘K Overlay (Optional)

Press **⌘K** (Mac) or **Ctrl+K** (Windows) on any Canvas page to open the Spotlight-style search overlay.

---

## Adding Your School

If your school uses a custom Canvas domain not listed above:

```bash
bash scripts/add_school.sh https://yourschool.instructure.com
```

This automatically updates `manifest.json`, `content.js`, `background.js`, and `popup.js`.

---

## Updating the Extension

When you get a new version:

1. Pull the latest changes or extract the new version
2. Go to `chrome://extensions`
3. Click the **refresh icon** (↻) on the Canvascope card
4. Your indexed content is preserved between updates

---

## Troubleshooting Installation

### Error: "Manifest file is missing or unreadable"

**Cause**: You selected the wrong folder or files are missing.

**Solution**: Make sure you're selecting the `extension-core` folder that contains `manifest.json`, not a parent folder.

### Error: "service_worker must be a valid file"

**Cause**: The `background-wrapper.js` file is missing.

**Solution**: Verify `background-wrapper.js` exists in the extension folder.

### Extension icon is grayed out

**Cause**: You're not on a Canvas page.

**Solution**: Navigate to your Canvas LMS first. The extension activates on supported LMS domains.

---

## Uninstalling

To completely remove Canvascope:

### Option 1: From Chrome
1. Go to `chrome://extensions`
2. Find "Canvascope"
3. Click **"Remove"**
4. Confirm the removal

### Option 2: Clear Data First (Recommended)
1. Click the Canvascope icon
2. Click **"Clear All Data"**
3. Then remove from `chrome://extensions`

This ensures all your indexed data is deleted.

---

## Need Help?

Check the [Troubleshooting Guide](./TROUBLESHOOTING.md) for more solutions!
