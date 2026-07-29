// Canvascope query normalization utilities (single source of truth).
//
// Shared abbreviation-expansion / number-variant helpers used by the Cmd+K
// palette search (popup.js) and by embedding query normalization. Moved out
// of popup.js verbatim (byte-identical logic) so both the lexical search
// path and the embedding query path stay in sync — see
// docs/EMBEDDINGS_UPGRADE_SPEC.md §4 item 1.
(function (globalScope) {
    'use strict';

    if (globalScope.CanvascopeQueryNormalizer) return;

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
        phys: 'physics',
        bio: 'biology',
        biol: 'biology',
        chem: 'chemistry',
        pset: 'problem set',
        ps: 'problem set'
    };

    // Regex to split compact tokens like hw4, proj2, quiz10
    const COMPACT_TOKEN_RE = /^([a-z]+)(\d{1,3})$/i;

    /**
     * Normalize text: lowercase, strip punctuation, collapse whitespace
     */
    function normalizeText(str) {
        return (str || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Expand abbreviations and split compact forms (hw4 → homework 4)
     */
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

    /**
     * Generate number variants: for each number token, include both padded and unpadded
     * "homework 4" → "homework 4 homework 04"
     */
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

        if (hasVariant) {
            variants.push(altTokens.join(' '));
        }

        return variants.join(' ');
    }

    /**
     * Full normalization pipeline for embedding queries: normalize then
     * expand abbreviations. expandAbbreviations already normalizes its
     * input internally, so this composition is behaviorally identical to
     * expandAbbreviations(text) alone (normalizeText is idempotent) —
     * written out explicitly to keep the pipeline self-documenting.
     * hw4 → "homework 4".
     */
    function normalizeForEmbedding(text) {
        return expandAbbreviations(normalizeText(text));
    }

    globalScope.CanvascopeQueryNormalizer = Object.freeze({
        ABBREV_MAP,
        COMPACT_TOKEN_RE,
        normalizeText,
        expandAbbreviations,
        numberVariants,
        normalizeForEmbedding
    });
})(typeof self !== 'undefined' ? self : globalThis);
