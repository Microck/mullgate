#!/usr/bin/env node

import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { writeCliReport } from './cli-output.js';
import { registerCompletionsCommand } from './commands/completions.js';
import { registerConfigCommands } from './commands/config.js';
import { registerProxyCommand } from './commands/proxy.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerVersionCommand } from './commands/version.js';

/**
 * Builds the Mullgate CLI command tree with all top-level subcommands registered.
 */
export function createCli(): Command {
  const program = new Command();

  program
    .name('mullgate')
    .description('Minimal Mullvad proxy CLI for setup, daily proxy operations, and advanced config')
    .version(packageJson.version, '-v, --version', 'display the installed Mullgate CLI version')
    .showHelpAfterError();

  registerSetupCommand(program);
  registerProxyCommand(program);
  registerConfigCommands(program);
  registerVersionCommand(program);
  registerCompletionsCommand(program);

  return program;
}

async function main(): Promise<void> {
  const program = createCli();
  await program.parseAsync(process.argv);
}

function readErrorDetail(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== 'object' || !(key in error)) {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [
    'Mullgate CLI failed.',
    ...(readErrorDetail(error, 'phase') ? [`phase: ${readErrorDetail(error, 'phase')}`] : []),
    ...(readErrorDetail(error, 'source') ? [`source: ${readErrorDetail(error, 'source')}`] : []),
    ...(readErrorDetail(error, 'code') ? [`code: ${readErrorDetail(error, 'code')}`] : []),
    ...(readErrorDetail(error, 'artifactPath')
      ? [`artifact: ${readErrorDetail(error, 'artifactPath')}`]
      : []),
    `reason: ${message}`,
    ...(readErrorDetail(error, 'cause') ? [`cause: ${readErrorDetail(error, 'cause')}`] : []),
  ];
  writeCliReport({
    sink: process.stderr,
    text: lines.join('\n'),
    tone: 'error',
  });
  process.exitCode = 1;
});
