#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net, { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveMullgatePaths } from '../src/config/paths.js';
import { REDACTED, redactSensitiveText } from '../src/config/redact.js';
import { ConfigStore } from '../src/config/store.js';
import type { MullgateConfig, RuntimeStartDiagnostic } from '../src/config/schema.js';
import type { RuntimeBundleManifest, RuntimeEndpoint } from '../src/runtime/render-runtime-bundle.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const DEFAULT_LOCATIONS = 'sweden-gothenburg,austria-vienna';
const DEFAULT_TARGET_URL = 'https://am.i.mullvad.net/json';
const DEFAULT_ROUTE_CHECK_IP = '1.1.1.1';
const DEFAULT_HTTPS_PORT = '8443';
const VERIFY_TARGET_URL_ENV = 'MULLGATE_VERIFY_TARGET_URL';
const VERIFY_ROUTE_CHECK_IP_ENV = 'MULLGATE_VERIFY_ROUTE_CHECK_IP';
const REQUIRED_SETUP_ENV_KEYS = [
  'MULLGATE_ACCOUNT_NUMBER',
  'MULLGATE_PROXY_USERNAME',
  'MULLGATE_PROXY_PASSWORD',
  'MULLGATE_DEVICE_NAME',
] as const;
const REQUIRED_PROTOCOLS = ['socks5', 'http', 'https'] as const;
const PRIVATE_KEY_PATTERN = /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/;

type ProxyProtocol = (typeof REQUIRED_PROTOCOLS)[number];

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly metadataPath: string;
  readonly renderedCommand: string;
};

type VerificationOptions = {
  readonly targetUrl: string;
  readonly routeCheckIp: string;
  readonly keepTempHome: boolean;
};

type VerificationContract = {
  readonly targetUrl: string;
  readonly routeCheckIp: string;
  readonly setupEnv: NodeJS.ProcessEnv;
  readonly shouldGenerateTlsAssets: boolean;
};

type VerificationContext = {
  phase: string;
  readonly root: string;
  readonly artifactsDir: string;
  readonly paths: ReturnType<typeof resolveMullgatePaths>;
  config: MullgateConfig | null;
  hostsOutputPath: string | null;
  manifestPath: string | null;
  lastStartPath: string | null;
  runtimeStarted: boolean;
};

type ExitPayload = {
  readonly ip?: string;
  readonly country?: string;
  readonly city?: string;
  readonly mullvad_exit_ip?: boolean;
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
  readonly stdoutPath: string;
  readonly stderrPath: string;
};

