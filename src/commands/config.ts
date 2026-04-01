import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  autocomplete,
  autocompleteMultiselect,
  cancel as clackCancel,
  confirm,
  intro,
  isCancel,
  outro,
  select,
  text,
} from '@clack/prompts';
import type { Command } from 'commander';
import {
  defaultDeviceName,
  loadStoredRelayCatalog,
  type PlannedSetupRoute,
  planSetupRoutes,
  summarizeValidationSource,
  verifyHttpsAssets,
  withRuntimeStatus,
} from '../app/setup-runner.js';
import { writeCliRaw, writeCliReport } from '../cli-output.js';
import {
  buildExposureContract,
  computePublishedPort,
  deriveExposureHostname,
  deriveRuntimeListenerHost,
  type ExposureValidationFailure,
  normalizeExposureBaseDomain,
  validateExposureSettings,
} from '../config/exposure-contract.js';
import { formatRedactedConfig } from '../config/redact.js';
import type { ExposureMode, MullgateConfig } from '../config/schema.js';
import { ConfigStore, type LoadConfigResult, normalizeMullgateConfig } from '../config/store.js';
import { createLocationAliasCatalog, normalizeLocationToken } from '../domain/location-aliases.js';
import {
  listRegionGroupNames,
  listRegionGroups,
  resolveRegionCountryCodes,
} from '../domain/region-groups.js';
import {
  fetchRelays,
  type MullvadRelay,
  type MullvadRelayCatalog,
} from '../mullvad/fetch-relays.js';
import { buildPlatformSupportContract } from '../platform/support-contract.js';
import { requireArrayValue, requireDefined } from '../required.js';
import {
  ENTRY_WIREPROXY_SOCKS_PORT,
  renderRuntimeProxyArtifacts,
} from '../runtime/render-runtime-proxies.js';
import { validateRuntimeArtifacts } from '../runtime/validate-runtime.js';

const DEFAULT_HTTPS_PORT = 8443;
const EDITABLE_CONFIG_FIELDS = new Map<string, EditableFieldSpec>([
  ['setup.bind.host', { parse: parseRequiredString }],
  ['setup.bind.socksPort', { parse: parsePort }],
  ['setup.bind.httpPort', { parse: parsePort }],
  ['setup.bind.httpsPort', { parse: parseNullablePort }],
  ['setup.auth.username', { parse: parseRequiredString }],
  ['setup.auth.password', { parse: parseRequiredString, secret: true }],
  ['setup.location.requested', { parse: parseRequiredString }],
  ['setup.location.country', { parse: parseNullableString }],
  ['setup.location.city', { parse: parseNullableString }],
  ['setup.location.hostnameLabel', { parse: parseNullableString }],
  ['setup.location.resolvedAlias', { parse: parseNullableString }],
  ['setup.https.enabled', { parse: parseBoolean }],
  ['setup.https.certPath', { parse: parseNullableString }],
  ['setup.https.keyPath', { parse: parseNullableString }],
  ['mullvad.deviceName', { parse: parseRequiredString }],
  ['mullvad.relayConstraints.ownership', { parse: parseNullableString }],
  ['mullvad.relayConstraints.providers', { parse: parseStringArray }],
]);

type EditableFieldSpec = {
  readonly parse: (raw: string, options: { json: boolean }) => unknown;
  readonly secret?: boolean;
};

type ConfigValidationSuccess = {
  readonly ok: true;
  readonly phase: 'validation';
  readonly source: 'validation-suite';
  readonly refreshedArtifacts: boolean;
  readonly config: MullgateConfig;
  readonly artifactPath: string;
  readonly reportPath: string;
  readonly message: string;
};

type ConfigValidationFailure = {
  readonly ok: false;
  readonly phase:
    | 'load-config'
    | 'read-config'
    | 'parse-config'
    | 'https-assets'
    | 'relay-normalize'
    | 'artifact-render'
    | 'validation'
    | 'persist-config';
  readonly source: string;
  readonly message: string;
  readonly artifactPath?: string;
  readonly cause?: string;
};

type ConfigValidationResult = ConfigValidationSuccess | ConfigValidationFailure;

type ExposureUpdateInput = {
  readonly mode?: ExposureMode;
  readonly baseDomain?: string | null;
  readonly baseDomainSpecified: boolean;
  readonly routeBindIps?: readonly string[];
};

type ExposureUpdateSuccess = {
  readonly ok: true;
  readonly config: MullgateConfig;
};

type ExposureUpdateFailure = ExposureValidationFailure;

type ExposureUpdateResult = ExposureUpdateSuccess | ExposureUpdateFailure;

export type ExposureCommandOptions = {
  readonly mode?: string;
  readonly baseDomain?: string;
  readonly clearBaseDomain?: boolean;
  readonly routeBindIp?: string[];
};

const LEGACY_RELAYS_URL = 'https://api.mullvad.net/www/relays/all/';

export type ProxyExportProtocol = 'socks5' | 'http' | 'https';
export type RelayOwnerFilter = 'mullvad' | 'rented' | 'all';
export type RelayRunModeFilter = 'ram' | 'disk' | 'all';

export type ProxyExportSelector = {
  readonly kind: 'country' | 'region';
  readonly value: string;
  readonly city?: string;
  readonly server?: string;
  readonly providers: readonly string[];
  readonly owner: RelayOwnerFilter;
  readonly runMode: RelayRunModeFilter;
  readonly minPortSpeed: number | null;
  readonly requestedCount: number | null;
};

type ProxyExportSelectorResult = ProxyExportSelector & {
  readonly matchedCount: number;
  readonly exportedCount: number;
};

export type ProxyExportEntry = {
  readonly routeIndex: number;
  readonly alias: string;
  readonly hostname: string;
  readonly countryCode: string | null;
  readonly cityCode: string | null;
  readonly relayHostname: string | null;
  readonly provider: string | null;
  readonly owner: RelayOwnerFilter | null;
  readonly runMode: Exclude<RelayRunModeFilter, 'all'> | null;
  readonly portSpeed: number | null;
  readonly url: string;
};

export type ProxyExportRouteDescriptor = {
  readonly routeIndex: number;
  readonly routeId: string;
  readonly routeAlias: string;
  readonly routeHostname: string;
  readonly countryCode: string | null;
  readonly cityCode: string | null;
  readonly relayHostname: string | null;
  readonly provider: string | null;
  readonly owner: RelayOwnerFilter | null;
  readonly runMode: Exclude<RelayRunModeFilter, 'all'> | null;
  readonly portSpeed: number | null;
};

export type ProxyExportPlanSuccess = {
  readonly ok: true;
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelectorResult[];
  readonly entries: readonly ProxyExportEntry[];
  readonly outputText: string;
  readonly suggestedFilename: string;
};

export type ProxyExportFailure = {
  readonly ok: false;
  readonly phase: string;
  readonly source: string;
  readonly message: string;
  readonly configPath?: string;
  readonly artifactPath?: string;
  readonly cause?: string;
};

type ProxyExportPlanResult = ProxyExportPlanSuccess | ProxyExportFailure;

export type ProxyExportWriteMode = 'file' | 'stdout' | 'dry-run';

export type ProxyExportResolvedInput = {
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelector[];
  readonly writeMode: ProxyExportWriteMode;
  readonly outputPath?: string;
  readonly force: boolean;
};

type ProxyExportSelectorParseResult =
  | {
      readonly ok: true;
      readonly selectors: readonly ProxyExportSelector[];
    }
  | ProxyExportFailure;

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

const GUIDED_PROMPT_CANCELLED = Symbol('guided-prompt-cancelled');
const _PROVISIONING_URL_ENV = 'MULLGATE_MULLVAD_WG_URL';
const RELAYS_URL_ENV = 'MULLGATE_MULLVAD_RELAYS_URL';

type PromptTextOptions = {
  readonly message: string;
  readonly initialValue?: string;
  readonly placeholder?: string;
  readonly validate?: (value: string | undefined) => string | undefined;
};

type PromptSelectOption = {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
};

type PromptSelectOptions = {
  readonly message: string;
  readonly options: readonly PromptSelectOption[];
  readonly initialValue?: string;
  readonly placeholder?: string;
};

type PromptMultiSelectOptions = {
  readonly message: string;
  readonly options: readonly PromptSelectOption[];
  readonly initialValues?: readonly string[];
  readonly required?: boolean;
  readonly placeholder?: string;
};

type PromptConfirmOptions = {
  readonly message: string;
  readonly initialValue?: boolean;
  readonly active?: string;
  readonly inactive?: string;
};

function describePromptStep(title: string, detail: string): string {
  return `${title}\n${detail}`;
}

type GuidedProxyExportSelectorSeed = {
  readonly kind: ProxyExportSelector['kind'];
  readonly value: string;
};

type GuidedPromptClient = {
  readonly intro: (message: string) => void;
  readonly outro: (message: string) => void;
  readonly cancel: (message: string) => void;
  readonly text: (options: PromptTextOptions) => Promise<string | typeof GUIDED_PROMPT_CANCELLED>;
  readonly select: (
    options: PromptSelectOptions,
  ) => Promise<string | typeof GUIDED_PROMPT_CANCELLED>;
  readonly multiselect: (
    options: PromptMultiSelectOptions,
  ) => Promise<readonly string[] | typeof GUIDED_PROMPT_CANCELLED>;
  readonly confirm: (
    options: PromptConfirmOptions,
  ) => Promise<boolean | typeof GUIDED_PROMPT_CANCELLED>;
  readonly close: () => Promise<void>;
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

export function registerHostsCommand(target: Command): void {
  target
    .command('hosts')
    .description('List configured proxy hostnames and their route bind-IP mappings.')
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
        text: renderHostsReport(result.config, store.paths.configFile),
      });
    });
}

export function registerRegionsCommand(target: Command): void {
  target
    .command('regions')
    .description('List the curated export region groups and their member country codes.')
    .action(() => {
      writeCliReport({ sink: process.stdout, text: renderRegionGroupsReport() });
    });
}

