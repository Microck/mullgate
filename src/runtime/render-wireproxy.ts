import { chmod, type FileHandle, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type MullgatePaths,
  type RouteWireproxyPaths,
  resolveRouteWireproxyPaths,
} from '../config/paths.js';
import type { MullgateConfig, RoutedLocation } from '../config/schema.js';
import {
  createLocationAliasCatalog,
  type LocationAliasTarget,
  resolveLocationAlias,
} from '../domain/location-aliases.js';
import type { MullvadRelay, MullvadRelayCatalog } from '../mullvad/fetch-relays.js';
import { requireDefined } from '../required.js';

const DEFAULT_ALLOWED_IPS = '0.0.0.0/0, ::/0';
const DEFAULT_KEEPALIVE_SECONDS = 25;
const DEFAULT_MULLVAD_DNS = '10.64.0.1';
const DEFAULT_WIREGUARD_PORT = 51820;
const _CONTAINER_BIND_HOST = '0.0.0.0';

export type WireproxyRouteIdentity = {
  readonly routeId: string;
  readonly routeAlias: string;
  readonly routeHostname: string;
  readonly routeBindIp: string;
  readonly serviceName: string;
  readonly backendName: string;
};

export type RenderedWireproxyRoute = WireproxyRouteIdentity & {
  readonly selectedRelay: MullvadRelay;
  readonly selectedTarget: LocationAliasTarget | null;
  readonly wireproxyConfig: string;
  readonly artifactPaths: RouteWireproxyPaths;
};

export type RenderedWireproxyArtifacts = {
  readonly wireproxyConfigPath: string;
  readonly relayCachePath: string;
  readonly configTestReportPath: string;
};

export type RenderWireproxySuccess = {
  ok: true;
  phase: 'artifact-render';
  source: 'canonical-config';
  checkedAt: string;
  selectedRelay: MullvadRelay;
  selectedTarget: LocationAliasTarget | null;
  wireproxyConfig: string;
  routes: readonly RenderedWireproxyRoute[];
  artifactPaths: RenderedWireproxyArtifacts;
};

export type RenderWireproxyFailure = {
  ok: false;
  phase: 'artifact-render';
  source: 'canonical-config' | 'relay-catalog' | 'user-input' | 'filesystem';
  checkedAt: string;
  code: 'MISSING_WIREGUARD' | 'NO_MATCHING_RELAY' | 'WRITE_FAILED';
  message: string;
  cause?: string;
  artifactPath?: string;
  routeId?: string;
  routeAlias?: string;
  routeHostname?: string;
  routeBindIp?: string;
  serviceName?: string;
};

export type RenderWireproxyResult = RenderWireproxySuccess | RenderWireproxyFailure;

export type RenderWireproxyOptions = {
  config: MullgateConfig;
  relayCatalog: MullvadRelayCatalog;
  paths: MullgatePaths;
  generatedAt?: string;
};

export type ConfiguredRouteRelay = WireproxyRouteIdentity & {
  readonly selectedRelay: MullvadRelay;
  readonly selectedTarget: LocationAliasTarget | null;
};

