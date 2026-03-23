import { REDACTED } from '../config/redact.js';
import type { MullvadRelay, MullvadRelayCatalog } from '../mullvad/fetch-relays.js';

export const FEASIBILITY_ARTIFACT_VERSION = 1 as const;
export const FEASIBILITY_PROOF_MODEL = 'single-entry-shared-socks-exits' as const;

export type FeasibilityProofModel = typeof FEASIBILITY_PROOF_MODEL;
export type FeasibilityVerdictStatus = 'pass' | 'fail';
export type FeasibilityVerdictReason =
  | 'distinct-exits-confirmed'
  | 'collapsed-exits'
  | 'route-drift'
  | 'prerequisite-missing'
  | 'insufficient-socks-relay-metadata'
  | 'probe-failure';
export type FeasibilityPhase =
  | 'prerequisite-check'
  | 'relay-selection'
  | 'probe-execution'
  | 'route-check'
  | 'summary';

export type FeasibilityRelayLocation = {
  readonly countryCode: string;
  readonly countryName: string;
  readonly cityCode: string;
  readonly cityName: string;
};

export type FeasibilityEntryIdentity = {
  readonly mullvadWireguardDeviceCount: 1;
  readonly deviceName: string;
  readonly relayHostname: string;
  readonly relayFqdn: string;
  readonly endpointIpv4: string;
  readonly endpointIpv6?: string;
  readonly publicKey: string;
  readonly accountNumber?: string;
  readonly wireguardPrivateKey?: string;
  readonly location: FeasibilityRelayLocation;
};

export type FeasibilityLogicalExit = {
  readonly logicalExitId: string;
  readonly relayHostname: string;
  readonly relayFqdn: string;
  readonly endpointIpv4: string;
  readonly endpointIpv6?: string;
  readonly publicKey: string;
  readonly socksHostname: string;
  readonly socksPort: number;
  readonly source: MullvadRelay['source'];
  readonly location: FeasibilityRelayLocation;
};

export type SingleEntryFeasibilityTopology = {
  readonly proofModel: FeasibilityProofModel;
  readonly entryIdentity: FeasibilityEntryIdentity;
  readonly logicalExits: readonly FeasibilityLogicalExit[];
};

export type HostRouteSnapshot = {
  readonly checkedAt: string;
  readonly targetIp: string;
  readonly command: string;
  readonly normalizedRoute: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifactPath?: string;
};

export type FeasibilityRouteCheck = {
  readonly before: HostRouteSnapshot | null;
  readonly after: HostRouteSnapshot | null;
  readonly unchanged: boolean;
};

export type FeasibilityObservedExit = {
  readonly ip: string;
  readonly country: string;
  readonly city: string;
  readonly hostname?: string | null;
};

export type FeasibilityProbeSuccess = {
  readonly ok: true;
  readonly logicalExitId: string;
  readonly targetUrl: string;
  readonly proxyUrl?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly stdoutArtifactPath?: string;
  readonly stderrArtifactPath?: string;
  readonly observedExit: FeasibilityObservedExit;
};

export type FeasibilityProbeFailure = {
  readonly ok: false;
  readonly logicalExitId: string;
  readonly targetUrl: string;
  readonly proxyUrl?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly code?: string;
  readonly message: string;
  readonly stdoutArtifactPath?: string;
  readonly stderrArtifactPath?: string;
};

export type FeasibilityProbeObservation = FeasibilityProbeSuccess | FeasibilityProbeFailure;

export type FeasibilityPrerequisiteFailure = {
  readonly code: string;
  readonly message: string;
  readonly artifactPath?: string;
};

export type FeasibilityRelaySelectionSummary = {
  readonly requestedCount: 2 | 3;
  readonly availableCount: number;
  readonly candidateCount: number;
  readonly missingMetadataCount: number;
  readonly selectedRelayHostnames: readonly string[];
};

export type FeasibilityRelaySelectionSuccess = {
  readonly ok: true;
  readonly phase: 'relay-selection';
  readonly requestedCount: 2 | 3;
  readonly availableCount: number;
  readonly candidateCount: number;
  readonly missingMetadataCount: number;
  readonly selected: readonly FeasibilityLogicalExit[];
};

export type FeasibilityRelaySelectionFailure = {
  readonly ok: false;
  readonly phase: 'relay-selection';
  readonly code: 'INSUFFICIENT_SOCKS_RELAYS';
  readonly requestedCount: 2 | 3;
  readonly availableCount: number;
  readonly candidateCount: number;
  readonly missingMetadataCount: number;
  readonly message: string;
};

export type FeasibilityRelaySelectionResult =
  | FeasibilityRelaySelectionSuccess
  | FeasibilityRelaySelectionFailure;

