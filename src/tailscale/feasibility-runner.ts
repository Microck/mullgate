import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  fetchRelays,
  type MullvadRelay,
  type MullvadRelayCatalog,
  resolveRelaySocksInternalIps,
} from '../mullvad/fetch-relays.js';
import { requireArrayValue } from '../required.js';

const DEFAULT_TARGET_URL = 'https://am.i.mullvad.net/json';
const DEFAULT_OUTPUT_ROOT = '.tmp/tailscale-feasibility';
const DEFAULT_RELAYS_URL = 'https://api.mullvad.net/www/relays/all/';
const DEFAULT_EXIT_COUNT = 3 as const;
const DEFAULT_TAILSCALE_IMAGE = 'tailscale/tailscale:stable';
const DEFAULT_CURL_IMAGE = 'curlimages/curl:8.11.1';
const PREFERRED_PROBE_CITY_KEYS = ['se-got', 'at-vie', 'us-nyc'] as const;

const REQUIRED_LIVE_ENV_KEYS = [
  'MULLGATE_TAILSCALE_AUTH_KEY',
  'MULLGATE_TAILSCALE_TAILNET',
  'MULLGATE_TAILSCALE_PINNED_EXIT_NODE',
] as const;

export type TailscaleFeasibilityOptions = {
  readonly targetUrl: string;
  readonly outputRoot: string;
  readonly logicalExitCount: 2 | 3;
  readonly fixturePath?: string;
  readonly mullvadRelaysUrl?: string;
  readonly authKey?: string;
  readonly tailnet?: string;
  readonly pinnedExitNode?: string;
  readonly tailscaleImage: string;
  readonly curlImage: string;
  readonly keepWorkspace: boolean;
};

export type TailscaleFeasibilityParseResult =
  | { readonly ok: true; readonly options: TailscaleFeasibilityOptions }
  | {
      readonly ok: false;
      readonly helpText: string;
      readonly exitCode: 0 | 1;
      readonly error?: string;
    };

export type TailscaleProbeObservation = {
  readonly ok: boolean;
  readonly relayHostname: string;
  readonly socksInternalIp: string;
  readonly targetUrl: string;
  readonly observedExit?: {
    readonly ip: string;
    readonly country?: string;
    readonly city?: string;
    readonly mullvadExitIpHostname?: string;
  };
  readonly message?: string;
};

export type TailscaleFeasibilityArtifact = {
  readonly version: 1;
  readonly generatedAt: string;
  readonly mode: 'fixture' | 'live';
  readonly proof: 'one-tailscaled-direct-internal-socks';
  readonly targetUrl: string;
  readonly requestedExitCount: 2 | 3;
  readonly selectedRelays: readonly {
    readonly relayHostname: string;
    readonly socksHostname: string;
    readonly socksInternalIp: string;
  }[];
  readonly probes: readonly TailscaleProbeObservation[];
  readonly verdict: {
    readonly ok: boolean;
    readonly distinctObservedExitCount: number;
    readonly reason:
      | 'passed'
      | 'insufficient-distinct-exits'
      | 'probe-failure'
      | 'prerequisite-failure';
  };
};

export type TailscaleFeasibilityResult = {
  readonly exitCode: 0 | 1;
  readonly outputDir: string;
  readonly summaryJsonPath: string;
  readonly summaryTextPath: string;
  readonly workspacePath?: string;
  readonly artifact: TailscaleFeasibilityArtifact;
  readonly preservedWorkspace: boolean;
};

export function parseTailscaleFeasibilityArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): TailscaleFeasibilityParseResult {
  let targetUrl = env.MULLGATE_VERIFY_TARGET_URL?.trim() || DEFAULT_TARGET_URL;
  let outputRoot = env.MULLGATE_TAILSCALE_OUTPUT_ROOT?.trim() || DEFAULT_OUTPUT_ROOT;
  let logicalExitCount: 2 | 3 =
    readLogicalExitCount(env.MULLGATE_TAILSCALE_LOGICAL_EXIT_COUNT?.trim()) ?? DEFAULT_EXIT_COUNT;
  let fixturePath: string | undefined;
  let keepWorkspace = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = requireArrayValue(argv, index, `Missing CLI argument at index ${index}.`);

    if (argument === '--help' || argument === '-h') {
      return { ok: false, helpText: renderTailscaleFeasibilityHelp(), exitCode: 0 };
    }

    if (argument === '--target-url') {
      targetUrl = readFlagValue({ argv, index, flag: '--target-url' });
      index += 1;
      continue;
    }

    if (argument === '--logical-exit-count') {
      const rawCount = readFlagValue({ argv, index, flag: '--logical-exit-count' });
      const parsed = readLogicalExitCount(rawCount);

      if (!parsed) {
        return {
          ok: false,
          helpText: renderTailscaleFeasibilityHelp(),
          exitCode: 1,
          error: `Invalid --logical-exit-count value: ${rawCount}. Expected 2 or 3.`,
        };
      }

      logicalExitCount = parsed;
      index += 1;
      continue;
    }

    if (argument === '--output-root') {
      outputRoot = readFlagValue({ argv, index, flag: '--output-root' });
      index += 1;
      continue;
    }

    if (argument === '--fixture') {
      fixturePath = readFlagValue({ argv, index, flag: '--fixture' });
      index += 1;
      continue;
    }

    if (argument === '--keep-workspace') {
      keepWorkspace = true;
      continue;
    }

    return {
      ok: false,
      helpText: renderTailscaleFeasibilityHelp(),
      exitCode: 1,
      error: `Unknown argument: ${argument}`,
    };
  }

  return {
    ok: true,
    options: {
      targetUrl,
      outputRoot,
      logicalExitCount,
      ...(fixturePath ? { fixturePath } : {}),
      ...(env.MULLGATE_MULLVAD_RELAYS_URL?.trim()
        ? { mullvadRelaysUrl: env.MULLGATE_MULLVAD_RELAYS_URL.trim() }
        : {}),
      ...(env.MULLGATE_TAILSCALE_AUTH_KEY?.trim()
        ? { authKey: env.MULLGATE_TAILSCALE_AUTH_KEY.trim() }
        : {}),
      ...(env.MULLGATE_TAILSCALE_TAILNET?.trim()
        ? { tailnet: env.MULLGATE_TAILSCALE_TAILNET.trim() }
        : {}),
      ...(env.MULLGATE_TAILSCALE_PINNED_EXIT_NODE?.trim()
        ? { pinnedExitNode: env.MULLGATE_TAILSCALE_PINNED_EXIT_NODE.trim() }
        : {}),
      tailscaleImage: env.MULLGATE_TAILSCALE_IMAGE?.trim() || DEFAULT_TAILSCALE_IMAGE,
      curlImage: env.MULLGATE_TAILSCALE_CURL_IMAGE?.trim() || DEFAULT_CURL_IMAGE,
      keepWorkspace,
    },
  };
}

export function renderTailscaleFeasibilityHelp(): string {
  return [
    'Usage: pnpm exec tsx scripts/verify-tailscale-feasibility.ts [options]',
    '',
    'Run the Tailscale exit-source feasibility verifier. Live mode starts a',
    'temporary tailscaled sidecar container, authenticates it into the configured',
    'tailnet, pins it to one Mullvad exit node, resolves Mullvad SOCKS hostnames',
    'with public DNS, probes 2-3 direct 10.124.x:1080 SOCKS endpoints',
    'concurrently, and passes only when the observed exits are distinct.',
    '',
    'Options:',
    `  --target-url <url>          Exit-check endpoint (default: ${DEFAULT_TARGET_URL})`,
    '  --logical-exit-count <2|3>  Number of direct internal SOCKS exits to probe.',
    `  --output-root <path>        Artifact output root (default: ${DEFAULT_OUTPUT_ROOT})`,
    '  --fixture <path>            Replay a saved artifact instead of running live probes.',
    '  --keep-workspace            Preserve the temporary sidecar state directory.',
    '',
    'Optional environment variables:',
    `  MULLGATE_MULLVAD_RELAYS_URL Override Mullvad relay endpoint (default: ${DEFAULT_RELAYS_URL})`,
    '  MULLGATE_TAILSCALE_AUTH_KEY Reusable or ephemeral Tailscale auth key for live mode.',
    '  MULLGATE_TAILSCALE_TAILNET Tailnet name used by the sidecar.',
    '  MULLGATE_TAILSCALE_PINNED_EXIT_NODE Mullvad exit node to pin the sidecar to.',
    `  MULLGATE_TAILSCALE_IMAGE Sidecar image (default: ${DEFAULT_TAILSCALE_IMAGE}).`,
    `  MULLGATE_TAILSCALE_CURL_IMAGE Probe image (default: ${DEFAULT_CURL_IMAGE}).`,
    '  MULLGATE_TAILSCALE_LOGICAL_EXIT_COUNT Requested logical exit count (2 or 3).',
    '  MULLGATE_TAILSCALE_OUTPUT_ROOT Artifact output root.',
    '',
  ].join('\n');
}

