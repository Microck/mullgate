import { describe, expect, it } from 'vitest';

import {
  buildExposureContract,
  computePublishedPort,
  deriveExposureHostname,
  deriveLoopbackBindIp,
  deriveRuntimeBackendHost,
  deriveRuntimeListenerHost,
  normalizeExposureBaseDomain,
  usesInlineSelectorAccess,
  validateAccessSettings,
  validateExposureSettings,
} from '../../src/config/exposure-contract.js';
import type { MullgateConfig } from '../../src/config/schema.js';

function createMinimalConfig(
  overrides?: {
    exposureMode?: 'loopback' | 'private-network' | 'public';
    accessMode?: 'published-routes' | 'inline-selector';
    baseDomain?: string | null;
    password?: string;
    allowUnsafePublicEmptyPassword?: boolean;
    routeCount?: number;
    runtimePhase?: 'unvalidated' | 'validated' | 'starting' | 'running' | 'error';
    runtimeMessage?: string | null;
  },
): MullgateConfig {
  const exposureMode = overrides?.exposureMode ?? 'loopback';
  const accessMode = overrides?.accessMode ?? 'published-routes';
  const routeCount = overrides?.routeCount ?? 1;

  const locations = Array.from({ length: routeCount }, (_, i) => ({
    alias: `route-${i}`,
    hostname: `route-${i}.local`,
    bindIp: `127.0.0.${i + 1}`,
    relayPreference: { requested: `se`, resolvedAlias: null },
    mullvad: {
      relayConstraints: { providers: [] },
      exit: {
        relayHostname: `se-sto-${String(i).padStart(3, '0')}`,
        relayFqdn: `se-sto-${String(i).padStart(3, '0')}.relays.mullvad.net`,
        socksHostname: `se-sto-${String(i).padStart(3, '0')}-socks.relays.mullvad.net`,
        socksPort: 1080,
        countryCode: 'se',
        cityCode: 'sto',
      },
    },
    runtime: { routeId: `route-${i}`, httpsBackendName: `route-route-${i}` },
  }));

  return {
    version: 2,
    createdAt: '2025-01-01T00:00:00+00:00',
    updatedAt: '2025-01-01T00:00:00+00:00',
    setup: {
      source: 'guided-setup',
      bind: { host: '127.0.0.1', socksPort: 1080, httpPort: 8080, httpsPort: null },
      auth: { username: 'user', password: overrides?.password ?? 's3cret' },
      access: {
        mode: accessMode,
        allowUnsafePublicEmptyPassword: overrides?.allowUnsafePublicEmptyPassword ?? false,
      },
      exposure: {
        mode: exposureMode,
        allowLan: false,
        baseDomain: overrides?.baseDomain ?? null,
      },
      location: { requested: 'se', resolvedAlias: null },
      https: { enabled: false },
    },
    mullvad: {
      accountNumber: '12345678',
      deviceName: 'test',
      lastProvisionedAt: null,
      relayConstraints: { ownership: undefined, providers: [] },
      wireguard: {
        publicKey: null,
        privateKey: 'wg-key',
        ipv4Address: null,
        ipv6Address: null,
        gatewayIpv4: null,
        gatewayIpv6: null,
        dnsServers: [],
        peerPublicKey: null,
        peerEndpoint: null,
      },
    },
    routing: { locations },
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
      status: {
        phase: overrides?.runtimePhase ?? 'validated',
        lastCheckedAt: null,
        message: overrides?.runtimeMessage ?? null,
      },
    },
    diagnostics: {
      lastRuntimeStartReportPath: '/tmp/start-report.json',
      lastRuntimeStart: null,
    },
  } satisfies MullgateConfig;
}

