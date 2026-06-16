import type { AccessMode, MullgateConfig } from '../config/schema.js';
import { requireArrayValue, requireDefined } from '../required.js';

const DEFAULT_HTTPS_PORT = 8443;

type EditableFieldSpec = {
  readonly parse: (raw: string, options: { json: boolean }) => unknown;
  readonly secret?: boolean;
};

export const EDITABLE_CONFIG_FIELDS = new Map<string, EditableFieldSpec>([
  ['setup.bind.host', { parse: parseRequiredString }],
  ['setup.bind.socksPort', { parse: parsePort }],
  ['setup.bind.httpPort', { parse: parsePort }],
  ['setup.bind.httpsPort', { parse: parseNullablePort }],
  ['setup.auth.username', { parse: parseRequiredString }],
  ['setup.auth.password', { parse: parsePassword, secret: true }],
  ['setup.access.mode', { parse: parseAccessMode }],
  ['setup.access.allowUnsafePublicEmptyPassword', { parse: parseBoolean }],
  ['setup.location.requested', { parse: parseRequiredString }],
  ['setup.location.country', { parse: parseNullableString }],
  ['setup.location.city', { parse: parseNullableString }],
  ['setup.location.hostnameLabel', { parse: parseNullableString }],
  ['setup.location.resolvedAlias', { parse: parseNullableString }],
  ['setup.https.enabled', { parse: parseBoolean }],
  ['setup.https.certPath', { parse: parseNullableString }],
  ['setup.https.keyPath', { parse: parseNullableString }],
  ['mullvad.deviceName', { parse: parseRequiredString }],
  ['mullvad.relayConstraints.ownership', { parse: parseNullableString }],
  ['mullvad.relayConstraints.providers', { parse: parseStringArray }],
]);

export function formatOutputValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

export function getConfigValue(
  config: MullgateConfig,
  keyPath: string,
): { found: true; value: unknown } | { found: false } {
  let current: unknown = config;

  for (const segment of keyPath.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return { found: false };
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return { found: true, value: current };
}

export function setConfigValue(config: MullgateConfig, keyPath: string, value: unknown): void {
  const segments = keyPath.split('.');
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = requireArrayValue(segments, index, `Config path ${keyPath} is not writable.`);
    const next = current[segment];

    if (!next || typeof next !== 'object') {
      throw new Error(`Config path ${keyPath} is not writable.`);
    }

    current = next as Record<string, unknown>;
  }

  const finalSegment = requireDefined(segments.at(-1), `Config path ${keyPath} is not writable.`);
  current[finalSegment] = value;
}

export function applyPostSetNormalization(config: MullgateConfig, changedPath: string): void {
  if (changedPath === 'setup.location.requested') {
    config.setup.location = {
      requested: config.setup.location.requested,
      resolvedAlias: null,
    };
  }

  if (changedPath === 'setup.bind.httpsPort') {
    if (config.setup.bind.httpsPort === null) {
      config.setup.https = {
        enabled: false,
      };
    } else {
      config.setup.https = {
        ...config.setup.https,
        enabled: true,
      };
    }
  }

  if (changedPath === 'setup.https.enabled') {
    if (!config.setup.https.enabled) {
      config.setup.https = {
        enabled: false,
      };
      config.setup.bind.httpsPort = null;
    } else if (config.setup.bind.httpsPort === null) {
      config.setup.bind.httpsPort = DEFAULT_HTTPS_PORT;
    }
  }

  if (changedPath === 'setup.https.certPath' || changedPath === 'setup.https.keyPath') {
    const hasCert = Boolean(config.setup.https.certPath);
    const hasKey = Boolean(config.setup.https.keyPath);
    config.setup.https.enabled = hasCert || hasKey;

    if (config.setup.https.enabled && config.setup.bind.httpsPort === null) {
      config.setup.bind.httpsPort = DEFAULT_HTTPS_PORT;
    }

    if (!config.setup.https.enabled) {
      config.setup.bind.httpsPort = null;
    }
  }
}

export async function readStdinValue(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () =>
      resolve(
        Buffer.concat(chunks)
          .toString('utf8')
          .replace(/\r?\n$/, ''),
      ),
    );
    process.stdin.on('error', reject);
  });
}

export function formatRawInput(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? JSON.stringify(trimmed) : 'an empty value';
}

function formatUnknownInput(value: unknown): string {
  if (typeof value === 'string') {
    return formatRawInput(value);
  }

  const serialized = JSON.stringify(value);
  return serialized ? formatRawInput(serialized) : String(value);
}

function parseRequiredString(raw: string): string {
  const value = raw.trim();

  if (!value) {
    throw new Error(`Expected a non-empty string value, but received ${formatRawInput(raw)}.`);
  }

  return value;
}

function parsePassword(raw: string): string {
  return raw;
}

function parseNullableString(raw: string, options: { json: boolean }): string | null {
  if (options.json) {
    const parsed = JSON.parse(raw) as unknown;

    if (parsed === null) {
      return null;
    }

    if (typeof parsed === 'string' && parsed.trim().length > 0) {
      return parsed.trim();
    }

    throw new Error(`Expected a JSON string or null, but received ${formatUnknownInput(parsed)}.`);
  }

  const value = raw.trim();
  return value === '' || value === 'null' ? null : value;
}

function parsePort(raw: string, options?: { json: boolean }): number {
  const value = parseNumber(raw, options?.json ?? false);

  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Port ${formatRawInput(raw)} must be an integer between 1 and 65535.`);
  }

  return value;
}

function parseNullablePort(raw: string, options: { json: boolean }): number | null {
  if (!options.json && (raw.trim() === '' || raw.trim() === 'null')) {
    return null;
  }

  if (options.json) {
    const parsed = JSON.parse(raw) as unknown;

    if (parsed === null) {
      return null;
    }

    if (typeof parsed === 'number') {
      return parsePort(String(parsed));
    }

    throw new Error(`Expected a JSON number or null, but received ${formatUnknownInput(parsed)}.`);
  }

  return parsePort(raw);
}

function parseBoolean(raw: string, options: { json: boolean }): boolean {
  if (options.json) {
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'boolean') {
      throw new Error(`Expected a JSON boolean, but received ${formatUnknownInput(parsed)}.`);
    }

    return parsed;
  }

  const value = raw.trim().toLowerCase();

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`Boolean value ${formatRawInput(raw)} must be true or false.`);
}

function parseAccessMode(raw: string): AccessMode {
  const value = raw.trim();

  if (value === 'published-routes' || value === 'inline-selector') {
    return value;
  }

  throw new Error(
    `Access mode ${formatRawInput(raw)} must be published-routes or inline-selector.`,
  );
}

function parseStringArray(raw: string, options: { json: boolean }): string[] {
  if (options.json) {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
      throw new Error(
        `Expected a JSON array of strings, but received ${formatUnknownInput(parsed)}.`,
      );
    }

    return parsed.map((value) => value.trim()).filter((value) => value.length > 0);
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseNumber(raw: string, json: boolean): number {
  if (json) {
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'number') {
      throw new Error(`Expected a JSON number, but received ${formatUnknownInput(parsed)}.`);
    }

    return parsed;
  }

  const numeric = Number(raw.trim());

  if (!Number.isFinite(numeric)) {
    throw new Error(`Expected a numeric value, but received ${formatRawInput(raw)}.`);
  }

  return numeric;
}
