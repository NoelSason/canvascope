/**
 * ============================================
 * Canvascope – Slash Command Pack (slash-commands-pack.js)
 * ============================================
 *
 * Registers the BetterCanvas-parity command set into the slash overlay:
 *
 *   /theme    <id>            Apply or browse themes
 *   /font     <id>            Swap UI font
 *   /density  compact|cozy    Card density
 *   /paint    <course> <hex>  Repaint a course card
 *   /skin     reset           Reset all skin prefs (or open settings panel)
 *   /preview  on|off          Toggle hover previews
 *   /gpa      [scenario]      Open GPA calculator
 *   /grades                   Live grades summary
 *   /note     <text>          Quick-capture a note
 *   /notes                    Browse notes
 *   /todo     add|done|clear  Manage custom todos
 *   /remind   <item> <when>   Set a one-off reminder (delegated to background)
 *   /sync                     Push/pull skin + tools via Supabase
 *
 * Each command implements its own buildResults(arg, ctx) and the overlay
 * dispatches to it via the registration hook added in slash-overlay.js.
 *
 * ============================================
 */

(function canvascopeSlashPack() {
  'use strict';

  if (window.__canvascopeSlashPackInitialised) return;
  window.__canvascopeSlashPackInitialised = true;

  function tryRegister() {
    if (typeof window.__canvascopeRegisterSlashCommands !== 'function') return false;
    window.__canvascopeRegisterSlashCommands(buildCommands());
    return true;
  }

  // Slash overlay may load slightly after this script; retry briefly.
  if (!tryRegister()) {
    let attempts = 0;
    const t = setInterval(() => {
      attempts += 1;
      if (tryRegister() || attempts > 40) clearInterval(t);
    }, 100);
  }

  function getSkinApi()  { return window.CanvascopeSkin || null; }
  function getToolsApi() { return window.CanvascopeAcademicTools || null; }

  function buildCommands() {
    return [
      cmdTheme(),
      cmdFont(),
      cmdDensity(),
      cmdPaint(),
      cmdSkin(),
      cmdPreview(),
      cmdGpa(),
      cmdGrades(),
      cmdNote(),
      cmdNotes(),
      cmdTodo(),
      cmdRemind(),
      cmdSync()
    ];
  }

  // -------------------------------------------------------------------------
  // /theme
  // -------------------------------------------------------------------------
  function cmdTheme() {
    return {
      order: 100, id: 'cs-theme', primaryAlias: 'theme',
      aliases: ['themes', 'style'],
      title: 'Apply theme',
      description: 'Switch between built-in themes (dim, oled, paper, …).',
      keywords: ['theme', 'dark', 'light', 'oled', 'paper', 'solarized'],
      icon: 'bolt', badge: 'Theme', needsArgument: true,
      buildResults(arg) {
        const themes = getSkinApi()?.listThemes() || [];
        const q = String(arg || '').trim().toLowerCase();
        const filtered = q
          ? themes.filter(t =>
              t.id.includes(q) || t.name.toLowerCase().includes(q) ||
              t.tags?.some(tag => tag.includes(q))
            )
          : themes;
        if (!filtered.length) {
          return [{
            kind: 'guidance', title: 'No matching themes',
            subtitle: 'Try /theme dim, /theme oled, /theme paper.',
            icon: 'bolt'
          }];
        }
        return filtered.map(t => ({
          kind: 'action',
          title: t.name,
          subtitle: `${t.mode} · ${t.tags?.join(' · ') || t.id}`,
          icon: t.mode === 'dark' ? 'home' : 'star',
          badge: 'Apply',
          onSelect: async () => {
            const api = getSkinApi();
            if (!api) return;
            if (t.id === 'canvas-default') await api.reset();
            else await api.apply({ themeId: t.id, mode: t.mode });
          }
        }));
      },
      emptyCopy: q => q ? `No themes matched "${q}".` : 'No themes available.'
    };
  }

  // -------------------------------------------------------------------------
  // /font
  // -------------------------------------------------------------------------
  function cmdFont() {
    return {
      order: 101, id: 'cs-font', primaryAlias: 'font',
      aliases: ['fonts'],
      title: 'Swap font',
      description: 'Use a different typeface across Canvas.',
      keywords: ['font', 'typeface', 'family'],
      icon: 'bolt', needsArgument: true,
      buildResults(arg) {
        const fonts = getSkinApi()?.listFonts() || [];
        const q = String(arg || '').trim().toLowerCase();
        const filtered = q ? fonts.filter(f => f.id.includes(q) || f.name.toLowerCase().includes(q)) : fonts;
        return filtered.map(f => ({
          kind: 'action',
          title: f.name,
          subtitle: f.value,
          icon: 'star', badge: 'Set',
          onSelect: () => getSkinApi()?.apply({ font: f.id })
        }));
      }
    };
  }

  // -------------------------------------------------------------------------
  // /density
  // -------------------------------------------------------------------------
  function cmdDensity() {
    const opts = [
      { id: 'compact', label: 'Compact', desc: 'Tighter cards, hide actions.' },
      { id: 'cozy',    label: 'Cozy',    desc: 'Default Canvascope density.' },
      { id: 'comfy',   label: 'Comfy',   desc: 'Roomier cards.' }
    ];
    return {
      order: 102, id: 'cs-density', primaryAlias: 'density',
      title: 'Card density',
      description: 'Adjust dashboard card spacing.',
      keywords: ['density', 'compact', 'cozy', 'comfy', 'card'],
      icon: 'bolt', needsArgument: false,
      buildResults(arg) {
        const q = String(arg || '').trim().toLowerCase();
        return opts
          .filter(o => !q || o.id.includes(q) || o.label.toLowerCase().includes(q))
          .map(o => ({
            kind: 'action', title: o.label, subtitle: o.desc,
            icon: 'star', badge: 'Set',
            onSelect: () => getSkinApi()?.apply({ cardDensity: o.id })
          }));
      }
    };
  }

  // -------------------------------------------------------------------------
  // /paint <course> <hex>
  // -------------------------------------------------------------------------
  function cmdPaint() {
    return {
      order: 103, id: 'cs-paint', primaryAlias: 'paint',
      aliases: ['color', 'colour'],
      title: 'Paint course card',
      description: 'Recolor a course card. Usage: /paint <course> <#hex>',
      keywords: ['paint', 'color', 'card', 'dashboard'],
      icon: 'star', needsArgument: true,
      buildResults(arg, ctx) {
        const tokens = String(arg || '').trim().split(/\s+/);
        const courseQuery = tokens.slice(0, -1).join(' ');
        const colorToken = tokens[tokens.length - 1] || '';
        const hex = parseHex(colorToken);
        const courses = (ctx.indexedContent || []).filter(i => (i.type || '').toLowerCase() === 'course');
        const matched = courses.filter(c =>
          !courseQuery ||
          (c.title || '').toLowerCase().includes(courseQuery.toLowerCase())
        ).slice(0, ctx.SLASH_RESULT_LIMIT || 8);

        if (!hex) {
          return [{
            kind: 'guidance',
            title: 'Provide a hex color',
            subtitle: 'Example: /paint Biology #ff5577',
            icon: 'bolt'
          }, ...matched.map(c => ({
            kind: 'item', item: c, title: c.title || 'Course', subtitle: 'Pick this course',
            icon: 'star',
            onSelect: () => { /* no-op; user types color */ }
          }))];
        }

        if (!matched.length) {
          return [{
            kind: 'guidance', title: 'No matching course', subtitle: 'Try a substring of the course name.', icon: 'bolt'
          }];
        }

        return matched.map(c => ({
          kind: 'action',
          title: `Paint "${c.title}" → ${hex}`,
          subtitle: `Course ID ${extractCourseId(c.url) || '?'}`,
          icon: 'star', badge: 'Paint',
          onSelect: async () => {
            const id = extractCourseId(c.url);
            if (!id) return;
            const api = getSkinApi();
            if (!api) return;
            const cur = api.get();
            await api.apply({ cardColors: { ...(cur.cardColors || {}), [id]: hex } });
          }
        }));
      }
    };
  }

  function parseHex(s) {
    const m = String(s || '').trim().replace(/^#/, '');
    if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(m)) return null;
    return '#' + (m.length === 3 ? m.split('').map(c => c + c).join('') : m).toLowerCase();
  }

  function extractCourseId(url) {
    const m = String(url || '').match(/\/courses\/(\d+)/);
    return m ? m[1] : null;
  }

  // -------------------------------------------------------------------------
  // /skin reset, /skin
  // -------------------------------------------------------------------------
  function cmdSkin() {
    return {
      order: 104, id: 'cs-skin', primaryAlias: 'skin',
      aliases: ['settings'],
      title: 'Skin settings',
      description: 'Quick toggles for sidebar, gradients, overlay, fixer.',
      keywords: ['skin', 'reset', 'settings', 'preferences'],
      icon: 'bolt', needsArgument: false,
      buildResults(arg) {
        const api = getSkinApi(); if (!api) return [];
        const s = api.get();
        const q = String(arg || '').trim().toLowerCase();
        const entries = [
          {
            title: 'Reset all skin prefs',
            subtitle: 'Restore Canvas default look.',
            onSelect: () => api.reset()
          },
          {
            title: s.hideSidebarLogo ? 'Show sidebar logo' : 'Hide sidebar logo',
            subtitle: 'Toggle the Canvas logomark.',
            onSelect: () => api.apply({ hideSidebarLogo: !s.hideSidebarLogo })
          },
          {
            title: s.hideSidebarHelp ? 'Show sidebar help' : 'Hide sidebar help',
            subtitle: 'Toggle the Help link in the global nav.',
            onSelect: () => api.apply({ hideSidebarHelp: !s.hideSidebarHelp })
          },
          {
            title: s.hideRecentFeedback ? 'Show recent feedback' : 'Hide recent feedback',
            subtitle: 'Toggle the dashboard "Recent Feedback" panel.',
            onSelect: () => api.apply({ hideRecentFeedback: !s.hideRecentFeedback })
          },
          {
            title: s.cardGradient ? 'Disable card gradient' : 'Enable card gradient',
            subtitle: 'Smooth hue blend on dashboard card headers.',
            onSelect: () => api.apply({ cardGradient: !s.cardGradient })
          },
          {
            title: s.cardOverlayDisabled ? 'Enable color overlay' : 'Disable color overlay',
            subtitle: 'The translucent layer on card hero images.',
            onSelect: () => api.apply({ cardOverlayDisabled: !s.cardOverlayDisabled })
          },
          {
            title: s.showGradePills ? 'Hide grade pills' : 'Show grade pills',
            subtitle: 'Show current letter + % on each dashboard card.',
            onSelect: () => api.apply({ showGradePills: !s.showGradePills })
          },
          {
            title: s.darkModeFixer ? 'Disable dark-mode fixer' : 'Enable dark-mode fixer',
            subtitle: 'Inverts inline white backgrounds in discussions/iframes.',
            onSelect: () => api.apply({ darkModeFixer: !s.darkModeFixer })
          }
        ];
        return entries
          .filter(e => !q || e.title.toLowerCase().includes(q))
          .map(e => ({ kind: 'action', icon: 'bolt', badge: 'Toggle', ...e }));
      }
    };
  }

  // -------------------------------------------------------------------------
  // /preview
  // -------------------------------------------------------------------------
  function cmdPreview() {
    return {
      order: 105, id: 'cs-preview', primaryAlias: 'preview',
      title: 'Hover previews',
      description: 'Toggle assignment / announcement hover previews.',
      keywords: ['preview', 'hover', 'assignment', 'peek'],
      icon: 'bolt', needsArgument: false,
      buildResults(arg) {
        const api = getSkinApi(); if (!api) return [];
        const s = api.get();
        const want = String(arg || '').trim().toLowerCase();
        if (want === 'on' || want === 'off') {
          return [{
            kind: 'action',
            title: `Turn previews ${want.toUpperCase()}`,
            subtitle: 'Applies to all Canvas pages.',
            icon: 'star', badge: 'Apply',
            onSelect: () => api.apply({ previewsEnabled: want === 'on' })
          }];
        }
        return [
          { title: s.previewsEnabled ? 'Turn previews OFF' : 'Turn previews ON',
            subtitle: 'Currently ' + (s.previewsEnabled ? 'enabled' : 'disabled') + '.',
            onSelect: () => api.apply({ previewsEnabled: !s.previewsEnabled }) },
          { title: s.previewsShowRank ? 'Hide rank line in preview' : 'Show rank line in preview',
            subtitle: 'Dogfood line showing the indexed rank of the assignment.',
            onSelect: () => api.apply({ previewsShowRank: !s.previewsShowRank }) }
        ].map(e => ({ kind: 'action', icon: 'bolt', badge: 'Toggle', ...e }));
      }
    };
  }

  // -------------------------------------------------------------------------
  // /gpa
  // -------------------------------------------------------------------------
  function cmdGpa() {
    return {
      order: 110, id: 'cs-gpa', primaryAlias: 'gpa',
      title: 'GPA calculator',
      description: 'Run a live GPA or load a saved scenario.',
      keywords: ['gpa', 'grade', 'calculator', 'scenario', 'what-if'],
      icon: 'cap', needsArgument: false,
      buildResults(arg, ctx) {
        const tools = getToolsApi();
        if (!tools) return [{ kind: 'guidance', title: 'Tools not loaded yet', icon: 'bolt' }];
        return [{
          kind: 'action',
          title: arg ? `Open GPA · ${arg}` : 'Open GPA calculator',
          subtitle: 'Live courses + saved scenarios.',
          icon: 'cap', badge: 'Open',
          onSelect: () => { tools.openGpaCalculator(arg || undefined); ctx.closeOverlay?.(); }
        }];
      }
    };
  }

  // -------------------------------------------------------------------------
  // /grades
  // -------------------------------------------------------------------------
  function cmdGrades() {
    return {
      order: 111, id: 'cs-grades', primaryAlias: 'grades',
      title: 'Grades summary',
      description: 'One-screen view of current grades.',
      keywords: ['grade', 'grades', 'summary'],
      icon: 'cap', needsArgument: false,
      buildResults(arg, ctx) {
        const tools = getToolsApi();
        if (!tools) return [{ kind: 'guidance', title: 'Tools not loaded yet', icon: 'bolt' }];
        return [{
          kind: 'action', title: 'Open grades summary',
          subtitle: 'Pulls live data from Canvas.',
          icon: 'cap', badge: 'Open',
          onSelect: () => { tools.openGradesSummary(); ctx.closeOverlay?.(); }
        }];
      }
    };
  }

  // -------------------------------------------------------------------------
  // /note  (quick capture)
  // -------------------------------------------------------------------------
  function cmdNote() {
    return {
      order: 120, id: 'cs-note', primaryAlias: 'note',
      title: 'Quick note',
      description: 'Capture a note from any Canvas page.',
      keywords: ['note', 'jot', 'capture'],
      icon: 'pin', needsArgument: true,
      buildResults(arg, ctx) {
        const tools = getToolsApi();
        const t = String(arg || '').trim();
        if (!t) {
          return [{ kind: 'guidance', title: 'Type a note after /note', subtitle: 'Example: /note remember to email TA', icon: 'pin' }];
        }
        return [{
          kind: 'action', title: `Save "${t.slice(0, 60)}${t.length > 60 ? '…' : ''}"`,
          subtitle: 'Saved & indexed for search.',
          icon: 'pin', badge: 'Save',
          onSelect: async () => {
            if (!tools) return;
            await tools.quickCaptureNote(t);
            ctx.setFeedbackMsg?.('Note saved ✓', 'success');
            setTimeout(() => ctx.closeOverlay?.(), 700);
          }
        }];
      }
    };
  }

  // -------------------------------------------------------------------------
  // /notes  (browse)
  // -------------------------------------------------------------------------
  function cmdNotes() {
    return {
      order: 121, id: 'cs-notes', primaryAlias: 'notes',
      title: 'Browse notes',
      description: 'Open the notes panel.',
      keywords: ['notes', 'browse'],
      icon: 'pin', needsArgument: false,
      buildResults(arg, ctx) {
        const tools = getToolsApi();
        return [{
          kind: 'action', title: 'Open notes',
          subtitle: 'All your captured notes.',
          icon: 'pin', badge: 'Open',
          onSelect: () => { tools?.openNotesBrowser(); ctx.closeOverlay?.(); }
        }];
      }
    };
  }

  // -------------------------------------------------------------------------
  // /todo
  // -------------------------------------------------------------------------
  function cmdTodo() {
    return {
      order: 122, id: 'cs-todo', primaryAlias: 'todo',
      aliases: ['task'],
      title: 'Custom todo',
      description: 'add <text> · done <id> · clear · list',
      keywords: ['todo', 'task', 'add', 'done'],
      icon: 'pin', needsArgument: true,
      buildResults(arg, ctx) {
        const tools = getToolsApi();
        const tokens = String(arg || '').trim().split(/\s+/);
        const verb = (tokens.shift() || '').toLowerCase();
        const rest = tokens.join(' ');

        if (verb === 'add' && rest) {
          return [{
            kind: 'action', title: `Add todo "${rest.slice(0, 60)}"`,
            subtitle: 'Joins your Up Next list.',
            icon: 'pin', badge: 'Add',
            onSelect: async () => {
              await tools?.addTodo(rest);
              ctx.setFeedbackMsg?.('Todo added ✓', 'success');
              setTimeout(() => ctx.closeOverlay?.(), 600);
            }
          }];
        }

        if (verb === 'clear') {
          return [{
            kind: 'action', title: 'Clear all custom todos',
            subtitle: 'Cannot be undone.', icon: 'pin', badge: 'Clear',
            onSelect: async () => {
              await tools?.clearTodos();
              ctx.setFeedbackMsg?.('Cleared ✓', 'success');
              setTimeout(() => ctx.closeOverlay?.(), 600);
            }
          }];
        }

        // Default: list current todos (and 'done <id>' shortcut).
        return new Promise(resolve => {
          (tools?.listTodos() || Promise.resolve([])).then(todos => {
            if (!todos.length) {
              resolve([{ kind: 'guidance', title: 'No custom todos yet',
                subtitle: 'Try /todo add buy textbook', icon: 'pin' }]);
              return;
            }
            const wantId = verb === 'done' ? rest : '';
            resolve(todos.slice(0, 20).map(t => ({
              kind: 'action',
              title: (t.done ? '☑ ' : '☐ ') + t.title,
              subtitle: t.dueAt ? new Date(t.dueAt).toLocaleString() : 'No due date',
              icon: 'pin',
              badge: wantId && t.id === wantId ? 'Toggle' : (t.done ? 'Undo' : 'Done'),
              onSelect: async () => { await tools?.toggleTodoDone(t.id); }
            })));
          });
        });
      }
    };
  }

  // -------------------------------------------------------------------------
  // /remind  (delegate to background)
  // -------------------------------------------------------------------------
  function cmdRemind() {
    return {
      order: 130, id: 'cs-remind', primaryAlias: 'remind',
      title: 'Set reminder',
      description: 'Browser notification for an assignment or todo.',
      keywords: ['remind', 'reminder', 'notify', 'notification'],
      icon: 'cal', needsArgument: true,
      buildResults(arg, ctx) {
        const q = String(arg || '').trim();
        if (!q) {
          return [{ kind: 'guidance', title: 'Type what to remind you about',
            subtitle: 'Example: /remind midterm in 1h', icon: 'cal' }];
        }
        // Parse trailing "in 1h", "in 30m", "tomorrow 9am".
        const when = parseWhen(q);
        const subject = when ? q.slice(0, when.start).trim() : q;
        return [{
          kind: 'action',
          title: `Remind: "${subject}"`,
          subtitle: when ? `Fires ${new Date(when.at).toLocaleString()}` : 'Default: 1 hour from now',
          icon: 'cal', badge: 'Set',
          onSelect: async () => {
            try {
              const res = await chrome.runtime.sendMessage({
                action: 'csReminders.scheduleOnce',
                title: subject,
                body: 'Canvascope reminder',
                at: when?.at || (Date.now() + 60 * 60 * 1000)
              });
              if (!res?.ok) throw new Error(res?.message || 'Reminder could not be scheduled.');
              ctx.setFeedbackMsg?.('Reminder set ✓', 'success');
              setTimeout(() => ctx.closeOverlay?.(), 700);
            } catch (e) {
              ctx.setFeedbackMsg?.(String(e?.message || 'Could not set reminder.'), 'error');
            }
          }
        }];
      }
    };
  }

  function parseWhen(q) {
    const inMatch = q.match(/\bin\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)\b/i);
    if (inMatch) {
      const n = Number(inMatch[1]);
      const unit = inMatch[2].toLowerCase();
      const ms = /m/.test(unit) && !/h|d/.test(unit) ? n * 60 * 1000
               : /h/.test(unit) ? n * 3600 * 1000
               : n * 86400 * 1000;
      return { at: Date.now() + ms, start: inMatch.index };
    }
    const tomMatch = q.match(/\btomorrow(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b/i);
    if (tomMatch) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const hr = tomMatch[1] ? Number(tomMatch[1]) + (tomMatch[3]?.toLowerCase() === 'pm' && Number(tomMatch[1]) < 12 ? 12 : 0) : 9;
      d.setHours(hr, tomMatch[2] ? Number(tomMatch[2]) : 0, 0, 0);
      return { at: d.getTime(), start: tomMatch.index };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // /sync
  // -------------------------------------------------------------------------
  function cmdSync() {
    return {
      order: 140, id: 'cs-sync', primaryAlias: 'sync',
      aliases: ['cloud'],
      title: 'Force cloud sync',
      description: 'Push/pull skin, notes, todos via Supabase.',
      keywords: ['sync', 'cloud', 'supabase', 'push', 'pull'],
      icon: 'sync', needsArgument: false,
      buildResults(arg, ctx) {
        return [{
          kind: 'action', title: 'Sync now',
          subtitle: 'Requires Canvascope sign-in.',
          icon: 'sync', badge: 'Sync',
          onSelect: async () => {
            try {
              const res = await chrome.runtime.sendMessage({ action: 'csSync.forceAll' });
              ctx.setFeedbackMsg?.(res?.ok ? 'Synced ✓' : (res?.message || 'Sync failed.'),
                                 res?.ok ? 'success' : 'error');
              setTimeout(() => ctx.closeOverlay?.(), 900);
            } catch (e) {
              ctx.setFeedbackMsg?.('Sync failed.', 'error');
            }
          }
        }];
      }
    };
  }

  console.log('[Canvascope Slash Pack] loaded — 13 commands registered.');
})();
