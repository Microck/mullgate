import type { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { runSetupFlow } from '../src/app/setup-runner.js';
import { resolveMullgatePaths } from '../src/config/paths.js';
import { CONFIG_VERSION, type MullgateConfig } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import {
  createLocationAliasCatalog,
  resolveLocationAlias,
} from '../src/domain/location-aliases.js';
import { fetchRelays, normalizeRelayPayload } from '../src/mullvad/fetch-relays.js';
import { provisionWireguard } from '../src/mullvad/provision-wireguard.js';
import { requireDefined } from '../src/required.js';
import { renderRuntimeBundle } from '../src/runtime/render-runtime-bundle.js';
import { renderWireproxyArtifacts } from '../src/runtime/render-wireproxy.js';
import { validateRuntimeArtifacts } from '../src/runtime/validate-runtime.js';
import { validateWireproxyConfig } from '../src/runtime/validate-wireproxy.js';
import { createFixtureRoute, createFixtureRuntime } from './helpers/mullgate-fixtures.js';
import { expectPrivateFileMode, normalizeFixtureHomePath } from './helpers/platform-test-utils.js';

const fixturesDir = join(process.cwd(), 'test/fixtures/mullvad');
const temporaryDirectories: string[] = [];

type JsonRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  rawBody: string;
};

type JsonRouteHandler = (request: JsonRequest) => {
  status?: number;
  body: string;
  contentType?: string;
};

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-provisioning-'));
  const linuxRoot = root.replaceAll('\\', '/');
  temporaryDirectories.push(root);

  return {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: linuxRoot,
    XDG_CONFIG_HOME: `${linuxRoot}/config`,
    XDG_STATE_HOME: `${linuxRoot}/state`,
    XDG_CACHE_HOME: `${linuxRoot}/cache`,
  };
}

