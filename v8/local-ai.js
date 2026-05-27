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
   * @param {function} onDownloadProgress - Callback to track model downloading state
   * @returns {Promise<string>} 'available' | 'after-download' | 'unavailable'
   */
  async checkCapabilities(onDownloadProgress) {
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
          availability = availability.available; // 'readily' or 'after-download' or 'no'
        }
      }

      console.log('[Canvascope AI] Model availability status:', availability);

      if (availability === 'readily' || availability === 'available') {
        return 'available';
      } else if (availability === 'after-download') {
        return 'after-download';
      }

      return 'unavailable';
    } catch (error) {
      console.error('[Canvascope AI] Capability check failed:', error);
      return 'unavailable';
    }
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
      temperature: 0.6,
      topK: 4
    };

    if (systemPrompt) {
      expectedOptions.initialPrompts = [{ role: 'system', content: systemPrompt }];
    }

    if (onDownloadProgress) {
      expectedOptions.monitor = (m) => {
        m.addEventListener('downloadprogress', (e) => {
          const pct = e.total ? Math.floor((e.loaded / e.total) * 100) : 0;
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
