import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { REDACTED } from '../config/redact.js';
import type { MullgatePaths } from '../config/paths.js';
import type { MullgateConfig } from '../config/schema.js';

const CONTAINER_BIND_HOST = '0.0.0.0';
const WIREPROXY_IMAGE = 'backplane/wireproxy:20260320';
const WIREPROXY_SERVICE = 'wireproxy';
const HAPROXY_IMAGE = 'haproxytech/haproxy-alpine:3.0.19';
const HAPROXY_SERVICE = 'https-sidecar';
const HAPROXY_CONFIG_CONTAINER_PATH = '/usr/local/etc/haproxy/haproxy.cfg';
const HAPROXY_CERT_INPUT_PATH = '/run/mullgate/tls-input/cert.pem';
const HAPROXY_KEY_INPUT_PATH = '/run/mullgate/tls-input/key.pem';
const HAPROXY_COMBINED_PEM_PATH = '/run/mullgate/tls/haproxy.pem';
const HAPROXY_TLS_TMPFS_PATH = '/run/mullgate/tls';
const WIREPROXY_CONFIG_CONTAINER_PATH = '/etc/wireproxy/wireproxy.conf';

export type RuntimeEndpoint = {
  readonly protocol: 'socks5' | 'http' | 'https';
  readonly host: string;
  readonly port: number;
  readonly containerHost: '0.0.0.0';
  readonly containerPort: number;
  readonly auth: {
    readonly username: string;
    readonly password: typeof REDACTED;
  };
  readonly proxyUrl: string;
};

