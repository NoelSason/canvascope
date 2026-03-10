import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, hashToken, requireToken, requireUuid } from "../_shared/device-auth.ts";

type RegisterPayload = {
  deviceId?: string;
  deviceToken?: string;
  deviceName?: string;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const payload = (await request.json()) as RegisterPayload;
    const deviceId = (payload.deviceId ?? "").trim();
    const deviceToken = (payload.deviceToken ?? "").trim();
    const deviceName = (payload.deviceName ?? "My PC").trim().slice(0, 64) || "My PC";

    requireUuid(deviceId, "deviceId");
    requireToken(deviceToken);

    const tokenHash = await hashToken(deviceToken);

    const { data: existing, error: existingError } = await admin
      .from("devices")
      .select("id, device_token_hash")
      .eq("id", deviceId)
      .maybeSingle();

    if (existingError) {
      throw new Error(`Failed to check existing device: ${existingError.message}`);
    }

    if (existing && existing.device_token_hash !== tokenHash) {
      return json({ error: "Device already exists with a different token" }, 409);
    }

    const now = new Date().toISOString();
    const { error: upsertError } = await admin.from("devices").upsert(
      {
        id: deviceId,
        name: deviceName,
        device_token_hash: tokenHash,
        last_seen_at: now,
      },
      {
        onConflict: "id",
      },
    );

    if (upsertError) {
      throw new Error(`Failed to register device: ${upsertError.message}`);
    }

    return json({ ok: true, deviceId, deviceName });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return json({ error: message }, status);
  }
});
