#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildExposureContract } from '../src/config/exposure-contract.js';
import { resolveMullgatePaths } from '../src/config/paths.js';
import { CONFIG_VERSION, type MullgateConfig } from '../src/config/schema.js';
import { buildPlatformSupportContract } from '../src/platform/support-contract.js';
import { requireArrayValue } from '../src/required.js';
import {
  createFixtureRuntime,
  createFixtureRoute as createRoutedLocationFixture,
} from '../test/helpers/mullgate-fixtures.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const defaultOutputRoot = '.tmp/m002-final';

type FinalVerifierOptions = {
  readonly outputRoot: string;
};

type ScriptResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type StepResult = {
  readonly id: 'network-modes' | 'platform-surfaces';
  readonly title: string;
  readonly scriptPath: string;
  readonly result: ScriptResult;
  readonly preservedTempHomes: readonly string[];
};

type FinalSummary = {
  readonly milestoneId: 'M002';
  readonly sliceId: 'S03';
  readonly verdict: 'pass' | 'fail';
  readonly generatedAt: string;
  readonly outputRoot: string;
  readonly posture: {
    readonly recommendedRemote: string;
    readonly advancedPublic: string;
    readonly linuxRuntime: string;
    readonly macosRuntime: string;
    readonly windowsRuntime: string;
  };
  readonly steps: ReadonlyArray<{
    readonly id: StepResult['id'];
    readonly title: string;
    readonly exitCode: number;
    readonly preservedTempHomes: readonly string[];
    readonly stdoutPath: string;
    readonly stderrPath: string;
  }>;
  readonly inspection: {
    readonly summaryTextPath: string;
    readonly summaryJsonPath: string;
  };
};

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (!options) {
      return;
    }

    const outputDir = path.join(resolveOutputRoot(options.outputRoot), 'latest');
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true, mode: 0o700 });

    const steps: readonly StepResult[] = [
      await runStep({
        id: 'network-modes',
        title: 'M002 S01 network-mode verifier',
        scriptPath: 'scripts/verify-m002-network-modes.ts',
      }),
      await runStep({
        id: 'platform-surfaces',
        title: 'M002 S02 platform-surface verifier',
        scriptPath: 'scripts/verify-m002-platform-surfaces.ts',
      }),
    ];

    for (const step of steps) {
      await writeStepArtifacts({ outputDir, step });
    }

    const summary = buildSummary({
      outputDir,
      steps,
    });
    const summaryText = renderSummaryText(summary);

    await Promise.all([
      writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
        mode: 0o600,
      }),
      writeFile(path.join(outputDir, 'summary.txt'), `${summaryText}\n`, { mode: 0o600 }),
    ]);

    process.stdout.write(`${summaryText}\n`);
    process.exitCode = summary.verdict === 'pass' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n`);
    process.stdout.write(renderHelp());
    process.exitCode = 1;
  }
}

function parseArgs(argv: readonly string[]): FinalVerifierOptions | null {
  const normalizedArgs = argv[0] === '--' ? argv.slice(1) : argv;
  let outputRoot = defaultOutputRoot;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const argument = requireArrayValue(
      normalizedArgs,
      index,
      `Missing CLI argument at index ${index}.`,
    );

    if (argument === '--help' || argument === '-h') {
      process.stdout.write(renderHelp());
      return null;
    }

    if (argument === '--output-root') {
      const value = normalizedArgs[index + 1];

      if (!value || value.startsWith('-')) {
        throw new Error('Missing value for --output-root.');
      }

      outputRoot = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { outputRoot };
}

function renderHelp(): string {
  return [
    'Usage: pnpm exec tsx scripts/verify-m002-final.ts [options]',
    '',
    'Run the final M002 milestone verifier: compose the shipped S01 network-mode',
    'verifier and S02 platform-surface verifier, capture their outputs into one',
    'stable proof bundle, and restate the assembled Mullgate operator posture in a',
    'single summary without introducing a second assertion path.',
    '',
    'Options:',
    `  --output-root <path>  Directory that receives the final proof bundle (default: ${defaultOutputRoot})`,
    '  -h, --help            Show this help text.',
    '',
    'Inspection workflow:',
    '  Start with latest/summary.txt for the operator-readable M002 verdict, then',
    '  inspect latest/summary.json for the machine-readable bundle. If a composed',
    '  verifier fails, continue with latest/network-modes.stdout.txt,',
    '  latest/network-modes.stderr.txt, latest/platform-surfaces.stdout.txt,',
    '  latest/platform-surfaces.stderr.txt, and any preserved temp-home paths',
    '  listed in the summary.',
    '',
    'This command reuses the existing M002 verifier scripts as the authoritative',
    'proof paths. It does not clone their assertions or introduce a separate',
    'network/platform contract implementation.',
    '',
  ].join('\n');
}

async function runStep(input: {
  readonly id: StepResult['id'];
  readonly title: string;
  readonly scriptPath: string;
}): Promise<StepResult> {
  const result = await runScript(input.scriptPath);

  return {
    id: input.id,
    title: input.title,
    scriptPath: input.scriptPath,
    result,
    preservedTempHomes: collectPreservedTempHomes({
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  };
}

async function runScript(scriptPath: string): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, scriptPath], {
      cwd: repoRoot,
      env: process.env,
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
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function collectPreservedTempHomes(input: {
  readonly stdout: string;
  readonly stderr: string;
}): readonly string[] {
  const matches = `${input.stdout}\n${input.stderr}`.matchAll(/^preserved temp home: (.+)$/gm);
  const homes = new Set<string>();

  for (const match of matches) {
    const value = match[1]?.trim();

    if (value) {
      homes.add(value);
    }
  }

  return [...homes];
}

async function writeStepArtifacts(input: {
  readonly outputDir: string;
  readonly step: StepResult;
}): Promise<void> {
  await Promise.all([
    writeFile(path.join(input.outputDir, `${input.step.id}.stdout.txt`), input.step.result.stdout, {
      mode: 0o600,
    }),
    writeFile(path.join(input.outputDir, `${input.step.id}.stderr.txt`), input.step.result.stderr, {
      mode: 0o600,
    }),
  ]);
}

function buildSummary(input: {
  readonly outputDir: string;
  readonly steps: readonly StepResult[];
}): FinalSummary {
  const verdict = input.steps.every((step) => step.result.exitCode === 0) ? 'pass' : 'fail';
  const contractSummary = buildContractSummary();

  return {
    milestoneId: 'M002',
    sliceId: 'S03',
    verdict,
    generatedAt: new Date().toISOString(),
    outputRoot: input.outputDir,
    posture: {
      recommendedRemote: contractSummary.recommendedRemote,
      advancedPublic: contractSummary.advancedPublic,
      linuxRuntime: contractSummary.linuxRuntime,
      macosRuntime: contractSummary.macosRuntime,
      windowsRuntime: contractSummary.windowsRuntime,
    },
    steps: input.steps.map((step) => ({
      id: step.id,
      title: step.title,
      exitCode: step.result.exitCode,
      preservedTempHomes: step.preservedTempHomes,
      stdoutPath: path.join(input.outputDir, `${step.id}.stdout.txt`),
      stderrPath: path.join(input.outputDir, `${step.id}.stderr.txt`),
    })),
    inspection: {
      summaryTextPath: path.join(input.outputDir, 'summary.txt'),
      summaryJsonPath: path.join(input.outputDir, 'summary.json'),
    },
  };
}

function renderSummaryText(summary: FinalSummary): string {
  const stepLines = summary.steps.map((step) => {
    const status = step.exitCode === 0 ? 'ok' : 'failed';
    const preservedHomes =
      step.preservedTempHomes.length > 0
        ? ` | preserved temp homes: ${step.preservedTempHomes.join(', ')}`
        : '';

    return `- ${step.id}: ${status}${preservedHomes}`;
  });

  return [
    `M002 final verification: ${summary.verdict.toUpperCase()}`,
    '',
    'assembled posture:',
    `- recommended remote: ${summary.posture.recommendedRemote}`,
    `- advanced public: ${summary.posture.advancedPublic}`,
    `- linux runtime: ${summary.posture.linuxRuntime}`,
    `- macOS runtime: ${summary.posture.macosRuntime}`,
    `- Windows runtime: ${summary.posture.windowsRuntime}`,
    '',
    'composed verifiers:',
    ...stepLines,
    '',
    `summary json: ${summary.inspection.summaryJsonPath}`,
    `summary text: ${summary.inspection.summaryTextPath}`,
  ].join('\n');
}

function resolveOutputRoot(outputRoot: string): string {
  return path.isAbsolute(outputRoot) ? outputRoot : path.join(repoRoot, outputRoot);
}

function buildContractSummary(): {
  readonly recommendedRemote: string;
  readonly advancedPublic: string;
  readonly linuxRuntime: string;
  readonly macosRuntime: string;
  readonly windowsRuntime: string;
} {
  const linuxPaths = resolveMullgatePaths({
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: '/home/alice',
    XDG_CONFIG_HOME: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CACHE_HOME: undefined,
  });
  const macosPaths = resolveMullgatePaths({
    ...process.env,
    MULLGATE_PLATFORM: 'macos',
    HOME: '/Users/alice',
    XDG_CONFIG_HOME: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CACHE_HOME: undefined,
  });
  const windowsPaths = resolveMullgatePaths({
    ...process.env,
    MULLGATE_PLATFORM: 'windows',
    USERPROFILE: 'C:\\Users\\alice',
    APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    HOME: undefined,
    XDG_CONFIG_HOME: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CACHE_HOME: undefined,
  });
  const config = createExposureFixtureConfig();
  const privateNetworkContract = buildExposureContract(config);
  const publicContract = buildExposureContract({
    ...config,
    setup: {
      ...config.setup,
      exposure: {
        ...config.setup.exposure,
        mode: 'public',
      },
    },
  });

  return {
    recommendedRemote: privateNetworkContract.guidance[0] ?? privateNetworkContract.posture.summary,
    advancedPublic: publicContract.guidance[0] ?? publicContract.posture.summary,
    linuxRuntime: buildPlatformSupportContract({ paths: linuxPaths }).posture.summary,
    macosRuntime: buildPlatformSupportContract({ paths: macosPaths }).posture.summary,
    windowsRuntime: buildPlatformSupportContract({ paths: windowsPaths }).posture.summary,
  };
}

function createExposureFixtureConfig(): MullgateConfig {
  const timestamp = '2026-03-22T20:15:00.000Z';
  const linuxPaths = resolveMullgatePaths({
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: '/home/alice',
    XDG_CONFIG_HOME: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CACHE_HOME: undefined,
  });

  return {
    version: CONFIG_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    setup: {
      source: 'guided-setup',
      bind: {
        host: '10.0.0.10',
        socksPort: 1080,
        httpPort: 8080,
        httpsPort: 8443,
      },
      auth: {
        username: 'alice',
        password: 'redacted-secret',
      },
      exposure: {
        mode: 'private-network',
        allowLan: true,
        baseDomain: null,
      },
      location: {
        requested: 'sweden-gothenburg',
        country: 'se',
        city: 'got',
        hostnameLabel: 'se-got-wg-101',
        resolvedAlias: 'sweden-gothenburg',
      },
      https: {
        enabled: false,
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: 'mullgate-m002-final-fixture-1',
      lastProvisionedAt: timestamp,
      relayConstraints: {
        providers: [],
      },
      wireguard: {
        publicKey: 'public-key-value-1',
        privateKey: 'private-key-value-1',
        ipv4Address: '10.64.12.34/32',
        ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1234/128',
        gatewayIpv4: '10.64.0.1',
        gatewayIpv6: 'fc00:bbbb:bbbb:bb01::1',
        dnsServers: ['10.64.0.1'],
        peerPublicKey: 'peer-public-key-value-1',
        peerEndpoint: 'se-got-wg-101.relays.mullvad.net:3401',
      },
    },
    routing: {
      locations: [
        createRoutedLocationFixture({
          alias: 'sweden-gothenburg',
          hostname: '10.0.0.10',
          bindIp: '10.0.0.10',
          requested: 'sweden-gothenburg',
          country: 'se',
          city: 'got',
          hostnameLabel: 'se-got-wg-101',
          resolvedAlias: 'sweden-gothenburg',
          routeId: 'se-got-wg-101',
          httpsBackendName: 'route-se-got-wg-101',
          exit: {
            relayHostname: 'se-got-wg-101',
            relayFqdn: 'se-got-wg-101.relays.mullvad.net',
            socksHostname: 'se-got-wg-101.mullvad.net',
            socksPort: 1080,
            countryCode: 'se',
            cityCode: 'got',
          },
        }),
        createRoutedLocationFixture({
          alias: 'austria-vienna',
          hostname: '10.0.0.11',
          bindIp: '10.0.0.11',
          requested: 'austria-vienna',
          country: 'at',
          city: 'vie',
          hostnameLabel: 'at-vie-wg-001',
          resolvedAlias: 'austria-vienna',
          routeId: 'at-vie-wg-001',
          httpsBackendName: 'route-at-vie-wg-001',
          exit: {
            relayHostname: 'at-vie-wg-001',
            relayFqdn: 'at-vie-wg-001.relays.mullvad.net',
            socksHostname: 'at-vie-wg-001.mullvad.net',
            socksPort: 1080,
            countryCode: 'at',
            cityCode: 'vie',
          },
        }),
      ],
    },
    runtime: createFixtureRuntime({
      paths: linuxPaths,
      status: {
        phase: 'validated',
        lastCheckedAt: timestamp,
        message: 'Fixture config already validated.',
      },
    }),
    diagnostics: {
      lastRuntimeStartReportPath: linuxPaths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

main();
