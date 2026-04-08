import os from 'node:os';

import type { Command } from 'commander';

import packageJson from '../../package.json' with { type: 'json' };
import { type WritableTextSink, writeCliReport } from '../cli-output.js';
import { CONFIG_VERSION } from '../config/schema.js';

export type VersionCommandDependencies = {
  readonly stdout?: WritableTextSink;
};

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
          `cli version: ${packageJson.version}`,
          `config schema: ${CONFIG_VERSION}`,
          `node: ${process.version}`,
          `platform: ${process.platform}`,
          `arch: ${process.arch}`,
          `hostname: ${os.hostname()}`,
        ].join('\n'),
      });
    });
}
