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
  static async extractTextFromPdf(arrayBuffer) {
    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) {
      throw new Error('PDF.js library is not loaded on this page.');
    }

    // Set worker source to our local extension bundle
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pagesText = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        let pageText = textContent.items.map(item => item.str).join(' ').trim();
        
        // OCR Fallback: if page contains very little text (e.g. scanned image PDF)
        if (pageText.length < 50) {
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
        }

        pagesText.push(pageText);
      } catch (err) {
        console.warn(`[Canvascope DocumentParser] Failed to extract page ${pageNum}:`, err);
        pagesText.push(''); // Keep index offset aligned
      }
    }

    return pagesText;
  }

  /**
   * Fetches a PDF as an ArrayBuffer, caches it locally in chrome.storage.local, parses it, and indexes it persistently.
   * @param {string} url - The PDF URL to parse
   * @param {string} titleHint - Optional title hint for indexing
   * @param {string} courseHint - Optional course name hint for indexing
   * @returns {Promise<Array<string>>} Page-by-page text content
   */
  static async fetchAndParsePdf(url, titleHint = null, courseHint = null) {
    try {
      if (!url) return [];

      // Clean the URL (strip query/hashes to get unique doc ID)
      const cleanUrl = url.split('?')[0].split('#')[0];
      const docId = `pdf:${cleanUrl}`;

      // Check storage cache
      const cacheKey = `doc_cache_${docId}`;
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
        pagesText = await this.extractTextFromPdf(arrayBuffer);

        // Cache the parsed pages
        await chrome.storage.local.set({ [cacheKey]: pagesText });
        console.log(`[Canvascope DocumentParser] Successfully cached ${pagesText.length} pages for PDF`);
      }

      // Persistently index this PDF to indexedContent
      if (pagesText && pagesText.length > 0) {
        await this.persistPdfToIndex(url, titleHint, courseHint, pagesText);
      }

      return pagesText;
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

      const pdfIndexItem = {
        title: cleanTitle,
        courseName: courseName || 'General',
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
   * Lexically & conceptually scores parsed pages against prompt text and returns the top 3 matches using RRF.
   * @param {Array<string>} pages - Extracted text per page
   * @param {string} promptText - User query question
   * @returns {Array<{pageNum: number, text: string}>} Top 3 matching pages
   */
  static scoreDocumentPages(pages, promptText) {
    if (!Array.isArray(pages) || pages.length === 0) return [];

    // 1. Lexical page scoring list
    const tokens = promptText.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);

    let lexicalRankList = [];
    if (tokens.length > 0) {
      const scoredLexical = pages.map((text, idx) => {
        let score = 0;
        const textLower = text.toLowerCase();
        for (const token of tokens) {
          let pos = textLower.indexOf(token);
          while (pos !== -1) {
            score += 1;
            pos = textLower.indexOf(token, pos + token.length);
          }
        }
        return { pageNum: idx + 1, text, score };
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
          const pageVector = SemanticMatcher.vectorize(text);
          const similarity = SemanticMatcher.cosineSimilarity(queryVector, pageVector);
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
