import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "").trim();
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Identify the caller from their JWT.
    const { data: { user }, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !user) return json({ error: "unauthorized" }, 401);

    // Load this user's stored refresh token + cached access token (service role bypasses RLS).
    const { data: row, error: rowErr } = await admin
      .from("google_calendar_tokens")
      .select("refresh_token, access_token, access_token_expires_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row || !row.refresh_token) return json({ error: "no_refresh_token" }, 404);

    // Serve the cached access token if it still has >60s of life.
    if (row.access_token && row.access_token_expires_at) {
      const remaining = new Date(row.access_token_expires_at).getTime() - Date.now();
      if (remaining > 60_000) {
        return json({ access_token: row.access_token, cached: true });
      }
    }

    // Exchange the refresh token for a fresh Google access token.
    const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    if (!clientId || !clientSecret) return json({ error: "server_misconfigured", detail: "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set" }, 500);

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    });
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.access_token) {
      return json({ error: "refresh_failed", detail: tokenJson }, 502);
    }

    const expiresAt = new Date(Date.now() + (tokenJson.expires_in ?? 3600) * 1000).toISOString();
    await admin
      .from("google_calendar_tokens")
      .update({
        access_token: tokenJson.access_token,
        access_token_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);

    return json({ access_token: tokenJson.access_token, expires_in: tokenJson.expires_in });
  } catch (e) {
    return json({ error: "exception", message: String((e as Error)?.message || e) }, 500);
  }
});
