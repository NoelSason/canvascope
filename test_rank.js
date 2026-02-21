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

function simulatePrepass(query, title) {
    const normQ = expandAbbreviations(query).toLowerCase();
    const rawQ = normalizeText(query).toLowerCase();
    const queryVariants = normQ === rawQ ? [normQ] : [normQ, rawQ];

    const nt = normalizeText(title).toLowerCase();

    let bestBaseScore = null;

    for (const q of queryVariants) {
        if (!q) continue;

        const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exactWordRe = new RegExp(`\\b${escapedQ}\\b`, 'i');

        let score = null;
        if (nt === q) {
            score = 0.0;
        } else if (nt.startsWith(q + ' ') || nt.startsWith(q)) {
            score = 0.05;
        } else if (exactWordRe.test(nt)) {
            score = 0.1;
        } else if (nt.includes(q)) {
            score = 0.15;
        }

        if (score !== null && (bestBaseScore === null || score < bestBaseScore)) {
            bestBaseScore = score;
        }
    }

    return bestBaseScore;
}

const query = "lab b lecture";

console.log("Query:", query);
console.log("Raw Q:", normalizeText(query));
console.log("Expanded Q:", expandAbbreviations(query));

const title1 = "Lab 3 - Lecture Recordings";
const title2 = "Lab B Lecture - Alpha Pinene Oxide.pdf";

console.log("Title 1 Prepass Score:", simulatePrepass(query, title1));
console.log("Title 2 Prepass Score:", simulatePrepass(query, title2));
