import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { hostname } from 'node:os';

import { cancel as clackCancel, confirm, intro, isCancel, outro, password, text } from '@clack/prompts';

import { createLocationAliasCatalog, resolveLocationAlias, type LocationAliasTarget } from '../domain/location-aliases.js';
import type { MullgatePaths } from '../config/paths.js';
import { ConfigStore } from '../config/store.js';
import { CONFIG_VERSION, type MullgateConfig } from '../config/schema.js';
import { fetchRelays, type MullvadRelayCatalog } from '../mullvad/fetch-relays.js';
import { provisionWireguard, type ProvisionWireguardResult } from '../mullvad/provision-wireguard.js';
import { renderWireproxyArtifacts } from '../runtime/render-wireproxy.js';
import { validateWireproxyConfig, type ValidateWireproxyOptions } from '../runtime/validate-wireproxy.js';

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_SOCKS_PORT = 1080;
const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_HTTPS_PORT = 8443;
const DEFAULT_PROXY_USERNAME = 'mullgate';
const PROMPT_CANCELLED = Symbol('setup-prompt-cancelled');

export type SetupInputValues = {
  readonly accountNumber: string;
  readonly bindHost: string;
  readonly socksPort: number;
  readonly httpPort: number;
  readonly username: string;
  readonly password: string;
  readonly location: string;
  readonly httpsPort: number | null;
  readonly httpsCertPath?: string;
  readonly httpsKeyPath?: string;
  readonly deviceName?: string;
};

export type SetupSuccess = {
  readonly ok: true;
  readonly phase: 'setup-complete';
  readonly source: 'guided-setup';
  readonly exitCode: 0;
  readonly paths: MullgatePaths;
  readonly config: MullgateConfig;
  readonly selectedLocation: LocationAliasTarget;
  readonly selectedRelayHostname: string;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
  readonly relayCachePath: string;
  readonly wireproxyConfigPath: string;
  readonly dockerComposePath: string;
  readonly validationReportPath: string;
  readonly validationSource: ReturnType<typeof summarizeValidationSource>;
  readonly summary: string;
};

export type SetupCancelled = {
  readonly ok: false;
  readonly cancelled: true;
  readonly phase: 'prompt';
  readonly source: 'user-input';
  readonly exitCode: 130;
  readonly paths: MullgatePaths;
  readonly message: string;
};

export type SetupFailure = {
  readonly ok: false;
  readonly cancelled?: false;
  readonly phase:
    | 'prompt'
    | 'https-assets'
    | 'relay-fetch'
    | 'relay-normalize'
    | 'wireguard-keygen'
    | 'wireguard-provision'
    | 'location-aliases'
    | 'location-lookup'
    | 'persist-config'
    | 'artifact-render'
    | 'validation';
  readonly source: string;
  readonly exitCode: 1;
  readonly paths: MullgatePaths;
  readonly message: string;
  readonly cause?: string;
  readonly endpoint?: string;
  readonly artifactPath?: string;
  readonly config?: MullgateConfig;
};

export type SetupFlowResult = SetupSuccess | SetupCancelled | SetupFailure;

export type HttpsAssetCheckResult =
  | {
      readonly ok: true;
      readonly enabled: boolean;
    }
  | {
      readonly ok: false;
      readonly phase: 'https-assets';
      readonly source: 'canonical-config' | 'input' | 'filesystem';
      readonly message: string;
      readonly artifactPath?: string;
      readonly cause?: string;
    };

export type RunSetupFlowOptions = {
  readonly store?: ConfigStore;
  readonly initialValues?: Partial<SetupInputValues>;
  readonly interactive?: boolean;
  readonly provisioningBaseUrl?: string | URL;
  readonly relayCatalogUrl?: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly validateOptions?: Pick<ValidateWireproxyOptions, 'wireproxyBinary' | 'dockerBinary' | 'dockerImage' | 'spawn'>;
  readonly checkedAt?: string;
};

