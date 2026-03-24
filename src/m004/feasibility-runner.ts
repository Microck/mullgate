import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { REDACTED } from '../config/redact.js';
import {
  fetchRelays,
  type MullvadRelay,
  type MullvadRelayCatalog,
} from '../mullvad/fetch-relays.js';
import { provisionWireguard } from '../mullvad/provision-wireguard.js';
import { requireArrayValue, requireDefined } from '../required.js';
import { validateWireproxyConfig } from '../runtime/validate-wireproxy.js';
import {
  createEntryIdentityFromRelay,
  createFeasibilityArtifact,
  createSingleEntryTopology,
  type FeasibilityArtifact,
  type FeasibilityLogicalExit,
  type FeasibilityPrerequisiteFailure,
  type FeasibilityProbeObservation,
  type FeasibilityRelaySelectionSummary,
  type HostRouteSnapshot,
  selectFeasibilityExitRelays,
  serializeFeasibilityArtifact,
} from './feasibility-contract.js';

const DEFAULT_TARGET_URL = 'https://am.i.mullvad.net/json';
const DEFAULT_ROUTE_CHECK_IP = '1.1.1.1';
const DEFAULT_OUTPUT_ROOT = '.tmp/m004-feasibility';
const DEFAULT_WIREPROXY_IMAGE = 'backplane/wireproxy:20260320';
const DEFAULT_WIREPROXY_CONTAINER_PATH = '/etc/wireproxy/wireproxy.conf';
const _DEFAULT_HTTP_PORT = 8081;
const DEFAULT_DNS_SERVER = '10.64.0.1';
const DEFAULT_WIREGUARD_PORT = 51820;
const DEFAULT_LOGICAL_EXIT_COUNT = 3 as const;
const DEFAULT_RELAYS_URL = 'https://api.mullvad.net/www/relays/all/';
const REQUIRED_ENV_KEYS = [
  'MULLGATE_ACCOUNT_NUMBER',
  'MULLGATE_PROXY_USERNAME',
  'MULLGATE_PROXY_PASSWORD',
  'MULLGATE_DEVICE_NAME',
] as const;

type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

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

export type FeasibilityRunnerOptions = {
  readonly targetUrl: string;
  readonly routeCheckIp: string;
  readonly logicalExitCount: 2 | 3;
  readonly outputRoot: string;
  readonly keepTempHome: boolean;
  readonly fixturePath?: string;
  readonly accountNumber?: string;
  readonly proxyUsername?: string;
  readonly proxyPassword?: string;
  readonly deviceName?: string;
  readonly mullvadWgUrl?: string;
  readonly mullvadRelaysUrl?: string;
  readonly wireproxyImage?: string;
};

export type FeasibilityParseResult =
  | {
      readonly ok: true;
      readonly options: FeasibilityRunnerOptions;
    }
  | {
      readonly ok: false;
      readonly helpText: string;
      readonly exitCode: 0 | 1;
      readonly error?: string;
    };

export type FeasibilityRunnerResult = {
  readonly exitCode: 0 | 1;
  readonly outputDir: string;
  readonly summaryJsonPath: string;
  readonly summaryTextPath: string;
  readonly workspacePath?: string;
  readonly artifact: FeasibilityArtifact;
  readonly preservedWorkspace: boolean;
};

type RunnerContext = {
  phase: string;
  readonly workspaceRoot: string;
  readonly artifactsDir: string;
  readonly outputDir: string;
  readonly secrets: Set<string>;
  readonly cleanupFailures: string[];
  routeBefore: HostRouteSnapshot | null;
  routeAfter: HostRouteSnapshot | null;
  entryRelay: MullvadRelay | null;
  logicalExits: readonly FeasibilityLogicalExit[];
  relaySelection: FeasibilityRelaySelectionSummary;
  containerName: string | null;
  socksPort: number | null;
  wireproxyConfigPath: string | null;
  wireproxyConfigText: string | null;
  artifact: FeasibilityArtifact | null;
  selectedCatalog: MullvadRelayCatalog | null;
};

type ProbeInput = {
  readonly logicalExit: FeasibilityLogicalExit;
  readonly localSocksPort: number;
  readonly proxyUsername: string;
  readonly proxyPassword: string;
  readonly targetUrl: string;
};

