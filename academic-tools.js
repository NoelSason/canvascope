/**
 * ============================================
 * Canvascope – Academic Tools (academic-tools.js)
 * ============================================
 *
 * PURPOSE:
 * Adds four in-page features that traditional Canvas helpers offer:
 *   1. GPA calculator    — supports college (4.0) and high school (4.3/5.0
 *                          weighted) modes, named "what-if" scenarios,
 *                          and live scrape of current Canvas grades.
 *   2. Grades summary    — one-screen overview of every course's current
 *                          letter + percentage. Backs the dashboard grade
 *                          pills (canvas-skin.js renders the pill itself).
 *   3. Notes             — markdown-lite (bold/italic/lists/checkboxes)
 *                          notes that are indexed as type:'note' so they
 *                          show up in popup + slash search.
 *   4. Custom todos      — light tasks with optional due date + course
 *                          tag + color. Merged into the Up Next pipeline
 *                          via popup.js so they live alongside Canvas work.
 *
 * STORAGE:
 *   chrome.storage.local
 *     - gpaScenarios:        Array<Scenario>
 *     - dashboardNotes:      Array<Note>
 *     - customTodos:         Array<Todo>
 *     - canvasGradesByCourse: Record<courseId, GradeSummary>
 *
 * UI:
 * All UI is rendered into in-page modals (one shared host element so we never
 * leak more than one). The shared host uses an open shadow root so Canvas
 * stylesheets do not bleed in.
 *
 * Slash commands route here via slash-commands-pack.js.
 * ============================================
 */

