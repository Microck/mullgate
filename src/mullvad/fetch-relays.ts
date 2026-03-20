import { z } from 'zod';

const MULLVAD_RELAYS_URL = 'https://api.mullvad.net/public/relays/wireguard/v1/';

const appRelaySchema = z
  .object({
    hostname: z.string().min(1),
    ipv4_addr_in: z.string().min(1),
    ipv6_addr_in: z.string().min(1).nullable().optional(),
    public_key: z.string().min(1),
    multihop_port: z.number().int().positive().optional(),
  })
  .passthrough();

const appCitySchema = z
  .object({
    name: z.string().min(1),
    code: z.string().min(1),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    relays: z.array(appRelaySchema),
  })
  .passthrough();

const appCountrySchema = z
  .object({
    name: z.string().min(1),
    code: z.string().min(1),
    cities: z.array(appCitySchema),
  })
  .passthrough();

const appRelayPayloadSchema = z
  .object({
    countries: z.array(appCountrySchema),
  })
  .passthrough();

const legacyRelaySchema = z
  .object({
    hostname: z.string().min(1),
    fqdn: z.string().min(1).optional(),
    type: z.string().min(1),
    active: z.boolean().optional().default(true),
    owned: z.boolean().optional().default(false),
    provider: z.string().min(1).optional(),
    country_code: z.string().min(1),
    country_name: z.string().min(1),
    city_code: z.string().min(1),
    city_name: z.string().min(1),
    ipv4_addr_in: z.string().min(1),
    ipv6_addr_in: z.string().min(1).nullable().optional(),
    pubkey: z.string().min(1).optional(),
    multihop_port: z.number().int().positive().optional(),
    socks_name: z.string().min(1).optional(),
    socks_port: z.number().int().positive().optional(),
    network_port_speed: z.number().int().positive().optional(),
    stboot: z.boolean().optional(),
    daita: z.boolean().optional(),
    status_messages: z.array(z.unknown()).optional(),
  })
  .passthrough();

const legacyRelayPayloadSchema = z.array(legacyRelaySchema);

export type MullvadRelaySource = 'app-wireguard-v1' | 'www-relays-all';
export type FetchRelaysPhase = 'relay-fetch' | 'relay-normalize';
export type FetchRelaysFailureCode = 'NETWORK_ERROR' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'UNSUPPORTED_PAYLOAD';

export type MullvadRelay = {
  readonly hostname: string;
  readonly fqdn: string;
  readonly source: MullvadRelaySource;
  readonly active: boolean;
  readonly owned: boolean;
  readonly provider?: string;
  readonly publicKey: string;
  readonly endpointIpv4: string;
  readonly endpointIpv6?: string;
  readonly multihopPort?: number;
  readonly socksName?: string;
  readonly socksPort?: number;
  readonly networkPortSpeed?: number;
  readonly stboot?: boolean;
  readonly daita?: boolean;
  readonly location: {
    readonly countryCode: string;
    readonly countryName: string;
    readonly cityCode: string;
    readonly cityName: string;
    readonly latitude?: number;
    readonly longitude?: number;
  };
};

export type MullvadRelayCountry = {
  readonly code: string;
  readonly name: string;
  readonly cities: readonly {
    readonly code: string;
    readonly name: string;
    readonly relayCount: number;
    readonly latitude?: number;
    readonly longitude?: number;
  }[];
};

export type MullvadRelayCatalog = {
  readonly source: MullvadRelaySource;
  readonly fetchedAt: string;
  readonly endpoint: string;
  readonly relayCount: number;
  readonly countries: readonly MullvadRelayCountry[];
  readonly relays: readonly MullvadRelay[];
};

export type FetchRelaysSuccess = {
  ok: true;
  phase: 'relay-normalize';
  source: MullvadRelaySource;
  endpoint: string;
  value: MullvadRelayCatalog;
};

export type FetchRelaysFailure = {
  ok: false;
  phase: FetchRelaysPhase;
  source: 'mullvad-relay-api' | 'input';
  endpoint: string;
  code: FetchRelaysFailureCode;
  message: string;
  cause?: string;
  statusCode?: number;
};

