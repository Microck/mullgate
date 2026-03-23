import { lookup } from 'node:dns/promises';
import { access } from 'node:fs/promises';
import { isIP } from 'node:net';

import type { Command } from 'commander';

import { loadStoredRelayCatalog } from '../app/setup-runner.js';
import {
  buildExposureContract,
  deriveLoopbackBindIp,
  type ExposureContract,
  validateExposureSettings,
} from '../config/exposure-contract.js';
import { resolveRouteWireproxyPaths } from '../config/paths.js';
import { redactSensitiveText } from '../config/redact.js';
import type { MullgateConfig, RuntimeStartDiagnostic } from '../config/schema.js';
import { ConfigStore, type LoadConfigResult } from '../config/store.js';
import {
  buildPlatformSupportContract,
  type PlatformSupportContract,
} from '../platform/support-contract.js';
import {
  type DockerComposeStatusResult,
  type QueryDockerComposeStatusOptions,
  queryDockerComposeStatus,
} from '../runtime/docker-runtime.js';
import type { RuntimeBundleManifest } from '../runtime/render-runtime-bundle.js';
import type { ValidateWireproxyResult } from '../runtime/validate-wireproxy.js';
import {
  type ArtifactReadResult,
  classifyContainerState,
  findContainerForService,
  formatArtifactPresence,
  readJsonArtifact,
  renderComposeRemediation,
  resolveLastStartDiagnostic,
} from './runtime-diagnostics.js';

const ROUTING_LAYER_SERVICE = 'routing-layer';
const RELAY_CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

type WritableTextSink = {
  write(chunk: string): unknown;
};

type DoctorOutcome = 'pass' | 'degraded' | 'fail';

type DoctorCheck = {
  readonly name: string;
  readonly outcome: DoctorOutcome;
  readonly summary: string;
  readonly details: readonly string[];
  readonly remediation?: string;
};

type DoctorFlowResult = {
  readonly ok: boolean;
  readonly exitCode: 0 | 1;
  readonly overall: DoctorOutcome;
  readonly summary: string;
};

type DoctorCommandDependencies = {
  readonly store?: ConfigStore;
  readonly checkedAt?: string;
  readonly inspectRuntime?: (
    options: QueryDockerComposeStatusOptions,
  ) => Promise<DockerComposeStatusResult>;
  readonly resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  readonly stdout?: WritableTextSink;
  readonly stderr?: WritableTextSink;
};

type RouteArtifactTarget = {
  readonly routeId: string;
  readonly alias: string;
  readonly hostname: string;
  readonly bindIp: string;
  readonly serviceName: string;
  readonly reportPath: string;
};

type RouteValidationReport = RouteArtifactTarget & {
  readonly result: ArtifactReadResult<ValidateWireproxyResult>;
};

type FailedValidationReport = RouteValidationReport & {
  readonly result: {
    readonly kind: 'present';
    readonly value: Extract<ValidateWireproxyResult, { ok: false }>;
  };
};

type SuccessfulValidationReport = RouteValidationReport & {
  readonly result: {
    readonly kind: 'present';
    readonly value: Extract<ValidateWireproxyResult, { ok: true }>;
  };
};

type InvalidValidationReport = RouteValidationReport & {
  readonly result: {
    readonly kind: 'invalid';
    readonly reason: string;
  };
};

export function registerDoctorCommand(
  program: Command,
  dependencies: DoctorCommandDependencies = {},
): void {
  program
    .command('doctor')
    .description(
      'Run deterministic, route-aware diagnostics for config, runtime, bind, DNS, and last-start failures.',
    )
    .action(createDoctorCommandAction(dependencies));
}

export function createDoctorCommandAction(
  dependencies: DoctorCommandDependencies = {},
): () => Promise<void> {
  return async () => {
    const result = await runDoctorFlow(dependencies);
    writeDoctorResult(result, dependencies);
    process.exitCode = result.exitCode;
  };
}

