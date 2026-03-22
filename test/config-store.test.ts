import { mkdtempSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { renderPathReport } from '../src/commands/config.js';
import { resolveMullgatePaths } from '../src/config/paths.js';
import { formatRedactedConfig, redactConfig } from '../src/config/redact.js';
import { ConfigStore, listTemporaryArtifacts } from '../src/config/store.js';
import { CONFIG_VERSION, mullgateConfigSchema, type MullgateConfig } from '../src/config/schema.js';

const temporaryDirectories: string[] = [];

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-test-'));
  temporaryDirectories.push(root);

  return {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

function createPlatformEnvironment(platform: 'linux' | 'macos' | 'windows'): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), `mullgate-${platform}-test-`));
  temporaryDirectories.push(root);

  if (platform === 'windows') {
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
        {
          alias: 'se-sto',
          hostname: 'se-sto',
          bindIp: '127.0.0.1',
          relayPreference: {
            requested: 'se-sto',
            country: 'Sweden',
            city: 'Stockholm',
            hostnameLabel: 'se-sto',
            resolvedAlias: null,
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
          runtime: {
            routeId: 'se-sto',
            wireproxyServiceName: 'wireproxy-se-sto',
            haproxyBackendName: 'route-se-sto',
            wireproxyConfigFile: 'wireproxy-se-sto.conf',
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
        phase: 'unvalidated',
        lastCheckedAt: null,
        message: 'Pending first render.',
      },
    },
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
            "accountNumber": "123456789012",
            "deviceName": "mullgate-test-host",
            "lastProvisionedAt": null,
            "relayConstraints": {
              "ownership": "mullvad-owned",
              "providers": [
                "31173",
              ],
            },
            "wireguard": {
              "dnsServers": [
                "10.64.0.1",
              ],
              "gatewayIpv4": null,
              "gatewayIpv6": null,
              "ipv4Address": null,
              "ipv6Address": null,
              "peerEndpoint": null,
              "peerPublicKey": null,
              "privateKey": "private-key-value",
              "publicKey": "public-key-value",
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
            "haproxyBackendName": "route-se-sto",
            "routeId": "se-sto",
            "wireproxyConfigFile": "wireproxy-se-sto.conf",
            "wireproxyServiceName": "wireproxy-se-sto",
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
        "config home: /home/alice/.config (platform:linux-xdg-default)",
        "state home: /home/alice/.local/state (platform:linux-xdg-default)",
        "cache home: /home/alice/.cache (platform:linux-xdg-default)",
        "config file: /home/alice/.config/mullgate/config.json (missing)",
        "state dir: /home/alice/.local/state/mullgate",
        "cache dir: /home/alice/.cache/mullgate",
        "runtime dir: /home/alice/.local/state/mullgate/runtime (missing)",
        "wireproxy config: /home/alice/.local/state/mullgate/runtime/wireproxy.conf",
        "wireproxy configtest report: /home/alice/.local/state/mullgate/runtime/wireproxy-configtest.json",
        "docker compose: /home/alice/.local/state/mullgate/runtime/docker-compose.yml",
        "relay cache: /home/alice/.cache/mullgate/relays.json (missing)",
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
        "config home: /Users/alice/Library/Application Support (platform:macos-library-application-support)",
        "state home: /Users/alice/Library/Application Support (platform:macos-library-application-support)",
        "cache home: /Users/alice/Library/Caches (platform:macos-library-caches)",
        "config file: /Users/alice/Library/Application Support/mullgate/config.json (missing)",
        "state dir: /Users/alice/Library/Application Support/mullgate",
        "cache dir: /Users/alice/Library/Caches/mullgate",
        "runtime dir: /Users/alice/Library/Application Support/mullgate/runtime (missing)",
        "wireproxy config: /Users/alice/Library/Application Support/mullgate/runtime/wireproxy.conf",
        "wireproxy configtest report: /Users/alice/Library/Application Support/mullgate/runtime/wireproxy-configtest.json",
        "docker compose: /Users/alice/Library/Application Support/mullgate/runtime/docker-compose.yml",
        "relay cache: /Users/alice/Library/Caches/mullgate/relays.json (missing)",
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
        "config home: C:\\Users\\alice\\AppData\\Roaming (platform:windows-appdata)",
        "state home: C:\\Users\\alice\\AppData\\Local (platform:windows-localappdata)",
        "cache home: C:\\Users\\alice\\AppData\\Local (platform:windows-localappdata)",
        "config file: C:\\Users\\alice\\AppData\\Roaming\\mullgate\\config.json (missing)",
        "state dir: C:\\Users\\alice\\AppData\\Local\\mullgate",
        "cache dir: C:\\Users\\alice\\AppData\\Local\\mullgate",
        "runtime dir: C:\\Users\\alice\\AppData\\Local\\mullgate\\runtime (missing)",
        "wireproxy config: C:\\Users\\alice\\AppData\\Local\\mullgate\\runtime\\wireproxy.conf",
        "wireproxy configtest report: C:\\Users\\alice\\AppData\\Local\\mullgate\\runtime\\wireproxy-configtest.json",
        "docker compose: C:\\Users\\alice\\AppData\\Local\\mullgate\\runtime\\docker-compose.yml",
        "relay cache: C:\\Users\\alice\\AppData\\Local\\mullgate\\relays.json (missing)",
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
    expect(loaded.config.setup.location).toEqual(loaded.config.routing.locations[0]?.relayPreference);
    expect(loaded.config.setup.exposure.baseDomain).toBeNull();
    expect(loaded.config.mullvad).toEqual(loaded.config.routing.locations[0]?.mullvad);

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
          {
            alias: 'se-got',
            hostname: 'sto.internal',
            bindIp: '127.0.0.10',
            relayPreference: {
              requested: 'se-got',
              country: 'se',
              city: 'got',
              hostnameLabel: 'se-got-wg-101',
              resolvedAlias: 'sweden-gothenburg',
            },
            mullvad: {
              ...initial.mullvad,
              deviceName: 'route-one-device',
            },
            runtime: {
              routeId: 'se-got',
              wireproxyServiceName: 'wireproxy-se-got',
              haproxyBackendName: 'route-se-got',
              wireproxyConfigFile: 'wireproxy-se-got.conf',
            },
          },
          {
            alias: 'se-sto',
            hostname: 'sto-2.internal',
            bindIp: '127.0.0.11',
            relayPreference: {
              requested: 'se-sto',
              country: 'se',
              city: 'sto',
              hostnameLabel: 'se-sto-wg-001',
              resolvedAlias: 'sweden-stockholm',
            },
            mullvad: {
              ...initial.mullvad,
              deviceName: 'route-two-device',
            },
            runtime: {
              routeId: 'se-sto',
              wireproxyServiceName: 'wireproxy-se-sto',
              haproxyBackendName: 'route-se-sto',
              wireproxyConfigFile: 'wireproxy-se-sto.conf',
            },
          },
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
        deviceName: 'route-one-device',
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
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await listTemporaryArtifacts(store.paths.appConfigDir)).toEqual([]);
  });

  it('redacts account numbers, private keys, and passwords in human-readable output', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const config = createFixtureConfig(env);
    config.routing.locations.push({
      alias: 'se-got',
      hostname: 'got.internal',
      bindIp: '127.0.0.11',
      relayPreference: {
        requested: 'se-got',
        country: 'se',
        city: 'got',
        hostnameLabel: 'se-got-wg-101',
        resolvedAlias: 'sweden-gothenburg',
      },
      mullvad: {
        ...config.mullvad,
        accountNumber: '999999999999',
        deviceName: 'mullgate-secondary-route',
        wireguard: {
          ...config.mullvad.wireguard,
          privateKey: 'secondary-private-key',
        },
      },
      runtime: {
        routeId: 'se-got',
        wireproxyServiceName: 'wireproxy-se-got',
        haproxyBackendName: 'route-se-got',
        wireproxyConfigFile: 'wireproxy-se-got.conf',
      },
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
              accountNumber: '[redacted]',
              wireguard: {
                privateKey: '[redacted]',
              },
            },
          },
          {
            mullvad: {
              accountNumber: '[redacted]',
              wireguard: {
                privateKey: '[redacted]',
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
    expect(parsedRendered.routing.locations.map((location) => ({ alias: location.alias, hostname: location.hostname, bindIp: location.bindIp }))).toEqual([
      { alias: 'se-sto', hostname: 'se-sto', bindIp: '127.0.0.1' },
      { alias: 'se-got', hostname: 'got.internal', bindIp: '127.0.0.11' },
    ]);
    expect(parsedRendered.routing.locations[1]?.mullvad.accountNumber).toBe('[redacted]');
    expect(parsedRendered.routing.locations[1]?.runtime.routeId).toBe('se-got');
    expect(parsedRendered.runtime.sourceConfigPath).toContain('/config/mullgate/config.json');
  });

  it(
    'prints a clear empty-home message from the real CLI entrypoint',
    () => {
      const env = createTempEnvironment();
      const result = spawnSync('pnpm', ['exec', 'tsx', 'src/cli.ts', 'config', 'show'], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Mullgate is not configured yet.');
      expect(result.stdout).toContain(resolveMullgatePaths(env).configFile);
    },
    15000,
  );
});
