import { resolveRegionCountryCodes } from '../domain/region-groups.js';
import type { MullvadRelay, MullvadRelayCatalog } from '../mullvad/fetch-relays.js';
import type {
  ProxyExportSelector,
  RelayOwnerFilter,
  RelayRunModeFilter,
} from './proxy-export-selectors.js';

export type ProxyExportEntry = {
  readonly routeIndex: number;
  readonly alias: string;
  readonly hostname: string;
  readonly countryCode: string | null;
  readonly cityCode: string | null;
  readonly relayHostname: string | null;
  readonly provider: string | null;
  readonly owner: RelayOwnerFilter | null;
  readonly runMode: Exclude<RelayRunModeFilter, 'all'> | null;
  readonly portSpeed: number | null;
  readonly url: string;
};

export function renderProxyExportSelectorLabel(selector: ProxyExportSelector): string {
  const parts =
    selector.kind === 'region'
      ? [`region=${selector.value}`]
      : [
          `country=${selector.value}`,
          ...(selector.city ? [`city=${selector.city}`] : []),
          ...(selector.server ? [`server=${selector.server}`] : []),
        ];

  return [
    ...parts,
    ...(selector.providers.length > 0 ? [`providers=${selector.providers.join(',')}`] : []),
    ...(selector.owner !== 'all' ? [`owner=${selector.owner}`] : []),
    ...(selector.runMode !== 'all' ? [`run-mode=${selector.runMode}`] : []),
    ...(selector.minPortSpeed !== null ? [`min-port-speed=${selector.minPortSpeed}`] : []),
  ].join(' ');
}

export function listMatchingRelays(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode?: string;
  readonly cityCode?: string;
  readonly providers: readonly string[];
  readonly owner?: RelayOwnerFilter;
  readonly runMode?: RelayRunModeFilter;
  readonly minPortSpeed?: number | null;
  readonly includeInactive?: boolean;
}): MullvadRelay[] {
  const providers = new Set(input.providers.map((provider) => provider.toLowerCase()));
  const owner = input.owner ?? 'all';
  const runMode = input.runMode ?? 'all';
  const minPortSpeed = input.minPortSpeed ?? null;
  const includeInactive = input.includeInactive ?? false;

  return [...input.relayCatalog.relays]
    .filter((relay) => {
      if (!includeInactive && !relay.active) {
        return false;
      }

      if (input.countryCode && relay.location.countryCode !== input.countryCode) {
        return false;
      }

      if (input.cityCode && relay.location.cityCode !== input.cityCode) {
        return false;
      }

      if (providers.size > 0 && (!relay.provider || !providers.has(relay.provider.toLowerCase()))) {
        return false;
      }

      if (owner === 'mullvad' && !relay.owned) {
        return false;
      }

      if (owner === 'rented' && relay.owned) {
        return false;
      }

      if (runMode === 'ram' && relay.stboot !== true) {
        return false;
      }

      if (runMode === 'disk' && relay.stboot === true) {
        return false;
      }

      if (minPortSpeed !== null && (relay.networkPortSpeed ?? 0) < minPortSpeed) {
        return false;
      }

      return true;
    })
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        Number(right.owned) - Number(left.owned) ||
        (right.networkPortSpeed ?? 0) - (left.networkPortSpeed ?? 0) ||
        left.location.countryCode.localeCompare(right.location.countryCode) ||
        left.location.cityCode.localeCompare(right.location.cityCode) ||
        left.hostname.localeCompare(right.hostname),
    );
}