export async function runTailscaleFeasibilityVerifier(
  options: TailscaleFeasibilityOptions,
): Promise<TailscaleFeasibilityResult> {
  const outputDir = path.join(options.outputRoot, 'latest');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  let workspacePath: string | undefined;
  let sidecarName: string | null = null;

  if (options.fixturePath) {
    const artifact = JSON.parse(
      await readFile(options.fixturePath, 'utf8'),
    ) as TailscaleFeasibilityArtifact;
    return writeResult({ outputDir, artifact, preservedWorkspace: false });
  }

  try {
    const missingEnv = REQUIRED_LIVE_ENV_KEYS.filter((key) => !options[envKeyToOptionKey(key)]);
    if (missingEnv.length > 0) {
      return writeResult({
        outputDir,
        artifact: createPrerequisiteFailureArtifact({
          targetUrl: options.targetUrl,
          requestedExitCount: options.logicalExitCount,
          message: `Missing required live-mode environment: ${missingEnv.join(', ')}.`,
        }),
        preservedWorkspace: false,
      });
    }

    const relays = await fetchRelays({
      ...(options.mullvadRelaysUrl ? { url: options.mullvadRelaysUrl } : {}),
    });

    if (!relays.ok) {
      return writeResult({
        outputDir,
        artifact: createPrerequisiteFailureArtifact({
          targetUrl: options.targetUrl,
          requestedExitCount: options.logicalExitCount,
          message: relays.message,
        }),
        preservedWorkspace: false,
      });
    }

    const resolved = await resolveRelaySocksInternalIps(relays.value);

    if (!resolved.ok) {
      return writeResult({
        outputDir,
        artifact: createPrerequisiteFailureArtifact({
          targetUrl: options.targetUrl,
          requestedExitCount: options.logicalExitCount,
          relayHostname: resolved.relayHostname,
          message: resolved.message,
        }),
        preservedWorkspace: false,
      });
    }

    const selectedRelays = selectTailscaleProbeRelays(resolved.value, options.logicalExitCount);
    if (selectedRelays.length !== options.logicalExitCount) {
      return writeResult({
        outputDir,
        artifact: createPrerequisiteFailureArtifact({
          targetUrl: options.targetUrl,
          requestedExitCount: options.logicalExitCount,
          message: `Only ${selectedRelays.length} active distinct-city relays had resolved internal SOCKS IPs.`,
        }),
        preservedWorkspace: false,
      });
    }

    workspacePath = await mkdtemp(path.join(tmpdir(), 'mullgate-tailscale-feasibility-'));
    sidecarName = createContainerName();
    const sidecarStarted = await startTailscaleSidecar({
      options,
      workspacePath,
      containerName: sidecarName,
    });

    if (sidecarStarted.exitCode !== 0) {
      return writeResult({
        outputDir,
        workspacePath,
        artifact: createPrerequisiteFailureArtifact({
          targetUrl: options.targetUrl,
          requestedExitCount: options.logicalExitCount,
          message:
            sidecarStarted.stderr || sidecarStarted.stdout || 'Failed to start tailscale sidecar.',
        }),
        preservedWorkspace: options.keepWorkspace,
      });
    }

    const sidecarReady = await waitForTailscaleSidecar(sidecarName);
    if (sidecarReady.exitCode !== 0) {
      return writeResult({
        outputDir,
        workspacePath,
        artifact: createPrerequisiteFailureArtifact({
          targetUrl: options.targetUrl,
          requestedExitCount: options.logicalExitCount,
          message:
            sidecarReady.stderr || sidecarReady.stdout || 'Tailscale sidecar did not become ready.',
        }),
        preservedWorkspace: options.keepWorkspace,
      });
    }

    const activeSidecarName = sidecarName;
    const probes = await Promise.all(
      selectedRelays.map((relay) =>
        probeInternalSocksExit({
          relay,
          targetUrl: options.targetUrl,
          sidecarName: activeSidecarName,
          curlImage: options.curlImage,
        }),
      ),
    );

    return writeResult({
      outputDir,
      workspacePath,
      artifact: createArtifact({
        mode: 'live',
        targetUrl: options.targetUrl,
        requestedExitCount: options.logicalExitCount,
        selectedRelays: selectedRelays.map((relay) => ({
          relayHostname: relay.hostname,
          socksHostname: relay.socksName ?? '',
          socksInternalIp: relay.socksInternalIp ?? '',
        })),
        probes,
      }),
      preservedWorkspace: options.keepWorkspace,
    });
  } finally {
    if (sidecarName) {
      await runCommand('docker', ['rm', '-f', sidecarName]);
    }
    if (workspacePath && !options.keepWorkspace) {
      await removeWorkspace(workspacePath, options.tailscaleImage);
    }
  }
}