export async function runDoctorFlow(
  dependencies: Omit<DoctorCommandDependencies, 'stdout' | 'stderr'> = {},
): Promise<DoctorFlowResult> {
  const store = dependencies.store ?? new ConfigStore();
  const checkedAt = dependencies.checkedAt ?? new Date().toISOString();
  const loadResult = await store.load();

  if (!loadResult.ok) {
    return renderLoadFailure(store, loadResult, checkedAt);
  }

  if (loadResult.source === 'empty') {
    return renderUnconfiguredFailure(store, loadResult.message, checkedAt);
  }

  const config = loadResult.config;
  const inspectRuntime = dependencies.inspectRuntime ?? queryDockerComposeStatus;
  const resolveHostname = dependencies.resolveHostname ?? defaultResolveHostname;
  const manifestPath = config.runtime.runtimeBundle.manifestPath;
  const lastStartReportPath = config.diagnostics.lastRuntimeStartReportPath;

  const [
    manifestResultRaw,
    lastStartResultRaw,
    composeStatus,
    relayCacheResult,
    primaryWireproxyExists,
  ] = await Promise.all([
    readJsonArtifact<RuntimeBundleManifest>(manifestPath),
    readJsonArtifact<RuntimeStartDiagnostic>(lastStartReportPath),
    inspectRuntime({
      composeFilePath: config.runtime.runtimeBundle.dockerComposePath,
      ...(dependencies.checkedAt ? { checkedAt: dependencies.checkedAt } : {}),
    }),
    loadStoredRelayCatalog(config.runtime.relayCachePath),
    fileExists(config.runtime.wireproxyConfigPath),
  ]);

  const manifestResult = normalizeManifestResult(manifestResultRaw);
  const lastStartResult = normalizeLastStartResult(lastStartResultRaw);
  const manifest = manifestResult.kind === 'present' ? manifestResult.value : null;
  const exposure = manifest?.exposure ?? buildExposureContract(config);
  const platform = manifest?.platform ?? buildPlatformSupportContract({ paths: store.paths });
  const lastStart = resolveLastStartDiagnostic(config, lastStartResult);
  const routeTargets = buildRouteArtifactTargets(config, manifest);
  const routeValidationReports = await Promise.all(
    routeTargets.map(async (target) => ({
      ...target,
      result: normalizeValidationReportResult(
        await readJsonArtifact<ValidateWireproxyResult>(target.reportPath),
      ),
    })),
  );

  const checks = await Promise.all([
    Promise.resolve(buildConfigCheck(config, store.paths.configFile)),
    Promise.resolve(buildPlatformCheck(platform)),
    Promise.resolve(buildValidationCheck(config, primaryWireproxyExists, routeValidationReports)),
    Promise.resolve(
      buildRelayCacheCheck(config.runtime.relayCachePath, relayCacheResult, checkedAt),
    ),
    Promise.resolve(buildExposureCheck(config, exposure)),
    Promise.resolve(buildBindCheck(config)),
    buildHostnameCheck(config, exposure, resolveHostname),
    Promise.resolve(buildRuntimeCheck(config, composeStatus, routeTargets, lastStart)),
    Promise.resolve(buildLastStartCheck(lastStartResult, lastStart)),
  ]);

  const overall = summarizeOverallOutcome(checks.map((check) => check.outcome));
  const summary = redactSensitiveText(
    renderDoctorSummary({
      checkedAt,
      overall,
      store,
      config,
      manifestResult,
      lastStartResult,
      checks,
    }),
    config,
  );

  return {
    ok: overall !== 'fail',
    exitCode: overall === 'fail' ? 1 : 0,
    overall,
    summary,
  };
}

function renderLoadFailure(
  store: ConfigStore,
  result: Extract<LoadConfigResult, { ok: false }>,
  checkedAt: string,
): DoctorFlowResult {
  const check: DoctorCheck = {
    name: 'config',
    outcome: 'fail',
    summary: 'Saved Mullgate config could not be read or parsed.',
    details: [
      `phase=${result.phase}`,
      `source=${result.source}`,
      `artifact=${result.artifactPath}`,
      `reason=${result.message}`,
    ],
    remediation:
      'Fix the saved config JSON/schema issue or rerun `mullgate setup` to recreate the canonical config.',
  };

  return {
    ok: false,
    exitCode: 1,
    overall: 'fail',
    summary: renderDoctorFailureSummary({
      checkedAt,
      overall: 'fail',
      store,
      configPath: store.paths.configFile,
      runtimeDir: store.paths.runtimeDir,
      relayCachePath: store.paths.provisioningCacheFile,
      wireproxyConfigPath: store.paths.wireproxyConfigFile,
      manifestPath: store.paths.runtimeBundleManifestFile,
      lastStartReportPath: store.paths.runtimeStartDiagnosticsFile,
      checks: [check],
    }),
  };
}

function renderUnconfiguredFailure(
  store: ConfigStore,
  message: string,
  checkedAt: string,
): DoctorFlowResult {
  const check: DoctorCheck = {
    name: 'config',
    outcome: 'fail',
    summary: 'Mullgate is not configured yet, so doctor cannot inspect runtime or exposure state.',
    details: [message],
    remediation:
      'Run `mullgate setup` first, then rerun `mullgate doctor` once a canonical config exists.',
  };

  return {
    ok: false,
    exitCode: 1,
    overall: 'fail',
    summary: renderDoctorFailureSummary({
      checkedAt,
      overall: 'fail',
      store,
      configPath: store.paths.configFile,
      runtimeDir: store.paths.runtimeDir,
      relayCachePath: store.paths.provisioningCacheFile,
      wireproxyConfigPath: store.paths.wireproxyConfigFile,
      manifestPath: store.paths.runtimeBundleManifestFile,
      lastStartReportPath: store.paths.runtimeStartDiagnosticsFile,
      checks: [check],
    }),
  };
}

