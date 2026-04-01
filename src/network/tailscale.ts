import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';

import type { ExposureMode } from '../config/schema.js';

export const LOOPBACK_BIND_HOST = '127.0.0.1';
export const PRIVATE_NETWORK_FALLBACK_BIND_HOST = '0.0.0.0';

export function detectTailscaleIpv4(spawn: typeof spawnSync = spawnSync): string | null {
  const result = spawn('tailscale', ['ip', '-4'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 1_000,
  });

  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    return null;
  }

  const candidates = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isIP(line) === 4);

  return candidates[0] ?? null;
}

export function deriveDefaultBindHost(exposureMode: ExposureMode): string {
  if (exposureMode !== 'private-network') {
    return LOOPBACK_BIND_HOST;
  }

  return detectTailscaleIpv4() ?? PRIVATE_NETWORK_FALLBACK_BIND_HOST;
}
