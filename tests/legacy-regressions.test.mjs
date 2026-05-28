import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

const externalFixturesByScript = {
  'test_search_regressions.js': ['BerkeleyCanvascopeExport.json'],
  'test_temporal_lab.js': ['BerkeleyCanvascopeExport.json', 'UCSDCanvascopeExport.json']
};

function findExternalFixture(filename) {
  const candidates = [
    path.join(rootDir, filename),
    path.join(path.dirname(rootDir), filename)
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

for (const script of scripts) {
  const requiredFixtures = externalFixturesByScript[script] || [];
  const missingFixtures = requiredFixtures.filter(filename => !findExternalFixture(filename));
  const testOptions = missingFixtures.length > 0
    ? {
        timeout: 300_000,
        skip: `requires external fixture(s): ${missingFixtures.join(', ')}`
      }
    : { timeout: 300_000 };

  test(`legacy regression script passes: ${script}`, testOptions, () => {
    const srcPath = path.join(rootDir, 'tests', 'legacy', script);
    const destPath = path.join(rootDir, script);

    // Temporarily copy to root to preserve relative path resolution inside the legacy script
    fs.copyFileSync(srcPath, destPath);

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
    } finally {
      // Clean up the copied file from root immediately
      try {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
      } catch (err) {
        console.error(`Failed to clean up temporary test script ${script}:`, err);
      }
    }
  });
}
