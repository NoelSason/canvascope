export const SEARCH_EVENT_KINDS = [
  "query_submitted",
  "result_clicked",
  "suggestion_shown",
  "suggestion_clicked",
] as const;

export type SearchEventKind = typeof SEARCH_EVENT_KINDS[number];

const SEARCH_EVENT_KIND_SET = new Set<string>(SEARCH_EVENT_KINDS);
const TASK_TOKEN_SET = new Set([
  "lab",
  "prelab",
  "quiz",
  "assignment",
  "homework",
  "discussion",
]);

const MAX_QUERY_LENGTH = 240;
const MAX_TIMEZONE_LENGTH = 80;
const MAX_CLICKED_ITEM_ID_LENGTH = 240;
const MAX_CLICKED_ITEM_TYPE_LENGTH = 48;
const MIN_PROMOTION_STREAK = 3;
const CROSS_SLOT_CONFIDENCE_THRESHOLD = 0.85;

export type SearchEventRecord = {
  eventKind: SearchEventKind;
  rawQuery: string;
  normalizedQuery: string;
  baseQuery: string;
  sequenceNumber: number | null;
  localTimezone: string;
  localDayOfWeek: number;
  localHourBucket: number;
  localWeekIndex: number;
  clickedItemId: string | null;
  clickedItemType: string | null;
};

export type SearchPatternRow = {
  user_id: string;
  base_query: string;
  local_day_of_week: number;
  local_hour_bucket: number;
  last_sequence_number: number | null;
  last_seen_week_index: number | null;
  consecutive_weeks: number;
  query_submit_count: number;
  result_click_count: number;
  suggestion_impression_count: number;
  suggestion_click_count: number;
  predicted_query: string | null;
  confidence: number;
  updated_at?: string;
};

