const fs = require('fs');

// We need a way to run the ranking logic. Since it's baked into popup.js which
// relies on DOM and Chrome APIs, we will mock the necessary environment here,
// then load the logic.

// Provide basic mocks
global.chrome = {
    storage: {
        local: {
            get: async () => ({}),
            set: async () => { }
        }
    }
};

const FUSE_OPTIONS = {
    threshold: 0.35,
    includeScore: true,
    includeMatches: true,
    minMatchCharLength: 2,
    ignoreLocation: true,
    findAllMatches: true,
    keys: [
        { name: 'title', weight: 3.0 },
        { name: 'searchTitleNormalized', weight: 2.5 },
        { name: 'searchAliases', weight: 2.0 },
        { name: 'folderPath', weight: 1.8 },
        { name: 'moduleName', weight: 1.5 },
        { name: 'courseName', weight: 1.2 },
        { name: 'type', weight: 0.5 }
    ]
};

const Fuse = require('./lib/fuse.min.js');

// Helper functions (extracted & adapted from popup.js for isolated testing)
const ABBREV_MAP = {
    hw: 'homework',
    proj: 'project',
    assn: 'assignment',
    assign: 'assignment',
    disc: 'discussion',
    lec: 'lecture',
    lab: 'laboratory',
    mt: 'midterm',
    ch: 'chapter',
    chap: 'chapter',
    wk: 'week',
    pset: 'problem set',
    ps: 'problem set'
};

const COMPACT_TOKEN_RE = /^([a-z]+)(\d{1,3})$/i;
const STOP_TOKENS = new Set(['a', 'an', 'the', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'is']);
const MAX_RESULTS = 20;

