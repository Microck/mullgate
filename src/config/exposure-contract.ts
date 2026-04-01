import { isIP } from 'node:net';

import { requireDefined } from '../required.js';
import { REDACTED } from './redact.js';
import type { AccessMode, ExposureMode, MullgateConfig } from './schema.js';

const HTTPS_DEFAULT_PORT = 8443;
const PRIVATE_NETWORK_LISTEN_HOST = '0.0.0.0';
const PRIVATE_NETWORK_BACKEND_HOST = '127.0.0.1';

type ExposureProtocol = 'socks5' | 'http' | 'https';

type ExposurePort = {
  readonly protocol: ExposureProtocol;
  readonly port: number;
};

export type ExposureValidationFailure = {
  readonly ok: false;
  readonly phase: 'setup-validation';
  readonly source: 'input';
  readonly code: string;
  readonly message: string;
  readonly cause?: string;
  readonly artifactPath: string;
};

export type ExposureValidationSuccess = {
  readonly ok: true;
  readonly mode: ExposureMode;
  readonly baseDomain: string | null;
  readonly bindHost: string;
  readonly routeBindIps: readonly [string, ...string[]];
};

export type ExposureValidationResult = ExposureValidationSuccess | ExposureValidationFailure;

export type ExposureEndpoint = {
  readonly protocol: ExposureProtocol;
  readonly port: number;
  readonly hostnameUrl: string;
  readonly bindUrl: string;
  readonly redactedHostnameUrl: string;
  readonly redactedBindUrl: string;
  readonly authRequired: true;
};

export type ExposureRouteContract = {
  readonly index: number;
  readonly alias: string;
  readonly routeId: string;
  readonly hostname: string;
  readonly bindIp: string;
  readonly dnsRecord: string | null;
  readonly endpoints: readonly ExposureEndpoint[];
};

export type InlineSelectorExample = {
  readonly selector: string;
  readonly targetLabel: string;
  readonly endpoints: readonly ExposureEndpoint[];
  readonly guaranteedUrl: string;
  readonly bestEffortUrl: string;
};

export type ExposureWarning = {
  readonly code:
    | 'LOOPBACK_ONLY'
    | 'DNS_REQUIRED'
    | 'PUBLIC_EXPOSURE'
    | 'SINGLE_ROUTE'
    | 'RUNTIME_UNVALIDATED'
    | 'INLINE_SELECTOR_PUBLIC_EMPTY_PASSWORD';
  readonly severity: 'info' | 'warning';
  readonly message: string;
};

export type ExposureContract = {
  readonly mode: ExposureMode;
  readonly accessMode: AccessMode;
  readonly allowLan: boolean;
  readonly baseDomain: string | null;
  readonly ports: readonly ExposurePort[];
  readonly routes: readonly ExposureRouteContract[];
  readonly dnsRecords: readonly string[];
  readonly inlineSelector: null | {
    readonly sharedHost: string;
    readonly listenerHost: string;
    readonly selectorField: 'username';
    readonly syntax: {
      readonly guaranteed: string;
      readonly bestEffort: string;
    };
    readonly examples: readonly InlineSelectorExample[];
  };
  readonly posture: {
    readonly recommendation: 'local-default' | 'recommended-remote' | 'advanced-remote';
    readonly modeLabel: string;
    readonly summary: string;
    readonly remoteStory: string;
  };
  readonly guidance: readonly string[];
  readonly remediation: {
    readonly bindPosture: string;
    readonly hostnameResolution: string;
    readonly restart: string;
  };
  readonly warnings: readonly ExposureWarning[];
  readonly runtimeStatus: {
    readonly phase: MullgateConfig['runtime']['status']['phase'];
    readonly message: string | null;
    readonly restartRequired: boolean;
  };
};

export type AccessValidationResult = { readonly ok: true } | ExposureValidationFailure;

export function computePublishedPort(
  exposureMode: ExposureMode,
  basePort: number,
  routeIndex: number,
): number {
  return exposureMode === 'private-network' ? basePort + routeIndex : basePort;
}

