import type { MullvadRelay } from '../mullvad/fetch-relays.js';

export type LocationAliasPhase = 'location-aliases' | 'location-lookup';
export type LocationAliasFailureCode = 'ALIAS_COLLISION' | 'ALIAS_NOT_FOUND' | 'ALIAS_AMBIGUOUS';

export type CountryLocationTarget = {
  kind: 'country';
  countryCode: string;
  countryName: string;
};

export type CityLocationTarget = {
  kind: 'city';
  countryCode: string;
  countryName: string;
  cityCode: string;
  cityName: string;
};

export type RelayLocationTarget = {
  kind: 'relay';
  hostname: string;
  fqdn: string;
  countryCode: string;
  countryName: string;
  cityCode: string;
  cityName: string;
};

export type LocationAliasTarget = CountryLocationTarget | CityLocationTarget | RelayLocationTarget;

export type CountryAliasEntry = {
  code: string;
  name: string;
  aliases: readonly string[];
};

export type CityAliasEntry = {
  countryCode: string;
  countryName: string;
  code: string;
  name: string;
  aliases: readonly string[];
};

export type RelayAliasEntry = {
  hostname: string;
  fqdn: string;
  countryCode: string;
  countryName: string;
  cityCode: string;
  cityName: string;
  aliases: readonly string[];
};

export type LocationAliasCatalog = {
  countries: readonly CountryAliasEntry[];
  cities: readonly CityAliasEntry[];
  relays: readonly RelayAliasEntry[];
  index: Readonly<Record<string, readonly LocationAliasTarget[]>>;
  ambiguousAliases: readonly {
    alias: string;
    targets: readonly LocationAliasTarget[];
  }[];
};

export type CreateLocationAliasCatalogSuccess = {
  ok: true;
  phase: 'location-aliases';
  source: 'relay-catalog';
  value: LocationAliasCatalog;
};

export type LocationAliasFailure = {
  ok: false;
  phase: LocationAliasPhase;
  source: 'relay-catalog' | 'user-input';
  code: LocationAliasFailureCode;
  message: string;
  alias?: string;
  candidates?: readonly LocationAliasTarget[];
};

export type CreateLocationAliasCatalogResult =
  | CreateLocationAliasCatalogSuccess
  | LocationAliasFailure;
export type ResolveLocationAliasResult =
  | {
      ok: true;
      phase: 'location-lookup';
      source: 'user-input';
      alias: string;
      value: LocationAliasTarget;
    }
  | LocationAliasFailure;

export function createLocationAliasCatalog(
  relays: readonly MullvadRelay[],
): CreateLocationAliasCatalogResult {
  const countriesByCode = new Map<string, CountryAliasEntry>();
  const citiesByKey = new Map<string, CityAliasEntry>();
  const relayEntries: RelayAliasEntry[] = [];
  const aliasIndex = new Map<string, LocationAliasTarget[]>();

  for (const relay of relays) {
    const countryCode = relay.location.countryCode;
    const countryName = relay.location.countryName;
    const cityCode = relay.location.cityCode;
    const cityName = relay.location.cityName;

    const existingCountry = countriesByCode.get(countryCode);

    if (existingCountry && existingCountry.name !== countryName) {
      return createFailure({
        phase: 'location-aliases',
        source: 'relay-catalog',
        code: 'ALIAS_COLLISION',
        message: `Country code ${countryCode} mapped to multiple names (${existingCountry.name} vs ${countryName}).`,
        alias: countryCode,
      });
    }

    const existingCity = citiesByKey.get(cityKey(countryCode, cityCode));

    if (existingCity && existingCity.name !== cityName) {
      return createFailure({
        phase: 'location-aliases',
        source: 'relay-catalog',
        code: 'ALIAS_COLLISION',
        message: `City alias ${countryCode}-${cityCode} mapped to multiple city names (${existingCity.name} vs ${cityName}).`,
        alias: `${countryCode}-${cityCode}`,
      });
    }

    if (!existingCountry) {
      countriesByCode.set(countryCode, {
        code: countryCode,
        name: countryName,
        aliases: Object.freeze(uniqueAliases([countryCode, normalizeLocationToken(countryName)])),
      });
    }

    if (!existingCity) {
      const countrySlug = normalizeLocationToken(countryName);
      const citySlug = normalizeLocationToken(cityName);

      citiesByKey.set(cityKey(countryCode, cityCode), {
        countryCode,
        countryName,
        code: cityCode,
        name: cityName,
        aliases: Object.freeze(
          uniqueAliases([
            `${countryCode}-${cityCode}`,
            `${countryCode}-${citySlug}`,
            `${countrySlug}-${citySlug}`,
            citySlug,
          ]),
        ),
      });
    }

    relayEntries.push({
      hostname: relay.hostname,
      fqdn: relay.fqdn,
      countryCode,
      countryName,
      cityCode,
      cityName,
      aliases: Object.freeze(uniqueAliases([relay.hostname, relay.fqdn])),
    });
  }

  const countries = [...countriesByCode.values()].sort((left, right) =>
    left.code.localeCompare(right.code),
  );
  const cities = [...citiesByKey.values()].sort(
    (left, right) =>
      left.countryCode.localeCompare(right.countryCode) || left.code.localeCompare(right.code),
  );
  const relaysSorted = [...relayEntries].sort(
    (left, right) =>
      left.countryCode.localeCompare(right.countryCode) ||
      left.cityCode.localeCompare(right.cityCode) ||
      left.hostname.localeCompare(right.hostname),
  );

  for (const country of countries) {
    const target: CountryLocationTarget = {
      kind: 'country',
      countryCode: country.code,
      countryName: country.name,
    };

    for (const alias of country.aliases) {
      const registration = registerAlias(aliasIndex, alias, target, 'required');

      if (!registration.ok) {
        return registration;
      }
    }
  }

  for (const city of cities) {
    const target: CityLocationTarget = {
      kind: 'city',
      countryCode: city.countryCode,
      countryName: city.countryName,
      cityCode: city.code,
      cityName: city.name,
    };

    for (const alias of city.aliases) {
      const required =
        alias.startsWith(`${city.countryCode}-`) ||
        alias.startsWith(`${normalizeLocationToken(city.countryName)}-`);
      const registration = registerAlias(
        aliasIndex,
        alias,
        target,
        required ? 'required' : 'optional',
      );

      if (!registration.ok) {
        return registration;
      }
    }
  }

  for (const relay of relaysSorted) {
    const target: RelayLocationTarget = {
      kind: 'relay',
      hostname: relay.hostname,
      fqdn: relay.fqdn,
      countryCode: relay.countryCode,
      countryName: relay.countryName,
      cityCode: relay.cityCode,
      cityName: relay.cityName,
    };

    for (const alias of relay.aliases) {
      const registration = registerAlias(aliasIndex, alias, target, 'required');

      if (!registration.ok) {
        return registration;
      }
    }
  }

  const index = Object.fromEntries(
    [...aliasIndex.entries()]
      .sort(([leftAlias], [rightAlias]) => leftAlias.localeCompare(rightAlias))
      .map(([alias, targets]) => [alias, Object.freeze([...targets])]),
  ) as Readonly<Record<string, readonly LocationAliasTarget[]>>;

  const ambiguousAliases = Object.freeze(
    [...aliasIndex.entries()]
      .filter(([, targets]) => targets.length > 1)
      .sort(([leftAlias], [rightAlias]) => leftAlias.localeCompare(rightAlias))
      .map(([alias, targets]) => ({
        alias,
        targets: Object.freeze([...targets]),
      })),
  );

  return {
    ok: true,
    phase: 'location-aliases',
    source: 'relay-catalog',
    value: {
      countries: Object.freeze(countries),
      cities: Object.freeze(cities),
      relays: Object.freeze(relaysSorted),
      index,
      ambiguousAliases,
    },
  };
}

