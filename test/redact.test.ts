import { describe, expect, it } from 'vitest';

import { resolveMullgatePaths } from '../src/config/paths.js';
import { collectKnownSecrets } from '../src/config/redact.js';
import {
  CONFIG_VERSION,
  type MullgateConfig,
  mullgateConfigSchema,
  sensitiveConfigFieldPaths,
} from '../src/config/schema.js';
import { createFixtureRoute, createFixtureRuntime } from './helpers/mullgate-fixtures.js';

describe('collectKnownSecrets', () => {
  it('includes every sensitive schema field value', () => {
    const config = createFixtureConfig();
    const secrets = collectKnownSecrets(config);

    expect(sensitiveConfigFieldPaths).toEqual([
      'setup.auth.password',
      'mullvad.accountNumber',
      'mullvad.wireguard.privateKey',
    ]);

    for (const path of sensitiveConfigFieldPaths) {
      expect(secrets).toContain(readConfigValue(config, path));
    }
  });
});

function readConfigValue(
  config: MullgateConfig,
  path: (typeof sensitiveConfigFieldPaths)[number],
): string {
  switch (path) {
    case 'setup.auth.password':
      return config.setup.auth.password;
    case 'mullvad.accountNumber':
      return config.mullvad.accountNumber;
    case 'mullvad.wireguard.privateKey':
      return config.mullvad.wireguard.privateKey ?? '';
  }
}

function createFixtureConfig(): MullgateConfig {
  const paths = resolveMullgatePaths({
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    XDG_CONFIG_HOME: '/tmp/mullgate-redact-schema-sync/config',
    XDG_STATE_HOME: '/tmp/mullgate-redact-schema-sync/state',
    XDG_CACHE_HOME: '/tmp/mullgate-redact-schema-sync/cache',
  });
  const timestamp = '2026-03-20T18:48:01.000Z';

  return mullgateConfigSchema.parse({
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
        password: 'schema-sync-password',
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
        privateKey: 'schema-sync-private-key',
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
  });
}
