import { describe, expect, it } from 'vitest';

import {
  type ProcessExecution,
  type ProcessRunner,
  queryDockerComposeStatus,
  startDockerRuntime,
} from '../../src/runtime/docker-runtime.js';

function createQueuedRunner(steps: ProcessExecution[]): ProcessRunner {
  const queue = [...steps];

  return async () => {
    const next = queue.shift();

    if (!next) {
      throw new Error('Unexpected extra process invocation.');
    }

    return next;
  };
}

describe('startDockerRuntime', () => {
  it('classifies a missing Docker binary before attempting compose up', async () => {
    const missingDockerError = Object.assign(new Error('spawn docker ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;

    const result = await startDockerRuntime({
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      checkedAt: '2026-03-20T19:00:00.000Z',
      runner: createQueuedRunner([
        {
          exitCode: null,
          stdout: '',
          stderr: '',
          error: missingDockerError,
        },
      ]),
    });

    expect(result).toEqual({
      ok: false,
      phase: 'compose-detect',
      source: 'docker-binary',
      checkedAt: '2026-03-20T19:00:00.000Z',
      code: 'DOCKER_COMPOSE_MISSING',
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      command: {
        binary: 'docker',
        args: ['compose', 'version'],
        cwd: '/tmp/mullgate/runtime',
        rendered: 'docker compose version',
      },
      message:
        'Docker CLI is not installed or is not on PATH, so Mullgate cannot launch the runtime bundle.',
      cause: 'spawn docker ENOENT',
      artifactPath: '/tmp/mullgate/runtime/docker-compose.yml',
    });
  });

  it('classifies an unavailable compose plugin separately from launch failures', async () => {
    const result = await startDockerRuntime({
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      checkedAt: '2026-03-20T19:01:00.000Z',
      runner: createQueuedRunner([
        {
          exitCode: 1,
          stdout: '',
          stderr: "docker: 'compose' is not a docker command.\n",
        },
      ]),
    });

    expect(result).toEqual({
      ok: false,
      phase: 'compose-detect',
      source: 'docker-compose',
      checkedAt: '2026-03-20T19:01:00.000Z',
      code: 'DOCKER_COMPOSE_MISSING',
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      command: {
        binary: 'docker',
        args: ['compose', 'version'],
        cwd: '/tmp/mullgate/runtime',
        rendered: 'docker compose version',
      },
      message:
        'Docker is installed but `docker compose` is unavailable, so Mullgate cannot launch the runtime bundle.',
      cause: "docker: 'compose' is not a docker command.",
      artifactPath: '/tmp/mullgate/runtime/docker-compose.yml',
      exitCode: 1,
    });
  });

  it('returns structured launch metadata when compose up fails after detection succeeds', async () => {
    const result = await startDockerRuntime({
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      checkedAt: '2026-03-20T19:02:00.000Z',
      runner: createQueuedRunner([
        {
          exitCode: 0,
          stdout: 'Docker Compose version v2.40.1\n',
          stderr: '',
        },
        {
          exitCode: 1,
          stdout: '',
          stderr: 'failed to pull image "backplane/wireproxy:20260320"\n',
        },
      ]),
    });

    expect(result).toEqual({
      ok: false,
      phase: 'compose-launch',
      source: 'docker-compose',
      checkedAt: '2026-03-20T19:02:00.000Z',
      code: 'COMPOSE_UP_FAILED',
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      command: {
        binary: 'docker',
        args: ['compose', '--file', '/tmp/mullgate/runtime/docker-compose.yml', 'up', '--detach'],
        cwd: '/tmp/mullgate/runtime',
        rendered: 'docker compose --file /tmp/mullgate/runtime/docker-compose.yml up --detach',
      },
      message: 'Docker Compose failed to start the Mullgate runtime bundle.',
      cause: 'failed to pull image "backplane/wireproxy:20260320"',
      artifactPath: '/tmp/mullgate/runtime/docker-compose.yml',
      exitCode: 1,
    });
  });

  it('returns the detached launch command metadata on success', async () => {
    const result = await startDockerRuntime({
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      checkedAt: '2026-03-20T19:03:00.000Z',
      runner: createQueuedRunner([
        {
          exitCode: 0,
          stdout: 'Docker Compose version v2.40.1\n',
          stderr: '',
        },
        {
          exitCode: 0,
          stdout:
            'Container mullgate-wireproxy-1  Started\nContainer mullgate-https-sidecar-1  Started\n',
          stderr: '',
        },
      ]),
    });

    expect(result).toEqual({
      ok: true,
      phase: 'compose-launch',
      source: 'docker-compose',
      checkedAt: '2026-03-20T19:03:00.000Z',
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      command: {
        binary: 'docker',
        args: ['compose', '--file', '/tmp/mullgate/runtime/docker-compose.yml', 'up', '--detach'],
        cwd: '/tmp/mullgate/runtime',
        rendered: 'docker compose --file /tmp/mullgate/runtime/docker-compose.yml up --detach',
      },
      message: 'Docker Compose launched the Mullgate runtime bundle in detached mode.',
      stdout:
        'Container mullgate-wireproxy-1  Started\nContainer mullgate-https-sidecar-1  Started\n',
      stderr: '',
    });
  });
});

describe('queryDockerComposeStatus', () => {
  it('classifies a missing Docker binary before attempting compose ps', async () => {
    const missingDockerError = Object.assign(new Error('spawn docker ENOENT'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException;

    const result = await queryDockerComposeStatus({
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      checkedAt: '2026-03-21T06:00:00.000Z',
      runner: createQueuedRunner([
        {
          exitCode: null,
          stdout: '',
          stderr: '',
          error: missingDockerError,
        },
      ]),
    });

    expect(result).toEqual({
      ok: false,
      phase: 'compose-detect',
      source: 'docker-binary',
      checkedAt: '2026-03-21T06:00:00.000Z',
      code: 'DOCKER_COMPOSE_MISSING',
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      command: {
        binary: 'docker',
        args: ['compose', 'version'],
        cwd: '/tmp/mullgate/runtime',
        rendered: 'docker compose version',
      },
      message:
        'Docker CLI is not installed or is not on PATH, so Mullgate cannot inspect the runtime bundle.',
      cause: 'spawn docker ENOENT',
      artifactPath: '/tmp/mullgate/runtime/docker-compose.yml',
    });
  });

  it('parses typed compose ps JSON into structured container summaries', async () => {
    const result = await queryDockerComposeStatus({
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      checkedAt: '2026-03-21T06:01:00.000Z',
      runner: createQueuedRunner([
        {
          exitCode: 0,
          stdout: 'Docker Compose version v2.40.1\n',
          stderr: '',
        },
        {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Name: 'mullgate-routing-layer-1',
              Service: 'routing-layer',
              Project: 'mullgate',
              State: 'running',
              Health: 'healthy',
              Status: 'Up 10 seconds',
              ExitCode: 0,
            },
            {
              Name: 'mullgate-wireproxy-se-got-wg-101-1',
              Service: 'wireproxy-se-got-wg-101',
              Project: 'mullgate',
              State: 'running',
              Health: 'healthy',
              Status: 'Up 10 seconds',
              ExitCode: 0,
            },
            {
              Name: 'mullgate-wireproxy-at-vie-wg-001-1',
              Service: 'wireproxy-at-vie-wg-001',
              Project: 'mullgate',
              State: 'exited',
              Status: 'Exited (2) 3 seconds ago',
              ExitCode: 2,
            },
          ]),
          stderr: '',
        },
      ]),
    });

    expect(result).toEqual({
      ok: true,
      phase: 'compose-ps',
      source: 'docker-compose',
      checkedAt: '2026-03-21T06:01:00.000Z',
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      command: {
        binary: 'docker',
        args: [
          'compose',
          '--file',
          '/tmp/mullgate/runtime/docker-compose.yml',
          'ps',
          '--all',
          '--format',
          'json',
        ],
        cwd: '/tmp/mullgate/runtime',
        rendered:
          'docker compose --file /tmp/mullgate/runtime/docker-compose.yml ps --all --format json',
      },
      message: 'Docker Compose reported 3 Mullgate container(s) from typed JSON status.',
      project: 'mullgate',
      containers: [
        {
          name: 'mullgate-routing-layer-1',
          service: 'routing-layer',
          project: 'mullgate',
          state: 'running',
          health: 'healthy',
          status: 'Up 10 seconds',
          exitCode: 0,
          publishers: [],
        },
        {
          name: 'mullgate-wireproxy-se-got-wg-101-1',
          service: 'wireproxy-se-got-wg-101',
          project: 'mullgate',
          state: 'running',
          health: 'healthy',
          status: 'Up 10 seconds',
          exitCode: 0,
          publishers: [],
        },
        {
          name: 'mullgate-wireproxy-at-vie-wg-001-1',
          service: 'wireproxy-at-vie-wg-001',
          project: 'mullgate',
          state: 'exited',
          health: null,
          status: 'Exited (2) 3 seconds ago',
          exitCode: 2,
          publishers: [],
        },
      ],
      summary: {
        total: 3,
        running: 2,
        healthy: 2,
        starting: 0,
        stopped: 1,
        unhealthy: 0,
      },
    });
  });

  it('fails cleanly when compose ps does not return valid JSON', async () => {
    const result = await queryDockerComposeStatus({
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      checkedAt: '2026-03-21T06:02:00.000Z',
      runner: createQueuedRunner([
        {
          exitCode: 0,
          stdout: 'Docker Compose version v2.40.1\n',
          stderr: '',
        },
        {
          exitCode: 0,
          stdout: 'not-json\n',
          stderr: '',
        },
      ]),
    });

    expect(result).toEqual({
      ok: false,
      phase: 'compose-ps',
      source: 'compose-json',
      checkedAt: '2026-03-21T06:02:00.000Z',
      code: 'COMPOSE_PS_INVALID_JSON',
      composeFilePath: '/tmp/mullgate/runtime/docker-compose.yml',
      command: {
        binary: 'docker',
        args: [
          'compose',
          '--file',
          '/tmp/mullgate/runtime/docker-compose.yml',
          'ps',
          '--all',
          '--format',
          'json',
        ],
        cwd: '/tmp/mullgate/runtime',
        rendered:
          'docker compose --file /tmp/mullgate/runtime/docker-compose.yml ps --all --format json',
      },
      message:
        'Docker Compose returned runtime status that Mullgate could not parse as typed JSON.',
      cause: expect.stringContaining('Unexpected token'),
      artifactPath: '/tmp/mullgate/runtime/docker-compose.yml',
    });
  });
});
