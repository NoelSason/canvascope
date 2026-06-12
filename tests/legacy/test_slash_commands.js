const fs = require('fs');
const path = require('path');
const vm = require('vm');

const POPUP_PATH = path.join(__dirname, 'src/popup/popup.js');
const popupSource = fs.readFileSync(POPUP_PATH, 'utf8');

function extractFunctionSource(source, functionName) {
  const signature = `function ${functionName}`;
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`Unable to find ${functionName} in popup.js`);
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
  'normalizeText',
  'normalizeSlashAlias',
  'buildSlashCommandLookup',
  'scoreSlashCommandMatch',
  'rankSlashCommands',
  'parseSlashCommandText',
  'isSlashPdfEligibleItem',
  'handleSearchInputKeydown'
];

const context = {
  console,
  String,
  Array,
  Map,
  state: {
    slashMode: {
      active: false,
      results: [],
      highlightedIndex: 0
    },
    isOverlayMode: false,
    overlayHighlightIndex: 0
  },
  elements: {
    searchInput: { value: '' },
    resultsContainer: {
      querySelector() { return null; },
      querySelectorAll() { return []; }
    }
  },
  executeSlashHighlightedEntry() {},
  moveSlashHighlight() {},
  chrome: {
    storage: {
      local: {
        get() {}
      }
    }
  },
  sanitizeAdminExport() {
    return {};
  },
  Blob: class Blob {},
  URL: {
    createObjectURL() { return 'blob:test'; },
    revokeObjectURL() {}
  },
  document: {
    body: {
      appendChild() {},
      removeChild() {}
    },
    createElement() {
      return {
        click() {}
      };
    }
  }
};

vm.createContext(context);
vm.runInContext(
  functionNames.map((name) => extractFunctionSource(popupSource, name)).join('\n\n'),
  context
);

const commands = [
  {
    id: 'lectra-send',
    order: 0,
    primaryAlias: 'ls',
    aliases: ['lectra', 'lectra-send'],
    title: 'Lectra Send',
    description: 'Find a PDF and send it to Lectra.',
    keywords: ['pdf', 'send', 'annotate']
  },
  {
    id: 'gradescope',
    order: 1,
    primaryAlias: 'gs',
    aliases: ['gradescope'],
    title: 'Open Gradescope',
    description: 'Launch Gradescope in a new tab.',
    keywords: ['gradescope', 'grade', 'open']
  },
  {
    id: 'refresh',
    order: 2,
    primaryAlias: 'refresh',
    aliases: ['sync'],
    title: 'Refresh Index',
    description: 'Kick off a fresh Canvascope sync.',
    keywords: ['refresh', 'sync', 'scan']
  }
];

const lookup = context.buildSlashCommandLookup(commands);

assert(lookup.get('ls')?.id === 'lectra-send', 'Expected primary alias lookup for /ls.');
assert(lookup.get('gradescope')?.id === 'gradescope', 'Expected secondary alias lookup for /gradescope.');
assert(lookup.get('sync')?.id === 'refresh', 'Expected alias lookup for /sync.');

const parsedCommand = context.parseSlashCommandText('/ls', lookup);
assert(parsedCommand.active === true, 'Expected slash input to be active.');
assert(parsedCommand.mode === 'commands', 'Expected /ls without a space to stay in command mode.');
assert(parsedCommand.exactCommand?.id === 'lectra-send', 'Expected /ls to resolve to the Lectra command.');

const parsedResults = context.parseSlashCommandText('/ls organic chemistry', lookup);
assert(parsedResults.mode === 'results', 'Expected /ls with a trailing argument to switch into results mode.');
assert(parsedResults.argumentText === 'organic chemistry', 'Expected slash parser to preserve the argument text.');

const parsedPrefix = context.parseSlashCommandText('/g', lookup);
assert(parsedPrefix.mode === 'commands', 'Expected /g to stay in command mode until the command is exact.');
assert(parsedPrefix.exactCommand === null, 'Expected /g to have no exact command yet.');

let highlightedExecutions = 0;
let highlightDelta = null;
context.executeSlashHighlightedEntry = () => {
  highlightedExecutions += 1;
};
context.moveSlashHighlight = (delta) => {
  highlightDelta = delta;
};

context.state.slashMode.active = true;
context.state.isOverlayMode = false;
context.handleSearchInputKeydown({
  key: 'Enter',
  preventDefault() {}
});
assert(highlightedExecutions === 1, 'Expected Enter to execute the highlighted slash entry when slash mode is active.');

context.handleSearchInputKeydown({
  key: 'ArrowDown',
  preventDefault() {}
});
assert(highlightDelta === 1, 'Expected ArrowDown to move the slash highlight when slash mode is active.');

context.handleSearchInputKeydown({
  key: 'ArrowUp',
  preventDefault() {}
});
assert(highlightDelta === -1, 'Expected ArrowUp to move the slash highlight upward when slash mode is active.');

const rankedByAlias = context.rankSlashCommands(commands, 'gr');
assert(rankedByAlias[0]?.id === 'gradescope', 'Expected Gradescope to rank first for a /gr query.');

const rankedByAliasAlias = context.rankSlashCommands(commands, 'sync');
assert(rankedByAliasAlias[0]?.id === 'refresh', 'Expected Refresh to rank first for a /sync query.');

assert(
  context.isSlashPdfEligibleItem({ type: 'pdf', title: 'Lecture Notes', url: 'https://example.edu/files/1' }) === true,
  'Expected type=pdf items to be eligible for /ls.'
);
assert(
  context.isSlashPdfEligibleItem({ type: 'file', title: 'Lab A.pdf', url: 'https://example.edu/files/2' }) === true,
  'Expected file items with a .pdf title to be eligible for /ls.'
);
assert(
  context.isSlashPdfEligibleItem({ type: 'file', title: 'Syllabus', url: 'https://example.edu/files/2/download?download=1&name=syllabus.pdf' }) === true,
  'Expected file items with a .pdf URL to be eligible for /ls.'
);
assert(
  context.isSlashPdfEligibleItem({ type: 'file', title: 'Syllabus', url: 'https://example.edu/files/2' }) === false,
  'Expected generic file items without a PDF hint to stay ineligible for /ls.'
);

console.log('Slash command regression checks passed.');
