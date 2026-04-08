import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COMPATIBILITY_ARTIFACT_VERSION,
  COMPATIBILITY_PROOF_MODEL,
  type CompatibilityProtocolObservation,
  createCompatibilityArtifact,
  serializeCompatibilityArtifact,
} from '../../src/m004/compatibility-contract.js';
import {
  parseCompatibilityArgs,
  renderCompatibilityHelp,
  renderMissingCompatibilityEnvError,
  runCompatibilityVerifier,
} from '../../src/m004/compatibility-runner.js';
import {
  createEntryIdentityFromRelay,
  createFeasibilityArtifact,
  createSingleEntryTopology,
  FEASIBILITY_PROOF_MODEL,
  type FeasibilityArtifact,
  type FeasibilityLogicalExit,
  type FeasibilityProbeObservation,
} from '../../src/m004/feasibility-contract.js';

function createLogicalExits(): FeasibilityLogicalExit[] {
  return [
    {
      logicalExitId: 'exit-1',
      relayHostname: 'at-vie-wg-001',
      relayFqdn: 'at-vie-wg-001.relays.mullvad.net',
      endpointIpv4: '146.70.111.84',
      publicKey: 'relay-public-key-1',
      socksHostname: 'at-vie-wg-socks5-001.relays.mullvad.net',
      socksPort: 1080,
      source: 'www-relays-all',
      location: {
        countryCode: 'at',
        countryName: 'Austria',
        cityCode: 'vie',
        cityName: 'Vienna',
      },
    },
    {
      logicalExitId: 'exit-2',
      relayHostname: 'se-got-wg-101',
      relayFqdn: 'se-got-wg-101.relays.mullvad.net',
      endpointIpv4: '146.70.82.14',
      publicKey: 'relay-public-key-2',
      socksHostname: 'se-got-wg-socks5-101.relays.mullvad.net',
      socksPort: 1080,
      source: 'www-relays-all',
      location: {
        countryCode: 'se',
        countryName: 'Sweden',
        cityCode: 'got',
        cityName: 'Gothenburg',
      },
    },
  ];
}

function createSuccessfulProbe(options: {
  readonly logicalExitId: string;
  readonly ip: string;
  readonly country: string;
  readonly city: string;
}): FeasibilityProbeObservation {
  return {
    ok: true,
    logicalExitId: options.logicalExitId,
    targetUrl: 'https://am.i.mullvad.net/json',
    startedAt: '2026-03-21T19:01:00.000Z',
    completedAt: '2026-03-21T19:01:01.000Z',
    durationMs: 1000,
    observedExit: {
      ip: options.ip,
      country: options.country,
      city: options.city,
    },
  };
}

function createFeasibilityFixture(): FeasibilityArtifact {
  const logicalExits = createLogicalExits();

  return createFeasibilityArtifact({
    generatedAt: '2026-03-21T19:02:00.000Z',
    topology: createSingleEntryTopology({
      entryIdentity: createEntryIdentityFromRelay({
        relay: {
          hostname: 'se-got-wg-101',
          fqdn: 'se-got-wg-101.relays.mullvad.net',
          source: 'www-relays-all',
          active: true,
          owned: true,
          publicKey: 'entry-public-key',
          endpointIpv4: '146.70.10.10',
          endpointIpv6: '2a03:1b20:5:f011::a',
          socksName: 'se-got-wg-socks5-101.relays.mullvad.net',
          socksPort: 1080,
          location: {
            countryCode: 'se',
            countryName: 'Sweden',
            cityCode: 'got',
            cityName: 'Gothenburg',
          },
        },
        deviceName: 'mullgate-m004-compatibility',
        accountNumber: '123456789012',
        wireguardPrivateKey: 'private-key-value-1',
      }),
      logicalExits,
    }),
    relaySelection: {
      requestedCount: 2,
      availableCount: 2,
      candidateCount: 3,
      missingMetadataCount: 0,
      selectedRelayHostnames: logicalExits.map((logicalExit) => logicalExit.relayHostname),
    },
    routeCheck: {
      before: {
        checkedAt: '2026-03-21T19:00:00.000Z',
        targetIp: '1.1.1.1',
        command: 'ip route get 1.1.1.1',
        normalizedRoute: '1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10 uid 1000',
        stdout: '1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10 uid 1000\n',
        stderr: '',
      },
      after: {
        checkedAt: '2026-03-21T19:03:00.000Z',
        targetIp: '1.1.1.1',
        command: 'ip route get 1.1.1.1',
        normalizedRoute: '1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10 uid 1000',
        stdout: '1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10 uid 1000\n',
        stderr: '',
      },
    },
    probes: [
      createSuccessfulProbe({
        logicalExitId: 'exit-1',
        ip: '185.65.134.10',
        country: 'Austria',
        city: 'Vienna',
      }),
      createSuccessfulProbe({
        logicalExitId: 'exit-2',
        ip: '185.65.136.30',
        country: 'Sweden',
        city: 'Gothenburg',
      }),
    ],
  });
}