export function selectTailscaleProbeRelays(
  catalog: MullvadRelayCatalog,
  count: 2 | 3,
): readonly MullvadRelay[] {
  const candidates = catalog.relays.filter(
    (relay) => relay.active && relay.socksName && relay.socksPort && relay.socksInternalIp,
  );
  const usedCities = new Set<string>();
  const selected: MullvadRelay[] = [];

  for (const cityKey of PREFERRED_PROBE_CITY_KEYS) {
    const relay = candidates.find(
      (candidate) => `${candidate.location.countryCode}-${candidate.location.cityCode}` === cityKey,
    );

    if (!relay) {
      continue;
    }

    selected.push(relay);
    usedCities.add(cityKey);

    if (selected.length === count) {
      return selected;
    }
  }

  for (const relay of candidates) {
    const relayCityKey = `${relay.location.countryCode}-${relay.location.cityCode}`;
    if (usedCities.has(relayCityKey)) {
      continue;
    }

    usedCities.add(relayCityKey);
    selected.push(relay);

    if (selected.length === count) {
      break;
    }
  }

  return selected;
}

function createArtifact(input: {
  readonly mode: 'fixture' | 'live';
  readonly targetUrl: string;
  readonly requestedExitCount: 2 | 3;
  readonly selectedRelays: readonly TailscaleFeasibilityArtifact['selectedRelays'][number][];
  readonly probes: readonly TailscaleProbeObservation[];
}): TailscaleFeasibilityArtifact {
  const observedExitKeys = new Set(
    input.probes
      .filter((probe) => probe.ok && probe.observedExit)
      .map(
        (probe) =>
          `${probe.observedExit?.ip}|${probe.observedExit?.country}|${probe.observedExit?.city}`,
      ),
  );
  const allProbesPassed =
    input.probes.length === input.requestedExitCount && input.probes.every((probe) => probe.ok);
  const ok = allProbesPassed && observedExitKeys.size === input.requestedExitCount;
  const prerequisiteFailed =
    input.selectedRelays.length === 0 && input.probes.some((probe) => !probe.ok);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    proof: 'one-tailscaled-direct-internal-socks',
    targetUrl: input.targetUrl,
    requestedExitCount: input.requestedExitCount,
    selectedRelays: input.selectedRelays,
    probes: input.probes,
    verdict: {
      ok,
      distinctObservedExitCount: observedExitKeys.size,
      reason: ok
        ? 'passed'
        : prerequisiteFailed
          ? 'prerequisite-failure'
          : input.probes.some((probe) => !probe.ok)
            ? 'probe-failure'
            : observedExitKeys.size < input.requestedExitCount
              ? 'insufficient-distinct-exits'
              : 'prerequisite-failure',
    },
  };
}

