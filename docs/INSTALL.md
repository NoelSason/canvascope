# Canvascope - Installation Guide

## Prerequisites

- **Google Chrome** (version 88 or newer)
- Basic familiarity with browser extensions (don't worry, we'll guide you!)

---

## Step-by-Step Installation

### Step 1: Download the Extension

Make sure you have the `Canvascope` folder with all these files:
```
Canvascope/
├── manifest.json
├── popup.html
├── popup.js
├── content.js
├── background.js
├── styles.css
├── lib/
│   └── fuse.min.js
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Step 2: Open Chrome Extensions Page

1. Open Google Chrome
2. Type `chrome://extensions` in the address bar
3. Press **Enter**

![Chrome Extensions URL](chrome://extensions)

### Step 3: Enable Developer Mode

1. Look at the **top-right corner** of the page
2. Find the toggle switch labeled **"Developer mode"**
3. **Turn it ON** (the toggle should turn blue)

> 💡 **Why Developer Mode?**
> This allows you to load your own extensions that aren't from the Chrome Web Store.
> It's completely safe for extensions you trust!

### Step 4: Load the Extension

1. Click the **"Load unpacked"** button (appears after enabling Developer mode)
2. Navigate to your `Canvascope` folder
3. Select the folder and click **"Select"** or **"Open"**

### Step 5: Verify Installation

You should see:
- ✅ "Canvascope" appears in your extensions list
- ✅ No error messages (red text)
- ✅ The extension icon appears in your Chrome toolbar

> 💡 **Can't see the icon?**
> Click the puzzle piece icon (🧩) in the toolbar, then pin Canvascope!

---

## First-Time Setup

### 1. Navigate to Canvas

Open your school's Canvas LMS in a new tab:
- Usually something like `yourschool.instructure.com`

### 2. Open a Course

Click on any course to view its content.

### 3. Click the Extension Icon

Click the Canvascope icon in your toolbar.

### 4. Scan Your Content

Click **"Re-scan Canvas"** to index the current page's content.

### 5. Start Searching!

Type anything in the search box to find your content.

---

## Updating the Extension

When you get a new version:

1. Delete the old `Canvascope` folder
2. Extract the new version
3. Go to `chrome://extensions`
4. Click the **refresh icon** (↻) on the Canvascope card
5. Or remove and re-add the extension

---

## Troubleshooting Installation

### Error: "Manifest file is missing or unreadable"

**Cause**: You selected the wrong folder or files are missing.

**Solution**: Make sure you're selecting the folder that contains `manifest.json`, not a parent folder.

### Error: "service_worker must be a valid file"

**Cause**: The `background.js` file is missing or has a typo.

**Solution**: Verify `background.js` exists in the extension folder.

### Extension icon is grayed out

**Cause**: You're not on a Canvas page.

**Solution**: Navigate to your Canvas LMS first. The extension only works on `*.instructure.com` domains.

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