export function registerExposureCommand(target: Command): void {
  target
    .command('exposure')
    .option('--mode <mode>', 'Set exposure mode to loopback, private-network, or public.')
    .option('--base-domain <domain>', 'Set the base domain used to derive per-route hostnames.')
    .option(
      '--clear-base-domain',
      'Remove any configured base domain and fall back to alias/direct-IP hostnames.',
    )
    .option(
      '--route-bind-ip <ip>',
      'Set the shared private-network host IP, or repeat once per route for public exposure.',
      collectRepeatedValues,
      [],
    )
    .description(
      'Inspect or update how Mullgate publishes route hostnames, bind IPs, and restart guidance.',
    )
    .action(async (options: ExposureCommandOptions) => {
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

      if (!hasExposureUpdate(options)) {
        writeCliReport({
          sink: process.stdout,
          text: renderExposureReport(result.config, store.paths.configFile),
        });
        return;
      }

      if (options.baseDomain !== undefined && options.clearBaseDomain) {
        writeCliReport({
          sink: process.stderr,
          text: renderExposureUpdateError({
            ok: false,
            phase: 'setup-validation',
            source: 'input',
            code: 'AMBIGUOUS_BASE_DOMAIN',
            message: 'Pass --base-domain or --clear-base-domain, not both.',
            artifactPath: store.paths.configFile,
          }),
          tone: 'error',
        });
        process.exitCode = 1;
        return;
      }

      let mode: ExposureMode | undefined;

      if (options.mode !== undefined) {
        try {
          mode = parseExposureModeOption(options.mode);
        } catch (error) {
          writeCliReport({
            sink: process.stderr,
            text: renderExposureUpdateError({
              ok: false,
              phase: 'setup-validation',
              source: 'input',
              code: 'INVALID_EXPOSURE_MODE',
              message: error instanceof Error ? error.message : String(error),
              artifactPath: store.paths.configFile,
            }),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }
      }

      const updateResult = updateExposureConfig(result.config, store.paths.configFile, {
        ...(mode ? { mode } : {}),
        ...(options.baseDomain !== undefined ? { baseDomain: options.baseDomain } : {}),
        baseDomainSpecified: Boolean(options.clearBaseDomain || options.baseDomain !== undefined),
        ...(options.clearBaseDomain ? { baseDomain: null } : {}),
        ...(options.routeBindIp && options.routeBindIp.length > 0
          ? { routeBindIps: options.routeBindIp }
          : {}),
      });

      if (!updateResult.ok) {
        writeCliReport({
          sink: process.stderr,
          text: renderExposureUpdateError(updateResult),
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
          text: renderValidationError({
            ok: false,
            phase: 'persist-config',
            source: 'filesystem',
            message: 'Failed to persist the updated exposure contract.',
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
        text: renderExposureUpdateSuccess(updateResult.config, store.paths.configFile),
        tone: 'success',
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

export function renderPathReport(report: Awaited<ReturnType<ConfigStore['inspectPaths']>>): string {
  const { paths, exists } = report;
  const platform = buildPlatformSupportContract({ paths: report.paths });

  return [
    'Mullgate path report',
    `phase: ${report.phase}`,
    `source: ${report.source}`,
    `platform: ${report.platform}`,
    `platform source: ${report.platformSource}`,
    `platform support: ${platform.posture.supportLevel}`,
    `platform mode: ${platform.posture.modeLabel}`,
    `platform summary: ${platform.posture.summary}`,
    `runtime story: ${platform.posture.runtimeStory}`,
    `host networking: ${platform.hostNetworking.modeLabel}`,
    `host networking summary: ${platform.hostNetworking.summary}`,
    `config home: ${paths.configHome} (${report.pathSources.configHome})`,
    `state home: ${paths.stateHome} (${report.pathSources.stateHome})`,
    `cache home: ${paths.cacheHome} (${report.pathSources.cacheHome})`,
    `config file: ${paths.configFile} (${exists.configFile ? 'present' : 'missing'})`,
    `state dir: ${paths.appStateDir}`,
    `cache dir: ${paths.appCacheDir}`,
    `runtime dir: ${paths.runtimeDir} (${exists.runtimeDir ? 'present' : 'missing'})`,
    `entry wireproxy config: ${paths.entryWireproxyConfigFile}`,
    `route proxy config: ${paths.routeProxyConfigFile}`,
    `runtime validation report: ${paths.runtimeValidationReportFile}`,
    `docker compose: ${paths.dockerComposePath}`,
    `relay cache: ${paths.provisioningCacheFile} (${exists.relayCacheFile ? 'present' : 'missing'})`,
    '',
    'platform guidance',
    ...platform.guidance.map((line) => `- ${line}`),
    '',
    'platform warnings',
    ...(platform.warnings.length > 0
      ? platform.warnings.map((warning) => `- ${warning.severity}: ${warning.message}`)
      : ['- none']),
  ].join('\n');
}

export function renderLocationsReport(config: MullgateConfig, configPath: string): string {
  return [
    'Mullgate routed locations',
    'phase: inspect-config',
    'source: canonical-config',
    `config: ${configPath}`,
    `routes: ${config.routing.locations.length}`,
    ...config.routing.locations.flatMap((location, index) => [
      '',
      `${index + 1}. ${location.alias}`,
      `   hostname: ${location.hostname}`,
      `   bind ip: ${location.bindIp}`,
      `   requested: ${location.relayPreference.requested}`,
      `   resolved alias: ${location.relayPreference.resolvedAlias ?? 'n/a'}`,
      `   country: ${location.relayPreference.country ?? 'n/a'}`,
      `   city: ${location.relayPreference.city ?? 'n/a'}`,
      `   exit relay: ${location.mullvad.exit.relayHostname}`,
      `   exit socks: ${location.mullvad.exit.socksHostname}:${location.mullvad.exit.socksPort}`,
      `   route id: ${location.runtime.routeId}`,
      `   https backend: ${location.runtime.httpsBackendName}`,
    ]),
  ].join('\n');
}

export function renderHostsReport(config: MullgateConfig, configPath: string): string {
  return [
    'Mullgate routed hosts',
    'phase: inspect-config',
    'source: canonical-config',
    `config: ${configPath}`,
    `routes: ${config.routing.locations.length}`,
    'hostname -> bind ip',
    ...config.routing.locations.map(
      (location, index) =>
        `${index + 1}. ${location.hostname} -> ${location.bindIp} (alias: ${location.alias}, route id: ${location.runtime.routeId})`,
    ),
    '',
    'copy/paste hosts block',
    ...renderHostsBlock(config),
  ].join('\n');
}

export function renderExposureReport(config: MullgateConfig, configPath: string): string {
  const exposure = buildExposureContract(config);

  return [
    'Mullgate exposure report',
    'phase: inspect-config',
    'source: canonical-config',
    `config: ${configPath}`,
    `mode: ${exposure.mode}`,
    `mode label: ${exposure.posture.modeLabel}`,
    `recommendation: ${exposure.posture.recommendation}`,
    `posture summary: ${exposure.posture.summary}`,
    `remote story: ${exposure.posture.remoteStory}`,
    `base domain: ${exposure.baseDomain ?? 'n/a'}`,
    `allow lan: ${exposure.allowLan ? 'yes' : 'no'}`,
    `runtime status: ${exposure.runtimeStatus.phase}`,
    `restart needed: ${exposure.runtimeStatus.restartRequired ? 'yes' : 'no'}`,
    ...(exposure.runtimeStatus.message
      ? [`runtime message: ${exposure.runtimeStatus.message}`]
      : []),
    '',
    'guidance',
    ...exposure.guidance.map((line) => `- ${line}`),
    '',
    'remediation',
    `- bind posture: ${exposure.remediation.bindPosture}`,
    `- hostname resolution: ${exposure.remediation.hostnameResolution}`,
    `- restart: ${exposure.remediation.restart}`,
    '',
    'routes',
    ...exposure.routes.flatMap((route) => [
      `${route.index + 1}. ${route.hostname} -> ${route.bindIp}`,
      `   alias: ${route.alias}`,
      `   route id: ${route.routeId}`,
      `   dns: ${route.dnsRecord ?? 'not required; use direct bind IP entrypoints'}`,
      ...route.endpoints.flatMap((endpoint) => [
        `   ${endpoint.protocol} hostname: ${endpoint.redactedHostnameUrl}`,
        `   ${endpoint.protocol} direct ip: ${endpoint.redactedBindUrl}`,
      ]),
    ]),
    '',
    'warnings',
    ...(exposure.warnings.length > 0
      ? exposure.warnings.map((warning) => `- ${warning.severity}: ${warning.message}`)
      : ['- none']),
    '',
    'local host-file mapping',
    '- `mullgate proxy access` remains the copy/paste /etc/hosts view for local-only testing.',
  ].join('\n');
}

export function updateExposureConfig(
  config: MullgateConfig,
  artifactPath: string,
  input: ExposureUpdateInput,
): ExposureUpdateResult {
  const nextMode = input.mode ?? config.setup.exposure.mode;
  const nextBaseDomain = input.baseDomainSpecified
    ? (input.baseDomain ?? null)
    : config.setup.exposure.baseDomain;
  const existingBindIps = config.routing.locations.map((location) => location.bindIp);
  const routeBindIps =
    input.routeBindIps ??
    (nextMode === 'loopback'
      ? []
      : nextMode === 'private-network'
        ? [config.setup.bind.host]
        : config.setup.exposure.mode === 'loopback' && input.mode !== undefined
          ? []
          : existingBindIps);
  const validated = validateExposureSettings({
    routeCount: config.routing.locations.length,
    exposureMode: nextMode,
    exposureBaseDomain: normalizeExposureBaseDomain(nextBaseDomain),
    routeBindIps,
    artifactPath,
    caller: 'config-exposure',
  });

  if (!validated.ok) {
    return validated;
  }

  const updatedRoutingLocations = config.routing.locations.map((location, index) => ({
    ...location,
    bindIp: requireArrayValue(
      validated.routeBindIps,
      index,
      `Missing validated bind IP for routed location ${location.alias}.`,
    ),
    hostname: deriveExposureHostname(
      location.alias,
      requireArrayValue(
        validated.routeBindIps,
        index,
        `Missing validated bind IP for routed location ${location.alias}.`,
      ),
      validated.baseDomain,
      validated.mode,
    ),
  }));
  const canonicalConfig = normalizeMullgateConfig({
    ...config,
    setup: {
      ...config.setup,
      bind: {
        ...config.setup.bind,
        host: validated.bindHost,
      },
      exposure: {
        mode: validated.mode,
        allowLan: validated.mode !== 'loopback',
        baseDomain: validated.baseDomain,
      },
    },
    routing: {
      locations: updatedRoutingLocations,
    },
  });

  return {
    ok: true,
    config: withRuntimeStatus(
      canonicalConfig,
      'unvalidated',
      null,
      'Exposure settings changed; rerun `mullgate proxy validate` or `mullgate proxy start` to refresh runtime artifacts.',
    ),
  };
}

function renderExposureUpdateSuccess(config: MullgateConfig, configPath: string): string {
  return [
    'Mullgate exposure updated.',
    'phase: persist-config',
    'source: input',
    `config: ${configPath}`,
    `runtime status: ${config.runtime.status.phase}`,
    `reason: ${config.runtime.status.message ?? 'Exposure settings changed.'}`,
    '',
    renderExposureReport(config, configPath),
  ].join('\n');
}

function renderExposureUpdateError(result: ExposureUpdateFailure): string {
  return [
    'Mullgate exposure update failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    `code: ${result.code}`,
    `artifact: ${result.artifactPath}`,
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
  ].join('\n');
}

function renderHostsBlock(config: MullgateConfig): string[] {
  return config.routing.locations.map((location) => `${location.bindIp} ${location.hostname}`);
}

export function renderRegionGroupsReport(): string {
  const regionGroups = listRegionGroups();

  return [
    'Mullgate region groups',
    'phase: inspect-config',
    'source: canonical-region-groups',
    `regions: ${regionGroups.length}`,
    ...regionGroups.flatMap((region, index) => [
      '',
      `${index + 1}. ${region.name}`,
      `   countries: ${region.countryCodes.join(', ')}`,
      `   example: mullgate proxy export --region ${region.name} --count 5`,
    ]),
  ].join('\n');
}

export function parseProxyExportSelectors(
  tokens: readonly string[],
): ProxyExportSelectorParseResult {
  const selectors: ProxyExportSelector[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token) {
      continue;
    }

    const countryOption = readCliOptionValue({
      flag: '--country',
      token,
      nextToken: tokens[index + 1],
    });

    if (countryOption.matched) {
      selectors.push({
        kind: 'country',
        value: normalizeProxyExportSelectorValue(countryOption.value, 'country'),
        providers: [],
        owner: 'all',
        runMode: 'all',
        minPortSpeed: null,
        requestedCount: null,
      });
      index += countryOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const regionOption = readCliOptionValue({
      flag: '--region',
      token,
      nextToken: tokens[index + 1],
    });

    if (regionOption.matched) {
      selectors.push({
        kind: 'region',
        value: normalizeProxyExportSelectorValue(regionOption.value, 'region'),
        providers: [],
        owner: 'all',
        runMode: 'all',
        minPortSpeed: null,
        requestedCount: null,
      });
      index += regionOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const cityOption = readCliOptionValue({
      flag: '--city',
      token,
      nextToken: tokens[index + 1],
    });

    if (cityOption.matched) {
      const previousSelector = selectors.at(-1);

      if (!previousSelector || previousSelector.kind !== 'country') {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: 'Pass --city after a --country selector.',
        };
      }

      if (previousSelector.city) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: `Selector country=${previousSelector.value} already has a --city.`,
        };
      }

      if (previousSelector.server) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: `Selector country=${previousSelector.value} already has a --server, so --city is redundant.`,
        };
      }

      selectors[selectors.length - 1] = {
        ...previousSelector,
        city: normalizeProxyExportSelectorValue(cityOption.value, 'country'),
      };
      index += cityOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const serverOption = readCliOptionValue({
      flag: '--server',
      token,
      nextToken: tokens[index + 1],
    });

    if (serverOption.matched) {
      const previousSelector = selectors.at(-1);

      if (!previousSelector || previousSelector.kind !== 'country') {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: 'Pass --server after a --country selector.',
        };
      }

      if (previousSelector.server) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: `Selector country=${previousSelector.value} already has a --server.`,
        };
      }

      selectors[selectors.length - 1] = {
        ...previousSelector,
        server: normalizeProxyExportSelectorValue(serverOption.value, 'country'),
      };
      index += serverOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const providerOption = readCliOptionValue({
      flag: '--provider',
      token,
      nextToken: tokens[index + 1],
    });

    if (providerOption.matched) {
      const previousSelector = selectors.at(-1);

      if (!previousSelector) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: 'Pass --provider after a --country or --region selector.',
        };
      }

      selectors[selectors.length - 1] = {
        ...previousSelector,
        providers: [...previousSelector.providers, providerOption.value.trim()],
      };
      index += providerOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const ownerOption = readCliOptionValue({
      flag: '--owner',
      token,
      nextToken: tokens[index + 1],
    });

    if (ownerOption.matched) {
      const previousSelector = selectors.at(-1);

      if (!previousSelector) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: 'Pass --owner after a --country or --region selector.',
        };
      }

      if (previousSelector.owner !== 'all') {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: `Selector ${previousSelector.kind}=${previousSelector.value} already has an --owner filter.`,
        };
      }

      selectors[selectors.length - 1] = {
        ...previousSelector,
        owner: parseRelayOwnerFilter(ownerOption.value),
      };
      index += ownerOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const runModeOption = readCliOptionValue({
      flag: '--run-mode',
      token,
      nextToken: tokens[index + 1],
    });

    if (runModeOption.matched) {
      const previousSelector = selectors.at(-1);

      if (!previousSelector) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: 'Pass --run-mode after a --country or --region selector.',
        };
      }

      if (previousSelector.runMode !== 'all') {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: `Selector ${previousSelector.kind}=${previousSelector.value} already has a --run-mode filter.`,
        };
      }

      selectors[selectors.length - 1] = {
        ...previousSelector,
        runMode: parseRelayRunModeFilter(runModeOption.value),
      };
      index += runModeOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const minPortSpeedOption = readCliOptionValue({
      flag: '--min-port-speed',
      token,
      nextToken: tokens[index + 1],
    });

    if (minPortSpeedOption.matched) {
      const previousSelector = selectors.at(-1);

      if (!previousSelector) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: 'Pass --min-port-speed after a --country or --region selector.',
        };
      }

      if (previousSelector.minPortSpeed !== null) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: `Selector ${previousSelector.kind}=${previousSelector.value} already has a --min-port-speed filter.`,
        };
      }

      selectors[selectors.length - 1] = {
        ...previousSelector,
        minPortSpeed: parseProxyExportMinPortSpeed(minPortSpeedOption.value),
      };
      index += minPortSpeedOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const countOption = readCliOptionValue({
      flag: '--count',
      token,
      nextToken: tokens[index + 1],
    });

    if (countOption.matched) {
      if (selectors.length === 0) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: 'Pass --count after a --country or --region selector.',
        };
      }

      const previousSelector = selectors.at(-1);

      if (!previousSelector) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: 'Pass --count after a --country or --region selector.',
        };
      }

      if (previousSelector.requestedCount !== null) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: `Selector ${previousSelector.kind}=${previousSelector.value} already has a --count.`,
        };
      }

      selectors[selectors.length - 1] = {
        ...previousSelector,
        requestedCount: parseProxyExportCount(countOption.value),
      };
      index += countOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const protocolOption = readCliOptionValue({
      flag: '--protocol',
      token,
      nextToken: tokens[index + 1],
    });

    if (protocolOption.matched) {
      index += protocolOption.consumedNextToken ? 1 : 0;
      continue;
    }

    const outputOption = readCliOptionValue({
      flag: '--output',
      token,
      nextToken: tokens[index + 1],
    });

    if (outputOption.matched) {
      index += outputOption.consumedNextToken ? 1 : 0;
    }
  }

  return {
    ok: true,
    selectors,
  };
}

