import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';

import {
  loadStoredRelayCatalog,
  summarizeValidationSource,
  verifyHttpsAssets,
  withRuntimeStatus,
} from '../app/setup-runner.js';
import type { MullgatePaths } from '../config/paths.js';
import { redactSensitiveText } from '../config/redact.js';
import { ConfigStore } from '../config/store.js';
import type { MullgateConfig, RuntimeStartDiagnostic } from '../config/schema.js';
import { startDockerRuntime, type DockerRuntimeResult, type StartDockerRuntimeOptions } from '../runtime/docker-runtime.js';
import { renderRuntimeBundle, type RuntimeBundleManifest } from '../runtime/render-runtime-bundle.js';
import { renderWireproxyArtifacts, type RenderedWireproxyRoute } from '../runtime/render-wireproxy.js';
import { validateWireproxyConfig, type ValidateWireproxyOptions } from '../runtime/validate-wireproxy.js';

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
  readonly routeId: string;
  readonly routeHostname: string;
  readonly routeBindIp: string;
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
  readonly validateOptions?: Pick<ValidateWireproxyOptions, 'wireproxyBinary' | 'dockerBinary' | 'dockerImage' | 'spawn'>;
  readonly stdout?: WritableTextSink;
  readonly stderr?: WritableTextSink;
};

export function registerStartCommand(program: Command, dependencies: StartCommandDependencies = {}): void {
  program
    .command('start')
    .description('Re-render derived runtime artifacts from saved config, validate them, and launch the Docker runtime bundle.')
    .action(createStartCommandAction(dependencies));
}

export function createStartCommandAction(dependencies: StartCommandDependencies = {}): () => Promise<void> {
  return async () => {
    const result = await runStartFlow(dependencies);
    writeStartResult(result, dependencies);
    process.exitCode = result.exitCode;
  };
}

