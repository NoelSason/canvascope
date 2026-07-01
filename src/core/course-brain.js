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
    return html.replace(/\[(\d{1,2})\]/g, (match, num) => {
      const n = Number(num);
      const source = sources.find(s => s.n === n);
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

  function buildStudyNotesPrompt(scopeLabel) {
    const cleanScope = String(scopeLabel || 'the indexed course materials').trim() || 'the indexed course materials';
    return `Turn ${cleanScope} into actionable study notes. Use this exact structure:
1. Key concepts — bullets, each with at least one citation like [1].
2. Plain-English explanation — short and source-grounded.
3. Worked example — adapt one example from the sources when possible.
4. Edge cases / common mistakes — what a student is likely to miss.
5. Likely exam or assignment angle — only if supported by the sources.
6. Lectra handoff — 3 portable bullets a student can paste into Lectra.
Every factual claim must be grounded in the retrieved sources; if the sources are thin, say what is missing instead of guessing.`;
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
    refresh: populateCoursePicker,
    isBusy: () => busy,
    __test: { createThrottledBrainRenderer, decorateCitations, buildStudyNotesPrompt }
  };
})();
