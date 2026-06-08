/**
 * Canvascope Local Embeddings Controller
 * Generates dense semantic vectors (384 dimensions) for local RAG retrieval.
 * Employs a dual-pipeline approach:
 * 1. Primary: ONNX-based all-MiniLM-L6-v2 model via Transformers.js (when available/loaded).
 * 2. Fallback: Dense semantic vocabulary projection (24 distinct academic conceptual dimensions)
 *    hMap-projected into 384 dimensions for zero-dependency instant offline execution.
 */
class LocalEmbeddingsController {
  constructor() {
    this.pipelineInstance = null;
    this.loading = false;
    this.initialized = false;
  }

  /**
   * Initializes the ONNX embedding pipeline inside the side panel.
   * Loads the model dynamically.
   */
  async initPipeline() {
    if (this.initialized || this.loading) return;
    this.loading = true;
    console.log('[Canvascope Embeddings] Initializing ONNX embedding pipeline...');
    try {
      // Import Xenova Transformers.js dynamically from CDN or fallback
      // Since MV3 CSP allows self + wasm-eval, we can load the module
      const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.14.0');
      
      // Load feature-extraction pipeline with MiniLM-L6 model
      this.pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
        progress_callback: (info) => {
          if (info.status === 'progress') {
            console.log(`[Canvascope Embeddings] Loading ONNX model: ${info.loaded}/${info.total} (${info.progress.toFixed(1)}%)`);
          }
        }
      });
      
