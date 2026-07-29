/**
 * Canvascope v11 — Exam Builder.
 *
 * Builds a practice exam (multiple-choice + short-answer) with a separate
 * answer key from everything indexed in a course. It rides the same
 * whole-corpus route as Course Brain: RAGCore.compileCourseCorpus → the
 * byte-stable corpus block → AIRouter.stream (claude-proxy Haiku 4.5 with
 * prompt caching).
 *
 * BYTE-STABILITY CONTRACT (shared prompt cache with Brain Q&A):
 * - EXAM_SYSTEM_PROMPT is a fixed constant — it interpolates NO dates, user
 *   identity, question count, or any per-request value. Two exam builds for the
 *   same course therefore send byte-identical `system` AND `corpus` strings.
 * - Every exam parameter (question count, optional focus topic) lives in the
 *   USER prompt, which is the only string allowed to vary between builds.
 * - The corpus string from compileCourseCorpus is passed through verbatim.
 * These three rules keep the cached corpus prefix identical across exam builds
 * and Brain questions on the same course, so cache hits are shared.
 */
(() => {
  // Fixed, byte-stable system prompt. DO NOT interpolate dates, the student's
  // name/profile, the question count, or any request-specific value here — that
  // would fork the prompt cache. Exam parameters go in the user prompt instead.
  const EXAM_SYSTEM_PROMPT = `You are Canvascope's exam builder. You write rigorous practice exams for a student, grounded strictly in the numbered course sources you are given.

Rules:
- Base every question ONLY on the provided course sources. Do not invent facts that aren't supported by the sources.
- After each question, cite the source(s) it draws from using [n] markers that match the numbered sources.
- Write a MIX of question types: multiple-choice (four options A–D, exactly one correct) and short-answer. Aim for roughly half of each.
- Order the exam from easier recall questions to harder applied/analytical ones.
- Keep questions clear and unambiguous. Multiple-choice distractors should be plausible, not obvious throwaways.

Output format (Markdown), in exactly this structure:

## Practice Exam

1. <question text> [n]
   - A. <option>
   - B. <option>
   - C. <option>
   - D. <option>
2. <short-answer question> [n]

...continue numbering...

---

## Answer Key

1. <correct option letter> — <one-line explanation grounded in the sources> [n]
2. <model short answer — 1–3 sentences> [n]

...continue...

Keep the exam and the answer key clearly separated by the horizontal rule. Do not add any preamble, closing remarks, or a separate source list — Canvascope shows sources separately.`;

  const STORAGE_KEY = 'lastExamByCourse';
  const MIN_QUESTIONS = 3;
  const MAX_QUESTIONS = 25;
  const DEFAULT_QUESTIONS = 10;
  // Room for a full mixed exam plus its answer key. This is a request param
  // only — it never enters the cached prompt, so it can't affect byte-stability.
  const EXAM_MAX_TOKENS = 8000;

  function clampCount(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_QUESTIONS;
    return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, v));
  }

  /**
   * The ONLY string that may vary between builds. Every exam parameter is
   * carried here so the system + corpus stay byte-identical for cache sharing.
   */
  function buildUserPrompt({ questionCount = DEFAULT_QUESTIONS, focusTopic = '' } = {}) {
    const count = clampCount(questionCount);
    let prompt = `Write a ${count}-question practice exam from the course sources above, mixing multiple-choice and short-answer questions, then a separate answer key. Follow the required Markdown structure exactly.`;
    const topic = String(focusTopic || '').trim();
    if (topic) prompt += ` Weight the exam toward this topic where the sources support it: ${topic}.`;
    return prompt;
  }

  /** Storage sub-key for a course scope ('' = all courses). */
  function keyFor(courseName) {
    const name = String(courseName || '').trim();
    return name || '__all__';
  }

  /**
   * Read the most recently built exam for a course scope, if any.
   * @param {string} courseName
   * @returns {Promise<{markdown:string, generatedAt:number, courseName:string}|null>}
   */
  async function loadLastExam(courseName = '') {
    try {
      const { [STORAGE_KEY]: map = {} } = await chrome.storage.local.get(STORAGE_KEY);
      return map[keyFor(courseName)] || null;
    } catch (_) {
      return null;
    }
  }

  /** Persist the finished exam per course. */
  async function saveLastExam(courseName, markdown) {
    try {
      const { [STORAGE_KEY]: map = {} } = await chrome.storage.local.get(STORAGE_KEY);
      map[keyFor(courseName)] = {
        markdown,
        generatedAt: Date.now(),
        courseName: String(courseName || '')
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: map });
    } catch (e) {
      console.warn('[Canvascope Exam] Could not persist exam:', e);
    }
  }

  /**
   * Build a practice exam for a course scope, streaming Markdown deltas.
   *
   * @param {{courseName?:string, questionCount?:number, focusTopic?:string}} params
   * @param {{onDelta?:(delta:string, full:string)=>void}} [hooks]
   * @returns {Promise<{markdown:string, sources:Array}>}
   */
  async function build({ courseName = '', questionCount = DEFAULT_QUESTIONS, focusTopic = '' } = {}, hooks = {}) {
    const { onDelta } = hooks;

    if (typeof RAGCore === 'undefined' || typeof AIRouter === 'undefined') {
      throw new Error('Canvascope is still loading — try again in a moment.');
    }

    const compiled = await RAGCore.compileCourseCorpus(courseName);
    if (!compiled || !compiled.corpus || !Array.isArray(compiled.sources) || !compiled.sources.length) {
      throw new Error('No indexed course materials to build an exam from yet. Open a few course pages or files so Canvascope can index them first.');
    }

    // system + corpus are byte-stable; only the user prompt carries parameters.
    const userPrompt = buildUserPrompt({ questionCount, focusTopic });
    let markdown = '';
    for await (const delta of AIRouter.stream(userPrompt, {
      system: EXAM_SYSTEM_PROMPT,
      corpus: compiled.corpus,
      maxTokens: EXAM_MAX_TOKENS
    })) {
      markdown += delta;
      if (typeof onDelta === 'function') onDelta(delta, markdown);
    }

    if (markdown.trim()) {
      await saveLastExam(courseName, markdown);
    }
    return { markdown, sources: compiled.sources };
  }

  window.CanvascopeExamBuilder = {
    EXAM_SYSTEM_PROMPT,
    buildUserPrompt,
    build,
    loadLastExam,
    saveLastExam
  };
})();
