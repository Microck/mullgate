import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cancel as clackCancel, confirm, intro, isCancel, outro, text } from '@clack/prompts';
import type { Command } from 'commander';
import {
  loadStoredRelayCatalog,
  summarizeValidationSource,
  verifyHttpsAssets,
  withRuntimeStatus,
} from '../app/setup-runner.js';
import {
  buildExposureContract,
  deriveExposureHostname,
  type ExposureValidationFailure,
  normalizeExposureBaseDomain,
  validateExposureSettings,
} from '../config/exposure-contract.js';
import { formatRedactedConfig, REDACTED, redactConfig } from '../config/redact.js';
import type { ExposureMode, MullgateConfig } from '../config/schema.js';
import { ConfigStore, type LoadConfigResult, syncLegacyMirrorsToRouting } from '../config/store.js';
import {
  listRegionGroupNames,
  listRegionGroups,
  resolveRegionCountryCodes,
} from '../domain/region-groups.js';
import { buildPlatformSupportContract } from '../platform/support-contract.js';
import { renderWireproxyArtifacts } from '../runtime/render-wireproxy.js';
import { validateWireproxyConfig } from '../runtime/validate-wireproxy.js';

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
  readonly source: 'wireproxy-binary' | 'docker' | 'internal-syntax';
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

type ProxyExportProtocol = 'socks5' | 'http' | 'https';

type ProxyExportSelector = {
  readonly kind: 'country' | 'region';
  readonly value: string;
  readonly requestedCount: number | null;
};

type ProxyExportSelectorResult = ProxyExportSelector & {
  readonly matchedCount: number;
  readonly exportedCount: number;
};

type ProxyExportEntry = {
  readonly routeIndex: number;
  readonly alias: string;
  readonly hostname: string;
  readonly countryCode: string | null;
  readonly url: string;
  readonly redactedUrl: string;
};

type ProxyExportPlanSuccess = {
  readonly ok: true;
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelectorResult[];
  readonly entries: readonly ProxyExportEntry[];
  readonly outputText: string;
  readonly redactedOutputText: string;
  readonly suggestedFilename: string;
};

type ProxyExportFailure = {
  readonly ok: false;
  readonly phase: string;
  readonly source: string;
  readonly message: string;
  readonly configPath?: string;
  readonly artifactPath?: string;
  readonly cause?: string;
};

type ProxyExportPlanResult = ProxyExportPlanSuccess | ProxyExportFailure;

type ProxyExportWriteMode = 'file' | 'stdout' | 'dry-run';

type ProxyExportResolvedInput = {
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
  readonly dryRun?: boolean;
  readonly stdout?: boolean;
  readonly force?: boolean;
};

const GUIDED_PROMPT_CANCELLED = Symbol('guided-prompt-cancelled');

type PromptTextOptions = {
  readonly message: string;
  readonly initialValue?: string;
  readonly placeholder?: string;
  readonly validate?: (value: string | undefined) => string | undefined;
};

type PromptConfirmOptions = {
  readonly message: string;
  readonly initialValue?: boolean;
  readonly active?: string;
  readonly inactive?: string;
};

