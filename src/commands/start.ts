import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';

import {
  loadStoredRelayCatalog,
  summarizeValidationSource,
  verifyHttpsAssets,
  withRuntimeStatus,
} from '../app/setup-runner.js';
import { writeCliReport } from '../cli-output.js';
import type { MullgatePaths } from '../config/paths.js';
import type { MullgateConfig, RuntimeStartDiagnostic } from '../config/schema.js';
import { ConfigStore } from '../config/store.js';
import {
  type DockerRuntimeResult,
  type StartDockerRuntimeOptions,
  startDockerRuntime,
} from '../runtime/docker-runtime.js';
import {
  type RuntimeBundleManifest,
  renderRuntimeBundle,
} from '../runtime/render-runtime-bundle.js';
import {
  ENTRY_TUNNEL_SERVICE,
  ROUTE_PROXY_SERVICE,
  renderRuntimeProxyArtifacts,
} from '../runtime/render-runtime-proxies.js';
import {
  type ValidateRuntimeOptions,
  validateRuntimeArtifacts,
} from '../runtime/validate-runtime.js';

type ValidationSourceSummary = string;

type WritableTextSink = {
  write(chunk: string): unknown;
};

type RouteDiagnosticContext = {
  readonly routeId?: string | null;
  readonly routeHostname?: string | null;
  readonly routeBindIp?: string | null;
  readonly serviceName?: string | null;
};

type RouteValidationSuccess = {
  readonly ok: true;
  readonly validationSource: ValidationSourceSummary;
  readonly reportPath: string;
};

type RouteValidationFailure = {
  readonly ok: false;
  readonly phase: 'validation';
  readonly source: string;
  readonly message: string;
  readonly cause: string;
  readonly artifactPath: string;
  readonly validationSource: ValidationSourceSummary;
  readonly routeId: string | null;
  readonly routeHostname: string | null;
  readonly routeBindIp: string | null;
  readonly serviceName: string;
  readonly reportPath: string;
};

export type StartSuccess = {
  readonly ok: true;
  readonly phase: 'compose-launch';
  readonly source: 'docker-compose';
  readonly exitCode: 0;
  readonly paths: MullgatePaths;
  readonly config: MullgateConfig;
  readonly report: RuntimeStartDiagnostic;
  readonly validationSource: ValidationSourceSummary;
  readonly composeFilePath: string;
  readonly manifestPath: string;
  readonly validationReportPath: string;
  readonly summary: string;
};

export type StartFailure = {
  readonly ok: false;
  readonly exitCode: 1;
  readonly phase:
    | 'load-config'
    | 'read-config'
    | 'parse-config'
    | 'https-assets'
    | 'relay-normalize'
    | 'artifact-render'
    | 'validation'
    | 'compose-detect'
    | 'compose-launch'
    | 'persist-config';
  readonly source: string;
  readonly paths: MullgatePaths;
  readonly message: string;
  readonly attemptedAt?: string;
  readonly artifactPath?: string;
  readonly cause?: string;
  readonly code?: string | null;
  readonly command?: string | null;
  readonly composeFilePath?: string | null;
  readonly validationSource?: ValidationSourceSummary | null;
  readonly routeId?: string | null;
  readonly routeHostname?: string | null;
  readonly routeBindIp?: string | null;
  readonly serviceName?: string | null;
  readonly config?: MullgateConfig;
  readonly report?: RuntimeStartDiagnostic;
};

export type StartFlowResult = StartSuccess | StartFailure;

export type StartCommandDependencies = {
  readonly store?: ConfigStore;
  readonly checkedAt?: string;
  readonly startRuntime?: (options: StartDockerRuntimeOptions) => Promise<DockerRuntimeResult>;
  readonly validateOptions?: Pick<
    ValidateRuntimeOptions,
    'wireproxyBinary' | 'dockerBinary' | 'dockerImage' | 'routeProxyDockerImage' | 'spawn'
  >;
  readonly stdout?: WritableTextSink;
  readonly stderr?: WritableTextSink;
};

export function registerStartCommand(
  program: Command,
  dependencies: StartCommandDependencies = {},
): void {
  program
    .command('start')
    .description(
      'Re-render derived runtime artifacts from saved config, validate them, and launch the Docker runtime bundle.',
    )
    .action(createStartCommandAction(dependencies));
}

