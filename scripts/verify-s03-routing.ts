import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { MullgateConfig, RuntimeStartDiagnostic } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import type {
  RuntimeBundleManifest,
  RuntimeEndpoint,
} from '../src/runtime/render-runtime-bundle.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const DEFAULT_TARGET_URL = 'https://am.i.mullvad.net/json';
const DEFAULT_ROUTE_CHECK_IP = '1.1.1.1';
const REQUIRED_PROTOCOLS = ['socks5', 'http', 'https'] as const;
const REDACTED = '[redacted]';

type ProxyProtocol = (typeof REQUIRED_PROTOCOLS)[number];

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type VerificationOptions = {
  readonly targetUrl: string;
  readonly routeCheckIp: string;
};

type ExitProbe = {
  readonly routeId: string;
  readonly hostname: string;
  readonly bindIp: string;
  readonly protocol: ProxyProtocol;
  readonly proxyUrl: string;
  readonly ip: string;
  readonly country: string | null;
  readonly city: string | null;
  readonly mullvadExitIp: boolean | null;
};

type ExitPayload = {
  readonly ip?: string;
  readonly country?: string;
  readonly city?: string;
  readonly mullvad_exit_ip?: boolean;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options) {
    return;
  }

  const store = new ConfigStore();
  const configBeforeStart = await loadConfig(store);
  assertAtLeastTwoRoutes(configBeforeStart);

  const routeBefore = await captureRoute(options.routeCheckIp);
  const directBefore = await runDirectProbe(options.targetUrl);
  const hostsCommand = await runCliCommand(['config', 'hosts']);

  if (hostsCommand.exitCode !== 0) {
    throw new Error(
      [
        'mullgate config hosts failed before live verification.',
        hostsCommand.stderr || hostsCommand.stdout || 'No CLI output.',
      ].join('\n'),
    );
  }

  assertHostsOutput(hostsCommand.stdout, configBeforeStart);
  assertNoSecretLeaks('config hosts output', hostsCommand.stdout, configBeforeStart);

  const startResult = await runCliCommand(['start']);

  if (startResult.exitCode !== 0) {
    throw new Error(
      [
        'mullgate start failed during live verification.',
        startResult.stderr || startResult.stdout || 'No CLI output.',
      ].join('\n'),
    );
  }

  const routeAfter = await captureRoute(options.routeCheckIp);

  if (normalizeRoute(routeBefore) !== normalizeRoute(routeAfter)) {
    throw new Error(
      [
        `Host route to ${options.routeCheckIp} changed after mullgate start.`,
        `before: ${normalizeRoute(routeBefore)}`,
        `after: ${normalizeRoute(routeAfter)}`,
      ].join('\n'),
    );
  }

  const configAfterStart = await loadConfig(store);
  const manifest = await loadJsonFile<RuntimeBundleManifest>(
    store.paths.runtimeBundleManifestFile,
    'runtime manifest',
  );
  const lastStart = await loadJsonFile<RuntimeStartDiagnostic>(
    store.paths.runtimeStartDiagnosticsFile,
    'last-start report',
  );

  assertStartSummary(startResult.stdout, manifest, configAfterStart);
  assertManifestTopology(manifest, configAfterStart);
  assertLastStartReport(lastStart, manifest);
  assertNoSecretLeaks('start output', startResult.stdout, configAfterStart);
  assertNoSecretLeaks('runtime manifest', JSON.stringify(manifest, null, 2), configAfterStart);
  assertNoSecretLeaks('last-start report', JSON.stringify(lastStart, null, 2), configAfterStart);

  const selectedRoutes = manifest.routes.slice(0, 2);

  for (const route of selectedRoutes) {
    await assertHostnameResolution(route.hostname, route.bindIp);

    for (const protocol of REQUIRED_PROTOCOLS) {
      const endpoint = findEndpoint(route.publishedEndpoints, protocol);
      await waitForPort(route.bindIp, endpoint.port, 30_000);
    }
  }

  const exitProbes: ExitProbe[] = [];

  for (const route of selectedRoutes) {
    for (const protocol of REQUIRED_PROTOCOLS) {
      const endpoint = findEndpoint(route.publishedEndpoints, protocol);
      exitProbes.push(
        await runProxyProbe({
          config: configAfterStart,
          routeId: route.routeId,
          hostname: route.hostname,
          bindIp: route.bindIp,
          protocol,
          port: endpoint.port,
          targetUrl: options.targetUrl,
        }),
      );
    }
  }

  assertPerRouteProtocolConsistency(exitProbes);
  assertDistinctExits(
    exitProbes,
    selectedRoutes.map((route) => route.routeId),
  );

  const directAfter = await runDirectProbe(options.targetUrl);

  const lines = [
    'S03 routing verification passed.',
    `target: ${options.targetUrl}`,
    `host route target: ${options.routeCheckIp}`,
    `route before: ${normalizeRoute(routeBefore)}`,
    `route after: ${normalizeRoute(routeAfter)}`,
    `direct before: ${formatDirectProbe(directBefore)}`,
    `direct after: ${formatDirectProbe(directAfter)}`,
    `hosts report: ${store.paths.configFile}`,
    `runtime manifest: ${store.paths.runtimeBundleManifestFile}`,
    `last-start report: ${store.paths.runtimeStartDiagnosticsFile}`,
    'verified host mappings:',
    ...selectedRoutes.map((route, index) => `${index + 1}. ${route.hostname} -> ${route.bindIp}`),
    'verified routed exits:',
    ...renderProbeLines(exitProbes),
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
}