export function usesInlineSelectorAccess(config: Pick<MullgateConfig, 'setup'>): boolean {
  return config.setup.access.mode === 'inline-selector';
}

export function deriveInlineSelectorBindHost(config: Pick<MullgateConfig, 'setup'>): string {
  return config.setup.bind.host;
}

export function validateAccessSettings(input: {
  readonly exposureMode: ExposureMode;
  readonly accessMode: AccessMode;
  readonly password: string;
  readonly allowUnsafePublicEmptyPassword: boolean;
  readonly artifactPath: string;
}): AccessValidationResult {
  if (
    input.exposureMode === 'public' &&
    input.accessMode === 'inline-selector' &&
    input.password.length === 0 &&
    !input.allowUnsafePublicEmptyPassword
  ) {
    return {
      ok: false,
      phase: 'setup-validation',
      source: 'input',
      code: 'UNSAFE_PUBLIC_INLINE_SELECTOR_EMPTY_PASSWORD',
      message:
        'Public inline-selector access with an empty password is blocked unless the unsafe override is enabled.',
      cause:
        'Set setup.access.allowUnsafePublicEmptyPassword=true or choose a non-empty proxy password before exposing selector-driven listeners on a public host.',
      artifactPath: input.artifactPath,
    };
  }

  return { ok: true };
}

export function deriveRuntimeListenerHost(exposureMode: ExposureMode, bindIp: string): string {
  return exposureMode === 'private-network' ? PRIVATE_NETWORK_LISTEN_HOST : bindIp;
}

export function deriveRuntimeBackendHost(exposureMode: ExposureMode, bindIp: string): string {
  return exposureMode === 'private-network' ? PRIVATE_NETWORK_BACKEND_HOST : bindIp;
}

export function buildExposureContract(config: MullgateConfig): ExposureContract {
  const ports = collectExposurePorts(config);
  const inlineSelectorEnabled = usesInlineSelectorAccess(config);
  const routes = inlineSelectorEnabled
    ? []
    : config.routing.locations.map((route, index) => ({
        index,
        alias: route.alias,
        routeId: route.runtime.routeId,
        hostname: route.hostname,
        bindIp: route.bindIp,
        dnsRecord: config.setup.exposure.baseDomain ? `${route.hostname} A ${route.bindIp}` : null,
        endpoints: ports.map((entry) =>
          createExposureEndpoint(route.hostname, route.bindIp, {
            ...entry,
            port: computePublishedPort(config.setup.exposure.mode, entry.port, index),
          }),
        ),
      }));
  const dnsRecords = routes.flatMap((route) => (route.dnsRecord ? [route.dnsRecord] : []));
  const warnings: ExposureWarning[] = [];

  if (config.setup.exposure.mode === 'loopback') {
    warnings.push({
      code: 'LOOPBACK_ONLY',
      severity: 'info',
      message:
        'Loopback mode is local-only. Keep using `mullgate proxy access` for host-file testing on this machine.',
    });
  }

  if (config.setup.exposure.baseDomain) {
    warnings.push({
      code: 'DNS_REQUIRED',
      severity: 'info',
      message:
        'Publish one DNS A record per route hostname and point it at the matching bind IP before expecting remote hostname access to work.',
    });
  }

  if (config.setup.exposure.mode === 'public') {
    warnings.push({
      code: 'PUBLIC_EXPOSURE',
      severity: 'warning',
      message:
        'Public exposure publishes authenticated proxy listeners on publicly routable IPs. Confirm firewalling, rate limits, and monitoring before enabling it on the open internet.',
    });
  }

  if (config.setup.exposure.mode === 'public' && config.routing.locations.length === 1) {
    warnings.push({
      code: 'SINGLE_ROUTE',
      severity: 'warning',
      message:
        'Only one routed bind IP is configured, so remote exposure will not provide hostname-based route selection until additional routes are added.',
    });
  }

  if (config.runtime.status.phase === 'unvalidated') {
    warnings.push({
      code: 'RUNTIME_UNVALIDATED',
      severity: 'warning',
      message:
        config.runtime.status.message ??
        'Saved exposure settings have not been rendered into runtime artifacts yet. Rerun `mullgate proxy validate` or `mullgate proxy start` after changing exposure settings.',
    });
  }

  if (
    config.setup.exposure.mode === 'public' &&
    inlineSelectorEnabled &&
    config.setup.auth.password.length === 0
  ) {
    warnings.push({
      code: 'INLINE_SELECTOR_PUBLIC_EMPTY_PASSWORD',
      severity: 'warning',
      message:
        'Inline-selector access is exposing a public listener with an empty password. This is only appropriate when you intentionally accept selector-only proxy access on the public host.',
    });
  }

  const inlineSelector = inlineSelectorEnabled ? buildInlineSelectorContract(config, ports) : null;

  return {
    mode: config.setup.exposure.mode,
    accessMode: config.setup.access.mode,
    allowLan: config.setup.exposure.allowLan,
    baseDomain: config.setup.exposure.baseDomain,
    ports,
    routes,
    dnsRecords,
    inlineSelector,
    posture: buildExposurePosture(config),
    guidance: buildExposureGuidance(config, dnsRecords),
    remediation: buildExposureRemediation(config),
    warnings,
    runtimeStatus: {
      phase: config.runtime.status.phase,
      message: config.runtime.status.message,
      restartRequired: config.runtime.status.phase === 'unvalidated',
    },
  };
}

