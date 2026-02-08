# Canvas Search - Security Documentation

This document explains the security measures implemented in Canvas Search and provides a checklist for auditing the extension.

---

## Security Principles

Canvas Search follows these core security principles:

1. **Privacy by Default** - All data stays on your computer
2. **Least Privilege** - Only requests minimal permissions
3. **No External Connections** - No data sent to any server
4. **Defense in Depth** - Multiple layers of protection

---

## Threat Model

### What We Protect Against

| Threat | Risk Level | Mitigation |
|--------|------------|------------|
| **XSS (Cross-Site Scripting)** | High | Use `textContent` instead of `innerHTML`; sanitize all inputs |
| **Data Exfiltration** | High | No network requests; all data local |
| **Privilege Escalation** | Medium | Minimal permissions; no `<all_urls>` |
| **Malicious Site Injection** | Medium | Strict Canvas domain verification |
| **Storage Tampering** | Low | Validate data structure on read |
| **Code Injection** | High | Strict CSP; no `eval()`; no inline scripts |

### What We DON'T Protect Against

- **Malicious browser extensions** - Other extensions could access Chrome Storage
- **Physical access** - Someone with your computer can access stored data
- **Compromised browser** - If Chrome itself is compromised

---

## Permissions Explained

### `storage`
**Why needed**: Store indexed Canvas content locally between browser sessions.

**Risk level**: Low - Data stays on device.

### `activeTab`
**Why needed**: Access the current Canvas tab to scan content when user clicks "Re-scan".

**Risk level**: Low - Only activates on user action.

### Host Permission: `*://*.instructure.com/*`
**Why needed**: Run content script on Canvas pages to extract course content.

**Risk level**: Medium - We limit this strictly to Canvas domains only.

---

## Security Audit Checklist

Use this checklist to verify the extension's security:

### ✅ Manifest Security
- [ ] `manifest_version` is 3 (latest, most secure)
- [ ] No `<all_urls>` in host_permissions
- [ ] No `declarativeNetRequest` or `webRequest` permissions
- [ ] CSP disallows inline scripts and eval
- [ ] No `remotely_hosted_code`

### ✅ Content Script Security
- [ ] Domain verification before any DOM access
- [ ] No `eval()` or `new Function()`
- [ ] No `document.write()`
- [ ] No access to cookies or localStorage
- [ ] No authentication bypass attempts

### ✅ Popup Security
- [ ] No `innerHTML` with user data
- [ ] All user input sanitized before display
- [ ] No inline event handlers
- [ ] No external scripts loaded
- [ ] URLs validated before opening

### ✅ Data Security
- [ ] No external network requests
- [ ] All data stored locally only
- [ ] Data deletion option provided
- [ ] No sensitive data logged to console

### ✅ Code Quality
- [ ] All variables properly scoped
- [ ] No global namespace pollution
- [ ] Error handling prevents crashes
- [ ] No dependencies on external CDNs

---

## Content Security Policy

Our CSP settings in `manifest.json`:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'none'; base-uri 'none';"
}
```

### What This Means

| Directive | Value | Effect |
|-----------|-------|--------|
| `script-src 'self'` | Only our own scripts | Blocks inline scripts and external scripts |
| `object-src 'none'` | No plugins | Blocks Flash, Java, etc. |
| `base-uri 'none'` | No base URL | Prevents base tag injection |

---

## Safe Coding Practices Used

### 1. Safe DOM Manipulation

**Instead of:**
```javascript
// DANGEROUS - allows XSS
element.innerHTML = userInput;
```

**We use:**
```javascript
// SAFE - escapes HTML automatically
element.textContent = userInput;
```

### 2. URL Validation

**Before opening any URL:**
```javascript
function isValidCanvasUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname.endsWith('.instructure.com');
  } catch (e) {
    return false;
  }
}
```

### 3. Domain Verification

**Before running any content script logic:**
```javascript
function isCanvasDomain() {
  const hostname = window.location.hostname.toLowerCase();
  return hostname.endsWith('.instructure.com');
}

if (!isCanvasDomain()) {
  // Don't run - not on Canvas
  return;
}
```

---

## Data Handling

### What We Collect

| Data | Purpose | Storage |
|------|---------|---------|
| Link titles | Search indexing | Local Chrome Storage |
| Link URLs | Navigation | Local Chrome Storage |
| Module names | Search context | Local Chrome Storage |
| File names | Search indexing | Local Chrome Storage |

### What We DON'T Collect

- ❌ Passwords or authentication tokens
- ❌ Personal information
- ❌ Assignment content or grades
- ❌ Discussion posts or messages
- ❌ Any data from non-Canvas sites

### Data Lifecycle

1. **Collection**: Only when user clicks "Re-scan Canvas"
2. **Storage**: Local Chrome Storage only
3. **Access**: Only by this extension
4. **Deletion**: User can click "Clear All Data" anytime

---

## Reporting Security Issues

If you find a security vulnerability:

1. **Do not** post publicly
2. Document the issue with steps to reproduce
3. Contact the maintainer privately
4. Allow time for a fix before disclosure

---

## Security Updates

When updating the extension:

1. Review all code changes
2. Run through Security Audit Checklist
3. Test on a non-production Canvas account first
4. Keep backups of previous working versions
