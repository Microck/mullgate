#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildExposureContract, type ExposureContract } from '../src/config/exposure-contract.js';
import { resolveMullgatePaths, resolveRouteWireproxyPaths } from '../src/config/paths.js';
import { CONFIG_VERSION, type MullgateConfig, type RoutedLocation } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import type { MullvadRelayCatalog } from '../src/mullvad/fetch-relays.js';
import {
  type RuntimeBundleManifest,
  renderRuntimeBundle,
} from '../src/runtime/render-runtime-bundle.js';

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type VerificationOptions = {
  readonly simulateDrift: boolean;
};

type DockerScenario = 'idle';

type ScenarioDefinition = {
  readonly id: 'loopback-default' | 'private-network-direct' | 'public-direct';
  readonly title: string;
  readonly updateArgs: readonly string[];
  readonly expectedMode: 'loopback' | 'private-network' | 'public';
};

type SeededScenario = {
  readonly env: NodeJS.ProcessEnv;
  readonly paths: ReturnType<typeof resolveMullgatePaths>;
  readonly store: ConfigStore;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

const scenarios: readonly ScenarioDefinition[] = [
  {
    id: 'loopback-default',
    title: 'default local-only loopback posture',
    updateArgs: [],
    expectedMode: 'loopback',
  },
  {
    id: 'private-network-direct',
    title: 'recommended private-network remote posture',
    updateArgs: [
      'config',
      'exposure',
      '--mode',
      'private-network',
      '--clear-base-domain',
      '--route-bind-ip',
      '192.168.50.10',
      '--route-bind-ip',
      '192.168.50.11',
    ],
    expectedMode: 'private-network',
  },
  {
    id: 'public-direct',
    title: 'advanced public direct-IP posture',
    updateArgs: [
      'config',
      'exposure',
      '--mode',
      'public',
      '--clear-base-domain',
      '--route-bind-ip',
      '203.0.113.10',
      '--route-bind-ip',
      '203.0.113.11',
    ],
    expectedMode: 'public',
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

  process.stdout.write(
    `${['M002 S01 network-mode verification passed.', ...results].join('\n')}\n`,
  );
}

function parseArgs(argv: readonly string[]): VerificationOptions | null {
  const normalizedArgs = argv[0] === '--' ? argv.slice(1) : argv;
  let simulateDrift = false;

  for (const argument of normalizedArgs) {
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(renderHelp());
      return null;
    }

    if (argument === '--simulate-drift') {
      simulateDrift = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { simulateDrift };
}

function renderHelp(): string {
  return [
    'Usage: pnpm verify:m002-network-modes [options]',
    '',
    'Exercise the real Mullgate CLI across loopback, private-network, and public exposure',
    'postures. For each mode the verifier checks the immediate restart-required exposure',
    'report, runs `mullgate config validate` to regenerate runtime artifacts, then asserts',
    '`config exposure`, `config hosts`, `status`, `doctor`, and the runtime manifest all',
    'agree on the assembled network-mode contract.',
    '',
    'Options:',
    '  --simulate-drift   Tamper with one verified manifest in memory so the verifier exits non-zero.',
    '  -h, --help         Show this help text.',
    '',
  ].join('\n');
}

async function verifyScenario(input: {
  readonly scenario: ScenarioDefinition;
  readonly options: VerificationOptions;
}): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), `mullgate-m002-${input.scenario.id}-`));
  let preserveRoot = false;

  try {
    const seeded = await seedScenario({ root });
    let preValidateExposure: CommandResult | null = null;
    let updateResult: CommandResult | null = null;

    if (input.scenario.updateArgs.length > 0) {
      updateResult = await runCliCommand({ env: seeded.env, args: input.scenario.updateArgs });
      assertExitCode({
        result: updateResult,
        expected: 0,
        message: `${input.scenario.id}: exposure update failed unexpectedly.`,
      });

      const updatedConfig = await loadConfig({ store: seeded.store });
      assertScenarioMode({
        scenario: input.scenario,
        config: updatedConfig,
      });
      assertNoSecretLeaks({
        label: `${input.scenario.id} update`,
        text: updateResult.stdout,
        config: updatedConfig,
      });

      preValidateExposure = await runCliCommand({ env: seeded.env, args: ['config', 'exposure'] });
      assertExitCode({
        result: preValidateExposure,
        expected: 0,
        message: `${input.scenario.id}: pre-validation config exposure failed.`,
      });
      assertExposureRestartRequired({
        scenario: input.scenario,
        output: preValidateExposure.stdout,
        config: updatedConfig,
      });
      assertNoSecretLeaks({
        label: `${input.scenario.id} pre-validation exposure`,
        text: preValidateExposure.stdout,
        config: updatedConfig,
      });
    }

    const validate = await runCliCommand({ env: seeded.env, args: ['config', 'validate'] });
    assertExitCode({
      result: validate,
      expected: 0,
      message: `${input.scenario.id}: config validate failed.`,
    });

    const config = await loadConfig({ store: seeded.store });
    assertScenarioMode({ scenario: input.scenario, config });
    const exposureContract = buildExposureContract(config);

    const runtimeBundleResult = await renderRuntimeBundle({
      config,
      paths: seeded.paths,
    });

    if (!runtimeBundleResult.ok) {
      throw new Error(
        `${input.scenario.id}: failed to render runtime bundle after validation: ${runtimeBundleResult.message}`,
      );
    }

    const configExposure = await runCliCommand({ env: seeded.env, args: ['config', 'exposure'] });
    const configHosts = await runCliCommand({ env: seeded.env, args: ['config', 'hosts'] });
    const status = await runCliCommand({ env: seeded.env, args: ['status'] });
    const doctor = await runCliCommand({ env: seeded.env, args: ['doctor'] });
    const manifestFile = await loadJsonFile<RuntimeBundleManifest>(
      config.runtime.runtimeBundle.manifestPath,
      'runtime manifest',
    );
    const manifest =
      input.options.simulateDrift && input.scenario.id === 'private-network-direct'
        ? tamperManifest({ manifest: manifestFile })
        : manifestFile;

    await writeScenarioArtifacts({
      root,
      commandResults: {
        ...(updateResult ? { update: updateResult } : {}),
        ...(preValidateExposure ? { preValidateExposure } : {}),
        validate,
        configExposure,
        configHosts,
        status,
        doctor,
      },
      manifest,
    });

    assertExitCode({
      result: configExposure,
      expected: 0,
      message: `${input.scenario.id}: config exposure failed.`,
    });
    assertExitCode({
      result: configHosts,
      expected: 0,
      message: `${input.scenario.id}: config hosts failed.`,
    });
    assertExitCode({
      result: status,
      expected: 0,
      message: `${input.scenario.id}: status failed.`,
    });
    assertExitCode({
      result: doctor,
      expected: 0,
      message: `${input.scenario.id}: doctor should remain degraded-but-successful in the idle-runtime verifier.`,
    });

    assertNoSecretLeaks({
      label: `${input.scenario.id} validate`,
      text: `${validate.stdout}\n${validate.stderr}`,
      config,
    });
    assertNoSecretLeaks({
      label: `${input.scenario.id} exposure`,
      text: configExposure.stdout,
      config,
    });
    assertNoSecretLeaks({ label: `${input.scenario.id} hosts`, text: configHosts.stdout, config });
    assertNoSecretLeaks({ label: `${input.scenario.id} status`, text: status.stdout, config });
    assertNoSecretLeaks({
      label: `${input.scenario.id} doctor`,
      text: `${doctor.stdout}\n${doctor.stderr}`,
      config,
    });
    assertNoSecretLeaks({
      label: `${input.scenario.id} manifest`,
      text: JSON.stringify(manifest, null, 2),
      config,
    });

    assertValidationSurface({
      scenario: input.scenario,
      output: validate.stdout,
      config,
    });
    assertExposureSurface({
      scenario: input.scenario,
      output: configExposure.stdout,
      exposureContract,
    });
    assertHostsSurface({
      output: configHosts.stdout,
      exposureContract,
    });
    assertStatusSurface({
      output: status.stdout,
      exposureContract,
      manifestPath: config.runtime.runtimeBundle.manifestPath,
    });
    assertDoctorSurface({
      output: `${doctor.stdout}\n${doctor.stderr}`,
      exposureContract,
    });
    assertManifestSurface({
      manifest,
      exposureContract,
      scenarioId: input.scenario.id,
    });
    assertCliAndManifestAgree({
      scenarioId: input.scenario.id,
      exposureOutput: configExposure.stdout,
      statusOutput: status.stdout,
      doctorOutput: `${doctor.stdout}\n${doctor.stderr}`,
      manifest,
      exposureContract,
    });

    return `- ${input.scenario.id}: ok (${input.scenario.title}; config exposure restart hint, config validate, status, doctor, hosts, and runtime-manifest all agree after artifact refresh)`;
  } catch (error) {
    preserveRoot = true;
    throw withPreservedRoot({ root, error });
  } finally {
    if (!preserveRoot) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function seedScenario(input: { readonly root: string }): Promise<SeededScenario> {
  const env = await createTempEnvironment({ root: input.root, dockerScenario: 'idle' });
  const paths = resolveMullgatePaths(env);
  const store = new ConfigStore(paths);
  const config = createBaseFixtureConfig({ env });

  await store.save(config);
  await seedPrerequisiteArtifacts({ paths, config });

  return { env, paths, store };
}

async function createTempEnvironment(input: {
  readonly root: string;
  readonly dockerScenario: DockerScenario;
}): Promise<NodeJS.ProcessEnv> {
  const fakeBin = path.join(input.root, 'fake-bin');
  await mkdir(fakeBin, { recursive: true, mode: 0o700 });
  await installFakeDocker({ directory: fakeBin, dockerScenario: input.dockerScenario });

  return {
    ...process.env,
    HOME: input.root,
    XDG_CONFIG_HOME: path.join(input.root, 'config'),
    XDG_STATE_HOME: path.join(input.root, 'state'),
    XDG_CACHE_HOME: path.join(input.root, 'cache'),
    PATH: [fakeBin, process.env.PATH ?? '']
      .filter((value) => value.length > 0)
      .join(path.delimiter),
    MULLGATE_FAKE_DOCKER_SCENARIO: input.dockerScenario,
  };
}

function createBaseFixtureConfig(input: { readonly env: NodeJS.ProcessEnv }): MullgateConfig {
  const paths = resolveMullgatePaths(input.env);
  const timestamp = '2026-03-22T15:55:00.000Z';

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
        password: 'multi-route-secret',
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
      deviceName: 'mullgate-m002-test-1',
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
          hostname: 'sweden-gothenburg',
          bindIp: '127.0.0.1',
          requested: 'sweden-gothenburg',
          country: 'se',
          city: 'got',
          hostnameLabel: 'se-got-wg-101',
          resolvedAlias: 'sweden-gothenburg',
          routeId: 'sweden-gothenburg',
          wireproxyServiceName: 'wireproxy-sweden-gothenburg',
          haproxyBackendName: 'route-sweden-gothenburg',
          wireproxyConfigFile: 'wireproxy-sweden-gothenburg.conf',
          deviceName: 'mullgate-m002-test-1',
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
          hostname: 'austria-vienna',
          bindIp: '127.0.0.2',
          requested: 'austria-vienna',
          country: 'at',
          city: 'vie',
          hostnameLabel: 'at-vie-wg-001',
          resolvedAlias: 'austria-vienna',
          routeId: 'austria-vienna',
          wireproxyServiceName: 'wireproxy-austria-vienna',
          haproxyBackendName: 'route-austria-vienna',
          wireproxyConfigFile: 'wireproxy-austria-vienna.conf',
          deviceName: 'mullgate-m002-test-2',
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
  readonly paths: ReturnType<typeof resolveMullgatePaths>;
  readonly config: MullgateConfig;
}): Promise<void> {
  await mkdir(path.dirname(input.paths.provisioningCacheFile), { recursive: true, mode: 0o700 });
  await writeFile(
    input.paths.provisioningCacheFile,
    `${JSON.stringify(createRelayCatalog(), null, 2)}\n`,
    { mode: 0o600 },
  );
  await mkdir(path.dirname(input.paths.wireproxyConfigFile), { recursive: true, mode: 0o700 });
  await writeFile(input.paths.wireproxyConfigFile, '# primary wireproxy fixture\n', {
    mode: 0o600,
  });

  for (const route of input.config.routing.locations) {
    const routePaths = resolveRouteWireproxyPaths(input.paths, route.runtime);
    await mkdir(path.dirname(routePaths.wireproxyConfigPath), { recursive: true, mode: 0o700 });
    await writeFile(routePaths.wireproxyConfigPath, `# verifier route ${route.runtime.routeId}\n`, {
      mode: 0o600,
    });
  }
}

