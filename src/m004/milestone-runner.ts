import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  runCompatibilityVerifier,
  renderCompatibilityHelp,
  renderMissingCompatibilityEnvError,
  renderCompatibilitySummary,
  type CompatibilityParseResult,
  type CompatibilityRunnerOptions,
  type CompatibilityRunnerResult,
  type CompatibilitySummaryBundle,
} from './compatibility-runner.js';
import {
  createMilestoneDecisionBundle,
  renderMilestoneDecisionText,
  serializeMilestoneDecisionBundle,
  type MilestoneDecisionBundle,
} from './milestone-contract.js';

const DEFAULT_OUTPUT_ROOT = '.tmp/m004';
const DEFAULT_TARGET_URL = 'https://am.i.mullvad.net/json';
const DEFAULT_ROUTE_CHECK_IP = '1.1.1.1';

export type MilestoneRunnerOptions = CompatibilityRunnerOptions;

export type MilestoneRunnerResult = {
  readonly exitCode: 0 | 1;
  readonly outputDir: string;
  readonly decisionJsonPath: string;
  readonly decisionTextPath: string;
  readonly compatibilitySummaryJsonPath: string;
  readonly compatibilitySummaryTextPath: string;
  readonly compatibilityArtifactJsonPath: string;
  readonly compatibilityBundle: CompatibilitySummaryBundle;
  readonly decisionBundle: MilestoneDecisionBundle;
  readonly preservedWorkspace: boolean;
  readonly workspacePath?: string;
};

