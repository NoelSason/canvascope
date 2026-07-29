import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// course-materials.js touches chrome.storage only inside its async statics, so
// hydrateItems needs no stub — but embedding-index.js registers a
// storage.onChanged listener at load, and we need it here to assert the itemKey
// identity invariant. Stub before evaluating either.
const mockStorage = {};
const changeListeners = [];
globalThis.chrome = {
    storage: {
        local: {
            get: async (keys) => {
                const out = {};
                for (const key of keys) if (key in mockStorage) out[key] = mockStorage[key];
                return out;
            },
            set: async (obj) => { Object.assign(mockStorage, obj); }
        },
        onChanged: { addListener: (fn) => changeListeners.push(fn) }
    }
};

const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
new Function(read('src', 'core', 'embeddings-config.js'))();
new Function(read('src', 'core', 'embedding-index.js'))();
new Function(read('src', 'core', 'course-materials.js'))();

const CM = globalThis.CanvascopeCourseMaterials;
const EI = globalThis.CanvascopeEmbeddingIndex;

const HOST = 'https://bcourses.berkeley.edu';

function item(overrides = {}) {
    return {
        title: 'Lecture 3.pdf',
        courseName: 'Math 1A',
        courseId: '1550636',
        type: 'pdf',
        url: `${HOST}/courses/1550636/files/93606933`,
        ...overrides
    };
}

function chunk(overrides = {}) {
    return {
        chunkId: 'course-material:abcd1234:p1:0',
        documentId: 'course-material:abcd1234',
        courseId: '1550636',
        courseName: 'Math 1A',
        canvasFileId: '93606933',
        title: 'Lecture 3.pdf',
        url: `${HOST}/courses/1550636/files/93606933`,
        sourceUrl: `${HOST}/courses/1550636/files/93606933`,
        pageStart: 1,
        pageEnd: 1,
        chunkIndex: 0,
        text: 'The chain rule states that the derivative of a composite function...',
        ...overrides
    };
}

test('exposes hydrateItems as a static', () => {
    assert.equal(typeof CM.hydrateItems, 'function');
});

test('attaches per-page text and fills an empty content field', () => {
    const items = [item()];
    const chunks = [
        chunk(),
        chunk({ chunkId: 'course-material:abcd1234:p2:0', pageStart: 2, pageEnd: 2, chunkIndex: 1, text: 'Page two body.' })
    ];
    const { items: out, stats } = CM.hydrateItems(items, { chunks });

    assert.deepEqual(out[0].pages, [
        { pageNum: 1, text: 'The chain rule states that the derivative of a composite function...' },
        { pageNum: 2, text: 'Page two body.' }
    ]);
    assert.match(out[0].content, /chain rule/);
    assert.match(out[0].content, /Page two body/);
    assert.equal(stats.documentsMatched, 1);
    assert.equal(stats.documentsUnmatched, 0);
    assert.equal(stats.itemsHydrated, 1);
    assert.equal(stats.pagesAttached, 2);
    assert.equal(stats.chunksSeen, 2);
});

// The single highest-value assertion in this file. title/url/type/courseId/
// courseName are exactly the inputs to itemKey — if hydration rewrites any of
// them the popup's byKey lookup desynchronizes from what the background
// embedded, and every vector for that item becomes unreachable.
test('never changes any field that feeds itemKey', () => {
    const items = [item(), item({ title: 'HW 4.pdf', url: `${HOST}/files/94791328/download` })];
    const before = items.map(EI.itemKey);
    const chunks = [
        chunk(),
        chunk({
            documentId: 'course-material:ffff0000',
            chunkId: 'course-material:ffff0000:p1:0',
            canvasFileId: '94791328',
            title: 'A COMPLETELY DIFFERENT TITLE',
            courseName: 'Some Other Course',
            courseId: '999999',
            url: `${HOST}/files/94791328/download`
        })
    ];
    const { items: out } = CM.hydrateItems(items, { chunks });

    assert.deepEqual(out.map(EI.itemKey), before);
    for (let i = 0; i < items.length; i++) {
        for (const field of ['title', 'url', 'type', 'courseId', 'courseName']) {
            assert.equal(out[i][field], items[i][field], `${field} must be preserved`);
        }
    }
});

test('does not mutate the input array or its items', () => {
    const items = [item()];
    const snapshot = JSON.parse(JSON.stringify(items));
    const { items: out } = CM.hydrateItems(items, { chunks: [chunk()] });

    assert.deepEqual(items, snapshot, 'inputs must be untouched');
    assert.notEqual(out[0], items[0], 'must return a new object');
    assert.equal(items[0].pages, undefined);
});

test('preserves length and order', () => {
    const items = [item({ title: 'A' }), item({ title: 'B', url: `${HOST}/courses/1/files/1` }), item({ title: 'C' })];
    const { items: out } = CM.hydrateItems(items, { chunks: [chunk()] });
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(i => i.title), ['A', 'B', 'C']);
});

