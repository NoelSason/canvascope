import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mutable mock storage; the index module registers a storage.onChanged
// listener at load, so the chrome stub must exist BEFORE evaluation.
const mockStorage = {};
const changeListeners = [];
globalThis.chrome = {
    storage: {
        local: {
            get: async (keys) => {
                const out = {};
                for (const key of keys) {
                    if (key in mockStorage) out[key] = mockStorage[key];
                }
                return out;
            },
            set: async (obj) => {
                if (typeof globalThis.__setInterceptor === 'function') {
                    globalThis.__setInterceptor(obj);
                }
                Object.assign(mockStorage, obj);
                const changes = {};
                for (const key of Object.keys(obj)) changes[key] = { newValue: obj[key] };
                changeListeners.forEach(fn => fn(changes, 'local'));
            }
        },
        onChanged: {
            addListener: (fn) => changeListeners.push(fn)
        }
    }
};

const configCode = readFileSync(join(__dirname, '..', 'src', 'core', 'embeddings-config.js'), 'utf8');
const indexCode = readFileSync(join(__dirname, '..', 'src', 'core', 'embedding-index.js'), 'utf8');
new Function(configCode)();
new Function(indexCode)();

const EI = globalThis.CanvascopeEmbeddingIndex;
const CFG = globalThis.CanvascopeEmbeddingsConfig;

