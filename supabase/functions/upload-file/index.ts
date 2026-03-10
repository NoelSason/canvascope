import { corsHeaders, json } from "../_shared/cors.ts";
import {
  admin,
  requireToken,
  requireUuid,
  sanitizeFileName,
  validateDevice,
} from "../_shared/device-auth.ts";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const formData = await request.formData();
    const deviceId = String(formData.get("deviceId") ?? "").trim();
    const deviceToken = String(formData.get("deviceToken") ?? "").trim();
    const file = formData.get("file");

    requireUuid(deviceId, "deviceId");
    requireToken(deviceToken);

    if (!(file instanceof File)) {
      return json({ error: "Missing file field" }, 400);
    }

    if (file.size <= 0) {
      return json({ error: "File is empty" }, 400);
    }

    if (file.size > MAX_FILE_BYTES) {
      return json({ error: `File exceeds ${MAX_FILE_BYTES} byte limit` }, 413);
    }

    await validateDevice(deviceId, deviceToken);

    const uploadId = crypto.randomUUID();
    const fileName = sanitizeFileName(file.name || "upload.bin");
    const objectPath = `${deviceId}/${uploadId}-${fileName}`;
    const contentType = file.type || "application/octet-stream";

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
      device_id: deviceId,
      file_name: fileName,
      object_path: objectPath,
      mime_type: contentType,
      size_bytes: file.size,
      status: "queued",
    });

    if (rowError) {
      // Best-effort cleanup if metadata write fails.
      await admin.storage.from("drops").remove([objectPath]);
      throw new Error(`Failed to record upload metadata: ${rowError.message}`);
    }

    return json({
      ok: true,
      uploadId,
      fileName,
      sizeBytes: file.size,
      contentType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return json({ error: message }, status);
  }
});
