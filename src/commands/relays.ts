import type { Command } from 'commander';

import { writeCliReport } from '../cli-output.js';
import { buildExposureContract } from '../config/exposure-contract.js';
import { ConfigStore } from '../config/store.js';
import { normalizeLocationToken } from '../domain/location-aliases.js';
import { listRegionGroupNames, resolveRegionCountryCodes } from '../domain/region-groups.js';
import type { MullvadRelay, MullvadRelayCatalog } from '../mullvad/fetch-relays.js';
import {
  type CommandRunner,
  type ProxyExitProbeResult,
  probeProxyExit,
  probeRelayLatency,
  type RelayProbeResult,
} from '../mullvad/relay-probe.js';
import {
  chooseRelaysForProxyExportSelector,
  listMatchingRelays,
  loadRelayCatalogForProxyExport,
  type ProxyExportFailure,
  type ProxyExportSelector,
  parseRelayOwnerFilter,
  parseRelayRunModeFilter,
  type RelayOwnerFilter,
  type RelayRunModeFilter,
  renderProxyExportSelectorLabel,
} from './config.js';

const DEFAULT_VERIFY_TARGET_URL = 'https://am.i.mullvad.net/json';
const VERIFY_TARGET_URL_ENV = 'MULLGATE_VERIFY_TARGET_URL';

type RelayListCommandOptions = {
  readonly country?: string;
  readonly region?: string;
  readonly city?: string;
  readonly server?: string;
  readonly provider?: string[];
  readonly owner?: string;
  readonly runMode?: string;
  readonly minPortSpeed?: string;
  readonly count?: string;
  readonly includeInactive?: boolean;
};

type RelayProbeCommandOptions = Omit<RelayListCommandOptions, 'includeInactive'>;

type RelayVerifyCommandOptions = {
  readonly route?: string;
  readonly targetUrl?: string;
};

type RelaysCommandDependencies = {
  readonly store?: ConfigStore;
  readonly runner?: CommandRunner;
  readonly commandName?: string;
};

type ResolvedRelayCommandSelection = {
  readonly selector: ProxyExportSelector | null;
  readonly label: string;
  readonly matchedRelays: readonly MullvadRelay[];
  readonly requestedCount: number | null;
};

