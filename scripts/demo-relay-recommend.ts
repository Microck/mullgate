import fs from 'node:fs';
import path from 'node:path';

import {
  createDemoEnvironment,
  runDisplayedCliCommand,
  seedLoopbackSetup,
  seedPrivateNetworkExposure,
  startFixtureServer,
} from './demo-helpers.js';

async function main(): Promise<void> {
  const environment = await createDemoEnvironment();
  const server = await startFixtureServer();

  try {
    await createFakePingBinary({ rootDir: environment.rootDir });

    const demoEnv = {
      ...environment.env,
      MULLGATE_MULLVAD_RELAYS_URL: new URL('/relays', server.baseUrl).toString(),
    };

    await seedLoopbackSetup({
      env: demoEnv,
      serverBaseUrl: server.baseUrl,
      deviceName: 'mullgate-demo-relays',
    });
    await seedPrivateNetworkExposure({
      env: demoEnv,
      serverBaseUrl: server.baseUrl,
      deviceName: 'mullgate-demo-relays',
      bindIps: ['192.168.10.10', '192.168.10.11'],
      baseDomain: 'proxy.example.com',
    });

    await runDisplayedCliCommand({
      display:
        'mullgate relays list --country Sweden --owner mullvad --run-mode ram --min-port-speed 9000',
      args: [
        'relays',
        'list',
        '--country',
        'Sweden',
        '--owner',
        'mullvad',
        '--run-mode',
        'ram',
        '--min-port-speed',
        '9000',
      ],
      env: demoEnv,
    });

    await runDisplayedCliCommand({
      display: 'mullgate relays probe --country Sweden --count 2',
      args: ['relays', 'probe', '--country', 'Sweden', '--count', '2'],
      env: demoEnv,
    });

    await runDisplayedCliCommand({
      display: 'mullgate recommend --country Sweden --count 1',
      args: ['recommend', '--country', 'Sweden', '--count', '1'],
      env: demoEnv,
    });
  } finally {
    await server.close();
    await environment.cleanup();
  }
}

async function createFakePingBinary(input: { readonly rootDir: string }): Promise<void> {
  const binDir = path.join(input.rootDir, 'bin');
  const scriptPath = path.join(binDir, 'fake-ping.mjs');
  const launcherPath = path.join(binDir, 'ping');

  await fs.promises.writeFile(
    scriptPath,
    [
      'const targetIp = process.argv.at(-1) ?? "";',
      '',
      'if (targetIp.length === 0) {',
      "  console.error('missing ping target');",
      '  process.exit(1);',
      '}',
      '',
      'const latencyMs =',
      "  targetIp === '185.213.154.22'",
      "    ? '8.5'",
      "    : targetIp === '185.213.154.2'",
      "      ? '14.2'",
      "      : targetIp === '185.213.154.1'",
      "        ? '31.8'",
      "        : '22.4';",
      '',
      'console.log("64 bytes from " + targetIp + ": icmp_seq=1 ttl=57 time=" + latencyMs + " ms");',
      '',
    ].join('\n'),
    'utf8',
  );

  await fs.promises.writeFile(
    launcherPath,
    ['#!/bin/sh', 'exec node "$(dirname "$0")/fake-ping.mjs" "$@"', ''].join('\n'),
    'utf8',
  );

  fs.chmodSync(scriptPath, 0o755);
  fs.chmodSync(launcherPath, 0o755);
}

await main();
