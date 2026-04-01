import type { Command } from 'commander';

import { writeCliReport } from '../cli-output.js';
import type { AccessMode, ExposureMode } from '../config/schema.js';
import { ConfigStore } from '../config/store.js';
import { registerAutostartCommand } from './autostart.js';
import {
  type ExposureCommandOptions,
  registerExportCommand,
  registerLocationsCommand,
  registerValidateCommand,
  renderExposureReport,
  renderHostsReport,
  renderLoadConfigError,
  renderMissingConfigError,
  updateExposureConfig,
} from './config.js';
import { registerDoctorCommand } from './doctor.js';
import { registerRecommendCommand } from './recommend.js';
import { registerRelaysCommand } from './relays.js';
import { registerStartCommand } from './start.js';
import { registerStatusCommand } from './status.js';

export function registerProxyCommand(program: Command): void {
  const proxy = program
    .command('proxy')
    .description(
      'Operate runtime, access, export, relay, and startup surfaces for routed proxies.',
    );

  registerStartCommand(proxy);
  registerStatusCommand(proxy);
  registerDoctorCommand(proxy);
  registerValidateCommand(proxy);
  registerLocationsCommand(proxy, {
    commandName: 'list',
    description: 'List configured routed proxies, hostnames, bind IPs, and runtime ids.',
  });
  registerExportCommand(proxy);
  registerAutostartCommand(proxy);
  registerProxyAccessCommand(proxy);

  const relay = registerRelaysCommand(proxy, { commandName: 'relay' });
  registerRecommendCommand(relay);
  relay.description('Inspect relays, recommend exact exits, and verify configured route exits.');

  proxy.addHelpText(
    'after',
    [
      '',
      'Quick commands:',
      '  mullgate proxy access',
      '  mullgate proxy start',
      '  mullgate proxy status',
      '  mullgate proxy doctor',
      '  mullgate proxy export --regions',
      '',
      'Advanced commands:',
      '  mullgate proxy relay list',
      '  mullgate proxy relay probe',
      '  mullgate proxy relay recommend',
      '  mullgate proxy autostart status',
      '  mullgate config show',
    ].join('\n'),
  );
}