export type FeasibilitySummary = {
  readonly requestedLogicalExitCount: number;
  readonly successfulProbeCount: number;
  readonly failedProbeCount: number;
  readonly distinctObservedExitCount: number;
  readonly routeUnchanged: boolean;
  readonly collapsedLogicalExitIds: readonly string[];
};

export type FeasibilityVerdict = {
  readonly status: FeasibilityVerdictStatus;
  readonly reason: FeasibilityVerdictReason;
  readonly phase: FeasibilityPhase;
  readonly stopReason: FeasibilityVerdictReason;
  readonly summary: string;
};

export type FeasibilityArtifact = {
  readonly schemaVersion: typeof FEASIBILITY_ARTIFACT_VERSION;
  readonly generatedAt: string;
  readonly topology: SingleEntryFeasibilityTopology;
  readonly relaySelection: FeasibilityRelaySelectionSummary;
  readonly prerequisiteFailures: readonly FeasibilityPrerequisiteFailure[];
  readonly routeCheck: FeasibilityRouteCheck;
  readonly probes: readonly FeasibilityProbeObservation[];
  readonly summary: FeasibilitySummary;
  readonly verdict: FeasibilityVerdict;
};

export type CreateFeasibilityArtifactOptions = {
  readonly generatedAt: string;
  readonly topology: SingleEntryFeasibilityTopology;
  readonly relaySelection: FeasibilityRelaySelectionSummary;
  readonly prerequisiteFailures?: readonly FeasibilityPrerequisiteFailure[];
  readonly routeCheck: {
    readonly before: HostRouteSnapshot | null;
    readonly after: HostRouteSnapshot | null;
  };
  readonly probes: readonly FeasibilityProbeObservation[];
};

export type SerializeFeasibilityArtifactOptions = {
  readonly artifact: FeasibilityArtifact;
  readonly additionalSecrets?: readonly string[];
};

export type SelectFeasibilityExitRelaysOptions = {
  readonly catalog: MullvadRelayCatalog;
  readonly count: 2 | 3;
  readonly entryRelayHostname?: string;
  readonly logicalExitIdPrefix?: string;
};

export function createSingleEntryTopology(options: {
  readonly entryIdentity: FeasibilityEntryIdentity;
  readonly logicalExits: readonly FeasibilityLogicalExit[];
}): SingleEntryFeasibilityTopology {
  return {
    proofModel: FEASIBILITY_PROOF_MODEL,
    entryIdentity: options.entryIdentity,
    logicalExits: [...options.logicalExits],
  };
}

export function createEntryIdentityFromRelay(options: {
  readonly relay: MullvadRelay;
  readonly deviceName: string;
  readonly accountNumber?: string;
  readonly wireguardPrivateKey?: string;
}): FeasibilityEntryIdentity {
  return {
    mullvadWireguardDeviceCount: 1,
    deviceName: options.deviceName,
    relayHostname: options.relay.hostname,
    relayFqdn: options.relay.fqdn,
    endpointIpv4: options.relay.endpointIpv4,
    ...(options.relay.endpointIpv6 ? { endpointIpv6: options.relay.endpointIpv6 } : {}),
    publicKey: options.relay.publicKey,
    ...(options.accountNumber ? { accountNumber: options.accountNumber } : {}),
    ...(options.wireguardPrivateKey ? { wireguardPrivateKey: options.wireguardPrivateKey } : {}),
    location: toRelayLocation(options.relay),
  };
}

export function selectFeasibilityExitRelays(
  options: SelectFeasibilityExitRelaysOptions,
): FeasibilityRelaySelectionResult {
  const logicalExitIdPrefix = options.logicalExitIdPrefix ?? 'exit';
  const socksCapableRelays = options.catalog.relays.filter((relay) => isSocksCapableRelay(relay));
  const missingMetadataCount = options.catalog.relays.filter(
    (relay) => relay.active && !isSocksCapableRelay(relay),
  ).length;
  const preferredRelays = socksCapableRelays.filter(
    (relay) => relay.hostname !== options.entryRelayHostname,
  );
  const entryRelayFallbacks = socksCapableRelays.filter(
    (relay) => relay.hostname === options.entryRelayHostname,
  );

  const selectedRelays = selectDistinctRelays({
    preferredRelays,
    fallbackRelays: entryRelayFallbacks,
    count: options.count,
  });

  if (selectedRelays.length < options.count) {
    return {
      ok: false,
      phase: 'relay-selection',
      code: 'INSUFFICIENT_SOCKS_RELAYS',
      requestedCount: options.count,
      availableCount: socksCapableRelays.length,
      candidateCount: options.catalog.relays.length,
      missingMetadataCount,
      message:
        `Need ${options.count} SOCKS-capable Mullvad relays for the single-entry feasibility probe, ` +
        `but only ${selectedRelays.length} deterministic candidates were available.`,
    };
  }

  return {
    ok: true,
    phase: 'relay-selection',
    requestedCount: options.count,
    availableCount: socksCapableRelays.length,
    candidateCount: options.catalog.relays.length,
    missingMetadataCount,
    selected: selectedRelays.map((relay, index) => ({
      logicalExitId: `${logicalExitIdPrefix}-${index + 1}`,
      relayHostname: relay.hostname,
      relayFqdn: relay.fqdn,
      endpointIpv4: relay.endpointIpv4,
      ...(relay.endpointIpv6 ? { endpointIpv6: relay.endpointIpv6 } : {}),
      publicKey: relay.publicKey,
      socksHostname: relay.socksName!,
      socksPort: relay.socksPort!,
      source: relay.source,
      location: toRelayLocation(relay),
    })),
  };
}

