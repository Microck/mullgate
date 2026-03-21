import { mkdtempSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveMullgatePaths } from '../../src/config/paths.js';
import { CONFIG_VERSION, type MullgateConfig } from '../../src/config/schema.js';
import { renderRuntimeBundle } from '../../src/runtime/render-runtime-bundle.js';

const temporaryDirectories: string[] = [];

function createTempEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-runtime-bundle-'));
  temporaryDirectories.push(root);

  return {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

function createFixtureConfig(env: NodeJS.ProcessEnv): MullgateConfig {
  const paths = resolveMullgatePaths(env);
  const timestamp = '2026-03-20T18:48:01.000Z';
  const certPath = path.join(env.HOME!, 'certs', 'proxy.crt');
  const keyPath = path.join(env.HOME!, 'certs', 'proxy.key');

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
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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

    const compose = normalizePaths(await readFile(result.artifactPaths.dockerComposePath, 'utf8'), env);
    const httpsSidecarConfig = await readFile(result.artifactPaths.httpsSidecarConfigPath, 'utf8');
    const manifest = normalizePaths(await readFile(result.artifactPaths.manifestPath, 'utf8'), env);
    const composeStats = statSync(result.artifactPaths.dockerComposePath);
    const manifestStats = statSync(result.artifactPaths.manifestPath);

    expect(composeStats.mode & 0o777).toBe(0o600);
    expect(manifestStats.mode & 0o777).toBe(0o600);

    expect('\n' + compose).toMatchInlineSnapshot(`
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
      - cat /run/mullgate/tls-input/cert.pem /run/mullgate/tls-input/key.pem > /run/mullgate/tls/haproxy.pem && exec haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg
    tmpfs:
      - /run/mullgate/tls
    volumes:
      - /tmp/mullgate-home/state/mullgate/runtime/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - /tmp/mullgate-home/certs/proxy.crt:/run/mullgate/tls-input/cert.pem:ro
      - /tmp/mullgate-home/certs/proxy.key:/run/mullgate/tls-input/key.pem:ro
    ports:
      - \"127.0.0.1:1080:1080\"
      - \"127.0.0.1:8080:8080\"
      - \"127.0.0.1:8443:8443\"
      - \"127.0.0.2:1080:1080\"
      - \"127.0.0.2:8080:8080\"
      - \"127.0.0.2:8443:8443\"
  wireproxy-se-got-wg-101:
    image: backplane/wireproxy:20260320
    user: \"0:0\"
    restart: unless-stopped
    command:
      - --config
      - /etc/wireproxy/wireproxy.conf
    volumes:
      - /tmp/mullgate-home/state/mullgate/runtime/wireproxy-se-got-wg-101.conf:/etc/wireproxy/wireproxy.conf:ro
  wireproxy-at-vie-wg-001:
    image: backplane/wireproxy:20260320
    user: \"0:0\"
    restart: unless-stopped
    command:
      - --config
      - /etc/wireproxy/wireproxy.conf
    volumes:
      - /tmp/mullgate-home/state/mullgate/runtime/wireproxy-at-vie-wg-001.conf:/etc/wireproxy/wireproxy.conf:ro
"
`);
    expect('\n' + httpsSidecarConfig).toMatchInlineSnapshot(`
"\n# Generated by Mullgate. Derived artifact; edit canonical config instead.
global
  log stdout format raw local0

defaults
  log global
  mode tcp
  timeout connect 10s
  timeout client 1m
  timeout server 1m

frontend socks5_proxy
  bind 0.0.0.0:1080
  acl route_se_got_wg_101_socks5 dst 127.0.0.1
  use_backend route-se-got-wg-101-socks5 if route_se_got_wg_101_socks5
  acl route_at_vie_wg_001_socks5 dst 127.0.0.2
  use_backend route-at-vie-wg-001-socks5 if route_at_vie_wg_001_socks5
  default_backend route-se-got-wg-101-socks5

frontend http_proxy
  bind 0.0.0.0:8080
  acl route_se_got_wg_101_http dst 127.0.0.1
  use_backend route-se-got-wg-101-http if route_se_got_wg_101_http
  acl route_at_vie_wg_001_http dst 127.0.0.2
  use_backend route-at-vie-wg-001-http if route_at_vie_wg_001_http
  default_backend route-se-got-wg-101-http

frontend https_proxy
  bind 0.0.0.0:8443 ssl crt /run/mullgate/tls/haproxy.pem
  acl route_se_got_wg_101_https dst 127.0.0.1
  use_backend route-se-got-wg-101-https if route_se_got_wg_101_https
  acl route_at_vie_wg_001_https dst 127.0.0.2
  use_backend route-at-vie-wg-001-https if route_at_vie_wg_001_https
  default_backend route-se-got-wg-101-https

backend route-se-got-wg-101-socks5
  server se-got-wg-101 wireproxy-se-got-wg-101:1080 check

backend route-se-got-wg-101-http
  server se-got-wg-101 wireproxy-se-got-wg-101:8080 check

backend route-se-got-wg-101-https
  server se-got-wg-101 wireproxy-se-got-wg-101:8080 check

backend route-at-vie-wg-001-socks5
  server at-vie-wg-001 wireproxy-at-vie-wg-001:1080 check

backend route-at-vie-wg-001-http
  server at-vie-wg-001 wireproxy-at-vie-wg-001:8080 check

backend route-at-vie-wg-001-https
  server at-vie-wg-001 wireproxy-at-vie-wg-001:8080 check

"
`);
    expect('\n' + manifest).toMatchInlineSnapshot(`
"\n{
  \"generatedAt\": \"2026-03-20T18:55:00.000Z\",
  \"source\": \"canonical-config\",
  \"topology\": \"multi-route-wireproxy-haproxy\",
  \"relayCachePath\": \"/tmp/mullgate-home/cache/mullgate/relays.json\",
  \"images\": {
    \"wireproxy\": \"backplane/wireproxy:20260320\",
    \"routingLayer\": \"haproxytech/haproxy-alpine:3.0.19\"
  },
  \"services\": {
    \"routingLayer\": {
      \"name\": \"routing-layer\",
      \"listeners\": {
        \"socks5\": \"0.0.0.0:1080\",
        \"http\": \"0.0.0.0:8080\",
        \"https\": \"0.0.0.0:8443\"
      },
      \"publishedPorts\": [
        \"127.0.0.1:1080:1080\",
        \"127.0.0.1:8080:8080\",
        \"127.0.0.1:8443:8443\",
        \"127.0.0.2:1080:1080\",
        \"127.0.0.2:8080:8080\",
        \"127.0.0.2:8443:8443\"
      ],
      \"mountPaths\": {
        \"haproxyConfigPath\": \"/tmp/mullgate-home/state/mullgate/runtime/haproxy.cfg\",
        \"certPath\": \"/tmp/mullgate-home/certs/proxy.crt\",
        \"keyPath\": \"/tmp/mullgate-home/certs/proxy.key\",
        \"combinedPemPath\": \"/run/mullgate/tls/haproxy.pem\"
      }
    }
  },
  \"routes\": [
    {
      \"routeId\": \"se-got-wg-101\",
      \"alias\": \"sweden-gothenburg\",
      \"hostname\": \"se-got-wg-101\",
      \"bindIp\": \"127.0.0.1\",
      \"wireproxyConfigPath\": \"/tmp/mullgate-home/state/mullgate/runtime/wireproxy-se-got-wg-101.conf\",
      \"configTestReportPath\": \"/tmp/mullgate-home/state/mullgate/runtime/wireproxy-se-got-wg-101-configtest.json\",
      \"services\": {
        \"wireproxy\": {
          \"name\": \"wireproxy-se-got-wg-101\",
          \"internalListeners\": {
            \"socks5\": \"0.0.0.0:1080\",
            \"http\": \"0.0.0.0:8080\"
          }
        },
        \"backends\": {
          \"socks5\": \"route-se-got-wg-101-socks5\",
          \"http\": \"route-se-got-wg-101-http\",
          \"https\": \"route-se-got-wg-101-https\"
        }
      },
      \"publishedEndpoints\": [
        {
          \"routeId\": \"se-got-wg-101\",
          \"hostname\": \"se-got-wg-101\",
          \"bindIp\": \"127.0.0.1\",
          \"protocol\": \"socks5\",
          \"host\": \"se-got-wg-101\",
          \"port\": 1080,
          \"containerHost\": \"0.0.0.0\",
          \"containerPort\": 1080,
          \"auth\": {
            \"username\": \"alice\",
            \"password\": \"[redacted]\"
          },
          \"proxyUrl\": \"socks5://alice:[redacted]@se-got-wg-101:1080\",
          \"bindUrl\": \"socks5://alice:[redacted]@127.0.0.1:1080\"
        },
        {
          \"routeId\": \"se-got-wg-101\",
          \"hostname\": \"se-got-wg-101\",
          \"bindIp\": \"127.0.0.1\",
          \"protocol\": \"http\",
          \"host\": \"se-got-wg-101\",
          \"port\": 8080,
          \"containerHost\": \"0.0.0.0\",
          \"containerPort\": 8080,
          \"auth\": {
            \"username\": \"alice\",
            \"password\": \"[redacted]\"
          },
          \"proxyUrl\": \"http://alice:[redacted]@se-got-wg-101:8080\",
          \"bindUrl\": \"http://alice:[redacted]@127.0.0.1:8080\"
        },
        {
          \"routeId\": \"se-got-wg-101\",
          \"hostname\": \"se-got-wg-101\",
          \"bindIp\": \"127.0.0.1\",
          \"protocol\": \"https\",
          \"host\": \"se-got-wg-101\",
          \"port\": 8443,
          \"containerHost\": \"0.0.0.0\",
          \"containerPort\": 8443,
          \"auth\": {
            \"username\": \"alice\",
            \"password\": \"[redacted]\"
          },
          \"proxyUrl\": \"https://alice:[redacted]@se-got-wg-101:8443\",
          \"bindUrl\": \"https://alice:[redacted]@127.0.0.1:8443\"
        }
      ]
    },
    {
      \"routeId\": \"at-vie-wg-001\",
      \"alias\": \"austria-vienna\",
      \"hostname\": \"at-vie-wg-001\",
      \"bindIp\": \"127.0.0.2\",
      \"wireproxyConfigPath\": \"/tmp/mullgate-home/state/mullgate/runtime/wireproxy-at-vie-wg-001.conf\",
      \"configTestReportPath\": \"/tmp/mullgate-home/state/mullgate/runtime/wireproxy-at-vie-wg-001-configtest.json\",
      \"services\": {
        \"wireproxy\": {
          \"name\": \"wireproxy-at-vie-wg-001\",
          \"internalListeners\": {
            \"socks5\": \"0.0.0.0:1080\",
            \"http\": \"0.0.0.0:8080\"
          }
        },
        \"backends\": {
          \"socks5\": \"route-at-vie-wg-001-socks5\",
          \"http\": \"route-at-vie-wg-001-http\",
          \"https\": \"route-at-vie-wg-001-https\"
        }
      },
      \"publishedEndpoints\": [
        {
          \"routeId\": \"at-vie-wg-001\",
          \"hostname\": \"at-vie-wg-001\",
          \"bindIp\": \"127.0.0.2\",
          \"protocol\": \"socks5\",
          \"host\": \"at-vie-wg-001\",
          \"port\": 1080,
          \"containerHost\": \"0.0.0.0\",
          \"containerPort\": 1080,
          \"auth\": {
            \"username\": \"alice\",
            \"password\": \"[redacted]\"
          },
          \"proxyUrl\": \"socks5://alice:[redacted]@at-vie-wg-001:1080\",
          \"bindUrl\": \"socks5://alice:[redacted]@127.0.0.2:1080\"
        },
        {
          \"routeId\": \"at-vie-wg-001\",
          \"hostname\": \"at-vie-wg-001\",
          \"bindIp\": \"127.0.0.2\",
          \"protocol\": \"http\",
          \"host\": \"at-vie-wg-001\",
          \"port\": 8080,
          \"containerHost\": \"0.0.0.0\",
          \"containerPort\": 8080,
          \"auth\": {
            \"username\": \"alice\",
            \"password\": \"[redacted]\"
          },
          \"proxyUrl\": \"http://alice:[redacted]@at-vie-wg-001:8080\",
          \"bindUrl\": \"http://alice:[redacted]@127.0.0.2:8080\"
        },
        {
          \"routeId\": \"at-vie-wg-001\",
          \"hostname\": \"at-vie-wg-001\",
          \"bindIp\": \"127.0.0.2\",
          \"protocol\": \"https\",
          \"host\": \"at-vie-wg-001\",
          \"port\": 8443,
          \"containerHost\": \"0.0.0.0\",
          \"containerPort\": 8443,
          \"auth\": {
            \"username\": \"alice\",
            \"password\": \"[redacted]\"
          },
          \"proxyUrl\": \"https://alice:[redacted]@at-vie-wg-001:8443\",
          \"bindUrl\": \"https://alice:[redacted]@127.0.0.2:8443\"
        }
      ]
    }
  ],
  \"publishedEndpoints\": [
    {
      \"routeId\": \"se-got-wg-101\",
      \"hostname\": \"se-got-wg-101\",
      \"bindIp\": \"127.0.0.1\",
      \"protocol\": \"socks5\",
      \"host\": \"se-got-wg-101\",
      \"port\": 1080,
      \"containerHost\": \"0.0.0.0\",
      \"containerPort\": 1080,
      \"auth\": {
        \"username\": \"alice\",
        \"password\": \"[redacted]\"
      },
      \"proxyUrl\": \"socks5://alice:[redacted]@se-got-wg-101:1080\",
      \"bindUrl\": \"socks5://alice:[redacted]@127.0.0.1:1080\"
    },
    {
      \"routeId\": \"se-got-wg-101\",
      \"hostname\": \"se-got-wg-101\",
      \"bindIp\": \"127.0.0.1\",
      \"protocol\": \"http\",
      \"host\": \"se-got-wg-101\",
      \"port\": 8080,
      \"containerHost\": \"0.0.0.0\",
      \"containerPort\": 8080,
      \"auth\": {
        \"username\": \"alice\",
        \"password\": \"[redacted]\"
      },
      \"proxyUrl\": \"http://alice:[redacted]@se-got-wg-101:8080\",
      \"bindUrl\": \"http://alice:[redacted]@127.0.0.1:8080\"
    },
    {
      \"routeId\": \"se-got-wg-101\",
      \"hostname\": \"se-got-wg-101\",
      \"bindIp\": \"127.0.0.1\",
      \"protocol\": \"https\",
      \"host\": \"se-got-wg-101\",
      \"port\": 8443,
      \"containerHost\": \"0.0.0.0\",
      \"containerPort\": 8443,
      \"auth\": {
        \"username\": \"alice\",
        \"password\": \"[redacted]\"
      },
      \"proxyUrl\": \"https://alice:[redacted]@se-got-wg-101:8443\",
      \"bindUrl\": \"https://alice:[redacted]@127.0.0.1:8443\"
    },
    {
      \"routeId\": \"at-vie-wg-001\",
      \"hostname\": \"at-vie-wg-001\",
      \"bindIp\": \"127.0.0.2\",
      \"protocol\": \"socks5\",
      \"host\": \"at-vie-wg-001\",
      \"port\": 1080,
      \"containerHost\": \"0.0.0.0\",
      \"containerPort\": 1080,
      \"auth\": {
        \"username\": \"alice\",
        \"password\": \"[redacted]\"
      },
      \"proxyUrl\": \"socks5://alice:[redacted]@at-vie-wg-001:1080\",
      \"bindUrl\": \"socks5://alice:[redacted]@127.0.0.2:1080\"
    },
    {
      \"routeId\": \"at-vie-wg-001\",
      \"hostname\": \"at-vie-wg-001\",
      \"bindIp\": \"127.0.0.2\",
      \"protocol\": \"http\",
      \"host\": \"at-vie-wg-001\",
      \"port\": 8080,
      \"containerHost\": \"0.0.0.0\",
      \"containerPort\": 8080,
      \"auth\": {
        \"username\": \"alice\",
        \"password\": \"[redacted]\"
      },
      \"proxyUrl\": \"http://alice:[redacted]@at-vie-wg-001:8080\",
      \"bindUrl\": \"http://alice:[redacted]@127.0.0.2:8080\"
    },
    {
      \"routeId\": \"at-vie-wg-001\",
      \"hostname\": \"at-vie-wg-001\",
      \"bindIp\": \"127.0.0.2\",
      \"protocol\": \"https\",
      \"host\": \"at-vie-wg-001\",
      \"port\": 8443,
      \"containerHost\": \"0.0.0.0\",
      \"containerPort\": 8443,
      \"auth\": {
        \"username\": \"alice\",
        \"password\": \"[redacted]\"
      },
      \"proxyUrl\": \"https://alice:[redacted]@at-vie-wg-001:8443\",
      \"bindUrl\": \"https://alice:[redacted]@127.0.0.2:8443\"
    }
  ]
}
"
`);
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
      message: 'HTTPS runtime bundle rendering requires both certificate and key paths in the canonical config.',
      artifactPath: config.setup.https.certPath,
    });
  });
});
