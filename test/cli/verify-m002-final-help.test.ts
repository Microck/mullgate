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
    const child = spawn(process.execPath, [tsxCliPath, 'scripts/verify-m002-final.ts', ...args], {
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

describe('verify-m002-final help contract', () => {
  it('documents the composed verifier workflow and inspection surfaces', async () => {
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
      Usage: pnpm exec tsx scripts/verify-m002-final.ts [options]

      Run the final M002 milestone verifier: compose the shipped S01 network-mode
      verifier and S02 platform-surface verifier, capture their outputs into one
      stable proof bundle, and restate the assembled Mullgate operator posture in a
      single summary without introducing a second assertion path.

      Options:
        --output-root <path>  Directory that receives the final proof bundle (default: .tmp/m002-final)
        -h, --help            Show this help text.

      Inspection workflow:
        Start with latest/summary.txt for the operator-readable M002 verdict, then
        inspect latest/summary.json for the machine-readable bundle. If a composed
        verifier fails, continue with latest/network-modes.stdout.txt,
        latest/network-modes.stderr.txt, latest/platform-surfaces.stdout.txt,
        latest/platform-surfaces.stderr.txt, and any preserved temp-home paths
        listed in the summary.

      This command reuses the existing M002 verifier scripts as the authoritative
      proof paths. It does not clone their assertions or introduce a separate
      network/platform contract implementation."
    `);
  });
});
