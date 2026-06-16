import { listRegionGroupNames, resolveRegionCountryCodes } from '../domain/region-groups.js';
import type { MullvadRelayCatalog } from '../mullvad/fetch-relays.js';
import type {
  ProxyExportProtocol,
  ProxyExportResolvedInput,
  ProxyExportWriteMode,
} from './proxy-export-plan.js';
import {
  createGuidedPromptClient,
  describePromptStep,
  GUIDED_PROMPT_CANCELLED,
  type GuidedPromptClient,
  type PromptSelectOption,
} from './proxy-export-prompt-client.js';
import { listMatchingRelays } from './proxy-export-relays.js';
import {
  type ProxyExportFailure,
  type ProxyExportSelector,
  parseProxyExportCount,
} from './proxy-export-selectors.js';

type GuidedProxyExportSelectorSeed = {
  readonly kind: ProxyExportSelector['kind'];
  readonly value: string;
};

export async function collectGuidedProxyExportInput(input: {
  readonly initialProtocol?: ProxyExportProtocol;
  readonly initialSelectors: readonly ProxyExportSelector[];
  readonly initialWriteMode: ProxyExportWriteMode;
  readonly initialOutputPath?: string;
  readonly force: boolean;
  readonly configPath: string;
  readonly relayCatalog: MullvadRelayCatalog;
}): Promise<{ readonly ok: true; readonly value: ProxyExportResolvedInput } | ProxyExportFailure> {
  const prompts = createGuidedPromptClient();

  try {
    prompts.intro(
      'Mullgate proxy export\nBuild a ready-to-paste proxy list from your saved routes.',
    );

    const protocol =
      input.initialProtocol ??
      (await prompts.select({
        message: describePromptStep(
          'Proxy protocol',
          'Pick the scheme your clients expect in the exported proxy URLs.',
        ),
        initialValue: 'socks5',
        options: [
          { value: 'socks5', label: 'SOCKS5' },
          { value: 'http', label: 'HTTP' },
          { value: 'https', label: 'HTTPS' },
        ],
      }));

    if (protocol === GUIDED_PROMPT_CANCELLED) {
      prompts.cancel('Guided export cancelled.');
      return createGuidedCancellation(input.configPath);
    }

    const selectors =
      input.initialSelectors.length > 0
        ? input.initialSelectors
        : await collectGuidedProxyExportSelectors(prompts, input.relayCatalog);

    if (selectors === GUIDED_PROMPT_CANCELLED) {
      prompts.cancel('Guided export cancelled.');
      return createGuidedCancellation(input.configPath);
    }

    const resolvedWriteMode =
      input.initialWriteMode !== 'file' || input.initialOutputPath !== undefined
        ? input.initialWriteMode
        : await prompts.select({
            message: describePromptStep(
              'Output mode',
              'Choose whether Mullgate should write a file, print the list, or just preview it.',
            ),
            initialValue: 'file',
            options: [
              { value: 'file', label: 'Write file' },
              { value: 'stdout', label: 'Print to stdout' },
              { value: 'dry-run', label: 'Preview only' },
            ],
          });

    if (resolvedWriteMode === GUIDED_PROMPT_CANCELLED) {
      prompts.cancel('Guided export cancelled.');
      return createGuidedCancellation(input.configPath);
    }

    const writeMode = parseProxyExportWriteMode(resolvedWriteMode);
    let outputPath = input.initialOutputPath;

    if (writeMode === 'file' && !outputPath) {
      const promptedOutputPath = await prompts.text({
        message: describePromptStep(
          'Output path',
          'Choose where Mullgate should write the proxy list file.',
        ),
        initialValue: 'proxies.txt',
        placeholder: 'proxies.txt',
        validate: (value) =>
          readOptionalString(value) ? undefined : 'Output path is required when writing a file.',
      });

      if (promptedOutputPath === GUIDED_PROMPT_CANCELLED) {
        prompts.cancel('Guided export cancelled.');
        return createGuidedCancellation(input.configPath);
      }

      outputPath = promptedOutputPath.trim();
    }

    prompts.outro(
      writeMode === 'file'
        ? `Will export ${selectors.length === 0 ? 'all configured routes' : `${selectors.length} selector batches`} to ${outputPath}.`
        : `Will ${writeMode === 'stdout' ? 'print' : 'preview'} ${selectors.length === 0 ? 'all configured routes' : `${selectors.length} selector batches`} via ${writeMode}.`,
    );

    return {
      ok: true,
      value: {
        protocol: parseProxyExportProtocol(protocol),
        selectors,
        writeMode,
        ...(outputPath ? { outputPath } : {}),
        force: input.force,
      },
    };
  } finally {
    await prompts.close();
  }
}

