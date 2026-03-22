#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveMullgatePaths, resolveRouteWireproxyPaths } from '../src/config/paths.js';
import { ConfigStore } from '../src/config/store.js';
import { CONFIG_VERSION, type MullgateConfig, type RoutedLocation } from '../src/config/schema.js';
import type { MullvadRelayCatalog } from '../src/mullvad/fetch-relays.js';
import { renderRuntimeBundle, type RuntimeBundleManifest } from '../src/runtime/render-runtime-bundle.js';
import type { ValidateWireproxyResult } from '../src/runtime/validate-wireproxy.js';

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
  readonly generatedAt: string;
  readonly updateArgs: readonly string[];
  readonly expected: {
    readonly mode: 'loopback' | 'private-network' | 'public';
    readonly modeLabel: string;
    readonly recommendation: 'local-default' | 'recommended-remote' | 'advanced-remote';
    readonly postureSummary: string;
    readonly remoteStory: string;
    readonly guidance: readonly string[];
    readonly warnings: readonly string[];
    readonly routes: readonly {
      readonly alias: string;
      readonly hostname: string;
      readonly bindIp: string;
      readonly dnsLine: string;
    }[];
  };
};

type SeededScenario = {
  readonly env: NodeJS.ProcessEnv;
  readonly paths: ReturnType<typeof resolveMullgatePaths>;
  readonly store: ConfigStore;
  readonly config: MullgateConfig;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const REDACTED = '[redacted]';

const scenarios: readonly ScenarioDefinition[] = [
  {
    id: 'loopback-default',
    title: 'default local-only loopback posture',
    generatedAt: '2026-03-22T16:00:00.000Z',
    updateArgs: [],
    expected: {
      mode: 'loopback',
      modeLabel: 'Loopback / local-only',
      recommendation: 'local-default',
      postureSummary: 'Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.',
      remoteStory: 'Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.',
      guidance: [
        'Loopback mode is the default local-only posture. Keep it for same-machine use and developer/operator checks.',
        'Use `mullgate config hosts` if you want a copy/paste /etc/hosts block for this machine.',
      ],
      warnings: [
        'info: Loopback mode is local-only. Keep using `mullgate config hosts` for host-file testing on this machine.',
      ],
      routes: [
        {
          alias: 'sweden-gothenburg',
          hostname: 'sweden-gothenburg',
          bindIp: '127.0.0.1',
          dnsLine: 'dns: not required; use direct bind IP entrypoints',
        },
        {
          alias: 'austria-vienna',
          hostname: 'austria-vienna',
          bindIp: '127.0.0.2',
          dnsLine: 'dns: not required; use direct bind IP entrypoints',
        },
      ],
    },
  },
  {
    id: 'private-network-direct',
    title: 'recommended private-network remote posture',
    generatedAt: '2026-03-22T16:05:00.000Z',
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
    expected: {
      mode: 'private-network',
      modeLabel: 'Private network / Tailscale-first',
      recommendation: 'recommended-remote',
      postureSummary: 'Recommended remote posture. Use this for Tailscale, LAN, or other trusted private overlays before considering public exposure.',
      remoteStory: 'Keep bind IPs private, ensure route hostnames resolve inside the trusted network, and use `mullgate config hosts` when local host-file wiring is the easiest path.',
      guidance: [
        'Private-network mode is the recommended remote posture for Tailscale, LAN, and other trusted overlays. Keep it private by ensuring every bind IP stays reachable only inside that trusted network.',
        'Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.',
        'No base domain is configured, so clients must reach each route via the direct bind IP entrypoints below.',
      ],
      warnings: [
        'warning: Exposure settings changed; rerun `mullgate config validate` or `mullgate start` to refresh runtime artifacts.',
      ],
      routes: [
        {
          alias: 'sweden-gothenburg',
          hostname: '192.168.50.10',
          bindIp: '192.168.50.10',
          dnsLine: 'dns: not required; use direct bind IP entrypoints',
        },
        {
          alias: 'austria-vienna',
          hostname: '192.168.50.11',
          bindIp: '192.168.50.11',
          dnsLine: 'dns: not required; use direct bind IP entrypoints',
        },
      ],
    },
  },
  {
    id: 'public-direct',
    title: 'advanced public direct-IP posture',
    generatedAt: '2026-03-22T16:10:00.000Z',
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
    expected: {
      mode: 'public',
      modeLabel: 'Advanced public exposure',
      recommendation: 'advanced-remote',
      postureSummary: 'Expert-only remote posture. Publicly routable listeners are possible, but Mullgate does not treat this as the default or safest operating mode.',
      remoteStory: 'Prefer private-network mode unless you intentionally need internet-reachable listeners and can provide DNS, firewalling, monitoring, and host hardening yourself.',
      guidance: [
        'Public mode is advanced operator territory. Only use it when you intentionally want internet-reachable listeners and are prepared to harden the host around them.',
        'Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.',
        'No base domain is configured, so clients must reach each route via the direct bind IP entrypoints below.',
      ],
      warnings: [
        'warning: Public exposure publishes authenticated proxy listeners on publicly routable IPs. Confirm firewalling, rate limits, and monitoring before enabling it on the open internet.',
        'warning: Exposure settings changed; rerun `mullgate config validate` or `mullgate start` to refresh runtime artifacts.',
      ],
      routes: [
        {
          alias: 'sweden-gothenburg',
          hostname: '203.0.113.10',
          bindIp: '203.0.113.10',
          dnsLine: 'dns: not required; use direct bind IP entrypoints',
        },
        {
          alias: 'austria-vienna',
          hostname: '203.0.113.11',
          bindIp: '203.0.113.11',
          dnsLine: 'dns: not required; use direct bind IP entrypoints',
        },
      ],
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

  process.stdout.write(`${['M002 S01 network-mode verification passed.', ...results].join('\n')}\n`);
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
    'postures. Verifies that `config exposure`, `config hosts`, `status`, `doctor`, and the',
    'runtime-manifest all stay aligned on network-mode recommendation, guidance, warnings,',
    'and route hostname/bind-IP wiring.',
    '',
    'Options:',
    '  --simulate-drift   Force one verifier assertion to fail so the temp home is preserved.',
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

    if (input.scenario.updateArgs.length > 0) {
      const updateResult = await runCliCommand({ env: seeded.env, args: input.scenario.updateArgs });
      assertExitCode({
        result: updateResult,
        expected: 0,
        message: `${input.scenario.id}: exposure update failed unexpectedly.`,
      });
      assertNoSecretLeaks({ label: `${input.scenario.id} update`, text: updateResult.stdout, config: seeded.config });
    }

    const configExposure = await runCliCommand({ env: seeded.env, args: ['config', 'exposure'] });
    const configHosts = await runCliCommand({ env: seeded.env, args: ['config', 'hosts'] });
    const status = await runCliCommand({ env: seeded.env, args: ['status'] });
    const doctor = await runCliCommand({ env: seeded.env, args: ['doctor'] });
    const config = await loadConfig({ store: seeded.store });
    const renderResult = await renderRuntimeBundle({
      config,
      paths: seeded.paths,
      generatedAt: input.scenario.generatedAt,
    });

    if (!renderResult.ok) {
      throw new Error(`${input.scenario.id}: failed to render runtime bundle: ${renderResult.message}`);
    }

    const manifest = input.options.simulateDrift && input.scenario.id === 'private-network-direct'
      ? tamperManifest({ manifest: renderResult.manifest })
      : renderResult.manifest;

    await writeScenarioArtifacts({
      root,
      commandResults: {
        configExposure,
        configHosts,
        status,
        doctor,
      },
      manifest,
    });

    assertExitCode({ result: configExposure, expected: 0, message: `${input.scenario.id}: config exposure failed.` });
    assertExitCode({ result: configHosts, expected: 0, message: `${input.scenario.id}: config hosts failed.` });
    assertExitCode({ result: status, expected: 0, message: `${input.scenario.id}: status failed.` });
    assertExitCode({ result: doctor, expected: 0, message: `${input.scenario.id}: doctor should render a degraded idle-runtime report without a hard failure.` });

    assertNoSecretLeaks({ label: `${input.scenario.id} exposure`, text: configExposure.stdout, config });
    assertNoSecretLeaks({ label: `${input.scenario.id} hosts`, text: configHosts.stdout, config });
    assertNoSecretLeaks({ label: `${input.scenario.id} status`, text: status.stdout, config });
    assertNoSecretLeaks({ label: `${input.scenario.id} doctor`, text: doctor.stderr, config });

    assertExposureSurface({
      scenario: input.scenario,
      output: configExposure.stdout,
    });
    assertHostsSurface({
      scenario: input.scenario,
      output: configHosts.stdout,
    });
    assertStatusSurface({
      scenario: input.scenario,
      output: status.stdout,
    });
    assertDoctorExposureSurface({
      scenario: input.scenario,
      output: `${doctor.stdout}\n${doctor.stderr}`,
    });
    assertManifestSurface({
      scenario: input.scenario,
      manifest,
    });
    assertCliAndManifestAgree({
      scenario: input.scenario,
      exposureOutput: configExposure.stdout,
      statusOutput: status.stdout,
      manifest,
    });

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

async function seedScenario(input: { readonly root: string }): Promise<SeededScenario> {
  const env = await createTempEnvironment({ root: input.root, dockerScenario: 'idle' });
  const paths = resolveMullgatePaths(env);
  const store = new ConfigStore(paths);
  const config = createBaseFixtureConfig({ env });

  await store.save(config);
  await seedRuntimeArtifacts({ env, paths, config });

  return { env, paths, store, config };
}

async function createTempEnvironment(input: { readonly root: string; readonly dockerScenario: DockerScenario }): Promise<NodeJS.ProcessEnv> {
  const fakeBin = path.join(input.root, 'fake-bin');
  await mkdir(fakeBin, { recursive: true, mode: 0o700 });
  await installFakeDocker({ directory: fakeBin, dockerScenario: input.dockerScenario });

  return {
    ...process.env,
    HOME: input.root,
    XDG_CONFIG_HOME: path.join(input.root, 'config'),
    XDG_STATE_HOME: path.join(input.root, 'state'),
    XDG_CACHE_HOME: path.join(input.root, 'cache'),
    PATH: [fakeBin, process.env.PATH ?? ''].filter((value) => value.length > 0).join(path.delimiter),
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

async function seedRuntimeArtifacts(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly paths: ReturnType<typeof resolveMullgatePaths>;
  readonly config: MullgateConfig;
}): Promise<void> {
  const renderResult = await renderRuntimeBundle({
    config: input.config,
    paths: input.paths,
    generatedAt: input.config.updatedAt,
  });

  if (!renderResult.ok) {
    throw new Error(`Failed to render runtime bundle: ${renderResult.message}`);
  }

  await mkdir(path.dirname(input.paths.provisioningCacheFile), { recursive: true, mode: 0o700 });
  await writeFile(input.paths.provisioningCacheFile, `${JSON.stringify(createRelayCatalog(), null, 2)}\n`, { mode: 0o600 });
  await writeFile(input.paths.wireproxyConfigFile, '# primary wireproxy fixture\n', { mode: 0o600 });

  for (const route of input.config.routing.locations) {
    const routePaths = resolveRouteWireproxyPaths(input.paths, route.runtime);
    await writeFile(routePaths.wireproxyConfigPath, `# verifier route ${route.runtime.routeId}\n`, { mode: 0o600 });
    await writeFile(routePaths.configTestReportPath, `${JSON.stringify(createValidationSuccess({ targetPath: routePaths.configTestReportPath }), null, 2)}\n`, { mode: 0o600 });
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

function createValidationSuccess(input: { readonly targetPath: string }): ValidateWireproxyResult {
  return {
    ok: true,
    phase: 'validation',
    source: 'internal-syntax',
    status: 'success',
    checkedAt: '2026-03-22T15:56:00.000Z',
    target: input.targetPath,
    reportPath: input.targetPath,
    validator: 'internal-syntax',
    issues: [],
  };
}

async function installFakeDocker(input: { readonly directory: string; readonly dockerScenario: DockerScenario }): Promise<void> {
  const dockerPath = path.join(input.directory, 'docker');
  await writeFile(dockerPath, renderFakeDockerScript({ dockerScenario: input.dockerScenario }), { mode: 0o755 });
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
printf '%s\n' "unsupported fake docker invocation: $*" >&2
exit 2
`;
}

async function writeScenarioArtifacts(input: {
  readonly root: string;
  readonly commandResults: {
    readonly configExposure: CommandResult;
    readonly configHosts: CommandResult;
    readonly status: CommandResult;
    readonly doctor: CommandResult;
  };
  readonly manifest: RuntimeBundleManifest;
}): Promise<void> {
  await writeFile(path.join(input.root, 'config-exposure.stdout.txt'), input.commandResults.configExposure.stdout, { mode: 0o600 });
  await writeFile(path.join(input.root, 'config-exposure.stderr.txt'), input.commandResults.configExposure.stderr, { mode: 0o600 });
  await writeFile(path.join(input.root, 'config-hosts.stdout.txt'), input.commandResults.configHosts.stdout, { mode: 0o600 });
  await writeFile(path.join(input.root, 'config-hosts.stderr.txt'), input.commandResults.configHosts.stderr, { mode: 0o600 });
  await writeFile(path.join(input.root, 'status.stdout.txt'), input.commandResults.status.stdout, { mode: 0o600 });
  await writeFile(path.join(input.root, 'status.stderr.txt'), input.commandResults.status.stderr, { mode: 0o600 });
  await writeFile(path.join(input.root, 'doctor.stdout.txt'), input.commandResults.doctor.stdout, { mode: 0o600 });
  await writeFile(path.join(input.root, 'doctor.stderr.txt'), input.commandResults.doctor.stderr, { mode: 0o600 });
  await writeFile(path.join(input.root, 'runtime-manifest.json'), `${JSON.stringify(input.manifest, null, 2)}\n`, { mode: 0o600 });
}

async function runCliCommand(input: { readonly env: NodeJS.ProcessEnv; readonly args: readonly string[] }): Promise<CommandResult> {
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

function assertExposureSurface(input: { readonly scenario: ScenarioDefinition; readonly output: string }): void {
  assertContains({ text: input.output, expected: 'Mullgate exposure report', message: `${input.scenario.id}: exposure report header missing.` });
  assertContains({ text: input.output, expected: `mode: ${input.scenario.expected.mode}`, message: `${input.scenario.id}: exposure mode line missing.` });
  assertContains({ text: input.output, expected: `mode label: ${input.scenario.expected.modeLabel}`, message: `${input.scenario.id}: mode label missing.` });
  assertContains({ text: input.output, expected: `recommendation: ${input.scenario.expected.recommendation}`, message: `${input.scenario.id}: recommendation line missing.` });
  assertContains({ text: input.output, expected: `posture summary: ${input.scenario.expected.postureSummary}`, message: `${input.scenario.id}: posture summary missing.` });
  assertContains({ text: input.output, expected: `remote story: ${input.scenario.expected.remoteStory}`, message: `${input.scenario.id}: remote story missing.` });

  for (const guidanceLine of input.scenario.expected.guidance) {
    assertContains({ text: input.output, expected: `- ${guidanceLine}`, message: `${input.scenario.id}: guidance line missing.` });
  }

  for (const warningLine of input.scenario.expected.warnings) {
    assertContains({ text: input.output, expected: `- ${warningLine}`, message: `${input.scenario.id}: warning line missing.` });
  }

  for (const route of input.scenario.expected.routes) {
    assertContains({ text: input.output, expected: `${route.hostname} -> ${route.bindIp}`, message: `${input.scenario.id}: route header missing for ${route.hostname}.` });
    assertContains({ text: input.output, expected: route.dnsLine, message: `${input.scenario.id}: dns line missing for ${route.hostname}.` });
  }
}

function assertHostsSurface(input: { readonly scenario: ScenarioDefinition; readonly output: string }): void {
  assertContains({ text: input.output, expected: 'copy/paste hosts block', message: `${input.scenario.id}: hosts block header missing.` });

  for (const route of input.scenario.expected.routes) {
    assertContains({ text: input.output, expected: `${route.bindIp} ${route.hostname}`, message: `${input.scenario.id}: hosts block line missing for ${route.hostname}.` });
  }
}

function assertStatusSurface(input: { readonly scenario: ScenarioDefinition; readonly output: string }): void {
  assertContains({ text: input.output, expected: `mode label: ${input.scenario.expected.modeLabel}`, message: `${input.scenario.id}: status mode label missing.` });
  assertContains({ text: input.output, expected: `recommendation: ${input.scenario.expected.recommendation}`, message: `${input.scenario.id}: status recommendation missing.` });
  assertContains({ text: input.output, expected: `posture summary: ${input.scenario.expected.postureSummary}`, message: `${input.scenario.id}: status posture summary missing.` });
  assertContains({ text: input.output, expected: `remote story: ${input.scenario.expected.remoteStory}`, message: `${input.scenario.id}: status remote story missing.` });
  assertContains({ text: input.output, expected: 'network-mode guidance', message: `${input.scenario.id}: status network-mode guidance section missing.` });

  for (const guidanceLine of input.scenario.expected.guidance.slice(0, 2)) {
    assertContains({ text: input.output, expected: `- ${guidanceLine}`, message: `${input.scenario.id}: status guidance line missing.` });
  }
}

function assertDoctorExposureSurface(input: { readonly scenario: ScenarioDefinition; readonly output: string }): void {
  assertContains({ text: input.output, expected: `detail: mode=${input.scenario.expected.mode}`, message: `${input.scenario.id}: doctor exposure mode detail missing.` });
  assertContains({ text: input.output, expected: `detail: mode-label=${input.scenario.expected.modeLabel}`, message: `${input.scenario.id}: doctor mode label detail missing.` });
  assertContains({ text: input.output, expected: `detail: recommendation=${input.scenario.expected.recommendation}`, message: `${input.scenario.id}: doctor recommendation detail missing.` });
  assertContains({ text: input.output, expected: `detail: posture-summary=${input.scenario.expected.postureSummary}`, message: `${input.scenario.id}: doctor posture summary detail missing.` });
  assertContains({ text: input.output, expected: `detail: remote-story=${input.scenario.expected.remoteStory}`, message: `${input.scenario.id}: doctor remote story detail missing.` });
}

function assertManifestSurface(input: { readonly scenario: ScenarioDefinition; readonly manifest: RuntimeBundleManifest }): void {
  if (input.manifest.exposure.mode !== input.scenario.expected.mode) {
    throw new Error(`${input.scenario.id}: manifest exposure mode drifted to ${input.manifest.exposure.mode}.`);
  }

  if (input.manifest.exposure.posture.modeLabel !== input.scenario.expected.modeLabel) {
    throw new Error(`${input.scenario.id}: manifest mode label drifted.`);
  }

  if (input.manifest.exposure.posture.recommendation !== input.scenario.expected.recommendation) {
    throw new Error(`${input.scenario.id}: manifest recommendation drifted.`);
  }

  if (input.manifest.exposure.posture.summary !== input.scenario.expected.postureSummary) {
    throw new Error(`${input.scenario.id}: manifest posture summary drifted.`);
  }

  if (input.manifest.exposure.posture.remoteStory !== input.scenario.expected.remoteStory) {
    throw new Error(`${input.scenario.id}: manifest remote story drifted.`);
  }
}

function assertCliAndManifestAgree(input: {
  readonly scenario: ScenarioDefinition;
  readonly exposureOutput: string;
  readonly statusOutput: string;
  readonly manifest: RuntimeBundleManifest;
}): void {
  for (const route of input.manifest.exposure.routes) {
    assertContains({ text: input.exposureOutput, expected: `${route.hostname} -> ${route.bindIp}`, message: `${input.scenario.id}: exposure/manifest drift for ${route.hostname}.` });
    assertContains({ text: input.statusOutput, expected: `${route.hostname} -> ${route.bindIp}`, message: `${input.scenario.id}: status/manifest drift for ${route.hostname}.` });
  }
}

function tamperManifest(input: { readonly manifest: RuntimeBundleManifest }): RuntimeBundleManifest {
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

function withPreservedRoot(input: { readonly root: string; readonly error: unknown }): Error {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return new Error(`${message}\npreserved temp home: ${input.root}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
