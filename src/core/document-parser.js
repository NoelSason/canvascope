/**
 * Canvascope Document Parser
 * Fetches and extracts text page-by-page from local or LMS PDFs using pdf.js,
 * caching results and ranking page relevance to enforce Nano context limits.
 */
class DocumentParser {
  /**
   * Parses text content of a PDF file array buffer.
   * @param {ArrayBuffer} arrayBuffer - The PDF binary buffer
   * @returns {Promise<Array<string>>} List of text strings per page
   */
  static async extractTextFromPdf(arrayBuffer, options = {}) {
    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      throw new Error('PDF.js library is not loaded on this page.');
    }

    // Set worker source to our local extension bundle
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/lib/pdf.worker.min.js');

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pagesText = [];
    const selectedPages = this.normalizePageSelection(pdf.numPages, options);
    const ocrPageBudget = Number.isFinite(options.ocrPageBudget)
      ? Math.max(0, options.ocrPageBudget)
      : 12;
    let ocrPagesUsed = 0;

    for (const pageNum of selectedPages) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        let pageText = textContent.items.map(item => item.str).join(' ').trim();
        
        // OCR Fallback: if page contains very little text (e.g. scanned image PDF).
        // Cap automatic OCR so long scanned textbooks do not freeze the side panel;
        // callers can request a smaller page range and retry for citations.
        if (pageText.length < 50 && ocrPagesUsed < ocrPageBudget) {
          ocrPagesUsed += 1;
          console.log(`[Canvascope DocumentParser] Low selectable text on page ${pageNum} (${pageText.length} chars). Triggering local OCR...`);
          try {
            if (typeof document === 'undefined') {
              throw new Error('document is undefined (not running in browser)');
            }
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            const viewport = page.getViewport({ scale: 1.5 }); // scale up for OCR quality
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            await page.render({
              canvasContext: context,
              viewport: viewport
            }).promise;

            const dataUrl = canvas.toDataURL('image/png');
            let ocrText = '';

            if (typeof window !== 'undefined' && window.CanvascopeOCR) {
              ocrText = await window.CanvascopeOCR.recognize(dataUrl);
            } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
              const res = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                  type: 'canvascope-ocr-request',
                  imageData: dataUrl
                }, (response) => resolve(response || { success: false }));
              });
              if (res && res.success) {
                ocrText = res.text || '';
              }
            }

            if (ocrText) {
              console.log(`[Canvascope DocumentParser] OCR page ${pageNum} success: extracted ${ocrText.length} chars.`);
              pageText = (pageText + '\n' + ocrText).trim();
            }
          } catch (ocrErr) {
            console.warn(`[Canvascope DocumentParser] OCR failed on page ${pageNum}:`, ocrErr);
          }
        } else if (pageText.length < 50 && ocrPagesUsed >= ocrPageBudget) {
          console.warn(`[Canvascope DocumentParser] Skipping OCR for page ${pageNum}; OCR page budget exhausted.`);
        }

        pagesText.push(pageText);
      } catch (err) {
        console.warn(`[Canvascope DocumentParser] Failed to extract page ${pageNum}:`, err);
        pagesText.push(''); // Keep selected-page offset aligned
      } finally {
        if (typeof options.onProgress === 'function') {
          options.onProgress({ pageNum, processed: pagesText.length, total: selectedPages.length, pdfPages: pdf.numPages });
        }
      }
    }

    return pagesText;
  }

  /**
   * Converts caller PDF scope options into a compact list of 1-based pages.
   * Large-PDF workflows can request current page / page ranges so Canvascope can
   * produce useful cited notes without parsing an entire textbook first.
   */
  static normalizePageSelection(totalPages, options = {}) {
    const clamp = (value) => Math.min(totalPages, Math.max(1, Number.parseInt(value, 10)));
    if (!Number.isFinite(totalPages) || totalPages <= 0) return [];

    if (Array.isArray(options.pages) && options.pages.length > 0) {
      return [...new Set(options.pages.map(clamp))].sort((a, b) => a - b);
    }

    const hasStart = Number.isFinite(options.startPage);
    const hasEnd = Number.isFinite(options.endPage);
    if (hasStart || hasEnd) {
      const start = clamp(hasStart ? options.startPage : 1);
      const end = clamp(hasEnd ? options.endPage : start);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      return Array.from({ length: hi - lo + 1 }, (_, index) => lo + index);
    }

    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  static hasPdfScope(options = {}) {
    return (Array.isArray(options.pages) && options.pages.length > 0)
      || Number.isFinite(options.startPage)
      || Number.isFinite(options.endPage);
  }

  /**
   * Quick extraction quality signal for PDF study notes. This gives Canvascope a
   * cheap way to warn on scanned/image-heavy PDFs or empty page ranges without
   * re-reading the file or sending low-confidence context to AI as if complete.
   */
  static assessPdfTextQuality(pagesText, options = {}) {
    const pages = Array.isArray(pagesText) ? pagesText : [];
    const readablePages = pages.filter(text => String(text || '').trim().length >= 80).length;
    const totalChars = pages.reduce((sum, text) => sum + String(text || '').trim().length, 0);
    const averageChars = pages.length ? Math.round(totalChars / pages.length) : 0;
    const readableRatio = pages.length ? readablePages / pages.length : 0;
    const scoped = this.hasPdfScope(options);
    const likelyScanned = pages.length > 0 && (readableRatio < 0.4 || averageChars < 120);
    const warning = pages.length === 0
      ? 'No readable PDF pages were extracted.'
      : likelyScanned
        ? 'This PDF appears scanned or low-text; notes may be incomplete. Try a smaller page range or OCR-first workflow.'
        : scoped
          ? 'Notes are based on the selected PDF scope, not the full document.'
          : null;

    return {
      pages: pages.length,
      readablePages,
      totalChars,
      averageChars,
      readableRatio,
      scoped,
      likelyScanned,
      warning
    };
  }

  static pdfScopeCacheKey(options = {}) {
    if (Array.isArray(options.pages) && options.pages.length > 0) {
      return `pages:${[...new Set(options.pages.map(page => Number.parseInt(page, 10)).filter(Number.isFinite))].sort((a, b) => a - b).join(',')}`;
    }
    const start = Number.isFinite(options.startPage) ? Number.parseInt(options.startPage, 10) : '';
    const end = Number.isFinite(options.endPage) ? Number.parseInt(options.endPage, 10) : '';
    return `range:${start}-${end}`;
  }

  /**
   * Fetches a PDF as an ArrayBuffer, caches it locally in chrome.storage.local, parses it, and indexes it persistently.
   * @param {string} url - The PDF URL to parse
   * @param {string} titleHint - Optional title hint for indexing
   * @param {string} courseHint - Optional course name hint for indexing
   * @param {object} options - Optional parsing scope: pages, startPage, endPage, ocrPageBudget, onProgress
   * @returns {Promise<Array<string>>} Page-by-page text content
   */
  static async fetchAndParsePdf(url, titleHint = null, courseHint = null, options = {}) {
    try {
      if (!url) return [];

      // Clean the URL (strip query/hashes to get unique doc ID)
      const cleanUrl = url.split('?')[0].split('#')[0];
      const docId = `pdf:${cleanUrl}`;

      const scopedParse = this.hasPdfScope(options);

      // Check storage cache. Full-document parses keep the historical key; scoped
      // parses use a separate key so a quick current-page read never poisons the
      // complete-PDF cache used by course indexing.
      const cacheKey = scopedParse
        ? `doc_cache_${docId}:${this.pdfScopeCacheKey(options)}`
        : `doc_cache_${docId}`;
      if (!this._fetchParseInFlight) this._fetchParseInFlight = new Map();
      if (this._fetchParseInFlight.has(cacheKey)) {
        console.log('[Canvascope DocumentParser] Reusing in-flight PDF parse:', cleanUrl);
        return await this._fetchParseInFlight.get(cacheKey);
      }

      const parsePromise = (async () => {
        const cache = await chrome.storage.local.get([cacheKey]);
        let pagesText = null;

        if (cache[cacheKey] && Array.isArray(cache[cacheKey])) {
          console.log('[Canvascope DocumentParser] Cache hit for PDF:', cleanUrl);
          pagesText = cache[cacheKey];
        } else {
          console.log('[Canvascope DocumentParser] Cache miss, fetching PDF:', cleanUrl);
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP network error: status ${response.status}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          pagesText = await this.extractTextFromPdf(arrayBuffer, options);

          // Cache the parsed pages
          await chrome.storage.local.set({ [cacheKey]: pagesText });
          console.log(`[Canvascope DocumentParser] Successfully cached ${pagesText.length} pages for PDF`);
        }

        // Persistently index only complete PDFs. Scoped extracts are latency-first
        // previews for current-page/page-range study and do not contain enough page
        // positions to replace the course corpus safely.
        if (!scopedParse && pagesText && pagesText.length > 0) {
          await this.persistPdfToIndex(url, titleHint, courseHint, pagesText);
        }

        return pagesText;
      })();

      this._fetchParseInFlight.set(cacheKey, parsePromise);
      try {
        return await parsePromise;
      } finally {
        this._fetchParseInFlight.delete(cacheKey);
      }
    } catch (e) {
      console.error('[Canvascope DocumentParser] PDF extraction failed:', e);
      return [];
    }
  }

  /**
   * Permanently indexes parsed PDF text into chrome.storage.local 'indexedContent'
   */
  static async persistPdfToIndex(url, title, courseName, pagesText) {
    try {
      if (!Array.isArray(pagesText) || pagesText.length === 0) return;
      const cleanUrl = url.split('?')[0].split('#')[0];
      
      const { indexedContent = [] } = await chrome.storage.local.get(['indexedContent']);
      const existingIdx = indexedContent.findIndex(item => item.url && item.url.split('?')[0].split('#')[0] === cleanUrl);
      
      const fullText = pagesText.join('\n').trim();
      const filename = cleanUrl.split('/').pop() || 'document.pdf';
      const cleanTitle = title || filename;
      const cleanCourseName = courseName || 'General';
      const existing = existingIdx !== -1 ? indexedContent[existingIdx] : null;

      // Re-parsing the same PDF can happen on page focus, Ask retries, and Study
      // Pack generation. If nothing student-visible changed, skip the storage
      // write so large PDF indexes do not churn extension storage or bump
      // indexedAt ordering, which keeps the side panel responsive on big courses.
      if (existing &&
          existing.title === cleanTitle &&
          existing.courseName === cleanCourseName &&
          existing.content === fullText &&
          Array.isArray(existing.pages) &&
          existing.pages.length === pagesText.length &&
          existing.pages.every((page, idx) => page === pagesText[idx])) {
        console.log('[Canvascope DocumentParser] Indexed PDF unchanged; skipped storage rewrite:', cleanTitle);
        return;
      }

      const pdfIndexItem = {
        title: cleanTitle,
        courseName: cleanCourseName,
        url: url,
        type: 'file',
        content: fullText, // Save full text in item's content field
        pages: pagesText,
        indexedAt: Date.now()
      };

      if (existingIdx !== -1) {
        // Update existing item with full extracted text content
        indexedContent[existingIdx] = { ...indexedContent[existingIdx], ...pdfIndexItem };
        console.log('[Canvascope DocumentParser] Updated existing indexed PDF content:', cleanTitle);
      } else {
        // Append new PDF item to main indexer
        indexedContent.push(pdfIndexItem);
        console.log('[Canvascope DocumentParser] Saved new PDF permanently to main index:', cleanTitle);
      }

      try {
        await chrome.storage.local.set({ indexedContent });
      } catch (writeErr) {
        // Quota fallback: if the user denied `unlimitedStorage` or storage is
        // capped, evict the oldest indexed PDFs and retry once. Newest item
        // (the one we just pushed/updated) is preserved.
        const msg = String(writeErr?.message || writeErr || '');
        if (!/quota/i.test(msg)) throw writeErr;

        const newestUrl = pdfIndexItem.url;
        const fileEntries = indexedContent
          .map((item, idx) => ({ item, idx }))
          .filter(({ item }) => item?.type === 'file' && item.url !== newestUrl)
          .sort((a, b) => (a.item.indexedAt || 0) - (b.item.indexedAt || 0));

        const evictCount = Math.max(1, Math.ceil(fileEntries.length / 4));
        const toEvict = new Set(fileEntries.slice(0, evictCount).map(e => e.idx));
        const pruned = indexedContent.filter((_, idx) => !toEvict.has(idx));

        console.warn(`[Canvascope DocumentParser] Storage quota hit; evicting ${toEvict.size} oldest indexed PDF(s) and retrying.`);
        await chrome.storage.local.set({ indexedContent: pruned });
      }
    } catch (e) {
      console.warn('[Canvascope DocumentParser] Failed to persist PDF to index:', e);
    }
  }

  /**
   * Returns a cached semantic vector for page text. Students often ask several
   * follow-up questions against the same PDF or Canvas page; memoizing page
   * vectors avoids re-tokenizing every page for each prompt while keeping query
   * vectors fresh. The cache is intentionally small and keyed by a compact text
   * signature so long readings do not create unbounded memory pressure.
   */
  static semanticVectorForPage(text) {
    if (typeof SemanticMatcher === 'undefined') return null;
    if (!this._pageVectorCache) this._pageVectorCache = new Map();

    const safeText = String(text || '');
    const key = `${safeText.length}:${safeText.slice(0, 80)}:${safeText.slice(-80)}`;
    if (this._pageVectorCache.has(key)) {
      return this._pageVectorCache.get(key);
    }

    const vector = SemanticMatcher.vectorize(safeText);
    this._pageVectorCache.set(key, vector);

    // Keep memory bounded during long course/PDF sessions.
    if (this._pageVectorCache.size > 200) {
      const oldestKey = this._pageVectorCache.keys().next().value;
      this._pageVectorCache.delete(oldestKey);
    }

    return vector;
  }

  /**
   * Lexically & conceptually scores parsed pages against prompt text and returns the top 3 matches using RRF.
   * @param {Array<string>} pages - Extracted text per page
   * @param {string} promptText - User query question
   * @returns {Array<{pageNum: number, text: string}>} Top 3 matching pages
   */
  static scoreDocumentPages(pages, promptText) {
    if (!Array.isArray(pages) || pages.length === 0) return [];

    // 1. Lexical page scoring list. Normalize once and de-duplicate query tokens
    // so long repeated prompts (common when a student pastes an assignment page)
    // do not multiply O(pages × tokens × text scans) work or over-rank a page
    // just because a word was repeated in the question.
    const normalizedPrompt = String(promptText || '').toLowerCase();
    const tokens = [...new Set(normalizedPrompt
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2))];

    let lexicalRankList = [];
    if (tokens.length > 0) {
      const scoredLexical = pages.map((text, idx) => {
        const safeText = String(text || '');
        let score = 0;
        const textLower = safeText.toLowerCase();
        for (const token of tokens) {
          let pos = textLower.indexOf(token);
          while (pos !== -1) {
            score += 1;
            pos = textLower.indexOf(token, pos + token.length);
          }
        }
        return { pageNum: idx + 1, text: safeText, score };
      });
      
      lexicalRankList = scoredLexical
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);
    }

    // 2. Semantic concept scoring list
    let semanticRankList = [];
    if (typeof SemanticMatcher !== 'undefined') {
      const queryVector = SemanticMatcher.vectorize(promptText);
      const hasConcepts = Object.values(queryVector).some(val => val > 0);

      if (hasConcepts) {
        const scoredSemantic = pages.map((text, idx) => {
          const pageVector = this.semanticVectorForPage(text);
          const similarity = pageVector ? SemanticMatcher.cosineSimilarity(queryVector, pageVector) : 0;
          return { pageNum: idx + 1, text, similarity };
        });

        semanticRankList = scoredSemantic
          .filter(x => x.similarity > 0.15)
          .sort((a, b) => b.similarity - a.similarity);
      }
    }

    // 3. Blend rankings using Reciprocal Rank Fusion (RRF)
    let matchedPages = [];
    if (typeof SemanticMatcher !== 'undefined' && (lexicalRankList.length > 0 || semanticRankList.length > 0)) {
      matchedPages = SemanticMatcher.rrfMerge(
        lexicalRankList, 
        semanticRankList,
        (page) => String(page.pageNum)
      ).slice(0, 3);
    } else if (lexicalRankList.length > 0) {
      matchedPages = lexicalRankList.slice(0, 3);
    }

    // If no matching pages found, return the first 3 pages as a fallback
    if (matchedPages.length === 0) {
      return pages.slice(0, 3).map((text, idx) => ({ pageNum: idx + 1, text }));
    }

    return matchedPages.map(x => ({ pageNum: x.pageNum, text: x.text }));
  }
}
