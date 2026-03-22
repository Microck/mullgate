import { chmod, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { normalizeLocationToken } from '../domain/location-aliases.js';
import { resolveMullgatePaths, type MullgatePaths } from './paths.js';
import {
  mullgateConfigInputSchema,
  mullgateConfigSchema,
  type MullgateConfig,
  type MullgateConfigInput,
  type RoutedLocation,
  type RoutedLocationInput,
} from './schema.js';

export type LoadConfigResult =
  | {
      readonly ok: true;
      readonly phase: 'load-config';
      readonly source: 'empty';
      readonly paths: MullgatePaths;
      readonly config: null;
      readonly message: string;
    }
  | {
      readonly ok: true;
      readonly phase: 'load-config';
      readonly source: 'file';
      readonly paths: MullgatePaths;
      readonly config: MullgateConfig;
      readonly artifactPath: string;
    }
  | {
      readonly ok: false;
      readonly phase: 'read-config' | 'parse-config';
      readonly source: 'file';
      readonly paths: MullgatePaths;
      readonly artifactPath: string;
      readonly message: string;
    };

export type SaveConfigResult = {
  readonly ok: true;
  readonly phase: 'persist-config';
  readonly source: 'input';
  readonly paths: MullgatePaths;
  readonly artifactPath: string;
  readonly config: MullgateConfig;
};

export type PathReport = {
  readonly phase: 'resolve-paths';
  readonly source: 'canonical-path-contract';
  readonly platform: MullgatePaths['platform'];
  readonly platformSource: MullgatePaths['platformSource'];
  readonly pathSources: MullgatePaths['pathSources'];
  readonly paths: MullgatePaths;
  readonly exists: {
    readonly configFile: boolean;
    readonly runtimeDir: boolean;
    readonly relayCacheFile: boolean;
  };
};

const DEFAULT_ROUTE_ID = 'primary';

export class ConfigStore {
  readonly paths: MullgatePaths;

  constructor(paths: MullgatePaths = resolveMullgatePaths()) {
    this.paths = paths;
  }

  async load(): Promise<LoadConfigResult> {
    try {
      const raw = await readFile(this.paths.configFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const config = normalizeMullgateConfig(parsed);

      return {
        ok: true,
        phase: 'load-config',
        source: 'file',
        paths: this.paths,
        config,
        artifactPath: this.paths.configFile,
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          ok: true,
          phase: 'load-config',
          source: 'empty',
          paths: this.paths,
          config: null,
          message: `Mullgate is not configured yet. Run \`mullgate setup\` to create ${this.paths.configFile}.`,
        };
      }

      if (error instanceof SyntaxError) {
        return {
          ok: false,
          phase: 'parse-config',
          source: 'file',
          paths: this.paths,
          artifactPath: this.paths.configFile,
          message: `Config file is not valid JSON: ${error.message}`,
        };
      }

      if (error instanceof Error && error.name === 'ZodError') {
        return {
          ok: false,
          phase: 'parse-config',
          source: 'file',
          paths: this.paths,
          artifactPath: this.paths.configFile,
          message: 'Config file does not match the Mullgate schema.',
        };
      }

      return {
        ok: false,
        phase: 'read-config',
        source: 'file',
        paths: this.paths,
        artifactPath: this.paths.configFile,
        message: error instanceof Error ? error.message : 'Unknown error while reading config.',
      };
    }
  }

  async save(input: MullgateConfig): Promise<SaveConfigResult> {
    const config = normalizeMullgateConfig(input);

    await ensureDirectory(this.paths.appConfigDir);
    await ensureDirectory(this.paths.appStateDir);
    await ensureDirectory(this.paths.appCacheDir);
    await ensureDirectory(this.paths.runtimeDir);

    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    await writeFileAtomic(this.paths.configFile, serialized, 0o600);

    return {
      ok: true,
      phase: 'persist-config',
      source: 'input',
      paths: this.paths,
      artifactPath: this.paths.configFile,
      config,
    };
  }

  async inspectPaths(): Promise<PathReport> {
    return {
      phase: 'resolve-paths',
      source: 'canonical-path-contract',
      platform: this.paths.platform,
      platformSource: this.paths.platformSource,
      pathSources: this.paths.pathSources,
      paths: this.paths,
      exists: {
        configFile: await fileExists(this.paths.configFile),
        runtimeDir: await fileExists(this.paths.runtimeDir),
        relayCacheFile: await fileExists(this.paths.provisioningCacheFile),
      },
    };
  }
}

export function normalizeMullgateConfig(input: unknown): MullgateConfig {
  const parsed = mullgateConfigInputSchema.parse(input);
  const locations = normalizeRoutingLocations(parsed);
  const primaryLocation = locations[0]!;

  const normalized: MullgateConfig = {
    ...parsed,
    setup: {
      ...parsed.setup,
      bind: {
        ...parsed.setup.bind,
        host: primaryLocation.bindIp,
      },
      location: structuredClone(primaryLocation.relayPreference),
    },
    mullvad: structuredClone(primaryLocation.mullvad),
    routing: {
      locations,
    },
  };

  return mullgateConfigSchema.parse(normalized);
}

export function syncLegacyMirrorsToRouting(config: MullgateConfig): MullgateConfig {
  const [firstLocation, ...remainingLocations] = config.routing.locations;

  if (!firstLocation) {
    return config;
  }

  const updatedPrimary = normalizeRoutedLocation(
    {
      hostname: firstLocation.hostname,
      bindIp: firstLocation.bindIp,
      relayPreference: structuredClone(config.setup.location),
      mullvad: structuredClone(config.mullvad),
      runtime: structuredClone(firstLocation.runtime),
    },
    0,
    new Set(),
    { bindIp: firstLocation.bindIp },
  );

  return normalizeMullgateConfig({
    ...config,
    setup: {
      ...config.setup,
      bind: {
        ...config.setup.bind,
        host: firstLocation.bindIp,
      },
    },
    routing: {
      locations: [updatedPrimary, ...remainingLocations],
    },
  });
}

function normalizeRoutingLocations(config: MullgateConfigInput): RoutedLocation[] {
  const usedRouteIds = new Set<string>();

  if (config.routing?.locations.length) {
    return config.routing.locations.map((location, index) =>
      normalizeRoutedLocation(location, index, usedRouteIds, {
        bindIp: index === 0 ? config.setup.bind.host : undefined,
      }),
    );
  }

  return [
    normalizeRoutedLocation(
      {
        relayPreference: structuredClone(config.setup.location),
        mullvad: structuredClone(config.mullvad),
      },
      0,
      usedRouteIds,
      { bindIp: config.setup.bind.host },
    ),
  ];
}

function normalizeRoutedLocation(
  location: RoutedLocationInput,
  index: number,
  usedRouteIds: Set<string>,
  fallbacks: { bindIp?: string },
): RoutedLocation {
  const relayPreference = structuredClone(location.relayPreference);
  const alias = chooseAlias(location, relayPreference, index);
  const hostname = chooseHostname(location, relayPreference, alias);
  const bindIp = location.bindIp?.trim() || fallbacks.bindIp || '127.0.0.1';
  const routeId = chooseUniqueRouteId(location, alias, hostname, index, usedRouteIds);

  return {
    alias,
    hostname,
    bindIp,
    relayPreference,
    mullvad: structuredClone(location.mullvad),
    runtime: {
      routeId,
      wireproxyServiceName: location.runtime?.wireproxyServiceName?.trim() || `wireproxy-${routeId}`,
      haproxyBackendName: location.runtime?.haproxyBackendName?.trim() || `route-${routeId}`,
      wireproxyConfigFile: location.runtime?.wireproxyConfigFile?.trim() || `wireproxy-${routeId}.conf`,
    },
  };
}

function chooseAlias(location: RoutedLocationInput, relayPreference: RoutedLocationInput['relayPreference'], index: number): string {
  const explicit = location.alias?.trim();

  if (explicit) {
    return explicit;
  }

  const derived = normalizeLocationToken(
    relayPreference.resolvedAlias ?? relayPreference.hostnameLabel ?? relayPreference.requested,
  );

  return derived || `route-${index + 1}`;
}

function chooseHostname(
  location: RoutedLocationInput,
  relayPreference: RoutedLocationInput['relayPreference'],
  alias: string,
): string {
  const explicit = location.hostname?.trim();

  if (explicit) {
    return explicit;
  }

  return relayPreference.hostnameLabel?.trim() || alias;
}

function chooseUniqueRouteId(
  location: RoutedLocationInput,
  alias: string,
  hostname: string,
  index: number,
  usedRouteIds: Set<string>,
): string {
  const baseCandidate =
    normalizeLocationToken(location.runtime?.routeId ?? hostname ?? alias) ||
    normalizeLocationToken(alias) ||
    (index === 0 ? DEFAULT_ROUTE_ID : `route-${index + 1}`);

  let candidate = baseCandidate;
  let suffix = 2;

  while (usedRouteIds.has(candidate)) {
    candidate = `${baseCandidate}-${suffix}`;
    suffix += 1;
  }

  usedRouteIds.add(candidate);
  return candidate;
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
}

async function writeFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

  let fileHandle;
  try {
    fileHandle = await open(temporaryPath, 'w', mode);
    await fileHandle.writeFile(content, 'utf8');
    await fileHandle.sync();
  } finally {
    await fileHandle?.close();
  }

  try {
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
    await chmod(filePath, mode);

    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await readFile(targetPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    return true;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function listTemporaryArtifacts(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
    .map((entry) => entry.name)
    .sort();
}
