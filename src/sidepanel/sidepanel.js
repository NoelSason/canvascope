/**
 * Canvascope AI Sidepanel Controller (v10)
 * Single Ask surface over the shared AIRouter: tab-aware + whole-corpus
 * retrieval (RAGCore.compileUnifiedPrompt), profile-personalized, with
 * clickable [n] citations — it merges what used to be separate Chat and
 * Course Brain views.
 */
document.addEventListener('DOMContentLoaded', () => {
  // Initialize v9 neural and OCR components
  if (window.LocalEmbeddings) {
    window.LocalEmbeddings.initPipeline();
  }
  if (window.CanvascopeOCR) {
    window.CanvascopeOCR.initWorker();
  }

  const contextLabel = document.getElementById('active-context-label');
  const introPrivacyCopy = document.getElementById('intro-privacy-copy');
  const chatHistory = document.getElementById('chat-history');
  const chatViewport = document.getElementById('view-chat');
  const userPrompt = document.getElementById('user-prompt');
  const sendBtn = document.getElementById('send-btn');
  const suggestButtons = document.querySelectorAll('.btn-suggest');
  const characterSuggestions = document.getElementById('character-suggestions');
  const characterSuggestionsList = document.getElementById('character-suggestions-list');
  const container = document.getElementById('sidepanel-container');
  const viewTabs = document.querySelectorAll('.view-tab');
  const views = { chat: document.getElementById('view-chat') };
  const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
    enableSendToLectra: false
  });
  let extensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
  let activeView = 'chat';
  let refreshCharacterSuggestions = async () => {};
  let askCourseScope = ''; // '' = all courses; set by the Ask course picker
  const SIDE_PANEL_THEME_VARS = [
    '--cs-bg',
    '--cs-bg-1',
    '--cs-bg-2',
    '--cs-bg-3',
    '--cs-bg-4',
    '--cs-border',
    '--cs-border-hi',
    '--cs-border-hot',
    '--cs-text',
    '--cs-text-2',
    '--cs-text-3',
    '--cs-text-4',
    '--cs-accent',
    '--cs-accent-hi',
    '--cs-accent-sat',
    '--cs-accent-lo',
    '--cs-on-accent'
  ];

  const SYSTEM_INSTRUCTION = `You are the Canvascope study assistant running inside a Chrome extension. You are a knowledgeable tutor first and a personal-records lookup second. Below each question you receive context drawn from the student's own saved data and the page they are viewing, and (when known) an "ABOUT THE STUDENT" profile.

How to use the context:
- The sections "THE STUDENT'S TASKS & DEADLINES", "RELEVANT COURSE DETAILS", and "ACTIVE PDF DOCUMENT PAGES" are the student's authoritative personal records. Answer directly and confidently from them.
- For questions about tasks, readings, assignments, exams, or deadlines, answer from the tasks/deadlines list. Match items by topic and keywords — e.g. "cs reading" or "next reading" matches a task titled "Finish reading RAG paper". Do NOT require the course code to match the page being viewed, and never refuse just because a course number (e.g. CS 101 vs CS 61B) differs from the active page.
- If one listed item plausibly matches the question, give its title, course, and due date. If several match, briefly list them.
- For conceptual, academic, or "explain/teach me X" questions, ANSWER from your own general knowledge — the course sections are supporting context, not a limit on what you can teach. Never refuse a concept question just because it isn't in the provided sections. Only the student's private specifics (their due dates, grades, instructions) are limited to what the sections contain; say so if those are missing.
- When an "ABOUT THE STUDENT" profile is present, use it silently to shape tone and examples. NEVER restate, summarize, or list the student's profile back to them — no "ABOUT THE STUDENT" section, no recap of their major/goals/courses. Personalization should be invisible.
- When answering from an ACTIVE PDF DOCUMENT, ground your answer in the page text provided and cite page numbers when useful.

Style: concise (2-4 sentences or a short list). Use bold text, inline code backticks, and lists where appropriate. Answer in natural prose — do NOT reproduce the provided context as labeled sections or echo back headers like "RELEVANT COURSE DETAILS" or "ABOUT THE STUDENT"; weave the relevant facts into your answer. Do not add a source list; Canvascope shows sources separately.`;

  /**
   * Current-date grounding. Without it the model reasons about "this week" and
   * term names (e.g. "Summer 2026") against its own training cutoff, decides a
   * present-day term "hasn't started yet", and wrongly refuses — even when the
   * student's materials for that term are indexed and cited. Rides the system
   * block (not the cached corpus) so it never busts the proxy's prompt cache.
   */
  function currentDateGroundingBlock() {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    return `\n\nToday's date is ${today}. Treat this as the current date when answering any time-relative question ("this week", "so far", "recently"). The student's indexed course materials and active page reflect their ACTUAL, current enrollment. Never claim a course "hasn't started", "isn't active yet", or that no information is available based on its term name or your own sense of what year it is — if sources or indexed materials are present, summarize what they contain.`;
  }

  /**
   * Chat system prompt + the student's profile block. The profile rides ONLY
   * in the system argument (never the corpus block) so claude-proxy's cached
   * corpus stays byte-identical across questions.
   */
  function systemWithProfile() {
    const block = (window.StudentProfile && StudentProfile.compileContextBlock()) || '';
    return SYSTEM_INSTRUCTION + currentDateGroundingBlock() + block;
  }

  // 1. Keep the sidepanel pinned to its own theme tokens (theme-boot owns
  //    [data-theme]; this only clears stale inline overrides).
  syncSkinTheme();
  updatePrivacyRoute('checking');
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.canvasSkin) {
      applySkinTokens(changes.canvasSkin.newValue);
    }
    if (area === 'local' && changes.settings) {
      extensionSettings = normalizeExtensionSettings(changes.settings.newValue);
      updateLectraButtonVisibility();
    }
  });

  // 2. Bootstrap the shared AI route (local Nano first, cloud fallback).
  bootstrapAIRoute();

  // 2.2 Listen for active tab activation and page completion to update context dynamically
  chrome.tabs.onActivated.addListener(() => detectActiveCourseContext());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
      detectActiveCourseContext();
    }
  });

  // 2.1 Pull the latest Supabase-synced study data (todos, notes) into local
  // storage so the RAG context reflects items added on other devices.
  try {
    chrome.runtime.sendMessage({ action: 'csTools.pull' }, () => { void chrome.runtime.lastError; });
  } catch (_) { /* ignore */ }

  // 2.34 Ask course-scope picker (whole-corpus retrieval scope).
  initAskScopePicker();

  function initAskScopePicker() {
    const select = document.getElementById('ask-course-select');
    const stat = document.getElementById('ask-corpus-stat');
    if (!select || typeof RAGCore === 'undefined') return;

    select.addEventListener('change', () => { askCourseScope = select.value; });

    (async () => {
      try {
        const courses = await RAGCore.listCourses();
        select.querySelectorAll('option:not(:first-child)').forEach(o => o.remove());
        courses.forEach(({ courseName, count }) => {
          const opt = document.createElement('option');
          opt.value = courseName;
          opt.textContent = `${courseName} (${count})`;
          select.appendChild(opt);
        });
        const total = courses.reduce((sum, c) => sum + c.count, 0);
        if (stat) stat.textContent = total > 0 ? `${total} indexed` : 'Nothing indexed yet';
      } catch (e) {
        console.warn('[Canvascope Ask] Course picker populate failed:', e);
      }
    })();
  }

  // 2.35 Student profile panel (personalizes Ask + Planner answers).
  initProfilePanel();
  initCharacterSuggestions();

  function initProfilePanel() {
    const overlay = document.getElementById('profile-overlay');
    const openBtn = document.getElementById('btn-profile');
    if (!overlay || !openBtn || !window.StudentProfile) return;

    const fields = {
      name: document.getElementById('pf-name'),
      school: document.getElementById('pf-school'),
      majors: document.getElementById('pf-majors'),
      year: document.getElementById('pf-year'),
      goals: document.getElementById('pf-goals'),
      style: document.getElementById('pf-style')
    };
    const autoSection = document.getElementById('profile-auto-section');
    const autoList = document.getElementById('profile-auto-list');
    const characterProfile = window.CanvascopeCharacterProfile || null;
    const characterControls = document.getElementById('character-profile-controls');
    const cpfEnabled = document.getElementById('cpf-enabled');
    const cpfPaused = document.getElementById('cpf-paused');
    const cpfStatus = document.getElementById('cpf-status');
    const cpfDismissed = document.getElementById('cpf-dismissed');
    const cpfUpdated = document.getElementById('cpf-updated');
    const cpfSync = document.getElementById('character-profile-sync');
    const cpfSummaries = document.getElementById('cpf-summaries');
    const cpfClear = document.getElementById('cpf-clear');
    const splitList = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

    function populate() {
      const { facts } = StudentProfile.get();
      fields.name.value = facts.who.fullName || '';
      fields.school.value = facts.who.school || '';
      fields.majors.value = (facts.who.majors || []).join(', ');
      fields.year.value = facts.who.year || '';
      fields.goals.value = (facts.who.goals || []).join(', ');
      fields.style.value = facts.how.studyStyle || '';
      renderAuto(facts._auto);
      renderCharacterProfileControls();
    }

    const AUTO_LABELS = { courses: 'Courses', pendingTodos: 'Open to-dos', fullName: 'Name' };
    function renderAuto(auto) {
      const keys = Object.keys(auto || {});
      autoSection.hidden = keys.length === 0;
      autoList.innerHTML = '';
      keys.forEach(key => {
        const entry = auto[key];
        const value = Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value);
        const row = document.createElement('div');
        row.className = 'profile-auto-row';
        row.innerHTML = `
          <span class="profile-auto-key"></span>
          <span class="profile-auto-val"></span>
          <button class="profile-auto-dismiss" aria-label="Remove this detected fact" title="Remove">&times;</button>
        `;
        row.querySelector('.profile-auto-key').textContent = AUTO_LABELS[key] || key;
        row.querySelector('.profile-auto-val').textContent = value;
        row.querySelector('.profile-auto-dismiss').addEventListener('click', async () => {
          await StudentProfile.dismissAuto(key);
          renderAuto(StudentProfile.get().facts._auto);
        });
        autoList.appendChild(row);
      });
    }

    const openPanel = () => { populate(); overlay.hidden = false; };
    const closePanel = () => { overlay.hidden = true; };

    openBtn.addEventListener('click', openPanel);
    document.getElementById('profile-close').addEventListener('click', closePanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });

    document.getElementById('profile-save').addEventListener('click', async () => {
      await StudentProfile.save({
        who: {
          fullName: fields.name.value.trim(),
          school: fields.school.value.trim(),
          majors: splitList(fields.majors.value),
          year: fields.year.value.trim(),
          goals: splitList(fields.goals.value)
        },
        how: { studyStyle: fields.style.value.trim() }
      });
      closePanel();
    });

    document.getElementById('profile-clear').addEventListener('click', async () => {
      await StudentProfile.clear();
      populate();
    });

    async function renderCharacterProfileControls() {
      if (!characterControls) return;
      if (!characterProfile) {
        characterControls.hidden = true;
        return;
      }
      characterControls.hidden = false;
      try {
        const view = await characterProfile.inspect();
        const active = view.enabled && !view.paused;
        if (cpfEnabled) cpfEnabled.checked = !!view.enabled;
        if (cpfPaused) {
          cpfPaused.checked = !!view.paused;
          cpfPaused.disabled = !view.enabled;
        }
        if (cpfStatus) {
          cpfStatus.textContent = view.enabled ? (active ? 'On' : 'Paused') : 'Off';
        }
        if (cpfDismissed) cpfDismissed.textContent = String(view.dismissedCount || 0);
        if (cpfUpdated) cpfUpdated.textContent = formatCharacterProfileTime(view.updatedAt);
        if (cpfSync) cpfSync.textContent = view.synced ? 'Syncs when signed in' : 'Local';
        renderCharacterProfileSummaries(view.summaries || []);
      } catch (e) {
        console.warn('[Canvascope Character Profile] Controls failed:', e);
        if (cpfStatus) cpfStatus.textContent = 'Unavailable';
      }
    }

    function renderCharacterProfileSummaries(summaries) {
      if (!cpfSummaries) return;
      cpfSummaries.textContent = '';
      const visible = (summaries || []).slice(0, 4);
      if (!visible.length) {
        const empty = document.createElement('span');
        empty.className = 'character-profile-empty';
        empty.textContent = 'No summaries yet';
        cpfSummaries.appendChild(empty);
        return;
      }
      visible.forEach((summary) => {
        const row = document.createElement('div');
        row.className = 'character-profile-summary';
        const text = document.createElement('span');
        text.textContent = summary.text || summary.kind || 'Summary';
        const source = document.createElement('small');
        source.textContent = Array.isArray(summary.sources) && summary.sources.length
          ? summary.sources.join(', ')
          : 'Canvascope';
        row.append(text, source);
        cpfSummaries.appendChild(row);
      });
    }

    function formatCharacterProfileTime(value) {
      if (!value) return 'Never';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return 'Unknown';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    cpfEnabled?.addEventListener('change', async () => {
      if (!characterProfile) return;
      cpfEnabled.disabled = true;
      try {
        await characterProfile.setEnabled(cpfEnabled.checked);
        await renderCharacterProfileControls();
        await refreshCharacterSuggestions();
      } finally {
        cpfEnabled.disabled = false;
      }
    });

    cpfPaused?.addEventListener('change', async () => {
      if (!characterProfile) return;
      cpfPaused.disabled = true;
      try {
        await characterProfile.setPaused(cpfPaused.checked);
        await renderCharacterProfileControls();
        await refreshCharacterSuggestions();
      } finally {
        const state = await characterProfile.load().catch(() => null);
        cpfPaused.disabled = !state?.enabled;
      }
    });

    cpfClear?.addEventListener('click', async () => {
      if (!characterProfile) return;
      if (!window.confirm('Delete personalized suggestion data from this device and your synced account?')) return;
      cpfClear.disabled = true;
      try {
        await characterProfile.clear();
        await renderCharacterProfileControls();
        await refreshCharacterSuggestions();
      } finally {
        cpfClear.disabled = false;
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.characterProfile) renderCharacterProfileControls();
    });

    // First-run onboarding: surface the panel once when the user has never
    // entered anything themselves (auto-captured facts don't count — they
    // arrive in the background and must not suppress onboarding). Delayed so
    // a synced profile arriving from Supabase doesn't flash it.
    (async () => {
      const { profileOnboardingShown } = await chrome.storage.local.get('profileOnboardingShown');
      if (profileOnboardingShown) return;
      await new Promise(r => setTimeout(r, 1500));
      if (StudentProfile.get().manualEmpty) openPanel();
      await chrome.storage.local.set({ profileOnboardingShown: true });
    })();
  }

  function initCharacterSuggestions() {
    const profile = window.CanvascopeCharacterProfile;
    if (!characterSuggestions || !characterSuggestionsList || !profile) return;

    let renderSeq = 0;

    async function render() {
      const seq = ++renderSeq;
      try {
        const suggestions = await profile.getSuggestions();
        if (seq !== renderSeq) return;
        characterSuggestionsList.textContent = '';
        if (!suggestions.length) {
          characterSuggestions.hidden = true;
          return;
        }
        characterSuggestions.hidden = false;
        suggestions.forEach((suggestion) => {
          characterSuggestionsList.appendChild(createCharacterSuggestionEl(suggestion, render));
        });
      } catch (e) {
        console.warn('[Canvascope Character Profile] Suggestions failed:', e);
        characterSuggestions.hidden = true;
      }
    }

    refreshCharacterSuggestions = render;
    render();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.characterProfile || changes.searchHistory || changes.canvasGradesByCourse) render();
    });
  }

  function createCharacterSuggestionEl(suggestion, rerender) {
    const item = document.createElement('div');
    item.className = 'character-suggestion';

    const action = document.createElement('button');
    action.className = 'character-suggestion-main';
    action.type = 'button';
    action.title = suggestion.why || suggestion.label || 'Open suggestion';

    const label = document.createElement('span');
    label.className = 'character-suggestion-label';
    label.textContent = suggestion.label || 'Suggested next step';

    const reason = document.createElement('span');
    reason.className = 'character-suggestion-reason';
    const source = Array.isArray(suggestion.sources) && suggestion.sources[0] ? suggestion.sources[0] : 'Canvascope';
    reason.textContent = [suggestion.why, source].filter(Boolean).join(' · ');

    action.append(label, reason);
    action.addEventListener('click', () => handleCharacterSuggestion(suggestion));

    const dismiss = document.createElement('button');
    dismiss.className = 'character-suggestion-icon';
    dismiss.type = 'button';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss suggestion');
    dismiss.textContent = 'x';
    dismiss.addEventListener('click', async () => {
      try {
        await window.CanvascopeCharacterProfile?.dismiss(suggestion.id);
        await rerender();
      } catch (_) { /* ignore */ }
    });

    const pause = document.createElement('button');
    pause.className = 'character-suggestion-icon';
    pause.type = 'button';
    pause.title = 'Pause Character Profile suggestions';
    pause.setAttribute('aria-label', 'Pause Character Profile suggestions');
    pause.textContent = 'II';
    pause.addEventListener('click', async () => {
      try {
        await window.CanvascopeCharacterProfile?.setPaused(true);
        await rerender();
      } catch (_) { /* ignore */ }
    });

    item.append(action, dismiss, pause);
    return item;
  }

  async function handleCharacterSuggestion(suggestion) {
    if (suggestion.kind === 'resume_page' && /^https?:\/\//i.test(suggestion.targetUrl || '')) {
      try {
        await chrome.tabs.create({ url: suggestion.targetUrl });
        return;
      } catch (e) {
        console.warn('[Canvascope Character Profile] Resume page open failed:', e);
      }
    }
    const label = suggestion.label || 'this suggested task';
    await submitPrompt(`Help me with this next: ${label}. Give me the first concrete step and use my course context when relevant.`);
  }

  // 2.4 View tab switching.
  viewTabs.forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  // 2.5 Consume slash-command intents (/ask, /plan, /quiz park one in storage
  // before background opens this panel; also honored while already open).
  // The on-load consume happens at the end of bootstrapAIRoute() so the AI
  // route is settled before an intent question fires.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sidepanelIntent?.newValue) {
      consumeSidepanelIntent();
    }
  });

  async function consumeSidepanelIntent() {
    try {
      const { sidepanelIntent } = await chrome.storage.local.get('sidepanelIntent');
      if (!sidepanelIntent || !sidepanelIntent.ts || Date.now() - sidepanelIntent.ts > 30000) return;
      await chrome.storage.local.remove('sidepanelIntent');

      const { question, action } = sidepanelIntent;
      // 'brain'/'plan' are now folded into the unified Ask (chat) surface.
      if (action === 'quiz') {
        askQuiz();
      } else if (action === 'briefing') {
        if (sidepanelIntent.run) runDailyBriefingInPanel();
        else renderStoredBriefing();
      } else if (question) {
        submitPrompt(question);
      }
    } catch (e) {
      console.warn('[Canvascope AI] Sidepanel intent consume failed:', e);
    }
  }

  function switchView(name) {
    if (!views[name] || name === activeView) return;
    activeView = name;

    viewTabs.forEach(tab => {
      const isActive = tab.dataset.view === name;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });

    Object.entries(views).forEach(([key, el]) => {
      if (!el) return;
      if (key === name) {
        el.hidden = false;
        // Restart the crossfade.
        el.classList.remove('is-active');
        void el.offsetWidth;
        el.classList.add('is-active');
      } else {
        el.hidden = true;
        el.classList.remove('is-active');
      }
    });

    container.className = container.className.replace(/view-\w+-active/g, '').trim() + ` view-${name}-active`;

    if (name === 'chat') {
      userPrompt.placeholder = 'Ask anything across your course…';
    }
    refreshSendState();
  }

  // 3. Setup TextArea Auto-Resize & Enter key triggers
  userPrompt.addEventListener('input', () => {
    userPrompt.style.height = 'auto';
    userPrompt.style.height = `${userPrompt.scrollHeight}px`;
    refreshSendState();
  });

  userPrompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  });

  sendBtn.addEventListener('click', handleSubmit);

  // 3b. Paste assignment — read the clipboard once on this click (a user
  // gesture) and drop the copied assignment text into the prompt. The
  // clipboard is never read outside this handler.
  const pasteAssignmentBtn = document.getElementById('paste-assignment-btn');
  pasteAssignmentBtn?.addEventListener('click', async () => {
    try {
      const caps = self.CanvascopeOptionalCapabilities;
      const text = caps ? await caps.readClipboardText() : '';
      if (!text) return;
      const sep = userPrompt.value && !userPrompt.value.endsWith('\n') ? '\n' : '';
      userPrompt.value = userPrompt.value + sep + text;
      userPrompt.style.height = 'auto';
      userPrompt.style.height = `${userPrompt.scrollHeight}px`;
      refreshSendState();
      userPrompt.focus();
    } catch (_) { /* clipboard unavailable or denied */ }
  });

  // 4. Setup Suggestions Buttons
  suggestButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = btn.getAttribute('data-prompt');
      if (!prompt) return; // ignore action-only buttons
      userPrompt.value = prompt;
      userPrompt.style.height = 'auto';
      userPrompt.style.height = `${userPrompt.scrollHeight}px`;
      refreshSendState();
      handleSubmit();
    });
  });

  // 4.2 Setup "Send PDF to Lectra" button — sends the PDF detected on the
  // active tab to Lectra via the background service worker (same backend the
  // in-page /ls slash command uses).
  const lectraBtn = document.getElementById('btn-lectra-send');
  function normalizeExtensionSettings(rawSettings) {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    return {
      ...DEFAULT_EXTENSION_SETTINGS,
      ...source,
      enableSendToLectra: Boolean(source.enableSendToLectra)
    };
  }

  function isLectraEnabled() {
    return Boolean(extensionSettings.enableSendToLectra);
  }

  function updateLectraButtonVisibility() {
    if (!lectraBtn) return;
    lectraBtn.hidden = !isLectraEnabled();
  }

  if (lectraBtn) {
    chrome.storage.local.get(['settings']).then((data) => {
      extensionSettings = normalizeExtensionSettings(data.settings);
      updateLectraButtonVisibility();
    }).catch(() => {
      extensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
      updateLectraButtonVisibility();
    });

    lectraBtn.addEventListener('click', async () => {
      if (!isLectraEnabled()) return;
      lectraBtn.disabled = true;
      const bubble = addSystemBubble('**Sending the PDF on this page to Lectra...**');
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const res = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'sendPdfToLectra',
            trigger: 'sidebar_button',
            candidateUrl: null,
            sourcePageUrl: tab?.url || null,
            titleHint: tab?.title || null
          }, (response) => resolve(response || { success: false, message: 'No response from background script.' }));
        });

        const content = bubble.querySelector('.bubble-content');
        if (res.success) {
          content.innerHTML = parseSimpleMarkdown('**Sent to Lectra**: The PDF on this page was uploaded and queued for your Lectra iPad.');
        } else {
          const hint = res.code === 'feature_disabled'
            ? ' Enable **Send to Lectra** in the Canvascope popup settings first.'
            : res.code === 'not_signed_in' || res.code === 'auth_error'
              ? ' Sign in via the Canvascope popup, then try again.'
              : res.code === 'no_pdf_detected'
                ? ' Open a Canvas PDF (or a page with a PDF) in the active tab, then retry.'
                : '';
          content.innerHTML = parseSimpleMarkdown(`**Couldn't send to Lectra**: ${res.message || 'Unknown error.'}${hint}`);
        }
      } catch (e) {
        const content = bubble.querySelector('.bubble-content');
        content.innerHTML = parseSimpleMarkdown('**Couldn\'t send to Lectra**: ' + (e.message || e));
      } finally {
        lectraBtn.disabled = false;
        scrollViewport();
      }
    });
  }

  /**
   * Keep the sidepanel from inheriting Canvas paper/light skin variables.
   */
  async function syncSkinTheme() {
    applySkinTokens();
  }

  /**
   * Clears older inline theme overrides; tokens.css + theme-boot now drive
   * the actual palette via [data-theme] on <html>.
   */
  function applySkinTokens() {
    const root = document.documentElement;
    SIDE_PANEL_THEME_VARS.forEach(name => root.style.removeProperty(name));
    root.dataset.canvascopePanelTheme = 'v10';
  }

  function routeState() {
    return window.AIRouter ? AIRouter.getState() : { mode: null, ready: false };
  }

  function canSubmitPrompt() {
    const s = routeState();
    return s.ready || s.mode === 'local-download';
  }

  function refreshSendState() {
    sendBtn.disabled = !userPrompt.value.trim() || !canSubmitPrompt();
  }

  function updatePrivacyRoute(route) {
    if (!introPrivacyCopy) return;

    if (route === 'downloadable') {
      introPrivacyCopy.textContent = 'Send your first question to get set up, then ask about anything in your courses.';
      return;
    }

    if (route === 'auth-required') {
      introPrivacyCopy.textContent = 'Sign in from the Canvascope menu to start asking about your courses.';
      return;
    }

    introPrivacyCopy.textContent = 'Ask anything about your courses — summarize a syllabus, break down an assignment, or work out what you need for an A.';
  }

  /** Map an AIRouter state onto the status badge + privacy strip + bubbles. */
  function reflectRouteState(state, { announce = false } = {}) {
    if (state.mode === 'local' && state.ready) {
      updateUIStatus('ready', 'Ready');
      updatePrivacyRoute('local');
    } else if (state.mode === 'cloud' && state.ready) {
      updateUIStatus('ready', 'Ready');
      updatePrivacyRoute('cloud');
    } else if (state.mode === 'local-download') {
      updateUIStatus('checking', state.availability === 'downloading' ? 'Getting ready…' : 'Ready to set up');
      updatePrivacyRoute('downloadable');
      if (announce) addSystemBubble('**Almost ready** — send your first question to finish setup.');
    } else {
      updateUIStatus('error', 'Sign in');
      updatePrivacyRoute('auth-required');
      if (announce) addSystemBubble('**Sign in to continue** — open the Canvascope menu to sign in and start asking about your courses.');
    }
    refreshSendState();
  }

  /**
   * Bootstraps the shared AI route (capability check + session/cloud pick).
   */
  async function bootstrapAIRoute() {
    updateUIStatus('checking', 'Initializing...');
    updatePrivacyRoute('checking');

    // Load the student profile first so the local route's fixed system prompt
    // includes it; remote reconcile happens in the background.
    if (window.StudentProfile) {
      try { await StudentProfile.load(); } catch (_) { /* profile is optional */ }
    }

    const state = await AIRouter.init(systemWithProfile());
    reflectRouteState(state, { announce: true });
    detectActiveCourseContext();
    consumeSidepanelIntent();

    // Refresh auto-captured facts (course load, workload) without blocking.
    if (window.StudentProfile) StudentProfile.autoCapture().catch(() => {});
  }

  /**
   * Status indicator badge was removed from the header; route changes are now
   * surfaced through the intro copy + system bubbles only. Kept as a no-op so
   * the route/download flow can keep reporting state without a UI target.
   */
  function updateUIStatus() { /* status badge removed */ }

  /**
   * Scrapes metadata details from the active tab.
   */
  async function detectActiveCourseContext() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) {
        contextLabel.textContent = 'Open LMS Tab to Sync Context';
        restoreDefaultSuggestions();
        return;
      }

      // Check supported LMS domains
      const url = tab.url || '';
      const cleanUrl = url.toLowerCase().split('?')[0].split('#')[0];
      const isDirectPdf = cleanUrl.endsWith('.pdf') || url.toLowerCase().includes('application/pdf');

      const isLms = url.includes('instructure.com') ||
                    url.includes('brightspace.com') ||
                    url.includes('d2l.com') ||
                    url.includes('berkeley.edu') ||
                    url.includes('ucla.edu') ||
                    url.includes('ucsd.edu') ||
                    url.includes('mit.edu') ||
                    url.includes('asu.edu') ||
                    isDirectPdf;

      if (!isLms) {
        contextLabel.textContent = 'Active outside LMS portal';
        restoreDefaultSuggestions();
        return;
      }

      // 1. Determine if a PDF is active (direct or embedded)
      let isPdf = isDirectPdf;
      if (!isPdf) {
        try {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const el = document.querySelector('embed[src], object[data], iframe[src]');
              if (el) {
                const src = el.getAttribute('src') || el.getAttribute('data') || '';
                if (src.toLowerCase().includes('.pdf') || src.toLowerCase().includes('/files/') || src.toLowerCase().includes('/download')) {
                  return true;
                }
              }
              const attachment = document.querySelector('a.iframe_required, a[href*=".pdf"], a[href*="/files/"][href*="/download"]');
              if (attachment) {
                return true;
              }
              return false;
            }
          });
          isPdf = !!result;
        } catch (scriptError) {
          console.warn('[Canvascope AI] Failed to check for embedded PDF:', scriptError);
        }
      }

      // 2. Adjust suggestions based on PDF status
      if (isPdf) {
        applyPdfSuggestions();
      } else {
        restoreDefaultSuggestions();
      }

      // Sync active context details
      let contextName = 'Active course context';
      if (tab.title) {
        // Strip common Canvas prefixes/suffixes to keep label compact
        contextName = tab.title.split(':').pop().split('|')[0].trim();
      }
      contextLabel.textContent = isPdf ? `Attached PDF: ${contextName}` : `Attached: ${contextName}`;
    } catch (e) {
      contextLabel.textContent = 'Attached: General Context';
      restoreDefaultSuggestions();
    }
  }

  // Re-label a suggestion chip without destroying its leading SVG icon.
  function setSuggestLabel(btn, label, prompt) {
    if (!btn) return;
    const icon = btn.querySelector('svg');
    btn.textContent = '';
    if (icon) btn.appendChild(icon);
    btn.appendChild(document.createTextNode(' ' + label));
    if (prompt != null) btn.setAttribute('data-prompt', prompt);
  }

  function applyPdfSuggestions() {
    if (suggestButtons.length >= 3) {
      setSuggestLabel(suggestButtons[0], "Study Notes from PDF", "Turn this active PDF into actionable study notes. Include: key concepts, Cornell-style cue questions, worked examples or applications, likely edge cases/pitfalls, a short retrieval-practice quiz, and page-number citations. End with a concise Lectra handoff checklist I can use on iPad.");
      setSuggestLabel(suggestButtons[1], "Extract Tasks from PDF", "Identify and list all key due dates, milestones, and deliverables inside this PDF document.");
      setSuggestLabel(suggestButtons[2], "Practice Quiz on PDF", "Create a 3-question conceptual practice quiz based on the contents of this PDF document.");
    }
  }

  function restoreDefaultSuggestions() {
    if (suggestButtons.length >= 3) {
      setSuggestLabel(suggestButtons[0], "Summarize Assignment", "Summarize the active assignment page");
      setSuggestLabel(suggestButtons[1], "Extract Tasks", "What are the key deadlines and tasks on this page?");
      setSuggestLabel(suggestButtons[2], "Quick Practice Quiz", "Generate a 3-question conceptual quiz from this page context");
    }
  }

  /**
   * Helper to append a system message block.
   */
  function addSystemBubble(markdownText) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble bubble-system animate-fade-in';
    bubble.innerHTML = `
      <div class="turn-label">Canvascope</div>
      <div class="bubble-avatar"></div>
      <div class="bubble-content">${parseSimpleMarkdown(markdownText)}</div>
    `;
    chatHistory.appendChild(bubble);
    scrollViewport();
    return bubble;
  }

  // ---- Daily briefing card (autonomous agent) ----------------------------

  const AGENT_TOOL_LABELS = {
    create_todo: 'Added study to-do',
    create_calendar_event: 'Scheduled study block',
    generate_study_plan: 'Saved study plan',
    send_to_lectra: 'Sent to Lectra'
  };

  // Present-progressive labels shown live while the agent works.
  const AGENT_TOOL_PROGRESS = {
    list_deadlines: 'Checking your deadlines',
    get_grades: 'Reviewing your grades',
    search_corpus: 'Searching your course materials',
    read_active_page: 'Reading this page',
    list_calendar_events: 'Checking your calendar',
    create_todo: 'Adding a study to-do',
    create_calendar_event: 'Scheduling a study block',
    generate_study_plan: 'Writing a study plan'
  };

  // Holds the in-progress agent conversation so follow-up messages continue the
  // same thread (e.g. agent asks "what time?" → "9-11pm" stays in-context).
  // null = not in an agent conversation; the chat box routes to Q&A.
  let agentThread = null;

  function describeAuditEntry(entry) {
    const label = AGENT_TOOL_LABELS[entry.tool] || entry.tool;
    const detail = entry.input?.summary || entry.input?.title || '';
    return detail ? `${label}: ${detail}` : label;
  }

  // Append a "✓ <action> [Undo]" list for the given audit ids into a bubble.
  async function appendAgentActions(content, actionIds) {
    if (!content || !Array.isArray(actionIds) || !actionIds.length) return;
    const { agentAuditLog = [] } = await chrome.storage.local.get(['agentAuditLog']);
    const byId = new Map((agentAuditLog || []).map((e) => [e.id, e]));
    const list = document.createElement('div');
    list.className = 'agent-action-list';
    actionIds.forEach((id) => {
      const entry = byId.get(id);
      if (!entry || entry.status === 'undone') return;
      const row = document.createElement('div');
      row.className = 'agent-action-row';
      const text = document.createElement('span');
      text.className = 'agent-action-text';
      text.textContent = `✓ ${describeAuditEntry(entry)}`;
      row.appendChild(text);
      if (entry.undo_ref) {
        const undoBtn = document.createElement('button');
        undoBtn.className = 'agent-undo-btn';
        undoBtn.textContent = 'Undo';
        undoBtn.addEventListener('click', async () => {
          undoBtn.disabled = true;
          undoBtn.textContent = 'Undoing…';
          const res = await chrome.runtime.sendMessage({ type: 'agentUndo', auditId: id });
          if (res?.ok) { text.textContent = `↩ Undone: ${describeAuditEntry(entry)}`; undoBtn.remove(); }
          else { undoBtn.disabled = false; undoBtn.textContent = 'Undo'; }
        });
        row.appendChild(undoBtn);
      }
      list.appendChild(row);
    });
    if (list.childElementCount) content.appendChild(list);
  }

  // Append a Pause/Resume agent toggle into a bubble.
  async function appendPauseToggle(content) {
    if (!content) return;
    const { agentState } = await chrome.storage.local.get(['agentState']);
    const paused = !!agentState?.killSwitch?.paused;
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'agent-pause-btn';
    pauseBtn.textContent = paused ? 'Resume agent' : 'Pause agent';
    pauseBtn.addEventListener('click', async () => {
      const next = !(pauseBtn.textContent === 'Resume agent');
      await chrome.runtime.sendMessage({ type: 'agentSetPause', paused: next });
      pauseBtn.textContent = next ? 'Resume agent' : 'Pause agent';
    });
    content.appendChild(pauseBtn);
  }

  // Heuristic: does this message ask the agent to DO something (vs. ask a
  // question)? Action requests route to the tool-using agent; everything else
  // stays on the Course Brain Q&A path.
  function looksLikeAgentAction(prompt) {
    const p = String(prompt || '').trim().toLowerCase();
    if (!p) return false;
    if (/^(add|create|schedule|set up|set a|block off|block out|put|make( me)?|remind|plan( out)?|draft a study|build me)\b/.test(p)) return true;
    if (/\b(study block|on my calendar|to my calendar|calendar event|remind me|add a (to-?do|task|reminder)|create a (to-?do|task|reminder)|study plan)\b/.test(p)) return true;
    return false;
  }

  // Open a streaming port to the agent, render live steps into `content`, and
  // resolve with the final result (incl. updated `messages` for continuity).
  function streamAgentRun(content, payload) {
    return new Promise((resolve) => {
      let steps = null, thinkingEl = null, currentRow = null, currentLabel = '', settled = false;

      function ensureSteps() {
        if (!content) return null;
        if (!steps) { content.innerHTML = ''; steps = document.createElement('div'); steps.className = 'agent-steps'; content.appendChild(steps); }
        return steps;
      }
      function showThinking() {
        const s = ensureSteps(); if (!s) return;
        if (!thinkingEl) { thinkingEl = document.createElement('div'); thinkingEl.className = 'agent-step agent-step-thinking'; s.appendChild(thinkingEl); }
        thinkingEl.textContent = '· Thinking…';
        scrollViewport();
      }
      function clearThinking() { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }
      function startTool(name) {
        const s = ensureSteps(); if (!s) return;
        clearThinking();
        currentLabel = AGENT_TOOL_PROGRESS[name] || name;
        currentRow = document.createElement('div');
        currentRow.className = 'agent-step agent-step-running';
        currentRow.textContent = `⟳ ${currentLabel}…`;
        s.appendChild(currentRow);
        scrollViewport();
      }
      function endTool(status) {
        if (!currentRow) return;
        const mark = status === 'ok' ? '✓' : (status === 'integrity_block' ? '⊘' : '✗');
        currentRow.textContent = `${mark} ${currentLabel}`;
        currentRow.classList.remove('agent-step-running');
        currentRow = null;
      }
      async function finish(result) {
        if (settled) return; settled = true;
        clearThinking();
        let text = result?.text;
        if (!text) {
          if (result?.status === 'paused') text = 'The agent is paused — resume it to continue.';
          else if (result?.status === 'signed-out') text = 'Sign in to Canvascope to use the agent.';
          else text = 'Done.';
        }
        if (content) {
          const ans = document.createElement('div');
          ans.className = 'agent-answer';
          ans.innerHTML = parseSimpleMarkdown(text);
          content.appendChild(ans);
          await appendAgentActions(content, result?.actions);
        }
        scrollViewport();
        resolve(result || { status: 'error' });
      }
      function fail(message) {
        if (settled) return; settled = true;
        clearThinking();
        if (content) content.innerHTML = parseSimpleMarkdown(`I hit a problem doing that: ${message || 'please try again.'}`);
        resolve({ status: 'error' });
      }

      let port;
      try { port = chrome.runtime.connect({ name: 'agentRun' }); }
      catch (e) { fail(e.message); return; }

      showThinking();
      port.onMessage.addListener((ev) => {
        if (!ev) return;
        if (ev.type === 'status' && ev.phase === 'thinking') showThinking();
        else if (ev.type === 'tool' && ev.phase === 'start') startTool(ev.name);
        else if (ev.type === 'tool' && ev.phase === 'end') endTool(ev.status);
        else if (ev.type === 'done') { finish(ev.result); try { port.disconnect(); } catch (_) {} }
        else if (ev.type === 'error') { fail(ev.message); try { port.disconnect(); } catch (_) {} }
      });
      port.onDisconnect.addListener(() => { if (!settled) fail('the connection closed'); });
      try { port.postMessage({ type: 'start', ...payload }); }
      catch (e) { fail(e.message); }
    });
  }

  // Run the agent on a typed goal, streaming progress, and keep the
  // conversation open if the agent asked a follow-up question.
  async function submitAgentGoal(prompt) {
    appendBubble('student', '', prompt);
    const aiBubble = appendBubble('assistant', '', '');
    const content = aiBubble.querySelector('.bubble-content');
    const history = agentThread?.messages || null;
    const result = await streamAgentRun(content, { goal: prompt, history });
    if (result?.status === 'done') {
      // Keep the conversation open until the agent actually DOES something.
      // A turn that took no action (it asked a clarifying question or is still
      // gathering info) stays open so the next message continues in-context;
      // once it completes an action (created an event/todo/plan) and isn't
      // asking a follow-up, close the thread.
      const tookAction = Array.isArray(result.actions) && result.actions.length > 0;
      const asksFollowUp = /\?\s*$/.test(String(result.text || '').trim());
      const keepOpen = result.messages && (!tookAction || asksFollowUp);
      agentThread = keepOpen ? { messages: result.messages } : null;
    } else if (result?.status === 'paused') {
      agentThread = null;
    }
    // On error, leave agentThread unchanged so the user can retry in-context.
  }

  async function renderBriefingCard(briefing) {
    switchView('chat');
    const summary = briefing?.summary || 'No briefing available yet.';
    const bubble = addSystemBubble(summary);
    const content = bubble.querySelector('.bubble-content');
    if (!content) return;

    // Map the run's action ids to audit entries for friendly labels + undo.
    await appendAgentActions(content, Array.isArray(briefing?.actions) ? briefing.actions : []);

    // Pause / resume toggle.
    const { agentState } = await chrome.storage.local.get(['agentState']);
    const paused = !!agentState?.killSwitch?.paused;
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'agent-pause-btn';
    pauseBtn.textContent = paused ? 'Resume agent' : 'Pause agent';
    pauseBtn.addEventListener('click', async () => {
      const next = !(pauseBtn.textContent === 'Resume agent');
      await chrome.runtime.sendMessage({ type: 'agentSetPause', paused: next });
      pauseBtn.textContent = next ? 'Resume agent' : 'Pause agent';
    });
    content.appendChild(pauseBtn);
    scrollViewport();
  }

  async function renderStoredBriefing() {
    const { agentBriefing } = await chrome.storage.local.get(['agentBriefing']);
    if (agentBriefing) await renderBriefingCard(agentBriefing);
    else await runDailyBriefingInPanel();
  }

  async function runDailyBriefingInPanel() {
    switchView('chat');
    const aiBubble = appendBubble('assistant', '', '');
    const content = aiBubble.querySelector('.bubble-content');
    const result = await streamAgentRun(content, { briefing: true });
    if (result?.status === 'done' && content) {
      await appendPauseToggle(content);
    }
  }

  async function ensureSessionForSubmit() {
    const state = routeState();
    if (state.ready) return true;
    if (state.mode !== 'local-download') return false;

    updateUIStatus('checking', 'Getting ready…');
    const setupBubble = addSystemBubble('**Getting ready…** This may take a moment the first time.');
    const setupContent = setupBubble.querySelector('.bubble-content');

    const result = await AIRouter.ensureReady({
      onDownloadProgress: (pct) => {
        updateUIStatus('checking', pct > 0 ? `Downloading ${pct}%` : 'Downloading Model');
        if (setupContent) {
          setupContent.innerHTML = parseSimpleMarkdown(`**Downloading local AI model...** ${pct > 0 ? `${pct}% complete.` : 'Starting download.'}`);
        }
      }
    });

    if (result.ok && result.mode === 'local') {
      if (setupContent) {
        setupContent.innerHTML = parseSimpleMarkdown('**Ready** — ask anything about your courses.');
      }
      reflectRouteState(result);
      return true;
    }

    if (result.ok && result.mode === 'cloud') {
      if (setupContent) {
        setupContent.innerHTML = parseSimpleMarkdown('**Ready** — ask anything about your courses.');
      }
      reflectRouteState(result);
      return true;
    }

    reflectRouteState(result, { announce: true });
    return false;
  }

  /**
   * Read the input box and submit it through the unified Ask flow.
   */
  async function handleSubmit() {
    const prompt = userPrompt.value.trim();
    if (!prompt) return;
    userPrompt.value = '';
    userPrompt.style.height = 'auto';
    sendBtn.disabled = true;
    // Route to the tool-using agent when: (a) we're mid agent-conversation
    // (e.g. it asked "what time?"), or (b) the message asks it to DO something.
    // Otherwise stay on the Course Brain Q&A path.
    if (agentThread || looksLikeAgentAction(prompt)) {
      await submitAgentGoal(prompt);
      refreshSendState();
    } else {
      await submitPrompt(prompt);
    }
  }

  /** Grounded practice quiz over the current Ask scope. */
  function askQuiz() {
    const scopeLabel = askCourseScope || 'my courses';
    return submitPrompt(`Create a 4-question practice quiz on the most important concepts in ${scopeLabel}. For each question give the answer on the next line in bold. Base every question on the sources.`);
  }

  /**
   * The single Ask flow: tab-aware + whole-corpus retrieval, profile-
   * personalized, with clickable [n] citations. Replaces the old split
   * Chat / Course Brain paths.
   * @param {string} prompt
   */
  async function submitPrompt(prompt) {
    if (!prompt || !prompt.trim()) return;

    const ready = await ensureSessionForSubmit();
    if (!ready) {
      refreshSendState();
      return;
    }

    // 1. User + assistant bubbles with a streaming loader.
    appendBubble('student', '', prompt);
    const aiBubble = appendBubble('assistant', '', '');
    const bubbleContent = aiBubble.querySelector('.bubble-content');
    const loader = document.createElement('div');
    loader.className = 'stream-loader';
    loader.innerHTML = `<div class="stream-dot"></div><div class="stream-dot"></div><div class="stream-dot"></div>`;
    bubbleContent.appendChild(loader);
    scrollViewport();

    // 1b. Grade-target questions ("what do I need for an A") are answered by the
    //     deterministic calculator, never the LLM. Returns null to defer.
    try {
      const gradeAnswer = await self.CanvascopeGradeTargetAnswer?.(prompt, askCourseScope);
      if (gradeAnswer) {
        bubbleContent.innerHTML = parseSimpleMarkdown(gradeAnswer);
        scrollViewport();
        refreshSendState();
        return;
      }
    } catch (e) {
      console.warn('[Canvascope Ask] Grade-target path failed, falling back to LLM:', e);
    }

    // 2. Unified retrieval: active page (source [1]) + ranked corpus chunks.
    let fullPrompt = prompt;
    let sources = [];
    let presentation = { decorateCitations: true, sourceDisplay: 'rail' };
    let indexingStatus = null;
    try {
      const compiled = await RAGCore.compileUnifiedPrompt(prompt, { courseName: askCourseScope });
      fullPrompt = compiled.prompt;
      sources = compiled.sources || [];
      presentation = compiled.presentation || presentation;
      indexingStatus = compiled.indexingStatus || null;
    } catch (e) {
      console.warn('[Canvascope Ask] Unified retrieval failed, falling back to raw prompt:', e);
    }

    // 3. Stream the answer (AIRouter normalizes chunks to deltas).
    let fullResponse = '';
    try {
      for await (const delta of AIRouter.stream(fullPrompt, { system: systemWithProfile() })) {
        if (bubbleContent.querySelector('.stream-loader')) bubbleContent.innerHTML = '';
        fullResponse += delta;
        const visible = presentation.decorateCitations === false && window.CanvascopeAnswerRender?.stripCitationMarkers
          ? window.CanvascopeAnswerRender.stripCitationMarkers(fullResponse)
          : fullResponse;
        const html = parseSimpleMarkdown(visible);
        bubbleContent.innerHTML = presentation.decorateCitations === false
          ? html
          : decorateCitations(html, sources);
        scrollViewport();
      }
      if (fullResponse.trim()) {
        renderSourceChips(aiBubble, sources, bubbleContent, {
          mode: presentation.sourceDisplay === 'disclosure' ? 'disclosure' : 'rail',
          maxSources: 4
        });
        renderCourseMaterialIndexStatus(aiBubble, indexingStatus);
      } else {
        bubbleContent.innerHTML = parseSimpleMarkdown('*No answer was generated. Try rephrasing the question.*');
      }
    } catch (err) {
      console.error('[Canvascope Ask] Streaming execution error:', err);
      if (bubbleContent.querySelector('.stream-loader')) bubbleContent.innerHTML = '';
      if (fullResponse) {
        const visible = presentation.decorateCitations === false && window.CanvascopeAnswerRender?.stripCitationMarkers
          ? window.CanvascopeAnswerRender.stripCitationMarkers(fullResponse)
          : fullResponse;
        const html = parseSimpleMarkdown(visible);
        bubbleContent.innerHTML = (presentation.decorateCitations === false ? html : decorateCitations(html, sources)) +
          `<p style="color: var(--status-error); margin-top: 8px; font-style: italic;">Streaming interrupted: ${err.message || err}</p>`;
      } else {
        bubbleContent.innerHTML = `<span style="color: var(--status-error)">Error: Failed to complete streaming prompt. ${err.message || err}</span>`;
      }
      scrollViewport();
    } finally {
      refreshSendState();
    }
  }

  /** Turn [n] markers into cite pills — shared impl (answer-render.js). */
  function decorateCitations(html, sources) {
    return window.CanvascopeAnswerRender.decorateCitations(html, sources);
  }

  /** Append a clickable source rail under an answer bubble — shared impl. */
  function renderSourceChips(bubble, sources, bubbleContent, options = {}) {
    return window.CanvascopeAnswerRender.renderSourceChips(bubble, sources, {
      bubbleContent,
      mode: options.mode || 'rail',
      maxSources: options.maxSources || 4,
      onScroll: scrollViewport
    });
  }

  function renderCourseMaterialIndexStatus(container, status) {
    if (!container || !status) return;
    const queued = Number(status.queuedDocuments || 0);
    const indexed = Number(status.indexedDocuments || 0);
    const failed = Number(status.failedDocuments || 0);
    if (queued <= 0 && failed <= 0) return;
    const line = document.createElement('div');
    line.className = 'cs-indexing-status';
    const parts = [];
    if (queued > 0) parts.push(`${queued} course file${queued === 1 ? '' : 's'} indexing`);
    if (indexed > 0) parts.push(`${indexed} indexed`);
    if (failed > 0) parts.push(`${failed} failed`);
    line.textContent = parts.join(' · ');
    container.appendChild(line);
    scrollViewport();
  }

  /**
   * Helper to construct and append a chat bubble.
   */
  function appendBubble(role, avatar, text) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble bubble-${role} animate-fade-in`;
    const turnLabel = role === 'student' ? 'You' : 'Canvascope';
    bubble.innerHTML = `
      <div class="turn-label">${turnLabel}</div>
      <div class="bubble-avatar">${avatar || ''}</div>
      <div class="bubble-content">${parseSimpleMarkdown(text)}</div>
    `;
    chatHistory.appendChild(bubble);
    scrollViewport();
    return bubble;
  }

  function scrollViewport() {
    chatViewport.scrollTop = chatViewport.scrollHeight;
  }

  /** Minimal markdown → HTML — shared impl (answer-render.js). */
  function parseSimpleMarkdown(text) {
    return window.CanvascopeAnswerRender.parseSimpleMarkdown(text);
  }
});
