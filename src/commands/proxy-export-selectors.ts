export type RelayOwnerFilter = 'mullvad' | 'rented' | 'all';
export type RelayRunModeFilter = 'ram' | 'disk' | 'all';

export type ProxyExportSelector = {
  readonly kind: 'country' | 'region';
  readonly value: string;
  readonly city?: string;
  readonly server?: string;
  readonly providers: readonly string[];
  readonly owner: RelayOwnerFilter;
  readonly runMode: RelayRunModeFilter;
  readonly minPortSpeed: number | null;
  readonly requestedCount: number | 'all' | null;
};

export type ProxyExportFailure = {
  readonly ok: false;
  readonly phase: string;
  readonly source: string;
  readonly message: string;
  readonly configPath?: string;
  readonly artifactPath?: string;
  readonly cause?: string;
};

type ProxyExportSelectorParseResult =
  | {
      readonly ok: true;
      readonly selectors: readonly ProxyExportSelector[];
    }
  | ProxyExportFailure;

type ProxyExportSelectorParserState = {
  readonly selectors: ProxyExportSelector[];
};

type ProxyExportSelectorOptionSpec = {
  readonly flag: string;
  readonly apply: (
    state: ProxyExportSelectorParserState,
    value: string,
  ) => ProxyExportFailure | null;
};

export function parseProxyExportSelectors(
  tokens: readonly string[],
): ProxyExportSelectorParseResult {
  const state: ProxyExportSelectorParserState = { selectors: [] };

  try {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];

      if (!token) {
        continue;
      }

      const parsedOption = readProxyExportSelectorOption({
        token,
        nextToken: tokens[index + 1],
      });

      if (!parsedOption) {
        continue;
      }

      const failure = parsedOption.spec.apply(state, parsedOption.value);

      if (failure) {
        return failure;
      }

      index += parsedOption.consumedNextToken ? 1 : 0;
    }
  } catch (error) {
    return proxyExportSelectorInputError(error instanceof Error ? error.message : String(error));
  }

  return {
    ok: true,
    selectors: state.selectors,
  };
}

export function extractOrderedCommandArgs(input: {
  readonly argv: readonly string[];
  readonly commandPath: readonly string[];
}): string[] {
  if (input.commandPath.length === 0) {
    return [];
  }

  for (let index = 0; index <= input.argv.length - input.commandPath.length; index += 1) {
    const matches = input.commandPath.every(
      (segment, offset) => input.argv[index + offset] === segment,
    );

    if (matches) {
      return input.argv.slice(index + input.commandPath.length);
    }
  }

  return [];
}

export function extractProxyExportArgs(argv: readonly string[]): string[] {
  const proxyExport = extractOrderedCommandArgs({
    argv,
    commandPath: ['proxy', 'export'],
  });

  if (proxyExport.length > 0) {
    return proxyExport;
  }

  const topLevel = extractOrderedCommandArgs({
    argv,
    commandPath: ['export'],
  });

  if (topLevel.length > 0) {
    return topLevel;
  }

  return extractOrderedCommandArgs({
    argv,
    commandPath: ['config', 'export'],
  });
}

const PROXY_EXPORT_SELECTOR_OPTION_SPECS: readonly ProxyExportSelectorOptionSpec[] = [
  { flag: '--country', apply: appendCountryProxyExportSelector },
  { flag: '--region', apply: appendRegionProxyExportSelector },
  { flag: '--city', apply: applyProxyExportCityFilter },
  { flag: '--server', apply: applyProxyExportServerFilter },
  { flag: '--provider', apply: applyProxyExportProviderFilter },
  { flag: '--owner', apply: applyProxyExportOwnerFilter },
  { flag: '--run-mode', apply: applyProxyExportRunModeFilter },
  { flag: '--min-port-speed', apply: applyProxyExportMinPortSpeedFilter },
  { flag: '--count', apply: applyProxyExportCount },
  { flag: '--protocol', apply: ignoreProxyExportSelectorOption },
  { flag: '--output', apply: ignoreProxyExportSelectorOption },
];

