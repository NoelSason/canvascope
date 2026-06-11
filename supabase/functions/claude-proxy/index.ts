import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";

type ClaudeRequestPayload = {
  prompt: string;
  system?: string;
  corpus?: string;
  maxTokens?: number;
};

const MODEL = "claude-fable-5";
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

    // 2. Extract payload
    const payload = (await request.json()) as ClaudeRequestPayload;
    const prompt = String(payload.prompt ?? "").trim();
    if (!prompt) {
      return json({ error: "Missing prompt parameter" }, 400);
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
    const system: Array<Record<string, unknown>> = [];
    if (payload.system) {
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

    // 5. Query the Anthropic Messages API with streaming. Fable 5 rejects
    //    temperature/top_p/top_k and explicit thinking config — omit them all.
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        stream: true,
        ...(system.length > 0 ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
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

    // 6. Direct pipe the SSE stream back to the client
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
