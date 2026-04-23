import crypto from 'node:crypto';
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { normalizeLocationToken } from '../domain/location-aliases.js';
import { type MullgatePaths, resolveMullgatePaths } from './paths.js';
import {
  CONFIG_VERSION,
  type MullgateConfig,
  type MullgateConfigInput,
  mullgateConfigInputSchema,
  mullgateConfigSchema,
  type RoutedLocation,
  type RoutedLocationInput,
} from './schema.js';

class UnsupportedConfigVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Config version ${version} is no longer supported.`);
    this.name = 'UnsupportedConfigVersionError';
    this.version = version;
  }
}

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

      if (error instanceof UnsupportedConfigVersionError) {
        return {
          ok: false,
          phase: 'parse-config',
          source: 'file',
          paths: this.paths,
          artifactPath: this.paths.configFile,
          message: [
            `Config version ${error.version} is no longer supported. Mullgate now requires a version ${CONFIG_VERSION} config with one shared WireGuard device and exact per-route exits.`,
            'This is stale local state, not a config the current CLI will operate.',
            `Back up or remove ${this.paths.configFile} and the runtime artifacts under ${this.paths.runtimeDir}, then rerun \`mullgate setup\` and \`mullgate proxy start\`.`,
          ].join(' '),
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
  const version = readConfigVersion(input);

  if (version !== null && version !== CONFIG_VERSION) {
    throw new UnsupportedConfigVersionError(version);
  }

  const parsed = mullgateConfigInputSchema.parse(hydrateLegacyConfigInput(input));
  const locations = normalizeRoutingLocations(parsed);
  const primaryRoute = locations[0];

  return mullgateConfigSchema.parse({
    ...parsed,
    setup: {
      ...parsed.setup,
      bind: {
        ...parsed.setup.bind,
        host: primaryRoute?.bindIp ?? parsed.setup.bind.host,
      },
      location: structuredClone(primaryRoute?.relayPreference ?? parsed.setup.location),
    },
    routing: {
      locations,
    },
  });
}

function normalizeRoutingLocations(config: MullgateConfigInput): RoutedLocation[] {
  const usedRouteIds = new Set<string>();

  return config.routing.locations.map((location, index) =>
    normalizeRoutedLocation(location, index, usedRouteIds),
  );
}

function normalizeRoutedLocation(
  location: RoutedLocationInput,
  index: number,
  usedRouteIds: Set<string>,
): RoutedLocation {
  const relayPreference = structuredClone(location.relayPreference);
  const alias = chooseAlias(location, relayPreference, index);
  const hostname = chooseHostname(location, relayPreference, alias);
  const bindIp = location.bindIp?.trim() || '127.0.0.1';
  const routeId = chooseUniqueRouteId(location, alias, hostname, index, usedRouteIds);

  return {
    alias,
    hostname,
    bindIp,
    relayPreference,
    mullvad: structuredClone(location.mullvad),
    runtime: {
      routeId,
      httpsBackendName: location.runtime?.httpsBackendName?.trim() || `route-${routeId}`,
    },
  };
}

function chooseAlias(
  location: RoutedLocationInput,
  relayPreference: RoutedLocationInput['relayPreference'],
  index: number,
): string {
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

function readConfigVersion(input: unknown): number | null {
  if (!input || typeof input !== 'object' || !('version' in input)) {
    return null;
  }

  const version = (input as Record<string, unknown>).version;
  return typeof version === 'number' ? version : null;
}

function hydrateLegacyConfigInput(input: unknown): unknown {
  if (!isRecord(input) || 'routing' in input) {
    return input;
  }

  const setup = input.setup;
  const mullvad = input.mullvad;

  if (!isRecord(setup) || !isRecord(mullvad)) {
    return input;
  }

  const location = setup.location;
  const bind = setup.bind;
  const relayConstraints = mullvad.relayConstraints;

  if (!isRecord(location) || !isRecord(bind) || !isRecord(relayConstraints)) {
    return input;
  }

  const requested =
    readNonEmptyString(location.requested) ??
    readNonEmptyString(location.hostnameLabel) ??
    DEFAULT_ROUTE_ID;
  const hostnameLabel = readNonEmptyString(location.hostnameLabel);
  const relayHostname = hostnameLabel ?? (normalizeLocationToken(requested) || DEFAULT_ROUTE_ID);
  const countryAndCity = deriveLegacyRelayCodes({
    hostnameLabel,
    requested,
  });

  return {
    ...input,
    routing: {
      locations: [
        {
          bindIp: readNonEmptyString(bind.host) ?? '127.0.0.1',
          relayPreference: location,
          mullvad: {
            relayConstraints: {
              providers: Array.isArray(relayConstraints.providers)
                ? relayConstraints.providers
                : [],
            },
            exit: {
              relayHostname,
              relayFqdn: `${relayHostname}.relays.mullvad.net`,
              socksHostname: `${relayHostname}-socks.relays.mullvad.net`,
              socksPort: 1080,
              countryCode: countryAndCity.countryCode,
              cityCode: countryAndCity.cityCode,
            },
          },
        },
      ],
    },
  };
}

function deriveLegacyRelayCodes(input: {
  readonly hostnameLabel: string | null;
  readonly requested: string;
}): {
  readonly countryCode: string;
  readonly cityCode: string;
} {
  const token = normalizeLocationToken(input.hostnameLabel ?? input.requested) || DEFAULT_ROUTE_ID;
  const [countryCode = 'xx', cityCode = 'test'] = token.split('-');

  return {
    countryCode,
    cityCode,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
}

async function writeFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  const randomSuffix = crypto.randomBytes(4).readUInt32LE(0);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomSuffix}.tmp`,
  );

  let fileHandle: FileHandle | undefined;
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

    if (process.platform === 'win32') {
      return;
    }

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
