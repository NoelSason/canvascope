import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";

type AnthropicMessage = { role: "user" | "assistant"; content: unknown };
type AnthropicTool = Record<string, unknown>;
type SystemBlock = { type: "text"; text: string; cache_control?: Record<string, unknown> };

type ClaudeRequestPayload = {
  // Legacy single-turn Ask/Course Brain path (unchanged).
  prompt?: string;
  // Agent tool-use path: multi-turn conversation + tool definitions.
  messages?: AnthropicMessage[];
  tools?: AnthropicTool[];
  // `system` may be a plain string (legacy) or a pre-built block array whose
  // cache_control breakpoints are passed through untouched (agent path).
  system?: string | SystemBlock[];
  corpus?: string;
  maxTokens?: number;
  // Agent turns set this false to get the full message JSON back (with
  // stop_reason + tool_use blocks) instead of an SSE passthrough.
  stream?: boolean;
  // Optional per-call model override. Defaults below; agent turns send
  // "claude-haiku-4-5".
  model?: string;
};

// Default to the cheapest tool-capable model. Fable 5 is intentionally NOT
// used anywhere and NOT on the allowlist — any request for it falls back to
// this default.
const MODEL = "claude-haiku-4-5";
// Models the proxy is allowed to run — guards against arbitrary model strings
// from the client. Cheapest-first; Fable 5 deliberately excluded.
const ALLOWED_MODELS = new Set(["claude-haiku-4-5", "claude-sonnet-4-6"]);
const MAX_OUTPUT_CAP = 8192;

Deno.serve(async (request) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // 1. Authorize the user (Requires valid Supabase Bearer Token)
    await requireAuthUser(request);

    // 2. Extract payload. Two shapes are accepted: a legacy single `prompt`
    //    (Ask/Course Brain) or an agent `messages[]` array with `tools`.
    const payload = (await request.json()) as ClaudeRequestPayload;
    const prompt = String(payload.prompt ?? "").trim();
    const hasMessages = Array.isArray(payload.messages) && payload.messages.length > 0;
    if (!prompt && !hasMessages) {
      return json({ error: "Missing prompt or messages parameter" }, 400);
    }

    // 3. Resolve Anthropic API key from Supabase env variables
    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicApiKey) {
      console.error("[Claude Proxy] Missing ANTHROPIC_API_KEY environment variable on Supabase");
      return json({ error: "Course Brain cloud service is temporarily misconfigured. Missing backend credentials." }, 500);
    }

    // 4. Assemble system blocks. The corpus block is byte-identical across
    //    questions in a study session, so cache_control lets every question
    //    after the first read it from the prompt cache at ~10% input price.
    //    The agent path may pass `system` as a pre-built block array (charter +
    //    profile + memory, with its own cache breakpoints) — pass it through.
    let system: SystemBlock[] = [];
    if (Array.isArray(payload.system)) {
      system = payload.system as SystemBlock[];
    } else if (payload.system) {
      system.push({ type: "text", text: String(payload.system) });
    }
    if (payload.corpus) {
      system.push({
        type: "text",
        text: String(payload.corpus),
        cache_control: { type: "ephemeral" },
      });
    }

    const maxTokens = Math.min(Math.max(Number(payload.maxTokens) || 4096, 256), MAX_OUTPUT_CAP);

    // Pick the model: callers request claude-haiku-4-5; anything off the
    // allowlist (incl. Fable 5) falls back to the default (Haiku).
    const requestedModel = String(payload.model ?? MODEL);
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : MODEL;

    // Agent turns (with tools / multi-turn) need the full message JSON back so
    // the loop can read stop_reason + tool_use blocks; default to streaming so
    // the existing Ask path is unchanged.
    const stream = payload.stream !== false;
    const messages: AnthropicMessage[] = hasMessages
      ? (payload.messages as AnthropicMessage[])
      : [{ role: "user", content: prompt }];

    // 5. Query the Anthropic Messages API. Haiku/Fable reject
    //    temperature/top_p/top_k and explicit thinking config — omit them all.
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream,
        ...(system.length > 0 ? { system } : {}),
        ...(payload.tools ? { tools: payload.tools } : {}),
        messages,
      }),
    });

    if (!anthropicResponse.ok) {
      const errorText = await anthropicResponse.text();
      console.error("[Claude Proxy] Anthropic API call failed:", errorText);

      let richError = errorText;
      try {
        const parsed = JSON.parse(errorText);
        richError = parsed?.error?.message || parsed?.error?.type || errorText;
      } catch (_) {}

      return json({ error: `Claude service failed: ${richError}` }, 502);
    }

    // 6a. Agent path: return the full parsed message (content[], stop_reason,
    //     usage) so the service-worker loop can dispatch tool calls.
    if (!stream) {
      const data = await anthropicResponse.json();
      return json(data);
    }

    // 6b. Legacy Ask path: pipe the SSE stream straight back to the client.
    return new Response(anthropicResponse.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });

  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    const message = error instanceof Error ? error.message : "Unknown internal error";
    return json({ error: message }, 500);
  }
});
