import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, requireUuid } from "../_shared/device-auth.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";

type ClaimUploadV2Payload = {
  deviceId?: string;
  uploadId?: string;
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
    const payload = (await request.json()) as ClaimUploadV2Payload;
    const deviceId = String(payload.deviceId ?? "").trim();
    const uploadId = String(payload.uploadId ?? "").trim();
    const requestedClientKind = payload.clientKind === "lectra_ipad" ? "lectra_ipad" : "canvascope_extension";

    requireUuid(deviceId, "deviceId");
    requireUuid(uploadId, "uploadId");

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

    const nowIso = new Date().toISOString();

    await admin
      .from("devices")
      .update({ last_seen_at: nowIso })
      .eq("id", deviceId);

    const { data: existingUpload, error: existingUploadError } = await admin
      .from("uploads")
      .select("id, status, expires_at")
      .eq("id", uploadId)
      .eq("user_id", user.id)
      .eq("device_id", deviceId)
      .maybeSingle();

    if (existingUploadError) {
      throw new Error(`Unable to inspect upload: ${existingUploadError.message}`);
    }

    if (!existingUpload) {
      return json({ error: "Upload not found for device" }, 404);
    }

    if (existingUpload.expires_at <= nowIso) {
      if (existingUpload.status === "queued" || existingUpload.status === "downloading") {
        await admin
          .from("uploads")
          .update({ status: "canceled", claimed_at: null })
          .eq("id", uploadId)
          .eq("user_id", user.id)
          .eq("device_id", deviceId);
      }
      return json({ error: "Upload expired" }, 410);
    }

    const { data: claimedUpload, error: claimError } = await admin
      .from("uploads")
      .update({
        status: "downloading",
        claimed_at: nowIso,
      })
      .eq("id", uploadId)
      .eq("user_id", user.id)
      .eq("device_id", deviceId)
      .eq("status", "queued")
      .gt("expires_at", nowIso)
      .select("id, file_name, object_path, mime_type, size_bytes, created_at, expires_at")
      .maybeSingle();

    if (claimError) {
      throw new Error(`Unable to claim upload: ${claimError.message}`);
    }

    if (!claimedUpload) {
      if (existingUpload.status === "downloading") {
        return json({ error: "Upload already claimed" }, 409);
      }
      return json({ error: `Upload is not claimable (${existingUpload.status})` }, 409);
    }

    const { data: signedData, error: signedError } = await admin.storage
      .from("drops")
      .createSignedUrl(claimedUpload.object_path, 60 * 5);

    if (signedError || !signedData?.signedUrl) {
      await admin
        .from("uploads")
        .update({ status: "queued", claimed_at: null })
        .eq("id", claimedUpload.id)
        .eq("user_id", user.id)
        .eq("device_id", deviceId);
      throw new Error(signedError?.message || "Unable to sign download URL");
    }

    return json({
      ok: true,
      upload: {
        id: claimedUpload.id,
        uploadId: claimedUpload.id,
        fileName: claimedUpload.file_name,
        mimeType: claimedUpload.mime_type,
        sizeBytes: claimedUpload.size_bytes,
        createdAt: claimedUpload.created_at,
        expiresAt: claimedUpload.expires_at,
        downloadUrl: signedData.signedUrl,
      },
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
