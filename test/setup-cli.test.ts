import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveMullgatePaths } from '../src/config/paths.js';
import type { MullgateConfig } from '../src/config/schema.js';
import {
  createFakeWireproxyBinary,
  normalizeFixtureHomePath,
} from './helpers/platform-test-utils.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const fixturesDir = path.join(repoRoot, 'test/fixtures/mullvad');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

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

type CliRunOptions = {
  env: NodeJS.ProcessEnv;
  input?: string;
};

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-setup-cli-'));
  const linuxRoot = root.replaceAll('\\', '/');
  const binDir = `${linuxRoot}/bin`;
  temporaryDirectories.push(root);

  return {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: linuxRoot,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    XDG_CONFIG_HOME: `${linuxRoot}/config`,
    XDG_STATE_HOME: `${linuxRoot}/state`,
    XDG_CACHE_HOME: `${linuxRoot}/cache`,
  };
}

async function readJsonFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixturesDir, name), 'utf8')) as T;
}

async function readTextFixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

async function readSavedConfig(env: NodeJS.ProcessEnv): Promise<MullgateConfig> {
  const paths = resolveMullgatePaths(env);
  return JSON.parse(await readFile(paths.configFile, 'utf8')) as MullgateConfig;
}

function createProxyExportFixtureConfig(config: MullgateConfig): MullgateConfig {
  const templateRoute = structuredClone(config.routing.locations[0]!);
  const createRoute = (input: {
    alias: string;
    hostname: string;
    bindIp: string;
    country: string;
    city: string;
    hostnameLabel: string;
    deviceName: string;
  }): MullgateConfig['routing']['locations'][number] => ({
    ...structuredClone(templateRoute),
    alias: input.alias,
    hostname: input.hostname,
    bindIp: input.bindIp,
    relayPreference: {
      requested: input.alias,
      country: input.country,
      city: input.city,
      hostnameLabel: input.hostnameLabel,
      resolvedAlias: input.alias,
    },
    mullvad: {
      ...structuredClone(templateRoute.mullvad),
      deviceName: input.deviceName,
    },
    runtime: {
      routeId: input.alias,
      wireproxyServiceName: `wireproxy-${input.alias}`,
      haproxyBackendName: `route-${input.alias}`,
      wireproxyConfigFile: `wireproxy-${input.alias}.conf`,
    },
  });

  return {
    ...config,
    setup: {
      ...config.setup,
      bind: {
        ...config.setup.bind,
        host: '192.168.10.10',
      },
      exposure: {
        mode: 'private-network',
        allowLan: true,
        baseDomain: 'proxy.example.com',
      },
    },
    routing: {
      locations: [
        createRoute({
          alias: 'sweden-gothenburg',
          hostname: 'sweden-gothenburg.proxy.example.com',
          bindIp: '192.168.10.10',
          country: 'se',
          city: 'got',
          hostnameLabel: 'se-got-wg-101',
          deviceName: 'mullgate-export-se',
        }),
        createRoute({
          alias: 'austria-vienna',
          hostname: 'austria-vienna.proxy.example.com',
          bindIp: '192.168.10.11',
          country: 'at',
          city: 'vie',
          hostnameLabel: 'at-vie-wg-001',
          deviceName: 'mullgate-export-at',
        }),
        createRoute({
          alias: 'usa-new-york',
          hostname: 'usa-new-york.proxy.example.com',
          bindIp: '192.168.10.12',
          country: 'us',
          city: 'nyc',
          hostnameLabel: 'us-nyc-wg-001',
          deviceName: 'mullgate-export-us',
        }),
      ],
    },
  };
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

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') {
        headers.set(key, value);
      }
    }

    const routeResult = route({
      url: request.url ?? '/',
      method: request.method ?? 'GET',
      headers,
      body: rawBody.length > 0 ? tryParseJson(rawBody) : null,
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
    throw new Error('Failed to bind local test server.');
  }

  try {
    await run(new URL(`http://127.0.0.1:${address.port}`));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function runCli(args: string[], options: CliRunOptions): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, 'src/cli.ts', ...args], {
      cwd: repoRoot,
      env: options.env,
      stdio: 'pipe',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        status: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function normalizeOutput(value: string, env: NodeJS.ProcessEnv): string {
  return normalizeFixtureHomePath(value, env.HOME).trimEnd();
}

function _coerceProcessOutput(value: string | NodeJS.ArrayBufferView | null): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!value) {
    return '';
  }

  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
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
  await Promise.all(temporaryFiles.splice(0).map((file) => rm(file, { force: true })));
});