function buildCountryPromptOptions(
  relayCatalog: MullvadRelayCatalog,
): readonly PromptSelectOption[] {
  return relayCatalog.countries.map((country) => ({
    value: country.code,
    label: `${country.name} (${country.code})`,
    hint: `${country.cities.length} cities`,
  }));
}

function buildCityPromptOptions(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode: string;
}): readonly PromptSelectOption[] {
  const country = input.relayCatalog.countries.find((entry) => entry.code === input.countryCode);

  if (!country) {
    return [];
  }

  return country.cities.map((city) => ({
    value: city.code,
    label: `${city.name} (${city.code})`,
    hint: `${city.relayCount} servers`,
  }));
}

function buildServerPromptOptions(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode: string;
  readonly cityCode?: string;
  readonly providers: readonly string[];
}): readonly PromptSelectOption[] {
  return listMatchingRelays({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
    ...(input.cityCode ? { cityCode: input.cityCode } : {}),
    providers: input.providers,
  }).map((relay) => ({
    value: relay.hostname,
    label: relay.hostname,
    hint: `${relay.location.countryName} / ${relay.location.cityName}${relay.provider ? ` / ${relay.provider}` : ''}`,
  }));
}

function buildProviderPromptOptions(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode?: string;
  readonly cityCode?: string;
}): readonly PromptSelectOption[] {
  const providers = new Set<string>();

  listMatchingRelays({
    relayCatalog: input.relayCatalog,
    ...(input.countryCode ? { countryCode: input.countryCode } : {}),
    ...(input.cityCode ? { cityCode: input.cityCode } : {}),
    providers: [],
  }).forEach((relay) => {
    if (relay.provider?.trim()) {
      providers.add(relay.provider);
    }
  });

  return [...providers]
    .sort((left, right) => left.localeCompare(right))
    .map((provider) => ({
      value: provider,
      label: provider,
    }));
}

export function renderProxyExportSelectorLabel(selector: ProxyExportSelector): string {
  const parts =
    selector.kind === 'region'
      ? [`region=${selector.value}`]
      : [
          `country=${selector.value}`,
          ...(selector.city ? [`city=${selector.city}`] : []),
          ...(selector.server ? [`server=${selector.server}`] : []),
        ];

  return [
    ...parts,
    ...(selector.providers.length > 0 ? [`providers=${selector.providers.join(',')}`] : []),
    ...(selector.owner !== 'all' ? [`owner=${selector.owner}`] : []),
    ...(selector.runMode !== 'all' ? [`run-mode=${selector.runMode}`] : []),
    ...(selector.minPortSpeed !== null ? [`min-port-speed=${selector.minPortSpeed}`] : []),
  ].join(' ');
}

function resolveProxyExportProviderNames(input: {
  readonly providers: readonly string[];
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
}): { readonly ok: true; readonly providers: readonly string[] } | ProxyExportFailure {
  const available = new Map<string, string>();

  input.relayCatalog.relays.forEach((relay) => {
    if (relay.provider?.trim()) {
      available.set(normalizeLocationToken(relay.provider), relay.provider);
    }
  });

  const providers = input.providers.map((provider) => {
    const normalized = normalizeLocationToken(provider);
    return available.get(normalized) ?? provider.trim();
  });

  const unknown = providers.filter((provider) => !available.has(normalizeLocationToken(provider)));

  if (unknown.length > 0) {
    return {
      ok: false,
      phase: 'export-proxies',
      source: 'input',
      message: `Unknown provider ${unknown[0]}.`,
      configPath: input.configPath,
    };
  }

  return {
    ok: true,
    providers: [...new Set(providers)].sort((left, right) => left.localeCompare(right)),
  };
}

function resolveCountryCode(input: {
  readonly value: string;
  readonly config: MullgateConfig;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
}): { readonly ok: true; readonly countryCode: string } | ProxyExportFailure {
  const normalized = normalizeLocationToken(input.value);
  const match = input.relayCatalog.countries.find(
    (country) =>
      country.code.toLowerCase() === normalized ||
      normalizeLocationToken(country.name) === normalized,
  );

  if (match) {
    return {
      ok: true,
      countryCode: match.code,
    };
  }

  const configuredCountryCode = input.config.routing.locations
    .map((location) => location.relayPreference.country?.toLowerCase() ?? null)
    .filter(isDefined)
    .find((countryCode) => countryCode === normalized);

  if (configuredCountryCode) {
    return {
      ok: true,
      countryCode: configuredCountryCode,
    };
  }

  return {
    ok: false,
    phase: 'export-proxies',
    source: 'input',
    message: `Unknown country ${input.value}.`,
    configPath: input.configPath,
  };
}

function resolveCityCode(input: {
  readonly countryCode: string;
  readonly value: string;
  readonly config: MullgateConfig;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
}): { readonly ok: true; readonly cityCode: string } | ProxyExportFailure {
  const country = input.relayCatalog.countries.find((entry) => entry.code === input.countryCode);
  const normalized = normalizeLocationToken(input.value);
  const match = country?.cities.find(
    (city) =>
      city.code.toLowerCase() === normalized || normalizeLocationToken(city.name) === normalized,
  );

  if (match) {
    return {
      ok: true,
      cityCode: match.code,
    };
  }

  const configuredCityCode = input.config.routing.locations
    .filter((location) => location.relayPreference.country === input.countryCode)
    .map((location) => location.relayPreference.city?.toLowerCase() ?? null)
    .filter(isDefined)
    .find((cityCode) => cityCode === normalized);

  if (configuredCityCode) {
    return {
      ok: true,
      cityCode: configuredCityCode,
    };
  }

  return {
    ok: false,
    phase: 'export-proxies',
    source: 'input',
    message: `Unknown city ${input.value} for country ${input.countryCode}.`,
    configPath: input.configPath,
  };
}

function resolveServerHostname(input: {
  readonly countryCode: string;
  readonly cityCode?: string;
  readonly providers: readonly string[];
  readonly value: string;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
}): { readonly ok: true; readonly hostname: string } | ProxyExportFailure {
  const normalized = normalizeLocationToken(input.value);
  const relay = listMatchingRelays({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
    ...(input.cityCode ? { cityCode: input.cityCode } : {}),
    providers: input.providers,
  }).find(
    (entry) =>
      entry.hostname.toLowerCase() === normalized || entry.fqdn.toLowerCase() === normalized,
  );

  if (relay) {
    return {
      ok: true,
      hostname: relay.hostname,
    };
  }

  return {
    ok: false,
    phase: 'export-proxies',
    source: 'input',
    message: `Unknown server ${input.value} for the selected country/city/provider filters.`,
    configPath: input.configPath,
  };
}

export function listMatchingRelays(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode?: string;
  readonly cityCode?: string;
  readonly providers: readonly string[];
  readonly owner?: RelayOwnerFilter;
  readonly runMode?: RelayRunModeFilter;
  readonly minPortSpeed?: number | null;
  readonly includeInactive?: boolean;
}): MullvadRelay[] {
  const providers = new Set(input.providers.map((provider) => provider.toLowerCase()));
  const owner = input.owner ?? 'all';
  const runMode = input.runMode ?? 'all';
  const minPortSpeed = input.minPortSpeed ?? null;
  const includeInactive = input.includeInactive ?? false;

  return [...input.relayCatalog.relays]
    .filter((relay) => {
      if (!includeInactive && !relay.active) {
        return false;
      }

      if (input.countryCode && relay.location.countryCode !== input.countryCode) {
        return false;
      }

      if (input.cityCode && relay.location.cityCode !== input.cityCode) {
        return false;
      }

      if (providers.size > 0 && (!relay.provider || !providers.has(relay.provider.toLowerCase()))) {
        return false;
      }

      if (owner === 'mullvad' && !relay.owned) {
        return false;
      }

      if (owner === 'rented' && relay.owned) {
        return false;
      }

      if (runMode === 'ram' && relay.stboot !== true) {
        return false;
      }

      if (runMode === 'disk' && relay.stboot === true) {
        return false;
      }

      if (minPortSpeed !== null && (relay.networkPortSpeed ?? 0) < minPortSpeed) {
        return false;
      }

      return true;
    })
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        Number(right.owned) - Number(left.owned) ||
        (right.networkPortSpeed ?? 0) - (left.networkPortSpeed ?? 0) ||
        left.location.countryCode.localeCompare(right.location.countryCode) ||
        left.location.cityCode.localeCompare(right.location.cityCode) ||
        left.hostname.localeCompare(right.hostname),
    );
}

export function buildProxyExportPlan(input: {
  readonly config: MullgateConfig;
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelector[];
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
}): ProxyExportPlanResult {
  for (const selector of input.selectors) {
    if (selector.kind === 'region' && !resolveRegionCountryCodes(selector.value)) {
      return {
        ok: false,
        phase: 'export-proxies',
        source: 'input',
        message: `Unknown region ${selector.value}. Supported regions: ${listRegionGroupNames().join(', ')}.`,
        configPath: input.configPath,
      };
    }
  }

  const exposure = buildExposureContract(input.config);
  const routeDescriptors = describeConfiguredProxyExportRoutes({
    config: input.config,
    relayCatalog: input.relayCatalog,
  });

  if (!exposure.ports.some((port) => port.protocol === input.protocol)) {
    return {
      ok: false,
      phase: 'export-proxies',
      source: 'canonical-config',
      message: `Protocol ${input.protocol} is not configured in the saved Mullgate ports.`,
      configPath: input.configPath,
    };
  }

  const entries = exposure.routes
    .map((route, routeIndex) => {
      const endpoint = route.endpoints.find((candidate) => candidate.protocol === input.protocol);

      if (!endpoint) {
        return null;
      }

      return {
        routeIndex,
        alias: route.alias,
        hostname: route.hostname,
        countryCode: routeDescriptors[routeIndex]?.countryCode ?? null,
        cityCode: routeDescriptors[routeIndex]?.cityCode ?? null,
        relayHostname: routeDescriptors[routeIndex]?.relayHostname ?? null,
        provider: routeDescriptors[routeIndex]?.provider ?? null,
        owner: routeDescriptors[routeIndex]?.owner ?? null,
        runMode: routeDescriptors[routeIndex]?.runMode ?? null,
        portSpeed: routeDescriptors[routeIndex]?.portSpeed ?? null,
        url: createProxyExportUrl({
          protocol: input.protocol,
          hostname: route.hostname,
          port: endpoint.port,
          username: input.config.setup.auth.username,
          password: input.config.setup.auth.password,
        }),
      } satisfies ProxyExportEntry;
    })
    .filter(isDefined);

  if (entries.length === 0) {
    return {
      ok: false,
      phase: 'export-proxies',
      source: 'canonical-config',
      message: 'No exportable proxy routes were available for the requested protocol.',
      configPath: input.configPath,
    };
  }

  if (input.selectors.length === 0) {
    return {
      ok: true,
      protocol: input.protocol,
      selectors: [],
      entries,
      outputText: `${entries.map((entry) => entry.url).join('\n')}\n`,
      suggestedFilename: buildProxyExportFilename({
        protocol: input.protocol,
        selectors: input.selectors,
      }),
    };
  }

  const selectedRouteIndexes = new Set<number>();
  const selectedEntries: ProxyExportEntry[] = [];
  const selectorResults: ProxyExportSelectorResult[] = [];

  for (const selector of input.selectors) {
    const matchingEntries = entries.filter((entry) => {
      if (selectedRouteIndexes.has(entry.routeIndex)) {
        return false;
      }

      return matchesProxyExportSelector({ selector, entry });
    });
    const exportedEntries =
      selector.requestedCount === null
        ? matchingEntries
        : matchingEntries.slice(0, selector.requestedCount);

    exportedEntries.forEach((entry) => {
      selectedRouteIndexes.add(entry.routeIndex);
      selectedEntries.push(entry);
    });

    selectorResults.push({
      ...selector,
      matchedCount: matchingEntries.length,
      exportedCount: exportedEntries.length,
    });
  }

  if (selectedEntries.length === 0) {
    return {
      ok: false,
      phase: 'export-proxies',
      source: 'canonical-config',
      message: 'No configured routes matched the requested export selectors.',
      configPath: input.configPath,
    };
  }

  return {
    ok: true,
    protocol: input.protocol,
    selectors: selectorResults,
    entries: selectedEntries,
    outputText: `${selectedEntries.map((entry) => entry.url).join('\n')}\n`,
    suggestedFilename: buildProxyExportFilename({
      protocol: input.protocol,
      selectors: input.selectors,
    }),
  };
}

export function renderProxyExportSuccess(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly configPath: string;
  readonly outputPath: string;
}): string {
  return [
    'Mullgate proxy export complete.',
    ...renderProxyExportSummaryLines({
      result: input.result,
      configPath: input.configPath,
      writeMode: 'file',
    }),
    `output: ${input.outputPath}`,
  ].join('\n');
}

export function renderProxyExportPreview(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly configPath: string;
  readonly outputPath: string;
}): string {
  return [
    'Mullgate proxy export preview.',
    ...renderProxyExportSummaryLines({
      result: input.result,
      configPath: input.configPath,
      writeMode: 'dry-run',
    }),
    `output: ${input.outputPath}`,
    '',
    'preview',
    ...input.result.entries.map(
      (entry, index) =>
        `${index + 1}. ${entry.url} (alias: ${entry.alias}, country: ${entry.countryCode ?? 'n/a'}, city: ${entry.cityCode ?? 'n/a'}, relay: ${entry.relayHostname ?? 'n/a'})`,
    ),
  ].join('\n');
}

