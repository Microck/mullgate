import type { MullgateConfig } from '../config/schema.js';
import type { MullvadRelay, MullvadRelayCatalog } from '../mullvad/fetch-relays.js';
import {
  chooseRelaysForProxyExportSelector,
  matchesProxyExportSelector,
  type ProxyExportEntry,
} from './proxy-export-relays.js';
import type { ProxyExportSelector } from './proxy-export-selectors.js';

export type ProxyExportRouteDescriptor = {
  readonly routeIndex: number;
  readonly routeId: string;
  readonly routeAlias: string;
  readonly routeHostname: string;
  readonly countryCode: string | null;
  readonly cityCode: string | null;
  readonly relayHostname: string | null;
  readonly provider: string | null;
  readonly owner: ProxyExportEntry['owner'];
  readonly runMode: ProxyExportEntry['runMode'];
  readonly portSpeed: number | null;
};

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

export function planProxyExportRelayTargets(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly selectors: readonly ProxyExportSelector[];
  readonly configuredRoutes: readonly ProxyExportRouteDescriptor[];
}): {
  readonly ok: true;
  readonly targets: readonly {
    readonly relay: MullvadRelay;
    readonly selector: ProxyExportSelector;
  }[];
} {
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
    const matchingRelayCount = countMatchingCatalogRelays({
      relayCatalog: input.relayCatalog,
      selector,
      reservedRelayHostnames,
    });
    const desiredCount =
      selector.requestedCount === 'all'
        ? matchingConfiguredRoutes.length + matchingRelayCount
        : (selector.requestedCount ?? Math.max(1, matchingConfiguredRoutes.length));
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

function countMatchingCatalogRelays(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly selector: ProxyExportSelector;
  readonly reservedRelayHostnames: ReadonlySet<string>;
}): number {
  return input.relayCatalog.relays.filter((relay) => {
    if (input.reservedRelayHostnames.has(relay.hostname)) {
      return false;
    }

    return matchesProxyExportSelector({
      selector: input.selector,
      entry: {
        routeIndex: -1,
        alias: relay.hostname,
        hostname: relay.hostname,
        countryCode: relay.location.countryCode,
        cityCode: relay.location.cityCode,
        relayHostname: relay.hostname,
        provider: relay.provider ?? null,
        owner: relay.owned ? 'mullvad' : 'rented',
        runMode: relay.stboot ? 'ram' : 'disk',
        portSpeed: relay.networkPortSpeed ?? null,
        url: '',
      },
    });
  }).length;
}