function buildConfigCheck(config: MullgateConfig, configPath: string): DoctorCheck {
  return {
    name: 'config',
    outcome: 'pass',
    summary: 'Loaded the canonical Mullgate config successfully.',
    details: [
      `config=${configPath}`,
      `routes=${config.routing.locations.length}`,
      `saved-runtime-phase=${config.runtime.status.phase}`,
      `exposure-mode=${config.setup.exposure.mode}`,
    ],
  };
}

function buildPlatformCheck(platform: PlatformSupportContract): DoctorCheck {
  const details = [
    `platform=${platform.platform}`,
    `platform-source=${platform.platformSource}`,
    `support-level=${platform.posture.supportLevel}`,
    `mode-label=${platform.posture.modeLabel}`,
    `summary=${platform.posture.summary}`,
    `runtime-story=${platform.posture.runtimeStory}`,
    `config-paths=${platform.surfaces.configPaths}`,
    `config-workflow=${platform.surfaces.configWorkflow}`,
    `runtime-artifacts=${platform.surfaces.runtimeArtifacts}`,
    `runtime-execution=${platform.surfaces.runtimeExecution}`,
    `diagnostics=${platform.surfaces.diagnostics}`,
    `host-networking=${platform.hostNetworking.modeLabel}`,
    `host-networking-summary=${platform.hostNetworking.summary}`,
    ...platform.guidance.map((line) => `guidance=${line}`),
    ...platform.warnings.map((warning) => `${warning.severity}: ${warning.message}`),
  ];

  if (platform.posture.supportLevel === 'partial') {
    return {
      name: 'platform-support',
      outcome: 'degraded',
      summary:
        'Current platform keeps truthful config and diagnostic surfaces, but runtime execution remains limited compared with Linux.',
      details,
      remediation: platform.hostNetworking.remediation,
    };
  }

  return {
    name: 'platform-support',
    outcome: 'pass',
    summary: 'Current platform matches the fully supported Linux runtime contract.',
    details,
  };
}

function buildValidationCheck(
  config: MullgateConfig,
  primaryWireproxyExists: boolean,
  routeReports: readonly RouteValidationReport[],
): DoctorCheck {
  const failingReports = routeReports.filter(
    (report): report is FailedValidationReport =>
      report.result.kind === 'present' && report.result.value.ok === false,
  );
  const invalidReports = routeReports.filter(
    (report): report is InvalidValidationReport => report.result.kind === 'invalid',
  );
  const missingReports = routeReports.filter((report) => report.result.kind === 'missing');
  const successfulReports = routeReports.filter(
    (report): report is SuccessfulValidationReport =>
      report.result.kind === 'present' && report.result.value.ok,
  );

  const details = [
    `saved-runtime-phase=${config.runtime.status.phase}`,
    `saved-runtime-message=${config.runtime.status.message ?? 'n/a'}`,
    `wireproxy-config=${config.runtime.wireproxyConfigPath} (${primaryWireproxyExists ? 'present' : 'missing'})`,
    ...successfulReports.map(
      (report) => `report[${report.routeId}]=ok via ${report.result.value.source}`,
    ),
    ...failingReports.map(
      (report) =>
        `report[${report.routeId}]=failure via ${report.result.value.source}: ${report.result.value.cause}`,
    ),
    ...invalidReports.map((report) => `report[${report.routeId}]=invalid: ${report.result.reason}`),
    ...missingReports.map((report) => `report[${report.routeId}]=missing (${report.reportPath})`),
  ];

  if (!primaryWireproxyExists) {
    return {
      name: 'validation-artifacts',
      outcome: 'fail',
      summary: 'The primary wireproxy config artifact is missing from the runtime directory.',
      details,
      remediation:
        'Run `mullgate config validate` or `mullgate start` to regenerate the derived runtime artifacts before trusting the saved runtime state.',
    };
  }

  if (failingReports.length > 0 || config.runtime.status.phase === 'error') {
    return {
      name: 'validation-artifacts',
      outcome: 'fail',
      summary:
        failingReports.length > 0
          ? 'At least one persisted wireproxy validation report recorded a failure.'
          : 'Saved runtime status is `error`, so the current runtime artifacts should not be trusted.',
      details,
      remediation:
        'Fix the reported wireproxy/config issue, then rerun `mullgate config validate` or `mullgate start` to refresh the runtime artifacts.',
    };
  }

  if (invalidReports.length > 0) {
    return {
      name: 'validation-artifacts',
      outcome: 'fail',
      summary:
        'At least one persisted validation report could not be parsed back into the expected shape.',
      details,
      remediation:
        'Delete the broken validation report and rerun `mullgate config validate` so doctor can trust the persisted validation surface again.',
    };
  }

  if (config.runtime.status.phase === 'unvalidated') {
    return {
      name: 'validation-artifacts',
      outcome: 'degraded',
      summary:
        'Saved config is marked `unvalidated`, so runtime artifacts may lag behind recent config or exposure edits.',
      details,
      remediation:
        'Run `mullgate config validate` or `mullgate start` to regenerate wireproxy artifacts and capture a fresh validation report.',
    };
  }

  if (missingReports.length > 0) {
    return {
      name: 'validation-artifacts',
      outcome: 'degraded',
      summary:
        'One or more per-route validation reports are missing, so doctor cannot fully prove the rendered wireproxy configs are still in sync.',
      details,
      remediation:
        'Rerun `mullgate config validate` to recreate the missing configtest reports before relying on the saved validation metadata.',
    };
  }

  return {
    name: 'validation-artifacts',
    outcome: 'pass',
    summary: 'Wireproxy config artifacts and persisted validation reports are present.',
    details,
  };
}

