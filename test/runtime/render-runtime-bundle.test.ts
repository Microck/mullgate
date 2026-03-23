import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveMullgatePaths } from '../../src/config/paths.js';
import { CONFIG_VERSION, type MullgateConfig } from '../../src/config/schema.js';
import { planRuntimeBundle, renderRuntimeBundle } from '../../src/runtime/render-runtime-bundle.js';

const temporaryDirectories: string[] = [];
const windowsFixturePrefixes = [
  'C:\\Users\\alice\\AppData\\Local\\mullgate',
  'C:\\Users\\alice\\AppData\\Roaming\\mullgate',
] as const;

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-runtime-bundle-'));
  temporaryDirectories.push(root);

  return {
    ...process.env,
    MULLGATE_PLATFORM: 'linux',
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

function createPlatformEnvironment(platform: 'macos' | 'windows'): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), `mullgate-runtime-bundle-${platform}-`));
  temporaryDirectories.push(root);

  if (platform === 'windows') {
    cleanupWindowsFixturePaths();

    return {
      ...process.env,
      MULLGATE_PLATFORM: 'windows',
      USERPROFILE: 'C:\\Users\\alice',
      APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      HOME: undefined,
      XDG_CONFIG_HOME: undefined,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: undefined,
      TMPDIR: root,
    };
  }

  return {
    ...process.env,
    MULLGATE_PLATFORM: 'macos',
    HOME: '/Users/alice',
    XDG_CONFIG_HOME: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CACHE_HOME: undefined,
    TMPDIR: root,
  };
}

function cleanupWindowsFixturePaths(): void {
  readdirSync('.').forEach((entry) => {
    if (!windowsFixturePrefixes.some((prefix) => entry.startsWith(prefix))) {
      return;
    }

    rmSync(entry, { recursive: true, force: true });
  });
}

