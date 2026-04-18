import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';

import type { ExposureMode } from '../config/schema.js';

/** Bind host restricted to the local loopback interface. */
export const LOOPBACK_BIND_HOST = '127.0.0.1';
/** Fallback bind host for private-network exposure when Tailscale is unavailable. */
export const PRIVATE_NETWORK_FALLBACK_BIND_HOST = '0.0.0.0';

/**
 * Detect the local Tailscale IPv4 address by invoking `tailscale ip -4`.
 *
 * @param spawn - Override the spawn implementation (useful for testing).
 * @returns The first valid IPv4 address found, or `null` if Tailscale is not installed or returns no address.
 */
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

/**
 * Derive the default bind host based on the exposure mode.
 * For `private-network` mode, attempts to use the Tailscale IP; falls back to `0.0.0.0`.
 * All other modes bind to `127.0.0.1`.
 *
 * @param exposureMode - The configured exposure mode.
 * @returns The IP address to bind to.
 */
export function deriveDefaultBindHost(exposureMode: ExposureMode): string {
  if (exposureMode !== 'private-network') {
    return LOOPBACK_BIND_HOST;
  }

  return detectTailscaleIpv4() ?? PRIVATE_NETWORK_FALLBACK_BIND_HOST;
}
