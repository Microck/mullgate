#!/usr/bin/env tsx

import { access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

type RepoBaselineOptions = {
  readonly checkOnly: boolean;
};

type CommandResult = {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (!options) {
      return;
    }

    await assertPathExists('.github/workflows/ci.yml');
    await assertPathExists('.env.example');

    const results = [
      await runShellCommand('pnpm build'),
      await runShellCommand('pnpm typecheck'),
      await runShellCommand('pnpm test -- --run test/cli/help-command.test.ts test/cli/verify-s06-release-help.test.ts test/cli/verify-m002-final-help.test.ts'),
    ];

    for (const result of results) {
      if (result.exitCode !== 0) {
        throw new Error([
          `Repo baseline check failed: ${result.command}`,
          `exit code: ${result.exitCode}`,
          `stdout:\n${result.stdout || '<empty>'}`,
          `stderr:\n${result.stderr || '<empty>'}`,
        ].join('\n'));
      }
    }

    process.stdout.write([
      'M003 repo baseline verification passed.',
      '- required public-repo surfaces present: .github/workflows/ci.yml, .env.example',
      '- build: ok',
      '- typecheck: ok',
      '- help contracts: ok',
      ...(options.checkOnly ? ['- mode: check-only'] : []),
    ].join('\n') + '\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv: readonly string[]): RepoBaselineOptions | null {
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
    'Usage: pnpm exec tsx scripts/verify-m003-repo-baseline.ts [options]',
    '',
    'Run the M003 S01 public-repo baseline verifier: confirm the repo contains the',
    'new CI and example-env surfaces, then run the trusted build, typecheck, and',
    'CLI/help-contract checks that define the current release-quality floor.',
    '',
    'Options:',
    '  --check-only  Still runs the baseline verification commands, but tags the output as a repo-baseline audit mode.',
    '  -h, --help    Show this help text.',
    '',
    'Inspection workflow:',
    '  Start with the command output. On failure, the verifier prints the exact',
    '  failing command plus captured stdout/stderr so future agents can localize',
    '  whether the break is in build output, typecheck, or help-contract drift.',
    '',
  ].join('\n');
}

async function assertPathExists(relativePath: string): Promise<void> {
  await access(path.join(repoRoot, relativePath));
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

main();