async function readJsonFixture<T>(name: string): Promise<T> {
  const raw = await readFile(join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as T;
}

async function readTextFixture(name: string): Promise<string> {
  return readFile(join(fixturesDir, name), 'utf8');
}

async function withJsonServer(
  routes: Record<string, JsonRouteHandler>,
  run: (baseUrl: URL) => Promise<void>,
): Promise<void> {
  const server = createServer(async (request, response) => {
    const rawBody = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });

    const route = routes[request.url ?? '/'];

    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"detail":"not found"}');
      return;
    }

    const requestHeaders = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') {
        requestHeaders.set(key, value);
      }
    }

    const parsedBody = rawBody.length > 0 ? tryParseJson(rawBody) : null;
    const routeResult = route({
      url: request.url ?? '/',
      method: request.method ?? 'GET',
      headers: requestHeaders,
      body: parsedBody,
      rawBody,
    });

    response.writeHead(routeResult.status ?? 200, {
      'content-type': routeResult.contentType ?? 'application/json',
    });
    response.end(routeResult.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();

  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind test server.');
  }

  try {
    await run(new URL(`http://127.0.0.1:${address.port}`));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function createConfig(
  paths: ReturnType<typeof resolveMullgatePaths>,
  wireguard: MullgateConfig['mullvad']['wireguard'],
): MullgateConfig {
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
        httpsPort: null,
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
        requested: 'sweden-gothenburg',
        resolvedAlias: null,
      },
      https: {
        enabled: false,
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: 'mullgate-lab',
      lastProvisionedAt: timestamp,
      relayConstraints: {
        providers: [],
      },
      wireguard,
    },
    routing: {
      locations: [
        createFixtureRoute({
          alias: 'sweden-gothenburg',
          hostname: 'sweden-gothenburg',
          bindIp: '127.0.0.1',
          requested: 'sweden-gothenburg',
          resolvedAlias: null,
          countryCode: 'se',
          cityCode: 'got',
        }),
      ],
    },
    runtime: createFixtureRuntime({
      paths,
      status: {
        phase: 'unvalidated',
        lastCheckedAt: null,
        message: 'Pending first validation.',
      },
    }),
    diagnostics: {
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

function normalizePathInput(value: string, home: string): string {
  return normalizeFixtureHomePath(value, home);
}

function createSpawnStub(
  handlers: Record<string, (args: readonly string[]) => Partial<ReturnType<typeof spawnSync>>>,
): typeof spawnSync {
  return ((command: string, args?: readonly string[]) => {
    const handler = handlers[command];

    if (!handler) {
      const error = Object.assign(new Error(`${command} not found`), { code: 'ENOENT' });
      return {
        pid: 0,
        output: [],
        stdout: '',
        stderr: '',
        status: null,
        signal: null,
        error,
      } as ReturnType<typeof spawnSync>;
    }

    return {
      pid: 1,
      output: [],
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
      ...handler(args ?? []),
    } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function parseFormBody(raw: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Mullvad relay normalization and alias discovery', () => {
  it('normalizes app and legacy relay payloads into stable aliasable relay catalogs', async () => {
    const appPayload = await readJsonFixture<unknown>('app-relays.json');
    const legacyPayload = await readJsonFixture<unknown>('www-relays-all.json');

    const appResult = normalizeRelayPayload(appPayload, {
      fetchedAt: '2026-03-20T18:30:00.000Z',
      endpoint: 'fixture://app-relays.json',
    });
    const legacyResult = normalizeRelayPayload(legacyPayload, {
      fetchedAt: '2026-03-20T18:30:00.000Z',
      endpoint: 'fixture://www-relays-all.json',
    });

    expect(appResult.ok).toBe(true);
    expect(legacyResult.ok).toBe(true);

    if (!appResult.ok || !legacyResult.ok) {
      return;
    }

    const aliasCatalog = createLocationAliasCatalog(appResult.value.relays);
    expect(aliasCatalog.ok).toBe(true);

    if (!aliasCatalog.ok) {
      return;
    }

    expect(appResult.value.relays.map((relay) => relay.hostname)).toEqual([
      'at-vie-wg-001',
      'at-vie-wg-101',
      'se-got-wg-101',
      'se-got-wg-102',
      'se-sto-wg-001',
    ]);
    expect(legacyResult.value.relays.map((relay) => relay.hostname)).toEqual([
      'at-vie-wg-001',
      'se-got-wg-101',
      'se-sto-wg-001',
    ]);
    expect(resolveLocationAlias(aliasCatalog.value, 'sweden-gothenburg')).toEqual({
      ok: true,
      phase: 'location-lookup',
      source: 'user-input',
      alias: 'sweden-gothenburg',
      value: {
        kind: 'city',
        countryCode: 'se',
        countryName: 'Sweden',
        cityCode: 'got',
        cityName: 'Gothenburg',
      },
    });
    expect(resolveLocationAlias(aliasCatalog.value, 'se-got-wg-101')).toEqual({
      ok: true,
      phase: 'location-lookup',
      source: 'user-input',
      alias: 'se-got-wg-101',
      value: {
        kind: 'relay',
        hostname: 'se-got-wg-101',
        fqdn: 'se-got-wg-101.relays.mullvad.net',
        countryCode: 'se',
        countryName: 'Sweden',
        cityCode: 'got',
        cityName: 'Gothenburg',
      },
    });
    expect(
      `\n${JSON.stringify(
        {
          countries: aliasCatalog.value.countries,
          cities: aliasCatalog.value.cities,
          ambiguousAliases: aliasCatalog.value.ambiguousAliases,
        },
        null,
        2,
      )}`,
    ).toMatchInlineSnapshot(`
"\n{
  "countries": [
    {
      "code": "at",
      "name": "Austria",
      "aliases": [
        "at",
        "austria"
      ]
    },
    {
      "code": "se",
      "name": "Sweden",
      "aliases": [
        "se",
        "sweden"
      ]
    }
  ],
  "cities": [
    {
      "countryCode": "at",
      "countryName": "Austria",
      "code": "vie",
      "name": "Vienna",
      "aliases": [
        "at-vie",
        "at-vienna",
        "austria-vienna",
        "vienna"
      ]
    },
    {
      "countryCode": "se",
      "countryName": "Sweden",
      "code": "got",
      "name": "Gothenburg",
      "aliases": [
        "se-got",
        "se-gothenburg",
        "sweden-gothenburg",
        "gothenburg"
      ]
    },
    {
      "countryCode": "se",
      "countryName": "Sweden",
      "code": "sto",
      "name": "Stockholm",
      "aliases": [
        "se-sto",
        "se-stockholm",
        "sweden-stockholm",
        "stockholm"
      ]
    }
  ],
  "ambiguousAliases": []
}"
`);
  });
});

describe('Mullvad provisioning and runtime artifact rendering', () => {
  it('provisions a WireGuard device, renders wireproxy artifacts, and validates through the Docker fallback', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const provisionResponse = await readTextFixture('wg-provision-response.txt');
    const appPayload = await readJsonFixture<unknown>('app-relays.json');
    const requests: { provision?: unknown } = {};

    await withJsonServer(
      {
        '/wg': (request) => {
          requests.provision = parseFormBody(request.rawBody);
          const parsedBody = requests.provision as { pubkey: string; name?: string };

          return {
            body: JSON.stringify({
              ...JSON.parse(provisionResponse),
              pubkey: parsedBody.pubkey,
              name: parsedBody.name ?? 'mullgate-lab',
            }),
          };
        },
      },
      async (baseUrl) => {
        const provisionResult = await provisionWireguard({
          accountNumber: '123456789012',
          deviceName: 'mullgate-lab',
          baseUrl: new URL('/wg', baseUrl),
          checkedAt: '2026-03-20T18:32:00.000Z',
        });

        expect(provisionResult.ok).toBe(true);

        if (!provisionResult.ok) {
          return;
        }

        expect(requests.provision).toEqual({
          account: '123456789012',
          pubkey: provisionResult.value.publicKey,
          name: 'mullgate-lab',
        });
        expect(JSON.stringify(provisionResult.value)).toContain('[redacted]');
        expect(JSON.stringify(provisionResult.value)).not.toContain(
          provisionResult.value.privateKey,
        );

        const relayResult = normalizeRelayPayload(appPayload, {
          fetchedAt: '2026-03-20T18:33:00.000Z',
          endpoint: 'fixture://app-relays.json',
        });
        expect(relayResult.ok).toBe(true);

        if (!relayResult.ok) {
          return;
        }

        const config = createConfig(paths, provisionResult.value.toConfigValue());
        const renderResult = await renderWireproxyArtifacts({
          config,
          relayCatalog: relayResult.value,
          paths,
          generatedAt: '2026-03-20T18:34:00.000Z',
        });

        expect(renderResult.ok).toBe(true);

        if (!renderResult.ok) {
          return;
        }

        const wireproxyConfig = await readFile(
          renderResult.artifactPaths.entryWireproxyConfigPath,
          'utf8',
        );
        const relayCache = JSON.parse(
          await readFile(renderResult.artifactPaths.relayCachePath, 'utf8'),
        ) as { relayCount: number };
        const configStats = statSync(renderResult.artifactPaths.entryWireproxyConfigPath);

        expectPrivateFileMode(configStats.mode);
        expect(relayCache.relayCount).toBe(5);

        const validation = await validateWireproxyConfig({
          configPath: renderResult.artifactPaths.entryWireproxyConfigPath,
          reportPath: paths.runtimeValidationReportFile,
          checkedAt: '2026-03-20T18:35:00.000Z',
          spawn: createSpawnStub({
            docker: (args) => {
              expect(args).toContain('run');
              expect(args).toContain('/etc/wireproxy/wireproxy.conf');
              return {
                status: 0,
                stdout: 'docker wireproxy configtest ok\n',
              };
            },
          }),
        });

        expect(validation).toEqual({
          ok: true,
          phase: 'validation',
          source: 'docker',
          status: 'success',
          checkedAt: '2026-03-20T18:35:00.000Z',
          target: renderResult.artifactPaths.entryWireproxyConfigPath,
          reportPath: paths.runtimeValidationReportFile,
          validator: 'docker-wireproxy-configtest',
          issues: [],
        });

        const report = normalizePathInput(
          await readFile(paths.runtimeValidationReportFile, 'utf8'),
          requireDefined(env.HOME, 'Expected HOME in the test env.'),
        ).trimEnd();
        const normalizedConfig = normalizePathInput(
          wireproxyConfig,
          requireDefined(env.HOME, 'Expected HOME in the test env.'),
        )
          .split(provisionResult.value.privateKey)
          .join('WG_PRIVATE_KEY')
          .split('super-secret-password')
          .join('PROXY_PASSWORD');

        expect(`\n${normalizedConfig}`).toMatchInlineSnapshot(`
          "
          # Generated by Mullgate. Derived artifact; edit canonical config instead.
          # Generated at 2026-03-20T18:34:00.000Z
          # Shared entry relay se-got-wg-101

          [Interface]
          Address = 10.64.12.34/32, fc00:bbbb:bbbb:bb01::1:1234/128
          PrivateKey = WG_PRIVATE_KEY
          DNS = 10.64.0.1

          [Peer]
          PublicKey = Wg5yKrVIO52wBIMNz+lQbZ3ZIDvJpQ6AqmrKa1iWLEg=
          Endpoint = se-got-wg-101.relays.mullvad.net:3401
          AllowedIPs = 0.0.0.0/0, ::/0
          PersistentKeepalive = 25

          [Socks5]
          BindAddress = 127.0.0.1:39101

          [http]
          BindAddress = 127.0.0.1:39102
          "
        `);
        expect(`\n${report}`).toMatchInlineSnapshot(`
          "
          {
            "ok": true,
            "phase": "validation",
            "source": "docker",
            "status": "success",
            "checkedAt": "2026-03-20T18:35:00.000Z",
            "target": "/tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf",
            "validator": "docker-wireproxy-configtest",
            "issues": []
          }"
        `);
      },
    );
  });

  it('accepts the plain-text assigned address that Mullvad currently documents for router setup', async () => {
    await withJsonServer(
      {
        '/wg': () => ({
          body: '10.64.12.34/32\n',
          contentType: 'text/plain',
        }),
      },
      async (baseUrl) => {
        const provisionResult = await provisionWireguard({
          accountNumber: '123456789012',
          deviceName: 'mullgate-router',
          baseUrl: new URL('/wg', baseUrl),
          checkedAt: '2026-03-20T18:32:30.000Z',
          generateKeyPair: () => ({
            publicKey: 'PUBLIC_KEY_FOR_PLAINTEXT_CASE=',
            privateKey: 'PRIVATE_KEY_FOR_PLAINTEXT_CASE=',
          }),
        });

        expect(provisionResult).toMatchObject({
          ok: true,
          phase: 'wireguard-provision',
          source: 'mullvad-wg-endpoint',
          endpoint: new URL('/wg', baseUrl).toString(),
          checkedAt: '2026-03-20T18:32:30.000Z',
          value: {
            deviceName: 'mullgate-router',
            publicKey: 'PUBLIC_KEY_FOR_PLAINTEXT_CASE=',
            ipv4Address: '10.64.12.34/32',
            interfaceAddresses: ['10.64.12.34/32'],
            hijackDns: false,
            ports: [],
          },
        });
      },
    );
  });

  it('stages docker validation copies instead of mounting the private runtime artifacts directly', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const appPayload = await readJsonFixture<unknown>('app-relays.json');
    const relayResult = normalizeRelayPayload(appPayload, {
      fetchedAt: '2026-03-20T18:33:00.000Z',
      endpoint: 'fixture://app-relays.json',
    });

    expect(relayResult.ok).toBe(true);

    if (!relayResult.ok) {
      return;
    }

    const config = createConfig(paths, {
      publicKey: 'PUBLIC_KEY_FOR_STAGE_TEST=',
      privateKey: 'PRIVATE_KEY_FOR_STAGE_TEST=',
      ipv4Address: '10.64.12.34/32',
      ipv6Address: null,
      gatewayIpv4: null,
      gatewayIpv6: null,
      dnsServers: ['10.64.0.1'],
      peerPublicKey: null,
      peerEndpoint: null,
    });
    const renderResult = await renderWireproxyArtifacts({
      config,
      relayCatalog: relayResult.value,
      paths,
      generatedAt: '2026-03-20T18:34:00.000Z',
    });

    expect(renderResult.ok).toBe(true);

    if (!renderResult.ok) {
      return;
    }

    const dockerInvocations: string[][] = [];
    const validation = await validateRuntimeArtifacts({
      entryWireproxyConfigPath: renderResult.artifactPaths.entryWireproxyConfigPath,
      entryWireproxyConfigText: renderResult.entryWireproxyConfig,
      routeProxyConfigPath: renderResult.artifactPaths.routeProxyConfigPath,
      routeProxyConfigText: renderResult.routeProxyConfig,
      routes: renderResult.routes,
      bind: {
        socksPort: config.setup.bind.socksPort,
        httpPort: config.setup.bind.httpPort,
      },
      checkedAt: '2026-03-20T18:35:00.000Z',
      spawn: createSpawnStub({
        docker: (args) => {
          dockerInvocations.push([...args]);

          if (args.includes('/bin/3proxy')) {
            return {
              error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
            };
          }

          return {
            status: 0,
            stdout: 'docker wireproxy configtest ok\n',
          };
        },
      }),
    });

    expect(validation).toMatchObject({
      ok: true,
      phase: 'validation',
      source: 'validation-suite',
      checkedAt: '2026-03-20T18:35:00.000Z',
    });

    const wireproxyArgs = dockerInvocations.find((args) =>
      args.includes('/etc/wireproxy/wireproxy.conf'),
    );
    const routeProxyArgs = dockerInvocations.find((args) => args.includes('/bin/3proxy'));

    expect(wireproxyArgs).toBeDefined();

    if (process.platform === 'win32') {
      expect(dockerInvocations).toHaveLength(1);
      expect(routeProxyArgs).toBeUndefined();
      return;
    }

    expect(dockerInvocations).toHaveLength(2);
    expect(routeProxyArgs).toBeDefined();

    const wireproxyMount = requireDefined(
      wireproxyArgs?.[
        requireDefined(wireproxyArgs?.indexOf('-v'), 'Expected -v in wireproxy args.') + 1
      ],
      'Expected the staged wireproxy mount argument.',
    );
    const routeProxyMount = requireDefined(
      routeProxyArgs?.[
        requireDefined(routeProxyArgs?.indexOf('-v'), 'Expected -v in 3proxy args.') + 1
      ],
      'Expected the staged 3proxy mount argument.',
    );
    const wireproxyStagedPath = wireproxyMount.split(':')[0] ?? '';
    const routeProxyStagedPath = routeProxyMount.split(':')[0] ?? '';

    expect(wireproxyMount).toContain(':/etc/wireproxy/wireproxy.conf:ro');
    expect(routeProxyMount).toContain(':/etc/3proxy/3proxy.cfg');
    expect(routeProxyMount.endsWith(':ro')).toBe(false);
    expect(wireproxyStagedPath).not.toBe(renderResult.artifactPaths.entryWireproxyConfigPath);
    expect(routeProxyStagedPath).not.toBe(renderResult.artifactPaths.routeProxyConfigPath);
    expect(existsSync(wireproxyStagedPath)).toBe(false);
    expect(existsSync(routeProxyStagedPath)).toBe(false);
    expect(renderResult.routeProxyConfig).toContain('parent 1000 socks5+ 127.0.0.1 39101');
    expect(renderResult.routeProxyConfig).not.toContain('parent 1000 socks5 127.0.0.1 39101');
  });

  it('falls back to internal route-proxy syntax validation on Windows hosts', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const appPayload = await readJsonFixture<unknown>('app-relays.json');
    const relayResult = normalizeRelayPayload(appPayload, {
      fetchedAt: '2026-03-20T18:36:00.000Z',
      endpoint: 'fixture://app-relays.json',
    });

    expect(relayResult.ok).toBe(true);

    if (!relayResult.ok) {
      return;
    }

    const config = createConfig(paths, {
      publicKey: 'PUBLIC_KEY_FOR_WINDOWS_VALIDATION_TEST=',
      privateKey: 'PRIVATE_KEY_FOR_WINDOWS_VALIDATION_TEST=',
      ipv4Address: '10.64.12.34/32',
      ipv6Address: null,
      gatewayIpv4: null,
      gatewayIpv6: null,
      dnsServers: ['10.64.0.1'],
      peerPublicKey: null,
      peerEndpoint: null,
    });
    const renderResult = await renderWireproxyArtifacts({
      config,
      relayCatalog: relayResult.value,
      paths,
      generatedAt: '2026-03-20T18:37:00.000Z',
    });

    expect(renderResult.ok).toBe(true);

    if (!renderResult.ok) {
      return;
    }

    const originalPlatform = process.platform;

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const validation = await validateRuntimeArtifacts({
        entryWireproxyConfigPath: renderResult.artifactPaths.entryWireproxyConfigPath,
        entryWireproxyConfigText: renderResult.entryWireproxyConfig,
        routeProxyConfigPath: renderResult.artifactPaths.routeProxyConfigPath,
        routeProxyConfigText: renderResult.routeProxyConfig,
        routes: renderResult.routes,
        bind: {
          socksPort: config.setup.bind.socksPort,
          httpPort: config.setup.bind.httpPort,
        },
        checkedAt: '2026-03-20T18:38:00.000Z',
        spawn: createSpawnStub({
          docker: () => {
            throw new Error('Windows route-proxy validation should skip docker startup checks.');
          },
          wireproxy: () => ({
            status: 0,
            stdout: 'wireproxy configtest ok\n',
          }),
        }),
      });

      expect(validation).toMatchObject({
        ok: true,
        phase: 'validation',
        source: 'validation-suite',
        checkedAt: '2026-03-20T18:38:00.000Z',
        checks: [
          {
            artifact: 'entry-wireproxy',
            ok: true,
            source: 'wireproxy-binary',
            validator: 'wireproxy-configtest',
          },
          {
            artifact: 'route-proxy',
            ok: true,
            source: 'internal-syntax',
            validator: 'internal-syntax',
          },
        ],
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('runs the shared runtime containers as root so they can read the private mounted configs', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const config = createConfig(paths, {
      publicKey: 'PUBLIC_KEY_FOR_BUNDLE_TEST=',
      privateKey: 'PRIVATE_KEY_FOR_BUNDLE_TEST=',
      ipv4Address: '10.64.12.34/32',
      ipv6Address: null,
      gatewayIpv4: null,
      gatewayIpv6: null,
      dnsServers: ['10.64.0.1'],
      peerPublicKey: null,
      peerEndpoint: null,
    });
    const bundleResult = await renderRuntimeBundle({
      config,
      paths,
      generatedAt: '2026-03-20T18:36:00.000Z',
    });

    expect(bundleResult.ok).toBe(true);

    if (!bundleResult.ok) {
      return;
    }

    const compose = await readFile(bundleResult.artifactPaths.dockerComposePath, 'utf8');
    expect(compose).toContain('  entry-tunnel:\n');
    expect(compose).toContain('    user: "0:0"\n');
    expect(compose).toContain('  route-proxy:\n');
    expect(compose).toContain(
      '  route-proxy:\n    image: tarampampam/3proxy:latest\n    user: "0:0"\n',
    );
  });

  it('persists multi-route setup state with one shared Mullvad device and per-route exits', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const store = new ConfigStore(paths);
    const provisionFixture = JSON.parse(
      await readTextFixture('wg-provision-response.txt'),
    ) as Record<string, unknown>;
    const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');
    const provisionedNames: string[] = [];
    let provisionCount = 0;

    await withJsonServer(
      {
        '/wg': (request) => {
          provisionCount += 1;
          const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };
          provisionedNames.push(payload.name ?? '<missing>');

          return {
            body: JSON.stringify({
              ...provisionFixture,
              id: `device-${provisionCount}`,
              pubkey: payload.pubkey,
              name: payload.name ?? `mullgate-route-${provisionCount}`,
              ipv4_address: `10.64.12.${33 + provisionCount}/32`,
            }),
          };
        },
        '/relays': () => ({
          body: JSON.stringify(relayFixture),
        }),
      },
      async (baseUrl) => {
        const result = await runSetupFlow({
          store,
          interactive: false,
          initialValues: {
            accountNumber: '123456789012',
            username: 'alice',
            password: 'multi-route-secret',
            locations: ['sweden-gothenburg', 'austria-vienna'] as [string, ...string[]],
            deviceName: 'mullgate-lab',
          },
          provisioningBaseUrl: new URL('/wg', baseUrl),
          relayCatalogUrl: new URL('/relays', baseUrl),
          checkedAt: '2026-03-20T18:45:00.000Z',
          validateOptions: {
            spawn: createSpawnStub({
              docker: () => ({
                status: 0,
                stdout: 'docker wireproxy configtest ok\n',
              }),
            }),
          },
        });

        expect(result.ok).toBe(true);

        if (!result.ok) {
          return;
        }

        expect(provisionedNames).toEqual(['mullgate-lab']);
        expect(result.routes).toEqual([
          {
            index: 0,
            requested: 'sweden-gothenburg',
            alias: 'sweden-gothenburg',
            hostname: 'sweden-gothenburg',
            bindIp: '127.0.0.1',
            deviceName: 'mullgate-lab',
            exitRelayHostname: result.routes[0]?.exitRelayHostname,
            exitSocksHostname: result.routes[0]?.exitSocksHostname,
            exitSocksPort: result.routes[0]?.exitSocksPort,
          },
          {
            index: 1,
            requested: 'austria-vienna',
            alias: 'austria-vienna',
            hostname: 'austria-vienna',
            bindIp: '127.0.0.2',
            deviceName: 'mullgate-lab',
            exitRelayHostname: result.routes[1]?.exitRelayHostname,
            exitSocksHostname: result.routes[1]?.exitSocksHostname,
            exitSocksPort: result.routes[1]?.exitSocksPort,
          },
        ]);

        const savedConfig = JSON.parse(await readFile(paths.configFile, 'utf8')) as MullgateConfig;
        expect(savedConfig.setup.exposure).toEqual({
          mode: 'loopback',
          allowLan: false,
          baseDomain: null,
        });
        expect(savedConfig.setup.bind.host).toBe('127.0.0.1');
        expect(savedConfig.routing.locations).toHaveLength(2);
        expect(savedConfig.routing.locations[0]?.bindIp).toBe('127.0.0.1');
        expect(savedConfig.routing.locations[1]?.bindIp).toBe('127.0.0.2');
        expect(savedConfig.routing.locations[0]?.mullvad.exit.relayHostname).toBe('se-got-wg-101');
        expect(savedConfig.routing.locations[1]?.mullvad.exit.relayHostname).toBe('at-vie-wg-001');
        expect(savedConfig.setup.location.requested).toBe('sweden-gothenburg');
        expect(savedConfig.setup.location.resolvedAlias).toBe('sweden-gothenburg');
        expect(savedConfig.mullvad.deviceName).toBeTruthy();
      },
    );
  });

  it('retries a throttled shared-device Mullvad provisioning call and still persists the multi-route setup', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const store = new ConfigStore(paths);
    const provisionFixture = JSON.parse(
      await readTextFixture('wg-provision-response.txt'),
    ) as Record<string, unknown>;
    const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');
    const attemptsByDevice = new Map<string, number>();

    await withJsonServer(
      {
        '/wg': (request) => {
          const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };
          const deviceName = payload.name ?? '<missing>';
          const attempt = (attemptsByDevice.get(deviceName) ?? 0) + 1;
          attemptsByDevice.set(deviceName, attempt);

          if (deviceName === 'mullgate-lab' && attempt === 1) {
            return {
              status: 429,
              body: 'Request was throttled. Expected available in 1 second.',
              contentType: 'text/plain',
            };
          }

          return {
            body: JSON.stringify({
              ...provisionFixture,
              id: `${deviceName}-attempt-${attempt}`,
              pubkey: payload.pubkey,
              name: deviceName,
              ipv4_address: '10.64.12.34/32',
            }),
          };
        },
        '/relays': () => ({
          body: JSON.stringify(relayFixture),
        }),
      },
      async (baseUrl) => {
        const startedAt = Date.now();
        const result = await runSetupFlow({
          store,
          interactive: false,
          initialValues: {
            accountNumber: '123456789012',
            username: 'alice',
            password: 'multi-route-secret',
            locations: ['sweden-gothenburg', 'austria-vienna'] as [string, ...string[]],
            deviceName: 'mullgate-lab',
          },
          provisioningBaseUrl: new URL('/wg', baseUrl),
          relayCatalogUrl: new URL('/relays', baseUrl),
          checkedAt: '2026-03-20T18:45:00.000Z',
          validateOptions: {
            spawn: createSpawnStub({
              docker: () => ({
                status: 0,
                stdout: 'docker wireproxy configtest ok\n',
              }),
            }),
          },
        });
        const elapsedMs = Date.now() - startedAt;

        expect(result.ok).toBe(true);

        if (!result.ok) {
          return;
        }

        expect(attemptsByDevice.get('mullgate-lab')).toBe(2);
        expect(elapsedMs).toBeGreaterThanOrEqual(900);
        expect(result.routes.map((route) => route.deviceName)).toEqual([
          'mullgate-lab',
          'mullgate-lab',
        ]);

        const savedConfig = JSON.parse(await readFile(paths.configFile, 'utf8')) as MullgateConfig;
        expect(savedConfig.routing.locations).toHaveLength(2);
        expect(savedConfig.routing.locations[1]?.mullvad.exit.relayHostname).toBe('at-vie-wg-001');
      },
    );
  });

  it('persists public direct-ip exposure with an explicit bind ip for single-route setup', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const store = new ConfigStore(paths);
    const provisionFixture = JSON.parse(
      await readTextFixture('wg-provision-response.txt'),
    ) as Record<string, unknown>;
    const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');

    await withJsonServer(
      {
        '/wg': (request) => {
          const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };

          return {
            body: JSON.stringify({
              ...provisionFixture,
              id: 'device-public',
              pubkey: payload.pubkey,
              name: payload.name ?? 'mullgate-public',
              ipv4_address: '10.64.30.44/32',
            }),
          };
        },
        '/relays': () => ({
          body: JSON.stringify(relayFixture),
        }),
      },
      async (baseUrl) => {
        const result = await runSetupFlow({
          store,
          interactive: false,
          initialValues: {
            accountNumber: '123456789012',
            username: 'alice',
            password: 'public-secret',
            bindHost: '44.55.66.77',
            exposureMode: 'public',
            locations: ['sweden-gothenburg'] as [string, ...string[]],
            deviceName: 'mullgate-public',
          },
          provisioningBaseUrl: new URL('/wg', baseUrl),
          relayCatalogUrl: new URL('/relays', baseUrl),
          checkedAt: '2026-03-20T18:45:30.000Z',
          validateOptions: {
            spawn: createSpawnStub({
              docker: () => ({
                status: 0,
                stdout: 'docker wireproxy configtest ok\n',
              }),
            }),
          },
        });

        expect(result.ok).toBe(true);

        if (!result.ok) {
          return;
        }

        expect(result.routes).toEqual([
          {
            index: 0,
            requested: 'sweden-gothenburg',
            alias: 'sweden-gothenburg',
            hostname: '44.55.66.77',
            bindIp: '44.55.66.77',
            deviceName: 'mullgate-public',
            exitRelayHostname: result.routes[0]?.exitRelayHostname,
            exitSocksHostname: result.routes[0]?.exitSocksHostname,
            exitSocksPort: result.routes[0]?.exitSocksPort,
          },
        ]);

        const savedConfig = JSON.parse(await readFile(paths.configFile, 'utf8')) as MullgateConfig;
        expect(savedConfig.setup.exposure).toEqual({
          mode: 'public',
          allowLan: true,
          baseDomain: null,
        });
        expect(savedConfig.setup.bind.host).toBe('44.55.66.77');
        expect(savedConfig.routing.locations).toEqual([
          expect.objectContaining({
            alias: 'sweden-gothenburg',
            hostname: '44.55.66.77',
            bindIp: '44.55.66.77',
          }),
        ]);
      },
    );
  });

  it('fails setup validation when private-network uses an unsafe shared bind host', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));

    const result = await runSetupFlow({
      store,
      interactive: false,
      initialValues: {
        accountNumber: '123456789012',
        username: 'alice',
        password: 'missing-bind-secret',
        bindHost: '127.0.0.1',
        exposureMode: 'private-network',
        locations: ['sweden-gothenburg', 'austria-vienna'] as [string, ...string[]],
      },
      checkedAt: '2026-03-20T18:45:45.000Z',
    });

    expect(result).toEqual({
      ok: false,
      phase: 'setup-validation',
      source: 'input',
      exitCode: 1,
      paths: store.paths,
      code: 'UNSAFE_PRIVATE_BIND_IP',
      message:
        'Private-network exposure requires a trusted-network IPv4 host, but received 127.0.0.1.',
      cause:
        'Use an RFC1918 address, a Tailscale 100.x address, or 0.0.0.0 as the wildcard fallback when Tailscale is unavailable.',
      artifactPath: store.paths.configFile,
    });
  });

  it('returns shared-device provisioning failure metadata when the first Mullvad device request fails', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const _provisionFixture = JSON.parse(
      await readTextFixture('wg-provision-response.txt'),
    ) as Record<string, unknown>;
    const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');

    await withJsonServer(
      {
        '/wg': (request) => {
          const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };

          return {
            status: 500,
            body: JSON.stringify({
              detail: `account 123456789012 for ${payload.name ?? 'missing-device'} failed upstream`,
            }),
          };
        },
        '/relays': () => ({
          body: JSON.stringify(relayFixture),
        }),
      },
      async (baseUrl) => {
        const result = await runSetupFlow({
          store,
          interactive: false,
          initialValues: {
            accountNumber: '123456789012',
            username: 'alice',
            password: 'route-2-secret',
            locations: ['sweden-gothenburg', 'austria-vienna'] as [string, ...string[]],
            deviceName: 'mullgate-lab',
          },
          provisioningBaseUrl: new URL('/wg', baseUrl),
          relayCatalogUrl: new URL('/relays', baseUrl),
          checkedAt: '2026-03-20T18:46:00.000Z',
        });

        expect(result).toEqual({
          ok: false,
          phase: 'wireguard-provision',
          source: 'mullvad-wg-endpoint',
          exitCode: 1,
          paths: store.paths,
          code: 'HTTP_ERROR',
          endpoint: new URL('/wg', baseUrl).toString(),
          route: {
            index: 0,
            requested: 'sweden-gothenburg',
            alias: 'sweden-gothenburg',
            hostname: 'sweden-gothenburg',
            bindIp: '127.0.0.1',
            deviceName: 'mullgate-lab',
          },
          message: 'Provisioning failed for the shared Mullvad WireGuard device.',
          cause: 'account 123456789012 for mullgate-lab failed upstream',
        });
      },
    );
  });
});

