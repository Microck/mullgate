#!/usr/bin/env tsx

import {
  parseTailscaleFeasibilityArgs,
  renderTailscaleFeasibilityHelp,
  runTailscaleFeasibilityVerifier,
} from '../src/tailscale/feasibility-runner.js';

async function main(): Promise<void> {
  try {
    const forwardedArgs = process.argv.slice(2);
    const normalizedArgs = forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;
    const parsed = parseTailscaleFeasibilityArgs(normalizedArgs);

    if (!parsed.ok) {
      if (parsed.error) {
        process.stderr.write(`${parsed.error}\n\n`);
      }
      process.stdout.write(parsed.helpText);
      process.exitCode = parsed.exitCode;
      return;
    }

    const result = await runTailscaleFeasibilityVerifier(parsed.options);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stdout.write(renderTailscaleFeasibilityHelp());
    process.exitCode = 1;
  }
}

main();
