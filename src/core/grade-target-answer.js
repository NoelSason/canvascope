/**
 * Canvascope — Grade Target answerer (glue layer)
 *
 * Bridges a natural-language question ("what do I need for an A in this class")
 * to the deterministic calculator in grade-target.js. Handles intent detection,
 * resolving WHICH course (picker scope → course named in the question → the
 * active Canvas tab), pulling the live gradebook, loading parsed syllabus
 * memory, running the calc, and returning a ready-to-render markdown string.
 *
 * Returns a markdown string when it owns the question (including "pick a course"
 * / "couldn't read gradebook" cases), or null to let the normal LLM Ask flow
 * handle it. Loaded into the side panel; uses chrome.* + the globals
 * CanvascopeGradeTarget and CanvascopeSyllabusMemory.
 */
(function () {
  'use strict';

  // True for "what do I need for an A", "how do I get an A", "can I still
  // pass", "what grade do I need", etc. — but NOT for "what do I need to study".
  function isGradeTargetQuestion(q) {
    const s = String(q || '').toLowerCase();
    const STUDY = /\bneed\s+to\s+(study|read|review|prepare|prep|do|bring|know|watch|practice|memoriz|finish|submit|turn in)/;
    if (/\bwhat\s+(?:do|would|will|'?ll)\s+i\s+need\b/.test(s)) return !STUDY.test(s);
    if (/\bwhat(?:'s| is| do i need)\b.*\bfor\s+(?:an?\s+)?[a-d][+-]?\b/.test(s)) return true;
    if (/\bhow\s+(?:do|can|could)\s+i\s+(?:get|earn|score|make|pull|secure)\b/.test(s)) return true;
    if (/\bcan i (?:still )?(?:get|earn|pass|make|score|pull)\b/.test(s)) return true;
    if (/\bwhat grade\b/.test(s)) return true;
    if (/\bgrade i need\b/.test(s)) return true;
    if (/\bneed\b/.test(s) && /\b(?:for|get|getting|earn|make|score)\s+(?:an?\s+)?[a-d][+-]?\b/.test(s)) return true;
    return false;
  }

  function parseTargetLetter(q) {
    const m = String(q).match(/\b(?:get|earn|score|make|want|need|for)\s+(?:an?\s+)?([A-D][+-]?)\b/i);
    return m ? m[1].toUpperCase() : 'A';
  }

  // Course names differ across sources (picker name vs syllabus name vs Canvas
  // grades name) — normalize term/year/punctuation and match loosely.
  function normName(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\b(spring|summer|fall|winter)\b/g, ' ')
      .replace(/\b20\d\d\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function nameMatch(a, b) {
    const x = normName(a), y = normName(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
  }

  async function collectCourseCandidates() {
    const out = [];
    const seen = new Set();
    const add = (id, name) => {
      const key = id && String(id);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ id: key, name: name || '' });
    };
    try {
      ((await self.CanvascopeSyllabusMemory?.listCourses?.()) || [])
        .forEach(c => add(c.courseId, c.courseName));
    } catch (_) { /* ignore */ }
    try {
      const { canvasGradesByCourse = {}, indexedContent = [] } =
        await chrome.storage.local.get(['canvasGradesByCourse', 'indexedContent']);
      Object.entries(canvasGradesByCourse).forEach(([id, g]) => add(id, g.name));
      (Array.isArray(indexedContent) ? indexedContent : [])
        .forEach(it => { if (it && it.courseId) add(it.courseId, it.courseName); });
    } catch (_) { /* ignore */ }
    return out;
  }

  async function resolveCourseId(name) {
    if (!name) return null;
    const cands = await collectCourseCandidates();
    const exact = cands.find(c => normName(c.name) && normName(c.name) === normName(name));
    if (exact) return exact.id;
    const fuzzy = cands.find(c => nameMatch(c.name, name));
    return fuzzy ? fuzzy.id : null;
  }

  async function inferCourseFromText(text) {
    const t = String(text || '').toLowerCase();
    const cands = (await collectCourseCandidates())
      .filter(c => c.name)
      .sort((a, b) => normName(b.name).length - normName(a.name).length);
    for (const c of cands) {
      const n = normName(c.name);
      if (n && (t.includes(n) || t.includes(String(c.name).toLowerCase()))) return c;
    }
    return null;
  }

  // The course the user is looking at — for "this class" with no picker scope.
  async function activeTabCourse() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) return null;
      const u = new URL(tab.url);
      const m = u.pathname.match(/\/courses\/(\d+)/);
      if (!m) return null;
      return { id: m[1], host: u.hostname };
    } catch (_) { return null; }
  }

  async function courseNameById(courseId) {
    const cands = await collectCourseCandidates();
    const hit = cands.find(c => String(c.id) === String(courseId) && c.name);
    return hit ? hit.name : '';
  }

  function fetchGradebook(courseId, host) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'csTools.fetchGradebook', courseId, host }, (r) => {
          void chrome.runtime.lastError;
          resolve(r);
        });
      } catch (_) { resolve(null); }
    });
  }

  /**
   * @returns {Promise<string|null>} markdown answer, or null to defer to the LLM.
   */
  async function gradeTargetAnswer(question, courseScope) {
    if (!isGradeTargetQuestion(question)) return null;
    const GT = self.CanvascopeGradeTarget;
    if (!GT) return '_Grade calculator isn\'t loaded yet. Reload Canvascope at `chrome://extensions`, then reopen this panel._';

    let courseId = courseScope ? await resolveCourseId(courseScope) : null;
    let courseName = courseScope || '';
    let host = null;
    if (!courseId) {
      const inferred = await inferCourseFromText(question);
      if (inferred) { courseId = inferred.id; courseName = inferred.name; }
    }
    if (!courseId) {
      const active = await activeTabCourse();
      if (active) { courseId = active.id; host = active.host; }
    }
    if (!courseId) {
      return 'Open the course in Canvas (or pick it from the dropdown above), then ask again.';
    }
    if (!courseName) courseName = (await courseNameById(courseId)) || 'this course';

    const gb = await fetchGradebook(courseId, host);
    if (!gb || !gb.ok || !Array.isArray(gb.assignments) || gb.assignments.length === 0) {
      return `I couldn't read your gradebook for **${courseName}**. Open the course in Canvas (so I can read it with your session), then ask again.`;
    }

    const syllabus = (await self.CanvascopeSyllabusMemory?.getCourse?.(courseId)) || {};
    const result = GT.compute({
      assignments: gb.assignments,
      groups: gb.groups,
      syllabus,
      targetLetter: parseTargetLetter(question)
    });

    let answer = GT.formatAnswer(result, courseName);
    const hasScheme = (syllabus.gradingScheme && syllabus.gradingScheme.length);
    if (result.weightSource === 'canvas' && !hasScheme) {
      answer += `\n\n_Based on Canvas's category weights — open this course's syllabus once and I'll use its exact weighting and drop-lowest rules._`;
    }
    return answer;
  }

  self.CanvascopeGradeTargetAnswer = gradeTargetAnswer;
  self.CanvascopeGradeTargetAnswer.isGradeTargetQuestion = isGradeTargetQuestion;
})();
