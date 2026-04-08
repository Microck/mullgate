import { describe, expect, it } from 'vitest';
import {
  planRuntimeProxyArtifacts,
  renderRuntimeProxyArtifacts,
} from '../../src/runtime/render-runtime-proxies.js';
import {
  ENTRY_TUNNEL_SERVICE,
  ENTRY_WIREPROXY_HTTP_PORT,
  ENTRY_WIREPROXY_SOCKS_PORT,
  planWireproxyArtifacts,
  ROUTE_PROXY_SERVICE,
  renderWireproxyArtifacts,
} from '../../src/runtime/render-wireproxy.js';

describe('render-wireproxy compatibility exports', () => {
  it('re-exports runtime proxy symbols through the legacy wireproxy module', () => {
    expect(planWireproxyArtifacts).toBe(planRuntimeProxyArtifacts);
    expect(renderWireproxyArtifacts).toBe(renderRuntimeProxyArtifacts);

    expect({
      entryTunnelService: ENTRY_TUNNEL_SERVICE,
      routeProxyService: ROUTE_PROXY_SERVICE,
      socksPort: ENTRY_WIREPROXY_SOCKS_PORT,
      httpPort: ENTRY_WIREPROXY_HTTP_PORT,
    }).toEqual({
      entryTunnelService: 'entry-tunnel',
      routeProxyService: 'route-proxy',
      socksPort: 39101,
      httpPort: 39102,
    });
  });
});
