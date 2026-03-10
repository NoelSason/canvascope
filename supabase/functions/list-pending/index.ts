import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, requireToken, requireUuid, validateDevice } from "../_shared/device-auth.ts";

type PendingPayload = {
  deviceId?: string;
  deviceToken?: string;
  limit?: number;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const payload = (await request.json()) as PendingPayload;
    const deviceId = (payload.deviceId ?? "").trim();
    const deviceToken = (payload.deviceToken ?? "").trim();
    const limit = Math.max(1, Math.min(Number(payload.limit ?? 5), 10));

    requireUuid(deviceId, "deviceId");
    requireToken(deviceToken);
    await validateDevice(deviceId, deviceToken);

    const staleClaimCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await admin
      .from("uploads")
      .update({ status: "queued", claimed_at: null })
      .eq("device_id", deviceId)
      .eq("status", "downloading")
      .lt("claimed_at", staleClaimCutoff);

    const { data: queuedRows, error: queueError } = await admin
      .from("uploads")
      .select("id")
      .eq("device_id", deviceId)
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (queueError) {
      throw new Error(`Unable to list pending uploads: ${queueError.message}`);
    }

    if (!queuedRows || queuedRows.length === 0) {
      return json({ ok: true, uploads: [] });
    }

    const ids = queuedRows.map((row) => row.id);

    const { data: claimedRows, error: claimError } = await admin
      .from("uploads")
      .update({
        status: "downloading",
        claimed_at: new Date().toISOString(),
      })
      .in("id", ids)
      .eq("status", "queued")
      .select("id, file_name, object_path, mime_type, size_bytes, created_at");

    if (claimError) {
      throw new Error(`Unable to claim uploads: ${claimError.message}`);
    }

    if (!claimedRows || claimedRows.length === 0) {
      return json({ ok: true, uploads: [] });
    }

    const uploads = [];

    for (const row of claimedRows) {
      const { data: signedData, error: signedError } = await admin.storage
        .from("drops")
        .createSignedUrl(row.object_path, 60 * 5);

      if (signedError || !signedData?.signedUrl) {
        // Put the upload back into queue if signed URL generation fails.
        await admin
          .from("uploads")
          .update({ status: "queued", claimed_at: null })
          .eq("id", row.id)
          .eq("device_id", deviceId);
        continue;
      }

      uploads.push({
        id: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at,
        downloadUrl: signedData.signedUrl,
      });
    }

    return json({ ok: true, uploads });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return json({ error: message }, status);
  }
});