function parseArgs(argv: readonly string[]): VerificationOptions | null {
  let targetUrl = DEFAULT_TARGET_URL;
  let routeCheckIp = DEFAULT_ROUTE_CHECK_IP;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === '--help' || argument === '-h') {
      process.stdout.write(renderHelp());
      return null;
    }

    if (argument === '--target-url') {
      targetUrl = readFlagValue(argv, index, '--target-url');
      index += 1;
      continue;
    }

    if (argument === '--route-check-ip') {
      routeCheckIp = readFlagValue(argv, index, '--route-check-ip');
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    targetUrl,
    routeCheckIp,
  };
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function renderHelp(): string {
  return [
    'Usage: pnpm exec tsx scripts/verify-s03-routing.ts [options]',
    '',
    'Launch Mullgate once, verify local hostname mappings, probe two routed hostnames through',
    'SOCKS5/HTTP/HTTPS, and fail if runtime diagnostics or redaction guarantees are missing.',
    '',
    'Options:',
    `  --target-url <url>        Exit-check endpoint to query (default: ${DEFAULT_TARGET_URL})`,
    `  --route-check-ip <ip>     Direct-route IP used for host-route drift checks (default: ${DEFAULT_ROUTE_CHECK_IP})`,
    '  -h, --help                Show this help text',
    '',
  ].join('\n');
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

function assertAtLeastTwoRoutes(config: MullgateConfig): void {
  if (config.routing.locations.length < 2) {
    throw new Error(
      `Expected at least two routed locations, found ${config.routing.locations.length}.`,
    );
  }
}

async function captureRoute(targetIp: string): Promise<string> {
  const result = await runCommand('ip', ['route', 'get', targetIp]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `ip route get ${targetIp} failed.`);
  }

  return result.stdout.trim();
}

function normalizeRoute(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function loadJsonFile<T>(filePath: string, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    throw new Error(
      `Failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertHostsOutput(output: string, config: MullgateConfig): void {
  if (!output.includes('copy/paste hosts block')) {
    throw new Error('`mullgate config hosts` output did not include the copy/paste hosts block.');
  }

  for (const route of config.routing.locations) {
    const mapping = `${route.hostname} -> ${route.bindIp}`;
    const hostsBlockLine = `${route.bindIp} ${route.hostname}`;

    if (!output.includes(mapping)) {
      throw new Error(`Expected \`mullgate config hosts\` output to include mapping ${mapping}.`);
    }

    if (!output.includes(hostsBlockLine)) {
      throw new Error(
        `Expected \`mullgate config hosts\` output to include hosts block line ${hostsBlockLine}.`,
      );
    }
  }
}

