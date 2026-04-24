import { spawn } from 'node:child_process';

import type { MullvadRelay } from './fetch-relays.js';

export type CommandExecution = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunner = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}) => Promise<CommandExecution>;

export type RelayProbeSuccess = {
  readonly ok: true;
  readonly relay: MullvadRelay;
  readonly latencyMs: number;
};

export type RelayProbeFailure = {
  readonly ok: false;
  readonly relay: MullvadRelay;
  readonly message: string;
  readonly cause?: string;
};

export type RelayProbeResult = RelayProbeSuccess | RelayProbeFailure;

export type ProxyExitPayload = {
  readonly ip?: string;
  readonly country?: string;
  readonly city?: string;
  readonly mullvad_exit_ip?: boolean;
};

export type ProxyProtocol = 'socks5' | 'http' | 'https';

export type ProxyExitProbeSuccess = {
  readonly ok: true;
  readonly protocol: ProxyProtocol;
  readonly proxyUrl: string;
  readonly exit: {
    readonly ip: string;
    readonly country: string | null;
    readonly city: string | null;
    readonly mullvadExitIp: boolean | null;
  };
};

export type ProxyExitProbeFailure = {
  readonly ok: false;
  readonly protocol: ProxyProtocol;
  readonly proxyUrl: string;
  readonly message: string;
  readonly cause?: string;
};

export type ProxyExitProbeResult = ProxyExitProbeSuccess | ProxyExitProbeFailure;

/**
 * Probes a Mullvad relay to measure its latency using ping.
 *
 * @param input - The input containing the relay to probe and optional command runner.
 * @returns A result containing the latency in milliseconds or a failure if the relay is unreachable.
 */
export async function probeRelayLatency(input: {
  readonly relay: MullvadRelay;
  readonly runner?: CommandRunner;
}): Promise<RelayProbeResult> {
  const runner = input.runner ?? runCommand;
  const args = buildPingArgs(input.relay.endpointIpv4);
  const result = await runner({
    command: 'ping',
    args,
  });

  if (result.exitCode !== 0) {
    return {
      ok: false,
      relay: input.relay,
      message: `Ping failed for ${input.relay.hostname}.`,
      cause: result.stderr.trim() || result.stdout.trim() || 'ping returned a non-zero exit code.',
    };
  }

  const latencyMs = parsePingLatencyMs(result.stdout);

  if (latencyMs === null) {
    return {
      ok: false,
      relay: input.relay,
      message: `Ping succeeded for ${input.relay.hostname}, but Mullgate could not parse the latency.`,
      cause: result.stdout.trim() || 'No ping output was available.',
    };
  }

  return {
    ok: true,
    relay: input.relay,
    latencyMs,
  };
}

/**
 * Probes a proxy exit to verify it's working and returning Mullvad exit IPs.
 *
 * @param input - The input containing proxy configuration and target URL.
 * @returns A result containing the exit details or a failure if the probe fails.
 */
export async function probeProxyExit(input: {
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly targetUrl: string;
  readonly runner?: CommandRunner;
}): Promise<ProxyExitProbeResult> {
  const runner = input.runner ?? runCommand;
  const proxyUrl = `${input.protocol}://${input.host}:${input.port}`;
  const proxyScheme = input.protocol === 'socks5' ? 'socks5h' : input.protocol;
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
    `${proxyScheme}://${input.host}:${input.port}`,
    '--proxy-user',
    `${input.username}:${input.password}`,
  ];

  if (input.protocol === 'https') {
    args.push('--proxy-insecure');
  }

  args.push(input.targetUrl);

  const result = await runner({
    command: 'curl',
    args,
    env: createProxyNeutralEnv(process.env),
  });

  if (result.exitCode !== 0) {
    return {
      ok: false,
      protocol: input.protocol,
      proxyUrl,
      message: `Exit probe failed for ${proxyUrl}.`,
      cause: result.stderr.trim() || result.stdout.trim() || 'curl returned a non-zero exit code.',
    };
  }

  const payload = parseProxyExitPayload(result.stdout);

  if (!payload.ok) {
    return {
      ok: false,
      protocol: input.protocol,
      proxyUrl,
      message: `Exit probe returned invalid JSON for ${proxyUrl}.`,
      cause: payload.message,
    };
  }

  if (!payload.value.ip) {
    return {
      ok: false,
      protocol: input.protocol,
      proxyUrl,
      message: `Exit probe response for ${proxyUrl} did not include an ip field.`,
    };
  }

  if (payload.value.mullvad_exit_ip === false) {
    return {
      ok: false,
      protocol: input.protocol,
      proxyUrl,
      message: `Exit probe for ${proxyUrl} did not report a Mullvad exit.`,
    };
  }

  return {
    ok: true,
    protocol: input.protocol,
    proxyUrl,
    exit: {
      ip: payload.value.ip,
      country: payload.value.country ?? null,
      city: payload.value.city ?? null,
      mullvadExitIp: payload.value.mullvad_exit_ip ?? null,
    },
  };
}

/**
 * Parses ping output to extract latency in milliseconds.
 * Supports parsing time= format, min/avg/max format, and Windows "Average =" format.
 *
 * @param output - The raw ping command output.
 * @returns The latency in milliseconds, or null if parsing failed.
 */
export function parsePingLatencyMs(output: string): number | null {
  const timeMatch = /time[=<]\s*([0-9.]+)\s*ms/i.exec(output);

  if (timeMatch) {
    return Number(timeMatch[1]);
  }

  const summaryMatch = /min\/avg\/max(?:\/mdev)?\s*=\s*[0-9.]+\/([0-9.]+)\//i.exec(output);

  if (summaryMatch) {
    return Number(summaryMatch[1]);
  }

  const windowsMatch = /Average = ([0-9.]+)ms/i.exec(output);

  if (windowsMatch) {
    return Number(windowsMatch[1]);
  }

  return null;
}

/**
 * Parses the raw JSON response from a proxy exit probe.
 *
 * @param raw - The raw string response from the proxy.
 * @returns A result containing the parsed payload or an error message.
 */
export function parseProxyExitPayload(
  raw: string,
):
  | { readonly ok: true; readonly value: ProxyExitPayload }
  | { readonly ok: false; readonly message: string } {
  try {
    return {
      ok: true,
      value: JSON.parse(raw) as ProxyExitPayload,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildPingArgs(targetIp: string): readonly string[] {
  if (process.platform === 'win32') {
    return ['-n', '1', '-w', '4000', targetIp];
  }

  if (process.platform === 'darwin') {
    return ['-c', '1', '-W', '4000', targetIp];
  }

  return ['-c', '1', '-W', '4', targetIp];
}

function createProxyNeutralEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };

  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    delete env[key];
  }

  return env;
}

async function runCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): Promise<CommandExecution> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      env: input.env ?? process.env,
      stdio: 'pipe',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
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