export function createStartCommandAction(
  dependencies: StartCommandDependencies = {},
): () => Promise<void> {
  return async () => {
    const result = await runStartFlow(dependencies);
    writeStartResult(result, dependencies);
    process.exitCode = result.exitCode;
  };
}

export async function runStartFlow(
  dependencies: Omit<StartCommandDependencies, 'stdout' | 'stderr'> = {},
): Promise<StartFlowResult> {
  const store = dependencies.store ?? new ConfigStore();
  const loadResult = await store.load();

  if (!loadResult.ok) {
    return {
      ok: false,
      exitCode: 1,
      phase: loadResult.phase,
      source: loadResult.source,
      paths: store.paths,
      artifactPath: loadResult.artifactPath,
      message: loadResult.message,
    };
  }

  if (loadResult.source === 'empty') {
    return {
      ok: false,
      exitCode: 1,
      phase: loadResult.phase,
      source: loadResult.source,
      paths: store.paths,
      artifactPath: store.paths.configFile,
      message: loadResult.message,
    };
  }

  const attemptedAt = dependencies.checkedAt ?? new Date().toISOString();
  const startRuntime = dependencies.startRuntime ?? startDockerRuntime;
  const baseConfig = synchronizeRuntimePaths(loadResult.config, store.paths);

  const httpsCheck = await verifyHttpsAssets({
    enabled: baseConfig.setup.https.enabled,
    certPath: baseConfig.setup.https.certPath,
    keyPath: baseConfig.setup.https.keyPath,
  });

  if (!httpsCheck.ok) {
    return persistFailureOutcome({
      store,
      config: baseConfig,
      attemptedAt,
      phase: httpsCheck.phase,
      source: httpsCheck.source,
      message: httpsCheck.message,
      cause: httpsCheck.cause,
      artifactPath: httpsCheck.artifactPath,
      composeFilePath: store.paths.runtimeComposeFile,
    });
  }

  const relayCatalog = await loadStoredRelayCatalog(store.paths.provisioningCacheFile);

  if (!relayCatalog.ok) {
    return persistFailureOutcome({
      store,
      config: baseConfig,
      attemptedAt,
      phase: relayCatalog.phase,
      source: relayCatalog.source,
      message: relayCatalog.message,
      cause: relayCatalog.cause,
      artifactPath: relayCatalog.artifactPath,
      composeFilePath: store.paths.runtimeComposeFile,
    });
  }

  const runtimeProxyRender = await renderRuntimeProxyArtifacts({
    config: baseConfig,
    relayCatalog: relayCatalog.value,
    paths: store.paths,
    generatedAt: attemptedAt,
  });

  if (!runtimeProxyRender.ok) {
    return persistFailureOutcome({
      store,
      config: baseConfig,
      attemptedAt,
      phase: runtimeProxyRender.phase,
      source: runtimeProxyRender.source,
      code: runtimeProxyRender.code,
      message: runtimeProxyRender.message,
      cause: runtimeProxyRender.cause,
      artifactPath: runtimeProxyRender.artifactPath,
      composeFilePath: store.paths.runtimeComposeFile,
      routeId: runtimeProxyRender.routeId,
      routeHostname: runtimeProxyRender.routeHostname,
      routeBindIp: runtimeProxyRender.routeBindIp,
      serviceName: runtimeProxyRender.serviceName,
    });
  }

  const runtimeBundle = await renderRuntimeBundle({
    config: baseConfig,
    paths: store.paths,
    generatedAt: attemptedAt,
  });

  if (!runtimeBundle.ok) {
    return persistFailureOutcome({
      store,
      config: baseConfig,
      attemptedAt,
      phase: runtimeBundle.phase,
      source: runtimeBundle.source,
      code: runtimeBundle.code,
      message: runtimeBundle.message,
      cause: runtimeBundle.cause,
      artifactPath: runtimeBundle.artifactPath,
      composeFilePath: store.paths.runtimeComposeFile,
    });
  }

  const validationResult = await validateRenderedRuntime(
    {
      config: baseConfig,
      renderResult: runtimeProxyRender,
      bind: baseConfig.setup.bind,
      reportPath: store.paths.runtimeValidationReportFile,
    },
    attemptedAt,
    dependencies.validateOptions,
  );

  if (!validationResult.ok) {
    return persistFailureOutcome({
      store,
      config: baseConfig,
      attemptedAt,
      phase: validationResult.phase,
      source: validationResult.source,
      message: validationResult.message,
      cause: validationResult.cause,
      artifactPath: validationResult.artifactPath,
      composeFilePath: runtimeBundle.artifactPaths.dockerComposePath,
      validationSource: validationResult.validationSource,
      routeId: validationResult.routeId,
      routeHostname: validationResult.routeHostname,
      routeBindIp: validationResult.routeBindIp,
      serviceName: validationResult.serviceName,
    });
  }

  const startingConfig = withRuntimeStatus(
    baseConfig,
    'starting',
    attemptedAt,
    `Validated shared entry tunnel plus ${baseConfig.routing.locations.length} configured routes via ${validationResult.validationSource}; launching Docker Compose from ${runtimeBundle.artifactPaths.dockerComposePath}.`,
  );
  const startingPersist = await persistConfigOnly(store, startingConfig);

  if (!startingPersist.ok) {
    return startingPersist;
  }

  const runtimeResult = await startRuntime({
    composeFilePath: runtimeBundle.artifactPaths.dockerComposePath,
    checkedAt: attemptedAt,
    ...(dependencies.validateOptions?.dockerBinary
      ? { dockerBinary: dependencies.validateOptions.dockerBinary }
      : {}),
  });

  if (!runtimeResult.ok) {
    const inferredRoute = inferRouteDiagnosticContext(startingConfig, runtimeBundle.manifest, [
      runtimeResult.message,
      runtimeResult.cause,
      runtimeResult.command.rendered,
      runtimeResult.artifactPath,
    ]);

    return persistFailureOutcome({
      store,
      config: startingConfig,
      attemptedAt,
      phase: runtimeResult.phase,
      source: runtimeResult.source,
      code: runtimeResult.code,
      message: runtimeResult.message,
      cause: runtimeResult.cause,
      artifactPath: runtimeResult.artifactPath,
      command: runtimeResult.command.rendered,
      composeFilePath: runtimeResult.composeFilePath,
      validationSource: validationResult.validationSource,
      ...inferredRoute,
    });
  }

  const report = createRuntimeStartDiagnostic({
    attemptedAt,
    status: 'success',
    phase: runtimeResult.phase,
    source: runtimeResult.source,
    message: runtimeResult.message,
    artifactPath: runtimeResult.composeFilePath,
    command: runtimeResult.command.rendered,
    composeFilePath: runtimeResult.composeFilePath,
    validationSource: validationResult.validationSource,
  });
  const successConfig = withStartOutcome(
    startingConfig,
    report,
    'running',
    runtimeResult.checkedAt,
    `Runtime started via ${runtimeResult.source} using ${validationResult.validationSource}.`,
  );
  const persistSuccess = await persistStartOutcome(store, successConfig, report);

  if (!persistSuccess.ok) {
    return persistSuccess;
  }

  const refreshedRuntimeBundle = await renderRuntimeBundle({
    config: successConfig,
    paths: store.paths,
    generatedAt: runtimeResult.checkedAt,
  });

  if (!refreshedRuntimeBundle.ok) {
    return {
      ok: false,
      exitCode: 1,
      phase: 'persist-config',
      source: refreshedRuntimeBundle.source,
      paths: store.paths,
      attemptedAt: runtimeResult.checkedAt,
      artifactPath: refreshedRuntimeBundle.artifactPath,
      message:
        'Runtime started, but Mullgate failed to refresh the runtime manifest with the latest exposure status.',
      ...(refreshedRuntimeBundle.cause ? { cause: refreshedRuntimeBundle.cause } : {}),
      ...(refreshedRuntimeBundle.code ? { code: refreshedRuntimeBundle.code } : {}),
      config: successConfig,
      report,
      composeFilePath: store.paths.runtimeComposeFile,
      validationSource: validationResult.validationSource,
    };
  }

  return {
    ok: true,
    phase: 'compose-launch',
    source: 'docker-compose',
    exitCode: 0,
    paths: store.paths,
    config: successConfig,
    report,
    validationSource: validationResult.validationSource,
    composeFilePath: refreshedRuntimeBundle.artifactPaths.dockerComposePath,
    manifestPath: refreshedRuntimeBundle.artifactPaths.manifestPath,
    validationReportPath: validationResult.reportPath,
    summary: [
      'Mullgate runtime started.',
      'phase: compose-launch',
      'source: docker-compose',
      `attempted at: ${report.attemptedAt}`,
      `routes: ${baseConfig.routing.locations.length}`,
      `access mode: ${baseConfig.setup.access.mode}`,
      `config: ${store.paths.configFile}`,
      `entry wireproxy config: ${runtimeProxyRender.artifactPaths.entryWireproxyConfigPath}`,
      `route proxy config: ${runtimeProxyRender.artifactPaths.routeProxyConfigPath}`,
      `relay cache: ${runtimeProxyRender.artifactPaths.relayCachePath}`,
      `docker compose: ${refreshedRuntimeBundle.artifactPaths.dockerComposePath}`,
      `runtime manifest: ${refreshedRuntimeBundle.artifactPaths.manifestPath}`,
      `validation report: ${validationResult.reportPath}`,
      `validation: ${validationResult.validationSource}`,
      'exposure entrypoints:',
      ...renderExposureInventory(refreshedRuntimeBundle.manifest),
      'runtime status: running',
    ].join('\n'),
  };
}

