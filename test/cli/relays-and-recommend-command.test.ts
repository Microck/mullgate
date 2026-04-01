import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runRecommendFlow } from '../../src/commands/recommend.js';
import {
  runRelaysListFlow,
  runRelaysProbeFlow,
  runRelaysVerifyFlow,
} from '../../src/commands/relays.js';
import { resolveMullgatePaths } from '../../src/config/paths.js';
import { CONFIG_VERSION, type MullgateConfig } from '../../src/config/schema.js';
import { ConfigStore } from '../../src/config/store.js';
import type { MullvadRelayCatalog } from '../../src/mullvad/fetch-relays.js';
import { createFixtureRoute, createFixtureRuntime } from '../helpers/mullgate-fixtures.js';
import { normalizeFixtureHomePath } from '../helpers/platform-test-utils.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.MULLGATE_MULLVAD_RELAYS_URL;
});

function createTempStore(): { readonly store: ConfigStore; readonly home: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-relays-test-'));
  tempRoots.push(root);
  const env = {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };

  return {
    store: new ConfigStore(resolveMullgatePaths(env)),
    home: root,
  };
}

function createFixtureConfig(store: ConfigStore): MullgateConfig {
  const timestamp = '2026-03-25T04:10:00.000Z';

  return {
    version: CONFIG_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    setup: {
      source: 'guided-setup',
      bind: {
        host: '192.168.10.10',
        socksPort: 1080,
        httpPort: 8080,
        httpsPort: 8443,
      },
      auth: {
        username: 'alice',
        password: 'multi-route-secret',
      },
      access: {
        mode: 'published-routes',
        allowUnsafePublicEmptyPassword: false,
      },
      exposure: {
        mode: 'private-network',
        allowLan: true,
        baseDomain: 'proxy.example.com',
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
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: 'mullgate-test-1',
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
          hostname: 'sweden-gothenburg.proxy.example.com',
          bindIp: '192.168.10.10',
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
          hostname: 'austria-vienna.proxy.example.com',
          bindIp: '192.168.10.11',
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
      paths: store.paths,
      status: {
        phase: 'validated',
        lastCheckedAt: timestamp,
        message: 'Fixture config already validated.',
      },
    }),
    diagnostics: {
      lastRuntimeStartReportPath: store.paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

function createRelayCatalog(): MullvadRelayCatalog {
  return {
    source: 'www-relays-all',
    fetchedAt: '2026-03-25T04:10:00.000Z',
    endpoint: 'fixture://relays',
    relayCount: 4,
    countries: [
      {
        code: 'at',
        name: 'Austria',
        cities: [{ code: 'vie', name: 'Vienna', relayCount: 1 }],
      },
      {
        code: 'se',
        name: 'Sweden',
        cities: [
          { code: 'got', name: 'Gothenburg', relayCount: 1 },
          { code: 'sto', name: 'Stockholm', relayCount: 1 },
        ],
      },
      {
        code: 'us',
        name: 'United States',
        cities: [{ code: 'nyc', name: 'New York', relayCount: 1 }],
      },
    ],
    relays: [
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
        hostname: 'se-sto-wg-002',
        fqdn: 'se-sto-wg-002.relays.mullvad.net',
        source: 'www-relays-all',
        active: true,
        owned: true,
        provider: 'm247',
        publicKey: 'relay-public-key-se-sto-002',
        endpointIpv4: '185.213.154.22',
        networkPortSpeed: 10000,
        stboot: true,
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      },
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
        hostname: 'us-nyc-wg-001',
        fqdn: 'us-nyc-wg-001.relays.mullvad.net',
        source: 'www-relays-all',
        active: false,
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

function createRelayCatalogDataUrl(): string {
  const relayCatalog = createRelayCatalog();
  const legacyPayload = relayCatalog.relays.map((relay) => ({
    hostname: relay.hostname,
    fqdn: relay.fqdn,
    type: 'wireguard',
    active: relay.active,
    owned: relay.owned,
    provider: relay.provider,
    country_code: relay.location.countryCode,
    country_name: relay.location.countryName,
    city_code: relay.location.cityCode,
    city_name: relay.location.cityName,
    ipv4_addr_in: relay.endpointIpv4,
    pubkey: relay.publicKey,
    network_port_speed: relay.networkPortSpeed,
    stboot: relay.stboot,
  }));

  return `data:application/json,${encodeURIComponent(JSON.stringify(legacyPayload))}`;
}

describe('relay and recommend flows', () => {
  it('lists relays with richer policy filters', async () => {
    const { store, home } = createTempStore();
    await store.save(createFixtureConfig(store));
    process.env.MULLGATE_MULLVAD_RELAYS_URL = createRelayCatalogDataUrl();

    const result = await runRelaysListFlow({
      options: {
        country: 'Sweden',
        owner: 'mullvad',
        runMode: 'ram',
        minPortSpeed: '9000',
      },
      store,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(`\n${normalizeFixtureHomePath(result.text, home)}`).toMatchInlineSnapshot(`
      "
      Mullgate relay list
      phase: relay-list
      source: mullvad-relay-catalog
      catalog endpoint: data:application/json,%5B%7B%22hostname%22%3A%22se-got-wg-101%22%2C%22fqdn%22%3A%22se-got-wg-101.relays.mullvad.net%22%2C%22type%22%3A%22wireguard%22%2C%22active%22%3Atrue%2C%22owned%22%3Atrue%2C%22provider%22%3A%22m247%22%2C%22country_code%22%3A%22se%22%2C%22country_name%22%3A%22Sweden%22%2C%22city_code%22%3A%22got%22%2C%22city_name%22%3A%22Gothenburg%22%2C%22ipv4_addr_in%22%3A%22185.213.154.2%22%2C%22pubkey%22%3A%22relay-public-key-se-got-101%22%2C%22network_port_speed%22%3A10000%2C%22stboot%22%3Atrue%7D%2C%7B%22hostname%22%3A%22se-sto-wg-002%22%2C%22fqdn%22%3A%22se-sto-wg-002.relays.mullvad.net%22%2C%22type%22%3A%22wireguard%22%2C%22active%22%3Atrue%2C%22owned%22%3Atrue%2C%22provider%22%3A%22m247%22%2C%22country_code%22%3A%22se%22%2C%22country_name%22%3A%22Sweden%22%2C%22city_code%22%3A%22sto%22%2C%22city_name%22%3A%22Stockholm%22%2C%22ipv4_addr_in%22%3A%22185.213.154.22%22%2C%22pubkey%22%3A%22relay-public-key-se-sto-002%22%2C%22network_port_speed%22%3A10000%2C%22stboot%22%3Atrue%7D%2C%7B%22hostname%22%3A%22at-vie-wg-001%22%2C%22fqdn%22%3A%22at-vie-wg-001.relays.mullvad.net%22%2C%22type%22%3A%22wireguard%22%2C%22active%22%3Atrue%2C%22owned%22%3Afalse%2C%22provider%22%3A%22datawagon%22%2C%22country_code%22%3A%22at%22%2C%22country_name%22%3A%22Austria%22%2C%22city_code%22%3A%22vie%22%2C%22city_name%22%3A%22Vienna%22%2C%22ipv4_addr_in%22%3A%22185.213.154.1%22%2C%22pubkey%22%3A%22relay-public-key-at-vie-001%22%2C%22network_port_speed%22%3A1000%2C%22stboot%22%3Afalse%7D%2C%7B%22hostname%22%3A%22us-nyc-wg-001%22%2C%22fqdn%22%3A%22us-nyc-wg-001.relays.mullvad.net%22%2C%22type%22%3A%22wireguard%22%2C%22active%22%3Afalse%2C%22owned%22%3Afalse%2C%22provider%22%3A%22xtom%22%2C%22country_code%22%3A%22us%22%2C%22country_name%22%3A%22United%20States%22%2C%22city_code%22%3A%22nyc%22%2C%22city_name%22%3A%22New%20York%22%2C%22ipv4_addr_in%22%3A%22185.213.154.3%22%2C%22pubkey%22%3A%22relay-public-key-us-nyc-001%22%2C%22network_port_speed%22%3A5000%2C%22stboot%22%3Afalse%7D%5D
      selection: country=se owner=mullvad run-mode=ram min-port-speed=9000
      inactive relays: active only
      matched count: 2
      listed count: 2
      1. se-got-wg-101 country=se city=got provider=m247 owner=mullvad run-mode=ram port-speed=10000 active=yes endpoint=185.213.154.2
      2. se-sto-wg-002 country=se city=sto provider=m247 owner=mullvad run-mode=ram port-speed=10000 active=yes endpoint=185.213.154.22"
    `);
  });

  it('probes relays and ranks them by latency', async () => {
    const { store, home } = createTempStore();
    await store.save(createFixtureConfig(store));
    process.env.MULLGATE_MULLVAD_RELAYS_URL = createRelayCatalogDataUrl();

    const result = await runRelaysProbeFlow({
      options: {
        country: 'Sweden',
        count: '2',
      },
      store,
      runner: async ({ args }) => {
        const targetIp = args.at(-1);

        return {
          exitCode: 0,
          stdout: `64 bytes from ${targetIp}: icmp_seq=1 ttl=57 time=${targetIp === '185.213.154.22' ? '8.5' : '14.2'} ms`,
          stderr: '',
        };
      },
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(`\n${normalizeFixtureHomePath(result.text, home)}`).toMatchInlineSnapshot(`
      "
      Mullgate relay probe complete.
      phase: relay-probe
      source: ping
      catalog endpoint: data:application/json,%5B%7B%22hostname%22%3A%22se-got-wg-101%22%2C%22fqdn%22%3A%22se-got-wg-101.relays.mullvad.net%22%2C%22type%22%3A%22wireguard%22%2C%22active%22%3Atrue%2C%22owned%22%3Atrue%2C%22provider%22%3A%22m247%22%2C%22country_code%22%3A%22se%22%2C%22country_name%22%3A%22Sweden%22%2C%22city_code%22%3A%22got%22%2C%22city_name%22%3A%22Gothenburg%22%2C%22ipv4_addr_in%22%3A%22185.213.154.2%22%2C%22pubkey%22%3A%22relay-public-key-se-got-101%22%2C%22network_port_speed%22%3A10000%2C%22stboot%22%3Atrue%7D%2C%7B%22hostname%22%3A%22se-sto-wg-002%22%2C%22fqdn%22%3A%22se-sto-wg-002.relays.mullvad.net%22%2C%22type%22%3A%22wireguard%22%2C%22active%22%3Atrue%2C%22owned%22%3Atrue%2C%22provider%22%3A%22m247%22%2C%22country_code%22%3A%22se%22%2C%22country_name%22%3A%22Sweden%22%2C%22city_code%22%3A%22sto%22%2C%22city_name%22%3A%22Stockholm%22%2C%22ipv4_addr_in%22%3A%22185.213.154.22%22%2C%22pubkey%22%3A%22relay-public-key-se-sto-002%22%2C%22network_port_speed%22%3A10000%2C%22stboot%22%3Atrue%7D%2C%7B%22hostname%22%3A%22at-vie-wg-001%22%2C%22fqdn%22%3A%22at-vie-wg-001.relays.mullvad.net%22%2C%22type%22%3A%22wireguard%22%2C%22active%22%3Atrue%2C%22owned%22%3Afalse%2C%22provider%22%3A%22datawagon%22%2C%22country_code%22%3A%22at%22%2C%22country_name%22%3A%22Austria%22%2C%22city_code%22%3A%22vie%22%2C%22city_name%22%3A%22Vienna%22%2C%22ipv4_addr_in%22%3A%22185.213.154.1%22%2C%22pubkey%22%3A%22relay-public-key-at-vie-001%22%2C%22network_port_speed%22%3A1000%2C%22stboot%22%3Afalse%7D%2C%7B%22hostname%22%3A%22us-nyc-wg-001%22%2C%22fqdn%22%3A%22us-nyc-wg-001.relays.mullvad.net%22%2C%22type%22%3A%22wireguard%22%2C%22active%22%3Afalse%2C%22owned%22%3Afalse%2C%22provider%22%3A%22xtom%22%2C%22country_code%22%3A%22us%22%2C%22country_name%22%3A%22United%20States%22%2C%22city_code%22%3A%22nyc%22%2C%22city_name%22%3A%22New%20York%22%2C%22ipv4_addr_in%22%3A%22185.213.154.3%22%2C%22pubkey%22%3A%22relay-public-key-us-nyc-001%22%2C%22network_port_speed%22%3A5000%2C%22stboot%22%3Afalse%7D%5D
      selection: country=se
      matched count: 2
      requested count: 2
      successful probes: 2
      ranked relays
      1. se-sto-wg-002 country=se city=sto provider=m247 owner=mullvad run-mode=ram port-speed=10000 latency=8.5ms
      2. se-got-wg-101 country=se city=got provider=m247 owner=mullvad run-mode=ram port-speed=10000 latency=14.2ms"
    `);
  });

  it('verifies configured route exits through Mullvad', async () => {
    const { store, home } = createTempStore();
    await store.save(createFixtureConfig(store));
    process.env.MULLGATE_MULLVAD_RELAYS_URL = createRelayCatalogDataUrl();

    const result = await runRelaysVerifyFlow({
      options: {
        route: 'sweden-gothenburg',
        targetUrl: 'https://am.i.mullvad.net/json',
      },
      store,
      runner: async ({ args }) => {
        const proxyUrl = String(args[7]);

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ip: proxyUrl.includes(':8443')
              ? '203.0.113.12'
              : proxyUrl.includes(':8080')
                ? '203.0.113.11'
                : '203.0.113.10',
            country: 'SE',
            city: 'Gothenburg',
            mullvad_exit_ip: true,
          }),
          stderr: '',
        };
      },
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(`\n${normalizeFixtureHomePath(result.text, home)}`).toMatchInlineSnapshot(`
      "
      Mullgate route exit verification complete.
      phase: relay-verify
      source: configured-route
      config: /tmp/mullgate-home/config/mullgate/config.json
      route alias: sweden-gothenburg
      route id: sweden-gothenburg-proxy-example-com
      hostname: sweden-gothenburg.proxy.example.com
      bind ip: 192.168.10.10
      target: https://am.i.mullvad.net/json
      1. protocol=socks5 proxy=socks5://192.168.10.10:1080 exit-ip=203.0.113.10 country=SE city=Gothenburg mullvad_exit_ip=true
      2. protocol=http proxy=http://192.168.10.10:8080 exit-ip=203.0.113.10 country=SE city=Gothenburg mullvad_exit_ip=true
      3. protocol=https proxy=https://192.168.10.10:8443 exit-ip=203.0.113.10 country=SE city=Gothenburg mullvad_exit_ip=true"
    `);
  });

  it('recommends the fastest exact relay and previews the resulting route', async () => {
    const { store, home } = createTempStore();
    await store.save(createFixtureConfig(store));
    process.env.MULLGATE_MULLVAD_RELAYS_URL = createRelayCatalogDataUrl();

    const previousArgv = [...process.argv];
    process.argv = ['node', 'src/cli.ts', 'recommend', '--country', 'Sweden', '--count', '1'];

    try {
      const result = await runRecommendFlow({
        options: {},
        store,
        runner: async ({ args }) => {
          const targetIp = args.at(-1);

          return {
            exitCode: 0,
            stdout: `64 bytes from ${targetIp}: icmp_seq=1 ttl=57 time=${targetIp === '185.213.154.22' ? '7.1' : '13.4'} ms`,
            stderr: '',
          };
        },
      });

      expect(result.ok).toBe(true);

      if (!result.ok) {
        return;
      }

      expect(`\n${normalizeFixtureHomePath(result.text, home)}`).toMatchInlineSnapshot(`
        "
        Mullgate route recommendations.
        phase: recommend-routes
        source: relay-probe
        config: /tmp/mullgate-home/config/mullgate/config.json
        apply: no
        selectors: 1
        1. country=se matched=2 probed=2 recommended=1
        recommended routes: 1
        1. relay=se-got-wg-101 latency=13.4ms
           selector: country=se
           provider: m247
           owner: mullvad
           run mode: ram
           port speed: 10000
           route status: existing configured route
           route alias: sweden-gothenburg
           route id: sweden-gothenburg-proxy-example-com
           hostname: sweden-gothenburg.proxy.example.com
           bind ip: 192.168.10.10
           socks5: socks5://alice:multi-route-secret@192.168.10.10:1080
           http: http://alice:multi-route-secret@192.168.10.10:8080
           https: https://alice:multi-route-secret@192.168.10.10:8443"
      `);
    } finally {
      process.argv = previousArgv;
    }
  });
});