function registerProxyAccessCommand(target: Command): void {
  target
    .command('access')
    .option('--mode <mode>', 'Set exposure mode to loopback, private-network, or public.')
    .option('--access-mode <mode>', 'Set access mode to published-routes or inline-selector.')
    .option('--base-domain <domain>', 'Set the base domain used to derive per-route hostnames.')
    .option(
      '--unsafe-public-empty-password',
      'Allow empty passwords when inline-selector is exposed on a public host.',
    )
    .option(
      '--clear-base-domain',
      'Remove any configured base domain and fall back to alias/direct-IP hostnames.',
    )
    .option(
      '--route-bind-ip <ip>',
      'Set an ordered per-route bind IP. Repeat once per route.',
      collectRepeatedValues,
      [],
    )
    .description(
      'Inspect or update published route hostnames, bind IPs, direct-IP entrypoints, and DNS guidance.',
    )
    .action(async (options: ExposureCommandOptions) => {
      const store = new ConfigStore();
      const result = await store.load();

      if (!result.ok) {
        writeCliReport({
          sink: process.stderr,
          text: renderLoadConfigError(result),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      if (result.source === 'empty') {
        writeCliReport({
          sink: process.stderr,
          text: renderMissingConfigError(result.message, store.paths.configFile),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      if (!hasAccessUpdate(options)) {
        writeCliReport({
          sink: process.stdout,
          text: renderProxyAccessReport({
            config: result.config,
            configPath: store.paths.configFile,
          }),
        });
        return;
      }

      if (options.baseDomain !== undefined && options.clearBaseDomain) {
        writeCliReport({
          sink: process.stderr,
          text: [
            'Mullgate proxy access update failed.',
            'phase: proxy-access',
            'source: input',
            `artifact: ${store.paths.configFile}`,
            'reason: Pass --base-domain or --clear-base-domain, not both.',
          ].join('\n'),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      let mode: ExposureMode | undefined;
      let accessMode: AccessMode | undefined;

      try {
        mode = options.mode ? parseExposureModeOption(options.mode) : undefined;
        accessMode = options.accessMode ? parseAccessModeOption(options.accessMode) : undefined;
      } catch (error) {
        writeCliReport({
          sink: process.stderr,
          text: [
            'Mullgate proxy access update failed.',
            'phase: proxy-access',
            'source: input',
            `artifact: ${store.paths.configFile}`,
            `reason: ${error instanceof Error ? error.message : String(error)}`,
          ].join('\n'),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      const updateResult = updateExposureConfig(result.config, store.paths.configFile, {
        ...(mode ? { mode } : {}),
        ...(accessMode ? { accessMode } : {}),
        ...(options.unsafePublicEmptyPassword !== undefined
          ? { allowUnsafePublicEmptyPassword: options.unsafePublicEmptyPassword }
          : {}),
        ...(options.baseDomain !== undefined ? { baseDomain: options.baseDomain } : {}),
        baseDomainSpecified: Boolean(options.baseDomain !== undefined || options.clearBaseDomain),
        ...(options.clearBaseDomain ? { baseDomain: null } : {}),
        ...(options.routeBindIp && options.routeBindIp.length > 0
          ? { routeBindIps: options.routeBindIp }
          : {}),
      });

      if (!updateResult.ok) {
        writeCliReport({
          sink: process.stderr,
          text: renderProxyAccessUpdateError(updateResult),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      try {
        await store.save(updateResult.config);
      } catch (error) {
        writeCliReport({
          sink: process.stderr,
          text: [
            'Mullgate proxy access update failed.',
            'phase: persist-config',
            'source: filesystem',
            `artifact: ${store.paths.configFile}`,
            'reason: Failed to persist the updated access contract.',
            `cause: ${error instanceof Error ? error.message : String(error)}`,
          ].join('\n'),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      writeCliReport({
        sink: process.stdout,
        text: [
          'Mullgate proxy access updated.',
          'phase: proxy-access',
          'source: canonical-config',
          `config: ${store.paths.configFile}`,
          '',
          renderProxyAccessReport({
            config: updateResult.config,
            configPath: store.paths.configFile,
          }),
        ].join('\n'),
        tone: 'success',
      });
    });
}

function renderProxyAccessReport(input: {
  readonly config: Parameters<typeof renderExposureReport>[0];
  readonly configPath: string;
}): string {
  return [
    renderExposureReport(input.config, input.configPath),
    renderHostsReport(input.config, input.configPath),
  ].join('\n\n');
}

function renderProxyAccessUpdateError(
  result: ReturnType<typeof updateExposureConfig> & { readonly ok: false },
): string {
  return [
    'Mullgate proxy access update failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    `artifact: ${result.artifactPath}`,
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
  ].join('\n');
}

function hasAccessUpdate(options: ExposureCommandOptions): boolean {
  return Boolean(
    options.mode ||
      options.accessMode ||
      options.unsafePublicEmptyPassword !== undefined ||
      options.baseDomain !== undefined ||
      options.clearBaseDomain ||
      options.routeBindIp?.length,
  );
}

function parseExposureModeOption(raw: string): ExposureMode {
  const normalized = raw.trim();

  if (normalized === 'loopback' || normalized === 'private-network' || normalized === 'public') {
    return normalized;
  }

  throw new Error('Exposure mode must be loopback, private-network, or public.');
}

function parseAccessModeOption(raw: string): AccessMode {
  const normalized = raw.trim();

  if (normalized === 'published-routes' || normalized === 'inline-selector') {
    return normalized;
  }

  throw new Error('Access mode must be published-routes or inline-selector.');
}

function collectRepeatedValues(value: string, previous: string[]): string[] {
  return [...previous, value.trim()].filter((entry) => entry.length > 0);
}
