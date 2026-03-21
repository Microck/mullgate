import { createServer } from 'node:http';
import { mkdtempSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLocationAliasCatalog, resolveLocationAlias } from '../src/domain/location-aliases.js';
import { ConfigStore } from '../src/config/store.js';
import { resolveMullgatePaths } from '../src/config/paths.js';
import { runSetupFlow } from '../src/app/setup-runner.js';
import { CONFIG_VERSION, type MullgateConfig } from '../src/config/schema.js';
import { fetchRelays, normalizeRelayPayload } from '../src/mullvad/fetch-relays.js';
import { provisionWireguard } from '../src/mullvad/provision-wireguard.js';
import { renderWireproxyArtifacts } from '../src/runtime/render-wireproxy.js';
import { validateWireproxyConfig } from '../src/runtime/validate-wireproxy.js';

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
  temporaryDirectories.push(root);

  return {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

async function readJsonFixture<T>(name: string): Promise<T> {
  const raw = await readFile(join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as T;
}

async function readTextFixture(name: string): Promise<string> {
  return readFile(join(fixturesDir, name), 'utf8');
}

async function withJsonServer(routes: Record<string, JsonRouteHandler>, run: (baseUrl: URL) => Promise<void>): Promise<void> {
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
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function createConfig(paths: ReturnType<typeof resolveMullgatePaths>, wireguard: MullgateConfig['mullvad']['wireguard']): MullgateConfig {
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
        {
          alias: 'sweden-gothenburg',
          hostname: 'sweden-gothenburg',
          bindIp: '127.0.0.1',
          relayPreference: {
            requested: 'sweden-gothenburg',
            resolvedAlias: null,
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
          runtime: {
            routeId: 'sweden-gothenburg',
            wireproxyServiceName: 'wireproxy-sweden-gothenburg',
            haproxyBackendName: 'route-sweden-gothenburg',
            wireproxyConfigFile: 'wireproxy-sweden-gothenburg.conf',
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
        message: 'Pending first validation.',
      },
    },
    diagnostics: {
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

function normalizePathInput(value: string, home: string): string {
  return value.split(home).join('/tmp/mullgate-home');
}

function createSpawnStub(handlers: Record<string, (args: readonly string[]) => Partial<ReturnType<typeof spawnSync>>>): typeof spawnSync {
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
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
    expect(legacyResult.value.relays.map((relay) => relay.hostname)).toEqual(['at-vie-wg-001', 'se-got-wg-101', 'se-sto-wg-001']);
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
    expect('\n' + JSON.stringify({
      countries: aliasCatalog.value.countries,
      cities: aliasCatalog.value.cities,
      ambiguousAliases: aliasCatalog.value.ambiguousAliases,
    }, null, 2)).toMatchInlineSnapshot(`
"\n{
  \"countries\": [
    {
      \"code\": \"at\",
      \"name\": \"Austria\",
      \"aliases\": [
        \"at\",
        \"austria\"
      ]
    },
    {
      \"code\": \"se\",
      \"name\": \"Sweden\",
      \"aliases\": [
        \"se\",
        \"sweden\"
      ]
    }
  ],
  \"cities\": [
    {
      \"countryCode\": \"at\",
      \"countryName\": \"Austria\",
      \"code\": \"vie\",
      \"name\": \"Vienna\",
      \"aliases\": [
        \"at-vie\",
        \"at-vienna\",
        \"austria-vienna\",
        \"vienna\"
      ]
    },
    {
      \"countryCode\": \"se\",
      \"countryName\": \"Sweden\",
      \"code\": \"got\",
      \"name\": \"Gothenburg\",
      \"aliases\": [
        \"se-got\",
        \"se-gothenburg\",
        \"sweden-gothenburg\",
        \"gothenburg\"
      ]
    },
    {
      \"countryCode\": \"se\",
      \"countryName\": \"Sweden\",
      \"code\": \"sto\",
      \"name\": \"Stockholm\",
      \"aliases\": [
        \"se-sto\",
        \"se-stockholm\",
        \"sweden-stockholm\",
        \"stockholm\"
      ]
    }
  ],
  \"ambiguousAliases\": []
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
        expect(JSON.stringify(provisionResult.value)).not.toContain(provisionResult.value.privateKey);

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

        const wireproxyConfig = await readFile(renderResult.artifactPaths.wireproxyConfigPath, 'utf8');
        const relayCache = JSON.parse(await readFile(renderResult.artifactPaths.relayCachePath, 'utf8')) as { relayCount: number };
        const configStats = statSync(renderResult.artifactPaths.wireproxyConfigPath);

        expect(configStats.mode & 0o777).toBe(0o600);
        expect(relayCache.relayCount).toBe(5);

        const validation = await validateWireproxyConfig({
          configPath: renderResult.artifactPaths.wireproxyConfigPath,
          reportPath: renderResult.artifactPaths.configTestReportPath,
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
          target: renderResult.artifactPaths.wireproxyConfigPath,
          reportPath: renderResult.artifactPaths.configTestReportPath,
          validator: 'docker-wireproxy-configtest',
          issues: [],
        });

        const report = normalizePathInput(await readFile(renderResult.artifactPaths.configTestReportPath, 'utf8'), env.HOME!).trimEnd();
        const normalizedConfig = normalizePathInput(wireproxyConfig, env.HOME!)
          .split(provisionResult.value.privateKey).join('WG_PRIVATE_KEY')
          .split('super-secret-password').join('PROXY_PASSWORD');

        expect('\n' + normalizedConfig).toMatchInlineSnapshot(`
"\n# Generated by Mullgate. Derived artifact; edit canonical config instead.
# Generated at 2026-03-20T18:34:00.000Z

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
BindAddress = 0.0.0.0:1080
Username = alice
Password = PROXY_PASSWORD

[http]
BindAddress = 0.0.0.0:8080
Username = alice
Password = PROXY_PASSWORD
"
`);
        expect('\n' + report).toMatchInlineSnapshot(`
"\n{
  \"ok\": true,
  \"phase\": \"validation\",
  \"source\": \"docker\",
  \"status\": \"success\",
  \"checkedAt\": \"2026-03-20T18:35:00.000Z\",
  \"target\": \"/tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf\",
  \"validator\": \"docker-wireproxy-configtest\",
  \"issues\": []
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

  it('persists multi-route setup state with distinct Mullvad device data', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const store = new ConfigStore(paths);
    const provisionFixture = JSON.parse(await readTextFixture('wg-provision-response.txt')) as Record<string, unknown>;
    const relayFixture = await readJsonFixture<unknown>('app-relays.json');
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

        expect(provisionedNames).toEqual(['mullgate-lab-sweden-gothenburg', 'mullgate-lab-austria-vienna']);
        expect(result.routes).toEqual([
          {
            index: 0,
            requested: 'sweden-gothenburg',
            alias: 'sweden-gothenburg',
            hostname: 'sweden-gothenburg',
            bindIp: '127.0.0.1',
            deviceName: 'mullgate-lab-sweden-gothenburg',
            publicKey: result.routes[0]!.publicKey,
            ipv4Address: '10.64.12.34/32',
            ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1234/128',
          },
          {
            index: 1,
            requested: 'austria-vienna',
            alias: 'austria-vienna',
            hostname: 'austria-vienna',
            bindIp: '127.0.0.2',
            deviceName: 'mullgate-lab-austria-vienna',
            publicKey: result.routes[1]!.publicKey,
            ipv4Address: '10.64.12.35/32',
            ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1234/128',
          },
        ]);

        const savedConfig = JSON.parse(await readFile(paths.configFile, 'utf8')) as MullgateConfig;
        expect(savedConfig.routing.locations).toHaveLength(2);
        expect(savedConfig.routing.locations[0]!.mullvad.deviceName).toBe('mullgate-lab-sweden-gothenburg');
        expect(savedConfig.routing.locations[1]!.mullvad.deviceName).toBe('mullgate-lab-austria-vienna');
        expect(savedConfig.routing.locations[0]!.bindIp).toBe('127.0.0.1');
        expect(savedConfig.routing.locations[1]!.bindIp).toBe('127.0.0.2');
        expect(savedConfig.routing.locations[0]!.mullvad.wireguard.publicKey).not.toBe(
          savedConfig.routing.locations[1]!.mullvad.wireguard.publicKey,
        );
        expect(savedConfig.routing.locations[0]!.mullvad.wireguard.ipv4Address).toBe('10.64.12.34/32');
        expect(savedConfig.routing.locations[1]!.mullvad.wireguard.ipv4Address).toBe('10.64.12.35/32');
        expect(savedConfig.setup.location.requested).toBe('sweden-gothenburg');
        expect(savedConfig.setup.location.resolvedAlias).toBe('sweden-gothenburg');
        expect(savedConfig.mullvad.deviceName).toBe('mullgate-lab-sweden-gothenburg');
      },
    );
  });

  it('returns route-specific provisioning failure metadata for the second route', async () => {
    const env = createTempEnvironment();
    const store = new ConfigStore(resolveMullgatePaths(env));
    const provisionFixture = JSON.parse(await readTextFixture('wg-provision-response.txt')) as Record<string, unknown>;
    const relayFixture = await readJsonFixture<unknown>('app-relays.json');
    let provisionCount = 0;

    await withJsonServer(
      {
        '/wg': (request) => {
          provisionCount += 1;
          const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };

          if (provisionCount === 2) {
            return {
              status: 500,
              body: JSON.stringify({ detail: `account 123456789012 for ${payload.name ?? 'missing-device'} failed upstream` }),
            };
          }

          return {
            body: JSON.stringify({
              ...provisionFixture,
              id: 'device-1',
              pubkey: payload.pubkey,
              name: payload.name ?? 'mullgate-lab-sweden-gothenburg',
              ipv4_address: '10.64.12.34/32',
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
            index: 1,
            requested: 'austria-vienna',
            alias: 'austria-vienna',
            hostname: 'austria-vienna',
            bindIp: '127.0.0.2',
            deviceName: 'mullgate-lab-austria-vienna',
          },
          message: 'Provisioning failed for routed location austria-vienna (austria-vienna -> 127.0.0.2).',
          cause: 'account [redacted-account] for mullgate-lab-austria-vienna failed upstream',
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
          cause: 'account [redacted-account] failed upstream',
          statusCode: 500,
          retryable: true,
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
      message: 'Cannot render wireproxy artifacts before Mullvad WireGuard credentials are fully provisioned.',
      artifactPath: paths.configFile,
    });

    await mkdir(paths.runtimeDir, { recursive: true });
    const invalidWireproxyConfigPath = path.join(paths.runtimeDir, 'invalid-wireproxy.conf');
    await writeFile(invalidWireproxyConfigPath, '[Interface]\nPrivateKey = only-one-field\n', 'utf8');

    const validationFailure = await validateWireproxyConfig({
      configPath: invalidWireproxyConfigPath,
      reportPath: paths.wireproxyConfigTestReportFile,
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
      reportPath: paths.wireproxyConfigTestReportFile,
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
        {
          target: invalidWireproxyConfigPath,
          message: 'Missing required [http] section.',
        },
      ],
      cause: 'Missing required Address entry in [Interface].',
    });

    const report = await readFile(paths.wireproxyConfigTestReportFile, 'utf8');
    expect(report).not.toContain('123456789012');
    expect(report).not.toContain('PRIVATE_KEY_FOR_FAILURE_CASE');
  });
});