export function createFeasibilityArtifact(
  options: CreateFeasibilityArtifactOptions,
): FeasibilityArtifact {
  const prerequisiteFailures = [...(options.prerequisiteFailures ?? [])];
  const routeCheck = createRouteCheck(options.routeCheck);
  const summary = summarizeFeasibility({
    logicalExits: options.topology.logicalExits,
    probes: options.probes,
    routeCheck,
  });
  const verdict = classifyFeasibilityVerdict({
    prerequisiteFailures,
    relaySelection: options.relaySelection,
    routeCheck,
    probes: options.probes,
    summary,
  });

  return {
    schemaVersion: FEASIBILITY_ARTIFACT_VERSION,
    generatedAt: options.generatedAt,
    topology: options.topology,
    relaySelection: options.relaySelection,
    prerequisiteFailures,
    routeCheck,
    probes: [...options.probes],
    summary,
    verdict,
  };
}

export function serializeFeasibilityArtifact(options: SerializeFeasibilityArtifactOptions): string {
  const secrets = collectFeasibilitySecrets({
    artifact: options.artifact,
    additionalSecrets: options.additionalSecrets ?? [],
  });
  const serialized = JSON.stringify(options.artifact, null, 2);
  return redactSecretStrings(serialized, secrets);
}

export function areHostRoutesEquivalent(
  left: HostRouteSnapshot | null,
  right: HostRouteSnapshot | null,
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.targetIp === right.targetIp &&
    normalizeRouteSignature(left.normalizedRoute) === normalizeRouteSignature(right.normalizedRoute)
  );
}

function createRouteCheck(input: {
  readonly before: HostRouteSnapshot | null;
  readonly after: HostRouteSnapshot | null;
}): FeasibilityRouteCheck {
  return {
    before: input.before,
    after: input.after,
    unchanged: areHostRoutesEquivalent(input.before, input.after),
  };
}

function summarizeFeasibility(input: {
  readonly logicalExits: readonly FeasibilityLogicalExit[];
  readonly probes: readonly FeasibilityProbeObservation[];
  readonly routeCheck: FeasibilityRouteCheck;
}): FeasibilitySummary {
  const successfulProbes = input.probes.filter(isSuccessfulProbe);
  const failedProbeCount = input.probes.length - successfulProbes.length;
  const distinctExitGroups = groupObservedExits(successfulProbes);
  const collapsedLogicalExitIds = [...distinctExitGroups.values()]
    .filter((logicalExitIds) => logicalExitIds.length > 1)
    .flat();

  return {
    requestedLogicalExitCount: input.logicalExits.length,
    successfulProbeCount: successfulProbes.length,
    failedProbeCount,
    distinctObservedExitCount: distinctExitGroups.size,
    routeUnchanged: input.routeCheck.unchanged,
    collapsedLogicalExitIds,
  };
}

function classifyFeasibilityVerdict(input: {
  readonly prerequisiteFailures: readonly FeasibilityPrerequisiteFailure[];
  readonly relaySelection: FeasibilityRelaySelectionSummary;
  readonly routeCheck: FeasibilityRouteCheck;
  readonly probes: readonly FeasibilityProbeObservation[];
  readonly summary: FeasibilitySummary;
}): FeasibilityVerdict {
  if (
    input.prerequisiteFailures.length > 0 ||
    !input.routeCheck.before ||
    !input.routeCheck.after
  ) {
    return {
      status: 'fail',
      reason: 'prerequisite-missing',
      phase: 'prerequisite-check',
      stopReason: 'prerequisite-missing',
      summary:
        'The feasibility verifier could not prove the topology because one or more prerequisites were missing.',
    };
  }

  if (input.relaySelection.availableCount < input.relaySelection.requestedCount) {
    return {
      status: 'fail',
      reason: 'insufficient-socks-relay-metadata',
      phase: 'relay-selection',
      stopReason: 'insufficient-socks-relay-metadata',
      summary:
        'Mullvad relay metadata did not expose enough SOCKS-capable relays to drive the requested logical exits.',
    };
  }

  if (input.probes.some((probe) => !probe.ok)) {
    return {
      status: 'fail',
      reason: 'probe-failure',
      phase: 'probe-execution',
      stopReason: 'probe-failure',
      summary:
        'At least one logical exit probe failed before the verifier could compare distinct exits.',
    };
  }

  if (!input.routeCheck.unchanged) {
    return {
      status: 'fail',
      reason: 'route-drift',
      phase: 'route-check',
      stopReason: 'route-drift',
      summary:
        'The host route baseline changed during the feasibility run, so the result cannot prove standalone proxy behavior.',
    };
  }

  if (
    input.summary.successfulProbeCount < 2 ||
    input.summary.distinctObservedExitCount !== input.summary.successfulProbeCount
  ) {
    return {
      status: 'fail',
      reason: 'collapsed-exits',
      phase: 'summary',
      stopReason: 'collapsed-exits',
      summary:
        'Two or more logical exits resolved to the same observed exit, so the shared-entry topology did not prove distinct exits.',
    };
  }

  return {
    status: 'pass',
    reason: 'distinct-exits-confirmed',
    phase: 'summary',
    stopReason: 'distinct-exits-confirmed',
    summary:
      'The single-entry feasibility probe observed 2–3 distinct exits while the host route baseline remained unchanged.',
  };
}

