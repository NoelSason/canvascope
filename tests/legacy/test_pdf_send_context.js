const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BACKGROUND_PATH = path.join(__dirname, 'src/background/background.js');
const backgroundSource = fs.readFileSync(BACKGROUND_PATH, 'utf8');

function extractFunctionSource(source, functionName) {
  const signature = `function ${functionName}`;
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`Unable to find ${functionName} in background.js`);
  }

  const parenStart = source.indexOf('(', start);
  if (parenStart === -1) {
    throw new Error(`Unable to find parameter list for ${functionName}`);
  }

  let parenDepth = 0;
  let parenEnd = parenStart;
  for (; parenEnd < source.length; parenEnd += 1) {
    const char = source[parenEnd];
    if (char === '(') {
      parenDepth += 1;
    } else if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        break;
      }
    }
  }

  const braceStart = source.indexOf('{', parenEnd);
  if (braceStart === -1) {
    throw new Error(`Unable to find opening body brace for ${functionName}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, end + 1);
      }
    }
  }

  throw new Error(`Unable to find closing brace for ${functionName}`);
}

const functionNames = [
  'isPdfSupportedFetchProtocol',
  'normalizePdfCandidateUrl',
  'cleanTitle',
  'hasStrongPdfSendContext',
  'resolvePdfSendRequestPayload'
];

const context = {
  URL,
  console,
  String,
  Boolean
};

vm.createContext(context);
vm.runInContext(
  functionNames.map((name) => extractFunctionSource(backgroundSource, name)).join('\n\n'),
  context
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const livePreferred = context.resolvePdfSendRequestPayload({
  liveContext: {
    hasPdf: true,
    confidence: 'definitive',
    candidateUrl: 'https://example.edu/files/222/download',
    sourcePageUrl: 'https://example.edu/courses/1/files/222',
    titleHint: 'New PDF'
  },
  fallbackCandidateUrl: 'https://example.edu/files/111/download',
  fallbackSourcePageUrl: 'https://example.edu/courses/1/files/111',
  fallbackTitleHint: 'Old PDF'
});

assert(livePreferred.source === 'live_context', 'Expected live context to win over stale caller input.');
assert(livePreferred.candidateUrl === 'https://example.edu/files/222/download', 'Expected the newer live candidate URL.');
assert(livePreferred.sourcePageUrl === 'https://example.edu/courses/1/files/222', 'Expected the live source page URL.');
assert(livePreferred.titleHint === 'New PDF', 'Expected the live title hint.');

const fallbackPreferred = context.resolvePdfSendRequestPayload({
  liveContext: {
    hasPdf: false,
    confidence: 'weak',
    candidateUrl: 'https://example.edu/files/333/download',
    sourcePageUrl: 'https://example.edu/courses/1/files/333',
    titleHint: 'Weak Context'
  },
  fallbackCandidateUrl: 'https://example.edu/files/111/download',
  fallbackSourcePageUrl: 'https://example.edu/courses/1/files/111',
  fallbackTitleHint: 'Fallback PDF'
});

assert(fallbackPreferred.source === 'fallback_message', 'Expected fallback candidate when fresh context is not strong.');
assert(fallbackPreferred.candidateUrl === 'https://example.edu/files/111/download', 'Expected the fallback candidate URL.');
assert(fallbackPreferred.sourcePageUrl === 'https://example.edu/courses/1/files/111', 'Expected the fallback source URL.');
assert(fallbackPreferred.titleHint === 'Fallback PDF', 'Expected the fallback title hint.');

const unresolved = context.resolvePdfSendRequestPayload({
  liveContext: {
    hasPdf: false,
    confidence: 'none',
    candidateUrl: null,
    sourcePageUrl: null,
    titleHint: null
  },
  fallbackCandidateUrl: null,
  fallbackSourcePageUrl: null,
  fallbackTitleHint: null
});

assert(unresolved.source === 'unresolved', 'Expected unresolved result when neither live nor fallback inputs are valid.');
assert(unresolved.candidateUrl === null, 'Expected no candidate URL when unresolved.');

console.log('PDF send context regression checks passed.');