describe('failure metadata and redaction', () => {
  it('reports provisioning, relay, render, and validation failures with phase and source metadata', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);

    const invalidAccount = await provisionWireguard({
      accountNumber: '12',
      checkedAt: '2026-03-20T18:40:00.000Z',
    });

    expect(invalidAccount).toEqual({
      ok: false,
      phase: 'wireguard-provision',
      source: 'input',
      endpoint: 'https://api.mullvad.net/wg',
      checkedAt: '2026-03-20T18:40:00.000Z',
      code: 'INVALID_ACCOUNT',
      message: 'Mullvad account numbers must be 6-16 digits before provisioning can start.',
      retryable: false,
    });

    await withJsonServer(
      {
        '/wg': () => ({
          status: 500,
          body: JSON.stringify({ detail: 'account 123456789012 failed upstream' }),
        }),
        '/wg-throttled': () => ({
          status: 429,
          body: 'Request was throttled. Expected available in 3600 seconds.',
          contentType: 'text/plain',
        }),
        '/bad-relays': () => ({
          body: '{"countries":"definitely-not-an-array"}',
        }),
      },
      async (baseUrl) => {
        const upstreamFailure = await provisionWireguard({
          accountNumber: '123456789012',
          baseUrl: new URL('/wg', baseUrl),
          checkedAt: '2026-03-20T18:41:00.000Z',
          generateKeyPair: () => ({
            publicKey: 'PUBLIC_KEY_FOR_FAILURE_CASE=',
            privateKey: 'PRIVATE_KEY_FOR_FAILURE_CASE=',
          }),
        });

        expect(upstreamFailure).toEqual({
          ok: false,
          phase: 'wireguard-provision',
          source: 'mullvad-wg-endpoint',
          endpoint: new URL('/wg', baseUrl).toString(),
          checkedAt: '2026-03-20T18:41:00.000Z',
          code: 'HTTP_ERROR',
          message: 'Mullvad rejected the WireGuard provisioning request (HTTP 500).',
          cause: 'account 123456789012 failed upstream',
          statusCode: 500,
          retryable: true,
        });

        const throttledFailure = await provisionWireguard({
          accountNumber: '123456789012',
          baseUrl: new URL('/wg-throttled', baseUrl),
          checkedAt: '2026-03-20T18:41:30.000Z',
          generateKeyPair: () => ({
            publicKey: 'PUBLIC_KEY_FOR_THROTTLE_CASE=',
            privateKey: 'PRIVATE_KEY_FOR_THROTTLE_CASE=',
          }),
        });

        expect(throttledFailure).toEqual({
          ok: false,
          phase: 'wireguard-provision',
          source: 'mullvad-wg-endpoint',
          endpoint: new URL('/wg-throttled', baseUrl).toString(),
          checkedAt: '2026-03-20T18:41:30.000Z',
          code: 'HTTP_ERROR',
          message: 'Mullvad rejected the WireGuard provisioning request (HTTP 429).',
          cause: 'Request was throttled. Expected available in 3600 seconds.',
          statusCode: 429,
          retryable: true,
          retryAfterMs: 3_600_000,
        });

        const relayFailure = await fetchRelays({
          url: new URL('/bad-relays', baseUrl),
          fetchedAt: '2026-03-20T18:42:00.000Z',
        });

        expect(relayFailure).toEqual({
          ok: false,
          phase: 'relay-normalize',
          source: 'input',
          endpoint: new URL('/bad-relays', baseUrl).toString(),
          code: 'INVALID_RESPONSE',
          message: 'Mullvad app relay payload failed schema validation.',
          cause: 'countries: Invalid input: expected array, received string',
        });
      },
    );

    const renderFailure = await renderWireproxyArtifacts({
      config: createConfig(paths, {
        publicKey: null,
        privateKey: null,
        ipv4Address: null,
        ipv6Address: null,
        gatewayIpv4: null,
        gatewayIpv6: null,
        dnsServers: [],
        peerPublicKey: null,
        peerEndpoint: null,
      }),
      relayCatalog: {
        source: 'app-wireguard-v1',
        endpoint: 'fixture://app-relays.json',
        fetchedAt: '2026-03-20T18:43:00.000Z',
        relayCount: 0,
        countries: [],
        relays: [],
      },
      paths,
      generatedAt: '2026-03-20T18:43:00.000Z',
    });

    expect(renderFailure).toEqual({
      ok: false,
      phase: 'artifact-render',
      source: 'canonical-config',
      checkedAt: '2026-03-20T18:43:00.000Z',
      code: 'MISSING_WIREGUARD',
      message:
        'Cannot render runtime proxy artifacts before the shared Mullvad WireGuard device is fully provisioned.',
      artifactPath: paths.configFile,
      serviceName: 'entry-tunnel',
    });

    await mkdir(paths.runtimeDir, { recursive: true });
    const invalidWireproxyConfigPath = path.join(paths.runtimeDir, 'invalid-wireproxy.conf');
    await writeFile(
      invalidWireproxyConfigPath,
      '[Interface]\nPrivateKey = only-one-field\n',
      'utf8',
    );

    const validationFailure = await validateWireproxyConfig({
      configPath: invalidWireproxyConfigPath,
      reportPath: paths.runtimeValidationReportFile,
      checkedAt: '2026-03-20T18:44:00.000Z',
      spawn: createSpawnStub({}),
    });

    expect(validationFailure).toEqual({
      ok: false,
      phase: 'validation',
      source: 'internal-syntax',
      status: 'failure',
      checkedAt: '2026-03-20T18:44:00.000Z',
      target: invalidWireproxyConfigPath,
      reportPath: paths.runtimeValidationReportFile,
      validator: 'internal-syntax',
      issues: [
        {
          target: invalidWireproxyConfigPath,
          message: 'Missing required Address entry in [Interface].',
        },
        {
          target: invalidWireproxyConfigPath,
          message: 'Missing required [Peer] section.',
        },
        {
          target: invalidWireproxyConfigPath,
          message: 'Missing required [Socks5] section.',
        },
      ],
      cause: 'Missing required Address entry in [Interface].',
    });

    const report = await readFile(paths.runtimeValidationReportFile, 'utf8');
    expect(report).not.toContain('123456789012');
    expect(report).not.toContain('PRIVATE_KEY_FOR_FAILURE_CASE');
  });
});
