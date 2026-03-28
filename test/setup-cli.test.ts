import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveMullgatePaths } from '../src/config/paths.js';
import type { MullgateConfig } from '../src/config/schema.js';
import type { MullvadRelayCatalog } from '../src/mullvad/fetch-relays.js';
import { requireDefined } from '../src/required.js';
import { createFixtureRoute } from './helpers/mullgate-fixtures.js';
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

function requireHome(env: NodeJS.ProcessEnv): string {
  return requireDefined(env.HOME, 'Expected HOME in the test env.');
}

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-setup-cli-'));
  const linuxRoot = root.replaceAll('\\', '/');
  const binDir = `${linuxRoot}/bin`;
  const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
  const mergedPath = `${binDir}${path.delimiter}${inheritedPath}`;
  temporaryDirectories.push(root);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: linuxRoot,
    PATH: mergedPath,
    XDG_CONFIG_HOME: `${linuxRoot}/config`,
    XDG_STATE_HOME: `${linuxRoot}/state`,
    XDG_CACHE_HOME: `${linuxRoot}/cache`,
  };

  if (process.platform === 'win32') {
    // Windows child-process env lookup is case-insensitive, so keep both spellings aligned.
    env.Path = mergedPath;
  }

  return env;
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
  const templateRoute = structuredClone(
    requireDefined(config.routing.locations[0], 'Expected at least one routed location in config.'),
  );
  const createRoute = (input: {
    alias: string;
    hostname: string;
    bindIp: string;
    country: string;
    city: string;
    hostnameLabel: string;
  }): MullgateConfig['routing']['locations'][number] => ({
    ...structuredClone(templateRoute),
    ...createFixtureRoute({
      alias: input.alias,
      hostname: input.hostname,
      bindIp: input.bindIp,
      requested: input.alias,
      country: input.country,
      city: input.city,
      hostnameLabel: input.hostnameLabel,
      resolvedAlias: input.alias,
      providers: templateRoute.mullvad.relayConstraints.providers,
      exit: {
        relayHostname: input.hostnameLabel,
        relayFqdn: `${input.hostnameLabel}.relays.mullvad.net`,
        socksHostname: `${input.hostnameLabel}-socks.relays.mullvad.net`,
      },
    }),
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
        }),
        createRoute({
          alias: 'austria-vienna',
          hostname: 'austria-vienna.proxy.example.com',
          bindIp: '192.168.10.11',
          country: 'at',
          city: 'vie',
          hostnameLabel: 'at-vie-wg-001',
        }),
        createRoute({
          alias: 'usa-new-york',
          hostname: 'usa-new-york.proxy.example.com',
          bindIp: '192.168.10.12',
          country: 'us',
          city: 'nyc',
          hostnameLabel: 'us-nyc-wg-001',
        }),
      ],
    },
  };
}

