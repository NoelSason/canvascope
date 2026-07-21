/**
 * Canvascope Semantic Matcher
 * Computes Cosine Similarity across academic concept dimensions and performs
 * Reciprocal Rank Fusion (RRF) to merge and rerank lexical and semantic listings.
 */
class SemanticMatcher {
  static get DIMENSIONS() {
    if (!this._dimensions) {
      this._dimensions = Object.freeze({
        EVALUATION: Object.freeze(['exam', 'quiz', 'test', 'midterm', 'final', 'grading', 'assessment', 'score', 'points', 'grade']),
        MATERIAL: Object.freeze(['slides', 'lecture', 'reading', 'paper', 'syllabus', 'deck', 'textbook', 'worksheet', 'document', 'pdf', 'notes']),
        TIME: Object.freeze(['due', 'deadline', 'date', 'calendar', 'schedule', 'when', 'overdue', 'time', 'upcoming', 'next']),
        COMMUNICATION: Object.freeze(['email', 'zoom', 'office hours', 'professor', 'ta', 'contact', 'question', 'help', 'instructor', 'officehours']),
        COMPUTING: Object.freeze(['code', 'coding', 'programming', 'python', 'notebook', 'jupyter', 'github', 'repo', 'terminal', 'algorithm', 'debug', 'function', 'runtime', 'complexity', 'big-o', 'recursion', 'stack', 'heap', 'array', 'graph', 'tree', 'api', 'cli', 'compile', 'test']),
        STUDY_STRATEGY: Object.freeze(['active recall', 'spaced repetition', 'flashcards', 'flashcard', 'anki', 'self quiz', 'self-quiz', 'practice problems', 'teach back', 'teach-back', 'explain aloud', 'study guide', 'review loop', 'retrieval practice', 'mistake review', 'confidence rating'])
      });
    }
    return this._dimensions;
  }

  static get VECTOR_CACHE_LIMIT() {
    return 250;
  }

  static get VECTOR_CACHE_TEXT_LIMIT() {
    return 12000;
  }

  static get CONCEPT_TERMS() {
    if (!this._conceptTerms) {
      this._conceptTerms = Object.freeze(
        Object.entries(this.DIMENSIONS).map(([dimension, synonyms]) => Object.freeze({
          dimension,
          exact: Object.freeze(new Set(synonyms.filter(term => !term.includes(' ')))),
          phrases: Object.freeze(synonyms.filter(term => term.includes(' ')))
        }))
      );
    }
    return this._conceptTerms;
  }

  static cloneVector(vector) {
    return Array.isArray(vector) ? vector.slice() : { ...vector };
  }

  static cachedVector(cacheKey) {
    if (!this._vectorCache) return null;
    const cached = this._vectorCache.get(cacheKey);
    if (!cached) return null;
    // Refresh insertion order for a tiny LRU so repeated Canvas searches stay hot.
    this._vectorCache.delete(cacheKey);
    this._vectorCache.set(cacheKey, cached);
    return this.cloneVector(cached);
  }

  static rememberVector(cacheKey, vector) {
    if (!this._vectorCache) this._vectorCache = new Map();
    this._vectorCache.set(cacheKey, this.cloneVector(vector));
    while (this._vectorCache.size > this.VECTOR_CACHE_LIMIT) {
      const oldestKey = this._vectorCache.keys().next().value;
      this._vectorCache.delete(oldestKey);
    }
    return this.cloneVector(vector);
  }

