import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

import {
  cancel as clackCancel,
  confirm,
  intro,
  isCancel,
  outro,
  password,
  text,
} from '@clack/prompts';
import {
  deriveExposureHostname,
  normalizeExposureBaseDomain,
  validateExposureSettings,
} from '../config/exposure-contract.js';
import type { MullgatePaths } from '../config/paths.js';
import { CONFIG_VERSION, type ExposureMode, type MullgateConfig } from '../config/schema.js';
import { ConfigStore, normalizeMullgateConfig } from '../config/store.js';
import {
  createLocationAliasCatalog,
  type LocationAliasCatalog,
  type LocationAliasTarget,
  normalizeLocationToken,
  resolveLocationAlias,
} from '../domain/location-aliases.js';
import {
  fetchRelays,
  type MullvadRelay,
  type MullvadRelayCatalog,
} from '../mullvad/fetch-relays.js';
import {
  type ProvisionWireguardResult,
  provisionWireguard,
} from '../mullvad/provision-wireguard.js';
import { deriveDefaultBindHost } from '../network/tailscale.js';
import { requireArrayValue, requireDefined } from '../required.js';
import { renderRuntimeProxyArtifacts } from '../runtime/render-runtime-proxies.js';
import {
  type ValidateRuntimeOptions,
  validateRuntimeArtifacts,
} from '../runtime/validate-runtime.js';

const DEFAULT_SOCKS_PORT = 1080;
const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_HTTPS_PORT = 8443;
const DEFAULT_PROXY_USERNAME = 'mullgate';
const DEFAULT_EXPOSURE_MODE: ExposureMode = 'loopback';
const PROVISION_RETRY_LIMIT = 3;
const PROVISION_RETRY_FALLBACK_DELAY_MS = 1_500;
const PROMPT_CANCELLED = Symbol('setup-prompt-cancelled');

export type SetupInputValues = {
  readonly accountNumber: string;
  readonly bindHost: string;
  readonly routeBindIps: readonly [string, ...string[]];
  readonly exposureMode: ExposureMode;
  readonly exposureBaseDomain: string | null;
  readonly socksPort: number;
  readonly httpPort: number;
  readonly username: string;
  readonly password: string;
  readonly locations: readonly [string, ...string[]];
  readonly location: string;
  readonly httpsPort: number | null;
  readonly httpsCertPath?: string;
  readonly httpsKeyPath?: string;
  readonly deviceName?: string;
};

export type RawSetupInputValues = Omit<
  SetupInputValues,
  'routeBindIps' | 'exposureMode' | 'exposureBaseDomain'
> & {
  readonly routeBindIps?: readonly string[];
  readonly exposureMode?: ExposureMode;
  readonly exposureBaseDomain?: string | null;
};

export type SetupRouteMetadata = {
  readonly index: number;
  readonly requested: string;
  readonly alias: string;
  readonly hostname: string;
  readonly bindIp: string;
  readonly deviceName: string;
};

export type SetupSuccessRoute = SetupRouteMetadata & {
  readonly exitRelayHostname: string;
  readonly exitSocksHostname: string;
  readonly exitSocksPort: number;
};

export type SetupSuccess = {
  readonly ok: true;
  readonly phase: 'setup-complete';
  readonly source: 'guided-setup';
  readonly exitCode: 0;
  readonly paths: MullgatePaths;
  readonly config: MullgateConfig;
  readonly routes: readonly SetupSuccessRoute[];
  readonly selectedLocation: LocationAliasTarget;
  readonly selectedRelayHostname: string;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
  readonly relayCachePath: string;
  readonly entryWireproxyConfigPath: string;
  readonly routeProxyConfigPath: string;
  readonly dockerComposePath: string;
  readonly validationReportPath: string;
  readonly validationSource: string;
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
    | 'setup-validation'
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
  readonly code?: string;
  readonly cause?: string;
  readonly endpoint?: string;
  readonly artifactPath?: string;
  readonly route?: SetupRouteMetadata;
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
  readonly initialValues?: Partial<RawSetupInputValues>;
  readonly interactive?: boolean;
  readonly provisioningBaseUrl?: string | URL;
  readonly relayCatalogUrl?: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly validateOptions?: Pick<
    ValidateRuntimeOptions,
    'wireproxyBinary' | 'dockerBinary' | 'dockerImage' | 'routeProxyDockerImage' | 'spawn'
  >;
  readonly checkedAt?: string;
};

export type PlannedSetupRoute = SetupRouteMetadata & {
  readonly resolvedLocation: LocationAliasTarget;
  readonly relayPreference: MullgateConfig['setup']['location'];
  readonly routeId: string;
};