      this.initialized = true;
      console.log('[Canvascope Embeddings] ONNX local embeddings pipeline initialized successfully.');
    } catch (e) {
      console.warn('[Canvascope Embeddings] Failed to load ONNX pipeline, utilizing semantic fallback:', e);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Generates a 384-dimensional float array embedding for the given text.
   * @param {string} text - Input text
   * @returns {Promise<Array<number>>} 384-dimensional float array
   */
  async getEmbedding(text) {
    if (!text) return new Array(384).fill(0);

    // 1. Attempt ONNX model first
    if (this.initialized && this.pipelineInstance) {
      try {
        const output = await this.pipelineInstance(text, { pooling: 'mean', normalize: true });
        const vector = Array.from(output.data);
        if (vector.length === 384) {
          return vector;
        }
      } catch (err) {
        console.warn('[Canvascope Embeddings] ONNX execution failed, falling back:', err);
      }
    }

    // 2. Fallback to 24-dimension Vocabulary Projection hashed into 384 dimensions
    return this.generateFallbackEmbedding(text);
  }

  /**
   * Generates a 384-dimensional dense vector using a 24-dimensional semantic concept bag.
   * Uses a deterministic pseudo-random projection matrix to expand 24 concepts into 384 dimensions.
   */
  generateFallbackEmbedding(text) {
    const rawTokens = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    // 24 Conceptual dimensions mapping academic contexts
    const VOCAB_DIMENSIONS = {
      EXAM: ['exam', 'midterm', 'final', 'test', 'quiz', 'quizzes', 'assessment', 'assessments'],
      GRADE: ['grade', 'grades', 'score', 'scores', 'points', 'grading', 'rubric', 'weight'],
      ASSIGNMENT: ['assignment', 'assignments', 'homework', 'hw', 'deliverable', 'deliverables', 'project', 'projects', 'task', 'tasks'],
      READING: ['reading', 'readings', 'textbook', 'chapter', 'chapters', 'book', 'papers', 'article', 'articles'],
      LECTURE: ['lecture', 'lectures', 'slides', 'deck', 'presentation', 'class', 'classes', 'session', 'attendance'],
      SYLLABUS: ['syllabus', 'policy', 'policies', 'rules', 'calendar', 'schedule', 'course', 'courses'],
      TIME_DUE: ['due', 'deadline', 'deadlines', 'submit', 'submission', 'turnin', 'by'],
      TIME_WHEN: ['when', 'schedule', 'date', 'dates', 'calendar', 'time', 'upcoming', 'next', 'weekly'],
      PEOPLE_PROF: ['professor', 'prof', 'instructor', 'teacher', 'faculty', 'lecturer'],
      PEOPLE_TA: ['ta', 'tas', 'assistant', 'assistants', 'tutor', 'tutors', 'grader', 'graders'],
      OFFICE_HOURS: ['officehours', 'office hours', 'oh', 'consultation', 'zoom', 'link'],
      LABORATORY: ['lab', 'labs', 'laboratory', 'workstation', 'experiment', 'experiments', 'setup'],
      DISCUSSION: ['discussion', 'discussions', 'forum', 'piazza', 'edstem', 'canvas', 'post', 'posts'],
      HELP: ['help', 'questions', 'support', 'faq', 'resources', 'resource', 'guidelines'],
      OFFICIAL: ['announcement', 'announcements', 'notification', 'notifications', 'email', 'inbox'],
      MATH: ['math', 'mathematics', 'equation', 'formula', 'calculus', 'algebra', 'statistics', 'proof'],
      SCIENCE: ['science', 'biology', 'chemistry', 'physics', 'lab', 'experimental', 'natural'],
      COMPUTER: ['computer', 'code', 'programming', 'software', 'git', 'github', 'python', 'java', 'script'],
      ENGINEERING: ['engineering', 'design', 'circuit', 'system', 'systems', 'hardware', 'mechanical'],
      LITERATURE: ['literature', 'writing', 'essay', 'essays', 'paper', 'thesis', 'reading', 'book'],
      HISTORY: ['history', 'historical', 'social', 'culture', 'civilization', 'context', 'archive'],
      BUSINESS: ['business', 'finance', 'economics', 'management', 'marketing', 'accounting', 'strategy'],
      LOCATION: ['room', 'hall', 'building', 'campus', 'zoom', 'online', 'location', 'auditorium'],
      STATUS: ['complete', 'done', 'todo', 'pending', 'overdue', 'missing', 'progress', 'active']
    };

    const conceptVector = new Array(24).fill(0);
    const keys = Object.keys(VOCAB_DIMENSIONS);

    // Populate the 24-dimensional semantic concept vector
    for (const token of rawTokens) {
      keys.forEach((key, idx) => {
        const synonyms = VOCAB_DIMENSIONS[key];
        if (synonyms.some(syn => token.includes(syn) || syn.includes(token))) {
          conceptVector[idx] += 1;
        }
      });
    }

    // Expand the 24-dimension vector to 384 dimensions using a deterministic random projection matrix.
    // This allows cosine similarity on the expanded vectors to preserve distances in the concept space.
    const denseVector = new Array(384).fill(0);
    for (let d = 0; d < 384; d++) {
      let sum = 0;
      for (let c = 0; c < 24; c++) {
        // Deterministic sign matrix where cell (d, c) is +1 or -1 based on a hash
        const sign = this.hashSign(d, c);
        sum += conceptVector[c] * sign;
      }
      denseVector[d] = sum;
    }

    // Normalize the final 384-dimensional dense vector to unit length
    let sumSquares = 0;
    for (let d = 0; d < 384; d++) {
      sumSquares += denseVector[d] * denseVector[d];
    }
    const length = Math.sqrt(sumSquares);

    if (length > 0) {
      for (let d = 0; d < 384; d++) {
        denseVector[d] = denseVector[d] / length;
      }
    }

    return denseVector;
  }

  /**
   * Deterministic sign generator (+1 or -1) to simulate random projection matrix.
   */
  hashSign(d, c) {
    const seed = (d * 73) + (c * 31);
    const x = Math.sin(seed) * 10000;
    return (x - Math.floor(x)) > 0.5 ? 1 : -1;
  }
}

// Instantiate globally on side panel/extension page scopes
if (typeof window !== 'undefined') {
  window.LocalEmbeddings = new LocalEmbeddingsController();
}
