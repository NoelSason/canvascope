/**
 * Canvascope — page-vector export (dev tool)
 *
 * Dumps WHICH documents actually have page vectors in the embedding index and
 * WHAT text was embedded for each page, so you can write search queries whose
 * correct answer is known in advance.
 *
 * HOW TO RUN
 *   1. chrome://extensions → Canvascope → "service worker" (opens DevTools)
 *   2. Paste this whole file into the Console and hit Enter
 *   3. The digest is printed AND copied to your clipboard (DevTools `copy()`),
 *      so you can paste it straight into a chat
 *
 * The page list is filtered against the REAL keys in chrome.storage.local's
 * `embeddingIndex`, so a page only appears here if a vector for it truly
 * exists — an unparsed or OCR-failed PDF will be reported as such rather than
 * silently omitted.
 *
 * Knobs are at the top of the IIFE.
 */
(async () => {
    // ---- knobs ---------------------------------------------------------
    const SAMPLE_PAGES_PER_DOC = 3;   // pages quoted per document (0 = none)
    const SNIPPET_CHARS = 200; // chars quoted per sampled page
    const TERMS_PER_DOC = 12;  // distinctive body terms listed per doc
    const FULL_TEXT = false; // true = dump every page in full (huge)
    // --------------------------------------------------------------------

    const g = self;
    const CFG = g.CanvascopeEmbeddingsConfig;
    const EI = g.CanvascopeEmbeddingIndex;
    const RAG = g.RAGCore;
    if (!CFG || !EI) return console.error('Embeddings globals missing — is this the service worker console?');
    if (!RAG || typeof RAG.buildCorpus !== 'function') return console.error('RAGCore missing — is this the service worker console?');

    // 1. Read the persisted index and split its keys.
    const storeKey = CFG.INDEX_STORAGE_KEY;
    const store = (await chrome.storage.local.get(storeKey))[storeKey] || {};
    const allKeys = Object.keys(store.vectors || {});
    const pageKeySet = new Set(allKeys.filter(k => /#p\d+$/.test(k)));
    const itemKeyCount = allKeys.length - pageKeySet.size;

    // 2. Rebuild the corpus through the real path, so the text shown here is
    //    byte-for-byte what computeWantedEntries handed to the model.
    const corpus = await RAG.buildCorpus();

    const STOP = new Set(('the and for that with this from are was were will has have had not but you your our their its it is of to in on at as by or if be been being a an we they he she them us can may must should would could do does did done other than then there here what which who whom whose when where why how all any both each few more most some such only own same so too very just also into over under again further once during before after above below up down out off no nor too s t don now use used using page pages figure table example note section chapter problem problems set sets question questions answer answers solution solutions due date name total points score exam quiz midterm final homework assignment lecture week').split(' '));

    function tokenize(text) {
        return String(text || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
    }

    const docs = [];
    let emptyTextDocs = 0;

    for (const item of corpus) {
        if (!Array.isArray(item.pages) || item.pages.length === 0) continue;
        const base = EI.itemKey(item);

        const indexed = [];
        for (const p of item.pages) {
            const num = Number(p && p.pageNum);
            if (!Number.isFinite(num) || num <= 0) continue;
            if (!pageKeySet.has(`${base}#p${num}`)) continue; // no vector → not searchable
            indexed.push({ page: num, text: String(p.text || '').replace(/\s+/g, ' ').trim() });
        }
        if (indexed.length === 0) continue;

        const bodyChars = indexed.reduce((n, p) => n + p.text.length, 0);
        if (bodyChars < 40) emptyTextDocs++;

        // "Distinctive" = appears in the body but NOT in the title/course/path.
        // These are exactly the queries that can only be answered by a page
        // vector — a title match would be cheating.
        const contextTokens = new Set(tokenize([item.title, item.courseName, item.folderPath, item.moduleName].join(' ')));
        const freq = new Map();
        for (const p of indexed) {
            for (const tok of tokenize(p.text)) {
                if (STOP.has(tok) || contextTokens.has(tok)) continue;
                freq.set(tok, (freq.get(tok) || 0) + 1);
            }
        }
        const distinctive = [...freq.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, TERMS_PER_DOC)
            .map(([tok, n]) => `${tok}(${n})`);

        docs.push({
            title: item.title, course: item.courseName || '', type: item.type || '',
            folder: item.folderPath || item.moduleName || '',
            pageCount: indexed.length, bodyChars, distinctive, pages: indexed
        });
    }

    docs.sort((a, b) => b.pageCount - a.pageCount || a.title.localeCompare(b.title));

    // 3. Render a paste-sized digest.
    const out = [];
    out.push('=== CANVASCOPE PAGE-VECTOR EXPORT ===');
    out.push(`model ${store.modelId || '?'} · schema v${store.schemaVersion || '?'} · updated ${store.updatedAt ? new Date(store.updatedAt).toISOString() : '?'}`);
    out.push(`${allKeys.length} vectors total — ${itemKeyCount} item, ${pageKeySet.size} page`);
    out.push(`${docs.length} documents carry page vectors · ${docs.reduce((n, d) => n + d.pageCount, 0)} pages`);
    if (emptyTextDocs) out.push(`WARNING: ${emptyTextDocs} document(s) have near-empty page text (likely scanned/OCR-failed) — queries against those cannot match.`);
    out.push('');

    docs.forEach((d, i) => {
        out.push(`--- [${i + 1}] ${d.title}`);
        out.push(`    course: ${d.course}${d.folder ? ' · ' + d.folder : ''} · type: ${d.type} · ${d.pageCount} pages · ${d.bodyChars} chars`);
        out.push(`    distinctive: ${d.distinctive.join(', ') || '(none — empty body text)'}`);
        if (FULL_TEXT) {
            d.pages.forEach(p => out.push(`    p${p.page}: ${p.text}`));
        } else if (SAMPLE_PAGES_PER_DOC > 0) {
            const step = Math.max(1, Math.floor(d.pages.length / SAMPLE_PAGES_PER_DOC));
            for (let k = 0; k < d.pages.length && k / step < SAMPLE_PAGES_PER_DOC; k += step) {
                const p = d.pages[k];
                out.push(`    p${p.page}: ${p.text.slice(0, SNIPPET_CHARS)}${p.text.length > SNIPPET_CHARS ? '…' : ''}`);
            }
        }
        out.push('');
    });

    const text = out.join('\n');
    console.log(text);
    try {
        // `copy` is a DevTools console helper, not a page API.
        copy(text);
        console.log(`%c[copied to clipboard — ${text.length} chars]`, 'color:#5B7CFA;font-weight:bold');
    } catch (_) {
        console.log('(clipboard copy unavailable — select the output above and copy manually)');
    }
    return `${docs.length} documents, ${pageKeySet.size} page vectors`;
})();