async function collectGuidedProxyExportSelectors(
  prompts: GuidedPromptClient,
  relayCatalog: MullvadRelayCatalog,
): Promise<readonly ProxyExportSelector[] | typeof GUIDED_PROMPT_CANCELLED> {
  const filterExport = await prompts.confirm({
    message: describePromptStep(
      'Filter the export?',
      'Choose specific countries or region groups if you do not want every configured route in the file.',
    ),
    initialValue: false,
    active: 'Yes',
    inactive: 'No',
  });

  if (filterExport === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  if (!filterExport) {
    return [];
  }

  const countryOptions = buildCountryPromptOptions(relayCatalog);
  const regionOptions = listRegionGroupNames().map((region) => ({
    value: region,
    label: region,
    hint: `${resolveRegionCountryCodes(region)?.length ?? 0} countries`,
  }));

  const selectedSeeds = await collectGuidedProxyExportSelectorSeeds({
    prompts,
    countryOptions,
    regionOptions,
  });

  if (selectedSeeds === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const selectors: ProxyExportSelector[] = [];

  for (const seed of selectedSeeds) {
    const selector = await collectGuidedProxyExportSelectorFromSeed({
      prompts,
      relayCatalog,
      countryOptions,
      regionOptions,
      seed,
    });

    if (selector === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    selectors.push(selector);
  }

  while (true) {
    const addAnother = await prompts.confirm({
      message: describePromptStep(
        selectors.length === 0 ? 'Add a selector batch?' : 'Add another selector batch?',
        'Each batch can target one country or region, plus optional provider, city, server, and count filters.',
      ),
      initialValue: selectors.length === 0,
      active: 'Yes',
      inactive: 'No',
    });

    if (addAnother === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    if (!addAnother) {
      return selectors;
    }

    const selector = await collectGuidedProxyExportSelectorFromSeed({
      prompts,
      relayCatalog,
      countryOptions,
      regionOptions,
    });

    if (selector === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    selectors.push(selector);
  }
}

async function collectGuidedProxyExportSelectorSeeds(input: {
  readonly prompts: GuidedPromptClient;
  readonly countryOptions: readonly PromptSelectOption[];
  readonly regionOptions: readonly PromptSelectOption[];
}): Promise<readonly GuidedProxyExportSelectorSeed[] | typeof GUIDED_PROMPT_CANCELLED> {
  while (true) {
    const selectedCountries = await input.prompts.multiselect({
      message: describePromptStep(
        'Country batches',
        'Select one or more countries to turn into export batches.',
      ),
      options: input.countryOptions,
      placeholder: 'Select one or more countries',
    });

    if (selectedCountries === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    const selectedRegions = await input.prompts.multiselect({
      message: describePromptStep(
        'Region batches',
        'Select one or more built-in region groups such as Europe or Americas.',
      ),
      options: input.regionOptions,
      placeholder: 'Select one or more region groups',
    });

    if (selectedRegions === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    if (selectedCountries.length > 0 || selectedRegions.length > 0) {
      return [
        ...selectedCountries.map((value) => ({ kind: 'country' as const, value })),
        ...selectedRegions.map((value) => ({ kind: 'region' as const, value })),
      ];
    }

    const manualOnly = await input.prompts.confirm({
      message: describePromptStep(
        'Nothing selected from the lists yet.',
        'You can keep using the checklists or switch to building batches one at a time.',
      ),
      initialValue: true,
      active: 'Yes',
      inactive: 'Select from lists',
    });

    if (manualOnly === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    if (manualOnly) {
      return [];
    }
  }
}

async function collectGuidedProxyExportSelectorFromSeed(input: {
  readonly prompts: GuidedPromptClient;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryOptions: readonly PromptSelectOption[];
  readonly regionOptions: readonly PromptSelectOption[];
  readonly seed?: GuidedProxyExportSelectorSeed;
}): Promise<ProxyExportSelector | typeof GUIDED_PROMPT_CANCELLED> {
  const seed =
    input.seed ??
    (await collectManualGuidedProxyExportSelectorSeed({
      prompts: input.prompts,
      countryOptions: input.countryOptions,
      regionOptions: input.regionOptions,
    }));

  if (seed === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  if (seed.kind === 'region') {
    return collectGuidedRegionSelector({
      prompts: input.prompts,
      relayCatalog: input.relayCatalog,
      region: seed.value,
    });
  }

  return collectGuidedCountrySelector({
    prompts: input.prompts,
    relayCatalog: input.relayCatalog,
    countryCode: seed.value,
  });
}

async function collectManualGuidedProxyExportSelectorSeed(input: {
  readonly prompts: GuidedPromptClient;
  readonly countryOptions: readonly PromptSelectOption[];
  readonly regionOptions: readonly PromptSelectOption[];
}): Promise<GuidedProxyExportSelectorSeed | typeof GUIDED_PROMPT_CANCELLED> {
  const selectorType = await input.prompts.select({
    message: describePromptStep(
      'Selector type',
      'Choose whether this batch targets one country or one built-in region group.',
    ),
    initialValue: 'country',
    options: [
      { value: 'country', label: 'Country' },
      { value: 'region', label: 'Region' },
    ],
  });

  if (selectorType === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const kind = parseProxyExportSelectorType(selectorType);

  if (kind === 'region') {
    const region = await input.prompts.select({
      message: describePromptStep(
        'Region',
        'Pick the region group that should feed this export batch.',
      ),
      options: input.regionOptions,
      placeholder: 'Europe, Americas, Asia-Pacific',
    });

    if (region === GUIDED_PROMPT_CANCELLED) {
      return GUIDED_PROMPT_CANCELLED;
    }

    return {
      kind: 'region',
      value: region,
    };
  }

  const countryCode = await input.prompts.select({
    message: describePromptStep('Country', 'Pick the country that should feed this export batch.'),
    options: input.countryOptions,
    placeholder: 'Sweden, Austria, United States',
  });

  if (countryCode === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  return {
    kind: 'country',
    value: countryCode,
  };
}

async function collectGuidedRegionSelector(input: {
  readonly prompts: GuidedPromptClient;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly region: string;
}): Promise<ProxyExportSelector | typeof GUIDED_PROMPT_CANCELLED> {
  const providerOptions = buildProviderPromptOptions({ relayCatalog: input.relayCatalog });
  const providerFilter =
    providerOptions.length > 0
      ? await input.prompts.confirm({
          message: describePromptStep(
            `Filter ${input.region} by provider?`,
            'Use this if you want only specific Mullvad hosting providers for this batch.',
          ),
          initialValue: false,
          active: 'Yes',
          inactive: 'No',
        })
      : false;

  if (providerFilter === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const providers =
    providerFilter && providerOptions.length > 0
      ? await input.prompts.multiselect({
          message: describePromptStep(
            `Providers for ${input.region}`,
            'Select one or more providers to keep in this region batch.',
          ),
          options: providerOptions,
          placeholder: 'm247, xtom, datawagon',
        })
      : [];

  if (providers === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const selectorCount = await input.prompts.text({
    message: describePromptStep(
      `Count for ${input.region} (number or all)`,
      'Set how many proxies this batch should contribute, or use "all".',
    ),
    initialValue: '1',
    validate: validateProxyExportSelectorCountInput,
  });

  if (selectorCount === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  return {
    kind: 'region',
    value: input.region,
    providers,
    owner: 'all',
    runMode: 'all',
    minPortSpeed: null,
    requestedCount: parseGuidedProxyExportCount(selectorCount),
  };
}

async function collectGuidedCountrySelector(input: {
  readonly prompts: GuidedPromptClient;
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode: string;
}): Promise<ProxyExportSelector | typeof GUIDED_PROMPT_CANCELLED> {
  const countryLabel = describeGuidedCountrySelector(input.relayCatalog, input.countryCode);
  const cityOptions = buildCityPromptOptions({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
  });
  const cityFilter =
    cityOptions.length > 0
      ? await input.prompts.confirm({
          message: describePromptStep(
            `Pin ${countryLabel} to a city?`,
            'Choose one city if you want a tighter location filter than the whole country.',
          ),
          initialValue: false,
          active: 'Yes',
          inactive: 'No',
        })
      : false;

  if (cityFilter === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const city =
    cityFilter && cityOptions.length > 0
      ? await input.prompts.select({
          message: describePromptStep(
            `${countryLabel} city`,
            'Pick the city that should feed this country batch.',
          ),
          options: cityOptions,
          placeholder: 'Gothenburg, Vienna, New York',
        })
      : undefined;

  if (city === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const providerOptions = buildProviderPromptOptions({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
    ...(typeof city === 'string' ? { cityCode: city } : {}),
  });
  const providerFilter =
    providerOptions.length > 0
      ? await input.prompts.confirm({
          message: describePromptStep(
            `Filter ${countryLabel} by provider?`,
            'Use this if you want only specific Mullvad hosting providers for this country batch.',
          ),
          initialValue: false,
          active: 'Yes',
          inactive: 'No',
        })
      : false;

  if (providerFilter === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const providers =
    providerFilter && providerOptions.length > 0
      ? await input.prompts.multiselect({
          message: describePromptStep(
            `${countryLabel} providers`,
            'Select one or more providers to keep in this batch.',
          ),
          options: providerOptions,
          placeholder: 'm247, xtom, datawagon',
        })
      : [];

  if (providers === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const serverOptions = buildServerPromptOptions({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
    ...(typeof city === 'string' ? { cityCode: city } : {}),
    providers,
  });
  const serverFilter =
    serverOptions.length > 0
      ? await input.prompts.confirm({
          message: describePromptStep(
            `Pin ${countryLabel} to one exact server?`,
            'Use this only when you want a single named Mullvad relay host.',
          ),
          initialValue: false,
          active: 'Yes',
          inactive: 'No',
        })
      : false;

  if (serverFilter === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const server =
    serverFilter && serverOptions.length > 0
      ? await input.prompts.select({
          message: describePromptStep(
            `${countryLabel} server`,
            'Pick the exact relay hostname for this batch.',
          ),
          options: serverOptions,
          placeholder: 'se-got-wg-101, at-vie-wg-001',
        })
      : undefined;

  if (server === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  const selectorCount =
    typeof server === 'string'
      ? '1'
      : await input.prompts.text({
          message: describePromptStep(
            `Count for ${countryLabel} (number or all)`,
            'Set how many proxies this batch should contribute, or use "all".',
          ),
          initialValue: '1',
          validate: validateProxyExportSelectorCountInput,
        });

  if (selectorCount === GUIDED_PROMPT_CANCELLED) {
    return GUIDED_PROMPT_CANCELLED;
  }

  return {
    kind: 'country',
    value: input.countryCode,
    ...(typeof city === 'string' ? { city } : {}),
    ...(typeof server === 'string' ? { server } : {}),
    providers,
    owner: 'all',
    runMode: 'all',
    minPortSpeed: null,
    requestedCount: parseGuidedProxyExportCount(selectorCount),
  };
}

function buildCountryPromptOptions(
  relayCatalog: MullvadRelayCatalog,
): readonly PromptSelectOption[] {
  return relayCatalog.countries.map((country) => ({
    value: country.code,
    label: `${country.name} (${country.code})`,
    hint: `${country.cities.length} cities`,
  }));
}

function buildCityPromptOptions(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode: string;
}): readonly PromptSelectOption[] {
  const country = input.relayCatalog.countries.find((entry) => entry.code === input.countryCode);

  if (!country) {
    return [];
  }

  return country.cities.map((city) => ({
    value: city.code,
    label: `${city.name} (${city.code})`,
    hint: `${city.relayCount} servers`,
  }));
}

function buildServerPromptOptions(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode: string;
  readonly cityCode?: string;
  readonly providers: readonly string[];
}): readonly PromptSelectOption[] {
  return listMatchingRelays({
    relayCatalog: input.relayCatalog,
    countryCode: input.countryCode,
    ...(input.cityCode ? { cityCode: input.cityCode } : {}),
    providers: input.providers,
  }).map((relay) => ({
    value: relay.hostname,
    label: relay.hostname,
    hint: `${relay.location.countryName} / ${relay.location.cityName}${relay.provider ? ` / ${relay.provider}` : ''}`,
  }));
}

function buildProviderPromptOptions(input: {
  readonly relayCatalog: MullvadRelayCatalog;
  readonly countryCode?: string;
  readonly cityCode?: string;
}): readonly PromptSelectOption[] {
  const providers = new Set<string>();

  listMatchingRelays({
    relayCatalog: input.relayCatalog,
    ...(input.countryCode ? { countryCode: input.countryCode } : {}),
    ...(input.cityCode ? { cityCode: input.cityCode } : {}),
    providers: [],
  }).forEach((relay) => {
    if (relay.provider?.trim()) {
      providers.add(relay.provider);
    }
  });

  return [...providers]
    .sort((left, right) => left.localeCompare(right))
    .map((provider) => ({
      value: provider,
      label: provider,
    }));
}

function describeGuidedCountrySelector(
  relayCatalog: MullvadRelayCatalog,
  countryCode: string,
): string {
  const country = relayCatalog.countries.find((entry) => entry.code === countryCode);
  return country ? `${country.name} (${country.code})` : countryCode;
}

function createGuidedCancellation(configPath: string): ProxyExportFailure {
  return {
    ok: false,
    phase: 'export-proxies',
    source: 'user-input',
    message: 'Guided export cancelled before Mullgate wrote any proxy file.',
    configPath,
  };
}

function validateProxyExportSelectorCountInput(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase() ?? '';

  if (normalized === 'all') {
    return undefined;
  }

  try {
    parseProxyExportCount(normalized);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseProxyExportProtocol(value: string): ProxyExportProtocol {
  const normalized = value.trim().toLowerCase();

  if (normalized === 'socks5' || normalized === 'http' || normalized === 'https') {
    return normalized;
  }

  return 'socks5';
}

function parseProxyExportWriteMode(value: string): ProxyExportWriteMode {
  const normalized = value.trim().toLowerCase();

  if (normalized === 'file' || normalized === 'stdout' || normalized === 'dry-run') {
    return normalized;
  }

  return 'file';
}

function parseProxyExportSelectorType(value: string): ProxyExportSelector['kind'] {
  return value.trim().toLowerCase() === 'region' ? 'region' : 'country';
}

function parseGuidedProxyExportCount(value: string): number | 'all' {
  return value.trim().toLowerCase() === 'all' ? 'all' : parseProxyExportCount(value);
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
