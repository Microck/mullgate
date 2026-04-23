import type { Command } from 'commander';

import { writeCliReport } from '../cli-output.js';
import { buildExposureContract } from '../config/exposure-contract.js';
import type { MullgateConfig } from '../config/schema.js';
import { ConfigStore } from '../config/store.js';
import { resolveRegionCountryCodes } from '../domain/region-groups.js';
import type { MullvadRelay, MullvadRelayCatalog } from '../mullvad/fetch-relays.js';
import {
  type CommandRunner,
  probeRelayLatency,
  type RelayProbeResult,
} from '../mullvad/relay-probe.js';
import {
  chooseSpreadRelays,
  createAuthenticatedEndpointUrl,
  describeConfiguredProxyExportRoutes,
  ensureProxyExportRoutes,
  extractOrderedCommandArgs,
  listMatchingRelays,
  loadRelayCatalogForProxyExport,
  type ProxyExportFailure,
  type ProxyExportResolvedInput,
  type ProxyExportSelector,
  parseProxyExportSelectors,
  renderProxyExportSelectorLabel,
  resolveProxyExportSelectorsWithCatalog,
} from './config.js';

type RecommendCommandOptions = {
  readonly apply?: boolean;
};

type RecommendCommandDependencies = {
  readonly store?: ConfigStore;
  readonly runner?: CommandRunner;
};

type RecommendedRelay = {
  readonly selector: ProxyExportSelector;
  readonly relay: MullvadRelay;
  readonly latencyMs: number;
  readonly matchedCount: number;
  readonly probedCount: number;
};

type SelectorProbeSummary = {
  readonly selector: ProxyExportSelector;
  readonly matchedCount: number;
  readonly probedCount: number;
  readonly recommendedCount: number;
};

export function registerRecommendCommand(
  program: Command,
  dependencies: RecommendCommandDependencies = {},
): void {
  program
    .command('recommend')
    .option(
      '--country <code-or-name>',
      'Add a country selector. Pair it with optional filters and a following --count.',
    )
    .option(
      '--region <name>',
      'Add a curated region selector (americas, asia-pacific, europe, middle-east-africa). Pair it with optional filters and a following --count.',
    )
    .option('--city <code-or-name>', 'Refine the immediately preceding --country selector by city.')
    .option(
      '--server <hostname>',
      'Pin the immediately preceding --country selector to one exact relay hostname.',
    )
    .option(
      '--provider <name>',
      'Filter the immediately preceding selector by provider. Repeat as needed.',
    )
    .option(
      '--owner <owner>',
      'Filter the immediately preceding selector by relay ownership: mullvad, rented, or all.',
    )
    .option(
      '--run-mode <mode>',
      'Filter the immediately preceding selector by relay run mode: ram, disk, or all.',
    )
    .option(
      '--min-port-speed <mbps>',
      'Filter the immediately preceding selector by minimum advertised port speed in Mbps.',
    )
    .option(
      '--count <number>',
      'Apply a per-selector recommendation count to the immediately preceding selector batch.',
    )
    .option(
      '--apply',
      'Materialize the exact recommended relays into saved config and refreshed runtime artifacts.',
    )
    .description(
      'Probe matching Mullvad relays, recommend exact exits for ordered selector batches, and optionally apply them.',
    )
    .action(async (options: RecommendCommandOptions) => {
      try {
        const result = await runRecommendFlow({
          options,
          store: dependencies.store,
          runner: dependencies.runner,
        });

        if (!result.ok) {
          writeCliReport({
            sink: process.stderr,
            text: renderRecommendFailure(result),
            tone: 'error',
          });
          process.exitCode = 1;
          return;
        }

        writeCliReport({
          sink: process.stdout,
          text: result.text,
          ...(options.apply ? { tone: 'success' as const } : {}),
        });
      } catch (error) {
        writeCliReport({
          sink: process.stderr,
          text: renderRecommendFailure({
            ok: false,
            phase: 'recommend-routes',
            source: 'input',
            message: error instanceof Error ? error.message : String(error),
          }),
          tone: 'error',
        });
        process.exitCode = 1;
      }
    });
}

