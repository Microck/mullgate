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

  it('resolves Linux XDG paths predictably', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const report = await store.inspectPaths();

    expect(renderPathReport(report).split('\n')).toMatchInlineSnapshot(`
      [
        "Mullgate path report",
        "phase: resolve-paths",
        "source: xdg",
        "config file: ${resolveMullgatePaths(env).configFile} (missing)",
        "state dir: ${resolveMullgatePaths(env).appStateDir}",
        "cache dir: ${resolveMullgatePaths(env).appCacheDir}",
        "wireproxy config: ${resolveMullgatePaths(env).wireproxyConfigFile}",
        "wireproxy configtest report: ${resolveMullgatePaths(env).wireproxyConfigTestReportFile}",
        "docker compose: ${resolveMullgatePaths(env).dockerComposePath}",
        "relay cache: ${resolveMullgatePaths(env).provisioningCacheFile} (missing)",
      ]
    `);
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
