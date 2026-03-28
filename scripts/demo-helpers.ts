import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveMullgatePaths } from '../src/config/paths.js';
import type { MullgateConfig, RuntimeStartDiagnostic } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import { renderRuntimeBundle } from '../src/runtime/render-runtime-bundle.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const fixtureDir = path.join(repoRoot, 'test/fixtures/mullvad');
const tsxCliPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const demoAccountNumber = '123456789012';
const demoUsername = 'alice';
const demoPassword = 'demo-secret-password';
const demoLocations = ['sweden-gothenburg', 'austria-vienna'] as const;

type JsonRequest = {
  readonly rawBody: string;
};

type JsonRouteHandler = (request: JsonRequest) => {
  readonly body: string;
  readonly status?: number;
};

type RunProcessOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdin?: 'inherit' | 'pipe';
  readonly stdio?: 'inherit' | 'pipe';
};

type RunProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type DemoEnvironment = {
  readonly env: NodeJS.ProcessEnv;
  readonly rootDir: string;
  cleanup: () => Promise<void>;
};

type FixtureServer = {
  readonly baseUrl: URL;
  close: () => Promise<void>;
};

type DockerContainerFixture = {
  readonly Name: string;
  readonly Service: string;
  readonly Project: string;
  readonly State: string;
  readonly Health: string | null;
  readonly Status: string | null;
  readonly ExitCode: number | null;
  readonly Publishers: readonly [];
};

type SetupSeedOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly serverBaseUrl: URL;
  readonly deviceName: string;
};

type ExposureSeedOptions = SetupSeedOptions & {
  readonly bindIps: readonly [string, string];
  readonly baseDomain?: string;
};

type RunningStatusSeedOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly attemptedAt: string;
};

export function getRepoRoot(): string {
  return repoRoot;
}

