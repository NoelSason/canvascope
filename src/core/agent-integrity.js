/**
 * Canvascope Agent — Integrity Guard
 *
 * Enforces the hard product line: the autonomous agent never drafts, edits, or
 * submits graded content (assignments, quizzes, exams). Study aids only.
 *
 * This is the enforcement backstop. Two other layers sit in front of it:
 *   1. Capability boundary — there is simply no tool that can write to Canvas
 *      or submit anything (the strongest guarantee).
 *   2. System-prompt rule — the agent charter states the line verbatim.
 * This module is layer 3: a pre-execution check on every gated tool call so a
 * model that tries anyway is refused (and the refusal is logged + fed back so
 * the model self-corrects).
 *
 * Loaded into the service worker via importScripts; attaches to `self`.
 */
(function () {
  'use strict';

  // Tools whose inputs carry user-facing/persisted content and therefore must
  // be screened. Read-only tools (search/list/get) are never gated.
  const GATED_TOOLS = new Set([
    'create_todo',
    'create_calendar_event',
    'generate_study_plan',
    'send_to_lectra'
  ]);

  // Signals that the model is being asked to produce or submit graded work
  // rather than a study aid. Deliberately broad — false positives just nudge
  // the model to rephrase as a study aid; false negatives are the real risk.
  const GRADED_SUBMISSION_PATTERNS = [
    /\bsubmit(ting|ted)?\b/i,
    /\bturn(ing)?[\s-]?in\b/i,
    /\bhand(ing)?[\s-]?in\b/i,
    /\banswer key\b/i,
    /\b(quiz|exam|test|assignment|homework|hw)\s+answers?\b/i,
    /\banswers?\s+(to|for)\s+(the\s+)?(quiz|exam|test|assignment|homework|hw|q\d)/i,
    /\bfinal answer to\b/i,
    /\bfor credit\b/i,
    /\bwrite (my|the) (essay|paper|report|assignment|response)\b/i,
    /\bcomplete (the|my) (quiz|exam|assignment|homework)\b/i,
    /\bdo (my|the) (homework|assignment|quiz|exam)\b/i,
    /\bsolution(s)? to submit\b/i
  ];

  class IntegrityViolation extends Error {
    constructor(message) {
      super(message);
      this.name = 'IntegrityViolation';
    }
  }

  function collectText(input) {
    if (!input || typeof input !== 'object') return '';
    // Scan the fields where user-facing content lives.
    return ['title', 'summary', 'content', 'description', 'body', 'text', 'plan']
      .map((k) => (typeof input[k] === 'string' ? input[k] : ''))
      .join(' \n ');
  }

  const IntegrityGuard = {
    isGated(toolName) {
      return GATED_TOOLS.has(toolName);
    },

    /**
     * Throws IntegrityViolation if a gated tool call looks like it would
     * produce or submit graded content. No-op for non-gated tools.
     * @param {string} toolName
     * @param {object} input
     */
    assertStudyAidOnly(toolName, input) {
      if (!GATED_TOOLS.has(toolName)) return;
      const haystack = collectText(input);
      if (!haystack.trim()) return;
      for (const pattern of GRADED_SUBMISSION_PATTERNS) {
        if (pattern.test(haystack)) {
          throw new IntegrityViolation(
            'Refused: I can only create study aids (study plans, reminders, ' +
            'flashcards), not graded submission content like assignment, quiz, ' +
            'or exam answers. Reframe this as a study aid and try again.'
          );
        }
      }
    },

    IntegrityViolation
  };

  self.CanvascopeIntegrityGuard = IntegrityGuard;
})();
