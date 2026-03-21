import { chmodSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createStartCommandAction } from '../../src/commands/start.js';
import { resolveMullgatePaths } from '../../src/config/paths.js';
import { ConfigStore } from '../../src/config/store.js';
import { CONFIG_VERSION, type MullgateConfig, type RuntimeStartDiagnostic } from '../../src/config/schema.js';
import { normalizeRelayPayload } from '../../src/mullvad/fetch-relays.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const fixturesDir = path.join(repoRoot, 'test/fixtures/mullvad');
const temporaryDirectories: string[] = [];

type BufferSink = {
  readonly value: { current: string };
  write(chunk: string): boolean;
};

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-start-command-'));
  temporaryDirectories.push(root);

  return {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

function createFixtureConfig(env: NodeJS.ProcessEnv): MullgateConfig {
  const paths = resolveMullgatePaths(env);
  const timestamp = '2026-03-21T00:58:00.000Z';

  return {
    version: CONFIG_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    setup: {
      source: 'guided-setup',
      bind: {
        host: '127.0.0.1',
        socksPort: 1080,
        httpPort: 8080,
        httpsPort: 8443,
      },
      auth: {
        username: 'alice',
        password: 'proxy-password',
      },
      exposure: {
        mode: 'loopback',
        allowLan: false,
      },
      location: {
        requested: 'sweden-gothenburg',
        country: 'se',
        city: 'got',
        hostnameLabel: 'se-got-wg-101',
        resolvedAlias: 'sweden-gothenburg',
      },
      https: {
        enabled: true,
        certPath: path.join(env.HOME!, 'certs', 'proxy.crt'),
        keyPath: path.join(env.HOME!, 'certs', 'proxy.key'),
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: 'mullgate-start-test-1',
      lastProvisionedAt: timestamp,
      relayConstraints: {
        providers: [],
      },
      wireguard: {
        publicKey: 'public-key-value-1',
        privateKey: 'private-key-value-1',
        ipv4Address: '10.64.12.34/32',
        ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1234/128',
        gatewayIpv4: '10.64.0.1',
        gatewayIpv6: 'fc00:bbbb:bbbb:bb01::1',
        dnsServers: ['10.64.0.1'],
        peerPublicKey: 'peer-public-key-value-1',
        peerEndpoint: 'se-got-wg-101.relays.mullvad.net:3401',
      },
    },
    routing: {
      locations: [
        {
          alias: 'sweden-gothenburg',
          hostname: 'se-got-wg-101',
          bindIp: '127.0.0.1',
          relayPreference: {
            requested: 'sweden-gothenburg',
            country: 'se',
            city: 'got',
            hostnameLabel: 'se-got-wg-101',
            resolvedAlias: 'sweden-gothenburg',
          },
          mullvad: {
            accountNumber: '123456789012',
            deviceName: 'mullgate-start-test-1',
            lastProvisionedAt: timestamp,
            relayConstraints: {
              providers: [],
            },
            wireguard: {
              publicKey: 'public-key-value-1',
              privateKey: 'private-key-value-1',
              ipv4Address: '10.64.12.34/32',
              ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1234/128',
              gatewayIpv4: '10.64.0.1',
              gatewayIpv6: 'fc00:bbbb:bbbb:bb01::1',
              dnsServers: ['10.64.0.1'],
              peerPublicKey: 'peer-public-key-value-1',
              peerEndpoint: 'se-got-wg-101.relays.mullvad.net:3401',
            },
          },
          runtime: {
            routeId: 'se-got-wg-101',
            wireproxyServiceName: 'wireproxy-se-got-wg-101',
            haproxyBackendName: 'route-se-got-wg-101',
            wireproxyConfigFile: 'wireproxy-se-got-wg-101.conf',
          },
        },
        {
          alias: 'austria-vienna',
          hostname: 'at-vie-wg-001',
          bindIp: '127.0.0.2',
          relayPreference: {
            requested: 'austria-vienna',
            country: 'at',
            city: 'vie',
            hostnameLabel: 'at-vie-wg-001',
            resolvedAlias: 'austria-vienna',
          },
          mullvad: {
            accountNumber: '123456789012',
            deviceName: 'mullgate-start-test-2',
            lastProvisionedAt: timestamp,
            relayConstraints: {
              providers: [],
            },
            wireguard: {
              publicKey: 'public-key-value-2',
              privateKey: 'private-key-value-2',
              ipv4Address: '10.64.12.35/32',
              ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1235/128',
              gatewayIpv4: '10.64.0.1',
              gatewayIpv6: 'fc00:bbbb:bbbb:bb01::1',
              dnsServers: ['10.64.0.1'],
              peerPublicKey: 'peer-public-key-value-2',
              peerEndpoint: 'at-vie-wg-001.relays.mullvad.net:51820',
            },
          },
          runtime: {
            routeId: 'at-vie-wg-001',
            wireproxyServiceName: 'wireproxy-at-vie-wg-001',
            haproxyBackendName: 'route-at-vie-wg-001',
            wireproxyConfigFile: 'wireproxy-at-vie-wg-001.conf',
          },
        },
      ],
    },
    runtime: {
      backend: 'wireproxy',
      sourceConfigPath: paths.configFile,
      wireproxyConfigPath: paths.wireproxyConfigFile,
      wireproxyConfigTestReportPath: paths.wireproxyConfigTestReportFile,
      relayCachePath: paths.provisioningCacheFile,
      dockerComposePath: paths.dockerComposePath,
      runtimeBundle: {
        bundleDir: paths.runtimeBundleDir,
        dockerComposePath: paths.runtimeComposeFile,
        httpsSidecarConfigPath: paths.runtimeHttpsSidecarConfigFile,
        manifestPath: paths.runtimeBundleManifestFile,
      },
      status: {
        phase: 'validated',
        lastCheckedAt: timestamp,
        message: 'Fixture config already validated.',
      },
    },
    diagnostics: {
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

function createBufferSink(): BufferSink {
  const value = { current: '' };

  return {
    value,
    write(chunk: string) {
      value.current += chunk;
      return true;
    },
  };
}

async function readRelayCatalogFixture(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixturesDir, 'app-relays.json'), 'utf8')) as unknown;
}

async function createFakeWireproxyBinary(root: string): Promise<string> {
  const binDir = path.join(root, 'bin');
  const binaryPath = path.join(binDir, 'wireproxy');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    binaryPath,
    [
      '#!/bin/sh',
      'if [ "$1" != "--configtest" ]; then',
      '  echo "unsupported fake wireproxy invocation" >&2',
      '  exit 1',
      'fi',
      'config="$2"',
      'if grep -q "^Address = " "$config" && grep -q "^\\[Peer\\]" "$config" && grep -q "^\\[Socks5\\]" "$config" && grep -q "^\\[http\\]" "$config"; then',
      '  exit 0',
      'fi',
      'echo "fake wireproxy configtest: invalid rendered config at $config" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

async function seedSavedConfig(env: NodeJS.ProcessEnv): Promise<ConfigStore> {
  const paths = resolveMullgatePaths(env);
  const store = new ConfigStore(paths);
  const config = createFixtureConfig(env);
  const relayPayload = await readRelayCatalogFixture();
  const normalizedCatalog = normalizeRelayPayload(relayPayload, {
    endpoint: 'https://api.mullvad.net/public/relays/wireguard/v1/',
    fetchedAt: '2026-03-21T00:59:00.000Z',
  });

  if (!normalizedCatalog.ok) {
    throw new Error(`Fixture relay payload failed to normalize: ${normalizedCatalog.message}`);
  }

  await store.save(config);
  await mkdir(path.dirname(paths.provisioningCacheFile), { recursive: true, mode: 0o700 });
  await writeFile(paths.provisioningCacheFile, `${JSON.stringify(normalizedCatalog.value, null, 2)}\n`, { mode: 0o600 });
  await mkdir(path.dirname(config.setup.https.certPath!), { recursive: true, mode: 0o700 });
  await writeFile(config.setup.https.certPath!, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n', {
    mode: 0o600,
  });
  await writeFile(config.setup.https.keyPath!, '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n', {
    mode: 0o600,
  });

  return store;
}

function normalizeOutput(value: string, env: NodeJS.ProcessEnv): string {
  return value.split(env.HOME!).join('/tmp/mullgate-home').trimEnd();
}

function normalizeReport(report: RuntimeStartDiagnostic, env: NodeJS.ProcessEnv): string {
  return JSON.stringify(report, null, 2).split(env.HOME!).join('/tmp/mullgate-home');
}

afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('mullgate start command', () => {
  it('re-renders the multi-route runtime bundle and persists a successful start report', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const store = await seedSavedConfig(env);
    const stdout = createBufferSink();
    const stderr = createBufferSink();
    const wireproxyBinary = await createFakeWireproxyBinary(env.HOME!);
    let launchedComposeFile: string | null = null;

    await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.wireproxyConfigFile, '# stale wireproxy artifact\n', 'utf8');
    await writeFile(paths.runtimeComposeFile, '# stale compose artifact\n', 'utf8');

    const action = createStartCommandAction({
      store,
      checkedAt: '2026-03-21T01:00:00.000Z',
      stdout,
      stderr,
      validateOptions: {
        wireproxyBinary,
      },
      startRuntime: async (options) => {
        launchedComposeFile = options.composeFilePath;

        return {
          ok: true,
          phase: 'compose-launch',
          source: 'docker-compose',
          checkedAt: '2026-03-21T01:00:00.000Z',
          composeFilePath: options.composeFilePath,
          command: {
            binary: 'docker',
            args: ['compose', '--file', options.composeFilePath, 'up', '--detach'],
            cwd: path.dirname(options.composeFilePath),
            rendered: `docker compose --file ${options.composeFilePath} up --detach`,
          },
          message: 'Docker Compose launched the Mullgate runtime bundle in detached mode.',
          stdout: 'Container mullgate-routing-layer-1  Started\nContainer mullgate-wireproxy-se-got-wg-101-1  Started\nContainer mullgate-wireproxy-at-vie-wg-001-1  Started\n',
          stderr: '',
        };
      },
    });

    await action();

    expect(process.exitCode).toBe(0);
    expect(stderr.value.current).toBe('');
    expect(launchedComposeFile).toBe(paths.runtimeComposeFile);

    const savedConfigResult = await store.load();
    expect(savedConfigResult.ok && savedConfigResult.source === 'file').toBe(true);

    if (!savedConfigResult.ok || savedConfigResult.source !== 'file') {
      return;
    }

    const savedConfig = savedConfigResult.config;
    const persistedReport = JSON.parse(await readFile(paths.runtimeStartDiagnosticsFile, 'utf8')) as RuntimeStartDiagnostic;
    const renderedPrimaryWireproxyConfig = await readFile(paths.wireproxyConfigFile, 'utf8');
    const renderedRouteOneConfig = await readFile(path.join(paths.runtimeDir, 'wireproxy-se-got-wg-101.conf'), 'utf8');
    const renderedRouteTwoConfig = await readFile(path.join(paths.runtimeDir, 'wireproxy-at-vie-wg-001.conf'), 'utf8');
    const renderedCompose = await readFile(paths.runtimeComposeFile, 'utf8');
    const renderedManifest = JSON.parse(await readFile(paths.runtimeBundleManifestFile, 'utf8')) as { routes: Array<{ routeId: string }> };

    expect(renderedPrimaryWireproxyConfig).not.toContain('# stale wireproxy artifact');
    expect(renderedPrimaryWireproxyConfig).toContain('Password = proxy-password');
    expect(renderedRouteOneConfig).toContain('# Route se-got-wg-101 (se-got-wg-101 -> 127.0.0.1)');
    expect(renderedRouteTwoConfig).toContain('# Route at-vie-wg-001 (at-vie-wg-001 -> 127.0.0.2)');
    expect(renderedCompose).not.toContain('# stale compose artifact');
    expect(renderedCompose).toContain('routing-layer');
    expect(renderedCompose).toContain('wireproxy-at-vie-wg-001');
    expect(renderedManifest.routes.map((route) => route.routeId)).toEqual(['se-got-wg-101', 'at-vie-wg-001']);
    expect(savedConfig.runtime.status).toMatchObject({
      phase: 'running',
      lastCheckedAt: '2026-03-21T01:00:00.000Z',
      message: 'Runtime started via docker-compose using wireproxy-binary/configtest (2 routes).',
    });
    expect(savedConfig.diagnostics.lastRuntimeStart).toEqual(persistedReport);
    expect('\n' + normalizeOutput(stdout.value.current, env)).toMatchInlineSnapshot(`
"\nMullgate runtime started.
phase: compose-launch
source: docker-compose
attempted at: 2026-03-21T01:00:00.000Z
routes: 2
config: /tmp/mullgate-home/config/mullgate/config.json
primary wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
runtime manifest: /tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json
validation report: /tmp/mullgate-home/state/mullgate/runtime/wireproxy-at-vie-wg-001-configtest.json
validation: wireproxy-binary/configtest (2 routes)
runtime status: running"
`);
    expect('\n' + normalizeReport(persistedReport, env)).toMatchInlineSnapshot(`
"\n{
  \"attemptedAt\": \"2026-03-21T01:00:00.000Z\",
  \"status\": \"success\",
  \"phase\": \"compose-launch\",
  \"source\": \"docker-compose\",
  \"code\": null,
  \"message\": \"Docker Compose launched the Mullgate runtime bundle in detached mode.\",
  \"cause\": null,
  \"artifactPath\": \"/tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml\",
  \"composeFilePath\": \"/tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml\",
  \"validationSource\": \"wireproxy-binary/configtest (2 routes)\",
  \"routeId\": null,
  \"routeHostname\": null,
  \"routeBindIp\": null,
  \"serviceName\": null,
  \"command\": \"docker compose --file /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml up --detach\"
}"
`);
  });

  it('persists secret-safe route-aware compose failure diagnostics with phase, source, code, and validation metadata', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const store = await seedSavedConfig(env);
    const stdout = createBufferSink();
    const stderr = createBufferSink();
    const wireproxyBinary = await createFakeWireproxyBinary(env.HOME!);

    const action = createStartCommandAction({
      store,
      checkedAt: '2026-03-21T01:05:00.000Z',
      stdout,
      stderr,
      validateOptions: {
        wireproxyBinary,
      },
      startRuntime: async (options) => ({
        ok: false,
        phase: 'compose-launch',
        source: 'docker-compose',
        checkedAt: '2026-03-21T01:05:00.000Z',
        code: 'COMPOSE_UP_FAILED',
        composeFilePath: options.composeFilePath,
        command: {
          binary: 'docker',
          args: ['compose', '--file', options.composeFilePath, 'up', '--detach'],
          cwd: path.dirname(options.composeFilePath),
          rendered: `docker compose --file ${options.composeFilePath} up --detach`,
        },
        message: 'Docker Compose failed to start the Mullgate runtime bundle.',
        cause:
          'service wireproxy-at-vie-wg-001 crashed for proxy-password / 123456789012 / private-key-value-2 while reading -----BEGIN PRIVATE KEY-----\\nfixture\\n-----END PRIVATE KEY-----',
        artifactPath: options.composeFilePath,
        exitCode: 1,
      }),
    });

    await action();

    expect(process.exitCode).toBe(1);
    expect(stdout.value.current).toBe('');
    expect(stderr.value.current).not.toContain('proxy-password');
    expect(stderr.value.current).not.toContain('123456789012');
    expect(stderr.value.current).not.toContain('private-key-value-2');
    expect(stderr.value.current).not.toContain('BEGIN PRIVATE KEY');

    const savedConfigResult = await store.load();
    expect(savedConfigResult.ok && savedConfigResult.source === 'file').toBe(true);

    if (!savedConfigResult.ok || savedConfigResult.source !== 'file') {
      return;
    }

    const savedConfig = savedConfigResult.config;
    const persistedReport = JSON.parse(await readFile(paths.runtimeStartDiagnosticsFile, 'utf8')) as RuntimeStartDiagnostic;

    expect(savedConfig.runtime.status).toMatchObject({
      phase: 'error',
      lastCheckedAt: '2026-03-21T01:05:00.000Z',
      message: 'Docker Compose failed to start the Mullgate runtime bundle.',
    });
    expect(savedConfig.diagnostics.lastRuntimeStart).toEqual(persistedReport);
    expect(savedConfig.diagnostics.lastRuntimeStart?.routeId).toBe('at-vie-wg-001');
    expect(savedConfig.diagnostics.lastRuntimeStart?.routeHostname).toBe('at-vie-wg-001');
    expect(savedConfig.diagnostics.lastRuntimeStart?.routeBindIp).toBe('127.0.0.2');
    expect(savedConfig.diagnostics.lastRuntimeStart?.serviceName).toBe('wireproxy-at-vie-wg-001');
    expect(savedConfig.diagnostics.lastRuntimeStart?.cause).toContain('[redacted]');
    expect(savedConfig.diagnostics.lastRuntimeStart?.cause).not.toContain('proxy-password');
    expect(savedConfig.diagnostics.lastRuntimeStart?.cause).not.toContain('123456789012');
    expect(savedConfig.diagnostics.lastRuntimeStart?.cause).not.toContain('private-key-value-2');
    expect('\n' + normalizeOutput(stderr.value.current, env)).toMatchInlineSnapshot(`
"\nMullgate start failed.
phase: compose-launch
source: docker-compose
attempted at: 2026-03-21T01:05:00.000Z
code: COMPOSE_UP_FAILED
route id: at-vie-wg-001
route hostname: at-vie-wg-001
route bind ip: 127.0.0.2
service: wireproxy-at-vie-wg-001
artifact: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
command: docker compose --file /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml up --detach
reason: Docker Compose failed to start the Mullgate runtime bundle.
cause: service wireproxy-at-vie-wg-001 crashed for [redacted] / [redacted] / [redacted] while reading [redacted]
config: /tmp/mullgate-home/config/mullgate/config.json
validation: wireproxy-binary/configtest (2 routes)
start report: /tmp/mullgate-home/state/mullgate/runtime/last-start.json
runtime status: error"
`);
    expect('\n' + normalizeReport(persistedReport, env)).toMatchInlineSnapshot(`
"\n{
  \"attemptedAt\": \"2026-03-21T01:05:00.000Z\",
  \"status\": \"failure\",
  \"phase\": \"compose-launch\",
  \"source\": \"docker-compose\",
  \"code\": \"COMPOSE_UP_FAILED\",
  \"message\": \"Docker Compose failed to start the Mullgate runtime bundle.\",
  \"cause\": \"service wireproxy-at-vie-wg-001 crashed for [redacted] / [redacted] / [redacted] while reading [redacted]\",
  \"artifactPath\": \"/tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml\",
  \"composeFilePath\": \"/tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml\",
  \"validationSource\": \"wireproxy-binary/configtest (2 routes)\",
  \"routeId\": \"at-vie-wg-001\",
  \"routeHostname\": \"at-vie-wg-001\",
  \"routeBindIp\": \"127.0.0.2\",
  \"serviceName\": \"wireproxy-at-vie-wg-001\",
  \"command\": \"docker compose --file /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml up --detach\"
}"
`);
  });
});
