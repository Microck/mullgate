import { generateKeyPairSync } from 'node:crypto';

import { z } from 'zod';

import type { MullgateConfig } from '../config/schema.js';

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');
const MULLVAD_WG_URL = 'https://api.mullvad.net/wg';
const DEFAULT_DNS_SERVER = '10.64.0.1';
const accountNumberPattern = /^\d{6,16}$/;

const provisionedDeviceResponseSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    pubkey: z.string().min(1),
    hijack_dns: z.boolean().optional().default(false),
    created: z.string().min(1).optional(),
    ipv4_address: z.string().min(1),
    ipv6_address: z.string().min(1).nullable().optional(),
    ports: z.array(z.unknown()).optional().default([]),
  })
  .passthrough();

const apiErrorResponseSchema = z
  .object({
    code: z.string().min(1).optional(),
    detail: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
  })
  .passthrough();

export type WireguardKeyPair = {
  publicKey: string;
  privateKey: string;
};

export type ProvisionWireguardFailureCode =
  | 'INVALID_ACCOUNT'
  | 'KEY_GENERATION_FAILED'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR';

export type ProvisionWireguardFailurePhase = 'wireguard-keygen' | 'wireguard-provision';

export type ProvisionWireguardFailure = {
  ok: false;
  phase: ProvisionWireguardFailurePhase;
  source: 'input' | 'local-keygen' | 'mullvad-wg-endpoint';
  endpoint: string;
  checkedAt: string;
  code: ProvisionWireguardFailureCode;
  message: string;
  cause?: string;
  statusCode?: number;
  retryable: boolean;
  retryAfterMs?: number;
};

export type ProvisionedWireguardDeviceView = {
  readonly deviceId?: string;
  readonly deviceName?: string;
  readonly publicKey: string;
  readonly ipv4Address: string;
  readonly ipv6Address?: string;
  readonly interfaceAddresses: readonly [string, ...string[]];
  readonly createdAt?: string;
  readonly hijackDns: boolean;
  readonly ports: readonly unknown[];
};

export type ProvisionedWireguardDevice = ProvisionedWireguardDeviceView & {
  readonly privateKey: string;
  toConfigValue(): NonNullable<MullgateConfig['mullvad']['wireguard']>;
  toJSON(): ProvisionedWireguardDeviceView & { privateKey: '[redacted]' };
};

export type ProvisionWireguardSuccess = {
  ok: true;
  phase: 'wireguard-provision';
  source: 'mullvad-wg-endpoint';
  endpoint: string;
  checkedAt: string;
  value: ProvisionedWireguardDevice;
};

export type ProvisionWireguardResult = ProvisionWireguardSuccess | ProvisionWireguardFailure;

export type ProvisionWireguardOptions = {
  accountNumber: string;
  deviceName?: string;
  baseUrl?: string | URL;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  checkedAt?: string;
  generateKeyPair?: () => WireguardKeyPair;
};

export function generateWireguardKeyPair(): WireguardKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKey.export({ format: 'jwk' });

  if (typeof privateJwk.d !== 'string' || typeof publicJwk.x !== 'string') {
    throw new Error('Node did not return raw X25519 key material in JWK format.');
  }

  return {
    privateKey: base64UrlToBase64(privateJwk.d),
    publicKey: base64UrlToBase64(publicJwk.x),
  };
}

