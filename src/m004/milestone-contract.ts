import { REDACTED } from '../config/redact.js';
import type {
  CompatibilityRecommendationPosture,
  CompatibilityRequirementStatus,
} from './compatibility-contract.js';
import type { CompatibilitySummaryBundle } from './compatibility-runner.js';

export const MILESTONE_DECISION_BUNDLE_VERSION = 1 as const;
export const MILESTONE_DECISION_PROOF_MODEL = 'm004-shared-entry-redesign-decision' as const;
export const MILESTONE_REQUIREMENT_ID = 'R028' as const;
export const MILESTONE_REQUIREMENT_TITLE =
  'Many concurrent country-distinct exits on one Mullvad account' as const;
export const MILESTONE_DECISION_QUESTION =
  'Should Mullgate pursue a shared-entry redesign that reuses one Mullvad WireGuard identity for many concurrent country-distinct exits?' as const;

export type MilestoneDecisionPosture = 'pass' | 'fail' | 'contract-change-required';
export type MilestoneRequirementAdvancement = 'advanced' | 'blocked' | 'requires-contract-change';
export type MilestoneNextAction = 'pursue-redesign' | 'stop-redesign' | 'pursue-only-with-contract-change';

export type MilestoneSupportingRequirement = {
  readonly requirementId: CompatibilitySummaryBundle['summary']['requirementDeltas'][number]['requirementId'];
  readonly title: string;
  readonly status: CompatibilityRequirementStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
};

export type MilestoneDecisionBundle = {
  readonly schemaVersion: typeof MILESTONE_DECISION_BUNDLE_VERSION;
  readonly generatedAt: string;
  readonly proofModel: typeof MILESTONE_DECISION_PROOF_MODEL;
  readonly milestoneId: 'M004';
  readonly sliceId: 'S03';
  readonly question: typeof MILESTONE_DECISION_QUESTION;
  readonly posture: MilestoneDecisionPosture;
  readonly recommendation: {
    readonly summary: string;
    readonly nextAction: MilestoneNextAction;
    readonly rationale: readonly string[];
  };
  readonly requirement: {
    readonly requirementId: typeof MILESTONE_REQUIREMENT_ID;
    readonly title: typeof MILESTONE_REQUIREMENT_TITLE;
    readonly advancement: MilestoneRequirementAdvancement;
    readonly summary: string;
    readonly survivingRequirementIds: readonly string[];
    readonly contractChangeRequirementIds: readonly string[];
    readonly blockedRequirementIds: readonly string[];
  };
  readonly compatibility: {
    readonly overallVerdict: CompatibilitySummaryBundle['overallVerdict'];
    readonly recommendationPosture: CompatibilityRecommendationPosture;
    readonly headline: string;
    readonly phase: string;
    readonly mode: CompatibilitySummaryBundle['mode'];
    readonly hostnameRoutingStatus: CompatibilitySummaryBundle['summary']['hostnameRouting']['status'];
    readonly hostnameRoutingFailure: string | null;
    readonly protocolMatrix: CompatibilitySummaryBundle['summary']['protocolMatrix'];
    readonly operatorImpact: CompatibilitySummaryBundle['summary']['operatorImpact'];
  };
  readonly supportingRequirements: readonly MilestoneSupportingRequirement[];
  readonly artifactLinks: CompatibilitySummaryBundle['summary']['artifactLinks'];
  readonly diagnostics: {
    readonly preservedWorkspace: boolean;
    readonly workspacePath?: string;
    readonly notes: readonly string[];
  };
};

export type CreateMilestoneDecisionBundleOptions = {
  readonly compatibilityBundle: CompatibilitySummaryBundle;
};

export type SerializeMilestoneDecisionBundleOptions = {
  readonly bundle: MilestoneDecisionBundle;
  readonly additionalSecrets?: readonly string[];
};

