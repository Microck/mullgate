import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import {
  loadStoredRelayCatalog,
  summarizeValidationSource,
  verifyHttpsAssets,
  withRuntimeStatus,
} from '../app/setup-runner.js';
import { computePublishedPort, deriveRuntimeListenerHost } from '../config/exposure-contract.js';
import type { MullgateConfig } from '../config/schema.js';
import type { ConfigStore } from '../config/store.js';
import {
  ENTRY_WIREPROXY_SOCKS_PORT,
  type InlineSelectorMapping,
  renderRuntimeProxyArtifacts,
} from '../runtime/render-runtime-proxies.js';
import { validateRuntimeArtifacts } from '../runtime/validate-runtime.js';

export type ConfigValidationSuccess = {
  readonly ok: true;
  readonly phase: 'validation';
  readonly source: 'validation-suite';
  readonly refreshedArtifacts: boolean;
  readonly config: MullgateConfig;
  readonly artifactPath: string;
  readonly reportPath: string;
  readonly message: string;
};

export type ConfigValidationFailure = {
  readonly ok: false;
  readonly phase:
    | 'load-config'
    | 'read-config'
    | 'parse-config'
    | 'https-assets'
    | 'relay-normalize'
    | 'artifact-render'
    | 'validation'
    | 'persist-config';
  readonly source: string;
  readonly message: string;
  readonly artifactPath?: string;
  readonly cause?: string;
};

type ConfigValidationResult = ConfigValidationSuccess | ConfigValidationFailure;