export function registerRelaysCommand(
  program: Command,
  dependencies: RelaysCommandDependencies = {},
): Command {
  const relays = program
    .command(dependencies.commandName ?? 'relays')
    .description('Inspect, probe, and verify Mullvad relays plus configured route exits.');

  relays
    .command('list')
    .description(
      'List matching Mullvad relays with location, provider, ownership, run mode, and port speed details.',
    )
    .option('--country <code-or-name>', 'Filter relays to one country.')
    .option(
      '--region <name>',
      'Filter relays to one curated region group: americas, asia-pacific, europe, or middle-east-africa.',
    )
    .option('--city <code-or-name>', 'Refine a country filter to one city.')
    .option('--server <hostname>', 'Pin a country filter to one exact relay hostname.')
    .option('--provider <name>', 'Filter by provider. Repeat as needed.', collectRepeatedValues, [])
    .option('--owner <owner>', 'Filter by ownership: mullvad, rented, or all.')
    .option('--run-mode <mode>', 'Filter by run mode: ram, disk, or all.')
    .option('--min-port-speed <mbps>', 'Filter by minimum advertised port speed in Mbps.')
    .option('--count <number>', 'Limit the listed relays after filtering.')
    .option(
      '--include-inactive',
      'Include inactive relays instead of filtering to active relays only.',
    )
    .action(async (options: RelayListCommandOptions) => {
      const result = await runRelaysListFlow({
        options,
        store: dependencies.store,
      });

      if (!result.ok) {
        writeCliReport({ sink: process.stderr, text: renderRelayFailure(result), tone: 'error' });
        process.exitCode = 1;
        return;
      }

      writeCliReport({ sink: process.stdout, text: result.text });
    });

  relays
    .command('probe')
    .description('Ping matching Mullvad relays and rank them by latency.')
    .option('--country <code-or-name>', 'Probe relays from one country.')
    .option(
      '--region <name>',
      'Probe relays from one curated region group: americas, asia-pacific, europe, or middle-east-africa.',
    )
    .option('--city <code-or-name>', 'Refine a country probe to one city.')
    .option('--server <hostname>', 'Probe one exact relay hostname.')
    .option('--provider <name>', 'Filter by provider. Repeat as needed.', collectRepeatedValues, [])
    .option('--owner <owner>', 'Filter by ownership: mullvad, rented, or all.')
    .option('--run-mode <mode>', 'Filter by run mode: ram, disk, or all.')
    .option('--min-port-speed <mbps>', 'Filter by minimum advertised port speed in Mbps.')
    .option('--count <number>', 'Probe this many relays after applying spread selection.')
    .action(async (options: RelayProbeCommandOptions) => {
      const result = await runRelaysProbeFlow({
        options,
        store: dependencies.store,
        runner: dependencies.runner,
      });

      if (!result.ok) {
        writeCliReport({ sink: process.stderr, text: renderRelayFailure(result), tone: 'error' });
        process.exitCode = 1;
        return;
      }

      writeCliReport({ sink: process.stdout, text: result.text });
    });

  relays
    .command('verify')
    .description(
      'Verify one configured route exits through Mullvad for each published proxy protocol.',
    )
    .requiredOption(
      '--route <alias-or-hostname-or-route-id>',
      'Select the configured route to verify.',
    )
    .option(
      '--target-url <url>',
      `Exit-check endpoint to query. Defaults to ${DEFAULT_VERIFY_TARGET_URL}.`,
    )
    .action(async (options: RelayVerifyCommandOptions) => {
      const result = await runRelaysVerifyFlow({
        options,
        store: dependencies.store,
        runner: dependencies.runner,
      });

      if (!result.ok) {
        writeCliReport({ sink: process.stderr, text: renderRelayFailure(result), tone: 'error' });
        process.exitCode = 1;
        return;
      }

      writeCliReport({ sink: process.stdout, text: result.text, tone: 'success' });
    });

  return relays;
}

export async function runRelaysListFlow(input: {
  readonly options: RelayListCommandOptions;
  readonly store?: ConfigStore;
}): Promise<{ readonly ok: true; readonly text: string } | ProxyExportFailure> {
  const store = input.store ?? new ConfigStore();
  const relayCatalogResult = await loadRelayCatalogForProxyExport({ store });

  if (!relayCatalogResult.ok) {
    return relayCatalogResult;
  }

  const resolvedSelection = resolveRelayCommandSelection({
    options: input.options,
    relayCatalog: relayCatalogResult.relayCatalog,
    allowGlobalSelection: true,
    includeInactive: Boolean(input.options.includeInactive),
  });

  if (!resolvedSelection.ok) {
    return {
      ...resolvedSelection,
      configPath: store.paths.configFile,
    };
  }

  const selectedRelays =
    resolvedSelection.selection.selector && resolvedSelection.selection.requestedCount !== null
      ? chooseRelaysForProxyExportSelector({
          selector: resolvedSelection.selection.selector,
          relayCatalog: relayCatalogResult.relayCatalog,
          count: resolvedSelection.selection.requestedCount,
          excludedRelayHostnames: new Set<string>(),
        })
      : resolvedSelection.selection.requestedCount !== null
        ? resolvedSelection.selection.matchedRelays.slice(
            0,
            resolvedSelection.selection.requestedCount,
          )
        : resolvedSelection.selection.matchedRelays;

  return {
    ok: true,
    text: renderRelayListReport({
      relayCatalog: relayCatalogResult.relayCatalog,
      selection: resolvedSelection.selection,
      selectedRelays,
      includeInactive: Boolean(input.options.includeInactive),
    }),
  };
}

