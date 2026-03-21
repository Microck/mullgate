#!/usr/bin/env node

import { Command } from 'commander';

import { registerConfigCommands } from './commands/config.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerStartCommand } from './commands/start.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('mullgate')
    .description('CLI-first Mullvad proxy provisioning and config management')
    .showHelpAfterError();

  registerSetupCommand(program);
  registerStartCommand(program);
  registerConfigCommands(program);

  return program;
}

async function main(): Promise<void> {
  const program = createCli();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
