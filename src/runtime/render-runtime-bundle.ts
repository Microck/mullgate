import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { REDACTED } from '../config/redact.js';
import { buildExposureContract, type ExposureContract } from '../config/exposure-contract.js';
import { resolveRouteWireproxyPaths, type MullgatePaths } from '../config/paths.js';
import type { MullgateConfig, RoutedLocation } from '../config/schema.js';
import { buildPlatformSupportContract, type PlatformSupportContract } from '../platform/support-contract.js';

const CONTAINER_BIND_HOST = '0.0.0.0';
const WIREPROXY_IMAGE = 'backplane/wireproxy:20260320';
const HAPROXY_IMAGE = 'haproxytech/haproxy-alpine:3.0.19';
const ROUTING_LAYER_SERVICE = 'routing-layer';
const HAPROXY_CONFIG_CONTAINER_PATH = '/usr/local/etc/haproxy/haproxy.cfg';
const HAPROXY_CERT_INPUT_PATH = '/run/mullgate-cert.pem';
const HAPROXY_KEY_INPUT_PATH = '/run/mullgate-key.pem';
const HAPROXY_COMBINED_PEM_PATH = '/run/mullgate/tls/haproxy.pem';
const HAPROXY_TLS_TMPFS_PATH = '/run/mullgate/tls';
const WIREPROXY_CONFIG_CONTAINER_PATH = '/etc/wireproxy/wireproxy.conf';
const HOST_NETWORK_MODE = 'host';

type RuntimeProtocol = 'socks5' | 'http' | 'https';

export type RuntimeEndpoint = {
  readonly routeId: string;
  readonly hostname: string;
  readonly bindIp: string;
  readonly protocol: RuntimeProtocol;
  readonly host: string;
  readonly port: number;
  readonly containerHost: '0.0.0.0';
  readonly containerPort: number;
  readonly auth: {
    readonly username: typeof REDACTED;
    readonly password: typeof REDACTED;
  };
  readonly hostnameUrl: string;
  readonly bindUrl: string;
  readonly redactedHostnameUrl: string;
  readonly redactedBindUrl: string;
};

export type RuntimeBundleManifest = {
  readonly generatedAt: string;
  readonly source: 'canonical-config';
  readonly topology: 'multi-route-wireproxy-haproxy';
  readonly relayCachePath: string;
  readonly images: {
    readonly wireproxy: string;
    readonly routingLayer: string;
  };
  readonly services: {
    readonly routingLayer: {
      readonly name: string;
      readonly listeners: {
        readonly socks5: string | null;
        readonly http: string | null;
        readonly https: string | null;
      };
      readonly networkMode: 'host';
      readonly publishedPorts: string[];
      readonly mountPaths: {
        readonly haproxyConfigPath: string;
        readonly certPath: string | null;
        readonly keyPath: string | null;
        readonly combinedPemPath: string | null;
      };
    };
  };
  readonly exposure: ExposureContract;
  readonly platform: PlatformSupportContract;
  readonly routes: readonly {
    readonly routeId: string;
    readonly alias: string;
    readonly hostname: string;
    readonly bindIp: string;
    readonly wireproxyConfigPath: string;
    readonly configTestReportPath: string;
    readonly services: {
      readonly wireproxy: {
        readonly name: string;
        readonly internalListeners: {
          readonly socks5: string;
          readonly http: string;
        };
      };
      readonly backends: {
        readonly socks5: string | null;
        readonly http: string | null;
        readonly https: string | null;
      };
    };
    readonly publishedEndpoints: readonly RuntimeEndpoint[];
  }[];
  readonly publishedEndpoints: readonly RuntimeEndpoint[];
};

export type RenderedRuntimeBundleArtifacts = {
  readonly bundleDir: string;
  readonly dockerComposePath: string;
  readonly httpsSidecarConfigPath: string;
  readonly manifestPath: string;
};

export type RenderRuntimeBundleSuccess = {
  ok: true;
  phase: 'artifact-render';
  source: 'canonical-config';
  checkedAt: string;
  compose: string;
  httpsSidecarConfig: string;
  manifest: RuntimeBundleManifest;
  artifactPaths: RenderedRuntimeBundleArtifacts;
};

export type RenderRuntimeBundleFailure = {
  ok: false;
  phase: 'artifact-render';
  source: 'canonical-config' | 'filesystem';
  checkedAt: string;
  code: 'MISSING_HTTPS_CONFIG' | 'WRITE_FAILED';
  message: string;
  cause?: string;
  artifactPath?: string;
};

