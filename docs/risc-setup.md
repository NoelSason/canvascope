# Cross-Account Protection (RISC) setup

Google RISC notifies us when a shared user's Google Account changes in a way
that could compromise their Canvascope account (hijacking, account disabled,
sessions revoked). We validate the signed event and revoke the user's Supabase
sessions so they must re-authenticate.

## What's already built and deployed

| Piece | Location | State |
|-------|----------|-------|
| Receiver endpoint | `supabase/functions/risc-receiver/index.ts` | **Deployed** (`verify_jwt=false`) |
| Schema (audit/dedup + helpers) | `supabase/migrations/20260612120000_risc_cross_account_protection.sql` | **Applied** |
| Registration CLI | `scripts/risc-register.mjs` | Ready |

Direct function URL (do **not** register this — see step 3):
`https://vcadcdgnwxjlgaoqktkd.supabase.co/functions/v1/risc-receiver`

## Remaining setup (manual)

### 1. GCP service account (Console)
In the **same** GCP project as your Google OAuth client:
1. APIs & Services → Credentials → **Create credentials → Service account**.
2. Grant it the role **RISC Configuration Admin** (`roles/riscconfigs.admin`).
3. Create a **JSON key** and download it. Keep it secret; do not commit it.

### 2. Enable the RISC API (Console)
Open the **RISC API** page, read the RISC Terms, and click **Enable**.

### 3. Expose the receiver on canvascope.org (Vercel / Next.js)
RISC requires the delivery endpoint's domain to be a verified **Authorized
Domain** on the OAuth project. `*.supabase.co` can't be verified, but
`canvascope.org` already is (the `medmatch.canvascope.org/api/auth/google/callback`
redirect URI auto-authorized it). The web app (`web/extension-web`, deployed at
**medmatch.canvascope.org**) carries a thin reverse-proxy route handler:

- File: `web/extension-web/src/app/api/risc-receiver/route.ts`
- Forwards the POST to the Supabase `risc-receiver` edge function and passes the
  status back unchanged.

Deploy the web app (push to its Vercel project), then confirm the proxy forwards
POST bodies (should return `400` for a bogus token, same as the function):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://medmatch.canvascope.org/api/risc-receiver --data "not-a-token"   # expect 400
```

### 4. Register the stream
The service-account key lives at `.secrets/risc-service-account.json` (gitignored).
From `app/extension-core`:

```bash
KEY=.secrets/risc-service-account.json
node scripts/risc-register.mjs --key $KEY get                          # confirm auth/role
node scripts/risc-register.mjs --key $KEY update https://medmatch.canvascope.org/api/risc-receiver
node scripts/risc-register.mjs --key $KEY verify "hello-canvascope"    # send a test token
```
After `verify`, check the `risc_events` table (or function logs) for a
`verification` row — that confirms the full path works.

## Audience (`aud`) check
The receiver only accepts tokens whose `aud` is a known OAuth client ID. It
defaults to the extension manifest client id
`961806200943-…6deqch1r87uthbarmr7te483u4h7fn9m`. **Verify this matches the
Google Web client ID configured in Supabase Auth's Google provider.** If your
users sign in with a different/additional client, set the
`RISC_ALLOWED_AUDIENCES` secret (comma-separated) on the function.

## How events are handled
- `sessions-revoked`, `tokens-revoked`, `token-revoked`,
  `account-credential-change-required` → revoke the user's Supabase sessions.
- `account-disabled` → revoke sessions; unless `reason=bulk-account`, also set
  `risc_account_flags.signin_blocked = true`.
- `account-enabled` → clear `signin_blocked`.
- `verification` → logged only.

Events are deduped on the token's `jti` (`risc_events` primary key).

## Sign-in enforcement (Custom Access Token hook)
`account-disabled` events set `risc_account_flags.signin_blocked = true`. That
flag is enforced by the Postgres function `public.risc_enforce_signin_block`
(migration `20260613120000_risc_signin_block_hook.sql`), wired as Supabase's
**Custom Access Token** auth hook. Supabase runs it on every token issuance
(sign-in and refresh); for a blocked user it returns an HTTP 403 error that
aborts token issuance, so the account can't sign back in or refresh until an
`account-enabled` event clears the flag. The hook **fails open**: any internal
error returns the token unchanged, so a bug can never lock out all users.

**Enable it (one-time, per project)** — the function is deployed but the hook
must be turned on in the project's auth config:
- Dashboard → Authentication → Hooks → **Customize Access Token (JWT) Claims**
  → enable → select `public.risc_enforce_signin_block`, **or**
- run `supabase config push` (config.toml already sets
  `[auth.hook.custom_access_token]`).

Verify with:
```sql
-- 403 for a flagged user, claims passthrough for everyone else
select public.risc_enforce_signin_block(
  jsonb_build_object('user_id', '<some-user-uuid>', 'claims', '{}'::jsonb));
```

## Follow-up (optional)
Disable Google account-recovery email for a blocked user (RISC "suggested"
action) — not automated; handle case-by-case if needed.
