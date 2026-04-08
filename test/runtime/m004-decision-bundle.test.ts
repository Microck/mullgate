import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CompatibilitySummaryBundle } from '../../src/m004/compatibility-runner.js';
import { renderCompatibilityHelp } from '../../src/m004/compatibility-runner.js';
import type { MilestoneDecisionBundle } from '../../src/m004/milestone-contract.js';
import {
  parseMilestoneArgs,
  renderCompatibilityPassThroughHelp,
  renderMilestoneFailureHelp,
  renderMilestoneHelp,
  runMilestoneVerifier,
} from '../../src/m004/milestone-runner.js';

const fixturesDir = path.join(process.cwd(), 'test/fixtures', 'm004');

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

describe('m004 milestone runner', () => {
  it('parses milestone args from flags and surfaces the bundled help on failures', () => {
    expect(
      parseMilestoneArgs(
        [
          '--target-url',
          'https://example.com/exit.json',
          '--route-check-ip',
          '9.9.9.9',
          '--logical-exit-count',
          '2',
          '--output-root',
          '.tmp/custom-m004',
          '--fixture',
          './compatibility.json',
          '--keep-temp-home',
        ],
        {
          MULLGATE_ACCOUNT_NUMBER: ' 123456 ',
          MULLGATE_PROXY_USERNAME: ' alice ',
          MULLGATE_PROXY_PASSWORD: ' secret ',
          MULLGATE_DEVICE_NAME: ' mullgate-m004 ',
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
        outputRoot: '.tmp/custom-m004',
        keepTempHome: true,
        fixturePath: './compatibility.json',
        accountNumber: '123456',
        proxyUsername: 'alice',
        proxyPassword: 'secret',
        deviceName: 'mullgate-m004',
        mullvadWgUrl: 'https://wg.example.test',
        mullvadRelaysUrl: 'https://relays.example.test',
        wireproxyImage: 'custom/wireproxy:latest',
      },
    });

    expect(parseMilestoneArgs(['--help'])).toEqual({
      ok: false,
      helpText: renderMilestoneHelp(),
      exitCode: 0,
    });

    expect(parseMilestoneArgs(['--logical-exit-count', '4'])).toEqual({
      ok: false,
      helpText: renderMilestoneHelp(),
      exitCode: 1,
      error: 'Invalid --logical-exit-count value: 4. Expected 2 or 3.',
    });

    expect(parseMilestoneArgs(['--target-url'])).toEqual({
      ok: false,
      helpText: renderMilestoneHelp(),
      exitCode: 1,
      error: 'Missing value for --target-url.',
    });
  });

  it('renders milestone failure guidance and compatibility pass-through help', () => {
    const missingEnv = renderMilestoneFailureHelp(
      new Error('Missing required environment variables for the compatibility verifier.'),
      {},
    );

    expect(missingEnv).toContain(
      'Missing required environment variables for the live compatibility verifier:',
    );
    expect(missingEnv).toContain('MULLGATE_ACCOUNT_NUMBER');
    expect(missingEnv).toContain('Usage: pnpm exec tsx scripts/verify-m004.ts [options]');
    expect(renderMilestoneFailureHelp(new Error('boom'))).toContain('boom');
    expect(renderMilestoneFailureHelp('plain failure')).toContain('plain failure');
    expect(renderCompatibilityPassThroughHelp()).toBe(renderCompatibilityHelp());
    expect(renderMilestoneHelp()).toContain(
      'Run the final M004 milestone verifier: reuse the S02 compatibility verifier as',
    );
  });

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