function createRelayCatalog(): MullvadRelayCatalog {
  return {
    source: 'app-wireguard-v1',
    fetchedAt: '2026-03-22T15:54:00.000Z',
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
        hostname: 'austria-vienna',
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
        hostname: 'sweden-gothenburg',
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

async function installFakeDocker(input: {
  readonly directory: string;
  readonly dockerScenario: DockerScenario;
}): Promise<void> {
  const dockerPath = path.join(input.directory, 'docker');
  await writeFile(dockerPath, renderFakeDockerScript({ dockerScenario: input.dockerScenario }), {
    mode: 0o755,
  });
  await chmod(dockerPath, 0o755);
}

function renderFakeDockerScript(input: { readonly dockerScenario: DockerScenario }): string {
  const outputs: Record<DockerScenario, string> = {
    idle: '[]',
  };

  return `#!/bin/sh
set -eu
scenario="\${MULLGATE_FAKE_DOCKER_SCENARIO:-${input.dockerScenario}}"
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "version" ]; then
  printf '%s\n' 'Docker Compose version v2.40.0'
  exit 0
fi
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "--file" ] && [ "\${4:-}" = "ps" ] && [ "\${5:-}" = "--all" ] && [ "\${6:-}" = "--format" ] && [ "\${7:-}" = "json" ]; then
  case "\${scenario}" in
    idle)
      cat <<'EOF'
${outputs.idle}
EOF
      ;;
    *)
      printf '%s\n' "unknown fake docker scenario: \${scenario}" >&2
      exit 2
      ;;
  esac
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

async function writeScenarioArtifacts(input: {
  readonly root: string;
  readonly commandResults: Record<string, CommandResult>;
  readonly manifest: RuntimeBundleManifest;
}): Promise<void> {
  for (const [key, value] of Object.entries(input.commandResults)) {
    await writeFile(path.join(input.root, `${key}.stdout.txt`), value.stdout, { mode: 0o600 });
    await writeFile(path.join(input.root, `${key}.stderr.txt`), value.stderr, { mode: 0o600 });
  }

  await writeFile(
    path.join(input.root, 'runtime-manifest.json'),
    `${JSON.stringify(input.manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function runCliCommand(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly args: readonly string[];
}): Promise<CommandResult> {
  return runCommand({
    command: process.execPath,
    args: [tsxCliPath, 'src/cli.ts', ...input.args],
    cwd: repoRoot,
    env: input.env,
  });
}

async function runCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
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

async function loadConfig(input: { readonly store: ConfigStore }): Promise<MullgateConfig> {
  const result = await input.store.load();

  if (!result.ok) {
    throw new Error(`Failed to load Mullgate config: ${result.message}`);
  }

  if (result.source === 'empty') {
    throw new Error(result.message);
  }

  return result.config;
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

function assertScenarioMode(input: {
  readonly scenario: ScenarioDefinition;
  readonly config: MullgateConfig;
}): void {
  if (input.config.setup.exposure.mode !== input.scenario.expectedMode) {
    throw new Error(
      `${input.scenario.id}: saved config mode drifted to ${input.config.setup.exposure.mode}.`,
    );
  }
}

function assertExposureRestartRequired(input: {
  readonly scenario: ScenarioDefinition;
  readonly output: string;
  readonly config: MullgateConfig;
}): void {
  const exposureContract = buildExposureContract(input.config);

  assertContains({
    text: input.output,
    expected: `mode: ${exposureContract.mode}`,
    message: `${input.scenario.id}: pre-validation exposure report mode line missing.`,
  });
  assertContains({
    text: input.output,
    expected: 'runtime status: unvalidated',
    message: `${input.scenario.id}: pre-validation exposure report should show unvalidated runtime status.`,
  });
  assertContains({
    text: input.output,
    expected: 'restart needed: yes',
    message: `${input.scenario.id}: pre-validation exposure report should show restart needed.`,
  });

  for (const warning of exposureContract.warnings) {
    assertContains({
      text: input.output,
      expected: `- ${warning.severity}: ${warning.message}`,
      message: `${input.scenario.id}: pre-validation exposure warning missing.`,
    });
  }
}

function assertValidationSurface(input: {
  readonly scenario: ScenarioDefinition;
  readonly output: string;
  readonly config: MullgateConfig;
}): void {
  assertContains({
    text: input.output,
    expected: 'Mullgate config validated.',
    message: `${input.scenario.id}: validation success header missing.`,
  });
  assertContains({
    text: input.output,
    expected: 'runtime status: validated',
    message: `${input.scenario.id}: validation did not refresh runtime status.`,
  });
  assertContains({
    text: input.output,
    expected: `report: ${input.config.runtime.wireproxyConfigTestReportPath}`,
    message: `${input.scenario.id}: validation report path missing.`,
  });

  if (input.scenario.expectedMode === 'loopback') {
    assertContains({
      text: input.output,
      expected: 'artifacts refreshed: no',
      message: `${input.scenario.id}: untouched loopback validation should be able to reuse existing artifacts.`,
    });
    return;
  }

  assertContains({
    text: input.output,
    expected: 'artifacts refreshed: yes',
    message: `${input.scenario.id}: validation should refresh artifacts after exposure changes.`,
  });
}

function assertExposureSurface(input: {
  readonly scenario: ScenarioDefinition;
  readonly output: string;
  readonly exposureContract: ExposureContract;
}): void {
  assertContains({
    text: input.output,
    expected: 'Mullgate exposure report',
    message: `${input.scenario.id}: exposure report header missing.`,
  });
  assertContains({
    text: input.output,
    expected: `mode: ${input.exposureContract.mode}`,
    message: `${input.scenario.id}: exposure mode line missing.`,
  });
  assertContains({
    text: input.output,
    expected: `mode label: ${input.exposureContract.posture.modeLabel}`,
    message: `${input.scenario.id}: exposure mode label missing.`,
  });
  assertContains({
    text: input.output,
    expected: `recommendation: ${input.exposureContract.posture.recommendation}`,
    message: `${input.scenario.id}: exposure recommendation missing.`,
  });
  assertContains({
    text: input.output,
    expected: `posture summary: ${input.exposureContract.posture.summary}`,
    message: `${input.scenario.id}: exposure posture summary missing.`,
  });
  assertContains({
    text: input.output,
    expected: `remote story: ${input.exposureContract.posture.remoteStory}`,
    message: `${input.scenario.id}: exposure remote story missing.`,
  });
  assertContains({
    text: input.output,
    expected: `base domain: ${input.exposureContract.baseDomain ?? 'n/a'}`,
    message: `${input.scenario.id}: exposure base domain missing.`,
  });
  assertContains({
    text: input.output,
    expected: `allow lan: ${input.exposureContract.allowLan ? 'yes' : 'no'}`,
    message: `${input.scenario.id}: exposure allow-lan line missing.`,
  });
  assertContains({
    text: input.output,
    expected: `runtime status: ${input.exposureContract.runtimeStatus.phase}`,
    message: `${input.scenario.id}: exposure runtime status missing.`,
  });
  assertContains({
    text: input.output,
    expected: `restart needed: ${input.exposureContract.runtimeStatus.restartRequired ? 'yes' : 'no'}`,
    message: `${input.scenario.id}: exposure restart-needed line missing.`,
  });

  for (const guidanceLine of input.exposureContract.guidance) {
    assertContains({
      text: input.output,
      expected: `- ${guidanceLine}`,
      message: `${input.scenario.id}: exposure guidance line missing.`,
    });
  }

  assertContains({
    text: input.output,
    expected: `- bind posture: ${input.exposureContract.remediation.bindPosture}`,
    message: `${input.scenario.id}: exposure bind remediation missing.`,
  });
  assertContains({
    text: input.output,
    expected: `- hostname resolution: ${input.exposureContract.remediation.hostnameResolution}`,
    message: `${input.scenario.id}: exposure hostname remediation missing.`,
  });
  assertContains({
    text: input.output,
    expected: `- restart: ${input.exposureContract.remediation.restart}`,
    message: `${input.scenario.id}: exposure restart remediation missing.`,
  });

  for (const warning of input.exposureContract.warnings) {
    assertContains({
      text: input.output,
      expected: `- ${warning.severity}: ${warning.message}`,
      message: `${input.scenario.id}: exposure warning missing.`,
    });
  }

  for (const route of input.exposureContract.routes) {
    assertContains({
      text: input.output,
      expected: `${route.index + 1}. ${route.hostname} -> ${route.bindIp}`,
      message: `${input.scenario.id}: exposure route header missing.`,
    });
    assertContains({
      text: input.output,
      expected: `   alias: ${route.alias}`,
      message: `${input.scenario.id}: exposure route alias missing.`,
    });
    assertContains({
      text: input.output,
      expected: `   route id: ${route.routeId}`,
      message: `${input.scenario.id}: exposure route id missing.`,
    });
    assertContains({
      text: input.output,
      expected: `   dns: ${route.dnsRecord ?? 'not required; use direct bind IP entrypoints'}`,
      message: `${input.scenario.id}: exposure route dns line missing.`,
    });

    for (const endpoint of route.endpoints) {
      assertContains({
        text: input.output,
        expected: `   ${endpoint.protocol} hostname: ${endpoint.redactedHostnameUrl}`,
        message: `${input.scenario.id}: exposure hostname endpoint missing.`,
      });
      assertContains({
        text: input.output,
        expected: `   ${endpoint.protocol} direct ip: ${endpoint.redactedBindUrl}`,
        message: `${input.scenario.id}: exposure direct-IP endpoint missing.`,
      });
    }
  }
}

function assertHostsSurface(input: {
  readonly output: string;
  readonly exposureContract: ExposureContract;
}): void {
  assertContains({
    text: input.output,
    expected: 'Mullgate routed hosts',
    message: 'hosts report header missing.',
  });
  assertContains({
    text: input.output,
    expected: 'copy/paste hosts block',
    message: 'hosts block header missing.',
  });

  for (const route of input.exposureContract.routes) {
    assertContains({
      text: input.output,
      expected: `${route.index + 1}. ${route.hostname} -> ${route.bindIp} (alias: ${route.alias}, route id: ${route.routeId})`,
      message: `hosts mapping missing for ${route.routeId}.`,
    });
    assertContains({
      text: input.output,
      expected: `${route.bindIp} ${route.hostname}`,
      message: `hosts block line missing for ${route.routeId}.`,
    });
  }
}

function assertStatusSurface(input: {
  readonly output: string;
  readonly exposureContract: ExposureContract;
  readonly manifestPath: string;
}): void {
  assertContains({
    text: input.output,
    expected: 'Mullgate runtime status',
    message: 'status header missing.',
  });
  assertContains({
    text: input.output,
    expected: 'phase: stopped',
    message: 'status should classify the idle verifier runtime as stopped.',
  });
  assertContains({
    text: input.output,
    expected: 'exposure source: runtime-manifest',
    message: 'status should read exposure truth from runtime manifest after validation.',
  });
  assertContains({
    text: input.output,
    expected: `runtime manifest: ${input.manifestPath} (present)`,
    message: 'status runtime-manifest presence drifted.',
  });
  assertContains({
    text: input.output,
    expected: `mode label: ${input.exposureContract.posture.modeLabel}`,
    message: 'status mode label missing.',
  });
  assertContains({
    text: input.output,
    expected: `recommendation: ${input.exposureContract.posture.recommendation}`,
    message: 'status recommendation missing.',
  });
  assertContains({
    text: input.output,
    expected: `posture summary: ${input.exposureContract.posture.summary}`,
    message: 'status posture summary missing.',
  });
  assertContains({
    text: input.output,
    expected: `remote story: ${input.exposureContract.posture.remoteStory}`,
    message: 'status remote story missing.',
  });
  assertContains({
    text: input.output,
    expected: 'network-mode guidance',
    message: 'status network-mode guidance section missing.',
  });

  for (const guidanceLine of input.exposureContract.guidance) {
    assertContains({
      text: input.output,
      expected: `- ${guidanceLine}`,
      message: 'status guidance line missing.',
    });
  }

  for (const route of input.exposureContract.routes) {
    assertContains({
      text: input.output,
      expected: `${route.index + 1}. ${route.hostname} -> ${route.bindIp}`,
      message: `status route header missing for ${route.routeId}.`,
    });
    assertContains({
      text: input.output,
      expected: `   route id: ${route.routeId}`,
      message: `status route id missing for ${route.routeId}.`,
    });
    assertContains({
      text: input.output,
      expected: `   dns: ${route.dnsRecord ?? 'not required; use direct bind IP entrypoints'}`,
      message: `status dns line missing for ${route.routeId}.`,
    });
  }
}

function assertDoctorSurface(input: {
  readonly output: string;
  readonly exposureContract: ExposureContract;
}): void {
  assertContains({
    text: input.output,
    expected: 'Mullgate doctor',
    message: 'doctor header missing.',
  });
  assertContains({
    text: input.output,
    expected: 'overall: degraded',
    message: 'doctor should stay degraded in the idle-runtime verifier.',
  });

  const exposureOutcome = input.exposureContract.warnings.some(
    (warning) => warning.severity === 'warning',
  )
    ? 'degraded'
    : 'pass';
  assertContains({
    text: input.output,
    expected: `exposure-contract: ${exposureOutcome}`,
    message: 'doctor exposure-contract check drifted away from the expected severity.',
  });
  assertContains({
    text: input.output,
    expected: `detail: mode=${input.exposureContract.mode}`,
    message: 'doctor mode detail missing.',
  });
  assertContains({
    text: input.output,
    expected: `detail: mode-label=${input.exposureContract.posture.modeLabel}`,
    message: 'doctor mode-label detail missing.',
  });
  assertContains({
    text: input.output,
    expected: `detail: recommendation=${input.exposureContract.posture.recommendation}`,
    message: 'doctor recommendation detail missing.',
  });
  assertContains({
    text: input.output,
    expected: `detail: posture-summary=${input.exposureContract.posture.summary}`,
    message: 'doctor posture-summary detail missing.',
  });
  assertContains({
    text: input.output,
    expected: `detail: remote-story=${input.exposureContract.posture.remoteStory}`,
    message: 'doctor remote-story detail missing.',
  });
  assertContains({
    text: input.output,
    expected: `detail: bind-remediation=${input.exposureContract.remediation.bindPosture}`,
    message: 'doctor bind-remediation detail missing.',
  });
  assertContains({
    text: input.output,
    expected: `detail: hostname-remediation=${input.exposureContract.remediation.hostnameResolution}`,
    message: 'doctor hostname-remediation detail missing.',
  });
  assertContains({
    text: input.output,
    expected: `detail: restart-remediation=${input.exposureContract.remediation.restart}`,
    message: 'doctor restart-remediation detail missing.',
  });

  for (const warning of input.exposureContract.warnings) {
    assertContains({
      text: input.output,
      expected: `detail: ${warning.severity}: ${warning.message}`,
      message: 'doctor warning detail missing.',
    });
  }
}

function assertManifestSurface(input: {
  readonly manifest: RuntimeBundleManifest;
  readonly exposureContract: ExposureContract;
  readonly scenarioId: string;
}): void {
  if (input.manifest.exposure.mode !== input.exposureContract.mode) {
    throw new Error(
      `${input.scenarioId}: manifest exposure mode drifted to ${input.manifest.exposure.mode}.`,
    );
  }

  if (input.manifest.exposure.allowLan !== input.exposureContract.allowLan) {
    throw new Error(`${input.scenarioId}: manifest allow-lan drifted.`);
  }

  if (input.manifest.exposure.baseDomain !== input.exposureContract.baseDomain) {
    throw new Error(`${input.scenarioId}: manifest base-domain drifted.`);
  }

  if (input.manifest.exposure.runtimeStatus.phase !== input.exposureContract.runtimeStatus.phase) {
    throw new Error(`${input.scenarioId}: manifest runtime-status phase drifted.`);
  }

  if (
    input.manifest.exposure.runtimeStatus.restartRequired !==
    input.exposureContract.runtimeStatus.restartRequired
  ) {
    throw new Error(`${input.scenarioId}: manifest restart-required drifted.`);
  }

  if (input.manifest.exposure.posture.modeLabel !== input.exposureContract.posture.modeLabel) {
    throw new Error(`${input.scenarioId}: manifest mode-label drifted.`);
  }

  if (
    input.manifest.exposure.posture.recommendation !== input.exposureContract.posture.recommendation
  ) {
    throw new Error(`${input.scenarioId}: manifest recommendation drifted.`);
  }

  if (input.manifest.exposure.posture.summary !== input.exposureContract.posture.summary) {
    throw new Error(`${input.scenarioId}: manifest posture summary drifted.`);
  }

  if (input.manifest.exposure.posture.remoteStory !== input.exposureContract.posture.remoteStory) {
    throw new Error(`${input.scenarioId}: manifest remote story drifted.`);
  }

  for (const guidanceLine of input.exposureContract.guidance) {
    if (!input.manifest.exposure.guidance.includes(guidanceLine)) {
      throw new Error(`${input.scenarioId}: manifest guidance missing: ${guidanceLine}`);
    }
  }

  for (const warning of input.exposureContract.warnings) {
    const expected = `${warning.severity}: ${warning.message}`;
    if (
      !input.manifest.exposure.warnings.some(
        (candidate) => `${candidate.severity}: ${candidate.message}` === expected,
      )
    ) {
      throw new Error(`${input.scenarioId}: manifest warning missing: ${expected}`);
    }
  }

  for (const route of input.exposureContract.routes) {
    const manifestRoute = input.manifest.exposure.routes.find(
      (candidate) => candidate.routeId === route.routeId,
    );

    if (!manifestRoute) {
      throw new Error(`${input.scenarioId}: manifest exposure route missing for ${route.routeId}.`);
    }

    if (manifestRoute.hostname !== route.hostname || manifestRoute.bindIp !== route.bindIp) {
      throw new Error(
        `${input.scenarioId}: manifest exposure route wiring drifted for ${route.routeId}.`,
      );
    }
  }
}

function assertCliAndManifestAgree(input: {
  readonly scenarioId: string;
  readonly exposureOutput: string;
  readonly statusOutput: string;
  readonly doctorOutput: string;
  readonly manifest: RuntimeBundleManifest;
  readonly exposureContract: ExposureContract;
}): void {
  for (const route of input.manifest.exposure.routes) {
    const header = `${route.index + 1}. ${route.hostname} -> ${route.bindIp}`;
    assertContains({
      text: input.exposureOutput,
      expected: header,
      message: `${input.scenarioId}: exposure/manifest route drifted.`,
    });
    assertContains({
      text: input.statusOutput,
      expected: header,
      message: `${input.scenarioId}: status/manifest route drifted.`,
    });

    const dnsLine = `dns: ${route.dnsRecord ?? 'not required; use direct bind IP entrypoints'}`;
    assertContains({
      text: input.exposureOutput,
      expected: dnsLine,
      message: `${input.scenarioId}: exposure/manifest dns drifted.`,
    });
    assertContains({
      text: input.statusOutput,
      expected: dnsLine,
      message: `${input.scenarioId}: status/manifest dns drifted.`,
    });

    for (const endpoint of route.endpoints) {
      assertContains({
        text: input.exposureOutput,
        expected: endpoint.redactedHostnameUrl,
        message: `${input.scenarioId}: exposure/manifest hostname endpoint drifted.`,
      });
      assertContains({
        text: input.statusOutput,
        expected: endpoint.redactedHostnameUrl,
        message: `${input.scenarioId}: status/manifest hostname endpoint drifted.`,
      });
    }
  }

  assertContains({
    text: input.doctorOutput,
    expected: `detail: mode=${input.manifest.exposure.mode}`,
    message: `${input.scenarioId}: doctor/manifest mode drifted.`,
  });
  assertContains({
    text: input.doctorOutput,
    expected: `detail: mode-label=${input.manifest.exposure.posture.modeLabel}`,
    message: `${input.scenarioId}: doctor/manifest mode-label drifted.`,
  });

  if (input.manifest.exposure.posture.modeLabel !== input.exposureContract.posture.modeLabel) {
    throw new Error(
      `${input.scenarioId}: in-memory contract no longer matches verified manifest posture.`,
    );
  }
}

function tamperManifest(input: {
  readonly manifest: RuntimeBundleManifest;
}): RuntimeBundleManifest {
  const [firstRoute, ...remainingRoutes] = input.manifest.exposure.routes;

  if (!firstRoute) {
    return input.manifest;
  }

  return {
    ...input.manifest,
    exposure: {
      ...input.manifest.exposure,
      routes: [
        {
          ...firstRoute,
          bindIp: '198.18.0.200',
        },
        ...remainingRoutes,
      ],
    },
  };
}

function assertExitCode(input: {
  readonly result: CommandResult;
  readonly expected: number;
  readonly message: string;
}): void {
  if (input.result.exitCode !== input.expected) {
    throw new Error(
      `${input.message}\nexpected: ${input.expected}\nactual: ${input.result.exitCode}\nstdout:\n${input.result.stdout || '<empty>'}\nstderr:\n${input.result.stderr || '<empty>'}`,
    );
  }
}

function assertContains(input: {
  readonly text: string;
  readonly expected: string;
  readonly message: string;
}): void {
  if (!input.text.includes(input.expected)) {
    throw new Error(`${input.message}\nmissing: ${input.expected}`);
  }
}

function assertNotContains(input: {
  readonly text: string;
  readonly unexpected: string;
  readonly message: string;
}): void {
  if (input.text.includes(input.unexpected)) {
    throw new Error(`${input.message}\nunexpected: ${input.unexpected}`);
  }
}

function assertNoSecretLeaks(input: {
  readonly label: string;
  readonly text: string;
  readonly config: MullgateConfig;
}): void {
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
    ...input.config.routing.locations.flatMap((route) => [
      route.mullvad.accountNumber,
      route.mullvad.wireguard.privateKey,
    ]),
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
