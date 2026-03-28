import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildAutostartUnitFile,
  disableAutostart,
  enableAutostart,
  inspectAutostart,
} from '../../src/commands/autostart.js';

async function createAutostartFixture(): Promise<{
  readonly homeDir: string;
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
}> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'mullgate-autostart-'));
  const binDir = path.join(homeDir, 'bin');
  const binaryPath = path.join(binDir, 'mullgate');

  await mkdir(binDir, { recursive: true });
  await writeFile(binaryPath, '#!/bin/sh\nexit 0\n');
  await chmod(binaryPath, 0o755);

  return {
    homeDir,
    binaryPath,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: path.join(homeDir, 'config'),
      XDG_STATE_HOME: path.join(homeDir, 'state'),
      XDG_CACHE_HOME: path.join(homeDir, 'cache'),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  };
}

describe('mullgate autostart command', () => {
  it('renders a Linux systemd user unit that starts mullgate', () => {
    expect(
      `\n${buildAutostartUnitFile({ binaryPath: '/usr/local/bin/mullgate' })}`,
    ).toMatchInlineSnapshot(`
      "
      [Unit]
      Description=Mullgate proxy runtime
      Wants=network-online.target
      After=network-online.target

      [Service]
      Type=simple
      ExecStart=/usr/local/bin/mullgate proxy start
      Restart=on-failure
      RestartSec=15
      WorkingDirectory=%h

      [Install]
      WantedBy=default.target"
    `);
  });

  it('writes and enables the user service', async () => {
    const fixture = await createAutostartFixture();
    const commands: string[] = [];

    const result = await enableAutostart({
      env: fixture.env,
      argv: ['node', fixture.binaryPath],
      platform: 'linux',
      runSystemctl: async (args) => {
        commands.push(args.join(' '));
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const unitPath = path.join(fixture.homeDir, 'config', 'systemd', 'user', 'mullgate.service');
    const unitContents = await readFile(unitPath, 'utf8');

    expect(result.ok).toBe(true);
    expect(unitContents).toBe(`${buildAutostartUnitFile({ binaryPath: fixture.binaryPath })}\n`);
    expect(commands).toEqual(['--user daemon-reload', '--user enable --now mullgate.service']);
    expect(`\n${normalizeTempPath(result.summary, fixture.homeDir)}`).toMatchInlineSnapshot(`
      "
      Mullgate autostart enabled.
      phase: autostart-enable
      platform: linux
      unit: /tmp/mullgate-autostart-REPLACED/config/systemd/user/mullgate.service
      exec start: /tmp/mullgate-autostart-REPLACED/bin/mullgate proxy start
      service: enabled and started
      next step: run \`mullgate proxy autostart status\` if you want to verify the user service state."
    `);
  });

  it('accepts a relative release-binary invocation when mullgate is not on PATH', async () => {
    const fixture = await createAutostartFixture();
    const commands: string[] = [];
    const relativeBinaryPath = path.relative(process.cwd(), fixture.binaryPath);

    const result = await enableAutostart({
      env: {
        ...fixture.env,
        PATH: '/usr/bin:/bin',
      },
      argv: ['node', relativeBinaryPath],
      platform: 'linux',
      runSystemctl: async (args) => {
        commands.push(args.join(' '));
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const unitPath = path.join(fixture.homeDir, 'config', 'systemd', 'user', 'mullgate.service');
    const unitContents = await readFile(unitPath, 'utf8');

    expect(result.ok).toBe(true);
    expect(unitContents).toBe(`${buildAutostartUnitFile({ binaryPath: fixture.binaryPath })}\n`);
    expect(commands).toEqual(['--user daemon-reload', '--user enable --now mullgate.service']);
  });

  it('reports status with the generated unit preview', async () => {
    const fixture = await createAutostartFixture();
    const unitPath = path.join(fixture.homeDir, 'config', 'systemd', 'user', 'mullgate.service');
    await enableAutostart({
      env: fixture.env,
      argv: ['node', fixture.binaryPath],
      platform: 'linux',
      runSystemctl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });

    const result = await inspectAutostart({
      env: fixture.env,
      argv: ['node', fixture.binaryPath],
      platform: 'linux',
      runSystemctl: async (args) => {
        const command = args.join(' ');

        if (command === '--user is-enabled mullgate.service') {
          return { code: 0, stdout: 'enabled', stderr: '' };
        }

        if (command === '--user is-active mullgate.service') {
          return { code: 0, stdout: 'active', stderr: '' };
        }

        throw new Error(`Unexpected command: ${command}`);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain(unitPath);
    expect(result.summary).toContain('enabled: enabled');
    expect(result.summary).toContain('active: active');
    expect(result.summary).toContain('preview:');
  });

  it('fails clearly when systemctl is unavailable', async () => {
    const fixture = await createAutostartFixture();

    const result = await inspectAutostart({
      env: {
        ...fixture.env,
        PATH: path.dirname(fixture.binaryPath),
      },
      argv: ['node', fixture.binaryPath],
      platform: 'linux',
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
    });
    expect(`\n${result.summary}`).toMatchInlineSnapshot(`
      "
      Mullgate autostart failed.
      phase: autostart-status
      reason: systemctl was not found on PATH, so Mullgate cannot manage a user service."
    `);
  });

  it('stops and removes the user service', async () => {
    const fixture = await createAutostartFixture();
    const commands: string[] = [];

    await enableAutostart({
      env: fixture.env,
      argv: ['node', fixture.binaryPath],
      platform: 'linux',
      runSystemctl: async () => ({ code: 0, stdout: '', stderr: '' }),
    });

    const result = await disableAutostart({
      env: fixture.env,
      argv: ['node', fixture.binaryPath],
      platform: 'linux',
      runSystemctl: async (args) => {
        commands.push(args.join(' '));
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const unitPath = path.join(fixture.homeDir, 'config', 'systemd', 'user', 'mullgate.service');

    expect(result.ok).toBe(true);
    await expect(readFile(unitPath, 'utf8')).rejects.toThrow();
    expect(commands).toEqual(['--user disable --now mullgate.service', '--user daemon-reload']);
  });

  it('fails clearly on non-linux platforms', async () => {
    const fixture = await createAutostartFixture();

    const result = await inspectAutostart({
      env: fixture.env,
      argv: ['node', fixture.binaryPath],
      platform: 'darwin',
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
    });
    expect(`\n${result.summary}`).toMatchInlineSnapshot(`
      "
      Mullgate autostart failed.
      phase: autostart-status
      reason: Autostart is only supported on Linux right now."
    `);
  });
});

function normalizeTempPath(value: string, homeDir: string): string {
  return value.split(homeDir).join('/tmp/mullgate-autostart-REPLACED').replaceAll('\\', '/');
}