function normalizeText(str) {
    return (str || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function expandAbbreviations(text) {
    const tokens = normalizeText(text).split(' ');
    const expanded = [];
    for (const token of tokens) {
        const compactMatch = token.match(COMPACT_TOKEN_RE);
        if (compactMatch) {
            const [, letters, digits] = compactMatch;
            const expandedWord = ABBREV_MAP[letters] || letters;
            expanded.push(expandedWord, digits.replace(/^0+/, '') || '0');
        } else {
            expanded.push(ABBREV_MAP[token] || token);
        }
    }
    return expanded.join(' ');
}

function numberVariants(text) {
    const tokens = text.split(' ');
    const variants = [text];
    let hasVariant = false;
    const altTokens = tokens.map(t => {
        if (/^\d{1,3}$/.test(t)) {
            hasVariant = true;
            const unpadded = t.replace(/^0+/, '') || '0';
            const padded = unpadded.padStart(2, '0');
            return unpadded === t ? padded : unpadded;
        }
        return t;
    });
    if (hasVariant) variants.push(altTokens.join(' '));
    return variants.join(' ');
}

function buildSearchFields(item) {
    const normalized = expandAbbreviations(item.title || '');
    let aliases = numberVariants(normalized);
    if (item.folderPath) aliases += ' ' + normalizeText(item.folderPath);
    if (item.moduleName && item.moduleName !== 'Files') aliases += ' ' + normalizeText(item.moduleName);
    return { searchTitleNormalized: normalized, searchAliases: aliases };
}

function extractNumericTokens(text) {
    const matches = (text || '').match(/\b\d{1,4}\b/g);
    return matches ? matches.map(n => n.replace(/^0+/, '') || '0') : [];
}

// ============================================
// SIMULATION
// ============================================

class SearchPipeline {
    constructor(corpus) {
        this.rawCorpus = corpus;
        this.index = corpus.map(item => ({
            ...item,
            ...buildSearchFields(item)
        }));
        this.fuse = new Fuse(this.index, FUSE_OPTIONS);
        this.fuseRelaxed = new Fuse(this.index, { ...FUSE_OPTIONS, threshold: 0.55 });
    }

    // A simplified version of popup.js ranking logic
    search(query) {
        const effectiveQuery = query;
        const normalizedQuery = expandAbbreviations(query);
        const queryNums = extractNumericTokens(normalizedQuery);

        // Pre-pass
        const normQ = normalizedQuery.toLowerCase();
        const rawQ = normalizeText(effectiveQuery).toLowerCase();
        const queryVariants = normQ === rawQ ? [normQ] : [normQ, rawQ];

        const prePassHits = [];
        const prePassUrls = new Set();

        for (const item of this.index) {
            const nt = (item.searchTitleNormalized || normalizeText(item.title || '')).toLowerCase();
            let bestBaseScore = null;

            for (const q of queryVariants) {
                if (!q) continue;
                const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const exactWordRe = new RegExp(`\\b${escapedQ}\\b`, 'i');

                let score = null;
                if (nt === q) score = 0.0;
                else if (nt.startsWith(q + ' ') || nt.startsWith(q)) score = 0.05;
                else if (exactWordRe.test(nt)) score = 0.1;
                else if (nt.includes(q)) score = 0.15;

                if (score !== null && (bestBaseScore === null || score < bestBaseScore)) {
                    bestBaseScore = score;
                }
            }
            if (bestBaseScore !== null) {
                prePassHits.push({ item, score: bestBaseScore, prePass: true });
                prePassUrls.add(item.url);
            }
        }

        let fuseResults = this.fuse.search(normalizedQuery, { limit: MAX_RESULTS * 3 });
        if (fuseResults.length === 0) {
            fuseResults = this.fuseRelaxed.search(normalizedQuery, { limit: MAX_RESULTS * 3 });
        }

        let results = [...prePassHits];
        for (const r of fuseResults) {
            if (!prePassUrls.has(r.item.url)) results.push(r);
        }

        return this.rank(results, normalizedQuery, queryNums).slice(0, MAX_RESULTS);
    }

    rank(results, normalizedQuery, queryNums) {
        return results.map(r => {
            let score = (r.prePass && r.score !== undefined) ? (10.0 - r.score) : (1.0 - r.score);

            // Re-eval of the alignment metric specifically (current logic)
            if (queryNums && queryNums.length > 0) {
                const titleText = (r.item.searchTitleNormalized || normalizeText(r.item.title || '')).toLowerCase();
                const titleNums = new Set(extractNumericTokens(titleText));
                let aligned = 0, mismatched = 0;
                for (const qn of queryNums) {
                    if (titleNums.has(qn)) aligned++;
                    else mismatched++;
                }
                if (aligned > 0) score += 0.10 * (aligned / queryNums.length);
                if (mismatched > 0) score -= 0.18 * (mismatched / queryNums.length); // We're strengthening this later
            }

            // Re-eval of the token metric (current logic)
            if (normalizedQuery) {
                const titleText = (r.item.searchTitleNormalized || normalizeText(r.item.title || '')).toLowerCase();
                const contextText = normalizeText((r.item.folderPath || '') + ' ' + (r.item.moduleName || ''));
                const combined = titleText + ' ' + contextText;

                const qTokens = normalizedQuery.split(/\s+/).filter(t => t.length > 1 && !STOP_TOKENS.has(t));
                let found = 0;
                for (const t of qTokens) {
                    if (combined.includes(t)) found++; // This leads to false positives (bounds issue)
                }
                const coverage = qTokens.length ? found / qTokens.length : 1;

                if (coverage >= 0.8) score += 0.12;
                else if (coverage < 0.5 && qTokens.length >= 2) score -= 0.15 * (1 - coverage);
            }

            return { item: r.item, finalScore: score };
        }).sort((a, b) => b.finalScore - a.finalScore);
    }
}

// ============================================
// EVALUATION HARNESS
// ============================================

const queries = [
    { query: "hw4", expectedId: "1", desc: "hw4 exact numeric match" },
    { query: "hw 4", expectedId: "1", desc: "hw 4 spaced match" },
    { query: "lab b lecture", expectedId: "4", desc: "exact word bounds, avoid 'lab b lecture' hitting 'lab 3 - lecture'" },
    { query: "ch10", expectedId: "5", desc: "compact chapter" },
];

const mockCorpus = [
    { url: "id_1", title: "Homework 4 - Recursion", type: "assignment" },
    { url: "id_2", title: "Homework 14 - Trees", type: "assignment" },
    { url: "id_3", title: "Homework 24 - Graphs", type: "assignment" },
    { url: "id_4", title: "Lab B Lecture - Alpha Pinene Oxide.pdf", type: "file" },
    { url: "id_5", title: "Chapter 10 Reading", type: "page" },
    { url: "id_6", title: "Lab B Requirements", type: "assignment" }
];

function dcg(results, expectedId, k = 10) {
    let score = 0;
    for (let i = 0; i < Math.min(results.length, k); i++) {
        const id = results[i].item.url.replace('id_', '');
        if (id === expectedId || results[i].item.url === expectedId) {
            score += 1 / Math.log2(i + 2); // rel = 1 for match
        }
    }
    return score;
}

function runEvals() {
    const pipeline = new SearchPipeline(mockCorpus);
    console.log("=== Running Offline Relevance Eval ===");

    let mrrSum = 0;
    let rankSum = 0;
    let recall20 = 0;

    for (const q of queries) {
        const res = pipeline.search(q.query);
        const ranks = res.map(r => r.item.url.replace('id_', ''));
        const idx = ranks.indexOf(q.expectedId);

        let mrr = 0;
        if (idx !== -1) {
            mrr = 1 / (idx + 1);
            recall20 += 1;
            rankSum += (idx + 1);
        }

        mrrSum += mrr;
        console.log(`Q: "${q.query}" | Desc: ${q.desc}`);
        console.log(`  Expected Rank: ${idx === -1 ? 'NOT FOUND' : (idx + 1)}`);
        console.log(`  Top 3 URLs: ${ranks.slice(0, 3).join(", ")}`);
    }

    console.log("--------------------------------------");
    console.log(`MRR@10: ${(mrrSum / queries.length).toFixed(3)}`);
    if (recall20 > 0) {
        console.log(`Average Rank Valid: ${(rankSum / recall20).toFixed(2)}`);
    }
    console.log(`Recall@20: ${recall20} / ${queries.length}`);
}

runEvals();