export async function runRecommendFlow(input: {
  readonly options: RecommendCommandOptions;
  readonly store?: ConfigStore;
  readonly runner?: CommandRunner;
  readonly argv?: readonly string[];
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

  const selectorResult = parseProxyExportSelectors(
    (() => {
      const proxyRelayRecommend = extractOrderedCommandArgs({
        argv: input.argv ?? process.argv,
        commandPath: ['proxy', 'relay', 'recommend'],
      });

      if (proxyRelayRecommend.length > 0) {
        return proxyRelayRecommend;
      }

      return extractOrderedCommandArgs({
        argv: input.argv ?? process.argv,
        commandPath: ['recommend'],
      });
    })(),
  );

  if (!selectorResult.ok) {
    return {
      ...selectorResult,
      configPath: store.paths.configFile,
    };
  }

  if (selectorResult.selectors.length === 0) {
    return {
      ok: false,
      phase: 'recommend-routes',
      source: 'input',
      message: 'Pass at least one --country or --region selector to recommend routes.',
      configPath: store.paths.configFile,
    };
  }

  const relayCatalogResult = await loadRelayCatalogForProxyExport({ store });

  if (!relayCatalogResult.ok) {
    return relayCatalogResult;
  }

  const resolvedSelectors = resolveProxyExportSelectorsWithCatalog({
    config: loadResult.config,
    selectors: selectorResult.selectors,
    relayCatalog: relayCatalogResult.relayCatalog,
    configPath: store.paths.configFile,
  });

  if (!resolvedSelectors.ok) {
    return resolvedSelectors;
  }

  const normalizedSelectors = resolvedSelectors.selectors.map((selector) => ({
    ...selector,
    requestedCount: selector.requestedCount ?? 1,
  }));
  const recommendedRelaysResult = await recommendRelaysForSelectors({
    selectors: normalizedSelectors,
    relayCatalog: relayCatalogResult.relayCatalog,
    ...(input.runner ? { runner: input.runner } : {}),
  });

  if (!recommendedRelaysResult.ok) {
    return {
      ...recommendedRelaysResult,
      configPath: store.paths.configFile,
    };
  }

  const pinnedSelectors = recommendedRelaysResult.recommendations.map<ProxyExportSelector>(
    (recommendation) => ({
      kind: 'country',
      value: recommendation.relay.location.countryCode,
      city: recommendation.relay.location.cityCode,
      server: recommendation.relay.hostname,
      providers: [],
      owner: 'all',
      runMode: 'all',
      minPortSpeed: null,
      requestedCount: 1,
    }),
  );
  const ensuredRoutes = await ensureProxyExportRoutes({
    store,
    config: loadResult.config,
    relayCatalog: relayCatalogResult.relayCatalog,
    exportInput: createRecommendExportInput({
      selectors: pinnedSelectors,
      apply: Boolean(input.options.apply),
    }),
  });

  if (!ensuredRoutes.ok) {
    return ensuredRoutes;
  }

  return {
    ok: true,
    text: renderRecommendReport({
      config: ensuredRoutes.config,
      baseConfig: loadResult.config,
      configPath: store.paths.configFile,
      summaries: recommendedRelaysResult.summaries,
      recommendations: recommendedRelaysResult.recommendations,
      createdAliases: ensuredRoutes.createdAliases,
      applied: Boolean(input.options.apply),
      relayCatalog: relayCatalogResult.relayCatalog,
    }),
  };
}

async function recommendRelaysForSelectors(input: {
  readonly selectors: readonly ProxyExportSelector[];
  readonly relayCatalog: MullvadRelayCatalog;
  readonly runner?: CommandRunner;
}): Promise<
  | {
      readonly ok: true;
      readonly recommendations: readonly RecommendedRelay[];
      readonly summaries: readonly SelectorProbeSummary[];
    }
  | Omit<ProxyExportFailure, 'configPath'>
> {
  const reservedRelayHostnames = new Set<string>();
  const recommendations: RecommendedRelay[] = [];
  const summaries: SelectorProbeSummary[] = [];

  for (const selector of input.selectors) {
    const matchingRelays = listMatchingRelays({
      relayCatalog: input.relayCatalog,
      ...(selector.kind === 'country' ? { countryCode: selector.value } : {}),
      ...(selector.kind === 'country' && selector.city ? { cityCode: selector.city } : {}),
      providers: selector.providers,
      owner: selector.owner,
      runMode: selector.runMode,
      minPortSpeed: selector.minPortSpeed,
    }).filter((relay) => !reservedRelayHostnames.has(relay.hostname));

    const filteredMatchingRelays =
      selector.kind === 'region'
        ? matchingRelays.filter((relay) =>
            (resolveRegionCountryCodes(selector.value) ?? []).includes(relay.location.countryCode),
          )
        : matchingRelays.filter((relay) =>
            selector.server ? relay.hostname === selector.server : true,
          );

    if (filteredMatchingRelays.length === 0) {
      return {
        ok: false,
        phase: 'recommend-routes',
        source: 'mullvad-relay-catalog',
        message: `No active relays matched selector ${renderProxyExportSelectorLabel(selector)}.`,
      };
    }

    const probeResults: RelayProbeResult[] = [];

    for (const relay of filteredMatchingRelays) {
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
        phase: 'recommend-routes',
        source: 'ping',
        message: `No relays responded for selector ${renderProxyExportSelectorLabel(selector)}.`,
        cause: probeResults
          .filter((result): result is Extract<RelayProbeResult, { ok: false }> => !result.ok)
          .map((result) => `${result.relay.hostname}: ${result.cause ?? result.message}`)
          .join('; '),
      };
    }

    const selectedRelays = selectRecommendedRelays({
      selector,
      successfulProbes,
    });

    if (selectedRelays.length === 0) {
      return {
        ok: false,
        phase: 'recommend-routes',
        source: 'ping',
        message: `No recommended relays survived the spread selection for ${renderProxyExportSelectorLabel(selector)}.`,
      };
    }

    selectedRelays.forEach((result) => {
      reservedRelayHostnames.add(result.relay.hostname);
      recommendations.push({
        selector,
        relay: result.relay,
        latencyMs: result.latencyMs,
        matchedCount: filteredMatchingRelays.length,
        probedCount: successfulProbes.length,
      });
    });

    summaries.push({
      selector,
      matchedCount: filteredMatchingRelays.length,
      probedCount: successfulProbes.length,
      recommendedCount: selectedRelays.length,
    });
  }

  return {
    ok: true,
    recommendations,
    summaries,
  };
}

