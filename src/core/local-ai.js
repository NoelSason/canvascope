/**
 * Canvascope Offline AI Controller (Local Gemini Nano)
 * Wraps Chrome's Prompt API (LanguageModel) with capability detection and error fallbacks.
 */
class LocalAIController {
  constructor() {
    this.session = null;
    this.apiSurface = null; // 'LanguageModel' or 'self.ai.languageModel' or null
    this.modelParams = null;
    this.detectApiSurface();
  }

  /**
   * Auto-detect the Prompt API namespace. Handles Chrome 138+ stable as well as earlier experimental builds.
   */
  detectApiSurface() {
    if (typeof globalThis.LanguageModel !== 'undefined') {
      this.apiSurface = 'LanguageModel';
      console.log('[Canvascope AI] Detected stable LanguageModel namespace');
    } else if (typeof self !== 'undefined' && self.ai && self.ai.languageModel) {
      this.apiSurface = 'self.ai.languageModel';
      console.log('[Canvascope AI] Detected experimental self.ai.languageModel namespace');
    } else {
      this.apiSurface = null;
      console.warn('[Canvascope AI] Prompt API is unavailable in this environment');
    }
  }

  /**
   * Checks model availability and capabilities.
   * @returns {Promise<string>} 'available' | 'downloadable' | 'downloading' | 'unavailable'
   */
  async checkCapabilities() {
    if (!this.apiSurface) return 'unavailable';

    try {
      // 1. Resolve params (Constraints check)
      if (this.apiSurface === 'LanguageModel') {
        try {
          this.modelParams = await LanguageModel.params();
          console.log('[Canvascope AI] Resolved model parameters:', this.modelParams);
        } catch (e) {
          console.warn('[Canvascope AI] Could not query parameters:', e);
        }
      }

      // 2. Resolve availability
      let availability = 'unavailable';
      const expectedOptions = {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }]
      };

      if (this.apiSurface === 'LanguageModel') {
        availability = await LanguageModel.availability(expectedOptions);
      } else {
        availability = await self.ai.languageModel.capabilities();
        // Translate capabilities format if necessary
        if (availability && availability.available) {
          availability = availability.available;
        }
      }