(function canvascopeAcademicTools() {
  'use strict';

  if (window.__canvascopeAcademicToolsInitialised) return;
  window.__canvascopeAcademicToolsInitialised = true;

  // -------------------------------------------------------------------------
  // STORAGE HELPERS
  // -------------------------------------------------------------------------

  const STORE_GPA   = 'gpaScenarios';
  const STORE_NOTES = 'dashboardNotes';
  const STORE_TODOS = 'customTodos';
  const STORE_GRADES = 'canvasGradesByCourse';

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async function loadArray(key) {
    try {
      const { [key]: v } = await chrome.storage.local.get([key]);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  async function saveArray(key, arr) {
    try { await chrome.storage.local.set({ [key]: Array.isArray(arr) ? arr : [] }); } catch { /* ignore */ }
    try { chrome.runtime.sendMessage({ action: 'csTools.push', key, value: arr }); } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // SHARED MODAL HOST
  // -------------------------------------------------------------------------

  const MODAL_HOST_ID = 'cs-academic-modal-host';

  function ensureModalHost() {
    let host = document.getElementById(MODAL_HOST_ID);
    if (host && host.shadowRoot) return host;
    host = document.createElement('div');
    host.id = MODAL_HOST_ID;
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2147483645';
    host.style.pointerEvents = 'none';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = MODAL_CSS;
    root.appendChild(style);
    const slot = document.createElement('div');
    slot.id = 'slot';
    root.appendChild(slot);
    return host;
  }

  function openModal(renderInner) {
    const host = ensureModalHost();
    host.style.pointerEvents = 'auto';
    const root = host.shadowRoot;
    const slot = root.getElementById('slot');
    slot.innerHTML = '';
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const panel = document.createElement('div');
    panel.className = 'panel';
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
    slot.appendChild(backdrop);
    backdrop.appendChild(panel);
    renderInner(panel, root);
    const onKey = e => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey, true); } };
    document.addEventListener('keydown', onKey, true);
    return { root, panel, close: closeModal };
  }

  function closeModal() {
    const host = document.getElementById(MODAL_HOST_ID);
    if (!host) return;
    host.style.pointerEvents = 'none';
    if (host.shadowRoot) host.shadowRoot.getElementById('slot').innerHTML = '';
  }

  // -------------------------------------------------------------------------
  // GPA CALCULATOR
  // -------------------------------------------------------------------------

  // Letter → GPA point mappings.
  const GPA_SCALES = {
    'college-4.0': {
      label: 'College (4.0)',
      table: { 'A+': 4.0, 'A': 4.0, 'A-': 3.7, 'B+': 3.3, 'B': 3.0, 'B-': 2.7,
               'C+': 2.3, 'C': 2.0, 'C-': 1.7, 'D+': 1.3, 'D': 1.0, 'D-': 0.7, 'F': 0 }
    },
    'hs-4.0': {
      label: 'High School (4.0 Unweighted)',
      table: { 'A+': 4.0, 'A': 4.0, 'A-': 3.7, 'B+': 3.3, 'B': 3.0, 'B-': 2.7,
               'C+': 2.3, 'C': 2.0, 'C-': 1.7, 'D+': 1.3, 'D': 1.0, 'D-': 0.7, 'F': 0 }
    },
    'hs-4.3': {
      label: 'High School (4.3)',
      table: { 'A+': 4.3, 'A': 4.0, 'A-': 3.7, 'B+': 3.3, 'B': 3.0, 'B-': 2.7,
               'C+': 2.3, 'C': 2.0, 'C-': 1.7, 'D+': 1.3, 'D': 1.0, 'D-': 0.7, 'F': 0 }
    },
    'hs-5.0-weighted': {
      label: 'High School (5.0 Weighted)',
      // Weighted bump applied per-course via `weight` field; base same as 4.0.
      table: { 'A+': 4.0, 'A': 4.0, 'A-': 3.7, 'B+': 3.3, 'B': 3.0, 'B-': 2.7,
               'C+': 2.3, 'C': 2.0, 'C-': 1.7, 'D+': 1.3, 'D': 1.0, 'D-': 0.7, 'F': 0 }
    }
  };

  function percentToLetter(pct) {
    if (pct == null || isNaN(pct)) return '';
    const p = Number(pct);
    if (p >= 97) return 'A+'; if (p >= 93) return 'A';  if (p >= 90) return 'A-';
    if (p >= 87) return 'B+'; if (p >= 83) return 'B';  if (p >= 80) return 'B-';
    if (p >= 77) return 'C+'; if (p >= 73) return 'C';  if (p >= 70) return 'C-';
    if (p >= 67) return 'D+'; if (p >= 63) return 'D';  if (p >= 60) return 'D-';
    return 'F';
  }

  function computeGpa(courses, scale, opts) {
    const table = GPA_SCALES[scale]?.table || GPA_SCALES['college-4.0'].table;
    const weightedMode = scale === 'hs-5.0-weighted';
    let pts = 0, units = 0;
    for (const c of courses) {
      if (!c || c.excluded) continue;
      const credits = Number(c.credits || 1);
      if (!isFinite(credits) || credits <= 0) continue;
      const letter = c.letter || percentToLetter(c.percent);
      const base = table[letter];
      if (base == null) continue;
      let earned = base;
      if (weightedMode && c.weight) {
        // Honors +0.5, AP/IB +1.0. Convention varies; expose as numeric.
        earned = Math.min(5.0, base + Number(c.weight));
      }
      pts += earned * credits;
      units += credits;
    }
    return {
      gpa: units > 0 ? +(pts / units).toFixed(3) : 0,
      units,
      scale,
      label: GPA_SCALES[scale]?.label || 'GPA'
    };
  }

  async function fetchLiveCourses() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'csTools.fetchGrades' });
      if (res && res.ok && Array.isArray(res.courses)) return res.courses;
    } catch { /* ignore */ }
    // Fallback: read whatever the background already cached.
    try {
      const { [STORE_GRADES]: cached } = await chrome.storage.local.get([STORE_GRADES]);
      if (cached) {
        return Object.entries(cached).map(([id, g]) => ({
          courseId: id, name: g.name, letter: g.letter,
          percent: g.current, credits: g.credits || 1
        }));
      }
    } catch { /* ignore */ }
    return [];
  }

  async function openGpaCalculator(initialScenarioName) {
    const scenarios = await loadArray(STORE_GPA);
    const liveCourses = await fetchLiveCourses();
    let active = initialScenarioName
      ? scenarios.find(s => s.name === initialScenarioName)
      : null;
    if (!active) {
      active = {
        id: uid('gpa'),
        name: initialScenarioName || 'Live (Current Term)',
        scale: 'college-4.0',
        courses: liveCourses.map(c => ({
          courseId: c.courseId, name: c.name,
          letter: c.letter || percentToLetter(c.percent),
          percent: c.percent, credits: c.credits || 1, weight: 0, excluded: false
        })),
        createdAt: Date.now()
      };
    }

    openModal((panel, root) => {
      panel.innerHTML = '';
      const head = document.createElement('div'); head.className = 'panel__head';
      head.innerHTML = `<h2>GPA Calculator</h2>
        <div class="panel__sub">${escapeHtml(active.name)} · ${GPA_SCALES[active.scale].label}</div>
        <button class="panel__close" data-close>✕</button>`;
      head.querySelector('[data-close]').addEventListener('click', closeModal);
      panel.appendChild(head);

      const body = document.createElement('div'); body.className = 'panel__body gpa-body';
      panel.appendChild(body);

      const scaleRow = document.createElement('div'); scaleRow.className = 'gpa-controls';
      scaleRow.innerHTML = `<label>Scale</label>
        <select data-scale>
          ${Object.keys(GPA_SCALES).map(k =>
            `<option value="${k}" ${k === active.scale ? 'selected' : ''}>${GPA_SCALES[k].label}</option>`
          ).join('')}
        </select>
        <label>Scenario</label>
        <input type="text" data-name value="${escapeHtml(active.name)}"/>
        <button data-save>Save scenario</button>
        ${scenarios.length ? `<select data-load>
          <option value="">Load…</option>
          ${scenarios.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>` : ''}`;
      body.appendChild(scaleRow);

      const table = document.createElement('table'); table.className = 'gpa-table';
      table.innerHTML = `<thead><tr>
          <th>Course</th><th>Letter</th><th>%</th>
          <th>Credits</th><th>Weight</th><th>Excl.</th><th></th>
        </tr></thead><tbody></tbody>`;
      body.appendChild(table);
      const tbody = table.querySelector('tbody');

      function renderRows() {
        tbody.innerHTML = '';
        active.courses.forEach((c, idx) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><input data-f="name" value="${escapeHtml(c.name || '')}"/></td>
            <td><input data-f="letter" value="${escapeHtml(c.letter || '')}" maxlength="2" style="width:50px"/></td>
            <td><input data-f="percent" type="number" value="${c.percent ?? ''}" style="width:60px"/></td>
            <td><input data-f="credits" type="number" step="0.5" value="${c.credits ?? 1}" style="width:60px"/></td>
            <td><input data-f="weight" type="number" step="0.5" value="${c.weight ?? 0}" style="width:60px"/></td>
            <td style="text-align:center"><input data-f="excluded" type="checkbox" ${c.excluded ? 'checked' : ''}/></td>
            <td><button data-remove>✕</button></td>`;
          tr.querySelectorAll('[data-f]').forEach(el => {
            el.addEventListener('input', () => {
              const f = el.getAttribute('data-f');
              c[f] = el.type === 'checkbox' ? el.checked
                   : el.type === 'number'   ? Number(el.value)
                   : el.value;
              if (f === 'percent') c.letter = percentToLetter(c.percent);
              if (f === 'letter')  c.letter = (c.letter || '').toUpperCase();
              renderSummary();
            });
          });
          tr.querySelector('[data-remove]').addEventListener('click', () => {
            active.courses.splice(idx, 1); renderRows(); renderSummary();
          });
          tbody.appendChild(tr);
        });
        const addRow = document.createElement('tr');
        addRow.innerHTML = `<td colspan="7"><button data-add>+ Add course</button></td>`;
        addRow.querySelector('[data-add]').addEventListener('click', () => {
          active.courses.push({ name: 'New course', letter: 'A', percent: null, credits: 1, weight: 0, excluded: false });
          renderRows(); renderSummary();
        });
        tbody.appendChild(addRow);
      }

      const summary = document.createElement('div'); summary.className = 'gpa-summary';
      body.appendChild(summary);

      function renderSummary() {
        const result = computeGpa(active.courses, active.scale);
        summary.innerHTML = `
          <div class="gpa-summary__num">${result.gpa.toFixed(3)}</div>
          <div class="gpa-summary__meta">${result.units} units · ${result.label}</div>
        `;
      }

      scaleRow.querySelector('[data-scale]').addEventListener('change', e => {
        active.scale = e.target.value; head.querySelector('.panel__sub').textContent =
          `${active.name} · ${GPA_SCALES[active.scale].label}`;
        renderSummary();
      });
      scaleRow.querySelector('[data-name]').addEventListener('input', e => {
        active.name = e.target.value || 'Untitled scenario';
        head.querySelector('.panel__sub').textContent =
          `${active.name} · ${GPA_SCALES[active.scale].label}`;
      });
      scaleRow.querySelector('[data-save]').addEventListener('click', async () => {
        active.updatedAt = Date.now();
        const list = await loadArray(STORE_GPA);
        const idx = list.findIndex(s => s.id === active.id);
        if (idx >= 0) list[idx] = active; else list.unshift(active);
        await saveArray(STORE_GPA, list);
        flash(panel, 'Saved scenario');
      });
      const loadSel = scaleRow.querySelector('[data-load]');
      if (loadSel) loadSel.addEventListener('change', () => {
        const id = loadSel.value;
        const found = scenarios.find(s => s.id === id);
        if (found) { active = JSON.parse(JSON.stringify(found)); renderRows(); renderSummary(); }
      });

      renderRows();
      renderSummary();
    });
  }

  function flash(panel, msg) {
    const el = document.createElement('div');
    el.className = 'flash';
    el.textContent = msg;
    panel.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  // -------------------------------------------------------------------------
  // GRADES SUMMARY
  // -------------------------------------------------------------------------

  async function openGradesSummary() {
    const live = await fetchLiveCourses();
    openModal(panel => {
      panel.innerHTML = '';
      const head = document.createElement('div'); head.className = 'panel__head';
      head.innerHTML = `<h2>Grades</h2><div class="panel__sub">Current term · live from Canvas</div>
        <button class="panel__close" data-close>✕</button>`;
      head.querySelector('[data-close]').addEventListener('click', closeModal);
      panel.appendChild(head);

      const body = document.createElement('div'); body.className = 'panel__body';
      panel.appendChild(body);

      if (!live.length) {
        body.innerHTML = `<div class="empty">No grade data yet. Open a course's grades page once and reopen.</div>`;
        return;
      }
      const list = document.createElement('ul'); list.className = 'grades-list';
      live.forEach(c => {
        const li = document.createElement('li');
        const letter = c.letter || percentToLetter(c.percent);
        li.innerHTML = `
          <span class="grades-list__name">${escapeHtml(c.name || c.courseId)}</span>
          <span class="grades-list__letter">${escapeHtml(letter || '—')}</span>
          <span class="grades-list__pct">${c.percent != null ? c.percent + '%' : '—'}</span>
        `;
        if (c.courseId) li.style.cursor = 'pointer';
        li.addEventListener('click', () => {
          if (c.courseId) window.open(`/courses/${c.courseId}/grades`, '_blank');
        });
        list.appendChild(li);
      });
      body.appendChild(list);
    });
  }

  // -------------------------------------------------------------------------
  // NOTES
  // -------------------------------------------------------------------------

  async function quickCaptureNote(text) {
    const t = (text || '').trim();
    if (!t) return null;
    const notes = await loadArray(STORE_NOTES);
    const note = {
      id: uid('note'),
      title: t.split('\n')[0].slice(0, 80),
      body: t,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    notes.unshift(note);
    await saveArray(STORE_NOTES, notes);
    try { chrome.runtime.sendMessage({ action: 'forceScan', reason: 'note-added' }); } catch { /* ignore */ }
    return note;
  }

  async function openNotesBrowser() {
    const notes = await loadArray(STORE_NOTES);
    openModal(panel => {
      panel.innerHTML = '';
      const head = document.createElement('div'); head.className = 'panel__head';
      head.innerHTML = `<h2>Notes</h2><div class="panel__sub">${notes.length} note${notes.length === 1 ? '' : 's'}</div>
        <button class="panel__close" data-close>✕</button>`;
      head.querySelector('[data-close]').addEventListener('click', closeModal);
      panel.appendChild(head);

      const body = document.createElement('div'); body.className = 'panel__body notes-body';
      panel.appendChild(body);

      const composer = document.createElement('div'); composer.className = 'note-composer';
      composer.innerHTML = `
        <textarea data-new placeholder="Quick note… (markdown-lite: **bold** *italic* - list [ ] todo)"></textarea>
        <button data-add>Add note</button>`;
      composer.querySelector('[data-add]').addEventListener('click', async () => {
        const v = composer.querySelector('[data-new]').value.trim();
        if (!v) return;
        await quickCaptureNote(v);
        closeModal();
        openNotesBrowser();
      });
      body.appendChild(composer);

      const list = document.createElement('ul'); list.className = 'notes-list';
      notes.forEach(n => {
        const li = document.createElement('li');
        li.innerHTML = `
          <div class="notes-list__title">${escapeHtml(n.title)}</div>
          <div class="notes-list__body">${renderMarkdownLite(n.body)}</div>
          <div class="notes-list__meta">${new Date(n.updatedAt || n.createdAt).toLocaleString()}</div>
          <button data-del>✕</button>`;
        li.querySelector('[data-del]').addEventListener('click', async (e) => {
          e.stopPropagation();
          const filtered = (await loadArray(STORE_NOTES)).filter(x => x.id !== n.id);
          await saveArray(STORE_NOTES, filtered);
          li.remove();
        });
        list.appendChild(li);
      });
      body.appendChild(list);
    });
  }

  function renderMarkdownLite(src) {
    if (!src) return '';
    let html = escapeHtml(src);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/^- \[ \] (.+)$/gm, '<div class="md-todo">☐ $1</div>');
    html = html.replace(/^- \[x\] (.+)$/gim, '<div class="md-todo done">☑ $1</div>');
    html = html.replace(/^- (.+)$/gm, '<div class="md-li">• $1</div>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  // -------------------------------------------------------------------------
  // CUSTOM TODOS
  // -------------------------------------------------------------------------

  async function addTodo(text, opts) {
    const t = (text || '').trim();
    if (!t) return null;
    const todos = await loadArray(STORE_TODOS);
    const todo = {
      id: uid('todo'),
      title: t,
      dueAt: opts?.dueAt || null,
      courseId: opts?.courseId || null,
      color: opts?.color || null,
      done: false,
      createdAt: Date.now()
    };
    todos.unshift(todo);
    await saveArray(STORE_TODOS, todos);
    return todo;
  }

  async function toggleTodoDone(id) {
    const todos = await loadArray(STORE_TODOS);
    const t = todos.find(x => x.id === id);
    if (!t) return null;
    t.done = !t.done;
    await saveArray(STORE_TODOS, todos);
    return t;
  }

  async function clearTodos() {
    await saveArray(STORE_TODOS, []);
  }

  async function listTodos() {
    return loadArray(STORE_TODOS);
  }

  // -------------------------------------------------------------------------
  // PUBLIC API + UTILS
  // -------------------------------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.CanvascopeAcademicTools = {
    openGpaCalculator,
    openGradesSummary,
    openNotesBrowser,
    quickCaptureNote,
    addTodo,
    toggleTodoDone,
    clearTodos,
    listTodos,
    closeModal,
    computeGpa,
    percentToLetter
  };

  // -------------------------------------------------------------------------
  // STYLES (scoped to shadow DOM)
  // -------------------------------------------------------------------------

  const MODAL_CSS = `
    :host, * { box-sizing: border-box; }
    .backdrop {
      position: absolute; inset: 0;
      background: rgba(10,8,14,0.55);
      backdrop-filter: blur(6px);
      display: flex; align-items: flex-start; justify-content: center;
      padding-top: 8vh;
      font-family: 'Geist', 'Inter', system-ui, sans-serif;
      color: #ece9f1;
    }
    .panel {
      width: min(720px, calc(100vw - 32px));
      max-height: 84vh;
      overflow: auto;
      background: #1c1b22;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 14px;
      box-shadow: 0 32px 80px rgba(0,0,0,0.55);
      position: relative;
    }
    .panel__head {
      padding: 18px 22px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      position: relative;
    }
    .panel__head h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
    .panel__sub { font-size: 12px; color: #b6b0c2; margin-top: 4px; }
    .panel__close {
      position: absolute; top: 14px; right: 14px;
      width: 28px; height: 28px; border-radius: 6px;
      background: rgba(255,255,255,0.05); color: #b6b0c2;
      border: 1px solid rgba(255,255,255,0.06);
      cursor: pointer; font-size: 13px;
    }
    .panel__body { padding: 16px 22px 22px; }
    .empty { color: #7c7689; padding: 24px 0; text-align: center; }
    .flash {
      position: absolute; bottom: 14px; right: 14px;
      background: #a890e8; color: #1c1b22;
      padding: 6px 12px; border-radius: 6px;
      font-size: 12px; font-weight: 600;
    }

    /* GPA */
    .gpa-controls {
      display: grid;
      grid-template-columns: auto 1fr auto 2fr auto auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 14px;
    }
    .gpa-controls label { font-size: 11px; color: #b6b0c2; text-transform: uppercase; letter-spacing: 0.04em; }
    .gpa-controls select, .gpa-controls input, .gpa-controls button {
      background: #272731; color: #ece9f1; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px; padding: 6px 10px; font: inherit;
    }
    .gpa-controls button { background: #a890e8; color: #1c1b22; cursor: pointer; font-weight: 600; }
    .gpa-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .gpa-table th { text-align: left; color: #b6b0c2; font-weight: 500; padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .gpa-table td { padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.03); }
    .gpa-table input {
      background: #20202a; color: #ece9f1; border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px; padding: 4px 6px; font: inherit; width: 100%;
    }
    .gpa-table button {
      background: transparent; color: #7c7689; border: none; cursor: pointer; font-size: 14px;
    }
    .gpa-table button:hover { color: #e88a8a; }
    .gpa-summary {
      margin-top: 18px;
      display: flex; align-items: baseline; gap: 14px;
      padding: 14px 18px;
      background: #22212a; border-radius: 10px;
      border: 1px solid rgba(168,144,232,0.20);
    }
    .gpa-summary__num { font-size: 36px; font-weight: 700; color: #a890e8; font-variant-numeric: tabular-nums; }
    .gpa-summary__meta { font-size: 12px; color: #b6b0c2; }

    /* Grades */
    .grades-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .grades-list li {
      display: grid; grid-template-columns: 1fr 60px 80px;
      gap: 12px; align-items: center;
      padding: 10px 12px;
      background: #22212a; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.04);
    }
    .grades-list li:hover { background: #272731; border-color: rgba(168,144,232,0.15); }
    .grades-list__letter { color: #a890e8; font-weight: 600; text-align: center; }
    .grades-list__pct { text-align: right; color: #b6b0c2; font-variant-numeric: tabular-nums; }

    /* Notes */
    .note-composer { margin-bottom: 14px; display: flex; flex-direction: column; gap: 8px; }
    .note-composer textarea {
      min-height: 80px;
      background: #20202a; color: #ece9f1; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px; padding: 10px; font: inherit;
      resize: vertical;
    }
    .note-composer button {
      align-self: flex-end;
      background: #a890e8; color: #1c1b22; border: none;
      border-radius: 6px; padding: 6px 14px; cursor: pointer; font-weight: 600;
    }
    .notes-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .notes-list li {
      position: relative;
      background: #22212a; border-radius: 8px;
      padding: 10px 36px 10px 12px;
      border: 1px solid rgba(255,255,255,0.04);
    }
    .notes-list__title { font-weight: 600; color: #ece9f1; }
    .notes-list__body  { font-size: 12px; color: #b6b0c2; margin: 4px 0; line-height: 1.5; }
    .notes-list__meta  { font-size: 10px; color: #7c7689; }
    .notes-list li button {
      position: absolute; top: 8px; right: 8px;
      background: transparent; color: #7c7689; border: none; cursor: pointer; font-size: 13px;
    }
    .notes-list li button:hover { color: #e88a8a; }
    .md-todo { font-size: 12px; color: #ece9f1; }
    .md-todo.done { color: #7c7689; text-decoration: line-through; }
    .md-li { font-size: 12px; }
  `;

  console.log('[Canvascope Academic] academic-tools.js loaded.');
})();
