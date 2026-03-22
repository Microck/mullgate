import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCompatibilityArtifact } from '../../src/m004/compatibility-contract.js';
import type { CompatibilitySummaryBundle } from '../../src/m004/compatibility-runner.js';
import {
  MILESTONE_DECISION_BUNDLE_VERSION,
  MILESTONE_DECISION_PROOF_MODEL,
  MILESTONE_REQUIREMENT_ID,
  createMilestoneDecisionBundle,
  renderMilestoneDecisionText,
  serializeMilestoneDecisionBundle,
} from '../../src/m004/milestone-contract.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures', 'm004');

async function loadCompatibilityFixtureBundle(): Promise<CompatibilitySummaryBundle> {
  const fixturePath = path.join(fixturesDir, 'compatibility-hostname-fail.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    readonly generatedAt: string;
    readonly feasibility?: unknown;
    readonly hostnameRouting: Parameters<typeof createCompatibilityArtifact>[0]['hostnameRouting'];
    readonly protocols: Parameters<typeof createCompatibilityArtifact>[0]['protocols'];
    readonly operator: Parameters<typeof createCompatibilityArtifact>[0]['operator'];
    readonly phase: string;
    readonly workspacePath?: string;
    readonly notes?: readonly string[];
  };
  const artifact = createCompatibilityArtifact({
    generatedAt: fixture.generatedAt,
    ...(fixture.feasibility ? { feasibility: fixture.feasibility as never } : {}),
    hostnameRouting: fixture.hostnameRouting,
    protocols: fixture.protocols,
    operator: fixture.operator,
  });

  return {
    schemaVersion: 1,
    generatedAt: fixture.generatedAt,
    mode: 'fixture',
    phase: fixture.phase,
    overallVerdict: 'fail',
    artifact,
    summary: {
      headline:
        'SOCKS5 chaining can still work with explicit relay selection, but hostname-selected routing fails and HTTP/HTTPS cannot keep Mullgate’s current truthful contract.',
      protocolMatrix: artifact.protocols.map((protocol) => {
        return {
          protocol: protocol.protocol,
          outcome: protocol.outcome,
          reason: protocol.reason,
          contractStatus:
            protocol.outcome === 'supported'
              ? 'preserved'
              : protocol.outcome === 'degraded'
                ? 'contract-change'
                : 'failed',
          summary: protocol.summary,
          observedCapabilitySummary: protocol.observedCapabilitySummary,
          ...(protocol.artifactPath ? { artifactPath: protocol.artifactPath } : {}),
        };
      }),
      requirementDeltas: artifact.requirementDeltas.map((requirement) => {
        return {
          requirementId: requirement.requirementId,
          title: requirement.title,
          status: requirement.status,
          summary: requirement.summary,
          evidence: [...requirement.evidence],
        };
      }),
      operatorImpact: {
        authSurface: artifact.operator.authPreserved ? 'preserved' : 'failed',
        relaySelectionFlow: artifact.operator.requiresClientSpecificRelayConfiguration
          ? 'explicit-relay-selection-required'
          : 'hostname-selected',
        locationDiscovery: artifact.hostnameRouting.status === 'truthful' ? 'truthful-hostname-selection' : 'explicit-relay-mapping',
        notes: [...artifact.operator.notes],
      },
      hostnameRouting: {
        status: artifact.hostnameRouting.status,
        reason: artifact.hostnameRouting.reason,
        summary: artifact.hostnameRouting.summary,
        explicitFailure:
          'Hostname-selected routing fails under the one-entry topology because the shared entry collapses to one bind IP and SOCKS5 does not preserve the requested proxy hostname for destination-bind-IP selection.',
        ...(artifact.hostnameRouting.artifactPath ? { artifactPath: artifact.hostnameRouting.artifactPath } : {}),
      },
      recommendation: {
        posture: artifact.recommendation.posture,
        summary: artifact.recommendation.summary,
        survivingRequirementIds: [...artifact.recommendation.survivingRequirementIds],
        degradedRequirementIds: [...artifact.recommendation.degradedRequirementIds],
        failedRequirementIds: [...artifact.recommendation.failedRequirementIds],
      },
      artifactLinks: {
        artifactJson: '.tmp/m004/latest/compatibility-artifact.json',
        summaryJson: '.tmp/m004/latest/compatibility-summary.json',
        summaryText: '.tmp/m004/latest/compatibility-summary.txt',
        protocolEvidence: '.tmp/m004/latest/protocol-evidence.json',
        hostnameRoutingEvidence: '.tmp/m004/latest/hostname-routing.json',
        evaluationMetadata: '.tmp/m004/latest/evaluation.json',
        feasibilitySummaryJson: '.tmp/m004/latest/feasibility-summary.json',
        feasibilitySummaryText: '.tmp/m004/latest/feasibility-summary.txt',
      },
    },
    diagnostics: {
      preservedWorkspace: true,
      ...(fixture.workspacePath ? { workspacePath: fixture.workspacePath } : {}),
      notes: [...(fixture.notes ?? []), ...(fixture.workspacePath ? [`Preserved verifier workspace at ${fixture.workspacePath}.`] : [])],
      artifactPaths: {
        artifactJson: '.tmp/m004/latest/compatibility-artifact.json',
        summaryJson: '.tmp/m004/latest/compatibility-summary.json',
        summaryText: '.tmp/m004/latest/compatibility-summary.txt',
        protocolEvidence: '.tmp/m004/latest/protocol-evidence.json',
        hostnameRoutingEvidence: '.tmp/m004/latest/hostname-routing.json',
        evaluationMetadata: '.tmp/m004/latest/evaluation.json',
        feasibilitySummaryJson: '.tmp/m004/latest/feasibility-summary.json',
        feasibilitySummaryText: '.tmp/m004/latest/feasibility-summary.txt',
      },
    },
  };
}

