import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, requireUuid } from "../_shared/device-auth.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";

type StatusV2Payload = {
  deviceId?: string;
  uploadId?: string;
  status?: "queued" | "downloaded" | "canceled";
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
    const payload = (await request.json()) as StatusV2Payload;
    const deviceId = String(payload.deviceId ?? "").trim();
    const uploadId = String(payload.uploadId ?? "").trim();
    const status = payload.status;
    const requestedClientKind = payload.clientKind === "lectra_ipad" ? "lectra_ipad" : "canvascope_extension";

    requireUuid(deviceId, "deviceId");
    requireUuid(uploadId, "uploadId");

    if (status !== "queued" && status !== "downloaded" && status !== "canceled") {
      return json({ error: "Status must be queued, downloaded, or canceled" }, 400);
    }

    const { data: device, error: deviceError } = await admin
      .from("devices")
      .select("id, user_id, revoked_at, client_kind")
      .eq("id", deviceId)
      .maybeSingle();

    if (deviceError) {
      throw new Error(`Unable to look up device: ${deviceError.message}`);
    }

    if (!device) {
      return json({ error: "Device not found" }, 404);
    }

    if (device.user_id !== user.id || device.client_kind !== requestedClientKind || device.revoked_at) {
      return json({ error: "Device does not belong to this account" }, 403);
    }

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
      .eq("user_id", user.id)
      .select("id, object_path")
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to update upload status: ${error.message}`);
    }

    if (!data) {
      return json({ error: "Upload not found for device" }, 404);
    }

    if ((status === "downloaded" || status === "canceled") && data.object_path) {
      await admin.storage.from("drops").remove([data.object_path]);
    }

    return json({ ok: true, uploadId, status });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return json({ error: message }, status);
  }
});
