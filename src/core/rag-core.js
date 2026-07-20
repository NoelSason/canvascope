/**
 * Canvascope RAG (Retrieval-Augmented Generation) Core
 * Scrapes page content and retrieves relevant local schedule/task context.
 */
class RAGCore {
  static get TOKEN_CACHE_LIMIT() {
    return 300;
  }

  static tokenize(text) {
    const source = String(text || '');
    // Large scraped PDFs/pages are common in Canvascope. Caching those full
    // strings as Map keys keeps megabytes alive after retrieval and can make the
    // sidepanel feel progressively laggier during long study sessions. Cache the
    // short/repeated queries and metadata labels where reuse is high; tokenize
    // one-off large source blobs directly.
    if (source.length > 12000) {
      return this.tokenizeUncached(source);
    }
    if (!this._tokenCache) this._tokenCache = new Map();
    const cached = this._tokenCache.get(source);
    if (cached) {
      this._tokenCache.delete(source);
      this._tokenCache.set(source, cached);
      return cached.slice();
    }
    const tokens = this.tokenizeUncached(source);
    this._tokenCache.set(source, tokens);
    while (this._tokenCache.size > this.TOKEN_CACHE_LIMIT) {
      const oldestKey = this._tokenCache.keys().next().value;
      this._tokenCache.delete(oldestKey);
    }
    return tokens.slice();
  }

  static tokenizeUncached(text) {
    return String(text || '').toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }

  static normalizeTimestamp(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  static itemTimestamp(item) {
    if (!item) return 0;
    return this.normalizeTimestamp(
      item.scannedAt || item.indexedAt || item.updatedAt || item.createdAt || item.dueAt
    );
  }

  static metadataTextForItem(item) {
    const parts = [
      item?.title,
      item?.courseName,
      item?.moduleName,
      item?.folderPath,
      Array.isArray(item?.pathSegments) ? item.pathSegments.join(' > ') : '',
      Array.isArray(item?.searchAliases) ? item.searchAliases.join(' ') : item?.searchAliases,
      item?.type
    ];

    const weekHints = Array.isArray(item?.weekHints) ? item.weekHints : [];
    weekHints.forEach(week => {
      const normalized = String(week || '').replace(/^0+/, '') || '0';
      if (normalized) parts.push(`week ${normalized}`);
    });

    const dates = [
      item?.dueAt,
      item?.scannedAt,
      item?.indexedAt,
      item?.updatedAt,
      item?.createdAt
    ].filter(Boolean);
    dates.forEach(value => parts.push(String(value)));

    return parts
      .map(part => String(part || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  static sourceTextForItem(item, body = '') {
    const metadata = this.metadataTextForItem(item);
    const content = String(body || '').trim();
    if (!metadata) return content;
    if (!content) return metadata;
    return `${metadata}\n${content}`;
  }

  static hasStudySummaryIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const material = /\b(stud(?:y|ied|ying)|learn(?:ed|ing)?|cover(?:ed|ing)?|topic|topics|material|materials|lecture|lectures|slides?|readings?|notes?|files?|content|work(?:ed)? on)\b/.test(q);
    const temporal = /\b(this week|last week|today|recent(?:ly)?|latest|current|now|so far|week(?:\s*\d+)?)\b/.test(q);
    const summaryAsk = /\b(what|which|list|summar(?:y|ize|ise)|tell me|show me)\b/.test(q);
    return material && (temporal || summaryAsk);
  }

  static hasExampleDrillIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const practice = /\b(example|examples|edge cases?|corner cases?|walk ?through|practice|quiz me|test me|problem|problems|debug|trace|dry run|implement|code|coding)\b/.test(q);
    const learning = /\b(learn|study|understand|explain|teach|review|prepare|prep|exam|midterm|final|homework|assignment|project|algorithm|data structure|python|java|c\+\+|programming)\b/.test(q);
    return practice && learning;
  }

  static hasComplexityIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    return /\b(big[- ]?o|time complexity|space complexity|runtime|asymptotic|worst case|average case|amortized|scales?|efficient|efficiency)\b/.test(q);
  }

  static hasConceptMapIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    return /\b(concept map|dependency map|how (?:does|do) .* connect|connect(?:ions|ed)? between|what (?:am i|are we) missing|knowledge gaps?|gap check|prerequisites?|build on each other|relationship between)\b/.test(q);
  }