export function parseMilestoneArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CompatibilityParseResult {
  let targetUrl = env.MULLGATE_VERIFY_TARGET_URL?.trim() || DEFAULT_TARGET_URL;
  let routeCheckIp = env.MULLGATE_VERIFY_ROUTE_CHECK_IP?.trim() || DEFAULT_ROUTE_CHECK_IP;
  let logicalExitCount: 2 | 3 = readLogicalExitCount(env.MULLGATE_M004_LOGICAL_EXIT_COUNT?.trim()) ?? 3;
  let outputRoot = env.MULLGATE_M004_OUTPUT_ROOT?.trim() || DEFAULT_OUTPUT_ROOT;
  let keepTempHome = false;
  let fixturePath: string | undefined;

  try {
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index]!;

      if (argument === '--help' || argument === '-h') {
        return {
          ok: false,
          helpText: renderMilestoneHelp(),
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
            helpText: renderMilestoneHelp(),
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
        helpText: renderMilestoneHelp(),
        exitCode: 1,
        error: `Unknown argument: ${argument}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      helpText: renderMilestoneHelp(),
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

export function renderMilestoneHelp(): string {
  return [
    'Usage: pnpm exec tsx scripts/verify-m004.ts [options]',
    '',
    'Run the final M004 milestone verifier: reuse the S02 compatibility verifier as',
    'the only live execution path, then aggregate its secret-safe outputs into one',
    'milestone decision bundle that says whether Mullgate should pursue, stop, or',
    'only pursue the shared-entry redesign with explicit contract changes.',
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
    '  MULLGATE_M004_OUTPUT_ROOT    Override the milestone output root.',
    '',
    'Fixture mode:',
    '  Pass --fixture <path> to skip all live Mullvad/Docker work and replay a',
    '  deterministic compatibility fixture into the final milestone decision bundle.',
    '',
    'Options:',
    `  --target-url <url>            Exit-check endpoint to query (default: ${DEFAULT_TARGET_URL})`,
    `  --route-check-ip <ip>         Direct-route IP used for host-route drift checks (default: ${DEFAULT_ROUTE_CHECK_IP})`,
    '  --logical-exit-count <2|3>     Requested logical exit count for the reused shared-entry experiment (default: 3).',
    `  --output-root <path>          Directory that receives the final milestone bundle (default: ${DEFAULT_OUTPUT_ROOT})`,
    '  --fixture <path>               Replay a checked-in compatibility fixture instead of running live provisioning.',
    '  --keep-temp-home               Preserve the temp verifier workspace even on success.',
    '  -h, --help                     Show this help text.',
    '',
    'Inspection workflow:',
    '  Start with latest/decision.txt for the operator-readable PASS / FAIL /',
    '  contract-change-required answer, then inspect latest/decision.json for the',
    '  machine-readable bundle. If the milestone blocks, continue with',
    '  latest/compatibility-summary.txt, latest/compatibility-summary.json,',
    '  latest/protocol-evidence.json, latest/hostname-routing.json, and any',
    '  preserved workspace path named in the decision diagnostics.',
    '',
    'This command never creates a second live orchestration path. It simply reuses',
    'the compatibility verifier, preserves its diagnostics and artifact links, and',
    're-emits the final milestone decision in a stable .tmp/m004/latest layout.',
    '',
  ].join('\n');
}

export async function runMilestoneVerifier(options: MilestoneRunnerOptions): Promise<MilestoneRunnerResult> {
  const compatibilityResult = await runCompatibilityVerifier(options);
  const outputDir = compatibilityResult.outputDir;
  const compatibilitySummaryJsonPath = path.join(outputDir, 'compatibility-summary.json');
  const compatibilitySummaryTextPath = path.join(outputDir, 'compatibility-summary.txt');
  const compatibilityArtifactJsonPath = path.join(outputDir, 'compatibility-artifact.json');
  const decisionJsonPath = path.join(outputDir, 'decision.json');
  const decisionTextPath = path.join(outputDir, 'decision.txt');

  await copyFile(compatibilityResult.artifactJsonPath, compatibilityArtifactJsonPath);

  const compatibilityBundle = rewriteCompatibilityBundlePaths({
    bundle: compatibilityResult.bundle,
    compatibilitySummaryJsonPath,
    compatibilitySummaryTextPath,
    compatibilityArtifactJsonPath,
  });

  const compatibilitySummaryText = renderCompatibilitySummary({
    bundle: compatibilityBundle,
  });

  await Promise.all([
    writeFile(compatibilitySummaryJsonPath, `${JSON.stringify(compatibilityBundle, null, 2)}\n`, { mode: 0o600 }),
    writeFile(compatibilitySummaryTextPath, `${compatibilitySummaryText}\n`, { mode: 0o600 }),
  ]);

  const decisionBundle = createMilestoneDecisionBundle({
    compatibilityBundle,
  });
  const decisionJson = serializeMilestoneDecisionBundle({
    bundle: decisionBundle,
  });
  const decisionText = renderMilestoneDecisionText(decisionBundle);

  await Promise.all([
    writeFile(decisionJsonPath, `${decisionJson}\n`, { mode: 0o600 }),
    writeFile(decisionTextPath, `${decisionText}\n`, { mode: 0o600 }),
  ]);

  process.stdout.write(`${decisionText}\n`);

  return {
    exitCode: compatibilityResult.exitCode,
    outputDir,
    decisionJsonPath,
    decisionTextPath,
    compatibilitySummaryJsonPath,
    compatibilitySummaryTextPath,
    compatibilityArtifactJsonPath,
    compatibilityBundle,
    decisionBundle,
    preservedWorkspace: compatibilityResult.preservedWorkspace,
    ...(compatibilityResult.workspacePath ? { workspacePath: compatibilityResult.workspacePath } : {}),
  };
}

export function renderMilestoneFailureHelp(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const liveEnvError = renderMissingCompatibilityEnvError(env);

  if (liveEnvError && error instanceof Error && error.message.startsWith('Missing required environment variables')) {
    return `${liveEnvError}\n\n${renderMilestoneHelp()}`;
  }

  if (error instanceof Error) {
    return `${error.message}\n\n${renderMilestoneHelp()}`;
  }

  return `${String(error)}\n\n${renderMilestoneHelp()}`;
}

export function renderCompatibilityPassThroughHelp(): string {
  return renderCompatibilityHelp();
}

function rewriteCompatibilityBundlePaths(input: {
  readonly bundle: CompatibilitySummaryBundle;
  readonly compatibilitySummaryJsonPath: string;
  readonly compatibilitySummaryTextPath: string;
  readonly compatibilityArtifactJsonPath: string;
}): CompatibilitySummaryBundle {
  return {
    ...input.bundle,
    summary: {
      ...input.bundle.summary,
      artifactLinks: {
        ...input.bundle.summary.artifactLinks,
        artifactJson: input.compatibilityArtifactJsonPath,
        summaryJson: input.compatibilitySummaryJsonPath,
        summaryText: input.compatibilitySummaryTextPath,
      },
    },
    diagnostics: {
      ...input.bundle.diagnostics,
      notes: [...input.bundle.diagnostics.notes],
      artifactPaths: {
        ...input.bundle.diagnostics.artifactPaths,
        artifactJson: input.compatibilityArtifactJsonPath,
        summaryJson: input.compatibilitySummaryJsonPath,
        summaryText: input.compatibilitySummaryTextPath,
      },
    },
  };
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