function selectRecommendedRelays(input: {
  readonly selector: ProxyExportSelector;
  readonly successfulProbes: readonly Extract<RelayProbeResult, { ok: true }>[];
}): readonly Extract<RelayProbeResult, { ok: true }>[] {
  if (input.selector.server) {
    return input.successfulProbes
      .filter((result) => result.relay.hostname === input.selector.server)
      .slice(0, input.selector.requestedCount ?? 1);
  }

  const sortedRelays = input.successfulProbes.map((result) => result.relay);
  const selectedRelays =
    input.selector.kind === 'region'
      ? chooseSpreadRelays({
          candidates: sortedRelays,
          count: input.selector.requestedCount ?? 1,
          spreadKey: (relay) => relay.location.countryCode,
        })
      : chooseSpreadRelays({
          candidates: sortedRelays,
          count: input.selector.requestedCount ?? 1,
          spreadKey: input.selector.city
            ? (relay) => relay.hostname
            : (relay) => relay.location.cityCode,
        });
  const selectedHostnames = new Set(selectedRelays.map((relay) => relay.hostname));

  return input.successfulProbes.filter((result) => selectedHostnames.has(result.relay.hostname));
}

function createRecommendExportInput(input: {
  readonly selectors: readonly ProxyExportSelector[];
  readonly apply: boolean;
}): ProxyExportResolvedInput {
  return {
    protocol: 'socks5',
    selectors: input.selectors,
    writeMode: input.apply ? 'file' : 'dry-run',
    force: false,
  };
}

