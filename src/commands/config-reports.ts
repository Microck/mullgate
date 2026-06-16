import { withRuntimeStatus } from '../app/setup-runner.js';
import {
  buildExposureContract,
  deriveExposureHostname,
  type ExposureValidationFailure,
  normalizeExposureBaseDomain,
  validateAccessSettings,
  validateExposureSettings,
} from '../config/exposure-contract.js';
import type { AccessMode, ExposureMode, MullgateConfig } from '../config/schema.js';
import { type ConfigStore, normalizeMullgateConfig } from '../config/store.js';
import { listRegionGroups } from '../domain/region-groups.js';
import { buildPlatformSupportContract } from '../platform/support-contract.js';
import { requireArrayValue } from '../required.js';

type ExposureUpdateInput = {
  readonly mode?: ExposureMode;
  readonly accessMode?: AccessMode;
  readonly allowUnsafePublicEmptyPassword?: boolean;
  readonly baseDomain?: string | null;
  readonly baseDomainSpecified: boolean;
  readonly routeBindIps?: readonly string[];
};

type ExposureUpdateSuccess = {
  readonly ok: true;
  readonly config: MullgateConfig;
};

type ExposureUpdateFailure = ExposureValidationFailure;

type ExposureUpdateResult = ExposureUpdateSuccess | ExposureUpdateFailure;

export function renderPathReport(report: Awaited<ReturnType<ConfigStore['inspectPaths']>>): string {
  const { paths, exists } = report;
  const platform = buildPlatformSupportContract({ paths: report.paths });

  return [
    'Mullgate path report',
    `phase: ${report.phase}`,
    `source: ${report.source}`,
    `platform: ${report.platform}`,
    `platform source: ${report.platformSource}`,
    `platform support: ${platform.posture.supportLevel}`,
    `platform mode: ${platform.posture.modeLabel}`,
    `platform summary: ${platform.posture.summary}`,
    `runtime story: ${platform.posture.runtimeStory}`,
    `host networking: ${platform.hostNetworking.modeLabel}`,
    `host networking summary: ${platform.hostNetworking.summary}`,
    `config home: ${paths.configHome} (${report.pathSources.configHome})`,
    `state home: ${paths.stateHome} (${report.pathSources.stateHome})`,
    `cache home: ${paths.cacheHome} (${report.pathSources.cacheHome})`,
    `config file: ${paths.configFile} (${exists.configFile ? 'present' : 'missing'})`,
    `state dir: ${paths.appStateDir}`,
    `cache dir: ${paths.appCacheDir}`,
    `runtime dir: ${paths.runtimeDir} (${exists.runtimeDir ? 'present' : 'missing'})`,
    `entry wireproxy config: ${paths.entryWireproxyConfigFile}`,
    `route proxy config: ${paths.routeProxyConfigFile}`,
    `runtime validation report: ${paths.runtimeValidationReportFile}`,
    `docker compose: ${paths.dockerComposePath}`,
    `relay cache: ${paths.provisioningCacheFile} (${exists.relayCacheFile ? 'present' : 'missing'})`,
    '',
    'platform guidance',
    ...platform.guidance.map((line) => `- ${line}`),
    '',
    'platform warnings',
    ...(platform.warnings.length > 0
      ? platform.warnings.map((warning) => `- ${warning.severity}: ${warning.message}`)
      : ['- none']),
  ].join('\n');
}

export function renderLocationsReport(config: MullgateConfig, configPath: string): string {
  return [
    'Mullgate routed locations',
    'phase: inspect-config',
    'source: canonical-config',
    `config: ${configPath}`,
    `routes: ${config.routing.locations.length}`,
    ...config.routing.locations.flatMap((location, index) => [
      '',
      `${index + 1}. ${location.alias}`,
      `   hostname: ${location.hostname}`,
      `   bind ip: ${location.bindIp}`,
      `   requested: ${location.relayPreference.requested}`,
      `   resolved alias: ${location.relayPreference.resolvedAlias ?? 'n/a'}`,
      `   country: ${location.relayPreference.country ?? 'n/a'}`,
      `   city: ${location.relayPreference.city ?? 'n/a'}`,
      `   exit relay: ${location.mullvad.exit.relayHostname}`,
      `   exit socks: ${location.mullvad.exit.socksHostname}:${location.mullvad.exit.socksPort}`,
      `   route id: ${location.runtime.routeId}`,
      `   https backend: ${location.runtime.httpsBackendName}`,
    ]),
  ].join('\n');
}

