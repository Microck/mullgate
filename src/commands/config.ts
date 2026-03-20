import type { Command } from 'commander';

import { formatRedactedConfig } from '../config/redact.js';
import { ConfigStore, type LoadConfigResult } from '../config/store.js';

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('Inspect saved Mullgate configuration and derived paths.');

  config
    .command('path')
    .description('Show the resolved Mullgate XDG paths.')
    .action(async () => {
      const store = new ConfigStore();
      const report = await store.inspectPaths();
      process.stdout.write(`${renderPathReport(report)}\n`);
    });

  config
    .command('show')
    .description('Show the saved Mullgate config with secrets redacted.')
    .action(async () => {
      const store = new ConfigStore();
      const result = await store.load();

      if (!result.ok) {
        process.stderr.write(`${renderLoadError(result)}\n`);
        process.exitCode = 1;
        return;
      }

      if (result.source === 'empty') {
        process.stdout.write(`${result.message}\n`);
        return;
      }

      process.stdout.write(`${formatRedactedConfig(result.config)}\n`);
    });
}

export function renderPathReport(report: Awaited<ReturnType<ConfigStore['inspectPaths']>>): string {
  const { paths, exists } = report;

  return [
    'Mullgate path report',
    `phase: ${report.phase}`,
    `source: ${report.source}`,
    `config file: ${paths.configFile} (${exists.configFile ? 'present' : 'missing'})`,
    `state dir: ${paths.appStateDir}`,
    `cache dir: ${paths.appCacheDir}`,
    `wireproxy config: ${paths.wireproxyConfigFile}`,
    `wireproxy configtest report: ${paths.wireproxyConfigTestReportFile}`,
    `relay cache: ${paths.provisioningCacheFile} (${exists.relayCacheFile ? 'present' : 'missing'})`,
  ].join('\n');
}

function renderLoadError(result: Extract<LoadConfigResult, { ok: false }>): string {
  return [
    'Failed to inspect Mullgate config.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    `artifact: ${result.artifactPath}`,
    `reason: ${result.message}`,
  ].join('\n');
}
