import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderExposureReport, renderHostsReport, updateExposureConfig } from '../../src/commands/config.js';
import { resolveMullgatePaths } from '../../src/config/paths.js';
import { CONFIG_VERSION, type MullgateConfig } from '../../src/config/schema.js';

function createFixtureConfig(): MullgateConfig {
  const env = {
    ...process.env,
    HOME: '/tmp/mullgate-home',
    XDG_CONFIG_HOME: '/tmp/mullgate-home/config',
    XDG_STATE_HOME: '/tmp/mullgate-home/state',
    XDG_CACHE_HOME: '/tmp/mullgate-home/cache',
  };
  const paths = resolveMullgatePaths(env);
  const timestamp = '2026-03-21T04:10:00.000Z';

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
        password: 'multi-route-secret',
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
        enabled: true,
        certPath: path.join(env.HOME!, 'certs', 'proxy.crt'),
        keyPath: path.join(env.HOME!, 'certs', 'proxy.key'),
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: 'mullgate-runtime-test-1',
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
          hostname: 'sweden-gothenburg',
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
            deviceName: 'mullgate-runtime-test-1',
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
            routeId: 'sweden-gothenburg',
            wireproxyServiceName: 'wireproxy-sweden-gothenburg',
            haproxyBackendName: 'route-sweden-gothenburg',
            wireproxyConfigFile: 'wireproxy-sweden-gothenburg.conf',
          },
        },
        {
          alias: 'austria-vienna',
          hostname: 'austria-vienna',
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
            deviceName: 'mullgate-runtime-test-2',
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
            routeId: 'austria-vienna',
            wireproxyServiceName: 'wireproxy-austria-vienna',
            haproxyBackendName: 'route-austria-vienna',
            wireproxyConfigFile: 'wireproxy-austria-vienna.conf',
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

describe('config inspection helpers', () => {
  it('prints secret-safe host mappings plus a copy-paste hosts block', () => {
    const config = createFixtureConfig();

    const report = renderHostsReport(config, '/tmp/mullgate-home/config/mullgate/config.json');

    expect(report).not.toContain('multi-route-secret');
    expect(report).not.toContain('123456789012');
    expect(report).not.toContain('private-key-value-1');
    expect(report).not.toContain('private-key-value-2');
    expect('\n' + report).toMatchInlineSnapshot(`
"\nMullgate routed hosts
phase: inspect-config
source: canonical-config
config: /tmp/mullgate-home/config/mullgate/config.json
routes: 2
hostname -> bind ip
1. sweden-gothenburg -> 127.0.0.1 (alias: sweden-gothenburg, route id: sweden-gothenburg)
2. austria-vienna -> 127.0.0.2 (alias: austria-vienna, route id: austria-vienna)

copy/paste hosts block
127.0.0.1 sweden-gothenburg
127.0.0.2 austria-vienna"
`);
  });

  it('renders the dedicated exposure report with DNS guidance, direct-IP entrypoints, and restart hints', () => {
    const config = createFixtureConfig();
    config.setup.exposure = {
      mode: 'private-network',
      allowLan: true,
      baseDomain: 'proxy.example.com',
    };
    config.setup.bind.host = '192.168.10.10';
    config.routing.locations[0]!.hostname = 'sweden-gothenburg.proxy.example.com';
    config.routing.locations[0]!.bindIp = '192.168.10.10';
    config.routing.locations[1]!.hostname = 'austria-vienna.proxy.example.com';
    config.routing.locations[1]!.bindIp = '192.168.10.11';
    config.runtime.status = {
      phase: 'unvalidated',
      lastCheckedAt: null,
      message: 'Exposure settings changed; rerun `mullgate config validate` or `mullgate start` to refresh runtime artifacts.',
    };

    const report = renderExposureReport(config, '/tmp/mullgate-home/config/mullgate/config.json');

    expect(report).not.toContain('multi-route-secret');
    expect(report).not.toContain('123456789012');
    expect(report).not.toContain('private-key-value-1');
    expect(report).toContain('[redacted]:[redacted]@sweden-gothenburg.proxy.example.com:1080');
    expect('\n' + report).toMatchInlineSnapshot(`
"\nMullgate exposure report
phase: inspect-config
source: canonical-config
config: /tmp/mullgate-home/config/mullgate/config.json
mode: private-network
base domain: proxy.example.com
allow lan: yes
runtime status: unvalidated
restart needed: yes
runtime message: Exposure settings changed; rerun \`mullgate config validate\` or \`mullgate start\` to refresh runtime artifacts.

guidance
- Private-network mode expects those bind IPs to be reachable from your LAN, VPN, or overlay network.
- Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.
- Publish the DNS records below so every route hostname resolves to its matching bind IP.

routes
1. sweden-gothenburg.proxy.example.com -> 192.168.10.10
   alias: sweden-gothenburg
   route id: sweden-gothenburg
   dns: sweden-gothenburg.proxy.example.com A 192.168.10.10
   socks5 hostname: socks5://[redacted]:[redacted]@sweden-gothenburg.proxy.example.com:1080
   socks5 direct ip: socks5://[redacted]:[redacted]@192.168.10.10:1080
   http hostname: http://[redacted]:[redacted]@sweden-gothenburg.proxy.example.com:8080
   http direct ip: http://[redacted]:[redacted]@192.168.10.10:8080
   https hostname: https://[redacted]:[redacted]@sweden-gothenburg.proxy.example.com:8443
   https direct ip: https://[redacted]:[redacted]@192.168.10.10:8443
2. austria-vienna.proxy.example.com -> 192.168.10.11
   alias: austria-vienna
   route id: austria-vienna
   dns: austria-vienna.proxy.example.com A 192.168.10.11
   socks5 hostname: socks5://[redacted]:[redacted]@austria-vienna.proxy.example.com:1080
   socks5 direct ip: socks5://[redacted]:[redacted]@192.168.10.11:1080
   http hostname: http://[redacted]:[redacted]@austria-vienna.proxy.example.com:8080
   http direct ip: http://[redacted]:[redacted]@192.168.10.11:8080
   https hostname: https://[redacted]:[redacted]@austria-vienna.proxy.example.com:8443
   https direct ip: https://[redacted]:[redacted]@192.168.10.11:8443

warnings
- info: Publish one DNS A record per route hostname and point it at the matching bind IP before expecting remote hostname access to work.
- warning: Exposure settings changed; rerun \`mullgate config validate\` or \`mullgate start\` to refresh runtime artifacts.

local host-file mapping
- \`mullgate config hosts\` remains the copy/paste /etc/hosts view for local-only testing."
`);
  });

  it('renders the dedicated exposure report for no-domain direct-IP public access', () => {
    const config = createFixtureConfig();
    config.setup.exposure = {
      mode: 'public',
      allowLan: true,
      baseDomain: null,
    };
    config.setup.bind.host = '203.0.113.10';
    config.routing.locations[0]!.hostname = '203.0.113.10';
    config.routing.locations[0]!.bindIp = '203.0.113.10';
    config.routing.locations[1]!.hostname = '203.0.113.11';
    config.routing.locations[1]!.bindIp = '203.0.113.11';
    config.runtime.status = {
      phase: 'unvalidated',
      lastCheckedAt: null,
      message: 'Exposure settings changed; rerun `mullgate config validate` or `mullgate start` to refresh runtime artifacts.',
    };

    const report = renderExposureReport(config, '/tmp/mullgate-home/config/mullgate/config.json');

    expect(report).not.toContain('multi-route-secret');
    expect(report).not.toContain('123456789012');
    expect(report).not.toContain('private-key-value-1');
    expect(report).toContain('[redacted]:[redacted]@203.0.113.10:1080');
    expect('\n' + report).toMatchInlineSnapshot(`
"\nMullgate exposure report
phase: inspect-config
source: canonical-config
config: /tmp/mullgate-home/config/mullgate/config.json
mode: public
base domain: n/a
allow lan: yes
runtime status: unvalidated
restart needed: yes
runtime message: Exposure settings changed; rerun \`mullgate config validate\` or \`mullgate start\` to refresh runtime artifacts.

guidance
- Public mode expects those bind IPs to be reachable from the public internet.
- Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.
- No base domain is configured, so clients must reach each route via the direct bind IP entrypoints below.

routes
1. 203.0.113.10 -> 203.0.113.10
   alias: sweden-gothenburg
   route id: sweden-gothenburg
   dns: not required; use direct bind IP entrypoints
   socks5 hostname: socks5://[redacted]:[redacted]@203.0.113.10:1080
   socks5 direct ip: socks5://[redacted]:[redacted]@203.0.113.10:1080
   http hostname: http://[redacted]:[redacted]@203.0.113.10:8080
   http direct ip: http://[redacted]:[redacted]@203.0.113.10:8080
   https hostname: https://[redacted]:[redacted]@203.0.113.10:8443
   https direct ip: https://[redacted]:[redacted]@203.0.113.10:8443
2. 203.0.113.11 -> 203.0.113.11
   alias: austria-vienna
   route id: austria-vienna
   dns: not required; use direct bind IP entrypoints
   socks5 hostname: socks5://[redacted]:[redacted]@203.0.113.11:1080
   socks5 direct ip: socks5://[redacted]:[redacted]@203.0.113.11:1080
   http hostname: http://[redacted]:[redacted]@203.0.113.11:8080
   http direct ip: http://[redacted]:[redacted]@203.0.113.11:8080
   https hostname: https://[redacted]:[redacted]@203.0.113.11:8443
   https direct ip: https://[redacted]:[redacted]@203.0.113.11:8443

warnings
- warning: Public exposure publishes authenticated proxy listeners on publicly routable IPs. Confirm firewalling, rate limits, and monitoring before enabling it on the open internet.
- warning: Exposure settings changed; rerun \`mullgate config validate\` or \`mullgate start\` to refresh runtime artifacts.

local host-file mapping
- \`mullgate config hosts\` remains the copy/paste /etc/hosts view for local-only testing."
`);
  });

  it('updates exposure settings without raw JSON edits and mirrors the first bind IP back to setup.bind.host', () => {
    const config = createFixtureConfig();

    const result = updateExposureConfig(config, '/tmp/mullgate-home/config/mullgate/config.json', {
      mode: 'private-network',
      baseDomain: 'proxy.example.com',
      baseDomainSpecified: true,
      routeBindIps: ['192.168.10.10', '192.168.10.11'],
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.config.setup.exposure).toEqual({
      mode: 'private-network',
      allowLan: true,
      baseDomain: 'proxy.example.com',
    });
    expect(result.config.setup.bind.host).toBe('192.168.10.10');
    expect(result.config.routing.locations.map((location) => ({ hostname: location.hostname, bindIp: location.bindIp }))).toEqual([
      { hostname: 'sweden-gothenburg.proxy.example.com', bindIp: '192.168.10.10' },
      { hostname: 'austria-vienna.proxy.example.com', bindIp: '192.168.10.11' },
    ]);
    expect(result.config.runtime.status).toEqual({
      phase: 'unvalidated',
      lastCheckedAt: null,
      message: 'Exposure settings changed; rerun `mullgate config validate` or `mullgate start` to refresh runtime artifacts.',
    });
    expect('\n' + renderExposureReport(result.config, '/tmp/mullgate-home/config/mullgate/config.json')).toContain(
      'dns: sweden-gothenburg.proxy.example.com A 192.168.10.10',
    );
  });

  it('rejects ambiguous non-loopback bind IP edits with an explicit routed-exposure failure', () => {
    const config = createFixtureConfig();

    const result = updateExposureConfig(config, '/tmp/mullgate-home/config/mullgate/config.json', {
      mode: 'private-network',
      baseDomainSpecified: false,
      routeBindIps: ['192.168.10.10', '192.168.10.10'],
    });

    expect(result).toEqual({
      ok: false,
      phase: 'setup-validation',
      source: 'input',
      code: 'AMBIGUOUS_SHARED_BIND_IP',
      message: 'Non-loopback multi-route exposure requires distinct bind IPs, but found duplicates: 192.168.10.10.',
      cause: 'S03 routing still dispatches by destination bind IP, so multiple remote routes cannot safely share one published IP.',
      artifactPath: '/tmp/mullgate-home/config/mullgate/config.json',
    });
  });
});