export function parseFeasibilityArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): FeasibilityParseResult {
  let targetUrl = env.MULLGATE_VERIFY_TARGET_URL?.trim() || DEFAULT_TARGET_URL;
  let routeCheckIp = env.MULLGATE_VERIFY_ROUTE_CHECK_IP?.trim() || DEFAULT_ROUTE_CHECK_IP;
  let logicalExitCount: 2 | 3 =
    readLogicalExitCount(env.MULLGATE_M004_LOGICAL_EXIT_COUNT?.trim()) ??
    DEFAULT_LOGICAL_EXIT_COUNT;
  let outputRoot = env.MULLGATE_M004_OUTPUT_ROOT?.trim() || DEFAULT_OUTPUT_ROOT;
  let keepTempHome = false;
  let fixturePath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = requireArrayValue(argv, index, `Missing CLI argument at index ${index}.`);

    if (argument === '--help' || argument === '-h') {
      return {
        ok: false,
        helpText: renderFeasibilityHelp(),
        exitCode: 0,
      };
    }

    if (argument === '--target-url') {
      targetUrl = readFlagValue({ argv, index, flag: '--target-url' });
      index += 1;
      continue;
    }

    if (argument === '--route-check-ip') {
      routeCheckIp = readFlagValue({ argv, index, flag: '--route-check-ip' });
      index += 1;
      continue;
    }

    if (argument === '--logical-exit-count') {
      const rawCount = readFlagValue({ argv, index, flag: '--logical-exit-count' });
      const parsedCount = readLogicalExitCount(rawCount);

      if (!parsedCount) {
        return {
          ok: false,
          helpText: renderFeasibilityHelp(),
          exitCode: 1,
          error: `Invalid --logical-exit-count value: ${rawCount}. Expected 2 or 3.`,
        };
      }

      logicalExitCount = parsedCount;
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

    if (argument === '--keep-temp-home') {
      keepTempHome = true;
      continue;
    }

    return {
      ok: false,
      helpText: renderFeasibilityHelp(),
      exitCode: 1,
      error: `Unknown argument: ${argument}`,
    };
  }

  return {
    ok: true,
    options: {
      targetUrl,
      routeCheckIp,
      logicalExitCount,
      outputRoot,
      keepTempHome,
      ...(fixturePath ? { fixturePath } : {}),
      ...(env.MULLGATE_ACCOUNT_NUMBER?.trim()
        ? { accountNumber: env.MULLGATE_ACCOUNT_NUMBER.trim() }
        : {}),
      ...(env.MULLGATE_PROXY_USERNAME?.trim()
        ? { proxyUsername: env.MULLGATE_PROXY_USERNAME.trim() }
        : {}),
      ...(env.MULLGATE_PROXY_PASSWORD?.trim()
        ? { proxyPassword: env.MULLGATE_PROXY_PASSWORD.trim() }
        : {}),
      ...(env.MULLGATE_DEVICE_NAME?.trim() ? { deviceName: env.MULLGATE_DEVICE_NAME.trim() } : {}),
      ...(env.MULLGATE_MULLVAD_WG_URL?.trim()
        ? { mullvadWgUrl: env.MULLGATE_MULLVAD_WG_URL.trim() }
        : {}),
      ...(env.MULLGATE_MULLVAD_RELAYS_URL?.trim()
        ? { mullvadRelaysUrl: env.MULLGATE_MULLVAD_RELAYS_URL.trim() }
        : {}),
      ...(env.MULLGATE_M004_WIREPROXY_IMAGE?.trim()
        ? { wireproxyImage: env.MULLGATE_M004_WIREPROXY_IMAGE.trim() }
        : {}),
    },
  };
}

export function renderFeasibilityHelp(): string {
  return [
    'Usage: pnpm exec tsx scripts/verify-m004-feasibility.ts [options]',
    '',
    'Run the isolated M004 feasibility verifier: provision exactly one Mullvad',
    'WireGuard device into a temp workspace, start one shared entry wireproxy',
    'runtime without touching `mullgate start`, chain 2-3 concurrent probes',
    'through distinct Mullvad SOCKS5 relays, compare host-route snapshots, and',
    'write a secret-safe PASS/FAIL artifact bundle under the chosen output root.',
    '',
    'Required environment variables for live runs:',
    '  MULLGATE_ACCOUNT_NUMBER       Live Mullvad account number used to provision one device.',
    '  MULLGATE_PROXY_USERNAME       Username for the local shared-entry SOCKS listener.',
    '  MULLGATE_PROXY_PASSWORD       Password for the local shared-entry SOCKS listener.',
    '  MULLGATE_DEVICE_NAME          Deterministic Mullvad device label for the one-device experiment.',
    '',
    'Optional environment variables:',
    `  MULLGATE_VERIFY_TARGET_URL   Exit-check endpoint (default: ${DEFAULT_TARGET_URL})`,
    `  MULLGATE_VERIFY_ROUTE_CHECK_IP Direct-route check IP (default: ${DEFAULT_ROUTE_CHECK_IP})`,
    `  MULLGATE_MULLVAD_WG_URL      Override Mullvad WireGuard provisioning endpoint.`,
    `  MULLGATE_MULLVAD_RELAYS_URL  Override the legacy Mullvad relay endpoint with SOCKS metadata (default: ${DEFAULT_RELAYS_URL})`,
    '  MULLGATE_M004_LOGICAL_EXIT_COUNT Requested logical exit count (2 or 3, default: 3).',
    '  MULLGATE_M004_WIREPROXY_IMAGE Override the Docker image used for the shared entry runtime.',
    '',
    'Fixture mode:',
    '  Pass --fixture <path> to skip all live Mullvad/Docker work and re-render a',
    '  deterministic summary bundle from a checked-in feasibility artifact fixture.',
    '',
    'Options:',
    `  --target-url <url>           Exit-check endpoint to query (default: ${DEFAULT_TARGET_URL})`,
    `  --route-check-ip <ip>        Direct-route IP used for host-route drift checks (default: ${DEFAULT_ROUTE_CHECK_IP})`,
    '  --logical-exit-count <2|3>    Requested logical exit count for the experiment (default: 3).',
    `  --output-root <path>         Directory that receives the latest summary bundle (default: ${DEFAULT_OUTPUT_ROOT})`,
    '  --fixture <path>              Replay a checked-in feasibility artifact fixture instead of running live provisioning.',
    '  --keep-temp-home              Preserve the temp verifier workspace even on success.',
    '  -h, --help                    Show this help text.',
    '',
    'When the live experiment fails or returns a FAIL verdict, the verifier keeps a',
    'redacted temp workspace so future agents can inspect recorded commands, route',
    'snapshots, the generated wireproxy config, and probe artifacts without leaking',
    'raw Mullvad credentials or private keys.',
    '',
  ].join('\n');
}

