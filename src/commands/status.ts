import type { Command } from 'commander';

import { type WritableTextSink, writeCliReport } from '../cli-output.js';
import {
  buildExposureContract,
  computePublishedPort,
  deriveRuntimeListenerHost,
  type ExposureContract,
} from '../config/exposure-contract.js';
import { redactSensitiveText } from '../config/redact.js';
import type { MullgateConfig, RuntimeStartDiagnostic } from '../config/schema.js';
import { ConfigStore, type LoadConfigResult } from '../config/store.js';
import { buildPlatformSupportContract } from '../platform/support-contract.js';
import {
  type DockerComposeContainer,
  type DockerComposeStatusResult,
  type QueryDockerComposeStatusOptions,
  queryDockerComposeStatus,
} from '../runtime/docker-runtime.js';
import type { RuntimeBundleManifest } from '../runtime/render-runtime-bundle.js';
import { ENTRY_TUNNEL_SERVICE, ROUTE_PROXY_SERVICE } from '../runtime/render-runtime-proxies.js';
import {
  type ArtifactReadResult,
  type ContainerLiveState,
  classifyContainerState,
  findContainerForService,
  formatArtifactPresence,
  readJsonArtifact,
  renderComposeRemediation,
  resolveLastStartDiagnostic,
} from './runtime-diagnostics.js';

const ROUTING_LAYER_SERVICE = 'routing-layer';

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
  readonly listeners: {
    readonly socks5: string;
    readonly http: string;
    readonly https: string | null;
  };
  readonly httpsBackendName: string | null;
  readonly dnsRecord: string | null;
  readonly endpoints: readonly {
    readonly protocol: string;
    readonly hostnameUrl: string;
    readonly bindUrl: string;
  }[];
};

type SharedServiceView = {
  readonly serviceName: string;
  readonly container: DockerComposeContainer | null;
  readonly liveState: ContainerLiveState;
  readonly detail: string;
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
  readonly inspectRuntime?: (
    options: QueryDockerComposeStatusOptions,
  ) => Promise<DockerComposeStatusResult>;
  readonly stdout?: WritableTextSink;
  readonly stderr?: WritableTextSink;
};

export function registerStatusCommand(
  program: Command,
  dependencies: StatusCommandDependencies = {},
): void {
  program
    .command('status')
    .description(
      'Inspect saved Mullgate state, runtime artifacts, and live Docker Compose status in one report.',
    )
    .action(createStatusCommandAction(dependencies));
}

export function createStatusCommandAction(
  dependencies: StatusCommandDependencies = {},
): () => Promise<void> {
  return async () => {
    const result = await runStatusFlow(dependencies);
    writeStatusResult(result, dependencies);
    process.exitCode = result.exitCode;
  };
}

