import { isIP } from 'node:net';

import { REDACTED } from './redact.js';
import type { ExposureMode, MullgateConfig } from './schema.js';

const HTTPS_DEFAULT_PORT = 8443;

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

export type ExposureWarning = {
  readonly code: 'LOOPBACK_ONLY' | 'DNS_REQUIRED' | 'PUBLIC_EXPOSURE' | 'SINGLE_ROUTE' | 'RUNTIME_UNVALIDATED';
  readonly severity: 'info' | 'warning';
  readonly message: string;
};

export type ExposureContract = {
  readonly mode: ExposureMode;
  readonly allowLan: boolean;
  readonly baseDomain: string | null;
  readonly ports: readonly ExposurePort[];
  readonly routes: readonly ExposureRouteContract[];
  readonly dnsRecords: readonly string[];
  readonly guidance: readonly string[];
  readonly warnings: readonly ExposureWarning[];
  readonly runtimeStatus: {
    readonly phase: MullgateConfig['runtime']['status']['phase'];
    readonly message: string | null;
    readonly restartRequired: boolean;
  };
};

export function buildExposureContract(config: MullgateConfig): ExposureContract {
  const ports = collectExposurePorts(config);
  const routes = config.routing.locations.map((route, index) => ({
    index,
    alias: route.alias,
    routeId: route.runtime.routeId,
    hostname: route.hostname,
    bindIp: route.bindIp,
    dnsRecord: config.setup.exposure.baseDomain ? `${route.hostname} A ${route.bindIp}` : null,
    endpoints: ports.map((entry) => createExposureEndpoint(route.hostname, route.bindIp, entry)),
  }));
  const dnsRecords = routes.flatMap((route) => (route.dnsRecord ? [route.dnsRecord] : []));
  const warnings: ExposureWarning[] = [];

  if (config.setup.exposure.mode === 'loopback') {
    warnings.push({
      code: 'LOOPBACK_ONLY',
      severity: 'info',
      message: 'Loopback mode is local-only. Keep using `mullgate config hosts` for host-file testing on this machine.',
    });
  }

  if (config.setup.exposure.baseDomain) {
    warnings.push({
      code: 'DNS_REQUIRED',
      severity: 'info',
      message: 'Publish one DNS A record per route hostname and point it at the matching bind IP before expecting remote hostname access to work.',
    });
  }

  if (config.setup.exposure.mode === 'public') {
    warnings.push({
      code: 'PUBLIC_EXPOSURE',
      severity: 'warning',
      message: 'Public exposure publishes authenticated proxy listeners on publicly routable IPs. Confirm firewalling, rate limits, and monitoring before enabling it on the open internet.',
    });
  }

  if (config.setup.exposure.mode !== 'loopback' && config.routing.locations.length === 1) {
    warnings.push({
      code: 'SINGLE_ROUTE',
      severity: 'warning',
      message: 'Only one routed bind IP is configured, so remote exposure will not provide hostname-based route selection until additional routes are added.',
    });
  }

  if (config.runtime.status.phase === 'unvalidated') {
    warnings.push({
      code: 'RUNTIME_UNVALIDATED',
      severity: 'warning',
      message:
        config.runtime.status.message ??
        'Saved exposure settings have not been rendered into runtime artifacts yet. Rerun `mullgate config validate` or `mullgate start` after changing exposure settings.',
    });
  }

  return {
    mode: config.setup.exposure.mode,
    allowLan: config.setup.exposure.allowLan,
    baseDomain: config.setup.exposure.baseDomain,
    ports,
    routes,
    dnsRecords,
    guidance: buildExposureGuidance(config, dnsRecords),
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
  readonly exposureBaseDomain: string | null | undefined;
  readonly routeBindIps: readonly string[];
  readonly artifactPath: string;
  readonly caller?: 'setup' | 'config-exposure';
}): ExposureValidationResult {
  const baseDomain = normalizeExposureBaseDomain(input.exposureBaseDomain);

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

  if (input.exposureMode === 'loopback') {
    const routeBindIps = Array.from({ length: input.routeCount }, (_, index) => deriveLoopbackBindIp(index)) as [string, ...string[]];

    return {
      ok: true,
      mode: input.exposureMode,
      baseDomain,
      bindHost: routeBindIps[0],
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
            ? 'Pass --route-bind-ip <ip> to `mullgate config exposure`.'
            : 'Pass --route-bind-ip <ip> or set MULLGATE_ROUTE_BIND_IPS to a single IPv4 address.'
          : input.caller === 'config-exposure'
            ? 'Repeat --route-bind-ip for each route in `mullgate config exposure`.'
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
      cause: 'S03 routing still dispatches by destination bind IP, so multiple remote routes cannot safely share one published IP.',
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

    if (input.exposureMode === 'private-network' && !isPrivateIpv4(bindIp)) {
      return {
        ok: false,
        phase: 'setup-validation',
        source: 'input',
        code: 'UNSAFE_PRIVATE_BIND_IP',
        message: `Private-network exposure requires RFC1918 IPv4 bind IPs, but route ${index + 1} uses ${bindIp}.`,
        cause: 'Use 10.0.0.0/8, 172.16.0.0/12, or 192.168.0.0/16 addresses for private-network exposure.',
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
        cause: 'Choose a real public IPv4 address for each route or switch to private-network / loopback exposure.',
        artifactPath: input.artifactPath,
      };
    }
  }

  return {
    ok: true,
    mode: input.exposureMode,
    baseDomain,
    bindHost: input.routeBindIps[0]!,
    routeBindIps: input.routeBindIps as [string, ...string[]],
  };
}

export function normalizeExposureBaseDomain(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase().replace(/\.+$/, '');
  return trimmed ? trimmed : null;
}

export function deriveExposureHostname(alias: string, bindIp: string, baseDomain: string | null, exposureMode: ExposureMode): string {
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
      : [{ protocol: 'https', port: config.setup.bind.httpsPort ?? HTTPS_DEFAULT_PORT } satisfies ExposurePort]),
  ];
}

function createExposureEndpoint(hostname: string, bindIp: string, entry: ExposurePort): ExposureEndpoint {
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

function buildExposureGuidance(config: MullgateConfig, dnsRecords: readonly string[]): string[] {
  if (config.setup.exposure.mode === 'loopback') {
    return [
      'Loopback mode keeps all listeners on local-only bind IPs.',
      'Use `mullgate config hosts` if you want a copy/paste /etc/hosts block for this machine.',
    ];
  }

  const guidance = [
    config.setup.exposure.mode === 'private-network'
      ? 'Private-network mode expects those bind IPs to be reachable from your LAN, VPN, or overlay network.'
      : 'Public mode expects those bind IPs to be reachable from the public internet.',
    'Each route must keep a distinct bind IP so destination-IP routing remains truthful across SOCKS5, HTTP, and HTTPS.',
  ];

  if (dnsRecords.length > 0) {
    guidance.push('Publish the DNS records below so every route hostname resolves to its matching bind IP.');
  } else {
    guidance.push('No base domain is configured, so clients must reach each route via the direct bind IP entrypoints below.');
  }

  return guidance;
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

  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
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
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}