function assertStartSummary(
  output: string,
  manifest: RuntimeBundleManifest,
  config: MullgateConfig,
): void {
  if (!output.includes('exposure entrypoints:')) {
    throw new Error(
      '`mullgate start` success output did not include the exposure entrypoint inventory.',
    );
  }

  for (const route of manifest.routes.slice(0, 2)) {
    if (!output.includes(`${route.hostname} -> ${route.bindIp}`)) {
      throw new Error(
        `Expected start output to include routed endpoint header for ${route.hostname} -> ${route.bindIp}.`,
      );
    }

    for (const protocol of REQUIRED_PROTOCOLS) {
      const endpoint = findEndpoint(route.publishedEndpoints, protocol);

      if (!output.includes(`   ${protocol} hostname: ${endpoint.redactedHostnameUrl}`)) {
        throw new Error(
          `Expected start output to include ${protocol} hostname endpoint ${endpoint.redactedHostnameUrl}.`,
        );
      }

      if (!output.includes(`   ${protocol} direct ip: ${endpoint.redactedBindUrl}`)) {
        throw new Error(
          `Expected start output to include ${protocol} direct-ip endpoint ${endpoint.redactedBindUrl}.`,
        );
      }
    }
  }

  assertNoSecretLeaks('start output', output, config);
}

function assertManifestTopology(manifest: RuntimeBundleManifest, config: MullgateConfig): void {
  if (manifest.topology !== 'multi-route-wireproxy-haproxy') {
    throw new Error(
      `Expected runtime manifest topology to be multi-route-wireproxy-haproxy, got ${manifest.topology}.`,
    );
  }

  if (manifest.routes.length < 2) {
    throw new Error(
      `Expected runtime manifest to list at least two routes, found ${manifest.routes.length}.`,
    );
  }

  for (const route of config.routing.locations) {
    const manifestRoute = manifest.routes.find(
      (candidate) => candidate.routeId === route.runtime.routeId,
    );

    if (!manifestRoute) {
      throw new Error(`Runtime manifest is missing route ${route.runtime.routeId}.`);
    }

    if (manifestRoute.hostname !== route.hostname || manifestRoute.bindIp !== route.bindIp) {
      throw new Error(
        [
          `Runtime manifest route ${route.runtime.routeId} does not match canonical config.`,
          `expected: ${route.hostname} -> ${route.bindIp}`,
          `actual: ${manifestRoute.hostname} -> ${manifestRoute.bindIp}`,
        ].join('\n'),
      );
    }

    for (const protocol of REQUIRED_PROTOCOLS) {
      const endpoint = findEndpoint(manifestRoute.publishedEndpoints, protocol);

      if (endpoint.host !== route.hostname || endpoint.bindIp !== route.bindIp) {
        throw new Error(
          `Runtime manifest endpoint ${protocol} for ${route.runtime.routeId} did not preserve hostname/bind-IP routing metadata.`,
        );
      }

      if (
        endpoint.auth.username !== REDACTED ||
        endpoint.auth.password !== REDACTED ||
        !endpoint.redactedHostnameUrl.includes(REDACTED) ||
        !endpoint.redactedBindUrl.includes(REDACTED)
      ) {
        throw new Error(
          `Runtime manifest endpoint ${protocol} for ${route.runtime.routeId} was not redacted.`,
        );
      }
    }
  }
}

function assertLastStartReport(
  report: RuntimeStartDiagnostic,
  manifest: RuntimeBundleManifest,
): void {
  const requiredKeys = [
    'attemptedAt',
    'status',
    'phase',
    'source',
    'code',
    'message',
    'cause',
    'artifactPath',
    'composeFilePath',
    'validationSource',
    'routeId',
    'routeHostname',
    'routeBindIp',
    'serviceName',
    'command',
  ] as const;

  for (const key of requiredKeys) {
    if (!(key in report)) {
      throw new Error(`last-start.json is missing required key ${key}.`);
    }
  }

  if (report.status !== 'success') {
    throw new Error(`Expected last-start.json to record success, got ${report.status}.`);
  }

  if (!report.phase || !report.source || !report.validationSource) {
    throw new Error(
      'last-start.json is missing success diagnostics for phase/source/validationSource.',
    );
  }

  if (!report.composeFilePath || !report.command) {
    throw new Error('last-start.json is missing compose launch diagnostics on the success path.');
  }

  if (
    !manifest.routes.some((route) => report.composeFilePath === route.wireproxyConfigPath) &&
    !report.composeFilePath.endsWith('docker-compose.yml')
  ) {
    throw new Error(`Unexpected compose file path in last-start.json: ${report.composeFilePath}`);
  }
}