export type RuntimeBundleManifest = {
  readonly generatedAt: string;
  readonly source: 'canonical-config';
  readonly topology: 'wireproxy-haproxy-sidecar';
  readonly bindHost: string;
  readonly wireproxyConfigPath: string;
  readonly relayCachePath: string;
  readonly images: {
    readonly wireproxy: string;
    readonly httpsSidecar: string;
  };
  readonly services: {
    readonly wireproxy: {
      readonly internalListeners: {
        readonly socks5: string;
        readonly http: string;
      };
      readonly publishedPorts: string[];
    };
    readonly httpsSidecar: {
      readonly enabled: boolean;
      readonly internalListener: string | null;
      readonly publishedPort: string | null;
      readonly forwardsTo: string | null;
      readonly mountPaths: {
        readonly haproxyConfigPath: string;
        readonly certPath: string | null;
        readonly keyPath: string | null;
        readonly combinedPemPath: string | null;
      };
    };
  };
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

function buildPublishedEndpoints(config: MullgateConfig, https: Extract<ResolvedHttpsRuntime, { ok: true }>): RuntimeEndpoint[] {
  const endpoints: RuntimeEndpoint[] = [
    createEndpoint(config, 'socks5', config.setup.bind.socksPort),
    createEndpoint(config, 'http', config.setup.bind.httpPort),
  ];

  if (https.enabled) {
    endpoints.push(createEndpoint(config, 'https', https.port));
  }

  return endpoints;
}

function createEndpoint(config: MullgateConfig, protocol: RuntimeEndpoint['protocol'], port: number): RuntimeEndpoint {
  return {
    protocol,
    host: config.setup.bind.host,
    port,
    containerHost: CONTAINER_BIND_HOST,
    containerPort: port,
    auth: {
      username: config.setup.auth.username,
      password: REDACTED,
    },
    proxyUrl: `${protocol}://${encodeURIComponent(config.setup.auth.username)}:${REDACTED}@${config.setup.bind.host}:${port}`,
  };
}

function buildRuntimeBundleManifest(
  config: MullgateConfig,
  paths: MullgatePaths,
  generatedAt: string,
  https: Extract<ResolvedHttpsRuntime, { ok: true }>,
  publishedEndpoints: readonly RuntimeEndpoint[],
): RuntimeBundleManifest {
  return {
    generatedAt,
    source: 'canonical-config',
    topology: 'wireproxy-haproxy-sidecar',
    bindHost: config.setup.bind.host,
    wireproxyConfigPath: paths.wireproxyConfigFile,
    relayCachePath: paths.provisioningCacheFile,
    images: {
      wireproxy: WIREPROXY_IMAGE,
      httpsSidecar: HAPROXY_IMAGE,
    },
    services: {
      wireproxy: {
        internalListeners: {
          socks5: `${CONTAINER_BIND_HOST}:${config.setup.bind.socksPort}`,
          http: `${CONTAINER_BIND_HOST}:${config.setup.bind.httpPort}`,
        },
        publishedPorts: [
          `${config.setup.bind.host}:${config.setup.bind.socksPort}:${config.setup.bind.socksPort}`,
          `${config.setup.bind.host}:${config.setup.bind.httpPort}:${config.setup.bind.httpPort}`,
        ],
      },
      httpsSidecar: {
        enabled: https.enabled,
        internalListener: https.enabled ? `${CONTAINER_BIND_HOST}:${https.port}` : null,
        publishedPort: https.enabled ? `${config.setup.bind.host}:${https.port}:${https.port}` : null,
        forwardsTo: https.enabled ? `${WIREPROXY_SERVICE}:${config.setup.bind.httpPort}` : null,
        mountPaths: {
          haproxyConfigPath: paths.runtimeHttpsSidecarConfigFile,
          certPath: https.enabled ? https.certPath : null,
          keyPath: https.enabled ? https.keyPath : null,
          combinedPemPath: https.enabled ? HAPROXY_COMBINED_PEM_PATH : null,
        },
      },
    },
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
    `  ${WIREPROXY_SERVICE}:`,
    `    image: ${WIREPROXY_IMAGE}`,
    '    user: "0:0"',
    '    restart: unless-stopped',
    '    command:',
    '      - --config',
    `      - ${WIREPROXY_CONFIG_CONTAINER_PATH}`,
    '    volumes:',
    `      - ${paths.wireproxyConfigFile}:${WIREPROXY_CONFIG_CONTAINER_PATH}:ro`,
    '    ports:',
    `      - "${config.setup.bind.host}:${config.setup.bind.socksPort}:${config.setup.bind.socksPort}"`,
    `      - "${config.setup.bind.host}:${config.setup.bind.httpPort}:${config.setup.bind.httpPort}"`,
  ];

  if (https.enabled) {
    lines.push(
      `  ${HAPROXY_SERVICE}:`,
      `    image: ${HAPROXY_IMAGE}`,
      '    restart: unless-stopped',
      '    depends_on:',
      `      - ${WIREPROXY_SERVICE}`,
      '    entrypoint:',
      '      - /bin/sh',
      '      - -ec',
      // The combined PEM is constructed inside the container so the rendered artifacts never persist TLS private key material.
      `      - cat ${HAPROXY_CERT_INPUT_PATH} ${HAPROXY_KEY_INPUT_PATH} > ${HAPROXY_COMBINED_PEM_PATH} && exec haproxy -W -db -f ${HAPROXY_CONFIG_CONTAINER_PATH}`,
      '    tmpfs:',
      `      - ${HAPROXY_TLS_TMPFS_PATH}`,
      '    volumes:',
      `      - ${paths.runtimeHttpsSidecarConfigFile}:${HAPROXY_CONFIG_CONTAINER_PATH}:ro`,
      `      - ${https.certPath}:${HAPROXY_CERT_INPUT_PATH}:ro`,
      `      - ${https.keyPath}:${HAPROXY_KEY_INPUT_PATH}:ro`,
      '    ports:',
      `      - "${config.setup.bind.host}:${https.port}:${https.port}"`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function buildHttpsSidecarConfig(
  config: MullgateConfig,
  https: Extract<ResolvedHttpsRuntime, { ok: true }>,
): string {
  if (!https.enabled) {
    return '# HTTPS proxy is disabled in the canonical config.\n';
  }

  return [
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
    'frontend https_proxy',
    `  bind ${CONTAINER_BIND_HOST}:${https.port} ssl crt ${HAPROXY_COMBINED_PEM_PATH}`,
    '  default_backend wireproxy_http',
    '',
    'backend wireproxy_http',
    `  server wireproxy ${WIREPROXY_SERVICE}:${config.setup.bind.httpPort} check`,
    '',
  ].join('\n');
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
