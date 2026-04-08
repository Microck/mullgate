import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const temporaryDirectories: string[] = [];

type CliResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required ${name} for Mullgate E2E.`);
  }

  return value;
}

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, 'src/cli.ts', ...args], {
      cwd: repoRoot,
      env,
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

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.env.MULLGATE_E2E !== '1')('mullgate e2e runtime flow', () => {
  it(
    'runs setup, start, status, doctor, and stop against a real Docker-backed environment',
    { timeout: 180000 },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'mullgate-e2e-'));
      const home = root.replaceAll('\\', '/');
      temporaryDirectories.push(root);

      const env = {
        ...process.env,
        MULLGATE_PLATFORM: 'linux',
        HOME: home,
        XDG_CONFIG_HOME: `${home}/config`,
        XDG_STATE_HOME: `${home}/state`,
        XDG_CACHE_HOME: `${home}/cache`,
      };

      const setupResult = await runCli(
        [
          'setup',
          '--non-interactive',
          '--account-number',
          requiredEnv('MULLGATE_E2E_ACCOUNT_NUMBER'),
          '--username',
          requiredEnv('MULLGATE_E2E_PROXY_USERNAME'),
          '--password',
          requiredEnv('MULLGATE_E2E_PROXY_PASSWORD'),
          '--location',
          requiredEnv('MULLGATE_E2E_LOCATION'),
        ],
        env,
      );

      expect(setupResult.status).toBe(0);

      const startResult = await runCli(['proxy', 'start'], env);
      expect(startResult.status).toBe(0);

      const statusResult = await runCli(['proxy', 'status'], env);
      expect(statusResult.status).toBe(0);
      expect(statusResult.stdout).toContain('runtime status: running');

      const doctorResult = await runCli(['proxy', 'doctor'], env);
      expect(doctorResult.status).toBe(0);

      const stopResult = await runCli(['proxy', 'stop'], env);
      expect(stopResult.status).toBe(0);
    },
  );
});