type GeneratedTlsAssets = {
  readonly certPath: string;
  readonly keyPath: string;
  readonly root: string;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options) {
    return;
  }

  const contract = resolveContract(options);
  const root = await mkdtemp(path.join(tmpdir(), 'mullgate-s06-'));
  const artifactsDir = path.join(root, 'verifier-artifacts');
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });

  const env = createTempHomeEnv(root, contract.setupEnv);
  const paths = resolveMullgatePaths(env);
  const context: VerificationContext = {
    phase: 'initializing',
    root,
    artifactsDir,
    paths,
    config: null,
    hostsOutputPath: null,
    manifestPath: null,
    lastStartPath: null,
    runtimeStarted: false,
  };

  let preserveTempHome = options.keepTempHome;
  let tlsAssets: GeneratedTlsAssets | null = null;

  try {
    context.phase = 'prerequisites';
    logPhase(context.phase, 'Checking Linux release prerequisites.');
    const prerequisiteSummary = await verifyPrerequisites(contract, context);

    if (contract.shouldGenerateTlsAssets) {
      context.phase = 'tls-assets';
      logPhase(context.phase, 'Generating ephemeral HTTPS certificate and key for the proxy proof.');
      tlsAssets = await generateTlsAssets(context);
      env.MULLGATE_HTTPS_CERT_PATH = tlsAssets.certPath;
      env.MULLGATE_HTTPS_KEY_PATH = tlsAssets.keyPath;
      env.MULLGATE_HTTPS_PORT = env.MULLGATE_HTTPS_PORT?.trim() || DEFAULT_HTTPS_PORT;
    }

    context.phase = 'setup';
    logPhase(context.phase, 'Running non-interactive mullgate setup inside a temp XDG home.');
    const setupResult = await runCliCommand(context, env, ['setup', '--non-interactive'], 'setup');

    if (setupResult.exitCode !== 0) {
      const guidance = setupResult.stderr.includes('KEY_LIMIT_REACHED') || setupResult.stderr.includes('maximum number of WireGuard keys')
        ? [
            'The configured Mullgate proof needs one free Mullvad WireGuard device slot per routed location.',
            `Current route count: ${env.MULLGATE_LOCATIONS?.split(',').map((entry) => entry.trim()).filter(Boolean).length ?? 0}`,
            'Revoke old Mullvad devices or reduce the routed location count before rerunning `pnpm verify:s06`.',
          ]
        : [];

      throw new Error(
        [
          `phase: ${context.phase}`,
          'mullgate setup failed.',
          ...guidance,
          `stdout: ${setupResult.stdoutPath}`,
          `stderr: ${setupResult.stderrPath}`,
          `metadata: ${setupResult.metadataPath}`,
        ].join('\n'),
      );
    }

    const store = new ConfigStore(paths);
    const configAfterSetup = await loadConfig(store);
    context.config = configAfterSetup;
    assertAtLeastTwoRoutes(configAfterSetup);
    assertNoSecretLeaks('setup output', `${setupResult.stdout}\n${setupResult.stderr}`, configAfterSetup);

    context.phase = 'config-hosts';
    logPhase(context.phase, 'Inspecting emitted hostname → bind IP mappings.');
    const hostsResult = await runCliCommand(context, env, ['config', 'hosts'], 'config-hosts');
    context.hostsOutputPath = hostsResult.stdoutPath;
    assertExitCode(hostsResult, 0, context, 'mullgate config hosts failed.');
    assertHostsOutput(hostsResult.stdout, configAfterSetup);
    assertNoSecretLeaks('config hosts output', `${hostsResult.stdout}\n${hostsResult.stderr}`, configAfterSetup);

    context.phase = 'baseline';
    logPhase(context.phase, 'Capturing direct-route and direct-egress baselines before start.');
    const routeBefore = await captureRoute(contract.routeCheckIp, context);
    const directBefore = await runDirectProbe(context, contract.targetUrl, configAfterSetup);

    context.phase = 'start';
    logPhase(context.phase, 'Starting the real Docker runtime via mullgate start.');
    const startResult = await runCliCommand(context, env, ['start'], 'start');
    context.runtimeStarted = startResult.exitCode === 0;
    assertExitCode(startResult, 0, context, 'mullgate start failed.');

    const configAfterStart = await loadConfig(store);
    context.config = configAfterStart;
    const routeAfter = await captureRoute(contract.routeCheckIp, context);

    if (normalizeRoute(routeBefore) !== normalizeRoute(routeAfter)) {
      throw new Error(
        [
          `phase: ${context.phase}`,
          `Host route to ${contract.routeCheckIp} changed after mullgate start.`,
          `before: ${normalizeRoute(routeBefore)}`,
          `after: ${normalizeRoute(routeAfter)}`,
        ].join('\n'),
      );
    }

    const manifest = await loadJsonFile<RuntimeBundleManifest>(paths.runtimeBundleManifestFile, 'runtime manifest');
    const lastStart = await loadJsonFile<RuntimeStartDiagnostic>(paths.runtimeStartDiagnosticsFile, 'last-start report');
    context.manifestPath = paths.runtimeBundleManifestFile;
    context.lastStartPath = paths.runtimeStartDiagnosticsFile;

    assertStartSummary(startResult.stdout, manifest, configAfterStart);
    assertManifestTopology(manifest, configAfterStart);
    assertLastStartReport(lastStart, manifest);
    assertNoSecretLeaks('start output', `${startResult.stdout}\n${startResult.stderr}`, configAfterStart);
    assertNoSecretLeaks('runtime manifest', JSON.stringify(manifest, null, 2), configAfterStart);
    assertNoSecretLeaks('last-start report', JSON.stringify(lastStart, null, 2), configAfterStart);

    context.phase = 'status';
    logPhase(context.phase, 'Checking mullgate status against the running runtime.');
    const statusResult = await runCliCommand(context, env, ['status'], 'status');
    assertExitCode(statusResult, 0, context, 'mullgate status failed.');
    assertStatusOutput(statusResult.stdout, context, manifest);
    assertNoSecretLeaks('status output', `${statusResult.stdout}\n${statusResult.stderr}`, configAfterStart);

    context.phase = 'doctor';
    logPhase(context.phase, 'Checking mullgate doctor for route-aware recovery truth.');
    const doctorResult = await runCliCommand(context, env, ['doctor'], 'doctor');

    if (doctorResult.exitCode !== 0) {
      const doctorOutput = doctorResult.stderr || doctorResult.stdout;
      const extraGuidance = doctorOutput.includes('hostname-resolution: fail')
        ? [
            'Doctor reported hostname-resolution drift.',
            'Install the hosts block emitted by `mullgate config hosts` or publish DNS so each route hostname resolves to its saved bind IP, then rerun `pnpm verify:s06`.',
            ...(context.hostsOutputPath ? [`config hosts output: ${context.hostsOutputPath}`] : []),
          ]
        : [];

      throw new Error(
        [
          `phase: ${context.phase}`,
          'mullgate doctor failed during the integrated release proof.',
          ...extraGuidance,
          `stdout: ${doctorResult.stdoutPath}`,
          `stderr: ${doctorResult.stderrPath}`,
          `metadata: ${doctorResult.metadataPath}`,
        ].join('\n'),
      );
    }

    assertDoctorOutput(doctorResult.stdout, context);
    assertNoSecretLeaks('doctor output', `${doctorResult.stdout}\n${doctorResult.stderr}`, configAfterStart);

    const selectedRoutes = manifest.routes.slice(0, 2);

    context.phase = 'listeners';
    logPhase(context.phase, 'Waiting for published SOCKS5/HTTP/HTTPS listeners on the first two routes.');
    for (const route of selectedRoutes) {
      await assertHostnameResolution(route.hostname, route.bindIp);

      for (const protocol of REQUIRED_PROTOCOLS) {
        const endpoint = findEndpoint(route.publishedEndpoints, protocol);
        await waitForPort(route.bindIp, endpoint.port, 30_000);
      }
    }

    context.phase = 'probes';
    logPhase(context.phase, 'Probing authenticated SOCKS5/HTTP/HTTPS traffic and distinct exits.');
    const exitProbes: ExitProbe[] = [];

    for (const route of selectedRoutes) {
      for (const protocol of REQUIRED_PROTOCOLS) {
        const endpoint = findEndpoint(route.publishedEndpoints, protocol);
        exitProbes.push(
          await runProxyProbe(context, configAfterStart, {
            routeId: route.routeId,
            hostname: route.hostname,
            bindIp: route.bindIp,
            protocol,
            port: endpoint.port,
            targetUrl: contract.targetUrl,
          }),
        );
      }
    }

    assertPerRouteProtocolConsistency(exitProbes);
    assertDistinctExits(exitProbes, selectedRoutes.map((route) => route.routeId));

    const directAfter = await runDirectProbe(context, contract.targetUrl, configAfterStart);

    await writeJsonArtifact(context, 'probe-results.json', {
      directBefore,
      directAfter,
      routeBefore: normalizeRoute(routeBefore),
      routeAfter: normalizeRoute(routeAfter),
      probes: exitProbes,
    });

    const summaryLines = [
      'S06 release verification passed.',
      `target: ${contract.targetUrl}`,
      `host route target: ${contract.routeCheckIp}`,
      `route before: ${normalizeRoute(routeBefore)}`,
      `route after: ${normalizeRoute(routeAfter)}`,
      `direct before: ${formatExitPayload(directBefore)}`,
      `direct after: ${formatExitPayload(directAfter)}`,
      `config: ${paths.configFile}`,
      `runtime manifest: ${paths.runtimeBundleManifestFile}`,
      `last-start report: ${paths.runtimeStartDiagnosticsFile}`,
      `status output: ${path.join(context.artifactsDir, 'status.stdout.txt')}`,
      `doctor output: ${path.join(context.artifactsDir, 'doctor.stdout.txt')}`,
      'verified routes:',
      ...selectedRoutes.map((route, index) => `${index + 1}. ${route.hostname} -> ${route.bindIp}`),
      'verified routed exits:',
      ...renderProbeLines(exitProbes),
      ...prerequisiteSummary,
      ...(options.keepTempHome ? [`preserved temp home: ${root}`] : []),
    ];

    await writeTextArtifact(context, 'summary.txt', `${summaryLines.join('\n')}\n`);
    process.stdout.write(`${summaryLines.join('\n')}\n`);
  } catch (error) {
    preserveTempHome = true;
    const config = context.config;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = config ? redactSensitiveText(rawMessage, config) : rawMessage;
    const lines = [
      'S06 release verification failed.',
      `phase: ${context.phase}`,
      `temp home: ${context.root}`,
      `artifacts dir: ${context.artifactsDir}`,
      `config: ${context.paths.configFile}`,
      `runtime manifest: ${context.manifestPath ?? context.paths.runtimeBundleManifestFile}`,
      `last-start report: ${context.lastStartPath ?? context.paths.runtimeStartDiagnosticsFile}`,
      ...(context.hostsOutputPath ? [`config hosts output: ${context.hostsOutputPath}`] : []),
      message,
      'The temp XDG home was preserved for later inspection.',
    ];
    process.stderr.write(`${lines.join('\n')}\n`);
    process.exitCode = 1;
  } finally {
    await cleanupRuntime(context, env);

    if (tlsAssets) {
      await rm(tlsAssets.root, { recursive: true, force: true });
    }

    if (!preserveTempHome) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv: readonly string[]): VerificationOptions | null {
  let targetUrl = process.env[VERIFY_TARGET_URL_ENV]?.trim() || DEFAULT_TARGET_URL;
  let routeCheckIp = process.env[VERIFY_ROUTE_CHECK_IP_ENV]?.trim() || DEFAULT_ROUTE_CHECK_IP;
  let keepTempHome = false;

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

    if (argument === '--keep-temp-home') {
      keepTempHome = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { targetUrl, routeCheckIp, keepTempHome };
}

function renderHelp(): string {
  return [
    'Usage: pnpm exec tsx scripts/verify-s06-release.ts [options]',
    '',
    'Run the integrated Linux-first Mullgate proof in a temp XDG home: perform',
    'non-interactive setup, print/check `config hosts`, start the Docker runtime,',
    'verify `status` + `doctor`, prove SOCKS5/HTTP/HTTPS traffic, confirm the host',
    'route to a direct-check IP did not change, and compare the exits for two routed',
    'hostnames when they resolve locally to distinct bind IPs.',
    '',
    'Required environment variables:',
    '  MULLGATE_ACCOUNT_NUMBER       Live Mullvad account number used by setup.',
    '  MULLGATE_PROXY_USERNAME       Proxy username required on published listeners.',
    '  MULLGATE_PROXY_PASSWORD       Proxy password required on published listeners.',
    '  MULLGATE_DEVICE_NAME          Deterministic Mullvad device label for the proof.',
    '',
    'Optional setup environment variables:',
    `  MULLGATE_LOCATIONS            Comma-separated route list (default: ${DEFAULT_LOCATIONS})`,
    '  MULLGATE_LOCATION             Single-route shorthand; ignored when MULLGATE_LOCATIONS is set.',
    '  MULLGATE_ROUTE_BIND_IPS       Ordered bind IPs passed through to setup.',
    '  MULLGATE_EXPOSURE_MODE        loopback, private-network, or public.',
    '  MULLGATE_EXPOSURE_BASE_DOMAIN Base domain for derived route hostnames.',
    `  MULLGATE_HTTPS_PORT          HTTPS proxy port (default: ${DEFAULT_HTTPS_PORT} when verifier generates TLS assets)`,
    '  MULLGATE_HTTPS_CERT_PATH      Existing cert path; skips ephemeral generation when paired with key.',
    '  MULLGATE_HTTPS_KEY_PATH       Existing key path; skips ephemeral generation when paired with cert.',
    '  MULLGATE_MULLVAD_WG_URL       Override Mullvad provisioning endpoint for setup.',
    '  MULLGATE_MULLVAD_RELAYS_URL   Override Mullvad relay metadata endpoint for setup.',
    '',
    'Optional verifier environment variables:',
    `  ${VERIFY_TARGET_URL_ENV}        Exit-check endpoint (default: ${DEFAULT_TARGET_URL})`,
    `  ${VERIFY_ROUTE_CHECK_IP_ENV}    Direct-route check IP (default: ${DEFAULT_ROUTE_CHECK_IP})`,
    '',
    'If HTTPS cert/key paths are not provided, the verifier requires `openssl` so it can',
    'generate a temporary self-signed pair without persisting raw private-key material in',
    'the saved failure bundle.',
    'The verifier also needs one free Mullvad WireGuard device slot per routed location.',
    '',
    'Options:',
    `  --target-url <url>        Exit-check endpoint to query (default: ${DEFAULT_TARGET_URL})`,
    `  --route-check-ip <ip>     Direct-route IP used for host-route drift checks (default: ${DEFAULT_ROUTE_CHECK_IP})`,
    '  --keep-temp-home           Preserve the temp XDG home even on success.',
    '  -h, --help                 Show this help text.',
    '',
  ].join('\n');
}

function resolveContract(options: VerificationOptions): VerificationContract {
  const missingKeys = REQUIRED_SETUP_ENV_KEYS.filter((key) => !(process.env[key]?.trim()));

  if (missingKeys.length > 0) {
    throw new Error(`Missing required environment variables: ${missingKeys.join(', ')}`);
  }

  const setupEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MULLGATE_ACCOUNT_NUMBER: process.env.MULLGATE_ACCOUNT_NUMBER!.trim(),
    MULLGATE_PROXY_USERNAME: process.env.MULLGATE_PROXY_USERNAME!.trim(),
    MULLGATE_PROXY_PASSWORD: process.env.MULLGATE_PROXY_PASSWORD!.trim(),
    MULLGATE_DEVICE_NAME: process.env.MULLGATE_DEVICE_NAME!.trim(),
    MULLGATE_LOCATIONS: process.env.MULLGATE_LOCATIONS?.trim() || process.env.MULLGATE_LOCATION?.trim() || DEFAULT_LOCATIONS,
  };

  if (!setupEnv.MULLGATE_HTTPS_PORT?.trim()) {
    setupEnv.MULLGATE_HTTPS_PORT = DEFAULT_HTTPS_PORT;
  }

  const certProvided = Boolean(process.env.MULLGATE_HTTPS_CERT_PATH?.trim());
  const keyProvided = Boolean(process.env.MULLGATE_HTTPS_KEY_PATH?.trim());

  if (certProvided !== keyProvided) {
    throw new Error('Set both MULLGATE_HTTPS_CERT_PATH and MULLGATE_HTTPS_KEY_PATH, or neither.');
  }

  if (certProvided && keyProvided) {
    setupEnv.MULLGATE_HTTPS_CERT_PATH = process.env.MULLGATE_HTTPS_CERT_PATH!.trim();
    setupEnv.MULLGATE_HTTPS_KEY_PATH = process.env.MULLGATE_HTTPS_KEY_PATH!.trim();
  }

  return {
    targetUrl: options.targetUrl,
    routeCheckIp: options.routeCheckIp,
    setupEnv,
    shouldGenerateTlsAssets: !certProvided && !keyProvided,
  };
}

