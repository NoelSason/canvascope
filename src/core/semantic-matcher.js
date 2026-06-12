/**
 * Canvascope Semantic Matcher
 * Computes Cosine Similarity across academic concept dimensions and performs
 * Reciprocal Rank Fusion (RRF) to merge and rerank lexical and semantic listings.
 */
class SemanticMatcher {
  static get DIMENSIONS() {
    return {
      EVALUATION: ['exam', 'quiz', 'test', 'midterm', 'final', 'grading', 'assessment', 'score', 'points', 'grade'],
      MATERIAL: ['slides', 'lecture', 'reading', 'paper', 'syllabus', 'deck', 'textbook', 'worksheet', 'document', 'pdf', 'notes'],
      TIME: ['due', 'deadline', 'date', 'calendar', 'schedule', 'when', 'overdue', 'time', 'upcoming', 'next'],
      COMMUNICATION: ['email', 'zoom', 'office hours', 'professor', 'ta', 'contact', 'question', 'help', 'instructor', 'officehours']
    };
  }

  /**
   * Generates a normalized concept vector from a text string.
   * Supports both 384-dimensional dense vectors and legacy dictionary vectors.
   * @param {string} text - The input text
   * @returns {Array<number>|Record<string, number>} Vector representation
   */
  static vectorize(text) {
    if (typeof window !== 'undefined' && window.LocalEmbeddings) {
      return window.LocalEmbeddings.generateFallbackEmbedding(text);
    }
    if (typeof globalThis !== 'undefined' && globalThis.LocalEmbeddings) {
      return globalThis.LocalEmbeddings.generateFallbackEmbedding(text);
    }

    const vector = {};
    const dims = this.DIMENSIONS;
    
    // Initialize dimensions to 0
    for (const key in dims) {
      vector[key] = 0;
    }

    if (!text) return vector;

    // Tokenize text into words
    const tokens = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    // Populate frequencies
    for (const token of tokens) {
      for (const [dim, synonyms] of Object.entries(dims)) {
        if (synonyms.some(syn => token.includes(syn) || syn.includes(token))) {
          vector[dim] += 1;
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

    return vector;
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
