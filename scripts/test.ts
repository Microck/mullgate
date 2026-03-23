import { spawn } from 'node:child_process';
import path from 'node:path';

const forwardedArgs = process.argv.slice(2);
const normalizedArgs = forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;
const vitestEntrypoint = path.resolve(
  import.meta.dirname,
  '..',
  'node_modules',
  'vitest',
  'vitest.mjs',
);

const child = spawn(process.execPath, [vitestEntrypoint, ...normalizedArgs], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