export async function runRelaysProbeFlow(input: {
  readonly options: RelayProbeCommandOptions;
  readonly store?: ConfigStore;
  readonly runner?: CommandRunner;
}): Promise<{ readonly ok: true; readonly text: string } | ProxyExportFailure> {
  const store = input.store ?? new ConfigStore();
  const relayCatalogResult = await loadRelayCatalogForProxyExport({ store });

  if (!relayCatalogResult.ok) {
    return relayCatalogResult;
  }

  const resolvedSelection = resolveRelayCommandSelection({
    options: input.options,
    relayCatalog: relayCatalogResult.relayCatalog,
    allowGlobalSelection: false,
    includeInactive: false,
  });

  if (!resolvedSelection.ok) {
    return {
      ...resolvedSelection,
      configPath: store.paths.configFile,
    };
  }

  const selector = resolvedSelection.selection.selector;

  if (!selector) {
    return {
      ok: false,
      phase: 'relay-probe',
      source: 'input',
      message: 'Pass --country or --region before probing relays.',
      configPath: store.paths.configFile,
    };
  }

  const effectiveCount =
    resolvedSelection.selection.requestedCount ??
    (selector.server ? 1 : Math.min(5, resolvedSelection.selection.matchedRelays.length));
  const relaysToProbe = chooseRelaysForProxyExportSelector({
    selector,
    relayCatalog: relayCatalogResult.relayCatalog,
    count: effectiveCount,
    excludedRelayHostnames: new Set<string>(),
  });
  const probeResults: RelayProbeResult[] = [];

  for (const relay of relaysToProbe) {
    probeResults.push(
      await probeRelayLatency({
        relay,
        ...(input.runner ? { runner: input.runner } : {}),
      }),
    );
  }

  const successfulProbes = probeResults
    .filter((result): result is Extract<RelayProbeResult, { ok: true }> => result.ok)
    .sort((left, right) => left.latencyMs - right.latencyMs);

  if (successfulProbes.length === 0) {
    return {
      ok: false,
      phase: 'relay-probe',
      source: 'ping',
      message: 'No selected relays responded to latency probing.',
      configPath: store.paths.configFile,
      cause: probeResults
        .filter((result): result is Extract<RelayProbeResult, { ok: false }> => !result.ok)
        .map((result) => `${result.relay.hostname}: ${result.cause ?? result.message}`)
        .join('; '),
    };
  }

  return {
    ok: true,
    text: renderRelayProbeReport({
      relayCatalog: relayCatalogResult.relayCatalog,
      selection: resolvedSelection.selection,
      effectiveCount,
      probeResults,
      successfulProbes,
    }),
  };
}

export async function runRelaysVerifyFlow(input: {
  readonly options: RelayVerifyCommandOptions;
  readonly store?: ConfigStore;
  readonly runner?: CommandRunner;
}): Promise<{ readonly ok: true; readonly text: string } | ProxyExportFailure> {
  const store = input.store ?? new ConfigStore();
  const loadResult = await store.load();

  if (!loadResult.ok) {
    return {
      ok: false,
      phase: loadResult.phase,
      source: loadResult.source,
      message: loadResult.message,
      configPath: store.paths.configFile,
      artifactPath: loadResult.artifactPath,
    };
  }

  if (loadResult.source === 'empty') {
    return {
      ok: false,
      phase: 'load-config',
      source: 'empty',
      message: loadResult.message,
      configPath: store.paths.configFile,
    };
  }

  const routeLookup = normalizeLocationToken(input.options.route ?? '');
  const routeIndex = loadResult.config.routing.locations.findIndex((route) => {
    return (
      normalizeLocationToken(route.alias) === routeLookup ||
      normalizeLocationToken(route.hostname) === routeLookup ||
      normalizeLocationToken(route.runtime.routeId) === routeLookup
    );
  });

  if (routeIndex === -1) {
    return {
      ok: false,
      phase: 'relay-verify',
      source: 'input',
      message: `No configured route matched ${input.options.route}.`,
      configPath: store.paths.configFile,
    };
  }

  const exposure = buildExposureContract(loadResult.config);
  const route = exposure.routes[routeIndex];

  if (!route) {
    return {
      ok: false,
      phase: 'relay-verify',
      source: 'canonical-config',
      message: `Configured route ${input.options.route} did not have a published exposure contract.`,
      configPath: store.paths.configFile,
    };
  }

  const targetUrl =
    input.options.targetUrl?.trim() ||
    process.env[VERIFY_TARGET_URL_ENV] ||
    DEFAULT_VERIFY_TARGET_URL;
  const probeResults: ProxyExitProbeResult[] = [];

  for (const endpoint of route.endpoints) {
    probeResults.push(
      await probeProxyExit({
        protocol: endpoint.protocol,
        host: route.bindIp,
        port: endpoint.port,
        username: loadResult.config.setup.auth.username,
        password: loadResult.config.setup.auth.password,
        targetUrl,
        ...(input.runner ? { runner: input.runner } : {}),
      }),
    );
  }

  const failedProbe = probeResults.find((result) => !result.ok);

  if (failedProbe) {
    return {
      ok: false,
      phase: 'relay-verify',
      source: 'curl',
      message: failedProbe.message,
      configPath: store.paths.configFile,
      cause: failedProbe.cause,
    };
  }

  return {
    ok: true,
    text: renderRelayVerifyReport({
      configPath: store.paths.configFile,
      route,
      targetUrl,
      probeResults: probeResults as Extract<ProxyExitProbeResult, { ok: true }>[],
    }),
  };
}

