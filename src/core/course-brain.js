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
    const sourceByNumber = new Map(sources.map(source => [source.n, source]));
    return html.replace(/\[(\d{1,2})\]/g, (match, num) => {
      const n = Number(num);
      const source = sourceByNumber.get(n);
      if (!source) return match;
      return `<button class="brain-cite" data-cite="${n}" title="${escapeHtml(source.title)}">${n}</button>`;
    });
  }

  function renderSourceChips(container, sources) {
    if (!sources.length) return;
    const rail = document.createElement('div');
    rail.className = 'brain-source-rail';
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
    let pendingMarkdown = '';
    let lastRenderedMarkdown = null;
    let frame = 0;
    const scheduleFrame = window.requestAnimationFrame || ((fn) => window.setTimeout(fn, 16));
    const cancelFrame = window.cancelAnimationFrame || window.clearTimeout;

    const render = () => {
      frame = 0;
      if (pendingMarkdown === lastRenderedMarkdown) return;
      lastRenderedMarkdown = pendingMarkdown;
      body.innerHTML = decorateCitations(deps.markdown(pendingMarkdown), sources);
      scrollThread();
    };

    return {
      update(markdown) {
        pendingMarkdown = markdown;
        if (!frame) frame = scheduleFrame(render);
      },
      finish(markdown) {
        pendingMarkdown = markdown;
        if (frame) {
          cancelFrame(frame);
          frame = 0;
        }
        render();
      }
    };
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
      const ready = await AIRouter.ensureReady();
      if (!ready.ok) {
        body.innerHTML = deps.markdown('**AI route unavailable.** Sign in from the Canvascope popup to enable cloud fallback, or enable Chrome\'s on-device model.');
        return;
      }

      const { prompt, sources } = await RAGCore.compileBrainPrompt(question, { courseName: courseScope });

      // Personalize via the system block only — the corpus/prompt stays
      // untouched so claude-proxy's prompt cache keeps hitting.
      const profileBlock = (window.StudentProfile && StudentProfile.compileContextBlock()) || '';
      const system = profileBlock ? AIRouter.getState().systemInstruction + profileBlock : undefined;

      let full = '';
      const renderer = createThrottledBrainRenderer(body, sources);
      for await (const delta of AIRouter.stream(prompt, { system })) {
        if (body.querySelector('.stream-loader')) body.innerHTML = '';
        full += delta;
        renderer.update(full);
      }

      if (!full.trim()) {
        body.innerHTML = deps.markdown('*No answer was generated. Try rephrasing the question.*');
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
   * Generate a grounded practice quiz from the current Brain scope.
   * Rides the same retrieval + router path as ask().
   */
  async function quiz() {
    const scopeLabel = courseScope || 'my courses';
    return ask(`Create a 4-question practice quiz on the most important concepts in ${scopeLabel}. For each question give the answer on the next line in bold. Base every question on the sources.`);
  }

  /** Generate concise, citation-first notes for the current course/PDF scope. */
  async function studyNotes() {
    const scopeLabel = courseScope || 'the indexed course materials';
    return ask(buildStudyNotesPrompt(scopeLabel));
  }

  function selectionStudyNote(selection, source = {}) {
    return ask(buildSelectionStudyNotePrompt(selection, source));
  }

  function buildSelectionStudyNotePrompt(selection, source = {}) {
    const excerpt = String(selection || '').trim();
    const safeExcerpt = excerpt.length > 2400
      ? `${excerpt.slice(0, 2400).trim()}\n… clipped for speed; use Expand context only if the selection is too thin.`
      : excerpt;
    const title = String(source.title || source.pageTitle || 'selected course material').trim();
    const locator = [source.page ? `p. ${source.page}` : '', source.url || '']
      .filter(Boolean)
      .join(' · ');
    return `Turn this selected Canvas/PDF passage into one compact study note. Process only the selected excerpt first so long PDFs and Canvas pages stay responsive; if more context is required, say exactly what is missing.

Source: ${title}${locator ? ` (${locator})` : ''}

Selected excerpt:
"""
${safeExcerpt || '[No selection provided]'}
"""

Use this exact structure:
- Concept
- Plain-English explanation
- Worked example
- Edge case / common mistake
- Why it matters for this course
- Citation chip: include the provided source title/page/URL when available
- Lectra handoff: one portable Markdown bullet
Do not invent facts beyond the selected excerpt.`;
  }

  function buildStudyNotesPrompt(scopeLabel) {
    const cleanScope = String(scopeLabel || 'the indexed course materials').trim() || 'the indexed course materials';
    return `Turn ${cleanScope} into actionable study notes. Use this exact structure:
1. Key concepts — bullets, each with at least one citation like [1].
2. Plain-English explanation — short and source-grounded.
3. Worked example — adapt one example from the sources when possible.
4. Edge cases / common mistakes — what a student is likely to miss.
5. Likely exam or assignment angle — only if supported by the sources.
6. Confusion checkpoint — one self-test question that exposes the most likely misunderstanding.
7. Lectra handoff — 3 portable bullets a student can paste into Lectra.
Every factual claim must be grounded in the retrieved sources; if the sources are thin, say what is missing instead of guessing.`;
  }

  function buildAssignmentBridgePrompt(assignment, source = {}) {
    const assignmentText = String(assignment || '').trim();
    const clippedAssignment = assignmentText.length > 2000
      ? `${assignmentText.slice(0, 2000).trim()}\n… clipped for speed; ask for targeted PDF/page context before expanding.`
      : assignmentText;
    const title = String(source.title || source.pageTitle || 'course assignment').trim();
    const course = String(source.course || source.courseName || '').trim();
    const locator = [course, source.page ? `p. ${source.page}` : '', source.url || '']
      .filter(Boolean)
      .join(' · ');
    return `Bridge this Canvas/PDF assignment context into a Lectra-ready coding/study plan. Work from the provided excerpt first so large course pages stay responsive; request only the missing context needed for the next action.

Source: ${title}${locator ? ` (${locator})` : ''}

Assignment excerpt:
"""
${clippedAssignment || '[No assignment excerpt provided]'}
"""

Use this exact structure:
1. Goal in one sentence — grounded in the excerpt.
2. Concepts to review — cite source title/page/URL when available.
3. Starter examples — one tiny input/output or worked example.
4. Edge cases / tests — at least three checks a CS student can run.
5. Commands or files to inspect — include likely notebook, repo, terminal, or PDF handoff steps.
6. Performance / lag audit — name the largest file/PDF/dataset and how to avoid re-parsing it.
7. Lectra handoff — 3 portable Markdown bullets to paste into a notebook.
Do not invent rubric details, due dates, APIs, or requirements not present in the excerpt.`;
  }

  function buildConceptDrillPrompt(concept, source = {}) {
    const conceptText = String(concept || '').trim();
    const clippedConcept = conceptText.length > 1800
      ? `${conceptText.slice(0, 1800).trim()}\n… clipped for speed; drill the selected concept before expanding to the full PDF/page.`
      : conceptText;
    const title = String(source.title || source.pageTitle || 'course concept').trim();
    const course = String(source.course || source.courseName || '').trim();
    const locator = [course, source.page ? `p. ${source.page}` : '', source.url || '']
      .filter(Boolean)
      .join(' · ');
    return `Turn this focused course concept into a fast active-recall drill for a CS student. Use only the selected excerpt first so long PDFs, Canvas pages, and generated notes stay responsive.

Source: ${title}${locator ? ` (${locator})` : ''}

Concept excerpt:
"""
${clippedConcept || '[No concept excerpt provided]'}
"""

Use this exact structure:
1. One-sentence mental model — grounded in the excerpt.
2. Tiny worked example — include inputs, output, and one intermediate state if applicable.
3. Recall questions — 3 short questions, each answer hidden on the next line as **Answer:**.
4. Edge-case trap — the mistake a student is most likely to make.
5. Performance / lag hook — if this concept touches code, state the input size or repeated operation to watch.
6. Lectra drill handoff — 3 portable Markdown bullets that can become notebook cells.
Preserve provided source title/page/URL in the drill; do not invent facts beyond the excerpt.`;
  }

  function init(dependencies) {
    deps = dependencies;
    const select = $('brain-course-select');
    if (select) {
      select.addEventListener('change', () => { courseScope = select.value; });
    }
    populateCoursePicker();
  }

  window.CourseBrain = {
    init,
    ask,
    quiz,
    studyNotes,
    selectionStudyNote,
    refresh: populateCoursePicker,
    isBusy: () => busy,
    __test: { createThrottledBrainRenderer, decorateCitations, buildStudyNotesPrompt, buildSelectionStudyNotePrompt, buildAssignmentBridgePrompt, buildConceptDrillPrompt }
  };
})();
