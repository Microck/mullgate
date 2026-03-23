import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createEntryIdentityFromRelay,
  createFeasibilityArtifact,
  createSingleEntryTopology,
  FEASIBILITY_ARTIFACT_VERSION,
  FEASIBILITY_PROOF_MODEL,
  type FeasibilityArtifact,
  type FeasibilityLogicalExit,
  type FeasibilityProbeObservation,
  type HostRouteSnapshot,
  selectFeasibilityExitRelays,
  serializeFeasibilityArtifact,
} from '../../src/m004/feasibility-contract.js';
import { runFeasibilityVerifier } from '../../src/m004/feasibility-runner.js';
import { normalizeRelayPayload } from '../../src/mullvad/fetch-relays.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures');
const mullvadFixturesDir = path.join(fixturesDir, 'mullvad');

async function readJsonFixture<T>(name: string): Promise<T> {
  const raw = await readFile(path.join(mullvadFixturesDir, name), 'utf8');
  return JSON.parse(raw) as T;
}

function createRouteSnapshot(overrides: Partial<HostRouteSnapshot> = {}): HostRouteSnapshot {
  return {
    checkedAt: '2026-03-21T19:00:00.000Z',
    targetIp: '1.1.1.1',
    command: 'ip route get 1.1.1.1',
    normalizedRoute: '1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10 uid 1000',
    stdout: '1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10 uid 1000\n',
    stderr: '',
    ...overrides,
  };
}

function createSuccessfulProbe(options: {
  logicalExitId: string;
  ip: string;
  country: string;
  city: string;
  proxyUrl?: string;
}): FeasibilityProbeObservation {
  return {
    ok: true,
    logicalExitId: options.logicalExitId,
    targetUrl: 'https://am.i.mullvad.net/json',
    ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}),
    startedAt: '2026-03-21T19:01:00.000Z',
    completedAt: '2026-03-21T19:01:01.250Z',
    durationMs: 1250,
    stdoutArtifactPath: `/tmp/${options.logicalExitId}-stdout.txt`,
    stderrArtifactPath: `/tmp/${options.logicalExitId}-stderr.txt`,
    observedExit: {
      ip: options.ip,
      country: options.country,
      city: options.city,
    },
  };
}

function createFailureProbe(logicalExitId: string): FeasibilityProbeObservation {
  return {
    ok: false,
    logicalExitId,
    targetUrl: 'https://am.i.mullvad.net/json',
    proxyUrl: `socks5://alice:super-secret-password@${logicalExitId}.relay.mullvad.net:1080`,
    startedAt: '2026-03-21T19:01:00.000Z',
    completedAt: '2026-03-21T19:01:02.000Z',
    durationMs: 2000,
    code: 'PROBE_FAILED',
    message: `Probe for ${logicalExitId} failed while using account 123456789012 and -----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----`,
    stdoutArtifactPath: `/tmp/${logicalExitId}-stdout.txt`,
    stderrArtifactPath: `/tmp/${logicalExitId}-stderr.txt`,
  };
}

function createArtifact(options: {
  logicalExits: readonly FeasibilityLogicalExit[];
  probes: readonly FeasibilityProbeObservation[];
  before?: HostRouteSnapshot | null;
  after?: HostRouteSnapshot | null;
  prerequisiteFailures?: FeasibilityArtifact['prerequisiteFailures'];
}): FeasibilityArtifact {
  const entryRelay = {
    hostname: 'se-got-wg-101',
    fqdn: 'se-got-wg-101.relays.mullvad.net',
    source: 'www-relays-all' as const,
    active: true,
    owned: true,
    publicKey: 'public-entry-key',
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
  };

  return createFeasibilityArtifact({
    generatedAt: '2026-03-21T19:02:00.000Z',
    topology: createSingleEntryTopology({
      entryIdentity: createEntryIdentityFromRelay({
        relay: entryRelay,
        deviceName: 'mullgate-m004-feasibility',
        accountNumber: '123456789012',
        wireguardPrivateKey: 'private-key-value-1',
      }),
      logicalExits: options.logicalExits,
    }),
    relaySelection: {
      requestedCount: options.logicalExits.length as 2 | 3,
      availableCount: options.logicalExits.length,
      candidateCount: options.logicalExits.length + 1,
      missingMetadataCount: 0,
      selectedRelayHostnames: options.logicalExits.map((logicalExit) => logicalExit.relayHostname),
    },
    prerequisiteFailures: options.prerequisiteFailures,
    routeCheck: {
      before: options.before ?? createRouteSnapshot(),
      after: options.after ?? createRouteSnapshot({ checkedAt: '2026-03-21T19:03:00.000Z' }),
    },
    probes: options.probes,
  });
}