function selectDistinctRelays(input: {
  readonly preferredRelays: readonly MullvadRelay[];
  readonly fallbackRelays: readonly MullvadRelay[];
  readonly count: number;
}): MullvadRelay[] {
  const selected: MullvadRelay[] = [];
  const usedHostnames = new Set<string>();
  const usedCities = new Set<string>();
  const orderedPools = [input.preferredRelays, input.fallbackRelays];

  for (const pool of orderedPools) {
    for (const relay of pool) {
      if (selected.length >= input.count) {
        return selected;
      }
      if (usedHostnames.has(relay.hostname)) {
        continue;
      }

      const cityKey = createCityKey(relay);
      if (usedCities.has(cityKey)) {
        continue;
      }

      selected.push(relay);
      usedHostnames.add(relay.hostname);
      usedCities.add(cityKey);
    }
  }

  for (const pool of orderedPools) {
    for (const relay of pool) {
      if (selected.length >= input.count) {
        return selected;
      }
      if (usedHostnames.has(relay.hostname)) {
        continue;
      }

      selected.push(relay);
      usedHostnames.add(relay.hostname);
    }
  }

  return selected;
}

function isSocksCapableRelay(relay: MullvadRelay): boolean {
  return (
    relay.active &&
    typeof relay.socksName === 'string' &&
    relay.socksName.length > 0 &&
    typeof relay.socksPort === 'number'
  );
}

function toRelayLocation(relay: Pick<MullvadRelay, 'location'>): FeasibilityRelayLocation {
  return {
    countryCode: relay.location.countryCode,
    countryName: relay.location.countryName,
    cityCode: relay.location.cityCode,
    cityName: relay.location.cityName,
  };
}

function createCityKey(relay: MullvadRelay): string {
  return `${relay.location.countryCode}:${relay.location.cityCode}`;
}

function isSuccessfulProbe(probe: FeasibilityProbeObservation): probe is FeasibilityProbeSuccess {
  return probe.ok;
}

function groupObservedExits(probes: readonly FeasibilityProbeSuccess[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const probe of probes) {
    const key = createObservedExitKey(probe.observedExit);
    const existing = groups.get(key) ?? [];

    existing.push(probe.logicalExitId);
    groups.set(key, existing);
  }

  return groups;
}

function createObservedExitKey(observedExit: FeasibilityObservedExit): string {
  return [
    observedExit.ip,
    observedExit.country.trim().toLowerCase(),
    observedExit.city.trim().toLowerCase(),
  ].join('|');
}

function normalizeRouteSignature(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function collectFeasibilitySecrets(input: {
  readonly artifact: FeasibilityArtifact;
  readonly additionalSecrets: readonly string[];
}): string[] {
  const probeUrls = input.artifact.probes.flatMap((probe) =>
    probe.proxyUrl ? [probe.proxyUrl] : [],
  );
  const knownSecrets = [
    input.artifact.topology.entryIdentity.accountNumber,
    input.artifact.topology.entryIdentity.wireguardPrivateKey,
    ...probeUrls,
    ...input.additionalSecrets,
  ];

  return dedupeSecrets(knownSecrets);
}

function dedupeSecrets(values: readonly (string | undefined)[]): string[] {
  const deduped = new Set<string>();

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
      continue;
    }

    deduped.add(value);
    deduped.add(trimmed);
  }

  return [...deduped.values()].sort((left, right) => right.length - left.length);
}

function redactSecretStrings(value: string, secrets: readonly string[]): string {
  let redacted = value;

  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }

  return redacted.replace(
    /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g,
    REDACTED,
  );
}