function readProxyExportSelectorOption(input: {
  readonly token: string;
  readonly nextToken: string | undefined;
}): {
  readonly spec: ProxyExportSelectorOptionSpec;
  readonly value: string;
  readonly consumedNextToken: boolean;
} | null {
  for (const spec of PROXY_EXPORT_SELECTOR_OPTION_SPECS) {
    const option = readCliOptionValue({
      flag: spec.flag,
      token: input.token,
      nextToken: input.nextToken,
    });

    if (option.matched) {
      return {
        spec,
        value: option.value,
        consumedNextToken: option.consumedNextToken,
      };
    }
  }

  return null;
}

function appendCountryProxyExportSelector(
  state: ProxyExportSelectorParserState,
  value: string,
): null {
  state.selectors.push(createProxyExportSelector('country', value));
  return null;
}

function appendRegionProxyExportSelector(
  state: ProxyExportSelectorParserState,
  value: string,
): null {
  state.selectors.push(createProxyExportSelector('region', value));
  return null;
}

function applyProxyExportCityFilter(
  state: ProxyExportSelectorParserState,
  value: string,
): ProxyExportFailure | null {
  const previousSelector = getLastProxyExportSelector(state);

  if (!previousSelector || previousSelector.kind !== 'country') {
    return proxyExportSelectorInputError('Pass --city after a --country selector.');
  }

  if (previousSelector.city) {
    return proxyExportSelectorInputError(
      `Selector country=${previousSelector.value} already has a --city.`,
    );
  }

  if (previousSelector.server) {
    return proxyExportSelectorInputError(
      `Selector country=${previousSelector.value} already has a --server, so --city is redundant.`,
    );
  }

  replaceLastProxyExportSelector(state, {
    ...previousSelector,
    city: normalizeProxyExportSelectorValue(value, 'country'),
  });
  return null;
}

function applyProxyExportServerFilter(
  state: ProxyExportSelectorParserState,
  value: string,
): ProxyExportFailure | null {
  const previousSelector = getLastProxyExportSelector(state);

  if (!previousSelector || previousSelector.kind !== 'country') {
    return proxyExportSelectorInputError('Pass --server after a --country selector.');
  }

  if (previousSelector.server) {
    return proxyExportSelectorInputError(
      `Selector country=${previousSelector.value} already has a --server.`,
    );
  }

  replaceLastProxyExportSelector(state, {
    ...previousSelector,
    server: normalizeProxyExportSelectorValue(value, 'country'),
  });
  return null;
}

function applyProxyExportProviderFilter(
  state: ProxyExportSelectorParserState,
  value: string,
): ProxyExportFailure | null {
  const previousSelector = getLastProxyExportSelector(state);

  if (!previousSelector) {
    return proxyExportSelectorInputError('Pass --provider after a --country or --region selector.');
  }

  replaceLastProxyExportSelector(state, {
    ...previousSelector,
    providers: [...previousSelector.providers, value.trim()],
  });
  return null;
}

function applyProxyExportOwnerFilter(
  state: ProxyExportSelectorParserState,
  value: string,
): ProxyExportFailure | null {
  const previousSelector = getLastProxyExportSelector(state);

  if (!previousSelector) {
    return proxyExportSelectorInputError('Pass --owner after a --country or --region selector.');
  }

  if (previousSelector.owner !== 'all') {
    return proxyExportSelectorInputError(
      `Selector ${previousSelector.kind}=${previousSelector.value} already has an --owner filter.`,
    );
  }

  replaceLastProxyExportSelector(state, {
    ...previousSelector,
    owner: parseRelayOwnerFilter(value),
  });
  return null;
}

function applyProxyExportRunModeFilter(
  state: ProxyExportSelectorParserState,
  value: string,
): ProxyExportFailure | null {
  const previousSelector = getLastProxyExportSelector(state);

  if (!previousSelector) {
    return proxyExportSelectorInputError('Pass --run-mode after a --country or --region selector.');
  }

  if (previousSelector.runMode !== 'all') {
    return proxyExportSelectorInputError(
      `Selector ${previousSelector.kind}=${previousSelector.value} already has a --run-mode filter.`,
    );
  }

  replaceLastProxyExportSelector(state, {
    ...previousSelector,
    runMode: parseRelayRunModeFilter(value),
  });
  return null;
}