export function planWireproxyArtifacts(options: RenderWireproxyOptions): RenderWireproxyResult {
  const checkedAt = options.generatedAt ?? new Date().toISOString();
  const routes: RenderedWireproxyRoute[] = [];

  for (const route of options.config.routing.locations) {
    if (
      !route.mullvad.wireguard.publicKey ||
      !route.mullvad.wireguard.privateKey ||
      !route.mullvad.wireguard.ipv4Address
    ) {
      return {
        ok: false,
        phase: 'artifact-render',
        source: 'canonical-config',
        checkedAt,
        code: 'MISSING_WIREGUARD',
        message: `Cannot render wireproxy artifacts for route ${route.runtime.routeId} before Mullvad WireGuard credentials are fully provisioned.`,
        artifactPath: options.paths.configFile,
        ...describeRoute(route),
      };
    }

    const selectedTargetResult = resolveConfiguredLocation(route, options.relayCatalog.relays);

    if (!selectedTargetResult.ok) {
      return {
        ok: false,
        phase: 'artifact-render',
        source: selectedTargetResult.source,
        checkedAt,
        code: 'NO_MATCHING_RELAY',
        message: `No relay from the cached Mullvad catalog matched route ${route.runtime.routeId}.`,
        ...(selectedTargetResult.cause ? { cause: selectedTargetResult.cause } : {}),
        artifactPath: selectedTargetResult.artifactPath,
        ...describeRoute(route),
      };
    }

    routes.push({
      ...describeRoute(route),
      selectedRelay: selectedTargetResult.value.relay,
      selectedTarget: selectedTargetResult.value.target,
      wireproxyConfig: buildWireproxyConfig(
        options.config,
        route,
        selectedTargetResult.value.relay,
        checkedAt,
      ),
      artifactPaths: resolveRouteWireproxyPaths(options.paths, route.runtime),
    });
  }

  const primaryRoute = requireDefined(
    routes[0],
    'Expected at least one rendered route when planning wireproxy artifacts.',
  );

  return {
    ok: true,
    phase: 'artifact-render',
    source: 'canonical-config',
    checkedAt,
    selectedRelay: primaryRoute.selectedRelay,
    selectedTarget: primaryRoute.selectedTarget,
    wireproxyConfig: primaryRoute.wireproxyConfig,
    routes,
    artifactPaths: {
      wireproxyConfigPath: options.paths.wireproxyConfigFile,
      relayCachePath: options.paths.provisioningCacheFile,
      configTestReportPath: options.paths.wireproxyConfigTestReportFile,
    },
  };
}

export function selectConfiguredRouteRelays(input: {
  readonly config: MullgateConfig;
  readonly relayCatalog: MullvadRelayCatalog;
}):
  | {
      readonly ok: true;
      readonly routes: readonly ConfiguredRouteRelay[];
    }
  | {
      readonly ok: false;
      readonly source: 'canonical-config' | 'relay-catalog' | 'user-input';
      readonly message: string;
      readonly cause?: string;
      readonly artifactPath?: string;
      readonly routeId: string;
      readonly routeAlias: string;
      readonly routeHostname: string;
      readonly routeBindIp: string;
      readonly serviceName: string;
    } {
  const routes: ConfiguredRouteRelay[] = [];

  for (const route of input.config.routing.locations) {
    const selectedTargetResult = resolveConfiguredLocation(route, input.relayCatalog.relays);

    if (!selectedTargetResult.ok) {
      return {
        ok: false,
        source: selectedTargetResult.source,
        message: 'No relay from the cached Mullvad catalog matched the saved route preference.',
        ...(selectedTargetResult.cause ? { cause: selectedTargetResult.cause } : {}),
        ...(selectedTargetResult.artifactPath
          ? { artifactPath: selectedTargetResult.artifactPath }
          : {}),
        ...describeRoute(route),
      };
    }

    routes.push({
      ...describeRoute(route),
      selectedRelay: selectedTargetResult.value.relay,
      selectedTarget: selectedTargetResult.value.target,
    });
  }

  return {
    ok: true,
    routes,
  };
}

export async function renderWireproxyArtifacts(
  options: RenderWireproxyOptions,
): Promise<RenderWireproxyResult> {
  const planned = planWireproxyArtifacts(options);

  if (!planned.ok) {
    return planned;
  }

  try {
    await ensureDirectory(options.paths.runtimeDir);
    await ensureDirectory(options.paths.appStateDir);
    await ensureDirectory(options.paths.appCacheDir);

    await writeFileAtomic(
      planned.artifactPaths.wireproxyConfigPath,
      planned.wireproxyConfig,
      0o600,
    );

    for (const route of planned.routes) {
      await writeFileAtomic(route.artifactPaths.wireproxyConfigPath, route.wireproxyConfig, 0o600);
    }

    await writeFileAtomic(
      planned.artifactPaths.relayCachePath,
      `${JSON.stringify(options.relayCatalog, null, 2)}\n`,
      0o600,
    );
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const failingRoute =
      planned.routes.find((route) => route.artifactPaths.wireproxyConfigPath.includes('.tmp')) ??
      null;

    return {
      ok: false,
      phase: 'artifact-render',
      source: 'filesystem',
      checkedAt: planned.checkedAt,
      code: 'WRITE_FAILED',
      message: 'Failed to persist derived wireproxy artifacts under the Mullgate XDG directories.',
      cause,
      artifactPath: options.paths.runtimeDir,
      ...(failingRoute ? describeRenderedRoute(failingRoute) : {}),
    };
  }

  return planned;
}