  /**
   * Generates a normalized concept vector from a text string.
   * Supports both 384-dimensional dense vectors and legacy dictionary vectors.
   * @param {string} text - The input text
   * @returns {Array<number>|Record<string, number>} Vector representation
   */
  static vectorize(text) {
    const normalizedText = String(text || '');
    const hasWindowEmbeddings = typeof window !== 'undefined' && window.LocalEmbeddings;
    const hasGlobalEmbeddings = typeof globalThis !== 'undefined' && globalThis.LocalEmbeddings;
    const canCacheVector = normalizedText.length <= this.VECTOR_CACHE_TEXT_LIMIT;
    const embeddingMode = hasWindowEmbeddings || hasGlobalEmbeddings ? 'dense' : 'concept';
    const cacheKey = canCacheVector ? `${embeddingMode}:${normalizedText}` : null;
    const cached = cacheKey ? this.cachedVector(cacheKey) : null;
    if (cached) return cached;

    if (hasWindowEmbeddings) {
      const vector = window.LocalEmbeddings.generateFallbackEmbedding(normalizedText);
      return cacheKey ? this.rememberVector(cacheKey, vector) : this.cloneVector(vector);
    }
    if (hasGlobalEmbeddings) {
      const vector = globalThis.LocalEmbeddings.generateFallbackEmbedding(normalizedText);
      return cacheKey ? this.rememberVector(cacheKey, vector) : this.cloneVector(vector);
    }

    const vector = {};
    const dims = this.DIMENSIONS;
    
    // Initialize dimensions to 0
    for (const key in dims) {
      vector[key] = 0;
    }

    if (!normalizedText) return cacheKey ? this.rememberVector(cacheKey, vector) : this.cloneVector(vector);

    // Tokenize text once, then score exact concept hits in O(tokens + phrases)
    // instead of repeatedly scanning every synonym for every token. This keeps
    // side-panel retrieval responsive when CS PDFs/notebooks produce many chunks.
    const lowerText = normalizedText.toLowerCase();
    const tokenCounts = new Map();
    for (const token of lowerText.replace(/[^\w\s-]/g, ' ').split(/\s+/)) {
      if (token.length > 2) {
        tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
      }
    }

    // Populate frequencies
    for (const { dimension, exact, phrases } of this.CONCEPT_TERMS) {
      for (const [token, count] of tokenCounts) {
        if (exact.has(token)) {
          vector[dimension] += count;
        }
      }
      for (const phrase of phrases) {
        if (lowerText.includes(phrase)) {
          vector[dimension] += 1;
        }
      }
    }

    // Calculate Euclidean length
    let sumSquares = 0;
    for (const key in dims) {
      sumSquares += vector[key] * vector[key];
    }
    const length = Math.sqrt(sumSquares);

    // Normalize vector
    if (length > 0) {
      for (const key in dims) {
        vector[key] = vector[key] / length;
      }
    }

    return cacheKey ? this.rememberVector(cacheKey, vector) : this.cloneVector(vector);
  }

  /**
   * Computes the Cosine Similarity between two concept vectors.
   * Handles both arrays and concept dictionaries.
   * @param {Array<number>|Record<string, number>} v1 - First vector
   * @param {Array<number>|Record<string, number>} v2 - Second vector
   * @returns {number} Cosine similarity (between 0 and 1)
   */
  static cosineSimilarity(v1, v2) {
    if (Array.isArray(v1) && Array.isArray(v2)) {
      if (v1.length !== v2.length) return 0;
      let dotProduct = 0;
      for (let i = 0; i < v1.length; i++) {
        dotProduct += (v1[i] || 0) * (v2[i] || 0);
      }
      return Math.max(0, Math.min(1, dotProduct));
    }

    let dotProduct = 0;
    const keys = Object.keys(this.DIMENSIONS);
    
    for (const key of keys) {
      dotProduct += (v1[key] || 0) * (v2[key] || 0);
    }
    
    return dotProduct; // Since both vectors are normalized, dot product is the cosine similarity
  }

  /**
   * Merges two ranked lists using Reciprocal Rank Fusion (RRF).
   * @param {Array<any>} listA - First ranked list
   * @param {Array<any>} listB - Second ranked list
   * @param {function} idExtractor - Custom function to extract a unique ID from list items
   * @param {number} k - RRF smoothing parameter (defaults to 60)
   * @returns {Array<any>} Combined, reranked list of items
   */
  static rrfMerge(listA, listB, idExtractor = (item) => item.title + '|' + item.courseName, k = 60) {
    const scores = new Map();
    const itemMap = new Map();

    const processList = (list) => {
      if (!Array.isArray(list)) return;
      list.forEach((item, index) => {
        const id = idExtractor(item);
        const rank = index + 1;
        const score = 1.0 / (k + rank);
        
        scores.set(id, (scores.get(id) || 0) + score);
        itemMap.set(id, item);
      });
    };

    processList(listA);
    processList(listB);

    // Sort by combined RRF score descending
    const sortedIds = Array.from(scores.keys())
      .sort((a, b) => scores.get(b) - scores.get(a));

    return sortedIds.map(id => itemMap.get(id));
  }
}
