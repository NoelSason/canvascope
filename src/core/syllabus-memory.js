/**
 * Canvascope — Syllabus Memory
 *
 * One JSON blob per user (chrome.storage.local key `syllabusMemory`, mirrored to
 * the Supabase `user_syllabi` table via the existing csTools sync). The blob is
 * an object keyed by courseId; each entry holds the structured syllabus the
 * detector parsed: the grading scheme (category weights + drop-lowest rules),
 * letter cutoffs, schedule (meeting days / no-class dates / exam dates),
 * policies, and instructor info.
 *
 * Two consumers:
 *   1. grade-target.js — uses gradingScheme + letterCutoffs (+ live Canvas
 *      gradebook) to answer "what do I need to get an A".
 *   2. rag-core.js — folds a compact text rendering into the Course Brain corpus
 *      so schedule / policy questions ("when do we not have class") get answered
 *      with a citation.
 *
 * Loaded into both the service worker (importScripts) and the side panel
 * (<script>); attaches to `self` (=== window in the panel). The Supabase mirror
 * only runs where CanvascopeAgentSync exists (the service worker) — reads work
 * everywhere via chrome.storage.local.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'syllabusMemory';

  // Standard US letter cutoffs — used as a fallback when the syllabus doesn't
  // state its own scale. Order matters (descending) for grade-target lookups.
  const DEFAULT_LETTER_CUTOFFS = [
    { letter: 'A', min: 93 }, { letter: 'A-', min: 90 },
    { letter: 'B+', min: 87 }, { letter: 'B', min: 83 }, { letter: 'B-', min: 80 },
    { letter: 'C+', min: 77 }, { letter: 'C', min: 73 }, { letter: 'C-', min: 70 },
    { letter: 'D+', min: 67 }, { letter: 'D', min: 63 }, { letter: 'D-', min: 60 },
    { letter: 'F', min: 0 }
  ];

  function normalizeId(courseId) {
    return courseId == null ? '' : String(courseId);
  }

  const SyllabusMemory = {
    DEFAULT_LETTER_CUTOFFS,
    STORAGE_KEY,

    /** The full blob: { [courseId]: entry }. */
    async load() {
      const db = await chrome.storage.local.get([STORAGE_KEY]);
      const blob = db[STORAGE_KEY];
      return blob && typeof blob === 'object' ? blob : {};
    },

    /** One course's parsed syllabus, or null. */
    async getCourse(courseId) {
      const id = normalizeId(courseId);
      if (!id) return null;
      const blob = await this.load();
      return blob[id] || null;
    },

    /** Resolve a course entry by (case-insensitive) name — the picker uses names. */
    async getCourseByName(courseName) {
      const name = String(courseName || '').trim().toLowerCase();
      if (!name) return null;
      const blob = await this.load();
      for (const id of Object.keys(blob)) {
        const entry = blob[id];
        if (entry && String(entry.courseName || '').trim().toLowerCase() === name) return entry;
      }
      return null;
    },

    /** Courses we have a parsed syllabus for: [{ courseId, courseName, parsedAt }]. */
    async listCourses() {
      const blob = await this.load();
      return Object.keys(blob).map((id) => ({
        courseId: id,
        courseName: blob[id]?.courseName || '',
        parsedAt: blob[id]?.parsedAt || null
      }));
    },

    /**
     * Merge/replace one course's entry, persist locally, and trigger the
     * debounced Supabase sync (no-op outside the service worker). Returns the
     * stored entry.
     */
    async upsertCourse(courseId, data) {
      const id = normalizeId(courseId);
      if (!id) return null;
      const blob = await this.load();
      const entry = {
        ...(blob[id] || {}),
        ...(data || {}),
        courseId: id,
        parsedAt: Date.now()
      };
      blob[id] = entry;
      await chrome.storage.local.set({ [STORAGE_KEY]: blob });
      try {
        self.CanvascopeAgentSync?.pushKey?.(STORAGE_KEY, blob);
      } catch (_) { /* sync is best-effort, panel has no sync glue */ }
      return entry;
    },

    /**
     * Compact, deterministic text rendering of one course's syllabus for the
     * Course Brain corpus. Sorted/stable so the cached prefix stays byte-stable.
     */
    renderForCorpus(entry) {
      if (!entry) return '';
      const lines = [`SYLLABUS — ${entry.courseName || 'Course'}`];

      const isPoints = entry.gradeBasis === 'points';
      if (isPoints && entry.totalPoints) lines.push(`Total points: ${entry.totalPoints}`);
      const scheme = Array.isArray(entry.gradingScheme) ? entry.gradingScheme : [];
      if (scheme.length) {
        lines.push('Grading breakdown:');
        scheme
          .slice()
          .sort((a, b) => String(a.category).localeCompare(String(b.category)))
          .forEach((c) => {
            const drop = c.dropLowest ? `, drop lowest ${c.dropLowest}` : '';
            const amount = isPoints ? `${c.points || 0} pts` : `${c.weight}%`;
            lines.push(`- ${c.category}: ${amount}${drop}`);
          });
      }

      const cutoffs = Array.isArray(entry.letterCutoffs) ? entry.letterCutoffs : [];
      if (cutoffs.length) {
        const txt = cutoffs
          .slice()
          .sort((a, b) => (b.min || 0) - (a.min || 0))
          .map((c) => `${c.letter}≥${c.min}`)
          .join(', ');
        lines.push(`Letter cutoffs: ${txt}`);
      }

      const sched = entry.schedule || {};
      if (Array.isArray(sched.meetingDays) && sched.meetingDays.length) {
        lines.push(`Class meets: ${sched.meetingDays.join(', ')}`);
      }
      if (Array.isArray(sched.noClassDates) && sched.noClassDates.length) {
        lines.push(`No class on: ${sched.noClassDates.slice().sort().join(', ')}`);
      }
      if (Array.isArray(sched.examDates) && sched.examDates.length) {
        sched.examDates
          .slice()
          .sort((a, b) => String(a.date).localeCompare(String(b.date)))
          .forEach((e) => lines.push(`Exam — ${e.title || 'Exam'}: ${e.date}`));
      }

      const pol = entry.policies || {};
      if (pol.late) lines.push(`Late policy: ${pol.late}`);
      if (pol.attendance) lines.push(`Attendance: ${pol.attendance}`);
      if (pol.other) lines.push(`Other policies: ${pol.other}`);

      const inst = entry.instructor || {};
      if (inst.name) lines.push(`Instructor: ${inst.name}${inst.email ? ` (${inst.email})` : ''}`);
      if (inst.officeHours) lines.push(`Office hours: ${inst.officeHours}`);

      return lines.join('\n');
    }
  };

  self.CanvascopeSyllabusMemory = SyllabusMemory;
})();
