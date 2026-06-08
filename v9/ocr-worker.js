/**
 * Canvascope OCR Controller (v9)
 * Handles offline-friendly image text extraction using Tesseract.js.
 * Invoked by Sidepanel page or background messaging to process canvas/image data URLs,
 * bypassing host website CSP limitations.
 */
class OCRController {
  constructor() {
    this.worker = null;
    this.loading = false;
    this.initialized = false;
  }

  /**
   * Initializes the Tesseract.js worker with English language data.
   */
  async initWorker() {
    if (this.initialized || this.loading) return;
    this.loading = true;
    console.log('[Canvascope OCR] Initializing Tesseract worker...');
    try {
      // Tesseract is bundled locally (lib/tesseract/tesseract.min.js loaded via <script>).
      // MV3's CSP (script-src 'self') forbids remote code, so the worker, core (wasm), and
      // language data are all served from the extension package — nothing is fetched off-CDN.
      const Tesseract = (typeof window !== 'undefined' && window.Tesseract) ||
                        (typeof globalThis !== 'undefined' && globalThis.Tesseract);

      if (!Tesseract || typeof Tesseract.createWorker !== 'function') {
        throw new Error('Tesseract library not loaded — expected lib/tesseract/tesseract.min.js');
      }

      const base = chrome.runtime.getURL('lib/tesseract/');
      this.worker = await Tesseract.createWorker('eng', 1, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
        langPath: `${base}lang`,
        workerBlobURL: false,
      });
      this.initialized = true;
      console.log('[Canvascope OCR] Tesseract worker initialized successfully (local assets).');
    } catch (e) {
      console.error('[Canvascope OCR] Failed to initialize Tesseract worker:', e);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Runs OCR text recognition on an image data URL or canvas.
   * @param {string|HTMLCanvasElement} image - Image data URL or canvas element
   * @returns {Promise<string>} Extracted text
   */
  async recognize(image) {
    if (!image) return '';
    
    // Ensure worker is loaded
    if (!this.initialized) {
      await this.initWorker();
    }

    if (!this.worker) {
      console.warn('[Canvascope OCR] Worker is not available, skipping OCR recognition.');
      return '';
    }

    try {
      console.log('[Canvascope OCR] Processing image text extraction...');
      const result = await this.worker.recognize(image);
      const text = result?.data?.text || '';
      console.log(`[Canvascope OCR] Extraction complete. Characters found: ${text.length}`);
      return text.trim();
    } catch (err) {
      console.error('[Canvascope OCR] Recognition error:', err);
      return '';
    }
  }

  /**
   * Terminate worker to free memory when idle.
   */
  async terminate() {
    if (this.worker) {
      try {
        await this.worker.terminate();
        console.log('[Canvascope OCR] Worker terminated successfully.');
      } catch (e) {
        console.warn('[Canvascope OCR] Error terminating worker:', e);
      }
      this.worker = null;
      this.initialized = false;
    }
  }
}

// Instantiate globally on side panel/extension scopes
if (typeof window !== 'undefined') {
  window.CanvascopeOCR = new OCRController();

  // Add message listener for content-script delegation
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'canvascope-ocr-request') {
      (async () => {
        try {
          const text = await window.CanvascopeOCR.recognize(message.imageData);
          sendResponse({ success: true, text });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true; // Keep message channel open for async response
    }
  });
}
