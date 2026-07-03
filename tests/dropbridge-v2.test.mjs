import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const backgroundSource = readFileSync(new URL('../src/background/background.js', import.meta.url), 'utf8');
const offscreenSource = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');
const popupHtmlSource = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
const popupJsSource = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
const sidepanelHtmlSource = readFileSync(new URL('../src/sidepanel/sidepanel.html', import.meta.url), 'utf8');
const sidepanelJsSource = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
const gradescopeSource = readFileSync(new URL('../src/content/gradescope.js', import.meta.url), 'utf8');
const uploadFileV2Source = readFileSync(new URL('../supabase/functions/upload-file-v2/index.ts', import.meta.url), 'utf8');
const claimUploadV2Source = readFileSync(new URL('../supabase/functions/claim-upload-v2/index.ts', import.meta.url), 'utf8');
const updateUploadStatusV2Source = readFileSync(new URL('../supabase/functions/update-upload-status-v2/index.ts', import.meta.url), 'utf8');
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
  assert.match(offscreenSource, /payload\?\.payload/);
  assert.match(offscreenSource, /file_name/);
  assert.match(offscreenSource, /size_bytes/);
  assert.match(offscreenSource, /mime_type/);
  assert.match(offscreenSource, /created_at/);
  assert.match(offscreenSource, /realtimeReceivedAt/);
});

test('DropBridge popup renders receiver health status', () => {
  assert.match(popupHtmlSource, /id="dropbridge-status"/);
  assert.match(popupHtmlSource, /id="dropbridge-dot"/);
  assert.match(popupHtmlSource, /id="dropbridge-text"/);
  assert.match(popupHtmlSource, /id="settings-dropbridge-status"/);
  assert.match(popupHtmlSource, /id="settings-dropbridge-label"/);
  assert.match(popupHtmlSource, /id="settings-dropbridge-detail"/);
  assert.match(popupHtmlSource, /id="lectra-settings-title"/);
  assert.match(popupHtmlSource, /id="cs-overflow-send-pdf"[^>]*hidden/);
});

test('Lectra disabled hides UI and prevents FileDrop receiver warmup', () => {
  assert.match(backgroundSource, /async function isSendToLectraFeatureEnabled/);
  assert.match(backgroundSource, /reason:\s*'feature_disabled'/);
  assert.match(backgroundSource, /FileDrop disabled/);
  assert.match(gradescopeSource, /function isLectraEnabled/);
  assert.match(gradescopeSource, /removeButtons\(\)/);
  assert.match(sidepanelHtmlSource, /id="btn-lectra-send"[^>]*hidden/);
  assert.match(sidepanelJsSource, /function updateLectraButtonVisibility/);
});

test('PDF study workflow favors actionable notes with citations and Lectra handoff', () => {
  const pdfSuggestions = sourceBetween(
    sidepanelJsSource,
    'function applyPdfSuggestions()',
    'function restoreDefaultSuggestions()',
  );

  assert.match(pdfSuggestions, /Study Notes from PDF/);
  assert.match(pdfSuggestions, /key concepts/);
  assert.match(pdfSuggestions, /Cornell-style cue questions/);
  assert.match(pdfSuggestions, /worked examples or applications/);
  assert.match(pdfSuggestions, /edge cases\/pitfalls/);
  assert.match(pdfSuggestions, /page-number citations/);
  assert.match(pdfSuggestions, /Lectra handoff checklist/);
});

test('popup PDF viewer diagnostics are opt-in for responsiveness', () => {
  assert.match(popupJsSource, /const PDF_VIEWER_DEBUG = false;/);
});

test('DropBridge upload sends explicit realtime wake with sender device tracking', () => {
  assert.match(uploadFileV2Source, /const FILE_DROP_EVENT = "upload_queued"/);
  assert.match(uploadFileV2Source, /sender_device_id:\s*senderDeviceId \|\| null/);
  assert.match(uploadFileV2Source, /broadcastDropBridgeEvent/);
  assert.match(uploadFileV2Source, /wake_broadcasted/);
});

test('DropBridge claim and terminal status broadcast sender progress events', () => {
  assert.match(claimUploadV2Source, /sender_device_id/);
  assert.match(claimUploadV2Source, /status:\s*"claimed"/);
  assert.match(claimUploadV2Source, /status:\s*"signed_url_issued"/);
  assert.match(updateUploadStatusV2Source, /sender_device_id/);
  assert.match(updateUploadStatusV2Source, /const UPLOAD_STATUS_EVENT = "upload_status"/);
  assert.match(updateUploadStatusV2Source, /stage:\s*status/);
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