export type FetchRelaysResult = FetchRelaysSuccess | FetchRelaysFailure;

export type FetchRelaysOptions = {
  url?: string | URL;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  fetchedAt?: string;
};

export async function fetchRelays(options: FetchRelaysOptions = {}): Promise<FetchRelaysResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = new URL(options.url ?? MULLVAD_RELAYS_URL);
  const endpoint = url.toString();

  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return createFailure({
      phase: 'relay-fetch',
      source: 'mullvad-relay-api',
      endpoint,
      code: 'NETWORK_ERROR',
      message: 'Failed to fetch Mullvad relay metadata.',
      cause: formatUnknownError(error),
    });
  }

  if (!response.ok) {
    return createFailure({
      phase: 'relay-fetch',
      source: 'mullvad-relay-api',
      endpoint,
      code: 'HTTP_ERROR',
      message: `Mullvad relay metadata request failed with HTTP ${response.status}.`,
      cause: response.statusText || `HTTP ${response.status}`,
      statusCode: response.status,
    });
  }

  let payload: unknown;

  try {
    payload = (await response.json()) as unknown;
  } catch (error) {
    return createFailure({
      phase: 'relay-normalize',
      source: 'mullvad-relay-api',
      endpoint,
      code: 'INVALID_RESPONSE',
      message: 'Mullvad relay metadata was not valid JSON.',
      cause: formatUnknownError(error),
    });
  }

  return normalizeRelayPayload(payload, {
    fetchedAt: options.fetchedAt,
    endpoint,
  });
}

export function normalizeRelayPayload(
  payload: unknown,
  options: {
    fetchedAt?: string;
    endpoint?: string;
  } = {},
): FetchRelaysResult {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const endpoint = options.endpoint ?? 'input';

  if (isAppRelayPayload(payload)) {
    const parsed = appRelayPayloadSchema.safeParse(payload);

    if (!parsed.success) {
      return createFailure({
        phase: 'relay-normalize',
        source: 'input',
        endpoint,
        code: 'INVALID_RESPONSE',
        message: 'Mullvad app relay payload failed schema validation.',
        cause: formatZodIssues(parsed.error),
      });
    }

    const relays = parsed.data.countries.flatMap((country) =>
      country.cities.flatMap((city) =>
        city.relays.map<MullvadRelay>((relay) => ({
          hostname: relay.hostname,
          fqdn: `${relay.hostname}.relays.mullvad.net`,
          source: 'app-wireguard-v1',
          active: true,
          owned: false,
          publicKey: relay.public_key,
          endpointIpv4: relay.ipv4_addr_in,
          ...(relay.ipv6_addr_in ? { endpointIpv6: relay.ipv6_addr_in } : {}),
          ...(relay.multihop_port ? { multihopPort: relay.multihop_port } : {}),
          location: {
            countryCode: normalizeCode(country.code),
            countryName: country.name,
            cityCode: normalizeCode(city.code),
            cityName: city.name,
            ...(city.latitude !== undefined ? { latitude: city.latitude } : {}),
            ...(city.longitude !== undefined ? { longitude: city.longitude } : {}),
          },
        })),
      ),
    );

    return createSuccess({
      source: 'app-wireguard-v1',
      fetchedAt,
      endpoint,
      relays,
    });
  }

  if (Array.isArray(payload)) {
    const parsed = legacyRelayPayloadSchema.safeParse(payload);

    if (!parsed.success) {
      return createFailure({
        phase: 'relay-normalize',
        source: 'input',
        endpoint,
        code: 'INVALID_RESPONSE',
        message: 'Mullvad legacy relay payload failed schema validation.',
        cause: formatZodIssues(parsed.error),
      });
    }

    const relays = parsed.data
      .filter((relay) => relay.type === 'wireguard' && typeof relay.pubkey === 'string' && relay.pubkey.length > 0)
      .map<MullvadRelay>((relay) => ({
        hostname: relay.hostname,
        fqdn: relay.fqdn ?? `${relay.hostname}.relays.mullvad.net`,
        source: 'www-relays-all',
        active: relay.active,
        owned: relay.owned,
        ...(relay.provider ? { provider: relay.provider } : {}),
        publicKey: relay.pubkey!,
        endpointIpv4: relay.ipv4_addr_in,
        ...(relay.ipv6_addr_in ? { endpointIpv6: relay.ipv6_addr_in } : {}),
        ...(relay.multihop_port ? { multihopPort: relay.multihop_port } : {}),
        ...(relay.socks_name ? { socksName: relay.socks_name } : {}),
        ...(relay.socks_port ? { socksPort: relay.socks_port } : {}),
        ...(relay.network_port_speed ? { networkPortSpeed: relay.network_port_speed } : {}),
        ...(relay.stboot !== undefined ? { stboot: relay.stboot } : {}),
        ...(relay.daita !== undefined ? { daita: relay.daita } : {}),
        location: {
          countryCode: normalizeCode(relay.country_code),
          countryName: relay.country_name,
          cityCode: normalizeCode(relay.city_code),
          cityName: relay.city_name,
        },
      }));

    return createSuccess({
      source: 'www-relays-all',
      fetchedAt,
      endpoint,
      relays,
    });
  }

  return createFailure({
    phase: 'relay-normalize',
    source: 'input',
    endpoint,
    code: 'UNSUPPORTED_PAYLOAD',
    message: 'Mullvad relay metadata did not match the app or legacy relay formats.',
  });
}

