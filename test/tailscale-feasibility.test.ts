import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { MullvadRelayCatalog } from '../src/mullvad/fetch-relays.js';
import {
  parseTailscaleFeasibilityArgs,
  renderTailscaleFeasibilityHelp,
  runTailscaleFeasibilityVerifier,
  selectTailscaleProbeRelays,
  type TailscaleFeasibilityArtifact,
} from '../src/tailscale/feasibility-runner.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function createTempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createCatalog(): MullvadRelayCatalog {
  return {
    source: 'www-relays-all',
    fetchedAt: '2026-06-14T00:00:00.000Z',
    endpoint: 'fixture://relays',
    relayCount: 4,
    countries: [],
    relays: [
      createRelay('se-got-wg-101', 'se', 'got', '10.124.0.20'),
      createRelay('se-got-wg-102', 'se', 'got', '10.124.0.21'),
      createRelay('at-vie-wg-001', 'at', 'vie', '10.124.0.22'),
      createRelay('us-nyc-wg-001', 'us', 'nyc', '10.124.0.23'),
    ],
  };
}

function createRelay(
  hostname: string,
  countryCode: string,
  cityCode: string,
  socksInternalIp: string,
): MullvadRelayCatalog['relays'][number] {
  return {
    hostname,
    fqdn: `${hostname}.relays.mullvad.net`,
    source: 'www-relays-all',
    active: true,
    owned: true,
    publicKey: `public-key-${hostname}`,
    endpointIpv4: '203.0.113.10',
    socksName: `${hostname.replace('-wg-', '-wg-socks5-')}.relays.mullvad.net`,
    socksPort: 1080,
    socksInternalIp,
    location: {
      countryCode,
      countryName: countryCode.toUpperCase(),
      cityCode,
      cityName: cityCode.toUpperCase(),
    },
  };
}

function createPassingArtifact(): TailscaleFeasibilityArtifact {
  return {
    version: 1,
    generatedAt: '2026-06-14T00:00:00.000Z',
    mode: 'fixture',
    proof: 'one-tailscaled-direct-internal-socks',
    targetUrl: 'https://am.i.mullvad.net/json',
    requestedExitCount: 2,
    selectedRelays: [
      {
        relayHostname: 'se-got-wg-101',
        socksHostname: 'se-got-wg-socks5-101.relays.mullvad.net',
        socksInternalIp: '10.124.0.20',
      },
      {
        relayHostname: 'at-vie-wg-001',
        socksHostname: 'at-vie-wg-socks5-001.relays.mullvad.net',
        socksInternalIp: '10.124.0.22',
      },
    ],
    probes: [
      {
        ok: true,
        relayHostname: 'se-got-wg-101',
        socksInternalIp: '10.124.0.20',
        targetUrl: 'https://am.i.mullvad.net/json',
        observedExit: {
          ip: '185.213.154.217',
          country: 'Sweden',
          city: 'Gothenburg',
        },
      },
      {
        ok: true,
        relayHostname: 'at-vie-wg-001',
        socksInternalIp: '10.124.0.22',
        targetUrl: 'https://am.i.mullvad.net/json',
        observedExit: {
          ip: '185.65.134.10',
          country: 'Austria',
          city: 'Vienna',
        },
      },
    ],
    verdict: {
      ok: true,
      distinctObservedExitCount: 2,
      reason: 'passed',
    },
  };
}