test('joins a page\'s chunks in chunkIndex order regardless of array order', () => {
    const chunks = [
        chunk({ chunkId: 'course-material:abcd1234:p1:1', chunkIndex: 1, text: 'SECOND half.' }),
        chunk({ chunkId: 'course-material:abcd1234:p1:0', chunkIndex: 0, text: 'FIRST half.' })
    ];
    const { items: out } = CM.hydrateItems([item()], { chunks });
    assert.ok(out[0].pages[0].text.indexOf('FIRST') < out[0].pages[0].text.indexOf('SECOND'));
});

// splitTextIntoChunks overlaps consecutive chunks by CHUNK_OVERLAP_CHARS, so a
// naive join would repeat the seam text.
test('de-overlaps chunks that share a seam', () => {
    const overlap = 'X'.repeat(140);
    const a = 'head-content ' + overlap;
    const b = overlap + ' tail-content';
    const chunks = [
        chunk({ chunkIndex: 0, text: a }),
        chunk({ chunkId: 'course-material:abcd1234:p1:1', chunkIndex: 1, text: b })
    ];
    const { items: out } = CM.hydrateItems([item()], { chunks });
    const text = out[0].pages[0].text;

    assert.ok(text.length < a.length + b.length, 'seam must not be duplicated');
    assert.equal(text.split(overlap).length - 1, 1, 'overlap appears exactly once');
    assert.match(text, /head-content/);
    assert.match(text, /tail-content/);
});

test('matches by canvasFileId across differing url forms', () => {
    // Item carries the preview form; the chunk carries the signed download form.
    const items = [item({ url: `${HOST}/courses/1550636/files/93606933?preview=93606933` })];
    const chunks = [chunk({ url: `${HOST}/files/93606933/download?download_frd=1#x` })];
    const { items: out, stats } = CM.hydrateItems(items, { chunks });
    assert.equal(stats.documentsMatched, 1);
    assert.equal(out[0].pages.length, 1);
});

test('falls back to a url match when no canvasFileId is present', () => {
    const items = [item({ url: `${HOST}/courses/1550636/pages/notes?x=1` })];
    const chunks = [chunk({
        canvasFileId: '',
        url: `${HOST}/courses/1550636/pages/notes`,
        sourceUrl: `${HOST}/courses/1550636/pages/notes`
    })];
    const { items: out, stats } = CM.hydrateItems(items, { chunks });
    assert.equal(stats.documentsMatched, 1);
    assert.equal(out[0].pages.length, 1);
});

test('an unmatched document is counted and never synthesized into the corpus', () => {
    const items = [item()];
    const chunks = [chunk({
        documentId: 'course-material:orphan',
        canvasFileId: '55555555',
        url: `${HOST}/courses/999/files/55555555`,
        sourceUrl: `${HOST}/courses/999/files/55555555`
    })];
    const { items: out, stats } = CM.hydrateItems(items, { chunks });

    assert.equal(stats.documentsUnmatched, 1);
    assert.equal(stats.documentsMatched, 0);
    assert.equal(out.length, 1, 'no synthetic item may be appended');
    assert.equal(out[0].pages, undefined);
});

// One canvasFileId legitimately carries two documentIds (the same file reached
// via /courses/<c>/files/<f> and via /files/<f>/download).
test('two documents sharing one file id claim the item once', () => {
    const items = [item()];
    const chunks = [
        chunk({ documentId: 'course-material:aaaa', chunkId: 'course-material:aaaa:p1:0', text: 'from doc A' }),
        chunk({ documentId: 'course-material:bbbb', chunkId: 'course-material:bbbb:p1:0', text: 'from doc B' }),
        chunk({ documentId: 'course-material:bbbb', chunkId: 'course-material:bbbb:p2:0', pageStart: 2, pageEnd: 2, text: 'doc B page 2' })
    ];
    const { items: out, stats } = CM.hydrateItems(items, { chunks });

    assert.equal(stats.documentsMatched, 2, 'both resolve to the item');
    assert.equal(stats.itemsHydrated, 1, 'but only one may claim it');
    assert.equal(out[0].pages.length, 1, 'sorted documentId order means doc A wins');
    assert.match(out[0].pages[0].text, /from doc A/);
});

test('an item that already has real pages is left alone', () => {
    const items = [item({ pages: [{ pageNum: 1, text: 'fresher parse' }] })];
    const { items: out } = CM.hydrateItems(items, { chunks: [chunk()] });
    assert.deepEqual(out[0].pages, [{ pageNum: 1, text: 'fresher parse' }]);
});

test('an existing content body is never clobbered', () => {
    const items = [item({ content: 'assignment description' })];
    const { items: out } = CM.hydrateItems(items, { chunks: [chunk()] });
    assert.equal(out[0].content, 'assignment description');
    assert.equal(out[0].pages.length, 1, 'pages still attach');
});