export async function runFeasibilityVerifier(
  options: FeasibilityRunnerOptions,
): Promise<FeasibilityRunnerResult> {
  const outputDir = await prepareLatestOutputDir({ outputRoot: options.outputRoot });

  if (options.fixturePath) {
    const fixtureArtifact = JSON.parse(
      await readFile(options.fixturePath, 'utf8'),
    ) as FeasibilityArtifact;
    await writeSummaryArtifacts({
      outputDir,
      artifact: fixtureArtifact,
      additionalSecrets: [],
    });

    return {
      exitCode: 0,
      outputDir,
      summaryJsonPath: path.join(outputDir, 'summary.json'),
      summaryTextPath: path.join(outputDir, 'summary.txt'),
      artifact: fixtureArtifact,
      preservedWorkspace: true,
    };
  }

  const liveInputs = resolveLiveInputs(options);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'mullgate-m004-'));
  const artifactsDir = path.join(workspaceRoot, 'artifacts');
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  const cleanupFailures: string[] = [];

  const context: RunnerContext = {
    phase: 'initializing',
    workspaceRoot,
    artifactsDir,
    outputDir,
    secrets: new Set<string>([
      liveInputs.accountNumber,
      liveInputs.proxyUsername,
      liveInputs.proxyPassword,
    ]),
    cleanupFailures,
    routeBefore: null,
    routeAfter: null,
    entryRelay: null,
    logicalExits: [],
    relaySelection: {
      requestedCount: liveInputs.logicalExitCount,
      availableCount: 0,
      candidateCount: 0,
      missingMetadataCount: 0,
      selectedRelayHostnames: [],
    },
    containerName: null,
    socksPort: null,
    wireproxyConfigPath: null,
    wireproxyConfigText: null,
    artifact: null,
    selectedCatalog: null,
  };

  let preserveWorkspace = options.keepTempHome;
  let exitCode: 0 | 1 = 0;

  try {
    await verifyLivePrerequisites({ context, liveInputs });

    context.phase = 'relay-selection';
    logPhase({
      phase: context.phase,
      message: 'Fetching Mullvad relay metadata with SOCKS annotations.',
    });
    const relaysResult = await fetchRelays({ url: liveInputs.mullvadRelaysUrl });

    if (!relaysResult.ok) {
      throw new Error(
        `${relaysResult.message}${relaysResult.cause ? ` Cause: ${relaysResult.cause}` : ''}`,
      );
    }

    context.selectedCatalog = relaysResult.value;
    context.entryRelay = chooseEntryRelay({ catalog: relaysResult.value });
    context.relaySelection = createRelaySelectionSummary({
      requestedCount: liveInputs.logicalExitCount,
      availableCount: 0,
      candidateCount: relaysResult.value.relays.length,
      missingMetadataCount: 0,
      selectedRelayHostnames: [],
    });

    if (!context.entryRelay) {
      throw new Error(
        'No active Mullvad WireGuard relay was available to act as the shared entry tunnel.',
      );
    }

    const relaySelectionResult = selectFeasibilityExitRelays({
      catalog: relaysResult.value,
      count: liveInputs.logicalExitCount,
      entryRelayHostname: context.entryRelay.hostname,
    });

    if (relaySelectionResult.ok) {
      context.logicalExits = relaySelectionResult.selected;
      context.relaySelection = createRelaySelectionSummary({
        requestedCount: relaySelectionResult.requestedCount,
        availableCount: relaySelectionResult.availableCount,
        candidateCount: relaySelectionResult.candidateCount,
        missingMetadataCount: relaySelectionResult.missingMetadataCount,
        selectedRelayHostnames: relaySelectionResult.selected.map((relay) => relay.relayHostname),
      });
    } else {
      context.logicalExits = [];
      context.relaySelection = createRelaySelectionSummary({
        requestedCount: relaySelectionResult.requestedCount,
        availableCount: relaySelectionResult.availableCount,
        candidateCount: relaySelectionResult.candidateCount,
        missingMetadataCount: relaySelectionResult.missingMetadataCount,
        selectedRelayHostnames: [],
      });
    }

    context.routeBefore = await captureRouteSnapshot({
      context,
      targetIp: liveInputs.routeCheckIp,
      label: 'route-before',
    });

    if (!relaySelectionResult.ok) {
      const insufficientArtifact = createFeasibilityArtifact({
        generatedAt: new Date().toISOString(),
        topology: createSingleEntryTopology({
          entryIdentity: createEntryIdentityFromRelay({
            relay: context.entryRelay,
            deviceName: liveInputs.deviceName,
            accountNumber: liveInputs.accountNumber,
          }),
          logicalExits: context.logicalExits,
        }),
        relaySelection: context.relaySelection,
        routeCheck: {
          before: context.routeBefore,
          after: context.routeBefore,
        },
        probes: [],
      });

      context.artifact = insufficientArtifact;
      await finalizeCompletedRun({
        context,
        artifact: insufficientArtifact,
        liveInputs,
      });
      preserveWorkspace = true;

      return {
        exitCode: 0,
        outputDir,
        summaryJsonPath: path.join(outputDir, 'summary.json'),
        summaryTextPath: path.join(outputDir, 'summary.txt'),
        workspacePath: workspaceRoot,
        artifact: insufficientArtifact,
        preservedWorkspace: true,
      };
    }

    context.phase = 'provision-device';
    logPhase({
      phase: context.phase,
      message: 'Provisioning exactly one Mullvad WireGuard device for the entry tunnel.',
    });
    const provisionResult = await provisionWireguard({
      accountNumber: liveInputs.accountNumber,
      deviceName: liveInputs.deviceName,
      ...(liveInputs.mullvadWgUrl ? { baseUrl: liveInputs.mullvadWgUrl } : {}),
    });

    await writeJsonArtifact({
      outputDir: context.artifactsDir,
      fileName: 'provision-result.json',
      value: provisionResult,
      secrets: context.secrets,
    });

    if (!provisionResult.ok) {
      throw new Error(
        `${provisionResult.message}${provisionResult.cause ? ` Cause: ${provisionResult.cause}` : ''}`,
      );
    }

    context.secrets.add(provisionResult.value.privateKey);

    context.phase = 'runtime-render';
    logPhase({
      phase: context.phase,
      message: 'Rendering and validating the isolated entry wireproxy config.',
    });
    context.socksPort = await allocateFreePort();
    const httpPort = await allocateFreePort();
    context.wireproxyConfigPath = path.join(workspaceRoot, 'wireproxy-entry.conf');
    context.wireproxyConfigText = buildEntryWireproxyConfig({
      entryRelay: context.entryRelay,
      provisioned: provisionResult.value,
      proxyUsername: liveInputs.proxyUsername,
      proxyPassword: liveInputs.proxyPassword,
      socksPort: context.socksPort,
      httpPort,
    });

    await writeTextArtifact({
      outputDir: workspaceRoot,
      fileName: 'wireproxy-entry.conf',
      value: context.wireproxyConfigText,
      secrets: context.secrets,
      mode: 0o600,
    });

    const validationResult = await validateWireproxyConfig({
      configPath: context.wireproxyConfigPath,
      configText: context.wireproxyConfigText,
      reportPath: path.join(context.artifactsDir, 'wireproxy-configtest.json'),
    });

    if (!validationResult.ok) {
      throw new Error(
        `The isolated entry wireproxy config failed validation: ${validationResult.cause}`,
      );
    }

    context.phase = 'runtime-start';
    logPhase({ phase: context.phase, message: 'Starting the shared entry wireproxy container.' });
    context.containerName = `mullgate-m004-${Date.now()}`;
    const startResult = await runRecordedCommand({
      context,
      label: 'docker-run-entry',
      command: 'docker',
      args: [
        'run',
        '--detach',
        '--rm',
        '--name',
        context.containerName,
        '--user',
        '0:0',
        '--publish',
        `127.0.0.1:${context.socksPort}:${context.socksPort}`,
        '--volume',
        `${context.wireproxyConfigPath}:${DEFAULT_WIREPROXY_CONTAINER_PATH}:ro`,
        liveInputs.wireproxyImage,
        '--config',
        DEFAULT_WIREPROXY_CONTAINER_PATH,
      ],
      displayCommand: [
        'docker run --detach --rm',
        `--name ${context.containerName}`,
        '--user 0:0',
        `--publish 127.0.0.1:${context.socksPort}:${context.socksPort}`,
        `--volume ${context.wireproxyConfigPath}:${DEFAULT_WIREPROXY_CONTAINER_PATH}:ro`,
        liveInputs.wireproxyImage,
        `--config ${DEFAULT_WIREPROXY_CONTAINER_PATH}`,
      ].join(' '),
    });

    if (startResult.exitCode !== 0) {
      throw new Error(
        `Failed to start the isolated entry wireproxy container. Inspect ${startResult.stderrPath}.`,
      );
    }

    await waitForPort({ host: '127.0.0.1', port: context.socksPort, timeoutMs: 30_000 });
    context.routeAfter = await captureRouteSnapshot({
      context,
      targetIp: liveInputs.routeCheckIp,
      label: 'route-after',
    });

    context.phase = 'probe-execution';
    logPhase({
      phase: context.phase,
      message: `Running ${context.logicalExits.length} concurrent chained SOCKS probes through the shared entry tunnel.`,
    });
    const probeResults = await Promise.all(
      context.logicalExits.map(async (logicalExit) => {
        return runChainedProbe({
          context,
          input: {
            logicalExit,
            localSocksPort: requireDefined(
              context.socksPort,
              'SOCKS port should be available before running chained probes.',
            ),
            proxyUsername: liveInputs.proxyUsername,
            proxyPassword: liveInputs.proxyPassword,
            targetUrl: liveInputs.targetUrl,
          },
        });
      }),
    );

    const artifact = createFeasibilityArtifact({
      generatedAt: new Date().toISOString(),
      topology: createSingleEntryTopology({
        entryIdentity: createEntryIdentityFromRelay({
          relay: context.entryRelay,
          deviceName: liveInputs.deviceName,
          accountNumber: liveInputs.accountNumber,
          wireguardPrivateKey: provisionResult.value.privateKey,
        }),
        logicalExits: context.logicalExits,
      }),
      relaySelection: context.relaySelection,
      routeCheck: {
        before: context.routeBefore,
        after: context.routeAfter,
      },
      probes: probeResults,
    });
    context.artifact = artifact;

    await finalizeCompletedRun({
      context,
      artifact,
      liveInputs,
    });

    if (artifact.verdict.status === 'fail') {
      preserveWorkspace = true;
    }

    return {
      exitCode: 0,
      outputDir,
      summaryJsonPath: path.join(outputDir, 'summary.json'),
      summaryTextPath: path.join(outputDir, 'summary.txt'),
      ...(preserveWorkspace ? { workspacePath: workspaceRoot } : {}),
      artifact,
      preservedWorkspace: preserveWorkspace,
    };
  } catch (error) {
    exitCode = 1;
    preserveWorkspace = true;
    const failureArtifact = createFailureArtifact({
      context,
      liveInputs,
      error,
    });
    context.artifact = failureArtifact;
    await finalizeCompletedRun({
      context,
      artifact: failureArtifact,
      liveInputs,
    });

    return {
      exitCode,
      outputDir,
      summaryJsonPath: path.join(outputDir, 'summary.json'),
      summaryTextPath: path.join(outputDir, 'summary.txt'),
      workspacePath: workspaceRoot,
      artifact: failureArtifact,
      preservedWorkspace: true,
    };
  } finally {
    await cleanupLiveWorkspace({ context });

    if (preserveWorkspace) {
      await sanitizePreservedWorkspace({ context });
    } else {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

function resolveLiveInputs(options: FeasibilityRunnerOptions): Required<
  Pick<FeasibilityRunnerOptions, 'accountNumber' | 'proxyUsername' | 'proxyPassword' | 'deviceName'>
> & {
  readonly targetUrl: string;
  readonly routeCheckIp: string;
  readonly logicalExitCount: 2 | 3;
  readonly mullvadWgUrl?: string;
  readonly mullvadRelaysUrl: string;
  readonly wireproxyImage: string;
} {
  const missingKeys: RequiredEnvKey[] = REQUIRED_ENV_KEYS.filter((key) => {
    if (key === 'MULLGATE_ACCOUNT_NUMBER') {
      return !options.accountNumber?.trim();
    }
    if (key === 'MULLGATE_PROXY_USERNAME') {
      return !options.proxyUsername?.trim();
    }
    if (key === 'MULLGATE_PROXY_PASSWORD') {
      return !options.proxyPassword?.trim();
    }
    return !options.deviceName?.trim();
  });

  if (missingKeys.length > 0) {
    throw new Error(
      `Missing required environment variables for the live verifier: ${missingKeys.join(', ')}.`,
    );
  }

  const accountNumber = options.accountNumber?.trim();
  const proxyUsername = options.proxyUsername?.trim();
  const proxyPassword = options.proxyPassword?.trim();
  const deviceName = options.deviceName?.trim();

  if (!accountNumber || !proxyUsername || !proxyPassword || !deviceName) {
    throw new Error('Live verifier inputs are incomplete after validation.');
  }

  return {
    accountNumber,
    proxyUsername,
    proxyPassword,
    deviceName,
    targetUrl: options.targetUrl,
    routeCheckIp: options.routeCheckIp,
    logicalExitCount: options.logicalExitCount,
    ...(options.mullvadWgUrl ? { mullvadWgUrl: options.mullvadWgUrl } : {}),
    mullvadRelaysUrl: options.mullvadRelaysUrl ?? DEFAULT_RELAYS_URL,
    wireproxyImage: options.wireproxyImage ?? DEFAULT_WIREPROXY_IMAGE,
  };
}

async function verifyLivePrerequisites(input: {
  readonly context: RunnerContext;
  readonly liveInputs: ReturnType<typeof resolveLiveInputs>;
}): Promise<void> {
  input.context.phase = 'prerequisite-check';
  logPhase({
    phase: input.context.phase,
    message: 'Checking Node, pnpm, Docker, curl, and Linux route prerequisites.',
  });

  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0');

  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    throw new Error(
      `Node.js 22+ is required, but this process is running ${process.versions.node}.`,
    );
  }

  const prerequisiteCommands = [
    { label: 'prereq-pnpm', command: 'pnpm', args: ['--version'] },
    { label: 'prereq-docker', command: 'docker', args: ['--version'] },
    { label: 'prereq-docker-compose', command: 'docker', args: ['compose', 'version'] },
    { label: 'prereq-curl', command: 'curl', args: ['--version'] },
    {
      label: 'prereq-ip-route',
      command: 'ip',
      args: ['route', 'get', input.liveInputs.routeCheckIp],
    },
  ] as const;

  for (const entry of prerequisiteCommands) {
    const result = await runRecordedCommand({
      context: input.context,
      label: entry.label,
      command: entry.command,
      args: [...entry.args],
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Prerequisite command failed: ${result.renderedCommand}. Inspect ${result.stderrPath}.`,
      );
    }
  }
}

function chooseEntryRelay(input: { readonly catalog: MullvadRelayCatalog }): MullvadRelay | null {
  const sorted = [...input.catalog.relays].sort((left, right) => {
    return (
      Number(right.active) - Number(left.active) ||
      left.location.countryCode.localeCompare(right.location.countryCode) ||
      left.location.cityCode.localeCompare(right.location.cityCode) ||
      left.hostname.localeCompare(right.hostname)
    );
  });

  return sorted.find((relay) => relay.active) ?? null;
}

function createRelaySelectionSummary(
  input: FeasibilityRelaySelectionSummary,
): FeasibilityRelaySelectionSummary {
  return {
    requestedCount: input.requestedCount,
    availableCount: input.availableCount,
    candidateCount: input.candidateCount,
    missingMetadataCount: input.missingMetadataCount,
    selectedRelayHostnames: [...input.selectedRelayHostnames],
  };
}

function buildEntryWireproxyConfig(input: {
  readonly entryRelay: MullvadRelay;
  readonly provisioned: {
    readonly privateKey: string;
    readonly interfaceAddresses: readonly [string, ...string[]];
  };
  readonly proxyUsername: string;
  readonly proxyPassword: string;
  readonly socksPort: number;
  readonly httpPort: number;
}): string {
  const lines: string[] = [
    '# Generated by the isolated M004 feasibility verifier.',
    '[Interface]',
    `Address = ${input.provisioned.interfaceAddresses.join(', ')}`,
    `PrivateKey = ${input.provisioned.privateKey}`,
    `DNS = ${DEFAULT_DNS_SERVER}`,
    '',
    '[Peer]',
    `PublicKey = ${input.entryRelay.publicKey}`,
    `Endpoint = ${input.entryRelay.fqdn}:${input.entryRelay.multihopPort ?? DEFAULT_WIREGUARD_PORT}`,
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'PersistentKeepalive = 25',
    '',
    '[Socks5]',
    `BindAddress = 0.0.0.0:${input.socksPort}`,
    `Username = ${input.proxyUsername}`,
    `Password = ${input.proxyPassword}`,
    '',
    '[http]',
    `BindAddress = 0.0.0.0:${input.httpPort}`,
    `Username = ${input.proxyUsername}`,
    `Password = ${input.proxyPassword}`,
    '',
  ];

  return `${lines.join('\n')}\n`;
}

async function captureRouteSnapshot(input: {
  readonly context: RunnerContext;
  readonly targetIp: string;
  readonly label: string;
}): Promise<HostRouteSnapshot> {
  const result = await runRecordedCommand({
    context: input.context,
    label: input.label,
    command: 'ip',
    args: ['route', 'get', input.targetIp],
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to capture host route baseline with ${result.renderedCommand}. Inspect ${result.stderrPath}.`,
    );
  }

  return {
    checkedAt: new Date().toISOString(),
    targetIp: input.targetIp,
    command: result.renderedCommand,
    normalizedRoute: normalizeWhitespace(result.stdout),
    stdout: result.stdout,
    stderr: result.stderr,
    artifactPath: result.stdoutPath,
  };
}

async function runChainedProbe(input: {
  readonly context: RunnerContext;
  readonly input: ProbeInput;
}): Promise<FeasibilityProbeObservation> {
  const startedAt = new Date().toISOString();
  const preproxyUrl = `socks5h://${encodeURIComponent(input.input.proxyUsername)}:${encodeURIComponent(input.input.proxyPassword)}@127.0.0.1:${input.input.localSocksPort}`;
  const chainedProxyUrl = `socks5h://${input.input.logicalExit.socksHostname}:${input.input.logicalExit.socksPort}`;
  const label = `probe-${input.input.logicalExit.logicalExitId}`;
  const commandResult = await runRecordedCommand({
    context: input.context,
    label,
    command: 'curl',
    args: [
      '--silent',
      '--show-error',
      '--fail',
      '--location',
      '--connect-timeout',
      '20',
      '--max-time',
      '120',
      '--preproxy',
      preproxyUrl,
      '--proxy',
      chainedProxyUrl,
      input.input.targetUrl,
    ],
    displayCommand: [
      'curl --silent --show-error --fail --location --connect-timeout 20 --max-time 120',
      `--preproxy socks5h://${REDACTED}:${REDACTED}@127.0.0.1:${input.input.localSocksPort}`,
      `--proxy socks5h://${input.input.logicalExit.socksHostname}:${input.input.logicalExit.socksPort}`,
      input.input.targetUrl,
    ].join(' '),
  });
  const completedAt = new Date().toISOString();

  if (commandResult.exitCode !== 0) {
    return {
      ok: false,
      logicalExitId: input.input.logicalExit.logicalExitId,
      targetUrl: input.input.targetUrl,
      proxyUrl: chainedProxyUrl,
      startedAt,
      completedAt,
      durationMs: commandResult.durationMs,
      code: 'CHAINED_CURL_FAILED',
      message: `The chained curl probe for ${input.input.logicalExit.logicalExitId} failed. Inspect ${commandResult.stderrPath}.`,
      stdoutArtifactPath: commandResult.stdoutPath,
      stderrArtifactPath: commandResult.stderrPath,
    };
  }

  const parsed = parseProbePayload({
    raw: commandResult.stdout,
    logicalExitId: input.input.logicalExit.logicalExitId,
    stderrPath: commandResult.stderrPath,
  });

  if (!parsed.ok) {
    return {
      ok: false,
      logicalExitId: input.input.logicalExit.logicalExitId,
      targetUrl: input.input.targetUrl,
      proxyUrl: chainedProxyUrl,
      startedAt,
      completedAt,
      durationMs: commandResult.durationMs,
      code: 'INVALID_PROBE_PAYLOAD',
      message: parsed.message,
      stdoutArtifactPath: commandResult.stdoutPath,
      stderrArtifactPath: commandResult.stderrPath,
    };
  }

  return {
    ok: true,
    logicalExitId: input.input.logicalExit.logicalExitId,
    targetUrl: input.input.targetUrl,
    proxyUrl: chainedProxyUrl,
    startedAt,
    completedAt,
    durationMs: commandResult.durationMs,
    stdoutArtifactPath: commandResult.stdoutPath,
    stderrArtifactPath: commandResult.stderrPath,
    observedExit: parsed.value,
  };
}

function parseProbePayload(input: {
  readonly raw: string;
  readonly logicalExitId: string;
  readonly stderrPath: string;
}):
  | {
      readonly ok: true;
      readonly value: {
        readonly ip: string;
        readonly country: string;
        readonly city: string;
        readonly hostname?: string | null;
      };
    }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  try {
    const parsed = JSON.parse(input.raw) as Record<string, unknown>;
    const ip = typeof parsed.ip === 'string' ? parsed.ip : null;
    const country = typeof parsed.country === 'string' ? parsed.country : null;
    const city = typeof parsed.city === 'string' ? parsed.city : null;

    if (!ip || !country || !city) {
      return {
        ok: false,
        message: `The chained curl probe for ${input.logicalExitId} returned JSON without ip/country/city fields. Inspect ${input.stderrPath}.`,
      };
    }

    return {
      ok: true,
      value: {
        ip,
        country,
        city,
        ...(typeof parsed.hostname === 'string' ? { hostname: parsed.hostname } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: `The chained curl probe for ${input.logicalExitId} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

function createFailureArtifact(input: {
  readonly context: RunnerContext;
  readonly liveInputs: ReturnType<typeof resolveLiveInputs>;
  readonly error: unknown;
}): FeasibilityArtifact {
  const failureMessage = input.error instanceof Error ? input.error.message : String(input.error);
  const prerequisiteFailures: FeasibilityPrerequisiteFailure[] = [
    {
      code: input.context.phase.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
      message: failureMessage,
      artifactPath: input.context.artifactsDir,
    },
  ];
  const entryRelay = input.context.entryRelay ?? createFallbackEntryRelay();

  return createFeasibilityArtifact({
    generatedAt: new Date().toISOString(),
    topology: createSingleEntryTopology({
      entryIdentity: createEntryIdentityFromRelay({
        relay: entryRelay,
        deviceName: input.liveInputs.deviceName,
        accountNumber: input.liveInputs.accountNumber,
      }),
      logicalExits: input.context.logicalExits,
    }),
    relaySelection: input.context.relaySelection,
    prerequisiteFailures,
    routeCheck: {
      before: input.context.routeBefore,
      after: input.context.routeAfter,
    },
    probes: [],
  });
}

function createFallbackEntryRelay(): MullvadRelay {
  return {
    hostname: 'unknown-entry-relay',
    fqdn: 'unknown-entry-relay.relays.mullvad.net',
    source: 'www-relays-all',
    active: false,
    owned: false,
    publicKey: 'unknown-public-key',
    endpointIpv4: '0.0.0.0',
    location: {
      countryCode: 'zz',
      countryName: 'Unknown',
      cityCode: 'unknown',
      cityName: 'Unknown',
    },
  };
}

async function finalizeCompletedRun(input: {
  readonly context: RunnerContext;
  readonly artifact: FeasibilityArtifact;
  readonly liveInputs: ReturnType<typeof resolveLiveInputs>;
}): Promise<void> {
  const additionalSecrets = [
    input.liveInputs.proxyUsername,
    input.liveInputs.proxyPassword,
    input.liveInputs.accountNumber,
  ];
  await writeSummaryArtifacts({
    outputDir: input.context.outputDir,
    artifact: input.artifact,
    additionalSecrets,
    workspacePath: input.context.workspaceRoot,
  });
  await writeJsonArtifact({
    outputDir: input.context.artifactsDir,
    fileName: 'artifact.json',
    value: JSON.parse(
      serializeFeasibilityArtifact({ artifact: input.artifact, additionalSecrets }),
    ),
    secrets: input.context.secrets,
  });
}

async function writeSummaryArtifacts(input: {
  readonly outputDir: string;
  readonly artifact: FeasibilityArtifact;
  readonly additionalSecrets: readonly string[];
  readonly workspacePath?: string;
}): Promise<void> {
  const serialized = serializeFeasibilityArtifact({
    artifact: input.artifact,
    additionalSecrets: input.additionalSecrets,
  });
  const summaryLines = renderSummaryLines({
    artifact: input.artifact,
    workspacePath: input.workspacePath,
  });

  await writeFile(path.join(input.outputDir, 'summary.json'), `${serialized}\n`, { mode: 0o600 });
  await writeFile(path.join(input.outputDir, 'summary.txt'), `${summaryLines.join('\n')}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${summaryLines.join('\n')}\n`);
}

function renderSummaryLines(input: {
  readonly artifact: FeasibilityArtifact;
  readonly workspacePath?: string;
}): string[] {
  const lines: string[] = [
    `M004 feasibility verdict: ${input.artifact.verdict.status.toUpperCase()}`,
    `reason: ${input.artifact.verdict.reason}`,
    `phase: ${input.artifact.verdict.phase}`,
    `stop reason: ${input.artifact.verdict.stopReason}`,
    `entry relay: ${input.artifact.topology.entryIdentity.relayHostname}`,
    `requested exits: ${input.artifact.summary.requestedLogicalExitCount}`,
    `successful probes: ${input.artifact.summary.successfulProbeCount}`,
    `failed probes: ${input.artifact.summary.failedProbeCount}`,
    `distinct observed exits: ${input.artifact.summary.distinctObservedExitCount}`,
    `route unchanged: ${String(input.artifact.summary.routeUnchanged)}`,
  ];

  if (input.artifact.routeCheck.before && input.artifact.routeCheck.after) {
    lines.push(`route before: ${input.artifact.routeCheck.before.normalizedRoute}`);
    lines.push(`route after: ${input.artifact.routeCheck.after.normalizedRoute}`);
  }

  for (const logicalExit of input.artifact.topology.logicalExits) {
    const probe = input.artifact.probes.find(
      (candidate) => candidate.logicalExitId === logicalExit.logicalExitId,
    );

    if (!probe) {
      lines.push(
        `${logicalExit.logicalExitId}: relay=${logicalExit.relayHostname}, observed=not-run`,
      );
      continue;
    }

    if (!probe.ok) {
      lines.push(
        `${logicalExit.logicalExitId}: relay=${logicalExit.relayHostname}, observed=error (${probe.code ?? 'unknown'})`,
      );
      continue;
    }

    lines.push(
      `${logicalExit.logicalExitId}: relay=${logicalExit.relayHostname}, observed=${probe.observedExit.ip} ${probe.observedExit.country}/${probe.observedExit.city}, duration_ms=${probe.durationMs}`,
    );
  }

  if (input.workspacePath) {
    lines.push(`workspace: ${input.workspacePath}`);
  }

  return lines;
}

async function prepareLatestOutputDir(input: { readonly outputRoot: string }): Promise<string> {
  const resolvedRoot = path.resolve(input.outputRoot);
  const latestDir = path.join(resolvedRoot, 'latest');
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  await rm(latestDir, { recursive: true, force: true });
  await mkdir(latestDir, { recursive: true, mode: 0o700 });
  return latestDir;
}

async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close((error) => {
          reject(error ?? new Error('Failed to allocate a free TCP port.'));
        });
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForPort(input: {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: input.host, port: input.port });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      return;
    }

    await delay({ ms: 500 });
  }

  throw new Error(`Timed out waiting for ${input.host}:${input.port} to accept connections.`);
}

async function cleanupLiveWorkspace(input: { readonly context: RunnerContext }): Promise<void> {
  if (!input.context.containerName) {
    return;
  }

  const result = await runRecordedCommand({
    context: input.context,
    label: 'docker-rm-entry',
    command: 'docker',
    args: ['rm', '--force', input.context.containerName],
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    input.context.cleanupFailures.push(message);
    return null;
  });

  if (result && result.exitCode !== 0) {
    input.context.cleanupFailures.push(
      `docker rm --force ${input.context.containerName} failed. Inspect ${result.stderrPath}.`,
    );
  }
}

async function sanitizePreservedWorkspace(input: {
  readonly context: RunnerContext;
}): Promise<void> {
  if (!input.context.wireproxyConfigPath || !input.context.wireproxyConfigText) {
    return;
  }

  const redactedConfig = redactKnownStrings({
    value: input.context.wireproxyConfigText,
    secrets: [...input.context.secrets],
  });
  await writeFile(
    input.context.wireproxyConfigPath,
    `${redactedConfig.endsWith('\n') ? redactedConfig : `${redactedConfig}\n`}`,
    { mode: 0o600 },
  );
  await chmod(input.context.wireproxyConfigPath, 0o600);
}

async function runRecordedCommand(input: {
  readonly context: RunnerContext;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly displayCommand?: string;
}): Promise<CommandResult> {
  await mkdir(input.context.artifactsDir, { recursive: true, mode: 0o700 });
  const slug = input.label.replace(/[^a-zA-Z0-9.-]+/g, '-');
  const stdoutPath = path.join(input.context.artifactsDir, `${slug}.stdout.txt`);
  const stderrPath = path.join(input.context.artifactsDir, `${slug}.stderr.txt`);
  const metadataPath = path.join(input.context.artifactsDir, `${slug}.json`);
  const renderedCommand =
    input.displayCommand ?? renderCommand({ command: input.command, args: input.args });
  const startedAt = Date.now();
  const result = await runCommand({
    command: input.command,
    args: input.args,
  });
  const durationMs = Date.now() - startedAt;
  const sanitizedStdout = redactKnownStrings({
    value: result.stdout,
    secrets: [...input.context.secrets],
  });
  const sanitizedStderr = redactKnownStrings({
    value: result.stderr,
    secrets: [...input.context.secrets],
  });
  const sanitizedCommand = redactKnownStrings({
    value: renderedCommand,
    secrets: [...input.context.secrets],
  });

  await Promise.all([
    writeFile(stdoutPath, sanitizedStdout, { mode: 0o600 }),
    writeFile(stderrPath, sanitizedStderr, { mode: 0o600 }),
    writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          label: input.label,
          phase: input.context.phase,
          command: sanitizedCommand,
          exitCode: result.exitCode,
          durationMs,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    ),
  ]);

  return {
    exitCode: result.exitCode,
    stdout: sanitizedStdout,
    stderr: sanitizedStderr,
    durationMs,
    stdoutPath,
    stderrPath,
    metadataPath,
    renderedCommand: sanitizedCommand,
  };
}

async function runCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
}): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: 'pipe',
      env: process.env,
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
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function renderCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
}): string {
  return [input.command, ...input.args.map((value) => shellEscape({ value }))].join(' ');
}

function shellEscape(input: { readonly value: string }): string {
  if (/^[a-zA-Z0-9_./:=,@+-]+$/.test(input.value)) {
    return input.value;
  }

  return `'${input.value.replace(/'/g, `'\\''`)}'`;
}

function readFlagValue(input: {
  readonly argv: readonly string[];
  readonly index: number;
  readonly flag: string;
}): string {
  const value = input.argv[input.index + 1];

  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${input.flag}.`);
  }

  return value;
}

function readLogicalExitCount(value: string | undefined): 2 | 3 | null {
  if (!value) {
    return null;
  }

  if (value === '2') {
    return 2;
  }

  if (value === '3') {
    return 3;
  }

  return null;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function redactKnownStrings(input: {
  readonly value: string;
  readonly secrets: readonly string[];
}): string {
  let redacted = input.value;

  for (const secret of input.secrets) {
    if (!secret.trim()) {
      continue;
    }

    redacted = redacted.split(secret).join(REDACTED);
  }

  return redacted.replace(
    /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g,
    REDACTED,
  );
}

async function writeJsonArtifact(input: {
  readonly outputDir: string;
  readonly fileName: string;
  readonly value: unknown;
  readonly secrets: ReadonlySet<string>;
}): Promise<void> {
  const serialized = JSON.stringify(input.value, null, 2);
  const sanitized = redactKnownStrings({
    value: serialized,
    secrets: [...input.secrets.values()],
  });
  await writeFile(path.join(input.outputDir, input.fileName), `${sanitized}\n`, { mode: 0o600 });
}

async function writeTextArtifact(input: {
  readonly outputDir: string;
  readonly fileName: string;
  readonly value: string;
  readonly secrets: ReadonlySet<string>;
  readonly mode: number;
}): Promise<void> {
  const sanitized = redactKnownStrings({
    value: input.value,
    secrets: [...input.secrets.values()],
  });
  await writeFile(path.join(input.outputDir, input.fileName), sanitized, { mode: input.mode });
}

async function delay(input: { readonly ms: number }): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, input.ms);
  });
}

function logPhase(input: { readonly phase: string; readonly message: string }): void {
  process.stdout.write(`[${input.phase}] ${input.message}\n`);
}
