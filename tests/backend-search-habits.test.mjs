import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '../supabase/functions/_shared/search-habits.ts')
).href;

const {
  applySearchEventToPattern,
  extractTaskSequencePattern,
  matchesSuggestionPrefix,
  normalizeBaseQuery,
  normalizeSuggestionResponse,
  sanitizeSearchEventPayload,
  shouldReturnCrossSlotSuggestion
} = await import(moduleUrl);

function makeEvent(overrides = {}) {
  return sanitizeSearchEventPayload({
    eventKind: 'result_clicked',
    rawQuery: 'chem lab 1',
    normalizedQuery: 'chem lab 1',
    baseQuery: 'chem lab',
    sequenceNumber: 1,
    localTimezone: 'America/Los_Angeles',
    localDayOfWeek: 1,
    localHourBucket: 20,
    localWeekIndex: 100,
    ...overrides
  });
}

test('extractTaskSequencePattern recognizes numbered task queries', () => {
  assert.deepEqual(extractTaskSequencePattern('Chem Lab 12'), {
    baseQuery: 'chem lab',
    sequenceNumber: 12
  });
  assert.deepEqual(extractTaskSequencePattern('weekly quiz 4'), {
    baseQuery: 'weekly quiz',
    sequenceNumber: 4
  });
});

test('extractTaskSequencePattern ignores queries without a valid task suffix', () => {
  assert.equal(extractTaskSequencePattern('chem 12'), null);
  assert.equal(extractTaskSequencePattern('lecture 4'), null);
  assert.equal(extractTaskSequencePattern('lab'), null);
});

test('normalizeBaseQuery keeps task-shaped prefixes and rejects non-task queries', () => {
  assert.equal(normalizeBaseQuery('  Chem Lab!!  '), 'chem lab');
  assert.equal(normalizeBaseQuery('Syllabus Page'), '');
  assert.equal(normalizeBaseQuery('chem'), '');
});

test('sanitizeSearchEventPayload normalizes, clamps, and trims backend event payloads', () => {
  const payload = sanitizeSearchEventPayload({
    eventKind: 'result_clicked',
    rawQuery: ' Chem   Lab 4!! ',
    baseQuery: ' CHEM LAB ',
    sequenceNumber: '4.9',
    localTimezone: ' America/Los_Angeles ',
    localDayOfWeek: 99,
    localHourBucket: -3,
    localWeekIndex: 999999,
    clickedItemId: ' assignment-123 ',
    clickedItemType: ' assignment '
  });

  assert.equal(payload.rawQuery, 'Chem Lab 4!!');
  assert.equal(payload.normalizedQuery, 'chem lab 4');
  assert.equal(payload.baseQuery, 'chem lab');
  assert.equal(payload.sequenceNumber, 4);
  assert.equal(payload.localTimezone, 'America/Los_Angeles');
  assert.equal(payload.localDayOfWeek, 6);
  assert.equal(payload.localHourBucket, 0);
  assert.equal(payload.localWeekIndex, 100000);
  assert.equal(payload.clickedItemId, 'assignment-123');
  assert.equal(payload.clickedItemType, 'assignment');
});

test('sanitizeSearchEventPayload rejects invalid event kinds', () => {
  assert.throws(
    () => sanitizeSearchEventPayload({ eventKind: 'page_viewed', rawQuery: 'chem lab 4' }),
    /Invalid eventKind/
  );
});

test('applySearchEventToPattern promotes recurring weekly sequences after three weeks', () => {
  const userId = 'user-123';

  let pattern = applySearchEventToPattern(null, userId, makeEvent({
    sequenceNumber: 1,
    normalizedQuery: 'chem lab 1',
    rawQuery: 'chem lab 1',
    localWeekIndex: 100
  }));

  pattern = applySearchEventToPattern(pattern, userId, makeEvent({
    sequenceNumber: 2,
    normalizedQuery: 'chem lab 2',
    rawQuery: 'chem lab 2',
    localWeekIndex: 101
  }));

  pattern = applySearchEventToPattern(pattern, userId, makeEvent({
    sequenceNumber: 3,
    normalizedQuery: 'chem lab 3',
    rawQuery: 'chem lab 3',
    localWeekIndex: 102
  }));

  assert.equal(pattern.last_sequence_number, 3);
  assert.equal(pattern.last_seen_week_index, 102);
  assert.equal(pattern.consecutive_weeks, 3);
  assert.equal(pattern.predicted_query, 'chem lab 4');
  assert.ok(pattern.confidence > 0);
});

