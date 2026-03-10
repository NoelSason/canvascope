import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
}

export const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
  },
});

export async function hashToken(token: string): Promise<string> {
  const normalized = token.trim();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateDevice(deviceId: string, deviceToken: string): Promise<void> {
  const tokenHash = await hashToken(deviceToken);

  const { data, error } = await admin
    .from("devices")
    .select("id")
    .eq("id", deviceId)
    .eq("device_token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(`Device lookup failed: ${error.message}`);
  }

  if (!data) {
    throw new Error("Device authentication failed");
  }

  const { error: touchError } = await admin
    .from("devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", deviceId);

  if (touchError) {
    throw new Error(`Unable to update last_seen_at: ${touchError.message}`);
  }
}

export function requireUuid(value: string, fieldName: string): void {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(value)) {
    throw new Error(`Invalid ${fieldName}`);
  }
}

export function requireToken(value: string): void {
  if (!value || value.trim().length < 32) {
    throw new Error("Invalid device token");
  }
}

export function sanitizeFileName(input: string): string {
  const cleaned = input
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[^a-zA-Z0-9._()\- ]/g, "_")
    .trim();

  if (!cleaned) {
    return "upload.bin";
  }

  return cleaned.slice(0, 160);
}
