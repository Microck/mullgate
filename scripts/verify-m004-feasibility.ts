#!/usr/bin/env tsx

import {
  parseFeasibilityArgs,
  renderFeasibilityHelp,
  runFeasibilityVerifier,
} from '../src/m004/feasibility-runner.js';

async function main(): Promise<void> {
  try {
    const forwardedArgs = process.argv.slice(2);
    const normalizedArgs = forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;
    const parsed = parseFeasibilityArgs(normalizedArgs);

    if (!parsed.ok) {
      if (parsed.error) {
        process.stderr.write(`${parsed.error}\n\n`);
      }
      process.stdout.write(parsed.helpText);
      process.exitCode = parsed.exitCode;
      return;
    }

    const result = await runFeasibilityVerifier(parsed.options);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stdout.write(renderFeasibilityHelp());
    process.exitCode = 1;
  }
}

main();