describe('m004 feasibility contract', () => {
  it('selects deterministic SOCKS-capable relays from the legacy Mullvad catalog while preferring non-entry cities', async () => {
    const relayFixture = await readJsonFixture<unknown>('www-relays-all.json');
    const normalized = normalizeRelayPayload(relayFixture, {
      fetchedAt: '2026-03-21T18:55:00.000Z',
      endpoint: 'fixture://www-relays-all.json',
    });

    expect(normalized.ok).toBe(true);

    if (!normalized.ok) {
      throw new Error('Expected the legacy Mullvad relay fixture to normalize successfully.');
    }

    const twoExitSelection = selectFeasibilityExitRelays({
      catalog: normalized.value,
      count: 2,
      entryRelayHostname: 'se-got-wg-101',
    });

    expect(twoExitSelection).toEqual({
      ok: true,
      phase: 'relay-selection',
      requestedCount: 2,
      availableCount: 2,
      candidateCount: 3,
      missingMetadataCount: 0,
      selected: [
        {
          logicalExitId: 'exit-1',
          relayHostname: 'at-vie-wg-001',
          relayFqdn: 'at-vie-wg-001.relays.mullvad.net',
          endpointIpv4: '146.70.116.98',
          endpointIpv6: '2001:ac8:29:84::a01f',
          publicKey: 'TNrdH73p6h2EfeXxUiLOCOWHcjmjoslLxZptZpIPQXU=',
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
          endpointIpv4: '146.70.40.2',
          endpointIpv6: '2a03:1b20:5:f011::a01f',
          publicKey: 'Wg5yKrVIO52wBIMNz+lQbZ3ZIDvJpQ6AqmrKa1iWLEg=',
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
      ],
    });

    const threeExitSelection = selectFeasibilityExitRelays({
      catalog: normalized.value,
      count: 3,
      entryRelayHostname: 'se-got-wg-101',
    });

    expect(threeExitSelection).toEqual({
      ok: false,
      phase: 'relay-selection',
      code: 'INSUFFICIENT_SOCKS_RELAYS',
      requestedCount: 3,
      availableCount: 2,
      candidateCount: 3,
      missingMetadataCount: 0,
      message:
        'Need 3 SOCKS-capable Mullvad relays for the single-entry feasibility probe, but only 2 deterministic candidates were available.',
    });
  });

  it('emits a pass artifact when three logical exits resolve to distinct observed exits and routes stay unchanged', () => {
    const logicalExits: FeasibilityLogicalExit[] = [
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
        relayHostname: 'se-sto-wg-001',
        relayFqdn: 'se-sto-wg-001.relays.mullvad.net',
        endpointIpv4: '146.70.82.18',
        publicKey: 'relay-public-key-2',
        socksHostname: 'se-sto-wg-socks5-001.relays.mullvad.net',
        socksPort: 1080,
        source: 'www-relays-all',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      },
      {
        logicalExitId: 'exit-3',
        relayHostname: 'se-got-wg-101',
        relayFqdn: 'se-got-wg-101.relays.mullvad.net',
        endpointIpv4: '146.70.82.14',
        publicKey: 'relay-public-key-3',
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

    const artifact = createArtifact({
      logicalExits,
      probes: [
        createSuccessfulProbe({
          logicalExitId: 'exit-1',
          ip: '185.65.134.10',
          country: 'Austria',
          city: 'Vienna',
          proxyUrl:
            'socks5://alice:super-secret-password@at-vie-wg-socks5-001.relays.mullvad.net:1080',
        }),
        createSuccessfulProbe({
          logicalExitId: 'exit-2',
          ip: '185.65.135.20',
          country: 'Sweden',
          city: 'Stockholm',
          proxyUrl:
            'socks5://alice:super-secret-password@se-sto-wg-socks5-001.relays.mullvad.net:1080',
        }),
        createSuccessfulProbe({
          logicalExitId: 'exit-3',
          ip: '185.65.136.30',
          country: 'Sweden',
          city: 'Gothenburg',
          proxyUrl:
            'socks5://alice:super-secret-password@se-got-wg-socks5-101.relays.mullvad.net:1080',
        }),
      ],
    });

    expect(artifact).toEqual({
      schemaVersion: FEASIBILITY_ARTIFACT_VERSION,
      generatedAt: '2026-03-21T19:02:00.000Z',
      topology: {
        proofModel: FEASIBILITY_PROOF_MODEL,
        entryIdentity: {
          mullvadWireguardDeviceCount: 1,
          deviceName: 'mullgate-m004-feasibility',
          relayHostname: 'se-got-wg-101',
          relayFqdn: 'se-got-wg-101.relays.mullvad.net',
          endpointIpv4: '146.70.10.10',
          endpointIpv6: '2a03:1b20:5:f011::a',
          publicKey: 'public-entry-key',
          accountNumber: '123456789012',
          wireguardPrivateKey: 'private-key-value-1',
          location: {
            countryCode: 'se',
            countryName: 'Sweden',
            cityCode: 'got',
            cityName: 'Gothenburg',
          },
        },
        logicalExits,
      },
      relaySelection: {
        requestedCount: 3,
        availableCount: 3,
        candidateCount: 4,
        missingMetadataCount: 0,
        selectedRelayHostnames: ['at-vie-wg-001', 'se-sto-wg-001', 'se-got-wg-101'],
      },
      prerequisiteFailures: [],
      routeCheck: {
        before: createRouteSnapshot(),
        after: createRouteSnapshot({ checkedAt: '2026-03-21T19:03:00.000Z' }),
        unchanged: true,
      },
      probes: [
        createSuccessfulProbe({
          logicalExitId: 'exit-1',
          ip: '185.65.134.10',
          country: 'Austria',
          city: 'Vienna',
          proxyUrl:
            'socks5://alice:super-secret-password@at-vie-wg-socks5-001.relays.mullvad.net:1080',
        }),
        createSuccessfulProbe({
          logicalExitId: 'exit-2',
          ip: '185.65.135.20',
          country: 'Sweden',
          city: 'Stockholm',
          proxyUrl:
            'socks5://alice:super-secret-password@se-sto-wg-socks5-001.relays.mullvad.net:1080',
        }),
        createSuccessfulProbe({
          logicalExitId: 'exit-3',
          ip: '185.65.136.30',
          country: 'Sweden',
          city: 'Gothenburg',
          proxyUrl:
            'socks5://alice:super-secret-password@se-got-wg-socks5-101.relays.mullvad.net:1080',
        }),
      ],
      summary: {
        requestedLogicalExitCount: 3,
        successfulProbeCount: 3,
        failedProbeCount: 0,
        distinctObservedExitCount: 3,
        routeUnchanged: true,
        collapsedLogicalExitIds: [],
      },
      verdict: {
        status: 'pass',
        reason: 'distinct-exits-confirmed',
        phase: 'summary',
        stopReason: 'distinct-exits-confirmed',
        summary:
          'The single-entry feasibility probe observed 2–3 distinct exits while the host route baseline remained unchanged.',
      },
    });
  });

  it('classifies collapsed exits ahead of the pass condition', () => {
    const logicalExits: FeasibilityLogicalExit[] = [
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
        relayHostname: 'se-sto-wg-001',
        relayFqdn: 'se-sto-wg-001.relays.mullvad.net',
        endpointIpv4: '146.70.82.18',
        publicKey: 'relay-public-key-2',
        socksHostname: 'se-sto-wg-socks5-001.relays.mullvad.net',
        socksPort: 1080,
        source: 'www-relays-all',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      },
    ];

    const artifact = createArtifact({
      logicalExits,
      probes: [
        createSuccessfulProbe({
          logicalExitId: 'exit-1',
          ip: '185.65.134.10',
          country: 'Austria',
          city: 'Vienna',
        }),
        createSuccessfulProbe({
          logicalExitId: 'exit-2',
          ip: '185.65.134.10',
          country: 'Austria',
          city: 'Vienna',
        }),
      ],
    });

    expect(artifact.summary).toEqual({
      requestedLogicalExitCount: 2,
      successfulProbeCount: 2,
      failedProbeCount: 0,
      distinctObservedExitCount: 1,
      routeUnchanged: true,
      collapsedLogicalExitIds: ['exit-1', 'exit-2'],
    });
    expect(artifact.verdict).toEqual({
      status: 'fail',
      reason: 'collapsed-exits',
      phase: 'summary',
      stopReason: 'collapsed-exits',
      summary:
        'Two or more logical exits resolved to the same observed exit, so the shared-entry topology did not prove distinct exits.',
    });
  });

  it('classifies route drift when the host route snapshot changes even if probe exits differ', () => {
    const logicalExits: FeasibilityLogicalExit[] = [
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
        relayHostname: 'se-sto-wg-001',
        relayFqdn: 'se-sto-wg-001.relays.mullvad.net',
        endpointIpv4: '146.70.82.18',
        publicKey: 'relay-public-key-2',
        socksHostname: 'se-sto-wg-socks5-001.relays.mullvad.net',
        socksPort: 1080,
        source: 'www-relays-all',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      },
    ];

    const artifact = createArtifact({
      logicalExits,
      probes: [
        createSuccessfulProbe({
          logicalExitId: 'exit-1',
          ip: '185.65.134.10',
          country: 'Austria',
          city: 'Vienna',
        }),
        createSuccessfulProbe({
          logicalExitId: 'exit-2',
          ip: '185.65.135.20',
          country: 'Sweden',
          city: 'Stockholm',
        }),
      ],
      after: createRouteSnapshot({
        checkedAt: '2026-03-21T19:03:00.000Z',
        normalizedRoute: '1.1.1.1 dev wg-mullvad src 10.64.0.2 uid 1000',
        stdout: '1.1.1.1 dev wg-mullvad src 10.64.0.2 uid 1000\n',
      }),
    });

    expect(artifact.routeCheck).toEqual({
      before: createRouteSnapshot(),
      after: createRouteSnapshot({
        checkedAt: '2026-03-21T19:03:00.000Z',
        normalizedRoute: '1.1.1.1 dev wg-mullvad src 10.64.0.2 uid 1000',
        stdout: '1.1.1.1 dev wg-mullvad src 10.64.0.2 uid 1000\n',
      }),
      unchanged: false,
    });
    expect(artifact.verdict).toEqual({
      status: 'fail',
      reason: 'route-drift',
      phase: 'route-check',
      stopReason: 'route-drift',
      summary:
        'The host route baseline changed during the feasibility run, so the result cannot prove standalone proxy behavior.',
    });
  });

  it('redacts credentials, account numbers, private keys, and raw proxy URLs in serialized artifacts', () => {
    const logicalExits: FeasibilityLogicalExit[] = [
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
        relayHostname: 'se-sto-wg-001',
        relayFqdn: 'se-sto-wg-001.relays.mullvad.net',
        endpointIpv4: '146.70.82.18',
        publicKey: 'relay-public-key-2',
        socksHostname: 'se-sto-wg-socks5-001.relays.mullvad.net',
        socksPort: 1080,
        source: 'www-relays-all',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      },
    ];

    const artifact = createArtifact({
      logicalExits,
      probes: [
        createSuccessfulProbe({
          logicalExitId: 'exit-1',
          ip: '185.65.134.10',
          country: 'Austria',
          city: 'Vienna',
          proxyUrl:
            'socks5://alice:super-secret-password@at-vie-wg-socks5-001.relays.mullvad.net:1080',
        }),
        createFailureProbe('exit-2'),
      ],
    });

    const serialized = serializeFeasibilityArtifact({
      artifact,
      additionalSecrets: ['alice', 'super-secret-password'],
    });

    expect(serialized).not.toContain('123456789012');
    expect(serialized).not.toContain('private-key-value-1');
    expect(serialized).not.toContain('super-secret-password');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).toContain('at-vie-wg-socks5-001.relays.mullvad.net');
  });

  it('replays a collapsed-exit fixture into the summary bundle without requiring live Mullvad access', async () => {
    const outputRoot = path.join(process.cwd(), '.tmp', 'vitest-m004-fixture');
    const result = await runFeasibilityVerifier({
      targetUrl: 'https://am.i.mullvad.net/json',
      routeCheckIp: '1.1.1.1',
      logicalExitCount: 2,
      outputRoot,
      keepTempHome: false,
      fixturePath: path.join(fixturesDir, 'm004', 'feasibility-collapsed-exit.json'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.preservedWorkspace).toBe(true);
    expect(result.artifact.verdict).toEqual({
      status: 'fail',
      reason: 'collapsed-exits',
      phase: 'summary',
      stopReason: 'collapsed-exits',
      summary:
        'Two or more logical exits resolved to the same observed exit, so the shared-entry topology did not prove distinct exits.',
    });

    const summaryJson = await readFile(result.summaryJsonPath, 'utf8');
    const summaryText = await readFile(result.summaryTextPath, 'utf8');

    expect(summaryJson).toContain('"status": "fail"');
    expect(summaryJson).toContain('"reason": "collapsed-exits"');
    expect(summaryText).toContain('M004 feasibility verdict: FAIL');
    expect(summaryText).toContain('distinct observed exits: 1');
    expect(summaryText).toContain(
      'exit-1: relay=at-vie-wg-001, observed=185.65.134.10 Austria/Vienna',
    );
    expect(summaryText).toContain(
      'exit-2: relay=se-got-wg-101, observed=185.65.134.10 Austria/Vienna',
    );
  });
});
