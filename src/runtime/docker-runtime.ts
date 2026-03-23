import { spawn } from 'node:child_process';
import path from 'node:path';

import { z } from 'zod';

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

type DockerComposeDetectFailure = {
  ok: false;
  phase: 'compose-detect';
  source: 'docker-binary' | 'docker-compose';
  checkedAt: string;
  code: 'DOCKER_COMPOSE_MISSING';
  composeFilePath: string;
  command: DockerCommandMetadata;
  message: string;
  cause?: string;
  artifactPath?: string;
  exitCode?: number | null;
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

export type DockerComposePublisher = {
  readonly url: string | null;
  readonly targetPort: number | null;
  readonly publishedPort: number | null;
  readonly protocol: string | null;
};

export type DockerComposeContainer = {
  readonly name: string;
  readonly service: string;
  readonly project: string | null;
  readonly state: string;
  readonly health: string | null;
  readonly status: string | null;
  readonly exitCode: number | null;
  readonly publishers: readonly DockerComposePublisher[];
};

export type DockerComposeStatusSuccess = {
  ok: true;
  phase: 'compose-ps';
  source: 'docker-compose';
  checkedAt: string;
  composeFilePath: string;
  command: DockerCommandMetadata;
  message: string;
  containers: readonly DockerComposeContainer[];
  project: string | null;
  summary: {
    readonly total: number;
    readonly running: number;
    readonly healthy: number;
    readonly starting: number;
    readonly stopped: number;
    readonly unhealthy: number;
  };
};

export type DockerComposeStatusFailure = {
  ok: false;
  phase: 'compose-detect' | 'compose-ps';
  source: 'docker-binary' | 'docker-compose' | 'compose-json';
  checkedAt: string;
  code: 'DOCKER_COMPOSE_MISSING' | 'COMPOSE_PS_FAILED' | 'COMPOSE_PS_INVALID_JSON';
  composeFilePath: string;
  command: DockerCommandMetadata;
  message: string;
  cause?: string;
  artifactPath?: string;
  exitCode?: number | null;
};

export type DockerComposeStatusResult = DockerComposeStatusSuccess | DockerComposeStatusFailure;

export type StartDockerRuntimeOptions = {
  readonly composeFilePath: string;
  readonly checkedAt?: string;
  readonly cwd?: string;
  readonly dockerBinary?: string;
  readonly runner?: ProcessRunner;
};

export type QueryDockerComposeStatusOptions = {
  readonly composeFilePath: string;
  readonly checkedAt?: string;
  readonly cwd?: string;
  readonly dockerBinary?: string;
  readonly runner?: ProcessRunner;
};

const DEFAULT_DOCKER_BINARY = 'docker';

const composePsPublisherSchema = z
  .object({
    URL: z.string().nullable().optional(),
    TargetPort: z.union([z.number(), z.string()]).nullable().optional(),
    PublishedPort: z.union([z.number(), z.string()]).nullable().optional(),
    Protocol: z.string().nullable().optional(),
  })
  .passthrough();

const composePsContainerSchema = z
  .object({
    Name: z.string(),
    Service: z.string().optional(),
    Project: z.string().nullable().optional(),
    State: z.string().optional(),
    Health: z.string().nullable().optional(),
    Status: z.string().nullable().optional(),
    ExitCode: z.union([z.number(), z.string()]).nullable().optional(),
    Publishers: z.array(composePsPublisherSchema).optional(),
  })
  .passthrough();

export async function startDockerRuntime(
  options: StartDockerRuntimeOptions,
): Promise<DockerRuntimeResult> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const dockerBinary = options.dockerBinary ?? DEFAULT_DOCKER_BINARY;
  const cwd = options.cwd ?? path.dirname(options.composeFilePath);
  const runner = options.runner ?? defaultProcessRunner;

  const detectFailure = await detectDockerCompose({
    composeFilePath: options.composeFilePath,
    checkedAt,
    dockerBinary,
    cwd,
    runner,
    missingBinaryMessage:
      'Docker CLI is not installed or is not on PATH, so Mullgate cannot launch the runtime bundle.',
    detectFailureMessage:
      'Docker is installed but `docker compose` is unavailable, so Mullgate cannot launch the runtime bundle.',
  });

  if (detectFailure) {
    return detectFailure;
  }

  const launchCommand = buildCommand(
    dockerBinary,
    ['compose', '--file', options.composeFilePath, 'up', '--detach'],
    cwd,
  );
  const launchResult = await runner(launchCommand.binary, launchCommand.args, {
    cwd: launchCommand.cwd,
  });

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

export async function queryDockerComposeStatus(
  options: QueryDockerComposeStatusOptions,
): Promise<DockerComposeStatusResult> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const dockerBinary = options.dockerBinary ?? DEFAULT_DOCKER_BINARY;
  const cwd = options.cwd ?? path.dirname(options.composeFilePath);
  const runner = options.runner ?? defaultProcessRunner;

  const detectFailure = await detectDockerCompose({
    composeFilePath: options.composeFilePath,
    checkedAt,
    dockerBinary,
    cwd,
    runner,
    missingBinaryMessage:
      'Docker CLI is not installed or is not on PATH, so Mullgate cannot inspect the runtime bundle.',
    detectFailureMessage:
      'Docker is installed but `docker compose` is unavailable, so Mullgate cannot inspect the runtime bundle.',
  });

  if (detectFailure) {
    return detectFailure;
  }

  const statusCommand = buildCommand(
    dockerBinary,
    ['compose', '--file', options.composeFilePath, 'ps', '--all', '--format', 'json'],
    cwd,
  );
  const statusResult = await runner(statusCommand.binary, statusCommand.args, {
    cwd: statusCommand.cwd,
  });

  if (statusResult.error?.code === 'ENOENT') {
    return {
      ok: false,
      phase: 'compose-ps',
      source: 'docker-binary',
      checkedAt,
      code: 'DOCKER_COMPOSE_MISSING',
      composeFilePath: options.composeFilePath,
      command: statusCommand,
      message: 'Docker disappeared before Mullgate could inspect the runtime bundle.',
      cause: statusResult.error.message,
      artifactPath: options.composeFilePath,
    };
  }

  if ((statusResult.exitCode ?? 1) !== 0) {
    return {
      ok: false,
      phase: 'compose-ps',
      source: 'docker-compose',
      checkedAt,
      code: 'COMPOSE_PS_FAILED',
      composeFilePath: options.composeFilePath,
      command: statusCommand,
      message: 'Docker Compose failed while inspecting the Mullgate runtime bundle.',
      cause: summarizeProcessFailure(statusResult, 'docker compose ps --all --format json failed.'),
      artifactPath: options.composeFilePath,
      exitCode: statusResult.exitCode,
    };
  }

  let parsedContainers: z.infer<typeof composePsContainerSchema>[];

  try {
    parsedContainers = parseComposePsOutput(statusResult.stdout).map((entry) =>
      composePsContainerSchema.parse(entry),
    );
  } catch (error) {
    return {
      ok: false,
      phase: 'compose-ps',
      source: 'compose-json',
      checkedAt,
      code: 'COMPOSE_PS_INVALID_JSON',
      composeFilePath: options.composeFilePath,
      command: statusCommand,
      message:
        'Docker Compose returned runtime status that Mullgate could not parse as typed JSON.',
      cause: error instanceof Error ? error.message : String(error),
      artifactPath: options.composeFilePath,
    };
  }

  const containers = parsedContainers.map(normalizeComposeContainer);
  const summary = summarizeComposeContainers(containers);

  return {
    ok: true,
    phase: 'compose-ps',
    source: 'docker-compose',
    checkedAt,
    composeFilePath: options.composeFilePath,
    command: statusCommand,
    message:
      containers.length > 0
        ? `Docker Compose reported ${containers.length} Mullgate container(s) from typed JSON status.`
        : 'Docker Compose reported no Mullgate containers for the runtime bundle.',
    containers,
    project: containers[0]?.project ?? null,
    summary,
  };
}

