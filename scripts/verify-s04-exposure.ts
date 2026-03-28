import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveMullgatePaths } from '../src/config/paths.js';
import { CONFIG_VERSION, type MullgateConfig, type RoutedLocation } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import { requireDefined } from '../src/required.js';
import {
  type RuntimeBundleManifest,
  renderRuntimeBundle,
} from '../src/runtime/render-runtime-bundle.js';
import {
  createFixtureRuntime,
  createFixtureRoute as createRoutedLocationFixture,
} from '../test/helpers/mullgate-fixtures.js';

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type ScenarioDefinition = {
  readonly id: 'domain-private-network' | 'direct-ip-public';
  readonly title: string;
  readonly generatedAt: string;
  readonly updateArgs: readonly string[];
  readonly expected: {
    readonly mode: 'private-network' | 'public';
    readonly baseDomain: string | null;
    readonly allowLan: boolean;
    readonly restartNeeded: boolean;
    readonly guidance: readonly string[];
    readonly warnings: readonly string[];
    readonly absentWarnings?: readonly string[];
    readonly routes: readonly {
      readonly alias: string;
      readonly hostname: string;
      readonly bindIp: string;
      readonly dnsLine: string;
    }[];
  };
};

type VerificationOptions = {
  readonly simulateDrift: boolean;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const REDACTED = '[redacted]';

const scenarios: readonly ScenarioDefinition[] = [
  {
    id: 'domain-private-network',
    title: 'domain-backed private-network exposure',
    generatedAt: '2026-03-21T06:10:00.000Z',
    updateArgs: [
      'exposure',
      '--mode',
      'private-network',
      '--base-domain',
      'proxy.example.com',
      '--route-bind-ip',
      '192.168.50.10',
      '--route-bind-ip',
      '192.168.50.11',
    ],
    expected: {
      mode: 'private-network',
      baseDomain: 'proxy.example.com',
      allowLan: true,
      restartNeeded: true,
      guidance: [
        'Private-network mode is the recommended remote posture for Tailscale, LAN, and other trusted overlays. Keep it private by ensuring every bind IP stays reachable only inside that trusted network.',
        'Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.',
        'Publish the DNS records below so every route hostname resolves to its matching bind IP.',
      ],
      warnings: [
        'info: Publish one DNS A record per route hostname and point it at the matching bind IP before expecting remote hostname access to work.',
        'warning: Exposure settings changed; rerun `mullgate validate` or `mullgate start` to refresh runtime artifacts.',
      ],
      absentWarnings: [
        'warning: Public exposure publishes authenticated proxy listeners on publicly routable IPs.',
      ],
      routes: [
        {
          alias: 'sweden-gothenburg',
          hostname: 'sweden-gothenburg.proxy.example.com',
          bindIp: '192.168.50.10',
          dnsLine: 'dns: sweden-gothenburg.proxy.example.com A 192.168.50.10',
        },
        {
          alias: 'austria-vienna',
          hostname: 'austria-vienna.proxy.example.com',
          bindIp: '192.168.50.11',
          dnsLine: 'dns: austria-vienna.proxy.example.com A 192.168.50.11',
        },
      ],
    },
  },
  {
    id: 'direct-ip-public',
    title: 'direct-IP public exposure without a base domain',
    generatedAt: '2026-03-21T06:20:00.000Z',
    updateArgs: [
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
      baseDomain: null,
      allowLan: true,
      restartNeeded: true,
      guidance: [
        'Public mode is advanced operator territory. Only use it when you intentionally want internet-reachable listeners and are prepared to harden the host around them.',
        'Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.',
        'No base domain is configured, so clients must reach each route via the direct bind IP entrypoints below.',
      ],
      warnings: [
        'warning: Public exposure publishes authenticated proxy listeners on publicly routable IPs. Confirm firewalling, rate limits, and monitoring before enabling it on the open internet.',
        'warning: Exposure settings changed; rerun `mullgate validate` or `mullgate start` to refresh runtime artifacts.',
      ],
      absentWarnings: [
        'info: Publish one DNS A record per route hostname and point it at the matching bind IP before expecting remote hostname access to work.',
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
  const results: string[] = [];

  if (!options) {
    return;
  }

  for (const scenario of scenarios) {
    const result = await verifyScenario(scenario, options);
    results.push(result);
  }

  results.push(await verifyAmbiguousFailure());

  process.stdout.write(`${['S04 exposure verification passed.', ...results].join('\n')}\n`);
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
    'Usage: pnpm exec tsx scripts/verify-s04-exposure.ts [options]',
    '',
    "Exercise S04's saved-config, exposure, hosts, and runtime-manifest surfaces",
    'for one domain-backed scenario and one direct-IP scenario. Fail if mappings, guidance,',
    'warnings, restart-needed state, or redaction drift out of sync.',
    '',
    'Options:',
    '  --simulate-drift   Tamper with the rendered manifest in-memory so the verifier exits non-zero.',
    '  -h, --help         Show this help text',
    '',
  ].join('\n');
}

async function verifyScenario(
  scenario: ScenarioDefinition,
  options: VerificationOptions,
): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), `mullgate-s04-${scenario.id}-`));
  const env = createTempEnvironment(root);
  const paths = resolveMullgatePaths(env);
  const store = new ConfigStore(paths);
  let preserveRoot = false;

  try {
    await store.save(createBaseFixtureConfig(env));

    const updateResult = await runCliCommand(env, scenario.updateArgs);

    if (updateResult.exitCode !== 0) {
      throw new Error(
        [
          `${scenario.id}: initial exposure update failed.`,
          updateResult.stderr || updateResult.stdout || 'No CLI output.',
          `config: ${paths.configFile}`,
        ].join('\n'),
      );
    }

    const config = await loadConfig(store);
    const savedConfig = await loadJsonFile<MullgateConfig>(paths.configFile, 'saved config');
    const exposureResult = await runCliCommand(env, ['exposure']);
    const hostsResult = await runCliCommand(env, ['proxy', 'access']);

    if (exposureResult.exitCode !== 0) {
      throw new Error(
        [
          `${scenario.id}: \`mullgate exposure\` failed.`,
          exposureResult.stderr || exposureResult.stdout || 'No CLI output.',
          `config: ${paths.configFile}`,
        ].join('\n'),
      );
    }

    if (hostsResult.exitCode !== 0) {
      throw new Error(
        [
          `${scenario.id}: \`mullgate hosts\` failed.`,
          hostsResult.stderr || hostsResult.stdout || 'No CLI output.',
          `config: ${paths.configFile}`,
        ].join('\n'),
      );
    }

    const renderResult = await renderRuntimeBundle({
      config,
      paths,
      generatedAt: scenario.generatedAt,
    });

    if (!renderResult.ok) {
      throw new Error(
        [
          `${scenario.id}: runtime bundle render failed.`,
          `code: ${renderResult.code}`,
          `reason: ${renderResult.message}`,
          ...(renderResult.cause ? [`cause: ${renderResult.cause}`] : []),
          ...(renderResult.artifactPath ? [`artifact: ${renderResult.artifactPath}`] : []),
        ].join('\n'),
      );
    }

    const manifestPath = renderResult.artifactPaths.manifestPath;
    const manifestFile = await loadJsonFile<RuntimeBundleManifest>(
      manifestPath,
      'runtime manifest',
    );
    const manifest =
      options.simulateDrift && scenario.id === 'domain-private-network'
        ? tamperManifest(manifestFile)
        : manifestFile;

    assertSavedConfigMatchesScenario(savedConfig, scenario);
    assertNoSecretLeaks(`${scenario.id} update output`, updateResult.stdout, config);
    assertNoSecretLeaks(`${scenario.id} exposure`, exposureResult.stdout, config);
    assertNoSecretLeaks(`${scenario.id} hosts`, hostsResult.stdout, config);
    assertNoSecretLeaks(
      `${scenario.id} runtime manifest`,
      JSON.stringify(manifestFile, null, 2),
      config,
    );
    assertExposureSurface(scenario, exposureResult.stdout);
    assertHostsSurface(scenario, hostsResult.stdout);
    assertManifestSurface(scenario, manifest);
    assertCliAndManifestAgree(scenario, exposureResult.stdout, manifest);

    return `- ${scenario.id}: ok (${scenario.title}; ${scenario.expected.routes.length} routes cross-checked across saved config, exposure, hosts, and runtime manifest)`;
  } catch (error) {
    preserveRoot = true;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\npreserved temp home: ${root}`);
  } finally {
    if (!preserveRoot) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function verifyAmbiguousFailure(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-s04-ambiguous-'));
  const env = createTempEnvironment(root);
  const paths = resolveMullgatePaths(env);
  const store = new ConfigStore(paths);
  let preserveRoot = false;

  try {
    await store.save(createBaseFixtureConfig(env));

    const result = await runCliCommand(env, [
      'exposure',
      '--mode',
      'private-network',
      '--route-bind-ip',
      '192.168.50.10',
      '--route-bind-ip',
      '192.168.50.10',
    ]);

    if (result.exitCode === 0) {
      throw new Error(
        [
          'ambiguous duplicate-bind-IP scenario unexpectedly succeeded.',
          result.stdout || 'No CLI stdout.',
          `config: ${paths.configFile}`,
        ].join('\n'),
      );
    }

    if (!result.stderr.includes('Mullgate exposure update failed.')) {
      throw new Error(
        'ambiguous duplicate-bind-IP failure did not include the exposure failure header.',
      );
    }

    if (!result.stderr.includes('code: AMBIGUOUS_SHARED_BIND_IP')) {
      throw new Error(
        'ambiguous duplicate-bind-IP failure did not expose code AMBIGUOUS_SHARED_BIND_IP.',
      );
    }

    if (!result.stderr.includes('Non-loopback multi-route exposure requires distinct bind IPs')) {
      throw new Error(
        'ambiguous duplicate-bind-IP failure did not explain the duplicate bind-IP cause.',
      );
    }

    const config = await loadConfig(store);

    if (config.setup.exposure.mode !== 'loopback') {
      throw new Error(
        'ambiguous duplicate-bind-IP failure partially mutated the saved config instead of leaving loopback intact.',
      );
    }

    return '- ambiguous-bind-ip rejection: ok (`mullgate exposure` fails loudly with AMBIGUOUS_SHARED_BIND_IP and leaves the saved config unchanged)';
  } catch (error) {
    preserveRoot = true;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\npreserved temp home: ${root}`);
  } finally {
    if (!preserveRoot) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function assertSavedConfigMatchesScenario(
  config: MullgateConfig,
  scenario: ScenarioDefinition,
): void {
  if (config.setup.exposure.mode !== scenario.expected.mode) {
    throw new Error(`${scenario.id}: saved config mode drifted to ${config.setup.exposure.mode}.`);
  }

  if (config.setup.exposure.baseDomain !== scenario.expected.baseDomain) {
    throw new Error(
      `${scenario.id}: saved config base domain drifted to ${config.setup.exposure.baseDomain ?? 'null'} (expected ${scenario.expected.baseDomain ?? 'null'}).`,
    );
  }

  if (config.setup.exposure.allowLan !== scenario.expected.allowLan) {
    throw new Error(
      `${scenario.id}: saved config allowLan drifted to ${String(config.setup.exposure.allowLan)}.`,
    );
  }

  if (config.runtime.status.phase !== 'unvalidated') {
    throw new Error(
      `${scenario.id}: expected config runtime status to be unvalidated after CLI update, got ${config.runtime.status.phase}.`,
    );
  }

  if (!config.runtime.status.message?.includes('Exposure settings changed')) {
    throw new Error(
      `${scenario.id}: config runtime status message no longer explains the restart-needed state.`,
    );
  }

  const actualRoutes = config.routing.locations.map((route) => ({
    alias: route.alias,
    hostname: route.hostname,
    bindIp: route.bindIp,
  }));
  const expectedRoutes = scenario.expected.routes.map((route) => ({
    alias: route.alias,
    hostname: route.hostname,
    bindIp: route.bindIp,
  }));

  if (JSON.stringify(actualRoutes) !== JSON.stringify(expectedRoutes)) {
    throw new Error(
      [
        `${scenario.id}: saved config route mappings drifted.`,
        `expected: ${JSON.stringify(expectedRoutes)}`,
        `actual: ${JSON.stringify(actualRoutes)}`,
      ].join('\n'),
    );
  }

  if (config.setup.bind.host !== scenario.expected.routes[0]?.bindIp) {
    throw new Error(
      `${scenario.id}: setup.bind.host drifted to ${config.setup.bind.host} instead of mirroring ${scenario.expected.routes[0]?.bindIp}.`,
    );
  }
}

function assertExposureSurface(scenario: ScenarioDefinition, output: string): void {
  assertContains(
    output,
    'Mullgate exposure report',
    `${scenario.id}: exposure report header missing.`,
  );
  assertContains(
    output,
    `mode: ${scenario.expected.mode}`,
    `${scenario.id}: exposure report mode line missing.`,
  );
  assertContains(
    output,
    `base domain: ${scenario.expected.baseDomain ?? 'n/a'}`,
    `${scenario.id}: exposure report base domain line missing.`,
  );
  assertContains(
    output,
    `allow lan: ${scenario.expected.allowLan ? 'yes' : 'no'}`,
    `${scenario.id}: exposure report allow-lan line missing.`,
  );
  assertContains(
    output,
    'runtime status: unvalidated',
    `${scenario.id}: exposure report runtime status line missing.`,
  );
  assertContains(
    output,
    `restart needed: ${scenario.expected.restartNeeded ? 'yes' : 'no'}`,
    `${scenario.id}: exposure report restart-needed line missing.`,
  );

  for (const guidanceLine of scenario.expected.guidance) {
    assertContains(
      output,
      `- ${guidanceLine}`,
      `${scenario.id}: exposure report guidance line missing: ${guidanceLine}`,
    );
  }

  for (const warningLine of scenario.expected.warnings) {
    assertContains(
      output,
      `- ${warningLine}`,
      `${scenario.id}: exposure report warning line missing: ${warningLine}`,
    );
  }

  for (const absent of scenario.expected.absentWarnings ?? []) {
    if (output.includes(absent)) {
      throw new Error(
        `${scenario.id}: exposure report unexpectedly included warning text: ${absent}`,
      );
    }
  }

  for (const [index, route] of scenario.expected.routes.entries()) {
    assertContains(
      output,
      `${index + 1}. ${route.hostname} -> ${route.bindIp}`,
      `${scenario.id}: exposure route header missing for ${route.hostname}.`,
    );
    assertContains(
      output,
      `   alias: ${route.alias}`,
      `${scenario.id}: alias line missing for ${route.hostname}.`,
    );
    assertContains(
      output,
      `   ${route.dnsLine}`,
      `${scenario.id}: dns guidance line missing for ${route.hostname}.`,
    );
    assertContains(
      output,
      `   socks5 hostname: socks5://${REDACTED}:${REDACTED}@${route.hostname}:1080`,
      `${scenario.id}: socks5 hostname endpoint missing for ${route.hostname}.`,
    );
    assertContains(
      output,
      `   socks5 direct ip: socks5://${REDACTED}:${REDACTED}@${route.bindIp}:1080`,
      `${scenario.id}: socks5 direct-IP endpoint missing for ${route.hostname}.`,
    );
    assertContains(
      output,
      `   http hostname: http://${REDACTED}:${REDACTED}@${route.hostname}:8080`,
      `${scenario.id}: http hostname endpoint missing for ${route.hostname}.`,
    );
    assertContains(
      output,
      `   http direct ip: http://${REDACTED}:${REDACTED}@${route.bindIp}:8080`,
      `${scenario.id}: http direct-IP endpoint missing for ${route.hostname}.`,
    );
    assertContains(
      output,
      `   https hostname: https://${REDACTED}:${REDACTED}@${route.hostname}:8443`,
      `${scenario.id}: https hostname endpoint missing for ${route.hostname}.`,
    );
    assertContains(
      output,
      `   https direct ip: https://${REDACTED}:${REDACTED}@${route.bindIp}:8443`,
      `${scenario.id}: https direct-IP endpoint missing for ${route.hostname}.`,
    );
  }
}

function assertHostsSurface(scenario: ScenarioDefinition, output: string): void {
  assertContains(output, 'Mullgate routed hosts', `${scenario.id}: hosts report header missing.`);
  assertContains(
    output,
    'copy/paste hosts block',
    `${scenario.id}: hosts report no longer prints the hosts block header.`,
  );

  for (const [index, route] of scenario.expected.routes.entries()) {
    assertContains(
      output,
      `${index + 1}. ${route.hostname} -> ${route.bindIp} (alias: ${route.alias}, route id: ${route.alias})`,
      `${scenario.id}: hosts report mapping missing for ${route.hostname}.`,
    );
    assertContains(
      output,
      `${route.bindIp} ${route.hostname}`,
      `${scenario.id}: hosts block line missing for ${route.hostname}.`,
    );
  }
}

function assertManifestSurface(
  scenario: ScenarioDefinition,
  manifest: RuntimeBundleManifest,
): void {
  if (manifest.exposure.mode !== scenario.expected.mode) {
    throw new Error(`${scenario.id}: manifest exposure mode drifted to ${manifest.exposure.mode}.`);
  }

  if (manifest.exposure.baseDomain !== scenario.expected.baseDomain) {
    throw new Error(
      `${scenario.id}: manifest exposure base domain drifted to ${manifest.exposure.baseDomain ?? 'null'} (expected ${scenario.expected.baseDomain ?? 'null'}).`,
    );
  }

  if (manifest.exposure.allowLan !== scenario.expected.allowLan) {
    throw new Error(
      `${scenario.id}: manifest exposure allowLan drifted to ${String(manifest.exposure.allowLan)}.`,
    );
  }

  if (manifest.exposure.runtimeStatus.phase !== 'unvalidated') {
    throw new Error(
      `${scenario.id}: manifest runtime status drifted to ${manifest.exposure.runtimeStatus.phase}.`,
    );
  }

  if (manifest.exposure.runtimeStatus.restartRequired !== scenario.expected.restartNeeded) {
    throw new Error(
      `${scenario.id}: manifest restart-needed drifted to ${String(manifest.exposure.runtimeStatus.restartRequired)}.`,
    );
  }

  const actualRoutes = manifest.routes.map((route) => ({
    alias: route.alias,
    hostname: route.hostname,
    bindIp: route.bindIp,
  }));
  const expectedRoutes = scenario.expected.routes.map((route) => ({
    alias: route.alias,
    hostname: route.hostname,
    bindIp: route.bindIp,
  }));

  if (JSON.stringify(actualRoutes) !== JSON.stringify(expectedRoutes)) {
    throw new Error(
      [
        `${scenario.id}: manifest route mappings drifted.`,
        `expected: ${JSON.stringify(expectedRoutes)}`,
        `actual: ${JSON.stringify(actualRoutes)}`,
      ].join('\n'),
    );
  }

  for (const guidanceLine of scenario.expected.guidance) {
    if (!manifest.exposure.guidance.includes(guidanceLine)) {
      throw new Error(`${scenario.id}: manifest guidance missing: ${guidanceLine}`);
    }
  }

  for (const warningLine of scenario.expected.warnings) {
    if (
      !manifest.exposure.warnings.some(
        (warning) => `${warning.severity}: ${warning.message}` === warningLine,
      )
    ) {
      throw new Error(`${scenario.id}: manifest warning missing: ${warningLine}`);
    }
  }

  for (const absent of scenario.expected.absentWarnings ?? []) {
    if (
      manifest.exposure.warnings.some(
        (warning) => `${warning.severity}: ${warning.message}` === absent,
      )
    ) {
      throw new Error(`${scenario.id}: manifest unexpectedly included warning text: ${absent}`);
    }
  }

  for (const [index, route] of scenario.expected.routes.entries()) {
    const manifestRoute = manifest.exposure.routes[index];

    if (!manifestRoute) {
      throw new Error(`${scenario.id}: manifest exposure route ${index + 1} is missing.`);
    }

    if (
      manifestRoute.alias !== route.alias ||
      manifestRoute.hostname !== route.hostname ||
      manifestRoute.bindIp !== route.bindIp
    ) {
      throw new Error(
        [
          `${scenario.id}: manifest exposure route ${index + 1} drifted.`,
          `expected: ${route.alias} ${route.hostname} -> ${route.bindIp}`,
          `actual: ${manifestRoute.alias} ${manifestRoute.hostname} -> ${manifestRoute.bindIp}`,
        ].join('\n'),
      );
    }

    const expectedDnsRecord = route.dnsLine.startsWith('dns: ')
      ? route.dnsLine.replace(/^dns: /, '')
      : route.dnsLine;
    const actualDnsRecord =
      manifestRoute.dnsRecord ?? 'not required; use direct bind IP entrypoints';

    if (actualDnsRecord !== expectedDnsRecord) {
      throw new Error(
        `${scenario.id}: manifest DNS guidance drifted for ${route.hostname}. expected ${expectedDnsRecord}, got ${actualDnsRecord}.`,
      );
    }

    assertEndpointPresent(scenario.id, manifestRoute.endpoints, route.hostname, route.bindIp);
  }
}

function assertCliAndManifestAgree(
  scenario: ScenarioDefinition,
  output: string,
  manifest: RuntimeBundleManifest,
): void {
  for (const route of manifest.exposure.routes) {
    assertContains(
      output,
      `${route.index + 1}. ${route.hostname} -> ${route.bindIp}`,
      `${scenario.id}: CLI/manifest route header drifted for ${route.hostname}.`,
    );
    assertContains(
      output,
      `   dns: ${route.dnsRecord ?? 'not required; use direct bind IP entrypoints'}`,
      `${scenario.id}: CLI/manifest DNS line drifted for ${route.hostname}.`,
    );

    for (const endpoint of route.endpoints) {
      assertContains(
        output,
        `   ${endpoint.protocol} hostname: ${endpoint.redactedHostnameUrl}`,
        `${scenario.id}: CLI/manifest hostname endpoint drifted for ${route.hostname} (${endpoint.protocol}).`,
      );
      assertContains(
        output,
        `   ${endpoint.protocol} direct ip: ${endpoint.redactedBindUrl}`,
        `${scenario.id}: CLI/manifest direct-IP endpoint drifted for ${route.hostname} (${endpoint.protocol}).`,
      );
    }
  }
}

function assertEndpointPresent(
  scenarioId: string,
  endpoints: RuntimeBundleManifest['exposure']['routes'][number]['endpoints'],
  hostname: string,
  bindIp: string,
): void {
  for (const [protocol, port] of [
    ['socks5', 1080],
    ['http', 8080],
    ['https', 8443],
  ] as const) {
    const endpoint = endpoints.find((candidate) => candidate.protocol === protocol);

    if (!endpoint) {
      throw new Error(`${scenarioId}: manifest endpoint missing for ${hostname} (${protocol}).`);
    }

    if (
      endpoint.redactedHostnameUrl !== `${protocol}://${REDACTED}:${REDACTED}@${hostname}:${port}`
    ) {
      throw new Error(
        `${scenarioId}: manifest hostname endpoint drifted for ${hostname} (${protocol}).`,
      );
    }

    if (endpoint.redactedBindUrl !== `${protocol}://${REDACTED}:${REDACTED}@${bindIp}:${port}`) {
      throw new Error(
        `${scenarioId}: manifest bind-IP endpoint drifted for ${hostname} (${protocol}).`,
      );
    }
  }
}

function tamperManifest(manifest: RuntimeBundleManifest): RuntimeBundleManifest {
  const [firstRoute, ...restRoutes] = manifest.exposure.routes;

  if (!firstRoute) {
    return manifest;
  }

  return {
    ...manifest,
    exposure: {
      ...manifest.exposure,
      routes: [
        {
          ...firstRoute,
          bindIp: '198.18.0.200',
        },
        ...restRoutes,
      ],
    },
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

async function loadJsonFile<T>(filePath: string, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    throw new Error(
      `Failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function createTempEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

function createBaseFixtureConfig(env: NodeJS.ProcessEnv): MullgateConfig {
  const paths = resolveMullgatePaths(env);
  const timestamp = '2026-03-21T06:00:00.000Z';
  const homeDir = requireDefined(env.HOME, 'Expected HOME in the verification env.');
  const certPath = path.join(homeDir, 'certs', 'proxy.crt');
  const keyPath = path.join(homeDir, 'certs', 'proxy.key');

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
        httpsPort: 8443,
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
        enabled: true,
        certPath,
        keyPath,
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: 'mullgate-runtime-test-1',
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
          deviceName: 'mullgate-runtime-test-1',
          peerEndpoint: 'se-got-wg-101.relays.mullvad.net:3401',
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
          deviceName: 'mullgate-runtime-test-2',
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
    runtime: createFixtureRuntime({
      paths,
      status: {
        phase: 'validated',
        lastCheckedAt: timestamp,
        message: 'Fixture config already validated.',
      },
    }),
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
  return createRoutedLocationFixture({
    alias: input.alias,
    hostname: input.hostname,
    bindIp: input.bindIp,
    requested: input.requested,
    country: input.country,
    city: input.city,
    hostnameLabel: input.hostnameLabel,
    resolvedAlias: input.resolvedAlias,
    routeId: input.routeId,
    httpsBackendName: input.haproxyBackendName,
    exit: {
      relayHostname: input.hostnameLabel,
      relayFqdn: input.peerEndpoint.split(':')[0] ?? `${input.hostnameLabel}.relays.mullvad.net`,
      socksHostname: `${input.hostnameLabel}.mullvad.net`,
      socksPort: 1080,
      countryCode: input.country,
      cityCode: input.city,
    },
  });
}

function assertNoSecretLeaks(surface: string, text: string, config: MullgateConfig): void {
  for (const secret of collectSecrets(config)) {
    if (text.includes(secret)) {
      throw new Error(`${surface} leaked a secret value that should have been redacted.`);
    }
  }
}

function collectSecrets(config: MullgateConfig): string[] {
  const candidates = [
    config.setup.auth.username,
    config.setup.auth.password,
    config.mullvad.accountNumber,
    config.mullvad.wireguard.privateKey,
  ];

  return [
    ...new Set(
      candidates.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  ];
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
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
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

function assertContains(text: string, expected: string, message: string): void {
  if (!text.includes(expected)) {
    throw new Error(`${message}\nmissing: ${expected}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
