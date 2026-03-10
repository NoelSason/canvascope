import { corsHeaders, json } from "../_shared/cors.ts";
import { admin } from "../_shared/device-auth.ts";
import { isServiceRoleRequest } from "../_shared/auth-user.ts";

const BATCH_LIMIT = 500;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!isServiceRoleRequest(request)) {
    return json({ error: "Service-role authorization required" }, 403);
  }

  try {
    const nowIso = new Date().toISOString();
    const terminalCutoffIso = new Date(Date.now() - TERMINAL_RETENTION_MS).toISOString();

    const { data: expiredRows, error: listError } = await admin
      .from("uploads")
      .select("id, object_path")
      .in("status", ["queued", "downloading"])
      .lte("expires_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (listError) {
      throw new Error(`Failed to list expired uploads: ${listError.message}`);
    }

    let canceledCount = 0;
    let removedObjectCount = 0;

    if (expiredRows && expiredRows.length > 0) {
      const uploadIds = expiredRows.map((row) => row.id);
      const objectPaths = expiredRows.map((row) => row.object_path).filter(Boolean);

      if (objectPaths.length > 0) {
        await admin.storage.from("drops").remove(objectPaths);
        removedObjectCount += objectPaths.length;
      }

      const { error: cancelError } = await admin
        .from("uploads")
        .update({
          status: "canceled",
          claimed_at: null,
        })
        .in("id", uploadIds)
        .in("status", ["queued", "downloading"]);

      if (cancelError) {
        throw new Error(`Failed to mark expired uploads as canceled: ${cancelError.message}`);
      }
      canceledCount = uploadIds.length;
    }

    // Purge terminal metadata older than retention to keep the uploads table lean.
    const { data: staleTerminalRows, error: staleListError } = await admin
      .from("uploads")
      .select("id, object_path")
      .in("status", ["downloaded", "canceled"])
      .lte("created_at", terminalCutoffIso)
      .order("created_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (staleListError) {
      throw new Error(`Failed to list stale terminal uploads: ${staleListError.message}`);
    }

    let purgedCount = 0;
    if (staleTerminalRows && staleTerminalRows.length > 0) {
      const staleIds = staleTerminalRows.map((row) => row.id);
      const stalePaths = staleTerminalRows.map((row) => row.object_path).filter(Boolean);

      if (stalePaths.length > 0) {
        await admin.storage.from("drops").remove(stalePaths);
        removedObjectCount += stalePaths.length;
      }

      const { error: deleteError } = await admin.from("uploads").delete().in("id", staleIds);
      if (deleteError) {
        throw new Error(`Failed to purge stale terminal uploads: ${deleteError.message}`);
      }

      purgedCount = staleIds.length;
    }

    return json({
      ok: true,
      canceledCount,
      removedObjectCount,
      purgedTerminalCount: purgedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ error: message }, 500);
  }
});