export function validateExposureSettings(input: {
  readonly routeCount: number;
  readonly exposureMode: ExposureMode;
  readonly accessMode?: AccessMode;
  readonly exposureBaseDomain: string | null | undefined;
  readonly routeBindIps: readonly string[];
  readonly artifactPath: string;
  readonly caller?: 'setup' | 'config-exposure';
}): ExposureValidationResult {
  const baseDomain = normalizeExposureBaseDomain(input.exposureBaseDomain);
  const accessMode = input.accessMode ?? 'published-routes';

  if (baseDomain && !isValidBaseDomain(baseDomain)) {
    return {
      ok: false,
      phase: 'setup-validation',
      source: 'input',
      code: 'INVALID_BASE_DOMAIN',
      message: `Base domain must be a valid DNS suffix, but received ${baseDomain}.`,
      artifactPath: input.artifactPath,
    };
  }

  if (input.exposureMode === 'loopback' && accessMode === 'published-routes') {
    const routeBindIps = Array.from({ length: input.routeCount }, (_, index) =>
      deriveLoopbackBindIp(index),
    ) as [string, ...string[]];

    return {
      ok: true,
      mode: input.exposureMode,
      baseDomain,
      bindHost: routeBindIps[0],
      routeBindIps,
    };
  }

  if (input.exposureMode === 'private-network' || accessMode === 'inline-selector') {
    if (input.routeBindIps.length !== 1) {
      return {
        ok: false,
        phase: 'setup-validation',
        source: 'input',
        code: 'BIND_IP_COUNT_MISMATCH',
        message:
          accessMode === 'inline-selector'
            ? `Inline-selector access publishes one shared listener host, so exactly one bind IP is required, but received ${input.routeBindIps.length}.`
            : `Private-network exposure publishes every route on one shared host IP, so exactly one bind IP is required, but received ${input.routeBindIps.length}.`,
        cause:
          input.caller === 'config-exposure'
            ? 'Pass exactly one --route-bind-ip <ip> for the shared host, or omit it to keep the saved host IP.'
            : accessMode === 'inline-selector'
              ? 'Pass one bind IP or set MULLGATE_ROUTE_BIND_IPS / --bind-host to the shared host that clients should reach for selector-driven access.'
              : 'Pass one bind IP or set MULLGATE_ROUTE_BIND_IPS / --bind-host to the trusted-network host IP that remote clients should reach.',
        artifactPath: input.artifactPath,
      };
    }

    const bindHost = requireDefined(
      input.routeBindIps[0],
      'Expected one shared bind IP for private-network exposure.',
    );

    if (isIP(bindHost) !== 4) {
      return {
        ok: false,
        phase: 'setup-validation',
        source: 'input',
        code: 'INVALID_BIND_IP',
        message:
          accessMode === 'inline-selector'
            ? `Inline-selector access requires one valid IPv4 host, but received ${bindHost}.`
            : `Private-network exposure requires one valid IPv4 host, but received ${bindHost}.`,
        artifactPath: input.artifactPath,
      };
    }

    const invalidSharedHost =
      input.exposureMode === 'loopback'
        ? !isLoopbackIpv4(bindHost)
        : input.exposureMode === 'public'
          ? !isPublicExposureIpv4(bindHost)
          : !isPrivateNetworkHostIpv4(bindHost);

    if (invalidSharedHost) {
      return {
        ok: false,
        phase: 'setup-validation',
        source: 'input',
        code:
          input.exposureMode === 'public'
            ? 'UNSAFE_PUBLIC_BIND_IP'
            : input.exposureMode === 'loopback'
              ? 'UNSAFE_LOOPBACK_BIND_IP'
              : 'UNSAFE_PRIVATE_BIND_IP',
        message:
          input.exposureMode === 'public'
            ? `Public inline-selector exposure requires a publicly routable IPv4 host, but received ${bindHost}.`
            : input.exposureMode === 'loopback'
              ? `Loopback inline-selector exposure requires a loopback IPv4 host, but received ${bindHost}.`
              : `Private-network exposure requires a trusted-network IPv4 host, but received ${bindHost}.`,
        cause:
          input.exposureMode === 'public'
            ? 'Choose one real public IPv4 address for the shared selector listener or switch to private-network / loopback exposure.'
            : input.exposureMode === 'loopback'
              ? 'Use a 127.x.y.z loopback host for same-machine selector access.'
              : 'Use an RFC1918 address, a Tailscale 100.x address, or 0.0.0.0 as the wildcard fallback when Tailscale is unavailable.',
        artifactPath: input.artifactPath,
      };
    }

    const routeBindIps = Array.from({ length: input.routeCount }, () => bindHost) as [
      string,
      ...string[],
    ];

    return {
      ok: true,
      mode: input.exposureMode,
      baseDomain,
      bindHost,
      routeBindIps,
    };
  }

  if (input.routeBindIps.length !== input.routeCount) {
    return {
      ok: false,
      phase: 'setup-validation',
      source: 'input',
      code: 'BIND_IP_COUNT_MISMATCH',
      message:
        input.routeCount === 1
          ? `Non-loopback exposure requires exactly one explicit bind IP, but received ${input.routeBindIps.length}.`
          : `Non-loopback exposure requires one explicit bind IP per routed location (${input.routeCount} locations, ${input.routeBindIps.length} bind IPs).`,
      cause:
        input.routeCount === 1
          ? input.caller === 'config-exposure'
            ? 'Pass --route-bind-ip <ip> to `mullgate proxy access`.'
            : 'Pass --route-bind-ip <ip> or set MULLGATE_ROUTE_BIND_IPS to a single IPv4 address.'
          : input.caller === 'config-exposure'
            ? 'Repeat --route-bind-ip for each route in `mullgate proxy access`.'
            : 'Repeat --route-bind-ip for each route or set MULLGATE_ROUTE_BIND_IPS to a comma-separated ordered list.',
      artifactPath: input.artifactPath,
    };
  }

  const duplicates = findDuplicateValues(input.routeBindIps);

  if (duplicates.length > 0) {
    return {
      ok: false,
      phase: 'setup-validation',
      source: 'input',
      code: 'AMBIGUOUS_SHARED_BIND_IP',
      message: `Non-loopback multi-route exposure requires distinct bind IPs, but found duplicates: ${duplicates.join(', ')}.`,
      cause:
        'S03 routing still dispatches by destination bind IP, so multiple remote routes cannot safely share one published IP.',
      artifactPath: input.artifactPath,
    };
  }

  for (const [index, bindIp] of input.routeBindIps.entries()) {
    if (isIP(bindIp) !== 4) {
      return {
        ok: false,
        phase: 'setup-validation',
        source: 'input',
        code: 'INVALID_BIND_IP',
        message: `Route ${index + 1} bind IP must be a valid IPv4 address, but received ${bindIp}.`,
        artifactPath: input.artifactPath,
      };
    }

    if (input.exposureMode === 'public' && !isPublicExposureIpv4(bindIp)) {
      return {
        ok: false,
        phase: 'setup-validation',
        source: 'input',
        code: 'UNSAFE_PUBLIC_BIND_IP',
        message: `Public exposure requires publicly routable IPv4 bind IPs, but route ${index + 1} uses ${bindIp}.`,
        cause:
          'Choose a real public IPv4 address for each route or switch to private-network / loopback exposure.',
        artifactPath: input.artifactPath,
      };
    }
  }

  return {
    ok: true,
    mode: input.exposureMode,
    baseDomain,
    bindHost: requireDefined(
      input.routeBindIps[0],
      'Expected at least one bind IP after exposure validation.',
    ),
    routeBindIps: input.routeBindIps as [string, ...string[]],
  };
}