describe('mullgate setup CLI flow', () => {
  it(
    'completes setup from a clean XDG home and exposes redacted config inspection surfaces',
    { timeout: 20000 },
    async () => {
      const env = createTempEnvironment();
      await createFakeWireproxyBinary(env.HOME!);

      const provisionFixture = await readTextFixture('wg-provision-response.txt');
      const relayFixture = await readJsonFixture<unknown>('app-relays.json');

      await withJsonServer(
        {
          '/wg': (request) => {
            const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };
            return {
              body: JSON.stringify({
                ...JSON.parse(provisionFixture),
                pubkey: payload.pubkey,
                name: payload.name ?? 'mullgate-test-host',
              }),
            };
          },
          '/relays': () => ({
            body: JSON.stringify(relayFixture),
          }),
        },
        async (baseUrl) => {
          const setupResult = await runCli(
            [
              'setup',
              '--non-interactive',
              '--bind-host',
              '127.0.0.1',
              '--socks-port',
              '1080',
              '--http-port',
              '8080',
              '--device-name',
              'mullgate-single',
              '--mullvad-wg-url',
              new URL('/wg', baseUrl).toString(),
              '--mullvad-relays-url',
              new URL('/relays', baseUrl).toString(),
            ],
            {
              env: {
                ...env,
                MULLGATE_ACCOUNT_NUMBER: '123456789012',
                MULLGATE_PROXY_USERNAME: 'alice',
                MULLGATE_PROXY_PASSWORD: 'top-secret-password',
                MULLGATE_LOCATION: 'sweden-gothenburg',
              },
            },
          );

          expect(setupResult.status).toBe(0);
          expect(setupResult.stderr).toBe('');
          expect(`\n${normalizeOutput(setupResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate setup completed.
          phase: setup-complete
          source: guided-setup
          config: /tmp/mullgate-home/config/mullgate/config.json
          wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
          relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
          docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
          validation report: /tmp/mullgate-home/state/mullgate/runtime/wireproxy-configtest.json
          location: sweden-gothenburg
          exposure: loopback
          base domain: n/a
          routes: 1
          1. sweden-gothenburg
             hostname: sweden-gothenburg
             bind ip: 127.0.0.1
             device: mullgate-single
             tunnel ipv4: 10.64.12.34/32
          relay: se-got-wg-101
          validation: wireproxy-binary/configtest"
        `);

          const [
            pathResult,
            showResult,
            locationsResult,
            hostsResult,
            getPasswordResult,
            getLocationResult,
            validateResult,
          ] = await Promise.all([
            runCli(['config', 'path'], { env }),
            runCli(['config', 'show'], { env }),
            runCli(['config', 'locations'], { env }),
            runCli(['config', 'hosts'], { env }),
            runCli(['config', 'get', 'setup.auth.password'], { env }),
            runCli(['config', 'get', 'setup.location.requested'], { env }),
            runCli(['config', 'validate'], { env }),
          ]);

          expect(pathResult.status).toBe(0);
          expect(showResult.status).toBe(0);
          expect(locationsResult.status).toBe(0);
          expect(hostsResult.status).toBe(0);
          expect(getPasswordResult.status).toBe(0);
          expect(getLocationResult.status).toBe(0);
          expect(validateResult.status).toBe(0);

          expect(showResult.stdout).not.toContain('123456789012');
          expect(showResult.stdout).not.toContain('top-secret-password');
          expect(showResult.stdout).toContain('[redacted]');
          expect(locationsResult.stdout).not.toContain('123456789012');
          expect(locationsResult.stdout).not.toContain('top-secret-password');
          expect(hostsResult.stdout).not.toContain('123456789012');
          expect(hostsResult.stdout).not.toContain('top-secret-password');
          expect(getPasswordResult.stdout.trim()).toBe('[redacted]');
          expect(getLocationResult.stdout.trim()).toBe('sweden-gothenburg');
          expect(`\n${normalizeOutput(pathResult.stdout, env)}`).toMatchInlineSnapshot(`
            "
            Mullgate path report
            phase: resolve-paths
            source: canonical-path-contract
            platform: linux
            platform source: env:MULLGATE_PLATFORM
            platform support: full
            platform mode: Linux-first runtime support
            platform summary: Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.
            runtime story: Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.
            host networking: Native host networking available
            host networking summary: Docker host networking behaves as expected on Linux, so the routing layer and per-route wireproxy listeners can bind directly to the saved route IPs.
            config home: /tmp/mullgate-home/config (env:XDG_CONFIG_HOME)
            state home: /tmp/mullgate-home/state (env:XDG_STATE_HOME)
            cache home: /tmp/mullgate-home/cache (env:XDG_CACHE_HOME)
            config file: /tmp/mullgate-home/config/mullgate/config.json (present)
            state dir: /tmp/mullgate-home/state/mullgate
            cache dir: /tmp/mullgate-home/cache/mullgate
            runtime dir: /tmp/mullgate-home/state/mullgate/runtime (present)
            wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
            wireproxy configtest report: /tmp/mullgate-home/state/mullgate/runtime/wireproxy-configtest.json
            docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
            relay cache: /tmp/mullgate-home/cache/mullgate/relays.json (present)

            platform guidance
            - Linux is the reference runtime target for the current Mullgate topology and verification flow.
            - Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.

            platform warnings
            - none"
          `);
          expect(`\n${normalizeOutput(locationsResult.stdout, env)}`).toMatchInlineSnapshot(`
"\nMullgate routed locations
phase: inspect-config
source: canonical-config
config: /tmp/mullgate-home/config/mullgate/config.json
routes: 1

1. sweden-gothenburg
   hostname: sweden-gothenburg
   bind ip: 127.0.0.1
   requested: sweden-gothenburg
   resolved alias: sweden-gothenburg
   country: se
   city: got
   route id: sweden-gothenburg
   wireproxy service: wireproxy-sweden-gothenburg"
`);
          expect(`\n${normalizeOutput(hostsResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate routed hosts
          phase: inspect-config
          source: canonical-config
          config: /tmp/mullgate-home/config/mullgate/config.json
          routes: 1
          hostname -> bind ip
          1. sweden-gothenburg -> 127.0.0.1 (alias: sweden-gothenburg, route id: sweden-gothenburg)

          copy/paste hosts block
          127.0.0.1 sweden-gothenburg"
        `);
          expect(`\n${normalizeOutput(validateResult.stdout, env)}`).toMatchInlineSnapshot(`
"\nMullgate config validated.
phase: validation
source: wireproxy-binary
artifact: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
report: /tmp/mullgate-home/state/mullgate/runtime/wireproxy-configtest.json
artifacts refreshed: no
runtime status: validated
reason: Validated via wireproxy-binary/configtest."
`);
        },
      );
    },
  );

  it(
    'saves two routed locations from the real CLI flow with deterministic route metadata',
    { timeout: 10000 },
    async () => {
      const env = createTempEnvironment();
      await createFakeWireproxyBinary(env.HOME!);

      const provisionFixture = JSON.parse(
        await readTextFixture('wg-provision-response.txt'),
      ) as Record<string, unknown>;
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
          const setupResult = await runCli(
            [
              'setup',
              '--non-interactive',
              '--device-name',
              'mullgate-lab',
              '--location',
              'sweden-gothenburg',
              '--location',
              'austria-vienna',
              '--mullvad-wg-url',
              new URL('/wg', baseUrl).toString(),
              '--mullvad-relays-url',
              new URL('/relays', baseUrl).toString(),
            ],
            {
              env: {
                ...env,
                MULLGATE_ACCOUNT_NUMBER: '123456789012',
                MULLGATE_PROXY_USERNAME: 'alice',
                MULLGATE_PROXY_PASSWORD: 'multi-route-secret',
              },
            },
          );

          expect(setupResult.status).toBe(0);
          expect(setupResult.stderr).toBe('');
          expect(provisionedNames).toEqual([
            'mullgate-lab-sweden-gothenburg',
            'mullgate-lab-austria-vienna',
          ]);
          expect(`\n${normalizeOutput(setupResult.stdout, env)}`).toMatchInlineSnapshot(`
"\nMullgate setup completed.
phase: setup-complete
source: guided-setup
config: /tmp/mullgate-home/config/mullgate/config.json
wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
validation report: /tmp/mullgate-home/state/mullgate/runtime/wireproxy-configtest.json
location: sweden-gothenburg
exposure: loopback
base domain: n/a
routes: 2
1. sweden-gothenburg
   hostname: sweden-gothenburg
   bind ip: 127.0.0.1
   device: mullgate-lab-sweden-gothenburg
   tunnel ipv4: 10.64.12.34/32
2. austria-vienna
   hostname: austria-vienna
   bind ip: 127.0.0.2
   device: mullgate-lab-austria-vienna
   tunnel ipv4: 10.64.12.35/32
relay: se-got-wg-101
validation: wireproxy-binary/configtest"
`);

          const savedConfig = await readSavedConfig(env);
          const [locationsResult, hostsResult] = await Promise.all([
            runCli(['config', 'locations'], { env }),
            runCli(['config', 'hosts'], { env }),
          ]);

          expect(savedConfig.routing.locations).toHaveLength(2);
          expect(savedConfig.setup.exposure).toEqual({
            mode: 'loopback',
            allowLan: false,
            baseDomain: null,
          });
          expect(
            savedConfig.routing.locations.map((location) => ({
              alias: location.alias,
              hostname: location.hostname,
              bindIp: location.bindIp,
              deviceName: location.mullvad.deviceName,
              ipv4Address: location.mullvad.wireguard.ipv4Address,
            })),
          ).toEqual([
            {
              alias: 'sweden-gothenburg',
              hostname: 'sweden-gothenburg',
              bindIp: '127.0.0.1',
              deviceName: 'mullgate-lab-sweden-gothenburg',
              ipv4Address: '10.64.12.34/32',
            },
            {
              alias: 'austria-vienna',
              hostname: 'austria-vienna',
              bindIp: '127.0.0.2',
              deviceName: 'mullgate-lab-austria-vienna',
              ipv4Address: '10.64.12.35/32',
            },
          ]);
          expect(savedConfig.routing.locations[0]?.mullvad.wireguard.publicKey).not.toBe(
            savedConfig.routing.locations[1]?.mullvad.wireguard.publicKey,
          );
          expect(savedConfig.mullvad.deviceName).toBe('mullgate-lab-sweden-gothenburg');
          expect(savedConfig.setup.location.requested).toBe('sweden-gothenburg');
          expect(savedConfig.setup.location.resolvedAlias).toBe('sweden-gothenburg');
          expect(`\n${normalizeOutput(locationsResult.stdout, env)}`).toMatchInlineSnapshot(`
"\nMullgate routed locations
phase: inspect-config
source: canonical-config
config: /tmp/mullgate-home/config/mullgate/config.json
routes: 2

1. sweden-gothenburg
   hostname: sweden-gothenburg
   bind ip: 127.0.0.1
   requested: sweden-gothenburg
   resolved alias: sweden-gothenburg
   country: se
   city: got
   route id: sweden-gothenburg
   wireproxy service: wireproxy-sweden-gothenburg

2. austria-vienna
   hostname: austria-vienna
   bind ip: 127.0.0.2
   requested: austria-vienna
   resolved alias: austria-vienna
   country: at
   city: vie
   route id: austria-vienna
   wireproxy service: wireproxy-austria-vienna"
`);
          expect(`\n${normalizeOutput(hostsResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate routed hosts
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
        },
      );
    },
  );

  it(
    'persists a domain-backed multi-route exposure contract from the real CLI flow',
    { timeout: 15000 },
    async () => {
      const env = createTempEnvironment();
      await createFakeWireproxyBinary(env.HOME!);

      const provisionFixture = JSON.parse(
        await readTextFixture('wg-provision-response.txt'),
      ) as Record<string, unknown>;
      const relayFixture = await readJsonFixture<unknown>('app-relays.json');
      let provisionCount = 0;

      await withJsonServer(
        {
          '/wg': (request) => {
            provisionCount += 1;
            const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };

            return {
              body: JSON.stringify({
                ...provisionFixture,
                id: `device-${provisionCount}`,
                pubkey: payload.pubkey,
                name: payload.name ?? `mullgate-route-${provisionCount}`,
                ipv4_address: `10.64.22.${20 + provisionCount}/32`,
              }),
            };
          },
          '/relays': () => ({
            body: JSON.stringify(relayFixture),
          }),
        },
        async (baseUrl) => {
          const setupResult = await runCli(
            [
              'setup',
              '--non-interactive',
              '--device-name',
              'mullgate-domain',
              '--exposure-mode',
              'private-network',
              '--base-domain',
              'proxy.example.com',
              '--route-bind-ip',
              '192.168.10.10',
              '--route-bind-ip',
              '192.168.10.11',
              '--location',
              'sweden-gothenburg',
              '--location',
              'austria-vienna',
              '--mullvad-wg-url',
              new URL('/wg', baseUrl).toString(),
              '--mullvad-relays-url',
              new URL('/relays', baseUrl).toString(),
            ],
            {
              env: {
                ...env,
                MULLGATE_ACCOUNT_NUMBER: '123456789012',
                MULLGATE_PROXY_USERNAME: 'alice',
                MULLGATE_PROXY_PASSWORD: 'domain-secret',
              },
            },
          );

          expect(setupResult.status).toBe(0);
          expect(setupResult.stderr).toBe('');
          expect(`\n${normalizeOutput(setupResult.stdout, env)}`).toMatchInlineSnapshot(`
"\nMullgate setup completed.
phase: setup-complete
source: guided-setup
config: /tmp/mullgate-home/config/mullgate/config.json
wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
validation report: /tmp/mullgate-home/state/mullgate/runtime/wireproxy-configtest.json
location: sweden-gothenburg
exposure: private-network
base domain: proxy.example.com
routes: 2
1. sweden-gothenburg
   hostname: sweden-gothenburg.proxy.example.com
   bind ip: 192.168.10.10
   device: mullgate-domain-sweden-gothenburg
   tunnel ipv4: 10.64.22.21/32
2. austria-vienna
   hostname: austria-vienna.proxy.example.com
   bind ip: 192.168.10.11
   device: mullgate-domain-austria-vienna
   tunnel ipv4: 10.64.22.22/32
relay: se-got-wg-101
validation: wireproxy-binary/configtest"
`);

          const savedConfig = await readSavedConfig(env);
          const [showResult, hostsResult] = await Promise.all([
            runCli(['config', 'show'], { env }),
            runCli(['config', 'hosts'], { env }),
          ]);

          expect(savedConfig.setup.exposure).toEqual({
            mode: 'private-network',
            allowLan: true,
            baseDomain: 'proxy.example.com',
          });
          expect(savedConfig.setup.bind.host).toBe('192.168.10.10');
          expect(
            savedConfig.routing.locations.map((location) => ({
              hostname: location.hostname,
              bindIp: location.bindIp,
            })),
          ).toEqual([
            { hostname: 'sweden-gothenburg.proxy.example.com', bindIp: '192.168.10.10' },
            { hostname: 'austria-vienna.proxy.example.com', bindIp: '192.168.10.11' },
          ]);
          expect(showResult.stdout).toContain('proxy.example.com');
          expect(`\n${normalizeOutput(hostsResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate routed hosts
          phase: inspect-config
          source: canonical-config
          config: /tmp/mullgate-home/config/mullgate/config.json
          routes: 2
          hostname -> bind ip
          1. sweden-gothenburg.proxy.example.com -> 192.168.10.10 (alias: sweden-gothenburg, route id: sweden-gothenburg)
          2. austria-vienna.proxy.example.com -> 192.168.10.11 (alias: austria-vienna, route id: austria-vienna)

          copy/paste hosts block
          192.168.10.10 sweden-gothenburg.proxy.example.com
          192.168.10.11 austria-vienna.proxy.example.com"
        `);
        },
      );
    },
  );

  it(
    'exports weighted proxy batches to generated and explicit files without leaking secrets',
    { timeout: 15000 },
    async () => {
      const env = createTempEnvironment();
      await createFakeWireproxyBinary(env.HOME!);

      const provisionFixture = await readTextFixture('wg-provision-response.txt');
      const relayFixture = await readJsonFixture<unknown>('app-relays.json');
      const paths = resolveMullgatePaths(env);

      await withJsonServer(
        {
          '/wg': (request) => {
            const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };
            return {
              body: JSON.stringify({
                ...JSON.parse(provisionFixture),
                pubkey: payload.pubkey,
                name: payload.name ?? 'mullgate-export-host',
              }),
            };
          },
          '/relays': () => ({ body: JSON.stringify(relayFixture) }),
        },
        async (baseUrl) => {
          const setupResult = await runCli(
            [
              'setup',
              '--non-interactive',
              '--mullvad-wg-url',
              new URL('/wg', baseUrl).toString(),
              '--mullvad-relays-url',
              new URL('/relays', baseUrl).toString(),
            ],
            {
              env: {
                ...env,
                MULLGATE_ACCOUNT_NUMBER: '123456789012',
                MULLGATE_PROXY_USERNAME: 'alice',
                MULLGATE_PROXY_PASSWORD: 'export-secret',
                MULLGATE_LOCATION: 'sweden-gothenburg',
              },
            },
          );

          expect(setupResult.status).toBe(0);

          const exportFixtureConfig = createProxyExportFixtureConfig(await readSavedConfig(env));
          await writeFile(paths.configFile, JSON.stringify(exportFixtureConfig, null, 2), 'utf8');

          const autoFilename = path.join(
            repoRoot,
            'proxy-socks5-country-se-1--region-europe-2.txt',
          );
          temporaryFiles.push(autoFilename);
          const explicitOutput = path.join(env.HOME!, 'exports', 'proxy.txt');
          temporaryFiles.push(explicitOutput);
          const overwriteOutput = path.join(env.HOME!, 'exports', 'overwrite.txt');
          temporaryFiles.push(overwriteOutput);
          const guidedOutput = path.join(repoRoot, 'proxies.txt');
          temporaryFiles.push(guidedOutput);

          await Promise.all([
            rm(autoFilename, { force: true }),
            rm(explicitOutput, { force: true }),
            rm(overwriteOutput, { force: true }),
            rm(guidedOutput, { force: true }),
          ]);

          const autoResult = await runCli(
            [
              'config',
              'export',
              '--country',
              'se',
              '--count',
              '1',
              '--region',
              'europe',
              '--count',
              '2',
            ],
            { env },
          );
          const explicitResult = await runCli(
            [
              'config',
              'export',
              '--protocol',
              'http',
              '--country',
              'us',
              '--count',
              '1',
              '--output',
              explicitOutput,
            ],
            { env },
          );
          await writeFile(overwriteOutput, 'stale\n', 'utf8');
          const dryRunResult = await runCli(
            [
              'config',
              'export',
              '--dry-run',
              '--country',
              'se',
              '--count',
              '1',
              '--region',
              'europe',
              '--count',
              '2',
            ],
            { env },
          );
          const stdoutResult = await runCli(
            [
              'config',
              'export',
              '--stdout',
              '--protocol',
              'http',
              '--country',
              'us',
              '--count',
              '1',
            ],
            { env },
          );
          const overwriteFailResult = await runCli(
            ['config', 'export', '--output', overwriteOutput, '--country', 'se', '--count', '1'],
            { env },
          );
          const overwriteForceResult = await runCli(
            [
              'config',
              'export',
              '--force',
              '--output',
              overwriteOutput,
              '--country',
              'se',
              '--count',
              '1',
            ],
            { env },
          );
          const regionsResult = await runCli(['config', 'regions'], { env });
          const guidedResult = await runCli(['config', 'export', '--guided'], {
            env,
            input:
              '\n' +
              'y\n' +
              '\n' +
              'se\n' +
              '1\n' +
              'y\n' +
              'region\n' +
              'europe\n' +
              '2\n' +
              'n\n' +
              '\n' +
              '\n',
          });

          expect(autoResult.status).toBe(0);
          expect(explicitResult.status).toBe(0);
          expect(dryRunResult.status).toBe(0);
          expect(stdoutResult.status).toBe(0);
          expect(overwriteFailResult.status).toBe(1);
          expect(overwriteForceResult.status).toBe(0);
          expect(regionsResult.status).toBe(0);
          expect(guidedResult.status).toBe(0);
          expect(autoResult.stdout).not.toContain('export-secret');
          expect(explicitResult.stdout).not.toContain('export-secret');
          expect(dryRunResult.stdout).not.toContain('export-secret');
          expect(autoResult.stderr).toBe('');
          expect(explicitResult.stderr).toBe('');
          expect(guidedResult.stdout).not.toContain('export-secret');

          const autoFileContents = await readFile(autoFilename, 'utf8');
          const explicitFileContents = await readFile(explicitOutput, 'utf8');
          const overwriteFileContents = await readFile(overwriteOutput, 'utf8');
          const guidedFileContents = await readFile(guidedOutput, 'utf8');

          expect(`\n${normalizeOutput(autoResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate proxy export complete.
          phase: export-proxies
          source: canonical-config
          config: /tmp/mullgate-home/config/mullgate/config.json
          protocol: socks5
          write mode: file
          selectors: 2
          1. country=se requested=1 matched=1 exported=1
          2. region=europe requested=2 matched=1 exported=1
          exported count: 2
          output: ./proxy-socks5-country-se-1--region-europe-2.txt"
        `);
          expect(`\n${autoFileContents}`).toMatchInlineSnapshot(`
          "
          socks5://alice:export-secret@sweden-gothenburg.proxy.example.com:1080
          socks5://alice:export-secret@austria-vienna.proxy.example.com:1080
          "
        `);
          expect(`\n${normalizeOutput(explicitResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate proxy export complete.
          phase: export-proxies
          source: canonical-config
          config: /tmp/mullgate-home/config/mullgate/config.json
          protocol: http
          write mode: file
          selectors: 1
          1. country=us requested=1 matched=1 exported=1
          exported count: 1
          output: /tmp/mullgate-home/exports/proxy.txt"
        `);
          expect(`\n${explicitFileContents}`).toMatchInlineSnapshot(`
          "
          http://alice:export-secret@usa-new-york.proxy.example.com:8080
          "
        `);
          expect(`\n${normalizeOutput(dryRunResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate proxy export preview.
          phase: export-proxies
          source: canonical-config
          config: /tmp/mullgate-home/config/mullgate/config.json
          protocol: socks5
          write mode: dry-run
          selectors: 2
          1. country=se requested=1 matched=1 exported=1
          2. region=europe requested=2 matched=1 exported=1
          exported count: 2
          output: ./proxy-socks5-country-se-1--region-europe-2.txt

          preview
          1. socks5://[redacted]:[redacted]@sweden-gothenburg.proxy.example.com:1080 (alias: sweden-gothenburg, country: se)
          2. socks5://[redacted]:[redacted]@austria-vienna.proxy.example.com:1080 (alias: austria-vienna, country: at)"
        `);
          expect(dryRunResult.stderr).toBe('');
          expect(`\n${normalizeOutput(stdoutResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          http://alice:export-secret@usa-new-york.proxy.example.com:8080"
        `);
          expect(`\n${normalizeOutput(stdoutResult.stderr, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate proxy export complete.
          phase: export-proxies
          source: canonical-config
          config: /tmp/mullgate-home/config/mullgate/config.json
          protocol: http
          write mode: stdout
          selectors: 1
          1. country=us requested=1 matched=1 exported=1
          exported count: 1
          output: stdout"
        `);
          expect(`\n${normalizeOutput(overwriteFailResult.stderr, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate proxy export failed.
          phase: persist-file
          source: filesystem
          config: /tmp/mullgate-home/config/mullgate/config.json
          artifact: /tmp/mullgate-home/exports/overwrite.txt
          reason: Refusing to overwrite an existing proxy export file without --force."
        `);
          expect(`\n${overwriteFileContents}`).toMatchInlineSnapshot(`
          "
          socks5://alice:export-secret@sweden-gothenburg.proxy.example.com:1080
          "
        `);
          expect(`\n${normalizeOutput(regionsResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate region groups
          phase: inspect-config
          source: canonical-region-groups
          regions: 4

          1. americas
             countries: ag, ai, ar, aw, bb, bl, bm, bo, br, bs, bz, ca, cl, co, cr, cu, dm, do, ec, fk, gd, gl, gp, gt, gy, hn, ht, jm, kn, ky, lc, mf, mq, ms, mx, ni, pa, pe, pm, pr, py, sr, sv, tc, tt, us, uy, vc, ve, vg, vi
             example: mullgate config export --region americas --count 5

          2. asia-pacific
             countries: as, au, bd, bn, bt, cc, ck, cn, cx, fj, fm, gu, hk, id, in, jp, kh, ki, kp, kr, la, lk, mh, mm, mn, mo, mp, mv, my, nc, nf, np, nr, nu, nz, pg, ph, pk, pn, pw, sb, sg, th, tk, tl, to, tv, tw, vn, vu, wf, ws
             example: mullgate config export --region asia-pacific --count 5

          3. europe
             countries: ad, al, at, ba, be, bg, by, ch, cy, cz, de, dk, ee, es, fi, fo, fr, gb, gg, gi, gr, hr, hu, ie, im, is, it, je, li, lt, lu, lv, mc, md, me, mk, mt, nl, no, pl, pt, ro, rs, se, si, sj, sk, sm, ua, va
             example: mullgate config export --region europe --count 5

          4. middle-east-africa
             countries: ae, am, ao, az, bf, bi, bj, bw, cd, cf, cg, ci, cm, cv, dj, dz, eg, eh, er, et, ga, ge, gh, gm, gn, gq, gw, il, iq, ir, jo, ke, km, kw, lb, lr, ls, ly, ma, mg, ml, mr, mu, mw, mz, na, ne, ng, om, qa, re, rw, sa, sc, sd, sh, sl, sn, so, ss, st, sz, td, tg, tn, tr, tz, ug, ye, yt, za, zm, zw
             example: mullgate config export --region middle-east-africa --count 5"
        `);
          expect(guidedResult.stderr).toContain('Mullgate proxy export');
          expect(`\n${normalizeOutput(guidedResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate proxy export complete.
          phase: export-proxies
          source: canonical-config
          config: /tmp/mullgate-home/config/mullgate/config.json
          protocol: socks5
          write mode: file
          selectors: 2
          1. country=se requested=1 matched=1 exported=1
          2. region=europe requested=2 matched=1 exported=1
          exported count: 2
          output: proxies.txt"
        `);
          expect(`\n${guidedFileContents}`).toMatchInlineSnapshot(`
          "
          socks5://alice:export-secret@sweden-gothenburg.proxy.example.com:1080
          socks5://alice:export-secret@austria-vienna.proxy.example.com:1080
          "
        `);
        },
      );
    },
  );

  it('fails clearly on invalid non-loopback bind ip input before provisioning', async () => {
    const env = createTempEnvironment();

    const setupResult = await runCli(
      [
        'setup',
        '--non-interactive',
        '--exposure-mode',
        'private-network',
        '--bind-host',
        '192.168.10.10',
        '--location',
        'sweden-gothenburg',
        '--location',
        'austria-vienna',
      ],
      {
        env: {
          ...env,
          MULLGATE_ACCOUNT_NUMBER: '123456789012',
          MULLGATE_PROXY_USERNAME: 'alice',
          MULLGATE_PROXY_PASSWORD: 'missing-bind-secret',
        },
      },
    );

    expect(setupResult.status).toBe(1);
    expect(setupResult.stdout).toBe('');
    expect(setupResult.stderr).not.toContain('123456789012');
    expect(setupResult.stderr).not.toContain('missing-bind-secret');
    expect(`\n${normalizeOutput(setupResult.stderr, env)}`).toMatchInlineSnapshot(`
"\nMullgate setup failed.
phase: setup-validation
source: input
code: BIND_IP_COUNT_MISMATCH
artifact: /tmp/mullgate-home/config/mullgate/config.json
reason: Non-loopback exposure requires one explicit bind IP per routed location (2 locations, 1 bind IPs).
config: /tmp/mullgate-home/config/mullgate/config.json
cause: Repeat --route-bind-ip for each route or set MULLGATE_ROUTE_BIND_IPS to a comma-separated ordered list."
`);
  });

  it('reports route-aware provisioning failures without leaking secrets', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(env.HOME!);

    const provisionFixture = JSON.parse(
      await readTextFixture('wg-provision-response.txt'),
    ) as Record<string, unknown>;
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
              body: JSON.stringify({
                detail: `account 123456789012 for ${payload.name ?? 'missing-device'} failed upstream`,
              }),
            };
          }

          return {
            body: JSON.stringify({
              ...provisionFixture,
              id: `device-${provisionCount}`,
              pubkey: payload.pubkey,
              name: payload.name ?? `mullgate-route-${provisionCount}`,
              ipv4_address: '10.64.12.34/32',
            }),
          };
        },
        '/relays': () => ({
          body: JSON.stringify(relayFixture),
        }),
      },
      async (baseUrl) => {
        const setupResult = await runCli(
          [
            'setup',
            '--non-interactive',
            '--device-name',
            'mullgate-lab',
            '--location',
            'sweden-gothenburg',
            '--location',
            'austria-vienna',
            '--mullvad-wg-url',
            new URL('/wg', baseUrl).toString(),
            '--mullvad-relays-url',
            new URL('/relays', baseUrl).toString(),
          ],
          {
            env: {
              ...env,
              MULLGATE_ACCOUNT_NUMBER: '123456789012',
              MULLGATE_PROXY_USERNAME: 'alice',
              MULLGATE_PROXY_PASSWORD: 'route-2-secret',
            },
          },
        );

        expect(setupResult.status).toBe(1);
        expect(setupResult.stdout).toBe('');
        expect(setupResult.stderr).not.toContain('123456789012');
        expect(setupResult.stderr).not.toContain('route-2-secret');
        const normalizedFailure = normalizeOutput(setupResult.stderr, env).replace(
          baseUrl.origin,
          'http://127.0.0.1:PORT',
        );
        expect(`\n${normalizedFailure}`).toMatchInlineSnapshot(`
"\nMullgate setup failed.
phase: wireguard-provision
source: mullvad-wg-endpoint
code: HTTP_ERROR
route: 2
route alias: austria-vienna
requested alias: austria-vienna
hostname: austria-vienna
bind ip: 127.0.0.2
device: mullgate-lab-austria-vienna
endpoint: http://127.0.0.1:PORT/wg
reason: Provisioning failed for routed location austria-vienna (austria-vienna -> 127.0.0.2).
config: /tmp/mullgate-home/config/mullgate/config.json
cause: account [redacted-account] for mullgate-lab-austria-vienna failed upstream"
`);
      },
    );
  });

  it('updates saved config values safely and refreshes derived artifacts on validate', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(env.HOME!);

    const provisionFixture = await readTextFixture('wg-provision-response.txt');
    const relayFixture = await readJsonFixture<unknown>('app-relays.json');
    const paths = resolveMullgatePaths(env);

    await withJsonServer(
      {
        '/wg': (request) => {
          const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };
          return {
            body: JSON.stringify({
              ...JSON.parse(provisionFixture),
              pubkey: payload.pubkey,
              name: payload.name ?? 'mullgate-test-host',
            }),
          };
        },
        '/relays': () => ({ body: JSON.stringify(relayFixture) }),
      },
      async (baseUrl) => {
        const setupResult = await runCli(
          [
            'setup',
            '--non-interactive',
            '--mullvad-wg-url',
            new URL('/wg', baseUrl).toString(),
            '--mullvad-relays-url',
            new URL('/relays', baseUrl).toString(),
          ],
          {
            env: {
              ...env,
              MULLGATE_ACCOUNT_NUMBER: '123456789012',
              MULLGATE_PROXY_USERNAME: 'alice',
              MULLGATE_PROXY_PASSWORD: 'initial-password',
              MULLGATE_LOCATION: 'sweden-gothenburg',
            },
          },
        );

        expect(setupResult.status).toBe(0);

        const setPasswordResult = await runCli(
          ['config', 'set', 'setup.auth.password', '--stdin'],
          {
            env,
            input: 'rotated-password\n',
          },
        );
        const setPortResult = await runCli(['config', 'set', 'setup.bind.httpPort', '9091'], {
          env,
        });
        const getPasswordResult = await runCli(['config', 'get', 'setup.auth.password'], { env });
        const getPortResult = await runCli(['config', 'get', 'setup.bind.httpPort'], { env });
        const validateResult = await runCli(['config', 'validate'], { env });

        expect(setPasswordResult.status).toBe(0);
        expect(setPasswordResult.stdout).not.toContain('rotated-password');
        expect(setPortResult.status).toBe(0);
        expect(getPasswordResult.stdout.trim()).toBe('[redacted]');
        expect(getPortResult.stdout.trim()).toBe('9091');
        expect(validateResult.status).toBe(0);
        expect(`\n${normalizeOutput(setPasswordResult.stdout, env)}`).toMatchInlineSnapshot(`
"\nMullgate config updated.
phase: persist-config
source: input
key: setup.auth.password
config: /tmp/mullgate-home/config/mullgate/config.json
value: [redacted]
runtime status: unvalidated"
`);
        expect(`\n${normalizeOutput(validateResult.stdout, env)}`).toMatchInlineSnapshot(`
"\nMullgate config validated.
phase: validation
source: wireproxy-binary
artifact: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
report: /tmp/mullgate-home/state/mullgate/runtime/wireproxy-configtest.json
artifacts refreshed: yes
runtime status: validated
reason: Validated via wireproxy-binary/configtest."
`);

        const renderedWireproxyConfig = await readFile(paths.wireproxyConfigFile, 'utf8');
        expect(renderedWireproxyConfig).toContain('BindAddress = 127.0.0.1:9091');
        expect(renderedWireproxyConfig).toContain('Password = rotated-password');
      },
    );
  }, 20000);

  it('reports corrupted rendered artifacts with phase, source, and secret-safe diagnostics', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(env.HOME!);

    const provisionFixture = await readTextFixture('wg-provision-response.txt');
    const relayFixture = await readJsonFixture<unknown>('app-relays.json');
    const paths = resolveMullgatePaths(env);

    await withJsonServer(
      {
        '/wg': (request) => {
          const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };
          return {
            body: JSON.stringify({
              ...JSON.parse(provisionFixture),
              pubkey: payload.pubkey,
              name: payload.name ?? 'mullgate-test-host',
            }),
          };
        },
        '/relays': () => ({ body: JSON.stringify(relayFixture) }),
      },
      async (baseUrl) => {
        const setupResult = await runCli(
          [
            'setup',
            '--non-interactive',
            '--mullvad-wg-url',
            new URL('/wg', baseUrl).toString(),
            '--mullvad-relays-url',
            new URL('/relays', baseUrl).toString(),
          ],
          {
            env: {
              ...env,
              MULLGATE_ACCOUNT_NUMBER: '123456789012',
              MULLGATE_PROXY_USERNAME: 'alice',
              MULLGATE_PROXY_PASSWORD: 'failure-secret',
              MULLGATE_LOCATION: 'sweden-gothenburg',
            },
          },
        );

        expect(setupResult.status).toBe(0);

        await writeFile(paths.wireproxyConfigFile, '[Interface]\nPrivateKey = broken\n', 'utf8');
        const validateResult = await runCli(['config', 'validate'], { env });

        expect(validateResult.status).toBe(1);
        expect(validateResult.stdout).toBe('');
        expect(validateResult.stderr).not.toContain('failure-secret');
        expect(validateResult.stderr).not.toContain('123456789012');
        expect(`\n${normalizeOutput(validateResult.stderr, env)}`).toMatchInlineSnapshot(`
"\nMullgate config validation failed.
phase: validation
source: wireproxy-binary
artifact: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
reason: fake wireproxy configtest: invalid rendered config at /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
cause: fake wireproxy configtest: invalid rendered config at /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf"
`);
      },
    );
  });

  it('explains the missing-config validate failure from a clean XDG home', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(env.HOME!);

    const result = await runCli(['config', 'validate'], { env });

    expect(result.status).toBe(1);
    expect(`\n${normalizeOutput(result.stderr, env)}`).toMatchInlineSnapshot(`
"\nMullgate config validation failed.
phase: load-config
source: empty
artifact: /tmp/mullgate-home/config/mullgate/config.json
reason: Mullgate is not configured yet. Run \`mullgate setup\` to create /tmp/mullgate-home/config/mullgate/config.json."
`);
  });
});
