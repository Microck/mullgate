#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { requireDefined } from '../src/required.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const _tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

type InstallPathOptions = {
  readonly checkOnly: boolean;
};

type CommandResult = {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'mullgate-m003-install-'));

  try {
    const options = parseArgs(process.argv.slice(2));

    if (!options) {
      return;
    }

    const packDir = path.join(tempRoot, 'pack');
    const prefixDir = path.join(tempRoot, 'prefix');

    const buildResult = await runShellCommand('pnpm build');
    assertSuccess(buildResult);

    const packResult = await runShellCommand(
      `pnpm pack --pack-destination ${shellEscape(packDir)}`,
    );
    assertSuccess(packResult);

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
    const tarListResult = await runShellCommand(`tar -tzf ${shellEscape(tarballPath)}`);
    assertSuccess(tarListResult);
    assertCleanTarball(tarListResult.stdout);

    const installResult = await runShellCommand(
      `npm install -g --prefix ${shellEscape(prefixDir)} ${shellEscape(tarballPath)}`,
    );
    assertSuccess(installResult);

    const installedCliPath = path.join(prefixDir, 'bin', 'mullgate');
    const helpResult = await runShellCommand(`${shellEscape(installedCliPath)} --help`);
    assertSuccess(helpResult);

    if (!helpResult.stdout.includes('Usage: mullgate [options] [command]')) {
      throw new Error(
        'Installed CLI help output drifted away from the expected top-level usage contract.',
      );
    }

    process.stdout.write(
      `${[
        'M003 install-path verification passed.',
        `- tarball: ${tarballPath}`,
        `- installed cli: ${installedCliPath}`,
        '- package contents: clean',
        '- installed mullgate help: ok',
        ...(options.checkOnly ? ['- mode: check-only'] : []),
      ].join('\n')}\n`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv: readonly string[]): InstallPathOptions | null {
  const normalizedArgs = argv[0] === '--' ? argv.slice(1) : argv;
  let checkOnly = false;

  for (const argument of normalizedArgs) {
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(renderHelp());
      return null;
    }

    if (argument === '--check-only') {
      checkOnly = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { checkOnly };
}

function renderHelp(): string {
  return [
    'Usage: pnpm exec tsx scripts/verify-m003-install-path.ts [options]',
    '',
    'Run the M003 S02 install-path verifier: build Mullgate, pack the GitHub release',
    'tarball artifact, reject junk package contents, install that tarball into a temp',
    'global prefix, and prove the installed `mullgate` binary exposes the expected',
    'help surface.',
    '',
    'Options:',
    '  --check-only  Still runs the full install-path verification flow, but tags the output as audit mode.',
    '  -h, --help    Show this help text.',
    '',
    'Inspection workflow:',
    '  Start with the command output. On failure, the verifier names the failing',
    '  build/pack/install/help step so future agents can tell whether the drift is',
    '  in package contents, tarball installation, or installed CLI behavior.',
    '',
  ].join('\n');
}

function assertCleanTarball(stdout: string): void {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  const forbiddenPrefixes = [
    'package/.tmp/',
    'package/test/',
    'package/src/',
    'package/docs/',
    'package/.env',
    'package/.gsd/',
    'package/node_modules/',
  ];

  const offending = lines.filter((line) =>
    forbiddenPrefixes.some((prefix) => line.startsWith(prefix)),
  );

  if (offending.length > 0) {
    throw new Error(
      [
        'Packed tarball contains files that do not belong in the supported distribution artifact.',
        ...offending.slice(0, 20).map((line) => `- ${line}`),
      ].join('\n'),
    );
  }

  if (!lines.includes('package/dist/cli.js')) {
    throw new Error('Packed tarball is missing package/dist/cli.js.');
  }
}

function assertSuccess(result: CommandResult): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    [
      `Install-path check failed: ${result.command}`,
      `exit code: ${result.exitCode}`,
      `stdout:\n${result.stdout || '<empty>'}`,
      `stderr:\n${result.stderr || '<empty>'}`,
    ].join('\n'),
  );
}

async function runShellCommand(command: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
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
        command,
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