function createFixtureConfig(env: NodeJS.ProcessEnv): MullgateConfig {
  const paths = resolveMullgatePaths(env);
  const timestamp = '2026-03-20T18:48:01.000Z';
  const certPath = path.join(paths.appStateDir, 'certs', 'proxy.crt');
  const keyPath = path.join(paths.appStateDir, 'certs', 'proxy.key');

  return {
    version: CONFIG_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    setup: {
      source: 'guided-setup',
      bind: {
        host: '127.0.0.1',
        socksPort: 1080,
        httpPort: 8080,
        httpsPort: 8443,
      },
      auth: {
        username: 'alice',
        password: 'super-secret-password',
      },
      exposure: {
        mode: 'loopback',
        allowLan: false,
        baseDomain: null,
      },
      location: {
        requested: 'sweden-gothenburg',
        country: 'se',
        city: 'got',
        hostnameLabel: 'se-got-wg-101',
        resolvedAlias: 'sweden-gothenburg',
      },
      https: {
        enabled: true,
        certPath,
        keyPath,
      },
    },
    mullvad: {
      accountNumber: '123456789012',
      deviceName: 'mullgate-runtime-test-1',
      lastProvisionedAt: timestamp,
      relayConstraints: {
        providers: [],
      },
      wireguard: {
        publicKey: 'public-key-value-1',
        privateKey: 'private-key-value-1',
        ipv4Address: '10.64.12.34/32',
        ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1234/128',
        gatewayIpv4: '10.64.0.1',
        gatewayIpv6: 'fc00:bbbb:bbbb:bb01::1',
        dnsServers: ['10.64.0.1'],
        peerPublicKey: 'peer-public-key-value-1',
        peerEndpoint: 'se-got-wg-101.relays.mullvad.net:3401',
      },
    },
    routing: {
      locations: [
        {
          alias: 'sweden-gothenburg',
          hostname: 'se-got-wg-101',
          bindIp: '127.0.0.1',
          relayPreference: {
            requested: 'sweden-gothenburg',
            country: 'se',
            city: 'got',
            hostnameLabel: 'se-got-wg-101',
            resolvedAlias: 'sweden-gothenburg',
          },
          mullvad: {
            accountNumber: '123456789012',
            deviceName: 'mullgate-runtime-test-1',
            lastProvisionedAt: timestamp,
            relayConstraints: {
              providers: [],
            },
            wireguard: {
              publicKey: 'public-key-value-1',
              privateKey: 'private-key-value-1',
              ipv4Address: '10.64.12.34/32',
              ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1234/128',
              gatewayIpv4: '10.64.0.1',
              gatewayIpv6: 'fc00:bbbb:bbbb:bb01::1',
              dnsServers: ['10.64.0.1'],
              peerPublicKey: 'peer-public-key-value-1',
              peerEndpoint: 'se-got-wg-101.relays.mullvad.net:3401',
            },
          },
          runtime: {
            routeId: 'se-got-wg-101',
            wireproxyServiceName: 'wireproxy-se-got-wg-101',
            haproxyBackendName: 'route-se-got-wg-101',
            wireproxyConfigFile: 'wireproxy-se-got-wg-101.conf',
          },
        },
        {
          alias: 'austria-vienna',
          hostname: 'at-vie-wg-001',
          bindIp: '127.0.0.2',
          relayPreference: {
            requested: 'austria-vienna',
            country: 'at',
            city: 'vie',
            hostnameLabel: 'at-vie-wg-001',
            resolvedAlias: 'austria-vienna',
          },
          mullvad: {
            accountNumber: '123456789012',
            deviceName: 'mullgate-runtime-test-2',
            lastProvisionedAt: timestamp,
            relayConstraints: {
              providers: [],
            },
            wireguard: {
              publicKey: 'public-key-value-2',
              privateKey: 'private-key-value-2',
              ipv4Address: '10.64.12.35/32',
              ipv6Address: 'fc00:bbbb:bbbb:bb01::1:1235/128',
              gatewayIpv4: '10.64.0.1',
              gatewayIpv6: 'fc00:bbbb:bbbb:bb01::1',
              dnsServers: ['10.64.0.1'],
              peerPublicKey: 'peer-public-key-value-2',
              peerEndpoint: 'at-vie-wg-001.relays.mullvad.net:51820',
            },
          },
          runtime: {
            routeId: 'at-vie-wg-001',
            wireproxyServiceName: 'wireproxy-at-vie-wg-001',
            haproxyBackendName: 'route-at-vie-wg-001',
            wireproxyConfigFile: 'wireproxy-at-vie-wg-001.conf',
          },
        },
      ],
    },
    runtime: {
      backend: 'wireproxy',
      sourceConfigPath: paths.configFile,
      wireproxyConfigPath: paths.wireproxyConfigFile,
      wireproxyConfigTestReportPath: paths.wireproxyConfigTestReportFile,
      relayCachePath: paths.provisioningCacheFile,
      dockerComposePath: paths.dockerComposePath,
      runtimeBundle: {
        bundleDir: paths.runtimeBundleDir,
        dockerComposePath: paths.runtimeComposeFile,
        httpsSidecarConfigPath: paths.runtimeHttpsSidecarConfigFile,
        manifestPath: paths.runtimeBundleManifestFile,
      },
      status: {
        phase: 'validated',
        lastCheckedAt: timestamp,
        message: 'Fixture config already validated.',
      },
    },
    diagnostics: {
      lastRuntimeStartReportPath: paths.runtimeStartDiagnosticsFile,
      lastRuntimeStart: null,
    },
  };
}

function normalizePaths(value: string, env: NodeJS.ProcessEnv): string {
  return value.split(env.HOME!).join('/tmp/mullgate-home');
}