export async function runStatusFlow(
  dependencies: Omit<StatusCommandDependencies, 'stdout' | 'stderr'> = {},
): Promise<StatusFlowResult> {
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
      summary: renderUnconfiguredStatus(
        loadResult.message,
        store.paths.configFile,
        store.paths.runtimeDir,
      ),
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

  const exposure =
    manifestResult.kind === 'present'
      ? manifestResult.value.exposure
      : buildExposureContract(config);
  const platform =
    manifestResult.kind === 'present'
      ? manifestResult.value.platform
      : buildPlatformSupportContract({ paths: store.paths });
  const routes = buildRouteSurfaces(
    config,
    exposure,
    manifestResult.kind === 'present' ? manifestResult.value : null,
  );
  const routeViews = composeStatus.ok
    ? buildRouteContainerViews(routes, composeStatus.containers)
    : routes.map((route) => createRouteContainerView(route, null));
  const sharedServiceViews = buildSharedServiceViews(composeStatus);
  const lastStart = resolveLastStartDiagnostic(config, lastStartResult);
  const diagnostics = buildDiagnostics({
    config,
    manifestResult,
    lastStartResult,
    lastStart,
    composeStatus,
    sharedServiceViews,
  });
  const phase = classifyOverallPhase({
    config,
    composeStatus,
    sharedServiceViews,
    lastStart,
  });

  const summary = [
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
    `mode label: ${exposure.posture.modeLabel}`,
    `recommendation: ${exposure.posture.recommendation}`,
    `posture summary: ${exposure.posture.summary}`,
    `remote story: ${exposure.posture.remoteStory}`,
    `platform: ${platform.platform}`,
    `platform source: ${platform.platformSource}`,
    `platform support: ${platform.posture.supportLevel}`,
    `platform mode: ${platform.posture.modeLabel}`,
    `platform summary: ${platform.posture.summary}`,
    `runtime story: ${platform.posture.runtimeStory}`,
    `host networking: ${platform.hostNetworking.modeLabel}`,
    `host networking summary: ${platform.hostNetworking.summary}`,
    `compose inspection: ${composeStatus.ok ? 'available' : 'unavailable'}`,
    ...(composeStatus.ok
      ? [
          `compose project: ${composeStatus.project ?? 'n/a'}`,
          `compose command: ${composeStatus.command.rendered}`,
          `container summary: ${composeStatus.summary.total} total, ${composeStatus.summary.running} running, ${composeStatus.summary.starting} starting, ${composeStatus.summary.stopped} stopped, ${composeStatus.summary.unhealthy} unhealthy`,
          ...sharedServiceViews.map((service) => `${service.serviceName}: ${service.detail}`),
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
      `   shared service: ${view.route.serviceName}`,
      `   live state: ${view.detail}`,
      `   socks5 listener: ${view.route.listeners.socks5}`,
      `   http listener: ${view.route.listeners.http}`,
      ...(view.route.listeners.https ? [`   https listener: ${view.route.listeners.https}`] : []),
      ...(view.route.httpsBackendName ? [`   https backend: ${view.route.httpsBackendName}`] : []),
      `   dns: ${view.route.dnsRecord ?? 'not required; use direct bind IP entrypoints'}`,
      ...view.route.endpoints.flatMap((endpoint) => [
        `   ${endpoint.protocol} hostname: ${endpoint.hostnameUrl}`,
        `   ${endpoint.protocol} direct ip: ${endpoint.bindUrl}`,
      ]),
    ]),
    '',
    'platform guidance',
    ...platform.guidance.map((line) => `- ${line}`),
    ...(platform.warnings.length > 0
      ? [
          '',
          'platform warnings',
          ...platform.warnings.map((warning) => `- ${warning.severity}: ${warning.message}`),
        ]
      : []),
    '',
    'network-mode guidance',
    ...exposure.guidance.map((line) => `- ${line}`),
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
  ].join('\n');

  return {
    ok: true,
    exitCode: 0,
    phase,
    summary: redactSensitiveText(summary, config),
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
      serviceName:
        manifestRoute?.services.routeProxy.name ??
        manifest?.services.routeProxy.name ??
        ROUTE_PROXY_SERVICE,
      listeners: {
        socks5:
          manifestRoute?.listeners.socks5 ??
          `${deriveRuntimeListenerHost(config.setup.exposure.mode, location.bindIp)}:${computePublishedPort(config.setup.exposure.mode, config.setup.bind.socksPort, index)}`,
        http:
          manifestRoute?.listeners.http ??
          `${deriveRuntimeListenerHost(config.setup.exposure.mode, location.bindIp)}:${computePublishedPort(config.setup.exposure.mode, config.setup.bind.httpPort, index)}`,
        https:
          manifestRoute?.listeners.https ??
          (config.setup.bind.httpsPort === null
            ? null
            : `${deriveRuntimeListenerHost(config.setup.exposure.mode, location.bindIp)}:${computePublishedPort(config.setup.exposure.mode, config.setup.bind.httpsPort, index)}`),
      },
      httpsBackendName: manifestRoute?.services.backends.https ?? location.runtime.httpsBackendName,
      dnsRecord: exposureRoute?.dnsRecord ?? null,
      endpoints: (exposureRoute?.endpoints ?? []).map((endpoint) => ({
        protocol: endpoint.protocol,
        hostnameUrl: endpoint.hostnameUrl,
        bindUrl: endpoint.bindUrl,
      })),
    };
  });
}

function buildSharedServiceViews(composeStatus: DockerComposeStatusResult): SharedServiceView[] {
  const containers = composeStatus.ok ? composeStatus.containers : [];

  return [
    createSharedServiceView(
      ENTRY_TUNNEL_SERVICE,
      findContainerForService(containers, ENTRY_TUNNEL_SERVICE),
    ),
    createSharedServiceView(
      ROUTE_PROXY_SERVICE,
      findContainerForService(containers, ROUTE_PROXY_SERVICE),
    ),
    createSharedServiceView(
      ROUTING_LAYER_SERVICE,
      findContainerForService(containers, ROUTING_LAYER_SERVICE),
    ),
  ];
}

