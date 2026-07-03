/**
 * Canvascope Agent — Tool Registry (Phase 1)
 *
 * Defines the tools the agent can call and the client-side executors that run
 * them. All P1 executors run in the service worker and wrap existing
 * Canvascope capabilities (RAGCore retrieval, chrome.storage, the Google
 * Calendar write path). No tool can write to or submit anything in Canvas —
 * Canvas access is read-only by construction (the strongest integrity guard).
 *
 * AGENT_TOOLS  — JSON-schema array sent to the model (Anthropic `tools`).
 * TOOL_EXECUTORS — name -> async (input) => JSON-serializable result.
 *
 * Loaded into the service worker via importScripts; attaches to `self`.
 */
(function () {
  'use strict';

  const browserTz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (_) { return 'UTC'; }
  })();

  const AGENT_TOOLS = [
    {
      name: 'read_active_page',
      description:
        'Read the text content of the user\'s currently active Canvas/LMS tab ' +
        '(assignment, page, syllabus, or open PDF). Use when the goal refers to ' +
        '"this page" or the current screen. Read-only.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional focus for what to extract.' }
        }
      }
    },
    {
      name: 'search_corpus',
      description:
        'Search the student\'s synced course materials (assignments, readings, ' +
        'syllabi, notes) for content relevant to a query. Returns ranked, cited ' +
        'chunks. Use to ground briefings and study plans in actual course content.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          courseName: { type: 'string', description: 'Optional course to scope to.' }
        },
        required: ['query']
      }
    },
    {
      name: 'list_deadlines',
      description:
        'List the student\'s upcoming assignments and pending to-dos (soonest ' +
        'first). Use this first in a briefing to see what is due. Read-only.',
      input_schema: {
        type: 'object',
        properties: {
          withinDays: { type: 'integer', description: 'Only items due within N days (optional).' }
        }
      }
    },
    {
      name: 'get_grades',
      description:
        'Get the student\'s current grades per course (percent + letter). ' +
        'Use to flag courses that need attention. Read-only.',
      input_schema: {
        type: 'object',
        properties: {
          course: { type: 'string', description: 'Optional course name filter.' }
        }
      }
    },
    {
      name: 'create_todo',
      description:
        'Create a study to-do for the student (e.g. "Review Ch.7 before Friday\'s ' +
        'quiz"). Study aids only — never graded submission content.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The to-do text.' },
          course: { type: 'string', description: 'Course name (optional).' },
          dueDate: { type: 'string', description: 'ISO date/datetime the to-do is due (optional).' }
        },
        required: ['title']
      }
    },
    {
      name: 'list_calendar_events',
      description:
        'List the student\'s existing Google Calendar events in a time window ' +
        'so you can find a free slot BEFORE scheduling a study block. Always ' +
        'call this first when the student says "when I\'m free" or "find me ' +
        'time". Provide ISO 8601 timeMin/timeMax (use the RUN CONTEXT date for ' +
        '"today"/"tonight"). Read-only.',
      input_schema: {
        type: 'object',
        properties: {
          timeMin: { type: 'string', description: 'ISO 8601 start of the window, e.g. 2026-06-26T17:00:00.' },
          timeMax: { type: 'string', description: 'ISO 8601 end of the window, e.g. 2026-06-27T00:00:00.' }
        },
        required: ['timeMin', 'timeMax']
      }
    },
    {
      name: 'create_calendar_event',
      description:
        'Create a Google Calendar study block for the student. Use for planned ' +
        'study/review sessions. Study aids only — never schedule "take the exam" ' +
        'as if completing graded work.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title, e.g. "Study: BIO 1A Ch.7".' },
          description: { type: 'string', description: 'Optional details.' },
          startDateTime: { type: 'string', description: 'ISO 8601 start, e.g. 2026-06-26T18:00:00.' },
          endDateTime: { type: 'string', description: 'ISO 8601 end.' }
        },
        required: ['summary', 'startDateTime', 'endDateTime']
      }
    },
    {
      name: 'generate_study_plan',
      description:
        'Save a study plan (markdown you author) as a planner note for the ' +
        'student. Study aids only — outlines, schedules, review steps; never ' +
        'graded answers.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Plan title.' },
          plan: { type: 'string', description: 'The study plan content (markdown).' },
          course: { type: 'string', description: 'Course name (optional).' }
        },
        required: ['title', 'plan']
      }
    }
  ];

  // ---- Executors -----------------------------------------------------------

  function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  const TOOL_EXECUTORS = {
    async read_active_page(input) {
      const text = await RAGCore.scrapeActiveTab(String(input?.query || ''));
      return { text: text || '(no readable content on the active tab)' };
    },

    async search_corpus(input) {
      const chunks = await RAGCore.retrieveBrainChunks(String(input?.query || ''), {
        courseName: input?.courseName || '',
        limit: 6
      });
      return { results: chunks || [] };
    },

    async list_deadlines(input) {
      const corpus = await RAGCore.buildCorpus();
      let items = RAGCore.getUpcomingItems(corpus, 25);
      const withinDays = Number(input?.withinDays);
      if (Number.isFinite(withinDays) && withinDays > 0) {
        const cutoff = Date.now() + withinDays * 86400000;
        items = items.filter((i) => {
          if (!i.dueAt) return i.type === 'to-do'; // keep undated todos
          const t = new Date(i.dueAt).getTime();
          return Number.isNaN(t) ? true : t <= cutoff;
        });
      }
      return {
        deadlines: items.map((i) => ({
          title: i.title,
          course: i.courseName,
          type: i.type,
          dueAt: i.dueAt || null
        }))
      };
    },

    async get_grades(input) {
      const { canvasGradesByCourse = {} } = await chrome.storage.local.get(['canvasGradesByCourse']);
      let entries = Object.values(canvasGradesByCourse);
      const filter = (input?.course || '').toLowerCase().trim();
      if (filter) entries = entries.filter((g) => (g.name || '').toLowerCase().includes(filter));
      return {
        grades: entries.map((g) => ({ course: g.name, percent: g.current, letter: g.letter }))
      };
    },

    async create_todo(input) {
      const id = genId('todo');
      const todo = {
        id,
        title: String(input?.title || '').trim(),
        courseName: input?.course || '',
        dueDate: input?.dueDate || null,
        done: false,
        createdBy: 'agent',
        createdAt: Date.now()
      };
      if (!todo.title) throw new Error('create_todo requires a title.');
      const { customTodos = [] } = await chrome.storage.local.get(['customTodos']);
      const next = Array.isArray(customTodos) ? customTodos.slice() : [];
      next.push(todo);
      await chrome.storage.local.set({ customTodos: next });
      self.CanvascopeAgentSync?.pushKey?.('customTodos', next);
      return { id, created: true, undo: { kind: 'todo', id } };
    },

    async list_calendar_events(input) {
      if (typeof self.listCalendarEventsInternal !== 'function') {
        throw new Error('Calendar integration unavailable.');
      }
      const r = await self.listCalendarEventsInternal(input?.timeMin, input?.timeMax);
      if (!r?.success) throw new Error(r?.message || 'Failed to read your calendar.');
      return { events: r.events };
    },

    async create_calendar_event(input) {
      const eventPayload = {
        summary: String(input?.summary || '').trim(),
        description: input?.description || '',
        start: { dateTime: input?.startDateTime, timeZone: browserTz },
        end: { dateTime: input?.endDateTime, timeZone: browserTz },
        reminders: { useDefault: true }
      };
      if (!eventPayload.summary || !input?.startDateTime || !input?.endDateTime) {
        throw new Error('create_calendar_event requires summary, startDateTime, and endDateTime.');
      }
      if (typeof self.createCalendarEventInternal !== 'function') {
        throw new Error('Calendar integration unavailable.');
      }
      const result = await self.createCalendarEventInternal(eventPayload);
      if (!result?.success) {
        throw new Error(result?.message || 'Failed to create calendar event.');
      }
      return {
        eventId: result.eventId,
        created: true,
        undo: { kind: 'calendar', eventId: result.eventId }
      };
    },

    async generate_study_plan(input) {
      const id = genId('note');
      const note = {
        id,
        title: String(input?.title || 'Study Plan').trim(),
        content: String(input?.plan || '').trim(),
        courseName: input?.course || '',
        createdBy: 'agent',
        createdAt: Date.now()
      };
      if (!note.content) throw new Error('generate_study_plan requires plan content.');
      const { dashboardNotes = [] } = await chrome.storage.local.get(['dashboardNotes']);
      const next = Array.isArray(dashboardNotes) ? dashboardNotes.slice() : [];
      next.push(note);
      await chrome.storage.local.set({ dashboardNotes: next });
      self.CanvascopeAgentSync?.pushKey?.('dashboardNotes', next);
      return { id, created: true, undo: { kind: 'note', id } };
    }
  };

  self.CanvascopeAgentTools = { AGENT_TOOLS, TOOL_EXECUTORS };
})();
