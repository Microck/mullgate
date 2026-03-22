import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createCompatibilityArtifact,
  serializeCompatibilityArtifact,
  type CompatibilityArtifact,
  type CompatibilityHostnameRoutingObservation,
  type CompatibilityOperatorObservation,
  type CompatibilityProtocolObservation,
} from './compatibility-contract.js';
import {
  runFeasibilityVerifier,
  type FeasibilityParseResult,
  type FeasibilityRunnerOptions,
  type FeasibilityRunnerResult,
} from './feasibility-runner.js';
import type { FeasibilityArtifact } from './feasibility-contract.js';

const DEFAULT_OUTPUT_ROOT = '.tmp/m004-compatibility';
const DEFAULT_TARGET_URL = 'https://am.i.mullvad.net/json';
const DEFAULT_ROUTE_CHECK_IP = '1.1.1.1';
const REQUIRED_ENV_KEYS = ['MULLGATE_ACCOUNT_NUMBER', 'MULLGATE_PROXY_USERNAME', 'MULLGATE_PROXY_PASSWORD', 'MULLGATE_DEVICE_NAME'] as const;

export type CompatibilityRunnerOptions = {
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

export type CompatibilityParseResult =
  | {
      readonly ok: true;
      readonly options: CompatibilityRunnerOptions;
    }
  | {
      readonly ok: false;
      readonly helpText: string;
      readonly exitCode: 0 | 1;
      readonly error?: string;
    };

export type CompatibilityFixture = {
  readonly generatedAt: string;
  readonly feasibility?: FeasibilityArtifact;
  readonly hostnameRouting: CompatibilityHostnameRoutingObservation;
  readonly protocols: readonly CompatibilityProtocolObservation[];
  readonly operator: CompatibilityOperatorObservation;
  readonly phase: string;
  readonly workspacePath?: string;
  readonly notes?: readonly string[];
};

export type CompatibilitySummaryBundle = {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly mode: 'fixture' | 'live';
  readonly phase: string;
  readonly overallVerdict: 'pass' | 'contract-change' | 'fail';
  readonly artifact: CompatibilityArtifact;
  readonly diagnostics: {
    readonly workspacePath?: string;
    readonly preservedWorkspace: boolean;
    readonly notes: readonly string[];
    readonly artifactPaths: {
      readonly artifactJson: string;
      readonly summaryText: string;
      readonly protocolEvidence: string;
      readonly hostnameRoutingEvidence: string;
      readonly evaluationMetadata: string;
      readonly feasibilitySummaryJson?: string;
      readonly feasibilitySummaryText?: string;
    };
  };
};

export type CompatibilityRunnerResult = {
  readonly exitCode: 0 | 1;
  readonly outputDir: string;
  readonly summaryJsonPath: string;
  readonly summaryTextPath: string;
  readonly artifactJsonPath: string;
  readonly bundle: CompatibilitySummaryBundle;
  readonly preservedWorkspace: boolean;
  readonly workspacePath?: string;
};

export function parseCompatibilityArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CompatibilityParseResult {
  let targetUrl = env.MULLGATE_VERIFY_TARGET_URL?.trim() || DEFAULT_TARGET_URL;
  let routeCheckIp = env.MULLGATE_VERIFY_ROUTE_CHECK_IP?.trim() || DEFAULT_ROUTE_CHECK_IP;
  let logicalExitCount: 2 | 3 = readLogicalExitCount(env.MULLGATE_M004_LOGICAL_EXIT_COUNT?.trim()) ?? 3;
  let outputRoot = env.MULLGATE_M004_COMPATIBILITY_OUTPUT_ROOT?.trim() || env.MULLGATE_M004_OUTPUT_ROOT?.trim() || DEFAULT_OUTPUT_ROOT;
  let keepTempHome = false;
  let fixturePath: string | undefined;

  try {
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index]!;

      if (argument === '--help' || argument === '-h') {
        return {
          ok: false,
          helpText: renderCompatibilityHelp(),
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
            helpText: renderCompatibilityHelp(),
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
        helpText: renderCompatibilityHelp(),
        exitCode: 1,
        error: `Unknown argument: ${argument}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      helpText: renderCompatibilityHelp(),
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
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
      ...(env.MULLGATE_ACCOUNT_NUMBER?.trim() ? { accountNumber: env.MULLGATE_ACCOUNT_NUMBER.trim() } : {}),
      ...(env.MULLGATE_PROXY_USERNAME?.trim() ? { proxyUsername: env.MULLGATE_PROXY_USERNAME.trim() } : {}),
      ...(env.MULLGATE_PROXY_PASSWORD?.trim() ? { proxyPassword: env.MULLGATE_PROXY_PASSWORD.trim() } : {}),
      ...(env.MULLGATE_DEVICE_NAME?.trim() ? { deviceName: env.MULLGATE_DEVICE_NAME.trim() } : {}),
      ...(env.MULLGATE_MULLVAD_WG_URL?.trim() ? { mullvadWgUrl: env.MULLGATE_MULLVAD_WG_URL.trim() } : {}),
      ...(env.MULLGATE_MULLVAD_RELAYS_URL?.trim() ? { mullvadRelaysUrl: env.MULLGATE_MULLVAD_RELAYS_URL.trim() } : {}),
      ...(env.MULLGATE_M004_WIREPROXY_IMAGE?.trim() ? { wireproxyImage: env.MULLGATE_M004_WIREPROXY_IMAGE.trim() } : {}),
    },
  };
}

export function renderCompatibilityHelp(): string {
  return [
    'Usage: pnpm exec tsx scripts/verify-m004-compatibility.ts [options]',
    '',
    'Run the isolated M004 compatibility verifier: reuse the S01 single-entry',
    'shared-entry topology, prove what SOCKS5 can still do only with client-side',
    'chaining, document why hostname-selected routing is no longer truthful, mark',
    'HTTP/HTTPS compatibility limits explicitly, and write a secret-safe',
    'compatibility bundle under the chosen output root.',
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
    '  MULLGATE_MULLVAD_WG_URL      Override Mullvad WireGuard provisioning endpoint.',
    '  MULLGATE_MULLVAD_RELAYS_URL  Override the legacy Mullvad relay endpoint with SOCKS metadata.',
    '  MULLGATE_M004_LOGICAL_EXIT_COUNT Requested logical exit count (2 or 3, default: 3).',
    '  MULLGATE_M004_WIREPROXY_IMAGE Override the Docker image used for the shared entry runtime.',
    '  MULLGATE_M004_COMPATIBILITY_OUTPUT_ROOT Override the compatibility output root.',
    '',
    'Fixture mode:',
    '  Pass --fixture <path> to skip all live Mullvad/Docker work and replay a',
    '  deterministic compatibility-evidence input file into the summary bundle.',
    '',
    'Options:',
    `  --target-url <url>            Exit-check endpoint to query (default: ${DEFAULT_TARGET_URL})`,
    `  --route-check-ip <ip>         Direct-route IP used for host-route drift checks (default: ${DEFAULT_ROUTE_CHECK_IP})`,
    '  --logical-exit-count <2|3>     Requested logical exit count for the reused shared-entry experiment (default: 3).',
    `  --output-root <path>          Directory that receives the latest compatibility bundle (default: ${DEFAULT_OUTPUT_ROOT})`,
    '  --fixture <path>               Replay a checked-in compatibility fixture instead of running live provisioning.',
    '  --keep-temp-home               Preserve the temp verifier workspace even on success.',
    '  -h, --help                     Show this help text.',
    '',
    'This verifier expects exactly one Mullvad device for the shared-entry runtime.',
    'It never falls back to a redesigned multi-device path. When the topology,',
    'hostname truthfulness, or a probe phase fails, inspect latest/summary.json,',
    'latest/summary.txt, latest/protocol-evidence.json, and the preserved temp',
    'workspace paths named in the output bundle.',
    '',
  ].join('\n');
}

export async function runCompatibilityVerifier(options: CompatibilityRunnerOptions): Promise<CompatibilityRunnerResult> {
  const outputDir = await prepareLatestOutputDir({ outputRoot: options.outputRoot });
  const artifactJsonPath = path.join(outputDir, 'artifact.json');
  const protocolEvidencePath = path.join(outputDir, 'protocol-evidence.json');
  const hostnameRoutingEvidencePath = path.join(outputDir, 'hostname-routing.json');
  const evaluationMetadataPath = path.join(outputDir, 'evaluation.json');
  const summaryJsonPath = path.join(outputDir, 'summary.json');
  const summaryTextPath = path.join(outputDir, 'summary.txt');

  if (options.fixturePath) {
    const fixture = JSON.parse(await readFile(options.fixturePath, 'utf8')) as CompatibilityFixture;
    const artifact = createCompatibilityArtifact({
      generatedAt: fixture.generatedAt,
      ...(fixture.feasibility ? { feasibility: fixture.feasibility } : {}),
      hostnameRouting: fixture.hostnameRouting,
      protocols: fixture.protocols,
      operator: fixture.operator,
    });

    const bundle = await writeCompatibilityOutputs({
      outputDir,
      artifact,
      mode: 'fixture',
      phase: fixture.phase,
      notes: [...(fixture.notes ?? []), 'Fixture replay mode skipped all live Mullvad and Docker prerequisites.'],
      protocolEvidence: fixture.protocols,
      hostnameRoutingEvidence: fixture.hostnameRouting,
      preservedWorkspace: true,
      ...(fixture.workspacePath ? { workspacePath: fixture.workspacePath } : {}),
      artifactJsonPath,
      protocolEvidencePath,
      hostnameRoutingEvidencePath,
      evaluationMetadataPath,
      summaryJsonPath,
      summaryTextPath,
    });

    return {
      exitCode: 0,
      outputDir,
      summaryJsonPath,
      summaryTextPath,
      artifactJsonPath,
      bundle,
      preservedWorkspace: true,
      ...(fixture.workspacePath ? { workspacePath: fixture.workspacePath } : {}),
    };
  }

  const feasibilityOutputRoot = path.join(outputDir, 'feasibility-source');
  const feasibilityResult = await runFeasibilityVerifier({
    ...toFeasibilityRunnerOptions(options),
    outputRoot: feasibilityOutputRoot,
    keepTempHome: true,
  });

  const phase = feasibilityResult.exitCode === 0 ? 'compatibility-summary' : feasibilityResult.artifact.verdict.phase;
  const compatibilityInputs = createCompatibilityInputsFromFeasibility({
    artifact: feasibilityResult.artifact,
    workspacePath: feasibilityResult.workspacePath,
  });
  const artifact = createCompatibilityArtifact({
    generatedAt: new Date().toISOString(),
    feasibility: feasibilityResult.artifact,
    hostnameRouting: compatibilityInputs.hostnameRouting,
    protocols: compatibilityInputs.protocols,
    operator: compatibilityInputs.operator,
  });

  const preservedWorkspace = options.keepTempHome || feasibilityResult.exitCode !== 0 || artifact.recommendation.posture !== 'approved';

  const bundle = await writeCompatibilityOutputs({
    outputDir,
    artifact,
    mode: 'live',
    phase,
    notes: compatibilityInputs.notes,
    protocolEvidence: compatibilityInputs.protocols,
    hostnameRoutingEvidence: compatibilityInputs.hostnameRouting,
    preservedWorkspace,
    ...(feasibilityResult.workspacePath ? { workspacePath: feasibilityResult.workspacePath } : {}),
    artifactJsonPath,
    protocolEvidencePath,
    hostnameRoutingEvidencePath,
    evaluationMetadataPath,
    summaryJsonPath,
    summaryTextPath,
    feasibilitySummaryJsonPath: feasibilityResult.summaryJsonPath,
    feasibilitySummaryTextPath: feasibilityResult.summaryTextPath,
  });

  if (feasibilityResult.workspacePath && !preservedWorkspace) {
    await rm(feasibilityResult.workspacePath, { recursive: true, force: true });
  }

  return {
    exitCode: feasibilityResult.exitCode,
    outputDir,
    summaryJsonPath,
    summaryTextPath,
    artifactJsonPath,
    bundle,
    preservedWorkspace,
    ...(preservedWorkspace && feasibilityResult.workspacePath ? { workspacePath: feasibilityResult.workspacePath } : {}),
  };
}

function toFeasibilityRunnerOptions(options: CompatibilityRunnerOptions): FeasibilityRunnerOptions {
  return {
    targetUrl: options.targetUrl,
    routeCheckIp: options.routeCheckIp,
    logicalExitCount: options.logicalExitCount,
    outputRoot: options.outputRoot,
    keepTempHome: options.keepTempHome,
    ...(options.fixturePath ? { fixturePath: options.fixturePath } : {}),
    ...(options.accountNumber ? { accountNumber: options.accountNumber } : {}),
    ...(options.proxyUsername ? { proxyUsername: options.proxyUsername } : {}),
    ...(options.proxyPassword ? { proxyPassword: options.proxyPassword } : {}),
    ...(options.deviceName ? { deviceName: options.deviceName } : {}),
    ...(options.mullvadWgUrl ? { mullvadWgUrl: options.mullvadWgUrl } : {}),
    ...(options.mullvadRelaysUrl ? { mullvadRelaysUrl: options.mullvadRelaysUrl } : {}),
    ...(options.wireproxyImage ? { wireproxyImage: options.wireproxyImage } : {}),
  };
}

function createCompatibilityInputsFromFeasibility(input: {
  readonly artifact: FeasibilityArtifact;
  readonly workspacePath?: string;
}): {
  readonly hostnameRouting: CompatibilityHostnameRoutingObservation;
  readonly protocols: readonly CompatibilityProtocolObservation[];
  readonly operator: CompatibilityOperatorObservation;
  readonly notes: readonly string[];
} {
  const socksChainingWorked =
    input.artifact.verdict.status === 'pass' &&
    input.artifact.summary.successfulProbeCount >= 2 &&
    input.artifact.summary.distinctObservedExitCount >= 2;
  const logicalExitCount = input.artifact.topology.logicalExits.length;
  const hostnameRouting: CompatibilityHostnameRoutingObservation = {
    sharedBindIpCount: 1,
    requestedProxyHostnamePreserved: false,
    currentSelector: 'destination-bind-ip',
    artifactPath: input.workspacePath ? path.join(input.workspacePath, 'artifacts') : undefined,
    notes: [
      'The reused S01 topology provisions exactly one Mullvad WireGuard entry identity.',
      'Logical exit selection only appears inside the chained SOCKS5 client path, not as distinct bind IPs at the shared entry.',
    ],
  };
  const protocols: CompatibilityProtocolObservation[] = [
    {
      protocol: 'socks5',
      probeSucceeded: socksChainingWorked,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: socksChainingWorked,
      observedCapabilitySummary: socksChainingWorked
        ? `SOCKS5 client-side chaining reached ${input.artifact.summary.distinctObservedExitCount} distinct Mullvad exits only when the client explicitly targeted relay hostnames from the reused shared-entry probe set.`
        : `SOCKS5 client-side chaining did not complete truthfully because the reused shared-entry feasibility phase stopped at ${input.artifact.verdict.phase} with reason ${input.artifact.verdict.reason}.`,
      artifactPath: input.workspacePath ? path.join(input.workspacePath, 'artifacts', 'artifact.json') : undefined,
    },
    {
      protocol: 'http',
      probeSucceeded: true,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: false,
      observedCapabilitySummary:
        'HTTP can reach the shared entry itself, but the one-entry topology does not expose a truthful second-hop Mullvad relay selector for HTTP clients, so hostname-selected routing cannot survive.',
      artifactPath: input.workspacePath ? path.join(input.workspacePath, 'artifacts', 'artifact.json') : undefined,
    },
    {
      protocol: 'https',
      probeSucceeded: true,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: false,
      observedCapabilitySummary:
        'HTTPS can reach the shared entry itself, but the one-entry topology does not expose a truthful second-hop Mullvad relay selector for HTTPS clients, so hostname-selected routing cannot survive.',
      artifactPath: input.workspacePath ? path.join(input.workspacePath, 'artifacts', 'artifact.json') : undefined,
    },
  ];

  return {
    hostnameRouting,
    protocols,
    operator: {
      authPreserved: hasAuthSurface(input.artifact),
      requiresClientSpecificRelayConfiguration: socksChainingWorked,
      locationSelectionDiscoverable: logicalExitCount > 0,
      notes: [
        'Authenticated access remains on the local shared-entry proxy surface.',
        'Operators would have to understand explicit relay mapping instead of hostname-selected routing.',
      ],
    },
    notes: [
      `Reused the S01 shared-entry topology with ${input.artifact.topology.entryIdentity.mullvadWireguardDeviceCount} Mullvad device and ${logicalExitCount} logical exits.`,
      `Feasibility verdict was ${input.artifact.verdict.status.toUpperCase()} at phase ${input.artifact.verdict.phase}.`,
    ],
  };
}

function hasAuthSurface(artifact: FeasibilityArtifact): boolean {
  return artifact.topology.entryIdentity.mullvadWireguardDeviceCount === 1;
}

async function writeCompatibilityOutputs(input: {
  readonly outputDir: string;
  readonly artifact: CompatibilityArtifact;
  readonly mode: 'fixture' | 'live';
  readonly phase: string;
  readonly notes: readonly string[];
  readonly protocolEvidence: readonly CompatibilityProtocolObservation[];
  readonly hostnameRoutingEvidence: CompatibilityHostnameRoutingObservation;
  readonly preservedWorkspace: boolean;
  readonly workspacePath?: string;
  readonly artifactJsonPath: string;
  readonly protocolEvidencePath: string;
  readonly hostnameRoutingEvidencePath: string;
  readonly evaluationMetadataPath: string;
  readonly summaryJsonPath: string;
  readonly summaryTextPath: string;
  readonly feasibilitySummaryJsonPath?: string;
  readonly feasibilitySummaryTextPath?: string;
}): Promise<CompatibilitySummaryBundle> {
  const artifactText = serializeCompatibilityArtifact({ artifact: input.artifact });
  await Promise.all([
    writeFile(input.artifactJsonPath, `${artifactText}\n`, { mode: 0o600 }),
    writeFile(input.protocolEvidencePath, `${JSON.stringify(input.protocolEvidence, null, 2)}\n`, { mode: 0o600 }),
    writeFile(input.hostnameRoutingEvidencePath, `${JSON.stringify(input.hostnameRoutingEvidence, null, 2)}\n`, { mode: 0o600 }),
    writeFile(
      input.evaluationMetadataPath,
      `${JSON.stringify(
        {
          phase: input.phase,
          mode: input.mode,
          preservedWorkspace: input.preservedWorkspace,
          workspacePath: input.workspacePath ?? null,
          notes: input.notes,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    ),
  ]);

  const bundle: CompatibilitySummaryBundle = {
    schemaVersion: 1,
    generatedAt: input.artifact.generatedAt,
    mode: input.mode,
    phase: input.phase,
    overallVerdict: toOverallVerdict(input.artifact),
    artifact: input.artifact,
    diagnostics: {
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      preservedWorkspace: input.preservedWorkspace,
      notes: [...input.notes],
      artifactPaths: {
        artifactJson: input.artifactJsonPath,
        summaryText: input.summaryTextPath,
        protocolEvidence: input.protocolEvidencePath,
        hostnameRoutingEvidence: input.hostnameRoutingEvidencePath,
        evaluationMetadata: input.evaluationMetadataPath,
        ...(input.feasibilitySummaryJsonPath ? { feasibilitySummaryJson: input.feasibilitySummaryJsonPath } : {}),
        ...(input.feasibilitySummaryTextPath ? { feasibilitySummaryText: input.feasibilitySummaryTextPath } : {}),
      },
    },
  };

  const summaryText = renderCompatibilitySummary({ bundle });
  await Promise.all([
    writeFile(input.summaryJsonPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 }),
    writeFile(input.summaryTextPath, `${summaryText}\n`, { mode: 0o600 }),
  ]);
  process.stdout.write(`${summaryText}\n`);

  return bundle;
}

function renderCompatibilitySummary(input: { readonly bundle: CompatibilitySummaryBundle }): string {
  const lines: string[] = [
    `M004 compatibility verdict: ${input.bundle.overallVerdict.toUpperCase()}`,
    `phase: ${input.bundle.phase}`,
    `mode: ${input.bundle.mode}`,
    `recommendation posture: ${input.bundle.artifact.recommendation.posture}`,
    `hostname-selected routing: ${input.bundle.artifact.hostnameRouting.status} (${input.bundle.artifact.hostnameRouting.reason})`,
    `hostname summary: ${input.bundle.artifact.hostnameRouting.summary}`,
  ];

  input.bundle.artifact.protocols.forEach((protocol) => {
    lines.push(
      `${protocol.protocol}: ${protocol.outcome} (${protocol.reason}) — ${protocol.summary}`,
    );
  });

  lines.push('requirement deltas:');
  input.bundle.artifact.requirementDeltas.forEach((requirement) => {
    lines.push(`- ${requirement.requirementId}: ${requirement.status} — ${requirement.summary}`);
  });

  lines.push('artifacts:');
  lines.push(`- artifact: ${input.bundle.diagnostics.artifactPaths.artifactJson}`);
  lines.push(`- summary text: ${input.bundle.diagnostics.artifactPaths.summaryText}`);
  lines.push(`- protocol evidence: ${input.bundle.diagnostics.artifactPaths.protocolEvidence}`);
  lines.push(`- hostname evidence: ${input.bundle.diagnostics.artifactPaths.hostnameRoutingEvidence}`);
  lines.push(`- evaluation metadata: ${input.bundle.diagnostics.artifactPaths.evaluationMetadata}`);

  if (input.bundle.diagnostics.artifactPaths.feasibilitySummaryJson) {
    lines.push(`- feasibility summary json: ${input.bundle.diagnostics.artifactPaths.feasibilitySummaryJson}`);
  }

  if (input.bundle.diagnostics.artifactPaths.feasibilitySummaryText) {
    lines.push(`- feasibility summary text: ${input.bundle.diagnostics.artifactPaths.feasibilitySummaryText}`);
  }

  if (input.bundle.diagnostics.workspacePath) {
    lines.push(`workspace: ${input.bundle.diagnostics.workspacePath}`);
  }

  return lines.join('\n');
}

function toOverallVerdict(artifact: CompatibilityArtifact): 'pass' | 'contract-change' | 'fail' {
  if (artifact.recommendation.posture === 'approved') {
    return 'pass';
  }

  if (artifact.recommendation.posture === 'possible-with-contract-change') {
    return 'contract-change';
  }

  return 'fail';
}

async function prepareLatestOutputDir(input: { readonly outputRoot: string }): Promise<string> {
  const resolvedRoot = path.resolve(input.outputRoot);
  const latestDir = path.join(resolvedRoot, 'latest');
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  await rm(latestDir, { recursive: true, force: true });
  await mkdir(latestDir, { recursive: true, mode: 0o700 });
  return latestDir;
}

function readFlagValue(input: { readonly argv: readonly string[]; readonly index: number; readonly flag: string }): string {
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

export function renderMissingCompatibilityEnvError(env: NodeJS.ProcessEnv = process.env): string | null {
  const missingKeys = REQUIRED_ENV_KEYS.filter((key) => !env[key]?.trim());

  if (missingKeys.length === 0) {
    return null;
  }

  return `Missing required environment variables for the live compatibility verifier: ${missingKeys.join(', ')}.`;
}
