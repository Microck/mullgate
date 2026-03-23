import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CompatibilitySummaryBundle } from '../../src/m004/compatibility-runner.js';
import type { MilestoneDecisionBundle } from '../../src/m004/milestone-contract.js';
import { runMilestoneVerifier } from '../../src/m004/milestone-runner.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures', 'm004');

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

describe('m004 milestone runner', () => {
  it('wraps the compatibility fixture path into stable milestone decision artifacts', async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), 'm004-milestone-runner-'));

    try {
      const result = await runMilestoneVerifier({
        targetUrl: 'https://am.i.mullvad.net/json',
        routeCheckIp: '1.1.1.1',
        logicalExitCount: 3,
        outputRoot,
        keepTempHome: false,
        fixturePath: path.join(fixturesDir, 'compatibility-hostname-fail.json'),
      });

      const decisionJson = await readJsonFile<MilestoneDecisionBundle>(result.decisionJsonPath);
      const decisionText = await readFile(result.decisionTextPath, 'utf8');
      const compatibilitySummaryJson = await readJsonFile<CompatibilitySummaryBundle>(
        result.compatibilitySummaryJsonPath,
      );
      const compatibilitySummaryText = await readFile(result.compatibilitySummaryTextPath, 'utf8');

      expect(result.exitCode).toBe(0);
      expect(result.outputDir).toBe(path.join(outputRoot, 'latest'));
      expect(result.compatibilityArtifactJsonPath).toBe(
        path.join(outputRoot, 'latest', 'compatibility-artifact.json'),
      );
      expect(result.compatibilitySummaryJsonPath).toBe(
        path.join(outputRoot, 'latest', 'compatibility-summary.json'),
      );
      expect(result.compatibilitySummaryTextPath).toBe(
        path.join(outputRoot, 'latest', 'compatibility-summary.txt'),
      );
      expect(result.decisionJsonPath).toBe(path.join(outputRoot, 'latest', 'decision.json'));
      expect(result.decisionTextPath).toBe(path.join(outputRoot, 'latest', 'decision.txt'));

      expect(decisionJson).toMatchObject({
        milestoneId: 'M004',
        sliceId: 'S03',
        posture: 'fail',
        recommendation: {
          nextAction: 'stop-redesign',
        },
        requirement: {
          requirementId: 'R028',
          advancement: 'blocked',
        },
        compatibility: {
          overallVerdict: 'fail',
          recommendationPosture: 'blocked',
          hostnameRoutingStatus: 'not-truthful',
        },
        diagnostics: {
          preservedWorkspace: true,
          workspacePath: '/tmp/mullgate-m004-fixture',
        },
      });
      expect(decisionJson.requirement.summary).toContain('R028 is blocked');
      expect(decisionJson.requirement.blockedRequirementIds).toEqual(
        expect.arrayContaining(['R004', 'R006', 'R007']),
      );
      expect(decisionJson.requirement.contractChangeRequirementIds).toContain('R005');
      expect(decisionJson.artifactLinks.summaryJson).toBe(
        path.join(outputRoot, 'latest', 'compatibility-summary.json'),
      );
      expect(decisionJson.artifactLinks.summaryText).toBe(
        path.join(outputRoot, 'latest', 'compatibility-summary.txt'),
      );
      expect(decisionJson.artifactLinks.artifactJson).toBe(
        path.join(outputRoot, 'latest', 'compatibility-artifact.json'),
      );
      expect(decisionText).toContain('M004 shared-entry redesign decision: FAIL');
      expect(decisionText).toContain('next action: stop-redesign');
      expect(decisionText).toContain('R028: blocked');
      expect(decisionText).toContain(
        'hostname routing failure: Hostname-selected routing fails under the one-entry topology',
      );
      expect(decisionText).toContain('compatibility summary json:');
      expect(decisionText).toContain('preserved workspace: yes');

      expect(compatibilitySummaryJson.summary.artifactLinks.summaryJson).toBe(
        path.join(outputRoot, 'latest', 'compatibility-summary.json'),
      );
      expect(compatibilitySummaryJson.summary.artifactLinks.summaryText).toBe(
        path.join(outputRoot, 'latest', 'compatibility-summary.txt'),
      );
      expect(compatibilitySummaryJson.summary.artifactLinks.artifactJson).toBe(
        path.join(outputRoot, 'latest', 'compatibility-artifact.json'),
      );
      expect(compatibilitySummaryJson.summary.hostnameRouting.explicitFailure).toContain(
        'Hostname-selected routing fails',
      );
      expect(compatibilitySummaryJson.diagnostics.preservedWorkspace).toBe(true);
      expect(compatibilitySummaryJson.diagnostics.workspacePath).toBe('/tmp/mullgate-m004-fixture');
      expect(compatibilitySummaryJson.diagnostics.notes).toEqual(
        expect.arrayContaining([
          'Fixture proves that one-entry SOCKS5 chaining can still reach distinct exits while hostname-selected routing fails.',
          'Fixture replay mode skipped all live Mullvad and Docker prerequisites.',
        ]),
      );
      expect(compatibilitySummaryText).toContain('M004 compatibility verdict: FAIL');
      expect(compatibilitySummaryText).toContain('hostname-selected routing failure:');
      expect(compatibilitySummaryText).toContain('protocol matrix:');
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