function normalizeQuery(input: unknown): string {
  return String(input ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

function normalizeLooseText(input: unknown, maxLength: number): string {
  return String(input ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function toBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function containsTaskToken(tokens: string[]): boolean {
  return tokens.some((token) => TASK_TOKEN_SET.has(token));
}

export function extractTaskSequencePattern(input: unknown): { baseQuery: string; sequenceNumber: number } | null {
  const normalized = normalizeQuery(input);
  if (!normalized) return null;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;

  const lastToken = tokens[tokens.length - 1];
  if (!/^\d{1,3}$/.test(lastToken)) return null;

  const baseTokens = tokens.slice(0, -1);
  if (baseTokens.length < 2 || !containsTaskToken(baseTokens)) return null;

  return {
    baseQuery: baseTokens.join(" "),
    sequenceNumber: Number(lastToken),
  };
}

export function normalizeBaseQuery(input: unknown): string {
  const normalized = normalizeQuery(input);
  if (!normalized) return "";
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || !containsTaskToken(tokens)) return "";
  return normalized;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function buildPredictedQuery(baseQuery: string, lastSequenceNumber: number | null, consecutiveWeeks: number): string | null {
  if (!baseQuery || !Number.isFinite(lastSequenceNumber) || consecutiveWeeks < MIN_PROMOTION_STREAK) {
    return null;
  }
  return `${baseQuery} ${Number(lastSequenceNumber) + 1}`.trim();
}

function computeConfidence(pattern: SearchPatternRow, brokeWeeklyStreak: boolean): number {
  const impressionMisses = Math.max(
    0,
    Number(pattern.suggestion_impression_count || 0) - Number(pattern.suggestion_click_count || 0),
  );

  let score = 0;
  score += Math.min(0.6, Number(pattern.consecutive_weeks || 0) * 0.22);
  score += Math.min(0.14, Number(pattern.query_submit_count || 0) * 0.02);
  score += Math.min(0.2, Number(pattern.result_click_count || 0) * 0.05);
  score += Math.min(0.2, Number(pattern.suggestion_click_count || 0) * 0.1);
  score -= Math.min(0.28, impressionMisses * 0.05);
  if (brokeWeeklyStreak) score -= 0.14;

  return clampConfidence(score);
}

function makeEmptyPattern(userId: string, event: SearchEventRecord): SearchPatternRow {
  return {
    user_id: userId,
    base_query: event.baseQuery,
    local_day_of_week: event.localDayOfWeek,
    local_hour_bucket: event.localHourBucket,
    last_sequence_number: null,
    last_seen_week_index: null,
    consecutive_weeks: 0,
    query_submit_count: 0,
    result_click_count: 0,
    suggestion_impression_count: 0,
    suggestion_click_count: 0,
    predicted_query: null,
    confidence: 0,
  };
}

function isSequenceTrackingEvent(event: SearchEventRecord): boolean {
  return event.eventKind === "result_clicked"
    && Number.isFinite(event.sequenceNumber)
    && Boolean(extractTaskSequencePattern(`${event.baseQuery} ${event.sequenceNumber}`));
}

export function sanitizeSearchEventPayload(payload: unknown): SearchEventRecord {
  const source = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const eventKind = String(source.eventKind ?? "").trim();
  if (!SEARCH_EVENT_KIND_SET.has(eventKind)) {
    throw new Error("Invalid eventKind");
  }

  const rawQuery = normalizeLooseText(source.rawQuery ?? "", MAX_QUERY_LENGTH);
  const normalizedQuery = normalizeQuery(source.normalizedQuery ?? rawQuery);
  const derivedPattern = extractTaskSequencePattern(normalizedQuery);
  const derivedBaseQuery = normalizeBaseQuery(source.baseQuery ?? derivedPattern?.baseQuery ?? normalizedQuery);
  const derivedSequenceNumber = derivedPattern?.sequenceNumber ?? null;
  const explicitSequence = Number(source.sequenceNumber);
  const sequenceNumber = Number.isFinite(explicitSequence)
    ? Math.max(1, Math.trunc(explicitSequence))
    : derivedSequenceNumber;

  return {
    eventKind: eventKind as SearchEventKind,
    rawQuery,
    normalizedQuery,
    baseQuery: derivedBaseQuery,
    sequenceNumber: Number.isFinite(sequenceNumber) ? Number(sequenceNumber) : null,
    localTimezone: normalizeLooseText(source.localTimezone ?? "UTC", MAX_TIMEZONE_LENGTH) || "UTC",
    localDayOfWeek: toBoundedInteger(source.localDayOfWeek, 0, 0, 6),
    localHourBucket: toBoundedInteger(source.localHourBucket, 0, 0, 23),
    localWeekIndex: toBoundedInteger(source.localWeekIndex, 0, -100000, 100000),
    clickedItemId: normalizeLooseText(source.clickedItemId ?? "", MAX_CLICKED_ITEM_ID_LENGTH) || null,
    clickedItemType: normalizeLooseText(source.clickedItemType ?? "", MAX_CLICKED_ITEM_TYPE_LENGTH) || null,
  };
}

export function applySearchEventToPattern(
  existing: SearchPatternRow | null,
  userId: string,
  event: SearchEventRecord,
): SearchPatternRow {
  const next = existing ? { ...existing } : makeEmptyPattern(userId, event);
  let brokeWeeklyStreak = false;

  next.base_query = event.baseQuery;
  next.local_day_of_week = event.localDayOfWeek;
  next.local_hour_bucket = event.localHourBucket;

  if (event.eventKind === "query_submitted") {
    next.query_submit_count += 1;
  } else if (event.eventKind === "result_clicked") {
    next.result_click_count += 1;
  } else if (event.eventKind === "suggestion_shown") {
    next.suggestion_impression_count += 1;
  } else if (event.eventKind === "suggestion_clicked") {
    next.suggestion_click_count += 1;
  }

  if (isSequenceTrackingEvent(event) && Number.isFinite(event.sequenceNumber)) {
    const currentSequence = Number(event.sequenceNumber);
    const lastWeekIndex = Number.isFinite(next.last_seen_week_index) ? Number(next.last_seen_week_index) : null;
    const lastSequence = Number.isFinite(next.last_sequence_number) ? Number(next.last_sequence_number) : null;

    if (lastWeekIndex === null) {
      next.consecutive_weeks = 1;
      next.last_seen_week_index = event.localWeekIndex;
      next.last_sequence_number = currentSequence;
    } else if (event.localWeekIndex === lastWeekIndex) {
      if (lastSequence === null || currentSequence > lastSequence) {
        next.last_sequence_number = currentSequence;
      }
      if (next.consecutive_weeks <= 0) {
        next.consecutive_weeks = 1;
      }
    } else {
      const isConsecutiveWeek = event.localWeekIndex === lastWeekIndex + 1;
      const followsSequence = lastSequence === null || currentSequence === lastSequence + 1;

      if (isConsecutiveWeek && followsSequence) {
        next.consecutive_weeks = Math.max(1, Number(next.consecutive_weeks || 0)) + 1;
      } else {
        next.consecutive_weeks = 1;
        brokeWeeklyStreak = true;
      }

      next.last_seen_week_index = event.localWeekIndex;
      next.last_sequence_number = currentSequence;
    }
  }

  next.predicted_query = buildPredictedQuery(
    next.base_query,
    next.last_sequence_number,
    next.consecutive_weeks,
  );
  next.confidence = computeConfidence(next, brokeWeeklyStreak);
  next.updated_at = new Date().toISOString();

  return next;
}

export function normalizeSuggestionResponse(pattern: SearchPatternRow, slotMatch: boolean) {
  const predictedQuery = normalizeLooseText(pattern.predicted_query ?? "", MAX_QUERY_LENGTH);
  if (!predictedQuery) return null;

  return {
    query: predictedQuery,
    baseQuery: pattern.base_query,
    predictedSequenceNumber: Number.isFinite(pattern.last_sequence_number)
      ? Number(pattern.last_sequence_number) + 1
      : null,
    confidence: clampConfidence(pattern.confidence),
    slotMatch,
  };
}

export function shouldReturnCrossSlotSuggestion(pattern: SearchPatternRow): boolean {
  return clampConfidence(pattern.confidence) >= CROSS_SLOT_CONFIDENCE_THRESHOLD;
}

export function matchesSuggestionPrefix(pattern: SearchPatternRow, prefix: string): boolean {
  const normalizedPrefix = normalizeQuery(prefix);
  if (!normalizedPrefix) return true;
  const baseQuery = normalizeQuery(pattern.base_query);
  const predictedQuery = normalizeQuery(pattern.predicted_query ?? "");
  return baseQuery.startsWith(normalizedPrefix) || predictedQuery.startsWith(normalizedPrefix);
}
