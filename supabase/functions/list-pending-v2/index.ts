import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, requireUuid } from "../_shared/device-auth.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";

type PendingV2Payload = {
  deviceId?: string;
  limit?: number;
  clientKind?: "canvascope_extension" | "lectra_ipad";
};

const STALE_CLAIM_WINDOW_MS = 10 * 60 * 1000;
const STALE_DEVICE_WINDOW_MS = 12 * 60 * 1000;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const user = await requireAuthUser(request);
    const payload = (await request.json()) as PendingV2Payload;
    const deviceId = String(payload.deviceId ?? "").trim();
    const requestedClientKind = payload.clientKind === "lectra_ipad" ? "lectra_ipad" : "canvascope_extension";
    const limit = Math.max(1, Math.min(Number(payload.limit ?? 5), 10));

    requireUuid(deviceId, "deviceId");

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

    await admin
      .from("devices")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", deviceId);

    const nowIso = new Date().toISOString();
    const staleClaimCutoff = new Date(Date.now() - STALE_CLAIM_WINDOW_MS).toISOString();

    await admin
      .from("uploads")
      .update({ status: "queued", claimed_at: null })
      .eq("user_id", user.id)
      .eq("device_id", deviceId)
      .eq("status", "downloading")
      .gt("expires_at", nowIso)
      .lt("claimed_at", staleClaimCutoff);

    await admin
      .from("uploads")
      .update({ status: "canceled", claimed_at: null })
      .eq("user_id", user.id)
      .eq("device_id", deviceId)
      .in("status", ["queued", "downloading"])
      .lte("expires_at", nowIso);

    // Healing step: if uploads are queued on another stale device for same account/kind,
    // re-target them to the currently active device.
    const { data: queuedRowsForDevice, error: queueErrorForDevice } = await admin
      .from("uploads")
      .select("id")
      .eq("user_id", user.id)
      .eq("device_id", deviceId)
      .eq("status", "queued")
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (queueErrorForDevice) {
      throw new Error(`Unable to list pending uploads: ${queueErrorForDevice.message}`);
    }

    let queuedRows = queuedRowsForDevice ?? [];

    if (queuedRows.length === 0) {
      const staleSeenCutoff = new Date(Date.now() - STALE_DEVICE_WINDOW_MS).toISOString();

      const { data: queuedCandidateRows, error: queuedCandidateError } = await admin
        .from("uploads")
        .select("id, device_id")
        .eq("user_id", user.id)
        .eq("status", "queued")
        .gt("expires_at", nowIso)
        .order("created_at", { ascending: true })
        .limit(50);

      if (queuedCandidateError) {
        throw new Error(`Unable to inspect queued uploads: ${queuedCandidateError.message}`);
      }

      const { data: staleDownloadingRows, error: staleDownloadingError } = await admin
        .from("uploads")
        .select("id, device_id")
        .eq("user_id", user.id)
        .eq("status", "downloading")
        .gt("expires_at", nowIso)
        .lt("claimed_at", staleClaimCutoff)
        .order("created_at", { ascending: true })
        .limit(50);

      if (staleDownloadingError) {
        throw new Error(`Unable to inspect stale downloading uploads: ${staleDownloadingError.message}`);
      }

      const candidateDeviceIds = Array.from(
        new Set(
          [...(queuedCandidateRows ?? []), ...(staleDownloadingRows ?? [])]
            .map((row) => row.device_id)
            .filter(Boolean),
        ),
      );

      if (candidateDeviceIds.length > 0) {
        const { data: candidateDevices, error: devicesError } = await admin
          .from("devices")
          .select("id, client_kind, revoked_at, last_seen_at")
          .in("id", candidateDeviceIds);

        if (devicesError) {
          throw new Error(`Unable to inspect candidate devices: ${devicesError.message}`);
        }

        const staleDeviceIds = (candidateDevices ?? [])
          .filter((d) => d.client_kind === requestedClientKind && !d.revoked_at)
          .filter((d) => d.id !== deviceId)
          .filter((d) => !d.last_seen_at || d.last_seen_at < staleSeenCutoff)
          .map((d) => d.id);

        if (staleDeviceIds.length > 0) {
          await admin
            .from("uploads")
            .update({ status: "queued", claimed_at: null })
            .eq("user_id", user.id)
            .eq("status", "downloading")
            .gt("expires_at", nowIso)
            .lt("claimed_at", staleClaimCutoff)
            .in("device_id", staleDeviceIds);

          await admin
            .from("uploads")
            .update({ device_id: deviceId })
            .eq("user_id", user.id)
            .eq("status", "queued")
            .in("device_id", staleDeviceIds)
            .gt("expires_at", nowIso);

          const { data: healedRows, error: healedRowsError } = await admin
            .from("uploads")
            .select("id")
            .eq("user_id", user.id)
            .eq("device_id", deviceId)
            .eq("status", "queued")
            .gt("expires_at", nowIso)
            .order("created_at", { ascending: true })
            .limit(limit);

          if (healedRowsError) {
            throw new Error(`Unable to list healed uploads: ${healedRowsError.message}`);
          }

          queuedRows = healedRows ?? [];
        }
      }
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
      .eq("user_id", user.id)
      .eq("device_id", deviceId)
      .eq("status", "queued")
      .select("id, file_name, object_path, mime_type, size_bytes, created_at, expires_at");

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
        await admin
          .from("uploads")
          .update({ status: "queued", claimed_at: null })
          .eq("id", row.id)
          .eq("user_id", user.id)
          .eq("device_id", deviceId);
        continue;
      }

      uploads.push({
        id: row.id,
        uploadId: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        downloadUrl: signedData.signedUrl,
      });
    }

    return json({ ok: true, uploads });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return json({ error: message }, status);
  }
});
