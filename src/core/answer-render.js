/**
 * Canvascope — shared answer rendering helpers.
 *
 * One source of truth for turning an LLM answer into DOM: a tiny markdown
 * renderer, [n] → cite-pill decoration, and the clickable source rail. Used by
 * any surface that streams a RAG answer (the Ask sidepanel and the Cmd+K
 * overlay). Pure/DOM-only — no retrieval or inference here.
 *
 * Exposed as window.CanvascopeAnswerRender so it can be loaded as a classic
 * script in any extension page (popup, sidepanel).
 */
(function () {
  /**
   * Super-simple markdown: bold, italic, inline code, line breaks, and
   * single-level bullet lists. Escapes HTML first so model output is safe.
   */
  function parseSimpleMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>')
      .replace(/- (.*?)<br>/g, '<li>$1</li>')
      .replace(/<li>(.*?)<\/li>/g, (match) => {
        // Wrap adjacent list items in ul
        return `<ul>${match}</ul>`;
      })
      .replace(/<\/ul><ul>/g, ''); // Clean duplicate structures
  }

  /** Turn [n] markers in rendered markdown into clickable cite pills. */
  function decorateCitations(html, sources) {
    if (!sources || !sources.length) return html;
    return html.replace(/\[(\d{1,2})\]/g, (match, num) => {
      const n = Number(num);
      const source = sources.find((s) => s.n === n);
      if (!source) return match;
      const title = String(source.title || '').replace(/"/g, '&quot;');
      return `<button class="brain-cite" data-cite="${n}" title="${title}">${n}</button>`;
    });
  }

  /** Remove visible [n] citation markers for compact summary answers. */
  function stripCitationMarkers(text) {
    return String(text || '').replace(/\s*\[(\d{1,2})\]/g, '');
  }

  function normalizeSources(sources, maxSources = 4) {
    const out = [];
    const seen = new Set();
    (sources || []).forEach((source) => {
      if (!source) return;
      const key = `${source.url || ''}|${source.page || ''}|${source.title || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(source);
    });
    return out.slice(0, maxSources);
  }

  /**
   * Append a clickable source rail under an answer bubble and wire cite pills
   * to flash their matching chip into view.
   *
   * @param {HTMLElement} bubble        Element the source rail is appended to.
   * @param {Array}       sources       [{ n, title, url, page }]
   * @param {Object}     [options]
   * @param {HTMLElement} [options.bubbleContent]  Scope for cite-pill lookup
   *                       (defaults to `bubble`).
   * @param {Function}   [options.onScroll]        Called after the rail is
   *                       appended and after a cite pill is clicked, so the
   *                       host can keep its viewport pinned.
   */
  function renderSourceChips(bubble, sources, options = {}) {
    if (!sources || !sources.length) return;
    const { bubbleContent, onScroll, mode = 'rail', maxSources = 4 } = options;
    const shownSources = normalizeSources(sources, maxSources);
    if (!shownSources.length) return;
    const rail = document.createElement(mode === 'disclosure' ? 'details' : 'div');
    rail.className = mode === 'disclosure' ? 'brain-source-disclosure' : 'brain-source-rail';
    if (mode === 'disclosure') {
      const summary = document.createElement('summary');
      summary.textContent = `Sources (${shownSources.length})`;
      rail.appendChild(summary);
    }
    const list = mode === 'disclosure' ? document.createElement('div') : rail;
    if (mode === 'disclosure') {
      list.className = 'brain-source-rail brain-source-rail-compact';
      rail.appendChild(list);
    }
    shownSources.forEach((source) => {
      const chip = document.createElement(source.url ? 'button' : 'span');
      chip.className = 'brain-source-chip' + (source.url ? ' is-link' : '');
      chip.dataset.n = String(source.n);
      const loc = source.page ? ` · p.${source.page}` : '';
      const titleText = document.createElement('span');
      titleText.textContent = source.title || '';
      chip.innerHTML = `<span class="chip-n">${source.n}</span>`;
      chip.appendChild(titleText);
      if (loc) chip.appendChild(document.createTextNode(loc));
      if (source.url) {
        chip.title = source.url;
        chip.addEventListener('click', () => chrome.tabs.create({ url: source.url }));
      }
      list.appendChild(chip);
    });
    bubble.appendChild(rail);

    // Cite pills flash their matching chip into view.
    (bubbleContent || bubble).querySelectorAll('.brain-cite').forEach((pill) => {
      pill.addEventListener('click', () => {
        const chip = rail.querySelector(`.brain-source-chip[data-n="${pill.dataset.cite}"]`);
        if (!chip) return;
        if (mode === 'disclosure') rail.open = true;
        chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        chip.classList.remove('is-flash');
        void chip.offsetWidth;
        chip.classList.add('is-flash');
        if (typeof onScroll === 'function') onScroll();
      });
    });
    if (typeof onScroll === 'function') onScroll();
  }

  window.CanvascopeAnswerRender = {
    parseSimpleMarkdown,
    stripCitationMarkers,
    decorateCitations,
    renderSourceChips
  };
})();
