import { chmodSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveMullgatePaths } from '../src/config/paths.js';
import type { MullgateConfig } from '../src/config/schema.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const fixturesDir = path.join(repoRoot, 'test/fixtures/mullvad');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
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
  const binDir = path.join(root, 'bin');
  temporaryDirectories.push(root);

  return {
    ...process.env,
    HOME: root,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
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

async function createFakeWireproxyBinary(env: NodeJS.ProcessEnv): Promise<void> {
  const binDir = env.PATH!.split(path.delimiter)[0]!;
  await mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'wireproxy');
  await writeFile(
    scriptPath,
    [
      '#!/bin/sh',
      'if [ "$1" != "--configtest" ]; then',
      '  echo "unsupported fake wireproxy invocation" >&2',
      '  exit 1',
      'fi',
      'config="$2"',
      'if grep -q "^Address = " "$config" && grep -q "^\\[Peer\\]" "$config" && grep -q "^\\[Socks5\\]" "$config" && grep -q "^\\[http\\]" "$config"; then',
      '  exit 0',
      'fi',
      'echo "fake wireproxy configtest: invalid rendered config at $config" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(scriptPath, 0o755);
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
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
  return value.split(env.HOME!).join('/tmp/mullgate-home').trimEnd();
}

function coerceProcessOutput(value: string | NodeJS.ArrayBufferView | null): string {
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
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('mullgate setup CLI flow', () => {
  it('completes setup from a clean XDG home and exposes redacted config inspection surfaces', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(env);

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
        expect('\n' + normalizeOutput(setupResult.stdout, env)).toMatchInlineSnapshot(`
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
          routes: 1
          1. sweden-gothenburg
             hostname: sweden-gothenburg
             bind ip: 127.0.0.1
             device: mullgate-single
             tunnel ipv4: 10.64.12.34/32
          relay: se-got-wg-101
          validation: wireproxy-binary/configtest"
        `);

        const [pathResult, showResult, locationsResult, hostsResult, getPasswordResult, getLocationResult, validateResult] = await Promise.all([
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
        expect('\n' + normalizeOutput(pathResult.stdout, env)).toMatchInlineSnapshot(`
          "
          Mullgate path report
          phase: resolve-paths
          source: xdg
          config file: /tmp/mullgate-home/config/mullgate/config.json (present)
          state dir: /tmp/mullgate-home/state/mullgate
          cache dir: /tmp/mullgate-home/cache/mullgate
          wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
          wireproxy configtest report: /tmp/mullgate-home/state/mullgate/runtime/wireproxy-configtest.json
          docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
          relay cache: /tmp/mullgate-home/cache/mullgate/relays.json (present)"
        `);
        expect('\n' + normalizeOutput(locationsResult.stdout, env)).toMatchInlineSnapshot(`
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
        expect('\n' + normalizeOutput(hostsResult.stdout, env)).toMatchInlineSnapshot(`
"\nMullgate routed hosts
phase: inspect-config
source: canonical-config
config: /tmp/mullgate-home/config/mullgate/config.json
hostname -> bind ip
1. sweden-gothenburg -> 127.0.0.1 (alias: sweden-gothenburg, route id: sweden-gothenburg)"
`);
        expect('\n' + normalizeOutput(validateResult.stdout, env)).toMatchInlineSnapshot(`
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
  });

  it('saves two routed locations from the real CLI flow with deterministic route metadata', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(env);

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
        expect(provisionedNames).toEqual(['mullgate-lab-sweden-gothenburg', 'mullgate-lab-austria-vienna']);
        expect('\n' + normalizeOutput(setupResult.stdout, env)).toMatchInlineSnapshot(`
"\nMullgate setup completed.
phase: setup-complete
source: guided-setup
config: /tmp/mullgate-home/config/mullgate/config.json
wireproxy config: /tmp/mullgate-home/state/mullgate/runtime/wireproxy.conf
relay cache: /tmp/mullgate-home/cache/mullgate/relays.json
docker compose: /tmp/mullgate-home/state/mullgate/runtime/docker-compose.yml
validation report: /tmp/mullgate-home/state/mullgate/runtime/wireproxy-configtest.json
location: sweden-gothenburg
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
        expect(savedConfig.routing.locations.map((location) => ({
          alias: location.alias,
          hostname: location.hostname,
          bindIp: location.bindIp,
          deviceName: location.mullvad.deviceName,
          ipv4Address: location.mullvad.wireguard.ipv4Address,
        }))).toEqual([
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
        expect(savedConfig.routing.locations[0]!.mullvad.wireguard.publicKey).not.toBe(
          savedConfig.routing.locations[1]!.mullvad.wireguard.publicKey,
        );
        expect(savedConfig.mullvad.deviceName).toBe('mullgate-lab-sweden-gothenburg');
        expect(savedConfig.setup.location.requested).toBe('sweden-gothenburg');
        expect(savedConfig.setup.location.resolvedAlias).toBe('sweden-gothenburg');
        expect('\n' + normalizeOutput(locationsResult.stdout, env)).toMatchInlineSnapshot(`
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
        expect('\n' + normalizeOutput(hostsResult.stdout, env)).toMatchInlineSnapshot(`
"\nMullgate routed hosts
phase: inspect-config
source: canonical-config
config: /tmp/mullgate-home/config/mullgate/config.json
hostname -> bind ip
1. sweden-gothenburg -> 127.0.0.1 (alias: sweden-gothenburg, route id: sweden-gothenburg)
2. austria-vienna -> 127.0.0.2 (alias: austria-vienna, route id: austria-vienna)"
`);
      },
    );
  });

  it('reports route-aware provisioning failures without leaking secrets', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(env);

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
        const normalizedFailure = normalizeOutput(setupResult.stderr, env).replace(baseUrl.origin, 'http://127.0.0.1:PORT');
        expect('\n' + normalizedFailure).toMatchInlineSnapshot(`
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
    await createFakeWireproxyBinary(env);

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
          ['setup', '--non-interactive', '--mullvad-wg-url', new URL('/wg', baseUrl).toString(), '--mullvad-relays-url', new URL('/relays', baseUrl).toString()],
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

        const setPasswordResult = await runCli(['config', 'set', 'setup.auth.password', '--stdin'], {
          env,
          input: 'rotated-password\n',
        });
        const setPortResult = await runCli(['config', 'set', 'setup.bind.httpPort', '9091'], { env });
        const getPasswordResult = await runCli(['config', 'get', 'setup.auth.password'], { env });
        const getPortResult = await runCli(['config', 'get', 'setup.bind.httpPort'], { env });
        const validateResult = await runCli(['config', 'validate'], { env });

        expect(setPasswordResult.status).toBe(0);
        expect(setPasswordResult.stdout).not.toContain('rotated-password');
        expect(setPortResult.status).toBe(0);
        expect(getPasswordResult.stdout.trim()).toBe('[redacted]');
        expect(getPortResult.stdout.trim()).toBe('9091');
        expect(validateResult.status).toBe(0);
        expect('\n' + normalizeOutput(setPasswordResult.stdout, env)).toMatchInlineSnapshot(`
"\nMullgate config updated.
phase: persist-config
source: input
key: setup.auth.password
config: /tmp/mullgate-home/config/mullgate/config.json
value: [redacted]
runtime status: unvalidated"
`);
        expect('\n' + normalizeOutput(validateResult.stdout, env)).toMatchInlineSnapshot(`
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
        expect(renderedWireproxyConfig).toContain('BindAddress = 0.0.0.0:9091');
        expect(renderedWireproxyConfig).toContain('Password = rotated-password');
      },
    );
  },
  20000,
  );

  it('reports corrupted rendered artifacts with phase, source, and secret-safe diagnostics', async () => {
    const env = createTempEnvironment();
    await createFakeWireproxyBinary(env);

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
          ['setup', '--non-interactive', '--mullvad-wg-url', new URL('/wg', baseUrl).toString(), '--mullvad-relays-url', new URL('/relays', baseUrl).toString()],
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
        expect('\n' + normalizeOutput(validateResult.stderr, env)).toMatchInlineSnapshot(`
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
    await createFakeWireproxyBinary(env);

    const result = await runCli(['config', 'validate'], { env });

    expect(result.status).toBe(1);
    expect('\n' + normalizeOutput(result.stderr, env)).toMatchInlineSnapshot(`
"\nMullgate config validation failed.
phase: load-config
source: empty
artifact: /tmp/mullgate-home/config/mullgate/config.json
reason: Mullgate is not configured yet. Run \`mullgate setup\` to create /tmp/mullgate-home/config/mullgate/config.json."
`);
  });
});
