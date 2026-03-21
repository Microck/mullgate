import type { Command } from 'commander';

import { buildExposureContract, type ExposureContract } from '../config/exposure-contract.js';
import { redactSensitiveText } from '../config/redact.js';
import { ConfigStore, type LoadConfigResult } from '../config/store.js';
import type { MullgateConfig, RuntimeStartDiagnostic } from '../config/schema.js';
import {
  classifyContainerState,
  findContainerForService,
  formatArtifactPresence,
  readJsonArtifact,
  renderComposeRemediation,
  resolveLastStartDiagnostic,
  type ArtifactReadResult,
  type ContainerLiveState,
} from './runtime-diagnostics.js';
import {
  queryDockerComposeStatus,
  type DockerComposeContainer,
  type DockerComposeStatusResult,
  type QueryDockerComposeStatusOptions,
} from '../runtime/docker-runtime.js';
import type { RuntimeBundleManifest } from '../runtime/render-runtime-bundle.js';

const ROUTING_LAYER_SERVICE = 'routing-layer';

type WritableTextSink = {
  write(chunk: string): unknown;
};

type StatusPhase = 'unconfigured' | 'stopped' | 'starting' | 'running' | 'degraded' | 'error';

type StatusSuccess = {
  readonly ok: true;
  readonly exitCode: 0;
  readonly phase: StatusPhase;
  readonly summary: string;
};

type StatusFailure = {
  readonly ok: false;
  readonly exitCode: 1;
  readonly summary: string;
};

type StatusFlowResult = StatusSuccess | StatusFailure;

type RouteSurface = {
  readonly index: number;
  readonly alias: string;
  readonly routeId: string;
  readonly hostname: string;
  readonly bindIp: string;
  readonly serviceName: string;
  readonly backends: {
    readonly socks5: string | null;
    readonly http: string | null;
    readonly https: string | null;
  };
  readonly dnsRecord: string | null;
  readonly endpoints: readonly {
    readonly protocol: string;
    readonly redactedHostnameUrl: string;
    readonly redactedBindUrl: string;
  }[];
};

type RouteContainerView = {
  readonly route: RouteSurface;
  readonly container: DockerComposeContainer | null;
  readonly liveState: ContainerLiveState;
  readonly detail: string;
};

type StatusCommandDependencies = {
  readonly store?: ConfigStore;
  readonly checkedAt?: string;
  readonly inspectRuntime?: (options: QueryDockerComposeStatusOptions) => Promise<DockerComposeStatusResult>;
  readonly stdout?: WritableTextSink;
  readonly stderr?: WritableTextSink;
};

export function registerStatusCommand(program: Command, dependencies: StatusCommandDependencies = {}): void {
  program
    .command('status')
    .description('Inspect saved Mullgate state, runtime artifacts, and live Docker Compose status in one report.')
    .action(createStatusCommandAction(dependencies));
}

export function createStatusCommandAction(dependencies: StatusCommandDependencies = {}): () => Promise<void> {
  return async () => {
    const result = await runStatusFlow(dependencies);
    writeStatusResult(result, dependencies);
    process.exitCode = result.exitCode;
  };
}