function resolveRelayCommandSelection(input: {
  readonly options: RelayListCommandOptions | RelayProbeCommandOptions;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly allowGlobalSelection: boolean;
  readonly includeInactive: boolean;
}):
  | { readonly ok: true; readonly selection: ResolvedRelayCommandSelection }
  | Omit<ProxyExportFailure, 'configPath'> {
  if (input.options.country && input.options.region) {
    return {
      ok: false,
      phase: 'relay-selection',
      source: 'input',
      message: 'Pass --country or --region, not both.',
    };
  }

  if (input.options.city && !input.options.country) {
    return {
      ok: false,
      phase: 'relay-selection',
      source: 'input',
      message: 'Pass --city with --country.',
    };
  }

  if (input.options.server && !input.options.country) {
    return {
      ok: false,
      phase: 'relay-selection',
      source: 'input',
      message: 'Pass --server with --country.',
    };
  }

  const providersResult = resolveProviderNames({
    relayCatalog: input.relayCatalog,
    providers: input.options.provider ?? [],
  });

  if (!providersResult.ok) {
    return providersResult;
  }

  const owner = input.options.owner ? parseRelayOwnerFilter(input.options.owner) : 'all';
  const runMode = input.options.runMode ? parseRelayRunModeFilter(input.options.runMode) : 'all';
  const minPortSpeed = input.options.minPortSpeed
    ? parsePositiveInteger(input.options.minPortSpeed, 'Minimum port speed')
    : null;
  const requestedCount = input.options.count
    ? parsePositiveInteger(input.options.count, 'Relay count')
    : null;

  if (!input.options.country && !input.options.region) {
    if (!input.allowGlobalSelection) {
      return {
        ok: false,
        phase: 'relay-selection',
        source: 'input',
        message: 'Pass --country or --region before probing relays.',
      };
    }

    const matchedRelays = listMatchingRelays({
      relayCatalog: input.relayCatalog,
      providers: providersResult.providers,
      owner,
      runMode,
      minPortSpeed,
      includeInactive: input.includeInactive,
    });

    return {
      ok: true,
      selection: {
        selector: null,
        label: renderGlobalRelayFilterLabel({
          providers: providersResult.providers,
          owner,
          runMode,
          minPortSpeed,
          includeInactive: input.includeInactive,
        }),
        matchedRelays,
        requestedCount,
      },
    };
  }

  if (input.options.region) {
    const region = normalizeLocationToken(input.options.region);
    const regionCountryCodes = resolveRegionCountryCodes(region);

    if (!regionCountryCodes) {
      return {
        ok: false,
        phase: 'relay-selection',
        source: 'input',
        message: `Unknown region ${input.options.region}. Supported regions: ${listRegionGroupNames().join(', ')}.`,
      };
    }

    const selector: ProxyExportSelector = {
      kind: 'region',
      value: region,
      providers: providersResult.providers,
      owner,
      runMode,
      minPortSpeed,
      requestedCount,
    };
    const matchedRelays = listMatchingRelays({
      relayCatalog: input.relayCatalog,
      providers: providersResult.providers,
      owner,
      runMode,
      minPortSpeed,
      includeInactive: input.includeInactive,
    }).filter((relay) => regionCountryCodes.includes(relay.location.countryCode));

    return {
      ok: true,
      selection: {
        selector,
        label: renderProxyExportSelectorLabel(selector),
        matchedRelays,
        requestedCount,
      },
    };
  }

  const country = resolveCountryCode(input.relayCatalog, input.options.country ?? '');

  if (!country.ok) {
    return country;
  }

  const city =
    input.options.city === undefined
      ? { ok: true as const, cityCode: undefined }
      : resolveCityCode(input.relayCatalog, country.countryCode, input.options.city);

  if (!city.ok) {
    return city;
  }

  const selectorBase = {
    kind: 'country' as const,
    value: country.countryCode,
    ...(city.cityCode ? { city: city.cityCode } : {}),
    providers: providersResult.providers,
    owner,
    runMode,
    minPortSpeed,
    requestedCount,
  };

  if (!input.options.server) {
    const matchedRelays = listMatchingRelays({
      relayCatalog: input.relayCatalog,
      countryCode: country.countryCode,
      ...(city.cityCode ? { cityCode: city.cityCode } : {}),
      providers: providersResult.providers,
      owner,
      runMode,
      minPortSpeed,
      includeInactive: input.includeInactive,
    });

    return {
      ok: true,
      selection: {
        selector: selectorBase,
        label: renderProxyExportSelectorLabel(selectorBase),
        matchedRelays,
        requestedCount,
      },
    };
  }

  const serverResult = resolveServerHostname({
    relayCatalog: input.relayCatalog,
    countryCode: country.countryCode,
    ...(city.cityCode ? { cityCode: city.cityCode } : {}),
    providers: providersResult.providers,
    owner,
    runMode,
    minPortSpeed,
    value: input.options.server,
    includeInactive: input.includeInactive,
  });

  if (!serverResult.ok) {
    return serverResult;
  }

  const selector: ProxyExportSelector = {
    ...selectorBase,
    server: serverResult.hostname,
    requestedCount: requestedCount ?? 1,
  };
  const matchedRelays = listMatchingRelays({
    relayCatalog: input.relayCatalog,
    countryCode: country.countryCode,
    ...(city.cityCode ? { cityCode: city.cityCode } : {}),
    providers: providersResult.providers,
    owner,
    runMode,
    minPortSpeed,
    includeInactive: input.includeInactive,
  }).filter((relay) => relay.hostname === serverResult.hostname);

  return {
    ok: true,
    selection: {
      selector,
      label: renderProxyExportSelectorLabel(selector),
      matchedRelays,
      requestedCount: selector.requestedCount,
    },
  };
}