export function normalizeExposureBaseDomain(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase().replace(/\.+$/, '');
  return trimmed ? trimmed : null;
}

export function deriveExposureHostname(
  alias: string,
  bindIp: string,
  baseDomain: string | null,
  exposureMode: ExposureMode,
): string {
  if (baseDomain) {
    return `${alias}.${baseDomain}`;
  }

  return exposureMode === 'loopback' ? alias : bindIp;
}

export function deriveLoopbackBindIp(index: number): string {
  const thirdOctet = Math.floor(index / 254);
  const fourthOctet = (index % 254) + 1;

  return `127.0.${thirdOctet}.${fourthOctet}`;
}

function collectExposurePorts(config: MullgateConfig): ExposurePort[] {
  return [
    { protocol: 'socks5', port: config.setup.bind.socksPort },
    { protocol: 'http', port: config.setup.bind.httpPort },
    ...(config.setup.bind.httpsPort === null
      ? []
      : [
          {
            protocol: 'https',
            port: config.setup.bind.httpsPort ?? HTTPS_DEFAULT_PORT,
          } satisfies ExposurePort,
        ]),
  ];
}

function createExposureEndpoint(
  hostname: string,
  bindIp: string,
  entry: ExposurePort,
): ExposureEndpoint {
  return {
    protocol: entry.protocol,
    port: entry.port,
    hostnameUrl: `${entry.protocol}://${hostname}:${entry.port}`,
    bindUrl: `${entry.protocol}://${bindIp}:${entry.port}`,
    redactedHostnameUrl: `${entry.protocol}://${REDACTED}:${REDACTED}@${hostname}:${entry.port}`,
    redactedBindUrl: `${entry.protocol}://${REDACTED}:${REDACTED}@${bindIp}:${entry.port}`,
    authRequired: true,
  };
}