function createTempHomeEnv(root: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

async function verifyPrerequisites(contract: VerificationContract, context: VerificationContext): Promise<string[]> {
  const lines: string[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0');

  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    throw new Error(`Node.js 22+ is required, but this process is running ${process.versions.node}.`);
  }

  lines.push(`node: ${process.versions.node}`);

  const pnpm = await runRecordedCommand(context, {
    label: 'prereq-pnpm-version',
    command: 'pnpm',
    args: ['--version'],
    env: process.env,
  });
  assertExitCode(pnpm, 0, context, 'pnpm is missing or failed to report its version.');
  lines.push(`pnpm: ${pnpm.stdout.trim()}`);

  const dockerCompose = await runRecordedCommand(context, {
    label: 'prereq-docker-compose-version',
    command: 'docker',
    args: ['compose', 'version'],
    env: process.env,
  });
  assertExitCode(dockerCompose, 0, context, 'Docker Compose is missing or unavailable on PATH.');
  lines.push(`docker compose: ${firstLine(dockerCompose.stdout)}`);

  const curl = await runRecordedCommand(context, {
    label: 'prereq-curl-version',
    command: 'curl',
    args: ['--version'],
    env: process.env,
  });
  assertExitCode(curl, 0, context, 'curl is missing or unavailable on PATH.');
  lines.push(`curl: ${firstLine(curl.stdout)}`);

  const ipRoute = await runRecordedCommand(context, {
    label: 'prereq-ip-route',
    command: 'ip',
    args: ['route', 'get', contract.routeCheckIp],
    env: process.env,
  });
  assertExitCode(ipRoute, 0, context, `The Linux \`ip route get ${contract.routeCheckIp}\` prerequisite failed.`);
  lines.push(`route check command: ip route get ${contract.routeCheckIp}`);

  if (contract.shouldGenerateTlsAssets) {
    const openssl = await runRecordedCommand(context, {
      label: 'prereq-openssl-version',
      command: 'openssl',
      args: ['version'],
      env: process.env,
    });
    assertExitCode(openssl, 0, context, 'openssl is required to generate the verifier HTTPS certificate and key.');
    lines.push(`openssl: ${firstLine(openssl.stdout)}`);
  }

  await writeJsonArtifact(context, 'prerequisites.json', {
    node: process.versions.node,
    pnpm: pnpm.stdout.trim(),
    dockerCompose: dockerCompose.stdout.trim(),
    curl: curl.stdout.trim(),
    routeCheckIp: contract.routeCheckIp,
    generatedTlsAssets: contract.shouldGenerateTlsAssets,
  });

  return lines;
}

async function generateTlsAssets(context: VerificationContext): Promise<GeneratedTlsAssets> {
  const root = await mkdtemp(path.join(tmpdir(), 'mullgate-s06-tls-'));
  const certPath = path.join(root, 'proxy-cert.pem');
  const keyPath = path.join(root, 'proxy-key.pem');

  const result = await runRecordedCommand(context, {
    label: 'generate-tls-assets',
    command: 'openssl',
    args: [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=mullgate-s06.local',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    env: process.env,
    displayCommand: `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=mullgate-s06.local -keyout ${keyPath} -out ${certPath}`,
  });
  assertExitCode(result, 0, context, 'Failed to generate temporary HTTPS assets for the verifier.');

  await Promise.all([access(certPath), access(keyPath)]);

  return {
    certPath,
    keyPath,
    root,
  };
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
    throw new Error(`Expected at least two routed locations, found ${config.routing.locations.length}.`);
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
      throw new Error(`Expected \`mullgate config hosts\` output to include hosts block line ${hostsBlockLine}.`);
    }
  }
}

