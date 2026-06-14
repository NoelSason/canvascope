// Cross-Account Protection (RISC) event receiver.
//
// Google POSTs cryptographically signed Security Event Tokens (SETs) here when
// a shared user's Google Account changes in a way that may have security
// implications for their Canvascope account. We validate the token against
// Google's RISC signing keys, then act on the event (primarily: revoke the
// user's Supabase sessions so they have to re-authenticate).
//
// Deployed with verify_jwt = false (see supabase/config.toml): the request is
// authenticated by the SET's own signature, not a Supabase JWT.
//
// Docs: https://developers.google.com/identity/protocols/risc

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import * as jose from "https://esm.sh/jose@5.9.6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The `aud` of a RISC token is the Google OAuth client ID that issued the
// user's tokens. Must include every client ID your users sign in with — in
// particular the Web client ID configured in Supabase Auth's Google provider.
// Override via the RISC_ALLOWED_AUDIENCES secret (comma-separated) if needed.
const ALLOWED_AUDIENCES = (Deno.env.get("RISC_ALLOWED_AUDIENCES") ??
  "961806200943-6deqch1r87uthbarmr7te483u4h7fn9m.apps.googleusercontent.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const RISC_CONFIG_URL = "https://accounts.google.com/.well-known/risc-configuration";

const EVENT = {
  SESSIONS_REVOKED: "https://schemas.openid.net/secevent/risc/event-type/sessions-revoked",
  TOKENS_REVOKED: "https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked",
  TOKEN_REVOKED: "https://schemas.openid.net/secevent/oauth/event-type/token-revoked",
  ACCOUNT_DISABLED: "https://schemas.openid.net/secevent/risc/event-type/account-disabled",
  ACCOUNT_ENABLED: "https://schemas.openid.net/secevent/risc/event-type/account-enabled",
  CREDENTIAL_CHANGE_REQUIRED: "https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required",
  VERIFICATION: "https://schemas.openid.net/secevent/risc/event-type/verification",
} as const;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- RISC token verification ------------------------------------------------
// Discovery doc + remote JWKS are fetched once and cached for the worker's
// lifetime. createRemoteJWKSet handles key rotation/refresh internally.
let cached: { issuer: string; jwks: jose.JWTVerifyGetKey } | null = null;

async function getVerifier(): Promise<{ issuer: string; jwks: jose.JWTVerifyGetKey }> {
  if (cached) return cached;
  const res = await fetch(RISC_CONFIG_URL);
  if (!res.ok) throw new Error(`RISC discovery fetch failed: ${res.status}`);
  const cfg = await res.json() as { issuer: string; jwks_uri: string };
  cached = {
    issuer: cfg.issuer,
    jwks: jose.createRemoteJWKSet(new URL(cfg.jwks_uri)),
  };
  return cached;
}

// --- Event handlers ---------------------------------------------------------
async function revokeSessions(userId: string): Promise<number> {
  const { data, error } = await admin.rpc("revoke_user_sessions", { p_user_id: userId });
  if (error) throw new Error(`revoke_user_sessions failed: ${error.message}`);
  return Number(data ?? 0);
}

async function setSigninBlocked(userId: string, blocked: boolean, reason: string | null): Promise<void> {
  const { error } = await admin.from("risc_account_flags").upsert({
    user_id: userId,
    signin_blocked: blocked,
    reason,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw new Error(`risc_account_flags upsert failed: ${error.message}`);
}

async function userIdForSub(sub: string | null): Promise<string | null> {
  if (!sub) return null;
  const { data, error } = await admin.rpc("user_id_for_google_sub", { p_sub: sub });
  if (error) {
    console.error("[RISC] user_id_for_google_sub failed:", error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

// Decide and apply the response for a single event. `tokenType` is the OAuth
// token_type for token(s)-revoked events ("refresh_token" only, per spec).
async function handleEvent(
  type: string,
  detail: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  const reason = typeof detail?.reason === "string" ? detail.reason : null;

  switch (type) {
    case EVENT.VERIFICATION: {
      // Test ping from stream:verify — nothing to do but acknowledge/log.
      const state = typeof detail?.state === "string" ? detail.state : "";
      return `verification(state=${state})`;
    }

    case EVENT.SESSIONS_REVOKED:
    case EVENT.CREDENTIAL_CHANGE_REQUIRED:
    case EVENT.TOKENS_REVOKED:
    case EVENT.TOKEN_REVOKED: {
      if (!userId) return "no_matching_user";
      const n = await revokeSessions(userId);
      return `sessions_revoked(${n})`;
    }

    case EVENT.ACCOUNT_DISABLED: {
      if (!userId) return "no_matching_user";
      // Always end active sessions. For everything except a benign bulk-account
      // disable, also block future Google sign-in until we see account-enabled.
      const n = await revokeSessions(userId);
      if (reason !== "bulk-account") {
        await setSigninBlocked(userId, true, reason ?? "account-disabled");
        return `sessions_revoked(${n})+signin_blocked(reason=${reason ?? "none"})`;
      }
      return `sessions_revoked(${n})+bulk_account_logged`;
    }

    case EVENT.ACCOUNT_ENABLED: {
      if (!userId) return "no_matching_user";
      await setSigninBlocked(userId, false, "account-enabled");
      return "signin_unblocked";
    }

    default:
      return `ignored(unknown_type)`;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // 1. Read and verify the Security Event Token (raw JWT in the body).
  let payload: jose.JWTPayload;
  try {
    const token = (await request.text()).trim();
    if (!token) return new Response("Empty body", { status: 400, headers: corsHeaders });
    const { issuer, jwks } = await getVerifier();
    // Note: SETs are historical and carry no `exp`; jose only enforces exp when
    // present, so no special handling is needed. aud must be one of our client IDs.
    ({ payload } = await jose.jwtVerify(token, jwks, {
      issuer,
      audience: ALLOWED_AUDIENCES,
    }));
  } catch (err) {
    // Bad signature / unknown key / wrong aud or iss / malformed token.
    console.warn("[RISC] Token validation failed:", (err as Error).message);
    return new Response("Invalid security event token", { status: 400, headers: corsHeaders });
  }

  // 2. Idempotency: dedup on jti. If we've seen this token, ack without redoing.
  const jti = String(payload.jti ?? crypto.randomUUID());
  const events = (payload.events ?? {}) as Record<string, Record<string, unknown>>;
  const [firstType, firstDetail] = Object.entries(events)[0] ?? [null, {}];
  const firstSub = (firstDetail?.subject as Record<string, unknown> | undefined)?.sub as string | undefined ?? null;
  const firstUserId = await userIdForSub(firstSub);
  const firstReason = typeof firstDetail?.reason === "string" ? firstDetail.reason : null;

  const { error: insertErr } = await admin.from("risc_events").insert({
    jti,
    event_type: firstType ?? "unknown",
    subject_sub: firstSub,
    user_id: firstUserId,
    reason: firstReason,
    payload,
  });
  if (insertErr) {
    if (insertErr.code === "23505") {
      // Duplicate delivery — already processed. Acknowledge.
      return new Response(null, { status: 202, headers: corsHeaders });
    }
    console.error("[RISC] Failed to record event:", insertErr.message);
    // Fall through and still try to act; recording isn't worth dropping a SET.
  }

  // 3. Act on each event in the token.
  const outcomes: string[] = [];
  for (const [type, detail] of Object.entries(events)) {
    const sub = (detail?.subject as Record<string, unknown> | undefined)?.sub as string | undefined ?? null;
    const userId = sub === firstSub ? firstUserId : await userIdForSub(sub);
    try {
      outcomes.push(`${type.split("/").pop()}=${await handleEvent(type, detail, userId)}`);
    } catch (err) {
      console.error(`[RISC] Handler error for ${type}:`, (err as Error).message);
      outcomes.push(`${type.split("/").pop()}=error`);
    }
  }
  console.log(`[RISC] Processed jti=${jti}: ${outcomes.join(", ")}`);

  // Per spec: return 202 once the token is validated and accepted.
  return new Response(null, { status: 202, headers: corsHeaders });
});
