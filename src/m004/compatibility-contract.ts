import { REDACTED } from '../config/redact.js';
import {
  FEASIBILITY_PROOF_MODEL,
  type FeasibilityArtifact,
  type FeasibilityProofModel,
} from './feasibility-contract.js';

export const COMPATIBILITY_ARTIFACT_VERSION = 1 as const;
export const COMPATIBILITY_PROOF_MODEL = 'shared-entry-compatibility-matrix' as const;
export const COMPATIBILITY_REQUIREMENT_IDS = ['R004', 'R005', 'R006', 'R007', 'R008', 'R017', 'R019'] as const;
export const COMPATIBILITY_PROTOCOLS = ['socks5', 'http', 'https'] as const;

export type CompatibilityProofModel = typeof COMPATIBILITY_PROOF_MODEL;
export type CompatibilityRequirementId = (typeof COMPATIBILITY_REQUIREMENT_IDS)[number];
export type CompatibilityProtocol = (typeof COMPATIBILITY_PROTOCOLS)[number];
export type CompatibilityOutcome = 'supported' | 'degraded' | 'blocked';
export type CompatibilityRequirementStatus = 'preserved' | 'degraded' | 'failed';
export type CompatibilityRecommendationPosture = 'approved' | 'possible-with-contract-change' | 'blocked';
export type CompatibilityProtocolReason =
  | 'supported-as-is'
  | 'explicit-relay-selection-required'
  | 'hostname-routing-not-truthful'
  | 'probe-failed';
export type HostnameRoutingReason =
  | 'destination-bind-ip-selector-still-truthful'
  | 'proxy-hostname-preserved'
  | 'one-bind-ip-plus-socks5-hostname-loss';

export type CompatibilityFeasibilityReference = {
  readonly proofModel: FeasibilityProofModel;
  readonly generatedAt: string;
  readonly verdict: FeasibilityArtifact['verdict'];
  readonly summary: FeasibilityArtifact['summary'];
};

export type CompatibilityHostnameRoutingObservation = {
  readonly sharedBindIpCount: number;
  readonly requestedProxyHostnamePreserved: boolean;
  readonly currentSelector: 'destination-bind-ip';
  readonly artifactPath?: string;
  readonly notes?: readonly string[];
};

export type CompatibilityHostnameRoutingTruthfulness = {
  readonly status: 'truthful' | 'not-truthful';
  readonly reason: HostnameRoutingReason;
  readonly summary: string;
  readonly sharedBindIpCount: number;
  readonly requestedProxyHostnamePreserved: boolean;
  readonly currentSelector: 'destination-bind-ip';
  readonly artifactPath?: string;
  readonly notes: readonly string[];
};

export type CompatibilityProtocolObservation = {
  readonly protocol: CompatibilityProtocol;
  readonly probeSucceeded: boolean;
  readonly canSelectExitByHostname: boolean;
  readonly canSelectExitWithExplicitRelaySelection: boolean;
  readonly observedCapabilitySummary: string;
  readonly artifactPath?: string;
  readonly proxyUrl?: string;
};

export type CompatibilityProtocolVerdict = {
  readonly protocol: CompatibilityProtocol;
  readonly outcome: CompatibilityOutcome;
  readonly reason: CompatibilityProtocolReason;
  readonly summary: string;
  readonly observedCapabilitySummary: string;
  readonly probeSucceeded: boolean;
  readonly canSelectExitByHostname: boolean;
  readonly canSelectExitWithExplicitRelaySelection: boolean;
  readonly artifactPath?: string;
  readonly proxyUrl?: string;
};

export type CompatibilityOperatorObservation = {
  readonly authPreserved: boolean;
  readonly requiresClientSpecificRelayConfiguration: boolean;
  readonly locationSelectionDiscoverable: boolean;
  readonly notes?: readonly string[];
};

export type CompatibilityRequirementDelta = {
  readonly requirementId: CompatibilityRequirementId;
  readonly title: string;
  readonly status: CompatibilityRequirementStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
};

export type CompatibilityRecommendation = {
  readonly posture: CompatibilityRecommendationPosture;
  readonly summary: string;
  readonly survivingRequirementIds: readonly CompatibilityRequirementId[];
  readonly degradedRequirementIds: readonly CompatibilityRequirementId[];
  readonly failedRequirementIds: readonly CompatibilityRequirementId[];
};