export type ResolvedSetupRoute = PlannedSetupRoute & {
  readonly exitRelay: MullvadRelay;
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

  const resolvedInputs = resolveSetupInputs(promptValues.value, store.paths.configFile);

  if (!resolvedInputs.ok) {
    return {
      ok: false,
      phase: resolvedInputs.phase,
      source: resolvedInputs.source,
      exitCode: 1,
      paths: store.paths,
      code: resolvedInputs.code,
      message: resolvedInputs.message,
      ...(resolvedInputs.cause ? { cause: resolvedInputs.cause } : {}),
      ...(resolvedInputs.artifactPath ? { artifactPath: resolvedInputs.artifactPath } : {}),
    };
  }

  const setupInputs = resolvedInputs.value;

  const httpsCheck = await verifyHttpsAssets({
    enabled:
      setupInputs.httpsPort !== null ||
      Boolean(setupInputs.httpsCertPath || setupInputs.httpsKeyPath),
    certPath: setupInputs.httpsCertPath,
    keyPath: setupInputs.httpsKeyPath,
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

  const plannedRoutesResult = planSetupRoutes({
    requestedLocations: setupInputs.locations,
    routeBindIps: setupInputs.routeBindIps,
    exposureMode: setupInputs.exposureMode,
    exposureBaseDomain: setupInputs.exposureBaseDomain,
    aliasCatalog: aliasCatalog.value,
    baseDeviceName: setupInputs.deviceName ?? defaultDeviceName(),
  });

  if (!plannedRoutesResult.ok) {
    return {
      ok: false,
      phase: plannedRoutesResult.phase,
      source: plannedRoutesResult.source,
      exitCode: 1,
      paths: store.paths,
      code: plannedRoutesResult.code,
      message: plannedRoutesResult.message,
      ...(plannedRoutesResult.artifactPath
        ? { artifactPath: plannedRoutesResult.artifactPath }
        : {}),
      ...(plannedRoutesResult.route ? { route: plannedRoutesResult.route } : {}),
    };
  }

  const provisionResult = await provisionRouteWithRetries({
    accountNumber: setupInputs.accountNumber,
    route: plannedRoutesResult.value[0],
    provisioningBaseUrl: options.provisioningBaseUrl,
    fetch: options.fetch,
    checkedAt: options.checkedAt,
  });

  if (!provisionResult.ok) {
    return {
      ok: false,
      phase: provisionResult.phase,
      source: provisionResult.source,
      exitCode: 1,
      paths: store.paths,
      code: provisionResult.code,
      endpoint: provisionResult.endpoint,
      route: summarizeSetupRoute(
        requireDefined(plannedRoutesResult.value[0], 'Expected one planned route.'),
      ),
      message: 'Provisioning failed for the shared Mullvad WireGuard device.',
      cause: formatProvisioningCause(provisionResult),
    };
  }

  const resolvedRoutesResult = resolveSetupRouteExits({
    routes: plannedRoutesResult.value,
    relayCatalog: relayResult.value,
  });

  if (!resolvedRoutesResult.ok) {
    return {
      ok: false,
      phase: resolvedRoutesResult.phase,
      source: resolvedRoutesResult.source,
      exitCode: 1,
      paths: store.paths,
      code: resolvedRoutesResult.code,
      message: resolvedRoutesResult.message,
      ...(resolvedRoutesResult.artifactPath
        ? { artifactPath: resolvedRoutesResult.artifactPath }
        : {}),
      ...(resolvedRoutesResult.route ? { route: resolvedRoutesResult.route } : {}),
      ...(resolvedRoutesResult.cause ? { cause: resolvedRoutesResult.cause } : {}),
    };
  }

  const initialConfig = createCanonicalConfig({
    inputs: setupInputs,
    provisioning: provisionResult,
    routes: resolvedRoutesResult.value,
    relayCatalog: relayResult.value,
    paths: store.paths,
    checkedAt: options.checkedAt,
  });

  const initialSave = await saveConfigSafely(store, initialConfig);

  if (!initialSave.ok) {
    return initialSave;
  }

  const renderResult = await renderRuntimeProxyArtifacts({
    config: initialConfig,
    relayCatalog: relayResult.value,
    paths: store.paths,
    generatedAt: options.checkedAt,
  });

  if (!renderResult.ok) {
    const erroredConfig = withRuntimeStatus(
      initialConfig,
      'error',
      renderResult.checkedAt,
      renderResult.message,
    );
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

  const validationResult = await validateRuntimeArtifacts({
    entryWireproxyConfigPath: renderResult.artifactPaths.entryWireproxyConfigPath,
    entryWireproxyConfigText: renderResult.entryWireproxyConfig,
    routeProxyConfigPath: renderResult.artifactPaths.routeProxyConfigPath,
    routeProxyConfigText: renderResult.routeProxyConfig,
    routes: renderResult.routes,
    bind: {
      socksPort: setupInputs.socksPort,
      httpPort: setupInputs.httpPort,
    },
    reportPath: store.paths.runtimeValidationReportFile,
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
    routes: resolvedRoutesResult.value.map(toSetupSuccessRoute),
    selectedLocation:
      renderResult.entryTarget ??
      requireDefined(resolvedRoutesResult.value[0], 'Expected one resolved setup route.')
        .resolvedLocation,
    selectedRelayHostname: renderResult.entryRelay.hostname,
    relayCatalog: relayResult.value,
    configPath: store.paths.configFile,
    relayCachePath: renderResult.artifactPaths.relayCachePath,
    entryWireproxyConfigPath: renderResult.artifactPaths.entryWireproxyConfigPath,
    routeProxyConfigPath: renderResult.artifactPaths.routeProxyConfigPath,
    dockerComposePath: store.paths.runtimeComposeFile,
    validationReportPath: store.paths.runtimeValidationReportFile,
    validationSource: summarizeValidationSource(validationResult),
    summary: [
      'Mullgate setup completed.',
      'phase: setup-complete',
      'source: guided-setup',
      `config: ${store.paths.configFile}`,
      `entry wireproxy config: ${renderResult.artifactPaths.entryWireproxyConfigPath}`,
      `route proxy config: ${renderResult.artifactPaths.routeProxyConfigPath}`,
      `relay cache: ${renderResult.artifactPaths.relayCachePath}`,
      `docker compose: ${store.paths.runtimeComposeFile}`,
      `validation report: ${store.paths.runtimeValidationReportFile}`,
      `entry relay: ${renderResult.entryRelay.hostname}`,
      `shared device: ${setupInputs.deviceName ?? defaultDeviceName()}`,
      `location: ${resolvedRoutesResult.value[0]?.alias}`,
      `exposure: ${setupInputs.exposureMode}`,
      `base domain: ${setupInputs.exposureBaseDomain ?? 'n/a'}`,
      `routes: ${resolvedRoutesResult.value.length}`,
      ...resolvedRoutesResult.value.flatMap((route) => [
        `${route.index + 1}. ${route.alias}`,
        `   hostname: ${route.hostname}`,
        `   bind ip: ${route.bindIp}`,
        `   exit relay: ${route.exitRelay.hostname}`,
        `   exit socks: ${route.exitRelay.socksName ?? 'n/a'}:${route.exitRelay.socksPort ?? 'n/a'}`,
      ]),
      `tunnel ipv4: ${provisionResult.value.ipv4Address}`,
      `validation: ${summarizeValidationSource(validationResult)}`,
    ].join('\n'),
  };
}

export function planSetupRoutes(input: {
  requestedLocations: readonly string[];
  routeBindIps: readonly string[];
  exposureMode: ExposureMode;
  exposureBaseDomain: string | null;
  aliasCatalog: LocationAliasCatalog;
  baseDeviceName: string;
}):
  | { readonly ok: true; readonly value: readonly PlannedSetupRoute[] }
  | {
      readonly ok: false;
      readonly phase: SetupFailure['phase'];
      readonly source: string;
      readonly code: string;
      readonly message: string;
      readonly artifactPath?: string;
      readonly route: SetupRouteMetadata;
    } {
  const routeCount = input.requestedLocations.length;
  const provisionalRoutes = input.requestedLocations.map((requested, index) => {
    const provisionalAlias = normalizeLocationToken(requested) || `route-${index + 1}`;
    const bindIp = requireArrayValue(
      input.routeBindIps,
      index,
      `Missing bind IP for route ${index + 1}.`,
    );

    return {
      index,
      requested,
      alias: provisionalAlias,
      hostname: deriveExposureHostname(
        provisionalAlias,
        bindIp,
        input.exposureBaseDomain,
        input.exposureMode,
      ),
      bindIp,
      deviceName: deriveRouteDeviceName(input.baseDeviceName, provisionalAlias, routeCount),
    } satisfies SetupRouteMetadata;
  });
  const usedRouteLabels = new Set<string>();
  const plannedRoutes: PlannedSetupRoute[] = [];

  for (const provisionalRoute of provisionalRoutes) {
    const resolvedLocation = resolveLocationAlias(input.aliasCatalog, provisionalRoute.requested);

    if (!resolvedLocation.ok) {
      return {
        ok: false,
        phase: resolvedLocation.phase,
        source: resolvedLocation.source,
        code: resolvedLocation.code,
        message: resolvedLocation.message,
        ...(resolvedLocation.alias ? { artifactPath: resolvedLocation.alias } : {}),
        route: provisionalRoute,
      };
    }

    const routeLabel = chooseUniqueRouteLabel(
      deriveCanonicalRouteLabel(resolvedLocation.value),
      usedRouteLabels,
    );

    plannedRoutes.push({
      ...provisionalRoute,
      alias: routeLabel,
      hostname: deriveExposureHostname(
        routeLabel,
        provisionalRoute.bindIp,
        input.exposureBaseDomain,
        input.exposureMode,
      ),
      deviceName: deriveRouteDeviceName(input.baseDeviceName, routeLabel, routeCount),
      resolvedLocation: resolvedLocation.value,
      relayPreference: createRouteRelayPreference(
        provisionalRoute.requested,
        routeLabel,
        resolvedLocation.value,
      ),
      routeId: routeLabel,
    });
  }

  return {
    ok: true,
    value: plannedRoutes,
  };
}

function resolveSetupRouteExits(input: {
  readonly routes: readonly PlannedSetupRoute[];
  readonly relayCatalog: MullvadRelayCatalog;
}):
  | {
      readonly ok: true;
      readonly value: readonly ResolvedSetupRoute[];
    }
  | {
      readonly ok: false;
      readonly phase: SetupFailure['phase'];
      readonly source: string;
      readonly code: string;
      readonly message: string;
      readonly artifactPath?: string;
      readonly route?: SetupRouteMetadata;
      readonly cause?: string;
    } {
  const resolvedRoutes: ResolvedSetupRoute[] = [];

  for (const route of input.routes) {
    const exitRelay = selectSetupRouteExit({
      route,
      relayCatalog: input.relayCatalog,
    });

    if (!exitRelay.ok) {
      return {
        ok: false,
        phase: 'relay-normalize',
        source: exitRelay.source,
        code: exitRelay.code,
        message: exitRelay.message,
        ...(exitRelay.artifactPath ? { artifactPath: exitRelay.artifactPath } : {}),
        route: summarizeSetupRoute(route),
        ...(exitRelay.cause ? { cause: exitRelay.cause } : {}),
      };
    }

    resolvedRoutes.push({
      ...route,
      exitRelay: exitRelay.relay,
    });
  }

  return {
    ok: true,
    value: resolvedRoutes,
  };
}

function selectSetupRouteExit(input: {
  readonly route: PlannedSetupRoute;
  readonly relayCatalog: MullvadRelayCatalog;
}):
  | {
      readonly ok: true;
      readonly relay: MullvadRelay;
    }
  | {
      readonly ok: false;
      readonly source: 'canonical-config' | 'relay-catalog' | 'user-input';
      readonly code: 'NO_MATCHING_RELAY' | 'MISSING_SOCKS_METADATA';
      readonly message: string;
      readonly artifactPath?: string;
      readonly cause?: string;
    } {
  const candidates = input.relayCatalog.relays.filter((relay) => {
    if (input.route.resolvedLocation.kind === 'country') {
      return relay.location.countryCode === input.route.resolvedLocation.countryCode;
    }

    if (input.route.resolvedLocation.kind === 'city') {
      return (
        relay.location.countryCode === input.route.resolvedLocation.countryCode &&
        relay.location.cityCode === input.route.resolvedLocation.cityCode
      );
    }

    return relay.hostname === input.route.resolvedLocation.hostname;
  });
  const selectedRelay = choosePreferredSetupRelay(candidates);

  if (!selectedRelay) {
    return {
      ok: false,
      source: 'canonical-config',
      code: 'NO_MATCHING_RELAY',
      message: `No active Mullvad relay matched the requested route ${input.route.alias}.`,
      artifactPath: input.route.relayPreference.requested,
      cause: `Resolved ${input.route.requested} but no active relay survived exact exit selection.`,
    };
  }

  if (!selectedRelay.socksName || !selectedRelay.socksPort) {
    return {
      ok: false,
      source: 'relay-catalog',
      code: 'MISSING_SOCKS_METADATA',
      message: `Relay ${selectedRelay.hostname} did not include SOCKS metadata required for route pinning.`,
      artifactPath: input.route.relayPreference.requested,
      cause:
        'Fetch the Mullvad legacy relay catalog with SOCKS metadata before creating routed exits.',
    };
  }

  return {
    ok: true,
    relay: selectedRelay,
  };
}

function summarizeSetupRoute(route: SetupRouteMetadata): SetupRouteMetadata {
  return {
    index: route.index,
    requested: route.requested,
    alias: route.alias,
    hostname: route.hostname,
    bindIp: route.bindIp,
    deviceName: route.deviceName,
  };
}

function createRouteExitMetadata(
  relay: MullvadRelay,
): MullgateConfig['routing']['locations'][number]['mullvad']['exit'] {
  return {
    relayHostname: relay.hostname,
    relayFqdn: relay.fqdn,
    socksHostname: requireDefined(
      relay.socksName,
      `Expected relay ${relay.hostname} to include a SOCKS hostname.`,
    ),
    socksPort: requireDefined(
      relay.socksPort,
      `Expected relay ${relay.hostname} to include a SOCKS port.`,
    ),
    countryCode: relay.location.countryCode,
    cityCode: relay.location.cityCode,
  };
}

export async function provisionRouteWithRetries(input: {
  accountNumber: string;
  route: PlannedSetupRoute;
  provisioningBaseUrl?: string | URL;
  fetch?: typeof globalThis.fetch;
  checkedAt?: string;
}): Promise<ProvisionWireguardResult> {
  let attempt = 0;
  let lastResult: ProvisionWireguardResult | null = null;

  while (attempt < PROVISION_RETRY_LIMIT) {
    attempt += 1;
    const provisionResult = await provisionWireguard({
      accountNumber: input.accountNumber,
      deviceName: input.route.deviceName,
      ...(input.provisioningBaseUrl ? { baseUrl: input.provisioningBaseUrl } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
      checkedAt: input.checkedAt,
    });

    if (provisionResult.ok) {
      return provisionResult;
    }

    lastResult = provisionResult;

    if (
      !provisionResult.retryable ||
      !shouldRetryProvisioningFailure(provisionResult) ||
      attempt >= PROVISION_RETRY_LIMIT
    ) {
      return provisionResult;
    }

    const retryDelayMs = provisionResult.retryAfterMs ?? PROVISION_RETRY_FALLBACK_DELAY_MS;
    await delay(retryDelayMs);
  }

  return (
    lastResult ?? {
      ok: false,
      phase: 'wireguard-provision',
      source: 'mullvad-wg-endpoint',
      endpoint: new URL(input.provisioningBaseUrl ?? 'https://api.mullvad.net/wg').toString(),
      checkedAt: input.checkedAt ?? new Date().toISOString(),
      code: 'NETWORK_ERROR',
      message: `Provisioning failed for routed location ${input.route.alias}.`,
      cause: 'Provisioning retries exhausted without a recorded Mullvad response.',
      retryable: true,
    }
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function shouldRetryProvisioningFailure(
  result: Extract<ProvisionWireguardResult, { ok: false }>,
): boolean {
  if (result.code === 'NETWORK_ERROR') {
    return true;
  }

  if (result.code !== 'HTTP_ERROR') {
    return false;
  }

  if (result.statusCode === 429) {
    return true;
  }

  const cause = result.cause ?? '';
  return /\bthrottled\b|\bretry\b|\btry again\b/i.test(cause);
}

function toSetupSuccessRoute(route: ResolvedSetupRoute): SetupSuccessRoute {
  return {
    ...summarizeSetupRoute(route),
    exitRelayHostname: route.exitRelay.hostname,
    exitSocksHostname: requireDefined(
      route.exitRelay.socksName,
      `Expected relay ${route.exitRelay.hostname} to include a SOCKS hostname.`,
    ),
    exitSocksPort: requireDefined(
      route.exitRelay.socksPort,
      `Expected relay ${route.exitRelay.hostname} to include a SOCKS port.`,
    ),
  };
}

function formatProvisioningCause(result: Extract<ProvisionWireguardResult, { ok: false }>): string {
  return result.cause ?? result.message;
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
  provisioning: Extract<ProvisionWireguardResult, { ok: true }>;
  routes: readonly ResolvedSetupRoute[];
  relayCatalog: MullvadRelayCatalog;
  paths: MullgatePaths;
  checkedAt?: string;
}): MullgateConfig {
  const timestamp = input.checkedAt ?? new Date().toISOString();
  const httpsEnabled =
    input.inputs.httpsPort !== null ||
    Boolean(input.inputs.httpsCertPath || input.inputs.httpsKeyPath);
  const primaryRoute = requireDefined(
    input.routes[0],
    'Expected at least one routed location when creating the canonical config.',
  );
  const routingLocations = input.routes.map((route) => ({
    alias: route.alias,
    hostname: route.hostname,
    bindIp: route.bindIp,
    relayPreference: structuredClone(route.relayPreference),
    mullvad: {
      relayConstraints: {
        providers: [],
      },
      exit: createRouteExitMetadata(route.exitRelay),
    },
    runtime: {
      routeId: route.routeId,
      httpsBackendName: `route-${route.routeId}`,
    },
  }));

  return normalizeMullgateConfig({
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
        mode: input.inputs.exposureMode,
        allowLan: input.inputs.exposureMode !== 'loopback',
        baseDomain: input.inputs.exposureBaseDomain,
      },
      location: structuredClone(primaryRoute.relayPreference),
      https: {
        enabled: httpsEnabled,
        ...(input.inputs.httpsCertPath ? { certPath: input.inputs.httpsCertPath } : {}),
        ...(input.inputs.httpsKeyPath ? { keyPath: input.inputs.httpsKeyPath } : {}),
      },
    },
    mullvad: {
      accountNumber: input.inputs.accountNumber,
      ...(input.inputs.deviceName ? { deviceName: input.inputs.deviceName } : {}),
      lastProvisionedAt: input.provisioning.checkedAt,
      relayConstraints: {
        providers: [],
      },
      wireguard: input.provisioning.value.toConfigValue(),
    },
    routing: {
      locations: routingLocations,
    },
    runtime: {
      backend: 'shared-entry-wireguard-route-proxy',
      sourceConfigPath: input.paths.configFile,
      entryWireproxyConfigPath: input.paths.entryWireproxyConfigFile,
      routeProxyConfigPath: input.paths.routeProxyConfigFile,
      validationReportPath: input.paths.runtimeValidationReportFile,
      relayCachePath: input.paths.provisioningCacheFile,
      dockerComposePath: input.paths.dockerComposePath,
      runtimeBundle: {
        bundleDir: input.paths.runtimeBundleDir,
        dockerComposePath: input.paths.runtimeComposeFile,
        httpsSidecarConfigPath: input.paths.runtimeHttpsSidecarConfigFile,
        manifestPath: input.paths.runtimeBundleManifestFile,
      },
      status: {
        phase: 'unvalidated',
        lastCheckedAt: null,
        message: `Saved relay catalog from ${input.relayCatalog.source}; waiting for shared-runtime validation.`,
      },
    },
    diagnostics: {
      lastRuntimeStartReportPath: input.paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  });
}

async function collectSetupInputs(input: {
  interactive: boolean;
  initialValues?: Partial<RawSetupInputValues>;
  paths: MullgatePaths;
}): Promise<
  | typeof PROMPT_CANCELLED
  | { readonly ok: true; readonly value: SetupInputValues }
  | {
      readonly ok: false;
      readonly source: 'input';
      readonly message: string;
      readonly artifactPath?: string;
    }
> {
  const values = normalizeInitialSetupValues(input.initialValues);
  const configuredLocations = values.locations ?? ['se-gothenburg'];

  if (!input.interactive) {
    const missing = [
      ['account number', values.accountNumber],
      ['proxy username', values.username],
      ['proxy password', values.password],
      [
        'location alias',
        configuredLocations.length > 0 ? configuredLocations.join(', ') : undefined,
      ],
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
    validate: (value) =>
      /^\d{6,16}$/.test((value ?? '').trim()) ? undefined : 'Enter 6-16 digits.',
  });

  if (isCancel(accountNumber)) {
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
    validate: (value) =>
      (value ?? '').trim().length > 0 ? undefined : 'Proxy username is required.',
  });

  if (isCancel(username)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const proxyPassword = await password({
    message: 'Proxy password',
    mask: '•',
    validate: (value) =>
      (value ?? '').trim().length > 0 ? undefined : 'Proxy password is required.',
  });

  if (isCancel(proxyPassword)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const locationAliases = await text({
    message: 'Mullvad route aliases (comma-separated, ordered)',
    initialValue: configuredLocations.join(', '),
    placeholder: 'sweden-gothenburg, austria-vienna',
    validate: (value) =>
      parseLocationList(value).length > 0
        ? undefined
        : 'Enter at least one country, city, or relay alias.',
  });

  if (isCancel(locationAliases)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const exposureModeInput = await text({
    message: 'Exposure mode (loopback, private-network, public)',
    initialValue: values.exposureMode,
    validate: validateExposureModeInput,
  });

  if (isCancel(exposureModeInput)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const selectedExposureMode = parseExposureMode(exposureModeInput.trim());
  const bindHost = await text({
    message: selectedExposureMode === 'private-network' ? 'Private-network host IP' : 'Bind host',
    initialValue: deriveInteractiveBindHostDefault({
      selectedExposureMode,
      initialValues: input.initialValues,
      normalizedBindHost: values.bindHost,
    }),
    validate: (value) => ((value ?? '').trim().length > 0 ? undefined : 'Bind host is required.'),
  });

  if (isCancel(bindHost)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const baseDomainInput = await text({
    message: 'Base domain for derived route hostnames (optional)',
    initialValue: values.exposureBaseDomain ?? '',
    placeholder: 'proxy.example.com',
    validate: validateBaseDomainInput,
  });

  if (isCancel(baseDomainInput)) {
    clackCancel('Setup cancelled.');
    return PROMPT_CANCELLED;
  }

  const routeBindIpInput =
    selectedExposureMode !== 'public'
      ? undefined
      : await text({
          message: 'Route bind IPs (comma-separated, ordered)',
          initialValue: values.routeBindIps?.join(', ') ?? values.bindHost,
          placeholder: '192.168.10.10, 192.168.10.11',
          validate: (value) =>
            parseBindIpList(value).length > 0
              ? undefined
              : 'Enter at least one bind IP for non-loopback exposure.',
        });

  if (isCancel(routeBindIpInput)) {
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
      validate: (value) =>
        (value ?? '').trim().length > 0
          ? undefined
          : 'Certificate path is required when HTTPS is enabled.',
    });

    if (isCancel(certPath)) {
      clackCancel('Setup cancelled.');
      return PROMPT_CANCELLED;
    }

    const keyPath = await text({
      message: 'HTTPS key path',
      initialValue: values.httpsKeyPath,
      validate: (value) =>
        (value ?? '').trim().length > 0 ? undefined : 'Key path is required when HTTPS is enabled.',
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
    routeBindIps: parseBindIpList(routeBindIpInput),
    exposureMode: selectedExposureMode,
    exposureBaseDomain: normalizeExposureBaseDomain(baseDomainInput.trim()),
    socksPort: Number(socksPort.trim()),
    httpPort: Number(httpPort.trim()),
    username: username.trim(),
    password: proxyPassword.trim(),
    locations: parseLocationList(locationAliases) as [string, ...string[]],
    httpsCertPath,
    httpsKeyPath,
    httpsPort,
  });

  outro(
    `Will provision ${finalized.locations.join(', ')} with ${finalized.exposureMode} exposure and write Mullgate config to ${input.paths.configFile}.`,
  );

  return {
    ok: true,
    value: finalized,
  };
}

async function saveConfigSafely(
  store: ConfigStore,
  config: MullgateConfig,
): Promise<{ readonly ok: true } | SetupFailure> {
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

function normalizeInitialSetupValues(
  initialValues: Partial<RawSetupInputValues> | undefined,
): Partial<RawSetupInputValues> {
  const exposureMode = initialValues?.exposureMode ?? DEFAULT_EXPOSURE_MODE;
  const normalizedLocations = parseLocationList(
    initialValues?.locations ?? initialValues?.location,
  );
  const locations = (normalizedLocations.length > 0 ? normalizedLocations : ['se-gothenburg']) as [
    string,
    ...string[],
  ];
  const routeBindIps = parseBindIpList(initialValues?.routeBindIps ?? initialValues?.bindHost);

  return {
    accountNumber: initialValues?.accountNumber?.trim(),
    bindHost:
      initialValues?.bindHost?.trim() || routeBindIps[0] || deriveDefaultBindHost(exposureMode),
    routeBindIps,
    exposureMode,
    exposureBaseDomain: normalizeExposureBaseDomain(initialValues?.exposureBaseDomain),
    socksPort: initialValues?.socksPort ?? DEFAULT_SOCKS_PORT,
    httpPort: initialValues?.httpPort ?? DEFAULT_HTTP_PORT,
    username: initialValues?.username?.trim() || DEFAULT_PROXY_USERNAME,
    password: initialValues?.password,
    locations,
    location: locations[0],
    httpsPort: initialValues?.httpsPort ?? null,
    httpsCertPath: initialValues?.httpsCertPath?.trim(),
    httpsKeyPath: initialValues?.httpsKeyPath?.trim(),
    deviceName: initialValues?.deviceName?.trim() || defaultDeviceName(),
  };
}

function finalizeSetupValues(values: Partial<RawSetupInputValues>): SetupInputValues {
  const exposureMode = values.exposureMode ?? DEFAULT_EXPOSURE_MODE;
  const bindHost = values.bindHost?.trim() || deriveDefaultBindHost(exposureMode);
  const parsedLocations = parseLocationList(values.locations ?? values.location);
  const locations = (parsedLocations.length > 0 ? parsedLocations : ['se-gothenburg']) as [
    string,
    ...string[],
  ];
  const routeBindIps = parseBindIpList(values.routeBindIps ?? bindHost);
  const accountNumber = values.accountNumber?.trim();
  const socksPort = values.socksPort;
  const httpPort = values.httpPort;
  const username = values.username?.trim();
  const password = values.password?.trim();

  if (
    !accountNumber ||
    !bindHost ||
    socksPort === undefined ||
    httpPort === undefined ||
    !username ||
    !password
  ) {
    throw new Error('Setup values are incomplete. Missing one or more required setup inputs.');
  }

  const finalizedRouteBindIps = (routeBindIps.length > 0 ? routeBindIps : [bindHost]) as [
    string,
    ...string[],
  ];

  return {
    accountNumber,
    bindHost,
    routeBindIps: finalizedRouteBindIps,
    exposureMode,
    exposureBaseDomain: normalizeExposureBaseDomain(values.exposureBaseDomain),
    socksPort,
    httpPort,
    username,
    password,
    locations,
    location: locations[0],
    httpsPort: values.httpsPort ?? null,
    ...(values.httpsCertPath ? { httpsCertPath: values.httpsCertPath.trim() } : {}),
    ...(values.httpsKeyPath ? { httpsKeyPath: values.httpsKeyPath.trim() } : {}),
    ...(values.deviceName ? { deviceName: values.deviceName.trim() } : {}),
  };
}

function parseLocationList(value: readonly string[] | string | undefined): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseLocationList(entry));
  }

  return [];
}

function parseBindIpList(value: readonly string[] | string | undefined): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseBindIpList(entry));
  }

  return [];
}

function deriveInteractiveBindHostDefault(input: {
  readonly selectedExposureMode: ExposureMode;
  readonly initialValues?: Partial<RawSetupInputValues>;
  readonly normalizedBindHost?: string;
}): string {
  const explicitRouteBindIps = parseBindIpList(input.initialValues?.routeBindIps);
  const explicitBindHost = input.initialValues?.bindHost?.trim();

  if (explicitRouteBindIps.length > 0) {
    return explicitRouteBindIps[0] ?? deriveDefaultBindHost(input.selectedExposureMode);
  }

  if (explicitBindHost) {
    return explicitBindHost;
  }

  if (
    input.initialValues?.exposureMode === input.selectedExposureMode &&
    input.normalizedBindHost?.trim()
  ) {
    return input.normalizedBindHost.trim();
  }

  return deriveDefaultBindHost(input.selectedExposureMode);
}

function resolveSetupInputs(
  values: SetupInputValues,
  artifactPath: string,
):
  | { readonly ok: true; readonly value: SetupInputValues }
  | {
      readonly ok: false;
      readonly phase: 'setup-validation';
      readonly source: 'input';
      readonly code: string;
      readonly message: string;
      readonly cause?: string;
      readonly artifactPath: string;
    } {
  const exposureContract = validateExposureSettings({
    routeCount: values.locations.length,
    exposureMode: values.exposureMode,
    exposureBaseDomain: values.exposureBaseDomain,
    routeBindIps: parseBindIpList(values.routeBindIps),
    artifactPath,
  });

  if (!exposureContract.ok) {
    return exposureContract;
  }

  return {
    ok: true,
    value: {
      ...values,
      bindHost: exposureContract.bindHost,
      routeBindIps: exposureContract.routeBindIps,
      exposureBaseDomain: exposureContract.baseDomain,
    },
  };
}

function validateExposureModeInput(value: string | undefined): string | undefined {
  const normalized = (value ?? '').trim();
  return normalized === 'loopback' || normalized === 'private-network' || normalized === 'public'
    ? undefined
    : 'Enter loopback, private-network, or public.';
}

function parseExposureMode(value: string): ExposureMode {
  if (value === 'loopback' || value === 'private-network' || value === 'public') {
    return value;
  }

  return DEFAULT_EXPOSURE_MODE;
}

function validateBaseDomainInput(value: string | undefined): string | undefined {
  const normalized = normalizeExposureBaseDomain(value);
  return !normalized || isValidBaseDomain(normalized)
    ? undefined
    : 'Enter a valid DNS suffix like proxy.example.com.';
}

function isValidBaseDomain(value: string): boolean {
  if (value.length > 253 || value.includes('..')) {
    return false;
  }

  const labels = value.split('.');

  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
    !/^\d+$/.test(labels.at(-1) ?? '')
  );
}

function chooseUniqueRouteLabel(candidate: string, usedRouteLabels: Set<string>): string {
  const baseCandidate = normalizeLocationToken(candidate) || 'route';
  let resolvedCandidate = baseCandidate;
  let suffix = 2;

  while (usedRouteLabels.has(resolvedCandidate)) {
    resolvedCandidate = `${baseCandidate}-${suffix}`;
    suffix += 1;
  }

  usedRouteLabels.add(resolvedCandidate);
  return resolvedCandidate;
}

export function deriveCanonicalRouteLabel(target: LocationAliasTarget): string {
  if (target.kind === 'country') {
    return normalizeLocationToken(target.countryName) || target.countryCode;
  }

  if (target.kind === 'city') {
    return `${normalizeLocationToken(target.countryName)}-${normalizeLocationToken(target.cityName)}`;
  }

  return normalizeLocationToken(target.hostname);
}

export function deriveRouteDeviceName(
  baseDeviceName: string,
  _routeLabel: string,
  _routeCount: number,
): string {
  return baseDeviceName;
}

function choosePreferredSetupRelay(relays: readonly MullvadRelay[]): MullvadRelay | null {
  const sorted = [...relays].sort(
    (left, right) =>
      Number(right.active) - Number(left.active) ||
      left.location.countryCode.localeCompare(right.location.countryCode) ||
      left.location.cityCode.localeCompare(right.location.cityCode) ||
      left.hostname.localeCompare(right.hostname),
  );

  return sorted[0] ?? null;
}

export function createRouteRelayPreference(
  requestedAlias: string,
  canonicalAlias: string,
  target: LocationAliasTarget,
): MullgateConfig['setup']['location'] {
  return {
    requested: requestedAlias,
    country: target.countryCode,
    ...(target.kind === 'city' || target.kind === 'relay' ? { city: target.cityCode } : {}),
    ...(target.kind === 'relay' ? { hostnameLabel: target.hostname } : {}),
    resolvedAlias: canonicalAlias,
  };
}

function parseStoredRelayCatalog(
  payload: unknown,
):
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
  return typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'string'
    ? ((value as Record<string, unknown>)[key] as string)
    : null;
}

function readNumberProperty(value: unknown, key: string): number | null {
  return typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'number'
    ? ((value as Record<string, unknown>)[key] as number)
    : null;
}

function readArrayProperty(value: unknown, key: string): unknown[] | null {
  return typeof value === 'object' &&
    value !== null &&
    key in value &&
    Array.isArray((value as Record<string, unknown>)[key])
    ? ((value as Record<string, unknown>)[key] as unknown[])
    : null;
}

export function summarizeValidationSource(
  result: Awaited<ReturnType<typeof validateRuntimeArtifacts>>,
): string {
  const labels = result.checks.map((check) => {
    if (check.artifact === 'entry-wireproxy') {
      if (check.source === 'wireproxy-binary') {
        return 'wireproxy-binary/configtest';
      }

      if (check.source === 'docker') {
        return 'docker/configtest';
      }

      return 'internal-wireproxy-syntax';
    }

    if (check.source === 'docker') {
      return 'docker/3proxy-startup';
    }

    return 'internal-3proxy-syntax';
  });

  return [...new Set(labels)].join(' + ');
}

function validatePortInput(value: string | undefined): string | undefined {
  const numeric = Number((value ?? '').trim());
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535
    ? undefined
    : 'Enter a port between 1 and 65535.';
}

export function defaultDeviceName(): string {
  return `mullgate-${hostname().split('.')[0] || 'host'}`;
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