export async function provisionWireguard(
  options: ProvisionWireguardOptions,
): Promise<ProvisionWireguardResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = new URL(options.baseUrl ?? MULLVAD_WG_URL).toString();
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const accountNumber = options.accountNumber.trim();

  if (!accountNumberPattern.test(accountNumber)) {
    return createProvisionFailure({
      phase: 'wireguard-provision',
      source: 'input',
      endpoint,
      checkedAt,
      code: 'INVALID_ACCOUNT',
      message: 'Mullvad account numbers must be 6-16 digits before provisioning can start.',
      retryable: false,
    });
  }

  let keyPair: WireguardKeyPair;

  try {
    keyPair = (options.generateKeyPair ?? generateWireguardKeyPair)();
  } catch (error) {
    return createProvisionFailure({
      phase: 'wireguard-keygen',
      source: 'local-keygen',
      endpoint,
      checkedAt,
      code: 'KEY_GENERATION_FAILED',
      message: 'Failed to generate local WireGuard key material.',
      cause: formatUnknownError(error),
      retryable: false,
    });
  }

  let response: Response;

  try {
    const body = new URLSearchParams({
      account: accountNumber,
      pubkey: keyPair.publicKey,
      ...(options.deviceName ? { name: options.deviceName } : {}),
    });

    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
      },
      body,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return createProvisionFailure({
      phase: 'wireguard-provision',
      source: 'mullvad-wg-endpoint',
      endpoint,
      checkedAt,
      code: 'NETWORK_ERROR',
      message: 'Failed to reach Mullvad while provisioning WireGuard credentials.',
      cause: formatUnknownError(error),
      retryable: true,
    });
  }

  const rawBody = await response.text();
  const parsedBody = rawBody.length > 0 ? tryParseJson(rawBody) : null;

  if (!response.ok) {
    const parsedApiError =
      parsedBody && typeof parsedBody === 'object'
        ? apiErrorResponseSchema.safeParse(parsedBody)
        : null;
    const apiPayload = parsedApiError?.success ? parsedApiError.data : undefined;
    const plainTextBody = typeof parsedBody === 'string' ? parsedBody.trim() : null;
    const cause =
      plainTextBody ||
      apiPayload?.detail ||
      apiPayload?.error ||
      apiPayload?.message ||
      response.statusText ||
      `HTTP ${response.status}`;

    const retryAfterMs = readRetryAfterMs(response, cause);

    return createProvisionFailure({
      phase: 'wireguard-provision',
      source: 'mullvad-wg-endpoint',
      endpoint,
      checkedAt,
      code: 'HTTP_ERROR',
      message: `Mullvad rejected the WireGuard provisioning request (HTTP ${response.status}).`,
      cause,
      statusCode: response.status,
      retryable: isRetryableProvisioningResponse({ statusCode: response.status, cause }),
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    });
  }

  if (parsedBody === null) {
    return createProvisionFailure({
      phase: 'wireguard-provision',
      source: 'mullvad-wg-endpoint',
      endpoint,
      checkedAt,
      code: 'INVALID_RESPONSE',
      message: 'Mullvad returned an empty provisioning response.',
      retryable: false,
    });
  }

  if (typeof parsedBody === 'string') {
    const assignedIpv4 = parseAssignedAddress(parsedBody);

    if (!assignedIpv4) {
      return createProvisionFailure({
        phase: 'wireguard-provision',
        source: 'mullvad-wg-endpoint',
        endpoint,
        checkedAt,
        code: 'INVALID_RESPONSE',
        message:
          'Mullvad returned a plain-text provisioning response that did not include an address.',
        cause: parsedBody.trim(),
        retryable: false,
      });
    }

    return {
      ok: true,
      phase: 'wireguard-provision',
      source: 'mullvad-wg-endpoint',
      endpoint,
      checkedAt,
      value: createProvisionedWireguardDevice({
        ...(options.deviceName ? { deviceName: options.deviceName } : {}),
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        ipv4Address: assignedIpv4,
        hijackDns: false,
        ports: [],
      }),
    };
  }

  const parsedDevice = provisionedDeviceResponseSchema.safeParse(parsedBody);

  if (!parsedDevice.success) {
    return createProvisionFailure({
      phase: 'wireguard-provision',
      source: 'mullvad-wg-endpoint',
      endpoint,
      checkedAt,
      code: 'INVALID_RESPONSE',
      message:
        'Mullvad returned a provisioning payload that did not match the documented device contract.',
      cause: formatZodIssues(parsedDevice.error),
      retryable: false,
    });
  }

  return {
    ok: true,
    phase: 'wireguard-provision',
    source: 'mullvad-wg-endpoint',
    endpoint,
    checkedAt,
    value: createProvisionedWireguardDevice({
      ...(parsedDevice.data.id ? { deviceId: parsedDevice.data.id } : {}),
      ...(parsedDevice.data.name ? { deviceName: parsedDevice.data.name } : {}),
      publicKey: parsedDevice.data.pubkey,
      privateKey: keyPair.privateKey,
      ipv4Address: parsedDevice.data.ipv4_address,
      ...(parsedDevice.data.ipv6_address ? { ipv6Address: parsedDevice.data.ipv6_address } : {}),
      ...(parsedDevice.data.created ? { createdAt: parsedDevice.data.created } : {}),
      hijackDns: parsedDevice.data.hijack_dns,
      ports: parsedDevice.data.ports,
    }),
  };
}

