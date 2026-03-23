import {
  buildHealthyDockerFixtures,
  createDemoEnvironment,
  createFakeDockerBinary,
  createFakeWireproxyBinary,
  markRuntimeRunning,
  runDisplayedCliCommand,
  seedLoopbackSetup,
  seedPrivateNetworkExposure,
  startFixtureServer,
  validateSavedConfig,
} from './demo-helpers.js';

async function main(): Promise<void> {
  const environment = await createDemoEnvironment();
  const server = await startFixtureServer();

  try {
    await createFakeWireproxyBinary(environment.rootDir);
    await createFakeDockerBinary({
      rootDir: environment.rootDir,
      containers: buildHealthyDockerFixtures(),
    });

    const demoEnv = {
      ...environment.env,
      MULLGATE_DEMO_DOCKER_CONTAINERS: JSON.stringify(buildHealthyDockerFixtures()),
    };

    await seedLoopbackSetup({
      env: demoEnv,
      serverBaseUrl: server.baseUrl,
      deviceName: 'mullgate-demo-runtime',
    });
    await seedPrivateNetworkExposure({
      env: demoEnv,
      serverBaseUrl: server.baseUrl,
      deviceName: 'mullgate-demo-runtime',
      bindIps: ['192.168.10.10', '192.168.10.11'],
    });
    await validateSavedConfig(demoEnv);
    await markRuntimeRunning({
      env: demoEnv,
      attemptedAt: '2026-03-21T07:58:00.000Z',
    });

    await runDisplayedCliCommand({
      display: 'mullgate status',
      args: ['status'],
      env: demoEnv,
    });

    await runDisplayedCliCommand({
      display: 'mullgate doctor',
      args: ['doctor'],
      env: demoEnv,
      clearScreen: false,
    });
  } finally {
    await server.close();
    await environment.cleanup();
  }
}

await main();
