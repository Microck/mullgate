import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { withRuntimeStatus } from '../app/setup-runner.js';
import { writeCliRaw, writeCliReport } from '../cli-output.js';
import { formatRedactedConfig } from '../config/redact.js';
import type { MullgateConfig } from '../config/schema.js';
import { ConfigStore, type LoadConfigResult, normalizeMullgateConfig } from '../config/store.js';
import { listRegionGroupNames } from '../domain/region-groups.js';
import type { MullvadRelayCatalog } from '../mullvad/fetch-relays.js';
import {
  applyPostSetNormalization,
  EDITABLE_CONFIG_FIELDS,
  formatOutputValue,
  formatRawInput,
  getConfigValue,
  readStdinValue,
  setConfigValue,
} from './config-fields.js';
import {
  renderExposureReport,
  renderHostsReport,
  renderLocationsReport,
  renderPathReport,
  renderRegionGroupsReport,
  updateExposureConfig,
} from './config-reports.js';
import {
  renderValidationError,
  renderValidationSuccess,
  validateSavedConfig,
} from './config-validation.js';
import { collectGuidedProxyExportInput } from './proxy-export-guided.js';
import { resolveProxyExportOutputPath } from './proxy-export-output-path.js';
import {
  buildProxyExportPlan,
  type ProxyExportPlanSuccess,
  type ProxyExportProtocol,
  type ProxyExportResolvedInput,
  type ProxyExportWriteMode,
  resolveProxyExportSelectorsWithCatalog,
} from './proxy-export-plan.js';
import {
  chooseRelaysForProxyExportSelector,
  chooseSpreadRelays,
  listMatchingRelays,
  type ProxyExportEntry,
  renderProxyExportSelectorLabel,
} from './proxy-export-relays.js';
import {
  renderProxyExportError,
  renderProxyExportPreview,
  renderProxyExportStdoutNotice,
  renderProxyExportSuccess,
} from './proxy-export-render.js';
import {
  describeConfiguredProxyExportRoutes,
  type ProxyExportRouteDescriptor,
  planProxyExportRelayTargets,
} from './proxy-export-route-descriptors.js';
import { ensureProxyExportRoutes, loadRelayCatalogForProxyExport } from './proxy-export-routes.js';
import {
  extractOrderedCommandArgs,
  extractProxyExportArgs,
  type ProxyExportFailure,
  type ProxyExportSelector,
  parseProxyExportSelectors,
  parseRelayOwnerFilter,
  parseRelayRunModeFilter,
  type RelayOwnerFilter,
  type RelayRunModeFilter,
} from './proxy-export-selectors.js';

export {
  buildProxyExportPlan,
  chooseRelaysForProxyExportSelector,
  chooseSpreadRelays,
  describeConfiguredProxyExportRoutes,
  ensureProxyExportRoutes,
  extractOrderedCommandArgs,
  extractProxyExportArgs,
  listMatchingRelays,
  type ProxyExportEntry,
  type ProxyExportFailure,
  type ProxyExportPlanSuccess,
  type ProxyExportProtocol,
  type ProxyExportResolvedInput,
  type ProxyExportRouteDescriptor,
  type ProxyExportSelector,
  type ProxyExportWriteMode,
  parseProxyExportSelectors,
  parseRelayOwnerFilter,
  parseRelayRunModeFilter,
  planProxyExportRelayTargets,
  type RelayOwnerFilter,
  type RelayRunModeFilter,
  renderExposureReport,
  renderHostsReport,
  renderPathReport,
  renderProxyExportPreview,
  renderProxyExportSelectorLabel,
  renderProxyExportSuccess,
  renderRegionGroupsReport,
  resolveProxyExportSelectorsWithCatalog,
  updateExposureConfig,
  validateSavedConfig,
};

export type ExposureCommandOptions = {
  readonly mode?: string;
  readonly accessMode?: string;
  readonly unsafePublicEmptyPassword?: boolean;
  readonly baseDomain?: string;
  readonly clearBaseDomain?: boolean;
  readonly routeBindIp?: string[];
};