export type CompatibilityArtifact = {
  readonly schemaVersion: typeof COMPATIBILITY_ARTIFACT_VERSION;
  readonly generatedAt: string;
  readonly proofModel: CompatibilityProofModel;
  readonly feasibility: CompatibilityFeasibilityReference | null;
  readonly hostnameRouting: CompatibilityHostnameRoutingTruthfulness;
  readonly protocols: readonly CompatibilityProtocolVerdict[];
  readonly requirementDeltas: readonly CompatibilityRequirementDelta[];
  readonly recommendation: CompatibilityRecommendation;
  readonly operator: {
    readonly authPreserved: boolean;
    readonly requiresClientSpecificRelayConfiguration: boolean;
    readonly locationSelectionDiscoverable: boolean;
    readonly notes: readonly string[];
  };
};

export type CreateCompatibilityArtifactOptions = {
  readonly generatedAt: string;
  readonly feasibility?: FeasibilityArtifact;
  readonly hostnameRouting: CompatibilityHostnameRoutingObservation;
  readonly protocols: readonly CompatibilityProtocolObservation[];
  readonly operator: CompatibilityOperatorObservation;
};

export type SerializeCompatibilityArtifactOptions = {
  readonly artifact: CompatibilityArtifact;
  readonly additionalSecrets?: readonly string[];
};

const REQUIREMENT_TITLES: Record<CompatibilityRequirementId, string> = {
  R004: 'Hostname-selected location routing',
  R005: 'SOCKS5 support',
  R006: 'HTTP proxy support',
  R007: 'HTTPS proxy support',
  R008: 'Authenticated proxy access',
  R017: 'Low-friction first run for self-hosters',
  R019: 'Easy location naming and discovery',
};

export function createCompatibilityArtifact(options: CreateCompatibilityArtifactOptions): CompatibilityArtifact {
  const hostnameRouting = classifyHostnameRoutingTruthfulness(options.hostnameRouting);
  const protocols = COMPATIBILITY_PROTOCOLS.map((protocol) => {
    const observation = options.protocols.find((candidate) => candidate.protocol === protocol);

    if (!observation) {
      throw new Error(`Missing compatibility observation for protocol ${protocol}.`);
    }

    return classifyProtocolVerdict({
      hostnameRouting,
      observation,
    });
  });
  const requirementDeltas = createRequirementDeltas({
    hostnameRouting,
    protocols,
    operator: options.operator,
  });
  const recommendation = classifyRecommendation({
    requirementDeltas,
  });

  return {
    schemaVersion: COMPATIBILITY_ARTIFACT_VERSION,
    generatedAt: options.generatedAt,
    proofModel: COMPATIBILITY_PROOF_MODEL,
    feasibility: options.feasibility ? toFeasibilityReference(options.feasibility) : null,
    hostnameRouting,
    protocols,
    requirementDeltas,
    recommendation,
    operator: {
      authPreserved: options.operator.authPreserved,
      requiresClientSpecificRelayConfiguration: options.operator.requiresClientSpecificRelayConfiguration,
      locationSelectionDiscoverable: options.operator.locationSelectionDiscoverable,
      notes: [...(options.operator.notes ?? [])],
    },
  };
}

export function classifyHostnameRoutingTruthfulness(
  observation: CompatibilityHostnameRoutingObservation,
): CompatibilityHostnameRoutingTruthfulness {
  if (observation.sharedBindIpCount > 1) {
    return {
      status: 'truthful',
      reason: 'destination-bind-ip-selector-still-truthful',
      summary:
        'Hostname-selected routing remains truthful because distinct bind IPs still exist for the routing layer to dispatch on.',
      sharedBindIpCount: observation.sharedBindIpCount,
      requestedProxyHostnamePreserved: observation.requestedProxyHostnamePreserved,
      currentSelector: observation.currentSelector,
      ...(observation.artifactPath ? { artifactPath: observation.artifactPath } : {}),
      notes: [...(observation.notes ?? [])],
    };
  }

  if (observation.requestedProxyHostnamePreserved) {
    return {
      status: 'truthful',
      reason: 'proxy-hostname-preserved',
      summary:
        'Hostname-selected routing remains truthful because the shared-entry topology still preserves the requested proxy hostname end-to-end.',
      sharedBindIpCount: observation.sharedBindIpCount,
      requestedProxyHostnamePreserved: observation.requestedProxyHostnamePreserved,
      currentSelector: observation.currentSelector,
      ...(observation.artifactPath ? { artifactPath: observation.artifactPath } : {}),
      notes: [...(observation.notes ?? [])],
    };
  }

  return {
    status: 'not-truthful',
    reason: 'one-bind-ip-plus-socks5-hostname-loss',
    summary:
      'Hostname-selected routing is not truthful under one bind IP because SOCKS5 does not preserve the requested proxy hostname for the current destination-bind-IP selector.',
    sharedBindIpCount: observation.sharedBindIpCount,
    requestedProxyHostnamePreserved: observation.requestedProxyHostnamePreserved,
    currentSelector: observation.currentSelector,
    ...(observation.artifactPath ? { artifactPath: observation.artifactPath } : {}),
    notes: [...(observation.notes ?? [])],
  };
}