function createProtocolObservations(
  overrides: Partial<
    Record<'socks5' | 'http' | 'https', Partial<CompatibilityProtocolObservation>>
  > = {},
): CompatibilityProtocolObservation[] {
  return [
    {
      protocol: 'socks5',
      probeSucceeded: true,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: true,
      observedCapabilitySummary:
        'SOCKS5 chaining reaches distinct Mullvad exits only when the client selects a relay explicitly.',
      proxyUrl: 'socks5://alice:super-secret-password@shared-entry.local:1080',
      ...overrides.socks5,
    },
    {
      protocol: 'http',
      probeSucceeded: true,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: false,
      observedCapabilitySummary:
        'HTTP reaches the shared entry but cannot choose an exit relay without a contract-breaking selector.',
      ...overrides.http,
    },
    {
      protocol: 'https',
      probeSucceeded: true,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: false,
      observedCapabilitySummary:
        'HTTPS reaches the shared entry but cannot choose an exit relay without a contract-breaking selector.',
      ...overrides.https,
    },
  ];
}

const fixturesDir = path.join(process.cwd(), 'test/fixtures');

describe('m004 compatibility contract', () => {
  it('parses compatibility args from flags and prefers the compatibility-specific output root env', () => {
    expect(
      parseCompatibilityArgs(
        [
          '--target-url',
          'https://example.com/exit.json',
          '--route-check-ip',
          '9.9.9.9',
          '--logical-exit-count',
          '2',
          '--output-root',
          '.tmp/custom-compatibility',
          '--fixture',
          './compatibility.json',
          '--keep-temp-home',
        ],
        {
          MULLGATE_ACCOUNT_NUMBER: ' 123456 ',
          MULLGATE_PROXY_USERNAME: ' alice ',
          MULLGATE_PROXY_PASSWORD: ' secret ',
          MULLGATE_DEVICE_NAME: ' mullgate-compatibility ',
          MULLGATE_MULLVAD_WG_URL: ' https://wg.example.test ',
          MULLGATE_MULLVAD_RELAYS_URL: ' https://relays.example.test ',
          MULLGATE_M004_WIREPROXY_IMAGE: ' custom/wireproxy:latest ',
        },
      ),
    ).toEqual({
      ok: true,
      options: {
        targetUrl: 'https://example.com/exit.json',
        routeCheckIp: '9.9.9.9',
        logicalExitCount: 2,
        outputRoot: '.tmp/custom-compatibility',
        keepTempHome: true,
        fixturePath: './compatibility.json',
        accountNumber: '123456',
        proxyUsername: 'alice',
        proxyPassword: 'secret',
        deviceName: 'mullgate-compatibility',
        mullvadWgUrl: 'https://wg.example.test',
        mullvadRelaysUrl: 'https://relays.example.test',
        wireproxyImage: 'custom/wireproxy:latest',
      },
    });

    expect(
      parseCompatibilityArgs([], {
        MULLGATE_VERIFY_TARGET_URL: ' https://env.example/exit.json ',
        MULLGATE_VERIFY_ROUTE_CHECK_IP: ' 8.8.8.8 ',
        MULLGATE_M004_LOGICAL_EXIT_COUNT: '2',
        MULLGATE_M004_OUTPUT_ROOT: '.tmp/fallback-root',
        MULLGATE_M004_COMPATIBILITY_OUTPUT_ROOT: ' .tmp/env-compatibility ',
      }),
    ).toEqual({
      ok: true,
      options: {
        targetUrl: 'https://env.example/exit.json',
        routeCheckIp: '8.8.8.8',
        logicalExitCount: 2,
        outputRoot: '.tmp/env-compatibility',
        keepTempHome: false,
      },
    });
  });

  it('renders compatibility help and missing-env guidance for invalid cli inputs', () => {
    expect(parseCompatibilityArgs(['--help'])).toEqual({
      ok: false,
      helpText: renderCompatibilityHelp(),
      exitCode: 0,
    });

    expect(parseCompatibilityArgs(['--logical-exit-count', '4'])).toEqual({
      ok: false,
      helpText: renderCompatibilityHelp(),
      exitCode: 1,
      error: 'Invalid --logical-exit-count value: 4. Expected 2 or 3.',
    });

    expect(parseCompatibilityArgs(['--target-url'])).toEqual({
      ok: false,
      helpText: renderCompatibilityHelp(),
      exitCode: 1,
      error: 'Missing value for --target-url.',
    });

    expect(renderCompatibilityHelp()).toContain(
      'Run the isolated M004 compatibility verifier: reuse the S01 single-entry',
    );
    expect(renderCompatibilityHelp()).toContain('Fixture mode:');
    expect(renderMissingCompatibilityEnvError({})).toContain(
      'Missing required environment variables for the live compatibility verifier:',
    );
    expect(
      renderMissingCompatibilityEnvError({
        MULLGATE_ACCOUNT_NUMBER: '1',
        MULLGATE_PROXY_USERNAME: 'user',
        MULLGATE_PROXY_PASSWORD: 'pass',
        MULLGATE_DEVICE_NAME: 'device',
      }),
    ).toBeNull();
  });

  it('emits an approved compatibility artifact when hostname-selected routing stays truthful for every protocol', () => {
    const artifact = createCompatibilityArtifact({
      generatedAt: '2026-03-22T00:10:00.000Z',
      feasibility: createFeasibilityFixture(),
      hostnameRouting: {
        sharedBindIpCount: 2,
        requestedProxyHostnamePreserved: false,
        currentSelector: 'destination-bind-ip',
        artifactPath: '/tmp/compatibility/hostname-routing.json',
      },
      protocols: createProtocolObservations({
        socks5: {
          canSelectExitByHostname: true,
          canSelectExitWithExplicitRelaySelection: true,
          observedCapabilitySummary:
            'SOCKS5 keeps working with hostname-selected routing because distinct bind IPs still exist.',
        },
        http: {
          canSelectExitByHostname: true,
          observedCapabilitySummary:
            'HTTP keeps working with hostname-selected routing because distinct bind IPs still exist.',
        },
        https: {
          canSelectExitByHostname: true,
          observedCapabilitySummary:
            'HTTPS keeps working with hostname-selected routing because distinct bind IPs still exist.',
        },
      }),
      operator: {
        authPreserved: true,
        requiresClientSpecificRelayConfiguration: false,
        locationSelectionDiscoverable: true,
      },
    });

    expect(artifact).toEqual({
      schemaVersion: COMPATIBILITY_ARTIFACT_VERSION,
      generatedAt: '2026-03-22T00:10:00.000Z',
      proofModel: COMPATIBILITY_PROOF_MODEL,
      feasibility: {
        proofModel: FEASIBILITY_PROOF_MODEL,
        generatedAt: '2026-03-21T19:02:00.000Z',
        verdict: {
          status: 'pass',
          reason: 'distinct-exits-confirmed',
          phase: 'summary',
          stopReason: 'distinct-exits-confirmed',
          summary:
            'The single-entry feasibility probe observed 2–3 distinct exits while the host route baseline remained unchanged.',
        },
        summary: {
          requestedLogicalExitCount: 2,
          successfulProbeCount: 2,
          failedProbeCount: 0,
          distinctObservedExitCount: 2,
          routeUnchanged: true,
          collapsedLogicalExitIds: [],
        },
      },
      hostnameRouting: {
        status: 'truthful',
        reason: 'destination-bind-ip-selector-still-truthful',
        summary:
          'Hostname-selected routing remains truthful because distinct bind IPs still exist for the routing layer to dispatch on.',
        sharedBindIpCount: 2,
        requestedProxyHostnamePreserved: false,
        currentSelector: 'destination-bind-ip',
        artifactPath: '/tmp/compatibility/hostname-routing.json',
        notes: [],
      },
      protocols: [
        {
          protocol: 'socks5',
          outcome: 'supported',
          reason: 'supported-as-is',
          summary:
            'SOCKS5 preserves the current hostname-selected routing contract without redesign.',
          observedCapabilitySummary:
            'SOCKS5 keeps working with hostname-selected routing because distinct bind IPs still exist.',
          probeSucceeded: true,
          canSelectExitByHostname: true,
          canSelectExitWithExplicitRelaySelection: true,
          proxyUrl: 'socks5://alice:super-secret-password@shared-entry.local:1080',
        },
        {
          protocol: 'http',
          outcome: 'supported',
          reason: 'supported-as-is',
          summary:
            'HTTP preserves the current hostname-selected routing contract without redesign.',
          observedCapabilitySummary:
            'HTTP keeps working with hostname-selected routing because distinct bind IPs still exist.',
          probeSucceeded: true,
          canSelectExitByHostname: true,
          canSelectExitWithExplicitRelaySelection: false,
        },
        {
          protocol: 'https',
          outcome: 'supported',
          reason: 'supported-as-is',
          summary:
            'HTTPS preserves the current hostname-selected routing contract without redesign.',
          observedCapabilitySummary:
            'HTTPS keeps working with hostname-selected routing because distinct bind IPs still exist.',
          probeSucceeded: true,
          canSelectExitByHostname: true,
          canSelectExitWithExplicitRelaySelection: false,
        },
      ],
      requirementDeltas: [
        {
          requirementId: 'R004',
          title: 'Hostname-selected location routing',
          status: 'preserved',
          summary: 'Hostname-selected routing still maps truthfully to the requested Mullvad exit.',
          evidence: [
            'Hostname-selected routing remains truthful because distinct bind IPs still exist for the routing layer to dispatch on.',
          ],
        },
        {
          requirementId: 'R005',
          title: 'SOCKS5 support',
          status: 'preserved',
          summary:
            'SOCKS5 preserves the current hostname-selected routing contract without redesign.',
          evidence: [
            'SOCKS5 keeps working with hostname-selected routing because distinct bind IPs still exist.',
          ],
        },
        {
          requirementId: 'R006',
          title: 'HTTP proxy support',
          status: 'preserved',
          summary:
            'HTTP preserves the current hostname-selected routing contract without redesign.',
          evidence: [
            'HTTP keeps working with hostname-selected routing because distinct bind IPs still exist.',
          ],
        },
        {
          requirementId: 'R007',
          title: 'HTTPS proxy support',
          status: 'preserved',
          summary:
            'HTTPS preserves the current hostname-selected routing contract without redesign.',
          evidence: [
            'HTTPS keeps working with hostname-selected routing because distinct bind IPs still exist.',
          ],
        },
        {
          requirementId: 'R008',
          title: 'Authenticated proxy access',
          status: 'preserved',
          summary: 'Authenticated proxy access remains visible and enforced at the shared entry.',
          evidence: ['Shared-entry probing still requires authenticated local proxy access.'],
        },
        {
          requirementId: 'R017',
          title: 'Low-friction first run for self-hosters',
          status: 'preserved',
          summary:
            'The shared-entry topology keeps the self-hoster flow aligned with the existing low-friction product story.',
          evidence: ['Operators can keep the current hostname-only route-selection flow.'],
        },
        {
          requirementId: 'R019',
          title: 'Easy location naming and discovery',
          status: 'preserved',
          summary:
            'Route naming and exit discovery stay understandable because hostnames remain truthful selectors.',
          evidence: [
            'Hostname-selected routing remains truthful because distinct bind IPs still exist for the routing layer to dispatch on.',
            'Location-selection metadata can still be described to operators in a compatibility bundle.',
          ],
        },
      ],
      recommendation: {
        posture: 'approved',
        summary:
          'The shared-entry redesign preserves every tracked product contract in this matrix.',
        survivingRequirementIds: ['R004', 'R005', 'R006', 'R007', 'R008', 'R017', 'R019'],
        degradedRequirementIds: [],
        failedRequirementIds: [],
      },
      operator: {
        authPreserved: true,
        requiresClientSpecificRelayConfiguration: false,
        locationSelectionDiscoverable: true,
        notes: [],
      },
    });
  });

  it('marks SOCKS5 as degraded when explicit relay selection works but hostname-selected routing is no longer truthful', () => {
    const artifact = createCompatibilityArtifact({
      generatedAt: '2026-03-22T00:12:00.000Z',
      feasibility: createFeasibilityFixture(),
      hostnameRouting: {
        sharedBindIpCount: 1,
        requestedProxyHostnamePreserved: false,
        currentSelector: 'destination-bind-ip',
        notes: ['Only one bind IP remains at the shared entry.'],
      },
      protocols: createProtocolObservations(),
      operator: {
        authPreserved: true,
        requiresClientSpecificRelayConfiguration: true,
        locationSelectionDiscoverable: true,
        notes: ['Operators can inspect the relay mapping in the compatibility bundle.'],
      },
    });

    expect(artifact.hostnameRouting).toEqual({
      status: 'not-truthful',
      reason: 'one-bind-ip-plus-socks5-hostname-loss',
      summary:
        'Hostname-selected routing is not truthful under one bind IP because SOCKS5 does not preserve the requested proxy hostname for the current destination-bind-IP selector.',
      sharedBindIpCount: 1,
      requestedProxyHostnamePreserved: false,
      currentSelector: 'destination-bind-ip',
      notes: ['Only one bind IP remains at the shared entry.'],
    });
    expect(artifact.protocols[0]).toEqual({
      protocol: 'socks5',
      outcome: 'degraded',
      reason: 'explicit-relay-selection-required',
      summary:
        'SOCKS5 only works if operators or clients explicitly choose the Mullvad relay, so the product contract would need to change.',
      observedCapabilitySummary:
        'SOCKS5 chaining reaches distinct Mullvad exits only when the client selects a relay explicitly.',
      probeSucceeded: true,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: true,
      proxyUrl: 'socks5://alice:super-secret-password@shared-entry.local:1080',
    });
    expect(artifact.requirementDeltas.find((delta) => delta.requirementId === 'R005')).toEqual({
      requirementId: 'R005',
      title: 'SOCKS5 support',
      status: 'degraded',
      summary:
        'SOCKS5 only works if operators or clients explicitly choose the Mullvad relay, so the product contract would need to change.',
      evidence: [
        'SOCKS5 chaining reaches distinct Mullvad exits only when the client selects a relay explicitly.',
      ],
    });
    expect(artifact.requirementDeltas.find((delta) => delta.requirementId === 'R017')).toEqual({
      requirementId: 'R017',
      title: 'Low-friction first run for self-hosters',
      status: 'failed',
      summary:
        'The shared-entry topology breaks the low-friction self-hoster story because at least one required protocol no longer works truthfully.',
      evidence: [
        'Operators must configure client-specific relay selection instead of relying on hostname-only routing.',
      ],
    });
    expect(artifact.recommendation).toEqual({
      posture: 'blocked',
      summary:
        'The shared-entry redesign is blocked because one or more active product requirements fail under the compatibility matrix.',
      survivingRequirementIds: ['R008'],
      degradedRequirementIds: ['R005', 'R019'],
      failedRequirementIds: ['R004', 'R006', 'R007', 'R017'],
    });
  });

  it('marks the redesign blocked when HTTP and HTTPS cannot preserve hostname-selected routing', () => {
    const artifact = createCompatibilityArtifact({
      generatedAt: '2026-03-22T00:14:00.000Z',
      hostnameRouting: {
        sharedBindIpCount: 1,
        requestedProxyHostnamePreserved: false,
        currentSelector: 'destination-bind-ip',
      },
      protocols: createProtocolObservations({
        http: {
          observedCapabilitySummary:
            'HTTP has no truthful exit-selection mechanism once the bind IP collapses to a single shared entry.',
        },
        https: {
          observedCapabilitySummary:
            'HTTPS has no truthful exit-selection mechanism once the bind IP collapses to a single shared entry.',
        },
      }),
      operator: {
        authPreserved: true,
        requiresClientSpecificRelayConfiguration: true,
        locationSelectionDiscoverable: false,
      },
    });

    expect(artifact.protocols[1]).toEqual({
      protocol: 'http',
      outcome: 'blocked',
      reason: 'hostname-routing-not-truthful',
      summary:
        'HTTP cannot truthfully preserve hostname-selected routing under the shared-entry topology.',
      observedCapabilitySummary:
        'HTTP has no truthful exit-selection mechanism once the bind IP collapses to a single shared entry.',
      probeSucceeded: true,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: false,
    });
    expect(artifact.protocols[2]).toEqual({
      protocol: 'https',
      outcome: 'blocked',
      reason: 'hostname-routing-not-truthful',
      summary:
        'HTTPS cannot truthfully preserve hostname-selected routing under the shared-entry topology.',
      observedCapabilitySummary:
        'HTTPS has no truthful exit-selection mechanism once the bind IP collapses to a single shared entry.',
      probeSucceeded: true,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: false,
    });
    expect(artifact.requirementDeltas.find((delta) => delta.requirementId === 'R019')).toEqual({
      requirementId: 'R019',
      title: 'Easy location naming and discovery',
      status: 'failed',
      summary:
        'Route naming and exit discovery are no longer understandable enough to preserve the current product contract.',
      evidence: [
        'Hostname-selected routing is not truthful under one bind IP because SOCKS5 does not preserve the requested proxy hostname for the current destination-bind-IP selector.',
        'No truthful location-selection surface remains for operators to inspect.',
      ],
    });
  });

  it('serializes requirement deltas and redacts proxy credentials, account numbers, and private keys', () => {
    const artifact = createCompatibilityArtifact({
      generatedAt: '2026-03-22T00:16:00.000Z',
      feasibility: createFeasibilityFixture(),
      hostnameRouting: {
        sharedBindIpCount: 1,
        requestedProxyHostnamePreserved: false,
        currentSelector: 'destination-bind-ip',
      },
      protocols: createProtocolObservations(),
      operator: {
        authPreserved: true,
        requiresClientSpecificRelayConfiguration: true,
        locationSelectionDiscoverable: true,
      },
    });

    const serialized = serializeCompatibilityArtifact({
      artifact,
      additionalSecrets: ['alice', 'super-secret-password', '123456789012', 'private-key-value-1'],
    });

    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('super-secret-password');
    expect(serialized).not.toContain('123456789012');
    expect(serialized).not.toContain('private-key-value-1');
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('shared-entry-compatibility-matrix');
    expect(serialized).toContain('"requirementId": "R004"');
    expect(serialized).toContain('"posture": "blocked"');
  });

  it('replays the compatibility hostname fixture into a secret-safe summary bundle', async () => {
    const outputRoot = path.join(process.cwd(), '.tmp', 'vitest-m004-compatibility-fixture');
    const result = await runCompatibilityVerifier({
      targetUrl: 'https://am.i.mullvad.net/json',
      routeCheckIp: '1.1.1.1',
      logicalExitCount: 2,
      outputRoot,
      keepTempHome: false,
      fixturePath: path.join(fixturesDir, 'm004', 'compatibility-hostname-fail.json'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.preservedWorkspace).toBe(true);
    expect(result.bundle.overallVerdict).toBe('fail');
    expect(result.bundle.artifact.recommendation.posture).toBe('blocked');
    expect(result.bundle.artifact.hostnameRouting.status).toBe('not-truthful');
    expect(
      result.bundle.artifact.protocols.find((protocol) => protocol.protocol === 'socks5'),
    ).toEqual({
      protocol: 'socks5',
      outcome: 'degraded',
      reason: 'explicit-relay-selection-required',
      summary:
        'SOCKS5 only works if operators or clients explicitly choose the Mullvad relay, so the product contract would need to change.',
      observedCapabilitySummary:
        'SOCKS5 chaining reaches distinct Mullvad exits only when the client explicitly chooses a relay hostname for the second hop.',
      probeSucceeded: true,
      canSelectExitByHostname: false,
      canSelectExitWithExplicitRelaySelection: true,
      artifactPath: '/tmp/mullgate-m004-fixture/artifacts/probe-socks5.json',
    });

    const summaryJson = await readFile(result.summaryJsonPath, 'utf8');
    const summaryText = await readFile(result.summaryTextPath, 'utf8');
    const artifactJson = await readFile(result.artifactJsonPath, 'utf8');

    expect(summaryJson).toContain('"phase": "fixture-replay"');
    expect(summaryJson).toContain('"overallVerdict": "fail"');
    expect(summaryJson).toContain('"summary"');
    expect(summaryJson).toContain('"protocolMatrix"');
    expect(summaryJson).toContain('"operatorImpact"');
    expect(summaryJson).toContain('"artifactLinks"');
    expect(summaryJson).toContain('"summaryJson"');
    expect(summaryJson).toContain(
      '"explicitFailure": "Hostname-selected routing fails under the one-entry topology because the shared entry collapses to one bind IP and SOCKS5 does not preserve the requested proxy hostname for destination-bind-IP selection."',
    );
    expect(summaryText).toContain(
      'headline: SOCKS5 chaining can still work with explicit relay selection, but hostname-selected routing fails and HTTP/HTTPS cannot keep Mullgate’s current truthful contract',
    );
    expect(summaryText).toContain(
      'hostname-selected routing: not-truthful (one-bind-ip-plus-socks5-hostname-loss)',
    );
    expect(summaryText).toContain(
      'hostname-selected routing failure: Hostname-selected routing fails under the one-entry topology because the shared entry collapses to one bind IP and SOCKS5 does not preserve the requested proxy hostname for destination-bind-IP selection.',
    );
    expect(summaryText).toContain('protocol matrix:');
    expect(summaryText).toContain(
      '- socks5: degraded / contract-change (explicit-relay-selection-required)',
    );
    expect(summaryText).toContain('- http: blocked / failed (hostname-routing-not-truthful)');
    expect(summaryText).toContain('- https: blocked / failed (hostname-routing-not-truthful)');
    expect(summaryText).toContain('artifact links:');
    expect(summaryText).toContain('summary json:');
    expect(artifactJson).toContain('shared-entry-compatibility-matrix');
    expect(artifactJson).not.toContain('123456789012');
  });
});