async function detectDockerCompose(input: {
  readonly composeFilePath: string;
  readonly checkedAt: string;
  readonly dockerBinary: string;
  readonly cwd: string;
  readonly runner: ProcessRunner;
  readonly missingBinaryMessage: string;
  readonly detectFailureMessage: string;
}): Promise<DockerComposeDetectFailure | null> {
  const detectCommand = buildCommand(input.dockerBinary, ['compose', 'version'], input.cwd);
  const detectResult = await input.runner(detectCommand.binary, detectCommand.args, {
    cwd: detectCommand.cwd,
  });

  if (detectResult.error?.code === 'ENOENT') {
    return {
      ok: false,
      phase: 'compose-detect',
      source: 'docker-binary',
      checkedAt: input.checkedAt,
      code: 'DOCKER_COMPOSE_MISSING',
      composeFilePath: input.composeFilePath,
      command: detectCommand,
      message: input.missingBinaryMessage,
      cause: detectResult.error.message,
      artifactPath: input.composeFilePath,
    };
  }

  if ((detectResult.exitCode ?? 1) !== 0) {
    return {
      ok: false,
      phase: 'compose-detect',
      source: 'docker-compose',
      checkedAt: input.checkedAt,
      code: 'DOCKER_COMPOSE_MISSING',
      composeFilePath: input.composeFilePath,
      command: detectCommand,
      message: input.detectFailureMessage,
      cause: summarizeProcessFailure(detectResult, 'docker compose version failed.'),
      artifactPath: input.composeFilePath,
      exitCode: detectResult.exitCode,
    };
  }

  return null;
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

function parseComposePsOutput(stdout: string): unknown[] {
  const trimmed = stdout.trim();

  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error('Expected docker compose ps JSON output to be an array.');
    }

    return parsed;
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function normalizeComposeContainer(
  container: z.infer<typeof composePsContainerSchema>,
): DockerComposeContainer {
  return {
    name: container.Name,
    service: container.Service ?? container.Name,
    project: normalizeOptionalString(container.Project),
    state: normalizeOptionalString(container.State) ?? 'unknown',
    health: normalizeOptionalString(container.Health),
    status: normalizeOptionalString(container.Status),
    exitCode: normalizeOptionalNumber(container.ExitCode),
    publishers: (container.Publishers ?? []).map((publisher) => ({
      url: normalizeOptionalString(publisher.URL),
      targetPort: normalizeOptionalNumber(publisher.TargetPort),
      publishedPort: normalizeOptionalNumber(publisher.PublishedPort),
      protocol: normalizeOptionalString(publisher.Protocol),
    })),
  };
}

function summarizeComposeContainers(
  containers: readonly DockerComposeContainer[],
): DockerComposeStatusSuccess['summary'] {
  let running = 0;
  let healthy = 0;
  let starting = 0;
  let stopped = 0;
  let unhealthy = 0;

  for (const container of containers) {
    const state = normalizeStateValue(container.state);
    const health = normalizeStateValue(container.health);

    if (state === 'running') {
      running += 1;

      if (health === 'healthy' || health === 'none') {
        healthy += 1;
      } else if (health === 'starting') {
        starting += 1;
      } else if (health === 'unhealthy') {
        unhealthy += 1;
      } else {
        healthy += 1;
      }

      continue;
    }

    if (state === 'created' || state === 'restarting' || state === 'starting') {
      starting += 1;
      continue;
    }

    if (state === 'unknown') {
      unhealthy += 1;
      continue;
    }

    stopped += 1;
  }

  return {
    total: containers.length,
    running,
    healthy,
    starting,
    stopped,
    unhealthy,
  };
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return null;
    }

    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }

  return null;
}

function normalizeStateValue(value: string | null): string {
  return value ? value.trim().toLowerCase() : 'none';
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
