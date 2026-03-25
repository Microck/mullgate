#!/usr/bin/env node

import { Command } from 'commander';
import { writeCliReport } from './cli-output.js';
import { registerAutostartCommand } from './commands/autostart.js';
import { registerConfigCommands, registerOperatorCommands } from './commands/config.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerRecommendCommand } from './commands/recommend.js';
import { registerRelaysCommand } from './commands/relays.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatusCommand } from './commands/status.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('mullgate')
    .description('CLI-first Mullvad proxy provisioning and config management')
    .showHelpAfterError();

  registerSetupCommand(program);
  registerStartCommand(program);
  registerStatusCommand(program);
  registerDoctorCommand(program);
  registerAutostartCommand(program);
  registerOperatorCommands(program);
  registerRelaysCommand(program);
  registerRecommendCommand(program);
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