export function classifyProtocolVerdict(options: {
  readonly hostnameRouting: CompatibilityHostnameRoutingTruthfulness;
  readonly observation: CompatibilityProtocolObservation;
}): CompatibilityProtocolVerdict {
  const { observation } = options;

  if (!observation.probeSucceeded) {
    return {
      protocol: observation.protocol,
      outcome: 'blocked',
      reason: 'probe-failed',
      summary: `${labelProtocol(observation.protocol)} probing failed, so the shared-entry topology cannot support that protocol truthfully.`,
      observedCapabilitySummary: observation.observedCapabilitySummary,
      probeSucceeded: observation.probeSucceeded,
      canSelectExitByHostname: observation.canSelectExitByHostname,
      canSelectExitWithExplicitRelaySelection: observation.canSelectExitWithExplicitRelaySelection,
      ...(observation.artifactPath ? { artifactPath: observation.artifactPath } : {}),
      ...(observation.proxyUrl ? { proxyUrl: observation.proxyUrl } : {}),
    };
  }

  if (options.hostnameRouting.status === 'truthful' && observation.canSelectExitByHostname) {
    return {
      protocol: observation.protocol,
      outcome: 'supported',
      reason: 'supported-as-is',
      summary: `${labelProtocol(observation.protocol)} preserves the current hostname-selected routing contract without redesign.`,
      observedCapabilitySummary: observation.observedCapabilitySummary,
      probeSucceeded: observation.probeSucceeded,
      canSelectExitByHostname: observation.canSelectExitByHostname,
      canSelectExitWithExplicitRelaySelection: observation.canSelectExitWithExplicitRelaySelection,
      ...(observation.artifactPath ? { artifactPath: observation.artifactPath } : {}),
      ...(observation.proxyUrl ? { proxyUrl: observation.proxyUrl } : {}),
    };
  }

  if (observation.canSelectExitWithExplicitRelaySelection) {
    return {
      protocol: observation.protocol,
      outcome: 'degraded',
      reason: 'explicit-relay-selection-required',
      summary: `${labelProtocol(observation.protocol)} only works if operators or clients explicitly choose the Mullvad relay, so the product contract would need to change.`,
      observedCapabilitySummary: observation.observedCapabilitySummary,
      probeSucceeded: observation.probeSucceeded,
      canSelectExitByHostname: observation.canSelectExitByHostname,
      canSelectExitWithExplicitRelaySelection: observation.canSelectExitWithExplicitRelaySelection,
      ...(observation.artifactPath ? { artifactPath: observation.artifactPath } : {}),
      ...(observation.proxyUrl ? { proxyUrl: observation.proxyUrl } : {}),
    };
  }

  return {
    protocol: observation.protocol,
    outcome: 'blocked',
    reason: 'hostname-routing-not-truthful',
    summary: `${labelProtocol(observation.protocol)} cannot truthfully preserve hostname-selected routing under the shared-entry topology.`,
    observedCapabilitySummary: observation.observedCapabilitySummary,
    probeSucceeded: observation.probeSucceeded,
    canSelectExitByHostname: observation.canSelectExitByHostname,
    canSelectExitWithExplicitRelaySelection: observation.canSelectExitWithExplicitRelaySelection,
    ...(observation.artifactPath ? { artifactPath: observation.artifactPath } : {}),
    ...(observation.proxyUrl ? { proxyUrl: observation.proxyUrl } : {}),
  };
}