function createProvisionedWireguardDevice(input: {
  deviceId?: string;
  deviceName?: string;
  publicKey: string;
  privateKey: string;
  ipv4Address: string;
  ipv6Address?: string;
  createdAt?: string;
  hijackDns: boolean;
  ports: readonly unknown[];
}): ProvisionedWireguardDevice {
  const interfaceAddresses = (
    input.ipv6Address ? [input.ipv4Address, input.ipv6Address] : [input.ipv4Address]
  ) as [string, ...string[]];
  const publicView: ProvisionedWireguardDeviceView = {
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    ...(input.deviceName ? { deviceName: input.deviceName } : {}),
    publicKey: input.publicKey,
    ipv4Address: input.ipv4Address,
    ...(input.ipv6Address ? { ipv6Address: input.ipv6Address } : {}),
    interfaceAddresses,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    hijackDns: input.hijackDns,
    ports: Object.freeze([...input.ports]),
  };

  const value = { ...publicView } as ProvisionedWireguardDevice;

  Object.defineProperty(value, 'privateKey', {
    enumerable: false,
    value: input.privateKey,
    writable: false,
  });

  Object.defineProperty(value, 'toConfigValue', {
    enumerable: false,
    value: (): NonNullable<MullgateConfig['mullvad']['wireguard']> => ({
      publicKey: input.publicKey,
      privateKey: input.privateKey,
      ipv4Address: input.ipv4Address,
      ipv6Address: input.ipv6Address ?? null,
      gatewayIpv4: null,
      gatewayIpv6: null,
      dnsServers: [DEFAULT_DNS_SERVER],
      peerPublicKey: null,
      peerEndpoint: null,
    }),
  });

  Object.defineProperty(value, 'toJSON', {
    enumerable: false,
    value: () => ({
      ...publicView,
      privateKey: '[redacted]' as const,
    }),
  });

  Object.defineProperty(value, inspectSymbol, {
    enumerable: false,
    value: () => value.toJSON(),
  });

  return Object.freeze(value);
}

function createProvisionFailure(input: {
  phase: ProvisionWireguardFailurePhase;
  source: 'input' | 'local-keygen' | 'mullvad-wg-endpoint';
  endpoint: string;
  checkedAt: string;
  code: ProvisionWireguardFailureCode;
  message: string;
  cause?: string;
  statusCode?: number;
  retryable: boolean;
  retryAfterMs?: number;
}): ProvisionWireguardFailure {
  return {
    ok: false,
    phase: input.phase,
    source: input.source,
    endpoint: input.endpoint,
    checkedAt: input.checkedAt,
    code: input.code,
    message: input.message,
    ...(input.cause ? { cause: input.cause } : {}),
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
    retryable: input.retryable,
  };
}

function tryParseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

function parseAssignedAddress(rawBody: string): string | null {
  const candidate = rawBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return candidate ?? null;
}

function isRetryableProvisioningResponse(input: { statusCode: number; cause: string }): boolean {
  if (input.statusCode >= 500 || input.statusCode === 429) {
    return true;
  }

  return /\bthrottled\b|\bretry\b|\btry again\b/i.test(input.cause);
}

function readRetryAfterMs(response: Response, cause: string): number | null {
  const retryAfterHeader = response.headers.get('retry-after');

  if (retryAfterHeader) {
    const parsedSeconds = Number(retryAfterHeader.trim());

    if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
      return parsedSeconds * 1_000;
    }
  }

  const retryAfterMatch = cause.match(/expected available in\s+(\d+)\s+seconds?/i);

  if (!retryAfterMatch) {
    return null;
  }

  const parsedSeconds = Number(retryAfterMatch[1]);

  if (!Number.isFinite(parsedSeconds) || parsedSeconds < 0) {
    return null;
  }

  return parsedSeconds * 1_000;
}

function base64UrlToBase64(value: string): string {
  const padding = (4 - (value.length % 4)) % 4;
  return value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
