import { spawn } from 'node:child_process';
import path from 'node:path';

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
    const child = spawn(
      process.execPath,
      [tsxCliPath, 'scripts/verify-m004-feasibility.ts', ...args],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: 'pipe',
      },
    );

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

describe('verify-m004-feasibility help contract', () => {
  it('documents the one-device feasibility verifier inputs and fixture mode', async () => {
    const result = await runScript(['--help']);

    expect({
      status: result.status,
      stderr: result.stderr,
    }).toEqual({
      status: 0,
      stderr: '',
    });

    expect(`\n${result.stdout.trimEnd()}`).toMatchInlineSnapshot(`
      "
      Usage: pnpm exec tsx scripts/verify-m004-feasibility.ts [options]

      Run the isolated M004 feasibility verifier: provision exactly one Mullvad
      WireGuard device into a temp workspace, start one shared entry wireproxy
      runtime without touching \`mullgate proxy start\`, chain 2-3 concurrent probes
      through distinct Mullvad SOCKS5 relays, compare host-route snapshots, and
      write a secret-safe PASS/FAIL artifact bundle under the chosen output root.

      Required environment variables for live runs:
        MULLGATE_ACCOUNT_NUMBER       Live Mullvad account number used to provision one device.
        MULLGATE_PROXY_USERNAME       Username for the local shared-entry SOCKS listener.
        MULLGATE_PROXY_PASSWORD       Password for the local shared-entry SOCKS listener.
        MULLGATE_DEVICE_NAME          Deterministic Mullvad device label for the one-device experiment.

      Optional environment variables:
        MULLGATE_VERIFY_TARGET_URL   Exit-check endpoint (default: https://am.i.mullvad.net/json)
        MULLGATE_VERIFY_ROUTE_CHECK_IP Direct-route check IP (default: 1.1.1.1)
        MULLGATE_MULLVAD_WG_URL      Override Mullvad WireGuard provisioning endpoint.
        MULLGATE_MULLVAD_RELAYS_URL  Override the legacy Mullvad relay endpoint with SOCKS metadata (default: https://api.mullvad.net/www/relays/all/)
        MULLGATE_M004_LOGICAL_EXIT_COUNT Requested logical exit count (2 or 3, default: 3).
        MULLGATE_M004_WIREPROXY_IMAGE Override the Docker image used for the shared entry runtime.

      Fixture mode:
        Pass --fixture <path> to skip all live Mullvad/Docker work and re-render a
        deterministic summary bundle from a checked-in feasibility artifact fixture.

      Options:
        --target-url <url>           Exit-check endpoint to query (default: https://am.i.mullvad.net/json)
        --route-check-ip <ip>        Direct-route IP used for host-route drift checks (default: 1.1.1.1)
        --logical-exit-count <2|3>    Requested logical exit count for the experiment (default: 3).
        --output-root <path>         Directory that receives the latest summary bundle (default: .tmp/m004-feasibility)
        --fixture <path>              Replay a checked-in feasibility artifact fixture instead of running live provisioning.
        --keep-temp-home              Preserve the temp verifier workspace even on success.
        -h, --help                    Show this help text.

      When the live experiment fails or returns a FAIL verdict, the verifier keeps a
      redacted temp workspace so future agents can inspect recorded commands, route
      snapshots, the generated wireproxy config, and probe artifacts without leaking
      raw Mullvad credentials or private keys."
    `);
  });
});
