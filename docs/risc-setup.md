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

## Follow-up (not yet built)
`risc_account_flags.signin_blocked` is recorded but **not yet enforced** at
sign-in. To actually block a flagged user, add a Supabase auth hook
(`before_user_created` / `custom_access_token`) that rejects when the flag is
set, and disable account-recovery email for that user.
