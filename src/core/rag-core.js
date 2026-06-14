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
    compiledPrompt += `=== QUESTION ===\nAnswer the student's request. Use the sections above as authoritative context for their personal specifics (tasks/deadlines, document pages) — prefer those over the general active-page text, and match tasks by topic even if the course code differs from the page. For conceptual or "explain/teach me" questions, answer fully from your general knowledge even when the sections don't cover the topic, and tie the explanation to the student's profile and course materials where relevant. Do not refuse a concept question for lack of a matching section. Request: ${promptText}`;

    return compiledPrompt;
  }

  /* ════════════════════════════════════════════
     v10 Course Brain — course-scoped retrieval
     with chunk-level provenance for citations.
     ════════════════════════════════════════════ */

  /**
   * Distinct course names present in the indexed corpus, with item counts,
   * for the Brain view's course picker. Sorted by volume (busiest first).
   * @returns {Promise<Array<{courseName: string, count: number}>>}
   */
  static async listCourses() {
    const corpus = await this.buildCorpus();
    const counts = new Map();
    corpus.forEach(item => {
      const name = (item.courseName || '').trim();
      if (!name || name === 'General' || name === 'Personal To-Do' || name === 'Planner Note') return;
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([courseName, count]) => ({ courseName, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Explodes the corpus into retrievable chunks that carry provenance.
   * PDF items contribute one chunk per cached page; other items contribute
   * a single chunk from their body text (or title-only when bodyless).
   * @param {string} [courseName] - Optional course scope filter
   * @returns {Promise<Array>} chunks: {title, courseName, type, url, page, text}
   */
  static async buildChunkIndex(courseName = '') {
    const corpus = await this.buildCorpus();
    const scope = courseName
      ? corpus.filter(i => (i.courseName || '').toLowerCase() === courseName.toLowerCase())
      : corpus;

    const chunks = [];
    scope.forEach(item => {
      const base = {
        title: item.title,
        courseName: item.courseName,
        type: item.type,
        url: item.url || '',
        dueAt: item.dueAt || null
      };
      if (Array.isArray(item.pages) && item.pages.length > 0) {
        item.pages.forEach(page => {
          const text = (page && page.text) ? String(page.text) : '';
          if (!text.trim()) return;
          chunks.push({ ...base, page: page.pageNum || null, text: text.substring(0, 1500) });
        });
      } else {
        const text = (item.content || '').substring(0, 1500);
        chunks.push({ ...base, page: null, text });
      }
    });
    return chunks;
  }

  /**
   * Ranks chunks for a question using the same lexical + semantic + RRF blend
   * as retrieveLocalContext, but at chunk granularity so answers can cite the
   * exact PDF page or item they came from.
   * @param {string} question
   * @param {{courseName?: string, limit?: number, charBudget?: number}} opts
   * @returns {Promise<Array>} top chunks with provenance
   */
  static async retrieveBrainChunks(question, { courseName = '', limit = 6, charBudget = 6000 } = {}) {
    const chunks = await this.buildChunkIndex(courseName);
    if (chunks.length === 0) return [];

    const tokens = question.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const lexical = chunks.map(chunk => {
      let score = 0;
      const titleLower = chunk.title.toLowerCase();
      const courseLower = chunk.courseName.toLowerCase();
      const textLower = chunk.text.toLowerCase();
      for (const token of tokens) {
        if (titleLower.includes(token)) score += 10;
        if (courseLower.includes(token)) score += 4;
        if (textLower.includes(token)) score += 2;
      }
      return { chunk, score };
    });

    const strongMatches = lexical
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(x => x.chunk);

    // Relevance floor: the on-device "semantic" layer is a coarse 24-bucket
    // keyword projection (LocalEmbeddings) with no notion of specific topics
    // like "enzyme kinetics". Left unchecked it injects whatever bulky indexed
    // content happens to share a broad academic category (e.g. unrelated course
    // PDFs), which then gets cited as a source. So we let it only REORDER chunks
    // that already have lexical overlap with the query — never inject chunks the
    // query never lexically touched. This keeps citations on-topic and matches
    // the cleaner title-driven behavior of the Cmd+K search.
    const lexicallyRelevant = new Set(strongMatches);

    let semanticMatches = [];
    if (typeof SemanticMatcher !== 'undefined' && lexicallyRelevant.size > 0) {
      const queryVector = SemanticMatcher.vectorize(question);
      const hasConcepts = Object.values(queryVector).some(val => val > 0);
      if (hasConcepts) {
        semanticMatches = strongMatches
          .map(chunk => ({
            chunk,
            similarity: SemanticMatcher.cosineSimilarity(
              queryVector,
              SemanticMatcher.vectorize(`${chunk.title} ${chunk.text}`)
            )
          }))
          .filter(x => x.similarity > 0.15)
          .sort((a, b) => b.similarity - a.similarity)
          .map(x => x.chunk);
      }
    }

    // RRF now reranks within the lexically-relevant set; with semanticMatches
    // drawn only from strongMatches, no off-topic chunk can enter the result.
    const merged = (typeof SemanticMatcher !== 'undefined')
      ? SemanticMatcher.rrfMerge(strongMatches, semanticMatches)
      : strongMatches;

    // Enforce both the chunk limit and a total character budget so the
    // compiled prompt stays inside the on-device model's small window.
    const out = [];
    let used = 0;
    for (const chunk of merged) {
      if (out.length >= limit) break;
      const cost = chunk.text.length + chunk.title.length + 64;
      if (used + cost > charBudget && out.length > 0) continue;
      out.push(chunk);
      used += cost;
    }
    return out;
  }

  /**
   * Compiles a citation-grounded Course Brain prompt from ranked chunks.
   * @param {string} question
   * @param {{courseName?: string}} opts
   * @returns {Promise<{prompt: string, sources: Array}>} sources are 1-indexed
   *   {n, title, courseName, type, url, page} matching the [n] cite markers.
   */
  static async compileBrainPrompt(question, { courseName = '' } = {}) {
    const chunks = await this.retrieveBrainChunks(question, { courseName });

    const sources = chunks.map((chunk, i) => ({
      n: i + 1,
      title: chunk.title,
      courseName: chunk.courseName,
      type: chunk.type,
      url: chunk.url,
      page: chunk.page
    }));

    let prompt = '';
    if (chunks.length > 0) {
      prompt += `=== COURSE SOURCES (cite as [n]) ===\n`;
      chunks.forEach((chunk, i) => {
        const loc = chunk.page ? ` — page ${chunk.page}` : '';
        const due = chunk.dueAt ? ` — due ${new Date(chunk.dueAt).toLocaleDateString()}` : '';
        prompt += `[${i + 1}] ${chunk.title} (${chunk.courseName}${loc}${due})\n${chunk.text}\n\n`;
      });
    } else {
      prompt += `=== COURSE SOURCES ===\n(No indexed course content matched this question${courseName ? ` in ${courseName}` : ''}. Answer from your general knowledge, and mention that nothing in their indexed course materials covered it — opening the course files once lets Canvascope index them.)\n\n`;
    }

    prompt += `=== QUESTION ===\nAnswer the student's question. Ground claims in the numbered sources when they cover it, citing inline like [1] or [2]. When the sources only partially cover the topic (or are merely related, e.g. labs on the concept), fill the gaps from your general knowledge — clearly grounded teaching is better than refusing — and connect the explanation back to the course materials where helpful. Only attach [n] citations to claims actually drawn from the sources; never fabricate a citation. For facts specific to this course (due dates, grading, instructions), rely strictly on the sources and say so if they're missing. Be concise (2-5 sentences or a short list). Question: ${question}`;

    return { prompt, sources };
  }

  /**
   * Unified "Ask" retrieval: merges the page the student is viewing with
   * citation-grounded chunks from their WHOLE indexed corpus. The active page
   * (when present) is source [1]; ranked corpus chunks follow as [2..N]. This
   * is what powers the merged Ask surface — tab-aware AND course-wide, cited,
   * and willing to teach from general knowledge when the sources fall short.
   * @param {string} question
   * @param {{courseName?: string}} opts - Optional course scope filter
   * @returns {Promise<{prompt: string, sources: Array}>} sources are 1-indexed
   *   {n, title, courseName, type, url, page} matching the [n] cite markers.
   */
  static async compileUnifiedPrompt(question, { courseName = '' } = {}) {
    // Active-page scrape and whole-corpus chunk retrieval run concurrently.
    const [pageContext, chunks, tab] = await Promise.all([
      this.scrapeActiveTab(question),
      this.retrieveBrainChunks(question, { courseName, limit: 10, charBudget: 9000 }),
      chrome.tabs.query({ active: true, currentWindow: true }).then(r => r[0]).catch(() => null)
    ]);

    const sources = [];
    let body = '';

    // The page the student is looking at becomes the first, top-priority source.
    if (pageContext) {
      const n = sources.length + 1;
      const title = (tab && tab.title) ? (tab.title.split(':').pop().trim() || tab.title) : 'Active page';
      sources.push({ n, title, courseName: 'This page', type: 'page', url: (tab && tab.url) || '', page: null });
      body += `[${n}] ${title} (the page the student is viewing right now)\n${pageContext}\n\n`;
    }

    // Ranked chunks from across the indexed corpus carry their own provenance.
    chunks.forEach((chunk) => {
      const n = sources.length + 1;
      const loc = chunk.page ? ` — page ${chunk.page}` : '';
      const due = chunk.dueAt ? ` — due ${new Date(chunk.dueAt).toLocaleDateString()}` : '';
      body += `[${n}] ${chunk.title} (${chunk.courseName}${loc}${due})\n${chunk.text}\n\n`;
      sources.push({ n, title: chunk.title, courseName: chunk.courseName, type: chunk.type, url: chunk.url, page: chunk.page });
    });

    let prompt = '';
    if (sources.length > 0) {
      prompt += `=== SOURCES (cite as [n]) ===\n${body}`;
    } else {
      prompt += `=== SOURCES ===\n(Nothing in the student's indexed course materials or active page matched this question. Answer from your general knowledge and mention that nothing in their indexed materials covered it — opening the relevant course files once lets Canvascope index them.)\n\n`;
    }

    prompt += `=== QUESTION ===\nAnswer the student's question. Ground claims in the numbered sources when they cover it, citing inline like [1] or [2] (source [1] is the page they are viewing, when present). When the sources only partially cover the topic — or are merely related — fill the gaps from your general knowledge (clear teaching beats refusing) and connect the explanation back to the sources and the student's goals where helpful. Only attach an [n] citation to a claim actually drawn from that source; never fabricate a citation. For facts specific to this course (due dates, grading, instructions) rely strictly on the sources and say so plainly if they are missing. Be concise (2-5 sentences or a short list). Question: ${question}`;

    return { prompt, sources };
  }

  /**
   * Compiles the FULL indexed corpus for a course (or all courses) into one
   * citation-numbered block for the Claude Fable 5 cloud route. Unlike
   * retrieveBrainChunks there is no retrieval step and no 1500-char cap —
   * the 1M-token window holds everything. Chunks are sorted so the output is
   * byte-identical across calls; that stability is what lets the proxy's
   * prompt cache serve repeat questions at ~10% input price.
   * @param {string} [courseName] - Optional course scope filter
   * @param {{charBudget?: number}} [opts] - Corpus character cap (~4 chars/token)
   * @returns {Promise<{corpus: string, sources: Array, truncated: boolean}>}
   *   sources are 1-indexed {n, title, courseName, type, url, page}.
   */
  static async compileCourseCorpus(courseName = '', { charBudget = 900000 } = {}) {
    const corpus = await this.buildCorpus();
    const scope = courseName
      ? corpus.filter(i => (i.courseName || '').toLowerCase() === courseName.toLowerCase())
      : corpus;

    const chunks = [];
    scope.forEach(item => {
      const base = {
        title: item.title || '',
        courseName: item.courseName || '',
        type: item.type,
        url: item.url || '',
        dueAt: item.dueAt || null
      };
      if (Array.isArray(item.pages) && item.pages.length > 0) {
        item.pages.forEach(page => {
          const text = (page && page.text) ? String(page.text) : '';
          if (!text.trim()) return;
          chunks.push({ ...base, page: page.pageNum || null, text });
        });
      } else {
        const text = (item.content || '').trim();
        chunks.push({ ...base, page: null, text: text || base.title });
      }
    });

    chunks.sort((a, b) =>
      a.courseName.localeCompare(b.courseName) ||
      a.title.localeCompare(b.title) ||
      (a.page || 0) - (b.page || 0)
    );

    const sources = [];
    let text = `=== COURSE SOURCES (cite as [n]) ===\n`;
    let truncated = false;
    for (const chunk of chunks) {
      const n = sources.length + 1;
      const loc = chunk.page ? ` — page ${chunk.page}` : '';
      const due = chunk.dueAt ? ` — due ${new Date(chunk.dueAt).toLocaleDateString()}` : '';
      const block = `[${n}] ${chunk.title} (${chunk.courseName}${loc}${due})\n${chunk.text}\n\n`;
      if (text.length + block.length > charBudget) {
        truncated = true;
        continue;
      }
      text += block;
      sources.push({
        n,
        title: chunk.title,
        courseName: chunk.courseName,
        type: chunk.type,
        url: chunk.url,
        page: chunk.page
      });
    }

    return { corpus: text, sources, truncated };
  }
}
