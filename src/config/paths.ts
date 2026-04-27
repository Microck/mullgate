import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Canonical application directory prefix used across config, state, and cache paths.
 */
export const APP_NAME = 'mullgate';

/**
 * Supported host platform targets for Mullgate path resolution.
 */
export type MullgatePlatform = 'linux' | 'macos' | 'windows';
/**
 * Source used to determine the active Mullgate platform target.
 */
export type MullgatePlatformSource = 'process.platform' | 'env:MULLGATE_PLATFORM';
/**
 * Source annotation for each resolved Mullgate base directory.
 */
export type MullgatePathSource =
  | 'env:XDG_CONFIG_HOME'
  | 'env:XDG_STATE_HOME'
  | 'env:XDG_CACHE_HOME'
  | 'platform:linux-xdg-default'
  | 'platform:macos-library-application-support'
  | 'platform:macos-library-caches'
  | 'platform:windows-appdata'
  | 'platform:windows-localappdata';

/**
 * Canonical filesystem contract for all Mullgate config and runtime artifacts.
 */
export type MullgatePaths = {
  readonly platform: MullgatePlatform;
  readonly platformSource: MullgatePlatformSource;
  readonly pathSources: {
    readonly configHome: MullgatePathSource;
    readonly stateHome: MullgatePathSource;
    readonly cacheHome: MullgatePathSource;
  };
  readonly configHome: string;
  readonly stateHome: string;
  readonly cacheHome: string;
  readonly appConfigDir: string;
  readonly appStateDir: string;
  readonly appCacheDir: string;
  readonly configFile: string;
  readonly runtimeDir: string;
  readonly runtimeBundleDir: string;
  readonly entryWireproxyConfigFile: string;
  readonly routeProxyConfigFile: string;
  readonly runtimeValidationReportFile: string;
  readonly provisioningCacheFile: string;
  readonly runtimeComposeFile: string;
  readonly runtimeHttpsSidecarConfigFile: string;
  readonly runtimeBundleManifestFile: string;
  readonly runtimeStartDiagnosticsFile: string;
  readonly dockerComposePath: string;
};

type PathModule = typeof path.posix | typeof path.win32;

type ResolvedBaseDir = {
  readonly value: string;
  readonly source: MullgatePathSource;
};

/**
 * Resolves all Mullgate path locations based on the platform and environment variables.
 *
 * @param env - Optional environment variables (defaults to process.env).
 * @returns An object containing all resolved paths for config, state, cache, and runtime directories.
 */
export function resolveMullgatePaths(env: NodeJS.ProcessEnv = process.env): MullgatePaths {
  const platformResolution = resolveTargetPlatform(env);
  const pathModule = selectPathModule(platformResolution.platform);
  const home = resolveHomeDirectory({ env, platform: platformResolution.platform, pathModule });
  const configHome = resolveConfigHome({
    env,
    platform: platformResolution.platform,
    home,
    pathModule,
  });
  const stateHome = resolveStateHome({
    env,
    platform: platformResolution.platform,
    home,
    pathModule,
  });
  const cacheHome = resolveCacheHome({
    env,
    platform: platformResolution.platform,
    home,
    pathModule,
  });

  const appConfigDir = pathModule.join(configHome.value, APP_NAME);
  const appStateDir = pathModule.join(stateHome.value, APP_NAME);
  const appCacheDir = pathModule.join(cacheHome.value, APP_NAME);
  const runtimeDir = pathModule.join(appStateDir, 'runtime');
  const runtimeBundleDir = runtimeDir;
  const runtimeComposeFile = pathModule.join(runtimeBundleDir, 'docker-compose.yml');

  return {
    platform: platformResolution.platform,
    platformSource: platformResolution.source,
    pathSources: {
      configHome: configHome.source,
      stateHome: stateHome.source,
      cacheHome: cacheHome.source,
    },
    configHome: configHome.value,
    stateHome: stateHome.value,
    cacheHome: cacheHome.value,
    appConfigDir,
    appStateDir,
    appCacheDir,
    configFile: pathModule.join(appConfigDir, 'config.json'),
    runtimeDir,
    runtimeBundleDir,
    entryWireproxyConfigFile: pathModule.join(runtimeDir, 'entry-wireproxy.conf'),
    routeProxyConfigFile: pathModule.join(runtimeDir, 'route-proxy.cfg'),
    runtimeValidationReportFile: pathModule.join(runtimeDir, 'runtime-validation.json'),
    provisioningCacheFile: pathModule.join(appCacheDir, 'relays.json'),
    runtimeComposeFile,
    runtimeHttpsSidecarConfigFile: pathModule.join(runtimeBundleDir, 'haproxy.cfg'),
    runtimeBundleManifestFile: pathModule.join(runtimeBundleDir, 'runtime-manifest.json'),
    runtimeStartDiagnosticsFile: pathModule.join(runtimeDir, 'last-start.json'),
    dockerComposePath: runtimeComposeFile,
  };
}