async function captureRoute(targetIp: string, context: VerificationContext): Promise<string> {
  const result = await runRecordedCommand(context, {
    label: `route-${targetIp.replace(/[^a-zA-Z0-9]+/g, '-')}`,
    command: 'ip',
    args: ['route', 'get', targetIp],
    env: process.env,
  });
  assertExitCode(result, 0, context, `ip route get ${targetIp} failed.`);
  return result.stdout.trim();
}

function normalizeRoute(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function loadJsonFile<T>(filePath: string, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertStartSummary(output: string, manifest: RuntimeBundleManifest, config: MullgateConfig): void {
  if (!output.includes('Mullgate runtime started.')) {
    throw new Error('`mullgate start` success output did not include the runtime started banner.');
  }

  if (!output.includes('exposure entrypoints:')) {
    throw new Error('`mullgate start` success output did not include the exposure entrypoint inventory.');
  }

  for (const route of manifest.routes.slice(0, 2)) {
    if (!output.includes(`${route.hostname} -> ${route.bindIp}`)) {
      throw new Error(`Expected start output to include routed endpoint header for ${route.hostname} -> ${route.bindIp}.`);
    }

    for (const protocol of REQUIRED_PROTOCOLS) {
      const endpoint = findEndpoint(route.publishedEndpoints, protocol);

      if (!output.includes(`   ${protocol} hostname: ${endpoint.redactedHostnameUrl}`)) {
        throw new Error(`Expected start output to include ${protocol} hostname endpoint ${endpoint.redactedHostnameUrl}.`);
      }

      if (!output.includes(`   ${protocol} direct ip: ${endpoint.redactedBindUrl}`)) {
        throw new Error(`Expected start output to include ${protocol} direct-ip endpoint ${endpoint.redactedBindUrl}.`);
      }
    }
  }

  assertNoSecretLeaks('start output', output, config);
}

function assertManifestTopology(manifest: RuntimeBundleManifest, config: MullgateConfig): void {
  if (manifest.topology !== 'multi-route-wireproxy-haproxy') {
    throw new Error(`Expected runtime manifest topology to be multi-route-wireproxy-haproxy, got ${manifest.topology}.`);
  }

  if (manifest.routes.length < 2) {
    throw new Error(`Expected runtime manifest to list at least two routes, found ${manifest.routes.length}.`);
  }

  for (const route of config.routing.locations) {
    const manifestRoute = manifest.routes.find((candidate) => candidate.routeId === route.runtime.routeId);

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
        throw new Error(`Runtime manifest endpoint ${protocol} for ${route.runtime.routeId} was not redacted.`);
      }
    }
  }
}