export type ProxyExportCommandOptions = {
  readonly protocol?: string;
  readonly output?: string;
  readonly guided?: boolean;
  readonly regions?: boolean;
  readonly dryRun?: boolean;
  readonly stdout?: boolean;
  readonly force?: boolean;
  readonly country?: string[];
  readonly region?: string[];
  readonly city?: string[];
  readonly server?: string[];
  readonly provider?: string[];
  readonly owner?: string[];
  readonly runMode?: string[];
  readonly minPortSpeed?: string[];
};

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Inspect saved config values, raw paths, and advanced config fields.');

  registerPathCommand(config);
  registerConfigShowCommand(config);
  registerConfigGetCommand(config);
  registerConfigSetCommand(config);
}

export function registerPathCommand(target: Command): void {
  target
    .command('path')
    .description('Show the resolved Mullgate config, state, cache, and runtime paths.')
    .action(async () => {
      const store = new ConfigStore();
      const report = await store.inspectPaths();
      writeCliReport({ sink: process.stdout, text: renderPathReport(report) });
    });
}

function registerConfigShowCommand(target: Command): void {
  target
    .command('show')
    .description('Show the saved Mullgate config as JSON.')
    .action(async () => {
      const store = new ConfigStore();
      const result = await store.load();

      if (!result.ok) {
        writeCliReport({ sink: process.stderr, text: renderLoadError(result), tone: 'error' });
        process.exitCode = 1;
        return;
      }

      if (result.source === 'empty') {
        writeCliReport({ sink: process.stdout, text: result.message });
        return;
      }

      writeCliRaw({
        sink: process.stdout,
        text: `${formatRedactedConfig(result.config)}\n`,
      });
    });
}

export function registerLocationsCommand(
  target: Command,
  options: {
    readonly commandName?: string;
    readonly description?: string;
  } = {},
): void {
  target
    .command(options.commandName ?? 'locations')
    .description(
      options.description ??
        'List routed location aliases, bind IPs, relay preferences, and runtime ids.',
    )
    .action(async () => {
      const store = new ConfigStore();
      const result = await store.load();

      if (!result.ok) {
        writeCliReport({ sink: process.stderr, text: renderLoadError(result), tone: 'error' });
        process.exitCode = 1;
        return;
      }

      if (result.source === 'empty') {
        writeCliReport({ sink: process.stdout, text: result.message });
        return;
      }

      writeCliReport({
        sink: process.stdout,
        text: renderLocationsReport(result.config, store.paths.configFile),
      });
    });
}