function createCompatibilityBundle(options: {
  readonly recommendationPosture: CompatibilitySummaryBundle['artifact']['recommendation']['posture'];
}): CompatibilitySummaryBundle {
  const artifact = createCompatibilityArtifact({
    generatedAt: '2026-03-22T02:20:00.000Z',
    hostnameRouting: {
      sharedBindIpCount: options.recommendationPosture === 'approved' ? 2 : 1,
      requestedProxyHostnamePreserved: options.recommendationPosture !== 'blocked',
      currentSelector: 'destination-bind-ip',
      artifactPath: '.tmp/m004/latest/hostname-routing.json',
    },
    protocols: [
      {
        protocol: 'socks5',
        probeSucceeded: true,
        canSelectExitByHostname: options.recommendationPosture === 'approved',
        canSelectExitWithExplicitRelaySelection: true,
        observedCapabilitySummary:
          options.recommendationPosture === 'approved'
            ? 'SOCKS5 preserves hostname-selected routing under the tested topology.'
            : 'SOCKS5 only works when clients explicitly select a relay for the second hop.',
      },
      {
        protocol: 'http',
        probeSucceeded: true,
        canSelectExitByHostname: options.recommendationPosture === 'approved',
        canSelectExitWithExplicitRelaySelection: options.recommendationPosture === 'possible-with-contract-change',
        observedCapabilitySummary:
          options.recommendationPosture === 'approved'
            ? 'HTTP preserves hostname-selected routing under the tested topology.'
            : options.recommendationPosture === 'possible-with-contract-change'
              ? 'HTTP works only when the product contract switches to explicit relay selection.'
              : 'HTTP cannot preserve truthful routing under the one-entry topology.',
      },
      {
        protocol: 'https',
        probeSucceeded: true,
        canSelectExitByHostname: options.recommendationPosture === 'approved',
        canSelectExitWithExplicitRelaySelection: options.recommendationPosture === 'possible-with-contract-change',
        observedCapabilitySummary:
          options.recommendationPosture === 'approved'
            ? 'HTTPS preserves hostname-selected routing under the tested topology.'
            : options.recommendationPosture === 'possible-with-contract-change'
              ? 'HTTPS works only when the product contract switches to explicit relay selection.'
              : 'HTTPS cannot preserve truthful routing under the one-entry topology.',
      },
    ],
    operator: {
      authPreserved: true,
      requiresClientSpecificRelayConfiguration: options.recommendationPosture !== 'approved',
      locationSelectionDiscoverable: true,
      notes:
        options.recommendationPosture === 'approved'
          ? ['Operators can keep the current hostname-selected contract.']
          : ['Operators must understand an explicit relay mapping for the shared-entry topology.'],
    },
  });

  return {
    schemaVersion: 1,
    generatedAt: artifact.generatedAt,
    mode: 'fixture',
    phase: 'fixture-replay',
    overallVerdict:
      artifact.recommendation.posture === 'approved'
        ? 'pass'
        : artifact.recommendation.posture === 'possible-with-contract-change'
          ? 'contract-change'
          : 'fail',
    artifact,
    summary: {
      headline:
        artifact.recommendation.posture === 'approved'
          ? 'All tracked product contracts remain truthful enough to pursue the shared-entry redesign.'
          : artifact.recommendation.posture === 'possible-with-contract-change'
            ? 'The shared-entry topology is only viable if Mullgate accepts explicit contract changes for degraded protocol selection.'
            : 'The shared-entry topology is blocked because hostname truthfulness or protocol coverage failed.',
      protocolMatrix: artifact.protocols.map((protocol) => {
        return {
          protocol: protocol.protocol,
          outcome: protocol.outcome,
          reason: protocol.reason,
          contractStatus:
            protocol.outcome === 'supported'
              ? 'preserved'
              : protocol.outcome === 'degraded'
                ? 'contract-change'
                : 'failed',
          summary: protocol.summary,
          observedCapabilitySummary: protocol.observedCapabilitySummary,
        };
      }),
      requirementDeltas: artifact.requirementDeltas.map((requirement) => {
        return {
          requirementId: requirement.requirementId,
          title: requirement.title,
          status: requirement.status,
          summary: requirement.summary,
          evidence: [...requirement.evidence],
        };
      }),
      operatorImpact: {
        authSurface: 'preserved',
        relaySelectionFlow:
          artifact.operator.requiresClientSpecificRelayConfiguration
            ? 'explicit-relay-selection-required'
            : 'hostname-selected',
        locationDiscovery:
          artifact.hostnameRouting.status === 'truthful' ? 'truthful-hostname-selection' : 'explicit-relay-mapping',
        notes: [...artifact.operator.notes],
      },
      hostnameRouting: {
        status: artifact.hostnameRouting.status,
        reason: artifact.hostnameRouting.reason,
        summary: artifact.hostnameRouting.summary,
        explicitFailure:
          artifact.hostnameRouting.status === 'truthful'
            ? null
            : 'Hostname-selected routing fails under the one-entry topology because the shared entry collapses to one bind IP and SOCKS5 does not preserve the requested proxy hostname for destination-bind-IP selection.',
      },
      recommendation: {
        posture: artifact.recommendation.posture,
        summary: artifact.recommendation.summary,
        survivingRequirementIds: [...artifact.recommendation.survivingRequirementIds],
        degradedRequirementIds: [...artifact.recommendation.degradedRequirementIds],
        failedRequirementIds: [...artifact.recommendation.failedRequirementIds],
      },
      artifactLinks: {
        artifactJson: '.tmp/m004/latest/compatibility-artifact.json',
        summaryJson: '.tmp/m004/latest/compatibility-summary.json',
        summaryText: '.tmp/m004/latest/compatibility-summary.txt',
        protocolEvidence: '.tmp/m004/latest/protocol-evidence.json',
        hostnameRoutingEvidence: '.tmp/m004/latest/hostname-routing.json',
        evaluationMetadata: '.tmp/m004/latest/evaluation.json',
      },
    },
    diagnostics: {
      preservedWorkspace: artifact.recommendation.posture !== 'approved',
      notes: ['Compatibility summary prepared for milestone decision serialization.'],
      artifactPaths: {
        artifactJson: '.tmp/m004/latest/compatibility-artifact.json',
        summaryJson: '.tmp/m004/latest/compatibility-summary.json',
        summaryText: '.tmp/m004/latest/compatibility-summary.txt',
        protocolEvidence: '.tmp/m004/latest/protocol-evidence.json',
        hostnameRoutingEvidence: '.tmp/m004/latest/hostname-routing.json',
        evaluationMetadata: '.tmp/m004/latest/evaluation.json',
      },
    },
  };
}