export function createMilestoneDecisionBundle(options: CreateMilestoneDecisionBundleOptions): MilestoneDecisionBundle {
  const posture = toMilestonePosture(options.compatibilityBundle.artifact.recommendation.posture);
  const supportingRequirements = options.compatibilityBundle.summary.requirementDeltas.map((requirement) => {
    return {
      requirementId: requirement.requirementId,
      title: requirement.title,
      status: requirement.status,
      summary: requirement.summary,
      evidence: [...requirement.evidence],
    } satisfies MilestoneSupportingRequirement;
  });
  const survivingRequirementIds = supportingRequirements
    .filter((requirement) => requirement.status === 'preserved')
    .map((requirement) => requirement.requirementId);
  const contractChangeRequirementIds = supportingRequirements
    .filter((requirement) => requirement.status === 'degraded')
    .map((requirement) => requirement.requirementId);
  const blockedRequirementIds = supportingRequirements
    .filter((requirement) => requirement.status === 'failed')
    .map((requirement) => requirement.requirementId);

  return {
    schemaVersion: MILESTONE_DECISION_BUNDLE_VERSION,
    generatedAt: options.compatibilityBundle.generatedAt,
    proofModel: MILESTONE_DECISION_PROOF_MODEL,
    milestoneId: 'M004',
    sliceId: 'S03',
    question: MILESTONE_DECISION_QUESTION,
    posture,
    recommendation: {
      summary: createRecommendationSummary({
        posture,
        compatibilityBundle: options.compatibilityBundle,
      }),
      nextAction: toMilestoneNextAction(posture),
      rationale: createRecommendationRationale({
        posture,
        compatibilityBundle: options.compatibilityBundle,
      }),
    },
    requirement: {
      requirementId: MILESTONE_REQUIREMENT_ID,
      title: MILESTONE_REQUIREMENT_TITLE,
      advancement: toMilestoneRequirementAdvancement(posture),
      summary: createRequirementSummary({
        posture,
        compatibilityBundle: options.compatibilityBundle,
        blockedRequirementIds,
        contractChangeRequirementIds,
      }),
      survivingRequirementIds,
      contractChangeRequirementIds,
      blockedRequirementIds,
    },
    compatibility: {
      overallVerdict: options.compatibilityBundle.overallVerdict,
      recommendationPosture: options.compatibilityBundle.artifact.recommendation.posture,
      headline: options.compatibilityBundle.summary.headline,
      phase: options.compatibilityBundle.phase,
      mode: options.compatibilityBundle.mode,
      hostnameRoutingStatus: options.compatibilityBundle.summary.hostnameRouting.status,
      hostnameRoutingFailure: options.compatibilityBundle.summary.hostnameRouting.explicitFailure,
      protocolMatrix: options.compatibilityBundle.summary.protocolMatrix.map((protocol) => {
        return { ...protocol };
      }),
      operatorImpact: {
        ...options.compatibilityBundle.summary.operatorImpact,
        notes: [...options.compatibilityBundle.summary.operatorImpact.notes],
      },
    },
    supportingRequirements,
    artifactLinks: {
      ...options.compatibilityBundle.summary.artifactLinks,
    },
    diagnostics: {
      preservedWorkspace: options.compatibilityBundle.diagnostics.preservedWorkspace,
      ...(options.compatibilityBundle.diagnostics.workspacePath
        ? { workspacePath: options.compatibilityBundle.diagnostics.workspacePath }
        : {}),
      notes: [...options.compatibilityBundle.diagnostics.notes],
    },
  };
}

export function serializeMilestoneDecisionBundle(options: SerializeMilestoneDecisionBundleOptions): string {
  const serialized = JSON.stringify(options.bundle, null, 2);
  const secrets = dedupeSecrets(options.additionalSecrets ?? []);
  return redactSecretStrings(serialized, secrets);
}

export function renderMilestoneDecisionText(bundle: MilestoneDecisionBundle): string {
  const lines: string[] = [
    `M004 shared-entry redesign decision: ${bundle.posture.toUpperCase()}`,
    `question: ${bundle.question}`,
    `recommendation: ${bundle.recommendation.summary}`,
    `next action: ${bundle.recommendation.nextAction}`,
    `R028: ${bundle.requirement.advancement} — ${bundle.requirement.summary}`,
    `compatibility headline: ${bundle.compatibility.headline}`,
    `compatibility posture: ${bundle.compatibility.recommendationPosture}`,
    `hostname routing: ${bundle.compatibility.hostnameRoutingStatus}`,
  ];

  if (bundle.compatibility.hostnameRoutingFailure) {
    lines.push(`hostname routing failure: ${bundle.compatibility.hostnameRoutingFailure}`);
  }

  lines.push('supporting requirements:');
  bundle.supportingRequirements.forEach((requirement) => {
    lines.push(`- ${requirement.requirementId}: ${requirement.status} — ${requirement.summary}`);
  });

  lines.push('protocol matrix:');
  bundle.compatibility.protocolMatrix.forEach((protocol) => {
    lines.push(`- ${protocol.protocol}: ${protocol.outcome} (${protocol.reason}) — ${protocol.summary}`);
  });

  lines.push('artifact links:');
  lines.push(`- compatibility summary json: ${bundle.artifactLinks.summaryJson}`);
  lines.push(`- compatibility summary text: ${bundle.artifactLinks.summaryText}`);
  lines.push(`- compatibility artifact json: ${bundle.artifactLinks.artifactJson}`);
  lines.push(`- protocol evidence: ${bundle.artifactLinks.protocolEvidence}`);
  lines.push(`- hostname routing evidence: ${bundle.artifactLinks.hostnameRoutingEvidence}`);
  lines.push(`- evaluation metadata: ${bundle.artifactLinks.evaluationMetadata}`);

  if (bundle.artifactLinks.feasibilitySummaryJson) {
    lines.push(`- feasibility summary json: ${bundle.artifactLinks.feasibilitySummaryJson}`);
  }

  if (bundle.artifactLinks.feasibilitySummaryText) {
    lines.push(`- feasibility summary text: ${bundle.artifactLinks.feasibilitySummaryText}`);
  }

  lines.push(`preserved workspace: ${bundle.diagnostics.preservedWorkspace ? 'yes' : 'no'}`);

  if (bundle.diagnostics.workspacePath) {
    lines.push(`workspace path: ${bundle.diagnostics.workspacePath}`);
  }

  bundle.diagnostics.notes.forEach((note) => {
    lines.push(`diagnostic note: ${note}`);
  });

  return lines.join('\n');
}

