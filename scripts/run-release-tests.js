const { spawnSync } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

function commandExists(command) {
  const probe = spawnSync(command, ['--version'], {
    cwd: rootDir,
    stdio: 'ignore',
    env: process.env
  });
  return !probe.error;
}

function preflightRequiredTools() {
  const requiredTools = [...new Set(steps.map((step) => step.command))];
  const missingTools = requiredTools.filter((command) => !commandExists(command));

  if (missingTools.length === 0) {
    return;
  }

  throw new Error(
    `Missing required release test tool${missingTools.length === 1 ? '' : 's'}: ${missingTools.join(', ')}. ` +
      'Install the missing CLI(s), or run `npm run test:node` for Node-only regression tests.'
  );
}

const steps = [
  {
    name: 'Node regression tests',
    command: 'npm',
    args: ['run', 'test:node']
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
  preflightRequiredTools();

  for (const step of steps) {
    runStep(step);
  }
  console.log('\nRelease test suite passed.');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nRelease test suite failed: ${message}`);
  process.exit(1);
}