function assertLastStartReport(report: RuntimeStartDiagnostic, manifest: RuntimeBundleManifest): void {
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
    throw new Error('last-start.json is missing success diagnostics for phase/source/validationSource.');
  }

  if (!report.composeFilePath || !report.command) {
    throw new Error('last-start.json is missing compose launch diagnostics on the success path.');
  }

  if (!manifest.routes.some((route) => report.composeFilePath === route.wireproxyConfigPath) && !report.composeFilePath.endsWith('docker-compose.yml')) {
    throw new Error(`Unexpected compose file path in last-start.json: ${report.composeFilePath}`);
  }
}

function assertStatusOutput(output: string, context: VerificationContext, manifest: RuntimeBundleManifest): void {
  const expected = [
    'Mullgate runtime status',
    'phase: running',
    `config: ${context.paths.configFile}`,
    `runtime dir: ${context.paths.runtimeDir}`,
    `runtime manifest: ${context.paths.runtimeBundleManifestFile} (present)`,
    `last start report: ${context.paths.runtimeStartDiagnosticsFile} (present)`,
  ];

  for (const entry of expected) {
    if (!output.includes(entry)) {
      throw new Error(`mullgate status output drifted; missing: ${entry}`);
    }
  }

  for (const route of manifest.routes.slice(0, 2)) {
    if (!output.includes(`${route.hostname} -> ${route.bindIp}`)) {
      throw new Error(`mullgate status did not include route ${route.hostname} -> ${route.bindIp}.`);
    }

    if (!output.includes(`service: ${route.services.wireproxy.name}`)) {
      throw new Error(`mullgate status did not include service ${route.services.wireproxy.name}.`);
    }
  }
}