function describeRoute(route: RoutedLocation): WireproxyRouteIdentity {
  return {
    routeId: route.runtime.routeId,
    routeAlias: route.alias,
    routeHostname: route.hostname,
    routeBindIp: route.bindIp,
    serviceName: route.runtime.wireproxyServiceName,
    backendName: route.runtime.haproxyBackendName,
  };
}

function describeRenderedRoute(route: RenderedWireproxyRoute): WireproxyRouteIdentity {
  return {
    routeId: route.routeId,
    routeAlias: route.routeAlias,
    routeHostname: route.routeHostname,
    routeBindIp: route.routeBindIp,
    serviceName: route.serviceName,
    backendName: route.backendName,
  };
}

function buildWireproxyConfig(
  config: MullgateConfig,
  route: RoutedLocation,
  relay: MullvadRelay,
  generatedAt: string,
): string {
  const wireguard = route.mullvad.wireguard;
  const dnsServers = wireguard.dnsServers.length > 0 ? wireguard.dnsServers : [DEFAULT_MULLVAD_DNS];
  const interfaceAddresses = [wireguard.ipv4Address, wireguard.ipv6Address].filter(
    (value): value is string => Boolean(value),
  );
  const lines = [
    '# Generated by Mullgate. Derived artifact; edit canonical config instead.',
    `# Generated at ${generatedAt}`,
    `# Route ${route.runtime.routeId} (${route.hostname} -> ${route.bindIp})`,
    '',
    '[Interface]',
    `Address = ${interfaceAddresses.join(', ')}`,
    `PrivateKey = ${wireguard.privateKey}`,
    `DNS = ${dnsServers.join(', ')}`,
    '',
    '[Peer]',
    `PublicKey = ${relay.publicKey}`,
    `Endpoint = ${formatRelayEndpoint(relay)}`,
    `AllowedIPs = ${DEFAULT_ALLOWED_IPS}`,
    `PersistentKeepalive = ${DEFAULT_KEEPALIVE_SECONDS}`,
    '',
    '[Socks5]',
    `BindAddress = ${route.bindIp}:${config.setup.bind.socksPort}`,
    `Username = ${config.setup.auth.username}`,
    `Password = ${config.setup.auth.password}`,
    '',
    '[http]',
    `BindAddress = ${route.bindIp}:${config.setup.bind.httpPort}`,
    `Username = ${config.setup.auth.username}`,
    `Password = ${config.setup.auth.password}`,
  ];

  return `${lines.join('\n')}\n`;
}