function renderExposureInventory(manifest: RuntimeBundleManifest): string[] {
  if (manifest.exposure.accessMode === 'inline-selector' && manifest.exposure.inlineSelector) {
    return [
      `mode: ${manifest.exposure.mode}`,
      `access mode: ${manifest.exposure.accessMode}`,
      `base domain: ${manifest.exposure.baseDomain ?? 'n/a'}`,
      `shared host: ${manifest.exposure.inlineSelector.sharedHost}`,
      `selector field: ${manifest.exposure.inlineSelector.selectorField}`,
      `guaranteed syntax: ${manifest.exposure.inlineSelector.syntax.guaranteed}`,
      `best-effort syntax: ${manifest.exposure.inlineSelector.syntax.bestEffort}`,
      `restart needed: ${manifest.exposure.runtimeStatus.restartRequired ? 'yes' : 'no'}`,
      'selector examples:',
      ...manifest.exposure.inlineSelector.examples.flatMap((example, index) => [
        `${index + 1}. ${example.targetLabel}`,
        `   selector: ${example.selector}`,
        `   guaranteed: ${redactInlineSelectorUrl(example.guaranteedUrl)}`,
        `   best-effort: ${example.bestEffortUrl}`,
      ]),
      'warnings:',
      ...(manifest.exposure.warnings.length > 0
        ? manifest.exposure.warnings.map((warning) => `- ${warning.severity}: ${warning.message}`)
        : ['- none']),
    ];
  }

  return [
    `mode: ${manifest.exposure.mode}`,
    `base domain: ${manifest.exposure.baseDomain ?? 'n/a'}`,
    `restart needed: ${manifest.exposure.runtimeStatus.restartRequired ? 'yes' : 'no'}`,
    ...manifest.exposure.routes.flatMap((route) => [
      `${route.index + 1}. ${route.hostname} -> ${route.bindIp}`,
      `   alias: ${route.alias}`,
      `   dns: ${route.dnsRecord ?? 'not required; use direct bind IP entrypoints'}`,
      ...route.endpoints.flatMap((endpoint) => [
        `   ${endpoint.protocol} hostname: ${endpoint.redactedHostnameUrl}`,
        `   ${endpoint.protocol} direct ip: ${endpoint.redactedBindUrl}`,
      ]),
    ]),
    'warnings:',
    ...(manifest.exposure.warnings.length > 0
      ? manifest.exposure.warnings.map((warning) => `- ${warning.severity}: ${warning.message}`)
      : ['- none']),
  ];
}

