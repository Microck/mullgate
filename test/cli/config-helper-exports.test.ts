import { describe, expect, it } from 'vitest';
import {
  createAuthenticatedEndpointUrl,
  extractOrderedCommandArgs,
  extractProxyExportArgs,
  parseRelayOwnerFilter,
  parseRelayRunModeFilter,
  renderLoadConfigError,
  renderMissingConfigError,
} from '../../src/commands/config.js';
import type { MullgateConfig } from '../../src/config/schema.js';

describe('config exported helper functions', () => {
  it('extracts ordered command arguments for nested command paths', () => {
    expect(
      extractOrderedCommandArgs({
        argv: ['node', 'cli.js', 'proxy', 'export', '--country', 'se'],
        commandPath: ['proxy', 'export'],
      }),
    ).toEqual(['--country', 'se']);

    expect(
      extractOrderedCommandArgs({
        argv: ['node', 'cli.js', 'status'],
        commandPath: ['proxy', 'export'],
      }),
    ).toEqual([]);
  });

  it('extracts proxy export args from proxy, top-level, and config subcommands', () => {
    expect(
      extractProxyExportArgs(['node', 'cli.js', 'proxy', 'export', '--country', 'se']),
    ).toEqual(['--country', 'se']);
    expect(extractProxyExportArgs(['node', 'cli.js', 'export', '--region', 'europe'])).toEqual([
      '--region',
      'europe',
    ]);
    expect(
      extractProxyExportArgs(['node', 'cli.js', 'config', 'export', '--protocol', 'http']),
    ).toEqual(['--protocol', 'http']);
  });

  it('parses relay owner and run-mode filters', () => {
    expect(parseRelayOwnerFilter(' mullvad ')).toBe('mullvad');
    expect(parseRelayOwnerFilter('RENTED')).toBe('rented');
    expect(parseRelayRunModeFilter(' ram ')).toBe('ram');
    expect(parseRelayRunModeFilter('DISK')).toBe('disk');
  });

  it('rejects invalid relay owner and run-mode filters', () => {
    expect(() => parseRelayOwnerFilter('invalid')).toThrow(
      'Relay ownership "invalid" must be one of mullvad, rented, or all.',
    );
    expect(() => parseRelayRunModeFilter('invalid')).toThrow(
      'Relay run mode "invalid" must be one of ram, disk, or all.',
    );
  });

  it('adds encoded credentials to authenticated endpoint urls', () => {
    expect(
      createAuthenticatedEndpointUrl(
        {
          setup: {
            source: 'guided-setup',
            bind: { host: '127.0.0.1', socksPort: 1080, httpPort: 8080, httpsPort: null },
            auth: {
              username: 'alice@example.com',
              password: 'space secret',
            },
            access: { mode: 'published-routes', allowUnsafePublicEmptyPassword: false },
            exposure: { mode: 'loopback', allowLan: false, baseDomain: null },
            location: { requested: 'se', resolvedAlias: null },
            https: { enabled: false },
          },
        } as Pick<MullgateConfig, 'setup'>,
        'https://proxy.example.com:8443/status?format=json',
      ),
    ).toBe('https://alice%40example.com:space%20secret@proxy.example.com:8443/status?format=json');
    expect(
      createAuthenticatedEndpointUrl(
        {
          setup: {
            source: 'guided-setup',
            bind: { host: '127.0.0.1', socksPort: 1080, httpPort: 8080, httpsPort: null },
            auth: {
              username: 'alice',
              password: 'secret',
            },
            access: { mode: 'published-routes', allowUnsafePublicEmptyPassword: false },
            exposure: { mode: 'loopback', allowLan: false, baseDomain: null },
            location: { requested: 'se', resolvedAlias: null },
            https: { enabled: false },
          },
        } as Pick<MullgateConfig, 'setup'>,
        'proxy.example.com:8443/status',
      ),
    ).toBe('proxy.example.com:8443/status');
  });

  it('renders documented load and missing-config errors', () => {
    expect(
      renderLoadConfigError({
        ok: false,
        phase: 'read-config',
        source: 'file',
        paths: {
          platform: 'linux',
          platformSource: 'env:MULLGATE_PLATFORM',
        } as never,
        artifactPath: '/tmp/mullgate/config.json',
        message: 'Permission denied.',
      }),
    ).toMatchInlineSnapshot(`
      "Failed to inspect Mullgate config.
      phase: read-config
      source: file
      artifact: /tmp/mullgate/config.json
      reason: Permission denied."
    `);

    expect(
      renderMissingConfigError(
        'Config file does not exist yet. Run `mullgate setup` first.',
        '/tmp/mullgate/config.json',
      ),
    ).toMatchInlineSnapshot(`
      "Mullgate config command could not continue.
      phase: load-config
      source: empty
      artifact: /tmp/mullgate/config.json
      reason: Config file does not exist yet. Run \`mullgate setup\` first."
    `);
  });
});
