import { mkdtempSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
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
    runtime: {
      backend: 'wireproxy',
      sourceConfigPath: paths.configFile,
      wireproxyConfigPath: paths.wireproxyConfigFile,
      wireproxyConfigTestReportPath: paths.wireproxyConfigTestReportFile,
      relayCachePath: paths.provisioningCacheFile,
      dockerComposePath: path.join(paths.appStateDir, 'docker-compose.yml'),
      status: {
        phase: 'unvalidated',
        lastCheckedAt: null,
        message: 'Pending first render.',
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
    expect(config.runtime).toMatchInlineSnapshot(`
      {
        "backend": "wireproxy",
        "dockerComposePath": "${resolveMullgatePaths(env).appStateDir}/docker-compose.yml",
        "relayCachePath": "${resolveMullgatePaths(env).provisioningCacheFile}",
        "sourceConfigPath": "${resolveMullgatePaths(env).configFile}",
        "status": {
          "lastCheckedAt": null,
          "message": "Pending first render.",
          "phase": "unvalidated",
        },
        "wireproxyConfigPath": "${resolveMullgatePaths(env).wireproxyConfigFile}",
        "wireproxyConfigTestReportPath": "${resolveMullgatePaths(env).wireproxyConfigTestReportFile}",
      }
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
        "relay cache: ${resolveMullgatePaths(env).provisioningCacheFile} (missing)",
      ]
    `);
  });

  it('persists the canonical config atomically with restrictive permissions', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const initial = createFixtureConfig(env);
    const updated = {
      ...initial,
      updatedAt: '2026-03-20T18:49:01.000Z',
      setup: {
        ...initial.setup,
        auth: {
          ...initial.setup.auth,
          username: 'bob',
        },
      },
    } satisfies MullgateConfig;

    await store.save(initial);
    await store.save(updated);

    const saved = await readFile(store.paths.configFile, 'utf8');
    const stats = statSync(store.paths.configFile);

    expect(JSON.parse(saved)).toMatchObject({
      setup: {
        auth: {
          username: 'bob',
        },
      },
    });
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await listTemporaryArtifacts(store.paths.appConfigDir)).toEqual([]);
  });

  it('redacts account numbers, private keys, and passwords in human-readable output', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const config = createFixtureConfig(env);
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
    });
    expect(rendered).not.toContain('123456789012');
    expect(rendered).not.toContain('private-key-value');
    expect(rendered).not.toContain('super-secret-password');
    expect(JSON.parse(rendered)).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-03-20T18:48:01.000Z",
        "mullvad": {
          "accountNumber": "[redacted]",
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
            "privateKey": "[redacted]",
            "publicKey": "public-key-value",
          },
        },
        "runtime": {
          "backend": "wireproxy",
          "dockerComposePath": "${path.join(resolveMullgatePaths(env).appStateDir, 'docker-compose.yml')}",
          "relayCachePath": "${resolveMullgatePaths(env).provisioningCacheFile}",
          "sourceConfigPath": "${resolveMullgatePaths(env).configFile}",
          "status": {
            "lastCheckedAt": null,
            "message": "Pending first render.",
            "phase": "unvalidated",
          },
          "wireproxyConfigPath": "${resolveMullgatePaths(env).wireproxyConfigFile}",
          "wireproxyConfigTestReportPath": "${resolveMullgatePaths(env).wireproxyConfigTestReportFile}",
        },
        "setup": {
          "auth": {
            "password": "[redacted]",
            "username": "alice",
          },
          "bind": {
            "host": "127.0.0.1",
            "httpPort": 8080,
            "httpsPort": 8443,
            "socksPort": 1080,
          },
          "exposure": {
            "allowLan": false,
            "mode": "loopback",
          },
          "https": {
            "enabled": false,
          },
          "location": {
            "city": "Stockholm",
            "country": "Sweden",
            "hostnameLabel": "se-sto",
            "requested": "se-sto",
            "resolvedAlias": null,
          },
          "source": "guided-setup",
        },
        "updatedAt": "2026-03-20T18:48:01.000Z",
        "version": 1,
      }
    `);
  });

  it('prints a clear empty-home message from the real CLI entrypoint', () => {
    const env = createTempEnvironment();
    const result = spawnSync('pnpm', ['exec', 'tsx', 'src/cli.ts', 'config', 'show'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Mullgate is not configured yet.');
    expect(result.stdout).toContain(resolveMullgatePaths(env).configFile);
  });
});
