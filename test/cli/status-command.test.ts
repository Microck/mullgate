import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createStatusCommandAction } from '../../src/commands/status.js';
import { resolveMullgatePaths } from '../../src/config/paths.js';
import {
  CONFIG_VERSION,
  type MullgateConfig,
  type RuntimeStartDiagnostic,
} from '../../src/config/schema.js';
import { ConfigStore } from '../../src/config/store.js';
import type { DockerComposeStatusResult } from '../../src/runtime/docker-runtime.js';
import { renderRuntimeBundle } from '../../src/runtime/render-runtime-bundle.js';
import { createFixtureRoute, createFixtureRuntime } from '../helpers/mullgate-fixtures.js';
import { normalizeFixtureHomePath } from '../helpers/platform-test-utils.js';

const temporaryDirectories: string[] = [];

type BufferSink = {
  readonly value: { current: string };
  write(chunk: string): boolean;
};

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-status-command-'));
  const linuxRoot = root.replaceAll('\\', '/');
  temporaryDirectories.push(root);

  return {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: linuxRoot,
    XDG_CONFIG_HOME: `${linuxRoot}/config`,
    XDG_STATE_HOME: `${linuxRoot}/state`,
    XDG_CACHE_HOME: `${linuxRoot}/cache`,
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

function createFixtureConfig(env: NodeJS.ProcessEnv): MullgateConfig {
  const paths = resolveMullgatePaths(env);
  const timestamp = '2026-03-21T07:00:00.000Z';

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
        httpsPort: null,
      },
      auth: {
        username: 'alice',
        password: 'proxy-password',
      },
      access: {
        mode: 'published-routes',
        allowUnsafePublicEmptyPassword: false,
      },
      exposure: {
        mode: 'loopback',
        allowLan: false,
        baseDomain: null,
      },
      location: {
        requested: 'sweden-gothenburg',
        country: 'se',
        city: 'got',
        hostnameLabel: 'se-got-wg-101',
        resolvedAlias: 'sweden-gothenburg',
      },
      https: {
        enabled: false,
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: 'mullgate-status-test-1',
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
        createFixtureRoute({
          alias: 'sweden-gothenburg',
          hostname: 'se-got-wg-101',
          bindIp: '127.0.0.1',
          requested: 'sweden-gothenburg',
          country: 'se',
          city: 'got',
          hostnameLabel: 'se-got-wg-101',
          resolvedAlias: 'sweden-gothenburg',
        }),
        createFixtureRoute({
          alias: 'austria-vienna',
          hostname: 'at-vie-wg-001',
          bindIp: '127.0.0.2',
          requested: 'austria-vienna',
          country: 'at',
          city: 'vie',
          hostnameLabel: 'at-vie-wg-001',
          resolvedAlias: 'austria-vienna',
        }),
      ],
    },
    runtime: createFixtureRuntime({
      paths,
      status: {
        phase: 'validated',
        lastCheckedAt: timestamp,
        message: 'Fixture config already validated.',
      },
    }),
    diagnostics: {
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

async function seedSavedConfig(
  env: NodeJS.ProcessEnv,
  options: {
    readonly configure?: (config: MullgateConfig) => MullgateConfig;
    readonly lastStart?: RuntimeStartDiagnostic | null;
    readonly renderManifest?: boolean;
  } = {},
): Promise<{
  readonly store: ConfigStore;
  readonly paths: ReturnType<typeof resolveMullgatePaths>;
  readonly config: MullgateConfig;
}> {
  const paths = resolveMullgatePaths(env);
  const store = new ConfigStore(paths);
  const config = options.configure
    ? options.configure(createFixtureConfig(env))
    : createFixtureConfig(env);

  await store.save(config);

  if (options.renderManifest ?? true) {
    const bundleResult = await renderRuntimeBundle({
      config,
      paths,
      generatedAt: config.updatedAt,
    });

    if (!bundleResult.ok) {
      throw new Error(`Failed to render runtime bundle fixture: ${bundleResult.message}`);
    }
  }

  if (options.lastStart) {
    await mkdir(path.dirname(paths.runtimeStartDiagnosticsFile), { recursive: true, mode: 0o700 });
    await writeFile(
      paths.runtimeStartDiagnosticsFile,
      `${JSON.stringify(options.lastStart, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  return { store, paths, config };
}

function normalizeOutput(value: string, env: NodeJS.ProcessEnv): string {
  return normalizeFixtureHomePath(value, env.HOME).trimEnd();
}

function createComposeStatusSuccess(
  composeFilePath: string,
  containers: NonNullable<Extract<DockerComposeStatusResult, { ok: true }>['containers']>,
): Extract<DockerComposeStatusResult, { ok: true }> {
  const running = containers.filter((container) => container.state === 'running').length;
  const healthy = containers.filter(
    (container) => container.health === 'healthy' || container.health === null,
  ).length;
  const starting = containers.filter(
    (container) => container.health === 'starting' || container.state === 'restarting',
  ).length;
  const stopped = containers.filter((container) => container.state === 'exited').length;
  const unhealthy = containers.filter((container) => container.health === 'unhealthy').length;

  return {
    ok: true,
    phase: 'compose-ps',
    source: 'docker-compose',
    checkedAt: '2026-03-21T07:10:00.000Z',
    composeFilePath,
    command: {
      binary: 'docker',
      args: ['compose', '--file', composeFilePath, 'ps', '--all', '--format', 'json'],
      cwd: path.dirname(composeFilePath),
      rendered: `docker compose --file ${composeFilePath} ps --all --format json`,
    },
    message:
      containers.length > 0
        ? `Docker Compose reported ${containers.length} Mullgate container(s) from typed JSON status.`
        : 'Docker Compose reported no Mullgate containers for the runtime bundle.',
    project: containers[0]?.project ?? null,
    containers,
    summary: {
      total: containers.length,
      running,
      healthy,
      starting,
      stopped,
      unhealthy,
    },
  };
}

afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('mullgate status command', () => {
  it('reports an unconfigured install without crashing', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createStatusCommandAction({
      store,
      stdout,
      stderr,
      inspectRuntime: async (options) => createComposeStatusSuccess(options.composeFilePath, []),
    });

    await action();

    expect(process.exitCode).toBe(0);
    expect(stderr.value.current).toBe('');
    expect(`\n${normalizeOutput(stdout.value.current, env)}`).toMatchInlineSnapshot(`
"\nMullgate runtime status
phase: unconfigured
config: /tmp/mullgate-home/config/mullgate/config.json
runtime dir: /tmp/mullgate-home/state/mullgate/runtime
reason: Mullgate is not configured yet. Run \`mullgate setup\` to create /tmp/mullgate-home/config/mullgate/config.json.
next step: run \`mullgate setup\` before expecting runtime artifacts or Docker containers."
`);
  });

  it('reports a healthy routed runtime with live compose containers and artifact paths', async () => {
    const env = createTempEnvironment();
    const fixturePaths = resolveMullgatePaths(env);
    const { store, paths } = await seedSavedConfig(env, {
      configure: (config) => ({
        ...config,
        runtime: {
          ...config.runtime,
          status: {
            phase: 'running',
            lastCheckedAt: '2026-03-21T07:10:00.000Z',
            message: 'Runtime started successfully.',
          },
        },
      }),
      lastStart: {
        attemptedAt: '2026-03-21T07:10:00.000Z',
        status: 'success',
        phase: 'compose-launch',
        source: 'docker-compose',
        code: null,
        message: 'Docker Compose launched the Mullgate runtime bundle in detached mode.',
        cause: null,
        artifactPath: fixturePaths.runtimeComposeFile,
        composeFilePath: fixturePaths.runtimeComposeFile,
        validationSource: 'wireproxy-binary/configtest (2 routes)',
        routeId: null,
        routeHostname: null,
        routeBindIp: null,
        serviceName: null,
        command: `docker compose --file ${fixturePaths.runtimeComposeFile} up --detach --force-recreate`,
      },
    });
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createStatusCommandAction({
      store,
      stdout,
      stderr,
      inspectRuntime: async () =>
        createComposeStatusSuccess(paths.runtimeComposeFile, [
          {
            name: 'mullgate-entry-tunnel-1',
            service: 'entry-tunnel',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 10 seconds',
            exitCode: 0,
            publishers: [],
          },
          {
            name: 'mullgate-route-proxy-1',
            service: 'route-proxy',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 10 seconds',
            exitCode: 0,
            publishers: [],
          },
          {
            name: 'mullgate-routing-layer-1',
            service: 'routing-layer',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 10 seconds',
            exitCode: 0,
            publishers: [],
          },
        ]),
    });

    await action();

    expect(process.exitCode).toBe(0);
    expect(stderr.value.current).toBe('');
    expect(`\n${normalizeOutput(stdout.value.current, env)}`).toMatchInlineSnapshot(`
      "
      Mullgate runtime status
      phase: running
      config: /tmp/mullgate-home/config/mullgate/config.json
      runtime dir: /tmp/mullgate-home/state/mullgate/runtime
      docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
      runtime manifest: /tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json (present)
      last start report: /tmp/mullgate-home/state/mullgate/runtime/last-start.json (present)
      saved runtime status: running
      saved checked at: 2026-03-21T07:10:00.000Z
      saved message: Runtime started successfully.
      exposure source: runtime-manifest
      mode label: Loopback / local-only
      recommendation: local-default
      posture summary: Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.
      remote story: Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.
      platform: linux
      platform source: env:MULLGATE_PLATFORM
      platform support: full
      platform mode: Linux-first runtime support
      platform summary: Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.
      runtime story: Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.
      host networking: Native host networking available
      host networking summary: Docker host networking behaves as expected on Linux, so the routing layer and shared route-proxy listeners can bind directly to the saved route IPs.
      compose inspection: available
      compose project: mullgate
      compose command: docker compose --file /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml ps --all --format json
      container summary: 3 total, 3 running, 0 starting, 0 stopped, 0 unhealthy
      entry-tunnel: running (status=Up 10 seconds, health=healthy, exit=0)
      route-proxy: running (status=Up 10 seconds, health=healthy, exit=0)
      routing-layer: running (status=Up 10 seconds, health=healthy, exit=0)

      routes
      1. se-got-wg-101 -> 127.0.0.1
         alias: sweden-gothenburg
         route id: se-got-wg-101
         shared service: route-proxy
         live state: running (status=Up 10 seconds, health=healthy, exit=0)
         socks5 listener: 127.0.0.1:1080
         http listener: 127.0.0.1:8080
         https backend: route-se-got-wg-101
         dns: not required; use direct bind IP entrypoints
         socks5 hostname: socks5://se-got-wg-101:1080
         socks5 direct ip: socks5://127.0.0.1:1080
         http hostname: http://se-got-wg-101:8080
         http direct ip: http://127.0.0.1:8080
      2. at-vie-wg-001 -> 127.0.0.2
         alias: austria-vienna
         route id: at-vie-wg-001
         shared service: route-proxy
         live state: running (status=Up 10 seconds, health=healthy, exit=0)
         socks5 listener: 127.0.0.2:1080
         http listener: 127.0.0.2:8080
         https backend: route-at-vie-wg-001
         dns: not required; use direct bind IP entrypoints
         socks5 hostname: socks5://at-vie-wg-001:1080
         socks5 direct ip: socks5://127.0.0.2:1080
         http hostname: http://at-vie-wg-001:8080
         http direct ip: http://127.0.0.2:8080

      platform guidance
      - Linux is the reference runtime target for the current Mullgate topology and verification flow.
      - Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.

      network-mode guidance
      - Loopback mode is the default local-only posture. Keep it for same-machine use and developer/operator checks.
      - Use \`mullgate proxy access\` if you want a copy/paste /etc/hosts block for this machine.

      warnings
      - none

      last start diagnostics
      status: success
      attempted at: 2026-03-21T07:10:00.000Z
      phase: compose-launch
      source: docker-compose
      code: n/a
      reason: Docker Compose launched the Mullgate runtime bundle in detached mode."
    `);
  });

  it('reports a degraded multi-route runtime when saved status says running but one route is stopped', async () => {
    const env = createTempEnvironment();
    const rawFailureReport = {
      attemptedAt: '2026-03-21T07:20:00.000Z',
      status: 'failure',
      phase: 'compose-launch',
      source: 'docker-compose',
      code: 'COMPOSE_UP_FAILED',
      message:
        'Docker Compose failed to start the Mullgate runtime bundle for proxy-password / 123456789012 / private-key-value-2.',
      cause:
        'service route-proxy crashed while reading -----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY----- and account 123456789012',
      artifactPath: null,
      composeFilePath: null,
      validationSource: 'wireproxy-binary/configtest (2 routes)',
      routeId: 'at-vie-wg-001',
      routeHostname: 'at-vie-wg-001',
      routeBindIp: '127.0.0.2',
      serviceName: 'route-proxy',
      command: null,
    } satisfies RuntimeStartDiagnostic;
    const { store, paths } = await seedSavedConfig(env, {
      configure: (config) => ({
        ...config,
        runtime: {
          ...config.runtime,
          status: {
            phase: 'running',
            lastCheckedAt: '2026-03-21T07:20:00.000Z',
            message: 'Runtime started successfully.',
          },
        },
      }),
      lastStart: rawFailureReport,
    });
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createStatusCommandAction({
      store,
      stdout,
      stderr,
      inspectRuntime: async () =>
        createComposeStatusSuccess(paths.runtimeComposeFile, [
          {
            name: 'mullgate-entry-tunnel-1',
            service: 'entry-tunnel',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 30 seconds',
            exitCode: 0,
            publishers: [],
          },
          {
            name: 'mullgate-route-proxy-1',
            service: 'route-proxy',
            project: 'mullgate',
            state: 'exited',
            health: null,
            status: 'Exited (2) 3 seconds ago',
            exitCode: 2,
            publishers: [],
          },
          {
            name: 'mullgate-routing-layer-1',
            service: 'routing-layer',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 30 seconds',
            exitCode: 0,
            publishers: [],
          },
        ]),
    });

    await action();

    expect(process.exitCode).toBe(0);
    expect(stderr.value.current).toBe('');
    expect(`\n${normalizeOutput(stdout.value.current, env)}`).toMatchInlineSnapshot(`
      "
      Mullgate runtime status
      phase: degraded
      config: /tmp/mullgate-home/config/mullgate/config.json
      runtime dir: /tmp/mullgate-home/state/mullgate/runtime
      docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
      runtime manifest: /tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json (present)
      last start report: /tmp/mullgate-home/state/mullgate/runtime/last-start.json (present)
      saved runtime status: running
      saved checked at: 2026-03-21T07:20:00.000Z
      saved message: Runtime started successfully.
      exposure source: runtime-manifest
      mode label: Loopback / local-only
      recommendation: local-default
      posture summary: Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.
      remote story: Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.
      platform: linux
      platform source: env:MULLGATE_PLATFORM
      platform support: full
      platform mode: Linux-first runtime support
      platform summary: Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.
      runtime story: Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.
      host networking: Native host networking available
      host networking summary: Docker host networking behaves as expected on Linux, so the routing layer and shared route-proxy listeners can bind directly to the saved route IPs.
      compose inspection: available
      compose project: mullgate
      compose command: docker compose --file /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml ps --all --format json
      container summary: 3 total, 2 running, 0 starting, 1 stopped, 0 unhealthy
      entry-tunnel: running (status=Up 30 seconds, health=healthy, exit=0)
      route-proxy: exited (status=Exited (2) 3 seconds ago, exit=2)
      routing-layer: running (status=Up 30 seconds, health=healthy, exit=0)

      routes
      1. se-got-wg-101 -> 127.0.0.1
         alias: sweden-gothenburg
         route id: se-got-wg-101
         shared service: route-proxy
         live state: exited (status=Exited (2) 3 seconds ago, exit=2)
         socks5 listener: 127.0.0.1:1080
         http listener: 127.0.0.1:8080
         https backend: route-se-got-wg-101
         dns: not required; use direct bind IP entrypoints
         socks5 hostname: socks5://se-got-wg-101:1080
         socks5 direct ip: socks5://127.0.0.1:1080
         http hostname: http://se-got-wg-101:8080
         http direct ip: http://127.0.0.1:8080
      2. at-vie-wg-001 -> 127.0.0.2
         alias: austria-vienna
         route id: at-vie-wg-001
         shared service: route-proxy
         live state: exited (status=Exited (2) 3 seconds ago, exit=2)
         socks5 listener: 127.0.0.2:1080
         http listener: 127.0.0.2:8080
         https backend: route-at-vie-wg-001
         dns: not required; use direct bind IP entrypoints
         socks5 hostname: socks5://at-vie-wg-001:1080
         socks5 direct ip: socks5://127.0.0.2:1080
         http hostname: http://at-vie-wg-001:8080
         http direct ip: http://127.0.0.2:8080

      platform guidance
      - Linux is the reference runtime target for the current Mullgate topology and verification flow.
      - Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.

      network-mode guidance
      - Loopback mode is the default local-only posture. Keep it for same-machine use and developer/operator checks.
      - Use \`mullgate proxy access\` if you want a copy/paste /etc/hosts block for this machine.

      warnings
      - route-proxy is not fully healthy: exited (status=Exited (2) 3 seconds ago, exit=2).
      - saved runtime status says running, but live compose status shows stopped or degraded shared services. Trust live compose over the saved phase and rerun \`mullgate proxy start\` after fixing the failing service.
      - the last recorded \`mullgate proxy start\` attempt failed; inspect the last-start diagnostics below before restarting blindly.

      last start diagnostics
      status: failure
      attempted at: 2026-03-21T07:20:00.000Z
      phase: compose-launch
      source: docker-compose
      code: COMPOSE_UP_FAILED
      route id: at-vie-wg-001
      route hostname: at-vie-wg-001
      route bind ip: 127.0.0.2
      service: route-proxy
      reason: Docker Compose failed to start the Mullgate runtime bundle for [redacted] / [redacted] / private-key-value-2.
      cause: service route-proxy crashed while reading [redacted] and account [redacted]"
    `);
  });

  it('surfaces partial platform support from the runtime manifest on macOS-style installs', async () => {
    const env = createTempEnvironment();
    env.MULLGATE_PLATFORM = 'macos';
    const { store, paths } = await seedSavedConfig(env, {
      configure: (config) => ({
        ...config,
        setup: {
          ...config.setup,
          bind: {
            ...config.setup.bind,
            httpsPort: null,
          },
          https: {
            enabled: false,
          },
        },
      }),
    });
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createStatusCommandAction({
      store,
      stdout,
      stderr,
      inspectRuntime: async () => createComposeStatusSuccess(paths.runtimeComposeFile, []),
    });

    await action();

    expect(process.exitCode).toBe(0);
    expect(stderr.value.current).toBe('');
    const summary = stdout.value.current.trimEnd();
    expect(summary).toContain('platform: macos');
    expect(summary).toContain('platform support: partial');
    expect(summary).toContain('platform mode: macOS path + diagnostics support');
    expect(summary).toContain('host networking: Docker Desktop host networking is limited');
    expect(summary).toContain('platform guidance');
    expect(summary).toContain('platform warnings');
  });

  it('reports a validated-but-not-started runtime as stopped when compose has no containers', async () => {
    const env = createTempEnvironment();
    const { store, paths } = await seedSavedConfig(env);
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createStatusCommandAction({
      store,
      stdout,
      stderr,
      inspectRuntime: async () => createComposeStatusSuccess(paths.runtimeComposeFile, []),
    });

    await action();

    expect(process.exitCode).toBe(0);
    expect(stderr.value.current).toBe('');
    expect(`\n${normalizeOutput(stdout.value.current, env)}`).toMatchInlineSnapshot(`
      "
      Mullgate runtime status
      phase: stopped
      config: /tmp/mullgate-home/config/mullgate/config.json
      runtime dir: /tmp/mullgate-home/state/mullgate/runtime
      docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
      runtime manifest: /tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json (present)
      last start report: /tmp/mullgate-home/state/mullgate/runtime/last-start.json (missing)
      saved runtime status: validated
      saved checked at: 2026-03-21T07:00:00.000Z
      saved message: Fixture config already validated.
      exposure source: runtime-manifest
      mode label: Loopback / local-only
      recommendation: local-default
      posture summary: Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.
      remote story: Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.
      platform: linux
      platform source: env:MULLGATE_PLATFORM
      platform support: full
      platform mode: Linux-first runtime support
      platform summary: Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.
      runtime story: Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.
      host networking: Native host networking available
      host networking summary: Docker host networking behaves as expected on Linux, so the routing layer and shared route-proxy listeners can bind directly to the saved route IPs.
      compose inspection: available
      compose project: n/a
      compose command: docker compose --file /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml ps --all --format json
      container summary: 0 total, 0 running, 0 starting, 0 stopped, 0 unhealthy
      entry-tunnel: not present in live compose status
      route-proxy: not present in live compose status
      routing-layer: not present in live compose status

      routes
      1. se-got-wg-101 -> 127.0.0.1
         alias: sweden-gothenburg
         route id: se-got-wg-101
         shared service: route-proxy
         live state: not present in live compose status
         socks5 listener: 127.0.0.1:1080
         http listener: 127.0.0.1:8080
         https backend: route-se-got-wg-101
         dns: not required; use direct bind IP entrypoints
         socks5 hostname: socks5://se-got-wg-101:1080
         socks5 direct ip: socks5://127.0.0.1:1080
         http hostname: http://se-got-wg-101:8080
         http direct ip: http://127.0.0.1:8080
      2. at-vie-wg-001 -> 127.0.0.2
         alias: austria-vienna
         route id: at-vie-wg-001
         shared service: route-proxy
         live state: not present in live compose status
         socks5 listener: 127.0.0.2:1080
         http listener: 127.0.0.2:8080
         https backend: route-at-vie-wg-001
         dns: not required; use direct bind IP entrypoints
         socks5 hostname: socks5://at-vie-wg-001:1080
         socks5 direct ip: socks5://127.0.0.2:1080
         http hostname: http://at-vie-wg-001:8080
         http direct ip: http://127.0.0.2:8080

      platform guidance
      - Linux is the reference runtime target for the current Mullgate topology and verification flow.
      - Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.

      network-mode guidance
      - Loopback mode is the default local-only posture. Keep it for same-machine use and developer/operator checks.
      - Use \`mullgate proxy access\` if you want a copy/paste /etc/hosts block for this machine.

      warnings
      - no persisted last-start report exists yet; run \`mullgate proxy start\` to capture a fresh launch diagnostic.
      - entry-tunnel is not fully healthy: not present in live compose status.
      - route-proxy is not fully healthy: not present in live compose status.
      - routing-layer is not fully healthy: not present in live compose status.

      last start diagnostics
      status: none persisted yet"
    `);
  });
});