export function renderHostsReport(config: MullgateConfig, configPath: string): string {
  return [
    'Mullgate routed hosts',
    'phase: inspect-config',
    'source: canonical-config',
    `config: ${configPath}`,
    `routes: ${config.routing.locations.length}`,
    'hostname -> bind ip',
    ...config.routing.locations.map(
      (location, index) =>
        `${index + 1}. ${location.hostname} -> ${location.bindIp} (alias: ${location.alias}, route id: ${location.runtime.routeId})`,
    ),
    '',
    'copy/paste hosts block',
    ...renderHostsBlock(config),
  ].join('\n');
}

export function renderExposureReport(config: MullgateConfig, configPath: string): string {
  const exposure = buildExposureContract(config);

  if (exposure.accessMode === 'inline-selector' && exposure.inlineSelector) {
    return [
      'Mullgate exposure report',
      'phase: inspect-config',
      'source: canonical-config',
      `config: ${configPath}`,
      `mode: ${exposure.mode}`,
      `access mode: ${exposure.accessMode}`,
      `mode label: ${exposure.posture.modeLabel}`,
      `recommendation: ${exposure.posture.recommendation}`,
      `posture summary: ${exposure.posture.summary}`,
      `remote story: ${exposure.posture.remoteStory}`,
      `base domain: ${exposure.baseDomain ?? 'n/a'}`,
      `allow lan: ${exposure.allowLan ? 'yes' : 'no'}`,
      `shared host: ${exposure.inlineSelector.sharedHost}`,
      `selector field: ${exposure.inlineSelector.selectorField}`,
      `guaranteed syntax: ${exposure.inlineSelector.syntax.guaranteed}`,
      `best-effort syntax: ${exposure.inlineSelector.syntax.bestEffort}`,
      `runtime status: ${exposure.runtimeStatus.phase}`,
      `restart needed: ${exposure.runtimeStatus.restartRequired ? 'yes' : 'no'}`,
      ...(exposure.runtimeStatus.message
        ? [`runtime message: ${exposure.runtimeStatus.message}`]
        : []),
      '',
      'guidance',
      ...exposure.guidance.map((line) => `- ${line}`),
      '',
      'selector examples',
      ...exposure.inlineSelector.examples.flatMap((example, index) => [
        `${index + 1}. ${example.targetLabel}`,
        `   selector: ${example.selector}`,
        `   guaranteed: ${redactInlineSelectorUrl(example.guaranteedUrl)}`,
        `   best effort: ${redactInlineSelectorUrl(example.bestEffortUrl)}`,
      ]),
      '',
      'warnings',
      ...(exposure.warnings.length > 0
        ? exposure.warnings.map((warning) => `- ${warning.severity}: ${warning.message}`)
        : ['- none']),
    ].join('\n');
  }

  return [
    'Mullgate exposure report',
    'phase: inspect-config',
    'source: canonical-config',
    `config: ${configPath}`,
    `mode: ${exposure.mode}`,
    `mode label: ${exposure.posture.modeLabel}`,
    `recommendation: ${exposure.posture.recommendation}`,
    `posture summary: ${exposure.posture.summary}`,
    `remote story: ${exposure.posture.remoteStory}`,
    `base domain: ${exposure.baseDomain ?? 'n/a'}`,
    `allow lan: ${exposure.allowLan ? 'yes' : 'no'}`,
    `runtime status: ${exposure.runtimeStatus.phase}`,
    `restart needed: ${exposure.runtimeStatus.restartRequired ? 'yes' : 'no'}`,
    ...(exposure.runtimeStatus.message
      ? [`runtime message: ${exposure.runtimeStatus.message}`]
      : []),
    '',
    'guidance',
    ...exposure.guidance.map((line) => `- ${line}`),
    '',
    'remediation',
    `- bind posture: ${exposure.remediation.bindPosture}`,
    `- hostname resolution: ${exposure.remediation.hostnameResolution}`,
    `- restart: ${exposure.remediation.restart}`,
    '',
    'routes',
    ...exposure.routes.flatMap((route) => [
      `${route.index + 1}. ${route.hostname} -> ${route.bindIp}`,
      `   alias: ${route.alias}`,
      `   route id: ${route.routeId}`,
      `   dns: ${route.dnsRecord ?? 'not required; use direct bind IP entrypoints'}`,
      ...route.endpoints.flatMap((endpoint) => [
        `   ${endpoint.protocol} hostname: ${endpoint.redactedHostnameUrl}`,
        `   ${endpoint.protocol} direct ip: ${endpoint.redactedBindUrl}`,
      ]),
    ]),
    '',
    'warnings',
    ...(exposure.warnings.length > 0
      ? exposure.warnings.map((warning) => `- ${warning.severity}: ${warning.message}`)
      : ['- none']),
    '',
    'local host-file mapping',
    '- `mullgate proxy access` remains the copy/paste /etc/hosts view for local-only testing.',
  ].join('\n');
}