function applyProxyExportMinPortSpeedFilter(
  state: ProxyExportSelectorParserState,
  value: string,
): ProxyExportFailure | null {
  const previousSelector = getLastProxyExportSelector(state);

  if (!previousSelector) {
    return proxyExportSelectorInputError(
      'Pass --min-port-speed after a --country or --region selector.',
    );
  }

  if (previousSelector.minPortSpeed !== null) {
    return proxyExportSelectorInputError(
      `Selector ${previousSelector.kind}=${previousSelector.value} already has a --min-port-speed filter.`,
    );
  }

  replaceLastProxyExportSelector(state, {
    ...previousSelector,
    minPortSpeed: parseProxyExportMinPortSpeed(value),
  });
  return null;
}

function applyProxyExportCount(
  state: ProxyExportSelectorParserState,
  value: string,
): ProxyExportFailure | null {
  const previousSelector = getLastProxyExportSelector(state);

  if (!previousSelector) {
    return proxyExportSelectorInputError('Pass --count after a --country or --region selector.');
  }

  if (previousSelector.requestedCount !== null) {
    return proxyExportSelectorInputError(
      `Selector ${previousSelector.kind}=${previousSelector.value} already has a --count.`,
    );
  }

  replaceLastProxyExportSelector(state, {
    ...previousSelector,
    requestedCount: parseProxyExportCount(value),
  });
  return null;
}

function ignoreProxyExportSelectorOption(): null {
  return null;
}

function createProxyExportSelector(
  kind: ProxyExportSelector['kind'],
  value: string,
): ProxyExportSelector {
  return {
    kind,
    value: normalizeProxyExportSelectorValue(value, kind),
    providers: [],
    owner: 'all',
    runMode: 'all',
    minPortSpeed: null,
    requestedCount: null,
  };
}

function getLastProxyExportSelector(
  state: ProxyExportSelectorParserState,
): ProxyExportSelector | undefined {
  return state.selectors.at(-1);
}

function replaceLastProxyExportSelector(
  state: ProxyExportSelectorParserState,
  selector: ProxyExportSelector,
): void {
  state.selectors[state.selectors.length - 1] = selector;
}

function proxyExportSelectorInputError(message: string): ProxyExportFailure {
  return {
    ok: false,
    phase: 'export-proxies',
    source: 'input',
    message,
  };
}

export function parseRelayOwnerFilter(raw: string): RelayOwnerFilter {
  const normalized = raw.trim().toLowerCase();

  if (normalized === 'mullvad' || normalized === 'rented' || normalized === 'all') {
    return normalized;
  }

  throw new Error(`Relay ownership ${formatRawInput(raw)} must be one of mullvad, rented, or all.`);
}

export function parseRelayRunModeFilter(raw: string): RelayRunModeFilter {
  const normalized = raw.trim().toLowerCase();

  if (normalized === 'ram' || normalized === 'disk' || normalized === 'all') {
    return normalized;
  }

  throw new Error(`Relay run mode ${formatRawInput(raw)} must be one of ram, disk, or all.`);
}

export function parseProxyExportMinPortSpeed(raw: string): number {
  const value = Number(raw.trim());

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Minimum port speed ${formatRawInput(raw)} must be a positive integer.`);
  }

  return value;
}

export function normalizeProxyExportSelectorValue(
  value: string,
  kind: ProxyExportSelector['kind'],
): string {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    throw new Error(`A non-empty ${kind} selector value is required.`);
  }

  return normalized;
}

export function parseProxyExportCount(raw: string): number | 'all' {
  const normalized = raw.trim().toLowerCase();

  if (normalized === 'all') {
    return 'all';
  }

  const value = Number(normalized);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Selector counts must be positive integers.');
  }

  return value;
}

function readCliOptionValue(input: {
  readonly flag: string;
  readonly token: string;
  readonly nextToken: string | undefined;
}):
  | {
      readonly matched: true;
      readonly value: string;
      readonly consumedNextToken: boolean;
    }
  | {
      readonly matched: false;
      readonly consumedNextToken: false;
    } {
  if (input.token === input.flag) {
    if (!input.nextToken || input.nextToken.startsWith('--')) {
      throw new Error(`${input.flag} requires a value.`);
    }

    return {
      matched: true,
      value: input.nextToken,
      consumedNextToken: true,
    };
  }

  if (input.token.startsWith(`${input.flag}=`)) {
    return {
      matched: true,
      value: input.token.slice(input.flag.length + 1),
      consumedNextToken: false,
    };
  }

  return {
    matched: false,
    consumedNextToken: false,
  };
}

function formatRawInput(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? JSON.stringify(trimmed) : 'an empty value';
}