async function probeInternalSocksExit(input: {
  readonly relay: MullvadRelay;
  readonly targetUrl: string;
  readonly sidecarName: string;
  readonly curlImage: string;
}): Promise<TailscaleProbeObservation> {
  const socksInternalIp = input.relay.socksInternalIp ?? '';
  const result = await runCommand('docker', [
    'run',
    '--rm',
    '--network',
    `container:${input.sidecarName}`,
    input.curlImage,
    '--silent',
    '--show-error',
    '--fail',
    '--max-time',
    '30',
    '--socks5-hostname',
    `${socksInternalIp}:${input.relay.socksPort ?? 1080}`,
    input.targetUrl,
  ]);

  if (result.exitCode !== 0) {
    return {
      ok: false,
      relayHostname: input.relay.hostname,
      socksInternalIp,
      targetUrl: input.targetUrl,
      message: result.stderr || result.stdout || `curl exited ${result.exitCode}`,
    };
  }

  const parsed = parseExitPayload(result.stdout);

  if (!parsed) {
    return {
      ok: false,
      relayHostname: input.relay.hostname,
      socksInternalIp,
      targetUrl: input.targetUrl,
      message: 'Exit-check payload was not valid Mullvad JSON.',
    };
  }

  return {
    ok: true,
    relayHostname: input.relay.hostname,
    socksInternalIp,
    targetUrl: input.targetUrl,
    observedExit: parsed,
  };
}

function parseExitPayload(raw: string): TailscaleProbeObservation['observedExit'] | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const ip = typeof value.ip === 'string' ? value.ip : null;
    if (!ip) {
      return null;
    }
    return {
      ip,
      ...(typeof value.country === 'string' ? { country: value.country } : {}),
      ...(typeof value.city === 'string' ? { city: value.city } : {}),
      ...(typeof value.mullvad_exit_ip_hostname === 'string'
        ? { mullvadExitIpHostname: value.mullvad_exit_ip_hostname }
        : {}),
    };
  } catch {
    return null;
  }
}

async function writeResult(input: {
  readonly outputDir: string;
  readonly artifact: TailscaleFeasibilityArtifact;
  readonly workspacePath?: string;
  readonly preservedWorkspace: boolean;
}): Promise<TailscaleFeasibilityResult> {
  const summaryJsonPath = path.join(input.outputDir, 'summary.json');
  const summaryTextPath = path.join(input.outputDir, 'summary.txt');
  const summaryText = renderSummary(input.artifact);

  await writeFile(summaryJsonPath, `${JSON.stringify(input.artifact, null, 2)}\n`, { mode: 0o600 });
  await writeFile(summaryTextPath, summaryText, { mode: 0o600 });
  process.stdout.write(summaryText);

  return {
    exitCode: input.artifact.verdict.ok ? 0 : 1,
    outputDir: input.outputDir,
    summaryJsonPath,
    summaryTextPath,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    artifact: input.artifact,
    preservedWorkspace: input.preservedWorkspace,
  };
}

function renderSummary(artifact: TailscaleFeasibilityArtifact): string {
  return `${[
    `Tailscale exit-source feasibility verdict: ${artifact.verdict.ok ? 'PASS' : 'FAIL'}`,
    `mode: ${artifact.mode}`,
    `proof: ${artifact.proof}`,
    `target: ${artifact.targetUrl}`,
    `requested exits: ${artifact.requestedExitCount}`,
    `distinct observed exits: ${artifact.verdict.distinctObservedExitCount}`,
    `reason: ${artifact.verdict.reason}`,
    ...artifact.probes.map((probe) =>
      probe.ok
        ? `${probe.relayHostname}: ${probe.socksInternalIp} -> ${probe.observedExit?.ip} ${probe.observedExit?.country ?? 'n/a'}/${probe.observedExit?.city ?? 'n/a'}`
        : `${probe.relayHostname}: ${probe.socksInternalIp} failed: ${probe.message ?? 'unknown failure'}`,
    ),
  ].join('\n')}\n`;
}