function createSuccess(input: {
  source: MullvadRelaySource;
  fetchedAt: string;
  endpoint: string;
  relays: MullvadRelay[];
}): FetchRelaysSuccess {
  const relays = [...input.relays].sort(compareRelays);
  const countries = summarizeCountries(relays);

  return {
    ok: true,
    phase: 'relay-normalize',
    source: input.source,
    endpoint: input.endpoint,
    value: {
      source: input.source,
      fetchedAt: input.fetchedAt,
      endpoint: input.endpoint,
      relayCount: relays.length,
      countries,
      relays,
    },
  };
}

function createFailure(input: {
  phase: FetchRelaysPhase;
  source: 'mullvad-relay-api' | 'input';
  endpoint: string;
  code: FetchRelaysFailureCode;
  message: string;
  cause?: string;
  statusCode?: number;
}): FetchRelaysFailure {
  return {
    ok: false,
    phase: input.phase,
    source: input.source,
    endpoint: input.endpoint,
    code: input.code,
    message: input.message,
    ...(input.cause ? { cause: input.cause } : {}),
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
  };
}

function compareRelays(left: MullvadRelay, right: MullvadRelay): number {
  return (
    left.location.countryCode.localeCompare(right.location.countryCode) ||
    left.location.cityCode.localeCompare(right.location.cityCode) ||
    left.hostname.localeCompare(right.hostname)
  );
}

function summarizeCountries(relays: readonly MullvadRelay[]): MullvadRelayCountry[] {
  const countries = new Map<string, { name: string; cities: Map<string, MullvadRelayCountry['cities'][number]> }>();

  for (const relay of relays) {
    const existingCountry = countries.get(relay.location.countryCode) ?? {
      name: relay.location.countryName,
      cities: new Map(),
    };
    const existingCity = existingCountry.cities.get(relay.location.cityCode) ?? {
      code: relay.location.cityCode,
      name: relay.location.cityName,
      relayCount: 0,
      ...(relay.location.latitude !== undefined ? { latitude: relay.location.latitude } : {}),
      ...(relay.location.longitude !== undefined ? { longitude: relay.location.longitude } : {}),
    };

    existingCity.relayCount += 1;
    existingCountry.cities.set(relay.location.cityCode, existingCity);
    countries.set(relay.location.countryCode, existingCountry);
  }

  return [...countries.entries()]
    .sort(([leftCode], [rightCode]) => leftCode.localeCompare(rightCode))
    .map(([code, country]) => ({
      code,
      name: country.name,
      cities: [...country.cities.values()].sort((left, right) => left.code.localeCompare(right.code)),
    }));
}

function isAppRelayPayload(payload: unknown): payload is { countries: unknown[] } {
  return Boolean(payload && typeof payload === 'object' && 'countries' in payload);
}

function normalizeCode(value: string): string {
  return value.trim().toLowerCase();
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}