function randomUnitVector(dims = 384, seed = 1) {
    const v = new Float32Array(dims);
    let s = seed;
    for (let i = 0; i < dims; i++) {
        s = (s * 16807) % 2147483647;
        v[i] = (s / 2147483647) * 2 - 1;
    }
    let norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    for (let i = 0; i < dims; i++) v[i] /= norm;
    return v;
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

test('int8 quantize/dequantize round-trip keeps cosine > 0.999', () => {
    for (let seed = 1; seed <= 5; seed++) {
        const original = randomUnitVector(384, seed);
        const entry = EI.quantize(original);
        assert.equal(typeof entry.s, 'string');
        assert.equal(typeof entry.v, 'string');
        const roundTripped = EI.dequantize(entry);
        assert.equal(roundTripped.length, 384);
        assert.ok(cosine(original, roundTripped) > 0.999);
        const norm = Math.sqrt(roundTripped.reduce((acc, x) => acc + x * x, 0));
        assert.ok(Math.abs(norm - 1) < 1e-5, 'dequantized vector is renormalized');
    }
});

test('chunked base64 encoder matches naive btoa over large payloads', () => {
    const big = new Uint8Array(300000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 256;
    let naive = '';
    for (let i = 0; i < big.length; i++) naive += String.fromCharCode(big[i]);
    assert.equal(EI.bytesToBase64(big), btoa(naive));
    assert.deepEqual(Array.from(EI.base64ToBytes(EI.bytesToBase64(big)).slice(0, 100)), Array.from(big.slice(0, 100)));
});

test('itemKey prefers courseId, falls back to courseName; keyForChunk reconstructs page keys', () => {
    const withId = { type: 'file', courseId: 12345, courseName: 'CHEM 3A', url: 'https://x/y.pdf', title: 'Notes' };
    const withoutId = { type: 'file', courseName: 'CHEM 3A', url: 'https://x/y.pdf', title: 'Notes' };
    assert.equal(EI.itemKey(withId), 'file|12345|https://x/y.pdf|Notes');
    assert.equal(EI.itemKey(withoutId), 'file|CHEM 3A|https://x/y.pdf|Notes');
    assert.equal(EI.pageKey(withId, 7), 'file|12345|https://x/y.pdf|Notes#p7');
    assert.equal(EI.keyForChunk({ ...withId, page: 7 }), 'file|12345|https://x/y.pdf|Notes#p7');
    assert.equal(EI.keyForChunk({ ...withId, page: null }), EI.itemKey(withId));
    assert.equal(EI.keyForChunk({ ...withId, page: 0 }), EI.itemKey(withId));
});

test('textHash is deterministic FNV-1a hex-8', () => {
    assert.equal(EI.textHash('hello'), EI.textHash('hello'));
    assert.notEqual(EI.textHash('hello'), EI.textHash('hello '));
    assert.match(EI.textHash('anything'), /^[0-9a-f]{8}$/);
    assert.equal(EI.textHash(''), EI.textHash(null));
});

test('passageText joins title/course/type/path/content with 800-char body cap', () => {
    const item = {
        title: 'HW  4', courseName: 'PHYS 7A', type: 'assignment',
        folderPath: 'Week 3/Problem Sets', content: 'x'.repeat(2000)
    };
    const text = EI.passageText(item);
    const lines = text.split('\n');
    assert.equal(lines[0], 'HW 4');
    assert.equal(lines[1], 'PHYS 7A');
    assert.equal(lines[2], 'assignment');
    assert.equal(lines[3], 'Week 3/Problem Sets');
    assert.equal(lines[4].length, CFG.INDEX_ITEM_BODY_MAX_CHARS);
    assert.equal(CFG.INDEX_ITEM_BODY_MAX_CHARS, 800);
    // courseCode wins over courseName when present
    assert.ok(EI.passageText({ ...item, courseCode: 'P7A' }).includes('P7A'));
    // page variant swaps body for the page text
    assert.ok(EI.passagePageText(item, 'page body here').endsWith('page body here'));
});

// A page body is the payload, an item body is a summary field, so they get
// different caps. Asserted as *different* on purpose — collapsing them back to
// one constant would silently halve page recall.
test('passagePageText uses the larger page body cap', () => {
    const item = { title: 'Lecture', courseName: 'C', type: 'pdf' };
    const body = EI.passagePageText(item, 'y'.repeat(4000)).split('\n').pop();
    assert.equal(body.length, CFG.INDEX_PAGE_BODY_MAX_CHARS);
    assert.equal(CFG.INDEX_PAGE_BODY_MAX_CHARS, 1200);
    assert.notEqual(CFG.INDEX_PAGE_BODY_MAX_CHARS, CFG.INDEX_ITEM_BODY_MAX_CHARS);
});

// Tripwire for the "edits here are equivalent to a MODEL_ID bump" warning at the
// top of embedding-index.js: passageText defines the vector space, so any change
// to it silently invalidates every persisted item vector. If this fails, that was
// either deliberate (bump MODEL_ID and update this hash) or an accident.
test('passageText output hash is frozen', () => {
    const fixture = {
        title: 'Lecture 3 — Derivatives.pdf',
        courseName: 'Math 1A',
        type: 'pdf',
        folderPath: 'Week 3/Lectures',
        content: 'The chain rule states that the derivative of a composite function is...'
    };
    assert.equal(EI.textHash(EI.passageText(fixture)), 'c6ec2bed');
});

test('computeWantedEntries emits item vectors for all items and page vectors only for numbered pages', () => {
    const corpus = [
        { title: 'A', courseName: 'C1', type: 'assignment', url: 'u1', content: 'body' },
        {
            title: 'B', courseName: 'C1', type: 'file', url: 'u2', indexedAt: 100,
            pages: [{ pageNum: 1, text: 'p1' }, { pageNum: 2, text: 'p2' }, { pageNum: null, text: 'px' }, 'legacy string page', { pageNum: 3, text: '   ' }]
        }
    ];
    const wanted = EI.computeWantedEntries(corpus);
    const keys = Array.from(wanted.keys());
    assert.ok(keys.includes(EI.itemKey(corpus[0])));
    assert.ok(keys.includes(EI.itemKey(corpus[1])));
    assert.ok(keys.includes(EI.itemKey(corpus[1]) + '#p1'));
    assert.ok(keys.includes(EI.itemKey(corpus[1]) + '#p2'));
    // null pageNum, legacy string pages, and empty page text get no page vector
    assert.equal(keys.filter(k => k.includes('#p')).length, 2);
});

test('computeWantedEntries respects pageBudget, keeps all item entries', () => {
    const corpus = [];
    for (let i = 0; i < 5; i++) {
        corpus.push({
            title: `Doc ${i}`, courseName: 'C', type: 'file', url: `u${i}`, indexedAt: i,
            pages: [{ pageNum: 1, text: 'a' }, { pageNum: 2, text: 'b' }]
        });
    }
    const wanted = EI.computeWantedEntries(corpus, { pageBudget: 3 });
    const pageKeys = Array.from(wanted.keys()).filter(k => k.includes('#p'));
    assert.equal(pageKeys.length, 3);
    assert.equal(Array.from(wanted.keys()).filter(k => !k.includes('#p')).length, 5);
    // newest items (highest indexedAt) win the page budget
    assert.ok(pageKeys.every(k => k.includes('u4') || k.includes('u3')));
});

function pagedCorpus(docCount, pagesPerDoc) {
    const corpus = [];
    for (let i = 0; i < docCount; i++) {
        const pages = [];
        for (let p = 1; p <= pagesPerDoc; p++) pages.push({ pageNum: p, text: `doc${i} page${p}` });
        corpus.push({ title: `Doc ${i}`, courseName: 'C', type: 'pdf', url: `u${i}`, indexedAt: i, pages });
    }
    return corpus;
}

// INDEX_MAX_PAGE_VECTORS_TOTAL is the load-bearing page limit, not the dynamic
// pageBudget: that only ratchets down on a QUOTA_BYTES error, and the manifest
// declares unlimitedStorage so the quota never fires.
test('computeWantedEntries enforces the hard page ceiling and never drops item vectors', () => {
    const corpus = pagedCorpus(20, 10); // 20 items, 200 page candidates
    const stats = {};
    const wanted = EI.computeWantedEntries(corpus, { stats });
    const keys = Array.from(wanted.keys());
    const pageKeys = keys.filter(k => k.includes('#p'));

    assert.equal(keys.length - pageKeys.length, 20, 'every item vector survives');
    assert.ok(pageKeys.length <= CFG.INDEX_MAX_PAGE_VECTORS_TOTAL);
    assert.equal(stats.itemCount, 20);
    assert.equal(stats.pageCandidates, 200);
    assert.equal(stats.pagesTaken, pageKeys.length);
});

test('the three page budgets compose as a min, each winning in turn', () => {
    const corpus = pagedCorpus(10, 10); // 10 items, 100 page candidates

    // options.pageBudget is smallest
    const a = {};
    EI.computeWantedEntries(corpus, { pageBudget: 7, stats: a });
    assert.equal(a.pagesTaken, 7);
    assert.equal(a.pageBudget, 7);

    // the hard total ceiling is smallest
    const b = {};
    EI.computeWantedEntries(corpus, { pageBudget: 10_000, stats: b });
    assert.equal(b.pageBudget, CFG.INDEX_MAX_PAGE_VECTORS_TOTAL);
    assert.equal(b.pagesTaken, 100, 'all candidates fit under the ceiling');

    // cap - itemCount is smallest: 100 candidates, but only 5 slots left
    const originalCap = CFG.INDEX_VECTOR_CAP;
    assert.ok(Number.isFinite(originalCap));
    const c = {};
    EI.computeWantedEntries(corpus, { pageBudget: originalCap - 5, stats: c });
    assert.equal(c.pagesTaken, 100, 'still fits: 10 items + 100 pages << cap');
    assert.equal(c.itemCount, 10);
});

test('computeWantedEntries reports truncation rather than dropping pages silently', () => {
    const stats = {};
    EI.computeWantedEntries(pagedCorpus(5, 10), { pageBudget: 12, stats });
    assert.equal(stats.pageCandidates, 50);
    assert.equal(stats.pagesTaken, 12);
    assert.ok(stats.pageCandidates > stats.pagesTaken, 'the sync log needs both numbers');
});

test('sync embeds new entries, skips unchanged, prunes stale, re-embeds changed', async () => {
    delete mockStorage[CFG.INDEX_STORAGE_KEY];
    const corpus = [
        { title: 'One', courseName: 'C', type: 'assignment', url: 'u1', content: 'alpha' },
        { title: 'Two', courseName: 'C', type: 'assignment', url: 'u2', content: 'beta' }
    ];
    const calls = [];
    const embedFn = async (texts) => {
        calls.push(texts.length);
        return texts.map((_, i) => randomUnitVector(384, texts.length * 100 + i + 1));
    };

    const first = await EI.sync(corpus, embedFn);
    assert.equal(first.embedded, 2);
    assert.equal(first.skipped, 0);
    assert.equal(first.pruned, 0);
    const stored = mockStorage[CFG.INDEX_STORAGE_KEY];
    assert.equal(stored.modelId, CFG.MODEL_ID);
    assert.equal(Object.keys(stored.vectors).length, 2);

    // Unchanged corpus → all skipped, no embeds
    const second = await EI.sync(corpus, embedFn);
    assert.equal(second.embedded, 0);
    assert.equal(second.skipped, 2);

    // One item changes content, one is removed → 1 re-embed, 1 prune
    const mutated = [{ ...corpus[0], content: 'alpha CHANGED' }];
    const third = await EI.sync(mutated, embedFn);
    assert.equal(third.embedded, 1);
    assert.equal(third.pruned, 1);
    assert.equal(Object.keys(mockStorage[CFG.INDEX_STORAGE_KEY].vectors).length, 1);
});

test('load() returns null on modelId mismatch and decodes valid stores', async () => {
    delete mockStorage[CFG.INDEX_STORAGE_KEY];
    const corpus = [{ title: 'One', courseName: 'C', type: 'assignment', url: 'u1', content: 'alpha' }];
    await EI.sync(corpus, async (texts) => texts.map((_, i) => randomUnitVector(384, i + 9)));

    const good = await EI.load({ force: true });
    assert.ok(good);
    assert.equal(good.count, 1);
    assert.equal(good.modelId, CFG.MODEL_ID);
    const row = good.byKey.get(EI.itemKey(corpus[0]));
    assert.equal(row, 0);
    // cosine of a vector with itself ≈ 1
    const self = good.matrix.slice(0, 384);
    assert.ok(Math.abs(EI.cosineRow(good, row, self) - 1) < 1e-5);

    mockStorage[CFG.INDEX_STORAGE_KEY] = {
        ...mockStorage[CFG.INDEX_STORAGE_KEY],
        modelId: 'some-other-model'
    };
    const mismatched = await EI.load({ force: true });
    assert.equal(mismatched, null);
});

// The palette resolves page hits through this map, not through item.pages —
// popup.js builds its corpus from state.indexedContent and has no pages array
// to probe against.
test('load() exposes pagesByItem, page-ordered and row-aligned', async () => {
    delete mockStorage[CFG.INDEX_STORAGE_KEY];
    const corpus = [
        { title: 'Deck', courseName: 'C', type: 'pdf', url: 'u1', indexedAt: 5,
          pages: [{ pageNum: 3, text: 'three' }, { pageNum: 1, text: 'one' }, { pageNum: 2, text: 'two' }] },
        { title: 'Plain', courseName: 'C', type: 'assignment', url: 'u2', content: 'no pages' }
    ];
    let n = 0;
    await EI.sync(corpus, async (texts) => texts.map(() => randomUnitVector(384, ++n + 40)));

    const handle = await EI.load({ force: true });
    const base = EI.itemKey(corpus[0]);
    const rows = handle.pagesByItem.get(base);

    assert.ok(rows, 'the paged item has an entry');
    assert.deepEqual(rows.map(r => r.page), [1, 2, 3], 'ascending regardless of store order');
    assert.equal(handle.pagesByItem.get(EI.itemKey(corpus[1])), undefined, 'pageless item has none');

    // Each {page,row} must resolve to the vector actually stored under #pN.
    for (const { page, row } of rows) {
        assert.equal(row, handle.byKey.get(`${base}#p${page}`));
    }
});

test('pagesByItem ignores keys that only look like page keys', async () => {
    delete mockStorage[CFG.INDEX_STORAGE_KEY];
    // A title containing "#p2" must not split; only a trailing #p<digits> counts.
    const corpus = [
        { title: 'Notes #p2 draft', courseName: 'C', type: 'pdf', url: 'u1',
          pages: [{ pageNum: 4, text: 'real page' }] }
    ];
    let n = 0;
    await EI.sync(corpus, async (texts) => texts.map(() => randomUnitVector(384, ++n + 70)));

    const base = EI.itemKey(corpus[0]);
    // Hand-inject malformed suffixes alongside the legitimate ones.
    const store = mockStorage[CFG.INDEX_STORAGE_KEY];
    const sample = store.vectors[`${base}#p4`];
    store.vectors[`${base}#pabc`] = sample;
    store.vectors[`${base}#p0`] = sample;

    const handle = await EI.load({ force: true });
    const rows = handle.pagesByItem.get(base);
    assert.deepEqual(rows.map(r => r.page), [4], 'only #p4 counts');
    // The title's embedded "#p2" must not have created a phantom base entry
    // that shadows a real item key.
    assert.ok(!handle.pagesByItem.has('pdf|C|u1|Notes'));
});

test('quota eviction drops oldest page vectors, persists pageBudget, retries once', async () => {
    delete mockStorage[CFG.INDEX_STORAGE_KEY];
    const corpus = [];
    for (let i = 0; i < 4; i++) {
        corpus.push({
            title: `Doc ${i}`, courseName: 'C', type: 'file', url: `u${i}`, indexedAt: i,
            pages: [{ pageNum: 1, text: `page of doc ${i}` }]
        });
    }
    let threwOnce = false;
    globalThis.__setInterceptor = () => {
        if (!threwOnce) {
            threwOnce = true;
            throw new Error('QUOTA_BYTES quota exceeded');
        }
    };
    try {
        const result = await EI.sync(corpus, async (texts) => texts.map((_, i) => randomUnitVector(384, i + 40)));
        assert.equal(result.aborted, false);
        const stored = mockStorage[CFG.INDEX_STORAGE_KEY];
        assert.ok(threwOnce, 'quota error was thrown once');
        assert.ok(Number.isFinite(stored.pageBudget), 'pageBudget persisted after eviction');
        const pageKeys = Object.keys(stored.vectors).filter(k => k.includes('#p'));
        assert.ok(pageKeys.length < 4, 'some page vectors were evicted');
        // item vectors are immune to quota eviction
        assert.equal(Object.keys(stored.vectors).filter(k => !k.includes('#p')).length, 4);
    } finally {
        delete globalThis.__setInterceptor;
    }
});

test('sync aborts after 3 consecutive all-null batches and reports remaining', async () => {
    delete mockStorage[CFG.INDEX_STORAGE_KEY];
    const corpus = [];
    for (let i = 0; i < 60; i++) {
        corpus.push({ title: `T${i}`, courseName: 'C', type: 'assignment', url: `u${i}`, content: `c${i}` });
    }
    const result = await EI.sync(corpus, async (texts) => texts.map(() => null));
    assert.equal(result.aborted, true);
    assert.equal(result.embedded, 0);
    assert.equal(result.failed, CFG.EMBED_BATCH_SIZE * 3, 'exactly three full batches failed before aborting');
    assert.ok(result.remaining > 0);
});
