import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildProxyExportPlan,
  parseProxyExportSelectors,
  renderExposureReport,
  renderHostsReport,
  renderPathReport,
  renderProxyExportPreview,
  renderProxyExportSuccess,
  renderRegionGroupsReport,
  updateExposureConfig,
} from '../../src/commands/config.js';
import { resolveMullgatePaths } from '../../src/config/paths.js';
import { CONFIG_VERSION, type MullgateConfig } from '../../src/config/schema.js';
import { ConfigStore } from '../../src/config/store.js';
import type { MullvadRelayCatalog } from '../../src/mullvad/fetch-relays.js';
import { requireDefined } from '../../src/required.js';
import { createFixtureRoute, createFixtureRuntime } from '../helpers/mullgate-fixtures.js';

function requireRoute(
  config: MullgateConfig,
  index: number,
): MullgateConfig['routing']['locations'][number] {
  return requireDefined(config.routing.locations[index], `Expected fixture route ${index + 1}.`);
}

function createFixtureConfig(): MullgateConfig {
  const env = {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: '/tmp/mullgate-home',
    XDG_CONFIG_HOME: '/tmp/mullgate-home/config',
    XDG_STATE_HOME: '/tmp/mullgate-home/state',
    XDG_CACHE_HOME: '/tmp/mullgate-home/cache',
  };
  const paths = resolveMullgatePaths(env);
  const timestamp = '2026-03-21T04:10:00.000Z';
  const homeDir = requireDefined(env.HOME, 'Expected HOME in the fixture env.');

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
        certPath: path.join(homeDir, 'certs', 'proxy.crt'),
        keyPath: path.join(homeDir, 'certs', 'proxy.key'),
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
        createFixtureRoute({
          alias: 'sweden-gothenburg',
          hostname: 'sweden-gothenburg',
          bindIp: '127.0.0.1',
          requested: 'sweden-gothenburg',
          country: 'se',
          city: 'got',
          hostnameLabel: 'se-got-wg-101',
          resolvedAlias: 'sweden-gothenburg',
          exit: {
            relayHostname: 'se-got-wg-101',
            relayFqdn: 'se-got-wg-101.relays.mullvad.net',
            socksHostname: 'se-got-wg-101-socks.relays.mullvad.net',
          },
        }),
        createFixtureRoute({
          alias: 'austria-vienna',
          hostname: 'austria-vienna',
          bindIp: '127.0.0.2',
          requested: 'austria-vienna',
          country: 'at',
          city: 'vie',
          hostnameLabel: 'at-vie-wg-001',
          resolvedAlias: 'austria-vienna',
          exit: {
            relayHostname: 'at-vie-wg-001',
            relayFqdn: 'at-vie-wg-001.relays.mullvad.net',
            socksHostname: 'at-vie-wg-001-socks.relays.mullvad.net',
          },
        }),
      ],
    },
    runtime: createFixtureRuntime({
      paths,
      status: {
        phase: 'validated',
        lastCheckedAt: timestamp,
        message: 'Fixture config already validated.',
      },
    }),
    diagnostics: {
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

function createFixtureRelayCatalog(): MullvadRelayCatalog {
  return {
    source: 'www-relays-all',
    fetchedAt: '2026-03-21T04:10:00.000Z',
    endpoint: 'https://api.mullvad.net/public/relays/wireguard/v1/',
    relayCount: 3,
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
      {
        code: 'us',
        name: 'United States',
        cities: [{ code: 'nyc', name: 'New York', relayCount: 1 }],
      },
    ],
    relays: [
      {
        hostname: 'at-vie-wg-001',
        fqdn: 'at-vie-wg-001.relays.mullvad.net',
        source: 'www-relays-all',
        active: true,
        owned: false,
        provider: 'datawagon',
        publicKey: 'relay-public-key-at-vie-001',
        endpointIpv4: '185.213.154.1',
        networkPortSpeed: 1000,
        stboot: false,
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
        source: 'www-relays-all',
        active: true,
        owned: true,
        provider: 'm247',
        publicKey: 'relay-public-key-se-got-101',
        endpointIpv4: '185.213.154.2',
        networkPortSpeed: 10000,
        stboot: true,
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'got',
          cityName: 'Gothenburg',
        },
      },
      {
        hostname: 'us-nyc-wg-001',
        fqdn: 'us-nyc-wg-001.relays.mullvad.net',
        source: 'www-relays-all',
        active: true,
        owned: false,
        provider: 'xtom',
        publicKey: 'relay-public-key-us-nyc-001',
        endpointIpv4: '185.213.154.3',
        networkPortSpeed: 5000,
        stboot: false,
        location: {
          countryCode: 'us',
          countryName: 'United States',
          cityCode: 'nyc',
          cityName: 'New York',
        },
      },
    ],
  };
}

