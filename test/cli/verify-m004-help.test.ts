import path from 'node:path';
import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

type ScriptResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

async function runScript(args: readonly string[]): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, 'scripts/verify-m004.ts', ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'pipe',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        status: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

describe('verify-m004 help contract', () => {
  it('documents the final decision bundle workflow and inspection surfaces', async () => {
    const result = await runScript(['--help']);

    expect({
      status: result.status,
      stderr: result.stderr,
    }).toEqual({
      status: 0,
      stderr: '',
    });

    expect('\n' + result.stdout.trimEnd()).toMatchInlineSnapshot(`
      "
      Usage: pnpm exec tsx scripts/verify-m004.ts [options]

      Run the final M004 milestone verifier: reuse the S02 compatibility verifier as
      the only live execution path, then aggregate its secret-safe outputs into one
      milestone decision bundle that says whether Mullgate should pursue, stop, or
      only pursue the shared-entry redesign with explicit contract changes.

      Required environment variables for live runs:
        MULLGATE_ACCOUNT_NUMBER       Live Mullvad account number used to provision one device.
        MULLGATE_PROXY_USERNAME       Username for the local shared-entry SOCKS listener.
        MULLGATE_PROXY_PASSWORD       Password for the local shared-entry SOCKS listener.
        MULLGATE_DEVICE_NAME          Deterministic Mullvad device label for the one-device experiment.

      Optional environment variables:
        MULLGATE_VERIFY_TARGET_URL   Exit-check endpoint (default: https://am.i.mullvad.net/json)
        MULLGATE_VERIFY_ROUTE_CHECK_IP Direct-route check IP (default: 1.1.1.1)
        MULLGATE_MULLVAD_WG_URL      Override Mullvad WireGuard provisioning endpoint.
        MULLGATE_MULLVAD_RELAYS_URL  Override the legacy Mullvad relay endpoint with SOCKS metadata.
        MULLGATE_M004_LOGICAL_EXIT_COUNT Requested logical exit count (2 or 3, default: 3).
        MULLGATE_M004_WIREPROXY_IMAGE Override the Docker image used for the shared entry runtime.
        MULLGATE_M004_OUTPUT_ROOT    Override the milestone output root.

      Fixture mode:
        Pass --fixture <path> to skip all live Mullvad/Docker work and replay a
        deterministic compatibility fixture into the final milestone decision bundle.

      Options:
        --target-url <url>            Exit-check endpoint to query (default: https://am.i.mullvad.net/json)
        --route-check-ip <ip>         Direct-route IP used for host-route drift checks (default: 1.1.1.1)
        --logical-exit-count <2|3>     Requested logical exit count for the reused shared-entry experiment (default: 3).
        --output-root <path>          Directory that receives the final milestone bundle (default: .tmp/m004)
        --fixture <path>               Replay a checked-in compatibility fixture instead of running live provisioning.
        --keep-temp-home               Preserve the temp verifier workspace even on success.
        -h, --help                     Show this help text.

      Inspection workflow:
        Start with latest/decision.txt for the operator-readable PASS / FAIL /
        contract-change-required answer, then inspect latest/decision.json for the
        machine-readable bundle. If the milestone blocks, continue with
        latest/compatibility-summary.txt, latest/compatibility-summary.json,
        latest/protocol-evidence.json, latest/hostname-routing.json, and any
        preserved workspace path named in the decision diagnostics.

      This command never creates a second live orchestration path. It simply reuses
      the compatibility verifier, preserves its diagnostics and artifact links, and
      re-emits the final milestone decision in a stable .tmp/m004/latest layout."
    `);
  });
});
