import { readFile } from 'node:fs/promises';

import type { RuntimeStartDiagnostic } from '../config/schema.js';
import type { DockerComposeContainer } from '../runtime/docker-runtime.js';

export type ArtifactReadResult<T> =
  | {
      readonly kind: 'present';
      readonly value: T;
    }
  | {
      readonly kind: 'missing';
    }
  | {
      readonly kind: 'invalid';
      readonly reason: string;
    };

export type ContainerLiveState = 'running' | 'starting' | 'stopped' | 'degraded';

export async function readJsonArtifact<T>(targetPath: string): Promise<ArtifactReadResult<T>> {
  try {
    const raw = await readFile(targetPath, 'utf8');
    return {
      kind: 'present',
      value: JSON.parse(raw) as T,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { kind: 'missing' };
    }

    return {
      kind: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatArtifactPresence<T>(
  artifactPath: string,
  result: ArtifactReadResult<T>,
): string {
  switch (result.kind) {
    case 'present':
      return `${artifactPath} (present)`;
    case 'missing':
      return `${artifactPath} (missing)`;
    case 'invalid':
      return `${artifactPath} (invalid: ${result.reason})`;
  }
}

export function resolveLastStartDiagnostic(
  config: { readonly diagnostics: { readonly lastRuntimeStart: RuntimeStartDiagnostic | null } },
  result: ArtifactReadResult<RuntimeStartDiagnostic>,
): RuntimeStartDiagnostic | null {
  if (result.kind === 'present') {
    return result.value;
  }

  return config.diagnostics.lastRuntimeStart;
}

export function findContainerForService(
  containers: readonly DockerComposeContainer[],
  serviceName: string,
): DockerComposeContainer | null {
  return containers.find((container) => container.service === serviceName) ?? null;
}

export function classifyContainerState(container: DockerComposeContainer | null): {
  readonly liveState: ContainerLiveState;
  readonly detail: string;
} {
  if (!container) {
    return {
      liveState: 'stopped',
      detail: 'not present in live compose status',
    };
  }

  const state = normalizeState(container.state);
  const health = normalizeState(container.health);
  const suffix = [
    container.status ? `status=${container.status}` : null,
    health !== 'none' ? `health=${health}` : null,
    container.exitCode !== null ? `exit=${container.exitCode}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(', ');

  if (state === 'running' && (health === 'healthy' || health === 'none')) {
    return {
      liveState: 'running',
      detail: suffix.length > 0 ? `running (${suffix})` : 'running',
    };
  }

  if (state === 'running' && health === 'starting') {
    return {
      liveState: 'starting',
      detail: `running but still warming up (${suffix || 'health=starting'})`,
    };
  }

  if (state === 'created' || state === 'restarting' || state === 'starting') {
    return {
      liveState: 'starting',
      detail: suffix.length > 0 ? `${state} (${suffix})` : state,
    };
  }

  if (state === 'running' && health === 'unhealthy') {
    return {
      liveState: 'degraded',
      detail: `running but unhealthy (${suffix || 'health=unhealthy'})`,
    };
  }

  if (state === 'unknown') {
    return {
      liveState: 'degraded',
      detail: suffix.length > 0 ? `unknown (${suffix})` : 'unknown live state',
    };
  }

  return {
    liveState: 'stopped',
    detail: suffix.length > 0 ? `${state} (${suffix})` : state,
  };
}

export function renderComposeRemediation(
  code: 'DOCKER_COMPOSE_MISSING' | 'COMPOSE_PS_FAILED' | 'COMPOSE_PS_INVALID_JSON',
): string {
  switch (code) {
    case 'DOCKER_COMPOSE_MISSING':
      return 'Install Docker plus the Compose plugin, then rerun `mullgate status`, `mullgate doctor`, or `mullgate start`.';
    case 'COMPOSE_PS_FAILED':
      return 'Check `docker compose ps` / `docker compose logs` for the saved compose file and resolve the runtime failure before retrying.';
    case 'COMPOSE_PS_INVALID_JSON':
      return 'Update Docker Compose to a version that supports stable JSON output, or inspect the compose project manually for now.';
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function normalizeState(value: string | null): string {
  return value?.trim().toLowerCase() ?? 'none';
}
