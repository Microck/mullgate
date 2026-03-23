import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDoctorCommandAction } from '../../src/commands/doctor.js';
import { resolveMullgatePaths, resolveRouteWireproxyPaths } from '../../src/config/paths.js';
import {
  CONFIG_VERSION,
  type MullgateConfig,
  type RuntimeStartDiagnostic,
} from '../../src/config/schema.js';
import { ConfigStore } from '../../src/config/store.js';
import type { MullvadRelayCatalog } from '../../src/mullvad/fetch-relays.js';
import type { DockerComposeStatusResult } from '../../src/runtime/docker-runtime.js';
import { renderRuntimeBundle } from '../../src/runtime/render-runtime-bundle.js';
import type { ValidateWireproxyResult } from '../../src/runtime/validate-wireproxy.js';

const temporaryDirectories: string[] = [];
const windowsFixturePrefixes = [
  'C:\\Users\\alice\\AppData\\Local\\mullgate',
  'C:\\Users\\alice\\AppData\\Roaming\\mullgate',
] as const;

type BufferSink = {
  readonly value: { current: string };
  write(chunk: string): boolean;
};

function cleanupWindowsFixturePaths(): void {
  readdirSync('.').forEach((entry) => {
    if (!windowsFixturePrefixes.some((prefix) => entry.startsWith(prefix))) {
      return;
    }

    rmSync(entry, { recursive: true, force: true });
  });
}

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-doctor-command-'));
  temporaryDirectories.push(root);

  return {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
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
      deviceName: 'mullgate-doctor-test-1',
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
            deviceName: 'mullgate-doctor-test-1',
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
            deviceName: 'mullgate-doctor-test-2',
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

function createRelayCatalog(fetchedAt: string): MullvadRelayCatalog {
  return {
    source: 'app-wireguard-v1',
    fetchedAt,
    endpoint: 'https://api.mullvad.net/public/relays/wireguard/v1/',
    relayCount: 2,
    countries: [
      {
        code: 'at',
        name: 'Austria',
        cities: [{ code: 'vie', name: 'Vienna', relayCount: 1 }],
      },
      {
        code: 'se',
        name: 'Sweden',
        cities: [{ code: 'got', name: 'Gothenburg', relayCount: 1 }],
      },
    ],
    relays: [
      {
        hostname: 'at-vie-wg-001',
        fqdn: 'at-vie-wg-001.relays.mullvad.net',
        source: 'app-wireguard-v1',
        active: true,
        owned: false,
        publicKey: 'relay-public-key-2',
        endpointIpv4: '203.0.113.12',
        multihopPort: 51820,
        location: {
          countryCode: 'at',
          countryName: 'Austria',
          cityCode: 'vie',
          cityName: 'Vienna',
        },
      },
      {
        hostname: 'se-got-wg-101',
        fqdn: 'se-got-wg-101.relays.mullvad.net',
        source: 'app-wireguard-v1',
        active: true,
        owned: false,
        publicKey: 'relay-public-key-1',
        endpointIpv4: '203.0.113.11',
        multihopPort: 51820,
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'got',
          cityName: 'Gothenburg',
        },
      },
    ],
  };
}

function createValidationSuccess(targetPath: string): ValidateWireproxyResult {
  return {
    ok: true,
    phase: 'validation',
    source: 'internal-syntax',
    status: 'success',
    checkedAt: '2026-03-21T07:05:00.000Z',
    target: targetPath,
    reportPath: targetPath,
    validator: 'internal-syntax',
    issues: [],
  };
}