function renderProxyExportError(result: ProxyExportFailure): string {
  return [
    'Mullgate proxy export failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    ...(result.configPath ? [`config: ${result.configPath}`] : []),
    ...(result.artifactPath ? [`artifact: ${result.artifactPath}`] : []),
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
  ].join('\n');
}

function renderProxyExportStdoutNotice(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly configPath: string;
}): string {
  return [
    'Mullgate proxy export complete.',
    ...renderProxyExportSummaryLines({
      result: input.result,
      configPath: input.configPath,
      writeMode: 'stdout',
    }),
    'output: stdout',
  ].join('\n');
}

function renderProxyExportSummaryLines(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly configPath: string;
  readonly writeMode: ProxyExportWriteMode;
}): string[] {
  return [
    'phase: export-proxies',
    'source: canonical-config',
    `config: ${input.configPath}`,
    `protocol: ${input.result.protocol}`,
    `write mode: ${input.writeMode}`,
    ...(input.result.selectors.length === 0
      ? ['selection: all configured routes']
      : [
          `selectors: ${input.result.selectors.length}`,
          ...input.result.selectors.map(
            (selector, index) =>
              `${index + 1}. ${renderProxyExportSelectorLabel(selector)} requested=${selector.requestedCount ?? 'all'} matched=${selector.matchedCount} exported=${selector.exportedCount}`,
          ),
        ]),
    `exported count: ${input.result.entries.length}`,
  ];
}

