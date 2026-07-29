import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const popupSource = readFileSync(join(__dirname, '..', 'src', 'popup', 'popup.js'), 'utf8');
const configCode = readFileSync(join(__dirname, '..', 'src', 'core', 'embeddings-config.js'), 'utf8');
new Function(configCode)();
const CFG = globalThis.CanvascopeEmbeddingsConfig;

// popup.js is a classic script wired to the DOM, so it cannot be imported.
// Same source-slicing approach as dropbridge-v2.test.mjs.
function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Expected to find ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Expected to find ${endNeedle}`);
  return source.slice(start, end);
}

const refine = sourceBetween(popupSource, 'function scheduleSemanticRefine', 'function buildBoundaryMatcher');
const display = sourceBetween(popupSource, 'function displayResults(results)', 'function buildSubmissionBadge');

test('the semantic refine scores page vectors, not just item vectors', () => {
  assert.match(refine, /index\.pagesByItem/, 'must read the decoded page map');
  assert.match(refine, /THRESHOLDS\?\.bge\?\.page/, 'page hits need their own floor');
  assert.match(refine, /bestPage/, 'the winning page must be carried on the result');
});

// A document whose own item vector is missing must still be reachable through a
// page vector — that is the entire recall win of indexing PDF body text. A bare
// `continue` on a missing item row would silently discard it.
test('a missing item vector does not exclude the item from page scoring', () => {
  assert.match(refine, /-Infinity/);
  assert.doesNotMatch(
    refine,
    /const row = index\.byKey\.get\([^)]*\);\s*\n\s*if \(row === undefined\) continue;/,
    'the old item-only early-continue must be gone'
  );
});

// Both fallbacks read 0.55, the value the config comment records as having
// dropped a known-correct match. They are unreachable in production (the config
// script loads first) which is exactly why they rotted unnoticed.
test('threshold fallbacks match the configured values', () => {
  for (const key of ['item', 'page', 'recall']) {
    const found = refine.match(new RegExp(`THRESHOLDS\\?\\.bge\\?\\.${key}\\s*\\?\\?\\s*([\\d.]+)`));
    assert.ok(found, `expected a ${key} fallback in the refine`);
    assert.equal(Number(found[1]), CFG.THRESHOLDS.bge[key], `${key} fallback drifted from config`);
  }
});

// The common case for this feature is a query whose ORDER is already correct but
// where a row newly earns a page label. A key-only comparison sees no diff,
// returns early, and the hint never renders.
test('the order-identical early return is annotation-aware', () => {
  assert.match(refine, /const resultKey = /, 'a shared key extractor must exist');
  assert.match(refine, /resultKey\s*\)?[\s\S]{0,40}bestPage|bestPage[\s\S]{0,80}nextKeys/,
    'the repaint key must incorporate bestPage');
  assert.match(refine, /const nextKeys = merged\.map\(resultKey\)/);
  assert.match(refine, /const prevKeys = lexicalResults\.map\(resultKey\)/);
});

// lexicalResults is the already-painted array and the prevKeys baseline. If a
// future refactor annotates it in place, prevKeys starts reading annotations it
// wrote itself and the repaint silently stops happening.
test('the semantic list annotates a copy rather than mutating lexical results', () => {
  assert.match(refine, /\{ \.\.\.lex, bestPage, semanticSim: similarity \}/);
});

test('displayResults renders the page hint without needing a hidden CSS row', () => {
  assert.match(display, /const pageHint = /);
  assert.match(display, /· p\.\$\{pageHint\}/);
  // .overlay-result-context and .overlay-result-due are display:none in overlay
  // mode, so the hint rides on the course line, which is visible.
  const subtitle = sourceBetween(display, 'const baseSubtitle', 'if (shouldShowPathContext')
    .replace(/\/\/.*$/gm, '');
  const classNames = [...subtitle.matchAll(/className = '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(classNames, ['overlay-result-course'],
    'the page hint must not be rendered into a row that overlay mode hides');
});

// Pinned elsewhere in dropbridge-v2.test.mjs; re-asserted here so that a
// "cleanup" of displayResults during page-hint work fails in this file too.
test('displayResults keeps its existing pinned behavior', () => {
  assert.match(display, /defaultHighlightIndex/);
  assert.match(display, /!r\.item\?\.__isNote && !r\.item\?\.__isCustomTodo/);
  assert.match(display, /index === defaultHighlightIndex/);
  assert.doesNotMatch(display, /inOverlay && index === 0/);
  assert.match(popupSource, /item\.courseName \|\| item\.moduleName/);
});

test('the aria label spells out the page for screen readers', () => {
  const aria = sourceBetween(popupSource, 'function buildItemAriaLabel', 'function formatRelativeTime');
  assert.match(aria, /includeOpenedAt = false, page = null/, 'options bag, not a positional arg');
  assert.match(aria, /`page \$\{page\}`/, '"p.7" would be read as "p dot 7"');
  assert.match(display, /buildItemAriaLabel\(item, \{ page: pageHint \}\)/);
});

test('the palette hydrates its corpus before dedup, with a narrowed page cap', () => {
  const load = sourceBetween(popupSource, 'async function loadContent()', 'function clonePopupSubmissionSummary');
  assert.match(load, /courseMaterialChunks/);
  assert.match(load, /CM\.hydrateItems/);
  // Narrowed vs the index-bound defaults, but wide enough that the exact-token
  // body pass can actually see something: 400/4000 left it covering ~1-2% of a
  // lecture deck, which made the pass decorative.
  assert.match(load, /maxPageChars: 1200/, 'popup page window must not be vestigial');
  assert.match(load, /maxContentChars: PDF_BODY_SEARCH_LIMIT/,
    'body window must match the limit the body pass already assumes');
  assert.ok(
    load.indexOf('hydrateItems') < load.indexOf('deduplicateCrossType'),
    'hydration must precede dedup — the merge does not carry pages'
  );
});

test('the body-content recall revival has a kill switch', () => {
  const gate = sourceBetween(popupSource, 'function shouldRunBodyContentRecall', 'function countBoundaryMatches');
  assert.match(gate, /PALETTE_BODY_RECALL_ENABLED === false/);
  assert.equal(CFG.PALETTE_BODY_RECALL_ENABLED, true, 'shipped on, flippable off');
});

// dropbridge-v2.test.mjs needles the literal 'function openResult(item, event)'
// INCLUDING the closing paren, so the signature may not gain a parameter.
test('openResult keeps its pinned signature', () => {
  assert.match(popupSource, /function openResult\(item, event\)/);
});

test('buildPageAnchoredUrl only anchors urls a native PDF viewer will honor', () => {
  const helperSource = sourceBetween(popupSource, 'function buildPageAnchoredUrl', '\n}\n');
  assert.match(helperSource, /PALETTE_PAGE_DEEPLINK_ENABLED/);
  assert.match(helperSource, /download_frd/);

  // Evaluate the pure helper against a stubbed config.
  const make = (enabled) => {
    const scope = { CanvascopeEmbeddingsConfig: { PALETTE_PAGE_DEEPLINK_ENABLED: enabled } };
    return new Function('globalThis', `${helperSource}\n}\nreturn buildPageAnchoredUrl;`)(scope);
  };

  const off = make(false);
  assert.equal(off('https://x.edu/files/12/download', 7), 'https://x.edu/files/12/download',
    'disabled flag is a pass-through');

  const on = make(true);
  assert.equal(on('https://x.edu/files/12/download', 7), 'https://x.edu/files/12/download#page=7');
  // DocViewer preview page ignores fragments.
  assert.equal(on('https://x.edu/courses/3/files/12', 7), 'https://x.edu/courses/3/files/12');
  // download_frd=1 forces an attachment, so nothing renders to anchor into.
  assert.equal(on('https://x.edu/files/12/download?download_frd=1', 7),
    'https://x.edu/files/12/download?download_frd=1');
  assert.equal(on('https://x.edu/files/12/download', 0), 'https://x.edu/files/12/download');
  assert.equal(on('not a url', 3), 'not a url');
});

// ---------------------------------------------------------------------------
// The nine-query live failure: none of these were threshold tuning.
// ---------------------------------------------------------------------------

// THE headline bug. performSearch returned on results.length === 0 more than a
// hundred lines before it scheduled the refine, so a query whose only match is
// inside a PDF body — the exact thing page vectors exist for — could never be
// answered. Five of the nine failing queries died here.
test('the semantic pass is scheduled when lexical search finds nothing', () => {
  const search = sourceBetween(popupSource, 'if (results.length === 0) {', 'results = rankResults(');
  assert.match(search, /scheduleSemanticRefine\(query, queryMeta, \[\], searchCorpus\)/,
    'the zero-result branch must schedule the refine with an empty baseline');
  assert.match(search, /!options\.skipSideEffects/, 'and must respect skipSideEffects');
  // It has to be scheduled BEFORE the return, or nothing changes.
  const branch = sourceBetween(search, 'showNoResults(', '\n  }');
  assert.ok(
    branch.indexOf('scheduleSemanticRefine') < branch.lastIndexOf('return'),
    'the refine must be scheduled before the early return'
  );
});

// With no lexical list to rank-fuse against, the floor IS the relevance bar,
// so it must be stricter than the re-rank floor and the list must be shorter.
test('recall mode uses a stricter floor and a shorter list than re-rank mode', () => {
  assert.match(refine, /const isRecall = /);
  assert.match(refine, /isRecall[\s\S]{0,120}THRESHOLDS\?\.bge\?\.recall/,
    'recall mode must select the recall threshold');
  assert.match(refine, /isRecall \? \(CFG\.PALETTE_RECALL_TOP_N/,
    'recall mode must use the shorter cap');
  assert.ok(CFG.THRESHOLDS.bge.recall > CFG.THRESHOLDS.bge.item,
    'recall floor must sit above the noise floor');
  assert.ok(CFG.PALETTE_RECALL_TOP_N < CFG.PALETTE_SEMANTIC_TOP_N);
});

// displayResults wipes everything showNoResults injected.
test('a recall repaint restores the Ask affordance', () => {
  assert.match(refine, /if \(isRecall\) \{[\s\S]{0,200}injectAskRowIfQuestion/);
});

// Twelve silent exits on the hot path is how a dead feature shipped green.
test('every refine exit is observable under the debug flag', () => {
  assert.match(refine, /PALETTE_SEMANTIC_DEBUG/);
  assert.equal(typeof CFG.PALETTE_SEMANTIC_DEBUG, 'boolean');
  // Pin the GATE, not the current value: the flag is flipped on during live
  // debugging, but logging must never become unconditional. `debug` has to
  // resolve to a no-op when the flag is off.
  assert.match(refine, /PALETTE_SEMANTIC_DEBUG === true\)\s*\n?\s*\?/,
    'debug must be a ternary gated on the flag');
  assert.match(refine, /:\s*\(\)\s*=>\s*\{\}/, 'and a no-op when disabled');
  for (const marker of ['skipped:', 'aborted:', 'embed', 'scored', 'painted', 'threw']) {
    assert.ok(refine.includes(marker), `debug must report "${marker}"`);
  }
  assert.doesNotMatch(refine, /catch \(_\) \{\s*\n\s*\/\/ Lexical results are already painted[\s\S]{0,80}\n\s*\}/,
    'the outermost bare catch must now report');
});

// A timeout resolves {__timeout:true} with NO __error, so the original
// __error-only test skipped the retry for the single failure that actually
// happens: a cold host overrunning a budget sized for a loaded model.
test('embed-client retries when a cold host times out, not just when it is missing', () => {
  const clientSource = readFileSync(join(__dirname, '..', 'src', 'core', 'embed-client.js'), 'utf8');
  const request = sourceBetween(clientSource, 'async function request(', 'async function embedQuery');
  assert.match(request, /response\.__timeout/, 'a timeout must count as "nobody answered"');
  assert.match(request, /const noHost = .*NO_RECEIVER_RE.*\|\|.*__timeout/s);
  assert.match(request, /ensureHost/);
  // And the budget must adapt to a host that has not loaded its model yet.
  const budget = sourceBetween(clientSource, 'async function budgetFor(', 'async function request(');
  assert.match(budget, /op: 'status'/, 'must probe host state');
  assert.match(budget, /state === 'ready'/);
  assert.match(budget, /timeoutFor\('warmup'\)/, 'a cold host gets the warmup budget');
});

test('the palette pre-warms the model when it opens', () => {
  const contentSource = readFileSync(join(__dirname, '..', 'src', 'content', 'content.js'), 'utf8');
  const show = sourceBetween(contentSource, 'function showOverlay()', 'function hideOverlay()');
  assert.match(show, /csEmbeddingsPrewarm/,
    'the iframe is destroyed on every close, so warmup must start from the opener');

  const bgSource = readFileSync(join(__dirname, '..', 'src', 'background', 'background.js'), 'utf8');
  assert.match(bgSource, /message\.action === 'csEmbeddingsPrewarm'/, 'background must handle it');
});

// With ORT_PROXY=false the host loads WASM on the offscreen main thread and
// cannot answer a 2s probe, so "no answer" was closing the document out from
// under the very load a palette query had just started.
test('a not-busy host does not get its document closed while recently wanted', () => {
  const bgSource = readFileSync(join(__dirname, '..', 'src', 'background', 'background.js'), 'utf8');
  const close = sourceBetween(bgSource, 'async function maybeCloseSharedOffscreenDocument', '\n}\n');
  assert.match(close, /CS_EMBEDDINGS_CLOSE_GRACE_MS/);
  // The grace window must NOT be gated on a missing state. 'unloaded' is a
  // truthy string, and a freshly created doc reports exactly that until it
  // takes its first job — gating on `!state` closed brand-new documents on
  // sight, which is the one case the window exists for.
  assert.doesNotMatch(close, /!embedStatus\?\.state &&/,
    'the grace window must cover state:"unloaded", not only a missing state');
  assert.match(close, /readEmbeddingsHostWantedAt/, 'must read the durable timestamp');

  // The timestamp has to survive a service-worker restart: the close sweep runs
  // on the NEXT cold start, where a module variable is already back to 0.
  assert.match(bgSource, /storage\?\.session\?\.set\(\{ \[CS_EMBEDDINGS_WANTED_KEY\]/);
  // Every ensure counts as wanted, including the service worker's own.
  const ensure = sourceBetween(bgSource, 'async function ensureSharedOffscreenDocument', 'if (!chrome.offscreen)');
  assert.match(ensure, /markEmbeddingsHostWanted\(\)/);
});

// Two self-inflicted regressions from the first fix round, both of which
// produced the exact observed symptom (no page hint anywhere, "No results").
test('the page floor is not raised to the recall floor', () => {
  assert.doesNotMatch(refine, /Math\.max\(threshold, CFG\.THRESHOLDS\?\.bge\?\.page/,
    'recall mode would override the deliberately-lower page floor');
  assert.match(refine, /const pageThreshold = CFG\.THRESHOLDS\?\.bge\?\.page/);
  assert.ok(CFG.THRESHOLDS.bge.page < CFG.THRESHOLDS.bge.recall,
    'the page floor is meant to sit BELOW the recall floor');
});

test('a page hit labels its row without having to beat the item vector', () => {
  assert.doesNotMatch(refine, /bestPageSim > similarity/,
    'item passages carry the same body text, so the item vector routinely wins');
  assert.match(refine, /similarity = Math\.max\(similarity, bestPageSim\)/);
});

// 0.55 is the value this repo's own config records as having dropped a
// known-correct match at 0.5496. Re-introducing it in recall mode recreated the
// original bug in a new place.
test('the recall floor is not set at the known bad value', () => {
  assert.notEqual(CFG.THRESHOLDS.bge.recall, 0.55);
  assert.ok(CFG.THRESHOLDS.bge.recall > CFG.THRESHOLDS.bge.item);
  assert.ok(CFG.THRESHOLDS.bge.recall < 0.5496,
    'must sit below the measured correct-match score');
});

test('a zero-candidate run reports the closest miss instead of returning silently', () => {
  assert.match(refine, /no candidates cleared the floor/);
  assert.match(refine, /bestRejected/, 'must track the best rejected score');
  assert.match(refine, /keysMatched/, 'must distinguish a threshold miss from a key miss');
});

test('showNoResults releases the arrow-key highlight latch', () => {
  const noResults = sourceBetween(popupSource, 'function showNoResults(message)', 'if (state.isOverlayMode)');
  assert.match(noResults, /state\.overlayHighlightUserMoved = false/,
    'otherwise one ArrowDown latches it and every later recall refuses to paint');
});