function renderRecommendReport(input: {
  readonly config: MullgateConfig;
  readonly baseConfig: MullgateConfig;
  readonly configPath: string;
  readonly summaries: readonly SelectorProbeSummary[];
  readonly recommendations: readonly RecommendedRelay[];
  readonly createdAliases: readonly string[];
  readonly applied: boolean;
  readonly relayCatalog: MullvadRelayCatalog;
}): string {
  const exposure = buildExposureContract(input.config);
  const routeDescriptors = describeConfiguredProxyExportRoutes({
    config: input.config,
    relayCatalog: input.relayCatalog,
  });
  const usedRouteIndexes = new Set<number>();
  const recommendedRoutes = input.recommendations.map((recommendation) => {
    const descriptor = routeDescriptors.find((candidate) => {
      if (usedRouteIndexes.has(candidate.routeIndex)) {
        return false;
      }

      return candidate.relayHostname === recommendation.relay.hostname;
    });

    if (!descriptor) {
      return {
        recommendation,
        route: null,
      };
    }

    usedRouteIndexes.add(descriptor.routeIndex);
    return {
      recommendation,
      route: exposure.routes[descriptor.routeIndex] ?? null,
    };
  });

  return [
    input.applied ? 'Mullgate route recommendations applied.' : 'Mullgate route recommendations.',
    'phase: recommend-routes',
    'source: relay-probe',
    `config: ${input.configPath}`,
    `apply: ${input.applied ? 'yes' : 'no'}`,
    `selectors: ${input.summaries.length}`,
    ...input.summaries.map(
      (summary, index) =>
        `${index + 1}. ${renderProxyExportSelectorLabel(summary.selector)} matched=${summary.matchedCount} probed=${summary.probedCount} recommended=${summary.recommendedCount}`,
    ),
    `recommended routes: ${recommendedRoutes.length}`,
    ...recommendedRoutes.flatMap(({ recommendation, route }, index) => {
      const routeStatus = route
        ? input.createdAliases.includes(route.alias)
          ? input.applied
            ? 'applied new route'
            : 'would add new route'
          : 'existing configured route'
        : 'route details unavailable';

      const endpointLines = route
        ? route.endpoints.map((endpoint) => {
            return `   ${endpoint.protocol}: ${createAuthenticatedEndpointUrl(input.baseConfig, endpoint.bindUrl)}`;
          })
        : [];

      return [
        `${index + 1}. relay=${recommendation.relay.hostname} latency=${recommendation.latencyMs.toFixed(1)}ms`,
        `   selector: ${renderProxyExportSelectorLabel(recommendation.selector)}`,
        `   provider: ${recommendation.relay.provider ?? 'n/a'}`,
        `   owner: ${recommendation.relay.owned ? 'mullvad' : 'rented'}`,
        `   run mode: ${recommendation.relay.stboot ? 'ram' : 'disk'}`,
        `   port speed: ${recommendation.relay.networkPortSpeed ?? 'n/a'}`,
        `   route status: ${routeStatus}`,
        ...(route
          ? [
              `   route alias: ${route.alias}`,
              `   route id: ${route.routeId}`,
              `   hostname: ${route.hostname}`,
              `   bind ip: ${route.bindIp}`,
            ]
          : []),
        ...endpointLines,
      ];
    }),
  ].join('\n');
}

function renderRecommendFailure(result: ProxyExportFailure): string {
  return [
    'Mullgate recommend failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    ...(result.configPath ? [`config: ${result.configPath}`] : []),
    ...(result.artifactPath ? [`artifact: ${result.artifactPath}`] : []),
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
  ].join('\n');
}