      console.log('[Canvascope AI] Model availability status:', availability);
      return this.normalizeAvailability(availability);
    } catch (error) {
      console.error('[Canvascope AI] Capability check failed:', error);
      return 'unavailable';
    }
  }

  /**
   * Normalizes current Chrome Prompt API statuses plus older experimental names.
   * @param {string|object|boolean} rawAvailability
   * @returns {'available'|'downloadable'|'downloading'|'unavailable'}
   */
  normalizeAvailability(rawAvailability) {
    let value = rawAvailability;
    if (value && typeof value === 'object' && 'available' in value) {
      value = value.available;
    }
    if (value === true) return 'available';
    if (value === false || value == null) return 'unavailable';

    const normalized = String(value).toLowerCase();
    if (normalized === 'available' || normalized === 'readily') {
      return 'available';
    }
    if (normalized === 'downloadable' || normalized === 'after-download') {
      return 'downloadable';
    }
    if (normalized === 'downloading') {
      return 'downloading';
    }
    return 'unavailable';
  }

  /**
   * Initializes a new session.
   * @param {string} systemPrompt - Guidelines to instruct the AI behavior
   * @param {function} onDownloadProgress - Callback to display download/initialization percentage
   * @returns {Promise<boolean>} Success state
   */
  async initSession(systemPrompt = '', onDownloadProgress = null) {
    if (this.session) {
      this.destroySession();
    }

    const expectedOptions = {
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      temperature: this.resolveTemperature(),
      topK: this.resolveTopK()
    };

    if (systemPrompt) {
      expectedOptions.initialPrompts = [{ role: 'system', content: systemPrompt }];
    }

    if (onDownloadProgress) {
      expectedOptions.monitor = (m) => {
        m.addEventListener('downloadprogress', (e) => {
          const pct = e.total
            ? Math.floor((e.loaded / e.total) * 100)
            : Math.floor((e.loaded || 0) * 100);
          onDownloadProgress(pct);
        });
      };
    }

    try {
      if (this.apiSurface === 'LanguageModel') {
        this.session = await LanguageModel.create(expectedOptions);
      } else if (this.apiSurface === 'self.ai.languageModel') {
        this.session = await self.ai.languageModel.create(expectedOptions);
      }

      console.log('[Canvascope AI] Local AI Session initialized successfully');
      return true;
    } catch (err) {
      console.error('[Canvascope AI] Session creation failed:', err);
      return false;
    }
  }

  resolveTemperature() {
    const fallback = 0.6;
    const max = Number(this.modelParams?.maxTemperature);
    if (Number.isFinite(max) && max > 0) {
      return Math.min(fallback, max);
    }
    return fallback;
  }

  resolveTopK() {
    const fallback = 4;
    const max = Number(this.modelParams?.maxTopK);
    if (Number.isFinite(max) && max > 0) {
      return Math.max(1, Math.min(fallback, Math.floor(max)));
    }
    return fallback;
  }

  /**
   * Sends a prompt and yields streaming response text.
   * @param {string} promptText - The user prompt
   * @yields {string} Chunked text stream output
   */
  async *promptStream(promptText) {
    if (!this.session) {
      throw new Error('Local AI Session is not initialized. Call initSession first.');
    }

    try {
      const stream = this.session.promptStreaming(promptText);
      for await (const chunk of stream) {
        yield chunk;
      }
    } catch (error) {
      console.error('[Canvascope AI] Streaming execution error:', error);
      throw error;
    }
  }

  /**
   * Queries the Supabase AI proxy Edge Function to stream Gemini 1.5 Flash responses.
   * Used as a fallback when the browser lacks local Gemini Nano capabilities.
   * @param {string} promptText - The user prompt
   * @param {string} systemInstruction - Instructions to direct the AI behavior
   * @yields {string} Chunked text stream output
   */
  async *streamSupabaseProxy(promptText, systemInstruction = '') {
    // 1. Fetch active Supabase token from the background script
    const authRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getSupabaseSession' }, (response) => {
        resolve(response || { success: false, error: 'No response from background script' });
      });
    });

    if (!authRes.success || !authRes.accessToken) {
      throw new Error(authRes.error || 'You must be signed in to use the Cloud AI Fallback.');
    }

    // 2. Query the Supabase Edge Function
    const proxyUrl = 'https://vcadcdgnwxjlgaoqktkd.supabase.co/functions/v1/gemini-proxy';
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authRes.accessToken}`
      },
      body: JSON.stringify({
        prompt: promptText,
        systemInstruction
      })
    });

    if (!response.ok) {
      let errorMessage = `Server responded with status ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch (_) {}
      throw new Error(errorMessage);
    }

    if (promptText === '__listModels__' || promptText.endsWith('__listModels__')) {
      try {
        const listData = await response.json();
        yield '### Available Models:\n```json\n' + JSON.stringify(listData, null, 2) + '\n```';
      } catch (e) {
        yield 'Failed to parse list models data: ' + e.message;
      }
      return;
    }

    if (!response.body) {
      throw new Error('No response body returned from cloud AI service.');
    }

    // 3. Process the stream character-by-character/object-by-object
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let openBraces = 0;
    let startIndex = -1;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse JSON objects safely out of the stream buffer
        let i = 0;
        while (i < buffer.length) {
          const char = buffer[i];
          if (char === '{') {
            if (openBraces === 0) {
              startIndex = i;
            }
            openBraces++;
          } else if (char === '}') {
            openBraces--;
            if (openBraces === 0 && startIndex !== -1) {
              const jsonStr = buffer.substring(startIndex, i + 1);
              try {
                const parsed = JSON.parse(jsonStr);
                const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  yield text;
                }
              } catch (e) {
                console.warn('[Canvascope AI] Failed to parse stream sub-JSON fragment:', e);
              }
              buffer = buffer.substring(i + 1);
              i = -1; // Reset scanner index for updated buffer
              startIndex = -1;
            }
          }
          i++;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Streams an answer from the claude-proxy Edge Function (Claude Fable 5).
   * `corpus` is the byte-stable course corpus that the proxy marks for prompt
   * caching, so repeat questions in a session reuse it at ~10% input price.
   * Yields text deltas parsed from the Anthropic SSE stream.
   */
  async *streamClaudeProxy(promptText, systemInstruction = '', corpus = '', maxTokens = 4096) {
    // 1. Fetch active Supabase token from the background script
    const authRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getSupabaseSession' }, (response) => {
        resolve(response || { success: false, error: 'No response from background script' });
      });
    });

    if (!authRes.success || !authRes.accessToken) {
      throw new Error(authRes.error || 'You must be signed in to use Course Brain cloud answers.');
    }

    // 2. Query the Supabase Edge Function
    const proxyUrl = 'https://vcadcdgnwxjlgaoqktkd.supabase.co/functions/v1/claude-proxy';
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authRes.accessToken}`
      },
      body: JSON.stringify({
        prompt: promptText,
        system: systemInstruction,
        corpus,
        maxTokens
      })
    });

    if (!response.ok) {
      let errorMessage = `Server responded with status ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch (_) {}
      throw new Error(errorMessage);
    }

    if (!response.body) {
      throw new Error('No response body returned from cloud AI service.');
    }

    // 3. Parse Anthropic SSE: text arrives as content_block_delta events
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.substring(0, newlineIndex).trim();
          buffer = buffer.substring(newlineIndex + 1);

          if (!line.startsWith('data:')) continue;
          const data = line.substring(5).trim();
          if (!data || data === '[DONE]') continue;

          let event;
          try {
            event = JSON.parse(data);
          } catch (e) {
            console.warn('[Canvascope AI] Failed to parse Claude SSE fragment:', e);
            continue;
          }

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            yield event.delta.text;
          } else if (event.type === 'error') {
            throw new Error(event.error?.message || 'Claude stream reported an error.');
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Destroys active session to release memory.
   */
  destroySession() {
    if (this.session) {
      try {
        this.session.destroy();
        console.log('[Canvascope AI] Local AI Session destroyed successfully');
      } catch (e) {
        console.warn('[Canvascope AI] Error destroying session:', e);
      }
      this.session = null;
    }
  }
}