function buildInlineSelectorContract(
  config: MullgateConfig,
  ports: readonly ExposurePort[],
): NonNullable<ExposureContract['inlineSelector']> {
  const sharedHost = deriveInlineSelectorBindHost(config);
  const listenerHost = deriveRuntimeListenerHost(config.setup.exposure.mode, sharedHost);
  const examples = createInlineSelectorExamples(config, ports, sharedHost);

  return {
    sharedHost,
    listenerHost,
    selectorField: 'username',
    syntax: {
      guaranteed: 'selector:@host:port',
      bestEffort: 'selector@host:port',
    },
    examples,
  };
}

function createInlineSelectorExamples(
  config: MullgateConfig,
  ports: readonly ExposurePort[],
  sharedHost: string,
): readonly InlineSelectorExample[] {
  const resolveCountrySelector = (route: MullgateConfig['routing']['locations'][number]) =>
    route.relayPreference.country ?? route.mullvad.exit.countryCode;
  const resolveCitySelector = (route: MullgateConfig['routing']['locations'][number]) =>
    route.relayPreference.city ?? route.mullvad.exit.cityCode;
  const selectors = [
    ...new Map(
      config.routing.locations.flatMap((route) => {
        const countrySelector = resolveCountrySelector(route);
        const citySelector = resolveCitySelector(route);

        return [
          [
            countrySelector,
            {
              selector: countrySelector,
              targetLabel: `country ${countrySelector}`,
            },
          ],
          [
            `${countrySelector}-${citySelector}`,
            {
              selector: `${countrySelector}-${citySelector}`,
              targetLabel: `city ${countrySelector}-${citySelector}`,
            },
          ],
          [
            route.mullvad.exit.relayHostname,
            {
              selector: route.mullvad.exit.relayHostname,
              targetLabel: `relay ${route.mullvad.exit.relayHostname}`,
            },
          ],
        ];
      }),
    ).values(),
  ].slice(0, 3);

  return selectors.map((entry) => ({
    selector: entry.selector,
    targetLabel: entry.targetLabel,
    endpoints: ports.map((port) => createExposureEndpoint(sharedHost, sharedHost, port)),
    guaranteedUrl: `${ports[0]?.protocol ?? 'socks5'}://${entry.selector}:@${sharedHost}:${ports[0]?.port ?? 0}`,
    bestEffortUrl: `${ports[0]?.protocol ?? 'socks5'}://${entry.selector}@${sharedHost}:${ports[0]?.port ?? 0}`,
  }));
}