function buildRelayCacheCheck(
  relayCachePath: string,
  relayCacheResult: Awaited<ReturnType<typeof loadStoredRelayCatalog>>,
  checkedAt: string,
): DoctorCheck {
  if (!relayCacheResult.ok) {
    return {
      name: 'relay-cache',
      outcome: 'fail',
      summary: 'Saved Mullvad relay metadata could not be loaded.',
      details: [
        `relay-cache=${relayCachePath}`,
        `reason=${relayCacheResult.message}`,
        ...(relayCacheResult.cause ? [`cause=${relayCacheResult.cause}`] : []),
      ],
      remediation:
        'Refresh the saved relay catalog with a fresh `mullgate setup` run, then rerun `mullgate config validate` or `mullgate start` to rebuild derived artifacts.',
    };
  }

  const fetchedAt = Date.parse(relayCacheResult.value.fetchedAt);
  const ageMs = Number.isFinite(fetchedAt) ? Math.max(0, Date.parse(checkedAt) - fetchedAt) : null;
  const details = [
    `relay-cache=${relayCachePath}`,
    `source=${relayCacheResult.value.source}`,
    `endpoint=${relayCacheResult.value.endpoint}`,
    `fetched-at=${relayCacheResult.value.fetchedAt}`,
    `relay-count=${relayCacheResult.value.relayCount}`,
    ...(ageMs === null ? ['age=invalid timestamp'] : [`age=${formatAge(ageMs)}`]),
  ];

  if (ageMs === null) {
    return {
      name: 'relay-cache',
      outcome: 'degraded',
      summary:
        'Saved relay metadata has an unreadable timestamp, so doctor cannot judge freshness confidently.',
      details,
      remediation:
        'Refresh the relay cache with a fresh `mullgate setup` run before trusting location or relay selection diagnostics.',
    };
  }

  if (ageMs > RELAY_CACHE_STALE_MS) {
    return {
      name: 'relay-cache',
      outcome: 'degraded',
      summary:
        'Saved relay metadata is stale, so location and relay-selection diagnostics may lag behind Mullvad’s current catalog.',
      details,
      remediation:
        'Refresh the saved relay catalog with `mullgate setup`, then rerun `mullgate config validate` or `mullgate start` so runtime artifacts use the fresh relay data.',
    };
  }

  return {
    name: 'relay-cache',
    outcome: 'pass',
    summary: 'Saved Mullvad relay metadata is readable and fresh enough for offline diagnostics.',
    details,
  };
}

function buildExposureCheck(config: MullgateConfig, exposure: ExposureContract): DoctorCheck {
  const hasWarningSeverity = exposure.warnings.some((warning) => warning.severity === 'warning');
  const expectedAllowLan = config.setup.exposure.mode !== 'loopback';
  const allowLanMismatch = config.setup.exposure.allowLan !== expectedAllowLan;
  const details = [
    `mode=${exposure.mode}`,
    `mode-label=${exposure.posture.modeLabel}`,
    `recommendation=${exposure.posture.recommendation}`,
    `posture-summary=${exposure.posture.summary}`,
    `remote-story=${exposure.posture.remoteStory}`,
    `base-domain=${exposure.baseDomain ?? 'n/a'}`,
    `allow-lan=${exposure.allowLan ? 'yes' : 'no'}`,
    `dns-records=${exposure.dnsRecords.length}`,
    `routes=${exposure.routes.length}`,
    `bind-remediation=${exposure.remediation.bindPosture}`,
    `hostname-remediation=${exposure.remediation.hostnameResolution}`,
    `restart-remediation=${exposure.remediation.restart}`,
    ...exposure.warnings.map((warning) => `${warning.severity}: ${warning.message}`),
  ];

  if (allowLanMismatch) {
    return {
      name: 'exposure-contract',
      outcome: 'degraded',
      summary: 'Saved exposure flags disagree with the configured exposure mode.',
      details,
      remediation:
        'Re-save the exposure contract with `mullgate config exposure ...` so allow-lan and the saved network-mode posture stay aligned.',
    };
  }

  if (hasWarningSeverity) {
    return {
      name: 'exposure-contract',
      outcome: 'degraded',
      summary:
        'Saved exposure contract includes warning-level posture guidance that operators should resolve or consciously accept.',
      details,
      remediation: exposure.remediation.bindPosture,
    };
  }

  return {
    name: 'exposure-contract',
    outcome: 'pass',
    summary: 'Saved exposure contract is internally coherent.',
    details,
  };
}

