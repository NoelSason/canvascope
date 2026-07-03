/**
 * Canvascope Agent — Tool-Use Loop (service worker)
 *
 * The client-driven agent loop. It calls the claude-proxy edge function for
 * each model turn (the server holds the API key, tool schema, and prompt
 * caching), then executes any requested tools locally via the tool registry,
 * feeds results back, and repeats until the model is done.
 *
 * Safety: a global kill switch is checked before every turn and every tool
 * dispatch; gated tools pass the integrity guard; every executed tool (and
 * every refusal) is written to the audit log.
 *
 * Loaded into the service worker via importScripts AFTER background.js,
 * background-cs-extras.js, rag-core.js, and the other agent modules so the
 * globals they define exist when the loop runs. Attaches to `self`.
 */
(function () {
  'use strict';

  const MODEL = 'claude-haiku-4-5';
  const AUDIT_KEY = 'agentAuditLog';
  const AUDIT_CAP = 200;
  const BRIEFING_KEY = 'agentBriefing';

  // Static agent charter — byte-identical every run so it caches. Holds the
  // integrity line (layer 1 of the "never graded content" guard) and how to
  // use tools.
  const CHARTER = [
    'You are Canvascope\'s autonomous study agent for a college student.',
    'You work proactively on the student\'s behalf using the provided tools.',
    '',
    'HARD RULE — NEVER graded content: you must never draft, edit, complete, or',
    'submit assignments, quizzes, exams, or any work that will be turned in for',
    'a grade. You create STUDY AIDS ONLY: study plans, review reminders, study',
    'calendar blocks, and summaries of what is due. You have no tool that can',
    'submit anything, and you must not produce graded answers even as text.',
    '',
    'How to work:',
    '- Use list_deadlines and get_grades to understand what matters now.',
    '- Use search_corpus / read_active_page to ground your help in real content.',
    '- Create study todos and calendar study blocks when they clearly help.',
    '- When the student says "when I\'m free", "find me time", or similar, call',
    '  list_calendar_events for the relevant window FIRST, find an open slot,',
    '  then create the study block. Do NOT ask for a time you can look up.',
    '- Only ask the student for information you genuinely cannot determine from',
    '  the tools (e.g. which course to study). When you do ask, ask once and',
    '  stop — the conversation continues, so you will get their answer next.',
    '- Be concise and specific. Surface the 2-3 most important things.',
    '- When you are finished, write a short plain-language summary as your',
    '  final message.'
  ].join('\n');

  // ---- Profile + memory rendering (SW-safe; reads storage directly) --------

  async function compileProfileBlock() {
    try {
      const { studentProfile } = await chrome.storage.local.get(['studentProfile']);
      const facts = studentProfile?.facts;
      if (!facts) return '';
      const who = facts.who || {};
      const what = facts.what || {};
      const how = facts.how || {};
      const auto = facts._auto || {};
      const lines = [];
      const name = who.fullName || auto.fullName?.value || '';
      const idBits = [
        name ? `Name: ${name}` : '',
        who.school,
        Array.isArray(who.majors) && who.majors.length ? who.majors.join(' + ') : '',
        who.year
      ].filter(Boolean);
      if (idBits.length) lines.push(idBits.join(' · '));
      const courses = (Array.isArray(what.courses) && what.courses.length)
        ? what.courses : (auto.courses?.value || []);
      if (courses.length) lines.push(`Current courses: ${courses.slice(0, 12).join(', ')}`);
      const howBits = [how.tone, how.verbosity, how.studyStyle].filter(Boolean);
      if (howBits.length) lines.push(`Prefers: ${howBits.join(', ')}`);
      if (!lines.length) return '';
      return `# ABOUT THE STUDENT\n${lines.join('\n')}`;
    } catch (_) { return ''; }
  }

  // ---- System blocks (cache-stable ordering) ------------------------------

  async function buildSystemBlocks(volatileText) {
    const state = await self.CanvascopeAgentMemory.load();
    const profile = await compileProfileBlock();
    const memory = self.CanvascopeAgentMemory.compileMemoryBlock(state);

    const blocks = [
      // Block 1: static charter (cached, byte-identical every run).
      { type: 'text', text: CHARTER, cache_control: { type: 'ephemeral' } }
    ];
    // Block 2: semi-stable profile + memory (cached). Changes only when those
    // change, so the cached prefix stays valid across runs.
    const contextText = [profile, memory].filter(Boolean).join('\n\n');
    if (contextText) {
      blocks.push({ type: 'text', text: contextText, cache_control: { type: 'ephemeral' } });
    }
    // Block 3: volatile run context (NOT cached) — date, trigger, etc.
    if (volatileText) {
      blocks.push({ type: 'text', text: volatileText });
    }
    return blocks;
  }

  // ---- claude-proxy agent turn (non-streaming, full message back) ----------

  async function callClaudeProxyAgent({ messages, system, tools, maxTokens = 4096 }) {
    // callCanvascopeSupabaseFunction handles auth (apikey + bearer) and returns
    // parsed JSON; it throws on non-2xx / payload.error.
    return self.callCanvascopeSupabaseFunction('claude-proxy', {
      model: MODEL,
      messages,
      system,
      tools,
      stream: false,
      maxTokens
    });
  }

  // ---- Audit log -----------------------------------------------------------

  async function appendAudit(entry) {
    const record = { id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), ...entry };
    try {
      const { [AUDIT_KEY]: log = [] } = await chrome.storage.local.get([AUDIT_KEY]);
      const next = Array.isArray(log) ? log : [];
      next.push(record);
      while (next.length > AUDIT_CAP) next.shift();
      await chrome.storage.local.set({ [AUDIT_KEY]: next });
    } catch (_) { /* local audit is best-effort */ }
    try { self.CanvascopeAgentSync?.appendAudit?.(record); } catch (_) { /* remote best-effort */ }
    return record;
  }

  // ---- The loop ------------------------------------------------------------

  function extractText(content) {
    if (!Array.isArray(content)) return '';
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  }

  /**
   * Run the agent toward a goal. Returns { status, text, actions, runId }.
   * status: 'done' | 'maxed' | 'paused'
   */
  async function runGoal({ goal, maxIterations = 8, runId, trigger = 'on-demand', onEvent, history }) {
    runId = runId || `run_${Date.now().toString(36)}`;
    const tools = self.CanvascopeAgentTools.AGENT_TOOLS;
    const executors = self.CanvascopeAgentTools.TOOL_EXECUTORS;
    const guard = self.CanvascopeIntegrityGuard;
    const emit = typeof onEvent === 'function' ? onEvent : () => {};

    const volatile = `# RUN CONTEXT\nNow: ${new Date().toString()}\nTrigger: ${trigger}`;
    const system = await buildSystemBlocks(volatile);
    // Continue a prior conversation when history is passed (multi-turn), else
    // start fresh. The new user turn is appended either way.
    const messages = Array.isArray(history) ? history.slice() : [];
    messages.push({ role: 'user', content: goal });
    const actions = []; // audit ids of executed write tools (this turn)

    for (let i = 0; i < maxIterations; i++) {
      if (await self.CanvascopeAgentMemory.isPaused()) {
        await appendAudit({ runId, tool: '(loop)', status: 'paused' });
        return { status: 'paused', text: 'Agent is paused.', actions, runId, messages };
      }

      emit({ type: 'status', phase: 'thinking' });
      let message;
      try {
        message = await callClaudeProxyAgent({ messages, system, tools });
      } catch (err) {
        await appendAudit({ runId, tool: '(model)', status: 'error', result: { message: String(err?.message || err) } });
        throw err;
      }

      const content = Array.isArray(message?.content) ? message.content : [];
      messages.push({ role: 'assistant', content });

      const stopReason = message?.stop_reason;
      if (stopReason !== 'tool_use') {
        return { status: 'done', text: extractText(content), actions, runId, messages };
      }

      // Execute each requested tool, collecting results for the next turn.
      const toolResults = [];
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        const { id, name, input } = block;

        if (await self.CanvascopeAgentMemory.isPaused()) {
          await appendAudit({ runId, tool: '(loop)', status: 'paused' });
          return { status: 'paused', text: 'Agent paused mid-run.', actions, runId, messages };
        }

        emit({ type: 'tool', name, input, phase: 'start' });

        // Unknown tool -> error result so the model can recover.
        if (!executors[name]) {
          toolResults.push({ type: 'tool_result', tool_use_id: id, is_error: true, content: `Unknown tool: ${name}` });
          await appendAudit({ runId, tool: name, status: 'error', input, result: { message: 'unknown tool' } });
          emit({ type: 'tool', name, phase: 'end', status: 'error' });
          continue;
        }

        // Integrity guard (layer 3) for gated tools.
        try {
          guard.assertStudyAidOnly(name, input);
        } catch (violation) {
          toolResults.push({ type: 'tool_result', tool_use_id: id, is_error: true, content: violation.message });
          await appendAudit({ runId, tool: name, status: 'integrity_block', input });
          emit({ type: 'tool', name, phase: 'end', status: 'integrity_block' });
          continue;
        }

        try {
          const result = await executors[name](input);
          toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) });
          const audit = await appendAudit({
            runId,
            tool: name,
            status: 'ok',
            input,
            result,
            undoable: !!result?.undo,
            undo_ref: result?.undo || null
          });
          if (result?.undo) actions.push(audit.id);
          emit({ type: 'tool', name, phase: 'end', status: 'ok' });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: id, is_error: true, content: String(err?.message || err) });
          await appendAudit({ runId, tool: name, status: 'error', input, result: { message: String(err?.message || err) } });
          emit({ type: 'tool', name, phase: 'end', status: 'error' });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    await appendAudit({ runId, tool: '(loop)', status: 'loop_truncated' });
    return { status: 'maxed', text: extractText(messages[messages.length - 1]?.content) || '', actions, runId, messages };
  }

  // ---- Daily briefing ------------------------------------------------------

  async function runDailyBriefing(trigger = 'scheduled', onEvent) {
    if (await self.CanvascopeAgentMemory.isPaused()) {
      return { status: 'paused' };
    }
    // Require sign-in (proxy needs a token); bail quietly otherwise.
    try {
      const token = await self.getSupabaseAccessToken?.();
      if (!token) return { status: 'signed-out' };
    } catch (_) { return { status: 'signed-out' }; }

    const today = new Date().toISOString().slice(0, 10);
    const goal =
      `It's the morning of ${today}. Produce the student's daily study briefing. ` +
      `Review upcoming deadlines and grades, surface the 2-3 most important things ` +
      `for today, and where it clearly helps, create study-aid todos and calendar ` +
      `study blocks (never graded content). Then write a short briefing summary.`;

    const runId = `briefing_${Date.now().toString(36)}`;
    const out = await runGoal({ goal, maxIterations: 8, runId, trigger });

    if (out.status === 'done' || out.status === 'maxed') {
      const briefing = { summary: out.text, actions: out.actions, ts: Date.now(), runId };
      await chrome.storage.local.set({ [BRIEFING_KEY]: briefing });
      await self.CanvascopeAgentMemory.save({
        lastBriefing: { ts: briefing.ts, summary: out.text.slice(0, 280), actions: out.actions }
      });
      try {
        chrome.notifications?.create('agentBriefing', {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
          title: 'Your morning study briefing',
          message: (out.text || 'Your briefing is ready.').slice(0, 180)
        });
      } catch (_) { /* notifications optional */ }
    }
    return out;
  }

  // ---- Undo ----------------------------------------------------------------

  async function undoAction(auditId) {
    const { [AUDIT_KEY]: log = [] } = await chrome.storage.local.get([AUDIT_KEY]);
    const entry = (Array.isArray(log) ? log : []).find((e) => e.id === auditId);
    if (!entry || !entry.undo_ref) return { ok: false, reason: 'not-undoable' };
    const ref = entry.undo_ref;
    try {
      if (ref.kind === 'calendar') {
        if (typeof self.deleteCalendarEventInternal === 'function') {
          await self.deleteCalendarEventInternal(ref.eventId);
        }
      } else if (ref.kind === 'todo') {
        const { customTodos = [] } = await chrome.storage.local.get(['customTodos']);
        const next = (Array.isArray(customTodos) ? customTodos : []).filter((t) => t.id !== ref.id);
        await chrome.storage.local.set({ customTodos: next });
        self.CanvascopeAgentSync?.pushKey?.('customTodos', next);
      } else if (ref.kind === 'note') {
        const { dashboardNotes = [] } = await chrome.storage.local.get(['dashboardNotes']);
        const next = (Array.isArray(dashboardNotes) ? dashboardNotes : []).filter((n) => n.id !== ref.id);
        await chrome.storage.local.set({ dashboardNotes: next });
        self.CanvascopeAgentSync?.pushKey?.('dashboardNotes', next);
      } else {
        return { ok: false, reason: 'unknown-kind' };
      }
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) };
    }
    // Mark the original entry undone.
    const updated = (Array.isArray(log) ? log : []).map((e) => e.id === auditId ? { ...e, status: 'undone', undone_at: Date.now() } : e);
    await chrome.storage.local.set({ [AUDIT_KEY]: updated });
    await appendAudit({ runId: entry.runId, tool: `undo:${entry.tool}`, status: 'undone', undo_ref: ref });
    return { ok: true };
  }

  self.CanvascopeAgent = { runGoal, runDailyBriefing, undoAction, appendAudit, MODEL };
})();
