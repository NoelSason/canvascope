import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

if (!supabaseUrl || !anonKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars");
}

export class HttpError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

export type AuthenticatedUser = {
  id: string;
  email?: string | null;
};

export async function requireAuthUser(request: Request): Promise<AuthenticatedUser> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.trim()) {
    throw new HttpError("Missing Authorization header", 401);
  }
  const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) {
    throw new HttpError("Missing bearer token", 401);
  }

  const client = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authorization,
      },
    },
    auth: {
      persistSession: false,
    },
  });

  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) {
    const reason = error?.message?.trim() || "Unable to resolve user from bearer token";
    throw new HttpError(`Unauthorized: ${reason}`, 401);
  }

  return { id: data.user.id, email: data.user.email };
}

export function isServiceRoleRequest(request: Request): boolean {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }

  try {
    const payloadRaw = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const payloadJson = atob(payloadRaw);
    const payload = JSON.parse(payloadJson);
    const role = String(payload?.role ?? "");
    return role === "service_role" || role === "supabase_admin";
  } catch {
    return false;
  }
}
