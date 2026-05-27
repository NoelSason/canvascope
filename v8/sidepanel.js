/**
 * Canvascope AI Sidepanel Controller
 * Handles UI interactions, local model lifecycle, and RAG context compilation.
 */
document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.status-text');
  const aiStatusBadge = document.getElementById('ai-status');
  const contextLabel = document.getElementById('active-context-label');
  const chatHistory = document.getElementById('chat-history');
  const chatViewport = document.querySelector('.chat-viewport');
  const userPrompt = document.getElementById('user-prompt');
  const sendBtn = document.getElementById('send-btn');
  const suggestButtons = document.querySelectorAll('.btn-suggest');

  // Initialize the Local AI Controller
  const aiController = new LocalAIController();
  let aiSessionReady = false;
  let aiMode = null; // 'local' | 'cloud'

  const SYSTEM_INSTRUCTION = `You are the Canvascope study assistant running inside a Chrome extension. Below each question you receive context drawn from the student's own saved data and the page they are viewing.

How to use the context:
- The sections "THE STUDENT'S TASKS & DEADLINES", "RELEVANT COURSE DETAILS", and "ACTIVE PDF DOCUMENT PAGES" are the student's authoritative personal records. Answer directly and confidently from them.
- For questions about tasks, readings, assignments, exams, or deadlines, answer from the tasks/deadlines list. Match items by topic and keywords — e.g. "cs reading" or "next reading" matches a task titled "Finish reading RAG paper". Do NOT require the course code to match the page being viewed, and never refuse just because a course number (e.g. CS 101 vs CS 61B) differs from the active page.
- If one listed item plausibly matches the question, give its title, course, and due date. If several match, briefly list them.
- Only say the information isn't available when the relevant section is genuinely empty or contains nothing related to the question.
- When answering from an ACTIVE PDF DOCUMENT, ground your answer in the page text provided and cite page numbers when useful.

Style: concise (2-4 sentences or a short list). Use bold text, inline code backticks, and lists where appropriate.`;

  // 1. Sync Theme Styling Custom Skins
  syncSkinTheme();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.canvasSkin) {
      applySkinTokens(changes.canvasSkin.newValue);
    }
  });

  // 2. Initialize and bootstrap the local model
  bootstrapLocalAI();

  // 2.2 Listen for active tab activation and page completion to update context dynamically
  chrome.tabs.onActivated.addListener(() => detectActiveCourseContext());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
      detectActiveCourseContext();
    }
  });

  // 2.1 Pull the latest Supabase-synced study data (todos, notes) into local
  // storage so the RAG context reflects items added on other devices. Todos are
  // stored local-first in chrome.storage.local and mirrored to Supabase
  // (user_custom_todos); this merge is best-effort and silently no-ops when the
  // user is signed out or offline.
  try {
    chrome.runtime.sendMessage({ action: 'csTools.pull' }, () => { void chrome.runtime.lastError; });
  } catch (_) { /* ignore */ }

  // 3. Setup TextArea Auto-Resize & Enter key triggers
  userPrompt.addEventListener('input', () => {
    userPrompt.style.height = 'auto';
    userPrompt.style.height = `${userPrompt.scrollHeight}px`;
    sendBtn.disabled = !userPrompt.value.trim() || !aiSessionReady;
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
      if (!prompt) return; // ignore seed button here
      userPrompt.value = prompt;
      userPrompt.style.height = 'auto';
      userPrompt.style.height = `${userPrompt.scrollHeight}px`;
      sendBtn.disabled = false;
      handleSubmit();
    });
  });

  // 4.2 Setup Seed Developer Button
  const seedBtn = document.getElementById('btn-seed-test');
  if (seedBtn) {
    seedBtn.addEventListener('click', async () => {
      try {
        const data = await chrome.storage.local.get(['customTodos']);
        const todos = data.customTodos || [];
        const testTodo = {
          id: 'todo_test_rag_123',
          title: 'Finish reading RAG paper',
          dueAt: new Date(Date.now() + 86400000 * 3).toISOString(), // Due in 3 days
          courseName: 'CS 101',
          done: false,
          createdAt: Date.now()
        };
        // Avoid duplicates
        if (!todos.some(t => t.id === testTodo.id)) {
          todos.push(testTodo);
          await chrome.storage.local.set({ customTodos: todos });
        }
        
        // Confirm write by reading again
        const check = await chrome.storage.local.get(['customTodos']);
        const currentTodos = check.customTodos || [];
        
        addSystemBubble(`**Mock task seeded**: Added \`"Finish reading RAG paper"\` (CS 101, due in 3 days) to storage.\n\n**Current tasks in storage:**\n\`\`\`json\n${JSON.stringify(currentTodos, null, 2)}\n\`\`\`\n\nTry asking: *"When do I need to finish reading the rag paper by?"*`);
      } catch (e) {
        addSystemBubble('**Failed to seed task**: ' + e.message);
      }
    });
  }

  // 4.3 Setup "Send PDF to Lectra" button — sends the PDF detected on the
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
   * Automatically queries Canvascope storage and applies theme variables.
   */
  async function syncSkinTheme() {
    try {
      const { canvasSkin } = await chrome.storage.local.get(['canvasSkin']);
      if (canvasSkin) {
        applySkinTokens(canvasSkin);
      }
    } catch (e) {
      console.warn('[Canvascope AI] Failed to query active skin theme:', e);
    }
  }

  /**
   * Applies individual skin variables directly into the document root.
   */
  function applySkinTokens(skin) {
    const t = resolveSkinTokens(skin);
    if (!t) return;
    const root = document.documentElement;

    console.log('[Canvascope AI] Synchronizing visual skin theme:', skin.name || skin.id);

    // Map custom skin tokens to the sidepanel design variables.
    if (t.bg) root.style.setProperty('--cs-bg', t.bg);
    if (t.bgSoft) root.style.setProperty('--cs-bg-1', t.bgSoft);
    if (t.surface) root.style.setProperty('--cs-bg-2', t.surface);
    if (t.surface2) root.style.setProperty('--cs-bg-3', t.surface2);
    if (t.text) root.style.setProperty('--cs-text', t.text);
    if (t.textDim) root.style.setProperty('--cs-text-2', t.textDim);
    if (t.muted) root.style.setProperty('--cs-text-3', t.muted);
    if (t.border) root.style.setProperty('--cs-border', t.border);
    if (t.borderHi) root.style.setProperty('--cs-border-hi', t.borderHi);
    
    if (t.accent) {
      root.style.setProperty('--cs-accent', t.accent);
      root.style.setProperty('--cs-accent-hi', adjustColorBrightness(t.accent, 18));
      root.style.setProperty('--cs-accent-sat', adjustColorBrightness(t.accent, -12));
    }
    if (t.accentText) {
      root.style.setProperty('--cs-on-accent', t.accentText);
    }
  }

  function resolveSkinTokens(skin) {
    if (!skin || typeof skin !== 'object') return null;
    if (skin.tokens && typeof skin.tokens === 'object') return skin.tokens;

    const themesApi = window.CanvascopeSkinThemes;
    if (!themesApi) return null;

    let mode = skin.mode;
    if (mode === 'system' || skin.followSystem) {
      mode = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    let theme = themesApi.getTheme(skin.themeId || 'canvas-default') || themesApi.getTheme('canvas-default');
    if (mode === 'dark' && theme?.mode !== 'dark') theme = themesApi.getTheme('dim') || theme;
    if (mode === 'light' && theme?.mode !== 'light') theme = themesApi.getTheme('canvas-default') || theme;

    const normalized = themesApi.normalizeTheme({
      ...theme,
      tokens: {
        ...(theme?.tokens || {}),
        ...(skin.customTokens || {})
      }
    });

    return normalized.tokens;
  }

  function adjustColorBrightness(hex, percent) {
    hex = hex.replace(/^#/, '');
    let R = parseInt(hex.substring(0, 2), 16);
    let G = parseInt(hex.substring(2, 4), 16);
    let B = parseInt(hex.substring(4, 6), 16);

    R = parseInt(R * (100 + percent) / 100);
    G = parseInt(G * (100 + percent) / 100);
    B = parseInt(B * (100 + percent) / 100);

    R = (R < 255) ? R : 255;
    G = (G < 255) ? G : 255;
    B = (B < 255) ? B : 255;

    const rHex = R.toString(16).padStart(2, '0');
    const gHex = G.toString(16).padStart(2, '0');
    const bHex = B.toString(16).padStart(2, '0');

    return `#${rHex}${gHex}${bHex}`;
  }

  /**
   * Bootstraps the local Prompt API model capability check and session loading.
   */
  async function bootstrapLocalAI() {
    updateUIStatus('checking', 'Initializing...');

    const availability = await aiController.checkCapabilities();

    if (availability === 'unavailable') {
      console.log('[Canvascope AI] Local AI unavailable. Checking authentication for cloud fallback...');
      
      const authRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'checkAuthStatus' }, (response) => {
          resolve(response || { signedIn: false });
        });
      });

      if (authRes.signedIn) {
        updateUIStatus('cloud', 'Cloud AI Fallback');
        aiMode = 'cloud';
        aiSessionReady = true;
        sendBtn.disabled = !userPrompt.value.trim();
        detectActiveCourseContext();
        
        addSystemBubble('**Cloud fallback active**: Canvascope is routing AI requests securely through your Supabase account.');
      } else {
        updateUIStatus('error', 'Auth Required');
        addSystemBubble('**Login required for AI fallback**: The local model is unavailable on this browser. Sign in from the Canvascope popup to use cloud fallback.');
      }
      return;
    }

    if (availability === 'after-download') {
      updateUIStatus('checking', 'Downloading Model...');
      addSystemBubble('**Model download required**: Your browser is downloading the local model in the background. Try again in a minute.');
      
      // Setup polling interval to wait for download to finish
      const pollInterval = setInterval(async () => {
        const check = await aiController.checkCapabilities();
        if (check === 'available') {
          clearInterval(pollInterval);
          loadSession();
        }
      }, 5000);
      return;
    }

    // Load session immediately if ready
    loadSession();
  }

  async function loadSession() {
    updateUIStatus('checking', 'Starting session...');
    
    const success = await aiController.initSession(SYSTEM_INSTRUCTION);

    if (success) {
      updateUIStatus('ready', 'Ready');
      aiSessionReady = true;
      aiMode = 'local';
      sendBtn.disabled = !userPrompt.value.trim();
      detectActiveCourseContext();
    } else {
      updateUIStatus('error', 'Session Failed');
      addSystemBubble('**Failed to start AI session**: The browser failed to initialize the model container. Try restarting Chrome or clearing the extensions tab.');
    }
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

  /**
   * Main submit orchestrator. Grabs prompt, executes scrape, sends context, and streams text.
   */
  async function handleSubmit() {
    const prompt = userPrompt.value.trim();
    if (!prompt || !aiSessionReady) return;

    // 1. Reset text area
    userPrompt.value = '';
    userPrompt.style.height = 'auto';
    sendBtn.disabled = true;

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

    // 6. Execute Streaming
    let fullResponse = '';
    try {
      const stream = aiMode === 'cloud'
        ? aiController.streamSupabaseProxy(fullPrompt, SYSTEM_INSTRUCTION)
        : aiController.promptStream(fullPrompt);

      for await (const chunk of stream) {
        // Clear loader on first token
        if (bubbleContent.querySelector('.stream-loader')) {
          bubbleContent.innerHTML = '';
        }
        
        // Handle both delta and accumulated streaming chunk types gracefully
        if (fullResponse && chunk.startsWith(fullResponse)) {
          fullResponse = chunk; // Accumulated chunk
        } else {
          fullResponse += chunk; // Delta chunk
        }
        
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
      sendBtn.disabled = !userPrompt.value.trim();
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