describe('m004 milestone decision contract', () => {
  it('maps a blocked compatibility fixture into an explicit R028 stop decision without leaking secrets', async () => {
    const compatibilityBundle = await loadCompatibilityFixtureBundle();

    const decision = createMilestoneDecisionBundle({
      compatibilityBundle,
    });
    const text = renderMilestoneDecisionText(decision);
    const serialized = serializeMilestoneDecisionBundle({
      bundle: decision,
      additionalSecrets: ['123456789012', 'private-key-value-1', 'super-secret-password'],
    });

    expect(decision).toMatchObject({
      schemaVersion: MILESTONE_DECISION_BUNDLE_VERSION,
      proofModel: MILESTONE_DECISION_PROOF_MODEL,
      milestoneId: 'M004',
      sliceId: 'S03',
      posture: 'fail',
      recommendation: {
        nextAction: 'stop-redesign',
      },
      requirement: {
        requirementId: MILESTONE_REQUIREMENT_ID,
        advancement: 'blocked',
      },
      compatibility: {
        overallVerdict: 'fail',
        recommendationPosture: 'blocked',
        hostnameRoutingStatus: 'not-truthful',
      },
      diagnostics: {
        preservedWorkspace: true,
      },
    });
    expect(decision.requirement.summary).toContain('R028 is blocked');
    expect(decision.requirement.summary).toContain('R004');
    expect(decision.requirement.summary).toContain('R006');
    expect(decision.requirement.summary).toContain('R007');
    expect(decision.supportingRequirements.find((requirement) => requirement.requirementId === 'R005')).toMatchObject({
      status: 'degraded',
    });
    expect(text).toContain('M004 shared-entry redesign decision: FAIL');
    expect(text).toContain('R028: blocked');
    expect(text).toContain('hostname routing failure: Hostname-selected routing fails under the one-entry topology');
    expect(text).toContain('preserved workspace: yes');
    expect(serialized).toContain('"recommendation"');
    expect(serialized).toContain('"R028"');
    expect(serialized).not.toContain('123456789012');
    expect(serialized).not.toContain('private-key-value-1');
    expect(serialized).not.toContain('super-secret-password');
  });

  it('maps a fully preserved compatibility bundle into a pass posture that advances R028', () => {
    const decision = createMilestoneDecisionBundle({
      compatibilityBundle: createCompatibilityBundle({
        recommendationPosture: 'approved',
      }),
    });

    expect(decision.posture).toBe('pass');
    expect(decision.recommendation.nextAction).toBe('pursue-redesign');
    expect(decision.requirement.advancement).toBe('advanced');
    expect(decision.requirement.summary).toContain('R028 advances');
    expect(decision.requirement.blockedRequirementIds).toEqual([]);
    expect(decision.requirement.contractChangeRequirementIds).toEqual([]);
    expect(renderMilestoneDecisionText(decision)).toContain('M004 shared-entry redesign decision: PASS');
  });

  it('maps degraded compatibility into a contract-change-required posture that still keeps the final verdict explicit', () => {
    const decision = createMilestoneDecisionBundle({
      compatibilityBundle: createCompatibilityBundle({
        recommendationPosture: 'possible-with-contract-change',
      }),
    });

    expect(decision.posture).toBe('contract-change-required');
    expect(decision.recommendation.nextAction).toBe('pursue-only-with-contract-change');
    expect(decision.requirement.advancement).toBe('requires-contract-change');
    expect(decision.requirement.summary).toContain('R028 only advances if Mullgate accepts contract changes');
    expect(decision.requirement.contractChangeRequirementIds).toContain('R005');
    expect(decision.requirement.contractChangeRequirementIds).toContain('R006');
    expect(decision.requirement.contractChangeRequirementIds).toContain('R007');
    expect(renderMilestoneDecisionText(decision)).toContain('M004 shared-entry redesign decision: CONTRACT-CHANGE-REQUIRED');
  });
});