export function updateExposureConfig(
  config: MullgateConfig,
  artifactPath: string,
  input: ExposureUpdateInput,
): ExposureUpdateResult {
  const nextMode = input.mode ?? config.setup.exposure.mode;
  const nextAccessMode = input.accessMode ?? config.setup.access.mode;
  const nextAllowUnsafePublicEmptyPassword =
    input.allowUnsafePublicEmptyPassword ?? config.setup.access.allowUnsafePublicEmptyPassword;
  const nextBaseDomain = input.baseDomainSpecified
    ? (input.baseDomain ?? null)
    : config.setup.exposure.baseDomain;
  const existingBindIps = config.routing.locations.map((location) => location.bindIp);
  const routeBindIps =
    input.routeBindIps ??
    (nextAccessMode === 'inline-selector'
      ? [config.setup.bind.host]
      : nextMode === 'loopback'
        ? []
        : nextMode === 'private-network'
          ? [config.setup.bind.host]
          : config.setup.exposure.mode === 'loopback' && input.mode !== undefined
            ? []
            : existingBindIps);
  const validated = validateExposureSettings({
    routeCount: config.routing.locations.length,
    exposureMode: nextMode,
    accessMode: nextAccessMode,
    exposureBaseDomain: normalizeExposureBaseDomain(nextBaseDomain),
    routeBindIps,
    artifactPath,
    caller: 'config-exposure',
  });

  if (!validated.ok) {
    return validated;
  }

  const accessValidation = validateAccessSettings({
    exposureMode: validated.mode,
    accessMode: nextAccessMode,
    password: config.setup.auth.password,
    allowUnsafePublicEmptyPassword: nextAllowUnsafePublicEmptyPassword,
    artifactPath,
  });

  if (!accessValidation.ok) {
    return accessValidation;
  }

  const updatedRoutingLocations = config.routing.locations.map((location, index) => {
    const bindIp = requireArrayValue(
      validated.routeBindIps,
      index,
      `Missing validated bind IP for routed location ${location.alias}.`,
    );

    return {
      ...location,
      bindIp,
      hostname: deriveExposureHostname(
        location.alias,
        bindIp,
        validated.baseDomain,
        validated.mode,
      ),
    };
  });
  const canonicalConfig = normalizeMullgateConfig({
    ...config,
    setup: {
      ...config.setup,
      bind: {
        ...config.setup.bind,
        host: validated.bindHost,
      },
      access: {
        mode: nextAccessMode,
        allowUnsafePublicEmptyPassword: nextAllowUnsafePublicEmptyPassword,
      },
      exposure: {
        mode: validated.mode,
        allowLan: validated.mode !== 'loopback',
        baseDomain: validated.baseDomain,
      },
    },
    routing: {
      locations: updatedRoutingLocations,
    },
  });

  return {
    ok: true,
    config: withRuntimeStatus(
      canonicalConfig,
      'unvalidated',
      null,
      'Exposure settings changed; rerun `mullgate proxy validate` or `mullgate proxy start` to refresh runtime artifacts.',
    ),
  };
}

export function renderRegionGroupsReport(): string {
  const regionGroups = listRegionGroups();

  return [
    'Mullgate region groups',
    'phase: inspect-config',
    'source: canonical-region-groups',
    `regions: ${regionGroups.length}`,
    ...regionGroups.flatMap((region, index) => [
      '',
      `${index + 1}. ${region.name}`,
      `   countries: ${region.countryCodes.join(', ')}`,
      `   example: mullgate proxy export --region ${region.name} --count 5`,
    ]),
  ].join('\n');
}

function renderHostsBlock(config: MullgateConfig): string[] {
  return config.routing.locations.map((location) => `${location.bindIp} ${location.hostname}`);
}

function redactInlineSelectorUrl(url: string): string {
  return url.replace(/:\/\/([^:@/?#]+):([^@/?#]*)@/, '://$1:[redacted]@');
}
