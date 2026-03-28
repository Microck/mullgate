import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderPathReport } from '../src/commands/config.js';
import { resolveMullgatePaths } from '../src/config/paths.js';
import { formatRedactedConfig, redactConfig } from '../src/config/redact.js';
import { CONFIG_VERSION, type MullgateConfig, mullgateConfigSchema } from '../src/config/schema.js';
import { ConfigStore, listTemporaryArtifacts } from '../src/config/store.js';
import { createFixtureRoute, createFixtureRuntime } from './helpers/mullgate-fixtures.js';
import {
  cleanupWindowsFixtureArtifacts,
  expectPrivateFileMode,
} from './helpers/platform-test-utils.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const temporaryDirectories: string[] = [];
const windowsFixturePrefixes = [
  'C:\\Users\\alice\\AppData\\Local\\mullgate',
  'C:\\Users\\alice\\AppData\\Roaming\\mullgate',
] as const;

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-test-'));
  const linuxRoot = root.replaceAll('\\', '/');
  temporaryDirectories.push(root);

  return {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    XDG_CONFIG_HOME: `${linuxRoot}/config`,
    XDG_STATE_HOME: `${linuxRoot}/state`,
    XDG_CACHE_HOME: `${linuxRoot}/cache`,
  };
}

function createPlatformEnvironment(platform: 'linux' | 'macos' | 'windows'): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), `mullgate-${platform}-test-`));
  temporaryDirectories.push(root);

  if (platform === 'windows') {
    // These tests intentionally use fixed fake Windows paths in snapshots, so clear any
    // repo-root artifacts from earlier tests before checking the fallback-path contract.
    cleanupWindowsFixturePaths();

    return {
      ...process.env,
      MULLGATE_PLATFORM: 'windows',
      USERPROFILE: 'C:\\Users\\alice',
      APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      HOME: undefined,
      XDG_CONFIG_HOME: undefined,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: undefined,
      TMPDIR: root,
    };
  }

  if (platform === 'macos') {
    return {
      ...process.env,
      MULLGATE_PLATFORM: 'macos',
      HOME: '/Users/alice',
      XDG_CONFIG_HOME: undefined,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: undefined,
      TMPDIR: root,
    };
  }

  return {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: '/home/alice',
    XDG_CONFIG_HOME: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CACHE_HOME: undefined,
    TMPDIR: root,
  };
}

function cleanupWindowsFixturePaths(): void {
  cleanupWindowsFixtureArtifacts(windowsFixturePrefixes);
}

function createFixtureConfig(env: NodeJS.ProcessEnv): MullgateConfig {
  const paths = resolveMullgatePaths(env);
  const timestamp = '2026-03-20T18:48:01.000Z';

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
        password: 'super-secret-password',
      },
      exposure: {
        mode: 'loopback',
        allowLan: false,
        baseDomain: null,
      },
      location: {
        requested: 'se-sto',
        country: 'Sweden',
        city: 'Stockholm',
        hostnameLabel: 'se-sto',
        resolvedAlias: null,
      },
      https: {
        enabled: false,
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: 'mullgate-test-host',
      lastProvisionedAt: null,
      relayConstraints: {
        ownership: 'mullvad-owned',
        providers: ['31173'],
      },
      wireguard: {
        publicKey: 'public-key-value',
        privateKey: 'private-key-value',
        ipv4Address: null,
        ipv6Address: null,
        gatewayIpv4: null,
        gatewayIpv6: null,
        dnsServers: ['10.64.0.1'],
        peerPublicKey: null,
        peerEndpoint: null,
      },
    },
    routing: {
      locations: [
        createFixtureRoute({
          alias: 'se-sto',
          hostname: 'se-sto',
          bindIp: '127.0.0.1',
          requested: 'se-sto',
          country: 'Sweden',
          city: 'Stockholm',
          hostnameLabel: 'se-sto',
          resolvedAlias: null,
          providers: ['31173'],
          exit: {
            countryCode: 'se',
            cityCode: 'sto',
          },
        }),
      ],
    },
    runtime: createFixtureRuntime({
      paths,
      status: {
        phase: 'unvalidated',
        lastCheckedAt: null,
        message: 'Pending first render.',
      },
    }),
    diagnostics: {
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

function createLegacyFixtureConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const { routing: _routing, ...legacy } = createFixtureConfig(env);

  return {
    ...legacy,
    setup: {
      ...legacy.setup,
      exposure: {
        mode: legacy.setup.exposure.mode,
        allowLan: legacy.setup.exposure.allowLan,
      },
    },
  };
}

function createUnsupportedVersionFixtureConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const config = JSON.parse(JSON.stringify(createFixtureConfig(env))) as Record<string, unknown>;
  config.version = 1;
  return config;
}

afterEach(async () => {
  cleanupWindowsFixturePaths();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('mullgate config store', () => {
  it('parses the canonical config schema for all slice-owned concerns', () => {
    const env = createTempEnvironment();
    const config = createFixtureConfig(env);

    expect(() => mullgateConfigSchema.parse(config)).not.toThrow();
    expect(config.routing.locations).toMatchInlineSnapshot(`
      [
        {
          "alias": "se-sto",
          "bindIp": "127.0.0.1",
          "hostname": "se-sto",
          "mullvad": {
            "exit": {
              "cityCode": "sto",
              "countryCode": "se",
              "relayFqdn": "se-sto.relays.mullvad.net",
              "relayHostname": "se-sto",
              "socksHostname": "se-sto-socks.relays.mullvad.net",
              "socksPort": 1080,
            },
            "relayConstraints": {
              "providers": [
                "31173",
              ],
            },
          },
          "relayPreference": {
            "city": "Stockholm",
            "country": "Sweden",
            "hostnameLabel": "se-sto",
            "requested": "se-sto",
            "resolvedAlias": null,
          },
          "runtime": {
            "httpsBackendName": "route-se-sto",
            "routeId": "se-sto",
          },
        },
      ]
    `);
  });

  it('resolves Linux fallback paths predictably', async () => {
    const env = createPlatformEnvironment('linux');
    const store = new ConfigStore(resolveMullgatePaths(env));
    const report = await store.inspectPaths();

    expect(renderPathReport(report).split('\n')).toMatchInlineSnapshot(`
      [
        "Mullgate path report",
        "phase: resolve-paths",
        "source: canonical-path-contract",
        "platform: linux",
        "platform source: env:MULLGATE_PLATFORM",
        "platform support: full",
        "platform mode: Linux-first runtime support",
        "platform summary: Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.",
        "runtime story: Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.",
        "host networking: Native host networking available",
        "host networking summary: Docker host networking behaves as expected on Linux, so the routing layer and shared route-proxy listeners can bind directly to the saved route IPs.",
        "config home: /home/alice/.config (platform:linux-xdg-default)",
        "state home: /home/alice/.local/state (platform:linux-xdg-default)",
        "cache home: /home/alice/.cache (platform:linux-xdg-default)",
        "config file: /home/alice/.config/mullgate/config.json (missing)",
        "state dir: /home/alice/.local/state/mullgate",
        "cache dir: /home/alice/.cache/mullgate",
        "runtime dir: /home/alice/.local/state/mullgate/runtime (missing)",
        "entry wireproxy config: /home/alice/.local/state/mullgate/runtime/entry-wireproxy.conf",
        "route proxy config: /home/alice/.local/state/mullgate/runtime/route-proxy.cfg",
        "runtime validation report: /home/alice/.local/state/mullgate/runtime/runtime-validation.json",
        "docker compose: /home/alice/.local/state/mullgate/runtime/docker-compose.yml",
        "relay cache: /home/alice/.cache/mullgate/relays.json (missing)",
        "",
        "platform guidance",
        "- Linux is the reference runtime target for the current Mullgate topology and verification flow.",
        "- Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.",
        "",
        "platform warnings",
        "- none",
      ]
    `);
  });

  it('resolves macOS fallback paths predictably', async () => {
    const env = createPlatformEnvironment('macos');
    const store = new ConfigStore(resolveMullgatePaths(env));
    const report = await store.inspectPaths();

    expect(renderPathReport(report).split('\n')).toMatchInlineSnapshot(`
      [
        "Mullgate path report",
        "phase: resolve-paths",
        "source: canonical-path-contract",
        "platform: macos",
        "platform source: env:MULLGATE_PLATFORM",
        "platform support: partial",
        "platform mode: macOS path + diagnostics support",
        "platform summary: macOS keeps truthful config paths, runtime-manifest output, and diagnostics, but the current Docker-first runtime remains Linux-first because Docker Desktop does not provide the same host-networking semantics.",
        "runtime story: Use this platform for config inspection and deterministic diagnostics, but plan on a Linux host when you need the current multi-route runtime to be truthful end-to-end.",
        "host networking: Docker Desktop host networking is limited",
        "host networking summary: Docker Desktop does not expose Linux host-networking semantics for per-route bind IP listeners, so Mullgate cannot claim runtime parity with the Linux host-networking deployment on this platform.",
        "config home: /Users/alice/Library/Application Support (platform:macos-library-application-support)",
        "state home: /Users/alice/Library/Application Support (platform:macos-library-application-support)",
        "cache home: /Users/alice/Library/Caches (platform:macos-library-caches)",
        "config file: /Users/alice/Library/Application Support/mullgate/config.json (missing)",
        "state dir: /Users/alice/Library/Application Support/mullgate",
        "cache dir: /Users/alice/Library/Caches/mullgate",
        "runtime dir: /Users/alice/Library/Application Support/mullgate/runtime (missing)",
        "entry wireproxy config: /Users/alice/Library/Application Support/mullgate/runtime/entry-wireproxy.conf",
        "route proxy config: /Users/alice/Library/Application Support/mullgate/runtime/route-proxy.cfg",
        "runtime validation report: /Users/alice/Library/Application Support/mullgate/runtime/runtime-validation.json",
        "docker compose: /Users/alice/Library/Application Support/mullgate/runtime/docker-compose.yml",
        "relay cache: /Users/alice/Library/Caches/mullgate/relays.json (missing)",
        "",
        "platform guidance",
        "- macOS should still resolve the correct config/state/cache locations and emit the same exposure and diagnostic contracts as Linux.",
        "- When the CLI talks about runtime limitations on macOS, it should point at Docker Desktop host-networking differences instead of pretending the Linux runtime model is fully portable.",
        "",
        "platform warnings",
        "- warning: Linux remains the recommended runtime host for the current Docker-first Mullgate topology.",
        "- warning: Docker Desktop does not provide the Linux host-networking behavior that the current per-route bind-IP runtime depends on.",
      ]
    `);
  });

  it('resolves Windows fallback paths predictably', async () => {
    const env = createPlatformEnvironment('windows');
    const store = new ConfigStore(resolveMullgatePaths(env));
    const report = await store.inspectPaths();

    expect(renderPathReport(report).split('\n')).toMatchInlineSnapshot(`
      [
        "Mullgate path report",
        "phase: resolve-paths",
        "source: canonical-path-contract",
        "platform: windows",
        "platform source: env:MULLGATE_PLATFORM",
        "platform support: partial",
        "platform mode: Windows path + diagnostics support",
        "platform summary: Windows keeps truthful config paths, runtime-manifest output, and diagnostics, but the current Docker-first runtime remains Linux-first because Docker Desktop does not provide the same host-networking semantics.",
        "runtime story: Use this platform for config inspection and deterministic diagnostics, but plan on a Linux host when you need the current multi-route runtime to be truthful end-to-end.",
        "host networking: Docker Desktop host networking is limited",
        "host networking summary: Docker Desktop does not expose Linux host-networking semantics for per-route bind IP listeners, so Mullgate cannot claim runtime parity with the Linux host-networking deployment on this platform.",
        "config home: C:\\Users\\alice\\AppData\\Roaming (platform:windows-appdata)",
        "state home: C:\\Users\\alice\\AppData\\Local (platform:windows-localappdata)",
        "cache home: C:\\Users\\alice\\AppData\\Local (platform:windows-localappdata)",
        "config file: C:\\Users\\alice\\AppData\\Roaming\\mullgate\\config.json (missing)",
        "state dir: C:\\Users\\alice\\AppData\\Local\\mullgate",
        "cache dir: C:\\Users\\alice\\AppData\\Local\\mullgate",
        "runtime dir: C:\\Users\\alice\\AppData\\Local\\mullgate\\runtime (missing)",
        "entry wireproxy config: C:\\Users\\alice\\AppData\\Local\\mullgate\\runtime\\entry-wireproxy.conf",
        "route proxy config: C:\\Users\\alice\\AppData\\Local\\mullgate\\runtime\\route-proxy.cfg",
        "runtime validation report: C:\\Users\\alice\\AppData\\Local\\mullgate\\runtime\\runtime-validation.json",
        "docker compose: C:\\Users\\alice\\AppData\\Local\\mullgate\\runtime\\docker-compose.yml",
        "relay cache: C:\\Users\\alice\\AppData\\Local\\mullgate\\relays.json (missing)",
        "",
        "platform guidance",
        "- Windows should still resolve the correct config/state/cache locations and emit the same exposure and diagnostic contracts as Linux.",
        "- When the CLI talks about runtime limitations on Windows, it should point at Docker Desktop host-networking differences instead of pretending the Linux runtime model is fully portable.",
        "",
        "platform warnings",
        "- warning: Linux remains the recommended runtime host for the current Docker-first Mullgate topology.",
        "- warning: Docker Desktop does not provide the Linux host-networking behavior that the current per-route bind-IP runtime depends on.",
      ]
    `);
  });

  it('keeps explicit XDG overrides higher priority than platform fallbacks', async () => {
    const env: NodeJS.ProcessEnv = {
      ...createPlatformEnvironment('macos'),
      XDG_CONFIG_HOME: '/tmp/override-config',
      XDG_STATE_HOME: '/tmp/override-state',
      XDG_CACHE_HOME: '/tmp/override-cache',
    };
    const store = new ConfigStore(resolveMullgatePaths(env));
    const report = await store.inspectPaths();

    expect(report).toMatchObject({
      platform: 'macos',
      pathSources: {
        configHome: 'env:XDG_CONFIG_HOME',
        stateHome: 'env:XDG_STATE_HOME',
        cacheHome: 'env:XDG_CACHE_HOME',
      },
      paths: {
        configHome: '/tmp/override-config',
        stateHome: '/tmp/override-state',
        cacheHome: '/tmp/override-cache',
      },
    });
  });

  it('preserves platform-specific separator style for shared runtime artifacts', () => {
    expect(
      resolveMullgatePaths({
        ...process.env,
        MULLGATE_PLATFORM: 'linux',
        XDG_STATE_HOME: '/tmp/mullgate',
      }).entryWireproxyConfigFile,
    ).toBe('/tmp/mullgate/mullgate/runtime/entry-wireproxy.conf');

    expect(
      resolveMullgatePaths({
        ...process.env,
        MULLGATE_PLATFORM: 'windows',
        LOCALAPPDATA: 'C:/tmp/mullgate',
      }).entryWireproxyConfigFile,
    ).toBe('C:\\tmp\\mullgate\\mullgate\\runtime\\entry-wireproxy.conf');

    expect(
      resolveMullgatePaths({
        ...process.env,
        MULLGATE_PLATFORM: 'windows',
        LOCALAPPDATA: 'C:\\tmp\\mullgate',
      }).entryWireproxyConfigFile,
    ).toBe('C:\\tmp\\mullgate\\mullgate\\runtime\\entry-wireproxy.conf');
  });

  it('loads a legacy single-location config and persists the routed form with intact legacy mirrors', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const store = new ConfigStore(paths);
    const legacyConfig = createLegacyFixtureConfig(env);

    await mkdir(path.dirname(paths.configFile), { recursive: true, mode: 0o700 });
    await writeFile(paths.configFile, `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8');

    const loaded = await store.load();
    expect(loaded.ok && loaded.source === 'file').toBe(true);

    if (!loaded.ok || loaded.source !== 'file') {
      return;
    }

    expect(loaded.config.routing.locations).toHaveLength(1);
    expect(loaded.config.routing.locations[0]).toMatchObject({
      alias: 'se-sto',
      hostname: 'se-sto',
      bindIp: '127.0.0.1',
      relayPreference: {
        requested: 'se-sto',
      },
    });
    expect(loaded.config.setup.location).toEqual(
      loaded.config.routing.locations[0]?.relayPreference,
    );
    expect(loaded.config.setup.exposure.baseDomain).toBeNull();
    expect(loaded.config.mullvad).toMatchObject({
      deviceName: 'mullgate-test-host',
      relayConstraints: loaded.config.routing.locations[0]?.mullvad.relayConstraints,
    });

    await store.save(loaded.config);
    const saved = JSON.parse(await readFile(paths.configFile, 'utf8')) as MullgateConfig;

    expect(saved).toMatchObject({
      setup: {
        location: {
          requested: 'se-sto',
        },
      },
      mullvad: {
        deviceName: 'mullgate-test-host',
      },
      routing: {
        locations: [
          {
            alias: 'se-sto',
            hostname: 'se-sto',
            bindIp: '127.0.0.1',
            relayPreference: {
              requested: 'se-sto',
            },
            runtime: {
              routeId: 'se-sto',
            },
          },
        ],
      },
    });
  });

  it('fails with an operator recovery message for unsupported config versions', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const store = new ConfigStore(paths);
    const staleConfig = createUnsupportedVersionFixtureConfig(env);

    await mkdir(path.dirname(paths.configFile), { recursive: true, mode: 0o700 });
    await writeFile(paths.configFile, `${JSON.stringify(staleConfig, null, 2)}\n`, 'utf8');

    const loaded = await store.load();

    expect(loaded).toMatchObject({
      ok: false,
      phase: 'parse-config',
      source: 'file',
      artifactPath: paths.configFile,
      paths,
    });

    if (loaded.ok) {
      return;
    }

    expect(loaded.message).toContain('Config version 1 is no longer supported.');
    expect(loaded.message).toContain(
      'This is stale local state, not a config the current CLI will operate.',
    );
    expect(loaded.message).toContain(paths.configFile);
    expect(loaded.message).toContain(paths.runtimeDir);
    expect(loaded.message).toContain('rerun `mullgate setup` and `mullgate proxy start`');
  });

  it('persists routed configs atomically and mirrors the first route back into legacy fields', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const initial = createFixtureConfig(env);
    const updated = {
      ...initial,
      updatedAt: '2026-03-20T18:49:01.000Z',
      setup: {
        ...initial.setup,
        bind: {
          ...initial.setup.bind,
          host: '198.51.100.1',
        },
        exposure: {
          mode: 'private-network',
          allowLan: true,
          baseDomain: 'proxy.example.com',
        },
        location: {
          requested: 'stale-top-level-location',
          resolvedAlias: null,
        },
      },
      mullvad: {
        ...initial.mullvad,
        deviceName: 'stale-top-level-device',
      },
      routing: {
        locations: [
          createFixtureRoute({
            alias: 'se-got',
            hostname: 'sto.internal',
            bindIp: '127.0.0.10',
            requested: 'se-got',
            country: 'se',
            city: 'got',
            hostnameLabel: 'se-got-wg-101',
            resolvedAlias: 'sweden-gothenburg',
            providers: initial.mullvad.relayConstraints.providers,
            exit: {
              relayHostname: 'se-got-wg-101',
              relayFqdn: 'se-got-wg-101.relays.mullvad.net',
              socksHostname: 'se-got-wg-101-socks.relays.mullvad.net',
            },
          }),
          createFixtureRoute({
            alias: 'se-sto',
            hostname: 'sto-2.internal',
            bindIp: '127.0.0.11',
            requested: 'se-sto',
            country: 'se',
            city: 'sto',
            hostnameLabel: 'se-sto-wg-001',
            resolvedAlias: 'sweden-stockholm',
            providers: initial.mullvad.relayConstraints.providers,
            exit: {
              relayHostname: 'se-sto-wg-001',
              relayFqdn: 'se-sto-wg-001.relays.mullvad.net',
              socksHostname: 'se-sto-wg-001-socks.relays.mullvad.net',
            },
          }),
        ],
      },
    } satisfies MullgateConfig;

    await store.save(initial);
    await store.save(updated);

    const saved = JSON.parse(await readFile(store.paths.configFile, 'utf8')) as MullgateConfig;
    const stats = statSync(store.paths.configFile);

    expect(saved).toMatchObject({
      setup: {
        bind: {
          host: '127.0.0.10',
        },
        exposure: {
          mode: 'private-network',
          allowLan: true,
          baseDomain: 'proxy.example.com',
        },
        location: {
          requested: 'se-got',
          resolvedAlias: 'sweden-gothenburg',
          hostnameLabel: 'se-got-wg-101',
        },
      },
      mullvad: {
        deviceName: 'stale-top-level-device',
      },
      routing: {
        locations: [
          {
            alias: 'se-got',
            hostname: 'sto.internal',
            bindIp: '127.0.0.10',
          },
          {
            alias: 'se-sto',
            hostname: 'sto-2.internal',
            bindIp: '127.0.0.11',
          },
        ],
      },
    });
    expect(saved.routing.locations).toHaveLength(2);
    expectPrivateFileMode(stats.mode);
    expect(await listTemporaryArtifacts(store.paths.appConfigDir)).toEqual([]);
  });

  it('redacts account numbers, private keys, and passwords in human-readable output', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const config = createFixtureConfig(env);
    config.routing.locations.push({
      ...createFixtureRoute({
        alias: 'se-got',
        hostname: 'got.internal',
        bindIp: '127.0.0.11',
        requested: 'se-got',
        country: 'se',
        city: 'got',
        hostnameLabel: 'se-got-wg-101',
        resolvedAlias: 'sweden-gothenburg',
        providers: config.mullvad.relayConstraints.providers,
        exit: {
          relayHostname: 'se-got-wg-101',
          relayFqdn: 'se-got-wg-101.relays.mullvad.net',
          socksHostname: 'se-got-wg-101-socks.relays.mullvad.net',
        },
      }),
    });
    await store.save(config);

    const redacted = redactConfig(config);
    const rendered = formatRedactedConfig(config);

    expect(redacted).toMatchObject({
      setup: {
        auth: {
          password: '[redacted]',
        },
      },
      mullvad: {
        accountNumber: '[redacted]',
        wireguard: {
          privateKey: '[redacted]',
        },
      },
      routing: {
        locations: [
          {
            mullvad: {
              relayConstraints: {
                providers: ['31173'],
              },
            },
          },
          {
            mullvad: {
              relayConstraints: {
                providers: ['31173'],
              },
            },
          },
        ],
      },
    });
    expect(rendered).not.toContain('123456789012');
    expect(rendered).not.toContain('999999999999');
    expect(rendered).not.toContain('private-key-value');
    expect(rendered).not.toContain('secondary-private-key');
    expect(rendered).not.toContain('super-secret-password');
    const parsedRendered = JSON.parse(rendered) as MullgateConfig;

    expect(parsedRendered.setup.auth.password).toBe('[redacted]');
    expect(parsedRendered.mullvad.accountNumber).toBe('[redacted]');
    expect(parsedRendered.routing.locations).toHaveLength(2);
    expect(
      parsedRendered.routing.locations.map((location) => ({
        alias: location.alias,
        hostname: location.hostname,
        bindIp: location.bindIp,
      })),
    ).toEqual([
      { alias: 'se-sto', hostname: 'se-sto', bindIp: '127.0.0.1' },
      { alias: 'se-got', hostname: 'got.internal', bindIp: '127.0.0.11' },
    ]);
    expect(parsedRendered.routing.locations[1]?.runtime.routeId).toBe('got.internal');
    expect(parsedRendered.runtime.sourceConfigPath).toContain('/config/mullgate/config.json');
  });

  it('prints a clear empty-home message from the real CLI entrypoint', () => {
    const env = createTempEnvironment();
    const result = spawnSync(process.execPath, [tsxCliPath, 'src/cli.ts', 'config', 'show'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Mullgate is not configured yet.');
    expect(result.stdout).toContain(resolveMullgatePaths(env).configFile);
  }, 15000);
});