function buildBindCheck(config: MullgateConfig): DoctorCheck {
  const routeBindIps = config.routing.locations.map((location) => location.bindIp);
  const details = [
    `setup.bind.host=${config.setup.bind.host}`,
    ...config.routing.locations.map(
      (location, index) =>
        `route[${index + 1}] ${location.runtime.routeId} bind-ip=${location.bindIp}`,
    ),
  ];
  const issues: string[] = [];

  if (config.setup.bind.host !== config.routing.locations[0]?.bindIp) {
    issues.push(
      `Primary bind host ${config.setup.bind.host} does not match route ${config.routing.locations[0]?.runtime.routeId} bind IP ${config.routing.locations[0]?.bindIp}.`,
    );
  }

  if (config.setup.exposure.mode === 'loopback') {
    for (const [index, location] of config.routing.locations.entries()) {
      const expected = deriveLoopbackBindIp(index);
      if (location.bindIp !== expected) {
        issues.push(
          `Route ${location.runtime.routeId} should use loopback bind IP ${expected}, but saved config has ${location.bindIp}.`,
        );
      }
    }
  } else {
    const validation = validateExposureSettings({
      routeCount: config.routing.locations.length,
      exposureMode: config.setup.exposure.mode,
      exposureBaseDomain: config.setup.exposure.baseDomain,
      routeBindIps,
      artifactPath: config.runtime.sourceConfigPath,
      caller: 'config-exposure',
    });

    if (!validation.ok) {
      issues.push(validation.message);
      if (validation.cause) {
        issues.push(validation.cause);
      }
    }
  }

  if (issues.length > 0) {
    return {
      name: 'bind-posture',
      outcome: 'fail',
      summary: 'Saved bind IPs do not satisfy the configured exposure posture.',
      details: [...details, ...issues],
      remediation:
        config.setup.exposure.mode === 'loopback'
          ? 'Rerun `mullgate config exposure --mode loopback` so each route gets the expected loopback bind IPs, then revalidate the runtime artifacts.'
          : 'Use `mullgate config exposure` to correct the route bind IPs for the current exposure mode, then rerun `mullgate config validate` or `mullgate start`.',
    };
  }

  return {
    name: 'bind-posture',
    outcome: 'pass',
    summary: 'Saved bind IPs match the configured exposure posture.',
    details,
  };
}

