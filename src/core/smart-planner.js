/**
 * Canvascope v10 — Smart Planner view.
 * Generalizes the syllabus autopilot: instead of one PDF, it reads every
 * upcoming deadline (indexedContent + customTodos), asks the shared AIRouter
 * to split them into study blocks, and renders the same editable
 * checklist → /todo + Google Calendar + reminder flow the autopilot proved.
 */
(() => {
  let deps = null; // { markdown }
  let busy = false;

  const $ = (id) => document.getElementById(id);
  const MS_DAY = 24 * 60 * 60 * 1000;
  const DEADLINE_HANDOFF_BUFFER_MINUTES = 30;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Upcoming dated work: next 14 days plus anything overdue, soonest first. */
  async function loadDeadlines() {
    const corpus = await RAGCore.buildCorpus();
    const now = Date.now();
    return corpus
      .filter(i => i.dueAt && !i.done && i.type !== 'note')
      .map(i => ({ ...i, ts: new Date(i.dueAt).getTime() }))
      .filter(i => Number.isFinite(i.ts) && i.ts > now - 7 * MS_DAY && i.ts < now + 14 * MS_DAY)
      .sort((a, b) => a.ts - b.ts);
  }

  function renderRadar(items) {
    const mount = $('plan-radar-mount');
    if (!mount || typeof window.CanvascopeRadar === 'undefined') return;
    window.CanvascopeRadar.render(mount, {
      items,
      onOpen: (item) => { if (item && item.url) chrome.tabs.create({ url: item.url }); }
    });
  }

  function classifyDeadline(item, nowMs = Date.now()) {
    const ts = Number(item && item.ts);
    const hoursUntilDue = Number.isFinite(ts) ? (ts - nowMs) / (60 * 60 * 1000) : Infinity;
    const title = String((item && item.title) || '').toLowerCase();
    const body = `${title} ${String((item && (item.description || item.text || item.content)) || '').toLowerCase()}`;

    let urgency = 'later';
    if (hoursUntilDue < 0) urgency = 'overdue';
    else if (hoursUntilDue <= 24) urgency = 'today';
    else if (hoursUntilDue <= 72) urgency = 'soon';

    let effort = 'normal';
    if (/\b(exam|midterm|final|project|presentation|essay|paper|lab|portfolio|capstone|research)\b/.test(body)) {
      effort = 'high';
    } else if (/\b(quiz|worksheet|discussion|reading|reflection|survey|exit ticket|check[- ]?in)\b/.test(body)) {
      effort = 'quick';
    }

    return { urgency, effort };
  }

  function compactDeadlineText(item, maxLength = 180) {
    const text = String((item && (item.description || item.text || item.content)) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
  }

  function buildPlannerPrompt(deadlines, now = new Date()) {
    const nowMs = now.getTime();
    const lines = deadlines.slice(0, 15).map(d => {
      const triage = classifyDeadline(d, nowMs);
      const dueLabel = new Date(d.ts).toLocaleString();
      const evidence = compactDeadlineText(d);
      const hint = `urgency=${triage.urgency}, effort=${triage.effort}`;
      return `- "${d.title}" (${d.courseName || 'General'}) due ${dueLabel}; ${hint}${evidence ? `; notes: ${evidence}` : ''}`;
    }).join('\n');

    return `You are an academic planner. Today is ${now.toLocaleString()}.\n` +
      `Here are the student's upcoming deadlines, including local triage hints and source notes when available:\n${lines}\n\n` +
      `Propose 4-8 study blocks between now and the last deadline. Prioritize overdue/today items first, split high-effort items (essays, projects, exams) into multiple blocks (e.g. outline, draft, practice, review), keep quick items lightweight, and use the notes as source grounding instead of inventing requirements. Schedule blocks before their deadline, between 09:00 and 21:00 local time, 60-120 minutes each, leaving at least 30 minutes before a due time for submission checks and handoff.\n` +
      `Return ONLY a valid JSON array, no prose, each element: {"title": string, "startAt": ISO datetime string, "minutes": number, "course": string}.`;
  }

  function renderDeadlineList(items) {
    const list = $('plan-deadline-list');
    const count = $('plan-deadline-count');
    if (!list) return;
    list.innerHTML = '';
    if (count) count.textContent = items.length ? `${items.length} dated` : '';

    if (!items.length) {
      list.innerHTML = '<div class="plan-empty">No dated work in the next two weeks. Enjoy the calm.</div>';
      return;
    }

    const now = Date.now();
    items.slice(0, 12).forEach((item, i) => {
      const row = document.createElement(item.url ? 'button' : 'div');
      row.className = 'plan-deadline-row stagger-in';
      row.style.animationDelay = `${Math.min(i * 28, 280)}ms`;
      const overdue = item.ts < now;
      const dateLabel = new Date(item.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const triage = classifyDeadline(item, now);
      const effortLabel = triage.effort === 'high' ? 'deep work' : triage.effort;
      row.dataset.urgency = triage.urgency;
      row.dataset.effort = triage.effort;
      row.innerHTML = `
        <span class="plan-deadline-date${overdue ? ' is-overdue' : ''}">${overdue ? 'OVERDUE' : dateLabel}</span>
        <span class="plan-deadline-title">${escapeHtml(item.title)}</span>
        <span class="plan-deadline-course">${escapeHtml(item.courseName || '')}</span>
        <span class="plan-deadline-triage" title="Planner triage: ${escapeHtml(triage.urgency)} / ${escapeHtml(effortLabel)}">${escapeHtml(triage.urgency)} · ${escapeHtml(effortLabel)}</span>
      `;
      if (item.url) row.addEventListener('click', () => chrome.tabs.create({ url: item.url }));
      list.appendChild(row);
    });
  }

  /**
   * Robust JSON-array extraction — same defensive strategy as the syllabus
   * autopilot in academic-tools.js: strip markdown fences, then fall back to
   * string-aware brace counting so truncated tails don't lose earlier items.
   */
  function extractJsonArray(raw) {
    let text = String(raw || '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '');

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* fall through to scanning */ }

    const start = text.indexOf('[');
    if (start === -1) return [];
    const objects = [];
    let depth = 0, objStart = -1, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') { if (depth === 0) objStart = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && objStart !== -1) {
          try { objects.push(JSON.parse(text.slice(objStart, i + 1))); } catch (_) { /* skip bad fragment */ }
          objStart = -1;
        }
      }
    }
    return objects;
  }

  function toLocalInputValue(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function nextStudyWindowStart(nowMs) {
    const d = new Date(nowMs);
    d.setSeconds(0, 0);
    const hour = d.getHours();
    if (hour < 9) {
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    if (hour >= 21) {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    return d.getTime() + 30 * 60 * 1000;
  }

  function alignToStudyHours(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return NaN;
    d.setSeconds(0, 0);
    const hour = d.getHours();
    if (hour < 9) {
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    if (hour >= 21) {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
    return d.getTime();
  }

  function nextStudyBlockStart(candidateMs, earliestMs) {
    let start = Math.max(Number(candidateMs) || 0, Number(earliestMs) || 0);
    for (let i = 0; i < 3; i++) {
      const aligned = alignToStudyHours(start);
      if (!Number.isFinite(aligned)) return NaN;
      if (aligned >= start) return aligned;
      start = Math.max(aligned, earliestMs);
    }
    return alignToStudyHours(start);
  }

  function normalizeStudyBlocks(rawBlocks, deadlines, nowMs = Date.now()) {
    const deadlineTimes = (Array.isArray(deadlines) ? deadlines : [])
      .map(item => Number(item && item.ts))
      .filter(Number.isFinite);
    const lastDeadline = deadlineTimes.length ? Math.max(...deadlineTimes) : nowMs + 14 * MS_DAY;
    const fallbackStart = nextStudyWindowStart(nowMs);
    let cursor = fallbackStart;
    const normalized = [];

    for (const block of (Array.isArray(rawBlocks) ? rawBlocks : [])) {
      if (!block || !block.title) continue;
      const requestedMinutes = Math.max(30, Math.min(120, Number(block.minutes) || 60));
      const parsedStart = new Date(block.startAt).getTime();
      const requestedStart = Number.isFinite(parsedStart) && parsedStart > nowMs ? parsedStart : cursor;
      const startAt = nextStudyBlockStart(requestedStart, cursor);
      const latestEnd = lastDeadline - DEADLINE_HANDOFF_BUFFER_MINUTES * 60 * 1000;
      if (!Number.isFinite(startAt) || startAt > latestEnd) continue;
      const availableMinutes = Math.floor((latestEnd - startAt) / 60000);
      if (availableMinutes < 30) continue;
      const minutes = Math.min(requestedMinutes, availableMinutes);
      normalized.push({
        title: String(block.title).trim(),
        startAt: new Date(startAt).toISOString(),
        minutes,
        course: String(block.course || '').trim()
      });
      cursor = startAt + (minutes + 15) * 60 * 1000;
      if (normalized.length >= 10) break;
    }

    return normalized;
  }

  async function draftWeek() {
    if (busy) return;
    busy = true;
    const btn = $('btn-draft-week');
    const output = $('plan-output');
    if (btn) btn.disabled = true;
    output.innerHTML = `
      <div class="plan-drafting">
        <div class="stream-loader"><div class="stream-dot"></div><div class="stream-dot"></div><div class="stream-dot"></div></div>
        <span>Reading your deadlines and drafting study blocks…</span>
      </div>
    `;

    try {
      const ready = await AIRouter.ensureReady();
      if (!ready.ok) {
        output.innerHTML = `<div class="plan-empty">AI route unavailable. Sign in from the popup to enable cloud fallback.</div>`;
        return;
      }

      const deadlines = await loadDeadlines();
      if (!deadlines.length) {
        output.innerHTML = `<div class="plan-empty">Nothing to plan — no dated work in the next two weeks.</div>`;
        return;
      }

      const today = new Date();
      const prompt = buildPlannerPrompt(deadlines, today);

      // Profile rides in system only; the prompt stays strict-JSON-focused.
      const profileBlock = (window.StudentProfile && StudentProfile.compileContextBlock()) || '';
      const raw = await AIRouter.complete(prompt, profileBlock
        ? { system: AIRouter.getState().systemInstruction + profileBlock }
        : {});
      const blocks = normalizeStudyBlocks(extractJsonArray(raw), deadlines, Date.now());

      if (!blocks.length) {
        output.innerHTML = `<div class="plan-empty">Couldn't draft a plan from the model output. Try again.</div>`;
        return;
      }

      renderChecklist(blocks);
    } catch (err) {
      console.error('[Canvascope Planner] Draft failed:', err);
      output.innerHTML = `<div class="plan-empty">Planning failed: ${escapeHtml(err.message || String(err))}</div>`;
    } finally {
      if (btn) btn.disabled = false;
      busy = false;
    }
  }

  function renderChecklist(blocks) {
    const output = $('plan-output');
    output.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'plan-checklist animate-fade-in';
    card.innerHTML = `<div class="plan-section-head"><span class="plan-section-title">Proposed study blocks</span><span class="plan-section-meta">edit before saving</span></div>`;

    const rows = [];
    blocks.forEach((block, i) => {
      const row = document.createElement('div');
      row.className = 'plan-check-row stagger-in';
      row.style.animationDelay = `${Math.min(i * 28, 280)}ms`;
      row.innerHTML = `
        <input type="checkbox" class="plan-check" checked>
        <div class="plan-check-fields">
          <input type="text" class="plan-check-title" value="${escapeHtml(block.title)}">
          <div class="plan-check-meta">
            <input type="datetime-local" class="plan-check-when" value="${toLocalInputValue(block.startAt)}">
            <span class="plan-check-course">${escapeHtml(block.course || '')}</span>
            <span class="plan-check-mins">${Number(block.minutes) || 60}m</span>
          </div>
        </div>
      `;
      rows.push({ row, block });
      card.appendChild(row);
    });

    const actions = document.createElement('div');
    actions.className = 'plan-save-row';
    actions.innerHTML = `
      <label class="plan-cal-toggle"><input type="checkbox" id="plan-cal-sync"> Sync to Google Calendar</label>
      <label class="plan-cal-toggle"><input type="checkbox" id="plan-remind" checked> Remind me</label>
      <button id="btn-save-plan" class="btn-plan-primary">Save blocks</button>
    `;
    card.appendChild(actions);
    output.appendChild(card);

    actions.querySelector('#btn-save-plan').addEventListener('click', async () => {
      const saveBtn = actions.querySelector('#btn-save-plan');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      const calSync = actions.querySelector('#plan-cal-sync').checked;
      const remind = actions.querySelector('#plan-remind').checked;

      let saved = 0, calOk = 0, calFail = 0;
      const { customTodos = [] } = await chrome.storage.local.get(['customTodos']);

      for (const { row, block } of rows) {
        if (!row.querySelector('.plan-check').checked) continue;
        const title = row.querySelector('.plan-check-title').value.trim() || block.title;
        const whenVal = row.querySelector('.plan-check-when').value;
        const startTs = whenVal ? new Date(whenVal).getTime() : new Date(block.startAt).getTime();
        if (!Number.isFinite(startTs)) continue;
        const minutes = Number(block.minutes) || 60;

        // Same shape academic-tools addTodo writes — keeps /todo + sync + RAG happy.
        customTodos.push({
          id: `todo_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`,
          title,
          dueAt: startTs,
          courseId: null,
          color: null,
          done: false,
          createdAt: Date.now()
        });
        saved++;

        if (calSync) {
          const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              type: 'createGoogleCalendarEvent',
              event: {
                summary: title,
                description: `Canvascope study block${block.course ? ` — ${block.course}` : ''}`,
                start: { dateTime: new Date(startTs).toISOString() },
                end: { dateTime: new Date(startTs + minutes * 60 * 1000).toISOString() }
              }
            }, (response) => { void chrome.runtime.lastError; resolve(response || { success: false }); });
          });
          if (res.success) calOk++; else calFail++;
        }

        if (remind) {
          chrome.runtime.sendMessage({
            action: 'csReminders.scheduleOnce',
            title: `Study block: ${title}`,
            body: 'Scheduled by Canvascope Smart Planner',
            at: Math.max(startTs - 15 * 60 * 1000, Date.now() + 60 * 1000)
          }, () => { void chrome.runtime.lastError; });
        }
      }

      await chrome.storage.local.set({ customTodos });
      // Mirror to Supabase (best-effort, same path /todo uses).
      chrome.runtime.sendMessage({ action: 'csTools.push' }, () => { void chrome.runtime.lastError; });

      let summary = `**Saved ${saved} study block${saved === 1 ? '' : 's'}** to your /todo list.`;
      if (calSync) summary += ` Calendar: ${calOk} created${calFail ? `, ${calFail} failed` : ''}.`;
      if (remind && saved) summary += ' Reminders set for 15 minutes before each block.';
      output.insertAdjacentHTML('beforeend', `<div class="plan-save-result animate-fade-in">${deps.markdown(summary)}</div>`);
      saveBtn.textContent = 'Saved ✓';
      refresh();
    });
  }

  async function refresh() {
    const items = await loadDeadlines();
    renderRadar(items);
    renderDeadlineList(items);
  }

  function init(dependencies) {
    deps = dependencies;
    const btn = $('btn-draft-week');
    if (btn) btn.addEventListener('click', draftWeek);
    refresh();
  }

  window.SmartPlanner = {
    init,
    refresh,
    draftWeek,
    __test: { classifyDeadline, compactDeadlineText, buildPlannerPrompt, extractJsonArray, nextStudyWindowStart, normalizeStudyBlocks, toLocalInputValue }
  };
})();