function resolveTargetPlatform(env: NodeJS.ProcessEnv): {
  readonly platform: MullgatePlatform;
  readonly source: MullgatePlatformSource;
} {
  const override = env.MULLGATE_PLATFORM?.trim().toLowerCase();

  if (override) {
    return {
      platform: normalizePlatform(override),
      source: 'env:MULLGATE_PLATFORM',
    };
  }

  return {
    platform: normalizePlatform(process.platform),
    source: 'process.platform',
  };
}

function normalizePlatform(value: string): MullgatePlatform {
  if (value === 'darwin' || value === 'macos') {
    return 'macos';
  }

  if (value === 'win32' || value === 'windows') {
    return 'windows';
  }

  return 'linux';
}

function selectPathModule(platform: MullgatePlatform): PathModule {
  if (platform === 'windows') {
    return path.win32;
  }

  return path.posix;
}

function resolveHomeDirectory(input: {
  env: NodeJS.ProcessEnv;
  platform: MullgatePlatform;
  pathModule: PathModule;
}): string {
  const { env, platform, pathModule } = input;

  if (platform === 'windows') {
    const userProfile = normalizeAbsolutePath(env.USERPROFILE, pathModule);

    if (userProfile) {
      return userProfile;
    }

    const homeDrive = env.HOMEDRIVE?.trim();
    const homePath = env.HOMEPATH?.trim();

    if (homeDrive && homePath) {
      return pathModule.join(homeDrive, homePath);
    }
  }

  const homeOverride = normalizeAbsolutePath(env.HOME, pathModule);

  if (homeOverride) {
    return homeOverride;
  }

  return homedir();
}

function resolveConfigHome(input: {
  env: NodeJS.ProcessEnv;
  platform: MullgatePlatform;
  home: string;
  pathModule: PathModule;
}): ResolvedBaseDir {
  const xdgConfig = normalizeAbsolutePath(input.env.XDG_CONFIG_HOME, input.pathModule);

  if (xdgConfig) {
    return {
      value: xdgConfig,
      source: 'env:XDG_CONFIG_HOME',
    };
  }

  if (input.platform === 'macos') {
    return {
      value: input.pathModule.join(input.home, 'Library', 'Application Support'),
      source: 'platform:macos-library-application-support',
    };
  }

  if (input.platform === 'windows') {
    return {
      value: resolveWindowsBaseDir({
        candidate: input.env.APPDATA,
        home: input.home,
        fallbackSegments: ['AppData', 'Roaming'],
        pathModule: input.pathModule,
      }),
      source: 'platform:windows-appdata',
    };
  }

  return {
    value: input.pathModule.join(input.home, '.config'),
    source: 'platform:linux-xdg-default',
  };
}

function resolveStateHome(input: {
  env: NodeJS.ProcessEnv;
  platform: MullgatePlatform;
  home: string;
  pathModule: PathModule;
}): ResolvedBaseDir {
  const xdgState = normalizeAbsolutePath(input.env.XDG_STATE_HOME, input.pathModule);

  if (xdgState) {
    return {
      value: xdgState,
      source: 'env:XDG_STATE_HOME',
    };
  }

  if (input.platform === 'macos') {
    return {
      value: input.pathModule.join(input.home, 'Library', 'Application Support'),
      source: 'platform:macos-library-application-support',
    };
  }

  if (input.platform === 'windows') {
    return {
      value: resolveWindowsBaseDir({
        candidate: input.env.LOCALAPPDATA,
        home: input.home,
        fallbackSegments: ['AppData', 'Local'],
        pathModule: input.pathModule,
      }),
      source: 'platform:windows-localappdata',
    };
  }

  return {
    value: input.pathModule.join(input.home, '.local', 'state'),
    source: 'platform:linux-xdg-default',
  };
}

function resolveCacheHome(input: {
  env: NodeJS.ProcessEnv;
  platform: MullgatePlatform;
  home: string;
  pathModule: PathModule;
}): ResolvedBaseDir {
  const xdgCache = normalizeAbsolutePath(input.env.XDG_CACHE_HOME, input.pathModule);

  if (xdgCache) {
    return {
      value: xdgCache,
      source: 'env:XDG_CACHE_HOME',
    };
  }

  if (input.platform === 'macos') {
    return {
      value: input.pathModule.join(input.home, 'Library', 'Caches'),
      source: 'platform:macos-library-caches',
    };
  }

  if (input.platform === 'windows') {
    return {
      value: resolveWindowsBaseDir({
        candidate: input.env.LOCALAPPDATA,
        home: input.home,
        fallbackSegments: ['AppData', 'Local'],
        pathModule: input.pathModule,
      }),
      source: 'platform:windows-localappdata',
    };
  }

  return {
    value: input.pathModule.join(input.home, '.cache'),
    source: 'platform:linux-xdg-default',
  };
}

function resolveWindowsBaseDir(input: {
  candidate: string | undefined;
  home: string;
  fallbackSegments: string[];
  pathModule: PathModule;
}): string {
  return (
    normalizeAbsolutePath(input.candidate, input.pathModule) ??
    input.pathModule.join(input.home, ...input.fallbackSegments)
  );
}

function normalizeAbsolutePath(value: string | undefined, pathModule: PathModule): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  if (!pathModule.isAbsolute(trimmed) && !isWindowsDriveAbsolutePath(trimmed)) {
    return null;
  }

  return trimmed;
}

function isWindowsDriveAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}
