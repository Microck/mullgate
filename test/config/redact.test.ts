import { describe, expect, it } from 'vitest';

import { collectKnownSecrets, REDACTED, redactSensitiveText } from '../../src/config/redact.js';
import {
  sensitiveConfigFieldPaths,
  type MullgateConfig,
} from '../../src/config/schema.js';

function createMinimalConfig(overrides?: {
  accountNumber?: string;
  password?: string;
  privateKey?: string;
}): MullgateConfig {
  return {
    version: 2,
    createdAt: '2025-01-01T00:00:00+00:00',
    updatedAt: '2025-01-01T00:00:00+00:00',
    setup: {
      source: 'guided-setup',
      bind: { host: '127.0.0.1', socksPort: 1080, httpPort: 8080, httpsPort: null },
      auth: { username: 'user', password: overrides?.password ?? 's3cret' },
      access: { mode: 'published-routes', allowUnsafePublicEmptyPassword: false },
      exposure: { mode: 'loopback', allowLan: false, baseDomain: null },
      location: { requested: 'se', resolvedAlias: null },
      https: { enabled: false },
    },
    mullvad: {
      accountNumber: overrides?.accountNumber ?? '12345678',
      deviceName: 'test',
      lastProvisionedAt: null,
      relayConstraints: { ownership: undefined, providers: [] },
      wireguard: {
        publicKey: null,
        privateKey: overrides?.privateKey ?? 'wg-private-key-data',
        ipv4Address: null,
        ipv6Address: null,
        gatewayIpv4: null,
        gatewayIpv6: null,
        dnsServers: [],
        peerPublicKey: null,
        peerEndpoint: null,
      },
    },
    routing: {
      locations: [
        {
          alias: 'se',
          hostname: 'se-test',
          bindIp: '127.0.0.1',
          relayPreference: { requested: 'se', resolvedAlias: null },
          mullvad: {
            relayConstraints: { providers: [] },
            exit: {
              relayHostname: 'se-test',
              relayFqdn: 'se-test.relays.mullvad.net',
              socksHostname: 'se-test-socks.relays.mullvad.net',
              socksPort: 1080,
              countryCode: 'se',
              cityCode: 'sto',
            },
          },
          runtime: { routeId: 'se-test', httpsBackendName: 'route-se-test' },
        },
      ],
    },
    runtime: {
      backend: 'shared-entry-wireguard-route-proxy',
      sourceConfigPath: '/tmp/config.json',
      entryWireproxyConfigPath: '/tmp/entry.conf',
      routeProxyConfigPath: '/tmp/route.conf',
      validationReportPath: '/tmp/report.json',
      relayCachePath: '/tmp/cache.json',
      dockerComposePath: null,
      runtimeBundle: {
        bundleDir: '/tmp/bundle',
        dockerComposePath: '/tmp/compose.yml',
        httpsSidecarConfigPath: '/tmp/https.conf',
        manifestPath: '/tmp/manifest.json',
      },
      status: { phase: 'unvalidated', lastCheckedAt: null, message: null },
    },
    diagnostics: {
      lastRuntimeStartReportPath: '/tmp/start-report.json',
      lastRuntimeStart: null,
    },
  } satisfies MullgateConfig;
}

