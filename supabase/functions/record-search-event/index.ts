import { corsHeaders, json } from "../_shared/cors.ts";
import { HttpError, requireAuthUser } from "../_shared/auth-user.ts";
import { admin } from "../_shared/device-auth.ts";
import {
  applySearchEventToPattern,
  sanitizeSearchEventPayload,
} from "../_shared/search-habits.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const user = await requireAuthUser(request);
    const event = sanitizeSearchEventPayload(await request.json());

    const { error: insertEventError } = await admin
      .from("search_events")
      .insert({
        user_id: user.id,
        event_kind: event.eventKind,
        raw_query: event.rawQuery,
        normalized_query: event.normalizedQuery,
        base_query: event.baseQuery,
        sequence_number: event.sequenceNumber,
        local_timezone: event.localTimezone,
        local_day_of_week: event.localDayOfWeek,
        local_hour_bucket: event.localHourBucket,
        local_week_index: event.localWeekIndex,
        clicked_item_id: event.clickedItemId,
        clicked_item_type: event.clickedItemType,
      });

    if (insertEventError) {
      throw new Error(`Failed to insert search event: ${insertEventError.message}`);
    }

    if (!event.baseQuery) {
      return json({ ok: true, pattern: null });
    }

    const { data: existingPattern, error: existingPatternError } = await admin
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
      .eq("base_query", event.baseQuery)
      .eq("local_day_of_week", event.localDayOfWeek)
      .eq("local_hour_bucket", event.localHourBucket)
      .maybeSingle();

    if (existingPatternError) {
      throw new Error(`Failed to read search pattern: ${existingPatternError.message}`);
    }

    const nextPattern = applySearchEventToPattern(existingPattern ?? null, user.id, event);

    const { error: upsertError } = await admin
      .from("search_patterns")
      .upsert({
        user_id: nextPattern.user_id,
        base_query: nextPattern.base_query,
        local_day_of_week: nextPattern.local_day_of_week,
        local_hour_bucket: nextPattern.local_hour_bucket,
        last_sequence_number: nextPattern.last_sequence_number,
        last_seen_week_index: nextPattern.last_seen_week_index,
        consecutive_weeks: nextPattern.consecutive_weeks,
        query_submit_count: nextPattern.query_submit_count,
        result_click_count: nextPattern.result_click_count,
        suggestion_impression_count: nextPattern.suggestion_impression_count,
        suggestion_click_count: nextPattern.suggestion_click_count,
        predicted_query: nextPattern.predicted_query,
        confidence: nextPattern.confidence,
        updated_at: nextPattern.updated_at,
      }, {
        onConflict: "user_id,base_query,local_day_of_week,local_hour_bucket",
      });

    if (upsertError) {
      throw new Error(`Failed to upsert search pattern: ${upsertError.message}`);
    }

    return json({
      ok: true,
      pattern: {
        baseQuery: nextPattern.base_query,
        predictedQuery: nextPattern.predicted_query,
        confidence: nextPattern.confidence,
        consecutiveWeeks: nextPattern.consecutive_weeks,
      },
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
