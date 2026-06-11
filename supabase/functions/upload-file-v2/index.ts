import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, sanitizeFileName } from "../_shared/device-auth.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";
import { sendApnsPush } from "../_shared/apns.ts";
import { recordDropBridgeReceipt } from "../_shared/dropbridge-receipts.ts";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;
const ACTIVE_RECEIVER_WINDOW_MS = 12 * 60 * 1000;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const user = await requireAuthUser(request);
    const formData = await request.formData();
    const file = formData.get("file");
    const receiverKindField = String(formData.get("receiverKind") ?? "canvascope_extension").trim();
    const receiverKind = receiverKindField === "lectra_ipad" ? "lectra_ipad" : "canvascope_extension";
    const senderKindField = String(formData.get("senderKind") ?? "").trim();
    const senderKind = senderKindField === "lectra_ipad" ? "lectra_ipad" : senderKindField === "canvascope_extension" ? "canvascope_extension" : "";
    const senderDeviceId = String(formData.get("senderDeviceId") ?? "").trim();
    const metadataStr = String(formData.get("metadata") ?? "{}").trim();
    let metadata = {};
    try {
      metadata = JSON.parse(metadataStr);
    } catch {
      console.error("Failed to parse metadata JSON:", metadataStr);
    }

    console.log("Parsed FormData Fields:", {
      receiverKindField,
      senderKindField,
      senderDeviceId,
      metadata,
      fileSize: (formData.get("file") as File)?.size
    });

    if (!(file instanceof File)) {
      return json({ error: "Missing file field" }, 400);
    }

    if (file.size <= 0) {
      return json({ error: "File is empty" }, 400);
    }

    if (file.size > MAX_FILE_BYTES) {
      return json({ error: `File exceeds ${MAX_FILE_BYTES} byte limit` }, 413);
    }
    const activeReceiverCutoff = new Date(Date.now() - ACTIVE_RECEIVER_WINDOW_MS).toISOString();

    let receiverQuery = admin
      .from("devices")
      .select("id, last_seen_at, push_token, push_environment")
      .eq("user_id", user.id)
      .eq("client_kind", receiverKind)
      .is("revoked_at", null)
      .gt("last_seen_at", activeReceiverCutoff)
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(1);

    // Prevent loopback routing for the sender device.
    if (senderDeviceId) {
      receiverQuery = receiverQuery.neq("id", senderDeviceId);
    }

    let { data: receiver, error: receiverError } = await receiverQuery.maybeSingle();

    // Fallback to the most recently seen receiver when heartbeat is stale/missing.
    if (!receiver && !receiverError) {
      let fallbackQuery = admin
        .from("devices")
        .select("id, last_seen_at, push_token, push_environment")
        .eq("user_id", user.id)
        .eq("client_kind", receiverKind)
        .is("revoked_at", null)
        .order("last_seen_at", { ascending: false, nullsFirst: false })
        .limit(1);

      if (senderDeviceId) {
        fallbackQuery = fallbackQuery.neq("id", senderDeviceId);
      }

      const fallback = await fallbackQuery.maybeSingle();
      receiver = fallback.data;
      receiverError = fallback.error;
    }

    if (receiverError) {
      throw new Error(`Receiver lookup failed: ${receiverError.message}`);
    }

    if (!receiver) {
      return json(
        {
          error: receiverKind === "lectra_ipad"
            ? "No active Lectra receiver found. Open Lectra on iPad and try again."
            : "No active Canvascope receiver found. Open the Canvascope extension and try again.",
        },
        404,
      );
    }

    const uploadId = crypto.randomUUID();
    const fileName = sanitizeFileName(file.name || "upload.bin");
    const objectPath = `${user.id}/${receiver.id}/${uploadId}-${fileName}`;
    const contentType = file.type || "application/octet-stream";
    const expiresAt = new Date(Date.now() + QUEUE_RETENTION_MS).toISOString();
    const receiverWasActive = Boolean(receiver.last_seen_at && receiver.last_seen_at > activeReceiverCutoff);
    const arrayBuffer = await file.arrayBuffer();

    const { error: storageError } = await admin.storage.from("drops").upload(objectPath, arrayBuffer, {
      contentType,
      upsert: false,
    });

    if (storageError) {
      throw new Error(`Storage upload failed: ${storageError.message}`);
    }

    const { error: rowError } = await admin.from("uploads").insert({
      id: uploadId,
      user_id: user.id,
      device_id: receiver.id,
      file_name: fileName,
      object_path: objectPath,
      mime_type: contentType,
      size_bytes: file.size,
      status: "queued",
      expires_at: expiresAt,
      metadata: metadata,
    });

    if (rowError) {
      await admin.storage.from("drops").remove([objectPath]);
      throw new Error(`Failed to record upload metadata: ${rowError.message}`);
    }

    await recordDropBridgeReceipt({
      uploadId,
      userId: user.id,
      deviceId: receiver.id,
      stage: "queued",
      detail: {
        receiverKind,
        senderKind: senderKind || null,
        fileName,
        sizeBytes: file.size,
        mimeType: contentType,
      },
    });

    if (receiver.push_token && receiver.push_environment) {
      try {
        await sendApnsPush(receiver.push_token, receiver.push_environment, {
          aps: { "content-available": 1 },
          event: "upload_queued"
        });
      } catch (pushErr) {
        console.error("Delayed APNs push failure:", pushErr);
      }
    }

    return json({
      ok: true,
      uploadId,
      fileName,
      sizeBytes: file.size,
      contentType,
      receiverId: receiver.id,
      receiverLastSeenAt: receiver.last_seen_at,
      receiverWasActive,
      expiresAt,
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
