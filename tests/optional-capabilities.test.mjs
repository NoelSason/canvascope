import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.resolve(__dirname, '..', 'src', 'core', 'optional-capabilities.js');
const srcCode = fs.readFileSync(srcPath, 'utf8');
const manifestPath = path.resolve(__dirname, '..', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Keep the sandbox so tests can inject `self.navigator` (the module reads the
// clipboard via self.navigator.clipboard, valid in both the SW and the panel).
const sandbox = {};
function load() {
  new Function('self', srcCode)(sandbox);
  return sandbox.CanvascopeOptionalCapabilities;
}

function installChrome({ granted = [], historyItems = [] } = {}) {
  globalThis.chrome = {
    permissions: {
      contains: async ({ permissions }) => permissions.every((p) => granted.includes(p)),
      request: async () => true,
      remove: async () => true
    },
    history: {
      search: (_q, cb) => cb(historyItems)
    }
  };
}

const CAP = load();

test('history and clipboardRead are required install-time permissions', () => {
  assert.ok(manifest.permissions.includes('history'), 'history declared in required permissions');
  assert.ok(manifest.permissions.includes('clipboardRead'), 'clipboardRead declared in required permissions');
  assert.ok(!manifest.optional_permissions?.includes('history'), 'history is not optional');
  assert.ok(!manifest.optional_permissions?.includes('clipboardRead'), 'clipboardRead is not optional');
});

test('capabilities no-op when the permission is not granted', async () => {
  installChrome({ granted: [], historyItems: [{ url: 'https://x.instructure.com/courses/1', title: 'C', lastVisitTime: 1 }] });
  assert.equal(await CAP.has('history'), false);
  assert.deepEqual(await CAP.getRecentLmsHistory(), [], 'no history read without permission');
});

test('clipboard read returns empty without the permission (never ambient)', async () => {
  installChrome({ granted: [] });
  sandbox.navigator = { clipboard: { readText: async () => 'SECRET ASSIGNMENT TEXT' } };
  assert.equal(await CAP.readClipboardText(), '', 'clipboard not read until clipboardRead is granted');
});

test('getRecentLmsHistory returns only LMS visits, newest first, when granted', async () => {
  installChrome({
    granted: ['history'],
    historyItems: [
      { url: 'https://news.example.com/article', title: 'News', lastVisitTime: 5000 },
      { url: 'https://x.instructure.com/courses/1/pages/a', title: 'Course A', lastVisitTime: 1000 },
      { url: 'https://bcourses.berkeley.edu/courses/9', title: 'Berkeley', lastVisitTime: 9000 }
    ]
  });
  const out = await CAP.getRecentLmsHistory({ maxItems: 5 });
  assert.equal(out.length, 2, 'non-LMS visit filtered out');
  assert.equal(out[0].title, 'Berkeley', 'newest LMS visit first');
  assert.deepEqual(Object.keys(out[0]).sort(), ['lastVisit', 'title', 'url'], 'only summary fields returned');
});

test('clipboard read returns text once granted (gesture-driven)', async () => {
  installChrome({ granted: ['clipboardRead'] });
  sandbox.navigator = { clipboard: { readText: async () => 'Essay prompt: discuss...' } };
  assert.equal(await CAP.readClipboardText(), 'Essay prompt: discuss...');
});