export async function runStatusFlow(dependencies: Omit<StatusCommandDependencies, 'stdout' | 'stderr'> = {}): Promise<StatusFlowResult> {
  const store = dependencies.store ?? new ConfigStore();
  const loadResult = await store.load();

  if (!loadResult.ok) {
    return {
      ok: false,
      exitCode: 1,
      summary: renderLoadError(loadResult),
    };
  }

  if (loadResult.source === 'empty') {
    return {
      ok: true,
      exitCode: 0,
      phase: 'unconfigured',
      summary: renderUnconfiguredStatus(loadResult.message, store.paths.configFile, store.paths.runtimeDir),
    };
  }

  const config = loadResult.config;
  const manifestPath = config.runtime.runtimeBundle.manifestPath;
  const startReportPath = config.diagnostics.lastRuntimeStartReportPath;
  const composeFilePath = config.runtime.runtimeBundle.dockerComposePath;
  const inspectRuntime = dependencies.inspectRuntime ?? queryDockerComposeStatus;

  const [manifestResult, lastStartResult, composeStatus] = await Promise.all([
    readJsonArtifact<RuntimeBundleManifest>(manifestPath),
    readJsonArtifact<RuntimeStartDiagnostic>(startReportPath),
    inspectRuntime({
      composeFilePath,
      ...(dependencies.checkedAt ? { checkedAt: dependencies.checkedAt } : {}),
    }),
  ]);

  const exposure = manifestResult.kind === 'present' ? manifestResult.value.exposure : buildExposureContract(config);
  const routes = buildRouteSurfaces(config, exposure, manifestResult.kind === 'present' ? manifestResult.value : null);
  const routeViews = composeStatus.ok ? buildRouteContainerViews(routes, composeStatus.containers) : routes.map((route) => createRouteContainerView(route, null));
  const routingLayerContainer = composeStatus.ok ? findContainerForService(composeStatus.containers, ROUTING_LAYER_SERVICE) : null;
  const routingLayerState = classifyContainerState(routingLayerContainer);
  const lastStart = resolveLastStartDiagnostic(config, lastStartResult);
  const diagnostics = buildDiagnostics({
    config,
    manifestResult,
    lastStartResult,
    lastStart,
    composeStatus,
    routeViews,
    routingLayerState,
  });
  const phase = classifyOverallPhase({
    config,
    composeStatus,
    routeViews,
    routingLayerState,
    lastStart,
  });

  const summary = redactSensitiveText(
    [
      'Mullgate runtime status',
      `phase: ${phase}`,
      `config: ${store.paths.configFile}`,
      `runtime dir: ${store.paths.runtimeDir}`,
      `docker compose: ${composeFilePath}`,
      `runtime manifest: ${formatArtifactPresence(manifestPath, manifestResult)}`,
      `last start report: ${formatArtifactPresence(startReportPath, lastStartResult)}`,
      `saved runtime status: ${config.runtime.status.phase}`,
      `saved checked at: ${config.runtime.status.lastCheckedAt ?? 'n/a'}`,
      `saved message: ${config.runtime.status.message ?? 'n/a'}`,
      `exposure source: ${manifestResult.kind === 'present' ? 'runtime-manifest' : 'canonical-config fallback'}`,
      `compose inspection: ${composeStatus.ok ? 'available' : 'unavailable'}`,
      ...(composeStatus.ok
        ? [
            `compose project: ${composeStatus.project ?? 'n/a'}`,
            `compose command: ${composeStatus.command.rendered}`,
            `container summary: ${composeStatus.summary.total} total, ${composeStatus.summary.running} running, ${composeStatus.summary.starting} starting, ${composeStatus.summary.stopped} stopped, ${composeStatus.summary.unhealthy} unhealthy`,
            `routing layer: ${routingLayerState.detail}`,
          ]
        : [
            `compose command: ${composeStatus.command.rendered}`,
            `compose code: ${composeStatus.code}`,
            `compose reason: ${composeStatus.message}`,
            ...(composeStatus.cause ? [`compose cause: ${composeStatus.cause}`] : []),
          ]),
      '',
      'routes',
      ...routeViews.flatMap((view) => [
        `${view.route.index + 1}. ${view.route.hostname} -> ${view.route.bindIp}`,
        `   alias: ${view.route.alias}`,
        `   route id: ${view.route.routeId}`,
        `   service: ${view.route.serviceName}`,
        `   live state: ${view.detail}`,
        ...(view.route.backends.socks5 ? [`   socks5 backend: ${view.route.backends.socks5}`] : []),
        ...(view.route.backends.http ? [`   http backend: ${view.route.backends.http}`] : []),
        ...(view.route.backends.https ? [`   https backend: ${view.route.backends.https}`] : []),
        `   dns: ${view.route.dnsRecord ?? 'not required; use direct bind IP entrypoints'}`,
        ...view.route.endpoints.flatMap((endpoint) => [
          `   ${endpoint.protocol} hostname: ${endpoint.redactedHostnameUrl}`,
          `   ${endpoint.protocol} direct ip: ${endpoint.redactedBindUrl}`,
        ]),
      ]),
      '',
      'warnings',
      ...(diagnostics.length > 0 ? diagnostics.map((diagnostic) => `- ${diagnostic}`) : ['- none']),
      '',
      'last start diagnostics',
      ...(lastStart
        ? [
            `status: ${lastStart.status}`,
            `attempted at: ${lastStart.attemptedAt}`,
            `phase: ${lastStart.phase}`,
            `source: ${lastStart.source}`,
            `code: ${lastStart.code ?? 'n/a'}`,
            ...(lastStart.routeId ? [`route id: ${lastStart.routeId}`] : []),
            ...(lastStart.routeHostname ? [`route hostname: ${lastStart.routeHostname}`] : []),
            ...(lastStart.routeBindIp ? [`route bind ip: ${lastStart.routeBindIp}`] : []),
            ...(lastStart.serviceName ? [`service: ${lastStart.serviceName}`] : []),
            `reason: ${lastStart.message}`,
            ...(lastStart.cause ? [`cause: ${lastStart.cause}`] : []),
          ]
        : ['status: none persisted yet']),
    ].join('\n'),
    config,
  );

  return {
    ok: true,
    exitCode: 0,
    phase,
    summary,
  };
}