export function serializeCompatibilityArtifact(options: SerializeCompatibilityArtifactOptions): string {
  const secrets = collectCompatibilitySecrets({
    artifact: options.artifact,
    additionalSecrets: options.additionalSecrets ?? [],
  });
  const serialized = JSON.stringify(options.artifact, null, 2);
  return redactSecretStrings(serialized, secrets);
}

function createRequirementDeltas(input: {
  readonly hostnameRouting: CompatibilityHostnameRoutingTruthfulness;
  readonly protocols: readonly CompatibilityProtocolVerdict[];
  readonly operator: CompatibilityOperatorObservation;
}): CompatibilityRequirementDelta[] {
  const protocolMap = new Map<CompatibilityProtocol, CompatibilityProtocolVerdict>(
    input.protocols.map((protocol) => {
      return [protocol.protocol, protocol] as const;
    }),
  );
  const socks5 = protocolMap.get('socks5');
  const http = protocolMap.get('http');
  const https = protocolMap.get('https');

  if (!socks5 || !http || !https) {
    throw new Error('Expected compatibility verdicts for SOCKS5, HTTP, and HTTPS.');
  }

  const anyBlocked = input.protocols.some((protocol) => protocol.outcome === 'blocked');
  const anyDegraded = input.protocols.some((protocol) => protocol.outcome === 'degraded');

  const requirementDeltas: CompatibilityRequirementDelta[] = [
    {
      requirementId: 'R004',
      title: REQUIREMENT_TITLES.R004,
      status: input.hostnameRouting.status === 'truthful' ? 'preserved' : 'failed',
      summary:
        input.hostnameRouting.status === 'truthful'
          ? 'Hostname-selected routing still maps truthfully to the requested Mullvad exit.'
          : 'Hostname-selected routing no longer truthfully selects the Mullvad exit under the shared-entry topology.',
      evidence: [input.hostnameRouting.summary],
    },
    toProtocolRequirementDelta({
      requirementId: 'R005',
      verdict: socks5,
    }),
    toProtocolRequirementDelta({
      requirementId: 'R006',
      verdict: http,
    }),
    toProtocolRequirementDelta({
      requirementId: 'R007',
      verdict: https,
    }),
    {
      requirementId: 'R008',
      title: REQUIREMENT_TITLES.R008,
      status: input.operator.authPreserved ? 'preserved' : 'failed',
      summary: input.operator.authPreserved
        ? 'Authenticated proxy access remains visible and enforced at the shared entry.'
        : 'The shared-entry topology loses the authenticated proxy surface expected by the product contract.',
      evidence: [
        input.operator.authPreserved
          ? 'Shared-entry probing still requires authenticated local proxy access.'
          : 'Shared-entry probing could not prove authenticated local proxy access.',
      ],
    },
    {
      requirementId: 'R017',
      title: REQUIREMENT_TITLES.R017,
      status: anyBlocked
        ? 'failed'
        : input.operator.requiresClientSpecificRelayConfiguration || anyDegraded
          ? 'degraded'
          : 'preserved',
      summary: (() => {
        if (anyBlocked) {
          return 'The shared-entry topology breaks the low-friction self-hoster story because at least one required protocol no longer works truthfully.';
        }

        if (input.operator.requiresClientSpecificRelayConfiguration || anyDegraded) {
          return 'The shared-entry topology adds client-specific relay-selection steps, so the self-hoster flow would need a contract change.';
        }

        return 'The shared-entry topology keeps the self-hoster flow aligned with the existing low-friction product story.';
      })(),
      evidence: [
        input.operator.requiresClientSpecificRelayConfiguration
          ? 'Operators must configure client-specific relay selection instead of relying on hostname-only routing.'
          : 'Operators can keep the current hostname-only route-selection flow.',
      ],
    },
    {
      requirementId: 'R019',
      title: REQUIREMENT_TITLES.R019,
      status: input.hostnameRouting.status === 'truthful'
        ? 'preserved'
        : input.operator.locationSelectionDiscoverable
          ? 'degraded'
          : 'failed',
      summary: (() => {
        if (input.hostnameRouting.status === 'truthful') {
          return 'Route naming and exit discovery stay understandable because hostnames remain truthful selectors.';
        }

        if (input.operator.locationSelectionDiscoverable) {
          return 'Route naming remains diagnosable, but operators must understand an explicit relay-selection mapping instead of hostname-only routing.';
        }

        return 'Route naming and exit discovery are no longer understandable enough to preserve the current product contract.';
      })(),
      evidence: [
        input.hostnameRouting.summary,
        input.operator.locationSelectionDiscoverable
          ? 'Location-selection metadata can still be described to operators in a compatibility bundle.'
          : 'No truthful location-selection surface remains for operators to inspect.',
      ],
    },
  ];

  return requirementDeltas;
}

