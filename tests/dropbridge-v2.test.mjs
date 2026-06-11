import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const backgroundSource = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const offscreenSource = readFileSync(new URL('../offscreen.js', import.meta.url), 'utf8');
const migrationSource = readFileSync(
  new URL('../supabase/migrations/20260610120000_dropbridge_v3_realtime_receipts.sql', import.meta.url),
  'utf8',
);

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Expected to find ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Expected to find ${endNeedle}`);
  return source.slice(start, end);
}

test('DropBridge wake with uploadId attempts targeted claim before fallback polling', () => {
  const handler = sourceBetween(
    backgroundSource,
    "if (message.action === 'dropbridgeReceiverWake')",
    "if (message.action === 'dropbridgeReceiverStatus')",
  );

  const claimIndex = handler.indexOf('tryClaimAndProcessDropBridgeV2UploadById');
  const pollIndex = handler.indexOf('requestDropBridgeV2Poll');
  assert.ok(claimIndex > -1, 'expected targeted claim call in wake handler');
  assert.ok(pollIndex > -1, 'expected fallback poll call in wake handler');
  assert.ok(claimIndex < pollIndex, 'targeted claim must run before fallback polling');
  assert.match(handler, /if \(uploadId\)/, 'targeted claim should require a wake uploadId');
});

test('DropBridge targeted claim suppresses duplicate active upload wakes', () => {
  const targetedClaim = sourceBetween(
    backgroundSource,
    'async function tryClaimAndProcessDropBridgeV2UploadById',
    'function shouldRestartDropBridgeReceiverFromStatus',
  );

  assert.match(targetedClaim, /dropBridgeV2ActiveUploads\.has\(normalizedUploadId\)/);
  assert.match(targetedClaim, /dropBridgeV2TargetedClaimsInFlight\.has\(normalizedUploadId\)/);
  assert.match(targetedClaim, /return true;/, 'duplicate active wakes should be treated as handled');
});

test('DropBridge offscreen receiver forwards rich realtime wake metadata', () => {
  assert.match(offscreenSource, /function normalizeWakeUpload/);
  assert.match(offscreenSource, /file_name/);
  assert.match(offscreenSource, /size_bytes/);
  assert.match(offscreenSource, /mime_type/);
  assert.match(offscreenSource, /created_at/);
  assert.match(offscreenSource, /realtimeReceivedAt/);
});

test('DropBridge heartbeat uses the heartbeat endpoint instead of pending-list claim', () => {
  const heartbeat = sourceBetween(
    backgroundSource,
    'async function heartbeatDropBridgeV2Device',
    'async function ensureDropBridgeV2HeartbeatAlarm',
  );

  assert.match(heartbeat, /heartbeat-device-v2/);
  assert.doesNotMatch(heartbeat, /list-pending-v2/);
});

test('DropBridge v3 migration adds receipts and hot-path indexes', () => {
  assert.match(migrationSource, /create table if not exists public\.dropbridge_receipts/);
  assert.match(migrationSource, /alter table public\.dropbridge_receipts enable row level security/);
  assert.match(migrationSource, /idx_uploads_direct_claim_lookup/);
  assert.match(migrationSource, /idx_devices_user_kind_last_seen/);
  assert.match(migrationSource, /wake_emitted/);
});
