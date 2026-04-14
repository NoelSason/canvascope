import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";
import { admin } from "../_shared/device-auth.ts";
import {
  matchesSuggestionPrefix,
  normalizeSuggestionResponse,
  shouldReturnCrossSlotSuggestion,
} from "../_shared/search-habits.ts";

type SuggestionPayload = {
  localTimezone?: string;
  localDayOfWeek?: number;
  localHourBucket?: number;
  prefix?: string;
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
    const payload = (await request.json()) as SuggestionPayload;
    const localDayOfWeek = Math.max(0, Math.min(6, Math.trunc(Number(payload.localDayOfWeek ?? 0))));
    const localHourBucket = Math.max(0, Math.min(23, Math.trunc(Number(payload.localHourBucket ?? 0))));
    const prefix = String(payload.prefix ?? "").trim().toLowerCase();

    const { data: slotPatterns, error: slotError } = await admin
      .from("search_patterns")
      .select(`
        user_id,
        base_query,
        local_day_of_week,
        local_hour_bucket,
        last_sequence_number,
        last_seen_week_index,
        consecutive_weeks,
        query_submit_count,
        result_click_count,
        suggestion_impression_count,
        suggestion_click_count,
        predicted_query,
        confidence
      `)
      .eq("user_id", user.id)
      .eq("local_day_of_week", localDayOfWeek)
      .eq("local_hour_bucket", localHourBucket)
      .not("predicted_query", "is", null)
      .order("confidence", { ascending: false })
      .limit(8);

    if (slotError) {
      throw new Error(`Failed to load slot suggestions: ${slotError.message}`);
    }

    const suggestions = [];
    const seenQueries = new Set<string>();

    for (const pattern of slotPatterns ?? []) {
      if (!matchesSuggestionPrefix(pattern, prefix)) continue;
      const normalized = normalizeSuggestionResponse(pattern, true);
      if (!normalized || seenQueries.has(normalized.query)) continue;
      seenQueries.add(normalized.query);
      suggestions.push(normalized);
    }

    if (suggestions.length < 5) {
      const { data: fallbackPatterns, error: fallbackError } = await admin
        .from("search_patterns")
        .select(`
          user_id,
          base_query,
          local_day_of_week,
          local_hour_bucket,
          last_sequence_number,
          last_seen_week_index,
          consecutive_weeks,
          query_submit_count,
          result_click_count,
          suggestion_impression_count,
          suggestion_click_count,
          predicted_query,
          confidence
        `)
        .eq("user_id", user.id)
        .not("predicted_query", "is", null)
        .order("confidence", { ascending: false })
        .limit(12);

      if (fallbackError) {
        throw new Error(`Failed to load fallback suggestions: ${fallbackError.message}`);
      }

      for (const pattern of fallbackPatterns ?? []) {
        if (pattern.local_day_of_week === localDayOfWeek && pattern.local_hour_bucket === localHourBucket) continue;
        if (!shouldReturnCrossSlotSuggestion(pattern)) continue;
        if (!matchesSuggestionPrefix(pattern, prefix)) continue;

        const normalized = normalizeSuggestionResponse(pattern, false);
        if (!normalized || seenQueries.has(normalized.query)) continue;
        seenQueries.add(normalized.query);
        suggestions.push(normalized);

        if (suggestions.length >= 5) break;
      }
    }

    return json({
      ok: true,
      localTimezone: String(payload.localTimezone ?? "UTC"),
      suggestions,
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
