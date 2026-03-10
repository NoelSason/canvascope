import { corsHeaders, json } from "../_shared/cors.ts";
import { admin, requireUuid } from "../_shared/device-auth.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";

type UploadStatusPayload = {
  uploadId?: string;
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
    const payload = (await request.json()) as UploadStatusPayload;
    const uploadId = String(payload.uploadId ?? "").trim();

    requireUuid(uploadId, "uploadId");

    const { data, error } = await admin
      .from("uploads")
      .select("id, status, downloaded_at, expires_at, created_at")
      .eq("id", uploadId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch upload status: ${error.message}`);
    }

    if (!data) {
      return json({ error: "Upload not found" }, 404);
    }

    return json({
      ok: true,
      uploadId: data.id,
      status: data.status,
      createdAt: data.created_at,
      downloadedAt: data.downloaded_at,
      expiresAt: data.expires_at,
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
