import { chmod, type FileHandle, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  buildExposureContract,
  computePublishedPort,
  deriveRuntimeBackendHost,
  deriveRuntimeListenerHost,
  type ExposureContract,
} from '../config/exposure-contract.js';
import type { MullgatePaths } from '../config/paths.js';
import { REDACTED } from '../config/redact.js';
import type { MullgateConfig, RoutedLocation } from '../config/schema.js';
import {
  buildPlatformSupportContract,
  type PlatformSupportContract,
} from '../platform/support-contract.js';
import { requireDefined } from '../required.js';
import {
  ENTRY_TUNNEL_SERVICE,
  ENTRY_WIREPROXY_HTTP_PORT,
  ENTRY_WIREPROXY_SOCKS_PORT,
  ROUTE_PROXY_SERVICE,
} from './render-runtime-proxies.js';

const CONTAINER_BIND_HOST = '0.0.0.0';
const WIREPROXY_IMAGE = 'backplane/wireproxy:20260320';
const ROUTE_PROXY_IMAGE = 'tarampampam/3proxy:latest';
const HAPROXY_IMAGE = 'haproxytech/haproxy-alpine:3.0.19';
const ROUTING_LAYER_SERVICE = 'routing-layer';
const HAPROXY_CONFIG_CONTAINER_PATH = '/usr/local/etc/haproxy/haproxy.cfg';
const HAPROXY_CERT_INPUT_PATH = '/run/mullgate-cert.pem';
const HAPROXY_KEY_INPUT_PATH = '/run/mullgate-key.pem';
const HAPROXY_COMBINED_PEM_PATH = '/run/mullgate/tls/haproxy.pem';
const HAPROXY_TLS_TMPFS_PATH = '/run/mullgate/tls';
const ENTRY_WIREPROXY_CONFIG_CONTAINER_PATH = '/etc/wireproxy/wireproxy.conf';
const ROUTE_PROXY_CONFIG_CONTAINER_PATH = '/etc/3proxy/3proxy.cfg';
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
  readonly topology: 'shared-entry-wireguard-route-proxy-haproxy';
  readonly relayCachePath: string;
  readonly images: {
    readonly wireproxy: string;
    readonly routeProxy: string;
    readonly routingLayer: string;
  };
  readonly services: {
    readonly entryTunnel: {
      readonly name: string;
      readonly internalListeners: {
        readonly socks5: string;
        readonly http: string;
      };
      readonly networkMode: 'host';
      readonly mountPaths: {
        readonly entryWireproxyConfigPath: string;
      };
    };
    readonly routeProxy: {
      readonly name: string;
      readonly listeners: {
        readonly socks5: string;
        readonly http: string;
      };
      readonly networkMode: 'host';
      readonly mountPaths: {
        readonly routeProxyConfigPath: string;
      };
    };
    readonly routingLayer: {
      readonly name: string;
      readonly listeners: {
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
    readonly exit: {
      readonly relayHostname: string;
      readonly relayFqdn: string;
      readonly socksHostname: string;
      readonly socksPort: number;
      readonly countryCode: string;
      readonly cityCode: string;
    };
    readonly listeners: {
      readonly socks5: string;
      readonly http: string;
      readonly https: string | null;
    };
    readonly services: {
      readonly routeProxy: {
        readonly name: string;
      };
      readonly backends: {
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
  readonly ok: true;
  readonly phase: 'artifact-render';
  readonly source: 'canonical-config';
  readonly checkedAt: string;
  readonly compose: string;
  readonly httpsSidecarConfig: string;
  readonly manifest: RuntimeBundleManifest;
  readonly artifactPaths: RenderedRuntimeBundleArtifacts;
};

export type RenderRuntimeBundleFailure = {
  readonly ok: false;
  readonly phase: 'artifact-render';
  readonly source: 'canonical-config' | 'filesystem';
  readonly checkedAt: string;
  readonly code: 'MISSING_HTTPS_CONFIG' | 'WRITE_FAILED';
  readonly message: string;
  readonly cause?: string;
  readonly artifactPath?: string;
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
  const manifest = buildRuntimeBundleManifest(
    options.config,
    options.paths,
    checkedAt,
    https,
    publishedEndpoints,
  );

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

export async function renderRuntimeBundle(
  options: RenderRuntimeBundleOptions,
): Promise<RenderRuntimeBundleResult> {
  const planned = planRuntimeBundle(options);

  if (!planned.ok) {
    return planned;
  }

  try {
    await ensureDirectory(options.paths.runtimeBundleDir);
    await writeFileAtomic(planned.artifactPaths.dockerComposePath, planned.compose, 0o600);
    await writeFileAtomic(
      planned.artifactPaths.httpsSidecarConfigPath,
      planned.httpsSidecarConfig,
      0o600,
    );
    await writeFileAtomic(
      planned.artifactPaths.manifestPath,
      `${JSON.stringify(planned.manifest, null, 2)}\n`,
      0o600,
    );
  } catch (error) {
    return {
      ok: false,
      phase: 'artifact-render',
      source: 'filesystem',
      checkedAt: planned.checkedAt,
      code: 'WRITE_FAILED',
      message:
        'Failed to persist the rendered runtime bundle under the Mullgate state runtime directory.',
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
    config.setup.bind.httpsPort !== null ||
      config.setup.https.enabled ||
      config.setup.https.certPath ||
      config.setup.https.keyPath,
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
      message:
        'HTTPS runtime bundle rendering requires both certificate and key paths in the canonical config.',
      artifactPath:
        config.setup.https.certPath ??
        config.setup.https.keyPath ??
        config.runtime.runtimeBundle.httpsSidecarConfigPath,
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
  return config.routing.locations.flatMap((route, index) => {
    const endpoints: RuntimeEndpoint[] = [
      createEndpoint(config, route, index, 'socks5', config.setup.bind.socksPort),
      createEndpoint(config, route, index, 'http', config.setup.bind.httpPort),
    ];

    if (https.enabled) {
      endpoints.push(createEndpoint(config, route, index, 'https', https.port));
    }

    return endpoints;
  });
}

function createEndpoint(
  config: MullgateConfig,
  route: RoutedLocation,
  routeIndex: number,
  protocol: RuntimeEndpoint['protocol'],
  port: number,
): RuntimeEndpoint {
  const publishedPort = computePublishedPort(config.setup.exposure.mode, port, routeIndex);

  return {
    routeId: route.runtime.routeId,
    hostname: route.hostname,
    bindIp: route.bindIp,
    protocol,
    host: route.hostname,
    port: publishedPort,
    containerHost: CONTAINER_BIND_HOST,
    containerPort: publishedPort,
    auth: {
      username: REDACTED,
      password: REDACTED,
    },
    hostnameUrl: `${protocol}://${route.hostname}:${publishedPort}`,
    bindUrl: `${protocol}://${route.bindIp}:${publishedPort}`,
    redactedHostnameUrl: `${protocol}://${REDACTED}:${REDACTED}@${route.hostname}:${publishedPort}`,
    redactedBindUrl: `${protocol}://${REDACTED}:${REDACTED}@${route.bindIp}:${publishedPort}`,
  };
}

function buildRuntimeBundleManifest(
  config: MullgateConfig,
  paths: MullgatePaths,
  generatedAt: string,
  https: Extract<ResolvedHttpsRuntime, { ok: true }>,
  publishedEndpoints: readonly RuntimeEndpoint[],
): RuntimeBundleManifest {
  const routeManifests = config.routing.locations.map((route, index) => {
    const routeEndpoints = publishedEndpoints.filter(
      (endpoint) => endpoint.routeId === route.runtime.routeId,
    );
    const socks5Port = computePublishedPort(
      config.setup.exposure.mode,
      config.setup.bind.socksPort,
      index,
    );
    const httpPort = computePublishedPort(
      config.setup.exposure.mode,
      config.setup.bind.httpPort,
      index,
    );
    const httpsPort = https.enabled
      ? computePublishedPort(config.setup.exposure.mode, https.port, index)
      : null;
    const listenerHost = deriveRuntimeListenerHost(config.setup.exposure.mode, route.bindIp);

    return {
      routeId: route.runtime.routeId,
      alias: route.alias,
      hostname: route.hostname,
      bindIp: route.bindIp,
      exit: {
        relayHostname: route.mullvad.exit.relayHostname,
        relayFqdn: route.mullvad.exit.relayFqdn,
        socksHostname: route.mullvad.exit.socksHostname,
        socksPort: route.mullvad.exit.socksPort,
        countryCode: route.mullvad.exit.countryCode,
        cityCode: route.mullvad.exit.cityCode,
      },
      listeners: {
        socks5: `${listenerHost}:${socks5Port}`,
        http: `${listenerHost}:${httpPort}`,
        https: https.enabled && httpsPort !== null ? `${listenerHost}:${httpsPort}` : null,
      },
      services: {
        routeProxy: {
          name: ROUTE_PROXY_SERVICE,
        },
        backends: {
          https: https.enabled ? route.runtime.httpsBackendName : null,
        },
      },
      publishedEndpoints: routeEndpoints,
    };
  });

  return {
    generatedAt,
    source: 'canonical-config',
    topology: 'shared-entry-wireguard-route-proxy-haproxy',
    relayCachePath: paths.provisioningCacheFile,
    images: {
      wireproxy: WIREPROXY_IMAGE,
      routeProxy: ROUTE_PROXY_IMAGE,
      routingLayer: HAPROXY_IMAGE,
    },
    services: {
      entryTunnel: {
        name: ENTRY_TUNNEL_SERVICE,
        internalListeners: {
          socks5: `127.0.0.1:${ENTRY_WIREPROXY_SOCKS_PORT}`,
          http: `127.0.0.1:${ENTRY_WIREPROXY_HTTP_PORT}`,
        },
        networkMode: HOST_NETWORK_MODE,
        mountPaths: {
          entryWireproxyConfigPath: paths.entryWireproxyConfigFile,
        },
      },
      routeProxy: {
        name: ROUTE_PROXY_SERVICE,
        listeners: {
          socks5:
            config.setup.exposure.mode === 'private-network'
              ? `shared host ${CONTAINER_BIND_HOST} with per-route ports starting at ${config.setup.bind.socksPort}`
              : `per-route bind IPs on port ${config.setup.bind.socksPort}`,
          http:
            config.setup.exposure.mode === 'private-network'
              ? `shared host ${CONTAINER_BIND_HOST} with per-route ports starting at ${config.setup.bind.httpPort}`
              : `per-route bind IPs on port ${config.setup.bind.httpPort}`,
        },
        networkMode: HOST_NETWORK_MODE,
        mountPaths: {
          routeProxyConfigPath: paths.routeProxyConfigFile,
        },
      },
      routingLayer: {
        name: ROUTING_LAYER_SERVICE,
        listeners: {
          https: https.enabled
            ? config.setup.exposure.mode === 'private-network'
              ? `shared host ${CONTAINER_BIND_HOST} with per-route ports starting at ${https.port}`
              : `per-route bind IPs on port ${https.port}`
            : null,
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
  _config: MullgateConfig,
  paths: MullgatePaths,
  https: Extract<ResolvedHttpsRuntime, { ok: true }>,
): string {
  const lines = [
    '# Generated by Mullgate. Derived artifact; edit canonical config instead.',
    'name: mullgate',
    'services:',
    `  ${ENTRY_TUNNEL_SERVICE}:`,
    `    image: ${WIREPROXY_IMAGE}`,
    '    user: "0:0"',
    '    network_mode: host',
    '    restart: unless-stopped',
    '    command:',
    '      - --config',
    `      - ${ENTRY_WIREPROXY_CONFIG_CONTAINER_PATH}`,
    '    volumes:',
    `      - ${paths.entryWireproxyConfigFile}:${ENTRY_WIREPROXY_CONFIG_CONTAINER_PATH}:ro`,
    `  ${ROUTE_PROXY_SERVICE}:`,
    `    image: ${ROUTE_PROXY_IMAGE}`,
    '    user: "0:0"',
    '    network_mode: host',
    '    restart: unless-stopped',
    '    depends_on:',
    `      - ${ENTRY_TUNNEL_SERVICE}`,
    '    entrypoint:',
    '      - /bin/3proxy',
    `      - ${ROUTE_PROXY_CONFIG_CONTAINER_PATH}`,
    '    volumes:',
    `      - ${paths.routeProxyConfigFile}:${ROUTE_PROXY_CONFIG_CONTAINER_PATH}:ro`,
    `  ${ROUTING_LAYER_SERVICE}:`,
    `    image: ${HAPROXY_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    `      - ${ROUTE_PROXY_SERVICE}`,
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

  return `${lines.join('\n')}\n`;
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

  if (https.enabled && config.setup.exposure.mode === 'private-network') {
    for (const [index, route] of config.routing.locations.entries()) {
      const publishedPort = computePublishedPort(config.setup.exposure.mode, https.port, index);
      lines.push(
        `frontend https_proxy_${route.runtime.routeId}`,
        `  bind ${CONTAINER_BIND_HOST}:${publishedPort} ssl crt ${HAPROXY_COMBINED_PEM_PATH}`,
        `  default_backend ${route.runtime.httpsBackendName}`,
        '',
      );
    }
  } else if (https.enabled) {
    const primaryRoute = requireDefined(
      config.routing.locations[0],
      'Expected at least one routed location when rendering the HTTPS runtime bundle.',
    );
    lines.push(
      'frontend https_proxy',
      `  bind ${CONTAINER_BIND_HOST}:${https.port} ssl crt ${HAPROXY_COMBINED_PEM_PATH}`,
      ...buildRouteSelectionRules(config.routing.locations),
      `  default_backend ${primaryRoute.runtime.httpsBackendName}`,
      '',
    );
  }

  for (const route of config.routing.locations) {
    if (https.enabled) {
      lines.push(
        `backend ${route.runtime.httpsBackendName}`,
        `  server ${route.runtime.routeId} ${deriveRuntimeBackendHost(config.setup.exposure.mode, route.bindIp)}:${resolveHttpBackendPort(config, route.runtime.routeId)} check`,
        '',
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildRouteSelectionRules(routes: readonly RoutedLocation[]): string[] {
  return routes.flatMap((route) => {
    const aclName = `route_${route.runtime.routeId.replace(/[^a-zA-Z0-9]/g, '_')}_https`;
    return [
      `  acl ${aclName} dst ${route.bindIp}`,
      `  use_backend ${route.runtime.httpsBackendName} if ${aclName}`,
    ];
  });
}

function resolveHttpBackendPort(config: MullgateConfig, routeId: string): number {
  const routeIndex = config.routing.locations.findIndex(
    (route) => route.runtime.routeId === routeId,
  );
  return computePublishedPort(
    config.setup.exposure.mode,
    config.setup.bind.httpPort,
    routeIndex < 0 ? 0 : routeIndex,
  );
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
}

async function writeFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  let fileHandle: FileHandle | undefined;
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

    if (process.platform === 'win32') {
      return;
    }

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
