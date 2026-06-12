const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OVERLAY_PATH = path.join(__dirname, 'src/content/slash-overlay.js');
const overlaySource = fs.readFileSync(OVERLAY_PATH, 'utf8');

function extractFunctionSource(source, functionName) {
  const signature = `function ${functionName}`;
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`Unable to find ${functionName} in slash-overlay.js`);
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const functionNames = [
  'executeEntry',
  'executeGradescope',
  'onInputKeydown'
];

const context = {
  console,
  Promise,
  currentEntries: [],
  highlightedIndex: 0,
  executed: 0,
  feedbackCalls: [],
  closeCalls: 0,
  openCalls: [],
  setFeedbackMsg(message, tone) {
    context.feedbackCalls.push({ message, tone });
  },
  closeOverlay() {
    context.closeCalls += 1;
  },
  window: {
    open(url, target, features) {
      context.openCalls.push({ url, target, features });
    }
  }
};

vm.createContext(context);
vm.runInContext(
  functionNames.map((name) => extractFunctionSource(overlaySource, name)).join('\n\n'),
  context
);

(async () => {
  let prevented = false;
  context.currentEntries = [{
    onSelect() {
      context.executed += 1;
    }
  }];
  context.highlightedIndex = 0;

  context.onInputKeydown({
    key: 'Enter',
    preventDefault() {
      prevented = true;
    }
  });

  await Promise.resolve();

  assert(prevented, 'Expected Enter to prevent default in slash overlay.');
  assert(context.executed === 1, 'Expected Enter to execute the highlighted slash overlay entry.');

  await context.executeGradescope();
  assert(context.openCalls.length === 1, 'Expected Gradescope command to open a new tab via window.open.');
  assert(context.openCalls[0].url === 'https://www.gradescope.com/', 'Expected Gradescope to open the canonical URL.');
  assert(context.closeCalls === 1, 'Expected Gradescope command to close the overlay after opening.');

  context.currentEntries = [{
    onSelect() {
      return Promise.reject(new Error('boom'));
    }
  }];
  context.highlightedIndex = 0;
  context.feedbackCalls = [];

  context.onInputKeydown({
    key: 'Enter',
    preventDefault() {}
  });

  await Promise.resolve();
  await Promise.resolve();

  assert(context.feedbackCalls.length === 1, 'Expected slash overlay failures to surface feedback.');
  assert(context.feedbackCalls[0].tone === 'error', 'Expected slash overlay failures to use error feedback.');

  console.log('Slash overlay regression checks passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