describe('normalizeExposureBaseDomain', () => {
  it('returns null for undefined', () => {
    expect(normalizeExposureBaseDomain(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(normalizeExposureBaseDomain(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeExposureBaseDomain('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeExposureBaseDomain('   ')).toBeNull();
  });

  it('trims and lowercases the domain', () => {
    expect(normalizeExposureBaseDomain('  Example.COM  ')).toBe('example.com');
  });

  it('strips trailing dots', () => {
    expect(normalizeExposureBaseDomain('example.com.')).toBe('example.com');
    expect(normalizeExposureBaseDomain('example.com...')).toBe('example.com');
  });

  it('handles single-label domain', () => {
    expect(normalizeExposureBaseDomain('localhost')).toBe('localhost');
  });
});

describe('deriveLoopbackBindIp', () => {
  it('returns 127.0.0.1 for index 0', () => {
    expect(deriveLoopbackBindIp(0)).toBe('127.0.0.1');
  });

  it('returns 127.0.0.2 for index 1', () => {
    expect(deriveLoopbackBindIp(1)).toBe('127.0.0.2');
  });

  it('wraps to 127.0.1.1 at index 254', () => {
    expect(deriveLoopbackBindIp(254)).toBe('127.0.1.1');
  });

  it('handles index 253 correctly', () => {
    expect(deriveLoopbackBindIp(253)).toBe('127.0.0.254');
  });

  it('handles higher indices', () => {
    expect(deriveLoopbackBindIp(508)).toBe('127.0.2.1');
  });
});

describe('computePublishedPort', () => {
  it('returns basePort for loopback mode', () => {
    expect(computePublishedPort('loopback', 1080, 0)).toBe(1080);
    expect(computePublishedPort('loopback', 1080, 5)).toBe(1080);
  });

  it('returns basePort for public mode', () => {
    expect(computePublishedPort('public', 1080, 0)).toBe(1080);
  });

  it('adds routeIndex to basePort for private-network mode', () => {
    expect(computePublishedPort('private-network', 1080, 0)).toBe(1080);
    expect(computePublishedPort('private-network', 1080, 1)).toBe(1081);
    expect(computePublishedPort('private-network', 1080, 5)).toBe(1085);
  });
});

describe('deriveRuntimeListenerHost', () => {
  it('returns 0.0.0.0 for private-network mode', () => {
    expect(deriveRuntimeListenerHost('private-network', '10.0.0.1')).toBe('0.0.0.0');
  });

  it('returns bindIp for loopback mode', () => {
    expect(deriveRuntimeListenerHost('loopback', '127.0.0.1')).toBe('127.0.0.1');
  });

  it('returns bindIp for public mode', () => {
    expect(deriveRuntimeListenerHost('public', '1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('deriveRuntimeBackendHost', () => {
  it('returns 127.0.0.1 for private-network mode', () => {
    expect(deriveRuntimeBackendHost('private-network', '10.0.0.1')).toBe('127.0.0.1');
  });

  it('returns bindIp for loopback mode', () => {
    expect(deriveRuntimeBackendHost('loopback', '127.0.0.1')).toBe('127.0.0.1');
  });

  it('returns bindIp for public mode', () => {
    expect(deriveRuntimeBackendHost('public', '1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('deriveExposureHostname', () => {
  it('returns alias.baseDomain when baseDomain is set', () => {
    expect(deriveExposureHostname('route1', '127.0.0.1', 'example.com', 'loopback')).toBe(
      'route1.example.com',
    );
  });

  it('returns alias for loopback mode when no baseDomain', () => {
    expect(deriveExposureHostname('route1', '127.0.0.1', null, 'loopback')).toBe('route1');
  });

  it('returns bindIp for public mode when no baseDomain', () => {
    expect(deriveExposureHostname('route1', '1.2.3.4', null, 'public')).toBe('1.2.3.4');
  });
});

describe('usesInlineSelectorAccess', () => {
  it('returns true for inline-selector mode', () => {
    const config = createMinimalConfig({ accessMode: 'inline-selector' });
    expect(usesInlineSelectorAccess(config)).toBe(true);
  });

  it('returns false for published-routes mode', () => {
    const config = createMinimalConfig({ accessMode: 'published-routes' });
    expect(usesInlineSelectorAccess(config)).toBe(false);
  });
});

describe('validateAccessSettings', () => {
  it('returns ok for non-public mode', () => {
    const result = validateAccessSettings({
      exposureMode: 'loopback',
      accessMode: 'inline-selector',
      password: '',
      allowUnsafePublicEmptyPassword: false,
      artifactPath: '/tmp/test',
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok for public inline-selector with password', () => {
    const result = validateAccessSettings({
      exposureMode: 'public',
      accessMode: 'inline-selector',
      password: 'has-password',
      allowUnsafePublicEmptyPassword: false,
      artifactPath: '/tmp/test',
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok for public inline-selector with empty password when unsafe override enabled', () => {
    const result = validateAccessSettings({
      exposureMode: 'public',
      accessMode: 'inline-selector',
      password: '',
      allowUnsafePublicEmptyPassword: true,
      artifactPath: '/tmp/test',
    });
    expect(result.ok).toBe(true);
  });

  it('returns failure for public inline-selector with empty password', () => {
    const result = validateAccessSettings({
      exposureMode: 'public',
      accessMode: 'inline-selector',
      password: '',
      allowUnsafePublicEmptyPassword: false,
      artifactPath: '/tmp/test',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNSAFE_PUBLIC_INLINE_SELECTOR_EMPTY_PASSWORD');
  });

  it('returns ok for public published-routes with empty password', () => {
    const result = validateAccessSettings({
      exposureMode: 'public',
      accessMode: 'published-routes',
      password: '',
      allowUnsafePublicEmptyPassword: false,
      artifactPath: '/tmp/test',
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateExposureSettings', () => {
  const baseInput = {
    routeCount: 1,
    exposureMode: 'loopback' as const,
    exposureBaseDomain: null,
    routeBindIps: [] as string[],
    artifactPath: '/tmp/test',
  };

  it('returns success for loopback mode with no explicit bind IPs', () => {
    const result = validateExposureSettings(baseInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('loopback');
    expect(result.routeBindIps).toHaveLength(1);
    expect(result.routeBindIps[0]).toBe('127.0.0.1');
  });

  it('generates unique loopback IPs for multiple routes', () => {
    const result = validateExposureSettings({ ...baseInput, routeCount: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routeBindIps).toHaveLength(3);
    expect(result.routeBindIps[0]).toBe('127.0.0.1');
    expect(result.routeBindIps[1]).toBe('127.0.0.2');
    expect(result.routeBindIps[2]).toBe('127.0.0.3');
  });

  it('returns failure for invalid base domain', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureBaseDomain: 'not a valid domain!!!',
      exposureMode: 'public',
      routeBindIps: ['8.8.8.8'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_BASE_DOMAIN');
  });

  it('returns failure for single-label base domain', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureBaseDomain: 'localhost',
      exposureMode: 'public',
      routeBindIps: ['8.8.8.8'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_BASE_DOMAIN');
  });

  it('accepts valid base domain', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureBaseDomain: 'example.com',
      exposureMode: 'public',
      routeBindIps: ['8.8.8.8'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseDomain).toBe('example.com');
  });

  it('returns failure for private-network mode with zero bind IPs', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureMode: 'private-network',
      routeBindIps: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BIND_IP_COUNT_MISMATCH');
  });

  it('returns failure for private-network mode with multiple bind IPs', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureMode: 'private-network',
      routeBindIps: ['10.0.0.1', '10.0.0.2'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BIND_IP_COUNT_MISMATCH');
  });

  it('returns success for private-network mode with one valid bind IP', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureMode: 'private-network',
      routeBindIps: ['10.0.0.1'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindHost).toBe('10.0.0.1');
  });

  it('returns failure for non-IPv4 bind IP', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureMode: 'private-network',
      routeBindIps: ['not-an-ip'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_BIND_IP');
  });

  it('returns failure for duplicate bind IPs in multi-route public mode', () => {
    const result = validateExposureSettings({
      ...baseInput,
      routeCount: 2,
      exposureMode: 'public',
      routeBindIps: ['8.8.8.8', '8.8.8.8'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('AMBIGUOUS_SHARED_BIND_IP');
  });

  it('returns failure for mismatched bind IP count in public mode', () => {
    const result = validateExposureSettings({
      ...baseInput,
      routeCount: 2,
      exposureMode: 'public',
      routeBindIps: ['8.8.8.8'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BIND_IP_COUNT_MISMATCH');
  });

  it('returns failure for non-public bind IP in public mode', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureMode: 'public',
      routeBindIps: ['192.168.1.1'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNSAFE_PUBLIC_BIND_IP');
  });

  it('accepts Tailscale 100.x IPs for private-network mode', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureMode: 'private-network',
      routeBindIps: ['100.64.0.1'],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts 0.0.0.0 for private-network mode', () => {
    const result = validateExposureSettings({
      ...baseInput,
      exposureMode: 'private-network',
      routeBindIps: ['0.0.0.0'],
    });
    expect(result.ok).toBe(true);
  });
});

describe('buildExposureContract', () => {
  it('returns contract with loopback mode defaults', () => {
    const config = createMinimalConfig();
    const contract = buildExposureContract(config);

    expect(contract.mode).toBe('loopback');
    expect(contract.accessMode).toBe('published-routes');
    expect(contract.baseDomain).toBeNull();
    expect(contract.routes).toHaveLength(1);
    expect(contract.inlineSelector).toBeNull();
  });

  it('includes socks5 and http ports, no https when null', () => {
    const config = createMinimalConfig();
    const contract = buildExposureContract(config);

    expect(contract.ports).toHaveLength(2);
    expect(contract.ports.map((p) => p.protocol)).toEqual(['socks5', 'http']);
  });

  it('includes https port when configured', () => {
    const config = createMinimalConfig();
    // Need to set httpsPort on the config
    const configWithHttps: MullgateConfig = {
      ...config,
      setup: {
        ...config.setup,
        bind: { ...config.setup.bind, httpsPort: 8443 },
      },
    };
    const contract = buildExposureContract(configWithHttps);

    expect(contract.ports).toHaveLength(3);
    expect(contract.ports.map((p) => p.protocol)).toEqual(['socks5', 'http', 'https']);
  });

  it('generates LOOPBACK_ONLY warning for loopback mode', () => {
    const config = createMinimalConfig({ exposureMode: 'loopback' });
    const contract = buildExposureContract(config);

    expect(contract.warnings.some((w) => w.code === 'LOOPBACK_ONLY')).toBe(true);
  });

  it('generates PUBLIC_EXPOSURE warning for public mode', () => {
    const config = createMinimalConfig({ exposureMode: 'public' });
    const contract = buildExposureContract(config);

    expect(contract.warnings.some((w) => w.code === 'PUBLIC_EXPOSURE')).toBe(true);
  });

  it('generates DNS_REQUIRED warning when baseDomain is set', () => {
    const config = createMinimalConfig({
      exposureMode: 'private-network',
      baseDomain: 'example.com',
    });
    const contract = buildExposureContract(config);

    expect(contract.warnings.some((w) => w.code === 'DNS_REQUIRED')).toBe(true);
    expect(contract.baseDomain).toBe('example.com');
  });

  it('generates SINGLE_ROUTE warning for public mode with one route', () => {
    const config = createMinimalConfig({ exposureMode: 'public' });
    const contract = buildExposureContract(config);

    expect(contract.warnings.some((w) => w.code === 'SINGLE_ROUTE')).toBe(true);
  });

  it('does not generate SINGLE_ROUTE warning for public mode with multiple routes', () => {
    const config = createMinimalConfig({ exposureMode: 'public', routeCount: 3 });
    const contract = buildExposureContract(config);

    expect(contract.warnings.some((w) => w.code === 'SINGLE_ROUTE')).toBe(false);
  });

  it('generates RUNTIME_UNVALIDATED warning when status is unvalidated', () => {
    const config = createMinimalConfig({ runtimePhase: 'unvalidated' });
    const contract = buildExposureContract(config);

    expect(contract.warnings.some((w) => w.code === 'RUNTIME_UNVALIDATED')).toBe(true);
    expect(contract.runtimeStatus.restartRequired).toBe(true);
  });

  it('sets restartRequired to false when status is validated', () => {
    const config = createMinimalConfig({ runtimePhase: 'validated' });
    const contract = buildExposureContract(config);

    expect(contract.runtimeStatus.restartRequired).toBe(false);
  });

  it('returns empty routes for inline-selector mode', () => {
    const config = createMinimalConfig({ accessMode: 'inline-selector' });
    const contract = buildExposureContract(config);

    expect(contract.routes).toHaveLength(0);
    expect(contract.inlineSelector).not.toBeNull();
  });

  it('sets local-default posture for loopback mode', () => {
    const config = createMinimalConfig({ exposureMode: 'loopback' });
    const contract = buildExposureContract(config);

    expect(contract.posture.recommendation).toBe('local-default');
  });

  it('sets recommended-remote posture for private-network mode', () => {
    const config = createMinimalConfig({ exposureMode: 'private-network' });
    const contract = buildExposureContract(config);

    expect(contract.posture.recommendation).toBe('recommended-remote');
  });

  it('sets advanced-remote posture for public mode', () => {
    const config = createMinimalConfig({ exposureMode: 'public' });
    const contract = buildExposureContract(config);

    expect(contract.posture.recommendation).toBe('advanced-remote');
  });

  it('includes DNS records when baseDomain is configured', () => {
    const config = createMinimalConfig({
      exposureMode: 'public',
      baseDomain: 'proxy.example.com',
    });
    const contract = buildExposureContract(config);

    expect(contract.dnsRecords.length).toBeGreaterThan(0);
    expect(contract.dnsRecords[0]).toContain('A');
  });

  it('has no DNS records when no baseDomain', () => {
    const config = createMinimalConfig();
    const contract = buildExposureContract(config);

    expect(contract.dnsRecords).toHaveLength(0);
  });
});
