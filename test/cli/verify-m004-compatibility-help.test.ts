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
    const child = spawn(process.execPath, [tsxCliPath, 'scripts/verify-m004-compatibility.ts', ...args], {
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

describe('verify-m004-compatibility help contract', () => {
  it('documents the one-device compatibility verifier inputs, fixture mode, and artifact inspection guidance', async () => {
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
      Usage: pnpm exec tsx scripts/verify-m004-compatibility.ts [options]

      Run the isolated M004 compatibility verifier: reuse the S01 single-entry
      shared-entry topology, prove what SOCKS5 can still do only with client-side
      chaining, document why hostname-selected routing is no longer truthful, mark
      HTTP/HTTPS compatibility limits explicitly, and write a secret-safe
      compatibility bundle under the chosen output root.

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
        MULLGATE_M004_COMPATIBILITY_OUTPUT_ROOT Override the compatibility output root.

      Fixture mode:
        Pass --fixture <path> to skip all live Mullvad/Docker work and replay a
        deterministic compatibility-evidence input file into the summary bundle.

      Options:
        --target-url <url>            Exit-check endpoint to query (default: https://am.i.mullvad.net/json)
        --route-check-ip <ip>         Direct-route IP used for host-route drift checks (default: 1.1.1.1)
        --logical-exit-count <2|3>     Requested logical exit count for the reused shared-entry experiment (default: 3).
        --output-root <path>          Directory that receives the latest compatibility bundle (default: .tmp/m004-compatibility)
        --fixture <path>               Replay a checked-in compatibility fixture instead of running live provisioning.
        --keep-temp-home               Preserve the temp verifier workspace even on success.
        -h, --help                     Show this help text.

      This verifier expects exactly one Mullvad device for the shared-entry runtime.
      It never falls back to a redesigned multi-device path. When the topology,
      hostname truthfulness, or a probe phase fails, inspect latest/summary.json,
      latest/summary.txt, latest/protocol-evidence.json, latest/hostname-routing.json,
      and the preserved temp workspace paths named in the output bundle."
    `);
  });
});
