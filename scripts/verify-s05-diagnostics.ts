#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveMullgatePaths } from '../src/config/paths.js';
import {
  CONFIG_VERSION,
  type MullgateConfig,
  type RoutedLocation,
  type RuntimeStartDiagnostic,
} from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import type { MullvadRelayCatalog } from '../src/mullvad/fetch-relays.js';
import { renderRuntimeBundle } from '../src/runtime/render-runtime-bundle.js';
import type { ValidateRuntimeResult } from '../src/runtime/validate-runtime.js';
import {
  createFixtureRuntime,
  createFixtureRoute as createRoutedLocationFixture,
} from '../test/helpers/mullgate-fixtures.js';

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type VerificationOptions = {
  readonly simulateDrift: boolean;
};

type DockerScenario = 'unconfigured' | 'healthy' | 'degraded-auth' | 'hostname-drift';

type SeededScenario = {
  readonly env: NodeJS.ProcessEnv;
  readonly paths: ReturnType<typeof resolveMullgatePaths>;
  readonly config: MullgateConfig;
};

type FixtureConfigOptions = {
  readonly routeHostnames: readonly [string, string];
  readonly routeBindIps: readonly [string, string];
  readonly runtimePhase: MullgateConfig['runtime']['status']['phase'];
  readonly runtimeCheckedAt: string;
  readonly runtimeMessage: string;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const _REDACTED = '[redacted]';
const TLS_PRIVATE_KEY_FIXTURE = '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----';
const ENTRY_TUNNEL_SERVICE = 'entry-tunnel';
const ROUTE_PROXY_SERVICE = 'route-proxy';
const ROUTING_LAYER_SERVICE = 'routing-layer';
const PRIMARY_ROUTE = {
  alias: 'sweden-gothenburg',
  routeId: 'se-got-wg-101',
  requested: 'sweden-gothenburg',
  country: 'se',
  city: 'got',
  hostnameLabel: 'se-got-wg-101',
  wireproxyServiceName: 'wireproxy-se-got-wg-101',
  haproxyBackendName: 'route-se-got-wg-101',
  wireproxyConfigFile: 'wireproxy-se-got-wg-101.conf',
  deviceName: 'mullgate-s05-test-1',
  publicKey: 'public-key-value-1',
  privateKey: 'private-key-value-1',
  ipv4Address: '10.64.12.34/32',
  ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1234/128',
  peerEndpoint: 'se-got-wg-101.relays.mullvad.net:51820',
} as const;
const SECONDARY_ROUTE = {
  alias: 'austria-vienna',
  routeId: 'at-vie-wg-001',
  requested: 'austria-vienna',
  country: 'at',
  city: 'vie',
  hostnameLabel: 'at-vie-wg-001',
  wireproxyServiceName: 'wireproxy-at-vie-wg-001',
  haproxyBackendName: 'route-at-vie-wg-001',
  wireproxyConfigFile: 'wireproxy-at-vie-wg-001.conf',
  deviceName: 'mullgate-s05-test-2',
  publicKey: 'public-key-value-2',
  privateKey: 'private-key-value-2',
  ipv4Address: '10.64.12.35/32',
  ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1235/128',
  peerEndpoint: 'at-vie-wg-001.relays.mullvad.net:51820',
} as const;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options) {
    return;
  }

  const results = [
    await verifyUnconfiguredScenario(),
    await verifyHealthyScenario(options),
    await verifyDegradedAuthScenario(),
    await verifyHostnameDriftScenario(),
  ];

  process.stdout.write(`${['S05 diagnostics verification passed.', ...results].join('\n')}\n`);
}

function parseArgs(argv: readonly string[]): VerificationOptions | null {
  let simulateDrift = false;

  for (const argument of argv) {
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
    'Usage: pnpm tsx scripts/verify-s05-diagnostics.ts [options]',
    '',
    'Exercise the real `mullgate status` and `mullgate doctor` CLI commands inside temp XDG homes,',
    'backed by fake Docker Compose JSON, and fail on state-classification, remediation, route-context,',
    'or redaction drift across healthy and broken S05 diagnostics scenarios.',
    '',
    'Options:',
    '  --simulate-drift   Deliberately break a known assertion so the verifier exits non-zero.',
    '  -h, --help         Show this help text.',
    '',
  ].join('\n');
}