test('respects maxPagesPerItem, maxPageChars and maxContentChars', () => {
    const chunks = [];
    for (let p = 1; p <= 5; p++) {
        chunks.push(chunk({
            chunkId: `course-material:abcd1234:p${p}:0`,
            pageStart: p, pageEnd: p, chunkIndex: p - 1,
            text: 'y'.repeat(900)
        }));
    }

    const capped = CM.hydrateItems([item()], { chunks }, { maxPagesPerItem: 3 });
    assert.equal(capped.items[0].pages.length, 3);
    assert.deepEqual(capped.items[0].pages.map(p => p.pageNum), [1, 2, 3]);
    assert.equal(capped.stats.pagesDroppedOverCap, 2);

    const trimmed = CM.hydrateItems([item()], { chunks }, { maxPageChars: 100 });
    assert.equal(trimmed.items[0].pages[0].text.length, 100);
    assert.equal(trimmed.stats.pagesTruncated, 5);

    const noContent = CM.hydrateItems([item()], { chunks }, { maxContentChars: 0 });
    assert.equal(noContent.items[0].content, undefined);
    assert.equal(noContent.items[0].pages.length, 5, 'pages still attach');
});

test('skips degenerate chunks without throwing', () => {
    const items = [item()];
    const chunks = [
        chunk({ pageStart: 0 }),
        chunk({ chunkId: 'x:p0:0', pageStart: null }),
        chunk({ chunkId: 'y:p0:0', pageStart: -3 }),
        chunk({ chunkId: 'z:p1:0', text: '   ' }),
        chunk({ chunkId: 'w:p1:0', documentId: '' }),
        null,
        chunk({ chunkId: 'ok:p3:0', pageStart: '3', text: 'string page number is coerced' })
    ];
    const { items: out, stats } = CM.hydrateItems(items, { chunks });
    assert.equal(stats.chunksSeen, 1);
    assert.deepEqual(out[0].pages, [{ pageNum: 3, text: 'string page number is coerced' }]);
});

test('works with no documents array at all (chunks are self-describing)', () => {
    const { items: out, stats } = CM.hydrateItems([item()], { chunks: [chunk()] });
    assert.equal(stats.documentsMatched, 1);
    assert.equal(out[0].pages.length, 1);
});

test('returns the input unchanged for empty inputs', () => {
    assert.deepEqual(CM.hydrateItems([], { chunks: [chunk()] }).items, []);
    assert.deepEqual(CM.hydrateItems([item()], { chunks: [] }).items.map(i => i.pages), [undefined]);
    assert.deepEqual(CM.hydrateItems(null, {}).items, []);
    assert.deepEqual(CM.hydrateItems([item()], {}).items.map(i => i.pages), [undefined]);
});

// End-to-end: hydration is only useful if the pages it produces are the shape
// computeWantedEntries turns into #pN vectors.
test('produces pages that computeWantedEntries turns into page vectors', () => {
    const chunks = [
        chunk(),
        chunk({ chunkId: 'course-material:abcd1234:p2:0', pageStart: 2, pageEnd: 2, chunkIndex: 1, text: 'Page two body.' })
    ];
    const { items: out } = CM.hydrateItems([item()], { chunks });
    const wanted = EI.computeWantedEntries(out);
    const keys = Array.from(wanted.keys());
    const base = EI.itemKey(out[0]);

    assert.ok(keys.includes(base), 'item vector still planned');
    assert.ok(keys.includes(`${base}#p1`), 'page 1 vector planned');
    assert.ok(keys.includes(`${base}#p2`), 'page 2 vector planned');
    assert.equal(wanted.get(`${base}#p1`).kind, 'page');
});

// Hydration is a READ-TIME projection whose width depends on the caller's
// maxPageChars. The popup narrows it to bound memory, and the popup also writes
// state.indexedContent back to storage — so a persisted narrow projection would
// both bloat storage and shadow the full-width text on the next sync, because
// hydrateItems skips items that already carry pages.
test('dehydrateItems removes exactly what hydration added', () => {
    const items = [
        item(),
        item({ title: 'Has body', url: `${HOST}/files/94791328/download`, content: 'assignment description' }),
        item({ title: 'Untouched', url: `${HOST}/courses/1/pages/x` })
    ];
    const chunks = [
        chunk(),
        chunk({
            documentId: 'course-material:bodydoc', chunkId: 'course-material:bodydoc:p1:0',
            canvasFileId: '94791328', url: `${HOST}/files/94791328/download`
        })
    ];
    const { items: hydrated } = CM.hydrateItems(items, { chunks }, { maxPageChars: 400 });
    assert.ok(hydrated[0].pages, 'precondition: hydrated');
    assert.ok(hydrated[1].pages, 'precondition: hydrated');

    const dry = CM.dehydrateItems(hydrated);
    assert.deepEqual(dry, items, 'round-trip must restore the originals exactly');
    for (const row of dry) {
        assert.equal(row.__csHydratedFields, undefined, 'marker must not persist');
    }
    // The item that already had a body keeps it — hydration never claimed content there.
    assert.equal(dry[1].content, 'assignment description');
});

test('dehydrateItems is a safe no-op on never-hydrated input', () => {
    const items = [item({ content: 'mine' }), item({ pages: [{ pageNum: 1, text: 'mine' }] })];
    assert.deepEqual(CM.dehydrateItems(items), items);
    assert.deepEqual(CM.dehydrateItems([]), []);
    assert.deepEqual(CM.dehydrateItems(null), []);
});