describe('tailscale feasibility verifier', () => {
  it('parses CLI args and renders help', () => {
    expect(
      parseTailscaleFeasibilityArgs(
        [
          '--target-url',
          'https://example.test/exit.json',
          '--logical-exit-count',
          '2',
          '--output-root',
          '.tmp/tailscale-custom',
          '--fixture',
          './fixture.json',
          '--keep-workspace',
        ],
        {
          MULLGATE_MULLVAD_RELAYS_URL: ' https://relays.example.test ',
          MULLGATE_TAILSCALE_AUTH_KEY: ' tskey-auth-test ',
          MULLGATE_TAILSCALE_TAILNET: ' example.ts.net ',
          MULLGATE_TAILSCALE_PINNED_EXIT_NODE: ' fr-par-wg-001 ',
          MULLGATE_TAILSCALE_IMAGE: ' tailscale/tailscale:test ',
          MULLGATE_TAILSCALE_CURL_IMAGE: ' curlimages/curl:test ',
        },
      ),
    ).toEqual({
      ok: true,
      options: {
        targetUrl: 'https://example.test/exit.json',
        logicalExitCount: 2,
        outputRoot: '.tmp/tailscale-custom',
        fixturePath: './fixture.json',
        mullvadRelaysUrl: 'https://relays.example.test',
        authKey: 'tskey-auth-test',
        tailnet: 'example.ts.net',
        pinnedExitNode: 'fr-par-wg-001',
        tailscaleImage: 'tailscale/tailscale:test',
        curlImage: 'curlimages/curl:test',
        keepWorkspace: true,
      },
    });

    expect(parseTailscaleFeasibilityArgs(['--help'])).toEqual({
      ok: false,
      helpText: renderTailscaleFeasibilityHelp(),
      exitCode: 0,
    });
    expect(renderTailscaleFeasibilityHelp()).toContain(
      'Run the Tailscale exit-source feasibility verifier.',
    );
  });

  it('selects distinct-city relays that have resolved internal SOCKS IPs', () => {
    expect(
      selectTailscaleProbeRelays(createCatalog(), 3).map((relay) => ({
        hostname: relay.hostname,
        socksInternalIp: relay.socksInternalIp,
      })),
    ).toEqual([
      { hostname: 'se-got-wg-101', socksInternalIp: '10.124.0.20' },
      { hostname: 'at-vie-wg-001', socksInternalIp: '10.124.0.22' },
      { hostname: 'us-nyc-wg-001', socksInternalIp: '10.124.0.23' },
    ]);
  });

  it('replays fixture artifacts and writes summary files', async () => {
    const root = createTempDir('mullgate-tailscale-feasibility-');
    const fixturePath = path.join(root, 'fixture.json');
    const outputRoot = path.join(root, 'out');
    await writeFile(fixturePath, `${JSON.stringify(createPassingArtifact(), null, 2)}\n`, 'utf8');

    const result = await runTailscaleFeasibilityVerifier({
      targetUrl: 'https://am.i.mullvad.net/json',
      logicalExitCount: 2,
      outputRoot,
      fixturePath,
      tailscaleImage: 'tailscale/tailscale:test',
      curlImage: 'curlimages/curl:test',
      keepWorkspace: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.artifact.verdict).toEqual({
      ok: true,
      distinctObservedExitCount: 2,
      reason: 'passed',
    });
    expect(await readFile(result.summaryTextPath, 'utf8')).toContain(
      'Tailscale exit-source feasibility verdict: PASS',
    );
    expect(JSON.parse(await readFile(result.summaryJsonPath, 'utf8'))).toMatchObject({
      proof: 'one-tailscaled-direct-internal-socks',
      verdict: { ok: true },
    });
  });

  it('fails live mode before network work when Tailscale credentials are incomplete', async () => {
    const root = createTempDir('mullgate-tailscale-feasibility-');

    const result = await runTailscaleFeasibilityVerifier({
      targetUrl: 'https://am.i.mullvad.net/json',
      logicalExitCount: 2,
      outputRoot: path.join(root, 'out'),
      tailscaleImage: 'tailscale/tailscale:test',
      curlImage: 'curlimages/curl:test',
      keepWorkspace: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.preservedWorkspace).toBe(false);
    expect(result.artifact.verdict).toEqual({
      ok: false,
      distinctObservedExitCount: 0,
      reason: 'prerequisite-failure',
    });
    expect(result.artifact.probes[0]?.message).toContain('MULLGATE_TAILSCALE_AUTH_KEY');
  });
});
