import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/background/background-cs-extras.js', import.meta.url), 'utf8');
const helperStart = source.indexOf('function timestampMs');
const helperEnd = source.indexOf('async function pullTools');

assert.notEqual(helperStart, -1, 'timestamp helper exists');
assert.notEqual(helperEnd, -1, 'pullTools exists after resolver helpers');

const helperSource = source.slice(helperStart, helperEnd);
const { resolveToolPullValue } = new Function(`${helperSource}; return { resolveToolPullValue };`)();

test('characterProfile pull keeps newer local opt-out and pushes it back', () => {
  const local = {
    enabled: false,
    paused: false,
    dismissed: [],
    summaries: [],
    updatedAt: '2026-06-30T12:00:00.000Z'
  };
  const remote = {
    enabled: true,
    paused: false,
    dismissed: [],
    summaries: [],
    updatedAt: '2026-06-30T11:00:00.000Z'
  };

  const resolved = resolveToolPullValue('characterProfile', local, remote, '2026-06-30T11:05:00.000Z');
  assert.equal(resolved.action, 'keepLocal');
  assert.equal(resolved.reason, 'local-newer');
  assert.equal(resolved.value.enabled, false);
});

test('characterProfile pull applies a newer remote tombstone', () => {
  const local = {
    enabled: true,
    paused: false,
    dismissed: ['cp_abc123'],
    summaries: [{ kind: 'grade', text: 'Review BIO 1A', sources: ['Canvascope grades'], ts: Date.now() }],
    updatedAt: '2026-06-30T11:00:00.000Z'
  };
  const remote = {
    enabled: false,
    paused: false,
    dismissed: [],
    summaries: [],
    updatedAt: '2026-06-30T12:00:00.000Z'
  };

  const resolved = resolveToolPullValue('characterProfile', local, remote, '2026-06-30T12:05:00.000Z');
  assert.equal(resolved.action, 'applyRemote');
  assert.equal(resolved.value.enabled, false);
  assert.deepEqual(resolved.value.summaries, []);
});

test('characterProfile pull keeps local disabled state on timestamp tie', () => {
  const stamp = '2026-06-30T12:00:00.000Z';
  const local = { enabled: false, paused: false, dismissed: [], summaries: [], updatedAt: stamp };
  const remote = { enabled: true, paused: false, dismissed: [], summaries: [], updatedAt: stamp };

  const resolved = resolveToolPullValue('characterProfile', local, remote, stamp);
  assert.equal(resolved.action, 'keepLocal');
  assert.equal(resolved.reason, 'local-opt-out-tie');
});

test('non-character tool pulls still apply remote values directly', () => {
  const resolved = resolveToolPullValue('customTodos', { old: true }, [{ title: 'Study' }], '2026-06-30T12:00:00.000Z');
  assert.equal(resolved.action, 'applyRemote');
  assert.deepEqual(resolved.value, [{ title: 'Study' }]);
});

test('pullTools pushes a kept local characterProfile back to Supabase', () => {
  assert.match(
    source,
    /resolved\.action === 'keepLocal'[\s\S]*keptLocal\.push\(key\);[\s\S]*await pushToolsNow\(key, resolved\.value\);/
  );
});
