#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import {
  createDemoEnvironment,
  createFakeDockerBinary,
  createFakeWireproxyBinary,
  runCli,
} from './demo-helpers.js';
import { demoRoutePool } from './generate-demo-route-pool.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const routeCount = 50;

async function main(): Promise<void> {
  const environment = await createDemoEnvironment();
  const server = await startRouteDemoServer();
  const selectedRoutes = demoRoutePool.slice(0, routeCount);

  try {
    await createFakeWireproxyBinary(environment.rootDir);
    await createFakeDockerBinary({
      rootDir: environment.rootDir,
      containers: [],
    });

    await seedFiftyRouteSetup({
      env: environment.env,
      serverBaseUrl: server.baseUrl,
      routes: selectedRoutes,
    });

    await seedPrivateNetworkAccess({
      env: environment.env,
      bindIps: buildBindIps(selectedRoutes.length),
    });

    await runDisplayedShellCommand({
      display:
        "mullgate proxy access | awk '/^hostname -> bind ip/{show=1; next} /^copy\\/paste hosts block/{exit} show && /^[0-9]+\\./ { print }'",
      command:
        "node node_modules/tsx/dist/cli.mjs src/cli.ts proxy access | awk '/^hostname -> bind ip/{show=1; next} /^copy\\/paste hosts block/{exit} show && /^[0-9]+\\./ { print }'",
      env: environment.env,
    });
  } finally {
    await server.close();
    await environment.cleanup();
  }
}

async function seedFiftyRouteSetup(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly serverBaseUrl: URL;
  readonly routes: readonly (typeof demoRoutePool)[number][];
}): Promise<void> {
  const result = await runCli({
    args: [
      'setup',
      '--non-interactive',
      '--device-name',
      'mullgate-demo-50-routes',
      '--mullvad-wg-url',
      new URL('/wg', input.serverBaseUrl).toString(),
      '--mullvad-relays-url',
      new URL('/relays', input.serverBaseUrl).toString(),
    ],
    env: {
      ...input.env,
      MULLGATE_ACCOUNT_NUMBER: '123456789012',
      MULLGATE_PROXY_USERNAME: 'alice',
      MULLGATE_PROXY_PASSWORD: 'demo-secret-password',
      MULLGATE_LOCATIONS: input.routes.map((route) => route.alias).join(','),
    },
  });

  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    ['Failed to seed 50-route setup.', result.stdout.trim(), result.stderr.trim()]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

async function seedPrivateNetworkAccess(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly bindIps: readonly string[];
}): Promise<void> {
  const args = [
    'proxy',
    'access',
    '--mode',
    'private-network',
    '--base-domain',
    'proxy.example.com',
    ...input.bindIps.flatMap((bindIp) => ['--route-bind-ip', bindIp]),
  ];

  const result = await runCli({
    args,
    env: input.env,
  });

  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    ['Failed to seed 50-route private-network access.', result.stdout.trim(), result.stderr.trim()]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

function buildBindIps(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    return `10.44.0.${index + 10}`;
  });
}

async function runDisplayedShellCommand(input: {
  readonly display: string;
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<void> {
  process.stdout.write('\u001Bc');
  process.stdout.write(`$ ${input.display}\n`);
  await wait(450);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['-lc', input.command], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: input.env,
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed: ${input.display}`));
    });
  });

  await wait(2_000);
}

async function startRouteDemoServer(): Promise<{
  readonly baseUrl: URL;
  close: () => Promise<void>;
}> {
  const provisionFixture = JSON.parse(
    await readFile(path.join(repoRoot, 'test/fixtures/mullvad/wg-provision-response.txt'), 'utf8'),
  ) as Record<string, unknown>;

  let provisionCount = 0;
  const relayPayload = buildRelayPayload();

  const server = createServer(async (request, response) => {
    const rawBody = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      request.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      request.on('error', reject);
    });

    if (request.url === '/wg') {
      provisionCount += 1;
      const params = new URLSearchParams(rawBody);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ...provisionFixture,
          id: `demo-device-${provisionCount}`,
          pubkey: params.get('pubkey'),
          name: params.get('name') ?? `mullgate-demo-${provisionCount}`,
          ipv4_address: `10.64.12.${33 + provisionCount}/32`,
        }),
      );
      return;
    }

    if (request.url === '/relays') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(relayPayload));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"detail":"not found"}');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind the 50-route demo server.');
  }

  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function buildRelayPayload(): readonly Record<string, unknown>[] {
  const countryCodes = new Map<string, string>();
  const cityCodes = new Map<string, string>();

  return demoRoutePool.slice(0, routeCount).map((route, index) => {
    const relayIndex = String(index + 1).padStart(3, '0');
    const countryCode = getOrCreateCode({
      map: countryCodes,
      key: route.countryName,
      prefix: 'c',
      index: countryCodes.size,
    });
    const cityCode = getOrCreateCode({
      map: cityCodes,
      key: `${route.countryName}:${route.cityName}`,
      prefix: 'r',
      index: cityCodes.size,
    });

    return {
      hostname: `demo-${relayIndex}-wg-001`,
      fqdn: `demo-${relayIndex}-wg-001.relays.mullvad.net`,
      type: 'wireguard',
      active: true,
      owned: true,
      provider: 'Mullvad',
      country_code: countryCode,
      country_name: route.countryName,
      city_code: cityCode,
      city_name: route.cityName,
      ipv4_addr_in: `146.70.${Math.floor(index / 200) + 20}.${(index % 200) + 10}`,
      ipv6_addr_in: null,
      pubkey: `${String(index + 1).padStart(2, '0')}`.repeat(22).slice(0, 44),
      multihop_port: 3543,
      socks_name: `demo-${relayIndex}-wg-socks5-001.relays.mullvad.net`,
      socks_port: 1080,
      network_port_speed: 10000,
      stboot: true,
      daita: false,
      status_messages: [],
    };
  });
}

function getOrCreateCode(input: {
  readonly map: Map<string, string>;
  readonly key: string;
  readonly prefix: string;
  readonly index: number;
}): string {
  const existing = input.map.get(input.key);

  if (existing) {
    return existing;
  }

  const next = `${input.prefix}${String(input.index + 10).padStart(2, '0')}`;
  input.map.set(input.key, next);
  return next;
}

function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

await main();