export type RenderRuntimeBundleResult = RenderRuntimeBundleSuccess | RenderRuntimeBundleFailure;

export type RenderRuntimeBundleOptions = {
  readonly config: MullgateConfig;
  readonly paths: MullgatePaths;
  readonly generatedAt?: string;
};

export function planRuntimeBundle(options: RenderRuntimeBundleOptions): RenderRuntimeBundleResult {
  const checkedAt = options.generatedAt ?? new Date().toISOString();
  const https = resolveHttpsRuntime(options.config);

  if (!https.ok) {
    return {
      ok: false,
      phase: 'artifact-render',
      source: 'canonical-config',
      checkedAt,
      code: 'MISSING_HTTPS_CONFIG',
      message: https.message,
      ...(https.artifactPath ? { artifactPath: https.artifactPath } : {}),
    };
  }

  const publishedEndpoints = buildPublishedEndpoints(options.config, https);
  const compose = buildDockerCompose(options.config, options.paths, https);
  const httpsSidecarConfig = buildHttpsSidecarConfig(options.config, https);
  const manifest = buildRuntimeBundleManifest(options.config, options.paths, checkedAt, https, publishedEndpoints);

  return {
    ok: true,
    phase: 'artifact-render',
    source: 'canonical-config',
    checkedAt,
    compose,
    httpsSidecarConfig,
    manifest,
    artifactPaths: {
      bundleDir: options.paths.runtimeBundleDir,
      dockerComposePath: options.paths.runtimeComposeFile,
      httpsSidecarConfigPath: options.paths.runtimeHttpsSidecarConfigFile,
      manifestPath: options.paths.runtimeBundleManifestFile,
    },
  };
}

export async function renderRuntimeBundle(options: RenderRuntimeBundleOptions): Promise<RenderRuntimeBundleResult> {
  const planned = planRuntimeBundle(options);

  if (!planned.ok) {
    return planned;
  }

  try {
    await ensureDirectory(options.paths.runtimeBundleDir);
    await writeFileAtomic(planned.artifactPaths.dockerComposePath, planned.compose, 0o600);
    await writeFileAtomic(planned.artifactPaths.httpsSidecarConfigPath, planned.httpsSidecarConfig, 0o600);
    await writeFileAtomic(planned.artifactPaths.manifestPath, `${JSON.stringify(planned.manifest, null, 2)}\n`, 0o600);
  } catch (error) {
    return {
      ok: false,
      phase: 'artifact-render',
      source: 'filesystem',
      checkedAt: planned.checkedAt,
      code: 'WRITE_FAILED',
      message: 'Failed to persist the rendered runtime bundle under the Mullgate state runtime directory.',
      cause: error instanceof Error ? error.message : String(error),
      artifactPath: options.paths.runtimeBundleDir,
    };
  }

  return planned;
}

type ResolvedHttpsRuntime =
  | {
      readonly ok: true;
      readonly enabled: false;
    }
  | {
      readonly ok: true;
      readonly enabled: true;
      readonly port: number;
      readonly certPath: string;
      readonly keyPath: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly artifactPath?: string;
    };

function resolveHttpsRuntime(config: MullgateConfig): ResolvedHttpsRuntime {
  const requested = Boolean(
    config.setup.bind.httpsPort !== null || config.setup.https.enabled || config.setup.https.certPath || config.setup.https.keyPath,
  );

  if (!requested) {
    return { ok: true, enabled: false };
  }

  if (config.setup.bind.httpsPort === null) {
    return {
      ok: false,
      message: 'HTTPS runtime bundle rendering requires a configured HTTPS bind port.',
      artifactPath: config.runtime.runtimeBundle.dockerComposePath,
    };
  }

  if (!config.setup.https.certPath || !config.setup.https.keyPath) {
    return {
      ok: false,
      message: 'HTTPS runtime bundle rendering requires both certificate and key paths in the canonical config.',
      artifactPath: config.setup.https.certPath ?? config.setup.https.keyPath ?? config.runtime.runtimeBundle.httpsSidecarConfigPath,
    };
  }

  return {
    ok: true,
    enabled: true,
    port: config.setup.bind.httpsPort,
    certPath: config.setup.https.certPath,
    keyPath: config.setup.https.keyPath,
  };
}

