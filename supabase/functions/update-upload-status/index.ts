import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, requireToken, requireUuid, validateDevice } from "../_shared/device-auth.ts";

type StatusPayload = {
  deviceId?: string;
  deviceToken?: string;
  uploadId?: string;
  status?: "queued" | "downloaded" | "canceled";
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const payload = (await request.json()) as StatusPayload;
    const deviceId = (payload.deviceId ?? "").trim();
    const deviceToken = (payload.deviceToken ?? "").trim();
    const uploadId = (payload.uploadId ?? "").trim();
    const status = payload.status;

    requireUuid(deviceId, "deviceId");
    requireUuid(uploadId, "uploadId");
    requireToken(deviceToken);

    if (status !== "queued" && status !== "downloaded" && status !== "canceled") {
      return json({ error: "Status must be queued, downloaded, or canceled" }, 400);
    }

    await validateDevice(deviceId, deviceToken);

    const patch =
      status === "downloaded"
        ? {
            status,
            claimed_at: null,
            downloaded_at: new Date().toISOString(),
          }
        : {
            status,
            claimed_at: null,
            downloaded_at: null,
          };

    const { data, error } = await admin
      .from("uploads")
      .update(patch)
      .eq("id", uploadId)
      .eq("device_id", deviceId)
      .select("id")
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to update upload status: ${error.message}`);
    }

    if (!data) {
      return json({ error: "Upload not found for device" }, 404);
    }

    return json({ ok: true, uploadId, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return json({ error: message }, status);
  }
});