function assertDoctorOutput(output: string, context: VerificationContext): void {
  const expected = [
    'Mullgate doctor',
    'overall: pass',
    `config: ${context.paths.configFile}`,
    `runtime dir: ${context.paths.runtimeDir}`,
    'hostname-resolution: pass',
    'runtime: pass',
    'last-start: pass',
  ];

  for (const entry of expected) {
    if (!output.includes(entry)) {
      throw new Error(`mullgate doctor output drifted; missing: ${entry}`);
    }
  }
}

async function assertHostnameResolution(hostname: string, expectedBindIp: string): Promise<void> {
  if (hostname === expectedBindIp || isIP(hostname) === 4) {
    return;
  }

  const addresses = await lookup(hostname, { all: true, family: 4, verbatim: true }).catch((error: unknown) => {
    throw new Error(
      `Hostname ${hostname} did not resolve locally. Install the emitted hosts block so it resolves to ${expectedBindIp}. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
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

function findEndpoint(endpoints: readonly RuntimeEndpoint[], protocol: ProxyProtocol): RuntimeEndpoint {
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

async function runDirectProbe(context: VerificationContext, targetUrl: string, config: MullgateConfig): Promise<ExitPayload> {
  const result = await runRecordedCommand(context, {
    label: `direct-probe-${Date.now()}`,
    command: 'curl',
    args: ['--silent', '--show-error', '--fail', '--location', '--connect-timeout', '20', '--max-time', '60', '--noproxy', '*', targetUrl],
    env: createProxyNeutralEnv(process.env),
    displayCommand: `curl --silent --show-error --fail --location --connect-timeout 20 --max-time 60 --noproxy '*' ${targetUrl}`,
  });

  if (result.exitCode !== 0) {
    throw new Error(redactSensitiveText(result.stderr || result.stdout || 'Direct internet probe failed.', config));
  }

  return parseExitPayload(result.stdout, `direct probe for ${targetUrl}`);
}

async function runProxyProbe(
  context: VerificationContext,
  config: MullgateConfig,
  input: {
    readonly routeId: string;
    readonly hostname: string;
    readonly bindIp: string;
    readonly protocol: ProxyProtocol;
    readonly port: number;
    readonly targetUrl: string;
  },
): Promise<ExitProbe> {
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
    `${config.setup.auth.username}:${config.setup.auth.password}`,
  ];

  if (input.protocol === 'https') {
    args.push('--proxy-insecure');
  }

  args.push(input.targetUrl);

  const result = await runRecordedCommand(context, {
    label: `${input.routeId}-${input.protocol}-probe`,
    command: 'curl',
    args,
    env: createProxyNeutralEnv(process.env),
    displayCommand: [
      'curl --silent --show-error --fail --location --connect-timeout 20 --max-time 60',
      `--proxy ${proxyUrl}`,
      `--proxy-user ${REDACTED}:${REDACTED}`,
      ...(input.protocol === 'https' ? ['--proxy-insecure'] : []),
      input.targetUrl,
    ].join(' '),
  });

  if (result.exitCode !== 0) {
    throw new Error(
      redactSensitiveText(
        [
          `Proxy probe failed for ${input.hostname} (${input.protocol}, ${input.bindIp}:${input.port}).`,
          `stdout: ${result.stdoutPath}`,
          `stderr: ${result.stderrPath}`,
          result.stderr || result.stdout || 'curl returned a non-zero exit code.',
        ].join('\n'),
        config,
      ),
    );
  }

  const payload = parseExitPayload(result.stdout, `${input.protocol} probe for ${input.hostname}`);

  if (!payload.ip) {
    throw new Error(`${input.protocol} probe for ${input.hostname} returned JSON without an ip field.`);
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
    stdoutPath: result.stdoutPath,
    stderrPath: result.stderrPath,
  };
}

function parseExitPayload(raw: string, label: string): ExitPayload {
  try {
    return JSON.parse(raw) as ExitPayload;
  } catch (error) {
    throw new Error(`Failed to parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
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

  if (routeSummaries[0]!.exitKey === routeSummaries[1]!.exitKey) {
    throw new Error(
      [
        'Two routed hostnames collapsed to the same Mullvad exit.',
        `route 1: ${routeSummaries[0]!.probe.hostname} -> ${routeSummaries[0]!.probe.ip} (${routeSummaries[0]!.probe.country ?? 'unknown'})`,
        `route 2: ${routeSummaries[1]!.probe.hostname} -> ${routeSummaries[1]!.probe.ip} (${routeSummaries[1]!.probe.country ?? 'unknown'})`,
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

function formatExitPayload(payload: ExitPayload): string {
  const ip = payload.ip ?? 'unknown';
  const country = payload.country ?? 'unknown';
  const city = payload.city ?? 'unknown';
  const mullvad = payload.mullvad_exit_ip === null || payload.mullvad_exit_ip === undefined ? 'unknown' : String(payload.mullvad_exit_ip);
  return `ip=${ip}, country=${country}, city=${city}, mullvad_exit_ip=${mullvad}`;
}

function assertNoSecretLeaks(surface: string, text: string, config: MullgateConfig): void {
  const secrets = collectSecrets(config);

  for (const secret of secrets) {
    if (text.includes(secret)) {
      throw new Error(`${surface} leaked a secret value that should have been redacted.`);
    }
  }

  if (PRIVATE_KEY_PATTERN.test(text)) {
    throw new Error(`${surface} leaked raw TLS or WireGuard private-key material.`);
  }
}

function collectSecrets(config: MullgateConfig): string[] {
  const candidates = [
    config.setup.auth.username,
    config.setup.auth.password,
    config.mullvad.accountNumber,
    config.mullvad.wireguard.privateKey,
    ...config.routing.locations.flatMap((route) => [route.mullvad.accountNumber, route.mullvad.wireguard.privateKey]),
  ];

  return [...new Set(candidates.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

async function runCliCommand(
  context: VerificationContext,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  label: string,
): Promise<CommandResult> {
  return runRecordedCommand(context, {
    label,
    command: process.execPath,
    args: [tsxCliPath, 'src/cli.ts', ...args],
    cwd: repoRoot,
    env,
    displayCommand: `node ${path.relative(repoRoot, tsxCliPath)} src/cli.ts ${args.join(' ')}`,
  });
}

async function runRecordedCommand(
  context: VerificationContext,
  input: {
    readonly label: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly env: NodeJS.ProcessEnv;
    readonly displayCommand?: string;
  },
): Promise<CommandResult> {
  await mkdir(context.artifactsDir, { recursive: true, mode: 0o700 });
  const slug = input.label.replace(/[^a-zA-Z0-9.-]+/g, '-');
  const stdoutPath = path.join(context.artifactsDir, `${slug}.stdout.txt`);
  const stderrPath = path.join(context.artifactsDir, `${slug}.stderr.txt`);
  const metadataPath = path.join(context.artifactsDir, `${slug}.json`);
  const startedAt = Date.now();

  const result = await runCommand(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
  });
  const durationMs = Date.now() - startedAt;

  await Promise.all([
    writeFile(stdoutPath, result.stdout, { mode: 0o600 }),
    writeFile(stderrPath, result.stderr, { mode: 0o600 }),
    writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          label: input.label,
          phase: context.phase,
          command: input.displayCommand ?? renderCommand(input.command, input.args),
          exitCode: result.exitCode,
          durationMs,
          cwd: input.cwd ?? process.cwd(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    ),
  ]);

  return {
    ...result,
    durationMs,
    stdoutPath,
    stderrPath,
    metadataPath,
    renderedCommand: input.displayCommand ?? renderCommand(input.command, input.args),
  };
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env: NodeJS.ProcessEnv;
  },
): Promise<Pick<CommandResult, 'exitCode' | 'stdout' | 'stderr'>> {
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

function assertExitCode(result: CommandResult, expected: number, context: VerificationContext, message: string): void {
  if (result.exitCode !== expected) {
    const details = [
      `phase: ${context.phase}`,
      message,
      `expected exit code: ${expected}`,
      `actual exit code: ${result.exitCode}`,
      `command: ${result.renderedCommand}`,
      `stdout: ${result.stdoutPath}`,
      `stderr: ${result.stderrPath}`,
      `metadata: ${result.metadataPath}`,
    ];

    if (context.config) {
      throw new Error(redactSensitiveText(details.join('\n'), context.config));
    }

    throw new Error(details.join('\n'));
  }
}

function renderCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(shellEscape)].join(' ');
}

function shellEscape(value: string): string {
  if (/^[a-zA-Z0-9_./:=,@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function firstLine(value: string): string {
  return value.trim().split('\n')[0] ?? value.trim();
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function createProxyNeutralEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };

  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    delete env[key];
  }

  return env;
}

async function cleanupRuntime(context: VerificationContext, env: NodeJS.ProcessEnv): Promise<void> {
  if (!context.runtimeStarted) {
    return;
  }

  context.phase = 'cleanup';
  logPhase(context.phase, 'Stopping the temp Docker runtime.');
  const composeFile = context.paths.runtimeComposeFile;

  const result = await runRecordedCommand(context, {
    label: 'cleanup-docker-compose-down',
    command: 'docker',
    args: ['compose', '--file', composeFile, 'down', '--remove-orphans'],
    cwd: repoRoot,
    env,
    displayCommand: `docker compose --file ${composeFile} down --remove-orphans`,
  }).catch(async (error) => {
    const failurePath = path.join(context.artifactsDir, 'cleanup-error.txt');
    await writeFile(failurePath, `${error instanceof Error ? error.message : String(error)}\n`, { mode: 0o600 });
    return null;
  });

  if (result && result.exitCode !== 0) {
    const lines = [
      'Verifier cleanup failed while stopping the Docker runtime.',
      `stdout: ${result.stdoutPath}`,
      `stderr: ${result.stderrPath}`,
      `metadata: ${result.metadataPath}`,
    ];
    process.stderr.write(`${lines.join('\n')}\n`);
    process.exitCode = 1;
  }
}

async function writeJsonArtifact(context: VerificationContext, fileName: string, value: unknown): Promise<void> {
  await writeFile(path.join(context.artifactsDir, fileName), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function writeTextArtifact(context: VerificationContext, fileName: string, value: string): Promise<void> {
  await writeFile(path.join(context.artifactsDir, fileName), value, { mode: 0o600 });
}

function logPhase(phase: string, message: string): void {
  process.stdout.write(`[${phase}] ${message}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