function buildPublishedEndpoints(
  config: MullgateConfig,
  https: Extract<ResolvedHttpsRuntime, { ok: true }>,
): RuntimeEndpoint[] {
  return config.routing.locations.flatMap((route) => {
    const endpoints: RuntimeEndpoint[] = [
      createEndpoint(route, 'socks5', config.setup.bind.socksPort),
      createEndpoint(route, 'http', config.setup.bind.httpPort),
    ];

    if (https.enabled) {
      endpoints.push(createEndpoint(route, 'https', https.port));
    }

    return endpoints;
  });
}

function createEndpoint(route: RoutedLocation, protocol: RuntimeEndpoint['protocol'], port: number): RuntimeEndpoint {
  return {
    routeId: route.runtime.routeId,
    hostname: route.hostname,
    bindIp: route.bindIp,
    protocol,
    host: route.hostname,
    port,
    containerHost: CONTAINER_BIND_HOST,
    containerPort: port,
    auth: {
      username: REDACTED,
      password: REDACTED,
    },
    hostnameUrl: `${protocol}://${route.hostname}:${port}`,
    bindUrl: `${protocol}://${route.bindIp}:${port}`,
    redactedHostnameUrl: `${protocol}://${REDACTED}:${REDACTED}@${route.hostname}:${port}`,
    redactedBindUrl: `${protocol}://${REDACTED}:${REDACTED}@${route.bindIp}:${port}`,
  };
}

function buildRuntimeBundleManifest(
  config: MullgateConfig,
  paths: MullgatePaths,
  generatedAt: string,
  https: Extract<ResolvedHttpsRuntime, { ok: true }>,
  publishedEndpoints: readonly RuntimeEndpoint[],
): RuntimeBundleManifest {
  const routeManifests = config.routing.locations.map((route) => {
    const artifactPaths = resolveRouteWireproxyPaths(paths, route.runtime);
    const routeEndpoints = publishedEndpoints.filter((endpoint) => endpoint.routeId === route.runtime.routeId);

    return {
      routeId: route.runtime.routeId,
      alias: route.alias,
      hostname: route.hostname,
      bindIp: route.bindIp,
      wireproxyConfigPath: artifactPaths.wireproxyConfigPath,
      configTestReportPath: artifactPaths.configTestReportPath,
      services: {
        wireproxy: {
          name: route.runtime.wireproxyServiceName,
          internalListeners: {
            socks5: `${route.bindIp}:${config.setup.bind.socksPort}`,
            http: `${route.bindIp}:${config.setup.bind.httpPort}`,
          },
        },
        backends: {
          socks5: null,
          http: null,
          https: https.enabled ? `${route.runtime.haproxyBackendName}-https` : null,
        },
      },
      publishedEndpoints: routeEndpoints,
    };
  });

  return {
    generatedAt,
    source: 'canonical-config',
    topology: 'multi-route-wireproxy-haproxy',
    relayCachePath: paths.provisioningCacheFile,
    images: {
      wireproxy: WIREPROXY_IMAGE,
      routingLayer: HAPROXY_IMAGE,
    },
    services: {
      routingLayer: {
        name: ROUTING_LAYER_SERVICE,
        listeners: {
          socks5: null,
          http: null,
          https: https.enabled ? `per-route bind IPs on port ${https.port}` : null,
        },
        networkMode: HOST_NETWORK_MODE,
        publishedPorts: [],
        mountPaths: {
          haproxyConfigPath: paths.runtimeHttpsSidecarConfigFile,
          certPath: https.enabled ? https.certPath : null,
          keyPath: https.enabled ? https.keyPath : null,
          combinedPemPath: https.enabled ? HAPROXY_COMBINED_PEM_PATH : null,
        },
      },
    },
    exposure: buildExposureContract(config),
    platform: buildPlatformSupportContract({ paths }),
    routes: routeManifests,
    publishedEndpoints,
  };
}