test('applySearchEventToPattern updates same-week clicks without inflating the streak', () => {
  const userId = 'user-123';
  let pattern = null;

  for (const sequenceNumber of [1, 2, 3]) {
    pattern = applySearchEventToPattern(pattern, userId, makeEvent({
      sequenceNumber,
      normalizedQuery: `chem lab ${sequenceNumber}`,
      rawQuery: `chem lab ${sequenceNumber}`,
      localWeekIndex: 100 + (sequenceNumber - 1)
    }));
  }

  const updated = applySearchEventToPattern(pattern, userId, makeEvent({
    sequenceNumber: 4,
    normalizedQuery: 'chem lab 4',
    rawQuery: 'chem lab 4',
    localWeekIndex: 102
  }));

  assert.equal(updated.consecutive_weeks, 3);
  assert.equal(updated.last_sequence_number, 4);
  assert.equal(updated.predicted_query, 'chem lab 5');
});

test('applySearchEventToPattern resets the streak when a week or sequence breaks', () => {
  const userId = 'user-123';
  let pattern = null;

  for (const sequenceNumber of [1, 2, 3]) {
    pattern = applySearchEventToPattern(pattern, userId, makeEvent({
      sequenceNumber,
      normalizedQuery: `chem lab ${sequenceNumber}`,
      rawQuery: `chem lab ${sequenceNumber}`,
      localWeekIndex: 200 + (sequenceNumber - 1)
    }));
  }

  const reset = applySearchEventToPattern(pattern, userId, makeEvent({
    sequenceNumber: 8,
    normalizedQuery: 'chem lab 8',
    rawQuery: 'chem lab 8',
    localWeekIndex: 205
  }));

  assert.equal(reset.consecutive_weeks, 1);
  assert.equal(reset.last_sequence_number, 8);
  assert.equal(reset.predicted_query, null);
  assert.ok(reset.confidence < pattern.confidence);
});

test('normalizeSuggestionResponse returns predicted query metadata for eligible rows', () => {
  const response = normalizeSuggestionResponse({
    user_id: 'user-123',
    base_query: 'chem lab',
    local_day_of_week: 1,
    local_hour_bucket: 20,
    last_sequence_number: 4,
    last_seen_week_index: 102,
    consecutive_weeks: 4,
    query_submit_count: 4,
    result_click_count: 4,
    suggestion_impression_count: 1,
    suggestion_click_count: 1,
    predicted_query: 'chem lab 5',
    confidence: 1.4
  }, true);

  assert.deepEqual(response, {
    query: 'chem lab 5',
    baseQuery: 'chem lab',
    predictedSequenceNumber: 5,
    confidence: 1,
    slotMatch: true
  });
});

test('normalizeSuggestionResponse returns null when no predicted query is available', () => {
  assert.equal(normalizeSuggestionResponse({
    user_id: 'user-123',
    base_query: 'chem lab',
    local_day_of_week: 1,
    local_hour_bucket: 20,
    last_sequence_number: null,
    last_seen_week_index: null,
    consecutive_weeks: 1,
    query_submit_count: 1,
    result_click_count: 1,
    suggestion_impression_count: 0,
    suggestion_click_count: 0,
    predicted_query: null,
    confidence: 0.5
  }, false), null);
});

test('shouldReturnCrossSlotSuggestion enforces the confidence threshold', () => {
  assert.equal(shouldReturnCrossSlotSuggestion({ confidence: 0.84 }), false);
  assert.equal(shouldReturnCrossSlotSuggestion({ confidence: 0.85 }), true);
  assert.equal(shouldReturnCrossSlotSuggestion({ confidence: 1.5 }), true);
});

test('matchesSuggestionPrefix matches either the base query or predicted query prefix', () => {
  const pattern = {
    base_query: 'chem lab',
    predicted_query: 'chem lab 4'
  };

  assert.equal(matchesSuggestionPrefix(pattern, ''), true);
  assert.equal(matchesSuggestionPrefix(pattern, 'chem'), true);
  assert.equal(matchesSuggestionPrefix(pattern, 'chem lab 4'), true);
  assert.equal(matchesSuggestionPrefix(pattern, 'bio'), false);
});
