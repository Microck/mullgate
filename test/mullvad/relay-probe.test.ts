import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MullvadRelay } from '../../src/mullvad/fetch-relays.js';
import {
  parsePingLatencyMs,
  parseProxyExitPayload,
  probeProxyExit,
  probeRelayLatency,
} from '../../src/mullvad/relay-probe.js';

function createRelay(): MullvadRelay {
  return {
    hostname: 'se-got-wg-101',
    fqdn: 'se-got-wg-101.relays.mullvad.net',
    source: 'www-relays-all',
    active: true,
    owned: true,
    provider: 'm247',
    publicKey: 'relay-public-key-se-got-101',
    endpointIpv4: '185.213.154.2',
    networkPortSpeed: 10000,
    stboot: true,
    location: {
      countryCode: 'se',
      countryName: 'Sweden',
      cityCode: 'got',
      cityName: 'Gothenburg',
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('relay probe helpers', () => {
  it('parses linux and windows ping output', () => {
    expect(
      parsePingLatencyMs(
        '64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=18.4 ms\nrtt min/avg/max/mdev = 18.4/18.4/18.4/0.0 ms',
      ),
    ).toBe(18.4);
    expect(
      parsePingLatencyMs(
        'Reply from 1.1.1.1: bytes=32 time=24ms TTL=57\nApproximate round trip times in milli-seconds:\nMinimum = 24ms, Maximum = 24ms, Average = 24ms',
      ),
    ).toBe(24);
  });

  it('parses proxy exit payload JSON', () => {
    expect(parseProxyExitPayload('{"ip":"1.2.3.4","mullvad_exit_ip":true}')).toEqual({
      ok: true,
      value: {
        ip: '1.2.3.4',
        mullvad_exit_ip: true,
      },
    });
  });

  it('reports invalid proxy exit payload JSON', () => {
    expect(parseProxyExitPayload('not-json')).toEqual({
      ok: false,
      message: expect.stringContaining('Unexpected token'),
    });
  });

  it('returns null when ping output does not contain a latency', () => {
    expect(parsePingLatencyMs('PING 1.1.1.1 with no latency summary')).toBeNull();
  });

  it('probes relay latency with an injected runner', async () => {
    const result = await probeRelayLatency({
      relay: createRelay(),
      runner: async () => ({
        exitCode: 0,
        stdout:
          '64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms\nrtt min/avg/max/mdev = 12.3/12.3/12.3/0.0 ms',
        stderr: '',
      }),
    });

    expect(result).toEqual({
      ok: true,
      relay: createRelay(),
      latencyMs: 12.3,
    });
  });

  it('surfaces relay probe failures when ping exits non-zero', async () => {
    const result = await probeRelayLatency({
      relay: createRelay(),
      runner: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'network unreachable',
      }),
    });

    expect(result).toEqual({
      ok: false,
      relay: createRelay(),
      message: 'Ping failed for se-got-wg-101.',
      cause: 'network unreachable',
    });
  });

  it('surfaces relay probe failures when ping latency cannot be parsed', async () => {
    const result = await probeRelayLatency({
      relay: createRelay(),
      runner: async () => ({
        exitCode: 0,
        stdout: 'PING 1.1.1.1 with no latency summary',
        stderr: '',
      }),
    });

    expect(result).toEqual({
      ok: false,
      relay: createRelay(),
      message: 'Ping succeeded for se-got-wg-101, but Mullgate could not parse the latency.',
      cause: 'PING 1.1.1.1 with no latency summary',
    });
  });

  it('verifies Mullvad exit payloads through an injected curl runner', async () => {
    const result = await probeProxyExit({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'alice',
      password: 'secret',
      targetUrl: 'https://am.i.mullvad.net/json',
      runner: async () => ({
        exitCode: 0,
        stdout: '{"ip":"203.0.113.9","country":"SE","city":"Gothenburg","mullvad_exit_ip":true}',
        stderr: '',
      }),
    });

    expect(result).toEqual({
      ok: true,
      protocol: 'http',
      proxyUrl: 'http://127.0.0.1:8080',
      exit: {
        ip: '203.0.113.9',
        country: 'SE',
        city: 'Gothenburg',
        mullvadExitIp: true,
      },
    });
  });

  it('uses a socks5h proxy URL and strips inherited proxy env vars', async () => {
    let runnerInput:
      | {
          readonly command: string;
          readonly args: readonly string[];
          readonly env?: NodeJS.ProcessEnv;
        }
      | undefined;

    vi.stubEnv('HTTP_PROXY', 'http://proxy.example');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example');
    vi.stubEnv('ALL_PROXY', 'socks5://proxy.example');
    vi.stubEnv('NO_PROXY', 'localhost');

    await probeProxyExit({
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'alice',
      password: 'secret',
      targetUrl: 'https://am.i.mullvad.net/json',
      runner: async (input) => {
        runnerInput = input;
        return {
          exitCode: 0,
          stdout: '{"ip":"203.0.113.9","mullvad_exit_ip":true}',
          stderr: '',
        };
      },
    });

    expect(runnerInput).toBeDefined();
    expect(runnerInput?.command).toBe('curl');
    expect(runnerInput?.args).toContain('socks5h://127.0.0.1:1080');
    expect(runnerInput?.env).not.toHaveProperty('HTTP_PROXY');
    expect(runnerInput?.env).not.toHaveProperty('HTTPS_PROXY');
    expect(runnerInput?.env).not.toHaveProperty('ALL_PROXY');
    expect(runnerInput?.env).not.toHaveProperty('NO_PROXY');
  });

  it('adds proxy-insecure for https proxy probes', async () => {
    let runnerInput:
      | {
          readonly command: string;
          readonly args: readonly string[];
          readonly env?: NodeJS.ProcessEnv;
        }
      | undefined;

    await probeProxyExit({
      protocol: 'https',
      host: '127.0.0.1',
      port: 8443,
      username: 'alice',
      password: 'secret',
      targetUrl: 'https://am.i.mullvad.net/json',
      runner: async (input) => {
        runnerInput = input;
        return {
          exitCode: 0,
          stdout: '{"ip":"203.0.113.9","mullvad_exit_ip":true}',
          stderr: '',
        };
      },
    });

    expect(runnerInput?.args).toContain('--proxy-insecure');
  });

  it('surfaces proxy exit failures from curl execution errors', async () => {
    const result = await probeProxyExit({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'alice',
      password: 'secret',
      targetUrl: 'https://am.i.mullvad.net/json',
      runner: async () => ({
        exitCode: 28,
        stdout: '',
        stderr: 'operation timed out',
      }),
    });

    expect(result).toEqual({
      ok: false,
      protocol: 'http',
      proxyUrl: 'http://127.0.0.1:8080',
      message: 'Exit probe failed for http://127.0.0.1:8080.',
      cause: 'operation timed out',
    });
  });

  it('surfaces invalid JSON, missing ip, and non-Mullvad exits', async () => {
    const invalidJson = await probeProxyExit({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'alice',
      password: 'secret',
      targetUrl: 'https://am.i.mullvad.net/json',
      runner: async () => ({
        exitCode: 0,
        stdout: 'not-json',
        stderr: '',
      }),
    });

    const missingIp = await probeProxyExit({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'alice',
      password: 'secret',
      targetUrl: 'https://am.i.mullvad.net/json',
      runner: async () => ({
        exitCode: 0,
        stdout: '{"country":"SE","mullvad_exit_ip":true}',
        stderr: '',
      }),
    });

    const notMullvad = await probeProxyExit({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'alice',
      password: 'secret',
      targetUrl: 'https://am.i.mullvad.net/json',
      runner: async () => ({
        exitCode: 0,
        stdout: '{"ip":"203.0.113.9","mullvad_exit_ip":false}',
        stderr: '',
      }),
    });

    expect(invalidJson).toEqual({
      ok: false,
      protocol: 'http',
      proxyUrl: 'http://127.0.0.1:8080',
      message: 'Exit probe returned invalid JSON for http://127.0.0.1:8080.',
      cause: expect.stringContaining('Unexpected token'),
    });
    expect(missingIp).toEqual({
      ok: false,
      protocol: 'http',
      proxyUrl: 'http://127.0.0.1:8080',
      message: 'Exit probe response for http://127.0.0.1:8080 did not include an ip field.',
    });
    expect(notMullvad).toEqual({
      ok: false,
      protocol: 'http',
      proxyUrl: 'http://127.0.0.1:8080',
      message: 'Exit probe for http://127.0.0.1:8080 did not report a Mullvad exit.',
    });
  });
});