async function assertHostnameResolution(hostname: string, expectedBindIp: string): Promise<void> {
  const addresses = await lookup(hostname, { all: true, family: 4, verbatim: true }).catch(
    (error: unknown) => {
      throw new Error(
        `Hostname ${hostname} did not resolve locally. Add the emitted hosts block so it resolves to ${expectedBindIp}. Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  const uniqueAddresses = [...new Set(addresses.map((address) => address.address))];

  if (uniqueAddresses.length !== 1 || uniqueAddresses[0] !== expectedBindIp) {
    throw new Error(
      [
        `Hostname ${hostname} resolved to the wrong IPv4 address.`,
        `expected: ${expectedBindIp}`,
        `actual: ${uniqueAddresses.join(', ') || 'none'}`,
      ].join('\n'),
    );
  }
}

function findEndpoint(
  endpoints: readonly RuntimeEndpoint[],
  protocol: ProxyProtocol,
): RuntimeEndpoint {
  const endpoint = endpoints.find((candidate) => candidate.protocol === protocol);

  if (!endpoint) {
    throw new Error(`Route manifest is missing the ${protocol} published endpoint.`);
  }

  return endpoint;
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

async function runDirectProbe(targetUrl: string): Promise<ExitPayload> {
  const result = await runCommand(
    'curl',
    [
      '--silent',
      '--show-error',
      '--fail',
      '--location',
      '--connect-timeout',
      '20',
      '--max-time',
      '60',
      '--noproxy',
      '*',
      targetUrl,
    ],
    { env: createProxyNeutralEnv() },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Direct internet probe failed.');
  }

  return parseExitPayload(result.stdout, `direct probe for ${targetUrl}`);
}

function formatDirectProbe(payload: ExitPayload): string {
  const ip = payload.ip ?? 'unknown';
  const country = payload.country ?? 'unknown';
  const city = payload.city ?? 'unknown';
  const mullvad =
    payload.mullvad_exit_ip === null || payload.mullvad_exit_ip === undefined
      ? 'unknown'
      : String(payload.mullvad_exit_ip);
  return `ip=${ip}, country=${country}, city=${city}, mullvad_exit_ip=${mullvad}`;
}

async function runProxyProbe(input: {
  readonly config: MullgateConfig;
  readonly routeId: string;
  readonly hostname: string;
  readonly bindIp: string;
  readonly protocol: ProxyProtocol;
  readonly port: number;
  readonly targetUrl: string;
}): Promise<ExitProbe> {
  const proxyScheme = input.protocol === 'socks5' ? 'socks5h' : input.protocol;
  const proxyUrl = `${proxyScheme}://${input.hostname}:${input.port}`;
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
    `${input.config.setup.auth.username}:${input.config.setup.auth.password}`,
  ];

  if (input.protocol === 'https') {
    args.push('--proxy-insecure');
  }

  args.push(input.targetUrl);

  const result = await runCommand('curl', args, { env: createProxyNeutralEnv() });

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Proxy probe failed for ${input.hostname} (${input.protocol}, ${input.bindIp}:${input.port}).`,
        result.stderr || result.stdout || 'curl returned a non-zero exit code.',
      ].join('\n'),
    );
  }

  const payload = parseExitPayload(result.stdout, `${input.protocol} probe for ${input.hostname}`);

  if (!payload.ip) {
    throw new Error(
      `${input.protocol} probe for ${input.hostname} returned JSON without an ip field.`,
    );
  }

  if (payload.mullvad_exit_ip === false) {
    throw new Error(
      `${input.protocol} probe for ${input.hostname} (${input.bindIp}:${input.port}) did not exit through Mullvad according to ${input.targetUrl}.`,
    );
  }

  return {
    routeId: input.routeId,
    hostname: input.hostname,
    bindIp: input.bindIp,
    protocol: input.protocol,
    proxyUrl: `${input.protocol}://${input.hostname}:${input.port}`,
    ip: payload.ip,
    country: payload.country ?? null,
    city: payload.city ?? null,
    mullvadExitIp: payload.mullvad_exit_ip ?? null,
  };
}

function parseExitPayload(raw: string, label: string): ExitPayload {
  try {
    return JSON.parse(raw) as ExitPayload;
  } catch (error) {
    throw new Error(
      `Failed to parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertPerRouteProtocolConsistency(probes: readonly ExitProbe[]): void {
  const routeIds = [...new Set(probes.map((probe) => probe.routeId))];

  for (const routeId of routeIds) {
    const routeProbes = probes.filter((probe) => probe.routeId === routeId);
    const uniqueExitKeys = [...new Set(routeProbes.map((probe) => summarizeExit(probe)))];

    if (uniqueExitKeys.length !== 1) {
      throw new Error(
        [
          `Protocols for route ${routeId} did not agree on the routed Mullvad exit.`,
          ...routeProbes.map(
            (probe) =>
              `- ${probe.protocol}: ip=${probe.ip}, country=${probe.country ?? 'unknown'}, city=${probe.city ?? 'unknown'}, hostname=${probe.hostname}, bindIp=${probe.bindIp}`,
          ),
        ].join('\n'),
      );
    }
  }
}

function assertDistinctExits(probes: readonly ExitProbe[], routeIds: readonly string[]): void {
  const routeSummaries = routeIds.map((routeId) => {
    const firstProbe = probes.find((probe) => probe.routeId === routeId);

    if (!firstProbe) {
      throw new Error(`Missing exit probe data for route ${routeId}.`);
    }

    return {
      routeId,
      exitKey: summarizeExit(firstProbe),
      probe: firstProbe,
    };
  });

  if (routeSummaries[0]?.exitKey === routeSummaries[1]?.exitKey) {
    throw new Error(
      [
        'Two routed hostnames collapsed to the same Mullvad exit.',
        `route 1: ${routeSummaries[0]?.probe.hostname} -> ${routeSummaries[0]?.probe.ip} (${routeSummaries[0]?.probe.country ?? 'unknown'})`,
        `route 2: ${routeSummaries[1]?.probe.hostname} -> ${routeSummaries[1]?.probe.ip} (${routeSummaries[1]?.probe.country ?? 'unknown'})`,
      ].join('\n'),
    );
  }
}

function summarizeExit(probe: Pick<ExitProbe, 'ip' | 'country' | 'city'>): string {
  return [probe.ip, probe.country ?? 'unknown', probe.city ?? 'unknown'].join('|');
}

function renderProbeLines(probes: readonly ExitProbe[]): string[] {
  return probes.map(
    (probe) =>
      `${probe.hostname} ${probe.protocol}: ip=${probe.ip}, country=${probe.country ?? 'unknown'}, city=${probe.city ?? 'unknown'}, mullvad_exit_ip=${probe.mullvadExitIp === null ? 'unknown' : String(probe.mullvadExitIp)}`,
  );
}

function assertNoSecretLeaks(surface: string, text: string, config: MullgateConfig): void {
  const secrets = collectSecrets(config);

  for (const secret of secrets) {
    if (text.includes(secret)) {
      throw new Error(`${surface} leaked a secret value that should have been redacted.`);
    }
  }
}

function collectSecrets(config: MullgateConfig): string[] {
  const candidates = [
    config.setup.auth.password,
    config.mullvad.accountNumber,
    config.mullvad.wireguard.privateKey,
    ...config.routing.locations.flatMap((route) => [
      route.mullvad.accountNumber,
      route.mullvad.wireguard.privateKey,
    ]),
  ];

  return [
    ...new Set(
      candidates.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  ];
}

async function runCliCommand(args: readonly string[]): Promise<CommandResult> {
  return runCommand(process.execPath, [tsxCliPath, 'src/cli.ts', ...args], {
    cwd: repoRoot,
    env: process.env,
  });
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

function createProxyNeutralEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