type GuidedPromptClient = {
  readonly intro: (message: string) => void;
  readonly outro: (message: string) => void;
  readonly cancel: (message: string) => void;
  readonly text: (options: PromptTextOptions) => Promise<string | typeof GUIDED_PROMPT_CANCELLED>;
  readonly confirm: (
    options: PromptConfirmOptions,
  ) => Promise<boolean | typeof GUIDED_PROMPT_CANCELLED>;
  readonly close: () => Promise<void>;
};

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Inspect or update saved Mullgate configuration and derived paths.');

  config
    .command('path')
    .description('Show the resolved Mullgate config/state/cache/runtime paths.')
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

  config
    .command('locations')
    .description(
      'List routed location aliases, bind IPs, relay preferences, and runtime ids without secrets.',
    )
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

      process.stdout.write(`${renderLocationsReport(result.config, store.paths.configFile)}\n`);
    });

  config
    .command('hosts')
    .description(
      'List configured proxy hostnames and their route bind IP mappings without secrets.',
    )
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

      process.stdout.write(`${renderHostsReport(result.config, store.paths.configFile)}\n`);
    });

  config
    .command('regions')
    .description('List the curated export region groups and their member country codes.')
    .action(() => {
      process.stdout.write(`${renderRegionGroupsReport()}\n`);
    });

  config
    .command('exposure')
    .option('--mode <mode>', 'Set exposure mode to loopback, private-network, or public.')
    .option('--base-domain <domain>', 'Set the base domain used to derive per-route hostnames.')
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
      'Inspect or update remote exposure mode, bind IPs, DNS guidance, and restart status without raw JSON edits.',
    )
    .action(async (options: ExposureCommandOptions) => {
      const store = new ConfigStore();
      const result = await store.load();

      if (!result.ok) {
        process.stderr.write(`${renderLoadError(result)}\n`);
        process.exitCode = 1;
        return;
      }

      if (result.source === 'empty') {
        process.stderr.write(`${renderMissingConfig(result.message, store.paths.configFile)}\n`);
        process.exitCode = 1;
        return;
      }

      if (!hasExposureUpdate(options)) {
        process.stdout.write(`${renderExposureReport(result.config, store.paths.configFile)}\n`);
        return;
      }

      if (options.baseDomain !== undefined && options.clearBaseDomain) {
        process.stderr.write(
          `${renderExposureUpdateError({
            ok: false,
            phase: 'setup-validation',
            source: 'input',
            code: 'AMBIGUOUS_BASE_DOMAIN',
            message: 'Pass --base-domain or --clear-base-domain, not both.',
            artifactPath: store.paths.configFile,
          })}\n`,
        );
        process.exitCode = 1;
        return;
      }

      let mode: ExposureMode | undefined;

      if (options.mode !== undefined) {
        try {
          mode = parseExposureModeOption(options.mode);
        } catch (error) {
          process.stderr.write(
            `${renderExposureUpdateError({
              ok: false,
              phase: 'setup-validation',
              source: 'input',
              code: 'INVALID_EXPOSURE_MODE',
              message: error instanceof Error ? error.message : String(error),
              artifactPath: store.paths.configFile,
            })}\n`,
          );
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
        process.stderr.write(`${renderExposureUpdateError(updateResult)}\n`);
        process.exitCode = 1;
        return;
      }

      try {
        await store.save(updateResult.config);
      } catch (error) {
        process.stderr.write(
          `${renderValidationError({
            ok: false,
            phase: 'persist-config',
            source: 'filesystem',
            message: 'Failed to persist the updated exposure contract.',
            artifactPath: store.paths.configFile,
            cause: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        `${renderExposureUpdateSuccess(updateResult.config, store.paths.configFile)}\n`,
      );
    });

  config
    .command('export')
    .option('--protocol <protocol>', 'Export proxy URLs for socks5, http, or https.')
    .option(
      '--country <code>',
      'Add a country selector. Pair it with a following --count to cap that selector.',
    )
    .option(
      '--region <name>',
      `Add a curated region selector (${listRegionGroupNames().join(', ')}). Pair it with a following --count to cap that selector.`,
    )
    .option(
      '--count <number>',
      'Apply a per-selector export cap to the immediately preceding --country or --region.',
    )
    .option('--guided', 'Launch a guided export flow, like setup, for creating proxy lists.')
    .option('--dry-run', 'Preview a secret-safe export summary without writing a file.')
    .option('--stdout', 'Write the exported proxy URLs to stdout instead of a file.')
    .option('--force', 'Overwrite an existing output file.')
    .option('--output <path>', 'Write the export to this path instead of using an auto filename.')
    .description(
      'Export proxy URLs to a text file with ordered country/region selectors and deterministic dedupe.',
    )
    .action(async (options: ProxyExportCommandOptions) => {
      const store = new ConfigStore();
      const result = await store.load();

      if (!result.ok) {
        process.stderr.write(
          `${renderProxyExportError({
            ok: false,
            phase: result.phase,
            source: result.source,
            message: result.message,
            artifactPath: result.artifactPath,
          })}\n`,
        );
        process.exitCode = 1;
        return;
      }

      if (result.source === 'empty') {
        process.stderr.write(
          `${renderProxyExportError({
            ok: false,
            phase: 'load-config',
            source: 'empty',
            message: result.message,
            configPath: store.paths.configFile,
          })}\n`,
        );
        process.exitCode = 1;
        return;
      }

      try {
        const selectorResult = parseProxyExportSelectors(extractConfigExportArgs(process.argv));

        if (!selectorResult.ok) {
          process.stderr.write(
            `${renderProxyExportError({
              ...selectorResult,
              configPath: store.paths.configFile,
            })}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const resolvedInput = await resolveProxyExportInput({
          options,
          selectors: selectorResult.selectors,
          configPath: store.paths.configFile,
        });

        if (!resolvedInput.ok) {
          process.stderr.write(`${renderProxyExportError(resolvedInput)}\n`);
          process.exitCode = 1;
          return;
        }

        const exportInput = resolvedInput.value;

        const exportPlan = buildProxyExportPlan({
          config: result.config,
          protocol: exportInput.protocol,
          selectors: exportInput.selectors,
          configPath: store.paths.configFile,
        });

        if (!exportPlan.ok) {
          process.stderr.write(`${renderProxyExportError(exportPlan)}\n`);
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
          process.stderr.write(`${renderProxyExportError(deliveryResult)}\n`);
          process.exitCode = 1;
          return;
        }
      } catch (error) {
        process.stderr.write(
          `${renderProxyExportError({
            ok: false,
            phase: 'export-proxies',
            source: 'input',
            message: error instanceof Error ? error.message : String(error),
            configPath: store.paths.configFile,
          })}\n`,
        );
        process.exitCode = 1;
      }
    });

  config
    .command('get')
    .argument('<keyPath>', 'Dot-separated key path within the saved config.')
    .description('Read one saved config value with secret-safe redaction.')
    .action(async (keyPath: string) => {
      const store = new ConfigStore();
      const result = await store.load();

      if (!result.ok) {
        process.stderr.write(`${renderLoadError(result)}\n`);
        process.exitCode = 1;
        return;
      }

      if (result.source === 'empty') {
        process.stderr.write(`${renderMissingConfig(result.message, store.paths.configFile)}\n`);
        process.exitCode = 1;
        return;
      }

      const redacted = redactConfig(result.config);
      const resolved = getConfigValue(redacted, keyPath);

      if (!resolved.found) {
        process.stderr.write(`${renderConfigPathError('Config key was not found.', keyPath)}\n`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${formatOutputValue(resolved.value)}\n`);
    });

  config
    .command('set')
    .argument('<keyPath>', 'Editable config key path.')
    .argument('[value]', 'Replacement value. Use --stdin for secrets or complex JSON.')
    .option('--stdin', 'Read the replacement value from standard input.')
    .option('--json', 'Parse the provided value as JSON before saving.')
    .description('Update a saved config value without printing secrets back to the terminal.')
    .action(
      async (
        keyPath: string,
        value: string | undefined,
        options: { stdin?: boolean; json?: boolean },
      ) => {
        const store = new ConfigStore();
        const spec = EDITABLE_CONFIG_FIELDS.get(keyPath);

        if (!spec) {
          process.stderr.write(
            `${renderConfigPathError('Only a safe subset of config fields is editable. Use `mullgate config show` to inspect the saved schema.', keyPath)}\n`,
          );
          process.exitCode = 1;
          return;
        }

        if (options.stdin && value !== undefined) {
          process.stderr.write(
            `${renderConfigPathError('Pass a value or --stdin, not both.', keyPath)}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const rawValue = options.stdin ? await readStdinValue() : value;

        if (rawValue === undefined) {
          process.stderr.write(
            `${renderConfigPathError('A replacement value is required.', keyPath)}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const loadResult = await store.load();

        if (!loadResult.ok) {
          process.stderr.write(`${renderLoadError(loadResult)}\n`);
          process.exitCode = 1;
          return;
        }

        if (loadResult.source === 'empty') {
          process.stderr.write(
            `${renderMissingConfig(loadResult.message, store.paths.configFile)}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const updatedConfig = structuredClone(loadResult.config);

        try {
          const parsedValue = spec.parse(rawValue, { json: Boolean(options.json) });
          setConfigValue(updatedConfig, keyPath, parsedValue);
          applyPostSetNormalization(updatedConfig, keyPath);
        } catch (error) {
          process.stderr.write(
            `${renderConfigPathError(error instanceof Error ? error.message : String(error), keyPath)}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const canonicalConfig = syncLegacyMirrorsToRouting(updatedConfig);
        const staleConfig = withRuntimeStatus(
          canonicalConfig,
          'unvalidated',
          null,
          `Config changed at ${keyPath}; rerun \`mullgate config validate\` to refresh derived artifacts.`,
        );

        try {
          await store.save(staleConfig);
        } catch (error) {
          process.stderr.write(
            `${renderValidationError({
              ok: false,
              phase: 'persist-config',
              source: 'filesystem',
              message: 'Failed to persist the updated canonical config.',
              artifactPath: store.paths.configFile,
              cause: error instanceof Error ? error.message : String(error),
            })}\n`,
          );
          process.exitCode = 1;
          return;
        }

        process.stdout.write(
          `${[
            'Mullgate config updated.',
            'phase: persist-config',
            'source: input',
            `key: ${keyPath}`,
            `config: ${store.paths.configFile}`,
            spec.secret ? 'value: [redacted]' : 'value: updated',
            'runtime status: unvalidated',
          ].join('\n')}\n`,
        );
      },
    );

  config
    .command('validate')
    .option(
      '--refresh',
      'Re-render derived artifacts from saved config and relay cache before validating.',
    )
    .description(
      'Validate the saved or freshly rendered wireproxy config and persist the result metadata.',
    )
    .action(async (options: { refresh?: boolean }) => {
      const store = new ConfigStore();
      const result = await validateSavedConfig({ store, refresh: Boolean(options.refresh) });

      if (!result.ok) {
        process.stderr.write(`${renderValidationError(result)}\n`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${renderValidationSuccess(result)}\n`);
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
    `wireproxy config: ${paths.wireproxyConfigFile}`,
    `wireproxy configtest report: ${paths.wireproxyConfigTestReportFile}`,
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
      `   route id: ${location.runtime.routeId}`,
      `   wireproxy service: ${location.runtime.wireproxyServiceName}`,
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
    '- `mullgate config hosts` remains the copy/paste /etc/hosts view for local-only testing.',
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
    bindIp: validated.routeBindIps[index]!,
    hostname: deriveExposureHostname(
      location.alias,
      validated.routeBindIps[index]!,
      validated.baseDomain,
      validated.mode,
    ),
  }));
  const canonicalConfig = syncLegacyMirrorsToRouting({
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
      'Exposure settings changed; rerun `mullgate config validate` or `mullgate start` to refresh runtime artifacts.',
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
      `   example: mullgate config export --region ${region.name} --count 5`,
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
        requestedCount: null,
      });
      index += regionOption.consumedNextToken ? 1 : 0;
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

export function buildProxyExportPlan(input: {
  readonly config: MullgateConfig;
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelector[];
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
        countryCode:
          input.config.routing.locations[routeIndex]?.relayPreference.country?.toLowerCase() ??
          null,
        url: createProxyExportUrl({
          protocol: input.protocol,
          hostname: route.hostname,
          port: endpoint.port,
          username: input.config.setup.auth.username,
          password: input.config.setup.auth.password,
        }),
        redactedUrl: endpoint.redactedHostnameUrl,
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
      redactedOutputText: `${entries.map((entry) => entry.redactedUrl).join('\n')}\n`,
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

      return matchesProxyExportSelector({ selector, countryCode: entry.countryCode });
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
    redactedOutputText: `${selectedEntries.map((entry) => entry.redactedUrl).join('\n')}\n`,
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
        `${index + 1}. ${entry.redactedUrl} (alias: ${entry.alias}, country: ${entry.countryCode ?? 'n/a'})`,
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
              `${index + 1}. ${selector.kind}=${selector.value} requested=${selector.requestedCount ?? 'all'} matched=${selector.matchedCount} exported=${selector.exportedCount}`,
          ),
        ]),
    `exported count: ${input.result.entries.length}`,
  ];
}

async function resolveProxyExportInput(input: {
  readonly options: ProxyExportCommandOptions;
  readonly selectors: readonly ProxyExportSelector[];
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
    return {
      ok: true,
      value: {
        protocol: parseProxyExportProtocol(input.options.protocol),
        selectors: input.selectors,
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
}): Promise<{ readonly ok: true; readonly value: ProxyExportResolvedInput } | ProxyExportFailure> {
  const prompts = createGuidedPromptClient();

  try {
    prompts.intro('Mullgate proxy export');

    const protocol =
      input.initialProtocol ??
      (await prompts.text({
        message: 'Proxy protocol (socks5, http, https)',
        initialValue: 'socks5',
        validate: validateProxyExportProtocolInput,
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
        : await collectGuidedProxyExportSelectors(prompts);

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
        : await prompts.text({
            message: 'Output mode (file, stdout, dry-run)',
            initialValue: 'file',
            validate: validateProxyExportWriteModeInput,
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
        message: 'Output path',
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
): Promise<readonly ProxyExportSelector[] | typeof GUIDED_PROMPT_CANCELLED> {
  const filterExport = await prompts.confirm({
    message: 'Filter the export to specific countries or regions?',
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

  const selectors: ProxyExportSelector[] = [];

  while (true) {
    const selectorType = await prompts.text({
      message: 'Selector type (country or region)',
      initialValue: 'country',
      validate: validateProxyExportSelectorTypeInput,
    });

    if (selectorType === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    const kind = parseProxyExportSelectorType(selectorType);
    const selectorValue = await prompts.text({
      message:
        kind === 'country' ? 'Country code' : `Region name (${listRegionGroupNames().join(', ')})`,
      placeholder: kind === 'country' ? 'se' : 'europe',
      validate: (value) => validateGuidedProxyExportSelectorValue({ kind, value }),
    });

    if (selectorValue === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    const selectorCount = await prompts.text({
      message: 'Count for this selector (number or all)',
      initialValue: 'all',
      validate: validateProxyExportSelectorCountInput,
    });

    if (selectorCount === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    selectors.push({
      kind,
      value: normalizeProxyExportSelectorValue(selectorValue, kind),
      requestedCount: parseGuidedProxyExportCount(selectorCount),
    });

    const addAnother = await prompts.confirm({
      message: 'Add another selector batch?',
      initialValue: false,
      active: 'Yes',
      inactive: 'No',
    });

    if (addAnother === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    if (!addAnother) {
      return selectors;
    }
  }
}

async function deliverProxyExport(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly input: ProxyExportResolvedInput;
  readonly configPath: string;
  readonly guided: boolean;
}): Promise<{ readonly ok: true } | ProxyExportFailure> {
  if (input.input.writeMode === 'stdout') {
    process.stdout.write(input.result.outputText);
    process.stderr.write(
      `${renderProxyExportStdoutNotice({
        result: input.result,
        configPath: input.configPath,
      })}\n`,
    );
    return { ok: true };
  }

  const defaultOutputPath = input.input.outputPath ?? `./${input.result.suggestedFilename}`;

  if (input.input.writeMode === 'dry-run') {
    process.stdout.write(
      `${renderProxyExportPreview({
        result: input.result,
        configPath: input.configPath,
        outputPath: defaultOutputPath,
      })}\n`,
    );
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

  process.stdout.write(
    `${renderProxyExportSuccess({
      result: input.result,
      configPath: input.configPath,
      outputPath: resolvedOutput.displayPath,
    })}\n`,
  );
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
        message: `Output file ${displayPath} already exists. Overwrite it?`,
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
        message: 'Choose a different output path',
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

function validateProxyExportProtocolInput(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized === 'socks5' || normalized === 'http' || normalized === 'https'
    ? undefined
    : 'Enter socks5, http, or https.';
}

function validateProxyExportWriteModeInput(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized === 'file' || normalized === 'stdout' || normalized === 'dry-run'
    ? undefined
    : 'Enter file, stdout, or dry-run.';
}

function validateProxyExportSelectorTypeInput(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized === 'country' || normalized === 'region'
    ? undefined
    : 'Enter country or region.';
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

function validateGuidedProxyExportSelectorValue(input: {
  readonly kind: ProxyExportSelector['kind'];
  readonly value: string | undefined;
}): string | undefined {
  try {
    const normalized = normalizeProxyExportSelectorValue(input.value ?? '', input.kind);

    if (input.kind === 'region' && !resolveRegionCountryCodes(normalized)) {
      return `Unknown region ${normalized}. Supported regions: ${listRegionGroupNames().join(', ')}.`;
    }

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

  const hasExistingWireproxyConfig = await fileExists(input.store.paths.wireproxyConfigFile);
  const shouldRefresh =
    input.refresh ||
    loadResult.config.runtime.status.phase === 'unvalidated' ||
    !hasExistingWireproxyConfig;

  let configToValidatePath = input.store.paths.wireproxyConfigFile;
  let configToValidateText: string | undefined;
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

    const renderResult = await renderWireproxyArtifacts({
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

    configToValidatePath = renderResult.artifactPaths.wireproxyConfigPath;
    configToValidateText = renderResult.wireproxyConfig;
    refreshedArtifacts = true;
  } else {
    configToValidateText = await readFile(configToValidatePath, 'utf8');
  }

  const validationResult = await validateWireproxyConfig({
    configPath: configToValidatePath,
    configText: configToValidateText,
    reportPath: input.store.paths.wireproxyConfigTestReportFile,
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
    artifactPath: validationResult.target,
    reportPath: validationResult.reportPath ?? input.store.paths.wireproxyConfigTestReportFile,
    message: `Validated via ${summarizeValidationSource(validationResult)}.`,
  };
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

function renderMissingConfig(message: string, configPath: string): string {
  return [
    'Mullgate config command could not continue.',
    'phase: load-config',
    'source: empty',
    `artifact: ${configPath}`,
    `reason: ${message}`,
  ].join('\n');
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
    'Mullgate config validated.',
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
    'Mullgate config validation failed.',
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
    const segment = segments[index]!;
    const next = current[segment];

    if (!next || typeof next !== 'object') {
      throw new Error(`Config path ${keyPath} is not writable.`);
    }

    current = next as Record<string, unknown>;
  }

  current[segments.at(-1)!] = value;
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

function extractConfigExportArgs(argv: readonly string[]): string[] {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === 'config' && argv[index + 1] === 'export') {
      return argv.slice(index + 2);
    }
  }

  return [];
}

function parseProxyExportProtocol(raw: string | undefined): ProxyExportProtocol {
  const normalized = raw?.trim().toLowerCase() ?? 'socks5';

  if (normalized === 'socks5' || normalized === 'http' || normalized === 'https') {
    return normalized;
  }

  throw new Error('Protocol must be one of socks5, http, or https.');
}

function buildProxyExportFilename(input: {
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelector[];
}): string {
  if (input.selectors.length === 0) {
    return `proxy-${input.protocol}-all.txt`;
  }

  const selectorSlug = input.selectors
    .map((selector) => `${selector.kind}-${selector.value}-${selector.requestedCount ?? 'all'}`)
    .join('--');

  return `proxy-${input.protocol}-${selectorSlug}.txt`;
}

function matchesProxyExportSelector(input: {
  readonly selector: ProxyExportSelector;
  readonly countryCode: string | null;
}): boolean {
  if (!input.countryCode) {
    return false;
  }

  if (input.selector.kind === 'country') {
    return input.countryCode === input.selector.value;
  }

  const regionCountryCodes = resolveRegionCountryCodes(input.selector.value);
  return regionCountryCodes ? regionCountryCodes.includes(input.countryCode) : false;
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
