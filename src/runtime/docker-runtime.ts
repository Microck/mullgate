import { spawn } from 'node:child_process';
import path from 'node:path';

export type ProcessExecution = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: NodeJS.ErrnoException;
};

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<ProcessExecution> | ProcessExecution;

export type DockerCommandMetadata = {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly rendered: string;
};

export type DockerRuntimeSuccess = {
  ok: true;
  phase: 'compose-launch';
  source: 'docker-compose';
  checkedAt: string;
  composeFilePath: string;
  command: DockerCommandMetadata;
  message: string;
  stdout: string;
  stderr: string;
};

export type DockerRuntimeFailure = {
  ok: false;
  phase: 'compose-detect' | 'compose-launch';
  source: 'docker-binary' | 'docker-compose';
  checkedAt: string;
  code: 'DOCKER_COMPOSE_MISSING' | 'COMPOSE_UP_FAILED';
  composeFilePath: string;
  command: DockerCommandMetadata;
  message: string;
  cause?: string;
  artifactPath?: string;
  exitCode?: number | null;
};

export type DockerRuntimeResult = DockerRuntimeSuccess | DockerRuntimeFailure;

export type StartDockerRuntimeOptions = {
  readonly composeFilePath: string;
  readonly checkedAt?: string;
  readonly cwd?: string;
  readonly dockerBinary?: string;
  readonly runner?: ProcessRunner;
};

const DEFAULT_DOCKER_BINARY = 'docker';

export async function startDockerRuntime(options: StartDockerRuntimeOptions): Promise<DockerRuntimeResult> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const dockerBinary = options.dockerBinary ?? DEFAULT_DOCKER_BINARY;
  const cwd = options.cwd ?? path.dirname(options.composeFilePath);
  const runner = options.runner ?? defaultProcessRunner;

  const detectCommand = buildCommand(dockerBinary, ['compose', 'version'], cwd);
  const detectResult = await runner(detectCommand.binary, detectCommand.args, { cwd: detectCommand.cwd });

  if (detectResult.error?.code === 'ENOENT') {
    return {
      ok: false,
      phase: 'compose-detect',
      source: 'docker-binary',
      checkedAt,
      code: 'DOCKER_COMPOSE_MISSING',
      composeFilePath: options.composeFilePath,
      command: detectCommand,
      message: 'Docker CLI is not installed or is not on PATH, so Mullgate cannot launch the runtime bundle.',
      cause: detectResult.error.message,
      artifactPath: options.composeFilePath,
    };
  }

  if ((detectResult.exitCode ?? 1) !== 0) {
    return {
      ok: false,
      phase: 'compose-detect',
      source: 'docker-compose',
      checkedAt,
      code: 'DOCKER_COMPOSE_MISSING',
      composeFilePath: options.composeFilePath,
      command: detectCommand,
      message: 'Docker is installed but `docker compose` is unavailable, so Mullgate cannot launch the runtime bundle.',
      cause: summarizeProcessFailure(detectResult, 'docker compose version failed.'),
      artifactPath: options.composeFilePath,
      exitCode: detectResult.exitCode,
    };
  }

  const launchCommand = buildCommand(dockerBinary, ['compose', '--file', options.composeFilePath, 'up', '--detach'], cwd);
  const launchResult = await runner(launchCommand.binary, launchCommand.args, { cwd: launchCommand.cwd });

  if (launchResult.error?.code === 'ENOENT') {
    return {
      ok: false,
      phase: 'compose-launch',
      source: 'docker-binary',
      checkedAt,
      code: 'DOCKER_COMPOSE_MISSING',
      composeFilePath: options.composeFilePath,
      command: launchCommand,
      message: 'Docker disappeared before Mullgate could launch the runtime bundle.',
      cause: launchResult.error.message,
      artifactPath: options.composeFilePath,
    };
  }

  if ((launchResult.exitCode ?? 1) !== 0) {
    return {
      ok: false,
      phase: 'compose-launch',
      source: 'docker-compose',
      checkedAt,
      code: 'COMPOSE_UP_FAILED',
      composeFilePath: options.composeFilePath,
      command: launchCommand,
      message: 'Docker Compose failed to start the Mullgate runtime bundle.',
      cause: summarizeProcessFailure(launchResult, 'docker compose up --detach failed.'),
      artifactPath: options.composeFilePath,
      exitCode: launchResult.exitCode,
    };
  }

  return {
    ok: true,
    phase: 'compose-launch',
    source: 'docker-compose',
    checkedAt,
    composeFilePath: options.composeFilePath,
    command: launchCommand,
    message: 'Docker Compose launched the Mullgate runtime bundle in detached mode.',
    stdout: launchResult.stdout,
    stderr: launchResult.stderr,
  };
}

function buildCommand(binary: string, args: readonly string[], cwd: string): DockerCommandMetadata {
  return {
    binary,
    args: [...args],
    cwd,
    rendered: [binary, ...args].join(' '),
  };
}

function summarizeProcessFailure(result: ProcessExecution, fallback: string): string {
  const combined = [result.stderr, result.stdout]
    .filter((value) => value.trim().length > 0)
    .join('\n')
    .trim();

  return combined || fallback;
}

async function defaultProcessRunner(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
): Promise<ProcessExecution> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'pipe',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error,
      });
    });

    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}
