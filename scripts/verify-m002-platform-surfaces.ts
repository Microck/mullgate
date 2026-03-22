#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildExposureContract } from '../src/config/exposure-contract.js';
import { buildPlatformSupportContract } from '../src/platform/support-contract.js';
import { resolveMullgatePaths, resolveRouteWireproxyPaths, type MullgatePaths, type MullgatePlatform } from '../src/config/paths.js';
import { ConfigStore } from '../src/config/store.js';
import { CONFIG_VERSION, type MullgateConfig, type RoutedLocation } from '../src/config/schema.js';
import type { RuntimeBundleManifest } from '../src/runtime/render-runtime-bundle.js';
import { renderRuntimeBundle } from '../src/runtime/render-runtime-bundle.js';
import type { MullvadRelayCatalog } from '../src/mullvad/fetch-relays.js';
import type { ValidateWireproxyResult } from '../src/runtime/validate-wireproxy.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntrypointPath = path.join(repoRoot, 'src/cli.ts');

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ScenarioMode = 'filesystem' | 'planned';

type ScenarioDefinition = {
  readonly id: 'linux' | 'macos' | 'windows';
  readonly title: string;
  readonly platform: MullgatePlatform;
  readonly mode: ScenarioMode;
  readonly buildEnv: (root: string) => NodeJS.ProcessEnv;
};

type SeededScenario = {
  readonly env: NodeJS.ProcessEnv;
  readonly paths: MullgatePaths;
  readonly store: ConfigStore;
  readonly root: string;
  readonly config: MullgateConfig;
  readonly plannedRuntimeBundle?: Awaited<ReturnType<typeof renderRuntimeBundle>>;
};

type VerifierOptions = {
  readonly keepTempHomes: boolean;
};

const scenarios: readonly ScenarioDefinition[] = [
  {
    id: 'linux',
    title: 'Linux default-path full-support surface',
    platform: 'linux',
    mode: 'filesystem',
    buildEnv(root) {
      return {
        ...process.env,
        HOME: path.join(root, 'home'),
        PATH: process.env.PATH ?? '',
      };
    },
  },
  {
    id: 'macos',
    title: 'macOS default-path partial-support surface',
    platform: 'macos',
    mode: 'filesystem',
    buildEnv(root) {
      return {
        ...process.env,
        MULLGATE_PLATFORM: 'macos',
        HOME: path.join(root, 'home'),
        PATH: process.env.PATH ?? '',
      };
    },
  },
  {
    id: 'windows',
    title: 'Windows AppData partial-support surface',
    platform: 'windows',
    mode: 'planned',
    buildEnv(root) {
      return {
        ...process.env,
        MULLGATE_PLATFORM: 'windows',
        HOME: undefined,
        XDG_CONFIG_HOME: undefined,
        XDG_STATE_HOME: undefined,
        XDG_CACHE_HOME: undefined,
        USERPROFILE: 'C:\\Users\\alice',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        PATH: process.env.PATH ?? '',
      };
    },
  },
] as const;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options) {
    return;
  }

  const results: string[] = [];

  for (const scenario of scenarios) {
    results.push(await verifyScenario({ scenario, options }));
  }

  process.stdout.write(`${['M002 platform-surface verification passed.', ...results].join('\n')}\n`);
}