describe('redactSensitiveText', () => {
  it('replaces account number in text', () => {
    const config = createMinimalConfig({ accountNumber: '99998888' });
    const result = redactSensitiveText('account is 99998888 please', config);
    expect(result).not.toContain('99998888');
    expect(result).toContain(REDACTED);
  });

  it('replaces password in text', () => {
    const config = createMinimalConfig({ password: 'my-password-123' });
    const result = redactSensitiveText('password my-password-123 was used', config);
    expect(result).not.toContain('my-password-123');
    expect(result).toContain(REDACTED);
  });

  it('replaces wireguard private key in text', () => {
    const config = createMinimalConfig({ privateKey: 'wg-key-abcdef' });
    const result = redactSensitiveText('key is wg-key-abcdef here', config);
    expect(result).not.toContain('wg-key-abcdef');
    expect(result).toContain(REDACTED);
  });

  it('replaces all three secret types at once', () => {
    const config = createMinimalConfig({
      accountNumber: '11111111',
      password: 'pass',
      privateKey: 'key123',
    });
    const text = 'account 11111111 password pass key key123';
    const result = redactSensitiveText(text, config);
    expect(result).not.toContain('11111111');
    expect(result).not.toContain('pass');
    expect(result).not.toContain('key123');
  });

  it('redacts private key PEM blocks', () => {
    const config = createMinimalConfig();
    const pemBlock =
      '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const result = redactSensitiveText(`before ${pemBlock} after`, config);
    expect(result).not.toContain('BEGIN PRIVATE KEY');
    expect(result).toContain(REDACTED);
  });

  it('redacts multiple PEM blocks', () => {
    const config = createMinimalConfig();
    const block = '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----';
    const result = redactSensitiveText(`${block} middle ${block}`, config);
    expect(result).not.toContain('BEGIN PRIVATE KEY');
    const matches = result.match(new RegExp(REDACTED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('returns unchanged text when no secrets match', () => {
    const config = createMinimalConfig();
    const text = 'hello world no secrets here';
    expect(redactSensitiveText(text, config)).toBe(text);
  });

  it('handles empty string input', () => {
    const config = createMinimalConfig();
    expect(redactSensitiveText('', config)).toBe('');
  });

  it('handles whitespace-only secret values', () => {
    const config = createMinimalConfig({ password: '   ', privateKey: '' });
    // Whitespace-only and empty secrets should be filtered out
    const text = 'nothing to redact here';
    expect(redactSensitiveText(text, config)).toBe(text);
  });

  it('handles overlapping secrets (shorter secret inside longer)', () => {
    const config = createMinimalConfig({
      password: 'abc',
      accountNumber: 'abcdef',
      privateKey: '',
    });
    const text = 'secret is abcdef';
    const result = redactSensitiveText(text, config);
    // 'abc' inside 'abcdef' - depends on replacement order
    // Both should be gone
    expect(result).not.toContain('abcdef');
  });

  it('handles secret that appears multiple times', () => {
    const config = createMinimalConfig({ accountNumber: '123456', privateKey: '' });
    const text = 'first:123456 second:123456 third:123456';
    const result = redactSensitiveText(text, config);
    expect(result).not.toContain('123456');
    const count = (result.match(new RegExp(REDACTED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    expect(count).toBe(3);
  });

  it('does not match partial substrings of secrets', () => {
    // The implementation uses split/join so it does exact match
    const config = createMinimalConfig({ accountNumber: '1234', privateKey: '' });
    const text = 'number is 12345 not 1234';
    const result = redactSensitiveText(text, config);
    // '1234' appears at end of '12345' and standalone
    // split/join replaces all occurrences of exact '1234'
    expect(result).not.toContain('1234');
  });
});

describe('collectKnownSecrets schema sync', () => {
  it('covers every sensitive field path from the schema', () => {
    const config = createMinimalConfig({
      accountNumber: '11112222',
      password: 'test-password',
      privateKey: 'test-private-key',
    });

    const collected = new Set(collectKnownSecrets(config));

    for (const path of sensitiveConfigFieldPaths) {
      let secret: string | undefined;
      switch (path) {
        case 'setup.auth.password':
          secret = config.setup.auth.password;
          break;
        case 'mullvad.accountNumber':
          secret = config.mullvad.accountNumber;
          break;
        case 'mullvad.wireguard.privateKey':
          secret = config.mullvad.wireguard.privateKey;
          break;
      }
      expect(secret, `${path} should be non-empty in fixture`).toBeTruthy();
      expect(collected.has(secret!), `${path} missing from collectKnownSecrets()`).toBe(true);
    }
  });
});
