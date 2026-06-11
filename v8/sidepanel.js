/**
 * Canvascope AI Sidepanel Controller (v10)
 * Multi-view shell (Chat · Brain · Plan) over the shared AIRouter.
 * Chat keeps the v8 active-page RAG flow; Brain answers course-wide with
 * citations (course-brain.js); Plan drafts study blocks (smart-planner.js).
 */
document.addEventListener('DOMContentLoaded', () => {
  // Initialize v9 neural and OCR components
  if (window.LocalEmbeddings) {
    window.LocalEmbeddings.initPipeline();
  }
  if (window.CanvascopeOCR) {
    window.CanvascopeOCR.initWorker();
  }

  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.status-text');
  const aiStatusBadge = document.getElementById('ai-status');
  const contextLabel = document.getElementById('active-context-label');
  const introPrivacyCopy = document.getElementById('intro-privacy-copy');
  const privacyRouteLabel = document.getElementById('privacy-route-label');
  const chatHistory = document.getElementById('chat-history');
  const chatViewport = document.getElementById('view-chat');
  const userPrompt = document.getElementById('user-prompt');
  const sendBtn = document.getElementById('send-btn');
  const suggestButtons = document.querySelectorAll('.btn-suggest');
  const container = document.getElementById('sidepanel-container');
  const viewTabs = document.querySelectorAll('.view-tab');
  const views = { chat: document.getElementById('view-chat'), brain: document.getElementById('view-brain'), plan: document.getElementById('view-plan') };
  let activeView = 'chat';
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

  const SYSTEM_INSTRUCTION = `You are the Canvascope study assistant running inside a Chrome extension. Below each question you receive context drawn from the student's own saved data and the page they are viewing.

How to use the context:
- The sections "THE STUDENT'S TASKS & DEADLINES", "RELEVANT COURSE DETAILS", and "ACTIVE PDF DOCUMENT PAGES" are the student's authoritative personal records. Answer directly and confidently from them.
- For questions about tasks, readings, assignments, exams, or deadlines, answer from the tasks/deadlines list. Match items by topic and keywords — e.g. "cs reading" or "next reading" matches a task titled "Finish reading RAG paper". Do NOT require the course code to match the page being viewed, and never refuse just because a course number (e.g. CS 101 vs CS 61B) differs from the active page.
- If one listed item plausibly matches the question, give its title, course, and due date. If several match, briefly list them.
- Only say the information isn't available when the relevant section is genuinely empty or contains nothing related to the question.
- When answering from an ACTIVE PDF DOCUMENT, ground your answer in the page text provided and cite page numbers when useful.

Style: concise (2-4 sentences or a short list). Use bold text, inline code backticks, and lists where appropriate.`;

  // 1. Keep the sidepanel pinned to its own theme tokens (theme-boot owns
  //    [data-theme]; this only clears stale inline overrides).
  syncSkinTheme();
  updatePrivacyRoute('checking');
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.canvasSkin) {
      applySkinTokens(changes.canvasSkin.newValue);
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

  // 2.3 Initialize the Brain and Plan view modules.
  if (window.CourseBrain) {
    window.CourseBrain.init({ markdown: parseSimpleMarkdown });
  }
  if (window.SmartPlanner) {
    window.SmartPlanner.init({ markdown: parseSimpleMarkdown });
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

      const { view, question, action } = sidepanelIntent;
      if (view) switchView(view);
      if (action === 'quiz' && window.CourseBrain) {
        window.CourseBrain.quiz();
      } else if (view === 'brain' && question && window.CourseBrain) {
        window.CourseBrain.ask(question);
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
      userPrompt.placeholder = 'Ask local AI about this course...';
    } else if (name === 'brain') {
      userPrompt.placeholder = 'Ask anything across your course…';
      if (window.CourseBrain) window.CourseBrain.refresh();
    } else if (name === 'plan') {
      if (window.SmartPlanner) window.SmartPlanner.refresh();
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
  if (lectraBtn) {
    lectraBtn.addEventListener('click', async () => {
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
    const needsInput = activeView !== 'plan';
    sendBtn.disabled = !needsInput || !userPrompt.value.trim() || !canSubmitPrompt();
  }

  function updatePrivacyRoute(route) {
    if (!introPrivacyCopy || !privacyRouteLabel) return;

    if (route === 'local') {
      introPrivacyCopy.textContent = 'I am using Chrome\'s on-device model for answers. Ask me to summarize syllabus policies, analyze assignment guidelines, or extract the tasks on this page.';
      privacyRouteLabel.textContent = 'On-device - Chrome Prompt API';
      return;
    }

    if (route === 'cloud') {
      introPrivacyCopy.textContent = 'Cloud fallback is active. Canvascope sends the retrieved prompt context to your authenticated Supabase AI endpoint for answers.';
      privacyRouteLabel.textContent = 'Cloud fallback - Supabase Gemini';
      return;
    }

    if (route === 'downloadable') {
      introPrivacyCopy.textContent = 'Chrome can set up the on-device model. Send your first question to start local AI setup, then Canvascope will answer from page and course context.';
      privacyRouteLabel.textContent = 'Local model setup required';
      return;
    }

    if (route === 'auth-required') {
      introPrivacyCopy.textContent = 'Local AI is unavailable in this browser. Sign in from the Canvascope popup to use cloud fallback.';
      privacyRouteLabel.textContent = 'AI unavailable until sign-in';
      return;
    }

    introPrivacyCopy.textContent = 'I use on-device AI when Chrome\'s local model is available. If cloud fallback is active, Canvascope will say so before sending prompt context.';
    privacyRouteLabel.textContent = 'Checking AI route';
  }

  /** Map an AIRouter state onto the status badge + privacy strip + bubbles. */
  function reflectRouteState(state, { announce = false } = {}) {
    if (state.mode === 'local' && state.ready) {
      updateUIStatus('ready', 'Ready');
      updatePrivacyRoute('local');
    } else if (state.mode === 'cloud' && state.ready) {
      updateUIStatus('cloud', 'Cloud AI Fallback');
      updatePrivacyRoute('cloud');
      if (announce) addSystemBubble('**Cloud fallback active**: Canvascope is routing AI requests securely through your Supabase account.');
    } else if (state.mode === 'local-download') {
      updateUIStatus('checking', state.availability === 'downloading' ? 'Model Downloading' : 'Model Ready to Download');
      updatePrivacyRoute('downloadable');
      if (announce) addSystemBubble('**Local model setup required**: Send your first question to start Chrome\'s on-device model download and session setup. If setup fails, Canvascope can use cloud fallback after sign-in.');
    } else {
      updateUIStatus('error', 'Auth Required');
      updatePrivacyRoute('auth-required');
      if (announce) addSystemBubble('**Login required for AI fallback**: The local model is unavailable on this browser. Sign in from the Canvascope popup to use cloud fallback.');
    }
    refreshSendState();
  }

  /**
   * Bootstraps the shared AI route (capability check + session/cloud pick).
   */
  async function bootstrapAIRoute() {
    updateUIStatus('checking', 'Initializing...');
    updatePrivacyRoute('checking');

    const state = await AIRouter.init(SYSTEM_INSTRUCTION);
    reflectRouteState(state, { announce: true });
    detectActiveCourseContext();
    consumeSidepanelIntent();
  }

  /**
   * Updates the top-right AI Model status indicator.
   */
  function updateUIStatus(state, labelText) {
    aiStatusBadge.className = `ai-status-badge status-${state}`;
    statusText.textContent = labelText;
  }

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
      setSuggestLabel(suggestButtons[0], "Summarize PDF Document", "Provide a comprehensive summary of this active PDF document.");
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

  async function ensureSessionForSubmit() {
    const state = routeState();
    if (state.ready) return true;
    if (state.mode !== 'local-download') return false;

    updateUIStatus('checking', 'Starting Local AI');
    const setupBubble = addSystemBubble('**Starting local AI setup...** Chrome may need to download the on-device model before answering.');
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
        setupContent.innerHTML = parseSimpleMarkdown('**Local AI ready**: Canvascope will answer using Chrome\'s on-device model.');
      }
      reflectRouteState(result);
      return true;
    }

    if (result.ok && result.mode === 'cloud') {
      if (setupContent) {
        setupContent.innerHTML = parseSimpleMarkdown('**Cloud fallback active**: Local AI setup failed, so Canvascope is routing AI requests through your authenticated Supabase AI endpoint.');
      }
      reflectRouteState(result);
      return true;
    }

    reflectRouteState(result, { announce: true });
    return false;
  }

  /**
   * Main submit orchestrator. Routes to the active view's flow.
   */
  async function handleSubmit() {
    const prompt = userPrompt.value.trim();
    if (!prompt) return;

    const ready = await ensureSessionForSubmit();
    if (!ready) {
      refreshSendState();
      return;
    }

    // 1. Reset text area
    userPrompt.value = '';
    userPrompt.style.height = 'auto';
    sendBtn.disabled = true;

    // Brain view: course-wide cited answer, handled by its module.
    if (activeView === 'brain' && window.CourseBrain) {
      try {
        await window.CourseBrain.ask(prompt);
      } finally {
        refreshSendState();
      }
      return;
    }

    // 2. Append User Bubble
    appendBubble('student', '', prompt);

    // 3. Create Assistant Stream Bubble
    const aiBubble = appendBubble('assistant', '', '');
    const bubbleContent = aiBubble.querySelector('.bubble-content');

    // Add streaming loader
    const loader = document.createElement('div');
    loader.className = 'stream-loader';
    loader.innerHTML = `
      <div class="stream-dot"></div>
      <div class="stream-dot"></div>
      <div class="stream-dot"></div>
    `;
    bubbleContent.appendChild(loader);
    scrollViewport();

    // 4 & 5. Compile Prompt with Context (Dual-Source RAG Pipeline)
    let fullPrompt = prompt;
    try {
      fullPrompt = await RAGCore.compileRAGPrompt(prompt);
    } catch (e) {
      console.warn('[Canvascope AI] RAG Context compilation failed, falling back to raw prompt:', e);
    }

    // 6. Execute Streaming (AIRouter normalizes chunks to deltas)
    let fullResponse = '';
    try {
      for await (const delta of AIRouter.stream(fullPrompt, { system: SYSTEM_INSTRUCTION })) {
        // Clear loader on first token
        if (bubbleContent.querySelector('.stream-loader')) {
          bubbleContent.innerHTML = '';
        }
        fullResponse += delta;
        bubbleContent.innerHTML = parseSimpleMarkdown(fullResponse);
        scrollViewport();
      }
    } catch (err) {
      console.error('[Canvascope AI] Streaming execution error:', err);
      if (bubbleContent.querySelector('.stream-loader')) {
        bubbleContent.innerHTML = '';
      }
      if (fullResponse) {
        // Append error warning instead of wiping the entire generated response
        bubbleContent.innerHTML = parseSimpleMarkdown(fullResponse) +
          `<p style="color: var(--status-error); margin-top: 8px; font-style: italic;">Streaming interrupted: ${err.message || err}</p>`;
      } else {
        bubbleContent.innerHTML = `<span style="color: var(--status-error)">Error: Failed to complete streaming prompt. ${err.message || err}</span>`;
      }
      scrollViewport();
    } finally {
      refreshSendState();
    }
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

  /**
   * A super simple markdown parser helper to render bold, list items, code snippets, and linebreaks.
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
});
