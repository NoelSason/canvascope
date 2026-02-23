# Canvascope - Privacy Policy

**Last Updated**: February 2026 · **Version**: 2.1.0

---

## Summary

Canvascope is a privacy-first Chrome extension built by **Canvascope Inc.** Here's what you need to know:

✅ **All data stays on your computer**
✅ **No academic data is sent to any server**
✅ **No tracking or analytics**
✅ **You can delete all data anytime**

---

## What Data We Collect

When Canvascope auto-syncs or you trigger a manual scan, we index:

| Data Type | Example | Purpose |
|-----------|---------|---------|
| Link titles | "Week 3 Lecture Slides" | Search indexing |
| Link URLs | `https://school.instructure.com/...` | Opening results |
| Module names | "Module 2: Cell Biology" | Search context |
| Folder paths | "1. Homework / 2. Unit 1" | Search context & folder-aware ranking |
| File names | "lecture_notes.pdf" | Search indexing |
| Content types | "pdf", "video", "assignment" | Filtering & intent detection |
| Due dates | "2026-03-15T23:59:00Z" | Due date planner |
| Course names | "Chem 3A (Spring 2025)" | Course-scoped search |

### Click Feedback (Local Only)
We store which search results you open (URL and timestamp) locally to provide a subtle relevance boost for frequently accessed items. This data never leaves your device.

### Optional: Google Sign-In
If you choose to sign in with Google, your email and display name are stored locally for the account profile display. This is used only within the extension and is not sent to any external analytics service.

---

## What We DON'T Collect

❌ **Passwords** — Never accessed or stored
❌ **Grades** — Not collected
❌ **Assignment content** — Only titles and metadata, not actual content
❌ **Messages** — Private messages and discussions are never accessed
❌ **Browsing history** — Only Canvas/Brightspace pages you sync
❌ **Location data** — Not collected
❌ **Cookies** — Never accessed

---

## Where Data Is Stored

All data is stored **locally on your computer** using Chrome's Storage API.

| Storage Type | Location | Access |
|--------------|----------|--------|
| `chrome.storage.local` | Your computer only | This extension only |

**No cloud storage. No external databases for academic data.**

---

## How Data Is Used

Your data is used for **one purpose only**:

> To let you search your Canvas/Brightspace course content quickly.

We do NOT:
- Sell your data
- Share your data
- Analyze your data
- Use your data for advertising
- Send your academic data anywhere

---

## Third-Party Services

| Service | Used? | Notes |
|---------|-------|-------|
| Analytics | ❌ No | No tracking whatsoever |
| Advertising | ❌ No | No ads |
| Cloud storage (academic data) | ❌ No | All local |
| Supabase (bug reports only) | ✅ Optional | Only if user submits a bug report via Google Form sync |
| Google OAuth | ✅ Optional | Only if user chooses to sign in |

---

## Data Retention

**Automatic**: Data is stored until you delete it.

**Manual deletion**: Click "Clear All Data" in the extension popup.

**On uninstall**: Chrome removes all extension data automatically.

---

## Your Rights

You have full control over your data:

1. **View**: Search results show your indexed data
2. **Delete**: Click "Clear All Data" anytime
3. **Export**: Data is stored locally in standard JSON format
4. **Dismiss**: Hide tasks from the due planner

---

## Security

See [SECURITY.md](./SECURITY.md) for detailed security information.

Key points:
- Strict Content Security Policy
- No inline code execution
- Domain verification before any action
- Input sanitization throughout

---

## Children's Privacy

This extension is designed for educational use and does not knowingly collect personal information from children under 13.

---

## Changes to This Policy

If we update this privacy policy, we will:
1. Update the "Last Updated" date
2. Provide a summary of changes
3. Include the new policy in the extension update

---

## Contact

For privacy-related questions or concerns:
1. Review the source code (it's open for inspection)
2. Check the [SECURITY.md](./SECURITY.md) documentation
3. Open an issue on the [GitHub repository](https://github.com/NoelSason/canvascope)

---

## Consent

By using Canvascope, you agree to this privacy policy.

**Remember**: You can uninstall the extension and delete all data at any time.