export async function createDemoEnvironment(): Promise<DemoEnvironment> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'mullgate-demo-'));
  const homeDir = rootDir.replaceAll('\\', '/');
  const binDir = path.join(homeDir, 'bin');

  await mkdir(binDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: homeDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    XDG_CONFIG_HOME: `${homeDir}/config`,
    XDG_STATE_HOME: `${homeDir}/state`,
    XDG_CACHE_HOME: `${homeDir}/cache`,
  };

  return {
    env,
    rootDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

export async function createFakeWireproxyBinary(rootDir: string): Promise<void> {
  const binDir = path.join(rootDir, 'bin');
  const scriptPath = path.join(binDir, 'fake-wireproxy.mjs');
  const launcherPath = path.join(binDir, 'wireproxy');

  await writeFile(
    scriptPath,
    [
      "import fs from 'node:fs';",
      '',
      'const args = process.argv.slice(2);',
      "const configFlagIndex = args.indexOf('--config');",
      "const legacyConfigtestIndex = args.indexOf('--configtest');",
      'const configPath =',
      '  configFlagIndex >= 0 && args[configFlagIndex + 1]',
      '    ? args[configFlagIndex + 1]',
      '    : legacyConfigtestIndex === 0 && args[1]',
      '      ? args[1]',
      '      : null;',
      '',
      "if (!args.includes('--configtest') || !configPath) {",
      "  console.error('unsupported fake wireproxy invocation');",
      '  process.exit(1);',
      '}',
      '',
      "const configText = fs.readFileSync(configPath, 'utf8');",
      'const isValid =',
      '  /^Address = /m.test(configText) &&',
      '  /^\\[Peer\\]$/m.test(configText) &&',
      '  /^\\[Socks5\\]$/m.test(configText) &&',
      '  /^\\[http\\]$/m.test(configText);',
      '',
      'if (isValid) {',
      '  process.exit(0);',
      '}',
      '',
      'console.error("fake wireproxy configtest: invalid rendered config at " + configPath);',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    launcherPath,
    ['#!/bin/sh', 'exec node "$(dirname "$0")/fake-wireproxy.mjs" "$@"', ''].join('\n'),
    'utf8',
  );

  fs.chmodSync(scriptPath, 0o755);
  fs.chmodSync(launcherPath, 0o755);
}

export async function createFakeDockerBinary(input: {
  readonly rootDir: string;
  readonly containers: readonly DockerContainerFixture[];
}): Promise<void> {
  const binDir = path.join(input.rootDir, 'bin');
  const scriptPath = path.join(binDir, 'fake-docker.mjs');
  const launcherPath = path.join(binDir, 'docker');

  await writeFile(
    scriptPath,
    [
      "import fs from 'node:fs';",
      '',
      'const args = process.argv.slice(2);',
      "const containers = JSON.parse(process.env.MULLGATE_DEMO_DOCKER_CONTAINERS ?? '[]');",
      '',
      "if (args[0] !== 'compose') {",
      '  if (',
      "    args[0] === 'run' &&",
      "    args[1] === '--rm' &&",
      "    args[2] === '-v' &&",
      "    typeof args[3] === 'string' &&",
      "    args[4] === 'tarampampam/3proxy:latest' &&",
      "    args[5] === '/bin/3proxy' &&",
      "    args[6] === '/etc/3proxy/3proxy.cfg'",
      '  ) {',
      "    const [hostConfigPath] = args[3].split(':');",
      "    const configText = fs.readFileSync(hostConfigPath, 'utf8');",
      '    const isValid =',
      '      /^auth strong$/m.test(configText) &&',
      '      /^users .+:CL:.+$/m.test(configText) &&',
      '      /^parent 1000 socks5\\+ 127\\.0\\.0\\.1 39101$/m.test(configText) &&',
      '      /^socks -p\\d+ -i.+ -e.+$/m.test(configText) &&',
      '      /^proxy -p\\d+ -i.+ -e.+$/m.test(configText);',
      '',
      '    if (isValid) {',
      "      console.log('3proxy startup ok');",
      '      process.exit(0);',
      '    }',
      '',
      "    console.error('fake 3proxy startup: invalid rendered config at ' + hostConfigPath);",
      '    process.exit(1);',
      '  }',
      '',
      "  console.error('unsupported fake docker invocation');",
      '  process.exit(1);',
      '}',
      '',
      "if (args.length === 2 && args[1] === 'version') {",
      "  console.log('Docker Compose version v2.39.1');",
      '  process.exit(0);',
      '}',
      '',
      "if (args.includes('ps') && args.includes('--format') && args.includes('json')) {",
      '  console.log(JSON.stringify(containers));',
      '  process.exit(0);',
      '}',
      '',
      "console.error('unsupported fake docker compose command: ' + args.join(' '));",
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    launcherPath,
    ['#!/bin/sh', 'exec node "$(dirname "$0")/fake-docker.mjs" "$@"', ''].join('\n'),
    'utf8',
  );

  fs.chmodSync(scriptPath, 0o755);
  fs.chmodSync(launcherPath, 0o755);
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const provisionFixture = JSON.parse(
    await readFile(path.join(fixtureDir, 'wg-provision-response.txt'), 'utf8'),
  ) as Record<string, unknown>;
  const relayFixture = await readFile(path.join(fixtureDir, 'www-relays-all.json'), 'utf8');
  let provisionCount = 0;

  const routes: Record<string, JsonRouteHandler> = {
    '/wg': ({ rawBody }) => {
      provisionCount += 1;
      const params = Object.fromEntries(new URLSearchParams(rawBody).entries());
      return {
        body: JSON.stringify({
          ...provisionFixture,
          id: `device-${provisionCount}`,
          pubkey: params.pubkey,
          name: params.name ?? `mullgate-demo-${provisionCount}`,
          ipv4_address: `10.64.12.${33 + provisionCount}/32`,
        }),
      };
    },
    '/relays': () => ({
      body: relayFixture,
    }),
  };

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

    const route = routes[request.url ?? '/'];
    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"detail":"not found"}');
      return;
    }

    const result = route({ rawBody });
    response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    response.end(result.body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind the demo fixture server.');
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

export async function seedLoopbackSetup(options: SetupSeedOptions): Promise<void> {
  const result = await runCli({
    args: [
      'setup',
      '--non-interactive',
      '--device-name',
      options.deviceName,
      '--mullvad-wg-url',
      new URL('/wg', options.serverBaseUrl).toString(),
      '--mullvad-relays-url',
      new URL('/relays', options.serverBaseUrl).toString(),
    ],
    env: {
      ...options.env,
      MULLGATE_ACCOUNT_NUMBER: demoAccountNumber,
      MULLGATE_PROXY_USERNAME: demoUsername,
      MULLGATE_PROXY_PASSWORD: demoPassword,
      MULLGATE_LOCATIONS: demoLocations.join(','),
    },
  });

  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    ['Failed to seed loopback setup.', result.stdout.trim(), result.stderr.trim()]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

export async function seedPrivateNetworkExposure(options: ExposureSeedOptions): Promise<void> {
  const args = [
    'proxy',
    'access',
    '--mode',
    'private-network',
    '--route-bind-ip',
    options.bindIps[0],
    '--route-bind-ip',
    options.bindIps[1],
    ...(options.baseDomain ? ['--base-domain', options.baseDomain] : ['--clear-base-domain']),
  ];

  const result = await runCli({
    args,
    env: options.env,
  });

  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    ['Failed to seed exposure config.', result.stdout.trim(), result.stderr.trim()]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

export async function validateSavedConfig(env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runCli({
    args: ['proxy', 'validate'],
    env,
  });

  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    ['Failed to validate saved config.', result.stdout.trim(), result.stderr.trim()]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
}

export async function markRuntimeRunning(options: RunningStatusSeedOptions): Promise<void> {
  const paths = resolveMullgatePaths(options.env);
  const store = new ConfigStore(paths);
  const loadResult = await store.load();

  if (!loadResult.ok || loadResult.source === 'empty') {
    throw new Error('Cannot mark runtime as running before a saved config exists.');
  }

  const config: MullgateConfig = {
    ...loadResult.config,
    runtime: {
      ...loadResult.config.runtime,
      status: {
        phase: 'running',
        lastCheckedAt: options.attemptedAt,
        message: 'Runtime started successfully.',
      },
    },
  };
  const lastStart: RuntimeStartDiagnostic = {
    attemptedAt: options.attemptedAt,
    status: 'success',
    phase: 'compose-launch',
    source: 'docker-compose',
    code: null,
    message: 'Docker Compose launched the Mullgate runtime bundle in detached mode.',
    cause: null,
    artifactPath: config.runtime.runtimeBundle.dockerComposePath,
    composeFilePath: config.runtime.runtimeBundle.dockerComposePath,
    validationSource: 'wireproxy-binary/configtest (2 routes)',
    routeId: null,
    routeHostname: null,
    routeBindIp: null,
    serviceName: null,
    command: `docker compose --file ${config.runtime.runtimeBundle.dockerComposePath} up --detach`,
  };

  await store.save(config);
  const bundleResult = await renderRuntimeBundle({
    config,
    paths,
    generatedAt: options.attemptedAt,
  });

  if (!bundleResult.ok) {
    throw new Error(`Failed to render demo runtime bundle: ${bundleResult.message}`);
  }

  await writeFile(
    config.diagnostics.lastRuntimeStartReportPath,
    `${JSON.stringify(lastStart, null, 2)}\n`,
    'utf8',
  );
}

export async function runCli(options: {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): Promise<RunProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [tsxCliPath, 'src/cli.ts', ...options.args],
    env: options.env,
  });
}

export async function runDisplayedCliCommand(options: {
  readonly display: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly clearScreen?: boolean;
}): Promise<void> {
  if (options.clearScreen ?? true) {
    process.stdout.write('\u001Bc');
  }

  process.stdout.write(`$ ${options.display}\n`);
  await sleep(450);

  const result = await runProcess({
    command: process.execPath,
    args: [tsxCliPath, 'src/cli.ts', ...options.args],
    env: options.env,
    stdio: 'inherit',
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${options.display}`);
  }

  await sleep(2_000);
}

export async function runGuidedSetupDemo(options: {
  readonly env: NodeJS.ProcessEnv;
}): Promise<void> {
  process.stdout.write('\u001Bc');
  process.stdout.write('$ mullgate setup\n');
  await sleep(500);

  const child = spawn(
    'script',
    ['-qefc', `bash -lc '${process.execPath} ${tsxCliPath} src/cli.ts setup'`, '/dev/null'],
    {
      cwd: repoRoot,
      env: buildChildEnv(options.env),
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );

  const writes = [
    { delayMs: 900, value: `${demoAccountNumber}\n` },
    { delayMs: 650, value: '127.0.0.1\n' },
    { delayMs: 550, value: '1080\n' },
    { delayMs: 550, value: '8080\n' },
    { delayMs: 650, value: `${demoUsername}\n` },
    { delayMs: 650, value: `${demoPassword}\n` },
    { delayMs: 650, value: `${demoLocations.join(', ')}\n` },
    { delayMs: 650, value: 'loopback\n' },
    { delayMs: 650, value: '\n' },
    { delayMs: 650, value: 'n\n' },
  ];

  for (const write of writes) {
    await sleep(write.delayMs);
    child.stdin.write(write.value);
  }

  child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`Guided setup demo failed with exit code ${exitCode}.`);
  }

  await sleep(2_400);
}

export function buildHealthyDockerFixtures(): readonly DockerContainerFixture[] {
  return [
    {
      Name: 'mullgate-routing-layer-1',
      Service: 'routing-layer',
      Project: 'mullgate',
      State: 'running',
      Health: 'healthy',
      Status: 'Up 40 seconds',
      ExitCode: 0,
      Publishers: [],
    },
    {
      Name: 'mullgate-entry-tunnel-1',
      Service: 'entry-tunnel',
      Project: 'mullgate',
      State: 'running',
      Health: 'healthy',
      Status: 'Up 40 seconds',
      ExitCode: 0,
      Publishers: [],
    },
    {
      Name: 'mullgate-route-proxy-1',
      Service: 'route-proxy',
      Project: 'mullgate',
      State: 'running',
      Health: 'healthy',
      Status: 'Up 40 seconds',
      ExitCode: 0,
      Publishers: [],
    },
  ];
}

export async function syncDemoAsset(options: {
  readonly sourcePath: string;
  readonly destinationPath: string;
}): Promise<void> {
  await mkdir(path.dirname(options.destinationPath), { recursive: true });
  await writeFile(options.destinationPath, await readFile(options.sourcePath));
}

async function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd ?? repoRoot,
      env: buildChildEnv(options.env),
      stdio:
        options.stdio === 'inherit'
          ? ['inherit', 'inherit', 'inherit']
          : [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdoutChunks.push(Buffer.from(chunk));
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrChunks.push(Buffer.from(chunk));
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

export async function sleep(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function buildChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  delete nextEnv.NO_COLOR;
  return nextEnv;
}
