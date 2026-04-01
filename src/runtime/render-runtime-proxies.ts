import { chmod, type FileHandle, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { computePublishedPort, deriveRuntimeListenerHost } from '../config/exposure-contract.js';
import type { MullgatePaths } from '../config/paths.js';
import type { MullgateConfig, RoutedLocation } from '../config/schema.js';
import {
  createLocationAliasCatalog,
  type LocationAliasTarget,
  resolveLocationAlias,
} from '../domain/location-aliases.js';
import type { MullvadRelay, MullvadRelayCatalog } from '../mullvad/fetch-relays.js';

const DEFAULT_ALLOWED_IPS = '0.0.0.0/0, ::/0';
const DEFAULT_KEEPALIVE_SECONDS = 25;
const DEFAULT_MULLVAD_DNS = '10.64.0.1';
const DEFAULT_WIREGUARD_PORT = 51_820;

export const ENTRY_TUNNEL_SERVICE = 'entry-tunnel';
export const ROUTE_PROXY_SERVICE = 'route-proxy';
export const ENTRY_WIREPROXY_SOCKS_PORT = 39_101;
export const ENTRY_WIREPROXY_HTTP_PORT = 39_102;

export type RouteProxyIdentity = {
  readonly routeIndex: number;
  readonly routeId: string;
  readonly routeAlias: string;
  readonly routeHostname: string;
  readonly routeBindIp: string;
  readonly routeListenHost: string;
  readonly routeSocksPort: number;
  readonly routeHttpPort: number;
  readonly httpsBackendName: string;
};

export type RenderedRouteProxyRoute = RouteProxyIdentity & {
  readonly exitRelayHostname: string;
  readonly exitRelayFqdn: string;
  readonly exitSocksHostname: string;
  readonly exitSocksPort: number;
  readonly entryParent: {
    readonly host: '127.0.0.1';
    readonly port: number;
  };
};

export type RenderedRuntimeProxyArtifacts = {
  readonly entryWireproxyConfigPath: string;
  readonly routeProxyConfigPath: string;
  readonly relayCachePath: string;
};

export type RenderRuntimeProxySuccess = {
  readonly ok: true;
  readonly phase: 'artifact-render';
  readonly source: 'canonical-config';
  readonly checkedAt: string;
  readonly entryRelay: MullvadRelay;
  readonly entryTarget: LocationAliasTarget | null;
  readonly entryWireproxyConfig: string;
  readonly routeProxyConfig: string;
  readonly routes: readonly RenderedRouteProxyRoute[];
  readonly artifactPaths: RenderedRuntimeProxyArtifacts;
};

export type RenderRuntimeProxyFailure = {
  readonly ok: false;
  readonly phase: 'artifact-render';
  readonly source: 'canonical-config' | 'relay-catalog' | 'user-input' | 'filesystem';
  readonly checkedAt: string;
  readonly code:
    | 'MISSING_WIREGUARD'
    | 'NO_MATCHING_ENTRY_RELAY'
    | 'MISSING_ROUTE_EXIT'
    | 'WRITE_FAILED';
  readonly message: string;
  readonly cause?: string;
  readonly artifactPath?: string;
  readonly routeId?: string;
  readonly routeAlias?: string;
  readonly routeHostname?: string;
  readonly routeBindIp?: string;
  readonly serviceName?: string;
};

export type RenderRuntimeProxyResult = RenderRuntimeProxySuccess | RenderRuntimeProxyFailure;

export type RenderRuntimeProxyOptions = {
  readonly config: MullgateConfig;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly paths: MullgatePaths;
  readonly generatedAt?: string;
};

export function planRuntimeProxyArtifacts(
  options: RenderRuntimeProxyOptions,
): RenderRuntimeProxyResult {
  const checkedAt = options.generatedAt ?? new Date().toISOString();

  if (
    !options.config.mullvad.wireguard.publicKey ||
    !options.config.mullvad.wireguard.privateKey ||
    !options.config.mullvad.wireguard.ipv4Address
  ) {
    return {
      ok: false,
      phase: 'artifact-render',
      source: 'canonical-config',
      checkedAt,
      code: 'MISSING_WIREGUARD',
      message:
        'Cannot render runtime proxy artifacts before the shared Mullvad WireGuard device is fully provisioned.',
      artifactPath: options.paths.configFile,
      serviceName: ENTRY_TUNNEL_SERVICE,
    };
  }

  const entryRelayResult = resolveEntryRelay({
    config: options.config,
    relayCatalog: options.relayCatalog,
  });

  if (!entryRelayResult.ok) {
    return {
      ok: false,
      phase: 'artifact-render',
      source: entryRelayResult.source,
      checkedAt,
      code: 'NO_MATCHING_ENTRY_RELAY',
      message: 'No relay from the cached Mullvad catalog matched the shared entry preference.',
      ...(entryRelayResult.cause ? { cause: entryRelayResult.cause } : {}),
      ...(entryRelayResult.artifactPath ? { artifactPath: entryRelayResult.artifactPath } : {}),
      serviceName: ENTRY_TUNNEL_SERVICE,
    };
  }

  const routes = options.config.routing.locations.map((route, index) => {
    const exit = route.mullvad.exit;

    if (!exit.relayHostname || !exit.relayFqdn || !exit.socksHostname || !exit.socksPort) {
      return {
        ok: false as const,
        route,
      };
    }

    return {
      ok: true as const,
      value: {
        routeIndex: index,
        routeId: route.runtime.routeId,
        routeAlias: route.alias,
        routeHostname: route.hostname,
        routeBindIp: route.bindIp,
        routeListenHost: deriveRuntimeListenerHost(
          options.config.setup.exposure.mode,
          route.bindIp,
        ),
        routeSocksPort: computePublishedPort(
          options.config.setup.exposure.mode,
          options.config.setup.bind.socksPort,
          index,
        ),
        routeHttpPort: computePublishedPort(
          options.config.setup.exposure.mode,
          options.config.setup.bind.httpPort,
          index,
        ),
        httpsBackendName: route.runtime.httpsBackendName,
        exitRelayHostname: exit.relayHostname,
        exitRelayFqdn: exit.relayFqdn,
        exitSocksHostname: exit.socksHostname,
        exitSocksPort: exit.socksPort,
        entryParent: {
          host: '127.0.0.1' as const,
          port: ENTRY_WIREPROXY_SOCKS_PORT,
        },
      } satisfies RenderedRouteProxyRoute,
    };
  });

  const missingRoute = routes.find((route) => !route.ok);

  if (missingRoute && !missingRoute.ok) {
    return {
      ok: false,
      phase: 'artifact-render',
      source: 'canonical-config',
      checkedAt,
      code: 'MISSING_ROUTE_EXIT',
      message: `Route ${missingRoute.route.runtime.routeId} is missing an exact Mullvad exit definition.`,
      artifactPath: options.paths.configFile,
      ...describeRoute(missingRoute.route),
      serviceName: ROUTE_PROXY_SERVICE,
    };
  }

  const renderedRoutes = routes
    .filter((route): route is Extract<(typeof routes)[number], { ok: true }> => route.ok)
    .map((route) => route.value);

  return {
    ok: true,
    phase: 'artifact-render',
    source: 'canonical-config',
    checkedAt,
    entryRelay: entryRelayResult.value.relay,
    entryTarget: entryRelayResult.value.target,
    entryWireproxyConfig: buildEntryWireproxyConfig({
      config: options.config,
      relay: entryRelayResult.value.relay,
      generatedAt: checkedAt,
    }),
    routeProxyConfig: buildRouteProxyConfig({
      config: options.config,
      routes: renderedRoutes,
      generatedAt: checkedAt,
    }),
    routes: renderedRoutes,
    artifactPaths: {
      entryWireproxyConfigPath: options.paths.entryWireproxyConfigFile,
      routeProxyConfigPath: options.paths.routeProxyConfigFile,
      relayCachePath: options.paths.provisioningCacheFile,
    },
  };
}

export async function renderRuntimeProxyArtifacts(
  options: RenderRuntimeProxyOptions,
): Promise<RenderRuntimeProxyResult> {
  const planned = planRuntimeProxyArtifacts(options);

  if (!planned.ok) {
    return planned;
  }

  try {
    await ensureDirectory(options.paths.runtimeDir);
    await ensureDirectory(options.paths.appStateDir);
    await ensureDirectory(options.paths.appCacheDir);

    await writeFileAtomic(
      planned.artifactPaths.entryWireproxyConfigPath,
      planned.entryWireproxyConfig,
      0o600,
    );
    await writeFileAtomic(
      planned.artifactPaths.routeProxyConfigPath,
      planned.routeProxyConfig,
      0o600,
    );
    await writeFileAtomic(
      planned.artifactPaths.relayCachePath,
      `${JSON.stringify(options.relayCatalog, null, 2)}\n`,
      0o600,
    );
  } catch (error) {
    return {
      ok: false,
      phase: 'artifact-render',
      source: 'filesystem',
      checkedAt: planned.checkedAt,
      code: 'WRITE_FAILED',
      message:
        'Failed to persist derived runtime proxy artifacts under the Mullgate XDG directories.',
      cause: error instanceof Error ? error.message : String(error),
      artifactPath: options.paths.runtimeDir,
    };
  }

  return planned;
}

function buildEntryWireproxyConfig(input: {
  readonly config: MullgateConfig;
  readonly relay: MullvadRelay;
  readonly generatedAt: string;
}): string {
  const wireguard = input.config.mullvad.wireguard;
  const dnsServers = wireguard.dnsServers.length > 0 ? wireguard.dnsServers : [DEFAULT_MULLVAD_DNS];
  const interfaceAddresses = [wireguard.ipv4Address, wireguard.ipv6Address].filter(
    (value): value is string => Boolean(value),
  );
  const lines = [
    '# Generated by Mullgate. Derived artifact; edit canonical config instead.',
    `# Generated at ${input.generatedAt}`,
    `# Shared entry relay ${input.relay.hostname}`,
    '',
    '[Interface]',
    `Address = ${interfaceAddresses.join(', ')}`,
    `PrivateKey = ${wireguard.privateKey}`,
    `DNS = ${dnsServers.join(', ')}`,
    '',
    '[Peer]',
    `PublicKey = ${input.relay.publicKey}`,
    `Endpoint = ${formatRelayEndpoint(input.relay)}`,
    `AllowedIPs = ${DEFAULT_ALLOWED_IPS}`,
    `PersistentKeepalive = ${DEFAULT_KEEPALIVE_SECONDS}`,
    '',
    '[Socks5]',
    `BindAddress = 127.0.0.1:${ENTRY_WIREPROXY_SOCKS_PORT}`,
    '',
    '[http]',
    `BindAddress = 127.0.0.1:${ENTRY_WIREPROXY_HTTP_PORT}`,
  ];

  return `${lines.join('\n')}\n`;
}

function buildRouteProxyConfig(input: {
  readonly config: MullgateConfig;
  readonly routes: readonly RenderedRouteProxyRoute[];
  readonly generatedAt: string;
}): string {
  const lines = [
    '# Generated by Mullgate. Derived artifact; edit canonical config instead.',
    `# Generated at ${input.generatedAt}`,
    '# One shared 3proxy process publishes every per-route SOCKS5/HTTP listener.',
    'fakeresolve',
    'auth strong',
    `users ${input.config.setup.auth.username}:CL:${input.config.setup.auth.password}`,
    '',
  ];

  for (const route of input.routes) {
    // The shared entry hop must preserve the next-hop Mullvad SOCKS hostname through the tunnel.
    lines.push(
      `# Route ${route.routeId} (${route.routeHostname} -> ${route.routeBindIp}:${route.routeSocksPort}/${route.routeHttpPort}) exit ${route.exitRelayHostname}`,
      `allow ${input.config.setup.auth.username}`,
      `parent 1000 socks5+ ${route.entryParent.host} ${route.entryParent.port}`,
      `parent 1000 socks5+ ${route.exitSocksHostname} ${route.exitSocksPort}`,
      `socks -p${route.routeSocksPort} -i${route.routeListenHost} -e${route.routeBindIp}`,
      'flush',
      `allow ${input.config.setup.auth.username}`,
      `parent 1000 socks5+ ${route.entryParent.host} ${route.entryParent.port}`,
      `parent 1000 socks5+ ${route.exitSocksHostname} ${route.exitSocksPort}`,
      `proxy -p${route.routeHttpPort} -i${route.routeListenHost} -e${route.routeBindIp}`,
      'flush',
      '',
    );
  }

  return `${lines.join('\n')}\n`;
}

function resolveEntryRelay(input: {
  readonly config: MullgateConfig;
  readonly relayCatalog: MullvadRelayCatalog;
}):
  | {
      readonly ok: true;
      readonly value: {
        readonly relay: MullvadRelay;
        readonly target: LocationAliasTarget | null;
      };
    }
  | {
      readonly ok: false;
      readonly source: 'canonical-config' | 'relay-catalog' | 'user-input';
      readonly cause?: string;
      readonly artifactPath?: string;
    } {
  const directRelay = findDirectRelayMatch({
    relays: input.relayCatalog.relays,
    relayPreference: input.config.setup.location,
    providers: input.config.mullvad.relayConstraints.providers,
  });

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
    input.config.setup.location.resolvedAlias ??
    input.config.setup.location.hostnameLabel ??
    input.config.setup.location.requested;
  const catalogResult = createLocationAliasCatalog(input.relayCatalog.relays);

  if (!catalogResult.ok) {
    return {
      ok: false,
      source: 'relay-catalog',
      cause: catalogResult.message,
    };
  }

  const resolvedAlias = resolveLocationAlias(catalogResult.value, aliasInput);

  if (!resolvedAlias.ok) {
    return {
      ok: false,
      source: resolvedAlias.source,
      cause: resolvedAlias.message,
      artifactPath: aliasInput,
    };
  }

  const candidateRelays = input.relayCatalog.relays.filter((relay) =>
    relayMatchesTarget(relay, resolvedAlias.value),
  );
  const constrainedRelays = applyProviderConstraints(
    candidateRelays,
    input.config.mullvad.relayConstraints.providers,
  );
  const selectedRelay = choosePreferredRelay(constrainedRelays);

  if (!selectedRelay) {
    return {
      ok: false,
      source: 'canonical-config',
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

function findDirectRelayMatch(input: {
  readonly relays: readonly MullvadRelay[];
  readonly relayPreference: MullgateConfig['setup']['location'];
  readonly providers: readonly string[];
}): MullvadRelay | null {
  const constrained = applyProviderConstraints(input.relays, input.providers);
  const hostnameCandidates = [
    input.relayPreference.hostnameLabel,
    input.relayPreference.requested,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const hostname of hostnameCandidates) {
    const exactRelay = constrained.find(
      (relay) => relay.hostname === hostname || relay.fqdn === hostname,
    );

    if (exactRelay) {
      return exactRelay;
    }
  }

  if (input.relayPreference.country || input.relayPreference.city) {
    const matchingRelays = constrained.filter((relay) => {
      if (
        input.relayPreference.country &&
        relay.location.countryCode !== input.relayPreference.country
      ) {
        return false;
      }

      if (input.relayPreference.city && relay.location.cityCode !== input.relayPreference.city) {
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

function applyProviderConstraints(
  relays: readonly MullvadRelay[],
  providers: readonly string[],
): MullvadRelay[] {
  const allowedProviders = new Set(providers.map((provider) => provider.toLowerCase()));

  return relays.filter((relay) => {
    if (allowedProviders.size === 0) {
      return true;
    }

    return Boolean(relay.provider && allowedProviders.has(relay.provider.toLowerCase()));
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

function describeRoute(route: RoutedLocation): RouteProxyIdentity {
  return {
    routeIndex: -1,
    routeId: route.runtime.routeId,
    routeAlias: route.alias,
    routeHostname: route.hostname,
    routeBindIp: route.bindIp,
    routeListenHost: route.bindIp,
    routeSocksPort: 0,
    routeHttpPort: 0,
    httpsBackendName: route.runtime.httpsBackendName,
  };
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
