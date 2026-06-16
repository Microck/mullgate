import os from 'node:os';

import type { Command } from 'commander';

import { type WritableTextSink, writeCliReport } from '../cli-output.js';
import { CONFIG_VERSION } from '../config/schema.js';

export const CLI_VERSION = '2.0.4';

/**
 * Optional I/O overrides for the `mullgate version` command.
 */
export type VersionCommandDependencies = {
  readonly stdout?: WritableTextSink;
};

/**
 * Registers the `version` command that prints CLI and runtime support metadata.
 *
 * @param program - Root CLI program to extend.
 * @param dependencies - Optional command dependencies for output control.
 */
export function registerVersionCommand(
  program: Command,
  dependencies: VersionCommandDependencies = {},
): void {
  program
    .command('version')
    .description('Print the CLI version plus core runtime metadata for support reports.')
    .action(() => {
      const stdout = dependencies.stdout ?? process.stdout;

      writeCliReport({
        sink: stdout,
        text: [
          'Mullgate version',
          `cli version: ${CLI_VERSION}`,
          `config schema: ${CONFIG_VERSION}`,
          `node: ${process.version}`,
          `platform: ${process.platform}`,
          `arch: ${process.arch}`,
          `hostname: ${os.hostname()}`,
        ].join('\n'),
      });
    });
}
