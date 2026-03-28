#!/usr/bin/env node

import { Command } from 'commander';
import { writeCliReport } from './cli-output.js';
import { registerConfigCommands } from './commands/config.js';
import { registerProxyCommand } from './commands/proxy.js';
import { registerSetupCommand } from './commands/setup.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('mullgate')
    .description('Minimal Mullvad proxy CLI for setup, daily proxy operations, and advanced config')
    .showHelpAfterError();

  registerSetupCommand(program);
  registerProxyCommand(program);
  registerConfigCommands(program);

  return program;
}

async function main(): Promise<void> {
  const program = createCli();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeCliReport({
    sink: process.stderr,
    text: ['Mullgate CLI failed.', `reason: ${message}`].join('\n'),
    tone: 'error',
  });
  process.exitCode = 1;
});