export async function runSetupFlow(options: RunSetupFlowOptions = {}): Promise<SetupFlowResult> {
  const store = options.store ?? new ConfigStore();
  const interactive = options.interactive ?? isInteractiveTerminal();
  const promptValues = await collectSetupInputs({
    interactive,
    initialValues: options.initialValues,
    paths: store.paths,
  });

  if (promptValues === PROMPT_CANCELLED) {
    return {
      ok: false,
      cancelled: true,
      phase: 'prompt',
      source: 'user-input',
      exitCode: 130,
      paths: store.paths,
      message: 'Setup cancelled before Mullgate wrote any configuration.',
    };
  }

  if (!promptValues.ok) {
    return {
      ok: false,
      phase: 'prompt',
      source: promptValues.source,
      exitCode: 1,
      paths: store.paths,
      message: promptValues.message,
      ...(promptValues.artifactPath ? { artifactPath: promptValues.artifactPath } : {}),
    };
  }

  const httpsCheck = await verifyHttpsAssets({
    enabled: promptValues.value.httpsPort !== null || Boolean(promptValues.value.httpsCertPath || promptValues.value.httpsKeyPath),
    certPath: promptValues.value.httpsCertPath,
    keyPath: promptValues.value.httpsKeyPath,
  });

  if (!httpsCheck.ok) {
    return {
      ok: false,
      phase: httpsCheck.phase,
      source: httpsCheck.source,
      exitCode: 1,
      paths: store.paths,
      message: httpsCheck.message,
      ...(httpsCheck.cause ? { cause: httpsCheck.cause } : {}),
      ...(httpsCheck.artifactPath ? { artifactPath: httpsCheck.artifactPath } : {}),
    };
  }

  const relayResult = await fetchRelays({
    ...(options.relayCatalogUrl ? { url: options.relayCatalogUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    fetchedAt: options.checkedAt,
  });

  if (!relayResult.ok) {
    return {
      ok: false,
      phase: relayResult.phase,
      source: relayResult.source,
      exitCode: 1,
      paths: store.paths,
      endpoint: relayResult.endpoint,
      message: relayResult.message,
      ...(relayResult.cause ? { cause: relayResult.cause } : {}),
    };
  }

  const aliasCatalog = createLocationAliasCatalog(relayResult.value.relays);

  if (!aliasCatalog.ok) {
    return {
      ok: false,
      phase: aliasCatalog.phase,
      source: aliasCatalog.source,
      exitCode: 1,
      paths: store.paths,
      message: aliasCatalog.message,
      ...(aliasCatalog.alias ? { artifactPath: aliasCatalog.alias } : {}),
    };
  }

  const resolvedLocation = resolveLocationAlias(aliasCatalog.value, promptValues.value.location);

  if (!resolvedLocation.ok) {
    return {
      ok: false,
      phase: resolvedLocation.phase,
      source: resolvedLocation.source,
      exitCode: 1,
      paths: store.paths,
      message: resolvedLocation.message,
      ...(resolvedLocation.alias ? { artifactPath: resolvedLocation.alias } : {}),
    };
  }

  const provisionResult = await provisionWireguard({
    accountNumber: promptValues.value.accountNumber,
    ...(promptValues.value.deviceName ? { deviceName: promptValues.value.deviceName } : {}),
    ...(options.provisioningBaseUrl ? { baseUrl: options.provisioningBaseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    checkedAt: options.checkedAt,
  });

  if (!provisionResult.ok) {
    return {
      ok: false,
      phase: provisionResult.phase,
      source: provisionResult.source,
      exitCode: 1,
      paths: store.paths,
      endpoint: provisionResult.endpoint,
      message: provisionResult.message,
      ...(provisionResult.cause ? { cause: provisionResult.cause } : {}),
    };
  }

  const initialConfig = createCanonicalConfig({
    inputs: promptValues.value,
    resolvedLocation: resolvedLocation.value,
    relayCatalog: relayResult.value,
    provisionResult,
    paths: store.paths,
    checkedAt: options.checkedAt,
  });

  const initialSave = await saveConfigSafely(store, initialConfig);

  if (!initialSave.ok) {
    return initialSave;
  }

  const renderResult = await renderWireproxyArtifacts({
    config: initialConfig,
    relayCatalog: relayResult.value,
    paths: store.paths,
    generatedAt: options.checkedAt,
  });

  if (!renderResult.ok) {
    const erroredConfig = withRuntimeStatus(initialConfig, 'error', renderResult.checkedAt, renderResult.message);
    await saveConfigSafely(store, erroredConfig);

    return {
      ok: false,
      phase: renderResult.phase,
      source: renderResult.source,
      exitCode: 1,
      paths: store.paths,
      config: erroredConfig,
      message: renderResult.message,
      ...(renderResult.cause ? { cause: renderResult.cause } : {}),
      ...(renderResult.artifactPath ? { artifactPath: renderResult.artifactPath } : {}),
    };
  }

  const validationResult = await validateWireproxyConfig({
    configPath: renderResult.artifactPaths.wireproxyConfigPath,
    configText: renderResult.wireproxyConfig,
    reportPath: renderResult.artifactPaths.configTestReportPath,
    checkedAt: options.checkedAt,
    ...options.validateOptions,
  });

  const finalConfig = withRuntimeStatus(
    initialConfig,
    validationResult.ok ? 'validated' : 'error',
    validationResult.checkedAt,
    validationResult.ok
      ? `Validated via ${summarizeValidationSource(validationResult)}.`
      : `Validation failed via ${summarizeValidationSource(validationResult)}: ${validationResult.cause}`,
  );

  const finalSave = await saveConfigSafely(store, finalConfig);

  if (!finalSave.ok) {
    return finalSave;
  }

  if (!validationResult.ok) {
    return {
      ok: false,
      phase: validationResult.phase,
      source: validationResult.source,
      exitCode: 1,
      paths: store.paths,
      config: finalConfig,
      message: validationResult.cause,
      artifactPath: validationResult.target,
      cause: validationResult.issues.map((issue) => issue.message).join('; '),
    };
  }

  return {
    ok: true,
    phase: 'setup-complete',
    source: 'guided-setup',
    exitCode: 0,
    paths: store.paths,
    config: finalConfig,
    selectedLocation: renderResult.selectedTarget ?? resolvedLocation.value,
    selectedRelayHostname: renderResult.selectedRelay.hostname,
    relayCatalog: relayResult.value,
    configPath: store.paths.configFile,
    relayCachePath: renderResult.artifactPaths.relayCachePath,
    wireproxyConfigPath: renderResult.artifactPaths.wireproxyConfigPath,
    dockerComposePath: renderResult.artifactPaths.dockerComposePath,
    validationReportPath: renderResult.artifactPaths.configTestReportPath,
    validationSource: summarizeValidationSource(validationResult),
    summary: [
      'Mullgate setup completed.',
      'phase: setup-complete',
      'source: guided-setup',
      `config: ${store.paths.configFile}`,
      `wireproxy config: ${renderResult.artifactPaths.wireproxyConfigPath}`,
      `relay cache: ${renderResult.artifactPaths.relayCachePath}`,
      `docker compose: ${renderResult.artifactPaths.dockerComposePath}`,
      `validation report: ${renderResult.artifactPaths.configTestReportPath}`,
      `location: ${resolvedLocation.alias}`,
      `relay: ${renderResult.selectedRelay.hostname}`,
      `validation: ${summarizeValidationSource(validationResult)}`,
    ].join('\n'),
  };
}

export function withRuntimeStatus(
  config: MullgateConfig,
  phase: MullgateConfig['runtime']['status']['phase'],
  checkedAt: string | null,
  message: string | null,
): MullgateConfig {
  return {
    ...config,
    updatedAt: checkedAt ?? new Date().toISOString(),
    runtime: {
      ...config.runtime,
      status: {
        phase,
        lastCheckedAt: checkedAt,
        message,
      },
    },
  };
}

export async function verifyHttpsAssets(input: {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
}): Promise<HttpsAssetCheckResult> {
  if (!input.enabled) {
    return { ok: true, enabled: false };
  }

  if (!input.certPath || !input.keyPath) {
    return {
      ok: false,
      phase: 'https-assets',
      source: 'input',
      message: 'HTTPS was requested but both --https-cert-path and --https-key-path are required.',
      ...(input.certPath || input.keyPath ? { artifactPath: input.certPath ?? input.keyPath } : {}),
    };
  }

  for (const target of [input.certPath, input.keyPath]) {
    try {
      await access(target, fsConstants.R_OK);
    } catch (error) {
      return {
        ok: false,
        phase: 'https-assets',
        source: 'filesystem',
        message: 'HTTPS certificate assets were configured but could not be read.',
        artifactPath: target,
        cause: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { ok: true, enabled: true };
}

export async function loadStoredRelayCatalog(relayCachePath: string): Promise<
  | { readonly ok: true; readonly value: MullvadRelayCatalog }
  | {
      readonly ok: false;
      readonly phase: 'relay-normalize';
      readonly source: 'file';
      readonly message: string;
      readonly artifactPath: string;
      readonly cause?: string;
    }
> {
  let payload: unknown;

  try {
    payload = JSON.parse(await readFile(relayCachePath, 'utf8')) as unknown;
  } catch (error) {
    return {
      ok: false,
      phase: 'relay-normalize',
      source: 'file',
      message: 'Saved Mullvad relay cache could not be read as JSON.',
      artifactPath: relayCachePath,
      cause: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = parseStoredRelayCatalog(payload);

  if (!parsed.ok) {
    return {
      ok: false,
      phase: 'relay-normalize',
      source: 'file',
      message: parsed.message,
      artifactPath: relayCachePath,
      ...(parsed.cause ? { cause: parsed.cause } : {}),
    };
  }

  return parsed;
}

function createCanonicalConfig(input: {
  inputs: SetupInputValues;
  resolvedLocation: LocationAliasTarget;
  relayCatalog: MullvadRelayCatalog;
  provisionResult: Extract<ProvisionWireguardResult, { ok: true }>;
  paths: MullgatePaths;
  checkedAt?: string;
}): MullgateConfig {
  const timestamp = input.checkedAt ?? new Date().toISOString();
  const httpsEnabled = input.inputs.httpsPort !== null || Boolean(input.inputs.httpsCertPath || input.inputs.httpsKeyPath);

  return {
    version: CONFIG_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    setup: {
      source: 'guided-setup',
      bind: {
        host: input.inputs.bindHost,
        socksPort: input.inputs.socksPort,
        httpPort: input.inputs.httpPort,
        httpsPort: input.inputs.httpsPort,
      },
      auth: {
        username: input.inputs.username,
        password: input.inputs.password,
      },
      exposure: {
        mode: 'loopback',
        allowLan: false,
      },
      location: {
        requested: input.inputs.location,
        ...(input.resolvedLocation.kind !== 'relay' ? { country: input.resolvedLocation.countryCode } : { country: input.resolvedLocation.countryCode }),
        ...(input.resolvedLocation.kind === 'city' || input.resolvedLocation.kind === 'relay'
          ? { city: input.resolvedLocation.cityCode }
          : {}),
        ...(input.resolvedLocation.kind === 'relay' ? { hostnameLabel: input.resolvedLocation.hostname } : {}),
        resolvedAlias: normalizeResolvedAlias(input.inputs.location),
      },
      https: {
        enabled: httpsEnabled,
        ...(input.inputs.httpsCertPath ? { certPath: input.inputs.httpsCertPath } : {}),
        ...(input.inputs.httpsKeyPath ? { keyPath: input.inputs.httpsKeyPath } : {}),
      },
    },
    mullvad: {
      accountNumber: input.inputs.accountNumber,
      deviceName: input.inputs.deviceName ?? defaultDeviceName(),
      lastProvisionedAt: timestamp,
      relayConstraints: {
        providers: [],
      },
      wireguard: input.provisionResult.value.toConfigValue(),
    },
    runtime: {
      backend: 'wireproxy',
      sourceConfigPath: input.paths.configFile,
      wireproxyConfigPath: input.paths.wireproxyConfigFile,
      wireproxyConfigTestReportPath: input.paths.wireproxyConfigTestReportFile,
      relayCachePath: input.paths.provisioningCacheFile,
      dockerComposePath: input.paths.dockerComposePath,
      status: {
        phase: 'unvalidated',
        lastCheckedAt: null,
        message: `Saved relay catalog from ${input.relayCatalog.source}; waiting for validation.`,
      },
    },
  };
}

async function collectSetupInputs(input: {
  interactive: boolean;
  initialValues?: Partial<SetupInputValues>;
  paths: MullgatePaths;
}): Promise<
  | typeof PROMPT_CANCELLED
  | { readonly ok: true; readonly value: SetupInputValues }
  | { readonly ok: false; readonly source: 'input'; readonly message: string; readonly artifactPath?: string }
> {
  const values = normalizeInitialSetupValues(input.initialValues);

  if (!input.interactive) {
    const missing = [
      ['account number', values.accountNumber],
      ['proxy username', values.username],
      ['proxy password', values.password],
      ['location alias', values.location],
    ].filter(([, value]) => !value || value.trim().length === 0);

    if (missing.length > 0) {
      return {
        ok: false,
        source: 'input',
        message: `Missing required setup inputs for non-interactive mode: ${missing.map(([label]) => label).join(', ')}.`,
        artifactPath: input.paths.configFile,
      };
    }

    return {
      ok: true,
      value: finalizeSetupValues(values),
    };
  }

  intro('Mullgate setup');

  const accountNumber = await password({
    message: 'Mullvad account number',
    mask: '•',
    validate: (value) => (/^\d{6,16}$/.test((value ?? '').trim()) ? undefined : 'Enter 6-16 digits.'),
  });

  if (isCancel(accountNumber)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const bindHost = await text({
    message: 'Bind host',
    initialValue: values.bindHost,
    validate: (value) => ((value ?? '').trim().length > 0 ? undefined : 'Bind host is required.'),
  });

  if (isCancel(bindHost)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const socksPort = await text({
    message: 'SOCKS5 port',
    initialValue: String(values.socksPort),
    validate: validatePortInput,
  });

  if (isCancel(socksPort)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const httpPort = await text({
    message: 'HTTP proxy port',
    initialValue: String(values.httpPort),
    validate: validatePortInput,
  });

  if (isCancel(httpPort)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const username = await text({
    message: 'Proxy username',
    initialValue: values.username,
    validate: (value) => ((value ?? '').trim().length > 0 ? undefined : 'Proxy username is required.'),
  });

  if (isCancel(username)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const proxyPassword = await password({
    message: 'Proxy password',
    mask: '•',
    validate: (value) => ((value ?? '').trim().length > 0 ? undefined : 'Proxy password is required.'),
  });

  if (isCancel(proxyPassword)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const location = await text({
    message: 'Preferred Mullvad location alias',
    initialValue: values.location,
    placeholder: 'se-gothenburg',
    validate: (value) => ((value ?? '').trim().length > 0 ? undefined : 'Enter a country, city, or relay alias.'),
  });

  if (isCancel(location)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const configureHttps = await confirm({
    message: 'Configure optional HTTPS certificate paths now?',
    initialValue: Boolean(values.httpsCertPath || values.httpsKeyPath || values.httpsPort !== null),
    active: 'Yes',
    inactive: 'No',
  });

  if (isCancel(configureHttps)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  let httpsCertPath = values.httpsCertPath;
  let httpsKeyPath = values.httpsKeyPath;
  let httpsPort = values.httpsPort;

  if (configureHttps) {
    const certPath = await text({
      message: 'HTTPS certificate path',
      initialValue: values.httpsCertPath,
      validate: (value) => ((value ?? '').trim().length > 0 ? undefined : 'Certificate path is required when HTTPS is enabled.'),
    });

    if (isCancel(certPath)) {
      clackCancel('Setup cancelled.');
      return PROMPT_CANCELLED;
    }

    const keyPath = await text({
      message: 'HTTPS key path',
      initialValue: values.httpsKeyPath,
      validate: (value) => ((value ?? '').trim().length > 0 ? undefined : 'Key path is required when HTTPS is enabled.'),
    });

    if (isCancel(keyPath)) {
      clackCancel('Setup cancelled.');
      return PROMPT_CANCELLED;
    }

    const httpsPortInput = await text({
      message: 'HTTPS proxy port',
      initialValue: String(values.httpsPort ?? DEFAULT_HTTPS_PORT),
      validate: validatePortInput,
    });

    if (isCancel(httpsPortInput)) {
      clackCancel('Setup cancelled.');
      return PROMPT_CANCELLED;
    }

    httpsCertPath = certPath.trim();
    httpsKeyPath = keyPath.trim();
    httpsPort = Number(httpsPortInput.trim());
  } else {
    httpsCertPath = undefined;
    httpsKeyPath = undefined;
    httpsPort = null;
  }

  const finalized = finalizeSetupValues({
    ...values,
    accountNumber: accountNumber.trim(),
    bindHost: bindHost.trim(),
    socksPort: Number(socksPort.trim()),
    httpPort: Number(httpPort.trim()),
    username: username.trim(),
    password: proxyPassword.trim(),
    location: location.trim(),
    httpsCertPath,
    httpsKeyPath,
    httpsPort,
  });

  outro(`Will provision ${finalized.location} and write Mullgate config to ${input.paths.configFile}.`);

  return {
    ok: true,
    value: finalized,
  };
}

async function saveConfigSafely(store: ConfigStore, config: MullgateConfig): Promise<
  | { readonly ok: true }
  | SetupFailure
> {
  try {
    await store.save(config);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      phase: 'persist-config',
      source: 'filesystem',
      exitCode: 1,
      paths: store.paths,
      config,
      message: 'Failed to persist the canonical Mullgate config.',
      artifactPath: store.paths.configFile,
      cause: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeInitialSetupValues(initialValues: Partial<SetupInputValues> | undefined): Partial<SetupInputValues> {
  return {
    accountNumber: initialValues?.accountNumber?.trim(),
    bindHost: initialValues?.bindHost?.trim() || DEFAULT_BIND_HOST,
    socksPort: initialValues?.socksPort ?? DEFAULT_SOCKS_PORT,
    httpPort: initialValues?.httpPort ?? DEFAULT_HTTP_PORT,
    username: initialValues?.username?.trim() || DEFAULT_PROXY_USERNAME,
    password: initialValues?.password,
    location: initialValues?.location?.trim() || 'se-gothenburg',
    httpsPort: initialValues?.httpsPort ?? null,
    httpsCertPath: initialValues?.httpsCertPath?.trim(),
    httpsKeyPath: initialValues?.httpsKeyPath?.trim(),
    deviceName: initialValues?.deviceName?.trim() || defaultDeviceName(),
  };
}

function finalizeSetupValues(values: Partial<SetupInputValues>): SetupInputValues {
  return {
    accountNumber: values.accountNumber!.trim(),
    bindHost: values.bindHost!.trim(),
    socksPort: values.socksPort!,
    httpPort: values.httpPort!,
    username: values.username!.trim(),
    password: values.password!.trim(),
    location: values.location!.trim(),
    httpsPort: values.httpsPort ?? null,
    ...(values.httpsCertPath ? { httpsCertPath: values.httpsCertPath.trim() } : {}),
    ...(values.httpsKeyPath ? { httpsKeyPath: values.httpsKeyPath.trim() } : {}),
    ...(values.deviceName ? { deviceName: values.deviceName.trim() } : {}),
  };
}

function parseStoredRelayCatalog(payload: unknown):
  | { readonly ok: true; readonly value: MullvadRelayCatalog }
  | { readonly ok: false; readonly message: string; readonly cause?: string } {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      message: 'Saved Mullvad relay cache was not an object.',
    };
  }

  const source = readStringProperty(payload, 'source');
  const fetchedAt = readStringProperty(payload, 'fetchedAt');
  const endpoint = readStringProperty(payload, 'endpoint');
  const relayCount = readNumberProperty(payload, 'relayCount');
  const countries = readArrayProperty(payload, 'countries');
  const relays = readArrayProperty(payload, 'relays');

  if (!source || !fetchedAt || !endpoint || relayCount === null || !countries || !relays) {
    return {
      ok: false,
      message: 'Saved Mullvad relay cache did not match the expected catalog shape.',
    };
  }

  return {
    ok: true,
    value: payload as MullvadRelayCatalog,
  };
}

function readStringProperty(value: unknown, key: string): string | null {
  return typeof value === 'object' && value !== null && key in value && typeof (value as Record<string, unknown>)[key] === 'string'
    ? ((value as Record<string, unknown>)[key] as string)
    : null;
}

function readNumberProperty(value: unknown, key: string): number | null {
  return typeof value === 'object' && value !== null && key in value && typeof (value as Record<string, unknown>)[key] === 'number'
    ? ((value as Record<string, unknown>)[key] as number)
    : null;
}

function readArrayProperty(value: unknown, key: string): unknown[] | null {
  return typeof value === 'object' && value !== null && key in value && Array.isArray((value as Record<string, unknown>)[key])
    ? ((value as Record<string, unknown>)[key] as unknown[])
    : null;
}

function summarizeValidationSource(result: Awaited<ReturnType<typeof validateWireproxyConfig>>):
  | 'wireproxy-binary/configtest'
  | 'docker/configtest'
  | 'internal-syntax' {
  if (result.source === 'wireproxy-binary') {
    return 'wireproxy-binary/configtest';
  }

  if (result.source === 'docker') {
    return 'docker/configtest';
  }

  return 'internal-syntax';
}

function validatePortInput(value: string | undefined): string | undefined {
  const numeric = Number((value ?? '').trim());
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535 ? undefined : 'Enter a port between 1 and 65535.';
}

function defaultDeviceName(): string {
  return `mullgate-${hostname().split('.')[0] || 'host'}`;
}

function normalizeResolvedAlias(value: string): string {
  return value.trim().toLowerCase();
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
