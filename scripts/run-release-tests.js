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
      'tests/backend-search-habits.test.mjs',
      'tests/legacy-regressions.test.mjs',
      'tests/skin-themes.test.mjs',
      'tests/academic-tools-gpa.test.mjs'
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