function renderRelayListReport(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly selection: ResolvedRelayCommandSelection;
  readonly selectedRelays: readonly MullvadRelay[];
  readonly includeInactive: boolean;
}): string {
  return [
    'Mullgate relay list',
    'phase: relay-list',
    'source: mullvad-relay-catalog',
    `catalog endpoint: ${input.relayCatalog.endpoint}`,
    `selection: ${input.selection.label}`,
    `inactive relays: ${input.includeInactive ? 'included' : 'active only'}`,
    `matched count: ${input.selection.matchedRelays.length}`,
    `listed count: ${input.selectedRelays.length}`,
    ...(input.selectedRelays.length === 0
      ? ['relays: none']
      : ['relay table', ...renderRelayTable(input.selectedRelays)]),
  ].join('\n');
}

function renderRelayProbeReport(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly selection: ResolvedRelayCommandSelection;
  readonly effectiveCount: number;
  readonly probeResults: readonly RelayProbeResult[];
  readonly successfulProbes: readonly Extract<RelayProbeResult, { ok: true }>[];
}): string {
  const failures = input.probeResults.filter(
    (result): result is Extract<RelayProbeResult, { ok: false }> => !result.ok,
  );

  return [
    'Mullgate relay probe complete.',
    'phase: relay-probe',
    'source: ping',
    `catalog endpoint: ${input.relayCatalog.endpoint}`,
    `selection: ${input.selection.label}`,
    `matched count: ${input.selection.matchedRelays.length}`,
    `requested count: ${input.effectiveCount}`,
    `successful probes: ${input.successfulProbes.length}`,
    'ranked relays',
    ...input.successfulProbes.map(
      (result, index) =>
        `${index + 1}. ${renderRelaySummary(result.relay)} latency=${result.latencyMs.toFixed(1)}ms`,
    ),
    ...(failures.length > 0
      ? [
          'probe failures',
          ...failures.map(
            (result, index) =>
              `${index + 1}. ${result.relay.hostname} reason=${result.cause ?? result.message}`,
          ),
        ]
      : []),
  ].join('\n');
}

