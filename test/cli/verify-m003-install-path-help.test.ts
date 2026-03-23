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
    const child = spawn(process.execPath, [tsxCliPath, 'scripts/verify-m003-install-path.ts', ...args], {
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

describe('verify-m003-install-path help contract', () => {
  it('documents the tarball install-path workflow and failure localization guidance', async () => {
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
      Usage: pnpm exec tsx scripts/verify-m003-install-path.ts [options]

      Run the M003 S02 install-path verifier: build Mullgate, pack the GitHub release
      tarball artifact, reject junk package contents, install that tarball into a temp
      global prefix, and prove the installed \`mullgate\` binary exposes the expected
      help surface.

      Options:
        --check-only  Still runs the full install-path verification flow, but tags the output as audit mode.
        -h, --help    Show this help text.

      Inspection workflow:
        Start with the command output. On failure, the verifier names the failing
        build/pack/install/help step so future agents can tell whether the drift is
        in package contents, tarball installation, or installed CLI behavior."
    `);
  });
});
