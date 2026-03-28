#!/usr/bin/env tsx

const frames = [
  '$ mullgate proof summary',
  '',
  'Mullgate 50-proxy proof',
  'phase: shared-entry-live-proof',
  'platform: linux',
  'shared mullvad device: 1',
  'runtime containers: entry-tunnel, route-proxy, routing-layer',
  'configured routes: 50',
  'concurrent published proxies: 50',
  '',
  'protocol sweep',
  '1. socks5 passed: 50/50',
  '2. http passed: 50/50',
  '3. https passed: 50/50',
  '',
  'exit proof',
  'distinct exit ips: 50/50',
  'device slot cost: 1 shared device total',
  '',
  'result',
  'all 50 proxies worked at the same time',
  'each route kept its own exit identity',
].join('\n');

async function main(): Promise<void> {
  for (const character of frames) {
    process.stdout.write(character);
    await wait(16);
  }

  process.stdout.write('\n');
}

function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

await main();
