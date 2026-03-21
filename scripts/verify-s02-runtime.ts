import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

import { ConfigStore } from '../src/config/store.js';
import type { MullgateConfig } from '../src/config/schema.js';

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ProbeResult = {
  readonly protocol: 'socks5' | 'http' | 'https';
  readonly url: string;
  readonly ip: string;
  readonly mullvadExitIp: boolean | null;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const CLI_TARGET_URL = 'https://am.i.mullvad.net/json';

async function main(): Promise<void> {
  const store = new ConfigStore();
  const initialConfig = await loadConfig(store);
  const routeBefore = await captureRoute();
  const startResult = await runCommand(process.execPath, [tsxCliPath, 'src/cli.ts', 'start'], {
    cwd: repoRoot,
    env: process.env,
  });

  if (startResult.exitCode !== 0) {
    throw new Error(
      ['mullgate start failed during live verification.', startResult.stderr || startResult.stdout || 'No CLI output.'].join('\n'),
    );
  }

  const routeAfter = await captureRoute();

  if (normalizeRoute(routeBefore) !== normalizeRoute(routeAfter)) {
    throw new Error(
      [
        'Host route changed after mullgate start.',
        `before: ${normalizeRoute(routeBefore)}`,
        `after: ${normalizeRoute(routeAfter)}`,
      ].join('\n'),
    );
  }

  const config = await loadConfig(store);
  const probes = await runProtocolProbes(config);
  const startReport = JSON.parse(await readFile(store.paths.runtimeStartDiagnosticsFile, 'utf8')) as {
    status: string;
    phase: string;
    source: string;
    validationSource: string | null;
  };

  if (config.runtime.status.phase !== 'running') {
    throw new Error(`Expected runtime status to be running after start, got ${config.runtime.status.phase}.`);
  }

  if (startReport.status !== 'success') {
    throw new Error(`Expected persisted start report to record success, got ${startReport.status}.`);
  }

  const lines = [
    'S02 runtime verification passed.',
    `route before: ${normalizeRoute(routeBefore)}`,
    `route after: ${normalizeRoute(routeAfter)}`,
    `start phase: ${startReport.phase}`,
    `start source: ${startReport.source}`,
    `validation: ${startReport.validationSource ?? 'unknown'}`,
    ...probes.map(
      (probe) =>
        `${probe.protocol}: ok (ip=${probe.ip}, mullvad_exit_ip=${probe.mullvadExitIp === null ? 'unknown' : String(probe.mullvadExitIp)}) via ${probe.url}`,
    ),
    `runtime manifest: ${config.runtime.runtimeBundle.manifestPath}`,
    `start report: ${store.paths.runtimeStartDiagnosticsFile}`,
  ];

  process.stdout.write(`${lines.join('\n')}\n`);

  void initialConfig;
}

async function loadConfig(store: ConfigStore): Promise<MullgateConfig> {
  const result = await store.load();

  if (!result.ok) {
    throw new Error(`Failed to load Mullgate config: ${result.message}`);
  }

  if (result.source === 'empty') {
    throw new Error(result.message);
  }

  return result.config;
}

async function captureRoute(): Promise<string> {
  const result = await runCommand('ip', ['route', 'get', '1.1.1.1']);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'ip route get 1.1.1.1 failed.');
  }

  return result.stdout.trim();
}

function normalizeRoute(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function runProtocolProbes(config: MullgateConfig): Promise<ProbeResult[]> {
  const probes: ProbeResult[] = [];
  await waitForPort(config.setup.bind.host, config.setup.bind.socksPort, 30_000);
  probes.push(await runProxyProbe({ config, protocol: 'socks5' }));

  await waitForPort(config.setup.bind.host, config.setup.bind.httpPort, 30_000);
  probes.push(await runProxyProbe({ config, protocol: 'http' }));

  if (config.setup.bind.httpsPort === null || !config.setup.https.certPath) {
    throw new Error('HTTPS proxy verification requires a configured HTTPS port and certificate path.');
  }

  await waitForPort(config.setup.bind.host, config.setup.bind.httpsPort, 30_000);
  probes.push(await runProxyProbe({ config, protocol: 'https' }));
  return probes;
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'listener not ready yet';

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port });
        const onError = (error: Error) => {
          socket.destroy();
          reject(error);
        };

        socket.once('connect', () => {
          socket.end();
          resolve();
        });
        socket.once('error', onError);
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  throw new Error(`Timed out waiting for ${host}:${port} to accept connections (${lastError}).`);
}

async function runProxyProbe(input: {
  readonly config: MullgateConfig;
  readonly protocol: 'socks5' | 'http' | 'https';
}): Promise<ProbeResult> {
  const { config, protocol } = input;
  const port =
    protocol === 'socks5'
      ? config.setup.bind.socksPort
      : protocol === 'http'
        ? config.setup.bind.httpPort
        : config.setup.bind.httpsPort;

  if (port === null) {
    throw new Error(`Missing configured ${protocol} port in saved config.`);
  }

  const proxyUrl = `${protocol === 'socks5' ? 'socks5h' : protocol}://${config.setup.bind.host}:${port}`;
  const args = [
    '--silent',
    '--show-error',
    '--fail',
    '--location',
    '--connect-timeout',
    '20',
    '--max-time',
    '60',
    '--proxy',
    proxyUrl,
    '--proxy-user',
    `${config.setup.auth.username}:${config.setup.auth.password}`,
  ];

  if (protocol === 'https') {
    args.push('--proxy-insecure');
  }

  args.push(CLI_TARGET_URL);

  const result = await runCommand('curl', args);

  if (result.exitCode !== 0) {
    throw new Error(`${protocol} probe failed: ${result.stderr || result.stdout || 'curl returned a non-zero exit code.'}`);
  }

  const payload = JSON.parse(result.stdout) as { ip?: string; mullvad_exit_ip?: boolean };

  if (!payload.ip) {
    throw new Error(`${protocol} probe returned JSON without an ip field.`);
  }

  return {
    protocol,
    url: `${protocol}://${config.setup.bind.host}:${port}`,
    ip: payload.ip,
    mullvadExitIp: typeof payload.mullvad_exit_ip === 'boolean' ? payload.mullvad_exit_ip : null,
  };
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
