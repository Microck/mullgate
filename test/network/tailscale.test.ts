import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveDefaultBindHost,
  detectTailscaleIpv4,
  LOOPBACK_BIND_HOST,
  PRIVATE_NETWORK_FALLBACK_BIND_HOST,
} from '../../src/network/tailscale.js';

const temporaryDirectories: string[] = [];
type SpawnSyncFn = typeof import('node:child_process').spawnSync;
type SpawnSyncResult = ReturnType<SpawnSyncFn>;

function createSpawnResult(overrides: Partial<SpawnSyncResult>): SpawnSyncResult {
  return {
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    pid: 0,
    ...overrides,
  } as SpawnSyncResult;
}

function createSpawn(overrides: Partial<SpawnSyncResult>): SpawnSyncFn {
  return (() => createSpawnResult(overrides)) as SpawnSyncFn;
}

async function createFakeTailscaleCommand(output: {
  readonly stdout?: string;
  readonly stderr?: string;
}): Promise<string> {
  const binDir = await mkdtemp(path.join(tmpdir(), 'mullgate-tailscale-bin-'));
  const scriptPath = path.join(binDir, 'fake-tailscale.mjs');
  const posixLauncherPath = path.join(binDir, 'tailscale');
  const windowsLauncherPath = path.join(binDir, 'tailscale.cmd');
  temporaryDirectories.push(binDir);

  await writeFile(
    scriptPath,
    [
      `process.stdout.write(${JSON.stringify(output.stdout ?? '')});`,
      `process.stderr.write(${JSON.stringify(output.stderr ?? '')});`,
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    posixLauncherPath,
    ['#!/bin/sh', 'exec node "$(dirname "$0")/fake-tailscale.mjs" "$@"', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    windowsLauncherPath,
    ['@echo off', 'node "%~dp0fake-tailscale.mjs" %*', ''].join('\r\n'),
    'utf8',
  );
  await chmod(scriptPath, 0o755);
  await chmod(posixLauncherPath, 0o755);

  return binDir;
}

async function withPrependedPath<T>(binDir: string, run: () => Promise<T> | T): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;

  try {
    return await run();
  } finally {
    process.env.PATH = originalPath;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('tailscale bind host helpers', () => {
  it('returns null when the tailscale command is not installed', () => {
    const result = detectTailscaleIpv4(
      createSpawn({
        error: Object.assign(new Error('tailscale not found'), { code: 'ENOENT' }),
      }),
    );

    expect(result).toBeNull();
  });

  it('prefers the first IPv4 address emitted to stdout', () => {
    const result = detectTailscaleIpv4(
      createSpawn({
        stdout: ['not-an-ip', '100.64.0.11', '100.64.0.12'].join('\n'),
        stderr: '100.64.0.13\n',
      }),
    );

    expect(result).toBe('100.64.0.11');
  });

  it('falls back to stderr when stdout does not contain an IPv4 address', () => {
    const result = detectTailscaleIpv4(
      createSpawn({
        stdout: 'warning: interface warming up\n',
        stderr: ['debug: retrying', '100.88.1.9'].join('\n'),
      }),
    );

    expect(result).toBe('100.88.1.9');
  });

  it('returns the loopback bind host for non-private exposure modes', () => {
    expect(deriveDefaultBindHost('loopback')).toBe(LOOPBACK_BIND_HOST);
    expect(deriveDefaultBindHost('public')).toBe(LOOPBACK_BIND_HOST);
  });

  it('uses the detected tailscale IPv4 address for private-network exposure', async () => {
    const binDir = await createFakeTailscaleCommand({
      stdout: '100.77.2.4\n',
    });

    await withPrependedPath(binDir, async () => {
      expect(deriveDefaultBindHost('private-network')).toBe('100.77.2.4');
    });
  });

  it('falls back to the wildcard bind host when no tailscale IPv4 can be detected', async () => {
    const binDir = await createFakeTailscaleCommand({
      stdout: 'warning only\n',
      stderr: 'still starting up\n',
    });

    await withPrependedPath(binDir, async () => {
      expect(deriveDefaultBindHost('private-network')).toBe(PRIVATE_NETWORK_FALLBACK_BIND_HOST);
    });
  });
});
