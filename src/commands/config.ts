import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { Command } from 'commander';

import { formatRedactedConfig, redactConfig } from '../config/redact.js';
import { ConfigStore, syncLegacyMirrorsToRouting, type LoadConfigResult } from '../config/store.js';
import type { MullgateConfig } from '../config/schema.js';
import { loadStoredRelayCatalog, summarizeValidationSource, verifyHttpsAssets, withRuntimeStatus } from '../app/setup-runner.js';
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

  config
    .command('locations')
    .description('List routed location aliases, bind IPs, relay preferences, and runtime ids without secrets.')
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
    .description('List configured proxy hostnames and their route bind IP mappings without secrets.')
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
    .action(async (keyPath: string, value: string | undefined, options: { stdin?: boolean; json?: boolean }) => {
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
        process.stderr.write(`${renderConfigPathError('Pass a value or --stdin, not both.', keyPath)}\n`);
        process.exitCode = 1;
        return;
      }

      const rawValue = options.stdin ? await readStdinValue() : value;

      if (rawValue === undefined) {
        process.stderr.write(`${renderConfigPathError('A replacement value is required.', keyPath)}\n`);
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
        process.stderr.write(`${renderMissingConfig(loadResult.message, store.paths.configFile)}\n`);
        process.exitCode = 1;
        return;
      }

      const updatedConfig = structuredClone(loadResult.config);

      try {
        const parsedValue = spec.parse(rawValue, { json: Boolean(options.json) });
        setConfigValue(updatedConfig, keyPath, parsedValue);
        applyPostSetNormalization(updatedConfig, keyPath);
      } catch (error) {
        process.stderr.write(`${renderConfigPathError(error instanceof Error ? error.message : String(error), keyPath)}\n`);
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
        [
          'Mullgate config updated.',
          'phase: persist-config',
          'source: input',
          `key: ${keyPath}`,
          `config: ${store.paths.configFile}`,
          spec.secret ? 'value: [redacted]' : 'value: updated',
          'runtime status: unvalidated',
        ].join('\n') + '\n',
      );
    });

  config
    .command('validate')
    .option('--refresh', 'Re-render derived artifacts from saved config and relay cache before validating.')
    .description('Validate the saved or freshly rendered wireproxy config and persist the result metadata.')
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

  return [
    'Mullgate path report',
    `phase: ${report.phase}`,
    `source: ${report.source}`,
    `config file: ${paths.configFile} (${exists.configFile ? 'present' : 'missing'})`,
    `state dir: ${paths.appStateDir}`,
    `cache dir: ${paths.appCacheDir}`,
    `wireproxy config: ${paths.wireproxyConfigFile}`,
    `wireproxy configtest report: ${paths.wireproxyConfigTestReportFile}`,
    `docker compose: ${paths.dockerComposePath}`,
    `relay cache: ${paths.provisioningCacheFile} (${exists.relayCacheFile ? 'present' : 'missing'})`,
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
    'hostname -> bind ip',
    ...config.routing.locations.map(
      (location, index) => `${index + 1}. ${location.hostname} -> ${location.bindIp} (alias: ${location.alias}, route id: ${location.runtime.routeId})`,
    ),
  ].join('\n');
}

async function validateSavedConfig(input: { store: ConfigStore; refresh: boolean }): Promise<ConfigValidationResult> {
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
    const errored = withRuntimeStatus(loadResult.config, 'error', new Date().toISOString(), httpsCheck.message);
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
  const shouldRefresh = input.refresh || loadResult.config.runtime.status.phase === 'unvalidated' || !hasExistingWireproxyConfig;

  let configToValidatePath = input.store.paths.wireproxyConfigFile;
  let configToValidateText: string | undefined;
  let refreshedArtifacts = false;

  if (shouldRefresh) {
    const relayCatalog = await loadStoredRelayCatalog(input.store.paths.provisioningCacheFile);

    if (!relayCatalog.ok) {
      const errored = withRuntimeStatus(loadResult.config, 'error', new Date().toISOString(), relayCatalog.message);
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
      const errored = withRuntimeStatus(loadResult.config, 'error', renderResult.checkedAt, renderResult.message);
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

async function saveRuntimeStatus(store: ConfigStore, config: MullgateConfig): Promise<{ ok: true } | ConfigValidationFailure> {
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

function getConfigValue(config: MullgateConfig, keyPath: string): { found: true; value: unknown } | { found: false } {
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
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')));
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
