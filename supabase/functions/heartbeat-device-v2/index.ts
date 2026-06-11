import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, requireUuid } from "../_shared/device-auth.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";

type HeartbeatDeviceV2Payload = {
  deviceId?: string;
  clientKind?: "canvascope_extension" | "lectra_ipad";
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const user = await requireAuthUser(request);
    const payload = (await request.json()) as HeartbeatDeviceV2Payload;
    const deviceId = String(payload.deviceId ?? "").trim();
    const requestedClientKind = payload.clientKind === "lectra_ipad" ? "lectra_ipad" : "canvascope_extension";

    requireUuid(deviceId, "deviceId");

    const nowIso = new Date().toISOString();
    const { data, error } = await admin
      .from("devices")
      .update({ last_seen_at: nowIso })
      .eq("id", deviceId)
      .eq("user_id", user.id)
      .eq("client_kind", requestedClientKind)
      .is("revoked_at", null)
      .select("id, last_seen_at")
      .maybeSingle();

    if (error) {
      throw new Error(`Unable to update heartbeat: ${error.message}`);
    }

    if (!data) {
      return json({ error: "Device not found for account" }, 404);
    }

    return json({
      ok: true,
      deviceId: data.id,
      lastSeenAt: data.last_seen_at,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return json({ error: message }, status);
  }
});