function toProtocolRequirementDelta(options: {
  readonly requirementId: 'R005' | 'R006' | 'R007';
  readonly verdict: CompatibilityProtocolVerdict;
}): CompatibilityRequirementDelta {
  return {
    requirementId: options.requirementId,
    title: REQUIREMENT_TITLES[options.requirementId],
    status: toRequirementStatus(options.verdict.outcome),
    summary: options.verdict.summary,
    evidence: [options.verdict.observedCapabilitySummary],
  };
}

function classifyRecommendation(input: {
  readonly requirementDeltas: readonly CompatibilityRequirementDelta[];
}): CompatibilityRecommendation {
  const survivingRequirementIds = input.requirementDeltas
    .filter((requirement) => requirement.status === 'preserved')
    .map((requirement) => requirement.requirementId);
  const degradedRequirementIds = input.requirementDeltas
    .filter((requirement) => requirement.status === 'degraded')
    .map((requirement) => requirement.requirementId);
  const failedRequirementIds = input.requirementDeltas
    .filter((requirement) => requirement.status === 'failed')
    .map((requirement) => requirement.requirementId);

  if (failedRequirementIds.length > 0) {
    return {
      posture: 'blocked',
      summary:
        'The shared-entry redesign is blocked because one or more active product requirements fail under the compatibility matrix.',
      survivingRequirementIds,
      degradedRequirementIds,
      failedRequirementIds,
    };
  }

  if (degradedRequirementIds.length > 0) {
    return {
      posture: 'possible-with-contract-change',
      summary:
        'The shared-entry redesign is only possible if Mullgate explicitly changes the degraded product contracts named in this matrix.',
      survivingRequirementIds,
      degradedRequirementIds,
      failedRequirementIds,
    };
  }

  return {
    posture: 'approved',
    summary: 'The shared-entry redesign preserves every tracked product contract in this matrix.',
    survivingRequirementIds,
    degradedRequirementIds,
    failedRequirementIds,
  };
}

function toFeasibilityReference(artifact: FeasibilityArtifact): CompatibilityFeasibilityReference {
  return {
    proofModel: FEASIBILITY_PROOF_MODEL,
    generatedAt: artifact.generatedAt,
    verdict: artifact.verdict,
    summary: artifact.summary,
  };
}

function toRequirementStatus(outcome: CompatibilityOutcome): CompatibilityRequirementStatus {
  if (outcome === 'supported') {
    return 'preserved';
  }

  if (outcome === 'degraded') {
    return 'degraded';
  }

  return 'failed';
}

function labelProtocol(protocol: CompatibilityProtocol): string {
  if (protocol === 'socks5') {
    return 'SOCKS5';
  }

  if (protocol === 'http') {
    return 'HTTP';
  }

  return 'HTTPS';
}

function collectCompatibilitySecrets(input: {
  readonly artifact: CompatibilityArtifact;
  readonly additionalSecrets: readonly string[];
}): string[] {
  const feasibilitySecrets = input.artifact.feasibility ? [] : [];
  const protocolSecrets = input.artifact.protocols.flatMap((protocol) => {
    return protocol.proxyUrl ? [protocol.proxyUrl] : [];
  });
  const knownSecrets = [...protocolSecrets, ...input.additionalSecrets, ...feasibilitySecrets];
  return dedupeSecrets(knownSecrets);
}

function dedupeSecrets(values: readonly (string | undefined)[]): string[] {
  const deduped = new Set<string>();

  values.forEach((value) => {
    if (typeof value !== 'string') {
      return;
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return;
    }

    deduped.add(value);
    deduped.add(trimmed);
  });

  return [...deduped.values()].sort((left, right) => right.length - left.length);
}

function redactSecretStrings(value: string, secrets: readonly string[]): string {
  const redacted = secrets.reduce((current, secret) => {
    return current.split(secret).join(REDACTED);
  }, value);

  return redacted.replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, REDACTED);
}