function redactInlineSelectorUrl(url: string): string {
  return url.replace(/:\/\/([^:@]+):@/, '://$1:[redacted]@');
}

function writeStartResult(
  result: StartFlowResult,
  dependencies: Pick<StartCommandDependencies, 'stdout' | 'stderr'>,
): void {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  if (result.ok) {
    writeCliReport({ sink: stdout, text: result.summary, tone: 'success' });
    return;
  }

  const lines = [
    'Mullgate start failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    ...(result.attemptedAt ? [`attempted at: ${result.attemptedAt}`] : []),
    ...(result.code ? [`code: ${result.code}`] : []),
    ...(result.routeId ? [`route id: ${result.routeId}`] : []),
    ...(result.routeHostname ? [`route hostname: ${result.routeHostname}`] : []),
    ...(result.routeBindIp ? [`route bind ip: ${result.routeBindIp}`] : []),
    ...(result.serviceName ? [`service: ${result.serviceName}`] : []),
    ...(result.artifactPath ? [`artifact: ${result.artifactPath}`] : []),
    ...(result.composeFilePath ? [`docker compose: ${result.composeFilePath}`] : []),
    ...(result.command ? [`command: ${result.command}`] : []),
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
    `config: ${result.paths.configFile}`,
    ...(result.validationSource ? [`validation: ${result.validationSource}`] : []),
    ...(result.report ? [`start report: ${result.paths.runtimeStartDiagnosticsFile}`] : []),
    ...(result.config ? [`runtime status: ${result.config.runtime.status.phase}`] : []),
  ];

  writeCliReport({ sink: stderr, text: lines.join('\n'), tone: 'error' });
}

