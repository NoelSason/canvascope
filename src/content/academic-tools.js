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
    let ok = false;
    try {
      await chrome.storage.local.set({ [key]: Array.isArray(arr) ? arr : [] });
      ok = true;
    } catch (e) {
      // Common cause: the content script was detached after an extension reload,
      // which severs chrome.* until the page is refreshed. Surface it so callers
      // can warn the user instead of silently "succeeding".
      console.warn('[Canvascope Academic] Storage write failed for', key, e);
    }
    try { chrome.runtime.sendMessage({ action: 'csTools.push', key, value: arr }); } catch { /* ignore */ }
    return ok;
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

  // Match the modal to the page it overlays. We sample the actual page background
  // luminance (covers native-light Canvas, native-dark Canvas, and Canvascope's own
  // dark skin), falling back to the OS color-scheme preference.
  function parseRgb(value) {
    const m = String(value || '').match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function detectModalTheme() {
    try {
      const sources = [document.body, document.documentElement];
      for (const el of sources) {
        if (!el) continue;
        const c = parseRgb(getComputedStyle(el).backgroundColor);
        if (!c || c.a < 0.5) continue;
        // Perceived luminance (0–255).
        const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        return lum >= 150 ? 'light' : 'dark';
      }
    } catch (_) {}
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (_) {}
    return 'dark';
  }

  function openModal(renderInner) {
    const host = ensureModalHost();
    host.setAttribute('data-theme', detectModalTheme());
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
    if (typeof window.__canvascopeModalCleanup === 'function') {
      try { window.__canvascopeModalCleanup(); } catch (e) {}
      window.__canvascopeModalCleanup = null;
    }
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
    const ok = await saveArray(STORE_TODOS, todos);
    return ok ? todo : null;
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

  // -------------------------------------------------------------------------
  // ZEN FOCUS SPACE AUDIO SYNTHESIS & TIMER SYSTEM
  // -------------------------------------------------------------------------

  let zenAudioCtx = null;
  let zenBrownNoiseSource = null;
  let zenBrownNoiseGain = null;
  let zenBinauralOscL = null;
  let zenBinauralOscR = null;
  let zenBinauralGainL = null;
  let zenBinauralGainR = null;
  let zenMasterGain = null;

  function initZenAudio() {
    if (zenAudioCtx) return;
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    zenAudioCtx = new AudioCtxClass();
    zenMasterGain = zenAudioCtx.createGain();
    zenMasterGain.gain.value = 0.5; // default 50% volume
    zenMasterGain.connect(zenAudioCtx.destination);
  }

  function startBrownNoise() {
    initZenAudio();
    if (zenBrownNoiseSource) return;

    if (zenAudioCtx.state === 'suspended') {
      zenAudioCtx.resume();
    }

    const bufferSize = 2 * zenAudioCtx.sampleRate;
    const noiseBuffer = zenAudioCtx.createBuffer(1, bufferSize, zenAudioCtx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      output[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = output[i];
      output[i] *= 3.5; // Gain compensation
    }

    zenBrownNoiseSource = zenAudioCtx.createBufferSource();
    zenBrownNoiseSource.buffer = noiseBuffer;
    zenBrownNoiseSource.loop = true;

    zenBrownNoiseGain = zenAudioCtx.createGain();
    zenBrownNoiseGain.gain.value = 0.6; // soundscape balance

    zenBrownNoiseSource.connect(zenBrownNoiseGain).connect(zenMasterGain);
    zenBrownNoiseSource.start(0);
  }

  function stopBrownNoise() {
    if (zenBrownNoiseSource) {
      try { zenBrownNoiseSource.stop(); } catch(e) {}
      zenBrownNoiseSource.disconnect();
      zenBrownNoiseSource = null;
    }
    if (zenBrownNoiseGain) {
      zenBrownNoiseGain.disconnect();
      zenBrownNoiseGain = null;
    }
  }

  function startBinauralBeats(carrierFreq = 200, beatFreq = 10) {
    initZenAudio();
    if (zenBinauralOscL) return;

    if (zenAudioCtx.state === 'suspended') {
      zenAudioCtx.resume();
    }

    zenBinauralOscL = zenAudioCtx.createOscillator();
    zenBinauralOscR = zenAudioCtx.createOscillator();
    
    zenBinauralOscL.frequency.value = carrierFreq;
    zenBinauralOscR.frequency.value = carrierFreq + beatFreq;

    zenBinauralGainL = zenAudioCtx.createGain();
    zenBinauralGainR = zenAudioCtx.createGain();
    zenBinauralGainL.gain.value = 0.12; 
    zenBinauralGainR.gain.value = 0.12;

    const pannerL = zenAudioCtx.createStereoPanner ? zenAudioCtx.createStereoPanner() : null;
    const pannerR = zenAudioCtx.createStereoPanner ? zenAudioCtx.createStereoPanner() : null;

    if (pannerL && pannerR) {
      pannerL.pan.value = -1.0;
      pannerR.pan.value = 1.0;
      zenBinauralOscL.connect(zenBinauralGainL).connect(pannerL).connect(zenMasterGain);
      zenBinauralOscR.connect(zenBinauralGainR).connect(pannerR).connect(zenMasterGain);
    } else {
      zenBinauralOscL.connect(zenBinauralGainL).connect(zenMasterGain);
      zenBinauralOscR.connect(zenBinauralGainR).connect(zenMasterGain);
    }

    zenBinauralOscL.start(0);
    zenBinauralOscR.start(0);
  }

  function stopBinauralBeats() {
    if (zenBinauralOscL) {
      try { zenBinauralOscL.stop(); } catch(e) {}
      zenBinauralOscL.disconnect();
      zenBinauralOscL = null;
    }
    if (zenBinauralOscR) {
      try { zenBinauralOscR.stop(); } catch(e) {}
      zenBinauralOscR.disconnect();
      zenBinauralOscR = null;
    }
    if (zenBinauralGainL) {
      zenBinauralGainL.disconnect();
      zenBinauralGainL = null;
    }
    if (zenBinauralGainR) {
      zenBinauralGainR.disconnect();
      zenBinauralGainR = null;
    }
  }

  function stopAllZenAudio() {
    stopBrownNoise();
    stopBinauralBeats();
    if (zenAudioCtx) {
      try {
        zenAudioCtx.close();
      } catch(e) {}
      zenAudioCtx = null;
    }
  }

  let zenTimeLeft = 25 * 60;
  let zenDuration = 25 * 60;
  let zenTimerInterval = null;
  let zenTimerIsRunning = false;
  let zenActiveMode = 'work'; // 'work' | 'break'
  let zenCurrentTask = '';

  function closeZenSpace() {
    if (zenTimerInterval) {
      clearInterval(zenTimerInterval);
      zenTimerInterval = null;
    }
    zenTimerIsRunning = false;
    stopAllZenAudio();
    closeModal();
  }

  async function openZenSpace() {
    zenTimeLeft = 25 * 60;
    zenDuration = 25 * 60;
    zenTimerIsRunning = false;
    zenActiveMode = 'work';
    zenCurrentTask = '';
    
    window.__canvascopeModalCleanup = () => {
      if (zenTimerInterval) {
        clearInterval(zenTimerInterval);
        zenTimerInterval = null;
      }
      stopAllZenAudio();
    };

    const todos = await loadArray(STORE_TODOS);
    
    openModal((panel, root) => {
      panel.classList.add('panel--zen');
      
      panel.innerHTML = `
        <button class="zen-close-btn" data-close-zen>✕ Exit Focus Mode</button>
        <div class="zen-grid">
          
          <div class="zen-left">
            <h3 class="zen-sec-title">⟫ Current Goal</h3>
            <div class="zen-task-picker">
              <select data-zen-task-select>
                <option value="">Select active task…</option>
                ${todos.filter(t => !t.done).map(t => `<option value="${escapeHtml(t.title)}">${escapeHtml(t.title)}</option>`).join('')}
                <option value="custom">+ Type custom task…</option>
              </select>
              <input type="text" data-zen-custom-task placeholder="Enter focus goal…" style="display:none" />
            </div>
            
            <h3 class="zen-sec-title" style="margin-top:24px">⟫ Up Next</h3>
            <ul class="zen-todo-list">
              ${todos.length ? todos.slice(0, 5).map(t => `
                <li data-id="${t.id}" class="${t.done ? 'done' : ''}">
                  <input type="checkbox" ${t.done ? 'checked' : ''} />
                  <span>${escapeHtml(t.title)}</span>
                </li>
              `).join('') : '<li class="zen-todo-empty">No tasks in planner</li>'}
            </ul>
          </div>
          
          <div class="zen-center">
            <div class="zen-ring-container">
              <svg class="zen-ring" viewBox="0 0 200 200">
                <circle class="zen-ring-bg" cx="100" cy="100" r="88" />
                <circle class="zen-ring-fg" cx="100" cy="100" r="88" />
              </svg>
              <div class="zen-timer-digital">
                <div class="zen-time" data-zen-time>25:00</div>
                <div class="zen-mode-badge" data-zen-mode-label>WORK SESSION</div>
              </div>
            </div>
            
            <div class="zen-timer-controls">
              <button class="zen-btn-control btn-play" data-zen-play>Play</button>
              <button class="zen-btn-control btn-reset" data-zen-reset>Reset</button>
            </div>
            
            <div class="zen-timer-presets">
              <button data-zen-preset="1500" class="active">25m Work</button>
              <button data-zen-preset="2700">45m Deep</button>
              <button data-zen-preset="300">5m break</button>
              <button data-zen-preset="900">15m break</button>
            </div>
          </div>
          
          <div class="zen-right">
            <h3 class="zen-sec-title">⟫ Focus Soundscape</h3>
            <div class="zen-sound-controls">
              <button class="zen-sound-btn active" data-sound="none">
                None
              </button>
              <button class="zen-sound-btn" data-sound="brown-noise">
                Brown Noise
              </button>
              <button class="zen-sound-btn" data-sound="binaural">
                Binaural Beats
              </button>
            </div>
            
            <div class="zen-volume-container">
              <div class="zen-volume-header">
                <span>Volume</span>
                <span data-volume-label>50%</span>
              </div>
              <input type="range" class="zen-volume-slider" min="0" max="100" value="50" data-volume-slider />
            </div>

            <div class="zen-stress-tip">
              <strong>Tip:</strong> If feeling overwhelmed, pause the timer. The circular guide will help anchor your breathing: Inhale as it expands, exhale as it contracts.
            </div>
          </div>
        </div>
      `;

      const closeBtn = panel.querySelector('[data-close-zen]');
      const playBtn = panel.querySelector('[data-zen-play]');
      const resetBtn = panel.querySelector('[data-zen-reset]');
      const timeDisplay = panel.querySelector('[data-zen-time]');
      const modeLabel = panel.querySelector('[data-zen-mode-label]');
      const presetBtns = panel.querySelectorAll('[data-zen-preset]');
      const soundBtns = panel.querySelectorAll('[data-sound]');
      const volumeSlider = panel.querySelector('[data-volume-slider]');
      const volumeLabel = panel.querySelector('[data-volume-label]');
      const taskSelect = panel.querySelector('[data-zen-task-select]');
      const customTaskInput = panel.querySelector('[data-zen-custom-task]');
      const ringFg = panel.querySelector('.zen-ring-fg');
      const ringContainer = panel.querySelector('.zen-ring-container');
      const todoItems = panel.querySelectorAll('.zen-todo-list li');

      closeBtn.addEventListener('click', closeZenSpace);

      const radius = 88;
      const circumference = 2 * Math.PI * radius;
      ringFg.style.strokeDasharray = `${circumference} ${circumference}`;
      ringFg.style.strokeDashoffset = 0;

      function updateTimerDisplay() {
        const mins = Math.floor(zenTimeLeft / 60);
        const secs = zenTimeLeft % 60;
        timeDisplay.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        
        const progress = (zenDuration - zenTimeLeft) / zenDuration;
        const offset = progress * circumference;
        ringFg.style.strokeDashoffset = offset;
        
        if (!zenTimerIsRunning) {
          ringContainer.classList.add('breathing');
        } else {
          ringContainer.classList.remove('breathing');
        }
      }

      function tick() {
        if (zenTimeLeft > 0) {
          zenTimeLeft--;
          updateTimerDisplay();
        } else {
          clearInterval(zenTimerInterval);
          zenTimerInterval = null;
          zenTimerIsRunning = false;
          playBtn.textContent = 'Play';
          
          if (zenActiveMode === 'work') {
            zenActiveMode = 'break';
            zenTimeLeft = 5 * 60;
            zenDuration = 5 * 60;
            modeLabel.textContent = 'REST BREAK';
            modeLabel.classList.add('break');
            flash(panel, 'Session completed! Take a break.');
          } else {
            zenActiveMode = 'work';
            zenTimeLeft = 25 * 60;
            zenDuration = 25 * 60;
            modeLabel.textContent = 'WORK SESSION';
            modeLabel.classList.remove('break');
            flash(panel, 'Break over! Let\'s focus.');
          }
          
          presetBtns.forEach(btn => {
            const d = Number(btn.getAttribute('data-zen-preset'));
            if (d === zenTimeLeft) btn.classList.add('active');
            else btn.classList.remove('active');
          });

          updateTimerDisplay();
        }
      }

      playBtn.addEventListener('click', () => {
        if (zenTimerIsRunning) {
          clearInterval(zenTimerInterval);
          zenTimerInterval = null;
          zenTimerIsRunning = false;
          playBtn.textContent = 'Play';
          ringContainer.classList.add('breathing');
        } else {
          zenTimerIsRunning = true;
          playBtn.textContent = 'Pause';
          ringContainer.classList.remove('breathing');
          zenTimerInterval = setInterval(tick, 1000);
          if (zenAudioCtx && zenAudioCtx.state === 'suspended') {
            zenAudioCtx.resume();
          }
        }
      });

      resetBtn.addEventListener('click', () => {
        clearInterval(zenTimerInterval);
        zenTimerInterval = null;
        zenTimerIsRunning = false;
        playBtn.textContent = 'Play';
        zenTimeLeft = zenDuration;
        updateTimerDisplay();
      });

      presetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          clearInterval(zenTimerInterval);
          zenTimerInterval = null;
          zenTimerIsRunning = false;
          playBtn.textContent = 'Play';
          
          const sec = Number(btn.getAttribute('data-zen-preset'));
          zenTimeLeft = sec;
          zenDuration = sec;
          
          if (sec === 300 || sec === 900) {
            zenActiveMode = 'break';
            modeLabel.textContent = 'REST BREAK';
            modeLabel.classList.add('break');
          } else {
            zenActiveMode = 'work';
            modeLabel.textContent = 'WORK SESSION';
            modeLabel.classList.remove('break');
          }

          presetBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          updateTimerDisplay();
        });
      });

      soundBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          soundBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          
          const type = btn.getAttribute('data-sound');
          stopBrownNoise();
          stopBinauralBeats();

          if (type === 'brown-noise') {
            startBrownNoise();
          } else if (type === 'binaural') {
            startBinauralBeats();
          }
        });
      });

      volumeSlider.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        volumeLabel.textContent = `${val}%`;
        if (zenMasterGain) {
          zenMasterGain.gain.value = val / 100;
        }
      });

      taskSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === 'custom') {
          customTaskInput.style.display = 'block';
          customTaskInput.focus();
        } else {
          customTaskInput.style.display = 'none';
          if (val) {
            flash(panel, `Goal set: ${val}`);
          }
        }
      });

      customTaskInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const val = customTaskInput.value.trim();
          if (val) {
            flash(panel, `Goal set: ${val}`);
            const newOpt = document.createElement('option');
            newOpt.value = val;
            newOpt.textContent = val;
            newOpt.selected = true;
            taskSelect.insertBefore(newOpt, taskSelect.lastElementChild);
            customTaskInput.style.display = 'none';
          }
        }
      });

      todoItems.forEach(item => {
        const chk = item.querySelector('input[type="checkbox"]');
        const id = item.getAttribute('data-id');
        chk.addEventListener('change', async () => {
          await toggleTodoDone(id);
          if (chk.checked) {
            item.classList.add('done');
            flash(panel, 'Task marked completed ✓');
          } else {
            item.classList.remove('done');
          }
        });
      });

      updateTimerDisplay();
    });
  }

  // Pull readable syllabus text from an HTML page — many courses use a Canvas
  // "Syllabus" tab, a course home/front page, or a wiki page as the syllabus
  // instead of a PDF. Prefer the main user-content container; cap for the prompt.
  function extractSyllabusPageText() {
    const selectors = [
      '#course_syllabus',
      '.syllabus_course_summary',
      '#wiki_page_show .user_content',
      '#content .user_content',
      '.show-content.user_content',
      '.user_content',
      '#content',
      'main'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = el ? String(el.innerText || '').replace(/\n{3,}/g, '\n\n').trim() : '';
      if (text && text.length > 60) return text.slice(0, 15000);
    }
    const bodyText = String((document.body && document.body.innerText) || '').trim();
    return bodyText.slice(0, 15000);
  }

  async function openSyllabusAutopilot(pdfUrl) {
    if (!pdfUrl) {
      // Look for PDF urls on the active page
      try {
        const tabData = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'collectPdfCandidates' }, (response) => {
            resolve(response);
          });
        });
        pdfUrl = tabData?.candidates?.[0]?.url || tabData?.pageUrl;
      } catch (_) {}
    }

    // Canvas file-preview pages (/courses/.../files/<id>) return HTML, not PDF bytes,
    // so parsing them fails. Canonicalize any Canvas file URL to the /files/<id>/download
    // endpoint, which serves the actual PDF and matches the auto-index cache key.
    if (pdfUrl) {
      const m = pdfUrl.match(/\/files\/(\d+)/);
      if (m && !/\/files\/\d+\/download/.test(pdfUrl)) {
        try {
          const origin = new URL(pdfUrl).origin;
          pdfUrl = `${origin}/files/${m[1]}/download?download_frd=1`;
        } catch (_) {}
      }
    }

    openModal(async (panel, root) => {
      panel.innerHTML = '';
      
      const head = document.createElement('div');
      head.className = 'panel__head';
      head.innerHTML = `
        <h2>Syllabus Autopilot</h2>
        <div class="panel__sub">Extract course schedules and sync to Google Calendar</div>
        <button class="panel__close" data-close>✕</button>
      `;
      head.querySelector('[data-close]').addEventListener('click', closeModal);
      panel.appendChild(head);

      const body = document.createElement('div');
      body.className = 'panel__body';
      panel.appendChild(body);

      // Loading state UI
      const loader = document.createElement('div');
      loader.className = 'autopilot-loading';
      loader.innerHTML = `
        <div class="autopilot-spinner"></div>
        <div class="autopilot-loading-text" data-loading-text>Step 1 of 3: Parsing syllabus PDF...</div>
        <div class="autopilot-loading-sub">This runs 100% locally and may take a moment for scanned documents.</div>
      `;
      body.appendChild(loader);

      const loadingText = loader.querySelector('[data-loading-text]');

      try {
        const looksLikePdf = !!pdfUrl && (pdfUrl.endsWith('.pdf') || /\/files\/\d+/.test(pdfUrl) || pdfUrl.includes('/download'));

        let pages;
        if (looksLikePdf) {
          // 1a. PDF syllabus: parse in the background (DocumentParser is injected into
          // the tab there; it is not available in this content-script world).
          // Send the same title/course hints the auto-index path sends, so a file
          // parsed here and a file parsed by maybeAutoIndexPdf resolve to one
          // documentId instead of two. resolveCourseNameHint lives in content.js,
          // which shares this isolated world and loads first; guard anyway.
          const courseNameHint = (typeof resolveCourseNameHint === 'function')
            ? resolveCourseNameHint()
            : null;
          const fileIdMatch = String(pdfUrl || '').match(/\/files\/(\d+)/);
          const titleHint = (fileIdMatch && typeof fileTitleHintForId === 'function')
            ? fileTitleHintForId(fileIdMatch[1])
            : null;
          const parseResp = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              action: 'parsePdfText',
              pdfUrl,
              titleHint: titleHint || null,
              courseName: courseNameHint || null
            }, (r) => resolve(r || { success: false }));
          });
          if (!parseResp.success || !Array.isArray(parseResp.pages) || parseResp.pages.length === 0) {
            throw new Error('Could not parse any text from the PDF syllabus.' + (parseResp.error ? ` (${parseResp.error})` : ''));
          }
          pages = parseResp.pages;
        } else {
          // 1b. HTML syllabus: a Canvas "Syllabus" tab or a course home/front page used
          // as the syllabus. Read the page's own text directly (we have DOM access here).
          loadingText.textContent = 'Step 1 of 3: Reading syllabus page...';
          const pageText = extractSyllabusPageText();
          if (!pageText || pageText.length < 40) {
            throw new Error('No syllabus content found. Open a syllabus PDF, or your Canvas Syllabus / course home page, and try again.');
          }
          pages = [pageText];
        }

        loadingText.textContent = 'Step 2 of 3: Analyzing schedule with AI...';

        // Combine pages and limit context length
        const rawText = pages.join('\n').trim();
        const docTextSample = rawText.substring(0, 15000);

        // 2. Prompt Cloud AI proxy via message
        const prompt = `Analyze this syllabus text and extract all assignments, homeworks, exams, projects, and due dates.
Return ONLY a valid JSON array of objects. Do not write any markdown blocks (like \`\`\`json) or extra explanations. The response must be a single array of objects matching this exact format:
[
  {"title": "Homework 1: Intro to Python", "dueAt": "2026-09-12T23:59:00Z", "course": "General"},
  {"title": "Midterm Exam", "dueAt": "2026-10-15T10:00:00Z", "course": "General"}
]
Text:
${docTextSample}`;

        const aiResponse = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'promptSyllabusAI',
            prompt: prompt
          }, (response) => resolve(response || { success: false, error: 'no_response' }));
        });

        if (!aiResponse.success) {
          throw new Error(aiResponse.message || 'AI parsing request failed.');
        }

        loadingText.textContent = 'Step 3 of 3: Compiling schedule list...';

        // Clean fences/prose, then parse tolerantly. The model can truncate the final
        // object (token limit) or add stray text, so fall back to extracting whatever
        // complete {...} objects exist (string-aware so braces inside values are safe).
        let cleanText = String(aiResponse.text || '').trim();
        cleanText = cleanText.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '').trim();
        const fb = cleanText.indexOf('[');
        if (fb > 0) cleanText = cleanText.slice(fb);

        const extractObjects = (s) => {
          const items = [];
          let depth = 0, start = -1, inStr = false, esc = false;
          for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
              if (esc) esc = false;
              else if (c === '\\') esc = true;
              else if (c === '"') inStr = false;
              continue;
            }
            if (c === '"') { inStr = true; continue; }
            if (c === '{') { if (depth === 0) start = i; depth++; }
            else if (c === '}') {
              depth--;
              if (depth === 0 && start !== -1) {
                try { items.push(JSON.parse(s.slice(start, i + 1))); } catch (_) {}
                start = -1;
              }
            }
          }
          return items;
        };

        let scheduleItems = [];
        try {
          const lb = cleanText.lastIndexOf(']');
          scheduleItems = JSON.parse(lb > 0 ? cleanText.slice(0, lb + 1) : cleanText);
        } catch (_) {
          scheduleItems = extractObjects(cleanText);
        }
        if (!Array.isArray(scheduleItems)) scheduleItems = [];
        if (scheduleItems.length === 0) {
          console.warn('[Canvascope Autopilot] No items parsed. Raw AI text:', aiResponse.text);
          throw new Error('Failed to parse the structured schedule JSON from AI.');
        }

        if (!Array.isArray(scheduleItems) || scheduleItems.length === 0) {
          throw new Error('No assignments or key deadlines were found in the syllabus.');
        }

        // Render schedule items checklist
        body.removeChild(loader);

        const listContainer = document.createElement('div');
        listContainer.className = 'autopilot-list-container';
        listContainer.innerHTML = `
          <div class="autopilot-meta-row">
            <span class="autopilot-count">${scheduleItems.length}</span>
            <span>deadlines found — pick the ones to add</span>
          </div>
          <ul class="autopilot-list">
            ${scheduleItems.map((item, idx) => {
              const dateVal = item.dueAt ? item.dueAt.substring(0, 16) : '';
              return `
                <li class="autopilot-item" data-idx="${idx}">
                  <input type="checkbox" checked data-chk />
                  <div class="autopilot-item-fields">
                    <input type="text" class="autopilot-input-title" value="${escapeHtml(item.title)}" data-title placeholder="Task title" />
                    <input type="datetime-local" class="autopilot-input-date" value="${dateVal}" data-date />
                  </div>
                </li>
              `;
            }).join('')}
          </ul>
          <div class="autopilot-footer">
            <label class="autopilot-sync-gcal-label">
              <input type="checkbox" checked data-gcal-sync />
              <span>Sync to my Google Calendar</span>
            </label>
            <button class="autopilot-btn-submit" data-submit-autopilot>Save and Schedule</button>
          </div>
        `;
        body.appendChild(listContainer);

        const submitBtn = listContainer.querySelector('[data-submit-autopilot]');
        submitBtn.addEventListener('click', async () => {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Scheduling...';

          const rows = listContainer.querySelectorAll('.autopilot-item');
          const syncGoogle = listContainer.querySelector('[data-gcal-sync]').checked;

          let countSaved = 0;
          let countCalendar = 0;

          let courseNameVal = 'General';
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.title) {
              const parts = tab.title.split(':');
              if (parts.length > 0) courseNameVal = parts[0].trim();
            }
          } catch (_) {}

          for (const row of rows) {
            const checked = row.querySelector('[data-chk]').checked;
            if (!checked) continue;

            const title = row.querySelector('[data-title]').value.trim();
            const dateStr = row.querySelector('[data-date]').value;
            const dueAt = dateStr ? new Date(dateStr).toISOString() : null;

            if (!title) continue;

            // 1. Add to customTodos
            await addTodo(title, { dueAt, color: '#b297ff', courseId: courseNameVal });
            countSaved++;

            // 2. Add to Google Calendar if requested
            if (syncGoogle && dueAt) {
              const startDateTime = dueAt;
              const endDateTime = new Date(new Date(dueAt).getTime() + 30 * 60 * 1000).toISOString();
              
              const gcalRes = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                  type: 'createGoogleCalendarEvent',
                  event: {
                    summary: title,
                    description: `Course deadline for ${courseNameVal} - synced via Canvascope Syllabus Autopilot`,
                    start: { dateTime: startDateTime },
                    end: { dateTime: endDateTime }
                  }
                }, (response) => resolve(response || { success: false }));
              });
              if (gcalRes.success) {
                countCalendar++;
              }
            }
          }

          try { chrome.runtime.sendMessage({ action: 'forceScan', reason: 'autopilot-sync' }); } catch (_) {}

          closeModal();
          
          const calendarMsg = syncGoogle ? ` (${countCalendar} sent to Google Calendar)` : '';
          const successToast = document.createElement('div');
          successToast.style.cssText = `
            position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
            z-index: 2147483647; padding: 12px 20px; border-radius: 8px;
            background: #101b16; color: #6fce9a; border: 1px solid rgba(111, 206, 154, 0.45);
            font: 600 13px var(--cs-tool-font), system-ui;
            box-shadow: 0 16px 42px rgba(0,0,0,0.45);
          `;
          successToast.textContent = `Autopilot synced: ${countSaved} tasks added${calendarMsg} ✓`;
          document.body.appendChild(successToast);
          setTimeout(() => successToast.remove(), 4000);
        });

      } catch (err) {
        body.innerHTML = `
          <div class="autopilot-error">
            <div class="autopilot-error-title">Autopilot Parsing Failed</div>
            <div class="autopilot-error-body">${escapeHtml(err.message)}</div>
            <button class="autopilot-error-close" data-err-close>Close</button>
          </div>
        `;
        body.querySelector('[data-err-close]').addEventListener('click', closeModal);
      }
    });
  }

  // -------------------------------------------------------------------------
  // SYLLABUS AUTOPILOT — PROACTIVE PROMPT
  // -------------------------------------------------------------------------
  // A small floating card shown by content.js when it detects a syllabus page.
  // Accepting opens the existing autopilot modal; either action is remembered so
  // the same syllabus is never prompted again.

  const SYLLABUS_PROMPT_ID = 'cs-syllabus-autopilot-prompt';
  const SYLLABUS_PROMPT_STYLE_ID = 'cs-syllabus-autopilot-prompt-style';
  const SYLLABUS_DISMISS_STORE = 'syllabusAutopilotDismissals';
  let syllabusPromptCard = null;

  function removeSyllabusAutopilotPrompt() {
    if (syllabusPromptCard) {
      try { syllabusPromptCard.remove(); } catch (_) {}
      syllabusPromptCard = null;
    }
    const stray = document.getElementById(SYLLABUS_PROMPT_ID);
    if (stray) { try { stray.remove(); } catch (_) {} }
  }

  async function rememberSyllabusChoice(key) {
    if (!key) return;
    try {
      const { [SYLLABUS_DISMISS_STORE]: existing } = await chrome.storage.local.get([SYLLABUS_DISMISS_STORE]);
      const map = (existing && typeof existing === 'object') ? existing : {};
      map[key] = Date.now();
      await chrome.storage.local.set({ [SYLLABUS_DISMISS_STORE]: map });
    } catch (_) { /* storage may be unavailable right after a reload */ }
  }

  function ensureSyllabusPromptStyle() {
    if (document.getElementById(SYLLABUS_PROMPT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SYLLABUS_PROMPT_STYLE_ID;
    style.textContent = `
      #${SYLLABUS_PROMPT_ID} {
        /* Dark by default; light values applied via [data-theme="light"]. */
        --csp-bg: #0c0f17; --csp-border: #232837; --csp-border-2: #32384a;
        --csp-text: #f3f5fb; --csp-text-2: #aeb4c4; --csp-hover: #181c28;
        --csp-accent: #b297ff; --csp-on-accent: #100a22;
        --csp-shadow: 0 22px 60px rgba(0,0,0,0.55);
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
        width: 326px; max-width: calc(100vw - 40px); padding: 16px 16px 14px;
        border-radius: 16px; background: var(--csp-bg);
        border: 1px solid var(--csp-border);
        color: var(--csp-text); box-shadow: var(--csp-shadow);
        font: 13px/1.5 'Geist', system-ui, -apple-system, "Segoe UI", sans-serif;
        animation: csSyllabusPromptIn 0.26s cubic-bezier(0.16, 1, 0.3, 1);
        overflow: hidden;
      }
      #${SYLLABUS_PROMPT_ID}[data-theme="light"] {
        --csp-bg: #ffffff; --csp-border: #e4e6ef; --csp-border-2: #d2d5e1;
        --csp-text: #1a1c26; --csp-text-2: #595e6e; --csp-hover: #eef0f6;
        --csp-accent: #7c5cff; --csp-on-accent: #ffffff;
        --csp-shadow: 0 20px 52px rgba(40, 36, 80, 0.20);
      }
      #${SYLLABUS_PROMPT_ID}::before {
        content: ''; position: absolute; inset: 0 0 auto 0; height: 3px;
        background: linear-gradient(90deg, var(--csp-accent), transparent);
      }
      @keyframes csSyllabusPromptIn {
        from { opacity: 0; transform: translateY(12px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      #${SYLLABUS_PROMPT_ID} .cs-syl-head { display: flex; align-items: center; gap: 9px; margin-bottom: 6px; }
      #${SYLLABUS_PROMPT_ID} .cs-syl-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border-radius: 8px; font-size: 15px; line-height: 1;
        background: color-mix(in srgb, var(--csp-accent) 16%, transparent);
      }
      #${SYLLABUS_PROMPT_ID} .cs-syl-title { font-weight: 650; font-size: 14px; color: var(--csp-text); letter-spacing: -0.01em; }
      #${SYLLABUS_PROMPT_ID} .cs-syl-body { color: var(--csp-text-2); margin-bottom: 14px; }
      #${SYLLABUS_PROMPT_ID} .cs-syl-actions { display: flex; gap: 8px; justify-content: flex-end; }
      #${SYLLABUS_PROMPT_ID} button { font: 600 12.5px 'Geist', system-ui, sans-serif; border-radius: 9px; padding: 8px 15px; cursor: pointer; border: 1px solid transparent; transition: filter 0.15s ease, background 0.15s ease, transform 0.12s ease; }
      #${SYLLABUS_PROMPT_ID} button:active { transform: scale(0.96); }
      #${SYLLABUS_PROMPT_ID} .cs-syl-add { background: var(--csp-accent); color: var(--csp-on-accent); box-shadow: 0 5px 16px color-mix(in srgb, var(--csp-accent) 38%, transparent); }
      #${SYLLABUS_PROMPT_ID} .cs-syl-add:hover { filter: brightness(1.07); }
      #${SYLLABUS_PROMPT_ID} .cs-syl-dismiss { background: transparent; color: var(--csp-text-2); border-color: var(--csp-border-2); }
      #${SYLLABUS_PROMPT_ID} .cs-syl-dismiss:hover { background: var(--csp-hover); color: var(--csp-text); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showSyllabusAutopilotPrompt(ctx) {
    if (!ctx || syllabusPromptCard || document.getElementById(SYLLABUS_PROMPT_ID)) return;
    if (!document.body) return;

    ensureSyllabusPromptStyle();

    const card = document.createElement('div');
    card.id = SYLLABUS_PROMPT_ID;
    card.setAttribute('data-theme', detectModalTheme());
    card.innerHTML = `
      <div class="cs-syl-head">
        <span class="cs-syl-icon">📅</span>
        <span class="cs-syl-title">This looks like a syllabus</span>
      </div>
      <div class="cs-syl-body">Extract the deadlines and add them to your Google Calendar?</div>
      <div class="cs-syl-actions">
        <button class="cs-syl-dismiss" data-cs-syllabus-dismiss>Not now</button>
        <button class="cs-syl-add" data-cs-syllabus-add>Add to Calendar</button>
      </div>
    `;
    document.body.appendChild(card);
    syllabusPromptCard = card;

    card.querySelector('[data-cs-syllabus-add]').addEventListener('click', () => {
      const { key, pdfUrl } = ctx;
      removeSyllabusAutopilotPrompt();
      rememberSyllabusChoice(key);
      // pdfUrl is null for an HTML Syllabus tab → undefined routes to the page-text path.
      openSyllabusAutopilot(pdfUrl || undefined);
    });
    card.querySelector('[data-cs-syllabus-dismiss]').addEventListener('click', () => {
      const { key } = ctx;
      removeSyllabusAutopilotPrompt();
      rememberSyllabusChoice(key);
    });
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
    percentToLetter,
    openZenSpace,
    openSyllabusAutopilot,
    showSyllabusAutopilotPrompt,
    removeSyllabusAutopilotPrompt
  };

  // -------------------------------------------------------------------------
  // STYLES (scoped to shadow DOM)
  // -------------------------------------------------------------------------

  const MODAL_CSS = `
    :host, * { box-sizing: border-box; }
    :host {
      /* Dark theme (default). Light overrides live in :host([data-theme="light"]). */
      --cs-tool-bg: #07090f;
      --cs-tool-bg-1: #0c0f17;
      --cs-tool-bg-2: #11141d;
      --cs-tool-bg-3: #181c28;
      --cs-tool-border: #232837;
      --cs-tool-border-strong: #32384a;
      --cs-tool-text: #edf0f8;
      --cs-tool-text-2: #a9afbf;
      --cs-tool-text-3: #70788a;
      --cs-tool-accent: #b297ff;
      --cs-tool-accent-2: #c7b7ff;
      --cs-tool-on-accent: #100a22;
      --cs-tool-success: #75c48f;
      --cs-tool-danger: #ff8b8b;
      --cs-tool-shadow: 0 32px 80px rgba(0,0,0,0.62);
      --cs-tool-font: 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      --cs-tool-mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      color-scheme: dark;
    }
    :host([data-theme="light"]) {
      --cs-tool-bg: #f3f4f8;
      --cs-tool-bg-1: #ffffff;
      --cs-tool-bg-2: #f6f7fb;
      --cs-tool-bg-3: #eef0f6;
      --cs-tool-border: #e4e6ef;
      --cs-tool-border-strong: #d2d5e1;
      --cs-tool-text: #1a1c26;
      --cs-tool-text-2: #595e6e;
      --cs-tool-text-3: #8a8f9f;
      --cs-tool-accent: #7c5cff;
      --cs-tool-accent-2: #6a48f5;
      --cs-tool-on-accent: #ffffff;
      --cs-tool-success: #2f9e5f;
      --cs-tool-danger: #d8443f;
      --cs-tool-shadow: 0 24px 64px rgba(40, 36, 80, 0.22);
      color-scheme: light;
    }
    .backdrop {
      position: absolute; inset: 0;
      background: rgba(4, 6, 10, 0.62);
      backdrop-filter: blur(8px) saturate(1.1);
      -webkit-backdrop-filter: blur(8px) saturate(1.1);
      display: flex; align-items: flex-start; justify-content: center;
      padding-top: 8vh;
      font-family: var(--cs-tool-font);
      color: var(--cs-tool-text);
    }
    .panel {
      width: min(720px, calc(100vw - 32px));
      max-height: 84vh;
      overflow: hidden auto;
      background: var(--cs-tool-bg-1);
      border: 1px solid var(--cs-tool-border);
      border-radius: 18px;
      box-shadow: var(--cs-tool-shadow);
      position: relative;
      animation: cs-panel-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes cs-panel-in {
      from { opacity: 0; transform: translateY(14px) scale(0.985); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .panel__head {
      padding: 20px 24px 16px;
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--cs-tool-accent) 9%, var(--cs-tool-bg-2)),
          var(--cs-tool-bg-2));
      border-bottom: 1px solid var(--cs-tool-border);
      position: relative;
    }
    .panel__head::before {
      content: ''; position: absolute; inset: 0 0 auto 0; height: 3px;
      background: linear-gradient(90deg, var(--cs-tool-accent), color-mix(in srgb, var(--cs-tool-accent) 35%, transparent));
    }
    .panel__head h2 {
      margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -0.01em;
      color: var(--cs-tool-text);
    }
    .panel__sub { font-size: 12.5px; color: var(--cs-tool-text-2); margin-top: 5px; }
    .panel__close {
      position: absolute; top: 16px; right: 16px;
      width: 30px; height: 30px; border-radius: 9px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--cs-tool-bg-3); color: var(--cs-tool-text-2);
      border: 1px solid var(--cs-tool-border);
      cursor: pointer; font-size: 14px; line-height: 1;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 140ms ease;
    }
    .panel__close:hover {
      background: color-mix(in srgb, var(--cs-tool-danger) 16%, var(--cs-tool-bg-3));
      border-color: color-mix(in srgb, var(--cs-tool-danger) 40%, var(--cs-tool-border));
      color: var(--cs-tool-danger);
    }
    .panel__close:active { transform: scale(0.92); }
    .panel__body { padding: 16px 22px 22px; }
    .empty { color: var(--cs-tool-text-3); padding: 24px 0; text-align: center; }
    .flash {
      position: absolute; bottom: 14px; right: 14px;
      background: var(--cs-tool-accent); color: #080a11;
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
    .gpa-controls label { font-size: 11px; color: var(--cs-tool-text-2); text-transform: uppercase; letter-spacing: 0; }
    .gpa-controls select, .gpa-controls input, .gpa-controls button {
      background: var(--cs-tool-bg-3); color: var(--cs-tool-text); border: 1px solid var(--cs-tool-border);
      border-radius: 6px; padding: 6px 10px; font: inherit;
    }
    .gpa-controls button { background: var(--cs-tool-accent); color: #080a11; cursor: pointer; font-weight: 600; }
    .gpa-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .gpa-table th { text-align: left; color: var(--cs-tool-text-2); font-weight: 500; padding: 6px; border-bottom: 1px solid var(--cs-tool-border); }
    .gpa-table td { padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .gpa-table input {
      background: var(--cs-tool-bg-2); color: var(--cs-tool-text); border: 1px solid var(--cs-tool-border);
      border-radius: 4px; padding: 4px 6px; font: inherit; width: 100%;
    }
    .gpa-table button {
      background: transparent; color: var(--cs-tool-text-3); border: none; cursor: pointer; font-size: 14px;
    }
    .gpa-table button:hover { color: var(--cs-tool-danger); }
    .gpa-summary {
      margin-top: 18px;
      display: flex; align-items: baseline; gap: 14px;
      padding: 14px 18px;
      background: var(--cs-tool-bg-2); border-radius: 8px;
      border: 1px solid var(--cs-tool-border-strong);
    }
    .gpa-summary__num { font-size: 36px; font-weight: 700; color: var(--cs-tool-accent); font-variant-numeric: tabular-nums; }
    .gpa-summary__meta { font-size: 12px; color: var(--cs-tool-text-2); }

    /* Grades */
    .grades-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .grades-list li {
      display: grid; grid-template-columns: 1fr 60px 80px;
      gap: 12px; align-items: center;
      padding: 10px 12px;
      background: var(--cs-tool-bg-2); border-radius: 8px;
      border: 1px solid var(--cs-tool-border);
    }
    .grades-list li:hover { background: var(--cs-tool-bg-3); border-color: var(--cs-tool-border-strong); }
    .grades-list__letter { color: var(--cs-tool-accent); font-weight: 600; text-align: center; }
    .grades-list__pct { text-align: right; color: var(--cs-tool-text-2); font-variant-numeric: tabular-nums; }

    /* Notes */
    .note-composer { margin-bottom: 14px; display: flex; flex-direction: column; gap: 8px; }
    .note-composer textarea {
      min-height: 80px;
      background: var(--cs-tool-bg-2); color: var(--cs-tool-text); border: 1px solid var(--cs-tool-border);
      border-radius: 8px; padding: 10px; font: inherit;
      resize: vertical;
    }
    .note-composer button {
      align-self: flex-end;
      background: var(--cs-tool-accent); color: #080a11; border: none;
      border-radius: 6px; padding: 6px 14px; cursor: pointer; font-weight: 600;
    }
    .notes-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .notes-list li {
      position: relative;
      background: var(--cs-tool-bg-2); border-radius: 8px;
      padding: 10px 36px 10px 12px;
      border: 1px solid var(--cs-tool-border);
    }
    .notes-list__title { font-weight: 600; color: var(--cs-tool-text); }
    .notes-list__body  { font-size: 12px; color: var(--cs-tool-text-2); margin: 4px 0; line-height: 1.5; }
    .notes-list__meta  { font-size: 10px; color: var(--cs-tool-text-3); }
    .notes-list li button {
      position: absolute; top: 8px; right: 8px;
      background: transparent; color: var(--cs-tool-text-3); border: none; cursor: pointer; font-size: 13px;
    }
    .notes-list li button:hover { color: var(--cs-tool-danger); }
    .md-todo { font-size: 12px; color: var(--cs-tool-text); }
    .md-todo.done { color: var(--cs-tool-text-3); text-decoration: line-through; }
    .md-li { font-size: 12px; }

    /* ZEN FOCUS SPACE */
    .panel.panel--zen {
      width: 100vw;
      height: 100vh;
      max-width: 100vw;
      max-height: 100vh;
      border: none;
      border-radius: 0;
      background: rgba(7, 9, 15, 0.92);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--cs-tool-text);
      padding: 0;
      box-shadow: none;
    }
    .backdrop:has(.panel--zen) {
      padding-top: 0;
      background: transparent;
      backdrop-filter: none;
    }
    .zen-close-btn {
      position: absolute;
      top: 24px;
      right: 24px;
      background: var(--cs-tool-bg-2);
      border: 1px solid var(--cs-tool-border);
      color: var(--cs-tool-text-2);
      border-radius: 8px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 180ms ease;
      z-index: 99;
    }
    .zen-close-btn:hover {
      background: rgba(255, 139, 139, 0.12);
      border-color: rgba(255, 139, 139, 0.32);
      color: var(--cs-tool-danger);
    }
    .zen-grid {
      display: grid;
      grid-template-columns: 1.1fr 1.8fr 1.1fr;
      width: min(1140px, 92vw);
      height: min(640px, 80vh);
      gap: 32px;
      align-items: stretch;
    }
    .zen-left, .zen-right {
      background: var(--cs-tool-bg-1);
      border: 1px solid var(--cs-tool-border);
      border-radius: 8px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }
    .zen-center {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .zen-sec-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--cs-tool-accent);
      text-transform: uppercase;
      letter-spacing: 0;
      margin-bottom: 14px;
      margin-top: 0;
    }
    
    /* LEFT PANEL: PLANNER & GOAL */
    .zen-task-picker select, .zen-task-picker input {
      width: 100%;
      background: var(--cs-tool-bg-2);
      color: var(--cs-tool-text);
      border: 1px solid var(--cs-tool-border);
      border-radius: 8px;
      padding: 10px 12px;
      font: inherit;
      font-size: 13px;
      margin-top: 6px;
      outline: none;
      transition: border-color 160ms ease;
    }
    .zen-task-picker select:focus, .zen-task-picker input:focus {
      border-color: var(--cs-tool-accent);
    }
    .zen-todo-list {
      list-style: none;
      padding: 0;
      margin: 0;
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
    }
    .zen-todo-list li {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--cs-tool-bg-2);
      border: 1px solid var(--cs-tool-border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
      transition: all 180ms ease;
    }
    .zen-todo-list li:hover {
      background: var(--cs-tool-bg-3);
      border-color: var(--cs-tool-border-strong);
    }
    .zen-todo-list li.done {
      opacity: 0.5;
      text-decoration: line-through;
      background: transparent;
    }
    .zen-todo-list li input[type="checkbox"] {
      width: 15px;
      height: 15px;
      cursor: pointer;
      accent-color: var(--cs-tool-accent);
      margin: 0;
    }
    .zen-todo-empty {
      color: var(--cs-tool-text-3);
      font-size: 12px;
      text-align: center;
      padding: 32px 0;
    }

    /* CENTER PANEL: TIMER */
    .zen-ring-container {
      position: relative;
      width: 240px;
      height: 240px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
    }
    .zen-ring {
      position: absolute;
      inset: 0;
      transform: rotate(-90deg);
      width: 100%;
      height: 100%;
    }
    .zen-ring-bg {
      fill: none;
      stroke: var(--cs-tool-border);
      stroke-width: 6;
    }
    .zen-ring-fg {
      fill: none;
      stroke: var(--cs-tool-accent);
      stroke-width: 6;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.3s ease;
    }
    
    /* Dynamic pulsing breathing animation for pauses */
    .zen-ring-container.breathing {
      animation: zenPulse 4s infinite cubic-bezier(0.4, 0, 0.2, 1);
    }
    @keyframes zenPulse {
      0% { transform: scale(1); opacity: 0.95; }
      50% { transform: scale(1.02); opacity: 1; filter: drop-shadow(0 0 14px rgba(178, 151, 255, 0.18)); }
      100% { transform: scale(1); opacity: 0.95; }
    }

    .zen-timer-digital {
      display: flex;
      flex-direction: column;
      align-items: center;
      z-index: 2;
    }
    .zen-time {
      font-size: 52px;
      font-weight: 700;
      font-family: var(--cs-tool-mono);
      letter-spacing: 0;
      color: var(--cs-tool-text);
      text-shadow: 0 0 20px rgba(255, 255, 255, 0.1);
    }
    .zen-mode-badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0;
      color: var(--cs-tool-accent);
      background: rgba(178, 151, 255, 0.10);
      border: 1px solid rgba(178, 151, 255, 0.22);
      border-radius: 6px;
      padding: 4px 10px;
      margin-top: 4px;
      text-transform: uppercase;
    }
    .zen-mode-badge.break {
      color: #7cc296;
      background: rgba(124, 194, 150, 0.1);
      border-color: rgba(124, 194, 150, 0.2);
    }

    .zen-timer-controls {
      display: flex;
      gap: 16px;
      margin-bottom: 24px;
    }
    .zen-btn-control {
      background: var(--cs-tool-accent);
      color: #080a11;
      border: none;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      padding: 10px 28px;
      cursor: pointer;
      box-shadow: none;
      transition: all 180ms ease;
    }
    .zen-btn-control:hover {
      transform: translateY(-1px);
      background: var(--cs-tool-accent-2);
    }
    .zen-btn-control.btn-reset {
      background: transparent;
      color: var(--cs-tool-text-2);
      border: 1px solid var(--cs-tool-border);
      box-shadow: none;
    }
    .zen-btn-control.btn-reset:hover {
      background: var(--cs-tool-bg-3);
      border-color: var(--cs-tool-border-strong);
      color: var(--cs-tool-text);
    }

    .zen-timer-presets {
      display: flex;
      gap: 8px;
      background: var(--cs-tool-bg-2);
      border: 1px solid var(--cs-tool-border);
      padding: 4px;
      border-radius: 8px;
    }
    .zen-timer-presets button {
      background: transparent;
      border: none;
      color: var(--cs-tool-text-2);
      font-size: 11px;
      font-weight: 500;
      border-radius: 6px;
      padding: 6px 14px;
      cursor: pointer;
      transition: all 140ms ease;
    }
    .zen-timer-presets button:hover {
      color: var(--cs-tool-text);
    }
    .zen-timer-presets button.active {
      background: var(--cs-tool-bg-3);
      color: var(--cs-tool-text);
    }

    /* RIGHT PANEL: AUDIO CONSOLE */
    .zen-sound-controls {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 20px;
    }
    .zen-sound-btn {
      background: var(--cs-tool-bg-2);
      border: 1px solid var(--cs-tool-border);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--cs-tool-text-2);
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: all 180ms ease;
      width: 100%;
    }
    .zen-sound-btn:hover {
      background: var(--cs-tool-bg-3);
      border-color: var(--cs-tool-border-strong);
      color: var(--cs-tool-text);
    }
    .zen-sound-btn.active {
      background: rgba(178, 151, 255, 0.10);
      border-color: rgba(178, 151, 255, 0.28);
      color: var(--cs-tool-accent);
    }
    .zen-sound-btn span {
      font-size: 16px;
    }
    .zen-volume-container {
      margin-top: 10px;
      background: var(--cs-tool-bg-2);
      border: 1px solid var(--cs-tool-border);
      padding: 14px;
      border-radius: 8px;
    }
    .zen-volume-header {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--cs-tool-text-2);
      margin-bottom: 8px;
    }
    .zen-volume-slider {
      width: 100%;
      accent-color: var(--cs-tool-accent);
      cursor: pointer;
      height: 4px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.1);
    }
    .zen-stress-tip {
      margin-top: auto;
      font-size: 11px;
      line-height: 1.5;
      color: var(--cs-tool-text-3);
      background: var(--cs-tool-bg-2);
      border-left: 2px solid rgba(178, 151, 255, 0.28);
      padding: 8px 10px;
      border-radius: 0 6px 6px 0;
    }
    
    /* ===================== Syllabus Autopilot ===================== */
    .autopilot-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 20px;
      text-align: center;
    }
    .autopilot-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid color-mix(in srgb, var(--cs-tool-accent) 22%, transparent);
      border-top-color: var(--cs-tool-accent);
      border-radius: 50%;
      animation: autopilot-spin 0.9s linear infinite;
      margin-bottom: 18px;
    }
    @keyframes autopilot-spin {
      to { transform: rotate(360deg); }
    }
    .autopilot-loading-text {
      font-size: 15px;
      font-weight: 600;
      color: var(--cs-tool-text);
      margin-bottom: 6px;
    }
    .autopilot-loading-sub {
      font-size: 12px;
      color: var(--cs-tool-text-3);
      max-width: 320px;
      line-height: 1.5;
    }
    .autopilot-list-container {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .autopilot-meta-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--cs-tool-text-2);
      font-weight: 500;
    }
    .autopilot-meta-row .autopilot-count {
      display: inline-flex; align-items: center;
      padding: 3px 10px; border-radius: 999px;
      font-size: 12px; font-weight: 650;
      color: var(--cs-tool-accent);
      background: color-mix(in srgb, var(--cs-tool-accent) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--cs-tool-accent) 30%, transparent);
    }
    .autopilot-list {
      list-style: none;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      max-height: 52vh;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-right: 4px;
    }
    /* Slim, themed scrollbar */
    .autopilot-list::-webkit-scrollbar { width: 8px; }
    .autopilot-list::-webkit-scrollbar-thumb {
      background: var(--cs-tool-border-strong); border-radius: 999px;
      border: 2px solid transparent; background-clip: padding-box;
    }
    .autopilot-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 11px 13px;
      background: var(--cs-tool-bg-2);
      border-radius: 12px;
      border: 1px solid var(--cs-tool-border);
      position: relative;
      transition: border-color 150ms ease, background 150ms ease, transform 120ms ease;
    }
    .autopilot-item::before {
      content: ''; position: absolute; left: 0; top: 50%;
      width: 3px; height: 0; border-radius: 0 3px 3px 0;
      background: var(--cs-tool-accent);
      transform: translateY(-50%);
      transition: height 160ms ease;
    }
    .autopilot-item:hover {
      border-color: var(--cs-tool-border-strong);
    }
    .autopilot-item:has(input[data-chk]:checked) {
      background: color-mix(in srgb, var(--cs-tool-accent) 7%, var(--cs-tool-bg-2));
      border-color: color-mix(in srgb, var(--cs-tool-accent) 42%, var(--cs-tool-border));
    }
    .autopilot-item:has(input[data-chk]:checked)::before { height: 60%; }
    .autopilot-item:not(:has(input[data-chk]:checked)) { opacity: 0.78; }

    /* Unified custom checkboxes (rows + sync toggle) */
    .autopilot-item input[type="checkbox"],
    .autopilot-sync-gcal-label input[type="checkbox"] {
      appearance: none; -webkit-appearance: none;
      flex: none;
      width: 19px; height: 19px;
      border-radius: 6px;
      border: 1.5px solid var(--cs-tool-border-strong);
      background: var(--cs-tool-bg-1);
      cursor: pointer; position: relative;
      transition: background 130ms ease, border-color 130ms ease, transform 100ms ease;
    }
    .autopilot-item input[type="checkbox"]:hover,
    .autopilot-sync-gcal-label input[type="checkbox"]:hover {
      border-color: var(--cs-tool-accent);
    }
    .autopilot-item input[type="checkbox"]:checked,
    .autopilot-sync-gcal-label input[type="checkbox"]:checked {
      background: var(--cs-tool-accent);
      border-color: var(--cs-tool-accent);
    }
    .autopilot-item input[type="checkbox"]:checked::after,
    .autopilot-sync-gcal-label input[type="checkbox"]:checked::after {
      content: ''; position: absolute; left: 6px; top: 2.5px;
      width: 5px; height: 9px;
      border: solid var(--cs-tool-on-accent);
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    .autopilot-item input[type="checkbox"]:active,
    .autopilot-sync-gcal-label input[type="checkbox"]:active { transform: scale(0.9); }

    .autopilot-item-fields {
      display: flex;
      flex: 1;
      gap: 8px;
      min-width: 0;
    }
    .autopilot-item-fields input {
      background: var(--cs-tool-bg-1);
      border: 1px solid var(--cs-tool-border);
      color: var(--cs-tool-text);
      border-radius: 9px;
      padding: 8px 11px;
      font: inherit;
      font-size: 13px;
      outline: none;
      min-width: 0;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    .autopilot-item-fields input:focus {
      border-color: var(--cs-tool-accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--cs-tool-accent) 22%, transparent);
    }
    .autopilot-input-title { flex: 2; font-weight: 500; }
    .autopilot-input-date {
      flex: 1.15;
      font-family: var(--cs-tool-mono);
      font-size: 12px;
      color: var(--cs-tool-text-2);
      letter-spacing: -0.02em;
    }
    .autopilot-input-date::-webkit-calendar-picker-indicator {
      opacity: 0.55; cursor: pointer;
      transition: opacity 140ms ease;
    }
    .autopilot-input-date:hover::-webkit-calendar-picker-indicator { opacity: 0.85; }

    .autopilot-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      margin-top: 4px;
      padding-top: 16px;
      border-top: 1px solid var(--cs-tool-border);
    }
    .autopilot-sync-gcal-label {
      display: flex; align-items: center; gap: 9px;
      font-size: 13px; color: var(--cs-tool-text-2);
      cursor: pointer; user-select: none;
    }
    .autopilot-btn-submit {
      background: var(--cs-tool-accent);
      color: var(--cs-tool-on-accent);
      font-weight: 650;
      border: none;
      border-radius: 10px;
      padding: 10px 20px;
      font-size: 13.5px;
      cursor: pointer;
      box-shadow: 0 6px 18px color-mix(in srgb, var(--cs-tool-accent) 38%, transparent);
      transition: transform 120ms ease, box-shadow 140ms ease, background 140ms ease, opacity 140ms ease;
    }
    .autopilot-btn-submit:hover {
      background: var(--cs-tool-accent-2);
      transform: translateY(-1px);
      box-shadow: 0 10px 26px color-mix(in srgb, var(--cs-tool-accent) 46%, transparent);
    }
    .autopilot-btn-submit:active { transform: translateY(0); }
    .autopilot-btn-submit:disabled {
      opacity: 0.6; cursor: default; transform: none; box-shadow: none;
    }
    .autopilot-error {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 36px 20px;
      text-align: center;
    }
    .autopilot-error-title {
      font-size: 16px;
      font-weight: 650;
      color: var(--cs-tool-danger);
      margin-bottom: 8px;
    }
    .autopilot-error-body {
      font-size: 13px;
      color: var(--cs-tool-text-2);
      margin-bottom: 18px;
      max-width: 80%;
      line-height: 1.55;
    }
    .autopilot-error-close {
      background: var(--cs-tool-bg-3);
      color: var(--cs-tool-text);
      border: 1px solid var(--cs-tool-border);
      border-radius: 9px;
      padding: 8px 18px;
      font-size: 13px;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease;
    }
    .autopilot-error-close:hover {
      background: var(--cs-tool-bg-2);
      border-color: var(--cs-tool-border-strong);
    }
  `;

  console.log('[Canvascope Academic] academic-tools.js loaded.');
})();