export function registerExportCommand(target: Command): void {
  target
    .command('export')
    .option('--protocol <protocol>', 'Export proxy URLs for socks5, http, or https.')
    .option(
      '--country <code-or-name>',
      'Add a country selector. Pair it with optional --city, --server, --provider, and a following --count.',
    )
    .option(
      '--region <name>',
      `Add a curated region selector (${listRegionGroupNames().join(', ')}). Pair it with optional --provider and a following --count.`,
    )
    .option(
      '--city <code-or-name>',
      'Refine the immediately preceding --country selector to one city.',
    )
    .option(
      '--server <hostname>',
      'Refine the immediately preceding --country selector to one exact Mullvad relay hostname.',
    )
    .option(
      '--provider <name>',
      'Filter the immediately preceding --country or --region selector by provider. Repeat as needed.',
    )
    .option(
      '--owner <owner>',
      'Filter the immediately preceding selector by relay ownership: mullvad, rented, or all.',
    )
    .option(
      '--run-mode <mode>',
      'Filter the immediately preceding selector by relay run mode: ram, disk, or all.',
    )
    .option(
      '--min-port-speed <mbps>',
      'Filter the immediately preceding selector by minimum advertised port speed in Mbps.',
    )
    .option(
      '--count <number>',
      'Apply a per-selector export cap to the immediately preceding --country or --region batch.',
    )
    .option('--guided', 'Launch a guided flow for creating proxy lists.')
    .option('--regions', 'Print the curated export region groups and exit without exporting.')
    .option('--dry-run', 'Preview the export without writing a file.')
    .option('--stdout', 'Write the exported proxy URLs to stdout instead of a file.')
    .option('--force', 'Overwrite an existing output file.')
    .option('--output <path>', 'Write the export to this path instead of using an auto filename.')
    .description(
      'Export proxy URLs to a text file with ordered country or region batches plus optional city, server, provider, ownership, run-mode, and port-speed filters.',
    )
    .action(async (options: ProxyExportCommandOptions) => {
      if (options.regions) {
        writeCliReport({ sink: process.stdout, text: renderRegionGroupsReport() });
        return;
      }

      const store = new ConfigStore();
      const result = await store.load();

      if (!result.ok) {
        writeCliReport({
          sink: process.stderr,
          text: renderProxyExportError({
            ok: false,
            phase: result.phase,
            source: result.source,
            message: result.message,
            artifactPath: result.artifactPath,
          }),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      if (result.source === 'empty') {
        writeCliReport({
          sink: process.stderr,
          text: renderProxyExportError({
            ok: false,
            phase: 'load-config',
            source: 'empty',
            message: result.message,
            configPath: store.paths.configFile,
          }),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      try {
        const selectorResult = parseProxyExportSelectors(extractProxyExportArgs(process.argv));

        if (!selectorResult.ok) {
          writeCliReport({
            sink: process.stderr,
            text: renderProxyExportError({
              ...selectorResult,
              configPath: store.paths.configFile,
            }),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        const relayCatalogResult = await loadRelayCatalogForProxyExport({ store });

        if (!relayCatalogResult.ok) {
          writeCliReport({
            sink: process.stderr,
            text: renderProxyExportError(relayCatalogResult),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        const resolvedInput = await resolveProxyExportInput({
          options,
          config: result.config,
          selectors: selectorResult.selectors,
          relayCatalog: relayCatalogResult.relayCatalog,
          configPath: store.paths.configFile,
        });

        if (!resolvedInput.ok) {
          writeCliReport({
            sink: process.stderr,
            text: renderProxyExportError(resolvedInput),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        const exportInput = resolvedInput.value;
        const ensuredRoutes = await ensureProxyExportRoutes({
          store,
          config: result.config,
          relayCatalog: relayCatalogResult.relayCatalog,
          exportInput,
        });

        if (!ensuredRoutes.ok) {
          writeCliReport({
            sink: process.stderr,
            text: renderProxyExportError(ensuredRoutes),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        const exportPlan = buildProxyExportPlan({
          config: ensuredRoutes.config,
          protocol: exportInput.protocol,
          selectors: exportInput.selectors,
          relayCatalog: ensuredRoutes.relayCatalog,
          configPath: store.paths.configFile,
        });

        if (!exportPlan.ok) {
          writeCliReport({
            sink: process.stderr,
            text: renderProxyExportError(exportPlan),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        const deliveryResult = await deliverProxyExport({
          result: exportPlan,
          input: exportInput,
          configPath: store.paths.configFile,
          guided: Boolean(options.guided),
        });

        if (!deliveryResult.ok) {
          writeCliReport({
            sink: process.stderr,
            text: renderProxyExportError(deliveryResult),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }
      } catch (error) {
        writeCliReport({
          sink: process.stderr,
          text: renderProxyExportError({
            ok: false,
            phase: 'export-proxies',
            source: 'input',
            message: error instanceof Error ? error.message : String(error),
            configPath: store.paths.configFile,
          }),
          tone: 'error',
        });
        process.exitCode = 1;
      }
    });
}

function registerConfigGetCommand(target: Command): void {
  target
    .command('get')
    .argument('<keyPath>', 'Dot-separated key path within the saved config.')
    .description('Read one saved config value.')
    .action(async (keyPath: string) => {
      const store = new ConfigStore();
      const result = await store.load();

      if (!result.ok) {
        writeCliReport({ sink: process.stderr, text: renderLoadError(result), tone: 'error' });
        process.exitCode = 1;
        return;
      }

      if (result.source === 'empty') {
        writeCliReport({
          sink: process.stderr,
          text: renderMissingConfig(result.message, store.paths.configFile),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      const resolved = getConfigValue(result.config, keyPath);

      if (!resolved.found) {
        writeCliReport({
          sink: process.stderr,
          text: renderConfigPathError('Config key was not found.', keyPath),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      writeCliRaw({ sink: process.stdout, text: `${formatOutputValue(resolved.value)}\n` });
    });
}

function registerConfigSetCommand(target: Command): void {
  target
    .command('set')
    .argument('<keyPath>', 'Editable config key path.')
    .argument('[value]', 'Replacement value. Use --stdin for secrets or complex JSON.')
    .option('--stdin', 'Read the replacement value from standard input.')
    .option('--json', 'Parse the provided value as JSON before saving.')
    .description('Update a saved config value without editing JSON by hand.')
    .action(
      async (
        keyPath: string,
        value: string | undefined,
        options: { stdin?: boolean; json?: boolean },
      ) => {
        const store = new ConfigStore();
        const spec = EDITABLE_CONFIG_FIELDS.get(keyPath);

        if (!spec) {
          writeCliReport({
            sink: process.stderr,
            text: renderConfigPathError(
              'Only a safe subset of config fields is editable. Use `mullgate config show` to inspect the saved schema.',
              keyPath,
            ),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        if (options.stdin && value !== undefined) {
          writeCliReport({
            sink: process.stderr,
            text: renderConfigPathError('Pass a value or --stdin, not both.', keyPath),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        const rawValue = options.stdin ? await readStdinValue() : value;

        if (rawValue === undefined) {
          writeCliReport({
            sink: process.stderr,
            text: renderConfigPathError('A replacement value is required.', keyPath),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        const loadResult = await store.load();

        if (!loadResult.ok) {
          writeCliReport({
            sink: process.stderr,
            text: renderLoadError(loadResult),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        if (loadResult.source === 'empty') {
          writeCliReport({
            sink: process.stderr,
            text: renderMissingConfig(loadResult.message, store.paths.configFile),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        const updatedConfig = structuredClone(loadResult.config);

        try {
          const parsedValue = spec.parse(rawValue, { json: Boolean(options.json) });
          setConfigValue(updatedConfig, keyPath, parsedValue);
          applyPostSetNormalization(updatedConfig, keyPath);
        } catch (error) {
          writeCliReport({
            sink: process.stderr,
            text: renderConfigPathError(
              error instanceof Error ? error.message : String(error),
              keyPath,
            ),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        const canonicalConfig = normalizeMullgateConfig(updatedConfig);
        const staleConfig = withRuntimeStatus(
          canonicalConfig,
          'unvalidated',
          null,
          `Config changed at ${keyPath}; rerun \`mullgate proxy validate\` to refresh derived artifacts.`,
        );

        try {
          await store.save(staleConfig);
        } catch (error) {
          writeCliReport({
            sink: process.stderr,
            text: renderValidationError({
              ok: false,
              phase: 'persist-config',
              source: 'filesystem',
              message: 'Failed to persist the updated canonical config.',
              artifactPath: store.paths.configFile,
              cause: error instanceof Error ? error.message : String(error),
            }),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        writeCliReport({
          sink: process.stdout,
          text: [
            'Mullgate config updated.',
            'phase: persist-config',
            'source: input',
            `key: ${keyPath}`,
            `config: ${store.paths.configFile}`,
            spec.secret
              ? 'value: stored without echoing it back to the terminal'
              : 'value: updated',
            'runtime status: unvalidated',
          ].join('\n'),
          tone: 'success',
        });
      },
    );
}

export function registerValidateCommand(target: Command): void {
  target
    .command('validate')
    .option(
      '--refresh',
      'Re-render derived artifacts from saved config and relay cache before validating.',
    )
    .description(
      'Validate the saved or freshly rendered shared runtime artifacts and persist the result metadata.',
    )
    .action(async (options: { refresh?: boolean }) => {
      const store = new ConfigStore();
      const result = await validateSavedConfig({ store, refresh: Boolean(options.refresh) });

      if (!result.ok) {
        writeCliReport({
          sink: process.stderr,
          text: renderValidationError(result),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      writeCliReport({
        sink: process.stdout,
        text: renderValidationSuccess(result),
        tone: 'success',
      });
    });
}

async function resolveProxyExportInput(input: {
  readonly options: ProxyExportCommandOptions;
  readonly config: MullgateConfig;
  readonly selectors: readonly ProxyExportSelector[];
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
}): Promise<{ readonly ok: true; readonly value: ProxyExportResolvedInput } | ProxyExportFailure> {
  const outputPath = readOptionalString(input.options.output);
  const initialProtocol = readOptionalString(input.options.protocol);
  const modeResult = resolveProxyExportWriteMode({
    dryRun: Boolean(input.options.dryRun),
    stdout: Boolean(input.options.stdout),
    force: Boolean(input.options.force),
    hasOutputPath: Boolean(outputPath),
    configPath: input.configPath,
  });

  if (!modeResult.ok) {
    return modeResult;
  }

  if (!input.options.guided) {
    const resolvedSelectors = resolveProxyExportSelectorsWithCatalog({
      config: input.config,
      selectors: input.selectors,
      relayCatalog: input.relayCatalog,
      configPath: input.configPath,
    });

    if (!resolvedSelectors.ok) {
      return resolvedSelectors;
    }

    return {
      ok: true,
      value: {
        protocol: parseProxyExportProtocol(initialProtocol),
        selectors: resolvedSelectors.selectors,
        writeMode: modeResult.writeMode,
        ...(outputPath ? { outputPath } : {}),
        force: Boolean(input.options.force),
      },
    };
  }

  const guidedInput = await collectGuidedProxyExportInput({
    ...(initialProtocol ? { initialProtocol: parseProxyExportProtocol(initialProtocol) } : {}),
    initialSelectors: input.selectors,
    initialWriteMode: modeResult.writeMode,
    initialOutputPath: outputPath,
    force: Boolean(input.options.force),
    configPath: input.configPath,
    relayCatalog: input.relayCatalog,
  });

  if (!guidedInput.ok) {
    return guidedInput;
  }

  return {
    ok: true,
    value: guidedInput.value,
  };
}

async function deliverProxyExport(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly input: ProxyExportResolvedInput;
  readonly configPath: string;
  readonly guided: boolean;
}): Promise<{ readonly ok: true } | ProxyExportFailure> {
  if (input.input.writeMode === 'stdout') {
    writeCliRaw({ sink: process.stdout, text: input.result.outputText });
    writeCliReport({
      sink: process.stderr,
      text: renderProxyExportStdoutNotice({
        result: input.result,
        configPath: input.configPath,
      }),
    });
    return { ok: true };
  }

  const defaultOutputPath = input.input.outputPath ?? `./${input.result.suggestedFilename}`;

  if (input.input.writeMode === 'dry-run') {
    writeCliReport({
      sink: process.stdout,
      text: renderProxyExportPreview({
        result: input.result,
        configPath: input.configPath,
        outputPath: defaultOutputPath,
      }),
    });
    return { ok: true };
  }

  const resolvedOutput = await resolveProxyExportOutputPath({
    outputPath: input.input.outputPath ?? `./${input.result.suggestedFilename}`,
    force: input.input.force,
    guided: input.guided,
    configPath: input.configPath,
  });

  if (!resolvedOutput.ok) {
    return resolvedOutput;
  }

  try {
    await mkdir(path.dirname(resolvedOutput.absolutePath), { recursive: true });
    await writeFile(resolvedOutput.absolutePath, input.result.outputText, 'utf8');
  } catch (error) {
    return {
      ok: false,
      phase: 'persist-file',
      source: 'filesystem',
      message: 'Failed to write the proxy export file.',
      configPath: input.configPath,
      artifactPath: resolvedOutput.absolutePath,
      cause: error instanceof Error ? error.message : String(error),
    };
  }

  writeCliReport({
    sink: process.stdout,
    text: renderProxyExportSuccess({
      result: input.result,
      configPath: input.configPath,
      outputPath: resolvedOutput.displayPath,
    }),
    tone: 'success',
  });
  return { ok: true };
}

function resolveProxyExportWriteMode(input: {
  readonly dryRun: boolean;
  readonly stdout: boolean;
  readonly force: boolean;
  readonly hasOutputPath: boolean;
  readonly configPath: string;
}): { readonly ok: true; readonly writeMode: ProxyExportWriteMode } | ProxyExportFailure {
  if (input.stdout && input.dryRun) {
    return {
      ok: false,
      phase: 'export-proxies',
      source: 'input',
      message: 'Pass --stdout or --dry-run, not both.',
      configPath: input.configPath,
    };
  }

  if (input.stdout && input.hasOutputPath) {
    return {
      ok: false,
      phase: 'export-proxies',
      source: 'input',
      message: 'Pass --stdout or --output, not both.',
      configPath: input.configPath,
    };
  }

  if (input.stdout && input.force) {
    return {
      ok: false,
      phase: 'export-proxies',
      source: 'input',
      message: '--force only applies when writing a file.',
      configPath: input.configPath,
    };
  }

  if (input.dryRun && input.force) {
    return {
      ok: false,
      phase: 'export-proxies',
      source: 'input',
      message: '--force only applies when writing a file.',
      configPath: input.configPath,
    };
  }

  if (input.stdout) {
    return {
      ok: true,
      writeMode: 'stdout',
    };
  }

  if (input.dryRun) {
    return {
      ok: true,
      writeMode: 'dry-run',
    };
  }

  return {
    ok: true,
    writeMode: 'file',
  };
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

export function renderLoadConfigError(result: Extract<LoadConfigResult, { ok: false }>): string {
  return renderLoadError(result);
}

function renderMissingConfig(message: string, configPath: string): string {
  return [
    'Mullgate config command could not continue.',
    'phase: load-config',
    'source: empty',
    `artifact: ${configPath}`,
    `reason: ${message}`,
  ].join('\n');
}

export function renderMissingConfigError(message: string, configPath: string): string {
  return renderMissingConfig(message, configPath);
}

function renderConfigPathError(message: string, keyPath: string): string {
  return [
    'Mullgate config path error.',
    'phase: config-path',
    'source: input',
    `key: ${keyPath}`,
    `reason: ${message}`,
  ].join('\n');
}

function parseProxyExportProtocol(raw: string | undefined): ProxyExportProtocol {
  const normalized = raw?.trim().toLowerCase() ?? 'socks5';

  if (normalized === 'socks5' || normalized === 'http' || normalized === 'https') {
    return normalized;
  }

  throw new Error(`Protocol ${formatRawInput(raw ?? '')} must be one of socks5, http, or https.`);
}

export function createAuthenticatedEndpointUrl(
  config: Pick<MullgateConfig, 'setup'>,
  url: string,
): string {
  const separatorIndex = url.indexOf('://');

  if (separatorIndex === -1) {
    return url;
  }

  const protocol = url.slice(0, separatorIndex);
  const authorityAndPath = url.slice(separatorIndex + 3);

  return `${protocol}://${encodeURIComponent(config.setup.auth.username)}:${encodeURIComponent(config.setup.auth.password)}@${authorityAndPath}`;
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
