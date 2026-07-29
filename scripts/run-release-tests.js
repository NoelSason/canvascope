const { spawnSync } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

const steps = [
  {
    name: 'Node regression tests',
    command: process.execPath,
    args: [
      '--experimental-transform-types',
      '--test',
      // Keep this list alphabetical and byte-identical to package.json's
      // `test:node`. The two drifted apart once already (four files ran only
      // in test:node, two only here, and grade-target in neither), which meant
      // the release gate silently covered less than local runs.
      'tests/academic-tools-gpa.test.mjs',
      'tests/backend-search-habits.test.mjs',
      'tests/background-tools-sync.test.mjs',
      'tests/character-profile.test.mjs',
      'tests/course-material-hydrate.test.mjs',
      'tests/course-materials.test.mjs',
      'tests/document-parser.test.mjs',
      'tests/dropbridge-v2.test.mjs',
      'tests/embedding-index.test.mjs',
      'tests/embeddings-config.test.mjs',
      'tests/embeddings-host.test.mjs',
      'tests/exam-builder.test.mjs',
      'tests/grade-target.test.mjs',
      'tests/legacy-regressions.test.mjs',
      'tests/local-ai.test.mjs',
      'tests/local-embeddings.test.mjs',
      'tests/optional-capabilities.test.mjs',
      'tests/palette-page-hits.test.mjs',
      'tests/query-normalizer.test.mjs',
      'tests/rag-core.test.mjs',
      'tests/risc-removal.test.mjs',
      'tests/semantic-matcher.test.mjs',
      'tests/skin-themes.test.mjs'
    ]
  },
  {
    name: 'Start local Supabase database',
    command: 'supabase',
    args: ['db', 'start']
  },
  {
    name: 'Wait for local Supabase services',
    command: 'sleep',
    args: ['10']
  },
  {
    name: 'Reset local Supabase database',
    command: 'supabase',
    args: ['db', 'reset', '--local', '--yes']
  },
  {
    name: 'Supabase pgTAP contract tests',
    command: 'supabase',
    args: ['test', 'db', '--local', 'supabase/tests']
  }
];

function runStep(step) {
  console.log(`\n==> ${step.name}`);

  const result = spawnSync(step.command, step.args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    const detail = result.signal ? ` (signal: ${result.signal})` : '';
    throw new Error(`${step.name} failed with exit code ${result.status}${detail}`);
  }
}

try {
  for (const step of steps) {
    runStep(step);
  }
  console.log('\nRelease test suite passed.');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nRelease test suite failed: ${message}`);
  process.exit(1);
}