function buildExposureGuidance(config: MullgateConfig, dnsRecords: readonly string[]): string[] {
  if (usesInlineSelectorAccess(config)) {
    const sharedHost = deriveInlineSelectorBindHost(config);

    return [
      'Inline-selector access keeps one shared listener per configured protocol and chooses the Mullvad exit from the proxy username instead of a pre-published per-route port.',
      config.setup.exposure.mode === 'public'
        ? 'Public inline-selector mode exposes one shared public listener. Only use this when you intentionally want remote selector-driven access on the public host.'
        : `Clients should connect directly to ${sharedHost} and change the username to switch between country, city, and exact relay selectors.`,
      'The guaranteed URL shape is `selector:@host:port`. The shorter `selector@host:port` form is best-effort only because some proxy clients do not normalize a missing password consistently.',
    ];
  }

  if (config.setup.exposure.mode === 'loopback') {
    return [
      'Loopback mode is the default local-only posture. Keep it for same-machine use and developer/operator checks.',
      'Use `mullgate proxy access` if you want a copy/paste /etc/hosts block for this machine.',
    ];
  }

  const guidance = [
    config.setup.exposure.mode === 'private-network'
      ? 'Private-network mode is the recommended remote posture for Tailscale, LAN, and other trusted overlays. Mullgate publishes every route on one shared private host IP so other trusted-network machines can reach that host directly.'
      : 'Public mode is advanced operator territory. Only use it when you intentionally want internet-reachable listeners and are prepared to harden the host around them.',
    config.setup.exposure.mode === 'private-network'
      ? 'Each private-network route gets a dedicated published port on that shared host. This is the canonical Tailscale-first access model.'
      : 'Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.',
  ];

  if (dnsRecords.length > 0) {
    guidance.push(
      config.setup.exposure.mode === 'private-network'
        ? 'Publish the DNS records below so every route hostname resolves to the shared private host IP.'
        : 'Publish the DNS records below so every route hostname resolves to its matching bind IP.',
    );
  } else {
    guidance.push(
      config.setup.exposure.mode === 'private-network'
        ? 'No base domain is configured, so clients should reach each route via the shared host IP entrypoints below.'
        : 'No base domain is configured, so clients must reach each route via the direct bind IP entrypoints below.',
    );
  }

  return guidance;
}