export function resolveLocationAlias(
  catalog: LocationAliasCatalog,
  input: string,
): ResolveLocationAliasResult {
  const alias = normalizeLocationToken(input);
  const candidates = catalog.index[alias] ?? [];

  if (candidates.length === 0) {
    return createFailure({
      phase: 'location-lookup',
      source: 'user-input',
      code: 'ALIAS_NOT_FOUND',
      message: `No Mullvad country, city, or relay matched alias ${alias}.`,
      alias,
    });
  }

  if (candidates.length > 1) {
    return createFailure({
      phase: 'location-lookup',
      source: 'user-input',
      code: 'ALIAS_AMBIGUOUS',
      message: `Alias ${alias} matched multiple Mullvad locations. Use a country-qualified alias instead.`,
      alias,
      candidates,
    });
  }

  return {
    ok: true,
    phase: 'location-lookup',
    source: 'user-input',
    alias,
    value: candidates[0]!,
  };
}

export function normalizeLocationToken(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function registerAlias(
  aliasIndex: Map<string, LocationAliasTarget[]>,
  alias: string,
  target: LocationAliasTarget,
  mode: 'required' | 'optional',
): CreateLocationAliasCatalogResult | { ok: true } {
  const normalizedAlias = normalizeLocationToken(alias);

  if (!normalizedAlias) {
    return { ok: true };
  }

  const existing = aliasIndex.get(normalizedAlias) ?? [];

  if (existing.some((candidate) => sameTarget(candidate, target))) {
    return { ok: true };
  }

  if (mode === 'required' && existing.length > 0) {
    return createFailure({
      phase: 'location-aliases',
      source: 'relay-catalog',
      code: 'ALIAS_COLLISION',
      message: `Alias ${normalizedAlias} resolved to multiple canonical Mullvad targets.`,
      alias: normalizedAlias,
      candidates: Object.freeze([...existing, target]),
    });
  }

  aliasIndex.set(normalizedAlias, [...existing, target]);
  return { ok: true };
}

function sameTarget(left: LocationAliasTarget, right: LocationAliasTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === 'country' && right.kind === 'country') {
    return left.countryCode === right.countryCode;
  }

  if (left.kind === 'city' && right.kind === 'city') {
    return left.countryCode === right.countryCode && left.cityCode === right.cityCode;
  }

  return left.kind === 'relay' && right.kind === 'relay' && left.hostname === right.hostname;
}

function cityKey(countryCode: string, cityCode: string): string {
  return `${countryCode}:${cityCode}`;
}

function uniqueAliases(aliases: readonly string[]): string[] {
  return [...new Set(aliases.filter((alias) => alias.trim().length > 0))];
}

function createFailure(input: {
  phase: LocationAliasPhase;
  source: 'relay-catalog' | 'user-input';
  code: LocationAliasFailureCode;
  message: string;
  alias?: string;
  candidates?: readonly LocationAliasTarget[];
}): LocationAliasFailure {
  return {
    ok: false,
    phase: input.phase,
    source: input.source,
    code: input.code,
    message: input.message,
    ...(input.alias ? { alias: input.alias } : {}),
    ...(input.candidates ? { candidates: input.candidates } : {}),
  };
}