function buildRouteSurfaces(
  config: MullgateConfig,
  exposure: ExposureContract,
  manifest: RuntimeBundleManifest | null,
): RouteSurface[] {
  const manifestRoutes = new Map((manifest?.routes ?? []).map((route) => [route.routeId, route]));
  const exposureRoutes = new Map(exposure.routes.map((route) => [route.routeId, route]));

  return config.routing.locations.map((location, index) => {
    const manifestRoute = manifestRoutes.get(location.runtime.routeId);
    const exposureRoute = exposureRoutes.get(location.runtime.routeId);

    return {
      index,
      alias: location.alias,
      routeId: location.runtime.routeId,
      hostname: exposureRoute?.hostname ?? manifestRoute?.hostname ?? location.hostname,
      bindIp: exposureRoute?.bindIp ?? manifestRoute?.bindIp ?? location.bindIp,
      serviceName: manifestRoute?.services.wireproxy.name ?? location.runtime.wireproxyServiceName,
      backends: {
        socks5: manifestRoute?.services.backends.socks5 ?? null,
        http: manifestRoute?.services.backends.http ?? null,
        https: manifestRoute?.services.backends.https ?? null,
      },
      dnsRecord: exposureRoute?.dnsRecord ?? null,
      endpoints: (exposureRoute?.endpoints ?? []).map((endpoint) => ({
        protocol: endpoint.protocol,
        redactedHostnameUrl: endpoint.redactedHostnameUrl,
        redactedBindUrl: endpoint.redactedBindUrl,
      })),
    };
  });
}

function buildRouteContainerViews(routes: readonly RouteSurface[], containers: readonly DockerComposeContainer[]): RouteContainerView[] {
  return routes.map((route) => createRouteContainerView(route, findContainerForService(containers, route.serviceName)));
}

function createRouteContainerView(route: RouteSurface, container: DockerComposeContainer | null): RouteContainerView {
  const classified = classifyContainerState(container);

  return {
    route,
    container,
    liveState: classified.liveState,
    detail: classified.detail,
  };
}

function classifyOverallPhase(input: {
  readonly config: MullgateConfig;
  readonly composeStatus: DockerComposeStatusResult;
  readonly routeViews: readonly RouteContainerView[];
  readonly routingLayerState: ReturnType<typeof classifyContainerState>;
  readonly lastStart: RuntimeStartDiagnostic | null;
}): StatusPhase {
  if (!input.composeStatus.ok) {
    return 'error';
  }

  const liveStates = [input.routingLayerState.liveState, ...input.routeViews.map((view) => view.liveState)];
  const hasRunning = liveStates.includes('running');
  const hasStarting = liveStates.includes('starting');
  const hasStopped = liveStates.includes('stopped');
  const hasDegraded = liveStates.includes('degraded');
  const expectedServices = input.routeViews.length + 1;
  const hasNoContainers = input.composeStatus.containers.length === 0;
  const hasMissingExpectedServices = input.composeStatus.containers.length < expectedServices && hasStopped;

  if (hasDegraded) {
    return 'degraded';
  }

  if (hasRunning && (hasStopped || hasMissingExpectedServices)) {
    return 'degraded';
  }

  if (hasRunning && !hasStarting && !hasStopped) {
    return 'running';
  }

  if (hasStarting && !hasStopped) {
    return 'starting';
  }

  if (hasNoContainers || (!hasRunning && !hasStarting && hasStopped)) {
    if (input.config.runtime.status.phase === 'running') {
      return 'degraded';
    }

    if (input.config.runtime.status.phase === 'error' || input.lastStart?.status === 'failure') {
      return 'error';
    }

    return 'stopped';
  }

  return 'stopped';
}

