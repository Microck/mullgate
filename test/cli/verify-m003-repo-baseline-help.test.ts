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
    const child = spawn(process.execPath, [tsxCliPath, 'scripts/verify-m003-repo-baseline.ts', ...args], {
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

describe('verify-m003-repo-baseline help contract', () => {
  it('documents the repo-baseline workflow and failure inspection guidance', async () => {
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
      Usage: pnpm exec tsx scripts/verify-m003-repo-baseline.ts [options]

      Run the M003 S01 public-repo baseline verifier: confirm the repo contains the
      new CI and example-env surfaces, then run the trusted build, typecheck, and
      CLI/help-contract checks that define the current release-quality floor.

      Options:
        --check-only  Still runs the baseline verification commands, but tags the output as a repo-baseline audit mode.
        -h, --help    Show this help text.

      Inspection workflow:
        Start with the command output. On failure, the verifier prints the exact
        failing command plus captured stdout/stderr so future agents can localize
        whether the break is in build output, typecheck, or help-contract drift."
    `);
  });
});
