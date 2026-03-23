import {
  createDemoEnvironment,
  createFakeWireproxyBinary,
  runDisplayedCliCommand,
  startFixtureServer,
} from './demo-helpers.js';

async function main(): Promise<void> {
  const environment = await createDemoEnvironment();
  const server = await startFixtureServer();

  try {
    await createFakeWireproxyBinary(environment.rootDir);

    await runDisplayedCliCommand({
      display: 'mullgate setup --non-interactive',
      args: ['setup', '--non-interactive'],
      env: {
        ...environment.env,
        MULLGATE_ACCOUNT_NUMBER: '123456789012',
        MULLGATE_PROXY_USERNAME: 'alice',
        MULLGATE_PROXY_PASSWORD: 'demo-secret-password',
        MULLGATE_LOCATIONS: 'sweden-gothenburg,austria-vienna',
        MULLGATE_DEVICE_NAME: 'mullgate-demo-setup',
        MULLGATE_MULLVAD_WG_URL: new URL('/wg', server.baseUrl).toString(),
        MULLGATE_MULLVAD_RELAYS_URL: new URL('/relays', server.baseUrl).toString(),
      },
    });
  } finally {
    await server.close();
    await environment.cleanup();
  }
}

await main();
