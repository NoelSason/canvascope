import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";

type GeminiRequestPayload = {
  prompt: string;
  systemInstruction?: string;
};

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
    const payload = (await request.json()) as GeminiRequestPayload;
    const prompt = String(payload.prompt ?? "").trim();
    if (!prompt) {
      return json({ error: "Missing prompt parameter" }, 400);
    }

    // 3. Resolve Gemini API Key from Supabase env variables
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) {
      console.error("[Gemini Proxy] Missing GEMINI_API_KEY environment variable on Supabase");
      return json({ error: "AI Fallback service is temporarily misconfigured. Missing backend credentials." }, 500);
    }

    // Diagnostic endpoint: list all available models for this key
    if (prompt === "__listModels__" || prompt.endsWith("__listModels__")) {
      const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`;
      const listResponse = await fetch(listUrl);
      const listData = await listResponse.json();
      return json({ models: listData.models || listData }, listResponse.status);
    }

    // 4. Construct Gemini 2.5 Flash stream endpoint
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${geminiApiKey}`;

    // Compile Gemini model payload
    const geminiPayload = {
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      system_instruction: payload.systemInstruction ? {
        parts: [{ text: payload.systemInstruction }]
      } : undefined,
      generationConfig: {
        temperature: 0.6,
        topK: 4,
        maxOutputTokens: 2048
      }
    };

    // 5. Query Google Gemini API securely using streaming
    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(geminiPayload)
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error("[Gemini Proxy] Google API call failed:", errorText);
      
      let richError = errorText;
      try {
        const parsed = JSON.parse(errorText);
        richError = parsed?.error?.message || parsed?.error?.status || errorText;
      } catch (_) {}
      
      return json({ error: `Google AI Service failed: ${richError}` }, 502);
    }

    // 6. Direct pipe the streaming response back to the client!
    return new Response(geminiResponse.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });

  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    const message = error instanceof Error ? error.message : "Unknown internal error";
    return json({ error: message }, 500);
  }
});
