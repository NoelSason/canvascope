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

  // 1. Sync Theme Styling Custom Skins
  syncSkinTheme();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.canvasSkin) {
      applySkinTokens(changes.canvasSkin.newValue);
    }
  });

  // 2. Initialize and Bootstrap local Gemini Nano
  bootstrapLocalAI();

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
      userPrompt.value = prompt;
      userPrompt.style.height = 'auto';
      userPrompt.style.height = `${userPrompt.scrollHeight}px`;
      sendBtn.disabled = false;
      handleSubmit();
    });
  });

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
    if (!skin || !skin.tokens) return;
    const t = skin.tokens;
    const root = document.documentElement;

    console.log('[Canvascope AI] Synchronizing visual skin theme:', skin.name || skin.id);

    // Map custom skin tokens to our css variables
    if (t.bg) root.style.setProperty('--cs-bg-base', t.bg);
    if (t.bgSoft) root.style.setProperty('--cs-bg-soft', t.bgSoft);
    if (t.surface) root.style.setProperty('--cs-surface', `rgba(${hexToRgb(t.surface)}, 0.75)`);
    if (t.text) root.style.setProperty('--cs-text-main', t.text);
    if (t.textDim) root.style.setProperty('--cs-text-dim', t.textDim);
    if (t.border) root.style.setProperty('--cs-border', t.border);
    if (t.borderHi) root.style.setProperty('--cs-border-hi', t.borderHi);
    
    if (t.accent) {
      root.style.setProperty('--cs-accent-color', t.accent);
      root.style.setProperty('--cs-accent-gradient', `linear-gradient(135deg, ${t.accent}, ${adjustColorBrightness(t.accent, -20)})`);
      root.style.setProperty('--cs-accent-glow', `rgba(${hexToRgb(t.accent)}, 0.3)`);
    }
  }

  function hexToRgb(hex) {
    hex = hex.replace(/^#/, '');
    if (hex.length === 3) {
      hex = hex.split('').map(char => char + char).join('');
    }
    const num = parseInt(hex, 16);
    return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
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
      updateUIStatus('error', 'Unsupported');
      addSystemBubble('⚠️ **Prompt API Unavailable**: Local Gemini Nano is not enabled in your browser. Ensure you are running Chrome 138+ with standard AI capabilities enabled in `chrome://flags/#optimization-guide-on-device-model`.');
      return;
    }

    if (availability === 'after-download') {
      updateUIStatus('checking', 'Downloading Model...');
      addSystemBubble('⬇️ **Model Download Required**: Your browser is currently downloading the local Gemini Nano model. This happens automatically in the background. Please wait a minute before starting your session.');
      
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

  /**
   * Creates a dedicated local session with initial system instructions.
   */
  async function loadSession() {
    updateUIStatus('checking', 'Starting session...');
    
    const systemPrompt = `You are a helpful, offline academic study assistant running local-first in the Canvascope Chrome extension.
Answer queries concisely and explain complex topics in 2-3 structured sentences. Use bold text, inline code backticks, or lists where appropriate.
If context is provided, use it directly to answer. Otherwise, respond using your core knowledge base.`;

    const success = await aiController.initSession(systemPrompt);

    if (success) {
      updateUIStatus('ready', 'Gemini Nano Ready');
      aiSessionReady = true;
      sendBtn.disabled = !userPrompt.value.trim();
      detectActiveCourseContext();
    } else {
      updateUIStatus('error', 'Session Failed');
      addSystemBubble('❌ **Failed to start AI Session**: The browser guide failed to initialize the model container. Try restarting Chrome or clearing your extensions tab.');
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
      if (!tab) {
        contextLabel.textContent = 'Open LMS Tab to Sync Context';
        return;
      }

      // Check supported LMS domains
      const url = tab.url || '';
      const isLms = url.includes('instructure.com') || 
                    url.includes('brightspace.com') || 
                    url.includes('d2l.com') ||
                    url.includes('berkeley.edu') || 
                    url.includes('ucla.edu') || 
                    url.includes('ucsd.edu') || 
                    url.includes('mit.edu') ||
                    url.includes('asu.edu');

      if (!isLms) {
        contextLabel.textContent = 'Active outside LMS portal';
        return;
      }

      // Sync active context details
      let contextName = 'Active course context';
      if (tab.title) {
        // Strip common Canvas prefixes/suffixes to keep label compact
        contextName = tab.title.split(':').pop().split('|')[0].trim();
      }
      contextLabel.textContent = `Attached: ${contextName}`;
    } catch (e) {
      contextLabel.textContent = 'Attached: General Context';
    }
  }

  /**
   * Helper to append a system message block.
   */
  function addSystemBubble(markdownText) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble bubble-system animate-fade-in';
    bubble.innerHTML = `
      <div class="bubble-avatar">⚙️</div>
      <div class="bubble-content">${parseSimpleMarkdown(markdownText)}</div>
    `;
    chatHistory.appendChild(bubble);
    scrollViewport();
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
    appendBubble('student', '👤', prompt);

    // 3. Create Assistant Stream Bubble
    const aiBubble = appendBubble('assistant', '🤖', '');
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

    // 4. Scrape active page text to inject as local-first context
    let activePageContext = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Clones body to safely strip non-essential nodes
            const body = document.body.cloneNode(true);
            body.querySelectorAll('script, style, nav, footer, header, #canvascope-slash-root').forEach(el => el.remove());
            return body.innerText.substring(0, 3000); // Grab a sensible chunk
          }
        });
        activePageContext = result || '';
      }
    } catch (e) {
      console.log('[Canvascope AI] Scraper context fetch skipped or unavailable:', e);
    }

    // 5. Compile Prompt with Context
    let fullPrompt = '';
    if (activePageContext) {
      fullPrompt = `=== CONTEXT FROM THE ACTIVE PAGE ===
${activePageContext}

=== QUESTION ===
Using the page context above, answer the student's request: ${prompt}`;
    } else {
      fullPrompt = prompt;
    }

    // 6. Execute Streaming
    try {
      let fullResponse = '';
      const stream = aiController.promptStream(fullPrompt);

      for await (const chunk of stream) {
        // Clear loader on first token
        if (bubbleContent.querySelector('.stream-loader')) {
          bubbleContent.innerHTML = '';
        }
        fullResponse = chunk; // Prompt API streaming chunks are additive
        bubbleContent.innerHTML = parseSimpleMarkdown(fullResponse);
        scrollViewport();
      }
    } catch (err) {
      if (bubbleContent.querySelector('.stream-loader')) {
        bubbleContent.innerHTML = '';
      }
      bubbleContent.innerHTML = `<span style="color: var(--status-error)">⚠️ **Error**: Failed to complete streaming prompt. The local model session was interrupted.</span>`;
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
    bubble.innerHTML = `
      <div class="bubble-avatar">${avatar}</div>
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