function buildExposurePosture(config: MullgateConfig): ExposureContract['posture'] {
  if (usesInlineSelectorAccess(config)) {
    if (config.setup.exposure.mode === 'loopback') {
      return {
        recommendation: 'local-default',
        modeLabel: 'Loopback / inline selector',
        summary:
          'Same-machine selector-driven posture. One local listener per protocol accepts country, city, or relay selectors in the proxy username.',
        remoteStory:
          'Switch to private-network mode when other trusted-network machines should reach the same shared selector-driven listener.',
      };
    }

    if (config.setup.exposure.mode === 'private-network') {
      return {
        recommendation: 'recommended-remote',
        modeLabel: 'Private network / inline selector',
        summary:
          'Recommended remote selector-driven posture. One shared host IP and fixed ports let trusted-network clients choose the Mullvad exit inline.',
        remoteStory:
          'Other trusted-network machines connect to the shared host IP and change only the proxy username to switch country, city, or relay.',
      };
    }

    return {
      recommendation: 'advanced-remote',
      modeLabel: 'Public / inline selector',
      summary:
        'Expert-only selector-driven public posture. One public listener accepts inline exit selection, so firewalling and explicit operator intent matter even more than in published-routes mode.',
      remoteStory:
        'Use this only when you intentionally want selector-driven access on a public listener and understand the authentication and exposure tradeoffs.',
    };
  }

  if (config.setup.exposure.mode === 'loopback') {
    return {
      recommendation: 'local-default',
      modeLabel: 'Loopback / local-only',
      summary:
        'Recommended default for same-machine use. Remote clients are intentionally out of scope in this posture.',
      remoteStory:
        'Switch to private-network mode for Tailscale, LAN, or other trusted-overlay remote access.',
    };
  }

  if (config.setup.exposure.mode === 'private-network') {
    return {
      recommendation: 'recommended-remote',
      modeLabel: 'Private network / Tailscale-first',
      summary:
        'Recommended remote posture. Use this for Tailscale, LAN, or other trusted private overlays before considering public exposure.',
      remoteStory:
        'Prefer the host Tailscale IP when available, then connect from other trusted-network machines to the published per-route ports on that shared host.',
    };
  }

  return {
    recommendation: 'advanced-remote',
    modeLabel: 'Advanced public exposure',
    summary:
      'Expert-only remote posture. Publicly routable listeners are possible, but Mullgate does not treat this as the default or safest operating mode.',
    remoteStory:
      'Prefer private-network mode unless you intentionally need internet-reachable listeners and can provide DNS, firewalling, monitoring, and host hardening yourself.',
  };
}