function renderRelayVerifyReport(input: {
  readonly configPath: string;
  readonly route: ReturnType<typeof buildExposureContract>['routes'][number];
  readonly targetUrl: string;
  readonly probeResults: readonly Extract<ProxyExitProbeResult, { ok: true }>[];
}): string {
  return [
    'Mullgate route exit verification complete.',
    'phase: relay-verify',
    'source: configured-route',
    `config: ${input.configPath}`,
    `route alias: ${input.route.alias}`,
    `route id: ${input.route.routeId}`,
    `hostname: ${input.route.hostname}`,
    `bind ip: ${input.route.bindIp}`,
    `target: ${input.targetUrl}`,
    ...input.probeResults.map(
      (result, index) =>
        `${index + 1}. protocol=${result.protocol} proxy=${result.proxyUrl} exit-ip=${result.exit.ip} country=${result.exit.country ?? 'n/a'} city=${result.exit.city ?? 'n/a'} mullvad_exit_ip=${result.exit.mullvadExitIp ?? 'unknown'}`,
    ),
  ].join('\n');
}

function renderRelaySummary(relay: MullvadRelay): string {
  return [
    relay.hostname,
    `country=${relay.location.countryCode}`,
    `city=${relay.location.cityCode}`,
    `provider=${relay.provider ?? 'n/a'}`,
    `owner=${relay.owned ? 'mullvad' : 'rented'}`,
    `run-mode=${relay.stboot ? 'ram' : 'disk'}`,
    `port-speed=${relay.networkPortSpeed ?? 'n/a'}`,
  ].join(' ');
}

function renderRelayTable(relays: readonly MullvadRelay[]): string[] {
  const headers = [
    '#',
    'hostname',
    'country',
    'city',
    'provider',
    'owner',
    'mode',
    'speed',
    'active',
  ];
  const rows = relays.map((relay, index) => [
    String(index + 1),
    relay.hostname,
    relay.location.countryCode,
    relay.location.cityCode,
    relay.provider ?? 'n/a',
    relay.owned ? 'mullvad' : 'rented',
    relay.stboot ? 'ram' : 'disk',
    relay.networkPortSpeed ? `${relay.networkPortSpeed}` : 'n/a',
    relay.active ? 'yes' : 'no',
  ]);
  const widths = headers.map((header, columnIndex) =>
    Math.max(header.length, ...rows.map((row) => row[columnIndex]?.length ?? 0)),
  );

  const formatRow = (row: readonly string[]) =>
    row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join('  ');

  return [
    formatRow(headers),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map(formatRow),
  ];
}

