import {
  defaultDeviceName,
  loadStoredRelayCatalog,
  type PlannedSetupRoute,
  planSetupRoutes,
  summarizeValidationSource,
  withRuntimeStatus,
} from '../app/setup-runner.js';
import { validateExposureSettings } from '../config/exposure-contract.js';
import type { MullgateConfig } from '../config/schema.js';
import { type ConfigStore, normalizeMullgateConfig } from '../config/store.js';
import { createLocationAliasCatalog } from '../domain/location-aliases.js';
import {
  fetchRelays,
  type MullvadRelay,
  type MullvadRelayCatalog,
} from '../mullvad/fetch-relays.js';
import { requireArrayValue, requireDefined } from '../required.js';
import { renderRuntimeProxyArtifacts } from '../runtime/render-runtime-proxies.js';
import { validateRuntimeArtifacts } from '../runtime/validate-runtime.js';
import type { ProxyExportResolvedInput } from './proxy-export-plan.js';
import {
  describeConfiguredProxyExportRoutes,
  planProxyExportRelayTargets,
} from './proxy-export-route-descriptors.js';
import type { ProxyExportFailure, ProxyExportSelector } from './proxy-export-selectors.js';

const LEGACY_RELAYS_URL = 'https://api.mullvad.net/www/relays/all/';
const RELAYS_URL_ENV = 'MULLGATE_MULLVAD_RELAYS_URL';

type PlannedProxyExportTarget = {
  readonly relay: MullvadRelay;
  readonly selector: ProxyExportSelector;
};

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
    relayCatalog: input.relayCatalog,
    selectors: input.exportInput.selectors,
    configuredRoutes: describeConfiguredProxyExportRoutes({
      config: input.config,
      relayCatalog: input.relayCatalog,
    }),
  });

  if (plannedTargets.targets.length === 0) {
    return {
      ok: true,
      config: input.config,
      relayCatalog: input.relayCatalog,
      createdAliases: [],
    };
  }

  const tailscaleRouteCheck = validateTailscaleExportTargets({
    config: input.config,
    targets: plannedTargets.targets,
    configPath: input.store.paths.configFile,
  });

  if (!tailscaleRouteCheck.ok) {
    return tailscaleRouteCheck;
  }

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
  const updatedConfig = createConfigWithPlannedExportRoutes({
    config: input.config,
    plannedRoutes,
    plannedTargets: plannedTargets.targets,
  });
  const createdAliases = plannedRoutes.map((route) => route.alias);

  if (input.exportInput.writeMode === 'dry-run') {
    return {
      ok: true,
      config: updatedConfig,
      relayCatalog: input.relayCatalog,
      createdAliases,
    };
  }

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
    inlineSelectors: renderResult.inlineSelectors,
    accessMode: pendingConfig.setup.access.mode,
    exposureMode: pendingConfig.setup.exposure.mode,
    bindHost: pendingConfig.setup.bind.host,
    bind: {
      socksPort: pendingConfig.setup.bind.socksPort,
      httpPort: pendingConfig.setup.bind.httpPort,
    },
    validateEntryWireproxy: pendingConfig.mullvad.exitSource !== 'tailscale-exit',
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
    createdAliases,
  };
}

function createConfigWithPlannedExportRoutes(input: {
  readonly config: MullgateConfig;
  readonly plannedRoutes: readonly PlannedSetupRoute[];
  readonly plannedTargets: readonly PlannedProxyExportTarget[];
}): MullgateConfig {
  return normalizeMullgateConfig({
    ...input.config,
    updatedAt: new Date().toISOString(),
    routing: {
      locations: [
        ...input.config.routing.locations,
        ...input.plannedRoutes.map((route, index) => {
          const target = requireArrayValue(
            input.plannedTargets,
            index,
            `Missing planned export target at index ${index}.`,
          );

          return createProvisionedRouteConfig({
            route,
            relay: target.relay,
            providers: target.selector.providers,
          });
        }),
      ],
    },
  });
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

  if (input.config.setup.access.mode === 'inline-selector') {
    return {
      ok: true,
      routeBindIps: Array.from({ length: input.count }, () => input.config.setup.bind.host),
    };
  }

  if (input.config.setup.exposure.mode === 'loopback') {
    const exposure = validateExposureSettings({
      routeCount: input.config.routing.locations.length + input.count,
      exposureMode: 'loopback',
      accessMode: input.config.setup.access.mode,
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

  try {
    for (let index = 0; index < input.count; index += 1) {
      previousBindIp = incrementIpv4Address(previousBindIp);
      nextRouteBindIps.push(previousBindIp);
    }
  } catch (error) {
    return {
      ok: false,
      phase: 'setup-validation',
      source: 'input',
      message: error instanceof Error ? error.message : String(error),
      configPath: input.configPath,
    };
  }

  const validated = validateExposureSettings({
    routeCount: input.config.routing.locations.length + input.count,
    exposureMode: input.config.setup.exposure.mode,
    accessMode: input.config.setup.access.mode,
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

  const numericValue = segments.reduce((accumulator, segment) => accumulator * 256 + segment, 0);

  if (numericValue >= 0xffffffff) {
    throw new Error(`Cannot derive the next bind IP from ${value}.`);
  }

  const nextValue = numericValue + 1;
  return [24, 16, 8, 0].map((shift) => String(Math.floor(nextValue / 2 ** shift) % 256)).join('.');
}

function validateTailscaleExportTargets(input: {
  readonly config: MullgateConfig;
  readonly targets: readonly PlannedProxyExportTarget[];
  readonly configPath: string;
}): { readonly ok: true } | ProxyExportFailure {
  if (input.config.mullvad.exitSource !== 'tailscale-exit') {
    return { ok: true };
  }

  const missingRelay = input.targets.find((target) => !target.relay.socksInternalIp);

  if (!missingRelay) {
    return { ok: true };
  }

  return {
    ok: false,
    phase: 'relay-normalize',
    source: 'mullvad-relay-catalog',
    message: `Relay ${missingRelay.relay.hostname} is missing the internal SOCKS IP required by tailscale-exit routes.`,
    configPath: input.configPath,
    artifactPath: missingRelay.relay.socksName ?? missingRelay.relay.hostname,
    cause:
      'Refresh the relay catalog with tailscale-exit metadata before applying selector-added routes.',
  };
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
        ...(input.relay.socksInternalIp ? { socksInternalIp: input.relay.socksInternalIp } : {}),
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

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