function buildDiagnostics(input: {
  readonly config: MullgateConfig;
  readonly manifestResult: ArtifactReadResult<RuntimeBundleManifest>;
  readonly lastStartResult: ArtifactReadResult<RuntimeStartDiagnostic>;
  readonly lastStart: RuntimeStartDiagnostic | null;
  readonly composeStatus: DockerComposeStatusResult;
  readonly routeViews: readonly RouteContainerView[];
  readonly routingLayerState: ReturnType<typeof classifyContainerState>;
}): string[] {
  const diagnostics: string[] = [];

  if (input.manifestResult.kind === 'missing') {
    diagnostics.push('runtime manifest is missing; rerun `mullgate start` to re-render the Docker/runtime artifact bundle.');
  } else if (input.manifestResult.kind === 'invalid') {
    diagnostics.push(`runtime manifest could not be parsed: ${input.manifestResult.reason}`);
  }

  if (input.lastStartResult.kind === 'missing' && !input.config.diagnostics.lastRuntimeStart) {
    diagnostics.push('no persisted last-start report exists yet; run `mullgate start` to capture a fresh launch diagnostic.');
  } else if (input.lastStartResult.kind === 'invalid') {
    diagnostics.push(`last-start report could not be parsed: ${input.lastStartResult.reason}`);
  }

  if (!input.composeStatus.ok) {
    diagnostics.push(`${input.composeStatus.message} ${renderComposeRemediation(input.composeStatus.code)}`.trim());
    return diagnostics;
  }

  if (input.routingLayerState.liveState !== 'running') {
    diagnostics.push(`routing layer is not fully healthy: ${input.routingLayerState.detail}.`);
  }

  for (const view of input.routeViews) {
    if (view.liveState !== 'running') {
      diagnostics.push(`route ${view.route.routeId} is ${view.liveState}: ${view.detail}.`);
    }
  }

  if (input.config.runtime.status.phase === 'running' && input.routeViews.some((view) => view.liveState !== 'running')) {
    diagnostics.push('saved runtime status says running, but live compose status shows stopped or degraded route containers. Trust live compose over the saved phase and rerun `mullgate start` after fixing the failing route.');
  }

  if (input.config.runtime.status.phase === 'unvalidated') {
    diagnostics.push('saved config is still marked unvalidated, so runtime artifacts may lag behind recent config or exposure edits.');
  }

  if (input.lastStart?.status === 'failure') {
    diagnostics.push('the last recorded `mullgate start` attempt failed; inspect the last-start diagnostics below before restarting blindly.');
  }

  return diagnostics;
}

function renderLoadError(result: Extract<LoadConfigResult, { ok: false }>): string {
  return [
    'Failed to inspect Mullgate runtime status.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    `artifact: ${result.artifactPath}`,
    `reason: ${result.message}`,
  ].join('\n');
}

function renderUnconfiguredStatus(message: string, configPath: string, runtimeDir: string): string {
  return [
    'Mullgate runtime status',
    'phase: unconfigured',
    `config: ${configPath}`,
    `runtime dir: ${runtimeDir}`,
    `reason: ${message}`,
    'next step: run `mullgate setup` before expecting runtime artifacts or Docker containers.',
  ].join('\n');
}

function writeStatusResult(result: StatusFlowResult, dependencies: Pick<StatusCommandDependencies, 'stdout' | 'stderr'>): void {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  if (result.ok) {
    stdout.write(`${result.summary}\n`);
    return;
  }

  stderr.write(`${result.summary}\n`);
}
