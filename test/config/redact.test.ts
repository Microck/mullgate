import { describe, expect, it } from 'vitest';

import { resolveMullgatePaths } from '../../src/config/paths.js';
import { collectKnownSecrets } from '../../src/config/redact.js';
import {
  CONFIG_VERSION,
  mullgateConfigSchema,
  sensitiveConfigFieldPaths,
  type MullgateConfig,
} from '../../src/config/schema.js';
import { createFixtureRoute, createFixtureRuntime } from '../helpers/mullgate-fixtures.js';

function createFixtureConfig(): MullgateConfig {
  const paths = resolveMullgatePaths({
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    XDG_CONFIG_HOME: '/tmp/mullgate/config',
    XDG_STATE_HOME: '/tmp/mullgate/state',
    XDG_CACHE_HOME: '/tmp/mullgate/cache',
  });

  return mullgateConfigSchema.parse({
    version: CONFIG_VERSION,
    createdAt: '2026-03-20T18:48:01.000Z',
    updatedAt: '2026-03-20T18:48:01.000Z',
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
        password: 'password-secret',
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
        privateKey: 'private-key-secret',
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

describe('config redaction secret coverage', () => {
  it('keeps collectKnownSecrets in sync with every schema-owned sensitive field', () => {
    const config = createFixtureConfig();
    const collectedSecrets = new Set(collectKnownSecrets(config));

    const expectedSecrets = new Map(
      sensitiveConfigFieldPaths.map((path) => {
        switch (path) {
          case 'setup.auth.password':
            return [path, config.setup.auth.password];
          case 'mullvad.accountNumber':
            return [path, config.mullvad.accountNumber];
          case 'mullvad.wireguard.privateKey':
            return [path, config.mullvad.wireguard.privateKey];
        }
      }),
    );

    expect(expectedSecrets.size).toBe(sensitiveConfigFieldPaths.length);

    for (const [path, secret] of expectedSecrets) {
      expect(secret, `${path} should stay non-empty in the fixture`).toBeTruthy();
      expect(collectedSecrets.has(secret as string), `${path} is missing from collectKnownSecrets()`).toBe(
        true,
      );
    }
  });
});