afterEach(async () => {
  cleanupWindowsFixturePaths();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('renderRuntimeBundle', () => {
  it('renders a multi-route compose bundle, HAProxy router config, and manifest from canonical settings', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const config = createFixtureConfig(env);

    const result = await renderRuntimeBundle({
      config,
      paths,
      generatedAt: '2026-03-20T18:55:00.000Z',
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const compose = normalizePaths(
      await readFile(result.artifactPaths.dockerComposePath, 'utf8'),
      env,
    );
    const httpsSidecarConfig = await readFile(result.artifactPaths.httpsSidecarConfigPath, 'utf8');
    const manifest = normalizePaths(await readFile(result.artifactPaths.manifestPath, 'utf8'), env);
    const composeStats = statSync(result.artifactPaths.dockerComposePath);
    const manifestStats = statSync(result.artifactPaths.manifestPath);

    expect(composeStats.mode & 0o777).toBe(0o600);
    expect(manifestStats.mode & 0o777).toBe(0o600);
    expect(manifest).not.toContain('super-secret-password');
    expect(manifest).not.toContain('alice');

    expect(`\n${compose}`).toMatchInlineSnapshot(`
"\n# Generated by Mullgate. Derived artifact; edit canonical config instead.
name: mullgate
services:
  routing-layer:
    image: haproxytech/haproxy-alpine:3.0.19
    restart: unless-stopped
    depends_on:
      - wireproxy-se-got-wg-101
      - wireproxy-at-vie-wg-001
    entrypoint:
      - /bin/sh
      - -ec
      - cat /run/mullgate-cert.pem /run/mullgate-key.pem > /run/mullgate/tls/haproxy.pem && exec haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg
    tmpfs:
      - /run/mullgate/tls
    network_mode: host
    volumes:
      - /tmp/mullgate-home/state/mullgate/runtime/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - /tmp/mullgate-home/state/mullgate/certs/proxy.crt:/run/mullgate-cert.pem:ro
      - /tmp/mullgate-home/state/mullgate/certs/proxy.key:/run/mullgate-key.pem:ro
  wireproxy-se-got-wg-101:
    image: backplane/wireproxy:20260320
    user: "0:0"
    network_mode: host
    restart: unless-stopped
    command:
      - --config
      - /etc/wireproxy/wireproxy.conf
    volumes:
      - /tmp/mullgate-home/state/mullgate/runtime/wireproxy-se-got-wg-101.conf:/etc/wireproxy/wireproxy.conf:ro
  wireproxy-at-vie-wg-001:
    image: backplane/wireproxy:20260320
    user: "0:0"
    network_mode: host
    restart: unless-stopped
    command:
      - --config
      - /etc/wireproxy/wireproxy.conf
    volumes:
      - /tmp/mullgate-home/state/mullgate/runtime/wireproxy-at-vie-wg-001.conf:/etc/wireproxy/wireproxy.conf:ro
"
`);
    expect(`\n${httpsSidecarConfig}`).toMatchInlineSnapshot(`
"\n# Generated by Mullgate. Derived artifact; edit canonical config instead.
global
  log stdout format raw local0

defaults
  log global
  mode tcp
  timeout connect 10s
  timeout client 1m
  timeout server 1m

frontend https_proxy
  bind 0.0.0.0:8443 ssl crt /run/mullgate/tls/haproxy.pem
  acl route_se_got_wg_101_https dst 127.0.0.1
  use_backend route-se-got-wg-101-https if route_se_got_wg_101_https
  acl route_at_vie_wg_001_https dst 127.0.0.2
  use_backend route-at-vie-wg-001-https if route_at_vie_wg_001_https
  default_backend route-se-got-wg-101-https

backend route-se-got-wg-101-https
  server se-got-wg-101 127.0.0.1:8080 check

backend route-at-vie-wg-001-https
  server at-vie-wg-001 127.0.0.2:8080 check

"
`);

    const parsedManifest = JSON.parse(manifest) as {
      exposure: {
        posture: {
          recommendation: string;
          modeLabel: string;
        };
        guidance: string[];
        remediation: {
          bindPosture: string;
          hostnameResolution: string;
          restart: string;
        };
      };
      platform: {
        platform: string;
        posture: {
          supportLevel: string;
          modeLabel: string;
        };
        surfaces: {
          configPaths: string;
          configWorkflow: string;
          runtimeArtifacts: string;
          runtimeExecution: string;
          diagnostics: string;
        };
        hostNetworking: {
          support: string;
          modeLabel: string;
        };
        warnings: Array<{ code: string }>;
      };
      services: {
        routingLayer: {
          listeners: {
            socks5: string | null;
            http: string | null;
            https: string | null;
          };
        };
      };
      routes: Array<{
        services: {
          backends: {
            socks5: string | null;
            http: string | null;
            https: string | null;
          };
        };
      }>;
    };

    expect(parsedManifest.services.routingLayer.listeners).toEqual({
      socks5: null,
      http: null,
      https: 'per-route bind IPs on port 8443',
    });
    expect(parsedManifest.exposure.posture).toEqual({
      recommendation: 'local-default',
      modeLabel: 'Loopback / local-only',
      summary:
        'Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.',
      remoteStory:
        'Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.',
    });
    expect(parsedManifest.exposure.guidance).toEqual([
      'Loopback mode is the default local-only posture. Keep it for same-machine use and developer/operator checks.',
      'Use `mullgate config hosts` if you want a copy/paste /etc/hosts block for this machine.',
    ]);
    expect(parsedManifest.exposure.remediation).toEqual({
      bindPosture:
        'Keep loopback mode on local-only bind IPs. If you need remote access, rerun `mullgate config exposure --mode private-network ...` with one trusted-network bind IP per route.',
      hostnameResolution:
        'For local host-file testing, use `mullgate config hosts` and apply the emitted block on this machine so each route hostname resolves to its saved loopback bind IP.',
      restart:
        'After changing exposure settings, rerun `mullgate config validate` or `mullgate start` so the runtime artifacts match the saved local-only posture.',
    });
    expect(parsedManifest.platform).toEqual({
      platform: 'linux',
      platformSource: 'env:MULLGATE_PLATFORM',
      pathSources: {
        configHome: 'env:XDG_CONFIG_HOME',
        stateHome: 'env:XDG_STATE_HOME',
        cacheHome: 'env:XDG_CACHE_HOME',
      },
      paths: {
        configHome: '/tmp/mullgate-home/config',
        stateHome: '/tmp/mullgate-home/state',
        cacheHome: '/tmp/mullgate-home/cache',
        appConfigDir: '/tmp/mullgate-home/config/mullgate',
        appStateDir: '/tmp/mullgate-home/state/mullgate',
        appCacheDir: '/tmp/mullgate-home/cache/mullgate',
        runtimeDir: '/tmp/mullgate-home/state/mullgate/runtime',
        runtimeBundleDir: '/tmp/mullgate-home/state/mullgate/runtime',
        runtimeManifestPath: '/tmp/mullgate-home/state/mullgate/runtime/runtime-manifest.json',
      },
      posture: {
        supportLevel: 'full',
        modeLabel: 'Linux-first runtime support',
        summary:
          'Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.',
        runtimeStory:
          'Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.',
      },
      surfaces: {
        configPaths: 'supported',
        configWorkflow: 'supported',
        runtimeArtifacts: 'supported',
        runtimeExecution: 'supported',
        diagnostics: 'supported',
      },
      hostNetworking: {
        support: 'native',
        modeLabel: 'Native host networking available',
        summary:
          'Docker host networking behaves as expected on Linux, so the routing layer and per-route wireproxy listeners can bind directly to the saved route IPs.',
        remediation:
          'If runtime checks fail on Linux, inspect Docker Compose health, route bind IP ownership, and hostname-resolution drift before assuming the platform contract is wrong.',
      },
      guidance: [
        'Linux is the reference runtime target for the current Mullgate topology and verification flow.',
        'Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.',
      ],
      warnings: [],
    });
    expect(parsedManifest.routes.map((route) => route.services.backends)).toEqual([
      { socks5: null, http: null, https: 'route-se-got-wg-101-https' },
      { socks5: null, http: null, https: 'route-at-vie-wg-001-https' },
    ]);
  });

  it('serializes partial-support platform posture for Docker Desktop style platforms', async () => {
    const macosEnv = createPlatformEnvironment('macos');
    const macosPaths = resolveMullgatePaths(macosEnv);
    const macosConfig = createFixtureConfig(macosEnv);
    macosConfig.setup.bind.httpsPort = null;
    macosConfig.setup.https = { enabled: false };
    const macosResult = planRuntimeBundle({
      config: macosConfig,
      paths: macosPaths,
      generatedAt: '2026-03-20T18:57:00.000Z',
    });

    expect(macosResult.ok).toBe(true);

    if (!macosResult.ok) {
      return;
    }

    expect(macosResult.manifest.platform).toMatchObject({
      platform: 'macos',
      posture: {
        supportLevel: 'partial',
        modeLabel: 'macOS path + diagnostics support',
      },
      surfaces: {
        configPaths: 'supported',
        configWorkflow: 'supported',
        runtimeArtifacts: 'supported',
        runtimeExecution: 'limited',
        diagnostics: 'supported',
      },
      hostNetworking: {
        support: 'limited',
        modeLabel: 'Docker Desktop host networking is limited',
      },
    });
    expect(macosResult.manifest.platform.warnings.map((warning) => warning.code)).toEqual([
      'LINUX_RUNTIME_RECOMMENDED',
      'DOCKER_DESKTOP_HOST_NETWORKING_LIMITED',
    ]);

    const windowsEnv = createPlatformEnvironment('windows');
    const windowsPaths = resolveMullgatePaths(windowsEnv);
    const windowsConfig = createFixtureConfig(windowsEnv);
    windowsConfig.setup.bind.httpsPort = null;
    windowsConfig.setup.https = { enabled: false };
    const windowsResult = planRuntimeBundle({
      config: windowsConfig,
      paths: windowsPaths,
      generatedAt: '2026-03-20T18:57:30.000Z',
    });

    expect(windowsResult.ok).toBe(true);

    if (!windowsResult.ok) {
      return;
    }

    expect(windowsResult.manifest.platform).toMatchObject({
      platform: 'windows',
      posture: {
        supportLevel: 'partial',
        modeLabel: 'Windows path + diagnostics support',
      },
      hostNetworking: {
        support: 'limited',
        modeLabel: 'Docker Desktop host networking is limited',
      },
      paths: {
        configHome: 'C:\\Users\\alice\\AppData\\Roaming',
        stateHome: 'C:\\Users\\alice\\AppData\\Local',
        cacheHome: 'C:\\Users\\alice\\AppData\\Local',
      },
    });
  });

  it('records domain guidance and public single-route warnings in the manifest exposure contract', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const config = createFixtureConfig(env);

    config.setup.exposure = {
      mode: 'public',
      allowLan: true,
      baseDomain: 'proxy.example.com',
    };
    config.setup.bind.host = '198.51.100.10';
    config.routing.locations = [
      {
        ...config.routing.locations[0]!,
        alias: 'sweden-gothenburg',
        hostname: 'sweden-gothenburg.proxy.example.com',
        bindIp: '198.51.100.10',
      },
    ];
    config.runtime.status = {
      phase: 'unvalidated',
      lastCheckedAt: null,
      message:
        'Exposure settings changed; rerun `mullgate config validate` or `mullgate start` to refresh runtime artifacts.',
    };

    const result = await renderRuntimeBundle({
      config,
      paths,
      generatedAt: '2026-03-20T18:56:30.000Z',
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const exposure = result.manifest.exposure;
    expect(exposure.posture).toEqual({
      recommendation: 'advanced-remote',
      modeLabel: 'Advanced public exposure',
      summary:
        'Expert-only remote posture. Publicly routable listeners are possible, but Mullgate does not treat this as the default or safest operating mode.',
      remoteStory:
        'Prefer private-network mode unless you intentionally need internet-reachable listeners and can provide DNS, firewalling, monitoring, and host hardening yourself.',
    });
    expect(exposure.guidance).toEqual([
      'Public mode is advanced operator territory. Only use it when you intentionally want internet-reachable listeners and are prepared to harden the host around them.',
      'Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.',
      'Publish the DNS records below so every route hostname resolves to its matching bind IP.',
    ]);
    expect(exposure.remediation).toEqual({
      bindPosture:
        'Use public mode only with intentionally public, distinct bind IPs per route. If you are not deliberately publishing internet-reachable listeners, switch back to private-network mode.',
      hostnameResolution:
        'Publish DNS A records so every route hostname resolves to its saved public bind IP before expecting remote hostname access to work on the open internet.',
      restart:
        'After changing exposure or DNS-facing bind IPs, rerun `mullgate config validate` or `mullgate start` so runtime artifacts reflect the advanced public posture accurately.',
    });
    expect(exposure.warnings.map((warning) => warning.code)).toEqual([
      'DNS_REQUIRED',
      'PUBLIC_EXPOSURE',
      'SINGLE_ROUTE',
      'RUNTIME_UNVALIDATED',
    ]);
  });

  it('fails when HTTPS is requested without both TLS asset paths', async () => {
    const env = createTempEnvironment();
    const paths = resolveMullgatePaths(env);
    const config = createFixtureConfig(env);
    config.setup.https = { enabled: true, certPath: config.setup.https.certPath };

    const result = await renderRuntimeBundle({
      config,
      paths,
      generatedAt: '2026-03-20T18:56:00.000Z',
    });

    expect(result).toEqual({
      ok: false,
      phase: 'artifact-render',
      source: 'canonical-config',
      checkedAt: '2026-03-20T18:56:00.000Z',
      code: 'MISSING_HTTPS_CONFIG',
      message:
        'HTTPS runtime bundle rendering requires both certificate and key paths in the canonical config.',
      artifactPath: config.setup.https.certPath,
    });
  });
});