function synchronizeRuntimePaths(config: MullgateConfig, paths: MullgatePaths): MullgateConfig {
  return {
    ...config,
    runtime: {
      ...config.runtime,
      sourceConfigPath: paths.configFile,
      entryWireproxyConfigPath: paths.entryWireproxyConfigFile,
      routeProxyConfigPath: paths.routeProxyConfigFile,
      validationReportPath: paths.runtimeValidationReportFile,
      relayCachePath: paths.provisioningCacheFile,
      dockerComposePath: paths.runtimeComposeFile,
      runtimeBundle: {
        bundleDir: paths.runtimeBundleDir,
        dockerComposePath: paths.runtimeComposeFile,
        httpsSidecarConfigPath: paths.runtimeHttpsSidecarConfigFile,
        manifestPath: paths.runtimeBundleManifestFile,
      },
    },
    diagnostics: {
      ...config.diagnostics,
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
    },
  };
}

function withStartOutcome(
  config: MullgateConfig,
  report: RuntimeStartDiagnostic,
  phase: MullgateConfig['runtime']['status']['phase'],
  checkedAt: string,
  message: string,
): MullgateConfig {
  const updated = withRuntimeStatus(config, phase, checkedAt, message);

  return {
    ...updated,
    diagnostics: {
      ...updated.diagnostics,
      lastRuntimeStart: report,
    },
  };
}

async function validateRenderedRuntime(
  input: {
    readonly config: MullgateConfig;
    readonly renderResult: Awaited<ReturnType<typeof renderRuntimeProxyArtifacts>> & { ok: true };
    readonly bind: MullgateConfig['setup']['bind'];
    readonly reportPath: string;
  },
  checkedAt: string,
  validateOptions?: StartCommandDependencies['validateOptions'],
): Promise<RouteValidationSuccess | RouteValidationFailure> {
  const result = await validateRuntimeArtifacts({
    entryWireproxyConfigPath: input.renderResult.artifactPaths.entryWireproxyConfigPath,
    entryWireproxyConfigText: input.renderResult.entryWireproxyConfig,
    routeProxyConfigPath: input.renderResult.artifactPaths.routeProxyConfigPath,
    routeProxyConfigText: input.renderResult.routeProxyConfig,
    routes: input.renderResult.routes,
    inlineSelectors: input.renderResult.inlineSelectors,
    accessMode: input.renderResult.accessMode,
    exposureMode: input.config.setup.exposure.mode,
    bindHost: input.config.setup.bind.host,
    bind: {
      socksPort: input.bind.socksPort,
      httpPort: input.bind.httpPort,
    },
    reportPath: input.reportPath,
    checkedAt,
    ...validateOptions,
  });
  const validationSource = summarizeValidationSource(result);

  if (!result.ok) {
    const failingRoute =
      result.artifact === 'route-proxy'
        ? (input.renderResult.routes.find((route) => result.cause.includes(route.routeId)) ?? null)
        : null;

    return {
      ok: false,
      phase: result.phase,
      source: result.source,
      message: 'Rendered runtime artifacts failed validation before Docker launch.',
      cause: result.cause,
      artifactPath: result.target,
      validationSource,
      routeId: failingRoute?.routeId ?? null,
      routeHostname: failingRoute?.routeHostname ?? null,
      routeBindIp: failingRoute?.routeBindIp ?? null,
      serviceName:
        result.artifact === 'entry-wireproxy' ? ENTRY_TUNNEL_SERVICE : ROUTE_PROXY_SERVICE,
      reportPath: result.reportPath ?? input.reportPath,
    };
  }

  return {
    ok: true,
    validationSource,
    reportPath: result.reportPath ?? input.reportPath,
  };
}

