/**
 * Smoke tests for lib/skin-themes.js — pure-logic catalog used by both the
 * in-page skin engine and the slash command pack.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const themes = require(path.resolve('lib/skin-themes.js'));

test('exports the expected public surface', () => {
  for (const k of ['DEFAULT_TOKENS', 'BUILTIN_THEMES', 'BUILTIN_FONTS',
                   'getTheme', 'getFont', 'listThemes', 'listFonts',
                   'normalizeTheme', 'buildCssVariables']) {
    assert.ok(k in themes, `expected key ${k} on module exports`);
  }
});

test('every built-in theme normalizes cleanly and has a complete token bag', () => {
  const list = themes.listThemes();
  assert.ok(list.length >= 6, 'expect at least 6 built-in themes');
  for (const t of list) {
    assert.ok(t.id, 'theme has id');
    assert.ok(t.name, 'theme has name');
    assert.ok(['light', 'dark'].includes(t.mode), 'theme mode is light or dark');
    for (const k of Object.keys(themes.DEFAULT_TOKENS)) {
      assert.ok(k in t.tokens, `${t.id} missing token ${k}`);
    }
  }
});

test('getTheme returns null for unknown ids and an object for known ids', () => {
  assert.equal(themes.getTheme('does-not-exist'), null);
  const dim = themes.getTheme('dim');
  assert.ok(dim);
  assert.equal(dim.id, 'dim');
  assert.equal(dim.mode, 'dark');
});

test('buildCssVariables emits one --cs-skin-* line per token', () => {
  const dim = themes.getTheme('dim');
  const css = themes.buildCssVariables(dim);
  const lines = css.split('\n').filter(Boolean);
  assert.equal(lines.length, Object.keys(dim.tokens).length);
  for (const line of lines) {
    assert.match(line, /^\s*--cs-skin-[a-z0-9-]+:\s+.+;$/);
  }
});

test('camelCase tokens are kebab-cased in CSS variable names', () => {
  const dim = themes.getTheme('dim');
  const css = themes.buildCssVariables(dim);
  // bgSoft → --cs-skin-bg-soft
  assert.match(css, /--cs-skin-bg-soft:/);
  assert.match(css, /--cs-skin-border-hi:/);
  assert.match(css, /--cs-skin-font-family:/);
});

test('built-in fonts each have an id, name, and CSS-valid value', () => {
  const fonts = themes.listFonts();
  assert.ok(fonts.length >= 5);
  for (const f of fonts) {
    assert.ok(f.id);
    assert.ok(f.name);
    assert.ok(typeof f.value === 'string' && f.value.length > 0);
  }
});