async function seedSavedConfig(
  env: NodeJS.ProcessEnv,
  options: {
    readonly configure?: (config: MullgateConfig) => MullgateConfig;
    readonly lastStart?: RuntimeStartDiagnostic | null;
    readonly renderManifest?: boolean;
    readonly relayCatalog?: MullvadRelayCatalog;
    readonly writeValidationReports?: boolean;
    readonly validationReports?: Record<string, ValidateWireproxyResult>;
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

  await mkdir(path.dirname(config.runtime.wireproxyConfigPath), { recursive: true, mode: 0o700 });
  await writeFile(config.runtime.wireproxyConfigPath, '# primary wireproxy fixture\n', {
    mode: 0o600,
  });

  for (const location of config.routing.locations) {
    const routePaths = resolveRouteWireproxyPaths(paths, location.runtime);
    await writeFile(
      routePaths.wireproxyConfigPath,
      `# route fixture ${location.runtime.routeId}\n`,
      { mode: 0o600 },
    );
  }

  const relayCatalog = options.relayCatalog ?? createRelayCatalog('2026-03-21T07:55:00.000Z');
  await mkdir(path.dirname(paths.provisioningCacheFile), { recursive: true, mode: 0o700 });
  await writeFile(paths.provisioningCacheFile, `${JSON.stringify(relayCatalog, null, 2)}\n`, {
    mode: 0o600,
  });

  if (options.writeValidationReports ?? true) {
    for (const location of config.routing.locations) {
      const routePaths = resolveRouteWireproxyPaths(paths, location.runtime);
      const report =
        options.validationReports?.[location.runtime.routeId] ??
        createValidationSuccess(routePaths.configTestReportPath);
      await writeFile(routePaths.configTestReportPath, `${JSON.stringify(report, null, 2)}\n`, {
        mode: 0o600,
      });
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
  return value.split(env.HOME!).join('/tmp/mullgate-home').trimEnd();
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
    checkedAt: '2026-03-21T08:00:00.000Z',
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
  cleanupWindowsFixturePaths();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('mullgate doctor command', () => {
  it('reports a healthy configured install with pass checks and redacted output', async () => {
    const env = createTempEnvironment();
    const fixturePaths = resolveMullgatePaths(env);
    const { store, paths } = await seedSavedConfig(env, {
      configure: (config) => ({
        ...config,
        runtime: {
          ...config.runtime,
          status: {
            phase: 'running',
            lastCheckedAt: '2026-03-21T07:58:00.000Z',
            message: 'Runtime is already up.',
          },
        },
      }),
      lastStart: {
        attemptedAt: '2026-03-21T07:58:00.000Z',
        status: 'success',
        phase: 'compose-launch',
        source: 'docker-compose',
        code: null,
        message: 'Docker Compose launched the Mullgate runtime bundle in detached mode.',
        cause: null,
        artifactPath: fixturePaths.runtimeComposeFile,
        composeFilePath: fixturePaths.runtimeComposeFile,
        validationSource: 'internal-syntax',
        routeId: null,
        routeHostname: null,
        routeBindIp: null,
        serviceName: null,
        command: `docker compose --file ${fixturePaths.runtimeComposeFile} up --detach`,
      },
    });
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createDoctorCommandAction({
      store,
      stdout,
      stderr,
      checkedAt: '2026-03-21T08:00:00.000Z',
      resolveHostname: async (hostname) => {
        if (hostname === 'se-got-wg-101') {
          return ['127.0.0.1'];
        }
        if (hostname === 'at-vie-wg-001') {
          return ['127.0.0.2'];
        }
        throw new Error(`Unexpected hostname ${hostname}`);
      },
      inspectRuntime: async () =>
        createComposeStatusSuccess(paths.runtimeComposeFile, [
          {
            name: 'mullgate-routing-layer-1',
            service: 'routing-layer',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 40 seconds',
            exitCode: 0,
            publishers: [],
          },
          {
            name: 'mullgate-wireproxy-se-got-wg-101-1',
            service: 'wireproxy-se-got-wg-101',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 40 seconds',
            exitCode: 0,
            publishers: [],
          },
          {
            name: 'mullgate-wireproxy-at-vie-wg-001-1',
            service: 'wireproxy-at-vie-wg-001',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 40 seconds',
            exitCode: 0,
            publishers: [],
          },
        ]),
    });

    await action();

    expect(process.exitCode).toBe(0);
    expect(stderr.value.current).toBe('');
    expect(stdout.value.current).not.toContain('proxy-password');
    expect(stdout.value.current).not.toContain('123456789012');
    expect(stdout.value.current).not.toContain('private-key-value-1');
    expect(`\n${normalizeOutput(stdout.value.current, env)}`).toMatchInlineSnapshot(`
      "
      Mullgate doctor
      overall: pass
      checked at: 2026-03-21T08:00:00.000Z
      mode: offline-default
      config: /tmp/mullgate-home/config/mullgate/config.json
      runtime dir: /tmp/mullgate-home/state/mullgate/runtime
      relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
      wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
      runtime manifest: /tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json (present)
      last start report: /tmp/mullgate-home/state/mullgate/runtime/last-start.json (present)

      checks
      1. config: pass
         summary: Loaded the canonical Mullgate config successfully.
         detail: config=/tmp/mullgate-home/config/mullgate/config.json
         detail: routes=2
         detail: saved-runtime-phase=running
         detail: exposure-mode=loopback

      2. platform-support: pass
         summary: Current platform matches the fully supported Linux runtime contract.
         detail: platform=linux
         detail: platform-source=process.platform
         detail: support-level=full
         detail: mode-label=Linux-first runtime support
         detail: summary=Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.
         detail: runtime-story=Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.
         detail: config-paths=supported
         detail: config-workflow=supported
         detail: runtime-artifacts=supported
         detail: runtime-execution=supported
         detail: diagnostics=supported
         detail: host-networking=Native host networking available
         detail: host-networking-summary=Docker host networking behaves as expected on Linux, so the routing layer and per-route wireproxy listeners can bind directly to the saved route IPs.
         detail: guidance=Linux is the reference runtime target for the current Mullgate topology and verification flow.
         detail: guidance=Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.

      3. validation-artifacts: pass
         summary: Wireproxy config artifacts and persisted validation reports are present.
         detail: saved-runtime-phase=running
         detail: saved-runtime-message=Runtime is already up.
         detail: wireproxy-config=/tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf (present)
         detail: report[se-got-wg-101]=ok via internal-syntax
         detail: report[at-vie-wg-001]=ok via internal-syntax

      4. relay-cache: pass
         summary: Saved Mullvad relay metadata is readable and fresh enough for offline diagnostics.
         detail: relay-cache=/tmp/mullgate-home/cache/mullgate/relays.json
         detail: source=app-wireguard-v1
         detail: endpoint=https://api.mullvad.net/public/relays/wireguard/v1/
         detail: fetched-at=2026-03-21T07:55:00.000Z
         detail: relay-count=2
         detail: age=0h

      5. exposure-contract: pass
         summary: Saved exposure contract is internally coherent.
         detail: mode=loopback
         detail: mode-label=Loopback / local-only
         detail: recommendation=local-default
         detail: posture-summary=Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.
         detail: remote-story=Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.
         detail: base-domain=n/a
         detail: allow-lan=no
         detail: dns-records=0
         detail: routes=2
         detail: bind-remediation=Keep loopback mode on local-only bind IPs. If you need remote access, rerun \`mullgate config exposure --mode private-network ...\` with one trusted-network bind IP per route.
         detail: hostname-remediation=For local host-file testing, use \`mullgate config hosts\` and apply the emitted block on this machine so each route hostname resolves to its saved loopback bind IP.
         detail: restart-remediation=After changing exposure settings, rerun \`mullgate config validate\` or \`mullgate start\` so the runtime artifacts match the saved local-only posture.
         detail: info: Loopback mode is local-only. Keep using \`mullgate config hosts\` for host-file testing on this machine.

      6. bind-posture: pass
         summary: Saved bind IPs match the configured exposure posture.
         detail: setup.bind.host=127.0.0.1
         detail: route[1] se-got-wg-101 bind-ip=127.0.0.1
         detail: route[2] at-vie-wg-001 bind-ip=127.0.0.2

      7. hostname-resolution: pass
         summary: Configured hostnames resolve to the bind IPs promised by the saved exposure contract.
         detail: route se-got-wg-101: se-got-wg-101 -> 127.0.0.1
         detail: route at-vie-wg-001: at-vie-wg-001 -> 127.0.0.2

      8. runtime: pass
         summary: Live Docker Compose status matches the expected Mullgate routing-layer and per-route services.
         detail: compose-command=docker compose --file /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml ps --all --format json
         detail: containers=3
         detail: running=3
         detail: starting=0
         detail: stopped=0
         detail: unhealthy=0
         detail: routing-layer=running (status=Up 40 seconds, health=healthy, exit=0)
         detail: route se-got-wg-101 (wireproxy-se-got-wg-101)=running (status=Up 40 seconds, health=healthy, exit=0)
         detail: route at-vie-wg-001 (wireproxy-at-vie-wg-001)=running (status=Up 40 seconds, health=healthy, exit=0)

      9. last-start: pass
         summary: The last recorded \`mullgate start\` attempt completed successfully.
         detail: status=success
         detail: attempted-at=2026-03-21T07:58:00.000Z
         detail: phase=compose-launch
         detail: source=docker-compose
         detail: code=n/a
         detail: reason=Docker Compose launched the Mullgate runtime bundle in detached mode."
    `);
  });

  it('fails cleanly on an unconfigured install', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createDoctorCommandAction({
      store,
      stdout,
      stderr,
      checkedAt: '2026-03-21T08:00:00.000Z',
    });

    await action();

    expect(process.exitCode).toBe(1);
    expect(stdout.value.current).toBe('');
    expect(`\n${normalizeOutput(stderr.value.current, env)}`).toMatchInlineSnapshot(`
"\nMullgate doctor
overall: fail
checked at: 2026-03-21T08:00:00.000Z
mode: offline-default
config: /tmp/mullgate-home/config/mullgate/config.json
runtime dir: /tmp/mullgate-home/state/mullgate/runtime
relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
runtime manifest: /tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json
last start report: /tmp/mullgate-home/state/mullgate/runtime/last-start.json

checks
1. config: fail
   summary: Mullgate is not configured yet, so doctor cannot inspect runtime or exposure state.
   detail: Mullgate is not configured yet. Run \`mullgate setup\` to create /tmp/mullgate-home/config/mullgate/config.json.
   remediation: Run \`mullgate setup\` first, then rerun \`mullgate doctor\` once a canonical config exists."
`);
  });

  it('explains missing Docker/Compose tooling as a named runtime failure', async () => {
    const env = createTempEnvironment();
    const { store, paths } = await seedSavedConfig(env, {
      configure: (config) => ({
        ...config,
        runtime: {
          ...config.runtime,
          status: {
            phase: 'running',
            lastCheckedAt: '2026-03-21T07:58:00.000Z',
            message: 'Runtime is already up.',
          },
        },
      }),
    });
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createDoctorCommandAction({
      store,
      stdout,
      stderr,
      checkedAt: '2026-03-21T08:00:00.000Z',
      resolveHostname: async (hostname) =>
        hostname === 'se-got-wg-101' ? ['127.0.0.1'] : ['127.0.0.2'],
      inspectRuntime: async () => ({
        ok: false,
        phase: 'compose-detect',
        source: 'docker-binary',
        checkedAt: '2026-03-21T08:00:00.000Z',
        code: 'DOCKER_COMPOSE_MISSING',
        composeFilePath: paths.runtimeComposeFile,
        command: {
          binary: 'docker',
          args: ['compose', 'version'],
          cwd: path.dirname(paths.runtimeComposeFile),
          rendered: 'docker compose version',
        },
        message:
          'Docker CLI is not installed or is not on PATH, so Mullgate cannot inspect the runtime bundle.',
        cause: 'spawn docker ENOENT',
        artifactPath: paths.runtimeComposeFile,
      }),
    });

    await action();

    expect(process.exitCode).toBe(1);
    expect(stdout.value.current).toBe('');
    expect(`\n${normalizeOutput(stderr.value.current, env)}`).toMatchInlineSnapshot(`
      "
      Mullgate doctor
      overall: fail
      checked at: 2026-03-21T08:00:00.000Z
      mode: offline-default
      config: /tmp/mullgate-home/config/mullgate/config.json
      runtime dir: /tmp/mullgate-home/state/mullgate/runtime
      relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
      wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
      runtime manifest: /tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json (present)
      last start report: /tmp/mullgate-home/state/mullgate/runtime/last-start.json (missing)

      checks
      1. config: pass
         summary: Loaded the canonical Mullgate config successfully.
         detail: config=/tmp/mullgate-home/config/mullgate/config.json
         detail: routes=2
         detail: saved-runtime-phase=running
         detail: exposure-mode=loopback

      2. platform-support: pass
         summary: Current platform matches the fully supported Linux runtime contract.
         detail: platform=linux
         detail: platform-source=process.platform
         detail: support-level=full
         detail: mode-label=Linux-first runtime support
         detail: summary=Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.
         detail: runtime-story=Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.
         detail: config-paths=supported
         detail: config-workflow=supported
         detail: runtime-artifacts=supported
         detail: runtime-execution=supported
         detail: diagnostics=supported
         detail: host-networking=Native host networking available
         detail: host-networking-summary=Docker host networking behaves as expected on Linux, so the routing layer and per-route wireproxy listeners can bind directly to the saved route IPs.
         detail: guidance=Linux is the reference runtime target for the current Mullgate topology and verification flow.
         detail: guidance=Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.

      3. validation-artifacts: pass
         summary: Wireproxy config artifacts and persisted validation reports are present.
         detail: saved-runtime-phase=running
         detail: saved-runtime-message=Runtime is already up.
         detail: wireproxy-config=/tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf (present)
         detail: report[se-got-wg-101]=ok via internal-syntax
         detail: report[at-vie-wg-001]=ok via internal-syntax

      4. relay-cache: pass
         summary: Saved Mullvad relay metadata is readable and fresh enough for offline diagnostics.
         detail: relay-cache=/tmp/mullgate-home/cache/mullgate/relays.json
         detail: source=app-wireguard-v1
         detail: endpoint=https://api.mullvad.net/public/relays/wireguard/v1/
         detail: fetched-at=2026-03-21T07:55:00.000Z
         detail: relay-count=2
         detail: age=0h

      5. exposure-contract: pass
         summary: Saved exposure contract is internally coherent.
         detail: mode=loopback
         detail: mode-label=Loopback / local-only
         detail: recommendation=local-default
         detail: posture-summary=Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.
         detail: remote-story=Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.
         detail: base-domain=n/a
         detail: allow-lan=no
         detail: dns-records=0
         detail: routes=2
         detail: bind-remediation=Keep loopback mode on local-only bind IPs. If you need remote access, rerun \`mullgate config exposure --mode private-network ...\` with one trusted-network bind IP per route.
         detail: hostname-remediation=For local host-file testing, use \`mullgate config hosts\` and apply the emitted block on this machine so each route hostname resolves to its saved loopback bind IP.
         detail: restart-remediation=After changing exposure settings, rerun \`mullgate config validate\` or \`mullgate start\` so the runtime artifacts match the saved local-only posture.
         detail: info: Loopback mode is local-only. Keep using \`mullgate config hosts\` for host-file testing on this machine.

      6. bind-posture: pass
         summary: Saved bind IPs match the configured exposure posture.
         detail: setup.bind.host=127.0.0.1
         detail: route[1] se-got-wg-101 bind-ip=127.0.0.1
         detail: route[2] at-vie-wg-001 bind-ip=127.0.0.2

      7. hostname-resolution: pass
         summary: Configured hostnames resolve to the bind IPs promised by the saved exposure contract.
         detail: route se-got-wg-101: se-got-wg-101 -> 127.0.0.1
         detail: route at-vie-wg-001: at-vie-wg-001 -> 127.0.0.2

      8. runtime: fail
         summary: Docker CLI is not installed or is not on PATH, so Mullgate cannot inspect the runtime bundle.
         detail: command=docker compose version
         detail: code=DOCKER_COMPOSE_MISSING
         detail: cause=spawn docker ENOENT
         remediation: Install Docker plus the Compose plugin, then rerun \`mullgate status\`, \`mullgate doctor\`, or \`mullgate start\`.

      9. last-start: degraded
         summary: No persisted last-start diagnostic exists yet.
         detail: Doctor can still inspect saved config and live runtime state, but there is no persisted start failure/success context yet.
         remediation: Run \`mullgate start\` once to capture a persisted launch report that future doctor runs can inspect."
    `);
  });

  it('degrades platform support cleanly on Windows-style installs while keeping other diagnostics truthful', async () => {
    cleanupWindowsFixturePaths();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MULLGATE_PLATFORM: 'windows',
      USERPROFILE: 'C:\\Users\\alice',
      APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      HOME: undefined,
      XDG_CONFIG_HOME: undefined,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: undefined,
    };
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

    const action = createDoctorCommandAction({
      store,
      stdout,
      stderr,
      checkedAt: '2026-03-21T08:00:00.000Z',
      resolveHostname: async (hostname) =>
        hostname === 'se-got-wg-101' ? ['127.0.0.1'] : ['127.0.0.2'],
      inspectRuntime: async () => createComposeStatusSuccess(paths.runtimeComposeFile, []),
    });

    await action();

    expect(process.exitCode).toBe(0);
    expect(stderr.value.current).toBe('');
    const summary = stdout.value.current.trimEnd();
    expect(summary).toContain('2. platform-support: degraded');
    expect(summary).toContain('detail: platform=windows');
    expect(summary).toContain('detail: support-level=partial');
    expect(summary).toContain('detail: mode-label=Windows path + diagnostics support');
    expect(summary).toContain('detail: runtime-execution=limited');
    expect(summary).toContain('detail: host-networking=Docker Desktop host networking is limited');
    expect(summary).toContain(
      'remediation: Treat Linux as the runtime execution target for now, or move the current Docker-first runtime into a Linux VM or host when you need the shipped multi-route topology to behave truthfully.',
    );
  });

  it('calls out hostname drift with route-aware remediation plus stale relay cache and validation drift', async () => {
    const env = createTempEnvironment();
    const { store, paths } = await seedSavedConfig(env, {
      configure: (config) => ({
        ...config,
        runtime: {
          ...config.runtime,
          status: {
            phase: 'unvalidated',
            lastCheckedAt: '2026-03-21T07:00:00.000Z',
            message:
              'Exposure settings changed; rerun `mullgate config validate` or `mullgate start` to refresh runtime artifacts.',
          },
        },
      }),
      relayCatalog: createRelayCatalog('2026-03-10T08:00:00.000Z'),
      writeValidationReports: false,
    });
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createDoctorCommandAction({
      store,
      stdout,
      stderr,
      checkedAt: '2026-03-21T08:00:00.000Z',
      resolveHostname: async (hostname) => {
        if (hostname === 'se-got-wg-101') {
          return ['127.0.0.1'];
        }
        if (hostname === 'at-vie-wg-001') {
          return ['127.0.0.9'];
        }
        throw new Error(`Unexpected hostname ${hostname}`);
      },
      inspectRuntime: async () => createComposeStatusSuccess(paths.runtimeComposeFile, []),
    });

    await action();

    expect(process.exitCode).toBe(1);
    expect(stdout.value.current).toBe('');
    expect(`\n${normalizeOutput(stderr.value.current, env)}`).toMatchInlineSnapshot(`
      "
      Mullgate doctor
      overall: fail
      checked at: 2026-03-21T08:00:00.000Z
      mode: offline-default
      config: /tmp/mullgate-home/config/mullgate/config.json
      runtime dir: /tmp/mullgate-home/state/mullgate/runtime
      relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
      wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
      runtime manifest: /tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json (present)
      last start report: /tmp/mullgate-home/state/mullgate/runtime/last-start.json (missing)

      checks
      1. config: pass
         summary: Loaded the canonical Mullgate config successfully.
         detail: config=/tmp/mullgate-home/config/mullgate/config.json
         detail: routes=2
         detail: saved-runtime-phase=unvalidated
         detail: exposure-mode=loopback

      2. platform-support: pass
         summary: Current platform matches the fully supported Linux runtime contract.
         detail: platform=linux
         detail: platform-source=process.platform
         detail: support-level=full
         detail: mode-label=Linux-first runtime support
         detail: summary=Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.
         detail: runtime-story=Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.
         detail: config-paths=supported
         detail: config-workflow=supported
         detail: runtime-artifacts=supported
         detail: runtime-execution=supported
         detail: diagnostics=supported
         detail: host-networking=Native host networking available
         detail: host-networking-summary=Docker host networking behaves as expected on Linux, so the routing layer and per-route wireproxy listeners can bind directly to the saved route IPs.
         detail: guidance=Linux is the reference runtime target for the current Mullgate topology and verification flow.
         detail: guidance=Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.

      3. validation-artifacts: degraded
         summary: Saved config is marked \`unvalidated\`, so runtime artifacts may lag behind recent config or exposure edits.
         detail: saved-runtime-phase=unvalidated
         detail: saved-runtime-message=Exposure settings changed; rerun \`mullgate config validate\` or \`mullgate start\` to refresh runtime artifacts.
         detail: wireproxy-config=/tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf (present)
         detail: report[se-got-wg-101]=missing (/tmp/mullgate-home/state/mullgate/runtime/wireproxy-se-got-wg-101-configtest.json)
         detail: report[at-vie-wg-001]=missing (/tmp/mullgate-home/state/mullgate/runtime/wireproxy-at-vie-wg-001-configtest.json)
         remediation: Run \`mullgate config validate\` or \`mullgate start\` to regenerate wireproxy artifacts and capture a fresh validation report.

      4. relay-cache: degraded
         summary: Saved relay metadata is stale, so location and relay-selection diagnostics may lag behind Mullvad’s current catalog.
         detail: relay-cache=/tmp/mullgate-home/cache/mullgate/relays.json
         detail: source=app-wireguard-v1
         detail: endpoint=https://api.mullvad.net/public/relays/wireguard/v1/
         detail: fetched-at=2026-03-10T08:00:00.000Z
         detail: relay-count=2
         detail: age=11d
         remediation: Refresh the saved relay catalog with \`mullgate setup\`, then rerun \`mullgate config validate\` or \`mullgate start\` so runtime artifacts use the fresh relay data.

      5. exposure-contract: degraded
         summary: Saved exposure contract includes warning-level posture guidance that operators should resolve or consciously accept.
         detail: mode=loopback
         detail: mode-label=Loopback / local-only
         detail: recommendation=local-default
         detail: posture-summary=Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.
         detail: remote-story=Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.
         detail: base-domain=n/a
         detail: allow-lan=no
         detail: dns-records=0
         detail: routes=2
         detail: bind-remediation=Keep loopback mode on local-only bind IPs. If you need remote access, rerun \`mullgate config exposure --mode private-network ...\` with one trusted-network bind IP per route.
         detail: hostname-remediation=For local host-file testing, use \`mullgate config hosts\` and apply the emitted block on this machine so each route hostname resolves to its saved loopback bind IP.
         detail: restart-remediation=After changing exposure settings, rerun \`mullgate config validate\` or \`mullgate start\` so the runtime artifacts match the saved local-only posture.
         detail: info: Loopback mode is local-only. Keep using \`mullgate config hosts\` for host-file testing on this machine.
         detail: warning: Exposure settings changed; rerun \`mullgate config validate\` or \`mullgate start\` to refresh runtime artifacts.
         remediation: Keep loopback mode on local-only bind IPs. If you need remote access, rerun \`mullgate config exposure --mode private-network ...\` with one trusted-network bind IP per route.

      6. bind-posture: pass
         summary: Saved bind IPs match the configured exposure posture.
         detail: setup.bind.host=127.0.0.1
         detail: route[1] se-got-wg-101 bind-ip=127.0.0.1
         detail: route[2] at-vie-wg-001 bind-ip=127.0.0.2

      7. hostname-resolution: fail
         summary: One or more route hostnames no longer resolve to their saved bind IPs.
         detail: route se-got-wg-101: se-got-wg-101 -> 127.0.0.1
         detail: route at-vie-wg-001: at-vie-wg-001 -> 127.0.0.9
         detail: Route at-vie-wg-001 expects at-vie-wg-001 to resolve to 127.0.0.2, but it currently resolves to 127.0.0.9.
         remediation: Use \`mullgate config hosts\` and install the emitted hosts block on this machine so each route hostname resolves to its saved bind IP, then rerun \`mullgate doctor\`.

      8. runtime: degraded
         summary: No live compose containers are running right now.
         detail: compose-command=docker compose --file /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml ps --all --format json
         detail: containers=0
         detail: running=0
         detail: starting=0
         detail: stopped=0
         detail: unhealthy=0
         detail: routing-layer=not present in live compose status
         detail: route se-got-wg-101 (wireproxy-se-got-wg-101)=not present in live compose status
         detail: route at-vie-wg-001 (wireproxy-at-vie-wg-001)=not present in live compose status
         remediation: Run \`mullgate start\` after fixing any validation, bind, or last-start issues reported above.

      9. last-start: degraded
         summary: No persisted last-start diagnostic exists yet.
         detail: Doctor can still inspect saved config and live runtime state, but there is no persisted start failure/success context yet.
         remediation: Run \`mullgate start\` once to capture a persisted launch report that future doctor runs can inspect."
    `);
  });

  it('surfaces route-aware auth failures without leaking secrets', async () => {
    const env = createTempEnvironment();
    const rawFailureReport = {
      attemptedAt: '2026-03-21T08:10:00.000Z',
      status: 'failure',
      phase: 'compose-launch',
      source: 'docker-compose',
      code: 'COMPOSE_UP_FAILED',
      message:
        'Docker Compose failed for proxy-password / 123456789012 / private-key-value-2 while authenticating route at-vie-wg-001.',
      cause:
        'service wireproxy-at-vie-wg-001 rejected username alice password proxy-password while reading -----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
      artifactPath: null,
      composeFilePath: null,
      validationSource: 'internal-syntax',
      routeId: 'at-vie-wg-001',
      routeHostname: 'at-vie-wg-001',
      routeBindIp: '127.0.0.2',
      serviceName: 'wireproxy-at-vie-wg-001',
      command: null,
    } satisfies RuntimeStartDiagnostic;
    const { store, paths } = await seedSavedConfig(env, {
      configure: (config) => ({
        ...config,
        runtime: {
          ...config.runtime,
          status: {
            phase: 'running',
            lastCheckedAt: '2026-03-21T08:09:00.000Z',
            message: 'Runtime is already up.',
          },
        },
      }),
      lastStart: rawFailureReport,
    });
    const stdout = createBufferSink();
    const stderr = createBufferSink();

    const action = createDoctorCommandAction({
      store,
      stdout,
      stderr,
      checkedAt: '2026-03-21T08:10:30.000Z',
      resolveHostname: async (hostname) =>
        hostname === 'se-got-wg-101' ? ['127.0.0.1'] : ['127.0.0.2'],
      inspectRuntime: async () =>
        createComposeStatusSuccess(paths.runtimeComposeFile, [
          {
            name: 'mullgate-routing-layer-1',
            service: 'routing-layer',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 2 minutes',
            exitCode: 0,
            publishers: [],
          },
          {
            name: 'mullgate-wireproxy-se-got-wg-101-1',
            service: 'wireproxy-se-got-wg-101',
            project: 'mullgate',
            state: 'running',
            health: 'healthy',
            status: 'Up 2 minutes',
            exitCode: 0,
            publishers: [],
          },
          {
            name: 'mullgate-wireproxy-at-vie-wg-001-1',
            service: 'wireproxy-at-vie-wg-001',
            project: 'mullgate',
            state: 'exited',
            health: null,
            status: 'Exited (2) 5 seconds ago',
            exitCode: 2,
            publishers: [],
          },
        ]),
    });

    await action();

    expect(process.exitCode).toBe(1);
    expect(stdout.value.current).toBe('');
    expect(stderr.value.current).not.toContain('proxy-password');
    expect(stderr.value.current).not.toContain('123456789012');
    expect(stderr.value.current).not.toContain('private-key-value-2');
    expect(stderr.value.current).not.toContain('BEGIN PRIVATE KEY');
    expect(`\n${normalizeOutput(stderr.value.current, env)}`).toMatchInlineSnapshot(`
      "
      Mullgate doctor
      overall: fail
      checked at: 2026-03-21T08:10:30.000Z
      mode: offline-default
      config: /tmp/mullgate-home/config/mullgate/config.json
      runtime dir: /tmp/mullgate-home/state/mullgate/runtime
      relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
      wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
      runtime manifest: /tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json (present)
      last start report: /tmp/mullgate-home/state/mullgate/runtime/last-start.json (present)

      checks
      1. config: pass
         summary: Loaded the canonical Mullgate config successfully.
         detail: config=/tmp/mullgate-home/config/mullgate/config.json
         detail: routes=2
         detail: saved-runtime-phase=running
         detail: exposure-mode=loopback

      2. platform-support: pass
         summary: Current platform matches the fully supported Linux runtime contract.
         detail: platform=linux
         detail: platform-source=process.platform
         detail: support-level=full
         detail: mode-label=Linux-first runtime support
         detail: summary=Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.
         detail: runtime-story=Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.
         detail: config-paths=supported
         detail: config-workflow=supported
         detail: runtime-artifacts=supported
         detail: runtime-execution=supported
         detail: diagnostics=supported
         detail: host-networking=Native host networking available
         detail: host-networking-summary=Docker host networking behaves as expected on Linux, so the routing layer and per-route wireproxy listeners can bind directly to the saved route IPs.
         detail: guidance=Linux is the reference runtime target for the current Mullgate topology and verification flow.
         detail: guidance=Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.

      3. validation-artifacts: pass
         summary: Wireproxy config artifacts and persisted validation reports are present.
         detail: saved-runtime-phase=running
         detail: saved-runtime-message=Runtime is already up.
         detail: wireproxy-config=/tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf (present)
         detail: report[se-got-wg-101]=ok via internal-syntax
         detail: report[at-vie-wg-001]=ok via internal-syntax

      4. relay-cache: pass
         summary: Saved Mullvad relay metadata is readable and fresh enough for offline diagnostics.
         detail: relay-cache=/tmp/mullgate-home/cache/mullgate/relays.json
         detail: source=app-wireguard-v1
         detail: endpoint=https://api.mullvad.net/public/relays/wireguard/v1/
         detail: fetched-at=2026-03-21T07:55:00.000Z
         detail: relay-count=2
         detail: age=0h

      5. exposure-contract: pass
         summary: Saved exposure contract is internally coherent.
         detail: mode=loopback
         detail: mode-label=Loopback / local-only
         detail: recommendation=local-default
         detail: posture-summary=Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.
         detail: remote-story=Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.
         detail: base-domain=n/a
         detail: allow-lan=no
         detail: dns-records=0
         detail: routes=2
         detail: bind-remediation=Keep loopback mode on local-only bind IPs. If you need remote access, rerun \`mullgate config exposure --mode private-network ...\` with one trusted-network bind IP per route.
         detail: hostname-remediation=For local host-file testing, use \`mullgate config hosts\` and apply the emitted block on this machine so each route hostname resolves to its saved loopback bind IP.
         detail: restart-remediation=After changing exposure settings, rerun \`mullgate config validate\` or \`mullgate start\` so the runtime artifacts match the saved local-only posture.
         detail: info: Loopback mode is local-only. Keep using \`mullgate config hosts\` for host-file testing on this machine.

      6. bind-posture: pass
         summary: Saved bind IPs match the configured exposure posture.
         detail: setup.bind.host=127.0.0.1
         detail: route[1] se-got-wg-101 bind-ip=127.0.0.1
         detail: route[2] at-vie-wg-001 bind-ip=127.0.0.2

      7. hostname-resolution: pass
         summary: Configured hostnames resolve to the bind IPs promised by the saved exposure contract.
         detail: route se-got-wg-101: se-got-wg-101 -> 127.0.0.1
         detail: route at-vie-wg-001: at-vie-wg-001 -> 127.0.0.2

      8. runtime: fail
         summary: Live Docker Compose state shows one or more expected Mullgate services are stopped or degraded.
         detail: compose-command=docker compose --file /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml ps --all --format json
         detail: containers=3
         detail: running=2
         detail: starting=0
         detail: stopped=1
         detail: unhealthy=0
         detail: routing-layer=running (status=Up 2 minutes, health=healthy, exit=0)
         detail: route se-got-wg-101 (wireproxy-se-got-wg-101)=running (status=Up 2 minutes, health=healthy, exit=0)
         detail: route at-vie-wg-001 (wireproxy-at-vie-wg-001)=exited (status=Exited (2) 5 seconds ago, exit=2)
         remediation: Inspect \`docker compose ps\` / \`docker compose logs\` for the named services, fix the failing route or routing layer, then rerun \`mullgate start\`.

      9. last-start: fail
         summary: The last recorded \`mullgate start\` attempt failed with an auth-related route/runtime error.
         detail: status=failure
         detail: attempted-at=2026-03-21T08:10:00.000Z
         detail: phase=compose-launch
         detail: source=docker-compose
         detail: code=COMPOSE_UP_FAILED
         detail: route-id=at-vie-wg-001
         detail: route-hostname=at-vie-wg-001
         detail: route-bind-ip=127.0.0.2
         detail: service=wireproxy-at-vie-wg-001
         detail: reason=Docker Compose failed for [redacted] / [redacted] / [redacted] while authenticating route at-vie-wg-001.
         detail: cause=service wireproxy-at-vie-wg-001 rejected username alice password [redacted] while reading [redacted]
         remediation: Check route at-vie-wg-001, service wireproxy-at-vie-wg-001, hostname at-vie-wg-001, bind 127.0.0.2 for rejected proxy auth or stale rendered credentials. If credentials changed, update \`setup.auth.username\` / \`setup.auth.password\` with \`mullgate config set\`, then rerun \`mullgate config validate\` and \`mullgate start\`."
    `);
  });
});