function buildExposureRemediation(config: MullgateConfig): ExposureContract['remediation'] {
  if (usesInlineSelectorAccess(config)) {
    if (config.setup.exposure.mode === 'loopback') {
      return {
        bindPosture:
          'Keep inline-selector loopback mode on one local bind host only. The shared listener should stay on 127.0.0.1 unless you intentionally switch exposure mode.',
        hostnameResolution:
          'Use the direct bind-host entrypoints for selector-driven access. Route hostnames are not the selector surface in this mode.',
        restart:
          'After changing access mode, exposure mode, or the bind host, rerun `mullgate proxy validate` or `mullgate proxy start` so the shared selector listeners are re-rendered.',
      };
    }

    if (config.setup.exposure.mode === 'private-network') {
      return {
        bindPosture:
          'Keep private-network inline-selector mode on one trusted-network host IP only. Mullgate binds wildcard listeners at runtime and uses the proxy username to choose exits.',
        hostnameResolution:
          'Use the direct shared host IP entrypoints unless you have your own DNS shortcut for that one shared listener host.',
        restart:
          'After changing access mode, exposure mode, or the bind host, rerun `mullgate proxy validate` or `mullgate proxy start` so the shared selector listeners are re-rendered.',
      };
    }

    return {
      bindPosture:
        'Use public inline-selector mode only with one intentionally public bind IP. If you are not deliberately publishing one selector-driven listener, switch back to private-network or published-routes mode.',
      hostnameResolution:
        'Use the direct shared public host entrypoints unless you deliberately publish a DNS shortcut for that one listener host.',
      restart:
        'After changing access mode, exposure mode, or the bind host, rerun `mullgate proxy validate` or `mullgate proxy start` so the shared selector listeners are re-rendered.',
    };
  }

  if (config.setup.exposure.mode === 'loopback') {
    return {
      bindPosture:
        'Keep loopback mode on local-only bind IPs. If you need remote access, rerun `mullgate proxy access --mode private-network ...` with one trusted-network bind IP per route.',
      hostnameResolution:
        'For local host-file testing, use `mullgate proxy access` and apply the emitted block on this machine so each route hostname resolves to its saved loopback bind IP.',
      restart:
        'After changing exposure settings, rerun `mullgate proxy validate` or `mullgate proxy start` so the runtime artifacts match the saved local-only posture.',
    };
  }

  if (config.setup.exposure.mode === 'private-network') {
    return {
      bindPosture:
        'Keep private-network mode on one trusted-network host IP only. Mullgate binds wildcard listeners at runtime and publishes dedicated per-route ports on that shared host.',
      hostnameResolution:
        'Make each route hostname resolve to the saved shared private-network host IP inside Tailscale/LAN DNS, or use the direct host-IP entrypoints if DNS is unnecessary.',
      restart:
        'After exposure or bind-IP changes, rerun `mullgate proxy validate` or `mullgate proxy start` so the runtime artifacts and operator guidance match the recommended private-network posture.',
    };
  }

  return {
    bindPosture:
      'Use public mode only with intentionally public, distinct bind IPs per route. If you are not deliberately publishing internet-reachable listeners, switch back to private-network mode.',
    hostnameResolution:
      'Publish DNS A records so every route hostname resolves to its saved public bind IP before expecting remote hostname access to work on the open internet.',
    restart:
      'After changing exposure or DNS-facing bind IPs, rerun `mullgate proxy validate` or `mullgate proxy start` so runtime artifacts reflect the advanced public posture accurately.',
  };
}

function isValidBaseDomain(value: string): boolean {
  if (value.length > 253 || value.includes('..')) {
    return false;
  }

  const labels = value.split('.');

  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
    !/^\d+$/.test(labels.at(-1) ?? '')
  );
}

function findDuplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }

    seen.add(value);
  }

  return [...duplicates].sort();
}

function isPrivateIpv4(value: string): boolean {
  const [first, second] = parseIpv4Octets(value);

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isLoopbackIpv4(value: string): boolean {
  const [first] = parseIpv4Octets(value);
  return first === 127;
}

function isTailscaleIpv4(value: string): boolean {
  const [first, second] = parseIpv4Octets(value);
  return first === 100 && second >= 64 && second <= 127;
}

function isPrivateNetworkHostIpv4(value: string): boolean {
  return value === PRIVATE_NETWORK_LISTEN_HOST || isPrivateIpv4(value) || isTailscaleIpv4(value);
}

function isPublicExposureIpv4(value: string): boolean {
  const [first, second] = parseIpv4Octets(value);

  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  ) {
    return false;
  }

  return true;
}

function parseIpv4Octets(value: string): [number, number, number, number] {
  const octets = value.split('.').map((segment) => Number(segment));
  const [first, second, third, fourth] = octets;
  return [
    requireDefined(first, `Missing first IPv4 octet in ${value}.`),
    requireDefined(second, `Missing second IPv4 octet in ${value}.`),
    requireDefined(third, `Missing third IPv4 octet in ${value}.`),
    requireDefined(fourth, `Missing fourth IPv4 octet in ${value}.`),
  ];
}
