import { describe, expect, it } from 'vitest';
import {
  createLocationAliasCatalog,
  normalizeLocationToken,
  resolveLocationAlias,
} from '../../src/domain/location-aliases.js';
import type { MullvadRelay } from '../../src/mullvad/fetch-relays.js';

function createRelay(overrides: Partial<MullvadRelay> & { hostname: string }): MullvadRelay {
  return {
    fqdn: `${overrides.hostname}.relays.mullvad.net`,
    source: 'www-relays-all',
    active: true,
    owned: false,
    publicKey: 'test-pubkey',
    endpointIpv4: '10.0.0.1',
    ...overrides,
    location: {
      countryCode: overrides.location?.countryCode ?? 'xx',
      countryName: overrides.location?.countryName ?? 'Testland',
      cityCode: overrides.location?.cityCode ?? 'tst',
      cityName: overrides.location?.cityName ?? 'Testville',
      ...overrides.location,
    },
  };
}

describe('normalizeLocationToken', () => {
  it('lowercases input', () => {
    expect(normalizeLocationToken('Hello')).toBe('hello');
  });

  it('strips diacritics via NFKD normalization', () => {
    expect(normalizeLocationToken('Zürich')).toBe('zurich');
    expect(normalizeLocationToken('São Paulo')).toBe('sao-paulo');
    expect(normalizeLocationToken('Malmö')).toBe('malmo');
  });

  it('replaces ampersand with "and"', () => {
    expect(normalizeLocationToken('S&V')).toBe('s-and-v');
  });

  it('removes curly/smart apostrophes', () => {
    expect(normalizeLocationToken("it's")).toBe('its');
    expect(normalizeLocationToken('don\u2019t')).toBe('dont');
  });

  it('collapses runs of non-alphanumeric chars into single dashes', () => {
    expect(normalizeLocationToken('a  b   c')).toBe('a-b-c');
    expect(normalizeLocationToken('x@@@y')).toBe('x-y');
  });

  it('strips leading and trailing dashes', () => {
    expect(normalizeLocationToken('  hello  ')).toBe('hello');
    expect(normalizeLocationToken('--hello--')).toBe('hello');
  });

  it('collapses multiple consecutive dashes', () => {
    expect(normalizeLocationToken('a--b')).toBe('a-b');
    expect(normalizeLocationToken('a---b')).toBe('a-b');
  });

  it('handles empty/whitespace-only input', () => {
    expect(normalizeLocationToken('')).toBe('');
    expect(normalizeLocationToken('   ')).toBe('');
  });

  it('handles already-normalized input', () => {
    expect(normalizeLocationToken('se')).toBe('se');
    expect(normalizeLocationToken('us-chi')).toBe('us-chi');
  });

  it('handles special unicode characters', () => {
    expect(normalizeLocationToken("Côte d'Ivoire")).toBe('cote-divoire');
    expect(normalizeLocationToken('Reykjavík')).toBe('reykjavik');
    expect(normalizeLocationToken('Łódź')).toBe('odz');
  });
});

describe('createLocationAliasCatalog', () => {
  it('builds a successful catalog from valid relays', () => {
    const relays = [
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
      createRelay({
        hostname: 'se-sto-002',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ];

    const result = createLocationAliasCatalog(relays);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.countries).toHaveLength(1);
    expect(result.value.countries[0]?.code).toBe('se');

    expect(result.value.cities).toHaveLength(1);
    expect(result.value.cities[0]?.code).toBe('sto');

    expect(result.value.relays).toHaveLength(2);
  });

  it('sorts countries, cities, and relays', () => {
    const relays = [
      createRelay({
        hostname: 'us-chi-001',
        location: { countryCode: 'us', countryName: 'USA', cityCode: 'chi', cityName: 'Chicago' },
      }),
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ];

    const result = createLocationAliasCatalog(relays);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.countries[0]?.code).toBe('se');
    expect(result.value.countries[1]?.code).toBe('us');
  });

  it('builds country aliases including code and normalized name', () => {
    const relays = [
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ];

    const result = createLocationAliasCatalog(relays);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const country = result.value.countries[0];
    expect(country?.aliases).toContain('se');
    expect(country?.aliases).toContain('sweden');
  });

  it('builds city aliases including code-based and name-based', () => {
    const relays = [
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ];

    const result = createLocationAliasCatalog(relays);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const city = result.value.cities[0];
    expect(city?.aliases).toContain('se-sto');
    expect(city?.aliases).toContain('stockholm');
    expect(city?.aliases).toContain('se-stockholm');
    expect(city?.aliases).toContain('sweden-stockholm');
  });

  it('returns collision failure for duplicate country code with different names', () => {
    const relays = [
      createRelay({
        hostname: 'xx-tst-001',
        location: { countryCode: 'xx', countryName: 'NameA', cityCode: 'tst', cityName: 'City' },
      }),
      createRelay({
        hostname: 'xx-tst-002',
        location: { countryCode: 'xx', countryName: 'NameB', cityCode: 'tst', cityName: 'City' },
      }),
    ];

    const result = createLocationAliasCatalog(relays);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('ALIAS_COLLISION');
    expect(result.phase).toBe('location-aliases');
    expect(result.message).toContain('xx');
  });

  it('returns collision failure for duplicate city key with different names', () => {
    const relays = [
      createRelay({
        hostname: 'xx-aaa-001',
        location: { countryCode: 'xx', countryName: 'Country', cityCode: 'cc', cityName: 'CityA' },
      }),
      createRelay({
        hostname: 'xx-aaa-002',
        location: { countryCode: 'xx', countryName: 'Country', cityCode: 'cc', cityName: 'CityB' },
      }),
    ];

    const result = createLocationAliasCatalog(relays);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('ALIAS_COLLISION');
    expect(result.message).toContain('CityA');
    expect(result.message).toContain('CityB');
  });

  it('handles relays with diacritics in city/country names', () => {
    const relays = [
      createRelay({
        hostname: 'ch-zrh-001',
        location: {
          countryCode: 'ch',
          countryName: 'Suisse',
          cityCode: 'zrh',
          cityName: 'Zürich',
        },
      }),
    ];

    const result = createLocationAliasCatalog(relays);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const city = result.value.cities[0];
    expect(city?.aliases).toContain('zurich');
  });

  it('creates an index with normalized alias keys', () => {
    const relays = [
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ];

    const result = createLocationAliasCatalog(relays);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const index = result.value.index;
    expect(index.se).toBeDefined();
    expect(index.sweden).toBeDefined();
    expect(index['se-sto']).toBeDefined();
    expect(index.stockholm).toBeDefined();
    expect(index['se-sto-001']).toBeDefined();
  });
});