export async function runStartFlow(dependencies: Omit<StartCommandDependencies, 'stdout' | 'stderr'> = {}): Promise<StartFlowResult> {
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

  const wireproxyRender = await renderWireproxyArtifacts({
    config: baseConfig,
    relayCatalog: relayCatalog.value,
    paths: store.paths,
    generatedAt: attemptedAt,
  });

  if (!wireproxyRender.ok) {
    return persistFailureOutcome({
      store,
      config: baseConfig,
      attemptedAt,
      phase: wireproxyRender.phase,
      source: wireproxyRender.source,
      code: wireproxyRender.code,
      message: wireproxyRender.message,
      cause: wireproxyRender.cause,
      artifactPath: wireproxyRender.artifactPath,
      composeFilePath: store.paths.runtimeComposeFile,
      routeId: wireproxyRender.routeId,
      routeHostname: wireproxyRender.routeHostname,
      routeBindIp: wireproxyRender.routeBindIp,
      serviceName: wireproxyRender.serviceName,
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

  const validationResult = await validateRenderedRoutes(wireproxyRender.routes, attemptedAt, dependencies.validateOptions);

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
    `Validated ${wireproxyRender.routes.length} route configs via ${validationResult.validationSource}; launching Docker Compose from ${runtimeBundle.artifactPaths.dockerComposePath}.`,
  );
  const startingPersist = await persistConfigOnly(store, startingConfig);

  if (!startingPersist.ok) {
    return startingPersist;
  }

  const runtimeResult = await startRuntime({
    composeFilePath: runtimeBundle.artifactPaths.dockerComposePath,
    checkedAt: attemptedAt,
    ...(dependencies.validateOptions?.dockerBinary ? { dockerBinary: dependencies.validateOptions.dockerBinary } : {}),
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
    config: startingConfig,
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

  return {
    ok: true,
    phase: 'compose-launch',
    source: 'docker-compose',
    exitCode: 0,
    paths: store.paths,
    config: successConfig,
    report,
    validationSource: validationResult.validationSource,
    composeFilePath: runtimeBundle.artifactPaths.dockerComposePath,
    manifestPath: runtimeBundle.artifactPaths.manifestPath,
    validationReportPath: validationResult.reportPath,
    summary: [
      'Mullgate runtime started.',
      'phase: compose-launch',
      'source: docker-compose',
      `attempted at: ${report.attemptedAt}`,
      `routes: ${wireproxyRender.routes.length}`,
      `config: ${store.paths.configFile}`,
      `primary wireproxy config: ${wireproxyRender.artifactPaths.wireproxyConfigPath}`,
      `relay cache: ${wireproxyRender.artifactPaths.relayCachePath}`,
      `docker compose: ${runtimeBundle.artifactPaths.dockerComposePath}`,
      `runtime manifest: ${runtimeBundle.artifactPaths.manifestPath}`,
      `validation report: ${validationResult.reportPath}`,
      `validation: ${validationResult.validationSource}`,
      'runtime status: running',
    ].join('\n'),
  };
}

function writeStartResult(result: StartFlowResult, dependencies: Pick<StartCommandDependencies, 'stdout' | 'stderr'>): void {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  if (result.ok) {
    stdout.write(`${result.summary}\n`);
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

  stderr.write(`${lines.join('\n')}\n`);
}

function synchronizeRuntimePaths(config: MullgateConfig, paths: MullgatePaths): MullgateConfig {
  return {
    ...config,
    runtime: {
      ...config.runtime,
      sourceConfigPath: paths.configFile,
      wireproxyConfigPath: paths.wireproxyConfigFile,
      wireproxyConfigTestReportPath: paths.wireproxyConfigTestReportFile,
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

async function validateRenderedRoutes(
  routes: readonly RenderedWireproxyRoute[],
  checkedAt: string,
  validateOptions?: StartCommandDependencies['validateOptions'],
): Promise<RouteValidationSuccess | RouteValidationFailure> {
  const validationSources: string[] = [];
  let primaryReportPath = routes[0]!.artifactPaths.configTestReportPath;

  for (const route of routes) {
    const result = await validateWireproxyConfig({
      configPath: route.artifactPaths.wireproxyConfigPath,
      configText: route.wireproxyConfig,
      reportPath: route.artifactPaths.configTestReportPath,
      checkedAt,
      ...validateOptions,
    });
    const validationSource = summarizeValidationSource(result);

    if (!result.ok) {
      return {
        ok: false,
        phase: result.phase,
        source: result.source,
        message: 'Rendered wireproxy config failed validation before Docker launch.',
        cause: result.cause,
        artifactPath: result.target,
        validationSource,
        routeId: route.routeId,
        routeHostname: route.routeHostname,
        routeBindIp: route.routeBindIp,
        serviceName: route.serviceName,
        reportPath: result.reportPath ?? route.artifactPaths.configTestReportPath,
      };
    }

    primaryReportPath = result.reportPath ?? route.artifactPaths.configTestReportPath;
    validationSources.push(validationSource);
  }

  return {
    ok: true,
    validationSource: summarizeValidationSources(validationSources, routes.length),
    reportPath: primaryReportPath,
  };
}

function summarizeValidationSources(sources: readonly string[], routeCount: number): string {
  const uniqueSources = [...new Set(sources)];
  const sourceSummary = uniqueSources.length === 1 ? uniqueSources[0]! : uniqueSources.join(', ');
  return routeCount === 1 ? sourceSummary : `${sourceSummary} (${routeCount} routes)`;
}

function inferRouteDiagnosticContext(
  config: MullgateConfig,
  manifest: RuntimeBundleManifest,
  values: readonly (string | null | undefined)[],
): RouteDiagnosticContext {
  // Compose launch errors often surface only the failing service name or mounted route config path, so match those
  // strings back to the rendered manifest before persisting last-start.json/stderr.
  const haystack = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n');

  const matches = manifest.routes.filter((route) => {
    if (!haystack) {
      return false;
    }

    return [
      route.routeId,
      route.hostname,
      route.bindIp,
      route.services.wireproxy.name,
      route.services.backends.socks5,
      route.services.backends.http,
      route.services.backends.https,
      route.wireproxyConfigPath,
    ].some((candidate) => typeof candidate === 'string' && haystack.includes(candidate));
  });

  const selected = matches.length === 1 ? matches[0] : matches.length === 0 && config.routing.locations.length === 1 ? manifest.routes[0] : null;

  if (!selected) {
    return {};
  }

  return {
    routeId: selected.routeId,
    routeHostname: selected.hostname,
    routeBindIp: selected.bindIp,
    serviceName: selected.services.wireproxy.name,
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
    config: input.config,
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
  const failedConfig = withStartOutcome(input.config, report, 'error', input.attemptedAt, report.message);
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
    await Promise.all([store.save(config), persistStartReport(store.paths.runtimeStartDiagnosticsFile, report)]);
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
      cause: error instanceof Error ? redactSensitiveText(error.message, config) : String(error),
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

async function persistConfigOnly(store: ConfigStore, config: MullgateConfig): Promise<{ ok: true } | StartFailure> {
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
      cause: error instanceof Error ? redactSensitiveText(error.message, config) : String(error),
      config,
      ...(config.diagnostics.lastRuntimeStart ? { report: config.diagnostics.lastRuntimeStart } : {}),
    };
  }
}

async function persistStartReport(reportPath: string, report: RuntimeStartDiagnostic): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function createRuntimeStartDiagnostic(input: {
  readonly config: MullgateConfig;
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
    message: redactSensitiveText(input.message, input.config),
    cause: input.cause ? redactSensitiveText(input.cause, input.config) : null,
    artifactPath: input.artifactPath ?? null,
    composeFilePath: input.composeFilePath ?? null,
    validationSource: input.validationSource ?? null,
    routeId: input.routeId ?? null,
    routeHostname: input.routeHostname ?? null,
    routeBindIp: input.routeBindIp ?? null,
    serviceName: input.serviceName ?? null,
    command: input.command ? redactSensitiveText(input.command, input.config) : null,
  };
}