function inferRouteDiagnosticContext(
  config: MullgateConfig,
  manifest: RuntimeBundleManifest,
  values: readonly (string | null | undefined)[],
): RouteDiagnosticContext {
  // Compose launch errors often surface only the failing service name or mounted route config path, so match those
  // strings back to the rendered manifest before persisting last-start.json/stderr.
  const haystack = values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');

  const matches = manifest.routes.filter((route) => {
    if (!haystack) {
      return false;
    }

    return [
      route.routeId,
      route.hostname,
      route.bindIp,
      route.listeners.socks5,
      route.listeners.http,
      route.listeners.https,
      route.services.backends.https,
    ].some((candidate) => typeof candidate === 'string' && haystack.includes(candidate));
  });

  const selected =
    matches.length === 1
      ? matches[0]
      : matches.length === 0 && config.routing.locations.length === 1
        ? manifest.routes[0]
        : null;

  if (!selected) {
    if (
      [
        ENTRY_TUNNEL_SERVICE,
        manifest.services.entryTunnel.mountPaths.entryWireproxyConfigPath,
        manifest.services.entryTunnel.internalListeners.socks5,
        manifest.services.entryTunnel.internalListeners.http,
      ].some((candidate) => haystack.includes(candidate))
    ) {
      return { serviceName: ENTRY_TUNNEL_SERVICE };
    }

    if (
      [ROUTE_PROXY_SERVICE, manifest.services.routeProxy.mountPaths.routeProxyConfigPath].some(
        (candidate) => haystack.includes(candidate),
      )
    ) {
      return { serviceName: ROUTE_PROXY_SERVICE };
    }

    if (haystack.includes('routing-layer')) {
      return { serviceName: 'routing-layer' };
    }

    return {};
  }

  const serviceName = haystack.includes('routing-layer') ? 'routing-layer' : ROUTE_PROXY_SERVICE;

  return {
    routeId: selected.routeId,
    routeHostname: selected.hostname,
    routeBindIp: selected.bindIp,
    serviceName,
  };
}