function buildDockerCompose(
  config: MullgateConfig,
  paths: MullgatePaths,
  https: Extract<ResolvedHttpsRuntime, { ok: true }>,
): string {
  const lines = [
    '# Generated by Mullgate. Derived artifact; edit canonical config instead.',
    'name: mullgate',
    'services:',
    `  ${ROUTING_LAYER_SERVICE}:`,
    `    image: ${HAPROXY_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    ...config.routing.locations.map((route) => `      - ${route.runtime.wireproxyServiceName}`),
  ];

  if (https.enabled) {
    lines.push(
      '    entrypoint:',
      '      - /bin/sh',
      '      - -ec',
      `      - cat ${HAPROXY_CERT_INPUT_PATH} ${HAPROXY_KEY_INPUT_PATH} > ${HAPROXY_COMBINED_PEM_PATH} && exec haproxy -W -db -f ${HAPROXY_CONFIG_CONTAINER_PATH}`,
      '    tmpfs:',
      `      - ${HAPROXY_TLS_TMPFS_PATH}`,
    );
  } else {
    lines.push(
      '    command:',
      '      - haproxy',
      '      - -W',
      '      - -db',
      '      - -f',
      `      - ${HAPROXY_CONFIG_CONTAINER_PATH}`,
    );
  }

  lines.push(
    '    network_mode: host',
    '    volumes:',
    `      - ${paths.runtimeHttpsSidecarConfigFile}:${HAPROXY_CONFIG_CONTAINER_PATH}:ro`,
  );

  if (https.enabled) {
    lines.push(
      `      - ${https.certPath}:${HAPROXY_CERT_INPUT_PATH}:ro`,
      `      - ${https.keyPath}:${HAPROXY_KEY_INPUT_PATH}:ro`,
    );
  }

  for (const route of config.routing.locations) {
    const artifactPaths = resolveRouteWireproxyPaths(paths, route.runtime);
    lines.push(
      `  ${route.runtime.wireproxyServiceName}:`,
      `    image: ${WIREPROXY_IMAGE}`,
      '    user: "0:0"',
      '    network_mode: host',
      '    restart: unless-stopped',
      '    command:',
      '      - --config',
      `      - ${WIREPROXY_CONFIG_CONTAINER_PATH}`,
      '    volumes:',
      `      - ${artifactPaths.wireproxyConfigPath}:${WIREPROXY_CONFIG_CONTAINER_PATH}:ro`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function buildPublishedPorts(
  config: MullgateConfig,
  https: Extract<ResolvedHttpsRuntime, { ok: true }>,
): string[] {
  const ports: string[] = [];

  for (const route of config.routing.locations) {
    ports.push(`${route.bindIp}:${config.setup.bind.socksPort}:${config.setup.bind.socksPort}`);
    ports.push(`${route.bindIp}:${config.setup.bind.httpPort}:${config.setup.bind.httpPort}`);

    if (https.enabled) {
      ports.push(`${route.bindIp}:${https.port}:${https.port}`);
    }
  }

  return ports;
}

function buildHttpsSidecarConfig(
  config: MullgateConfig,
  https: Extract<ResolvedHttpsRuntime, { ok: true }>,
): string {
  const lines = [
    '# Generated by Mullgate. Derived artifact; edit canonical config instead.',
    'global',
    '  log stdout format raw local0',
    '',
    'defaults',
    '  log global',
    '  mode tcp',
    '  timeout connect 10s',
    '  timeout client 1m',
    '  timeout server 1m',
    '',
  ];

  if (https.enabled) {
    const primaryRoute = config.routing.locations[0]!;
    lines.push(
      'frontend https_proxy',
      `  bind ${CONTAINER_BIND_HOST}:${https.port} ssl crt ${HAPROXY_COMBINED_PEM_PATH}`,
      ...buildRouteSelectionRules(config.routing.locations, 'https'),
      `  default_backend ${primaryRoute.runtime.haproxyBackendName}-https`,
      '',
    );
  }

  for (const route of config.routing.locations) {
    if (https.enabled) {
      lines.push(
        `backend ${route.runtime.haproxyBackendName}-https`,
        `  server ${route.runtime.routeId} ${route.bindIp}:${config.setup.bind.httpPort} check`,
        '',
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildRouteSelectionRules(routes: readonly RoutedLocation[], protocol: RuntimeProtocol): string[] {
  // SOCKS5 does not preserve the requested proxy hostname end-to-end, so the front door must dispatch by the
  // published destination bind IP that the operator mapped from hostname -> bind IP during setup/config inspection.
  return routes.flatMap((route) => {
    const aclName = `route_${route.runtime.routeId.replace(/[^a-zA-Z0-9]/g, '_')}_${protocol}`;
    return [
      `  acl ${aclName} dst ${route.bindIp}`,
      `  use_backend ${route.runtime.haproxyBackendName}-${protocol} if ${aclName}`,
    ];
  });
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
}

async function writeFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

  let fileHandle;
  try {
    fileHandle = await open(temporaryPath, 'w', mode);
    await fileHandle.writeFile(content, 'utf8');
    await fileHandle.sync();
  } finally {
    await fileHandle?.close();
  }

  try {
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
    await chmod(filePath, mode);

    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
