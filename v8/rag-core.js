/**
 * Canvascope RAG (Retrieval-Augmented Generation) Core
 * Scrapes page content and retrieves relevant local schedule/task context.
 */
class RAGCore {
  /**
   * Scrapes raw text from the active LMS browser tab, handling both HTML DOM and PDF documents natively.
   * @param {string} promptText - Optional user question for relevance-based page chunking
   * @returns {Promise<string>} Trimmed page content or matched PDF page text up to 4000 characters
   */
  static async scrapeActiveTab(promptText = '') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return '';

      const url = tab.url;
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
        console.log('[Canvascope RAG] Domain is outside supported LMS scopes, skipping page scraper');
        return '';
      }

      // 1. Check if the active tab is a direct PDF or contains an embedded file viewer
      let pdfUrl = isDirectPdf ? url : null;

      if (!pdfUrl) {
        try {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              // Try finding embedded objects/embeds/iframes
              const el = document.querySelector('embed[src], object[data], iframe[src]');
              if (el) {
                const src = el.getAttribute('src') || el.getAttribute('data') || '';
                if (src.toLowerCase().includes('.pdf') || src.toLowerCase().includes('/files/') || src.toLowerCase().includes('/download')) {
                  return src;
                }
              }
              // Try finding downloadable attachment buttons or preview URLs
              const attachment = document.querySelector('a.iframe_required, a[href*=".pdf"], a[href*="/files/"][href*="/download"]');
              if (attachment) {
                return attachment.getAttribute('href');
              }
              return null;
            }
          });
          if (result) {
            // Resolve relative link against tab base URL
            const resolved = new URL(result, url).toString();
            pdfUrl = resolved;
          }
        } catch (scriptError) {
          console.warn('[Canvascope RAG] Failed to execute scripting lookup for embeds:', scriptError);
        }
      }

      // 2. If PDF URL is found, parse and rank PDF pages
      if (pdfUrl && typeof DocumentParser !== 'undefined') {
        console.log('[Canvascope RAG] PDF file context detected:', pdfUrl);
        
        let documentTitle = pdfUrl.split('/').pop().split('?')[0] || 'PDF Document';
        let courseName = 'General';
        
        if (tab && tab.title) {
          const titleParts = tab.title.split(':');
          if (titleParts.length > 1) {
            courseName = titleParts[0].trim();
            documentTitle = titleParts.slice(1).join(':').trim();
          } else {
            documentTitle = tab.title.trim();
          }
        }

        const pages = await DocumentParser.fetchAndParsePdf(pdfUrl, documentTitle, courseName);
        if (pages && pages.length > 0) {
          const matched = DocumentParser.scoreDocumentPages(pages, promptText);
          let context = `=== ACTIVE PDF DOCUMENT PAGES ===\nFile: ${pdfUrl.split('/').pop().split('?')[0]}\n\n`;
          matched.forEach(page => {
            context += `--- Page ${page.pageNum} ---\n${page.text.substring(0, 1500)}\n\n`;
          });
          return context.trim();
        }
      }

      // 3. Otherwise, fall back to normal HTML DOM text parsing
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const body = document.body.cloneNode(true);
          // Safely strip non-essential DOM layers to preserve context window
          body.querySelectorAll('script, style, nav, footer, header, #canvascope-slash-root').forEach(el => el.remove());
          return body.innerText.substring(0, 4000).trim();
        }
      });

      return result || '';
    } catch (e) {
      console.log('[Canvascope RAG] Active page scraper bypassed or failed:', e);
      return '';
    }
  }

  /**
   * Detects whether a query is asking about the user's schedule, tasks, or to-do list.
   * When true, the retriever surfaces upcoming items even if no keyword lexically matches —
   * this is what makes the RAG "context aware" for natural questions like
   * "what do I need to do?" or "what's on my to-do list?".
   * @param {string} promptText
   * @returns {boolean}
   */
  static hasScheduleIntent(promptText) {
    const q = (promptText || '').toLowerCase();
    return /\b(to-?do|to ?dos?|task|tasks|assignment|assignments|homework|hw|due|deadline|deadlines|upcoming|pending|overdue|schedule|agenda|exam|exams|quiz|quizzes|test|tests|project|projects|study|reading|this week|next week|today|tomorrow|left to do|need to do|have to do|to get done|my list|coming up|what.s due|what do i|what's left)\b/.test(q);
  }

  /**
   * Builds the unified, normalized corpus of all local study assets
   * (synced assignments, custom to-dos, and dashboard notes).
   * @returns {Promise<Array>} Normalized corpus items
   */
  static async buildCorpus() {
    const db = await chrome.storage.local.get(['indexedContent', 'customTodos', 'dashboardNotes']);
    const indexedContent = Array.isArray(db.indexedContent) ? db.indexedContent : [];
    const customTodos = Array.isArray(db.customTodos) ? db.customTodos : [];
    const dashboardNotes = Array.isArray(db.dashboardNotes) ? db.dashboardNotes : [];

    const searchCorpus = [];

    indexedContent.forEach(item => {
      if (item && item.title) {
        searchCorpus.push({
          title: item.title,
          courseName: item.courseName || 'General',
          dueAt: item.dueAt || null,
          url: item.url || '',
          type: item.type || 'assignment',
          content: item.content || '',
          pages: item.pages || null,
          done: false
        });
      }
    });

    customTodos.forEach(todo => {
      if (todo && (todo.title || todo.text)) {
        searchCorpus.push({
          title: todo.title || todo.text,
          courseName: todo.courseName || 'Personal To-Do',
          dueAt: todo.dueDate || todo.dueAt || null,
          url: '',
          type: 'to-do',
          done: !!todo.done
        });
      }
    });

    dashboardNotes.forEach(note => {
      if (note && (note.title || note.content)) {
        searchCorpus.push({
          title: note.title || 'Memo',
          courseName: note.courseName || 'Planner Note',
          dueAt: note.createdAt || null,
          url: '',
          type: 'note',
          done: false
        });
      }
    });

    return searchCorpus;
  }

  /**
   * Tokenizes user queries and queries local database storage using frequency word scoring.
   * Falls back to surfacing the user's upcoming/pending tasks when the query is clearly
   * about their schedule but doesn't lexically match a stored item (context-aware retrieval).
   * @param {string} promptText - The user prompt question
   * @returns {Promise<Array>} List of top matching course calendar/note objects
   */
  static async retrieveLocalContext(promptText) {
    try {
      const searchCorpus = await this.buildCorpus();
      if (searchCorpus.length === 0) return [];

      // Tokenize prompt, removing standard punctuation and filtering out short helper words
      const tokens = promptText.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2);

      // 1. Lexical keyword scoring (precise matches for specific questions)
      const scoredItems = searchCorpus.map(item => {
        let score = 0;
        const titleLower = item.title.toLowerCase();
        const courseLower = item.courseName.toLowerCase();
        const contentLower = (item.content || '').toLowerCase();

        for (const token of tokens) {
          if (titleLower.includes(token)) {
            score += 10; // Exact match in title gets major priority
          }
          if (courseLower.includes(token)) {
            score += 4;  // Match in course name gets secondary priority
          }
          if (contentLower.includes(token)) {
            score += 2;  // Match in document body gets moderate priority
          }
        }
        return { item, score };
      });

      const strongMatches = scoredItems
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(x => x.item);

      // 2. Semantic concept scoring (Cosine similarity over academic synonym dimensions)
      let semanticMatches = [];
      if (typeof SemanticMatcher !== 'undefined') {
        const queryVector = SemanticMatcher.vectorize(promptText);
        // Only run if the query vector has some non-zero concept dimensions
        const hasConcepts = Object.values(queryVector).some(val => val > 0);
        
        if (hasConcepts) {
          const scoredSemantic = searchCorpus.map(item => {
            const itemText = `${item.title} ${item.courseName} ${item.type} ${item.content || ''}`;
            const itemVector = SemanticMatcher.vectorize(itemText);
            const similarity = SemanticMatcher.cosineSimilarity(queryVector, itemVector);
            return { item, similarity };
          });

          semanticMatches = scoredSemantic
            .filter(x => x.similarity > 0.15) // Keep conceptually relevant items
            .sort((a, b) => b.similarity - a.similarity)
            .map(x => x.item);
        }
      }

      // 3. Blend rankings using Reciprocal Rank Fusion (RRF)
      let finalMatches = [];
      if (typeof SemanticMatcher !== 'undefined') {
        finalMatches = SemanticMatcher.rrfMerge(strongMatches, semanticMatches);
      } else {
        finalMatches = strongMatches;
      }

      // Slice to top 5
      const topMatches = finalMatches.slice(0, 5);

      if (topMatches.length > 0) {
        return topMatches;
      }

      // 4. Context-aware fallback: no keyword or concept hit, but query has schedule intent
      if (this.hasScheduleIntent(promptText)) {
        return this.getUpcomingItems(searchCorpus);
      }

      return [];
    } catch (e) {
      console.warn('[Canvascope RAG] Local scheduler retriever failed:', e);
      return [];
    }
  }

  /**
   * Selects pending to-dos and upcoming/recent dated items, ordered for a study agenda:
   * undone to-dos first, then items sorted by soonest due date.
   * @param {Array} corpus - Normalized corpus from buildCorpus()
   * @param {number} limit
   * @returns {Array}
   */
  static getUpcomingItems(corpus, limit = 8) {
    const now = Date.now();
    const ts = (item) => {
      if (!item.dueAt) return Number.POSITIVE_INFINITY; // undated -> end of dated list
      const t = new Date(item.dueAt).getTime();
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };

    // Pending to-dos are always relevant regardless of date.
    const todos = corpus.filter(i => i.type === 'to-do' && !i.done);

    // Assignments: keep recent (last 14 days) + all upcoming, soonest first.
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    const assignments = corpus
      .filter(i => i.type === 'assignment' && i.dueAt)
      .filter(i => ts(i) > now - fourteenDays)
      .sort((a, b) => ts(a) - ts(b));

    const seen = new Set();
    const out = [];
    [...todos, ...assignments].forEach(item => {
      const key = `${item.type}|${item.title}|${item.courseName}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    });

    return out.slice(0, limit);
  }

  /**
   * Compiles scraped tab text and matching scheduler records into a single context-wrapped prompt.
   * @param {string} promptText - User query question
   * @returns {Promise<string>} Full compiled context-wrapped prompt
   */
  static async compileRAGPrompt(promptText) {
    // Run retrieval queries concurrently to minimize perceived latency
    const [pageContext, localMatches] = await Promise.all([
      this.scrapeActiveTab(promptText),
      this.retrieveLocalContext(promptText)
    ]);

    let compiledPrompt = '';

    // 1. Inject Active tab scraped RAG context
    if (pageContext) {
      if (pageContext.startsWith('=== ACTIVE PDF DOCUMENT PAGES ===')) {
        compiledPrompt += `${pageContext}\n\n`;
      } else {
        compiledPrompt += `=== CONTEXT FROM THE ACTIVE PAGE ===\n${pageContext}\n\n`;
      }
    }

    // 2. Inject Scheduler/Local DB matched entries
    if (localMatches && localMatches.length > 0) {
      const hasTodos = localMatches.some(m => m.type === 'to-do');
      const heading = this.hasScheduleIntent(promptText) && hasTodos
        ? `=== THE STUDENT'S TASKS & DEADLINES ===`
        : `=== RELEVANT COURSE DETAILS ===`;
      compiledPrompt += `${heading}\n`;
      localMatches.forEach((match, idx) => {
        const dateStr = match.dueAt ? new Date(match.dueAt).toLocaleDateString() : 'No due date';
        const status = match.type === 'to-do' && match.done ? ' [done]' : '';
        compiledPrompt += `${idx + 1}. [${match.type.toUpperCase()}] ${match.title} (${match.courseName}) - Due: ${dateStr}${status}\n`;
      });
      compiledPrompt += `\n`;
    } else if (this.hasScheduleIntent(promptText)) {
      // The user asked about their schedule but we found nothing stored locally.
      compiledPrompt += `=== THE STUDENT'S TASKS & DEADLINES ===\n(No tasks, assignments, or to-dos are currently saved in Canvascope. Let the student know their list is empty and suggest adding one with the /todo add command.)\n\n`;
    }

    // 3. Append original user question. We explicitly tell the model to lean on
    // the student's own records (tasks/deadlines, PDF pages) rather than the
    // broad active-page course list, which otherwise causes over-cautious
    // "I can't find that" refusals when a task's course code differs from the page.
    compiledPrompt += `=== QUESTION ===\nAnswer the student's request using the sections above as authoritative context. Prefer the tasks/deadlines and document sections over the general active-page text, and match tasks by topic even if the course code differs from the page. Request: ${promptText}`;

    return compiledPrompt;
  }
}