function renderGlobalRelayFilterLabel(input: {
  readonly providers: readonly string[];
  readonly owner: RelayOwnerFilter;
  readonly runMode: RelayRunModeFilter;
  readonly minPortSpeed: number | null;
  readonly includeInactive: boolean;
}): string {
  return [
    'all relays',
    ...(input.providers.length > 0 ? [`providers=${input.providers.join(',')}`] : []),
    ...(input.owner !== 'all' ? [`owner=${input.owner}`] : []),
    ...(input.runMode !== 'all' ? [`run-mode=${input.runMode}`] : []),
    ...(input.minPortSpeed !== null ? [`min-port-speed=${input.minPortSpeed}`] : []),
    ...(input.includeInactive ? ['inactive=included'] : []),
  ].join(' ');
}

function resolveProviderNames(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly providers: readonly string[];
}):
  | { readonly ok: true; readonly providers: readonly string[] }
  | Omit<ProxyExportFailure, 'configPath'> {
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
      phase: 'relay-selection',
      source: 'input',
      message: `Unknown provider ${unknown[0]}.`,
    };
  }

  return {
    ok: true,
    providers: [...new Set(providers)].sort((left, right) => left.localeCompare(right)),
  };
}

function resolveCountryCode(
  relayCatalog: MullvadRelayCatalog,
  value: string,
): { readonly ok: true; readonly countryCode: string } | Omit<ProxyExportFailure, 'configPath'> {
  const normalized = normalizeLocationToken(value);
  const country = relayCatalog.countries.find((entry) => {
    return (
      entry.code.toLowerCase() === normalized || normalizeLocationToken(entry.name) === normalized
    );
  });

  if (!country) {
    return {
      ok: false,
      phase: 'relay-selection',
      source: 'input',
      message: `Unknown country ${value}.`,
    };
  }

  return {
    ok: true,
    countryCode: country.code,
  };
}

function resolveCityCode(
  relayCatalog: MullvadRelayCatalog,
  countryCode: string,
  value: string,
): { readonly ok: true; readonly cityCode: string } | Omit<ProxyExportFailure, 'configPath'> {
  const country = relayCatalog.countries.find((entry) => entry.code === countryCode);
  const normalized = normalizeLocationToken(value);
  const city = country?.cities.find((entry) => {
    return (
      entry.code.toLowerCase() === normalized || normalizeLocationToken(entry.name) === normalized
    );
  });

  if (!city) {
    return {
      ok: false,
      phase: 'relay-selection',
      source: 'input',
      message: `Unknown city ${value} for country ${countryCode}.`,
    };
  }

  return {
    ok: true,
    cityCode: city.code,
  };
}

function resolveServerHostname(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode: string;
  readonly cityCode?: string;
  readonly providers: readonly string[];
  readonly owner: RelayOwnerFilter;
  readonly runMode: RelayRunModeFilter;
  readonly minPortSpeed: number | null;
  readonly value: string;
  readonly includeInactive: boolean;
}): { readonly ok: true; readonly hostname: string } | Omit<ProxyExportFailure, 'configPath'> {
  const normalized = normalizeLocationToken(input.value);
  const relay = listMatchingRelays({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
    ...(input.cityCode ? { cityCode: input.cityCode } : {}),
    providers: input.providers,
    owner: input.owner,
    runMode: input.runMode,
    minPortSpeed: input.minPortSpeed,
    includeInactive: input.includeInactive,
  }).find((entry) => {
    return entry.hostname.toLowerCase() === normalized || entry.fqdn.toLowerCase() === normalized;
  });

  if (!relay) {
    return {
      ok: false,
      phase: 'relay-selection',
      source: 'input',
      message: `Unknown server ${input.value} for the selected country/city/provider filters.`,
    };
  }

  return {
    ok: true,
    hostname: relay.hostname,
  };
}

function renderRelayFailure(result: ProxyExportFailure): string {
  return [
    'Mullgate relay command failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    ...(result.configPath ? [`config: ${result.configPath}`] : []),
    ...(result.artifactPath ? [`artifact: ${result.artifactPath}`] : []),
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
  ].join('\n');
}

function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw.trim());

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function collectRepeatedValues(value: string, previous: string[]): string[] {
  return [...previous, value.trim()].filter((entry) => entry.length > 0);
}
