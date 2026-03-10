import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, requireUuid } from "../_shared/device-auth.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";

type RegisterDeviceV2Payload = {
  deviceId?: string;
  deviceName?: string;
  clientKind?: "canvascope_extension" | "lectra_ipad";
  pushToken?: string;
  pushEnvironment?: "sandbox" | "production";
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
    const payload = (await request.json()) as RegisterDeviceV2Payload;
    const deviceId = String(payload.deviceId ?? "").trim();
    const clientKind = payload.clientKind === "lectra_ipad" ? "lectra_ipad" : "canvascope_extension";
    const defaultName = clientKind === "lectra_ipad" ? "Lectra iPad" : "Canvascope Receiver";
    const deviceName = String(payload.deviceName ?? defaultName)
      .trim()
      .slice(0, 64) || defaultName;

    requireUuid(deviceId, "deviceId");

    const { data: existing, error: existingError } = await admin
      .from("devices")
      .select("id, user_id")
      .eq("id", deviceId)
      .maybeSingle();

    if (existingError) {
      throw new Error(`Failed to check existing device: ${existingError.message}`);
    }

    if (existing?.user_id && existing.user_id !== user.id) {
      return json({ error: "Device belongs to another account" }, 409);
    }

    const pushToken = payload.pushToken ? String(payload.pushToken).trim() : null;
    const pushEnvironment = payload.pushEnvironment === "sandbox" ? "sandbox" : payload.pushEnvironment === "production" ? "production" : null;

    const now = new Date().toISOString();
    const { error: upsertError } = await admin.from("devices").upsert(
      {
        id: deviceId,
        user_id: user.id,
        name: deviceName,
        client_kind: clientKind,
        push_token: pushToken,
        push_environment: pushEnvironment,
        push_token_updated_at: pushToken ? now : null,
        revoked_at: null,
        last_seen_at: now,
      },
      {
        onConflict: "id",
      },
    );

    if (upsertError) {
      throw new Error(`Failed to register device: ${upsertError.message}`);
    }

    return json({ ok: true, deviceId, deviceName, userId: user.id, lastSeenAt: now });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return json({ error: message }, status);
  }
});
