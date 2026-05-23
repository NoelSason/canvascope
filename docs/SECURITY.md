# Canvascope - Security Documentation

This document summarizes the security model for Canvascope v7.0.0, including optional Lectra sync flows.

---

## Security Principles

1. Local-first indexing by default
2. Least-privilege extension permissions
3. Explicit user action for cloud sync (`Send to Lectra`)
4. Defense-in-depth with CSP + domain checks + backend RLS

---

## Threat Model

### Primary risks and mitigations

| Threat | Risk | Mitigation |
|---|---|---|
| XSS in extension UI | High | No inline scripts, strict CSP, avoid unsafe DOM insertion |
| Unauthorized data access | High | Host permission scoping + domain validation + Supabase RLS |
| Credential/session misuse | Medium | Supabase auth session isolation in extension storage adapter |
| PDF abuse (wrong file/type/size) | Medium | Signature checks + 25 MB size cap + MIME constraints in storage policy |
| Malicious extension interference | Medium | Out of scope; user browser hardening recommended |

### Out of scope

- Compromised local machine/browser profile
- Other installed extensions with broad permissions
- Account compromise outside this extension

---

## Permission Review

### `storage`
Stores search index, preferences, and auth session artifacts.

### `activeTab`
Used for tab-scoped actions and LMS/PDF context resolution.

### `tabs`
Reads active tab context for scan triggers and routing.

### `alarms`
Schedules background sync timers.

### `scripting`
Used for frame scanning and extension script execution paths.

### `identity`
Enables Google OAuth sign-in flow.

### `downloads`
Used by DropBridge file-transfer workflow in background service worker.

### Host permissions
- LMS: `*.instructure.com`, `*.brightspace.com`, `*.d2l.com`, plus known school domains
- Backend: `https://*.supabase.co/*`

Purpose: LMS data fetch + optional Lectra PDF upload/metadata sync.

---

## Network Data Flows

Canvascope performs network operations for:
- LMS content retrieval (Canvas/Brightspace)
- Optional auth/session handling with Supabase/Google OAuth
- Optional Lectra sync flows: `Send to Lectra` via `lectra_documents` + `synced_items`, plus DropBridge v2 browser receive for Lectra -> Canvascope

Canvascope does not include ad/analytics SDK calls.

---

## Lectra Sync Controls

`Send to Lectra` enforces:
- User confirmation prompt
- Authenticated session requirement
- PDF signature validation
- 25 MB upper bound
- RLS-restricted `lectra_documents` storage bucket for Canvascope -> Lectra
- `synced_items` registration for Lectra pickup
- Private DropBridge queue + realtime wake topic authorization for Lectra -> Canvascope

Required migration:
- `supabase/migrations/20260304211400_add_lectra_documents_storage.sql`
- `supabase/migrations/20260309120000_dropbridge_v2_wake_metadata_push.sql`

---

## CSP

From `manifest.json`:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'none'; base-uri 'none';"
}
```

This blocks inline/external script execution in extension pages.

---

## Security Checklist

- [ ] `manifest_version` is 3
- [ ] Host permissions remain limited to required domains
- [ ] No remote script execution or `eval`
- [ ] `Send to Lectra` requires explicit user action + auth
- [ ] Supabase storage/database policies enforce per-user access
- [ ] Console logs avoid sensitive secrets/content

---

## Incident Response

If you discover a vulnerability:
1. Do not publish exploit details publicly first.
2. Share reproduction steps privately with maintainers.
3. Include version, environment, and logs.
4. Coordinate patch and disclosure timeline.
