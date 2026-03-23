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
    const child = spawn(process.execPath, [tsxCliPath, 'scripts/verify-s06-release.ts', ...args], {
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

describe('verify-s06-release help contract', () => {
  it('documents the integrated release verifier inputs and flags', async () => {
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
      Usage: pnpm exec tsx scripts/verify-s06-release.ts [options]

      Run the integrated Linux-first Mullgate proof in a temp XDG home: perform
      non-interactive setup, print/check \`config hosts\`, start the Docker runtime,
      verify \`status\` + \`doctor\`, prove SOCKS5/HTTP/HTTPS traffic, confirm the host
      route to a direct-check IP did not change, and compare the exits for two routed
      hostnames when they resolve locally to distinct bind IPs.

      Required environment variables:
        MULLGATE_ACCOUNT_NUMBER       Live Mullvad account number used by setup.
        MULLGATE_PROXY_USERNAME       Proxy username required on published listeners.
        MULLGATE_PROXY_PASSWORD       Proxy password required on published listeners.
        MULLGATE_DEVICE_NAME          Deterministic Mullvad device label for the proof.

      Optional setup environment variables:
        MULLGATE_LOCATIONS            Comma-separated route list (default: sweden-gothenburg,austria-vienna)
        MULLGATE_LOCATION             Single-route shorthand; ignored when MULLGATE_LOCATIONS is set.
        MULLGATE_ROUTE_BIND_IPS       Ordered bind IPs passed through to setup.
        MULLGATE_EXPOSURE_MODE        loopback, private-network, or public.
        MULLGATE_EXPOSURE_BASE_DOMAIN Base domain for derived route hostnames.
        MULLGATE_HTTPS_PORT          HTTPS proxy port (default: 8443 when verifier generates TLS assets)
        MULLGATE_HTTPS_CERT_PATH      Existing cert path; skips ephemeral generation when paired with key.
        MULLGATE_HTTPS_KEY_PATH       Existing key path; skips ephemeral generation when paired with cert.
        MULLGATE_MULLVAD_WG_URL       Override Mullvad provisioning endpoint for setup.
        MULLGATE_MULLVAD_RELAYS_URL   Override Mullvad relay metadata endpoint for setup.

      Optional verifier environment variables:
        MULLGATE_VERIFY_TARGET_URL        Exit-check endpoint (default: https://am.i.mullvad.net/json)
        MULLGATE_VERIFY_ROUTE_CHECK_IP    Direct-route check IP (default: 1.1.1.1)

      If HTTPS cert/key paths are not provided, the verifier requires \`openssl\` so it can
      generate a temporary self-signed pair without persisting raw private-key material in
      the saved failure bundle.
      The verifier also needs one free Mullvad WireGuard device slot per routed location unless
      you resume from a previously preserved temp home with --reuse-temp-home.

      Options:
        --target-url <url>        Exit-check endpoint to query (default: https://am.i.mullvad.net/json)
        --route-check-ip <ip>     Direct-route IP used for host-route drift checks (default: 1.1.1.1)
        --keep-temp-home           Preserve the temp XDG home even on success.
        --reuse-temp-home <path>   Resume verification from an earlier preserved temp home instead of provisioning new devices.
        -h, --help                 Show this help text."
    `);
  });
});
