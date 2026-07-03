/**
 * Canvascope Course Materials
 *
 * Local-first course document index for Canvas Files/Modules. Raw PDF/OCR text
 * stays in chrome.storage.local unless the user opts into Supabase sync.
 */
(function () {
  const DOCUMENTS_KEY = 'courseMaterialDocuments';
  const CHUNKS_KEY = 'courseMaterialChunks';
  const SETTINGS_KEY = 'courseMaterialSettings';
  const STATUS_KEY = 'courseMaterialIndexStatus';
  const CHUNK_MAX_CHARS = 1700;
  const CHUNK_OVERLAP_CHARS = 140;
  const MAX_LOCAL_SEARCH_CHUNKS = 12;

  const MONTHS = Object.freeze({
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  });

  const STOPWORDS = new Set([
    'what', 'when', 'where', 'which', 'who', 'why', 'how', 'this', 'that',
    'with', 'from', 'about', 'into', 'your', 'their', 'course', 'courses',
    'week', 'today', 'please', 'tell', 'give', 'show', 'learning', 'learn',
    'studying', 'study', 'material', 'materials'
  ]);

  function storageArea() {
    return chrome?.storage?.local;
  }

  async function storageGet(keys) {
    const area = storageArea();
    if (!area) return {};
    return area.get(keys);
  }

  async function storageSet(obj) {
    const area = storageArea();
    if (!area) return;
    await area.set(obj);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cleanUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
      const parsed = new URL(String(rawUrl), typeof location !== 'undefined' ? location.href : undefined);
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return String(rawUrl || '').split('#')[0];
    }
  }

  function stableHash(input) {
    const text = String(input || '');
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function localDateIso(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseIsoDay(value) {
    const s = String(value || '').slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function dateInRange(dayIso, startIso, endIso) {
    if (!dayIso || !startIso || !endIso) return false;
    return dayIso >= startIso && dayIso <= endIso;
  }

  function tokenize(text) {
    return String(text || '').toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length > 2 && !STOPWORDS.has(token));
  }

  function extractWeekHints(values) {
    const hints = new Set();
    const inputs = Array.isArray(values) ? values : [values];
    for (const value of inputs) {
      const text = String(value || '');
      const re = /\bweek\s*#?\s*0*(\d{1,3})\b/ig;
      let match = re.exec(text);
      while (match) {
        hints.add(String(match[1] || '').replace(/^0+/, '') || '0');
        match = re.exec(text);
      }
    }
    return Array.from(hints);
  }

  function parseMonthToken(value) {
    const key = String(value || '').toLowerCase().replace(/\./g, '');
    return Object.prototype.hasOwnProperty.call(MONTHS, key) ? MONTHS[key] : null;
  }

  function parseWeekDateRange(text, referenceDate = new Date()) {
    const source = normalizeText(text);
    if (!source) return null;

    const monthName = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    const rangeRe = new RegExp(`${monthName}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|—|to)\\s*(?:${monthName}\\.?\\s*)?(\\d{1,2})(?:st|nd|rd|th)?`, 'i');
    const singleRe = new RegExp(`${monthName}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`, 'i');

    const range = source.match(rangeRe);
    const year = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? referenceDate.getFullYear()
      : new Date().getFullYear();

    if (range) {
      const startMonth = parseMonthToken(range[1]);
      const startDay = Number(range[2]);
      const endMonth = parseMonthToken(range[3]) ?? startMonth;
      const endDay = Number(range[4]);
      if (startMonth == null || endMonth == null || !startDay || !endDay) return null;
      const start = new Date(year, startMonth, startDay);
      const endYear = endMonth < startMonth ? year + 1 : year;
      const end = new Date(endYear, endMonth, endDay);
      return { start: localDateIso(start), end: localDateIso(end) };
    }

    const single = source.match(singleRe);
    if (single) {
      const month = parseMonthToken(single[1]);
      const day = Number(single[2]);
      if (month == null || !day) return null;
      const date = new Date(year, month, day);
      const iso = localDateIso(date);
      return { start: iso, end: iso };
    }

    return null;
  }

  function extractCanvasFileId(rawUrl) {
    const text = String(rawUrl || '');
    const preview = text.match(/[?&]preview=(\d+)/);
    if (preview) return preview[1];
    const file = text.match(/\/files\/(\d+)(?:\/|$|\?|#)/);
    return file ? file[1] : '';
  }

  function isPdfDocument(doc) {
    const mime = String(doc?.mimeType || doc?.contentType || '').toLowerCase();
    const title = String(doc?.title || doc?.filename || '').toLowerCase();
    const url = String(doc?.downloadUrl || doc?.url || doc?.sourceUrl || '').toLowerCase();
    return mime.includes('pdf') || /\.pdf(?:$|\?)/.test(title) || /\.pdf(?:$|\?)/.test(url);
  }

  function isAnswerKeyLike(docOrChunk) {
    const blob = [
      docOrChunk?.title,
      docOrChunk?.folderPath,
      docOrChunk?.moduleName,
      docOrChunk?.text
    ].join(' ').toLowerCase();
    return /\b(answer\s*key|answers?|solutions?|worksheet\s+solutions?|sol\.?pdf|dps_sol)\b/.test(blob);
  }

  function queryAllowsAnswerKeys(query) {
    return /\b(answer|answers|solution|solutions|key|worked|worksheet)\b/i.test(String(query || ''));
  }

  function hasStudySummaryIntent(question) {
    const q = String(question || '').toLowerCase();
    const material = /\b(stud(?:y|ied|ying)|learn(?:ed|ing)?|cover(?:ed|ing)?|topic|topics|material|materials|lecture|lectures|slides?|readings?|notes?|files?|content)\b/.test(q);
    const temporal = /\b(this week|last week|today|recent(?:ly)?|latest|current|now|so far|week(?:\s*\d+)?)\b/.test(q);
    const summaryAsk = /\b(what|which|list|summar(?:y|ize|ise)|tell me|show me)\b/.test(q);
    return material && (temporal || summaryAsk);
  }

  function sameCourse(value, { courseId = '', courseName = '' } = {}) {
    const id = String(courseId || '').trim();
    const name = normalizeText(courseName).toLowerCase();
    if (id && String(value?.courseId || '').trim() === id) return true;
    if (name && normalizeText(value?.courseName).toLowerCase() === name) return true;
    return !id && !name;
  }

  function normalizeDocument(raw, now = new Date()) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const url = cleanUrl(source.sourceUrl || source.url || source.downloadUrl || '');
    const downloadUrl = cleanUrl(source.downloadUrl || source.sourceUrl || source.url || '');
    const canvasFileId = normalizeText(source.canvasFileId || source.fileId || extractCanvasFileId(url) || extractCanvasFileId(downloadUrl));
    const title = normalizeText(source.title || source.displayName || source.filename || (url.split('/').pop() || 'Course file'));
    const courseId = normalizeText(source.courseId);
    const courseName = normalizeText(source.courseName) || 'General';
    const pathSegments = asArray(source.pathSegments).map(normalizeText).filter(Boolean);
    const folderPath = normalizeText(source.folderPath) || pathSegments.join(' > ');
    const moduleName = normalizeText(source.moduleName) || pathSegments[0] || 'Files';
    const dateRange = source.weekStart && source.weekEnd
      ? { start: source.weekStart, end: source.weekEnd }
      : parseWeekDateRange([folderPath, moduleName, title].join(' '), now);
    const weekHints = Array.isArray(source.weekHints) && source.weekHints.length
      ? source.weekHints.map(value => String(value || '').replace(/^0+/, '') || '0').filter(Boolean)
      : extractWeekHints([folderPath, moduleName, title]);
    const identity = [courseId, courseName, canvasFileId, url || downloadUrl, title].join('|');
    const documentId = normalizeText(source.documentId || source.id) || `course-material:${stableHash(identity)}`;
    const discoveredAt = normalizeText(source.discoveredAt) || new Date().toISOString();

    return {
      documentId,
      courseId,
      courseName,
      canvasFileId,
      title,
      url: url || downloadUrl,
      downloadUrl: downloadUrl || url,
      sourceUrl: url || downloadUrl,
      mimeType: normalizeText(source.mimeType || source.contentType),
      moduleName,
      folderPath,
      pathSegments,
      weekHints,
      weekStart: dateRange?.start || null,
      weekEnd: dateRange?.end || null,
      modifiedAt: normalizeText(source.modifiedAt || source.updatedAt || source.createdAt),
      discoveredAt,
      updatedAt: new Date().toISOString(),
      indexedAt: source.indexedAt || null,
      parsedAt: source.parsedAt || null,
      contentHash: source.contentHash || null,
      textLength: Number(source.textLength) || 0,
      pageCount: Number(source.pageCount) || 0,
      parseError: source.parseError || null,
      status: source.status || 'queued',
      isPdf: source.isPdf === true || isPdfDocument(source)
    };
  }

  function normalizePages(pages) {
    return asArray(pages).map((page, index) => {
      if (typeof page === 'string') {
        return { pageNum: index + 1, text: page };
      }
      return {
        pageNum: Number(page?.pageNum || page?.page || index + 1),
        text: String(page?.text || '')
      };
    });
  }

  function splitTextIntoChunks(text) {
    const source = String(text || '').trim();
    if (!source) return [];
    if (source.length <= CHUNK_MAX_CHARS) return [source];

    const chunks = [];
    let start = 0;
    while (start < source.length) {
      let end = Math.min(source.length, start + CHUNK_MAX_CHARS);
      if (end < source.length) {
        const boundary = Math.max(
          source.lastIndexOf('\n', end),
          source.lastIndexOf('. ', end),
          source.lastIndexOf('; ', end)
        );
        if (boundary > start + 500) end = boundary + 1;
      }
      chunks.push(source.slice(start, end).trim());
      if (end >= source.length) break;
      start = Math.max(0, end - CHUNK_OVERLAP_CHARS);
    }
    return chunks.filter(Boolean);
  }

  function buildChunksForDocument(document, pages) {
    const chunks = [];
    normalizePages(pages).forEach((page) => {
      splitTextIntoChunks(page.text).forEach((text, idx) => {
        chunks.push({
          chunkId: `${document.documentId}:p${page.pageNum}:${idx}`,
          documentId: document.documentId,
          courseId: document.courseId,
          courseName: document.courseName,
          canvasFileId: document.canvasFileId,
          title: document.title,
          url: document.url || document.downloadUrl || '',
          sourceUrl: document.sourceUrl || document.url || '',
          pageStart: page.pageNum,
          pageEnd: page.pageNum,
          chunkIndex: chunks.length,
          text,
          moduleName: document.moduleName,
          folderPath: document.folderPath,
          pathSegments: document.pathSegments,
          weekHints: document.weekHints,
          weekStart: document.weekStart,
          weekEnd: document.weekEnd,
          updatedAt: new Date().toISOString()
        });
      });
    });
    return chunks;
  }

  function metadataText(document) {
    return [
      document.title,
      document.courseName,
      document.moduleName,
      document.folderPath,
      document.weekStart && document.weekEnd ? `${document.weekStart} to ${document.weekEnd}` : '',
      asArray(document.weekHints).map(week => `week ${week}`).join(' ')
    ].map(normalizeText).filter(Boolean).join('\n');
  }

  function findCurrentWeekRange(documents, { today = new Date(), courseId = '', courseName = '' } = {}) {
    const dayIso = typeof today === 'string' ? today.slice(0, 10) : localDateIso(today);
    const matching = asArray(documents)
      .filter(doc => sameCourse(doc, { courseId, courseName }))
      .filter(doc => dateInRange(dayIso, doc.weekStart, doc.weekEnd))
      .sort((a, b) =>
        String(a.weekStart || '').localeCompare(String(b.weekStart || '')) ||
        String(a.title || '').localeCompare(String(b.title || ''))
      );
    if (!matching.length) return null;
    return {
      weekStart: matching[0].weekStart,
      weekEnd: matching[0].weekEnd,
      weekHints: Array.from(new Set(matching.flatMap(doc => asArray(doc.weekHints))))
    };
  }

  function scoreSearchEntry(entry, query, tokens, opts) {
    const document = entry.document || entry;
    const text = String(entry.text || '');
    const titleLower = String(document.title || '').toLowerCase();
    const folderLower = String(document.folderPath || '').toLowerCase();
    const moduleLower = String(document.moduleName || '').toLowerCase();
    const textLower = text.toLowerCase();
    let score = 0;

    for (const token of tokens) {
      if (titleLower.includes(token)) score += 10;
      if (folderLower.includes(token)) score += 7;
      if (moduleLower.includes(token)) score += 6;
      if (textLower.includes(token)) score += 2;
    }

    if (text.trim().length > 80) score += 8;
    if (document.status === 'indexed') score += 4;
    if (document.isPdf) score += 2;

    const studySummary = hasStudySummaryIntent(query);
    const dayIso = typeof opts.today === 'string' ? opts.today.slice(0, 10) : localDateIso(opts.today || new Date());
    if (studySummary && dateInRange(dayIso, document.weekStart, document.weekEnd)) score += 40;

    const currentWeek = opts.currentWeek;
    if (studySummary && currentWeek?.weekStart && currentWeek?.weekEnd) {
      if (document.weekStart === currentWeek.weekStart && document.weekEnd === currentWeek.weekEnd) score += 18;
      const sameHint = asArray(document.weekHints).some(week => asArray(currentWeek.weekHints).includes(week));
      if (sameHint) score += 8;
    }

    if (isAnswerKeyLike({ ...document, text }) && !queryAllowsAnswerKeys(query)) score -= 35;

    const modified = Date.parse(document.modifiedAt || document.indexedAt || document.discoveredAt || '');
    if (Number.isFinite(modified)) {
      const ageDays = (Date.now() - modified) / (24 * 60 * 60 * 1000);
      if (ageDays >= 0 && ageDays <= 14) score += 2;
    }

    return score;
  }

  function toRagChunk(entry, score) {
    const document = entry.document || entry;
    const page = entry.pageStart || null;
    const body = String(entry.text || '').trim();
    const text = body
      ? `${metadataText(document)}\n${body}`.trim()
      : metadataText(document);
    return {
      title: document.title,
      courseName: document.courseName,
      courseId: document.courseId,
      type: 'course_material',
      url: document.url || document.sourceUrl || document.downloadUrl || '',
      page,
      text: text.substring(0, CHUNK_MAX_CHARS + 500),
      moduleName: document.moduleName || '',
      folderPath: document.folderPath || '',
      pathSegments: asArray(document.pathSegments).slice(),
      weekHints: asArray(document.weekHints).slice(),
      weekStart: document.weekStart || null,
      weekEnd: document.weekEnd || null,
      indexedAt: document.indexedAt || document.discoveredAt || null,
      score
    };
  }

  class CourseMaterials {
    static keys = Object.freeze({
      documents: DOCUMENTS_KEY,
      chunks: CHUNKS_KEY,
      settings: SETTINGS_KEY,
      status: STATUS_KEY
    });

    static parseWeekDateRange(text, referenceDate) {
      return parseWeekDateRange(text, referenceDate);
    }

    static findCurrentWeekRange(documents, opts) {
      return findCurrentWeekRange(documents, opts);
    }

    static normalizeDocument(raw, now) {
      return normalizeDocument(raw, now);
    }

    static normalizePages(pages) {
      return normalizePages(pages);
    }

    static buildChunksForDocument(document, pages) {
      return buildChunksForDocument(document, pages);
    }

    static async getSettings() {
      const data = await storageGet([SETTINGS_KEY, 'settings']);
      const direct = data[SETTINGS_KEY] && typeof data[SETTINGS_KEY] === 'object' ? data[SETTINGS_KEY] : {};
      const appSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
      return {
        supabaseSyncEnabled: appSettings.courseMaterialSupabaseSync === true || direct.supabaseSyncEnabled === true
      };
    }

    static async setSettings(patch) {
      const current = await this.getSettings();
      const next = { ...current, ...(patch || {}) };
      await storageSet({ [SETTINGS_KEY]: next });
      return next;
    }

    static async readIndex() {
      const data = await storageGet([DOCUMENTS_KEY, CHUNKS_KEY, STATUS_KEY]);
      return {
        documents: asArray(data[DOCUMENTS_KEY]),
        chunks: asArray(data[CHUNKS_KEY]),
        status: data[STATUS_KEY] && typeof data[STATUS_KEY] === 'object' ? data[STATUS_KEY] : {}
      };
    }

    static async writeIndex({ documents, chunks, status }) {
      const payload = {};
      if (documents) payload[DOCUMENTS_KEY] = documents;
      if (chunks) payload[CHUNKS_KEY] = chunks;
      if (status) payload[STATUS_KEY] = status;
      await storageSet(payload);
    }

    static async upsertDiscoveredDocuments(rawDocuments, opts = {}) {
      const incoming = asArray(rawDocuments)
        .map(raw => normalizeDocument(raw, opts.today || new Date()))
        .filter(doc => doc.title && (doc.url || doc.downloadUrl || doc.canvasFileId));
      if (!incoming.length) return { upserted: 0, queued: 0, documents: [] };

      const { documents, chunks, status } = await this.readIndex();
      const byId = new Map(documents.map(doc => [doc.documentId, doc]));
      let queued = 0;
      for (const doc of incoming) {
        const existing = byId.get(doc.documentId);
        const merged = existing
          ? {
              ...existing,
              ...doc,
              status: existing.status === 'indexed' ? 'indexed' : (existing.status === 'indexing' ? 'indexing' : doc.status),
              indexedAt: existing.indexedAt || doc.indexedAt,
              parsedAt: existing.parsedAt || doc.parsedAt,
              contentHash: existing.contentHash || doc.contentHash,
              textLength: existing.textLength || doc.textLength,
              pageCount: existing.pageCount || doc.pageCount,
              parseError: existing.status === 'failed' ? existing.parseError : doc.parseError
            }
          : doc;
        if (merged.isPdf && merged.status !== 'indexed' && merged.status !== 'indexing') queued += 1;
        byId.set(doc.documentId, merged);
      }

      const nextDocuments = Array.from(byId.values())
        .sort((a, b) =>
          String(a.courseName || '').localeCompare(String(b.courseName || '')) ||
          String(a.folderPath || '').localeCompare(String(b.folderPath || '')) ||
          String(a.title || '').localeCompare(String(b.title || ''))
        );
      const nextStatus = {
        ...status,
        lastDiscoveryAt: new Date().toISOString(),
        lastDiscoveredCount: incoming.length,
        totalDocuments: nextDocuments.length
      };
      await this.writeIndex({ documents: nextDocuments, chunks, status: nextStatus });
      return { upserted: incoming.length, queued, documents: incoming };
    }

    static async setDocumentStatus(rawDocOrId, nextStatus, patch = {}) {
      const id = typeof rawDocOrId === 'string'
        ? rawDocOrId
        : normalizeDocument(rawDocOrId).documentId;
      const { documents, chunks, status } = await this.readIndex();
      const now = new Date().toISOString();
      const nextDocuments = documents.map(doc => doc.documentId === id
        ? { ...doc, ...patch, status: nextStatus, updatedAt: now }
        : doc
      );
      await this.writeIndex({
        documents: nextDocuments,
        chunks,
        status: { ...status, lastStatusAt: now }
      });
    }

    static async storeParsedPdf(rawDoc, pagesInput) {
      const pages = normalizePages(pagesInput);
      if (!pages.length) return { stored: false, chunks: 0 };
      const { documents, chunks, status } = await this.readIndex();
      const incomingDoc = normalizeDocument(rawDoc);
      const existingDoc = documents.find(doc => doc.documentId === incomingDoc.documentId) || {};
      const fullText = pages.map(page => page.text).join('\n').trim();
      const now = new Date().toISOString();
      const document = {
        ...incomingDoc,
        ...existingDoc,
        ...incomingDoc,
        status: fullText ? 'indexed' : 'failed',
        parsedAt: now,
        indexedAt: now,
        updatedAt: now,
        pageCount: pages.length,
        textLength: fullText.length,
        contentHash: stableHash(fullText),
        parseError: fullText ? null : 'No text extracted'
      };
      const documentChunks = fullText ? buildChunksForDocument(document, pages) : [];
      const nextDocuments = [
        ...documents.filter(doc => doc.documentId !== document.documentId),
        document
      ].sort((a, b) =>
        String(a.courseName || '').localeCompare(String(b.courseName || '')) ||
        String(a.folderPath || '').localeCompare(String(b.folderPath || '')) ||
        String(a.title || '').localeCompare(String(b.title || ''))
      );
      const nextChunks = [
        ...chunks.filter(chunk => chunk.documentId !== document.documentId),
        ...documentChunks
      ];
      await this.writeIndex({
        documents: nextDocuments,
        chunks: nextChunks,
        status: {
          ...status,
          lastIndexedAt: now,
          lastIndexedTitle: document.title,
          totalDocuments: nextDocuments.length,
          totalChunks: nextChunks.length
        }
      });
      return { stored: true, document, chunks: documentChunks.length };
    }

    static async searchLocal(query, opts = {}) {
      const { documents, chunks, status } = await this.readIndex();
      const courseId = normalizeText(opts.courseId);
      const courseName = normalizeText(opts.courseName);
      const tokens = tokenize(query);
      const currentWeek = findCurrentWeekRange(documents, {
        today: opts.today || new Date(),
        courseId,
        courseName
      });
      const allowAnswerKeys = queryAllowsAnswerKeys(query);
      const entries = [];
      const byDocId = new Map(documents.map(doc => [doc.documentId, doc]));

      for (const chunk of chunks) {
        const document = byDocId.get(chunk.documentId) || chunk;
        if (!sameCourse(document, { courseId, courseName })) continue;
        if (!allowAnswerKeys && isAnswerKeyLike({ ...document, text: chunk.text })) continue;
        entries.push({ ...chunk, document });
      }

      for (const document of documents) {
        if (!sameCourse(document, { courseId, courseName })) continue;
        if (!allowAnswerKeys && isAnswerKeyLike(document)) continue;
        const hasParsedChunks = chunks.some(chunk => chunk.documentId === document.documentId);
        if (hasParsedChunks && !hasStudySummaryIntent(query)) continue;
        entries.push({
          ...document,
          document,
          pageStart: null,
          text: metadataText(document)
        });
      }

      const scored = entries
        .map(entry => ({ entry, score: scoreSearchEntry(entry, query, tokens, { ...opts, currentWeek }) }))
        .filter(item => item.score > (hasStudySummaryIntent(query) ? -20 : 0))
        .sort((a, b) =>
          b.score - a.score ||
          String(a.entry.document?.folderPath || '').localeCompare(String(b.entry.document?.folderPath || '')) ||
          String(a.entry.document?.title || '').localeCompare(String(b.entry.document?.title || ''))
        );

      const selected = [];
      const seen = new Set();
      let used = 0;
      const limit = Number(opts.limit) || MAX_LOCAL_SEARCH_CHUNKS;
      const charBudget = Number(opts.charBudget) || 9000;
      for (const item of scored) {
        if (selected.length >= limit) break;
        const chunk = toRagChunk(item.entry, item.score);
        const key = `${chunk.url}|${chunk.page || ''}|${chunk.title}`;
        if (seen.has(key)) continue;
        const cost = chunk.text.length + chunk.title.length + 64;
        if (selected.length > 0 && used + cost > charBudget) continue;
        seen.add(key);
        selected.push(chunk);
        used += cost;
      }

      return {
        chunks: selected,
        status: {
          ...status,
          totalDocuments: documents.length,
          totalChunks: chunks.length,
          indexedDocuments: documents.filter(doc => doc.status === 'indexed').length,
          queuedDocuments: documents.filter(doc => doc.status === 'queued' || doc.status === 'indexing').length,
          failedDocuments: documents.filter(doc => doc.status === 'failed').length,
          currentWeek
        }
      };
    }

    static async searchSupabase(query, opts = {}) {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
        return { chunks: [], status: { remoteSkipped: true } };
      }
      const settings = await this.getSettings();
      if (!settings.supabaseSyncEnabled) return { chunks: [], status: { remoteSkipped: true, reason: 'disabled' } };
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'searchCourseMaterialsSupabase',
          query,
          courseId: opts.courseId || '',
          limit: opts.limit || MAX_LOCAL_SEARCH_CHUNKS,
          weekStart: opts.weekStart || null,
          weekEnd: opts.weekEnd || null
        }, (response) => {
          void chrome.runtime.lastError;
          if (!response?.success) {
            resolve({ chunks: [], status: { remoteSkipped: true, reason: response?.error || 'unavailable' } });
            return;
          }
          resolve({
            chunks: Array.isArray(response.chunks) ? response.chunks : [],
            status: response.status || { remote: true }
          });
        });
      });
    }

    static async search(query, opts = {}) {
      const [local, remote] = await Promise.all([
        this.searchLocal(query, opts),
        this.searchSupabase(query, opts).catch(() => ({ chunks: [], status: { remoteSkipped: true } }))
      ]);
      const merged = [];
      const seen = new Set();
      for (const chunk of [...(remote.chunks || []), ...(local.chunks || [])]) {
        const key = `${chunk.url || ''}|${chunk.page || ''}|${chunk.title || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(chunk);
        if (merged.length >= (opts.limit || MAX_LOCAL_SEARCH_CHUNKS)) break;
      }
      return {
        chunks: merged,
        status: {
          ...(local.status || {}),
          remote: remote.status || null
        }
      };
    }
  }

  const root = typeof self !== 'undefined' ? self : globalThis;
  root.CanvascopeCourseMaterials = CourseMaterials;
  if (typeof window !== 'undefined') {
    window.CanvascopeCourseMaterials = CourseMaterials;
  }
})();
