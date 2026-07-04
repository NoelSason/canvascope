/**
 * Canvascope v10 — Course Brain view.
 * Course-scoped Q&A over the indexed corpus with inline [n] citations and
 * clickable source chips. Retrieval is RAGCore.compileBrainPrompt (chunk-level
 * provenance); inference rides the shared AIRouter (local Nano → cloud).
 */
(() => {
  let deps = null;        // { markdown, scrollEl }
  let courseScope = '';   // '' = all courses
  let busy = false;

  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function populateCoursePicker() {
    const select = $('brain-course-select');
    const stat = $('brain-corpus-stat');
    if (!select) return;

    const courses = await RAGCore.listCourses();
    // Keep the "All courses" option, replace the rest.
    select.querySelectorAll('option:not(:first-child)').forEach(o => o.remove());
    courses.forEach(({ courseName, count }) => {
      const opt = document.createElement('option');
      opt.value = courseName;
      opt.textContent = `${courseName} (${count})`;
      select.appendChild(opt);
    });

    const total = courses.reduce((sum, c) => sum + c.count, 0);
    if (stat) stat.textContent = total > 0 ? `${total} items indexed` : 'Nothing indexed yet';
  }

  /** Turn [n] markers in rendered markdown into cite pills. */
  function decorateCitations(html, sources) {
    const byNumber = new Map((sources || []).map(source => [Number(source.n), source]));
    return html.replace(/\[(\d{1,2})\]/g, (match, num) => {
      const n = Number(num);
      const source = byNumber.get(n);
      if (!source) return match;
      return `<button class="brain-cite" data-cite="${n}" title="${escapeHtml(source.title)}">${n}</button>`;
    });
  }

  function renderSourceChips(container, sources) {
    if (!sources.length) return;
    const rail = document.createElement('div');
    rail.className = 'brain-source-rail';
    const confidence = summarizeSourceConfidence(sources);
    const badge = document.createElement('span');
    badge.className = `brain-source-confidence is-${confidence.level}`;
    badge.textContent = confidence.label;
    badge.title = confidence.title;
    rail.appendChild(badge);
    sources.forEach(source => {
      const chip = document.createElement(source.url ? 'button' : 'span');
      chip.className = 'brain-source-chip' + (source.url ? ' is-link' : '');
      chip.dataset.n = String(source.n);
      const loc = source.page ? ` · p.${source.page}` : '';
      chip.innerHTML = `<span class="chip-n">${source.n}</span>${escapeHtml(source.title)}${loc}`;
      if (source.url) {
        chip.title = source.url;
        chip.addEventListener('click', () => chrome.tabs.create({ url: source.url }));
      }
      rail.appendChild(chip);
    });
    container.appendChild(rail);
  }

  function summarizeSourceConfidence(sources = []) {
    const count = Array.isArray(sources) ? sources.length : 0;
    if (!count) {
      return {
        level: 'low',
        label: 'No source confidence',
        title: 'No retrieved course sources were attached. Scan or index more material before trusting this answer.'
      };
    }

    const anchored = sources.filter(source => source && (source.url || source.page || source.course || source.title)).length;
    if (count >= 3 && anchored >= 2) {
      return {
        level: 'strong',
        label: 'Strong source confidence',
        title: 'This answer has multiple anchored course sources. Still verify important facts before submitting coursework.'
      };
    }
    if (anchored >= 1) {
      return {
        level: 'ok',
        label: 'Source-backed',
        title: 'This answer has at least one course source. Use the chips below to verify the cited context.'
      };
    }
    return {
      level: 'low',
      label: 'Low source confidence',
      title: 'Retrieved chunks lack stable anchors. Try indexing the PDF/page again or ask for narrower sources.'
    };
  }

  function appendBlock(role, html) {
    const thread = $('brain-thread');
    const empty = $('brain-empty');
    if (empty) empty.remove();

    const block = document.createElement('div');
    block.className = `brain-block brain-block-${role} animate-fade-in`;
    block.innerHTML = `
      <div class="brain-block-label">${role === 'q' ? 'You' : 'Course Brain'}</div>
      <div class="brain-block-body">${html}</div>
    `;
    thread.appendChild(block);
    scrollThread();
    return block;
  }

  function scrollThread() {
    const viewport = $('view-brain');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }

  function createThrottledBrainRenderer(body, sources) {
    let pendingText = '';
    let lastRendered = null;
    let frameId = 0;
    const raf = window.requestAnimationFrame || ((fn) => window.setTimeout(fn, 16));
    const caf = window.cancelAnimationFrame || window.clearTimeout;

    const render = (text) => {
      if (text === lastRendered) return;
      lastRendered = text;
      body.innerHTML = decorateCitations(deps.markdown(text), sources || []);
      scrollThread();
    };

    const flush = () => {
      frameId = 0;
      render(pendingText);
    };

    return {
      update(text) {
        pendingText = String(text || '');
        if (pendingText === lastRendered || frameId) return;
        frameId = raf(flush);
      },
      finish(text) {
        pendingText = String(text || '');
        if (frameId) {
          caf(frameId);
          frameId = 0;
        }
        render(pendingText);
      }
    };
  }

  function clipForPrompt(text, limit) {
    const value = String(text || '').trim();
    if (value.length <= limit) return { text: value, clipped: false };

    const clipped = value.slice(0, limit).trimEnd();
    const lastBreak = clipped.lastIndexOf('\n');
    const minUsefulLength = Math.floor(limit * 0.55);
    const lineBounded = lastBreak >= minUsefulLength
      ? clipped.slice(0, lastBreak).trimEnd()
      : clipped;

    return { text: lineBounded, clipped: true };
  }

  function sourceLabel(source = {}) {
    const parts = [source.title || 'Canvas/PDF source'];
    const details = [];
    if (source.course) details.push(source.course);
    if (source.page) details.push(`p. ${source.page}`);
    if (source.url) details.push(source.url);
    return details.length ? `${parts[0]} (${details.join(' · ')})` : parts[0];
  }

  function buildStudyNotesPrompt(topic) {
    return `Create citation-first study notes for: ${String(topic || '').trim()}.

Use the course/PDF sources and include a citation like [1] on every factual bullet. Structure:
1. Key concepts and definitions
2. Worked examples that a CS student can replay in Lectra
3. Edge cases / common mistakes
4. Confusion checkpoint: 3 quick self-test questions
5. Lectra handoff: portable notes, commands, files, or notebook cells to create next

If the sources are thin, say what is missing instead of inventing facts.`;
  }

  function buildSelectionStudyNotePrompt(selection, source) {
    const clipped = clipForPrompt(selection, 1800);
    return `Turn this selected Canvas/PDF passage into structured study notes.
Source: ${sourceLabel(source)}
${clipped.clipped ? 'Note: the selection was clipped for speed; focus on the visible excerpt.\n' : ''}
Process only the selected excerpt first; Do not invent facts beyond it.

Excerpt:
${clipped.text}

Output:
- Concept summary with Citation chip [1]
- Worked example
- Edge case / common mistake
- Confusion checkpoint question
- Lectra handoff: what to save as a note or notebook cell`;
  }

  function buildAssignmentBridgePrompt(text, source) {
    const clipped = clipForPrompt(text, 1700);
    return `Convert this Canvas/PDF assignment context into a Lectra action plan.
Source: ${sourceLabel(source)}
${clipped.clipped ? 'Note: the assignment text was clipped for speed; flag any missing rubric details.\n' : ''}
Assignment context:
${clipped.text}

Include:
- Requirements explicitly present in the source
- Edge cases / tests to run
- Commands or files to inspect
- Performance / lag audit opportunities
- Lectra handoff: concise checklist for the project notebook

Do not invent rubric details.`;
  }

  function buildConceptDrillPrompt(selection, source) {
    const clipped = clipForPrompt(selection, 1600);
    return `Create a fast active-recall drill from this selected excerpt.
Source: ${sourceLabel(source)}
${clipped.clipped ? 'Note: the excerpt was clipped for speed.\n' : ''}
Use only the selected excerpt first and do not invent facts.

Excerpt:
${clipped.text}

Return:
- Tiny worked example
- Recall questions with answers hidden under short labels
- Performance / lag hook if the concept relates to code or tooling
- Lectra drill handoff`;
  }

  function buildCodeTracePrompt(trace, source) {
    const clipped = clipForPrompt(trace, 1600);
    return `Explain this code trace using the course context, then prepare a Lectra debug handoff.
Source: ${sourceLabel(source)}
${clipped.clipped ? 'Note: the log was clipped for speed; ask for the missing tail if needed.\n' : ''}
Trace:
${clipped.text}

Include:
- Likely failure point
- Minimal reproduction
- Edge-case test
- Performance / lag audit
- Lectra debug handoff

Do not invent hidden requirements.`;
  }

  function buildExamSprintPrompt(topic, source) {
    const clipped = clipForPrompt(topic, 1200);
    return `Create a 25-minute exam sprint from this Canvas/PDF context.
Source: ${sourceLabel(source)}
${clipped.clipped ? 'Note: the topic/context was clipped for speed; ask for missing pages if needed.\n' : ''}Context:
${clipped.text}

Return:
- 5-minute skim plan with citation targets
- 10-minute active recall drill
- 7-minute worked example or trace
- 3-minute Lectra handoff: exact note title, notebook cell, or checklist to save
- One performance/lag angle if the topic involves code, tools, PDFs, or notebooks

Use only the cited context first; say what source is missing instead of inventing facts.`;
  }

  function buildOfficeHoursPrepPrompt(context, source) {
    const clipped = clipForPrompt(context, 1500);
    return `Create a concise office-hours prep sheet from this Canvas/PDF course context.
Source: ${sourceLabel(source)}
${clipped.clipped ? 'Note: the context was clipped for speed; ask for the missing tail if needed.\n' : ''}Context:
${clipped.text}

Return:
- Top 3 questions to ask, each tied to a citation like [1]
- What I already tried or should try before attending
- Assignment, grade, or deadline risk to clarify
- CS debugging/repro detail to bring if this involves code
- Lectra handoff: note title, checklist, or notebook cell to save after office hours

Use only the provided context first. If there is not enough evidence, say what Canvas page, rubric, grade item, or lecture note is missing.`;
  }

  function buildMistakeReplayPrompt(context, source) {
    const clipped = clipForPrompt(context, 1600);
    return `Build a cited mistake-replay journal from this Canvas/PDF context.
Source: ${sourceLabel(source)}
${clipped.clipped ? 'Note: the context was clipped for speed; flag any missing rubric, trace, or feedback details.\n' : ''}Context:
${clipped.text}

Return:
- What went wrong: misconception, bug pattern, missed requirement, or confusing step, with citation [1]
- Minimal replay: tiny example, trace, command, or notebook cell that recreates the issue
- Corrective move: invariant, edge-case check, proof step, or debugging habit to use next time
- Retest checklist: 2 to 4 concrete checks before submitting or reviewing
- Lectra save: exact flashcard, checklist, or notebook cell title for spaced review

Use only the provided context first. If evidence is thin, say what source, rubric, code, log, or lecture note is missing instead of inventing facts.`;
  }

  function buildUpcomingWorkTriagePrompt(context, source) {
    const clipped = clipForPrompt(context, 1700);
    return `Turn this Canvas assignment/deadline context into an upcoming-work triage plan.
Source: ${sourceLabel(source)}
${clipped.clipped ? 'Note: the context was clipped for speed; flag any missing rubric, due-date, or submission details.\n' : ''}Context:
${clipped.text}

Return:
- Priority lane: quick task, medium task, project/exam prep, or unknown — with the reason and citation [1]
- Due-soon risk: what must happen in the next 24-48 hours, if anything
- Starter checklist: first concrete actions, files/links to open, commands/tests to run, or questions to ask
- Submission sanity check: how to verify upload, timestamp, gradebook status, or external-tool completion
- Lectra handoff: note title, checklist, or notebook cell to create for this work

Use only the provided Canvas/PDF context first. If evidence is thin, say what syllabus, assignment page, rubric, or link is missing instead of inventing requirements.`;
  }

  // Questions like "what do I need to get an A" are answered by the deterministic
  // grade-target calculator (grade-target.js), NOT the LLM — LLMs are unreliable
  // at the weighted arithmetic. Schedule/policy questions fall through to the
  // normal retrieval path, which now includes parsed syllabus memory.
  // True for "what do I need for an A", "what do I need to get a B+", "how do I
  // get an A", "can I still pass", "what grade do I need", etc. — but NOT for
  // study/prep questions like "what do I need to study".
  function isGradeTargetQuestion(q) {
    const s = String(q || '').toLowerCase();
    const STUDY = /\bneed\s+to\s+(study|read|review|prepare|prep|do|bring|know|watch|practice|memoriz|finish|submit|turn in)/;
    if (/\bwhat\s+(?:do|would|will|'?ll)\s+i\s+need\b/.test(s)) return !STUDY.test(s);
    if (/\bwhat(?:'s| is| do i need)\b.*\bfor\s+(?:an?\s+)?[a-d][+-]?\b/.test(s)) return true;
    if (/\bhow\s+(?:do|can|could)\s+i\s+(?:get|earn|score|make|pull|secure)\b/.test(s)) return true;
    if (/\bcan i (?:still )?(?:get|earn|pass|make|score|pull)\b/.test(s)) return true;
    if (/\bwhat grade\b/.test(s)) return true;
    if (/\bgrade i need\b/.test(s)) return true;
    // "need …" anywhere together with an explicit letter target ("for an A").
    if (/\bneed\b/.test(s) && /\b(?:for|get|getting|earn|make|score)\s+(?:an?\s+)?[a-d][+-]?\b/.test(s)) return true;
    return false;
  }

  function parseTargetLetter(q) {
    const m = String(q).match(/\b(?:get|earn|score|make|want|need|for)\s+(?:an?\s+)?([A-D][+-]?)(?![A-Za-z0-9])/i);
    return m ? m[1].toUpperCase() : 'A';
  }

  // Course names differ across sources — the picker uses indexedContent's
  // courseName (e.g. "Organic Chemistry Laboratory (Spring 2026)"), the syllabus
  // parse stores the breadcrumb name ("Chem 3BL"), and Canvas grades use yet
  // another course.name. Normalize (drop term/year/punctuation) and match
  // loosely so any of them resolves to the same Canvas courseId. This path can
  // run repeatedly while answering grade questions, so cache normalized labels
  // to avoid regex churn on large indexed course lists.
  const normNameCache = new Map();
  const MAX_NORM_NAME_CACHE = 256;

  function normName(s) {
    const key = String(s || '');
    if (normNameCache.has(key)) return normNameCache.get(key);
    const normalized = key
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')                       // drop "(Spring 2026)"
      .replace(/\b(spring|summer|fall|winter)\b/g, ' ')
      .replace(/\b20\d\d\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normNameCache.size >= MAX_NORM_NAME_CACHE) normNameCache.clear();
    normNameCache.set(key, normalized);
    return normalized;
  }
  function nameMatch(a, b) {
    const x = normName(a), y = normName(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
  }

  // All courses we can identify, with their Canvas courseId, deduped by id.
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

  // When no course is selected, see if the question names one we know about.
  async function inferCourseFromText(text) {
    const t = String(text || '').toLowerCase();
    const cands = (await collectCourseCandidates())
      .filter(c => c.name)
      .sort((a, b) => normName(b.name).length - normName(a.name).length); // longest first
    for (const c of cands) {
      const n = normName(c.name);
      if (n && (t.includes(n) || t.includes(String(c.name).toLowerCase()))) return c;
    }
    return null;
  }

  // The course the user is actually looking at — used when the picker is on
  // "All courses" and the question says "this class". Reads the active Canvas
  // tab's URL (/courses/<id>) directly.
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
   * Handle a grade-target question deterministically. Returns rendered HTML to
   * display, or null if this isn't a grade-target question.
   */
  async function tryGradeTarget(question) {
    if (!isGradeTargetQuestion(question)) return null;
    const GT = self.CanvascopeGradeTarget;
    if (!GT) {
      // The calculator script isn't loaded — almost always a stale build. Make
      // it visible instead of silently falling back to the LLM.
      return deps.markdown('_Grade calculator isn\'t loaded yet. Reload Canvascope at `chrome://extensions`, then close and reopen this panel._');
    }

    let courseId = courseScope ? await resolveCourseId(courseScope) : null;
    let courseName = courseScope || '';
    let host = null;
    if (!courseId) {
      const inferred = await inferCourseFromText(question);
      if (inferred) { courseId = inferred.id; courseName = inferred.name; }
    }
    if (!courseId) {
      // "this class" with the picker on All courses → use the active Canvas tab.
      const active = await activeTabCourse();
      if (active) { courseId = active.id; host = active.host; }
    }
    if (!courseId) {
      return deps.markdown('Open the course in Canvas (or pick it from the dropdown above), then ask again.');
    }
    if (!courseName) courseName = (await courseNameById(courseId)) || 'this course';

    const gb = await fetchGradebook(courseId, host);
    if (!gb || !gb.ok || !Array.isArray(gb.assignments) || gb.assignments.length === 0) {
      return deps.markdown(`I couldn't read your gradebook for **${escapeHtml(courseName)}**. Open the course in Canvas (so I can read it with your session), then ask again.`);
    }

    const syllabus = (await self.CanvascopeSyllabusMemory?.getCourse?.(courseId)) || {};
    const result = GT.compute({
      assignments: gb.assignments,
      groups: gb.groups,
      syllabus,
      targetLetter: parseTargetLetter(question)
    });

    let answer = GT.formatAnswer(result, courseName);
    if (result.weightSource === 'canvas' && !(syllabus.gradingScheme && syllabus.gradingScheme.length)) {
      answer += `\n\n_Based on Canvas's category weights — open this course's syllabus once and I'll use its exact weighting and drop-lowest rules._`;
    }
    return deps.markdown(answer);
  }

  /**
   * Ask the Brain a question. Returns when streaming completes.
   * @param {string} question
   */
  async function ask(question) {
    if (busy || !question.trim()) return;
    busy = true;

    appendBlock('q', escapeHtml(question));
    const answerBlock = appendBlock('a', `
      <div class="stream-loader">
        <div class="stream-dot"></div><div class="stream-dot"></div><div class="stream-dot"></div>
      </div>
    `);
    const body = answerBlock.querySelector('.brain-block-body');

    try {
      // Deterministic grade-target path ("what do I need to get an A") — no LLM.
      const gradeTargetHtml = await tryGradeTarget(question);
      if (gradeTargetHtml != null) {
        body.innerHTML = gradeTargetHtml;
        scrollThread();
        return;
      }

      const ready = await AIRouter.ensureReady();
      if (!ready.ok) {
        body.innerHTML = deps.markdown('**AI route unavailable.** Sign in from the Canvascope popup to enable cloud fallback, or enable Chrome\'s on-device model.');
        return;
      }

      const { prompt, sources } = await RAGCore.compileBrainPrompt(question, { courseName: courseScope });

      // Personalize via the system block only — the corpus/prompt stays
      // untouched so claude-proxy's prompt cache keeps hitting. The date line
      // keeps the model from treating a present-day term (e.g. "Summer 2026")
      // as a future, "not yet active" course and refusing to summarize indexed
      // materials.
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
      const dateBlock = `\n\nToday's date is ${today}. Treat this as the current date for any time-relative question ("this week", "so far"). The student's indexed materials reflect their ACTUAL, current enrollment — never claim a course "hasn't started" or "isn't active yet" based on its term name or your own sense of the year; if sources are present, summarize what they contain.`;
      const profileBlock = (window.StudentProfile && StudentProfile.compileContextBlock()) || '';
      const system = AIRouter.getState().systemInstruction + dateBlock + profileBlock;

      let full = '';
      const renderer = createThrottledBrainRenderer(body, sources);
      for await (const delta of AIRouter.stream(prompt, { system })) {
        if (body.querySelector('.stream-loader')) body.innerHTML = '';
        full += delta;
        renderer.update(full);
      }

      if (!full.trim()) {
        renderer.finish('*No answer was generated. Try rephrasing the question.*');
      } else {
        renderer.finish(full);
      }
      renderSourceChips(body.parentElement, sources);

      // Cite pills scroll their chip into view and flash it.
      answerBlock.querySelectorAll('.brain-cite').forEach(pill => {
        pill.addEventListener('click', () => {
          const chip = answerBlock.querySelector(`.brain-source-chip[data-n="${pill.dataset.cite}"]`);
          if (!chip) return;
          chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          chip.classList.remove('is-flash');
          void chip.offsetWidth; // restart the flash animation
          chip.classList.add('is-flash');
        });
      });
      scrollThread();
    } catch (err) {
      console.error('[Canvascope Brain] Ask failed:', err);
      if (body.querySelector('.stream-loader')) body.innerHTML = '';
      body.innerHTML += deps.markdown(`**Something went wrong:** ${err.message || err}`);
    } finally {
      busy = false;
    }
  }

  /**
   * Build a grounded practice-quiz request with a tiny spaced-review follow-up.
   * Students using AI study tools are better served by retrieval practice than
   * one-off summaries, so keep the quiz cited and add a short replay schedule.
   */
  function buildPracticeQuizPrompt(scopeLabel) {
    return `Create a 4-question practice quiz on the most important concepts in ${scopeLabel}. For each question give the answer on the next line in bold. Base every question on the sources.

Add a citation like [1] to each question or answer explanation. If a question cannot
be tied to a visible source, replace it with a source-backed question instead.

Before the quiz, add one short-answer warmup that the student should answer from memory before looking at options.

After the answers, add a short "Review next" section with:
- what to retry today
- what to revisit tomorrow
- one interleaved transfer question that connects this topic to a neighboring concept, assignment pattern, or debugging workflow found in the sources
- one likely misconception or trap answer to watch for
- what to save into Lectra as a notebook cell, flashcard, or checklist

End with a one-line academic integrity reminder to verify AI-generated study aids
against the cited course material before submitting coursework.

If the sources are thin, say what material is missing instead of inventing facts.`;
  }

  function buildFlashcardPackPrompt(scopeLabel) {
    return `Create a citation-first flashcard pack from ${scopeLabel} for quick active recall.

Return exactly:
1. 6 source-backed cards in Front / Back format. Put a citation like [1] on every back.
2. 2 trap cards for common misconceptions or edge cases found in the sources.
3. 1 tiny code, command, proof, or calculation replay card when the sources support it.
4. Review cadence: what to retry today, tomorrow, and later this week.
5. Lectra export: concise card titles or notebook-cell names to save next.

Keep each front short enough to answer from memory before revealing the back. If a card
cannot be tied to a visible source, replace it with a source-backed card. If the sources
are thin, say what lecture, page, rubric, or file is missing instead of inventing facts.`;
  }

  /**
   * Generate a grounded practice quiz from the current Brain scope.
   * Rides the same retrieval + router path as ask().
   */
  async function quiz() {
    const scopeLabel = courseScope || 'my courses';
    return ask(buildPracticeQuizPrompt(scopeLabel));
  }

  function init(dependencies) {
    deps = dependencies;
    const select = $('brain-course-select');
    if (select) {
      select.addEventListener('change', () => { courseScope = select.value; });
    }
    populateCoursePicker();
  }

  const api = { init, ask, quiz, refresh: populateCoursePicker, isBusy: () => busy };
  api.__test = {
    decorateCitations,
    createThrottledBrainRenderer,
    buildStudyNotesPrompt,
    buildSelectionStudyNotePrompt,
    buildAssignmentBridgePrompt,
    buildConceptDrillPrompt,
    buildCodeTracePrompt,
    buildExamSprintPrompt,
    buildOfficeHoursPrepPrompt,
    buildMistakeReplayPrompt,
    buildUpcomingWorkTriagePrompt,
    buildPracticeQuizPrompt,
    buildFlashcardPackPrompt,
    summarizeSourceConfidence,
    clipForPrompt,
    parseTargetLetter,
    normName,
    nameMatch
  };
  window.CourseBrain = api;
})();
