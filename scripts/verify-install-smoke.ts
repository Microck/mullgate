#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { requireDefined } from '../src/required.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

type CommandResult = {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mullgate-install-smoke-'));

  try {
    const packDir = path.join(tempRoot, 'pack');
    const installDir = path.join(tempRoot, 'install-root');

    assertSuccess(await runShellCommand({ command: 'pnpm build' }));
    assertSuccess(
      await runShellCommand({ command: `pnpm pack --pack-destination ${shellEscape(packDir)}` }),
    );

    const packFiles = await readdir(packDir);
    if (packFiles.length !== 1) {
      throw new Error(
        `Expected exactly one packed tarball in ${packDir}, found ${packFiles.length}.`,
      );
    }

    const tarballPath = path.join(
      packDir,
      requireDefined(packFiles[0], `Expected exactly one packed tarball in ${packDir}.`),
    );
    assertSuccess(
      await runShellCommand({
        command: `npm install --prefix ${shellEscape(installDir)} ${shellEscape(tarballPath)}`,
      }),
    );

    const installedCliPath = path.join(
      installDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'mullgate.cmd' : 'mullgate',
    );

    const helpResult = await runShellCommand({
      command: `${shellEscape(installedCliPath)} --help`,
    });
    assertSuccess(helpResult);
    assertContains({
      text: helpResult.stdout,
      expected: 'Usage: mullgate [options] [command]',
      message: 'Installed CLI help output drifted away from the expected top-level usage contract.',
    });

    const pathResult = await runShellCommand({
      command: `${shellEscape(installedCliPath)} path`,
    });
    assertSuccess(pathResult);
    assertContains({
      text: pathResult.stdout,
      expected: 'Mullgate path report',
      message:
        'Installed CLI path output drifted away from the expected top-level report contract.',
    });

    process.stdout.write(
      `${[
        'Install smoke verification passed.',
        `- platform: ${process.platform}`,
        `- tarball: ${tarballPath}`,
        `- installed cli: ${installedCliPath}`,
        '- installed mullgate help: ok',
        '- installed mullgate path: ok',
      ].join('\n')}\n`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function assertContains(input: { text: string; expected: string; message: string }): void {
  if (input.text.includes(input.expected)) {
    return;
  }

  throw new Error(
    [
      input.message,
      `expected substring: ${input.expected}`,
      `output:\n${input.text || '<empty>'}`,
    ].join('\n'),
  );
}

function assertSuccess(result: CommandResult): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    [
      `Install smoke failed: ${result.command}`,
      `exit code: ${result.exitCode}`,
      `stdout:\n${result.stdout || '<empty>'}`,
      `stderr:\n${result.stderr || '<empty>'}`,
    ].join('\n'),
  );
}

async function runShellCommand(input: { command: string }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: repoRoot,
      env: process.env,
      shell: true,
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
        command: input.command,
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function shellEscape(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