function parseArgs(argv: readonly string[]): VerifierOptions | null {
  const normalizedArgs = argv[0] === '--' ? argv.slice(1) : argv;
  let keepTempHomes = false;

  for (const argument of normalizedArgs) {
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(renderHelp());
      return null;
    }

    if (argument === '--keep-temp-homes') {
      keepTempHomes = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { keepTempHomes };
}

function renderHelp(): string {
  return [
    'Usage: pnpm verify:m002-platform-surfaces [options]',
    '',
    'Run the real Mullgate CLI under simulated Linux, macOS, and Windows',
    'environments. The verifier checks `config path`, `status`, `doctor`, and',
    '`runtime-manifest.json` for platform-support drift and preserves its temp',
    'home bundle on failure.',
    '',
    'Options:',
    '  --keep-temp-homes   Preserve the temp-home bundles even on success.',
    '  -h, --help          Show this help text.',
    '',
  ].join('\n');
}

async function verifyScenario(input: { readonly scenario: ScenarioDefinition; readonly options: VerifierOptions }): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), `mullgate-m002-platform-${input.scenario.id}-`));
  let preserveRoot = input.options.keepTempHomes;

  try {
    const env = input.scenario.buildEnv(root);
    const fakeBin = path.join(root, 'fake-bin');
    await mkdir(fakeBin, { recursive: true, mode: 0o700 });
    await installFakeDocker({ directory: fakeBin });
    env.PATH = [fakeBin, env.PATH ?? ''].filter((value) => value.length > 0).join(path.delimiter);

    const seeded = await seedScenario({ root, env, mode: input.scenario.mode });

    const platformContract = buildPlatformSupportContract({ paths: seeded.paths });
    const exposureContract = buildExposureContract(seeded.config);

    if (input.scenario.mode === 'planned') {
      const planned = seeded.plannedRuntimeBundle;

      if (!planned || !planned.ok) {
        throw new Error(`${input.scenario.id}: planned runtime bundle was not available.`);
      }

      const configPathOutput = renderExpectedConfigPathSurface({ paths: seeded.paths, contract: platformContract });
      const manifest = planned.manifest;

      await writeScenarioArtifacts({
        root,
        manifest,
        commandResults: {
          configPath: { exitCode: 0, stdout: `${configPathOutput}\n`, stderr: '' },
          status: { exitCode: 0, stdout: '', stderr: '' },
          doctor: { exitCode: 0, stdout: '', stderr: '' },
        },
      });

      assertContains({ text: configPathOutput, expected: `platform: ${platformContract.platform}`, message: `${input.scenario.id}: planned config path platform missing.` });
      assertManifestSurface({ manifest, contract: platformContract, exposure: exposureContract, scenarioId: input.scenario.id });

      return `- ${input.scenario.id}: ok (${input.scenario.title}; planned manifest/config-path contract verified, runtime execution intentionally limited on this host)`;
    }

    const configPathResult = await runCliCommand({ env: seeded.env, cwd: seeded.root, args: ['config', 'path'] });
    const statusResult = await runCliCommand({ env: seeded.env, cwd: seeded.root, args: ['status'] });
    const doctorResult = await runCliCommand({ env: seeded.env, cwd: seeded.root, args: ['doctor'] });
    const manifest = await readJsonFile<RuntimeBundleManifest>({
      filePath: resolveArtifactPath({ cwd: seeded.root, targetPath: seeded.paths.runtimeBundleManifestFile }),
      label: `${input.scenario.id} runtime manifest`,
    });

    await writeScenarioArtifacts({
      root,
      manifest,
      commandResults: {
        configPath: configPathResult,
        status: statusResult,
        doctor: doctorResult,
      },
    });

    assertExitCode({ result: configPathResult, expected: 0, message: `${input.scenario.id}: config path failed.` });
    assertExitCode({ result: statusResult, expected: 0, message: `${input.scenario.id}: status failed.` });
    assertExitCode({ result: doctorResult, expected: 0, message: `${input.scenario.id}: doctor failed.` });

    assertNoSecretLeaks({ label: `${input.scenario.id} config path`, text: configPathResult.stdout, config: seeded.config });
    assertNoSecretLeaks({ label: `${input.scenario.id} status`, text: statusResult.stdout, config: seeded.config });
    assertNoSecretLeaks({ label: `${input.scenario.id} doctor`, text: `${doctorResult.stdout}\n${doctorResult.stderr}`, config: seeded.config });
    assertNoSecretLeaks({ label: `${input.scenario.id} manifest`, text: JSON.stringify(manifest, null, 2), config: seeded.config });

    assertConfigPathSurface({ output: configPathResult.stdout, paths: seeded.paths, contract: platformContract, scenarioId: input.scenario.id });
    assertStatusSurface({
      output: statusResult.stdout,
      contract: platformContract,
      exposure: exposureContract,
      manifest,
      manifestPath: seeded.config.runtime.runtimeBundle.manifestPath,
    });
    assertDoctorSurface({ output: `${doctorResult.stdout}\n${doctorResult.stderr}`, contract: platformContract, exposure: exposureContract });
    assertManifestSurface({ manifest, contract: platformContract, exposure: exposureContract, scenarioId: input.scenario.id });

    return `- ${input.scenario.id}: ok (${input.scenario.title})`;
  } catch (error) {
    preserveRoot = true;
    throw withPreservedRoot({ root, error });
  } finally {
    if (!preserveRoot) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function seedScenario(input: { readonly root: string; readonly env: NodeJS.ProcessEnv; readonly mode: ScenarioMode }): Promise<SeededScenario> {
  const paths = resolveMullgatePaths(input.env);
  const store = new ConfigStore(paths);
  const config = createFixtureConfig({ env: input.env });

  if (input.mode === 'planned') {
    const plannedRuntimeBundle = await withCwd(input.root, async () => {
      await seedPrerequisiteArtifacts({ root: input.root, paths, config });
      return renderRuntimeBundle({
        config,
        paths,
        generatedAt: config.updatedAt,
      });
    });

    return {
      env: input.env,
      paths,
      store,
      root: input.root,
      config,
      plannedRuntimeBundle,
    };
  }

  await withCwd(input.root, async () => {
    await store.save(config);
    await seedPrerequisiteArtifacts({ root: input.root, paths, config });

    const runtimeBundle = await renderRuntimeBundle({
      config,
      paths,
      generatedAt: config.updatedAt,
    });

    if (!runtimeBundle.ok) {
      throw new Error(`Failed to render runtime bundle for ${paths.platform}: ${runtimeBundle.message}`);
    }
  });

  return {
    env: input.env,
    paths,
    store,
    root: input.root,
    config,
  };
}

function createFixtureConfig(input: { readonly env: NodeJS.ProcessEnv }): MullgateConfig {
  const paths = resolveMullgatePaths(input.env);
  const timestamp = '2026-03-22T19:55:00.000Z';

  return {
    version: CONFIG_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    setup: {
      source: 'guided-setup',
      bind: {
        host: '127.0.0.1',
        socksPort: 1080,
        httpPort: 8080,
        httpsPort: null,
      },
      auth: {
        username: 'alice',
        password: 'platform-surface-secret',
      },
      exposure: {
        mode: 'loopback',
        allowLan: false,
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
      deviceName: 'mullgate-m002-platform-1',
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
        peerEndpoint: 'se-got-wg-101.relays.mullvad.net:51820',
      },
    },
    routing: {
      locations: [
        createRouteFixture({
          alias: 'sweden-gothenburg',
          hostname: '127.0.0.1',
          bindIp: '127.0.0.1',
          requested: 'sweden-gothenburg',
          country: 'se',
          city: 'got',
          hostnameLabel: 'se-got-wg-101',
          resolvedAlias: 'sweden-gothenburg',
          routeId: 'se-got-wg-101',
          wireproxyServiceName: 'wireproxy-se-got-wg-101',
          haproxyBackendName: 'route-se-got-wg-101',
          wireproxyConfigFile: 'wireproxy-se-got-wg-101.conf',
          deviceName: 'mullgate-m002-platform-1',
          peerEndpoint: 'se-got-wg-101.relays.mullvad.net:51820',
          publicKey: 'public-key-value-1',
          privateKey: 'private-key-value-1',
          ipv4Address: '10.64.12.34/32',
          ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1234/128',
          accountNumber: '123456789012',
          lastProvisionedAt: timestamp,
        }),
        createRouteFixture({
          alias: 'austria-vienna',
          hostname: '127.0.0.2',
          bindIp: '127.0.0.2',
          requested: 'austria-vienna',
          country: 'at',
          city: 'vie',
          hostnameLabel: 'at-vie-wg-001',
          resolvedAlias: 'austria-vienna',
          routeId: 'at-vie-wg-001',
          wireproxyServiceName: 'wireproxy-at-vie-wg-001',
          haproxyBackendName: 'route-at-vie-wg-001',
          wireproxyConfigFile: 'wireproxy-at-vie-wg-001.conf',
          deviceName: 'mullgate-m002-platform-2',
          peerEndpoint: 'at-vie-wg-001.relays.mullvad.net:51820',
          publicKey: 'public-key-value-2',
          privateKey: 'private-key-value-2',
          ipv4Address: '10.64.12.35/32',
          ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1235/128',
          accountNumber: '123456789012',
          lastProvisionedAt: timestamp,
        }),
      ],
    },
    runtime: {
      backend: 'wireproxy',
      sourceConfigPath: paths.configFile,
      wireproxyConfigPath: paths.wireproxyConfigFile,
      wireproxyConfigTestReportPath: paths.wireproxyConfigTestReportFile,
      relayCachePath: paths.provisioningCacheFile,
      dockerComposePath: paths.dockerComposePath,
      runtimeBundle: {
        bundleDir: paths.runtimeBundleDir,
        dockerComposePath: paths.runtimeComposeFile,
        httpsSidecarConfigPath: paths.runtimeHttpsSidecarConfigFile,
        manifestPath: paths.runtimeBundleManifestFile,
      },
      status: {
        phase: 'validated',
        lastCheckedAt: timestamp,
        message: 'Fixture config already validated.',
      },
    },
    diagnostics: {
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

function createRouteFixture(input: {
  readonly alias: string;
  readonly hostname: string;
  readonly bindIp: string;
  readonly requested: string;
  readonly country: string;
  readonly city: string;
  readonly hostnameLabel: string;
  readonly resolvedAlias: string;
  readonly routeId: string;
  readonly wireproxyServiceName: string;
  readonly haproxyBackendName: string;
  readonly wireproxyConfigFile: string;
  readonly deviceName: string;
  readonly peerEndpoint: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly ipv4Address: string;
  readonly ipv6Address: string;
  readonly accountNumber: string;
  readonly lastProvisionedAt: string;
}): RoutedLocation {
  return {
    alias: input.alias,
    hostname: input.hostname,
    bindIp: input.bindIp,
    relayPreference: {
      requested: input.requested,
      country: input.country,
      city: input.city,
      hostnameLabel: input.hostnameLabel,
      resolvedAlias: input.resolvedAlias,
    },
    mullvad: {
      accountNumber: input.accountNumber,
      deviceName: input.deviceName,
      lastProvisionedAt: input.lastProvisionedAt,
      relayConstraints: {
        providers: [],
      },
      wireguard: {
        publicKey: input.publicKey,
        privateKey: input.privateKey,
        ipv4Address: input.ipv4Address,
        ipv6Address: input.ipv6Address,
        gatewayIpv4: '10.64.0.1',
        gatewayIpv6: 'fc00:bbbb:bbbb:bb01::1',
        dnsServers: ['10.64.0.1'],
        peerPublicKey: `peer-${input.publicKey}`,
        peerEndpoint: input.peerEndpoint,
      },
    },
    runtime: {
      routeId: input.routeId,
      wireproxyServiceName: input.wireproxyServiceName,
      haproxyBackendName: input.haproxyBackendName,
      wireproxyConfigFile: input.wireproxyConfigFile,
    },
  };
}

async function seedPrerequisiteArtifacts(input: {
  readonly root: string;
  readonly paths: MullgatePaths;
  readonly config: MullgateConfig;
}): Promise<void> {
  await ensureParentDirectory(resolveArtifactPath({ cwd: input.root, targetPath: input.paths.provisioningCacheFile }));
  await writeFile(resolveArtifactPath({ cwd: input.root, targetPath: input.paths.provisioningCacheFile }), `${JSON.stringify(createRelayCatalog(), null, 2)}\n`, { mode: 0o600 });

  await ensureParentDirectory(resolveArtifactPath({ cwd: input.root, targetPath: input.paths.wireproxyConfigFile }));
  await writeFile(resolveArtifactPath({ cwd: input.root, targetPath: input.paths.wireproxyConfigFile }), '# primary wireproxy fixture\n', { mode: 0o600 });

  for (const route of input.config.routing.locations) {
    const routePaths = resolveRouteWireproxyPaths(input.paths, route.runtime);
    await ensureParentDirectory(resolveArtifactPath({ cwd: input.root, targetPath: routePaths.wireproxyConfigPath }));
    await writeFile(resolveArtifactPath({ cwd: input.root, targetPath: routePaths.wireproxyConfigPath }), `# verifier route ${route.runtime.routeId}\n`, { mode: 0o600 });
    await ensureParentDirectory(resolveArtifactPath({ cwd: input.root, targetPath: routePaths.configTestReportPath }));
    await writeFile(
      resolveArtifactPath({ cwd: input.root, targetPath: routePaths.configTestReportPath }),
      `${JSON.stringify(createValidationSuccess(routePaths.configTestReportPath), null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

function createRelayCatalog(): MullvadRelayCatalog {
  return {
    source: 'app-wireguard-v1',
    fetchedAt: '2026-03-22T19:54:00.000Z',
    endpoint: 'https://api.mullvad.net/public/relays/wireguard/v1/',
    relayCount: 2,
    countries: [
      {
        code: 'at',
        name: 'Austria',
        cities: [{ code: 'vie', name: 'Vienna', relayCount: 1 }],
      },
      {
        code: 'se',
        name: 'Sweden',
        cities: [{ code: 'got', name: 'Gothenburg', relayCount: 1 }],
      },
    ],
    relays: [
      {
        hostname: 'at-vie-wg-001',
        fqdn: 'at-vie-wg-001.relays.mullvad.net',
        source: 'app-wireguard-v1',
        active: true,
        owned: false,
        publicKey: 'relay-public-key-2',
        endpointIpv4: '203.0.113.12',
        multihopPort: 51820,
        location: {
          countryCode: 'at',
          countryName: 'Austria',
          cityCode: 'vie',
          cityName: 'Vienna',
        },
      },
      {
        hostname: 'se-got-wg-101',
        fqdn: 'se-got-wg-101.relays.mullvad.net',
        source: 'app-wireguard-v1',
        active: true,
        owned: false,
        publicKey: 'relay-public-key-1',
        endpointIpv4: '203.0.113.11',
        multihopPort: 51820,
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'got',
          cityName: 'Gothenburg',
        },
      },
    ],
  };
}

function createValidationSuccess(targetPath: string): ValidateWireproxyResult {
  return {
    ok: true,
    phase: 'validation',
    source: 'internal-syntax',
    status: 'success',
    checkedAt: '2026-03-22T19:56:00.000Z',
    target: targetPath,
    reportPath: targetPath,
    validator: 'internal-syntax',
    issues: [],
  };
}

async function runCliCommand(input: { readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly args: readonly string[] }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, cliEntrypointPath, ...input.args], {
      cwd: input.cwd,
      env: input.env,
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

async function installFakeDocker(input: { readonly directory: string }): Promise<void> {
  const dockerPath = path.join(input.directory, 'docker');
  await writeFile(dockerPath, renderFakeDockerScript(), { mode: 0o755 });
  await chmod(dockerPath, 0o755);
}

function renderFakeDockerScript(): string {
  return `#!/bin/sh
set -eu
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "version" ]; then
  printf '%s\n' 'Docker Compose version v2.40.0'
  exit 0
fi
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "--file" ] && [ "\${4:-}" = "ps" ] && [ "\${5:-}" = "--all" ] && [ "\${6:-}" = "--format" ] && [ "\${7:-}" = "json" ]; then
  printf '%s\n' '[]'
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "--rm" ] && [ "\${3:-}" = "-v" ] && [ "\${5:-}" = "ghcr.io/windtf/wireproxy:latest" ] && [ "\${6:-}" = "--configtest" ]; then
  printf '%s\n' 'wireproxy configtest ok'
  exit 0
fi
printf '%s\n' "unsupported fake docker invocation: $*" >&2
exit 2
`;
}

function renderExpectedConfigPathSurface(input: {
  readonly paths: MullgatePaths;
  readonly contract: ReturnType<typeof buildPlatformSupportContract>;
}): string {
  return [
    'Mullgate path report',
    'phase: resolve-paths',
    'source: canonical-path-contract',
    `platform: ${input.contract.platform}`,
    `platform source: ${input.contract.platformSource}`,
    `platform support: ${input.contract.posture.supportLevel}`,
    `platform mode: ${input.contract.posture.modeLabel}`,
    `platform summary: ${input.contract.posture.summary}`,
    `runtime story: ${input.contract.posture.runtimeStory}`,
    `host networking: ${input.contract.hostNetworking.modeLabel}`,
    `host networking summary: ${input.contract.hostNetworking.summary}`,
    `config home: ${input.paths.configHome} (${input.paths.pathSources.configHome})`,
    `state home: ${input.paths.stateHome} (${input.paths.pathSources.stateHome})`,
    `cache home: ${input.paths.cacheHome} (${input.paths.pathSources.cacheHome})`,
    `config file: ${input.paths.configFile} (missing)`,
    `state dir: ${input.paths.appStateDir}`,
    `cache dir: ${input.paths.appCacheDir}`,
    `runtime dir: ${input.paths.runtimeDir} (present)`,
    `wireproxy config: ${input.paths.wireproxyConfigFile}`,
    `wireproxy configtest report: ${input.paths.wireproxyConfigTestReportFile}`,
    `docker compose: ${input.paths.dockerComposePath}`,
    `relay cache: ${input.paths.provisioningCacheFile} (present)`,
    '',
    'platform guidance',
    ...input.contract.guidance.map((line) => `- ${line}`),
    '',
    'platform warnings',
    ...(input.contract.warnings.length > 0 ? input.contract.warnings.map((warning) => `- ${warning.severity}: ${warning.message}`) : ['- none']),
  ].join('\n');
}

function assertConfigPathSurface(input: {
  readonly output: string;
  readonly paths: MullgatePaths;
  readonly contract: ReturnType<typeof buildPlatformSupportContract>;
  readonly scenarioId: string;
}): void {
  assertContains({ text: input.output, expected: 'Mullgate path report', message: `${input.scenarioId}: config path header missing.` });
  assertContains({ text: input.output, expected: `platform: ${input.contract.platform}`, message: `${input.scenarioId}: config path platform missing.` });
  assertContains({ text: input.output, expected: `platform source: ${input.contract.platformSource}`, message: `${input.scenarioId}: config path platform source missing.` });
  assertContains({ text: input.output, expected: `platform support: ${input.contract.posture.supportLevel}`, message: `${input.scenarioId}: config path support level missing.` });
  assertContains({ text: input.output, expected: `platform mode: ${input.contract.posture.modeLabel}`, message: `${input.scenarioId}: config path mode label missing.` });
  assertContains({ text: input.output, expected: `host networking: ${input.contract.hostNetworking.modeLabel}`, message: `${input.scenarioId}: config path host networking label missing.` });
  assertContains({ text: input.output, expected: `config home: ${input.paths.configHome} (${input.paths.pathSources.configHome})`, message: `${input.scenarioId}: config home line drifted.` });
  assertContains({ text: input.output, expected: `state home: ${input.paths.stateHome} (${input.paths.pathSources.stateHome})`, message: `${input.scenarioId}: state home line drifted.` });
  assertContains({ text: input.output, expected: `cache home: ${input.paths.cacheHome} (${input.paths.pathSources.cacheHome})`, message: `${input.scenarioId}: cache home line drifted.` });
}

function assertStatusSurface(input: {
  readonly output: string;
  readonly contract: ReturnType<typeof buildPlatformSupportContract>;
  readonly exposure: ReturnType<typeof buildExposureContract>;
  readonly manifest: RuntimeBundleManifest;
  readonly manifestPath: string;
}): void {
  assertContains({ text: input.output, expected: 'Mullgate runtime status', message: 'status header missing.' });
  assertContains({ text: input.output, expected: `platform: ${input.contract.platform}`, message: 'status platform missing.' });
  assertContains({ text: input.output, expected: `platform support: ${input.contract.posture.supportLevel}`, message: 'status platform support missing.' });
  assertContains({ text: input.output, expected: `platform mode: ${input.contract.posture.modeLabel}`, message: 'status platform mode missing.' });
  assertContains({ text: input.output, expected: `host networking: ${input.contract.hostNetworking.modeLabel}`, message: 'status host networking missing.' });
  assertContains({ text: input.output, expected: 'platform guidance', message: 'status platform guidance section missing.' });
  assertContains({ text: input.output, expected: `mode label: ${input.exposure.posture.modeLabel}`, message: 'status exposure mode label missing.' });
  assertContains({ text: input.output, expected: `recommendation: ${input.exposure.posture.recommendation}`, message: 'status exposure recommendation missing.' });
  assertContains({ text: input.output, expected: `runtime manifest: ${input.manifestPath} (present)`, message: 'status runtime-manifest presence line drifted.' });
}

function assertDoctorSurface(input: {
  readonly output: string;
  readonly contract: ReturnType<typeof buildPlatformSupportContract>;
  readonly exposure: ReturnType<typeof buildExposureContract>;
}): void {
  assertContains({ text: input.output, expected: 'Mullgate doctor', message: 'doctor header missing.' });
  assertContains({ text: input.output, expected: `platform=${input.contract.platform}`, message: 'doctor platform detail missing.' });
  assertContains({ text: input.output, expected: `support-level=${input.contract.posture.supportLevel}`, message: 'doctor support-level detail missing.' });
  assertContains({ text: input.output, expected: `mode-label=${input.contract.posture.modeLabel}`, message: 'doctor mode-label detail missing.' });
  assertContains({ text: input.output, expected: `host-networking=${input.contract.hostNetworking.modeLabel}`, message: 'doctor host-networking detail missing.' });
  assertContains({ text: input.output, expected: `recommendation=${input.exposure.posture.recommendation}`, message: 'doctor exposure recommendation detail missing.' });
}

function assertManifestSurface(input: {
  readonly manifest: RuntimeBundleManifest;
  readonly contract: ReturnType<typeof buildPlatformSupportContract>;
  readonly exposure: ReturnType<typeof buildExposureContract>;
  readonly scenarioId: string;
}): void {
  if (input.manifest.platform.platform !== input.contract.platform) {
    throw new Error(`${input.scenarioId}: runtime manifest platform drifted.`);
  }
  if (input.manifest.platform.posture.modeLabel !== input.contract.posture.modeLabel) {
    throw new Error(`${input.scenarioId}: runtime manifest platform mode drifted.`);
  }
  if (input.manifest.platform.hostNetworking.modeLabel !== input.contract.hostNetworking.modeLabel) {
    throw new Error(`${input.scenarioId}: runtime manifest host-networking drifted.`);
  }
  if (input.manifest.exposure.mode !== input.exposure.mode) {
    throw new Error(`${input.scenarioId}: runtime manifest exposure mode drifted.`);
  }
}

function resolveArtifactPath(input: { readonly cwd: string; readonly targetPath: string }): string {
  if (path.isAbsolute(input.targetPath)) {
    return input.targetPath;
  }

  return path.join(input.cwd, input.targetPath);
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

async function readJsonFile<T>(input: { readonly filePath: string; readonly label: string }): Promise<T> {
  try {
    return JSON.parse(await readFile(input.filePath, 'utf8')) as T;
  } catch (error) {
    throw new Error(`Failed to read ${input.label} at ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeScenarioArtifacts(input: {
  readonly root: string;
  readonly manifest: RuntimeBundleManifest;
  readonly commandResults: Record<string, CommandResult>;
}): Promise<void> {
  for (const [label, result] of Object.entries(input.commandResults)) {
    await writeFile(path.join(input.root, `${label}.stdout.txt`), result.stdout, { mode: 0o600 });
    await writeFile(path.join(input.root, `${label}.stderr.txt`), result.stderr, { mode: 0o600 });
  }

  await writeFile(path.join(input.root, 'runtime-manifest.copy.json'), `${JSON.stringify(input.manifest, null, 2)}\n`, { mode: 0o600 });
}

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);

  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

function assertExitCode(input: { readonly result: CommandResult; readonly expected: number; readonly message: string }): void {
  if (input.result.exitCode !== input.expected) {
    throw new Error(`${input.message}\nexpected: ${input.expected}\nactual: ${input.result.exitCode}\nstdout:\n${input.result.stdout || '<empty>'}\nstderr:\n${input.result.stderr || '<empty>'}`);
  }
}

function assertContains(input: { readonly text: string; readonly expected: string; readonly message: string }): void {
  if (!input.text.includes(input.expected)) {
    throw new Error(`${input.message}\nmissing: ${input.expected}`);
  }
}

function assertNotContains(input: { readonly text: string; readonly unexpected: string; readonly message: string }): void {
  if (input.text.includes(input.unexpected)) {
    throw new Error(`${input.message}\nunexpected: ${input.unexpected}`);
  }
}

function assertNoSecretLeaks(input: { readonly label: string; readonly text: string; readonly config: MullgateConfig }): void {
  for (const secret of collectSecrets({ config: input.config })) {
    assertNotContains({
      text: input.text,
      unexpected: secret,
      message: `${input.label} leaked a secret that should have been redacted.`,
    });
  }
}

function collectSecrets(input: { readonly config: MullgateConfig }): string[] {
  return [
    input.config.setup.auth.password,
    input.config.mullvad.accountNumber,
    input.config.mullvad.wireguard.privateKey,
    ...input.config.routing.locations.flatMap((route) => [route.mullvad.accountNumber, route.mullvad.wireguard.privateKey]),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function withPreservedRoot(input: { readonly root: string; readonly error: unknown }): Error {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return new Error(`${message}\npreserved temp home: ${input.root}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