function createProxyExportFixtureRelayCatalog(): MullvadRelayCatalog {
  return {
    source: 'www-relays-all',
    fetchedAt: '2026-03-24T00:00:00.000Z',
    endpoint: 'https://api.mullvad.net/public/relays/wireguard/v1/',
    relayCount: 3,
    countries: [
      {
        code: 'se',
        name: 'Sweden',
        cities: [{ code: 'got', name: 'Gothenburg', relayCount: 1 }],
      },
      {
        code: 'at',
        name: 'Austria',
        cities: [{ code: 'vie', name: 'Vienna', relayCount: 1 }],
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
  return normalizeValidationSource(normalizeFixtureHomePath(value, env.HOME)).trimEnd();
}

function normalizeValidationSource(value: string): string {
  return value.replaceAll('internal-3proxy-syntax', 'docker/3proxy-startup');
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
    'completes setup from a clean XDG home and exposes direct config inspection surfaces',
    { timeout: 20000 },
    async () => {
      const env = createTempEnvironment();
      await createFakeWireproxyBinary(requireHome(env));

      const provisionFixture = await readTextFixture('wg-provision-response.txt');
      const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');

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
            entry wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf
            route proxy config: /tmp/mullgate-home/state/mullgate/runtime/route-proxy.cfg
            relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
            docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
            validation report: /tmp/mullgate-home/state/mullgate/runtime/runtime-validation.json
            entry relay: se-got-wg-101
            shared device: mullgate-single
            location: sweden-gothenburg
            exposure: loopback
            base domain: n/a
            routes: 1
            1. sweden-gothenburg
               hostname: sweden-gothenburg
               bind ip: 127.0.0.1
               exit relay: se-got-wg-101
               exit socks: se-got-wg-socks5-101.relays.mullvad.net:1080
            tunnel ipv4: 10.64.12.34/32
            validation: wireproxy-binary/configtest + docker/3proxy-startup"
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
            runCli(['proxy', 'list'], { env }),
            runCli(['proxy', 'access'], { env }),
            runCli(['config', 'get', 'setup.auth.password'], { env }),
            runCli(['config', 'get', 'setup.location.requested'], { env }),
            runCli(['proxy', 'validate'], { env }),
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
          expect(getPasswordResult.stdout.trim()).toBe('top-secret-password');
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
            host networking summary: Docker host networking behaves as expected on Linux, so the routing layer and shared route-proxy listeners can bind directly to the saved route IPs.
            config home: /tmp/mullgate-home/config (env:XDG_CONFIG_HOME)
            state home: /tmp/mullgate-home/state (env:XDG_STATE_HOME)
            cache home: /tmp/mullgate-home/cache (env:XDG_CACHE_HOME)
            config file: /tmp/mullgate-home/config/mullgate/config.json (present)
            state dir: /tmp/mullgate-home/state/mullgate
            cache dir: /tmp/mullgate-home/cache/mullgate
            runtime dir: /tmp/mullgate-home/state/mullgate/runtime (present)
            entry wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf
            route proxy config: /tmp/mullgate-home/state/mullgate/runtime/route-proxy.cfg
            runtime validation report: /tmp/mullgate-home/state/mullgate/runtime/runtime-validation.json
            docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
            relay cache: /tmp/mullgate-home/cache/mullgate/relays.json (present)

            platform guidance
            - Linux is the reference runtime target for the current Mullgate topology and verification flow.
            - Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.

            platform warnings
            - none"
          `);
          expect(`\n${normalizeOutput(locationsResult.stdout, env)}`).toMatchInlineSnapshot(`
            "
            Mullgate routed locations
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
               exit relay: se-got-wg-101
               exit socks: se-got-wg-socks5-101.relays.mullvad.net:1080
               route id: sweden-gothenburg
               https backend: route-sweden-gothenburg"
          `);
          expect(`\n${normalizeOutput(hostsResult.stdout, env)}`).toMatchInlineSnapshot(`
            "
            Mullgate exposure report
            phase: inspect-config
            source: canonical-config
            config: /tmp/mullgate-home/config/mullgate/config.json
            mode: loopback
            mode label: Loopback / local-only
            recommendation: local-default
            posture summary: Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.
            remote story: Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.
            base domain: n/a
            allow lan: no
            runtime status: validated
            restart needed: no
            runtime message: Validated via wireproxy-binary/configtest + docker/3proxy-startup.

            guidance
            - Loopback mode is the default local-only posture. Keep it for same-machine use and developer/operator checks.
            - Use \`mullgate proxy access\` if you want a copy/paste /etc/hosts block for this machine.

            remediation
            - bind posture: Keep loopback mode on local-only bind IPs. If you need remote access, rerun \`mullgate exposure --mode private-network ...\` with one trusted-network bind IP per route.
            - hostname resolution: For local host-file testing, use \`mullgate proxy access\` and apply the emitted block on this machine so each route hostname resolves to its saved loopback bind IP.
            - restart: After changing exposure settings, rerun \`mullgate proxy validate\` or \`mullgate proxy start\` so the runtime artifacts match the saved local-only posture.

            routes
            1. sweden-gothenburg -> 127.0.0.1
               alias: sweden-gothenburg
               route id: sweden-gothenburg
               dns: not required; use direct bind IP entrypoints
               socks5 hostname: socks5://[redacted]:[redacted]@sweden-gothenburg:1080
               socks5 direct ip: socks5://[redacted]:[redacted]@127.0.0.1:1080
               http hostname: http://[redacted]:[redacted]@sweden-gothenburg:8080
               http direct ip: http://[redacted]:[redacted]@127.0.0.1:8080

            warnings
            - info: Loopback mode is local-only. Keep using \`mullgate proxy access\` for host-file testing on this machine.

            local host-file mapping
            - \`mullgate proxy access\` remains the copy/paste /etc/hosts view for local-only testing.

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
            "
            Mullgate validate complete.
            phase: validation
            source: validation-suite
            artifact: /tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf
            report: /tmp/mullgate-home/state/mullgate/runtime/runtime-validation.json
            artifacts refreshed: no
            runtime status: validated
            reason: Validated via wireproxy-binary/configtest + docker/3proxy-startup."
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
      await createFakeWireproxyBinary(requireHome(env));

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
          expect(provisionedNames).toEqual(['mullgate-lab']);
          expect(`\n${normalizeOutput(setupResult.stdout, env)}`).toMatchInlineSnapshot(`
            "
            Mullgate setup completed.
            phase: setup-complete
            source: guided-setup
            config: /tmp/mullgate-home/config/mullgate/config.json
            entry wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf
            route proxy config: /tmp/mullgate-home/state/mullgate/runtime/route-proxy.cfg
            relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
            docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
            validation report: /tmp/mullgate-home/state/mullgate/runtime/runtime-validation.json
            entry relay: se-got-wg-101
            shared device: mullgate-lab
            location: sweden-gothenburg
            exposure: loopback
            base domain: n/a
            routes: 2
            1. sweden-gothenburg
               hostname: sweden-gothenburg
               bind ip: 127.0.0.1
               exit relay: se-got-wg-101
               exit socks: se-got-wg-socks5-101.relays.mullvad.net:1080
            2. austria-vienna
               hostname: austria-vienna
               bind ip: 127.0.0.2
               exit relay: at-vie-wg-001
               exit socks: at-vie-wg-socks5-001.relays.mullvad.net:1080
            tunnel ipv4: 10.64.12.34/32
            validation: wireproxy-binary/configtest + docker/3proxy-startup"
          `);

          const savedConfig = await readSavedConfig(env);
          const [locationsResult, hostsResult] = await Promise.all([
            runCli(['proxy', 'list'], { env }),
            runCli(['proxy', 'access'], { env }),
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
              exitRelayHostname: location.mullvad.exit.relayHostname,
            })),
          ).toEqual([
            {
              alias: 'sweden-gothenburg',
              hostname: 'sweden-gothenburg',
              bindIp: '127.0.0.1',
              exitRelayHostname: 'se-got-wg-101',
            },
            {
              alias: 'austria-vienna',
              hostname: 'austria-vienna',
              bindIp: '127.0.0.2',
              exitRelayHostname: 'at-vie-wg-001',
            },
          ]);
          expect(savedConfig.mullvad.wireguard.publicKey).toBeTruthy();
          expect(savedConfig.mullvad.deviceName).toBe('mullgate-lab');
          expect(savedConfig.setup.location.requested).toBe('sweden-gothenburg');
          expect(savedConfig.setup.location.resolvedAlias).toBe('sweden-gothenburg');
          expect(`\n${normalizeOutput(locationsResult.stdout, env)}`).toMatchInlineSnapshot(`
            "
            Mullgate routed locations
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
               exit relay: se-got-wg-101
               exit socks: se-got-wg-socks5-101.relays.mullvad.net:1080
               route id: sweden-gothenburg
               https backend: route-sweden-gothenburg

            2. austria-vienna
               hostname: austria-vienna
               bind ip: 127.0.0.2
               requested: austria-vienna
               resolved alias: austria-vienna
               country: at
               city: vie
               exit relay: at-vie-wg-001
               exit socks: at-vie-wg-socks5-001.relays.mullvad.net:1080
               route id: austria-vienna
               https backend: route-austria-vienna"
          `);
          expect(`\n${normalizeOutput(hostsResult.stdout, env)}`).toMatchInlineSnapshot(`
            "
            Mullgate exposure report
            phase: inspect-config
            source: canonical-config
            config: /tmp/mullgate-home/config/mullgate/config.json
            mode: loopback
            mode label: Loopback / local-only
            recommendation: local-default
            posture summary: Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.
            remote story: Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.
            base domain: n/a
            allow lan: no
            runtime status: validated
            restart needed: no
            runtime message: Validated via wireproxy-binary/configtest + docker/3proxy-startup.

            guidance
            - Loopback mode is the default local-only posture. Keep it for same-machine use and developer/operator checks.
            - Use \`mullgate proxy access\` if you want a copy/paste /etc/hosts block for this machine.

            remediation
            - bind posture: Keep loopback mode on local-only bind IPs. If you need remote access, rerun \`mullgate exposure --mode private-network ...\` with one trusted-network bind IP per route.
            - hostname resolution: For local host-file testing, use \`mullgate proxy access\` and apply the emitted block on this machine so each route hostname resolves to its saved loopback bind IP.
            - restart: After changing exposure settings, rerun \`mullgate proxy validate\` or \`mullgate proxy start\` so the runtime artifacts match the saved local-only posture.

            routes
            1. sweden-gothenburg -> 127.0.0.1
               alias: sweden-gothenburg
               route id: sweden-gothenburg
               dns: not required; use direct bind IP entrypoints
               socks5 hostname: socks5://[redacted]:[redacted]@sweden-gothenburg:1080
               socks5 direct ip: socks5://[redacted]:[redacted]@127.0.0.1:1080
               http hostname: http://[redacted]:[redacted]@sweden-gothenburg:8080
               http direct ip: http://[redacted]:[redacted]@127.0.0.1:8080
            2. austria-vienna -> 127.0.0.2
               alias: austria-vienna
               route id: austria-vienna
               dns: not required; use direct bind IP entrypoints
               socks5 hostname: socks5://[redacted]:[redacted]@austria-vienna:1080
               socks5 direct ip: socks5://[redacted]:[redacted]@127.0.0.2:1080
               http hostname: http://[redacted]:[redacted]@austria-vienna:8080
               http direct ip: http://[redacted]:[redacted]@127.0.0.2:8080

            warnings
            - info: Loopback mode is local-only. Keep using \`mullgate proxy access\` for host-file testing on this machine.

            local host-file mapping
            - \`mullgate proxy access\` remains the copy/paste /etc/hosts view for local-only testing.

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
      await createFakeWireproxyBinary(requireHome(env));

      const provisionFixture = JSON.parse(
        await readTextFixture('wg-provision-response.txt'),
      ) as Record<string, unknown>;
      const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');
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
            "
            Mullgate setup completed.
            phase: setup-complete
            source: guided-setup
            config: /tmp/mullgate-home/config/mullgate/config.json
            entry wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf
            route proxy config: /tmp/mullgate-home/state/mullgate/runtime/route-proxy.cfg
            relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
            docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
            validation report: /tmp/mullgate-home/state/mullgate/runtime/runtime-validation.json
            entry relay: se-got-wg-101
            shared device: mullgate-domain
            location: sweden-gothenburg
            exposure: private-network
            base domain: proxy.example.com
            routes: 2
            1. sweden-gothenburg
               hostname: sweden-gothenburg.proxy.example.com
               bind ip: 192.168.10.10
               exit relay: se-got-wg-101
               exit socks: se-got-wg-socks5-101.relays.mullvad.net:1080
            2. austria-vienna
               hostname: austria-vienna.proxy.example.com
               bind ip: 192.168.10.11
               exit relay: at-vie-wg-001
               exit socks: at-vie-wg-socks5-001.relays.mullvad.net:1080
            tunnel ipv4: 10.64.22.21/32
            validation: wireproxy-binary/configtest + docker/3proxy-startup"
          `);

          const savedConfig = await readSavedConfig(env);
          const [showResult, hostsResult] = await Promise.all([
            runCli(['config', 'show'], { env }),
            runCli(['proxy', 'access'], { env }),
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
            runtime status: validated
            restart needed: no
            runtime message: Validated via wireproxy-binary/configtest + docker/3proxy-startup.

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
            2. austria-vienna.proxy.example.com -> 192.168.10.11
               alias: austria-vienna
               route id: austria-vienna
               dns: austria-vienna.proxy.example.com A 192.168.10.11
               socks5 hostname: socks5://[redacted]:[redacted]@austria-vienna.proxy.example.com:1080
               socks5 direct ip: socks5://[redacted]:[redacted]@192.168.10.11:1080
               http hostname: http://[redacted]:[redacted]@austria-vienna.proxy.example.com:8080
               http direct ip: http://[redacted]:[redacted]@192.168.10.11:8080

            warnings
            - info: Publish one DNS A record per route hostname and point it at the matching bind IP before expecting remote hostname access to work.

            local host-file mapping
            - \`mullgate proxy access\` remains the copy/paste /etc/hosts view for local-only testing.

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

  it('exports weighted proxy batches with full credentials', { timeout: 20000 }, async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(requireHome(env));

    const provisionFixture = await readTextFixture('wg-provision-response.txt');
    const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');
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
        await writeFile(
          paths.provisioningCacheFile,
          `${JSON.stringify(createProxyExportFixtureRelayCatalog(), null, 2)}\n`,
          'utf8',
        );

        const autoFilename = path.join(repoRoot, 'proxy-socks5-country-se-1--region-europe-2.txt');
        temporaryFiles.push(autoFilename);

        await rm(autoFilename, { force: true });

        const autoResult = await runCli(
          [
            'proxy',
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
        expect(autoResult.status).toBe(0);
        expect(autoResult.stderr).toBe('');

        const autoFileContents = await readFile(autoFilename, 'utf8');

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
      },
    );
  });

  it(
    'guides proxy export selection from numbered country, city, and server lists with full preview output',
    { timeout: 20000 },
    async () => {
      const env = createTempEnvironment();
      await createFakeWireproxyBinary(requireHome(env));

      const provisionFixture = await readTextFixture('wg-provision-response.txt');
      const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');
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
          await writeFile(
            paths.provisioningCacheFile,
            `${JSON.stringify(createProxyExportFixtureRelayCatalog(), null, 2)}\n`,
            'utf8',
          );

          const guidedResult = await runCli(
            ['proxy', 'export', '--guided', '--dry-run', '--protocol', 'http'],
            {
              env,
              input: 'y\n1\n\ny\n1\nn\ny\n1\nn\n',
            },
          );

          expect(guidedResult.status).toBe(0);
          expect(guidedResult.stdout).toContain('export-secret');
          expect(guidedResult.stderr).toContain('Country batches');
          expect(guidedResult.stderr).not.toContain(
            'Enter an option number or value from the list.',
          );
          expect(`\n${normalizeOutput(guidedResult.stdout, env)}`).toMatchInlineSnapshot(`
            "
            Mullgate proxy export preview.
            phase: export-proxies
            source: canonical-config
            config: /tmp/mullgate-home/config/mullgate/config.json
            protocol: http
            write mode: dry-run
            selectors: 1
            1. country=se city=got server=se-got-wg-101 requested=1 matched=1 exported=1
            exported count: 1
            output: ./proxy-http-country-se-got-se-got-wg-101-1.txt

            preview
            1. http://alice:export-secret@sweden-gothenburg.proxy.example.com:8080 (alias: sweden-gothenburg, country: se, city: got, relay: se-got-wg-101)"
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

  it('reports shared-device provisioning failures with the raw upstream details', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(requireHome(env));

    const provisionFixture = JSON.parse(
      await readTextFixture('wg-provision-response.txt'),
    ) as Record<string, unknown>;
    const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');
    let provisionCount = 0;

    await withJsonServer(
      {
        '/wg': (request) => {
          provisionCount += 1;
          const payload = parseFormBody(request.rawBody) as { pubkey: string; name?: string };

          if (provisionCount === 1) {
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
        expect(setupResult.stderr).not.toContain('route-2-secret');
        expect(setupResult.stderr).toContain('123456789012');
        const normalizedFailure = normalizeOutput(setupResult.stderr, env).replace(
          baseUrl.origin,
          'http://127.0.0.1:PORT',
        );
        expect(`\n${normalizedFailure}`).toMatchInlineSnapshot(`
          "
          Mullgate setup failed.
          phase: wireguard-provision
          source: mullvad-wg-endpoint
          code: HTTP_ERROR
          route: 1
          route alias: sweden-gothenburg
          requested alias: sweden-gothenburg
          hostname: sweden-gothenburg
          bind ip: 127.0.0.1
          device: mullgate-lab
          endpoint: http://127.0.0.1:PORT/wg
          reason: Provisioning failed for the shared Mullvad WireGuard device.
          config: /tmp/mullgate-home/config/mullgate/config.json
          cause: account 123456789012 for mullgate-lab failed upstream"
        `);
      },
    );
  });

  it('updates saved config values safely and refreshes derived artifacts on validate', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(requireHome(env));

    const provisionFixture = await readTextFixture('wg-provision-response.txt');
    const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');
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
        const validateResult = await runCli(['proxy', 'validate'], { env });

        expect(setPasswordResult.status).toBe(0);
        expect(setPasswordResult.stdout).not.toContain('rotated-password');
        expect(setPortResult.status).toBe(0);
        expect(getPasswordResult.stdout.trim()).toBe('rotated-password');
        expect(getPortResult.stdout.trim()).toBe('9091');
        expect(validateResult.status).toBe(0);
        expect(`\n${normalizeOutput(setPasswordResult.stdout, env)}`).toMatchInlineSnapshot(`
"\nMullgate config updated.
phase: persist-config
source: input
key: setup.auth.password
config: /tmp/mullgate-home/config/mullgate/config.json
value: stored without echoing it back to the terminal
runtime status: unvalidated"
`);
        expect(`\n${normalizeOutput(validateResult.stdout, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate validate complete.
          phase: validation
          source: validation-suite
          artifact: /tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf
          report: /tmp/mullgate-home/state/mullgate/runtime/runtime-validation.json
          artifacts refreshed: yes
          runtime status: validated
          reason: Validated via wireproxy-binary/configtest + docker/3proxy-startup."
        `);

        const renderedWireproxyConfig = await readFile(paths.entryWireproxyConfigFile, 'utf8');
        const renderedRouteProxyConfig = await readFile(paths.routeProxyConfigFile, 'utf8');
        expect(renderedWireproxyConfig).toContain('BindAddress = 127.0.0.1:39101');
        expect(renderedRouteProxyConfig).toContain('users alice:CL:rotated-password');
        expect(renderedRouteProxyConfig).toContain('proxy -p9091 -i127.0.0.1 -e127.0.0.1');
      },
    );
  }, 20000);

  it(
    'reports corrupted rendered artifacts with phase, source, and secret-safe diagnostics',
    { timeout: 20000 },
    async () => {
      const env = createTempEnvironment();
      await createFakeWireproxyBinary(requireHome(env));

      const provisionFixture = await readTextFixture('wg-provision-response.txt');
      const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');
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

          await writeFile(
            paths.entryWireproxyConfigFile,
            '[Interface]\nPrivateKey = broken\n',
            'utf8',
          );
          const validateResult = await runCli(['proxy', 'validate'], { env });

          expect(validateResult.status).toBe(1);
          expect(validateResult.stdout).toBe('');
          expect(validateResult.stderr).not.toContain('failure-secret');
          expect(validateResult.stderr).not.toContain('123456789012');
          expect(`\n${normalizeOutput(validateResult.stderr, env)}`).toMatchInlineSnapshot(`
          "
          Mullgate validate failed.
          phase: validation
          source: wireproxy-binary
          artifact: /tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf
          reason: fake wireproxy configtest: invalid rendered config at /tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf
          cause: fake wireproxy configtest: invalid rendered config at /tmp/mullgate-home/state/mullgate/runtime/entry-wireproxy.conf"
        `);
        },
      );
    },
  );

  it('explains the missing-config validate failure from a clean XDG home', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(requireHome(env));

    const result = await runCli(['proxy', 'validate'], { env });

    expect(result.status).toBe(1);
    expect(`\n${normalizeOutput(result.stderr, env)}`).toMatchInlineSnapshot(`
      "
      Mullgate validate failed.
      phase: load-config
      source: empty
      artifact: /tmp/mullgate-home/config/mullgate/config.json
      reason: Mullgate is not configured yet. Run \`mullgate setup\` to create /tmp/mullgate-home/config/mullgate/config.json."
    `);
  });
});
