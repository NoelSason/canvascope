import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const scripts = [
  'test_backend_adaptive_suggestions.js',
  'test_pdf_send_context.js',
  'test_rank.js',
  'test_search_regressions.js',
  'test_slash_overlay.js',
  'test_slash_commands.js',
  'test_temporal_lab.js',
  'test_weekly_habits.js'
];

for (const script of scripts) {
  test(`legacy regression script passes: ${script}`, { timeout: 300_000 }, () => {
    try {
      execFileSync(process.execPath, [script], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (error) {
      const parts = [`Script ${script} failed.`];

      if (typeof error.stdout === 'string' && error.stdout.trim()) {
        parts.push(`stdout:\n${error.stdout}`);
      }

      if (typeof error.stderr === 'string' && error.stderr.trim()) {
        parts.push(`stderr:\n${error.stderr}`);
      }

      assert.fail(parts.join('\n\n'));
    }
  });
}