function toMilestonePosture(posture: CompatibilityRecommendationPosture): MilestoneDecisionPosture {
  if (posture === 'approved') {
    return 'pass';
  }

  if (posture === 'possible-with-contract-change') {
    return 'contract-change-required';
  }

  return 'fail';
}

function toMilestoneRequirementAdvancement(posture: MilestoneDecisionPosture): MilestoneRequirementAdvancement {
  if (posture === 'pass') {
    return 'advanced';
  }

  if (posture === 'contract-change-required') {
    return 'requires-contract-change';
  }

  return 'blocked';
}

function toMilestoneNextAction(posture: MilestoneDecisionPosture): MilestoneNextAction {
  if (posture === 'pass') {
    return 'pursue-redesign';
  }

  if (posture === 'contract-change-required') {
    return 'pursue-only-with-contract-change';
  }

  return 'stop-redesign';
}

function createRecommendationSummary(input: {
  readonly posture: MilestoneDecisionPosture;
  readonly compatibilityBundle: CompatibilitySummaryBundle;
}): string {
  if (input.posture === 'pass') {
    return 'Pursue the shared-entry redesign because the compatibility verifier preserved the tracked product contracts strongly enough to advance R028.';
  }

  if (input.posture === 'contract-change-required') {
    return 'Only pursue the shared-entry redesign if Mullgate accepts explicit product-contract changes for the degraded compatibility requirements that gate R028.';
  }

  return 'Do not pursue the shared-entry redesign as-is because the compatibility verifier found blocked contracts that prevent R028 from advancing truthfully.';
}

function createRecommendationRationale(input: {
  readonly posture: MilestoneDecisionPosture;
  readonly compatibilityBundle: CompatibilitySummaryBundle;
}): string[] {
  const rationale: string[] = [input.compatibilityBundle.summary.headline];

  if (input.compatibilityBundle.summary.hostnameRouting.explicitFailure) {
    rationale.push(input.compatibilityBundle.summary.hostnameRouting.explicitFailure);
  }

  if (input.posture === 'pass') {
    rationale.push('Every tracked compatibility requirement remained preserved in the shared-entry topology.');
    return rationale;
  }

  if (input.posture === 'contract-change-required') {
    rationale.push(
      `The redesign only stays viable if Mullgate changes these requirement contracts: ${input.compatibilityBundle.artifact.recommendation.degradedRequirementIds.join(', ')}.`,
    );
    return rationale;
  }

  rationale.push(
    `The redesign is blocked by failed requirements: ${input.compatibilityBundle.artifact.recommendation.failedRequirementIds.join(', ')}.`,
  );
  return rationale;
}

function createRequirementSummary(input: {
  readonly posture: MilestoneDecisionPosture;
  readonly compatibilityBundle: CompatibilitySummaryBundle;
  readonly blockedRequirementIds: readonly string[];
  readonly contractChangeRequirementIds: readonly string[];
}): string {
  if (input.posture === 'pass') {
    return 'R028 advances because the shared-entry topology preserved the tracked hostname-routing, protocol, and operator contracts needed to justify redesign work.';
  }

  if (input.posture === 'contract-change-required') {
    return `R028 only advances if Mullgate accepts contract changes for ${input.contractChangeRequirementIds.join(', ')} while keeping the remaining requirements preserved.`;
  }

  const hostnameFailure = input.compatibilityBundle.summary.hostnameRouting.explicitFailure;

  if (hostnameFailure) {
    return `R028 is blocked because ${hostnameFailure} Supporting failures: ${input.blockedRequirementIds.join(', ')}.`;
  }

  return `R028 is blocked because the shared-entry topology failed required compatibility contracts: ${input.blockedRequirementIds.join(', ')}.`;
}

function dedupeSecrets(values: readonly string[]): string[] {
  const deduped = new Set<string>();

  values.forEach((value) => {
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