async function verifyUnconfiguredScenario(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-s05-unconfigured-'));
  let preserveRoot = false;

  try {
    const env = await createTempEnvironment(root, 'unconfigured');
    const status = await runCliCommand(env, ['status']);
    const doctor = await runCliCommand(env, ['proxy', 'doctor']);

    await writeScenarioArtifacts(root, { status, doctor });

    assertExitCode(status, 0, 'unconfigured: status should succeed with an explanatory report');
    assertExitCode(doctor, 1, 'unconfigured: doctor should fail cleanly on a missing config');
    assertContains(
      status.stdout,
      'phase: unconfigured',
      'unconfigured: status report did not classify the install as unconfigured.',
    );
    assertContains(
      status.stdout,
      'next step: run `mullgate setup` before expecting runtime artifacts or Docker containers.',
      'unconfigured: status report did not explain the next step.',
    );
    assertContains(doctor.stderr, 'overall: fail', 'unconfigured: doctor did not fail loudly.');
    assertContains(
      doctor.stderr,
      'Run `mullgate setup` first, then rerun `mullgate doctor` once a canonical config exists.',
      'unconfigured: doctor remediation drifted.',
    );

    return '- unconfigured: ok (`mullgate status` and `mullgate doctor` both explain the missing-config path and point operators back to `mullgate setup`)';
  } catch (error) {
    preserveRoot = true;
    throw withPreservedRoot(root, error);
  } finally {
    if (!preserveRoot) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function verifyHealthyScenario(options: VerificationOptions): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-s05-healthy-'));
  let preserveRoot = false;

  try {
    const seeded = await seedConfiguredScenario(
      root,
      'healthy',
      {
        routeHostnames: ['127.0.0.1', '127.0.0.2'],
        routeBindIps: ['127.0.0.1', '127.0.0.2'],
        runtimePhase: 'running',
        runtimeCheckedAt: '2026-03-21T09:00:00.000Z',
        runtimeMessage: 'Runtime is already up.',
      },
      {
        relayFetchedAt: '2026-03-21T08:55:00.000Z',
        writeValidationReports: true,
        lastStart: createSuccessfulLastStart(
          resolveMullgatePaths(await createTempEnvironment(root, 'healthy')).runtimeComposeFile,
        ),
      },
    );

    const status = await runCliCommand(seeded.env, ['status']);
    const doctor = await runCliCommand(seeded.env, ['proxy', 'doctor']);

    await writeScenarioArtifacts(root, { status, doctor });

    assertExitCode(status, 0, 'healthy: status should exit successfully.');
    assertExitCode(doctor, 0, 'healthy: doctor should exit successfully.');
    assertContains(
      status.stdout,
      'phase: running',
      'healthy: status did not classify the runtime as running.',
    );
    assertContains(
      status.stdout,
      'container summary: 3 total, 3 running, 0 starting, 0 stopped, 0 unhealthy',
      'healthy: status runtime summary drifted.',
    );
    assertContains(doctor.stdout, 'overall: pass', 'healthy: doctor did not stay green.');
    assertContains(
      doctor.stdout,
      '8. runtime: pass',
      'healthy: doctor runtime check drifted away from pass.',
    );
    assertContains(
      doctor.stdout,
      '9. last-start: pass',
      'healthy: doctor last-start success check drifted.',
    );
    assertSharedFact(
      status.stdout,
      doctor.stdout,
      `config: ${seeded.paths.configFile}`,
      'healthy: status/doctor config path drifted.',
    );
    assertSharedFact(
      status.stdout,
      doctor.stdout,
      `runtime dir: ${seeded.paths.runtimeDir}`,
      'healthy: status/doctor runtime dir drifted.',
    );
    assertSharedFact(
      status.stdout,
      doctor.stdout,
      seeded.paths.runtimeComposeFile,
      'healthy: status/doctor compose path drifted.',
    );
    assertContains(
      status.stdout,
      `${ENTRY_TUNNEL_SERVICE}: running`,
      'healthy: status did not expose the shared entry-tunnel service.',
    );
    assertContains(
      doctor.stdout,
      `${ENTRY_TUNNEL_SERVICE}=running`,
      'healthy: doctor did not expose the shared entry-tunnel service.',
    );
    assertContains(
      status.stdout,
      `${ROUTE_PROXY_SERVICE}: running`,
      'healthy: status did not expose the shared route-proxy service.',
    );
    assertContains(
      doctor.stdout,
      `${ROUTE_PROXY_SERVICE}=running`,
      'healthy: doctor did not expose the shared route-proxy service.',
    );
    assertContains(
      status.stdout,
      `${ROUTING_LAYER_SERVICE}: running`,
      'healthy: status did not expose the shared routing-layer service.',
    );
    assertContains(
      doctor.stdout,
      `${ROUTING_LAYER_SERVICE}=running`,
      'healthy: doctor did not expose the shared routing-layer service.',
    );
    assertContains(
      status.stdout,
      `shared service: ${ROUTE_PROXY_SERVICE}`,
      'healthy: status did not expose the shared per-route service mapping.',
    );
    assertContains(
      doctor.stdout,
      `route ${PRIMARY_ROUTE.routeId} publishes 127.0.0.1 -> 127.0.0.1 via ${ROUTE_PROXY_SERVICE}`,
      'healthy: doctor did not preserve the primary route mapping.',
    );
    assertContains(
      doctor.stdout,
      `route ${SECONDARY_ROUTE.routeId} publishes 127.0.0.2 -> 127.0.0.2 via ${ROUTE_PROXY_SERVICE}`,
      'healthy: doctor did not preserve the secondary route mapping.',
    );
    assertNoSecretLeaks('healthy status', status.stdout, seeded.config);
    assertNoSecretLeaks('healthy doctor', doctor.stdout, seeded.config);

    if (options.simulateDrift) {
      assertContains(
        status.stdout,
        'phase: degraded',
        'simulate-drift: intentionally expecting the healthy status report to classify as degraded.',
      );
    }

    return '- healthy: ok (`mullgate status` and `mullgate doctor` agree on a running routed install, expose matching route/container facts, and keep secrets redacted)';
  } catch (error) {
    preserveRoot = true;
    throw withPreservedRoot(root, error);
  } finally {
    if (!preserveRoot) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function verifyDegradedAuthScenario(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-s05-degraded-auth-'));
  let preserveRoot = false;

  try {
    const envForPaths = await createTempEnvironment(root, 'degraded-auth');
    const paths = resolveMullgatePaths(envForPaths);
    const seeded = await seedConfiguredScenario(
      root,
      'degraded-auth',
      {
        routeHostnames: ['127.0.0.1', '127.0.0.2'],
        routeBindIps: ['127.0.0.1', '127.0.0.2'],
        runtimePhase: 'running',
        runtimeCheckedAt: '2026-03-21T09:10:00.000Z',
        runtimeMessage: 'Runtime started successfully.',
      },
      {
        relayFetchedAt: '2026-03-21T09:05:00.000Z',
        writeValidationReports: true,
        lastStart: {
          attemptedAt: '2026-03-21T09:10:00.000Z',
          status: 'failure',
          phase: 'compose-launch',
          source: 'docker-compose',
          code: 'COMPOSE_UP_FAILED',
          message:
            'Docker Compose failed for multi-route-secret / 123456789012 / private-key-value-2 while authenticating route at-vie-wg-001.',
          cause: `service ${ROUTE_PROXY_SERVICE} rejected username alice password multi-route-secret while reading ${TLS_PRIVATE_KEY_FIXTURE}`,
          artifactPath: null,
          composeFilePath: null,
          validationSource: 'internal-syntax',
          routeId: SECONDARY_ROUTE.routeId,
          routeHostname: '127.0.0.2',
          routeBindIp: '127.0.0.2',
          serviceName: ROUTE_PROXY_SERVICE,
          command: `docker compose --file ${paths.runtimeComposeFile} up --detach`,
        },
      },
    );

    const status = await runCliCommand(seeded.env, ['status']);
    const doctor = await runCliCommand(seeded.env, ['proxy', 'doctor']);

    await writeScenarioArtifacts(root, { status, doctor });

    assertExitCode(status, 0, 'degraded-auth: status should still return a rendered report.');
    assertExitCode(
      doctor,
      1,
      'degraded-auth: doctor should fail on degraded runtime/auth evidence.',
    );
    assertContains(
      status.stdout,
      'phase: degraded',
      'degraded-auth: status did not classify the runtime as degraded.',
    );
    assertContains(
      status.stdout,
      `${ROUTE_PROXY_SERVICE} is not fully healthy:`,
      'degraded-auth: status warning lost the failing shared service context.',
    );
    assertContains(
      status.stdout,
      `shared service: ${ROUTE_PROXY_SERVICE}`,
      'degraded-auth: status stopped exposing the failing shared service name.',
    );
    assertContains(
      status.stdout,
      'the last recorded `mullgate start` attempt failed; inspect the last-start diagnostics below before restarting blindly.',
      'degraded-auth: status remediation drifted.',
    );
    assertContains(doctor.stderr, 'overall: fail', 'degraded-auth: doctor did not fail.');
    assertContains(
      doctor.stderr,
      '8. runtime: fail',
      'degraded-auth: doctor runtime check drifted away from fail.',
    );
    assertContains(
      doctor.stderr,
      '9. last-start: fail',
      'degraded-auth: doctor last-start check drifted away from fail.',
    );
    assertContains(
      doctor.stderr,
      `route-id=${SECONDARY_ROUTE.routeId}`,
      'degraded-auth: doctor lost the failing route id.',
    );
    assertContains(
      doctor.stderr,
      `service=${ROUTE_PROXY_SERVICE}`,
      'degraded-auth: doctor lost the failing service name.',
    );
    assertContains(
      doctor.stderr,
      'If credentials changed, update `setup.auth.username` / `setup.auth.password` with `mullgate config set`, then rerun `mullgate validate` and `mullgate start`.',
      'degraded-auth: doctor auth remediation drifted.',
    );
    assertContains(
      status.stdout,
      'route bind ip: 127.0.0.2',
      'degraded-auth: status lost the failing route bind-ip context.',
    );
    assertContains(
      doctor.stderr,
      'route-bind-ip=127.0.0.2',
      'degraded-auth: doctor lost the failing route bind-ip context.',
    );
    assertNoSecretLeaks('degraded-auth status', status.stdout, seeded.config);
    assertNoSecretLeaks('degraded-auth doctor', doctor.stderr, seeded.config);

    return '- degraded-auth: ok (a stopped route plus persisted auth-flavored last-start failure stays route-aware, redacted, and recovery-oriented across both CLI surfaces)';
  } catch (error) {
    preserveRoot = true;
    throw withPreservedRoot(root, error);
  } finally {
    if (!preserveRoot) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function verifyHostnameDriftScenario(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-s05-hostname-drift-'));
  let preserveRoot = false;

  try {
    const seeded = await seedConfiguredScenario(
      root,
      'hostname-drift',
      {
        routeHostnames: ['127.0.0.1', 'localhost'],
        routeBindIps: ['127.0.0.1', '127.0.0.2'],
        runtimePhase: 'unvalidated',
        runtimeCheckedAt: '2026-03-21T09:20:00.000Z',
        runtimeMessage:
          'Exposure settings changed; rerun `mullgate validate` or `mullgate start` to refresh runtime artifacts.',
      },
      {
        relayFetchedAt: '2026-03-21T09:15:00.000Z',
        writeValidationReports: false,
        lastStart: null,
      },
    );

    const status = await runCliCommand(seeded.env, ['status']);
    const doctor = await runCliCommand(seeded.env, ['proxy', 'doctor']);

    await writeScenarioArtifacts(root, { status, doctor });

    assertExitCode(status, 0, 'hostname-drift: status should still render a report.');
    assertExitCode(doctor, 1, 'hostname-drift: doctor should fail on hostname drift.');
    assertContains(
      status.stdout,
      'phase: stopped',
      'hostname-drift: status no longer classifies an unvalidated no-container install as stopped.',
    );
    assertContains(
      status.stdout,
      'saved config is still marked unvalidated, so runtime artifacts may lag behind recent config or exposure edits.',
      'hostname-drift: status lost the unvalidated warning.',
    );
    assertContains(
      status.stdout,
      '2. localhost -> 127.0.0.2',
      'hostname-drift: status lost the drifting hostname/bind mapping.',
    );
    assertContains(doctor.stderr, 'overall: fail', 'hostname-drift: doctor did not fail.');
    assertContains(
      doctor.stderr,
      '7. hostname-resolution: fail',
      'hostname-drift: doctor hostname-resolution check drifted away from fail.',
    );
    assertContains(
      doctor.stderr,
      `Route ${SECONDARY_ROUTE.routeId} expects localhost to resolve to 127.0.0.2`,
      'hostname-drift: doctor stopped explaining the hostname/bind mismatch.',
    );
    assertContains(
      doctor.stderr,
      'Use `mullgate hosts` and install the emitted hosts block on this machine so each route hostname resolves to its saved bind IP, then rerun `mullgate doctor`.',
      'hostname-drift: doctor lost the hosts-based remediation.',
    );
    assertContains(
      doctor.stderr,
      '8. runtime: degraded',
      'hostname-drift: doctor runtime no-container classification drifted.',
    );
    assertContains(
      doctor.stderr,
      '9. last-start: degraded',
      'hostname-drift: doctor no-last-start classification drifted.',
    );
    assertSharedFact(
      status.stdout,
      doctor.stderr,
      `config: ${seeded.paths.configFile}`,
      'hostname-drift: status/doctor config path drifted.',
    );
    assertSharedFact(
      status.stdout,
      doctor.stderr,
      `runtime dir: ${seeded.paths.runtimeDir}`,
      'hostname-drift: status/doctor runtime dir drifted.',
    );
    assertNoSecretLeaks('hostname-drift status', status.stdout, seeded.config);
    assertNoSecretLeaks('hostname-drift doctor', doctor.stderr, seeded.config);

    return '- hostname-drift: ok (`mullgate doctor` fails with explicit hosts-based remediation while `mullgate status` still reports the saved route wiring and unvalidated/stopped runtime truth)';
  } catch (error) {
    preserveRoot = true;
    throw withPreservedRoot(root, error);
  } finally {
    if (!preserveRoot) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function seedConfiguredScenario(
  root: string,
  dockerScenario: DockerScenario,
  configOptions: FixtureConfigOptions,
  options: {
    readonly relayFetchedAt: string;
    readonly writeValidationReports: boolean;
    readonly lastStart: RuntimeStartDiagnostic | null;
  },
): Promise<SeededScenario> {
  const env = await createTempEnvironment(root, dockerScenario);
  const paths = resolveMullgatePaths(env);
  const store = new ConfigStore(paths);
  const config = createFixtureConfig(env, configOptions);

  await store.save(config);

  const renderResult = await renderRuntimeBundle({
    config,
    paths,
    generatedAt: config.updatedAt,
  });

  if (!renderResult.ok) {
    throw new Error(
      [
        `Failed to render runtime bundle for ${dockerScenario}.`,
        `code: ${renderResult.code}`,
        `message: ${renderResult.message}`,
        ...(renderResult.cause ? [`cause: ${renderResult.cause}`] : []),
      ].join('\n'),
    );
  }

  await mkdir(path.dirname(config.runtime.entryWireproxyConfigPath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    config.runtime.entryWireproxyConfigPath,
    '# verifier primary wireproxy config\n',
    {
      mode: 0o600,
    },
  );
  await writeFile(config.runtime.routeProxyConfigPath, '# verifier shared route proxy config\n', {
    mode: 0o600,
  });

  if (options.writeValidationReports) {
    const report = createValidationSuccess({
      entryWireproxyConfigPath: config.runtime.entryWireproxyConfigPath,
      routeProxyConfigPath: config.runtime.routeProxyConfigPath,
      reportPath: config.runtime.validationReportPath,
    });
    await writeFile(config.runtime.validationReportPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  const relayCatalog = createRelayCatalog(options.relayFetchedAt);
  await mkdir(path.dirname(paths.provisioningCacheFile), { recursive: true, mode: 0o700 });
  await writeFile(paths.provisioningCacheFile, `${JSON.stringify(relayCatalog, null, 2)}\n`, {
    mode: 0o600,
  });

  if (options.lastStart) {
    await mkdir(path.dirname(paths.runtimeStartDiagnosticsFile), { recursive: true, mode: 0o700 });
    await writeFile(
      paths.runtimeStartDiagnosticsFile,
      `${JSON.stringify(options.lastStart, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  return {
    env,
    paths,
    config,
  };
}

async function createTempEnvironment(
  root: string,
  dockerScenario: DockerScenario,
): Promise<NodeJS.ProcessEnv> {
  const fakeBin = path.join(root, 'fake-bin');
  await mkdir(fakeBin, { recursive: true, mode: 0o700 });
  await installFakeDocker(fakeBin);

  return {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    PATH: [fakeBin, process.env.PATH ?? '']
      .filter((value) => value.length > 0)
      .join(path.delimiter),
    MULLGATE_FAKE_DOCKER_SCENARIO: dockerScenario,
  };
}

function createFixtureConfig(
  env: NodeJS.ProcessEnv,
  options: FixtureConfigOptions,
): MullgateConfig {
  const paths = resolveMullgatePaths(env);
  const timestamp = options.runtimeCheckedAt;

  return {
    version: CONFIG_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    setup: {
      source: 'guided-setup',
      bind: {
        host: options.routeBindIps[0],
        socksPort: 1080,
        httpPort: 8080,
        httpsPort: null,
      },
      auth: {
        username: 'alice',
        password: 'multi-route-secret',
      },
      access: {
        mode: 'published-routes',
        allowUnsafePublicEmptyPassword: false,
      },
      exposure: {
        mode: 'loopback',
        allowLan: false,
        baseDomain: null,
      },
      location: {
        requested: PRIMARY_ROUTE.requested,
        country: PRIMARY_ROUTE.country,
        city: PRIMARY_ROUTE.city,
        hostnameLabel: PRIMARY_ROUTE.hostnameLabel,
        resolvedAlias: PRIMARY_ROUTE.alias,
      },
      https: {
        enabled: false,
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: PRIMARY_ROUTE.deviceName,
      lastProvisionedAt: timestamp,
      relayConstraints: {
        providers: [],
      },
      wireguard: {
        publicKey: PRIMARY_ROUTE.publicKey,
        privateKey: PRIMARY_ROUTE.privateKey,
        ipv4Address: PRIMARY_ROUTE.ipv4Address,
        ipv6Address: PRIMARY_ROUTE.ipv6Address,
        gatewayIpv4: '10.64.0.1',
        gatewayIpv6: 'fc00:bbbb:bbbb:bb01::1',
        dnsServers: ['10.64.0.1'],
        peerPublicKey: `peer-${PRIMARY_ROUTE.publicKey}`,
        peerEndpoint: PRIMARY_ROUTE.peerEndpoint,
      },
    },
    routing: {
      locations: [
        createRouteFixture({
          route: PRIMARY_ROUTE,
          hostname: options.routeHostnames[0],
          bindIp: options.routeBindIps[0],
        }),
        createRouteFixture({
          route: SECONDARY_ROUTE,
          hostname: options.routeHostnames[1],
          bindIp: options.routeBindIps[1],
        }),
      ],
    },
    runtime: createFixtureRuntime({
      paths,
      status: {
        phase: options.runtimePhase,
        lastCheckedAt: options.runtimeCheckedAt,
        message: options.runtimeMessage,
      },
    }),
    diagnostics: {
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

function createRouteFixture(input: {
  readonly route: typeof PRIMARY_ROUTE | typeof SECONDARY_ROUTE;
  readonly hostname: string;
  readonly bindIp: string;
}): RoutedLocation {
  return createRoutedLocationFixture({
    alias: input.route.alias,
    hostname: input.hostname,
    bindIp: input.bindIp,
    requested: input.route.requested,
    country: input.route.country,
    city: input.route.city,
    hostnameLabel: input.route.hostnameLabel,
    resolvedAlias: input.route.alias,
    routeId: input.route.routeId,
    httpsBackendName: input.route.haproxyBackendName,
    exit: {
      relayHostname: input.route.hostnameLabel,
      relayFqdn:
        input.route.peerEndpoint.split(':')[0] ?? `${input.route.hostnameLabel}.relays.mullvad.net`,
      socksHostname: `${input.route.hostnameLabel}.mullvad.net`,
      socksPort: 1080,
      countryCode: input.route.country,
      cityCode: input.route.city,
    },
  });
}

function createRelayCatalog(fetchedAt: string): MullvadRelayCatalog {
  return {
    source: 'app-wireguard-v1',
    fetchedAt,
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
        hostname: SECONDARY_ROUTE.routeId,
        fqdn: `${SECONDARY_ROUTE.routeId}.relays.mullvad.net`,
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
        hostname: PRIMARY_ROUTE.routeId,
        fqdn: `${PRIMARY_ROUTE.routeId}.relays.mullvad.net`,
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

function createValidationSuccess(input: {
  readonly entryWireproxyConfigPath: string;
  readonly routeProxyConfigPath: string;
  readonly reportPath: string;
}): ValidateRuntimeResult {
  return {
    ok: true,
    phase: 'validation',
    source: 'validation-suite',
    status: 'success',
    checkedAt: '2026-03-21T09:00:00.000Z',
    reportPath: input.reportPath,
    checks: [
      {
        artifact: 'entry-wireproxy',
        ok: true,
        source: 'internal-syntax',
        validator: 'internal-syntax',
        target: input.entryWireproxyConfigPath,
        issues: [],
      },
      {
        artifact: 'route-proxy',
        ok: true,
        source: 'internal-syntax',
        validator: 'internal-syntax',
        target: input.routeProxyConfigPath,
        issues: [],
      },
    ],
  };
}

function createSuccessfulLastStart(composeFilePath: string): RuntimeStartDiagnostic {
  return {
    attemptedAt: '2026-03-21T09:00:00.000Z',
    status: 'success',
    phase: 'compose-launch',
    source: 'docker-compose',
    code: null,
    message: 'Docker Compose launched the Mullgate runtime bundle in detached mode.',
    cause: null,
    artifactPath: composeFilePath,
    composeFilePath,
    validationSource: 'internal-syntax',
    routeId: null,
    routeHostname: null,
    routeBindIp: null,
    serviceName: null,
    command: `docker compose --file ${composeFilePath} up --detach`,
  };
}

async function installFakeDocker(directory: string): Promise<void> {
  const dockerPath = path.join(directory, 'docker');
  await writeFile(dockerPath, renderFakeDockerScript(), { mode: 0o755 });
  await chmod(dockerPath, 0o755);
}

function renderFakeDockerScript(): string {
  const outputs: Record<DockerScenario, string> = {
    unconfigured: '[]',
    healthy: JSON.stringify(createFakeDockerContainers('healthy'), null, 2),
    'degraded-auth': JSON.stringify(createFakeDockerContainers('degraded-auth'), null, 2),
    'hostname-drift': '[]',
  };

  return `#!/bin/sh
set -eu
scenario="\${MULLGATE_FAKE_DOCKER_SCENARIO:-}"
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "version" ]; then
  printf '%s\n' 'Docker Compose version v2.40.0'
  exit 0
fi
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "--file" ] && [ "\${4:-}" = "ps" ] && [ "\${5:-}" = "--all" ] && [ "\${6:-}" = "--format" ] && [ "\${7:-}" = "json" ]; then
  case "\${scenario}" in
    unconfigured)
      cat <<'EOF'
${outputs.unconfigured}
EOF
      ;;
    healthy)
      cat <<'EOF'
${outputs.healthy}
EOF
      ;;
    degraded-auth)
      cat <<'EOF'
${outputs['degraded-auth']}
EOF
      ;;
    hostname-drift)
      cat <<'EOF'
${outputs['hostname-drift']}
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

function createFakeDockerContainers(
  scenario: Extract<DockerScenario, 'healthy' | 'degraded-auth'>,
): unknown[] {
  const base = [
    {
      Name: 'mullgate-entry-tunnel-1',
      Service: ENTRY_TUNNEL_SERVICE,
      Project: 'mullgate',
      State: 'running',
      Health: 'healthy',
      Status: scenario === 'healthy' ? 'Up 45 seconds' : 'Up 2 minutes',
      ExitCode: 0,
      Publishers: [],
    },
    {
      Name: 'mullgate-route-proxy-1',
      Service: ROUTE_PROXY_SERVICE,
      Project: 'mullgate',
      State: 'running',
      Health: 'healthy',
      Status: scenario === 'healthy' ? 'Up 45 seconds' : 'Up 2 minutes',
      ExitCode: 0,
      Publishers: [],
    },
    {
      Name: 'mullgate-routing-layer-1',
      Service: ROUTING_LAYER_SERVICE,
      Project: 'mullgate',
      State: 'running',
      Health: 'healthy',
      Status: scenario === 'healthy' ? 'Up 45 seconds' : 'Up 2 minutes',
      ExitCode: 0,
      Publishers: [],
    },
  ];

  if (scenario === 'healthy') {
    return base;
  }

  return [
    {
      ...base[0],
    },
    {
      Name: 'mullgate-route-proxy-1',
      Service: ROUTE_PROXY_SERVICE,
      Project: 'mullgate',
      State: 'exited',
      Health: null,
      Status: 'Exited (2) 5 seconds ago',
      ExitCode: 2,
      Publishers: [],
    },
    {
      ...base[2],
    },
  ];
}

async function writeScenarioArtifacts(
  root: string,
  input: { readonly status: CommandResult; readonly doctor: CommandResult },
): Promise<void> {
  await writeFile(path.join(root, 'status.stdout.txt'), input.status.stdout, { mode: 0o600 });
  await writeFile(path.join(root, 'status.stderr.txt'), input.status.stderr, { mode: 0o600 });
  await writeFile(path.join(root, 'doctor.stdout.txt'), input.doctor.stdout, { mode: 0o600 });
  await writeFile(path.join(root, 'doctor.stderr.txt'), input.doctor.stderr, { mode: 0o600 });
  await writeFile(
    path.join(root, 'command-results.json'),
    `${JSON.stringify(
      {
        status: { exitCode: input.status.exitCode },
        doctor: { exitCode: input.doctor.exitCode },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function runCliCommand(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<CommandResult> {
  return runCommand(process.execPath, [tsxCliPath, 'src/cli.ts', ...args], {
    cwd: repoRoot,
    env,
  });
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
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

function assertExitCode(result: CommandResult, expected: number, message: string): void {
  if (result.exitCode !== expected) {
    throw new Error(
      `${message}\nexpected: ${expected}\nactual: ${result.exitCode}\nstdout:\n${result.stdout || '<empty>'}\nstderr:\n${result.stderr || '<empty>'}`,
    );
  }
}

function assertContains(text: string, expected: string, message: string): void {
  if (!text.includes(expected)) {
    throw new Error(`${message}\nmissing: ${expected}`);
  }
}

function assertNotContains(text: string, unexpected: string, message: string): void {
  if (text.includes(unexpected)) {
    throw new Error(`${message}\nunexpected: ${unexpected}`);
  }
}

function assertSharedFact(left: string, right: string, expected: string, message: string): void {
  assertContains(left, expected, message);
  assertContains(right, expected, message);
}

function assertNoSecretLeaks(surface: string, text: string, config: MullgateConfig): void {
  for (const secret of collectSecrets(config)) {
    assertNotContains(text, secret, `${surface} leaked a secret that should have been redacted.`);
  }

  assertNotContains(
    text,
    TLS_PRIVATE_KEY_FIXTURE,
    `${surface} leaked the TLS private key fixture.`,
  );
  assertNotContains(text, 'BEGIN PRIVATE KEY', `${surface} leaked raw private-key material.`);
}

function collectSecrets(config: MullgateConfig): string[] {
  return [
    config.setup.auth.password,
    config.mullvad.accountNumber,
    config.mullvad.wireguard.privateKey,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function withPreservedRoot(root: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\npreserved temp home: ${root}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
