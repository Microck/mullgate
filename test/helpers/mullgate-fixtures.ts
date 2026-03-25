import type { MullgatePaths } from '../../src/config/paths.js';
import type {
  MullgateConfig,
  RoutedLocation,
  RoutedLocationExit,
} from '../../src/config/schema.js';

type RouteExitInput = Partial<RoutedLocationExit> & {
  readonly relayHostname?: string;
  readonly relayFqdn?: string;
  readonly socksHostname?: string;
  readonly socksPort?: number;
  readonly countryCode?: string;
  readonly cityCode?: string;
};

export type FixtureRouteInput = {
  readonly alias: string;
  readonly hostname: string;
  readonly bindIp: string;
  readonly requested: string;
  readonly resolvedAlias: string | null;
  readonly country?: string;
  readonly city?: string;
  readonly hostnameLabel?: string;
  readonly countryCode?: string;
  readonly cityCode?: string;
  readonly providers?: readonly string[];
  readonly routeId?: string;
  readonly httpsBackendName?: string;
  readonly exit?: RouteExitInput;
};

export function createFixtureRoute(input: FixtureRouteInput): RoutedLocation {
  const routeId = input.routeId ?? input.hostname;
  const relayHostname = input.exit?.relayHostname ?? input.hostname;
  const countryCode =
    input.exit?.countryCode ?? input.countryCode ?? inferCountryCodeFromHostname(input.hostname);
  const cityCode =
    input.exit?.cityCode ?? input.cityCode ?? inferCityCodeFromHostname(input.hostname);

  return {
    alias: input.alias,
    hostname: input.hostname,
    bindIp: input.bindIp,
    relayPreference: {
      requested: input.requested,
      ...(input.country ? { country: input.country } : {}),
      ...(input.city ? { city: input.city } : {}),
      ...(input.hostnameLabel ? { hostnameLabel: input.hostnameLabel } : {}),
      resolvedAlias: input.resolvedAlias,
    },
    mullvad: {
      relayConstraints: {
        providers: [...(input.providers ?? [])],
      },
      exit: {
        relayHostname,
        relayFqdn: input.exit?.relayFqdn ?? `${relayHostname}.relays.mullvad.net`,
        socksHostname: input.exit?.socksHostname ?? `${relayHostname}-socks.relays.mullvad.net`,
        socksPort: input.exit?.socksPort ?? 1080,
        countryCode,
        cityCode,
      },
    },
    runtime: {
      routeId,
      httpsBackendName: input.httpsBackendName ?? `route-${routeId}`,
    },
  };
}

export function createFixtureRuntime(input: {
  readonly paths: MullgatePaths;
  readonly status: MullgateConfig['runtime']['status'];
}): MullgateConfig['runtime'] {
  return {
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
    status: input.status,
  };
}

function inferCountryCodeFromHostname(hostname: string): string {
  return hostname.split('-')[0] ?? 'xx';
}

function inferCityCodeFromHostname(hostname: string): string {
  return hostname.split('-')[1] ?? 'test';
}
