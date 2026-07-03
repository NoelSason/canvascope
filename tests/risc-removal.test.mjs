import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

function projectUrl(path) {
  return new URL(path, root);
}

function readProjectFile(path) {
  return readFileSync(projectUrl(path), 'utf8');
}

test('RISC auth hook and receiver are not configured in Supabase config', () => {
  const config = readProjectFile('supabase/config.toml');

  assert.match(config, /\[auth\.hook\.custom_access_token\]\s+enabled = false/);
  assert.doesNotMatch(config, /^\[functions\.risc-receiver\]/m);
  assert.doesNotMatch(config, /risc_enforce_signin_block/);
});

test('RISC receiver, setup docs, and registration script are removed from active source', () => {
  const removedPaths = [
    'supabase/functions/risc-receiver/index.ts',
    'docs/risc-setup.md',
    'scripts/risc-register.mjs',
  ];

  for (const path of removedPaths) {
    assert.equal(existsSync(projectUrl(path)), false, `${path} should not exist`);
  }
});

test('RISC cleanup migration disarms the auth hook and drops event support objects', () => {
  const migrationNames = readdirSync(projectUrl('supabase/migrations'))
    .filter((name) => name.endsWith('_remove_risc_account_protection.sql'));

  assert.deepEqual(migrationNames, ['20260623015138_remove_risc_account_protection.sql']);

  const migration = readProjectFile(`supabase/migrations/${migrationNames[0]}`);
  assert.match(migration, /create or replace function public\.risc_enforce_signin_block\(event jsonb\)/);
  assert.match(migration, /select \$1;/);
  assert.match(migration, /drop function if exists public\.revoke_user_sessions\(uuid\);/);
  assert.match(migration, /drop function if exists public\.user_id_for_google_sub\(text\);/);
  assert.match(migration, /drop table if exists public\.risc_account_flags;/);
  assert.match(migration, /drop table if exists public\.risc_events;/);
});