  static hasLectraHandoffIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const handoff = /\b(lectra|ipad|portable notes?|export|handoff|send|carry over)\b/.test(q);
    const studyArtifact = /\b(notes?|study guide|cornell|outline|summary|flashcards?|quiz|practice|checklist)\b/.test(q);
    return handoff && studyArtifact;
  }

  static hasActiveRecallIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    return /\b(active recall|flashcards?|anki|quiz me|self[- ]?test|retrieval practice|practice quiz|cloze|spaced repetition)\b/.test(q);
  }

  static hasExamCramIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const assessment = /\b(exam|midterm|final|quiz|test|assessment)\b/.test(q);
    const urgency = /\b(cram|last[- ]?minute|tonight|tomorrow|before class|in \d+\s*(?:min|mins|minutes|hours?|hrs?)|quick(?:ly)?|rapid|urgent|panic|study plan|review plan)\b/.test(q);
    const prep = /\b(study|review|prepare|prep|ready|practice|prioriti[sz]e|focus)\b/.test(q);
    return assessment && (urgency || prep);
  }

  static hasStudyPlanIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const planning = /\b(plan|schedule|routine|session|sessions|block|blocks|pomodoro|timebox|time box|study sprint|sprints|roadmap|agenda)\b/.test(q);
    const study = /\b(study|review|learn|practice|homework|assignment|project|exam|midterm|final|quiz|course|class)\b/.test(q);
    return planning && study;
  }

  static hasInterleavingIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const switchCue = /\b(interleav(?:e|ed|ing)|mix(?:ed)? practice|rotate topics?|alternate topics?|shuffle topics?|varied practice|space out|spaced practice|avoid cramming|study multiple)\b/.test(q);
    const studyCue = /\b(study|review|practice|homework|assignment|problem set|p\s*set|exam|midterm|final|quiz|course|class|topics?|subjects?)\b/.test(q);
    return switchCue && studyCue;
  }

  static hasTeachBackIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const teachBack = /\b(teach[- ]?back|feynman|explain (?:it|this|back)|say it back|oral exam|recite|talk through|walk me through my understanding)\b/.test(q);
    const metacognitive = /\b(check my understanding|do i understand|spot gaps?|find gaps?|misconceptions?|what am i missing|self[- ]?explain|explain in my own words)\b/.test(q);
    return teachBack || metacognitive;
  }

  static hasSourceAuditIntent(question) {
    const q = String(question || '').toLowerCase();
    if (!q) return false;
    const sourceAsk = /\b(source audit|evidence checklist|citation checklist|cite check|citation audit|which sources|what evidence|source-backed|grounded notes?|open-book)\b/.test(q);
    const studyArtifact = /\b(study guide|notes?|outline|summary|review sheet|cheat sheet|flashcards?|quiz|exam|midterm|final|assignment|homework)\b/.test(q);
    return sourceAsk && studyArtifact;
  }

  static activeRecallGuidance(question) {
    if (!this.hasActiveRecallIntent(question)) return '';
    return ' Because the student is asking for active recall, format the answer as 5-8 quick retrieval prompts with answers hidden or immediately below each prompt, include one cloze-style card when possible, cite source-specific cards inline, and end with a short Lectra-ready review loop (what to ink, what to quiz tomorrow).';
  }

  static examCramGuidance(question) {
    if (!this.hasExamCramIntent(question)) return '';
    return ' Because the student is preparing for an assessment under time pressure, produce a prioritized cram plan: start with the highest-yield topics from the sources, split work into 20-30 minute blocks, include at least three active-recall checks, call out what to skip if time runs short, and end with one immediate next action.';
  }

  static studyPlanGuidance(question) {
    if (!this.hasStudyPlanIntent(question)) return '';
    return ' Because the student is asking for a study plan, turn the available tasks and sources into short timeboxed blocks: name the goal for each block, the exact source/task to open, one active-recall check, and a realistic next-session carryover. Keep it adaptive when due dates or time available are missing.';
  }

  static interleavingGuidance(question) {
    if (!this.hasInterleavingIntent(question)) return '';
    return ' Because the student is asking to interleave or mix practice, build a rotation across 2-4 topics instead of batching one topic end-to-end: alternate problem types, insert a short retrieval check before each switch, label when to switch topics, and end with an error-log cue for patterns that need blocked practice tomorrow.';
  }

  static teachBackGuidance(question) {
    if (!this.hasTeachBackIntent(question)) return '';
    return ' Because the student is asking for a teach-back/check-my-understanding flow, respond like a Socratic study coach: ask for or draft a 60-second explanation in the student\'s own words, identify 2-3 likely gaps or misconceptions from the sources, include a simple rubric for a strong explanation, and end with one follow-up question to test transfer.';
  }

  static conceptMapGuidance(question) {
    if (!this.hasConceptMapIntent(question)) return '';
    return ' Because the student is asking for a concept/gap map, organize the answer as: Core concepts, How they connect, Prerequisites to review, Likely gaps/edge cases, and Next study action. Cite only the source-backed links between concepts.';
  }

  static sourceAuditGuidance(question) {
    if (!this.hasSourceAuditIntent(question)) return '';
    return ' Because the student is asking for a source/evidence audit, add a compact checklist that separates source-backed facts, weakly supported assumptions, missing sources to open next, and any claims that should not receive citations.';
  }

  static isCourseMaterialChunk(chunk) {
    const type = String(chunk?.type || '').toLowerCase();
    return [
      'file',
      'folder',
      'slides',
      'document',
      'pdf',
      'page',
      'module',
      'video',
      'syllabus',
      'assignment',
      'quiz',
      'discussion'
    ].includes(type);
  }

  static explicitWeekHints(text) {
    const hints = [];
    const source = String(text || '');
    const re = /\bweek\s*#?\s*0*(\d{1,3})\b/ig;
    let match = re.exec(source);
    while (match) {
      hints.push(String(match[1] || '').replace(/^0+/, '') || '0');
      match = re.exec(source);
    }
    return hints;
  }

  static materialOverviewChunks(chunks, question, limit = 8) {
    if (!Array.isArray(chunks) || chunks.length === 0) return [];
    const tokens = this.tokenize(question)
      .filter(token => !['what', 'when', 'where', 'which', 'this', 'that', 'with', 'from', 'about', 'study', 'studied', 'learn', 'learned'].includes(token));
    const queryWeeks = this.explicitWeekHints(question);
    const now = Date.now();
    const bySource = new Map();

    chunks.forEach(chunk => {
      if (!this.isCourseMaterialChunk(chunk)) return;

      const blob = [
        chunk.title,
        chunk.courseName,
        chunk.moduleName,
        chunk.folderPath,
        chunk.text
      ].join(' ').toLowerCase();

      let score = 2;
      const type = String(chunk.type || '').toLowerCase();
      if (['file', 'slides', 'document', 'pdf', 'page', 'video'].includes(type)) score += 1.2;
      if (['course', 'navigation'].includes(type)) score -= 2;

      for (const token of tokens) {
        if (blob.includes(token)) score += 0.8;
      }

      const chunkWeeks = Array.isArray(chunk.weekHints)
        ? chunk.weekHints.map(value => String(value || '').replace(/^0+/, '') || '0').filter(Boolean)
        : [];
      if (chunkWeeks.length > 0) score += 1;
      if (queryWeeks.length > 0) {
        const exact = queryWeeks.some(week => chunkWeeks.includes(week));
        score += exact ? 4 : -0.5;
      }

      const ts = this.itemTimestamp(chunk);
      if (ts > 0 && ts <= now) {
        const daysAgo = (now - ts) / (1000 * 60 * 60 * 24);
        if (daysAgo <= 7) score += 2;
        else if (daysAgo <= 30) score += 1;
        else if (daysAgo <= 120) score += 0.35;
      }

      const key = `${chunk.url || chunk.title}|${chunk.courseName}|${chunk.page || ''}`;
      const prev = bySource.get(key);
      if (!prev || score > prev.score) {
        bySource.set(key, { chunk, score, ts });
      }
    });

    return [...bySource.values()]
      .sort((a, b) => b.score - a.score || b.ts - a.ts || String(a.chunk.title || '').localeCompare(String(b.chunk.title || '')))
      .slice(0, limit)
      .map(entry => entry.chunk);
  }

  static mergeUniqueChunks(primary, secondary) {
    const out = [];
    const seen = new Set();
    const add = (chunk) => {
      if (!chunk) return;
      const key = `${chunk.url || chunk.title}|${chunk.courseName}|${chunk.page || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(chunk);
    };
    (primary || []).forEach(add);
    (secondary || []).forEach(add);
    return out;
  }

  static currentGroundingBlock() {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    return `=== CURRENT CONTEXT ===\nToday's date is ${today}. Treat source titles, paths, modules, week labels, and dates as evidence that course materials exist. If sources show current or recent course files, summarize what those materials indicate; do not claim the course has not started, is not active, or has no information based on the term name or your own sense of the year. If a source only provides a title/path/date and no body text, use that label for a high-level materials summary without inventing details beyond it.\n\n`;
  }

  static extractCourseIdFromUrl(rawUrl) {
    const match = String(rawUrl || '').match(/\/courses\/(\d+)/);
    return match ? match[1] : '';
  }

  static async inferActiveCanvasContext() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !/\/courses\/\d+/i.test(tab.url)) return null;
      const courseId = this.extractCourseIdFromUrl(tab.url);
      let courseName = '';
      let folderPath = '';
      let moduleName = '';
      let weekHints = [];

      try {
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const crumbs = Array.from(document.querySelectorAll('#breadcrumbs li'))
              .map(node => clean((node.querySelector('a') || node).textContent))
              .filter(Boolean);
            const path = String(location.pathname || '').toLowerCase();
            let course = '';
            let segments = [];
            if (crumbs.length >= 2) {
              course = crumbs[1];
              segments = crumbs.slice(2);
            }
            if (!course) {
              course = clean(document.querySelector('.mobile-header-title, #breadcrumbs .home span')?.textContent || '');
            }
            if (!path.includes('/files/folder/')) {
              segments = [];
            }
            const hints = [];
            for (const value of segments) {
              const re = /\bweek\s*#?\s*0*(\d{1,3})\b/ig;
              let match = re.exec(value);
              while (match) {
                hints.push(String(match[1] || '').replace(/^0+/, '') || '0');
                match = re.exec(value);
              }
            }
            return {
              courseName: course,
              folderPath: segments.join(' > '),
              moduleName: segments[0] || '',
              weekHints
            };
          }
        });
        if (result && typeof result === 'object') {
          courseName = result.courseName || '';
          folderPath = result.folderPath || '';
          moduleName = result.moduleName || '';
          weekHints = Array.isArray(result.weekHints) ? result.weekHints : [];
        }
      } catch (error) {
        console.warn('[Canvascope RAG] Active course DOM inference failed:', error);
      }

      if (!courseName && tab.title) {
        courseName = String(tab.title).split(':')[0].trim();
      }
      return { tab, courseId, courseName, folderPath, moduleName, weekHints };
    } catch (error) {
      console.warn('[Canvascope RAG] Active course inference failed:', error);
      return null;
    }
  }

  static triggerActiveCourseMaterialDiscovery(activeContext) {
    if (!activeContext?.tab?.id) return;
    if (typeof chrome === 'undefined' || !chrome?.tabs?.sendMessage) return;
    chrome.tabs.sendMessage(activeContext.tab.id, {
      action: 'discoverCourseMaterials',
      reason: 'rag-question'
    }, () => { void chrome.runtime?.lastError; });
  }

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
    const db = await chrome.storage.local.get(['indexedContent', 'customTodos', 'dashboardNotes', 'syllabusMemory']);
    const indexedContent = Array.isArray(db.indexedContent) ? db.indexedContent : [];
    const customTodos = Array.isArray(db.customTodos) ? db.customTodos : [];
    const dashboardNotes = Array.isArray(db.dashboardNotes) ? db.dashboardNotes : [];
    const syllabusMemory = (db.syllabusMemory && typeof db.syllabusMemory === 'object') ? db.syllabusMemory : {};

    const searchCorpus = [];

    // Parsed syllabus memory → one searchable item per course (grading scheme,
    // letter cutoffs, meeting days, no-class dates, policies). Lets the Course
    // Brain answer "when do we not have class" / "what's the late policy" with
    // a citation. renderForCorpus is deterministic for cache stability.
    const SM = (typeof self !== 'undefined') ? self.CanvascopeSyllabusMemory : null;
    Object.keys(syllabusMemory).forEach(courseId => {
      const entry = syllabusMemory[courseId];
      if (!entry) return;
      const content = SM && SM.renderForCorpus ? SM.renderForCorpus(entry) : '';
      if (!content || !content.trim()) return;
      const courseName = entry.courseName || 'General';
      const url = (entry.host && entry.courseId)
        ? `https://${entry.host}/courses/${entry.courseId}/assignments/syllabus`
        : '';
      searchCorpus.push({
        title: `${courseName} Syllabus`,
        courseName,
        dueAt: null,
        url,
        type: 'syllabus',
        content,
        pages: null,
        done: false
      });
    });

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
          moduleName: item.moduleName || '',
          folderPath: item.folderPath || '',
          pathSegments: Array.isArray(item.pathSegments) ? item.pathSegments.slice() : [],
          weekHints: Array.isArray(item.weekHints) ? item.weekHints.slice() : [],
          weekStart: item.weekStart || null,
          weekEnd: item.weekEnd || null,
          searchAliases: item.searchAliases || '',
          searchPathNormalized: item.searchPathNormalized || '',
          containerUrl: item.containerUrl || '',
          courseId: item.courseId || null,
          scannedAt: item.scannedAt || null,
          indexedAt: item.indexedAt || null,
          createdAt: item.createdAt || null,
          updatedAt: item.updatedAt || null,
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
          content: todo.content || todo.notes || '',
          createdAt: todo.createdAt || null,
          updatedAt: todo.updatedAt || null,
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
          content: note.content || '',
          createdAt: note.createdAt || null,
          updatedAt: note.updatedAt || null,
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
      const tokens = this.tokenize(promptText);

      // 1. Lexical keyword scoring (precise matches for specific questions).
      // Normalize each row once so large cached PDF bodies are not rebuilt and
      // lowercased three times during every Ask keystroke/run.
      const searchableItems = searchCorpus.map(item => ({
        item,
        titleLower: String(item.title || '').toLowerCase(),
        courseLower: String(item.courseName || '').toLowerCase(),
        contentLower: this.sourceTextForItem(item, item.content || '').toLowerCase()
      }));
      const scoredItems = searchableItems.map(({ item, titleLower, courseLower, contentLower }) => {
        let score = 0;

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
          const scoredSemantic = searchableItems.map(({ item, titleLower, courseLower, contentLower }) => {
            const itemText = `${titleLower} ${courseLower} ${item.type || ''} ${contentLower}`;
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

    // Canvas dated work: keep recent (last 14 days) + all upcoming, soonest first.
    // Quizzes and discussions often carry due dates too, so include them in
    // schedule fallback answers instead of hiding them behind assignment-only
    // filtering.
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    const datedWorkTypes = new Set(['assignment', 'quiz', 'discussion']);
    const datedWork = corpus
      .filter(i => datedWorkTypes.has(i.type) && i.dueAt && !i.done)
      .filter(i => ts(i) > now - fourteenDays)
      .sort((a, b) => ts(a) - ts(b));

    const seen = new Set();
    const out = [];
    [...todos, ...datedWork].forEach(item => {
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
    const lectraHandoff = this.hasLectraHandoffIntent(promptText)
      ? ' If the student asks for Lectra/iPad handoff notes, end with a compact "Lectra handoff" checklist: portable note title, source/page citations to keep, concepts to ink, examples to rewrite, and retrieval-practice prompts.'
      : '';
    const activeRecallGuidance = this.activeRecallGuidance(promptText);
    const studyPlanGuidance = this.studyPlanGuidance(promptText);
    const interleavingGuidance = this.interleavingGuidance(promptText);
    const teachBackGuidance = this.teachBackGuidance(promptText);
    const sourceAuditGuidance = this.sourceAuditGuidance(promptText);
    compiledPrompt += `=== QUESTION ===\nAnswer the student's request. Use the sections above as authoritative context for their personal specifics (tasks/deadlines, document pages) — prefer those over the general active-page text, and match tasks by topic even if the course code differs from the page. For conceptual or "explain/teach me" questions, answer fully from your general knowledge even when the sections don't cover the topic, and tie the explanation to the student's profile and course materials where relevant. Do not refuse a concept question for lack of a matching section.${lectraHandoff}${activeRecallGuidance}${studyPlanGuidance}${interleavingGuidance}${teachBackGuidance}${sourceAuditGuidance} Request: ${promptText}`;

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
        dueAt: item.dueAt || null,
        moduleName: item.moduleName || '',
        folderPath: item.folderPath || '',
        pathSegments: Array.isArray(item.pathSegments) ? item.pathSegments.slice() : [],
        weekHints: Array.isArray(item.weekHints) ? item.weekHints.slice() : [],
        weekStart: item.weekStart || null,
        weekEnd: item.weekEnd || null,
        courseId: item.courseId || null,
        scannedAt: item.scannedAt || null,
        indexedAt: item.indexedAt || null,
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null
      };
      if (Array.isArray(item.pages) && item.pages.length > 0) {
        item.pages.forEach(page => {
          const text = typeof page === 'string' ? page : ((page && page.text) ? String(page.text) : '');
          if (!text.trim()) return;
          const pageNum = typeof page === 'string' ? null : (page.pageNum || null);
          chunks.push({ ...base, page: pageNum, text: this.sourceTextForItem(item, text).substring(0, 1500) });
        });
      } else {
        const text = this.sourceTextForItem(item, item.content || '').substring(0, 1500);
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
   * @param {{courseName?: string, courseId?: string, limit?: number, charBudget?: number}} opts
   * @returns {Promise<Array>} top chunks with provenance
   */
  static async retrieveBrainChunks(question, { courseName = '', courseId = '', limit = 6, charBudget = 6000 } = {}) {
    const chunks = await this.buildChunkIndex(courseName);
    let courseMaterialChunks = [];
    let courseMaterialStatus = null;
    const courseMaterials = (typeof self !== 'undefined' && self.CanvascopeCourseMaterials)
      || (typeof window !== 'undefined' && window.CanvascopeCourseMaterials)
      || null;
    if (courseMaterials && (typeof courseMaterials.search === 'function' || typeof courseMaterials.searchLocal === 'function')) {
      try {
        const searchFn = typeof courseMaterials.search === 'function'
          ? courseMaterials.search.bind(courseMaterials)
          : courseMaterials.searchLocal.bind(courseMaterials);
        const result = await searchFn(question, {
          courseName,
          courseId,
          limit: Math.max(limit, 10),
          charBudget
        });
        courseMaterialChunks = Array.isArray(result?.chunks) ? result.chunks : [];
        courseMaterialStatus = result?.status || null;
      } catch (error) {
        console.warn('[Canvascope RAG] Course material search failed:', error);
      }
    }
    this.lastCourseMaterialStatus = courseMaterialStatus;
    if (chunks.length === 0 && courseMaterialChunks.length === 0) return [];

    const tokens = this.tokenize(question);

    const lexical = chunks.map(chunk => {
      let score = 0;
      const titleLower = String(chunk.title || '').toLowerCase();
      const courseLower = String(chunk.courseName || '').toLowerCase();
      const textLower = String(chunk.text || '').toLowerCase();
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
    let merged = (typeof SemanticMatcher !== 'undefined')
      ? SemanticMatcher.rrfMerge(strongMatches, semanticMatches)
      : strongMatches;

    if (this.hasStudySummaryIntent(question)) {
      const overview = this.materialOverviewChunks(chunks, question, Math.max(limit, 8));
      merged = this.mergeUniqueChunks(overview, merged);
    }

    merged = this.mergeUniqueChunks(courseMaterialChunks, merged);

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

    let prompt = this.currentGroundingBlock();
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

    const drillGuidance = this.hasExampleDrillIntent(question)
      ? ' Because the student is asking for practice or examples, include one small worked example and one edge/corner case when it fits the topic; for code, show the reasoning trace before the final snippet.'
      : '';
    const complexityGuidance = this.hasComplexityIntent(question)
      ? ' Include time and space complexity with the assumptions that justify them; when there is a tradeoff, name the input variables explicitly.'
      : '';
    const activeRecallGuidance = this.activeRecallGuidance(question);
    const conceptMapGuidance = this.conceptMapGuidance(question);
    const examCramGuidance = this.examCramGuidance(question);
    const studyPlanGuidance = this.studyPlanGuidance(question);
    const interleavingGuidance = this.interleavingGuidance(question);
    const teachBackGuidance = this.teachBackGuidance(question);
    const sourceAuditGuidance = this.sourceAuditGuidance(question);
    prompt += `=== QUESTION ===\nAnswer the student's question. Ground claims in the numbered sources when they cover it, citing inline like [1] or [2]. When the sources only partially cover the topic (or are merely related, e.g. labs on the concept), fill the gaps from your general knowledge — clearly grounded teaching is better than refusing — and connect the explanation back to the course materials where helpful. For material-summary questions such as "what did we study this week", use source titles, folders, module names, dates, and week labels to summarize what the available materials indicate, even when body text is sparse.${drillGuidance}${complexityGuidance}${activeRecallGuidance}${conceptMapGuidance}${examCramGuidance}${studyPlanGuidance}${interleavingGuidance}${teachBackGuidance}${sourceAuditGuidance} Only attach [n] citations to claims actually drawn from the sources; never fabricate a citation. For facts specific to this course (due dates, grading, instructions), rely strictly on the sources and say so if they're missing. Be concise (2-5 sentences or a short list). Question: ${question}`;

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
  static async compileUnifiedPrompt(question, { courseName = '', courseId = '' } = {}) {
    const activeContext = await this.inferActiveCanvasContext();
    if (activeContext) this.triggerActiveCourseMaterialDiscovery(activeContext);
    const effectiveCourseName = courseName || activeContext?.courseName || '';
    const activeMatchesRequestedCourse = !courseName
      || String(activeContext?.courseName || '').toLowerCase() === String(courseName || '').toLowerCase();
    const effectiveCourseId = courseId || (activeMatchesRequestedCourse ? (activeContext?.courseId || '') : '');

    // Active-page scrape and course-scoped chunk retrieval run concurrently.
    const [pageContext, chunks, tab] = await Promise.all([
      this.scrapeActiveTab(question),
      this.retrieveBrainChunks(question, {
        courseName: effectiveCourseName,
        courseId: effectiveCourseId,
        limit: 10,
        charBudget: 9000
      }),
      chrome.tabs.query({ active: true, currentWindow: true }).then(r => r[0]).catch(() => null)
    ]);

    const sources = [];
    let body = '';

    // The page the student is looking at becomes the first, top-priority source.
    if (pageContext) {
      const n = sources.length + 1;
      const title = (tab && tab.title) ? (tab.title.split(':').pop().trim() || tab.title) : 'Active page';
      sources.push({ n, title, courseName: effectiveCourseName || 'This page', courseId: effectiveCourseId || null, type: 'page', url: (tab && tab.url) || '', page: null });
      body += `[${n}] ${title} (the page the student is viewing right now)\n${pageContext}\n\n`;
    }

    // Ranked chunks from across the indexed corpus carry their own provenance.
    chunks.forEach((chunk) => {
      const n = sources.length + 1;
      const loc = chunk.page ? ` — page ${chunk.page}` : '';
      const due = chunk.dueAt ? ` — due ${new Date(chunk.dueAt).toLocaleDateString()}` : '';
      const week = chunk.weekStart && chunk.weekEnd ? ` — ${chunk.weekStart} to ${chunk.weekEnd}` : '';
      body += `[${n}] ${chunk.title} (${chunk.courseName}${loc}${due}${week})\n${chunk.text}\n\n`;
      sources.push({
        n,
        title: chunk.title,
        courseName: chunk.courseName,
        courseId: chunk.courseId || null,
        type: chunk.type,
        url: chunk.url,
        page: chunk.page,
        weekStart: chunk.weekStart || null,
        weekEnd: chunk.weekEnd || null
      });
    });

    let prompt = this.currentGroundingBlock();
    if (sources.length > 0) {
      prompt += `=== SOURCES (cite as [n]) ===\n${body}`;
    } else {
      prompt += `=== SOURCES ===\n(Nothing in the student's indexed course materials or active page matched this question${effectiveCourseName ? ` for ${effectiveCourseName}` : ''}. Answer from your general knowledge and mention that Canvascope is still indexing or has not indexed the relevant files yet when course-specific materials are missing.)\n\n`;
    }

    const currentWeek = this.lastCourseMaterialStatus?.currentWeek;
    if (currentWeek?.weekStart && currentWeek?.weekEnd) {
      prompt += `=== CURRENT COURSE WEEK ===\nFor this active course, the indexed folder dates indicate this week is ${currentWeek.weekStart} to ${currentWeek.weekEnd}.\n\n`;
    }

    const drillGuidance = this.hasExampleDrillIntent(question)
      ? ' Because the student is asking for practice or examples, include one small worked example and one edge/corner case when it fits the topic; for code, show the reasoning trace before the final snippet.'
      : '';
    const complexityGuidance = this.hasComplexityIntent(question)
      ? ' Include time and space complexity with named input variables and call out any tradeoff between speed and memory.'
      : '';
    const activeRecallGuidance = this.activeRecallGuidance(question);
    const conceptMapGuidance = this.conceptMapGuidance(question);
    const examCramGuidance = this.examCramGuidance(question);
    const studyPlanGuidance = this.studyPlanGuidance(question);
    const interleavingGuidance = this.interleavingGuidance(question);
    const teachBackGuidance = this.teachBackGuidance(question);
    const sourceAuditGuidance = this.sourceAuditGuidance(question);
    prompt += `=== QUESTION ===\nAnswer the student's question. Use the active course scope first${effectiveCourseName ? ` (${effectiveCourseName})` : ''}; do not pull supporting links or materials from other courses unless the student explicitly asks for them. For material-summary questions such as "what am I learning this week?", explain the actual topics in plain language rather than summarizing source numbers. Prefer parsed PDF/OCR content over title-only metadata; when only titles/folders are available, say "based on the indexed file list" and avoid inventing slide details.${drillGuidance}${complexityGuidance}${activeRecallGuidance}${conceptMapGuidance}${examCramGuidance}${studyPlanGuidance}${interleavingGuidance}${teachBackGuidance}${sourceAuditGuidance} Do not include a bibliography or source list in the answer. Use citations sparingly only when a specific claim needs verification; never fabricate a citation. For facts specific to this course (due dates, grading, instructions) rely strictly on the sources and say so plainly if they are missing. Be concise: 3-5 bullets or 2-5 sentences. Question: ${question}`;

    return {
      prompt,
      sources,
      presentation: {
        decorateCitations: !this.hasStudySummaryIntent(question),
        sourceDisplay: 'disclosure'
      },
      indexingStatus: this.lastCourseMaterialStatus || null,
      activeCourse: activeContext ? {
        courseId: effectiveCourseId,
        courseName: effectiveCourseName
      } : null
    };
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
        dueAt: item.dueAt || null,
        moduleName: item.moduleName || '',
        folderPath: item.folderPath || '',
        pathSegments: Array.isArray(item.pathSegments) ? item.pathSegments.slice() : [],
        weekHints: Array.isArray(item.weekHints) ? item.weekHints.slice() : [],
        scannedAt: item.scannedAt || null,
        indexedAt: item.indexedAt || null,
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null
      };
      if (Array.isArray(item.pages) && item.pages.length > 0) {
        item.pages.forEach(page => {
          const text = (page && page.text) ? String(page.text) : '';
          if (!text.trim()) return;
          chunks.push({ ...base, page: page.pageNum || null, text: this.sourceTextForItem(item, text) });
        });
      } else {
        const text = this.sourceTextForItem(item, item.content || '').trim();
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