describe('resolveLocationAlias', () => {
  function makeCatalog(relays: MullvadRelay[]) {
    const result = createLocationAliasCatalog(relays);
    if (!result.ok) {
      throw new Error(`Catalog creation failed: ${result.message}`);
    }
    return result.value;
  }

  it('resolves a country code alias', () => {
    const catalog = makeCatalog([
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ]);

    const result = resolveLocationAlias(catalog, 'se');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.kind).toBe('country');
    expect(result.value.countryCode).toBe('se');
    expect(result.alias).toBe('se');
  });

  it('resolves a normalized country name', () => {
    const catalog = makeCatalog([
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ]);

    const result = resolveLocationAlias(catalog, 'Sweden');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.kind).toBe('country');
  });

  it('resolves a city alias (code-based)', () => {
    const catalog = makeCatalog([
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ]);

    const result = resolveLocationAlias(catalog, 'se-sto');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.kind).toBe('city');
    expect(result.value.cityCode).toBe('sto');
  });

  it('resolves a relay hostname', () => {
    const catalog = makeCatalog([
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ]);

    const result = resolveLocationAlias(catalog, 'se-sto-001');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.kind).toBe('relay');
    expect(result.value.hostname).toBe('se-sto-001');
  });

  it('returns ALIAS_NOT_FOUND for unknown alias', () => {
    const catalog = makeCatalog([
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ]);

    const result = resolveLocationAlias(catalog, 'zz-top');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('ALIAS_NOT_FOUND');
    expect(result.phase).toBe('location-lookup');
  });

  it('returns ALIAS_AMBIGUOUS for alias matching multiple targets', () => {
    const _catalog = makeCatalog([
      createRelay({
        hostname: 'xx-aaa-001',
        location: { countryCode: 'xx', countryName: 'Xland', cityCode: 'aaa', cityName: 'CityA' },
      }),
      createRelay({
        hostname: 'yy-bbb-002',
        location: { countryCode: 'yy', countryName: 'Yland', cityCode: 'bbb', cityName: 'CityB' },
      }),
    ]);

    // cityA "citya" may collide with cityB "cityb" depending on normalization
    // Test that a clearly ambiguous city name is handled
    // Both relays have the same city name -> the city slug alone is ambiguous
    // Actually let's test with two countries where a city slug happens to match
    const catalog2 = makeCatalog([
      createRelay({
        hostname: 'xx-par-001',
        location: { countryCode: 'xx', countryName: 'Xland', cityCode: 'par', cityName: 'Paris' },
      }),
      createRelay({
        hostname: 'yy-par-002',
        location: { countryCode: 'yy', countryName: 'Yland', cityCode: 'par', cityName: 'Paris' },
      }),
    ]);

    const result = resolveLocationAlias(catalog2, 'paris');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('ALIAS_AMBIGUOUS');
  });

  it('normalizes input before lookup', () => {
    const catalog = makeCatalog([
      createRelay({
        hostname: 'se-sto-001',
        location: {
          countryCode: 'se',
          countryName: 'Sweden',
          cityCode: 'sto',
          cityName: 'Stockholm',
        },
      }),
    ]);

    const result = resolveLocationAlias(catalog, 'SWEDEN');
    expect(result.ok).toBe(true);
  });
});