async function runCommand(
  command: string,
  args: readonly string[],
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'pipe' });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      resolve({ exitCode: 1, stdout: '', stderr: error.message });
    });
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function startTailscaleSidecar(input: {
  readonly options: TailscaleFeasibilityOptions;
  readonly workspacePath: string;
  readonly containerName: string;
}): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stateDir = path.join(input.workspacePath, 'tailscale-state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  return runCommand('docker', [
    'run',
    '--detach',
    '--name',
    input.containerName,
    '--cap-add',
    'NET_ADMIN',
    '--device',
    '/dev/net/tun',
    '--env',
    `MULLGATE_TAILSCALE_TAILNET=${input.options.tailnet ?? ''}`,
    '--env',
    `TS_AUTHKEY=${input.options.authKey ?? ''}`,
    '--env',
    `TS_HOSTNAME=${input.containerName}`,
    '--env',
    `TS_EXTRA_ARGS=--exit-node=${input.options.pinnedExitNode ?? ''} --exit-node-allow-lan-access=true`,
    '--env',
    'TS_STATE_DIR=/var/lib/tailscale',
    '--volume',
    `${stateDir}:/var/lib/tailscale`,
    input.options.tailscaleImage,
  ]);
}

async function waitForTailscaleSidecar(containerName: string): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let latest = { exitCode: 1, stdout: '', stderr: 'Tailscale sidecar readiness timed out.' };

  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await runCommand('docker', [
      'exec',
      containerName,
      'tailscale',
      'status',
      '--peers=false',
    ]);
    if (latest.exitCode === 0) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return latest;
}

async function removeWorkspace(workspacePath: string, cleanupImage: string): Promise<void> {
  const cleanup = await runCommand('docker', [
    'run',
    '--rm',
    '--volume',
    `${workspacePath}:/workspace`,
    cleanupImage,
    'sh',
    '-c',
    'chmod -R u+rwX,go+rwX /workspace 2>/dev/null || true',
  ]);

  if (cleanup.exitCode !== 0) {
    process.stderr.write(cleanup.stderr || cleanup.stdout);
  }

  await rm(workspacePath, { recursive: true, force: true });
}

function createPrerequisiteFailureArtifact(input: {
  readonly targetUrl: string;
  readonly requestedExitCount: 2 | 3;
  readonly message: string;
  readonly relayHostname?: string;
}): TailscaleFeasibilityArtifact {
  return createArtifact({
    mode: 'live',
    targetUrl: input.targetUrl,
    requestedExitCount: input.requestedExitCount,
    selectedRelays: [],
    probes: [
      {
        ok: false,
        relayHostname: input.relayHostname ?? 'n/a',
        socksInternalIp: 'n/a',
        targetUrl: input.targetUrl,
        message: input.message,
      },
    ],
  });
}

function createContainerName(): string {
  return `mullgate-tailscale-feasibility-${process.pid}-${Date.now()}`;
}

function envKeyToOptionKey(
  key: (typeof REQUIRED_LIVE_ENV_KEYS)[number],
): 'authKey' | 'tailnet' | 'pinnedExitNode' {
  if (key === 'MULLGATE_TAILSCALE_AUTH_KEY') {
    return 'authKey';
  }
  if (key === 'MULLGATE_TAILSCALE_TAILNET') {
    return 'tailnet';
  }
  return 'pinnedExitNode';
}

function readFlagValue(input: {
  readonly argv: readonly string[];
  readonly index: number;
  readonly flag: string;
}): string {
  const nextIndex = input.index + 1;
  const value = input.argv[nextIndex];

  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${input.flag}.`);
  }

  return value.trim();
}

function readLogicalExitCount(value: string | undefined): 2 | 3 | null {
  if (value === '2') {
    return 2;
  }

  if (value === '3') {
    return 3;
  }

  return null;
}