function resolveConfiguredLocation(
  route: RoutedLocation,
  relays: readonly MullvadRelay[],
):
  | { ok: true; value: { relay: MullvadRelay; target: LocationAliasTarget | null } }
  | {
      ok: false;
      source: 'canonical-config' | 'relay-catalog' | 'user-input';
      message: string;
      cause?: string;
      artifactPath?: string;
    } {
  const directRelay = findDirectRelayMatch(relays, route);

  if (directRelay) {
    return {
      ok: true,
      value: {
        relay: directRelay,
        target: {
          kind: 'relay',
          hostname: directRelay.hostname,
          fqdn: directRelay.fqdn,
          countryCode: directRelay.location.countryCode,
          countryName: directRelay.location.countryName,
          cityCode: directRelay.location.cityCode,
          cityName: directRelay.location.cityName,
        },
      },
    };
  }

  const aliasInput =
    route.relayPreference.resolvedAlias ??
    route.relayPreference.hostnameLabel ??
    route.relayPreference.requested;
  const catalogResult = createLocationAliasCatalog(relays);

  if (!catalogResult.ok) {
    return {
      ok: false,
      source: 'relay-catalog',
      message: 'Mullvad relay metadata could not be normalized into a stable alias catalog.',
      cause: catalogResult.message,
    };
  }

  const resolvedAlias = resolveLocationAlias(catalogResult.value, aliasInput);

  if (!resolvedAlias.ok) {
    return {
      ok: false,
      source: resolvedAlias.source,
      message: 'No relay from the cached Mullvad catalog matched the saved route preference.',
      cause: resolvedAlias.message,
      artifactPath: aliasInput,
    };
  }

  const candidateRelays = relays.filter((relay) => relayMatchesTarget(relay, resolvedAlias.value));
  const constrainedRelays = applyRelayConstraints(candidateRelays, route);
  const selectedRelay = choosePreferredRelay(constrainedRelays);

  if (!selectedRelay) {
    return {
      ok: false,
      source: 'canonical-config',
      message: 'No relay from the cached Mullvad catalog matched the saved route preference.',
      cause: `Resolved alias ${resolvedAlias.alias} but no active relay satisfied the saved constraints.`,
      artifactPath: aliasInput,
    };
  }

  return {
    ok: true,
    value: {
      relay: selectedRelay,
      target: resolvedAlias.value,
    },
  };
}

function findDirectRelayMatch(
  relays: readonly MullvadRelay[],
  route: RoutedLocation,
): MullvadRelay | null {
  const constrained = applyRelayConstraints(relays, route);
  const hostnameCandidates = [route.hostname, route.relayPreference.hostnameLabel].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  for (const hostname of hostnameCandidates) {
    const exactRelay = constrained.find(
      (relay) => relay.hostname === hostname || relay.fqdn === hostname,
    );

    if (exactRelay) {
      return exactRelay;
    }
  }

  if (route.relayPreference.country || route.relayPreference.city) {
    const matchingRelays = constrained.filter((relay) => {
      if (
        route.relayPreference.country &&
        relay.location.countryCode !== route.relayPreference.country
      ) {
        return false;
      }

      if (route.relayPreference.city && relay.location.cityCode !== route.relayPreference.city) {
        return false;
      }

      return true;
    });

    return choosePreferredRelay(matchingRelays);
  }

  return null;
}

function relayMatchesTarget(relay: MullvadRelay, target: LocationAliasTarget): boolean {
  if (target.kind === 'country') {
    return relay.location.countryCode === target.countryCode;
  }

  if (target.kind === 'city') {
    return (
      relay.location.countryCode === target.countryCode &&
      relay.location.cityCode === target.cityCode
    );
  }

  return relay.hostname === target.hostname;
}

function applyRelayConstraints(
  relays: readonly MullvadRelay[],
  route: RoutedLocation,
): MullvadRelay[] {
  const providers = new Set(
    route.mullvad.relayConstraints.providers.map((provider) => provider.toLowerCase()),
  );

  return relays.filter((relay) => {
    if (providers.size > 0 && (!relay.provider || !providers.has(relay.provider.toLowerCase()))) {
      return false;
    }

    return true;
  });
}

function choosePreferredRelay(relays: readonly MullvadRelay[]): MullvadRelay | null {
  const sorted = [...relays].sort(
    (left, right) =>
      Number(right.active) - Number(left.active) ||
      left.location.countryCode.localeCompare(right.location.countryCode) ||
      left.location.cityCode.localeCompare(right.location.cityCode) ||
      left.hostname.localeCompare(right.hostname),
  );

  return sorted[0] ?? null;
}

function formatRelayEndpoint(relay: MullvadRelay): string {
  return `${relay.fqdn}:${relay.multihopPort ?? DEFAULT_WIREGUARD_PORT}`;
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
}

async function writeFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await open(temporaryPath, 'w', mode);
    await fileHandle.writeFile(content, 'utf8');
    await fileHandle.sync();
  } finally {
    await fileHandle?.close();
  }

  try {
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
    await chmod(filePath, mode);

    // Windows does not support syncing directory handles the same way POSIX does.
    // The rename still gives us the atomic replacement we need for these artifacts.
    if (process.platform === 'win32') {
      return;
    }

    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
