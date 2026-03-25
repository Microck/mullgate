import { describe, expect, it } from 'vitest';

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
});