async function buildHostnameCheck(
  config: MullgateConfig,
  exposure: ExposureContract,
  resolveHostname: (hostname: string) => Promise<readonly string[]>,
): Promise<DoctorCheck> {
  const details: string[] = [];
  const failures: string[] = [];

  for (const route of exposure.routes) {
    if (route.hostname === route.bindIp || isIP(route.hostname) === 4) {
      details.push(
        `route ${route.routeId}: direct bind-IP entrypoint (${route.hostname}) does not require hostname lookup.`,
      );
      continue;
    }

    try {
      const addresses = unique(await resolveHostname(route.hostname));
      details.push(
        `route ${route.routeId}: ${route.hostname} -> ${addresses.length > 0 ? addresses.join(', ') : 'no addresses'}`,
      );

      if (!addresses.includes(route.bindIp)) {
        failures.push(
          `Route ${route.routeId} expects ${route.hostname} to resolve to ${route.bindIp}, but it currently resolves to ${addresses.join(', ') || 'no addresses'}.`,
        );
      }
    } catch (error) {
      failures.push(
        `Route ${route.routeId} could not resolve ${route.hostname}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  if (failures.length > 0) {
    return {
      name: 'hostname-resolution',
      outcome: 'fail',
      summary: 'One or more route hostnames no longer resolve to their saved bind IPs.',
      details: [...details, ...failures],
      remediation: buildHostnameRemediation(config, exposure),
    };
  }

  return {
    name: 'hostname-resolution',
    outcome: 'pass',
    summary:
      'Configured hostnames resolve to the bind IPs promised by the saved exposure contract.',
    details,
  };
}

function buildRuntimeCheck(
  config: MullgateConfig,
  composeStatus: DockerComposeStatusResult,
  routeTargets: readonly RouteArtifactTarget[],
  lastStart: RuntimeStartDiagnostic | null,
): DoctorCheck {
  if (!composeStatus.ok) {
    return {
      name: 'runtime',
      outcome: 'fail',
      summary: composeStatus.message,
      details: [
        `command=${composeStatus.command.rendered}`,
        `code=${composeStatus.code}`,
        ...(composeStatus.cause ? [`cause=${composeStatus.cause}`] : []),
      ],
      remediation: renderComposeRemediation(composeStatus.code),
    };
  }

  const routingLayerState = classifyContainerState(
    findContainerForService(composeStatus.containers, ROUTING_LAYER_SERVICE),
  );
  const routeStates = routeTargets.map((target) => ({
    ...target,
    state: classifyContainerState(
      findContainerForService(composeStatus.containers, target.serviceName),
    ),
  }));
  const unhealthyRoutes = routeStates.filter((route) => route.state.liveState !== 'running');
  const details = [
    `compose-command=${composeStatus.command.rendered}`,
    `containers=${composeStatus.summary.total}`,
    `running=${composeStatus.summary.running}`,
    `starting=${composeStatus.summary.starting}`,
    `stopped=${composeStatus.summary.stopped}`,
    `unhealthy=${composeStatus.summary.unhealthy}`,
    `routing-layer=${routingLayerState.detail}`,
    ...routeStates.map(
      (route) => `route ${route.routeId} (${route.serviceName})=${route.state.detail}`,
    ),
  ];

  if (composeStatus.containers.length === 0) {
    const shouldBeRunning =
      config.runtime.status.phase === 'running' ||
      config.runtime.status.phase === 'error' ||
      lastStart?.status === 'failure';
    return {
      name: 'runtime',
      outcome: shouldBeRunning ? 'fail' : 'degraded',
      summary: shouldBeRunning
        ? 'No live compose containers are running even though saved state implies a recent start or failure investigation.'
        : 'No live compose containers are running right now.',
      details,
      remediation:
        'Run `mullgate start` after fixing any validation, bind, or last-start issues reported above.',
    };
  }

  if (routingLayerState.liveState !== 'running' || unhealthyRoutes.length > 0) {
    return {
      name: 'runtime',
      outcome: 'fail',
      summary:
        'Live Docker Compose state shows one or more expected Mullgate services are stopped or degraded.',
      details,
      remediation:
        'Inspect `docker compose ps` / `docker compose logs` for the named services, fix the failing route or routing layer, then rerun `mullgate start`.',
    };
  }

  return {
    name: 'runtime',
    outcome: 'pass',
    summary:
      'Live Docker Compose status matches the expected Mullgate routing-layer and per-route services.',
    details,
  };
}

function buildLastStartCheck(
  lastStartResult: ArtifactReadResult<RuntimeStartDiagnostic>,
  lastStart: RuntimeStartDiagnostic | null,
): DoctorCheck {
  if (lastStartResult.kind === 'invalid') {
    return {
      name: 'last-start',
      outcome: 'fail',
      summary:
        'The persisted last-start diagnostic report could not be parsed back into the expected shape.',
      details: [`reason=${lastStartResult.reason}`],
      remediation:
        'Delete the broken last-start report and rerun `mullgate start` so doctor can capture a fresh runtime failure context.',
    };
  }

  if (!lastStart) {
    return {
      name: 'last-start',
      outcome: 'degraded',
      summary: 'No persisted last-start diagnostic exists yet.',
      details: [
        'Doctor can still inspect saved config and live runtime state, but there is no persisted start failure/success context yet.',
      ],
      remediation:
        'Run `mullgate start` once to capture a persisted launch report that future doctor runs can inspect.',
    };
  }

  const details = [
    `status=${lastStart.status}`,
    `attempted-at=${lastStart.attemptedAt}`,
    `phase=${lastStart.phase}`,
    `source=${lastStart.source}`,
    `code=${lastStart.code ?? 'n/a'}`,
    ...(lastStart.routeId ? [`route-id=${lastStart.routeId}`] : []),
    ...(lastStart.routeHostname ? [`route-hostname=${lastStart.routeHostname}`] : []),
    ...(lastStart.routeBindIp ? [`route-bind-ip=${lastStart.routeBindIp}`] : []),
    ...(lastStart.serviceName ? [`service=${lastStart.serviceName}`] : []),
    `reason=${lastStart.message}`,
    ...(lastStart.cause ? [`cause=${lastStart.cause}`] : []),
  ];

  if (lastStart.status === 'success') {
    return {
      name: 'last-start',
      outcome: 'pass',
      summary: 'The last recorded `mullgate start` attempt completed successfully.',
      details,
    };
  }

  const authRelated = isAuthRelatedFailure(lastStart);

  return {
    name: 'last-start',
    outcome: 'fail',
    summary: authRelated
      ? 'The last recorded `mullgate start` attempt failed with an auth-related route/runtime error.'
      : 'The last recorded `mullgate start` attempt failed and should be treated as actionable runtime evidence.',
    details,
    remediation: authRelated
      ? buildAuthFailureRemediation(lastStart)
      : buildStartFailureRemediation(lastStart),
  };
}

function buildRouteArtifactTargets(
  config: MullgateConfig,
  manifest: RuntimeBundleManifest | null,
): RouteArtifactTarget[] {
  const manifestRoutes = new Map((manifest?.routes ?? []).map((route) => [route.routeId, route]));

  return config.routing.locations.map((location) => {
    const manifestRoute = manifestRoutes.get(location.runtime.routeId);
    const artifactPaths = resolveRouteWireproxyPaths(
      { runtimeDir: config.runtime.runtimeBundle.bundleDir },
      location.runtime,
    );

    return {
      routeId: location.runtime.routeId,
      alias: location.alias,
      hostname: manifestRoute?.hostname ?? location.hostname,
      bindIp: manifestRoute?.bindIp ?? location.bindIp,
      serviceName: manifestRoute?.services.wireproxy.name ?? location.runtime.wireproxyServiceName,
      reportPath: manifestRoute?.configTestReportPath ?? artifactPaths.configTestReportPath,
    };
  });
}

function summarizeOverallOutcome(outcomes: readonly DoctorOutcome[]): DoctorOutcome {
  if (outcomes.includes('fail')) {
    return 'fail';
  }

  if (outcomes.includes('degraded')) {
    return 'degraded';
  }

  return 'pass';
}

function renderDoctorSummary(input: {
  readonly checkedAt: string;
  readonly overall: DoctorOutcome;
  readonly store: ConfigStore;
  readonly config: MullgateConfig;
  readonly manifestResult: ArtifactReadResult<RuntimeBundleManifest>;
  readonly lastStartResult: ArtifactReadResult<RuntimeStartDiagnostic>;
  readonly checks: readonly DoctorCheck[];
}): string {
  const lines = [
    'Mullgate doctor',
    `overall: ${input.overall}`,
    `checked at: ${input.checkedAt}`,
    'mode: offline-default',
    `config: ${input.store.paths.configFile}`,
    `runtime dir: ${input.store.paths.runtimeDir}`,
    `relay cache: ${input.config.runtime.relayCachePath}`,
    `wireproxy config: ${input.config.runtime.wireproxyConfigPath}`,
    `runtime manifest: ${formatArtifactPresence(input.config.runtime.runtimeBundle.manifestPath, input.manifestResult)}`,
    `last start report: ${formatArtifactPresence(input.config.diagnostics.lastRuntimeStartReportPath, input.lastStartResult)}`,
    '',
    'checks',
  ];

  for (const [index, check] of input.checks.entries()) {
    lines.push(`${index + 1}. ${check.name}: ${check.outcome}`);
    lines.push(`   summary: ${check.summary}`);
    for (const detail of check.details) {
      lines.push(`   detail: ${detail}`);
    }
    if (check.remediation) {
      lines.push(`   remediation: ${check.remediation}`);
    }
    if (index < input.checks.length - 1) {
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderDoctorFailureSummary(input: {
  readonly checkedAt: string;
  readonly overall: DoctorOutcome;
  readonly store: ConfigStore;
  readonly configPath: string;
  readonly runtimeDir: string;
  readonly relayCachePath: string;
  readonly wireproxyConfigPath: string;
  readonly manifestPath: string;
  readonly lastStartReportPath: string;
  readonly checks: readonly DoctorCheck[];
}): string {
  const lines = [
    'Mullgate doctor',
    `overall: ${input.overall}`,
    `checked at: ${input.checkedAt}`,
    'mode: offline-default',
    `config: ${input.configPath}`,
    `runtime dir: ${input.runtimeDir}`,
    `relay cache: ${input.relayCachePath}`,
    `wireproxy config: ${input.wireproxyConfigPath}`,
    `runtime manifest: ${input.manifestPath}`,
    `last start report: ${input.lastStartReportPath}`,
    '',
    'checks',
  ];

  for (const [index, check] of input.checks.entries()) {
    lines.push(`${index + 1}. ${check.name}: ${check.outcome}`);
    lines.push(`   summary: ${check.summary}`);
    for (const detail of check.details) {
      lines.push(`   detail: ${detail}`);
    }
    if (check.remediation) {
      lines.push(`   remediation: ${check.remediation}`);
    }
    if (index < input.checks.length - 1) {
      lines.push('');
    }
  }

  return lines.join('\n');
}

function writeDoctorResult(
  result: DoctorFlowResult,
  dependencies: Pick<DoctorCommandDependencies, 'stdout' | 'stderr'>,
): void {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  if (result.ok) {
    stdout.write(`${result.summary}\n`);
    return;
  }

  stderr.write(`${result.summary}\n`);
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname) !== 0) {
    return [hostname];
  }

  const resolved = await lookup(hostname, { all: true, verbatim: true });
  return unique(resolved.map((entry) => entry.address));
}

function normalizeManifestResult(
  result: ArtifactReadResult<RuntimeBundleManifest>,
): ArtifactReadResult<RuntimeBundleManifest> {
  return normalizeArtifact(
    result,
    isRuntimeBundleManifest,
    'Runtime manifest did not match the expected Mullgate bundle shape.',
  );
}

function normalizeLastStartResult(
  result: ArtifactReadResult<RuntimeStartDiagnostic>,
): ArtifactReadResult<RuntimeStartDiagnostic> {
  return normalizeArtifact(
    result,
    isRuntimeStartDiagnostic,
    'Last-start report did not match the expected Mullgate diagnostic shape.',
  );
}

function normalizeValidationReportResult(
  result: ArtifactReadResult<ValidateWireproxyResult>,
): ArtifactReadResult<ValidateWireproxyResult> {
  return normalizeArtifact(
    result,
    isValidateWireproxyResult,
    'Validation report did not match the expected wireproxy configtest shape.',
  );
}

function normalizeArtifact<T>(
  result: ArtifactReadResult<T>,
  guard: (value: unknown) => value is T,
  invalidReason: string,
): ArtifactReadResult<T> {
  if (result.kind !== 'present') {
    return result;
  }

  if (!guard(result.value)) {
    return {
      kind: 'invalid',
      reason: invalidReason,
    };
  }

  return result;
}

function isRuntimeBundleManifest(value: unknown): value is RuntimeBundleManifest {
  return (
    isObject(value) &&
    typeof value.generatedAt === 'string' &&
    Array.isArray(value.routes) &&
    isObject(value.exposure) &&
    Array.isArray(value.exposure.routes)
  );
}

function isRuntimeStartDiagnostic(value: unknown): value is RuntimeStartDiagnostic {
  return (
    isObject(value) &&
    typeof value.attemptedAt === 'string' &&
    typeof value.status === 'string' &&
    typeof value.phase === 'string' &&
    typeof value.source === 'string' &&
    typeof value.message === 'string'
  );
}

function isValidateWireproxyResult(value: unknown): value is ValidateWireproxyResult {
  return (
    isObject(value) &&
    typeof value.ok === 'boolean' &&
    value.phase === 'validation' &&
    typeof value.source === 'string' &&
    typeof value.status === 'string' &&
    typeof value.checkedAt === 'string' &&
    typeof value.target === 'string' &&
    Array.isArray(value.issues)
  );
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isAuthRelatedFailure(lastStart: RuntimeStartDiagnostic): boolean {
  const haystack = [lastStart.code, lastStart.message, lastStart.cause]
    .filter((value): value is string => Boolean(value))
    .join('\n');
  return /(auth|authentication|unauthorized|forbidden|invalid credentials|bad credentials|username|password|407|401)/i.test(
    haystack,
  );
}

function buildAuthFailureRemediation(lastStart: RuntimeStartDiagnostic): string {
  const routeContext = describeRouteContext(lastStart);
  return [
    routeContext.length > 0
      ? `Check ${routeContext} for rejected proxy auth or stale rendered credentials.`
      : 'Check the failing route/service for rejected proxy auth or stale rendered credentials.',
    'If credentials changed, update `setup.auth.username` / `setup.auth.password` with `mullgate config set`, then rerun `mullgate config validate` and `mullgate start`.',
  ].join(' ');
}

function buildStartFailureRemediation(lastStart: RuntimeStartDiagnostic): string {
  const routeContext = describeRouteContext(lastStart);
  return [
    routeContext.length > 0
      ? `Inspect ${routeContext} first.`
      : 'Inspect the failing runtime service first.',
    'Then follow the saved artifact paths and rerun `mullgate start` only after the reported runtime error is fixed.',
  ].join(' ');
}

function buildHostnameRemediation(config: MullgateConfig, exposure: ExposureContract): string {
  if (config.setup.exposure.baseDomain) {
    return 'Publish or update the saved DNS A records so every route hostname resolves to its saved bind IP, then rerun `mullgate doctor`.';
  }

  if (exposure.routes.some((route) => route.hostname !== route.bindIp)) {
    return 'Use `mullgate config hosts` and install the emitted hosts block on this machine so each route hostname resolves to its saved bind IP, then rerun `mullgate doctor`.';
  }

  return 'Use the direct bind-IP entrypoints from the saved exposure contract when hostnames are not available.';
}

function describeRouteContext(lastStart: RuntimeStartDiagnostic): string {
  const parts = [
    lastStart.routeId ? `route ${lastStart.routeId}` : null,
    lastStart.serviceName ? `service ${lastStart.serviceName}` : null,
    lastStart.routeHostname ? `hostname ${lastStart.routeHostname}` : null,
    lastStart.routeBindIp ? `bind ${lastStart.routeBindIp}` : null,
  ].filter((value): value is string => value !== null);

  return parts.join(', ');
}

function formatAge(ageMs: number): string {
  const totalHours = Math.floor(ageMs / (60 * 60 * 1000));

  if (totalHours < 24) {
    return `${totalHours}h`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
