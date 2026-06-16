import { buildExposureContract, type ExposureContract } from '../config/exposure-contract.js';
import type { MullgateConfig } from '../config/schema.js';
import { normalizeLocationToken } from '../domain/location-aliases.js';
import { listRegionGroupNames, resolveRegionCountryCodes } from '../domain/region-groups.js';
import type { MullvadRelayCatalog } from '../mullvad/fetch-relays.js';
import {
  listMatchingRelays,
  matchesProxyExportSelector,
  type ProxyExportEntry,
  renderProxyExportSelectorLabel,
} from './proxy-export-relays.js';
import {
  describeConfiguredProxyExportRoutes,
  type ProxyExportRouteDescriptor,
} from './proxy-export-route-descriptors.js';
import {
  normalizeProxyExportSelectorValue,
  type ProxyExportFailure,
  type ProxyExportSelector,
} from './proxy-export-selectors.js';

export type ProxyExportProtocol = 'socks5' | 'http' | 'https';
export type ProxyExportWriteMode = 'file' | 'stdout' | 'dry-run';

export type ProxyExportResolvedInput = {
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelector[];
  readonly writeMode: ProxyExportWriteMode;
  readonly outputPath?: string;
  readonly force: boolean;
};

type ProxyExportSelectorResult = ProxyExportSelector & {
  readonly matchedCount: number;
  readonly exportedCount: number;
};

export type ProxyExportPlanSuccess = {
  readonly ok: true;
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelectorResult[];
  readonly entries: readonly ProxyExportEntry[];
  readonly outputText: string;
  readonly suggestedFilename: string;
};

type ProxyExportPlanResult = ProxyExportPlanSuccess | ProxyExportFailure;

export function buildProxyExportPlan(input: {
  readonly config: MullgateConfig;
  readonly protocol: ProxyExportProtocol;
  readonly selectors: readonly ProxyExportSelector[];
  readonly relayCatalog: MullvadRelayCatalog;
  readonly configPath: string;
}): ProxyExportPlanResult {
  if (input.config.setup.access.mode === 'inline-selector') {
    return {
      ok: false,
      phase: 'export-proxies',
      source: 'canonical-config',
      message:
        'Proxy export currently supports published-routes mode only. Inline-selector access uses one shared listener, so switch back to published-routes or use `mullgate proxy access` for selector examples.',
      configPath: input.configPath,
    };
  }

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

  const entries = createProxyExportEntries({
    config: input.config,
    exposure,
    protocol: input.protocol,
    routeDescriptors,
  });

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
      selector.requestedCount === null || selector.requestedCount === 'all'
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

function createProxyExportEntries(input: {
  readonly config: MullgateConfig;
  readonly exposure: ExposureContract;
  readonly protocol: ProxyExportProtocol;
  readonly routeDescriptors: readonly ProxyExportRouteDescriptor[];
}): ProxyExportEntry[] {
  return input.exposure.routes
    .map((route, routeIndex) => {
      const endpoint = route.endpoints.find((candidate) => candidate.protocol === input.protocol);

      if (!endpoint) {
        return null;
      }

      return {
        routeIndex,
        alias: route.alias,
        hostname: route.hostname,
        countryCode: input.routeDescriptors[routeIndex]?.countryCode ?? null,
        cityCode: input.routeDescriptors[routeIndex]?.cityCode ?? null,
        relayHostname: input.routeDescriptors[routeIndex]?.relayHostname ?? null,
        provider: input.routeDescriptors[routeIndex]?.provider ?? null,
        owner: input.routeDescriptors[routeIndex]?.owner ?? null,
        runMode: input.routeDescriptors[routeIndex]?.runMode ?? null,
        portSpeed: input.routeDescriptors[routeIndex]?.portSpeed ?? null,
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

    if (
      serverResult.hostname &&
      (selector.requestedCount === 'all' || (selector.requestedCount ?? 1) > 1)
    ) {
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
        selector.requestedCount ?? 'default',
      ].join('-'),
    )
    .join('--');

  return `proxy-${input.protocol}-${selectorSlug}.txt`;
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

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