async function resolveProxyExportInput(input: {
  readonly options: ProxyExportCommandOptions;
  readonly config: MullgateConfig;
  readonly selectors: readonly ProxyExportSelector[];
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
}): Promise<{ readonly ok: true; readonly value: ProxyExportResolvedInput } | ProxyExportFailure> {
  const outputPath = readOptionalString(input.options.output);
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
        protocol: parseProxyExportProtocol(input.options.protocol),
        selectors: resolvedSelectors.selectors,
        writeMode: modeResult.writeMode,
        ...(outputPath ? { outputPath } : {}),
        force: Boolean(input.options.force),
      },
    };
  }

  const guidedInput = await collectGuidedProxyExportInput({
    initialProtocol: readOptionalString(input.options.protocol),
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

async function collectGuidedProxyExportInput(input: {
  readonly initialProtocol?: string;
  readonly initialSelectors: readonly ProxyExportSelector[];
  readonly initialWriteMode: ProxyExportWriteMode;
  readonly initialOutputPath?: string;
  readonly force: boolean;
  readonly configPath: string;
  readonly relayCatalog: MullvadRelayCatalog;
}): Promise<{ readonly ok: true; readonly value: ProxyExportResolvedInput } | ProxyExportFailure> {
  const prompts = createGuidedPromptClient();

  try {
    prompts.intro(
      'Mullgate proxy export\nBuild a ready-to-paste proxy list from your saved routes.',
    );

    const protocol =
      input.initialProtocol ??
      (await prompts.select({
        message: describePromptStep(
          'Proxy protocol',
          'Pick the scheme your clients expect in the exported proxy URLs.',
        ),
        initialValue: 'socks5',
        options: [
          { value: 'socks5', label: 'SOCKS5' },
          { value: 'http', label: 'HTTP' },
          { value: 'https', label: 'HTTPS' },
        ],
      }));

    if (protocol === GUIDED_PROMPT_CANCELLED) {
      prompts.cancel('Guided export cancelled.');
      return {
        ok: false,
        phase: 'export-proxies',
        source: 'user-input',
        message: 'Guided export cancelled before Mullgate wrote any proxy file.',
        configPath: input.configPath,
      };
    }

    const selectors =
      input.initialSelectors.length > 0
        ? input.initialSelectors
        : await collectGuidedProxyExportSelectors(prompts, input.relayCatalog);

    if (selectors === GUIDED_PROMPT_CANCELLED) {
      prompts.cancel('Guided export cancelled.');
      return {
        ok: false,
        phase: 'export-proxies',
        source: 'user-input',
        message: 'Guided export cancelled before Mullgate wrote any proxy file.',
        configPath: input.configPath,
      };
    }

    const resolvedWriteMode =
      input.initialWriteMode !== 'file' || input.initialOutputPath !== undefined
        ? input.initialWriteMode
        : await prompts.select({
            message: describePromptStep(
              'Output mode',
              'Choose whether Mullgate should write a file, print the list, or just preview it.',
            ),
            initialValue: 'file',
            options: [
              { value: 'file', label: 'Write file' },
              { value: 'stdout', label: 'Print to stdout' },
              { value: 'dry-run', label: 'Preview only' },
            ],
          });

    if (resolvedWriteMode === GUIDED_PROMPT_CANCELLED) {
      prompts.cancel('Guided export cancelled.');
      return {
        ok: false,
        phase: 'export-proxies',
        source: 'user-input',
        message: 'Guided export cancelled before Mullgate wrote any proxy file.',
        configPath: input.configPath,
      };
    }

    const writeMode = parseProxyExportWriteMode(resolvedWriteMode);
    let outputPath = input.initialOutputPath;

    if (writeMode === 'file' && !outputPath) {
      const promptedOutputPath = await prompts.text({
        message: describePromptStep(
          'Output path',
          'Choose where Mullgate should write the proxy list file.',
        ),
        initialValue: 'proxies.txt',
        placeholder: 'proxies.txt',
        validate: (value) =>
          readOptionalString(value) ? undefined : 'Output path is required when writing a file.',
      });

      if (promptedOutputPath === GUIDED_PROMPT_CANCELLED) {
        prompts.cancel('Guided export cancelled.');
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'user-input',
          message: 'Guided export cancelled before Mullgate wrote any proxy file.',
          configPath: input.configPath,
        };
      }

      outputPath = promptedOutputPath.trim();
    }

    prompts.outro(
      writeMode === 'file'
        ? `Will export ${selectors.length === 0 ? 'all configured routes' : `${selectors.length} selector batches`} to ${outputPath}.`
        : `Will ${writeMode === 'stdout' ? 'print' : 'preview'} ${selectors.length === 0 ? 'all configured routes' : `${selectors.length} selector batches`} via ${writeMode}.`,
    );

    return {
      ok: true,
      value: {
        protocol: parseProxyExportProtocol(protocol),
        selectors,
        writeMode,
        ...(outputPath ? { outputPath } : {}),
        force: input.force,
      },
    };
  } finally {
    await prompts.close();
  }
}

async function collectGuidedProxyExportSelectors(
  prompts: GuidedPromptClient,
  relayCatalog: MullvadRelayCatalog,
): Promise<readonly ProxyExportSelector[] | typeof GUIDED_PROMPT_CANCELLED> {
  const filterExport = await prompts.confirm({
    message: describePromptStep(
      'Filter the export?',
      'Choose specific countries or region groups if you do not want every configured route in the file.',
    ),
    initialValue: false,
    active: 'Yes',
    inactive: 'No',
  });

  if (filterExport === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  if (!filterExport) {
    return [];
  }

  const countryOptions = buildCountryPromptOptions(relayCatalog);
  const regionOptions = listRegionGroupNames().map((region) => ({
    value: region,
    label: region,
    hint: `${resolveRegionCountryCodes(region)?.length ?? 0} countries`,
  }));

  const selectedSeeds = await collectGuidedProxyExportSelectorSeeds({
    prompts,
    countryOptions,
    regionOptions,
  });

  if (selectedSeeds === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const selectors: ProxyExportSelector[] = [];

  for (const seed of selectedSeeds) {
    const selector = await collectGuidedProxyExportSelectorFromSeed({
      prompts,
      relayCatalog,
      countryOptions,
      regionOptions,
      seed,
    });

    if (selector === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    selectors.push(selector);
  }

  while (true) {
    const addAnother = await prompts.confirm({
      message: describePromptStep(
        selectors.length === 0 ? 'Add a selector batch?' : 'Add another selector batch?',
        'Each batch can target one country or region, plus optional provider, city, server, and count filters.',
      ),
      initialValue: selectors.length === 0,
      active: 'Yes',
      inactive: 'No',
    });

    if (addAnother === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    if (!addAnother) {
      return selectors;
    }

    const selector = await collectGuidedProxyExportSelectorFromSeed({
      prompts,
      relayCatalog,
      countryOptions,
      regionOptions,
    });

    if (selector === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    selectors.push(selector);
  }
}

async function collectGuidedProxyExportSelectorSeeds(input: {
  readonly prompts: GuidedPromptClient;
  readonly countryOptions: readonly PromptSelectOption[];
  readonly regionOptions: readonly PromptSelectOption[];
}): Promise<readonly GuidedProxyExportSelectorSeed[] | typeof GUIDED_PROMPT_CANCELLED> {
  while (true) {
    const selectedCountries = await input.prompts.multiselect({
      message: describePromptStep(
        'Country batches',
        'Select one or more countries to turn into export batches.',
      ),
      options: input.countryOptions,
      placeholder: 'Select one or more countries',
    });

    if (selectedCountries === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    const selectedRegions = await input.prompts.multiselect({
      message: describePromptStep(
        'Region batches',
        'Select one or more built-in region groups such as Europe or Americas.',
      ),
      options: input.regionOptions,
      placeholder: 'Select one or more region groups',
    });

    if (selectedRegions === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    if (selectedCountries.length > 0 || selectedRegions.length > 0) {
      return [
        ...selectedCountries.map((value) => ({ kind: 'country' as const, value })),
        ...selectedRegions.map((value) => ({ kind: 'region' as const, value })),
      ];
    }

    const manualOnly = await input.prompts.confirm({
      message: describePromptStep(
        'Nothing selected from the lists yet.',
        'You can keep using the checklists or switch to building batches one at a time.',
      ),
      initialValue: true,
      active: 'Yes',
      inactive: 'Select from lists',
    });

    if (manualOnly === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    if (manualOnly) {
      return [];
    }
  }
}

async function collectGuidedProxyExportSelectorFromSeed(input: {
  readonly prompts: GuidedPromptClient;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryOptions: readonly PromptSelectOption[];
  readonly regionOptions: readonly PromptSelectOption[];
  readonly seed?: GuidedProxyExportSelectorSeed;
}): Promise<ProxyExportSelector | typeof GUIDED_PROMPT_CANCELLED> {
  const seed =
    input.seed ??
    (await collectManualGuidedProxyExportSelectorSeed({
      prompts: input.prompts,
      countryOptions: input.countryOptions,
      regionOptions: input.regionOptions,
    }));

  if (seed === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  if (seed.kind === 'region') {
    return collectGuidedRegionSelector({
      prompts: input.prompts,
      relayCatalog: input.relayCatalog,
      region: seed.value,
    });
  }

  return collectGuidedCountrySelector({
    prompts: input.prompts,
    relayCatalog: input.relayCatalog,
    countryCode: seed.value,
  });
}

async function collectManualGuidedProxyExportSelectorSeed(input: {
  readonly prompts: GuidedPromptClient;
  readonly countryOptions: readonly PromptSelectOption[];
  readonly regionOptions: readonly PromptSelectOption[];
}): Promise<GuidedProxyExportSelectorSeed | typeof GUIDED_PROMPT_CANCELLED> {
  const selectorType = await input.prompts.select({
    message: describePromptStep(
      'Selector type',
      'Choose whether this batch targets one country or one built-in region group.',
    ),
    initialValue: 'country',
    options: [
      { value: 'country', label: 'Country' },
      { value: 'region', label: 'Region' },
    ],
  });

  if (selectorType === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const kind = parseProxyExportSelectorType(selectorType);

  if (kind === 'region') {
    const region = await input.prompts.select({
      message: describePromptStep(
        'Region',
        'Pick the region group that should feed this export batch.',
      ),
      options: input.regionOptions,
      placeholder: 'Europe, Americas, Asia-Pacific',
    });

    if (region === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    return {
      kind: 'region',
      value: region,
    };
  }

  const countryCode = await input.prompts.select({
    message: describePromptStep('Country', 'Pick the country that should feed this export batch.'),
    options: input.countryOptions,
    placeholder: 'Sweden, Austria, United States',
  });

  if (countryCode === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  return {
    kind: 'country',
    value: countryCode,
  };
}

async function collectGuidedRegionSelector(input: {
  readonly prompts: GuidedPromptClient;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly region: string;
}): Promise<ProxyExportSelector | typeof GUIDED_PROMPT_CANCELLED> {
  const providerOptions = buildProviderPromptOptions({ relayCatalog: input.relayCatalog });
  const providerFilter =
    providerOptions.length > 0
      ? await input.prompts.confirm({
          message: describePromptStep(
            `Filter ${input.region} by provider?`,
            'Use this if you want only specific Mullvad hosting providers for this batch.',
          ),
          initialValue: false,
          active: 'Yes',
          inactive: 'No',
        })
      : false;

  if (providerFilter === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const providers =
    providerFilter && providerOptions.length > 0
      ? await input.prompts.multiselect({
          message: describePromptStep(
            `Providers for ${input.region}`,
            'Select one or more providers to keep in this region batch.',
          ),
          options: providerOptions,
          placeholder: 'm247, xtom, datawagon',
        })
      : [];

  if (providers === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const selectorCount = await input.prompts.text({
    message: describePromptStep(
      `Count for ${input.region} (number or all)`,
      'Set how many proxies this batch should contribute, or use "all".',
    ),
    initialValue: '1',
    validate: validateProxyExportSelectorCountInput,
  });

  if (selectorCount === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  return {
    kind: 'region',
    value: input.region,
    providers,
    owner: 'all',
    runMode: 'all',
    minPortSpeed: null,
    requestedCount: parseGuidedProxyExportCount(selectorCount),
  };
}

async function collectGuidedCountrySelector(input: {
  readonly prompts: GuidedPromptClient;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode: string;
}): Promise<ProxyExportSelector | typeof GUIDED_PROMPT_CANCELLED> {
  const countryLabel = describeGuidedCountrySelector(input.relayCatalog, input.countryCode);
  const cityOptions = buildCityPromptOptions({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
  });
  const cityFilter =
    cityOptions.length > 0
      ? await input.prompts.confirm({
          message: describePromptStep(
            `Pin ${countryLabel} to a city?`,
            'Choose one city if you want a tighter location filter than the whole country.',
          ),
          initialValue: false,
          active: 'Yes',
          inactive: 'No',
        })
      : false;

  if (cityFilter === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const city =
    cityFilter && cityOptions.length > 0
      ? await input.prompts.select({
          message: describePromptStep(
            `${countryLabel} city`,
            'Pick the city that should feed this country batch.',
          ),
          options: cityOptions,
          placeholder: 'Gothenburg, Vienna, New York',
        })
      : undefined;

  if (city === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const providerOptions = buildProviderPromptOptions({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
    ...(typeof city === 'string' ? { cityCode: city } : {}),
  });
  const providerFilter =
    providerOptions.length > 0
      ? await input.prompts.confirm({
          message: describePromptStep(
            `Filter ${countryLabel} by provider?`,
            'Use this if you want only specific Mullvad hosting providers for this country batch.',
          ),
          initialValue: false,
          active: 'Yes',
          inactive: 'No',
        })
      : false;

  if (providerFilter === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const providers =
    providerFilter && providerOptions.length > 0
      ? await input.prompts.multiselect({
          message: describePromptStep(
            `${countryLabel} providers`,
            'Select one or more providers to keep in this batch.',
          ),
          options: providerOptions,
          placeholder: 'm247, xtom, datawagon',
        })
      : [];

  if (providers === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const serverOptions = buildServerPromptOptions({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
    ...(typeof city === 'string' ? { cityCode: city } : {}),
    providers,
  });
  const serverFilter =
    serverOptions.length > 0
      ? await input.prompts.confirm({
          message: describePromptStep(
            `Pin ${countryLabel} to one exact server?`,
            'Use this only when you want a single named Mullvad relay host.',
          ),
          initialValue: false,
          active: 'Yes',
          inactive: 'No',
        })
      : false;

  if (serverFilter === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const server =
    serverFilter && serverOptions.length > 0
      ? await input.prompts.select({
          message: describePromptStep(
            `${countryLabel} server`,
            'Pick the exact relay hostname for this batch.',
          ),
          options: serverOptions,
          placeholder: 'se-got-wg-101, at-vie-wg-001',
        })
      : undefined;

  if (server === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const selectorCount =
    typeof server === 'string'
      ? '1'
      : await input.prompts.text({
          message: describePromptStep(
            `Count for ${countryLabel} (number or all)`,
            'Set how many proxies this batch should contribute, or use "all".',
          ),
          initialValue: '1',
          validate: validateProxyExportSelectorCountInput,
        });

  if (selectorCount === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  return {
    kind: 'country',
    value: input.countryCode,
    ...(typeof city === 'string' ? { city } : {}),
    ...(typeof server === 'string' ? { server } : {}),
    providers,
    owner: 'all',
    runMode: 'all',
    minPortSpeed: null,
    requestedCount: parseGuidedProxyExportCount(selectorCount),
  };
}

function describeGuidedCountrySelector(
  relayCatalog: MullvadRelayCatalog,
  countryCode: string,
): string {
  const country = relayCatalog.countries.find((entry) => entry.code === countryCode);
  return country ? `${country.name} (${country.code})` : countryCode;
}

export function resolveProxyExportSelectorsWithCatalog(input: {
  readonly config: MullgateConfig;
  readonly selectors: readonly ProxyExportSelector[];
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
}): { readonly ok: true; readonly selectors: readonly ProxyExportSelector[] } | ProxyExportFailure {
  const selectors: ProxyExportSelector[] = [];

  for (const selector of input.selectors) {
    const providersResult = resolveProxyExportProviderNames({
      providers: selector.providers,
      relayCatalog: input.relayCatalog,
      configPath: input.configPath,
    });

    if (!providersResult.ok) {
      return providersResult;
    }

    if (selector.kind === 'region') {
      const region = normalizeProxyExportSelectorValue(selector.value, 'region');

      if (!resolveRegionCountryCodes(region)) {
        return {
          ok: false,
          phase: 'export-proxies',
          source: 'input',
          message: `Unknown region ${region}. Supported regions: ${listRegionGroupNames().join(', ')}.`,
          configPath: input.configPath,
        };
      }

      selectors.push({
        kind: 'region',
        value: region,
        providers: providersResult.providers,
        owner: selector.owner,
        runMode: selector.runMode,
        minPortSpeed: selector.minPortSpeed,
        requestedCount: selector.requestedCount,
      });
      continue;
    }

    const countryResult = resolveCountryCode({
      value: selector.value,
      config: input.config,
      relayCatalog: input.relayCatalog,
      configPath: input.configPath,
    });

    if (!countryResult.ok) {
      return countryResult;
    }

    const cityResult =
      selector.city === undefined
        ? { ok: true as const, cityCode: undefined }
        : resolveCityCode({
            countryCode: countryResult.countryCode,
            value: selector.city,
            config: input.config,
            relayCatalog: input.relayCatalog,
            configPath: input.configPath,
          });

    if (!cityResult.ok) {
      return cityResult;
    }

    const serverResult =
      selector.server === undefined
        ? { ok: true as const, hostname: undefined }
        : resolveServerHostname({
            countryCode: countryResult.countryCode,
            ...(cityResult.cityCode ? { cityCode: cityResult.cityCode } : {}),
            providers: providersResult.providers,
            value: selector.server,
            relayCatalog: input.relayCatalog,
            configPath: input.configPath,
          });

    if (!serverResult.ok) {
      return serverResult;
    }

    if (serverResult.hostname && selector.requestedCount !== null && selector.requestedCount > 1) {
      return {
        ok: false,
        phase: 'export-proxies',
        source: 'input',
        message: `Selector ${renderProxyExportSelectorLabel({
          ...selector,
          value: countryResult.countryCode,
          ...(cityResult.cityCode ? { city: cityResult.cityCode } : {}),
          ...(serverResult.hostname ? { server: serverResult.hostname } : {}),
          providers: providersResult.providers,
          owner: selector.owner,
          runMode: selector.runMode,
          minPortSpeed: selector.minPortSpeed,
        })} targets one exact server, so --count cannot exceed 1.`,
        configPath: input.configPath,
      };
    }

    selectors.push({
      kind: 'country',
      value: countryResult.countryCode,
      ...(cityResult.cityCode ? { city: cityResult.cityCode } : {}),
      ...(serverResult.hostname ? { server: serverResult.hostname } : {}),
      providers: providersResult.providers,
      owner: selector.owner,
      runMode: selector.runMode,
      minPortSpeed: selector.minPortSpeed,
      requestedCount: selector.requestedCount,
    });
  }

  return {
    ok: true,
    selectors,
  };
}

export function describeConfiguredProxyExportRoutes(input: {
  readonly config: MullgateConfig;
  readonly relayCatalog: MullvadRelayCatalog;
}): readonly ProxyExportRouteDescriptor[] {
  const relayByHostname = new Map(
    input.relayCatalog.relays.flatMap((relay) => [
      [relay.hostname, relay],
      [relay.fqdn, relay],
    ]),
  );

  return input.config.routing.locations.map((location, routeIndex) => {
    const matchedRelay = relayByHostname.get(location.mullvad.exit.relayHostname) ?? null;

    return {
      routeIndex,
      routeId: location.runtime.routeId,
      routeAlias: location.alias,
      routeHostname: location.hostname,
      countryCode: matchedRelay?.location.countryCode ?? location.mullvad.exit.countryCode ?? null,
      cityCode: matchedRelay?.location.cityCode ?? location.mullvad.exit.cityCode ?? null,
      relayHostname: matchedRelay?.hostname ?? location.mullvad.exit.relayHostname,
      provider: matchedRelay?.provider ?? location.mullvad.relayConstraints.providers[0] ?? null,
      owner: matchedRelay ? (matchedRelay.owned ? 'mullvad' : 'rented') : null,
      runMode: matchedRelay ? (matchedRelay.stboot ? 'ram' : 'disk') : null,
      portSpeed: matchedRelay?.networkPortSpeed ?? null,
    };
  });
}

export async function loadRelayCatalogForProxyExport(input: {
  readonly store: ConfigStore;
}): Promise<
  { readonly ok: true; readonly relayCatalog: MullvadRelayCatalog } | ProxyExportFailure
> {
  const cached = await loadStoredRelayCatalog(input.store.paths.provisioningCacheFile);

  if (cached.ok && relayCatalogHasRichMetadata(cached.value)) {
    return {
      ok: true,
      relayCatalog: cached.value,
    };
  }

  const envRelayUrl = readOptionalString(process.env[RELAYS_URL_ENV]);
  const preferredRelayUrl = envRelayUrl ?? LEGACY_RELAYS_URL;
  const preferredFetch = await fetchRelays({
    url: preferredRelayUrl,
  });

  if (preferredFetch.ok) {
    return {
      ok: true,
      relayCatalog: preferredFetch.value,
    };
  }

  if (cached.ok) {
    return {
      ok: true,
      relayCatalog: cached.value,
    };
  }

  const fetched = await fetchRelays({
    ...(envRelayUrl ? { url: envRelayUrl } : {}),
  });

  if (fetched.ok) {
    return {
      ok: true,
      relayCatalog: fetched.value,
    };
  }

  return {
    ok: false,
    phase: fetched.phase,
    source: fetched.source,
    message: fetched.message,
    configPath: input.store.paths.configFile,
    cause: preferredFetch.cause ?? cached.cause ?? fetched.cause ?? cached.message,
  };
}

function relayCatalogHasRichMetadata(relayCatalog: MullvadRelayCatalog): boolean {
  if (relayCatalog.source === 'www-relays-all') {
    return true;
  }

  return relayCatalog.relays.some((relay) => {
    return Boolean(relay.provider || relay.networkPortSpeed || relay.stboot !== undefined);
  });
}

export async function ensureProxyExportRoutes(input: {
  readonly store: ConfigStore;
  readonly config: MullgateConfig;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly exportInput: ProxyExportResolvedInput;
}): Promise<
  | {
      readonly ok: true;
      readonly config: MullgateConfig;
      readonly relayCatalog: MullvadRelayCatalog;
      readonly createdAliases: readonly string[];
    }
  | ProxyExportFailure
> {
  if (input.exportInput.selectors.length === 0) {
    return {
      ok: true,
      config: input.config,
      relayCatalog: input.relayCatalog,
      createdAliases: [],
    };
  }

  const plannedTargets = planProxyExportRelayTargets({
    config: input.config,
    relayCatalog: input.relayCatalog,
    selectors: input.exportInput.selectors,
    configuredRoutes: describeConfiguredProxyExportRoutes({
      config: input.config,
      relayCatalog: input.relayCatalog,
    }),
    configPath: input.store.paths.configFile,
  });

  if (!plannedTargets.ok) {
    return plannedTargets;
  }

  if (plannedTargets.targets.length === 0) {
    return {
      ok: true,
      config: input.config,
      relayCatalog: input.relayCatalog,
      createdAliases: [],
    };
  }

  const _newRouteCount = input.config.routing.locations.length + plannedTargets.targets.length;
  const routeBindIpsResult = deriveAddedRouteBindIps({
    config: input.config,
    count: plannedTargets.targets.length,
    configPath: input.store.paths.configFile,
  });

  if (!routeBindIpsResult.ok) {
    return routeBindIpsResult;
  }

  const aliasCatalog = createLocationAliasCatalog(input.relayCatalog.relays);

  if (!aliasCatalog.ok) {
    return {
      ok: false,
      phase: aliasCatalog.phase,
      source: aliasCatalog.source,
      message: aliasCatalog.message,
      configPath: input.store.paths.configFile,
      ...(aliasCatalog.alias ? { artifactPath: aliasCatalog.alias } : {}),
    };
  }

  const baseDeviceName = deriveExportBaseDeviceName(input.config);
  const plannedRoutesResult = planSetupRoutes({
    requestedLocations: plannedTargets.targets.map((target) => target.relay.hostname),
    routeBindIps: routeBindIpsResult.routeBindIps,
    exposureMode: input.config.setup.exposure.mode,
    exposureBaseDomain: input.config.setup.exposure.baseDomain,
    aliasCatalog: aliasCatalog.value,
    baseDeviceName,
  });

  if (!plannedRoutesResult.ok) {
    return {
      ok: false,
      phase: plannedRoutesResult.phase,
      source: plannedRoutesResult.source,
      message: plannedRoutesResult.message,
      configPath: input.store.paths.configFile,
      ...(plannedRoutesResult.code ? { cause: plannedRoutesResult.code } : {}),
      ...(plannedRoutesResult.artifactPath
        ? { artifactPath: plannedRoutesResult.artifactPath }
        : {}),
    };
  }

  const plannedRoutes = plannedRoutesResult.value.map((route) => ({
    ...route,
    deviceName: baseDeviceName,
  }));

  if (input.exportInput.writeMode === 'dry-run') {
    const dryRunConfig = normalizeMullgateConfig({
      ...input.config,
      updatedAt: new Date().toISOString(),
      routing: {
        locations: [
          ...input.config.routing.locations,
          ...plannedRoutes.map((route, index) =>
            createProvisionedRouteConfig({
              route,
              relay: requireArrayValue(
                plannedTargets.targets,
                index,
                `Missing planned export target at index ${index}.`,
              ).relay,
              providers: plannedTargets.targets[index]?.selector.providers ?? [],
            }),
          ),
        ],
      },
    });

    return {
      ok: true,
      config: dryRunConfig,
      relayCatalog: input.relayCatalog,
      createdAliases: plannedRoutes.map((route) => route.alias),
    };
  }

  const updatedConfig = normalizeMullgateConfig({
    ...input.config,
    updatedAt: new Date().toISOString(),
    routing: {
      locations: [
        ...input.config.routing.locations,
        ...plannedRoutes.map((route, index) =>
          createProvisionedRouteConfig({
            route,
            relay: requireArrayValue(
              plannedTargets.targets,
              index,
              `Missing planned export target at index ${index}.`,
            ).relay,
            providers: requireArrayValue(
              plannedTargets.targets,
              index,
              `Missing planned export target at index ${index}.`,
            ).selector.providers,
          }),
        ),
      ],
    },
  });

  const pendingConfig = withRuntimeStatus(
    updatedConfig,
    'unvalidated',
    null,
    'Export added routed locations; runtime artifacts were refreshed for the new routes.',
  );

  try {
    await input.store.save(pendingConfig);
  } catch (error) {
    return {
      ok: false,
      phase: 'persist-config',
      source: 'filesystem',
      message: 'Failed to persist config after adding export routes.',
      configPath: input.store.paths.configFile,
      cause: error instanceof Error ? error.message : String(error),
    };
  }

  const renderResult = await renderRuntimeProxyArtifacts({
    config: pendingConfig,
    relayCatalog: input.relayCatalog,
    paths: input.store.paths,
  });

  if (!renderResult.ok) {
    return {
      ok: false,
      phase: renderResult.phase,
      source: renderResult.source,
      message: renderResult.message,
      configPath: input.store.paths.configFile,
      ...(renderResult.cause ? { cause: renderResult.cause } : {}),
      ...(renderResult.artifactPath ? { artifactPath: renderResult.artifactPath } : {}),
    };
  }

  const validationResult = await validateRuntimeArtifacts({
    entryWireproxyConfigPath: renderResult.artifactPaths.entryWireproxyConfigPath,
    entryWireproxyConfigText: renderResult.entryWireproxyConfig,
    routeProxyConfigPath: renderResult.artifactPaths.routeProxyConfigPath,
    routeProxyConfigText: renderResult.routeProxyConfig,
    routes: renderResult.routes,
    bind: {
      socksPort: pendingConfig.setup.bind.socksPort,
      httpPort: pendingConfig.setup.bind.httpPort,
    },
    reportPath: input.store.paths.runtimeValidationReportFile,
  });

  const finalConfig = withRuntimeStatus(
    pendingConfig,
    validationResult.ok ? 'validated' : 'error',
    validationResult.checkedAt,
    validationResult.ok
      ? `Validated via ${summarizeValidationSource(validationResult)}.`
      : `Validation failed via ${summarizeValidationSource(validationResult)}: ${validationResult.cause}`,
  );

  try {
    await input.store.save(finalConfig);
  } catch (error) {
    return {
      ok: false,
      phase: 'persist-config',
      source: 'filesystem',
      message: 'Failed to persist validated config after adding export routes.',
      configPath: input.store.paths.configFile,
      cause: error instanceof Error ? error.message : String(error),
    };
  }

  if (!validationResult.ok) {
    return {
      ok: false,
      phase: validationResult.phase,
      source: validationResult.source,
      message: validationResult.cause,
      configPath: input.store.paths.configFile,
      artifactPath: validationResult.target,
      cause: validationResult.issues.map((issue) => issue.message).join('; '),
    };
  }

  return {
    ok: true,
    config: finalConfig,
    relayCatalog: input.relayCatalog,
    createdAliases: plannedRoutes.map((route) => route.alias),
  };
}

export function planProxyExportRelayTargets(input: {
  readonly config: MullgateConfig;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly selectors: readonly ProxyExportSelector[];
  readonly configuredRoutes: readonly ProxyExportRouteDescriptor[];
  readonly configPath: string;
}):
  | {
      readonly ok: true;
      readonly targets: readonly {
        readonly relay: MullvadRelay;
        readonly selector: ProxyExportSelector;
      }[];
    }
  | ProxyExportFailure {
  const reservedRelayHostnames = new Set<string>();
  const plannedTargets: { relay: MullvadRelay; selector: ProxyExportSelector }[] = [];

  for (const selector of input.selectors) {
    const matchingConfiguredRoutes = input.configuredRoutes.filter((route) => {
      if (route.relayHostname && reservedRelayHostnames.has(route.relayHostname)) {
        return false;
      }

      return matchesProxyExportSelector({
        selector,
        entry: {
          routeIndex: route.routeIndex,
          alias: route.routeAlias,
          hostname: route.routeHostname,
          countryCode: route.countryCode,
          cityCode: route.cityCode,
          relayHostname: route.relayHostname,
          provider: route.provider,
          owner: route.owner,
          runMode: route.runMode,
          portSpeed: route.portSpeed,
          url: '',
        },
      });
    });
    const desiredCount = selector.requestedCount ?? Math.max(1, matchingConfiguredRoutes.length);
    const exportedExistingRoutes = matchingConfiguredRoutes.slice(0, desiredCount);

    exportedExistingRoutes.forEach((route) => {
      if (route.relayHostname) {
        reservedRelayHostnames.add(route.relayHostname);
      }
    });

    const remainingCount = desiredCount - exportedExistingRoutes.length;

    if (remainingCount <= 0) {
      continue;
    }

    const selectedRelays = chooseRelaysForProxyExportSelector({
      selector,
      relayCatalog: input.relayCatalog,
      count: remainingCount,
      excludedRelayHostnames: reservedRelayHostnames,
    });

    selectedRelays.forEach((relay) => {
      reservedRelayHostnames.add(relay.hostname);
      plannedTargets.push({ relay, selector });
    });
  }

  return {
    ok: true,
    targets: plannedTargets,
  };
}

export function chooseRelaysForProxyExportSelector(input: {
  readonly selector: ProxyExportSelector;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly count: number;
  readonly excludedRelayHostnames: ReadonlySet<string>;
}): MullvadRelay[] {
  if (input.selector.kind === 'region') {
    const countryCodes = resolveRegionCountryCodes(input.selector.value) ?? [];

    return chooseSpreadRelays({
      candidates: listMatchingRelays({
        relayCatalog: input.relayCatalog,
        providers: input.selector.providers,
        owner: input.selector.owner,
        runMode: input.selector.runMode,
        minPortSpeed: input.selector.minPortSpeed,
      }).filter(
        (relay) =>
          countryCodes.includes(relay.location.countryCode) &&
          !input.excludedRelayHostnames.has(relay.hostname),
      ),
      count: input.count,
      spreadKey: (relay) => relay.location.countryCode,
    });
  }

  if (input.selector.server) {
    const relay = listMatchingRelays({
      relayCatalog: input.relayCatalog,
      countryCode: input.selector.value,
      ...(input.selector.city ? { cityCode: input.selector.city } : {}),
      providers: input.selector.providers,
      owner: input.selector.owner,
      runMode: input.selector.runMode,
      minPortSpeed: input.selector.minPortSpeed,
    }).find(
      (candidate) =>
        candidate.hostname === input.selector.server &&
        !input.excludedRelayHostnames.has(candidate.hostname),
    );

    return relay ? [relay] : [];
  }

  const candidates = listMatchingRelays({
    relayCatalog: input.relayCatalog,
    countryCode: input.selector.value,
    ...(input.selector.city ? { cityCode: input.selector.city } : {}),
    providers: input.selector.providers,
    owner: input.selector.owner,
    runMode: input.selector.runMode,
    minPortSpeed: input.selector.minPortSpeed,
  }).filter((relay) => !input.excludedRelayHostnames.has(relay.hostname));

  return chooseSpreadRelays({
    candidates,
    count: input.count,
    spreadKey: input.selector.city ? (relay) => relay.hostname : (relay) => relay.location.cityCode,
  });
}

export function chooseSpreadRelays(input: {
  readonly candidates: readonly MullvadRelay[];
  readonly count: number;
  readonly spreadKey: (relay: MullvadRelay) => string;
}): MullvadRelay[] {
  const grouped = new Map<string, MullvadRelay[]>();

  input.candidates.forEach((relay) => {
    const key = input.spreadKey(relay);
    const existing = grouped.get(key);

    if (existing) {
      existing.push(relay);
      return;
    }

    grouped.set(key, [relay]);
  });

  const groupKeys = [...grouped.keys()].sort((left, right) => left.localeCompare(right));
  const selected: MullvadRelay[] = [];

  while (selected.length < input.count) {
    let pickedAny = false;

    groupKeys.forEach((key) => {
      if (selected.length >= input.count) {
        return;
      }

      const relays = grouped.get(key);
      const nextRelay = relays?.shift();

      if (!nextRelay) {
        return;
      }

      selected.push(nextRelay);
      pickedAny = true;
    });

    if (!pickedAny) {
      return selected;
    }
  }

  return selected;
}

function deriveExportBaseDeviceName(config: MullgateConfig): string {
  return readOptionalString(config.mullvad.deviceName) ?? defaultDeviceName();
}

function deriveAddedRouteBindIps(input: {
  readonly config: MullgateConfig;
  readonly count: number;
  readonly configPath: string;
}): { readonly ok: true; readonly routeBindIps: readonly string[] } | ProxyExportFailure {
  if (input.count === 0) {
    return {
      ok: true,
      routeBindIps: [],
    };
  }

  if (input.config.setup.exposure.mode === 'loopback') {
    const exposure = validateExposureSettings({
      routeCount: input.config.routing.locations.length + input.count,
      exposureMode: 'loopback',
      exposureBaseDomain: input.config.setup.exposure.baseDomain,
      routeBindIps: [],
      artifactPath: input.configPath,
    });

    if (!exposure.ok) {
      return {
        ok: false,
        phase: exposure.phase,
        source: exposure.source,
        message: exposure.message,
        configPath: input.configPath,
        ...(exposure.cause ? { cause: exposure.cause } : {}),
      };
    }

    return {
      ok: true,
      routeBindIps: exposure.routeBindIps.slice(input.config.routing.locations.length),
    };
  }

  if (input.config.setup.exposure.mode === 'private-network') {
    return {
      ok: true,
      routeBindIps: Array.from({ length: input.count }, () => input.config.setup.bind.host),
    };
  }

  const nextRouteBindIps: string[] = [];
  let previousBindIp =
    input.config.routing.locations.at(-1)?.bindIp ?? input.config.setup.bind.host;

  for (let index = 0; index < input.count; index += 1) {
    previousBindIp = incrementIpv4Address(previousBindIp);
    nextRouteBindIps.push(previousBindIp);
  }
  const validated = validateExposureSettings({
    routeCount: input.config.routing.locations.length + input.count,
    exposureMode: input.config.setup.exposure.mode,
    exposureBaseDomain: input.config.setup.exposure.baseDomain,
    routeBindIps: [
      ...input.config.routing.locations.map((location) => location.bindIp),
      ...nextRouteBindIps,
    ],
    artifactPath: input.configPath,
  });

  if (!validated.ok) {
    return {
      ok: false,
      phase: validated.phase,
      source: validated.source,
      message: validated.message,
      configPath: input.configPath,
      ...(validated.cause ? { cause: validated.cause } : {}),
    };
  }

  return {
    ok: true,
    routeBindIps: validated.routeBindIps.slice(input.config.routing.locations.length),
  };
}

function incrementIpv4Address(value: string): string {
  const segments = value.split('.').map((segment) => Number(segment));

  if (
    segments.length !== 4 ||
    segments.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)
  ) {
    throw new Error(`Cannot derive the next bind IP from ${value}.`);
  }

  let numericValue = 0;
  segments.forEach((segment) => {
    numericValue = (numericValue << 8) + segment;
  });

  if (numericValue >= 0xffffffff) {
    throw new Error(`Cannot derive the next bind IP from ${value}.`);
  }

  const nextValue = numericValue + 1;
  return [24, 16, 8, 0].map((shift) => String((nextValue >> shift) & 255)).join('.');
}

function createProvisionedRouteConfig(input: {
  readonly route: PlannedSetupRoute;
  readonly relay: MullvadRelay;
  readonly providers: readonly string[];
}): MullgateConfig['routing']['locations'][number] {
  return {
    alias: input.route.alias,
    hostname: input.route.hostname,
    bindIp: input.route.bindIp,
    relayPreference: structuredClone(input.route.relayPreference),
    mullvad: {
      relayConstraints: {
        providers: [...input.providers],
      },
      exit: {
        relayHostname: input.relay.hostname,
        relayFqdn: input.relay.fqdn,
        socksHostname: requireDefined(
          input.relay.socksName,
          `Expected relay ${input.relay.hostname} to include a SOCKS hostname.`,
        ),
        socksPort: requireDefined(
          input.relay.socksPort,
          `Expected relay ${input.relay.hostname} to include a SOCKS port.`,
        ),
        countryCode: input.relay.location.countryCode,
        cityCode: input.relay.location.cityCode,
      },
    },
    runtime: {
      routeId: input.route.routeId,
      httpsBackendName: `route-${input.route.routeId}`,
    },
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

async function resolveProxyExportOutputPath(input: {
  readonly outputPath: string;
  readonly force: boolean;
  readonly guided: boolean;
  readonly configPath: string;
}): Promise<
  | {
      readonly ok: true;
      readonly displayPath: string;
      readonly absolutePath: string;
    }
  | ProxyExportFailure
> {
  let displayPath = input.outputPath.startsWith('./') ? input.outputPath : input.outputPath;
  let absolutePath = path.resolve(process.cwd(), input.outputPath);

  if (input.force || !(await fileExists(absolutePath))) {
    return {
      ok: true,
      displayPath,
      absolutePath,
    };
  }

  if (!input.guided) {
    return {
      ok: false,
      phase: 'persist-file',
      source: 'filesystem',
      message: 'Refusing to overwrite an existing proxy export file without --force.',
      configPath: input.configPath,
      artifactPath: absolutePath,
    };
  }

  const prompts = createGuidedPromptClient();

  try {
    while (true) {
      const overwrite = await prompts.confirm({
        message: describePromptStep(
          `Output file ${displayPath} already exists. Overwrite it?`,
          'Choose overwrite to replace it now, or pick a new destination path.',
        ),
        initialValue: false,
        active: 'Overwrite',
        inactive: 'Choose another path',
      });

      if (overwrite === GUIDED_PROMPT_CANCELLED) {
        prompts.cancel('Guided export cancelled.');
        return {
          ok: false,
          phase: 'persist-file',
          source: 'user-input',
          message: 'Guided export cancelled before Mullgate wrote any proxy file.',
          configPath: input.configPath,
          artifactPath: absolutePath,
        };
      }

      if (overwrite) {
        return {
          ok: true,
          displayPath,
          absolutePath,
        };
      }

      const nextPath = await prompts.text({
        message: describePromptStep(
          'Choose a different output path',
          'Pick a new file path for the proxy list.',
        ),
        initialValue: 'proxies.txt',
        validate: (value) =>
          readOptionalString(value) ? undefined : 'Output path is required when writing a file.',
      });

      if (nextPath === GUIDED_PROMPT_CANCELLED) {
        prompts.cancel('Guided export cancelled.');
        return {
          ok: false,
          phase: 'persist-file',
          source: 'user-input',
          message: 'Guided export cancelled before Mullgate wrote any proxy file.',
          configPath: input.configPath,
          artifactPath: absolutePath,
        };
      }

      displayPath = nextPath.trim();
      absolutePath = path.resolve(process.cwd(), displayPath);

      if (!(await fileExists(absolutePath))) {
        return {
          ok: true,
          displayPath,
          absolutePath,
        };
      }
    }
  } finally {
    await prompts.close();
  }
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

function createGuidedPromptClient(): GuidedPromptClient {
  if (process.stdin.isTTY && process.stderr.isTTY) {
    return {
      intro: (message) => {
        intro(message, { input: process.stdin, output: process.stderr });
      },
      outro: (message) => {
        outro(message, { input: process.stdin, output: process.stderr });
      },
      cancel: (message) => {
        clackCancel(message, { input: process.stdin, output: process.stderr });
      },
      text: async (options) => {
        const result = await text({
          message: options.message,
          ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
          ...(options.placeholder ? { placeholder: options.placeholder } : {}),
          ...(options.validate ? { validate: options.validate } : {}),
          input: process.stdin,
          output: process.stderr,
        });

        return isCancel(result) ? GUIDED_PROMPT_CANCELLED : result;
      },
      select: async (options) => {
        const result =
          options.options.length > 15
            ? await autocomplete({
                message: options.message,
                options: [...options.options],
                ...(options.initialValue !== undefined
                  ? { initialValue: options.initialValue }
                  : {}),
                ...(options.placeholder ? { placeholder: options.placeholder } : {}),
                input: process.stdin,
                output: process.stderr,
              })
            : await select({
                message: options.message,
                options: [...options.options],
                ...(options.initialValue !== undefined
                  ? { initialValue: options.initialValue }
                  : {}),
                input: process.stdin,
                output: process.stderr,
              });

        return isCancel(result) ? GUIDED_PROMPT_CANCELLED : result;
      },
      multiselect: async (options) => {
        const result = await autocompleteMultiselect({
          message: options.message,
          options: [...options.options],
          ...(options.initialValues ? { initialValues: [...options.initialValues] } : {}),
          ...(options.required !== undefined ? { required: options.required } : {}),
          ...(options.placeholder ? { placeholder: options.placeholder } : {}),
          input: process.stdin,
          output: process.stderr,
        });

        return isCancel(result) ? GUIDED_PROMPT_CANCELLED : result;
      },
      confirm: async (options) => {
        const result = await confirm({
          message: options.message,
          ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
          ...(options.active ? { active: options.active } : {}),
          ...(options.inactive ? { inactive: options.inactive } : {}),
          input: process.stdin,
          output: process.stderr,
        });

        return isCancel(result) ? GUIDED_PROMPT_CANCELLED : result;
      },
      close: async () => {},
    };
  }

  let bufferedLinesPromise: Promise<string[]> | null = null;

  async function nextBufferedLine(): Promise<string | null> {
    if (!bufferedLinesPromise) {
      bufferedLinesPromise = readAllStdinLines();
    }

    const bufferedLines = await bufferedLinesPromise;
    return bufferedLines.shift() ?? null;
  }

  return {
    intro: (message) => {
      process.stderr.write(`${message}\n`);
    },
    outro: (message) => {
      process.stderr.write(`${message}\n`);
    },
    cancel: (message) => {
      process.stderr.write(`${message}\n`);
    },
    text: async (options) => {
      while (true) {
        const renderedDefault = options.initialValue ? ` [${options.initialValue}]` : '';
        process.stderr.write(`${options.message}${renderedDefault}: `);
        const answer = await nextBufferedLine();

        if (answer === null) {
          process.stderr.write('\n');
          return GUIDED_PROMPT_CANCELLED;
        }

        const value = answer.trim().length > 0 ? answer : (options.initialValue ?? '');
        const validationError = options.validate?.(value);

        if (!validationError) {
          process.stderr.write('\n');
          return value;
        }

        process.stderr.write(`\n${validationError}\n`);
      }
    },
    select: async (options) => {
      const optionLookup = new Map(
        options.options.flatMap((option, index) => [
          [option.value.toLowerCase(), option.value],
          [String(index + 1), option.value],
          [option.label.toLowerCase(), option.value],
        ]),
      );

      while (true) {
        process.stderr.write(`${options.message}\n`);
        options.options.forEach((option, index) => {
          process.stderr.write(
            `  ${index + 1}. ${option.label}${option.hint ? ` - ${option.hint}` : ''}\n`,
          );
        });
        process.stderr.write('Select one option: ');
        const answer = await nextBufferedLine();

        if (answer === null) {
          process.stderr.write('\n');
          return GUIDED_PROMPT_CANCELLED;
        }

        const resolved = optionLookup.get(answer.trim().toLowerCase());

        if (resolved) {
          process.stderr.write('\n');
          return resolved;
        }

        process.stderr.write('\nEnter an option number or value from the list.\n');
      }
    },
    multiselect: async (options) => {
      const optionLookup = new Map(
        options.options.flatMap((option, index) => [
          [option.value.toLowerCase(), option.value],
          [String(index + 1), option.value],
          [option.label.toLowerCase(), option.value],
        ]),
      );

      while (true) {
        process.stderr.write(`${options.message}\n`);
        options.options.forEach((option, index) => {
          process.stderr.write(
            `  ${index + 1}. ${option.label}${option.hint ? ` - ${option.hint}` : ''}\n`,
          );
        });
        process.stderr.write('Select one or more options (comma-separated, blank for none): ');
        const answer = await nextBufferedLine();

        if (answer === null) {
          process.stderr.write('\n');
          return GUIDED_PROMPT_CANCELLED;
        }

        const selections = answer
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0)
          .map((entry) => optionLookup.get(entry))
          .filter(isDefined);

        if (selections.length === 0 && options.required) {
          process.stderr.write('\nSelect at least one option.\n');
          continue;
        }

        if (answer.trim().length > 0 && selections.length === 0) {
          process.stderr.write('\nEnter option numbers or values from the list.\n');
          continue;
        }

        process.stderr.write('\n');
        return [...new Set(selections)];
      }
    },
    confirm: async (options) => {
      while (true) {
        const suffix = options.initialValue ? ' [Y/n]' : ' [y/N]';
        process.stderr.write(`${options.message}${suffix}: `);
        const answer = await nextBufferedLine();

        if (answer === null) {
          process.stderr.write('\n');
          return GUIDED_PROMPT_CANCELLED;
        }

        const normalizedAnswer = answer.trim().toLowerCase();

        if (!normalizedAnswer) {
          process.stderr.write('\n');
          return options.initialValue ?? false;
        }

        if (['y', 'yes'].includes(normalizedAnswer)) {
          process.stderr.write('\n');
          return true;
        }

        if (['n', 'no'].includes(normalizedAnswer)) {
          process.stderr.write('\n');
          return false;
        }

        process.stderr.write('\nEnter yes or no.\n');
      }
    },
    close: async () => {},
  };
}

function validateProxyExportSelectorCountInput(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase() ?? '';

  if (normalized === 'all') {
    return undefined;
  }

  try {
    parseProxyExportCount(normalized);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseProxyExportWriteMode(value: string): ProxyExportWriteMode {
  const normalized = value.trim().toLowerCase();

  if (normalized === 'file' || normalized === 'stdout' || normalized === 'dry-run') {
    return normalized;
  }

  return 'file';
}

function parseProxyExportSelectorType(value: string): ProxyExportSelector['kind'] {
  return value.trim().toLowerCase() === 'region' ? 'region' : 'country';
}

function parseGuidedProxyExportCount(value: string): number | null {
  return value.trim().toLowerCase() === 'all' ? null : parseProxyExportCount(value);
}

export function parseRelayOwnerFilter(raw: string): RelayOwnerFilter {
  const normalized = raw.trim().toLowerCase();

  if (normalized === 'mullvad' || normalized === 'rented' || normalized === 'all') {
    return normalized;
  }

  throw new Error('Relay ownership must be one of mullvad, rented, or all.');
}

export function parseRelayRunModeFilter(raw: string): RelayRunModeFilter {
  const normalized = raw.trim().toLowerCase();

  if (normalized === 'ram' || normalized === 'disk' || normalized === 'all') {
    return normalized;
  }

  throw new Error('Relay run mode must be one of ram, disk, or all.');
}

function parseProxyExportMinPortSpeed(raw: string): number {
  const value = Number(raw.trim());

  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Minimum port speed must be a positive integer.');
  }

  return value;
}

async function validateSavedConfig(input: {
  store: ConfigStore;
  refresh: boolean;
}): Promise<ConfigValidationResult> {
  const loadResult = await input.store.load();

  if (!loadResult.ok) {
    return {
      ok: false,
      phase: loadResult.phase,
      source: loadResult.source,
      message: loadResult.message,
      artifactPath: loadResult.artifactPath,
    };
  }

  if (loadResult.source === 'empty') {
    return {
      ok: false,
      phase: 'load-config',
      source: loadResult.source,
      message: loadResult.message,
      artifactPath: input.store.paths.configFile,
    };
  }

  const httpsCheck = await verifyHttpsAssets({
    enabled: loadResult.config.setup.https.enabled,
    certPath: loadResult.config.setup.https.certPath,
    keyPath: loadResult.config.setup.https.keyPath,
  });

  if (!httpsCheck.ok) {
    const errored = withRuntimeStatus(
      loadResult.config,
      'error',
      new Date().toISOString(),
      httpsCheck.message,
    );
    await saveRuntimeStatus(input.store, errored);

    return {
      ok: false,
      phase: httpsCheck.phase,
      source: httpsCheck.source,
      message: httpsCheck.message,
      ...(httpsCheck.artifactPath ? { artifactPath: httpsCheck.artifactPath } : {}),
      ...(httpsCheck.cause ? { cause: httpsCheck.cause } : {}),
    };
  }

  const hasExistingRuntimeArtifacts = await Promise.all([
    fileExists(input.store.paths.entryWireproxyConfigFile),
    fileExists(input.store.paths.routeProxyConfigFile),
  ]).then(([entryExists, routeProxyExists]) => entryExists && routeProxyExists);
  const shouldRefresh =
    input.refresh ||
    loadResult.config.runtime.status.phase === 'unvalidated' ||
    !hasExistingRuntimeArtifacts;

  let entryWireproxyConfigPath = input.store.paths.entryWireproxyConfigFile;
  let entryWireproxyConfigText: string | undefined;
  let routeProxyConfigPath = input.store.paths.routeProxyConfigFile;
  let routeProxyConfigText: string | undefined;
  let refreshedArtifacts = false;

  if (shouldRefresh) {
    const relayCatalog = await loadStoredRelayCatalog(input.store.paths.provisioningCacheFile);

    if (!relayCatalog.ok) {
      const errored = withRuntimeStatus(
        loadResult.config,
        'error',
        new Date().toISOString(),
        relayCatalog.message,
      );
      await saveRuntimeStatus(input.store, errored);

      return {
        ok: false,
        phase: relayCatalog.phase,
        source: relayCatalog.source,
        message: relayCatalog.message,
        artifactPath: relayCatalog.artifactPath,
        ...(relayCatalog.cause ? { cause: relayCatalog.cause } : {}),
      };
    }

    const renderResult = await renderRuntimeProxyArtifacts({
      config: loadResult.config,
      relayCatalog: relayCatalog.value,
      paths: input.store.paths,
    });

    if (!renderResult.ok) {
      const errored = withRuntimeStatus(
        loadResult.config,
        'error',
        renderResult.checkedAt,
        renderResult.message,
      );
      await saveRuntimeStatus(input.store, errored);

      return {
        ok: false,
        phase: renderResult.phase,
        source: renderResult.source,
        message: renderResult.message,
        ...(renderResult.artifactPath ? { artifactPath: renderResult.artifactPath } : {}),
        ...(renderResult.cause ? { cause: renderResult.cause } : {}),
      };
    }

    entryWireproxyConfigPath = renderResult.artifactPaths.entryWireproxyConfigPath;
    entryWireproxyConfigText = renderResult.entryWireproxyConfig;
    routeProxyConfigPath = renderResult.artifactPaths.routeProxyConfigPath;
    routeProxyConfigText = renderResult.routeProxyConfig;
    refreshedArtifacts = true;
  } else {
    [entryWireproxyConfigText, routeProxyConfigText] = await Promise.all([
      readFile(entryWireproxyConfigPath, 'utf8'),
      readFile(routeProxyConfigPath, 'utf8'),
    ]);
  }

  const validationResult = await validateRuntimeArtifacts({
    entryWireproxyConfigPath,
    entryWireproxyConfigText,
    routeProxyConfigPath,
    routeProxyConfigText,
    routes: buildRuntimeValidationRoutes(loadResult.config),
    bind: {
      socksPort: loadResult.config.setup.bind.socksPort,
      httpPort: loadResult.config.setup.bind.httpPort,
    },
    reportPath: input.store.paths.runtimeValidationReportFile,
  });

  const updatedConfig = withRuntimeStatus(
    loadResult.config,
    validationResult.ok ? 'validated' : 'error',
    validationResult.checkedAt,
    validationResult.ok
      ? `Validated via ${summarizeValidationSource(validationResult)}.`
      : `Validation failed via ${summarizeValidationSource(validationResult)}: ${validationResult.cause}`,
  );

  const saveResult = await saveRuntimeStatus(input.store, updatedConfig);

  if (!saveResult.ok) {
    return saveResult;
  }

  if (!validationResult.ok) {
    return {
      ok: false,
      phase: validationResult.phase,
      source: validationResult.source,
      message: validationResult.cause,
      artifactPath: validationResult.target,
      cause: validationResult.issues.map((issue) => issue.message).join('; '),
    };
  }

  return {
    ok: true,
    phase: validationResult.phase,
    source: validationResult.source,
    refreshedArtifacts,
    config: updatedConfig,
    artifactPath: input.store.paths.entryWireproxyConfigFile,
    reportPath: validationResult.reportPath ?? input.store.paths.runtimeValidationReportFile,
    message: `Validated via ${summarizeValidationSource(validationResult)}.`,
  };
}

function buildRuntimeValidationRoutes(config: MullgateConfig) {
  return config.routing.locations.map((route, index) => ({
    routeIndex: index,
    routeId: route.runtime.routeId,
    routeAlias: route.alias,
    routeHostname: route.hostname,
    routeBindIp: route.bindIp,
    routeListenHost: deriveRuntimeListenerHost(config.setup.exposure.mode, route.bindIp),
    routeSocksPort: computePublishedPort(
      config.setup.exposure.mode,
      config.setup.bind.socksPort,
      index,
    ),
    routeHttpPort: computePublishedPort(
      config.setup.exposure.mode,
      config.setup.bind.httpPort,
      index,
    ),
    httpsBackendName: route.runtime.httpsBackendName,
    exitRelayHostname: route.mullvad.exit.relayHostname,
    exitRelayFqdn: route.mullvad.exit.relayFqdn,
    exitSocksHostname: route.mullvad.exit.socksHostname,
    exitSocksPort: route.mullvad.exit.socksPort,
    entryParent: {
      host: '127.0.0.1' as const,
      port: ENTRY_WIREPROXY_SOCKS_PORT,
    },
  }));
}

async function saveRuntimeStatus(
  store: ConfigStore,
  config: MullgateConfig,
): Promise<{ ok: true } | ConfigValidationFailure> {
  try {
    await store.save(config);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      phase: 'persist-config',
      source: 'filesystem',
      message: 'Failed to persist updated Mullgate runtime status.',
      artifactPath: store.paths.configFile,
      cause: error instanceof Error ? error.message : String(error),
    };
  }
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

function renderValidationSuccess(result: ConfigValidationSuccess): string {
  return [
    'Mullgate validate complete.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    `artifact: ${result.artifactPath}`,
    `report: ${result.reportPath}`,
    `artifacts refreshed: ${result.refreshedArtifacts ? 'yes' : 'no'}`,
    `runtime status: ${result.config.runtime.status.phase}`,
    `reason: ${result.message}`,
  ].join('\n');
}

function renderValidationError(result: ConfigValidationFailure): string {
  return [
    'Mullgate validate failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    ...(result.artifactPath ? [`artifact: ${result.artifactPath}`] : []),
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
  ].join('\n');
}

function formatOutputValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function getConfigValue(
  config: MullgateConfig,
  keyPath: string,
): { found: true; value: unknown } | { found: false } {
  let current: unknown = config;

  for (const segment of keyPath.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return { found: false };
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return { found: true, value: current };
}

function setConfigValue(config: MullgateConfig, keyPath: string, value: unknown): void {
  const segments = keyPath.split('.');
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = requireArrayValue(segments, index, `Config path ${keyPath} is not writable.`);
    const next = current[segment];

    if (!next || typeof next !== 'object') {
      throw new Error(`Config path ${keyPath} is not writable.`);
    }

    current = next as Record<string, unknown>;
  }

  const finalSegment = requireDefined(segments.at(-1), `Config path ${keyPath} is not writable.`);
  current[finalSegment] = value;
}

function applyPostSetNormalization(config: MullgateConfig, changedPath: string): void {
  if (changedPath === 'setup.location.requested') {
    config.setup.location = {
      requested: config.setup.location.requested,
      resolvedAlias: null,
    };
  }

  if (changedPath === 'setup.bind.httpsPort') {
    if (config.setup.bind.httpsPort === null) {
      config.setup.https = {
        enabled: false,
      };
    } else {
      config.setup.https = {
        ...config.setup.https,
        enabled: true,
      };
    }
  }

  if (changedPath === 'setup.https.enabled') {
    if (!config.setup.https.enabled) {
      config.setup.https = {
        enabled: false,
      };
      config.setup.bind.httpsPort = null;
    } else if (config.setup.bind.httpsPort === null) {
      config.setup.bind.httpsPort = DEFAULT_HTTPS_PORT;
    }
  }

  if (changedPath === 'setup.https.certPath' || changedPath === 'setup.https.keyPath') {
    const hasCert = Boolean(config.setup.https.certPath);
    const hasKey = Boolean(config.setup.https.keyPath);
    config.setup.https.enabled = hasCert || hasKey;

    if (config.setup.https.enabled && config.setup.bind.httpsPort === null) {
      config.setup.bind.httpsPort = DEFAULT_HTTPS_PORT;
    }

    if (!config.setup.https.enabled) {
      config.setup.bind.httpsPort = null;
    }
  }
}

function hasExposureUpdate(options: ExposureCommandOptions): boolean {
  return Boolean(
    options.mode ||
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

function collectRepeatedValues(value: string, previous: string[]): string[] {
  return [...previous, value.trim()].filter((entry) => entry.length > 0);
}

export function extractOrderedCommandArgs(input: {
  readonly argv: readonly string[];
  readonly commandPath: readonly string[];
}): string[] {
  if (input.commandPath.length === 0) {
    return [];
  }

  for (let index = 0; index <= input.argv.length - input.commandPath.length; index += 1) {
    const matches = input.commandPath.every(
      (segment, offset) => input.argv[index + offset] === segment,
    );

    if (matches) {
      return input.argv.slice(index + input.commandPath.length);
    }
  }

  return [];
}

export function extractProxyExportArgs(argv: readonly string[]): string[] {
  const proxyExport = extractOrderedCommandArgs({
    argv,
    commandPath: ['proxy', 'export'],
  });

  if (proxyExport.length > 0) {
    return proxyExport;
  }

  const topLevel = extractOrderedCommandArgs({
    argv,
    commandPath: ['export'],
  });

  if (topLevel.length > 0) {
    return topLevel;
  }

  return extractOrderedCommandArgs({
    argv,
    commandPath: ['config', 'export'],
  });
}

function parseProxyExportProtocol(raw: string | undefined): ProxyExportProtocol {
  const normalized = raw?.trim().toLowerCase() ?? 'socks5';

  if (normalized === 'socks5' || normalized === 'http' || normalized === 'https') {
    return normalized;
  }

  throw new Error('Protocol must be one of socks5, http, or https.');
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

function buildProxyExportFilename(input: {
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelector[];
}): string {
  if (input.selectors.length === 0) {
    return `proxy-${input.protocol}-all.txt`;
  }

  const selectorSlug = input.selectors
    .map((selector) =>
      [
        selector.kind,
        selector.value,
        ...(selector.city ? [selector.city] : []),
        ...(selector.server ? [selector.server] : []),
        ...(selector.providers.length > 0 ? [selector.providers.join('-')] : []),
        ...(selector.owner !== 'all' ? [selector.owner] : []),
        ...(selector.runMode !== 'all' ? [selector.runMode] : []),
        ...(selector.minPortSpeed !== null ? [`speed-${selector.minPortSpeed}`] : []),
        selector.requestedCount ?? 'all',
      ].join('-'),
    )
    .join('--');

  return `proxy-${input.protocol}-${selectorSlug}.txt`;
}

function matchesProxyExportSelector(input: {
  readonly selector: ProxyExportSelector;
  readonly entry: ProxyExportEntry;
}): boolean {
  if (!input.entry.countryCode) {
    return false;
  }

  if (
    input.selector.providers.length > 0 &&
    (!input.entry.provider ||
      !input.selector.providers.some(
        (provider) => provider.toLowerCase() === input.entry.provider?.toLowerCase(),
      ))
  ) {
    return false;
  }

  if (input.selector.owner !== 'all' && input.entry.owner !== input.selector.owner) {
    return false;
  }

  if (input.selector.runMode !== 'all' && input.entry.runMode !== input.selector.runMode) {
    return false;
  }

  if (
    input.selector.minPortSpeed !== null &&
    (input.entry.portSpeed ?? 0) < input.selector.minPortSpeed
  ) {
    return false;
  }

  if (input.selector.kind === 'country') {
    if (input.entry.countryCode !== input.selector.value) {
      return false;
    }

    if (input.selector.city && input.entry.cityCode !== input.selector.city) {
      return false;
    }

    if (input.selector.server && input.entry.relayHostname !== input.selector.server) {
      return false;
    }

    return true;
  }

  const regionCountryCodes = resolveRegionCountryCodes(input.selector.value);
  return regionCountryCodes ? regionCountryCodes.includes(input.entry.countryCode) : false;
}

function createProxyExportUrl(input: {
  readonly protocol: ProxyExportProtocol;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
}): string {
  return `${input.protocol}://${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}@${input.hostname}:${input.port}`;
}

function normalizeProxyExportSelectorValue(
  value: string,
  kind: ProxyExportSelector['kind'],
): string {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    throw new Error(`A non-empty ${kind} selector value is required.`);
  }

  return normalized;
}

function parseProxyExportCount(raw: string): number {
  const value = Number(raw.trim());

  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Selector counts must be positive integers.');
  }

  return value;
}

function readCliOptionValue(input: {
  readonly flag: string;
  readonly token: string;
  readonly nextToken: string | undefined;
}):
  | {
      readonly matched: true;
      readonly value: string;
      readonly consumedNextToken: boolean;
    }
  | {
      readonly matched: false;
      readonly consumedNextToken: false;
    } {
  if (input.token === input.flag) {
    if (!input.nextToken || input.nextToken.startsWith('--')) {
      throw new Error(`${input.flag} requires a value.`);
    }

    return {
      matched: true,
      value: input.nextToken,
      consumedNextToken: true,
    };
  }

  if (input.token.startsWith(`${input.flag}=`)) {
    return {
      matched: true,
      value: input.token.slice(input.flag.length + 1),
      consumedNextToken: false,
    };
  }

  return {
    matched: false,
    consumedNextToken: false,
  };
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseRequiredString(raw: string): string {
  const value = raw.trim();

  if (!value) {
    throw new Error('A non-empty string value is required.');
  }

  return value;
}

function parseNullableString(raw: string, options: { json: boolean }): string | null {
  if (options.json) {
    const parsed = JSON.parse(raw) as unknown;

    if (parsed === null) {
      return null;
    }

    if (typeof parsed === 'string' && parsed.trim().length > 0) {
      return parsed.trim();
    }

    throw new Error('Expected JSON string or null.');
  }

  const value = raw.trim();
  return value === '' || value === 'null' ? null : value;
}

function parsePort(raw: string, options?: { json: boolean }): number {
  const value = parseNumber(raw, options?.json ?? false);

  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('Ports must be integers between 1 and 65535.');
  }

  return value;
}

function parseNullablePort(raw: string, options: { json: boolean }): number | null {
  if (!options.json && (raw.trim() === '' || raw.trim() === 'null')) {
    return null;
  }

  if (options.json) {
    const parsed = JSON.parse(raw) as unknown;

    if (parsed === null) {
      return null;
    }

    if (typeof parsed === 'number') {
      return parsePort(String(parsed));
    }

    throw new Error('Expected JSON number or null.');
  }

  return parsePort(raw);
}

function parseBoolean(raw: string, options: { json: boolean }): boolean {
  if (options.json) {
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'boolean') {
      throw new Error('Expected JSON boolean.');
    }

    return parsed;
  }

  const value = raw.trim().toLowerCase();

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error('Boolean values must be true or false.');
}

function parseStringArray(raw: string, options: { json: boolean }): string[] {
  if (options.json) {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
      throw new Error('Expected JSON array of strings.');
    }

    return parsed.map((value) => value.trim()).filter((value) => value.length > 0);
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseNumber(raw: string, json: boolean): number {
  if (json) {
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'number') {
      throw new Error('Expected JSON number.');
    }

    return parsed;
  }

  const numeric = Number(raw.trim());

  if (!Number.isFinite(numeric)) {
    throw new Error('Expected a numeric value.');
  }

  return numeric;
}

async function readStdinValue(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () =>
      resolve(
        Buffer.concat(chunks)
          .toString('utf8')
          .replace(/\r?\n$/, ''),
      ),
    );
    process.stdin.on('error', reject);
  });
}

async function readAllStdinLines(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8').split(/\r?\n/));
    });
    process.stdin.on('error', reject);
  });
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