describe('config inspection helpers', () => {
  it('renders platform support posture in the path report for non-Linux installs', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MULLGATE_PLATFORM: 'macos',
      HOME: '/Users/alice',
      XDG_CONFIG_HOME: undefined,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: undefined,
    };
    const report = await new ConfigStore(resolveMullgatePaths(env)).inspectPaths();

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

  it('prints secret-safe host mappings plus a copy-paste hosts block', () => {
    const config = createFixtureConfig();

    const report = renderHostsReport(config, '/tmp/mullgate-home/config/mullgate/config.json');

    expect(report).not.toContain('multi-route-secret');
    expect(report).not.toContain('123456789012');
    expect(report).not.toContain('private-key-value-1');
    expect(report).not.toContain('private-key-value-2');
    expect(`\n${report}`).toMatchInlineSnapshot(`
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
    const firstRoute = requireRoute(config, 0);
    const secondRoute = requireRoute(config, 1);
    config.setup.exposure = {
      mode: 'private-network',
      allowLan: true,
      baseDomain: 'proxy.example.com',
    };
    config.setup.bind.host = '192.168.10.10';
    firstRoute.hostname = 'sweden-gothenburg.proxy.example.com';
    firstRoute.bindIp = '192.168.10.10';
    secondRoute.hostname = 'austria-vienna.proxy.example.com';
    secondRoute.bindIp = '192.168.10.11';
    config.runtime.status = {
      phase: 'unvalidated',
      lastCheckedAt: null,
      message:
        'Exposure settings changed; rerun `mullgate validate` or `mullgate start` to refresh runtime artifacts.',
    };

    const report = renderExposureReport(config, '/tmp/mullgate-home/config/mullgate/config.json');

    expect(report).not.toContain('multi-route-secret');
    expect(report).not.toContain('123456789012');
    expect(report).not.toContain('private-key-value-1');
    expect(report).toContain(
      'socks5://[redacted]:[redacted]@sweden-gothenburg.proxy.example.com:1080',
    );
    expect(`\n${report}`).toMatchInlineSnapshot(`
      "
      Mullgate exposure report
      phase: inspect-config
      source: canonical-config
      config: /tmp/mullgate-home/config/mullgate/config.json
      mode: private-network
      mode label: Private network / Tailscale-first
      recommendation: recommended-remote
      posture summary: Recommended remote posture. Use this for Tailscale, LAN, or other trusted private overlays before considering public exposure.
      remote story: Keep bind IPs private, ensure route hostnames resolve inside the trusted network, and use \`mullgate proxy access\` when local host-file wiring is the easiest path.
      base domain: proxy.example.com
      allow lan: yes
      runtime status: unvalidated
      restart needed: yes
      runtime message: Exposure settings changed; rerun \`mullgate validate\` or \`mullgate start\` to refresh runtime artifacts.

      guidance
      - Private-network mode is the recommended remote posture for Tailscale, LAN, and other trusted overlays. Keep it private by ensuring every bind IP stays reachable only inside that trusted network.
      - Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.
      - Publish the DNS records below so every route hostname resolves to its matching bind IP.

      remediation
      - bind posture: Keep private-network mode on trusted-network bind IPs only. Use one distinct RFC1918 or overlay-network address per route so destination-IP routing stays truthful.
      - hostname resolution: Make each route hostname resolve to its saved private-network bind IP inside Tailscale/LAN DNS, or use \`mullgate proxy access\` when host-file wiring is the intended local workaround.
      - restart: After exposure or bind-IP changes, rerun \`mullgate proxy validate\` or \`mullgate proxy start\` so the runtime artifacts and operator guidance match the recommended private-network posture.

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
      - warning: Exposure settings changed; rerun \`mullgate validate\` or \`mullgate start\` to refresh runtime artifacts.

      local host-file mapping
      - \`mullgate proxy access\` remains the copy/paste /etc/hosts view for local-only testing."
    `);
  });

  it('renders the dedicated exposure report for no-domain direct-IP public access', () => {
    const config = createFixtureConfig();
    const firstRoute = requireRoute(config, 0);
    const secondRoute = requireRoute(config, 1);
    config.setup.exposure = {
      mode: 'public',
      allowLan: true,
      baseDomain: null,
    };
    config.setup.bind.host = '203.0.113.10';
    firstRoute.hostname = '203.0.113.10';
    firstRoute.bindIp = '203.0.113.10';
    secondRoute.hostname = '203.0.113.11';
    secondRoute.bindIp = '203.0.113.11';
    config.runtime.status = {
      phase: 'unvalidated',
      lastCheckedAt: null,
      message:
        'Exposure settings changed; rerun `mullgate validate` or `mullgate start` to refresh runtime artifacts.',
    };

    const report = renderExposureReport(config, '/tmp/mullgate-home/config/mullgate/config.json');

    expect(report).not.toContain('multi-route-secret');
    expect(report).not.toContain('123456789012');
    expect(report).not.toContain('private-key-value-1');
    expect(report).toContain('socks5://[redacted]:[redacted]@203.0.113.10:1080');
    expect(`\n${report}`).toMatchInlineSnapshot(`
      "
      Mullgate exposure report
      phase: inspect-config
      source: canonical-config
      config: /tmp/mullgate-home/config/mullgate/config.json
      mode: public
      mode label: Advanced public exposure
      recommendation: advanced-remote
      posture summary: Expert-only remote posture. Publicly routable listeners are possible, but Mullgate does not treat this as the default or safest operating mode.
      remote story: Prefer private-network mode unless you intentionally need internet-reachable listeners and can provide DNS, firewalling, monitoring, and host hardening yourself.
      base domain: n/a
      allow lan: yes
      runtime status: unvalidated
      restart needed: yes
      runtime message: Exposure settings changed; rerun \`mullgate validate\` or \`mullgate start\` to refresh runtime artifacts.

      guidance
      - Public mode is advanced operator territory. Only use it when you intentionally want internet-reachable listeners and are prepared to harden the host around them.
      - Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.
      - No base domain is configured, so clients must reach each route via the direct bind IP entrypoints below.

      remediation
      - bind posture: Use public mode only with intentionally public, distinct bind IPs per route. If you are not deliberately publishing internet-reachable listeners, switch back to private-network mode.
      - hostname resolution: Publish DNS A records so every route hostname resolves to its saved public bind IP before expecting remote hostname access to work on the open internet.
      - restart: After changing exposure or DNS-facing bind IPs, rerun \`mullgate proxy validate\` or \`mullgate proxy start\` so runtime artifacts reflect the advanced public posture accurately.

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
      - warning: Exposure settings changed; rerun \`mullgate validate\` or \`mullgate start\` to refresh runtime artifacts.

      local host-file mapping
      - \`mullgate proxy access\` remains the copy/paste /etc/hosts view for local-only testing."
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
    expect(
      result.config.routing.locations.map((location) => ({
        hostname: location.hostname,
        bindIp: location.bindIp,
      })),
    ).toEqual([
      { hostname: 'sweden-gothenburg.proxy.example.com', bindIp: '192.168.10.10' },
      { hostname: 'austria-vienna.proxy.example.com', bindIp: '192.168.10.11' },
    ]);
    expect(result.config.runtime.status).toEqual({
      phase: 'unvalidated',
      lastCheckedAt: null,
      message:
        'Exposure settings changed; rerun `mullgate proxy validate` or `mullgate proxy start` to refresh runtime artifacts.',
    });
    expect(
      `\n${renderExposureReport(result.config, '/tmp/mullgate-home/config/mullgate/config.json')}`,
    ).toContain('dns: sweden-gothenburg.proxy.example.com A 192.168.10.10');
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
      message:
        'Non-loopback multi-route exposure requires distinct bind IPs, but found duplicates: 192.168.10.10.',
      cause:
        'S03 routing still dispatches by destination bind IP, so multiple remote routes cannot safely share one published IP.',
      artifactPath: '/tmp/mullgate-home/config/mullgate/config.json',
    });
  });

  it('parses interleaved proxy export selectors in CLI order', () => {
    const result = parseProxyExportSelectors([
      '--protocol',
      'http',
      '--country',
      'se',
      '--count',
      '1',
      '--region=europe',
      '--count=2',
      '--output',
      './proxy.txt',
    ]);

    expect(result).toEqual({
      ok: true,
      selectors: [
        {
          kind: 'country',
          value: 'se',
          providers: [],
          owner: 'all',
          runMode: 'all',
          minPortSpeed: null,
          requestedCount: 1,
        },
        {
          kind: 'region',
          value: 'europe',
          providers: [],
          owner: 'all',
          runMode: 'all',
          minPortSpeed: null,
          requestedCount: 2,
        },
      ],
    });
  });

  it('rejects proxy export counts that are not attached to a selector', () => {
    const result = parseProxyExportSelectors(['--count', '2']);

    expect(result).toEqual({
      ok: false,
      phase: 'export-proxies',
      source: 'input',
      message: 'Pass --count after a --country or --region selector.',
    });
  });

  it('parses city, server, and provider refinements on selector batches', () => {
    const result = parseProxyExportSelectors([
      '--country',
      'Sweden',
      '--city',
      'Gothenburg',
      '--provider',
      'm247',
      '--provider',
      'xtom',
      '--count',
      '2',
      '--country',
      'Austria',
      '--server',
      'at-vie-wg-001',
      '--count',
      '1',
      '--region',
      'europe',
      '--provider',
      'datawagon',
      '--count',
      '3',
    ]);

    expect(result).toEqual({
      ok: true,
      selectors: [
        {
          kind: 'country',
          value: 'sweden',
          city: 'gothenburg',
          providers: ['m247', 'xtom'],
          owner: 'all',
          runMode: 'all',
          minPortSpeed: null,
          requestedCount: 2,
        },
        {
          kind: 'country',
          value: 'austria',
          server: 'at-vie-wg-001',
          providers: [],
          owner: 'all',
          runMode: 'all',
          minPortSpeed: null,
          requestedCount: 1,
        },
        {
          kind: 'region',
          value: 'europe',
          providers: ['datawagon'],
          owner: 'all',
          runMode: 'all',
          minPortSpeed: null,
          requestedCount: 3,
        },
      ],
    });
  });

  it('parses relay ownership, run mode, and minimum port speed filters', () => {
    const result = parseProxyExportSelectors([
      '--country',
      'Sweden',
      '--owner',
      'mullvad',
      '--run-mode',
      'ram',
      '--min-port-speed',
      '10000',
      '--count',
      '1',
    ]);

    expect(result).toEqual({
      ok: true,
      selectors: [
        {
          kind: 'country',
          value: 'sweden',
          providers: [],
          owner: 'mullvad',
          runMode: 'ram',
          minPortSpeed: 10000,
          requestedCount: 1,
        },
      ],
    });
  });

  it('plans proxy exports with ordered selector dedupe and stable filenames', () => {
    const config = createFixtureConfig();
    const firstRoute = requireRoute(config, 0);
    const secondRoute = requireRoute(config, 1);
    config.setup.exposure = {
      mode: 'private-network',
      allowLan: true,
      baseDomain: 'proxy.example.com',
    };
    config.setup.bind.host = '192.168.10.10';
    firstRoute.hostname = 'sweden-gothenburg.proxy.example.com';
    firstRoute.bindIp = '192.168.10.10';
    secondRoute.hostname = 'austria-vienna.proxy.example.com';
    secondRoute.bindIp = '192.168.10.11';
    config.routing.locations.push({
      ...structuredClone(firstRoute),
      ...createFixtureRoute({
        alias: 'usa-new-york',
        hostname: 'usa-new-york.proxy.example.com',
        bindIp: '192.168.10.12',
        requested: 'usa-new-york',
        country: 'us',
        city: 'nyc',
        hostnameLabel: 'us-nyc-wg-001',
        resolvedAlias: 'usa-new-york',
        providers: firstRoute.mullvad.relayConstraints.providers,
        exit: {
          relayHostname: 'us-nyc-wg-001',
          relayFqdn: 'us-nyc-wg-001.relays.mullvad.net',
          socksHostname: 'us-nyc-wg-001-socks.relays.mullvad.net',
        },
      }),
    });

    const result = buildProxyExportPlan({
      config,
      protocol: 'http',
      selectors: [
        {
          kind: 'country',
          value: 'se',
          providers: [],
          owner: 'all',
          runMode: 'all',
          minPortSpeed: null,
          requestedCount: 1,
        },
        {
          kind: 'region',
          value: 'europe',
          providers: [],
          owner: 'all',
          runMode: 'all',
          minPortSpeed: null,
          requestedCount: 2,
        },
      ],
      relayCatalog: createFixtureRelayCatalog(),
      configPath: '/tmp/mullgate-home/config/mullgate/config.json',
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(
      `\n${renderProxyExportSuccess({
        result,
        configPath: '/tmp/mullgate-home/config/mullgate/config.json',
        outputPath: './proxy-http-country-se-1--region-europe-2.txt',
      })}`,
    ).toMatchInlineSnapshot(`
      "
      Mullgate proxy export complete.
      phase: export-proxies
      source: canonical-config
      config: /tmp/mullgate-home/config/mullgate/config.json
      protocol: http
      write mode: file
      selectors: 2
      1. country=se requested=1 matched=1 exported=1
      2. region=europe requested=2 matched=1 exported=1
      exported count: 2
      output: ./proxy-http-country-se-1--region-europe-2.txt"
    `);
    expect(`\n${result.outputText}`).toMatchInlineSnapshot(`
      "
      http://alice:multi-route-secret@sweden-gothenburg.proxy.example.com:8080
      http://alice:multi-route-secret@austria-vienna.proxy.example.com:8080
      "
    `);
    expect(result.outputText).not.toContain('[redacted]');
    expect(
      `\n${renderProxyExportPreview({
        result,
        configPath: '/tmp/mullgate-home/config/mullgate/config.json',
        outputPath: './proxy-http-country-se-1--region-europe-2.txt',
      })}`,
    ).toMatchInlineSnapshot(`
      "
      Mullgate proxy export preview.
      phase: export-proxies
      source: canonical-config
      config: /tmp/mullgate-home/config/mullgate/config.json
      protocol: http
      write mode: dry-run
      selectors: 2
      1. country=se requested=1 matched=1 exported=1
      2. region=europe requested=2 matched=1 exported=1
      exported count: 2
      output: ./proxy-http-country-se-1--region-europe-2.txt

      preview
      1. http://alice:multi-route-secret@sweden-gothenburg.proxy.example.com:8080 (alias: sweden-gothenburg, country: se, city: got, relay: se-got-wg-101)
      2. http://alice:multi-route-secret@austria-vienna.proxy.example.com:8080 (alias: austria-vienna, country: at, city: vie, relay: at-vie-wg-001)"
    `);
  });

  it('rejects unknown export regions with a documented error', () => {
    const config = createFixtureConfig();
    const result = buildProxyExportPlan({
      config,
      protocol: 'socks5',
      selectors: [
        {
          kind: 'region',
          value: 'antarctica',
          providers: [],
          owner: 'all',
          runMode: 'all',
          minPortSpeed: null,
          requestedCount: 1,
        },
      ],
      relayCatalog: createFixtureRelayCatalog(),
      configPath: '/tmp/mullgate-home/config/mullgate/config.json',
    });

    expect(result).toEqual({
      ok: false,
      phase: 'export-proxies',
      source: 'input',
      message:
        'Unknown region antarctica. Supported regions: americas, asia-pacific, europe, middle-east-africa.',
      configPath: '/tmp/mullgate-home/config/mullgate/config.json',
    });
  });

  it('filters planned proxy exports by ownership, run mode, and minimum port speed', () => {
    const config = createFixtureConfig();
    const result = buildProxyExportPlan({
      config,
      protocol: 'socks5',
      selectors: [
        {
          kind: 'country',
          value: 'se',
          providers: [],
          owner: 'mullvad',
          runMode: 'ram',
          minPortSpeed: 9000,
          requestedCount: 1,
        },
      ],
      relayCatalog: createFixtureRelayCatalog(),
      configPath: '/tmp/mullgate-home/config/mullgate/config.json',
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.entries.map((entry) => entry.alias)).toEqual(['sweden-gothenburg']);
  });

  it('renders the curated region group report', () => {
    expect(`\n${renderRegionGroupsReport()}`).toMatchInlineSnapshot(`
      "
      Mullgate region groups
      phase: inspect-config
      source: canonical-region-groups
      regions: 4

      1. americas
         countries: ag, ai, ar, aw, bb, bl, bm, bo, br, bs, bz, ca, cl, co, cr, cu, dm, do, ec, fk, gd, gl, gp, gt, gy, hn, ht, jm, kn, ky, lc, mf, mq, ms, mx, ni, pa, pe, pm, pr, py, sr, sv, tc, tt, us, uy, vc, ve, vg, vi
         example: mullgate proxy export --region americas --count 5

      2. asia-pacific
         countries: as, au, bd, bn, bt, cc, ck, cn, cx, fj, fm, gu, hk, id, in, jp, kh, ki, kp, kr, la, lk, mh, mm, mn, mo, mp, mv, my, nc, nf, np, nr, nu, nz, pg, ph, pk, pn, pw, sb, sg, th, tk, tl, to, tv, tw, vn, vu, wf, ws
         example: mullgate proxy export --region asia-pacific --count 5

      3. europe
         countries: ad, al, at, ba, be, bg, by, ch, cy, cz, de, dk, ee, es, fi, fo, fr, gb, gg, gi, gr, hr, hu, ie, im, is, it, je, li, lt, lu, lv, mc, md, me, mk, mt, nl, no, pl, pt, ro, rs, se, si, sj, sk, sm, ua, va
         example: mullgate proxy export --region europe --count 5

      4. middle-east-africa
         countries: ae, am, ao, az, bf, bi, bj, bw, cd, cf, cg, ci, cm, cv, dj, dz, eg, eh, er, et, ga, ge, gh, gm, gn, gq, gw, il, iq, ir, jo, ke, km, kw, lb, lr, ls, ly, ma, mg, ml, mr, mu, mw, mz, na, ne, ng, om, qa, re, rw, sa, sc, sd, sh, sl, sn, so, ss, st, sz, td, tg, tn, tr, tz, ug, ye, yt, za, zm, zw
         example: mullgate proxy export --region middle-east-africa --count 5"
    `);
  });
});
