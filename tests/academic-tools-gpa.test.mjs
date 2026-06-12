/**
 * Tests for the pure GPA logic inside academic-tools.js.
 *
 * The module is wrapped in an IIFE and depends on `window` + `chrome`. We
 * stub both, load it in a sandbox, then assert against the public API it
 * attaches to window.CanvascopeAcademicTools.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadAcademicTools() {
  const src = fs.readFileSync(path.resolve('src/content/academic-tools.js'), 'utf8');

  // Minimal Web/Chrome stub. The module references `chrome.storage.local`
  // and DOM APIs but only inside lazy code paths we do not call here.
  const win = { CanvascopeAcademicTools: null };
  const chromeStub = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {}
      }
    },
    runtime: {
      sendMessage: () => Promise.resolve({})
    }
  };
  const documentStub = {
    createElement: () => ({
      setAttribute() {}, addEventListener() {}, appendChild() {},
      removeChild() {}, classList: { add(){}, remove(){}, toggle(){} },
      style: {}, attachShadow() { return { appendChild(){} }; }
    }),
    getElementById: () => null,
    body: { appendChild() {}, querySelectorAll: () => [] },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => []
  };
  const ctx = {
    window: win,
    document: documentStub,
    chrome: chromeStub,
    setTimeout, clearTimeout,
    console
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.CanvascopeAcademicTools;
}

test('percentToLetter maps boundary values correctly', () => {
  const api = loadAcademicTools();
  assert.ok(api, 'tools api attached to window');
  assert.equal(api.percentToLetter(100), 'A+');
  assert.equal(api.percentToLetter(97),  'A+');
  assert.equal(api.percentToLetter(96),  'A');
  assert.equal(api.percentToLetter(90),  'A-');
  assert.equal(api.percentToLetter(83),  'B');
  assert.equal(api.percentToLetter(70),  'C-');
  assert.equal(api.percentToLetter(59),  'F');
  assert.equal(api.percentToLetter(null), '');
});

test('computeGpa returns weighted average across credits', () => {
  const api = loadAcademicTools();
  const courses = [
    { name: 'A',  letter: 'A',  credits: 4 },  // 4.0 * 4 = 16
    { name: 'B',  letter: 'B+', credits: 3 },  // 3.3 * 3 = 9.9
    { name: 'C',  letter: 'A-', credits: 3 }   // 3.7 * 3 = 11.1
  ];
  const res = api.computeGpa(courses, 'college-4.0');
  assert.equal(res.units, 10);
  // (16 + 9.9 + 11.1) / 10 = 3.7
  assert.equal(res.gpa, 3.7);
});

test('excluded courses do not contribute to the GPA', () => {
  const api = loadAcademicTools();
  const courses = [
    { letter: 'A', credits: 4 },
    { letter: 'F', credits: 4, excluded: true }
  ];
  const res = api.computeGpa(courses, 'college-4.0');
  assert.equal(res.units, 4);
  assert.equal(res.gpa, 4);
});

test('hs-5.0-weighted bumps base points by the weight field', () => {
  const api = loadAcademicTools();
  const courses = [
    { letter: 'A', credits: 1, weight: 1.0 }   // 4.0 + 1.0 → 5.0
  ];
  const res = api.computeGpa(courses, 'hs-5.0-weighted');
  assert.equal(res.gpa, 5);
});

test('empty input returns a 0 GPA, not NaN', () => {
  const api = loadAcademicTools();
  const res = api.computeGpa([], 'college-4.0');
  assert.equal(res.gpa, 0);
  assert.equal(res.units, 0);
});

test('percent fallback derives the letter when none is provided', () => {
  const api = loadAcademicTools();
  const courses = [{ percent: 92, credits: 3 }]; // 92 → A- (3.7)
  const res = api.computeGpa(courses, 'college-4.0');
  assert.equal(res.gpa, 3.7);
});