async function persistFailureOutcome(input: {
  readonly store: ConfigStore;
  readonly config: MullgateConfig;
  readonly attemptedAt: string;
  readonly phase: StartFailure['phase'];
  readonly source: string;
  readonly message: string;
  readonly cause?: string;
  readonly code?: string | null;
  readonly artifactPath?: string;
  readonly command?: string | null;
  readonly composeFilePath?: string | null;
  readonly validationSource?: ValidationSourceSummary | null;
  readonly routeId?: string | null;
  readonly routeHostname?: string | null;
  readonly routeBindIp?: string | null;
  readonly serviceName?: string | null;
}): Promise<StartFailure> {
  const report = createRuntimeStartDiagnostic({
    attemptedAt: input.attemptedAt,
    status: 'failure',
    phase: input.phase,
    source: input.source,
    code: input.code ?? null,
    message: input.message,
    cause: input.cause,
    artifactPath: input.artifactPath,
    command: input.command ?? null,
    composeFilePath: input.composeFilePath ?? null,
    validationSource: input.validationSource ?? null,
    routeId: input.routeId ?? null,
    routeHostname: input.routeHostname ?? null,
    routeBindIp: input.routeBindIp ?? null,
    serviceName: input.serviceName ?? null,
  });
  const failedConfig = withStartOutcome(
    input.config,
    report,
    'error',
    input.attemptedAt,
    report.message,
  );
  const persistResult = await persistStartOutcome(input.store, failedConfig, report);

  if (!persistResult.ok) {
    return persistResult;
  }

  return {
    ok: false,
    exitCode: 1,
    phase: input.phase,
    source: input.source,
    paths: input.store.paths,
    attemptedAt: input.attemptedAt,
    message: report.message,
    ...(report.cause ? { cause: report.cause } : {}),
    ...(report.code ? { code: report.code } : {}),
    ...(report.artifactPath ? { artifactPath: report.artifactPath } : {}),
    ...(report.command ? { command: report.command } : {}),
    ...(report.composeFilePath ? { composeFilePath: report.composeFilePath } : {}),
    ...(report.validationSource ? { validationSource: report.validationSource } : {}),
    ...(report.routeId ? { routeId: report.routeId } : {}),
    ...(report.routeHostname ? { routeHostname: report.routeHostname } : {}),
    ...(report.routeBindIp ? { routeBindIp: report.routeBindIp } : {}),
    ...(report.serviceName ? { serviceName: report.serviceName } : {}),
    config: failedConfig,
    report,
  };
}

async function persistStartOutcome(
  store: ConfigStore,
  config: MullgateConfig,
  report: RuntimeStartDiagnostic,
): Promise<{ ok: true } | StartFailure> {
  try {
    await Promise.all([
      store.save(config),
      persistStartReport(store.paths.runtimeStartDiagnosticsFile, report),
    ]);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      phase: 'persist-config',
      source: 'filesystem',
      paths: store.paths,
      attemptedAt: report.attemptedAt,
      artifactPath: store.paths.runtimeStartDiagnosticsFile,
      message: 'Failed to persist the Mullgate runtime start diagnostics.',
      cause: error instanceof Error ? error.message : String(error),
      config,
      report,
      composeFilePath: report.composeFilePath,
      validationSource: report.validationSource,
      routeId: report.routeId,
      routeHostname: report.routeHostname,
      routeBindIp: report.routeBindIp,
      serviceName: report.serviceName,
    };
  }
}

async function persistConfigOnly(
  store: ConfigStore,
  config: MullgateConfig,
): Promise<{ ok: true } | StartFailure> {
  try {
    await store.save(config);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      phase: 'persist-config',
      source: 'filesystem',
      paths: store.paths,
      message: 'Failed to persist the updated Mullgate runtime status.',
      artifactPath: store.paths.configFile,
      cause: error instanceof Error ? error.message : String(error),
      config,
      ...(config.diagnostics.lastRuntimeStart
        ? { report: config.diagnostics.lastRuntimeStart }
        : {}),
    };
  }
}

async function persistStartReport(
  reportPath: string,
  report: RuntimeStartDiagnostic,
): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function createRuntimeStartDiagnostic(input: {
  readonly attemptedAt: string;
  readonly status: RuntimeStartDiagnostic['status'];
  readonly phase: string;
  readonly source: string;
  readonly code?: string | null;
  readonly message: string;
  readonly cause?: string;
  readonly artifactPath?: string;
  readonly command?: string | null;
  readonly composeFilePath?: string | null;
  readonly validationSource?: ValidationSourceSummary | null;
  readonly routeId?: string | null;
  readonly routeHostname?: string | null;
  readonly routeBindIp?: string | null;
  readonly serviceName?: string | null;
}): RuntimeStartDiagnostic {
  return {
    attemptedAt: input.attemptedAt,
    status: input.status,
    phase: input.phase,
    source: input.source,
    code: input.code ?? null,
    message: input.message,
    cause: input.cause ?? null,
    artifactPath: input.artifactPath ?? null,
    composeFilePath: input.composeFilePath ?? null,
    validationSource: input.validationSource ?? null,
    routeId: input.routeId ?? null,
    routeHostname: input.routeHostname ?? null,
    routeBindIp: input.routeBindIp ?? null,
    serviceName: input.serviceName ?? null,
    command: input.command ?? null,
  };
}
