import { spawn } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

type CliResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

async function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, 'src/cli.ts', ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'pipe',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
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

describe('mullgate misc command contract', () => {
  it('prints structured version details', { timeout: 15000 }, async () => {
    const result = await runCli(['version']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const normalized = result.stdout
      .trimEnd()
      .replace(/hostname: .+/u, 'hostname: HOSTNAME_REPLACED');
    expect(`\n${normalized}`).toMatchInlineSnapshot(`
      "
      Mullgate version
      cli version: 1.3.0
      config schema: 2
      node: ${process.version}
      platform: ${process.platform}
      arch: ${process.arch}
      hostname: HOSTNAME_REPLACED"
    `);
  });

  it('prints bash completions', { timeout: 15000 }, async () => {
    const result = await runCli(['completions', 'bash']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('_mullgate_complete()');
    expect(result.stdout).toContain('complete -F _mullgate_complete mullgate');
    expect(result.stdout).toContain(
      'proxy_subcommands="start stop restart status logs doctor validate list export autostart access relay"',
    );
    expect(result.stdout).toContain(
      'config_subcommands="path show get set validate regions hosts"',
    );
  });
});
