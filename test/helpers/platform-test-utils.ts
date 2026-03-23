import { chmodSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect } from 'vitest';

export async function createFakeWireproxyBinary(rootDir: string): Promise<string> {
  const binDir = path.join(rootDir, 'bin');
  const scriptPath = path.join(binDir, 'fake-wireproxy.mjs');
  const posixLauncherPath = path.join(binDir, 'wireproxy');
  const windowsLauncherPath = path.join(binDir, 'wireproxy.cmd');

  await mkdir(binDir, { recursive: true });
  await writeFile(
    scriptPath,
    [
      "import fs from 'node:fs';",
      '',
      'const args = process.argv.slice(2);',
      '',
      "if (args[0] !== '--configtest') {",
      "  console.error('unsupported fake wireproxy invocation');",
      '  process.exit(1);',
      '}',
      '',
      'const configPath = args[1];',
      "const configText = fs.readFileSync(configPath, 'utf8');",
      'const isValid =',
      '  /^Address = /m.test(configText) &&',
      '  /^\\[Peer\\]$/m.test(configText) &&',
      '  /^\\[Socks5\\]$/m.test(configText) &&',
      '  /^\\[http\\]$/m.test(configText);',
      '',
      'if (isValid) {',
      '  process.exit(0);',
      '}',
      '',
      'console.error("fake wireproxy configtest: invalid rendered config at " + configPath);',
      'process.exit(1);',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    posixLauncherPath,
    ['#!/bin/sh', 'exec node "$(dirname "$0")/fake-wireproxy.mjs" "$@"', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    windowsLauncherPath,
    ['@echo off', 'node "%~dp0fake-wireproxy.mjs" %*', ''].join('\r\n'),
    'utf8',
  );

  chmodSync(scriptPath, 0o755);
  chmodSync(posixLauncherPath, 0o755);

  return process.platform === 'win32' ? windowsLauncherPath : posixLauncherPath;
}

export function normalizeFixtureHomePath(value: string, home?: string): string {
  if (!home) {
    return value.replaceAll('\\', '/');
  }

  const windowsHome = home.replaceAll('/', '\\');

  return value
    .split(home)
    .join('/tmp/mullgate-home')
    .split(windowsHome)
    .join('/tmp/mullgate-home')
    .replaceAll('\\', '/');
}

export function expectPrivateFileMode(mode: number): void {
  const normalized = mode & 0o777;

  if (process.platform === 'win32') {
    expect(normalized & 0o111).toBe(0);
    return;
  }

  expect(normalized).toBe(0o600);
}