export function chooseRelaysForProxyExportSelector(input: {
  readonly selector: ProxyExportSelector;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly count: number;
  readonly excludedRelayHostnames: ReadonlySet<string>;
}): MullvadRelay[] {
  if (input.selector.kind === 'region') {
    const countryCodes = resolveRegionCountryCodes(input.selector.value) ?? [];

    return chooseSpreadRelays({
      candidates: listMatchingRelays({
        relayCatalog: input.relayCatalog,
        providers: input.selector.providers,
        owner: input.selector.owner,
        runMode: input.selector.runMode,
        minPortSpeed: input.selector.minPortSpeed,
      }).filter(
        (relay) =>
          countryCodes.includes(relay.location.countryCode) &&
          !input.excludedRelayHostnames.has(relay.hostname),
      ),
      count: input.count,
      spreadKey: (relay) => relay.location.countryCode,
    });
  }

  if (input.selector.server) {
    const relay = listMatchingRelays({
      relayCatalog: input.relayCatalog,
      countryCode: input.selector.value,
      ...(input.selector.city ? { cityCode: input.selector.city } : {}),
      providers: input.selector.providers,
      owner: input.selector.owner,
      runMode: input.selector.runMode,
      minPortSpeed: input.selector.minPortSpeed,
    }).find(
      (candidate) =>
        candidate.hostname === input.selector.server &&
        !input.excludedRelayHostnames.has(candidate.hostname),
    );

    return relay ? [relay] : [];
  }

  const candidates = listMatchingRelays({
    relayCatalog: input.relayCatalog,
    countryCode: input.selector.value,
    ...(input.selector.city ? { cityCode: input.selector.city } : {}),
    providers: input.selector.providers,
    owner: input.selector.owner,
    runMode: input.selector.runMode,
    minPortSpeed: input.selector.minPortSpeed,
  }).filter((relay) => !input.excludedRelayHostnames.has(relay.hostname));

  return chooseSpreadRelays({
    candidates,
    count: input.count,
    spreadKey: input.selector.city ? (relay) => relay.hostname : (relay) => relay.location.cityCode,
  });
}

export function chooseSpreadRelays(input: {
  readonly candidates: readonly MullvadRelay[];
  readonly count: number;
  readonly spreadKey: (relay: MullvadRelay) => string;
}): MullvadRelay[] {
  const grouped = new Map<string, MullvadRelay[]>();

  input.candidates.forEach((relay) => {
    const key = input.spreadKey(relay);
    const existing = grouped.get(key);

    if (existing) {
      existing.push(relay);
      return;
    }

    grouped.set(key, [relay]);
  });

  const groupKeys = [...grouped.keys()].sort((left, right) => left.localeCompare(right));
  const selected: MullvadRelay[] = [];

  while (selected.length < input.count) {
    let pickedAny = false;

    groupKeys.forEach((key) => {
      if (selected.length >= input.count) {
        return;
      }

      const relays = grouped.get(key);
      const nextRelay = relays?.shift();

      if (!nextRelay) {
        return;
      }

      selected.push(nextRelay);
      pickedAny = true;
    });

    if (!pickedAny) {
      return selected;
    }
  }

  return selected;
}

export function matchesProxyExportSelector(input: {
  readonly selector: ProxyExportSelector;
  readonly entry: ProxyExportEntry;
}): boolean {
  if (!input.entry.countryCode) {
    return false;
  }

  if (
    input.selector.providers.length > 0 &&
    (!input.entry.provider ||
      !input.selector.providers.some(
        (provider) => provider.toLowerCase() === input.entry.provider?.toLowerCase(),
      ))
  ) {
    return false;
  }

  if (input.selector.owner !== 'all' && input.entry.owner !== input.selector.owner) {
    return false;
  }

  if (input.selector.runMode !== 'all' && input.entry.runMode !== input.selector.runMode) {
    return false;
  }

  if (
    input.selector.minPortSpeed !== null &&
    (input.entry.portSpeed ?? 0) < input.selector.minPortSpeed
  ) {
    return false;
  }

  if (input.selector.kind === 'country') {
    if (input.entry.countryCode !== input.selector.value) {
      return false;
    }

    if (input.selector.city && input.entry.cityCode !== input.selector.city) {
      return false;
    }

    if (input.selector.server && input.entry.relayHostname !== input.selector.server) {
      return false;
    }

    return true;
  }

  const regionCountryCodes = resolveRegionCountryCodes(input.selector.value);
  return regionCountryCodes ? regionCountryCodes.includes(input.entry.countryCode) : false;
}