export async function validateSavedConfig(input: {
  readonly store: ConfigStore;
  readonly refresh: boolean;
}): Promise<ConfigValidationResult> {
  const loadResult = await input.store.load();

  if (!loadResult.ok) {
    return {
      ok: false,
      phase: loadResult.phase,
      source: loadResult.source,
      message: loadResult.message,
      artifactPath: loadResult.artifactPath,
    };
  }

  if (loadResult.source === 'empty') {
    return {
      ok: false,
      phase: 'load-config',
      source: loadResult.source,
      message: loadResult.message,
      artifactPath: input.store.paths.configFile,
    };
  }

  const httpsCheck = await verifyHttpsAssets({
    enabled: loadResult.config.setup.https.enabled,
    certPath: loadResult.config.setup.https.certPath,
    keyPath: loadResult.config.setup.https.keyPath,
  });

  if (!httpsCheck.ok) {
    const errored = withRuntimeStatus(
      loadResult.config,
      'error',
      new Date().toISOString(),
      httpsCheck.message,
    );
    await saveRuntimeStatus(input.store, errored);

    return {
      ok: false,
      phase: httpsCheck.phase,
      source: httpsCheck.source,
      message: httpsCheck.message,
      ...(httpsCheck.artifactPath ? { artifactPath: httpsCheck.artifactPath } : {}),
      ...(httpsCheck.cause ? { cause: httpsCheck.cause } : {}),
    };
  }

  const hasExistingRuntimeArtifacts = await Promise.all([
    fileExists(input.store.paths.entryWireproxyConfigFile),
    fileExists(input.store.paths.routeProxyConfigFile),
  ]).then(([entryExists, routeProxyExists]) => entryExists && routeProxyExists);
  const shouldRefresh =
    input.refresh ||
    loadResult.config.setup.access.mode === 'inline-selector' ||
    loadResult.config.runtime.status.phase === 'unvalidated' ||
    !hasExistingRuntimeArtifacts;

  let entryWireproxyConfigPath = input.store.paths.entryWireproxyConfigFile;
  let entryWireproxyConfigText: string | undefined;
  let routeProxyConfigPath = input.store.paths.routeProxyConfigFile;
  let routeProxyConfigText: string | undefined;
  let inlineSelectors: readonly InlineSelectorMapping[] = [];
  let refreshedArtifacts = false;

  if (shouldRefresh) {
    const relayCatalog = await loadStoredRelayCatalog(input.store.paths.provisioningCacheFile);

    if (!relayCatalog.ok) {
      const errored = withRuntimeStatus(
        loadResult.config,
        'error',
        new Date().toISOString(),
        relayCatalog.message,
      );
      await saveRuntimeStatus(input.store, errored);

      return {
        ok: false,
        phase: relayCatalog.phase,
        source: relayCatalog.source,
        message: relayCatalog.message,
        artifactPath: relayCatalog.artifactPath,
        ...(relayCatalog.cause ? { cause: relayCatalog.cause } : {}),
      };
    }

    const renderResult = await renderRuntimeProxyArtifacts({
      config: loadResult.config,
      relayCatalog: relayCatalog.value,
      paths: input.store.paths,
    });

    if (!renderResult.ok) {
      const errored = withRuntimeStatus(
        loadResult.config,
        'error',
        renderResult.checkedAt,
        renderResult.message,
      );
      await saveRuntimeStatus(input.store, errored);

      return {
        ok: false,
        phase: renderResult.phase,
        source: renderResult.source,
        message: renderResult.message,
        ...(renderResult.artifactPath ? { artifactPath: renderResult.artifactPath } : {}),
        ...(renderResult.cause ? { cause: renderResult.cause } : {}),
      };
    }

    entryWireproxyConfigPath = renderResult.artifactPaths.entryWireproxyConfigPath;
    entryWireproxyConfigText = renderResult.entryWireproxyConfig;
    routeProxyConfigPath = renderResult.artifactPaths.routeProxyConfigPath;
    routeProxyConfigText = renderResult.routeProxyConfig;
    inlineSelectors = renderResult.inlineSelectors;
    refreshedArtifacts = true;
  } else {
    try {
      [entryWireproxyConfigText, routeProxyConfigText] = await Promise.all([
        readFile(entryWireproxyConfigPath, 'utf8'),
        readFile(routeProxyConfigPath, 'utf8'),
      ]);
    } catch (error) {
      return {
        ok: false,
        phase: 'validation',
        source: 'filesystem',
        message: 'Failed to read existing runtime artifacts for validation.',
        artifactPath: error instanceof Error && 'path' in error ? String(error.path) : undefined,
        cause: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const validationResult = await validateRuntimeArtifacts({
    entryWireproxyConfigPath,
    entryWireproxyConfigText,
    routeProxyConfigPath,
    routeProxyConfigText,
    routes: buildRuntimeValidationRoutes(loadResult.config),
    inlineSelectors,
    accessMode: loadResult.config.setup.access.mode,
    exposureMode: loadResult.config.setup.exposure.mode,
    bindHost: loadResult.config.setup.bind.host,
    bind: {
      socksPort: loadResult.config.setup.bind.socksPort,
      httpPort: loadResult.config.setup.bind.httpPort,
    },
    validateEntryWireproxy: loadResult.config.mullvad.exitSource !== 'tailscale-exit',
    reportPath: input.store.paths.runtimeValidationReportFile,
  });

  const updatedConfig = withRuntimeStatus(
    loadResult.config,
    validationResult.ok ? 'validated' : 'error',
    validationResult.checkedAt,
    validationResult.ok
      ? `Validated via ${summarizeValidationSource(validationResult)}.`
      : `Validation failed via ${summarizeValidationSource(validationResult)}: ${validationResult.cause}`,
  );

  const saveResult = await saveRuntimeStatus(input.store, updatedConfig);

  if (!saveResult.ok) {
    return saveResult;
  }

  if (!validationResult.ok) {
    return {
      ok: false,
      phase: validationResult.phase,
      source: validationResult.source,
      message: validationResult.cause,
      artifactPath: validationResult.target,
      cause: validationResult.issues.map((issue) => issue.message).join('; '),
    };
  }

  return {
    ok: true,
    phase: validationResult.phase,
    source: validationResult.source,
    refreshedArtifacts,
    config: updatedConfig,
    artifactPath: input.store.paths.entryWireproxyConfigFile,
    reportPath: validationResult.reportPath ?? input.store.paths.runtimeValidationReportFile,
    message: `Validated via ${summarizeValidationSource(validationResult)}.`,
  };
}

export function renderValidationSuccess(result: ConfigValidationSuccess): string {
  return [
    'Mullgate validate complete.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    `artifact: ${result.artifactPath}`,
    `report: ${result.reportPath}`,
    `artifacts refreshed: ${result.refreshedArtifacts ? 'yes' : 'no'}`,
    `runtime status: ${result.config.runtime.status.phase}`,
    `reason: ${result.message}`,
  ].join('\n');
}

export function renderValidationError(result: ConfigValidationFailure): string {
  return [
    'Mullgate validate failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    ...(result.artifactPath ? [`artifact: ${result.artifactPath}`] : []),
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
  ].join('\n');
}

function buildRuntimeValidationRoutes(config: MullgateConfig) {
  return config.routing.locations.map((route, index) => ({
    routeIndex: index,
    routeId: route.runtime.routeId,
    routeAlias: route.alias,
    routeHostname: route.hostname,
    routeBindIp: route.bindIp,
    routeListenHost: deriveRuntimeListenerHost(config.setup.exposure.mode, route.bindIp),
    routeSocksPort: computePublishedPort(
      config.setup.exposure.mode,
      config.setup.bind.socksPort,
      index,
    ),
    routeHttpPort: computePublishedPort(
      config.setup.exposure.mode,
      config.setup.bind.httpPort,
      index,
    ),
    httpsBackendName: route.runtime.httpsBackendName,
    exitRelayHostname: route.mullvad.exit.relayHostname,
    exitRelayFqdn: route.mullvad.exit.relayFqdn,
    exitSocksHostname: route.mullvad.exit.socksHostname,
    exitSocksPort: route.mullvad.exit.socksPort,
    exitSocksInternalIp: route.mullvad.exit.socksInternalIp ?? null,
    entryParent:
      config.mullvad.exitSource === 'tailscale-exit'
        ? null
        : {
            host: '127.0.0.1' as const,
            port: ENTRY_WIREPROXY_SOCKS_PORT,
          },
  }));
}

async function saveRuntimeStatus(
  store: ConfigStore,
  config: MullgateConfig,
): Promise<{ ok: true } | ConfigValidationFailure> {
  try {
    await store.save(config);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      phase: 'persist-config',
      source: 'filesystem',
      message: 'Failed to persist updated Mullgate runtime status.',
      artifactPath: store.paths.configFile,
      cause: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