function createSharedServiceView(
  serviceName: string,
  container: DockerComposeContainer | null,
): SharedServiceView {
  const classified = classifyContainerState(container);

  return {
    serviceName,
    container,
    liveState: classified.liveState,
    detail: classified.detail,
  };
}

function buildRouteContainerViews(
  routes: readonly RouteSurface[],
  containers: readonly DockerComposeContainer[],
): RouteContainerView[] {
  return routes.map((route) =>
    createRouteContainerView(route, findContainerForService(containers, route.serviceName)),
  );
}

function createRouteContainerView(
  route: RouteSurface,
  container: DockerComposeContainer | null,
): RouteContainerView {
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
  readonly sharedServiceViews: readonly SharedServiceView[];
  readonly lastStart: RuntimeStartDiagnostic | null;
}): StatusPhase {
  if (!input.composeStatus.ok) {
    return 'error';
  }

  const liveStates = input.sharedServiceViews.map((service) => service.liveState);
  const everyRunning = liveStates.every((state) => state === 'running');
  const someRunning = liveStates.some((state) => state === 'running');
  const someStarting = liveStates.some((state) => state === 'starting');
  const someStopped = liveStates.some((state) => state === 'stopped');
  const someDegraded = liveStates.some((state) => state === 'degraded');
  const hasNoContainers = input.composeStatus.containers.length === 0;

  if (someDegraded) {
    return 'degraded';
  }

  if (everyRunning) {
    return 'running';
  }

  if ((someRunning || someStarting) && !someStopped) {
    return 'starting';
  }

  if ((someRunning || someStarting) && someStopped) {
    return 'degraded';
  }

  if (hasNoContainers || liveStates.every((state) => state === 'stopped')) {
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
  readonly sharedServiceViews: readonly SharedServiceView[];
}): string[] {
  const diagnostics: string[] = [];

  if (input.manifestResult.kind === 'missing') {
    diagnostics.push(
      'runtime manifest is missing; rerun `mullgate proxy start` to re-render the Docker/runtime artifact bundle.',
    );
  } else if (input.manifestResult.kind === 'invalid') {
    diagnostics.push(`runtime manifest could not be parsed: ${input.manifestResult.reason}`);
  }

  if (input.lastStartResult.kind === 'missing' && !input.config.diagnostics.lastRuntimeStart) {
    diagnostics.push(
      'no persisted last-start report exists yet; run `mullgate proxy start` to capture a fresh launch diagnostic.',
    );
  } else if (input.lastStartResult.kind === 'invalid') {
    diagnostics.push(`last-start report could not be parsed: ${input.lastStartResult.reason}`);
  }

  if (!input.composeStatus.ok) {
    diagnostics.push(
      `${input.composeStatus.message} ${renderComposeRemediation(input.composeStatus.code)}`.trim(),
    );
    return diagnostics;
  }

  for (const service of input.sharedServiceViews) {
    if (service.liveState !== 'running') {
      diagnostics.push(`${service.serviceName} is not fully healthy: ${service.detail}.`);
    }
  }

  if (
    input.config.runtime.status.phase === 'running' &&
    input.sharedServiceViews.some((service) => service.liveState !== 'running')
  ) {
    diagnostics.push(
      'saved runtime status says running, but live compose status shows stopped or degraded shared services. Trust live compose over the saved phase and rerun `mullgate proxy start` after fixing the failing service.',
    );
  }

  if (input.config.runtime.status.phase === 'unvalidated') {
    diagnostics.push(
      'saved config is still marked unvalidated, so runtime artifacts may lag behind recent config or exposure edits.',
    );
  }

  if (input.lastStart?.status === 'failure') {
    diagnostics.push(
      'the last recorded `mullgate proxy start` attempt failed; inspect the last-start diagnostics below before restarting blindly.',
    );
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

function writeStatusResult(
  result: StatusFlowResult,
  dependencies: Pick<StatusCommandDependencies, 'stdout' | 'stderr'>,
): void {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  if (result.ok) {
    writeCliReport({ sink: stdout, text: result.summary });
    return;
  }

  writeCliReport({ sink: stderr, text: result.summary, tone: 'error' });
}
