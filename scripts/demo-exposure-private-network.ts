import {
  createDemoEnvironment,
  createFakeWireproxyBinary,
  runDisplayedCliCommand,
  seedLoopbackSetup,
  startFixtureServer,
} from './demo-helpers.js';

async function main(): Promise<void> {
  const environment = await createDemoEnvironment();
  const server = await startFixtureServer();

  try {
    await createFakeWireproxyBinary(environment.rootDir);
    await seedLoopbackSetup({
      env: environment.env,
      serverBaseUrl: server.baseUrl,
      deviceName: 'mullgate-demo-exposure',
    });

    await runDisplayedCliCommand({
      display:
        'mullgate proxy access --mode private-network --base-domain proxy.example.com --route-bind-ip 192.168.10.10 --route-bind-ip 192.168.10.11',
      args: [
        'proxy',
        'access',
        '--mode',
        'private-network',
        '--base-domain',
        'proxy.example.com',
        '--route-bind-ip',
        '192.168.10.10',
        '--route-bind-ip',
        '192.168.10.11',
      ],
      env: environment.env,
    });
  } finally {
    await server.close();
    await environment.cleanup();
  }
}

await main();
