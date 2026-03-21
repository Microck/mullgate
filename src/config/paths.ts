import { homedir } from 'node:os';
import path from 'node:path';

export const APP_NAME = 'mullgate';

export type MullgatePaths = {
  readonly configHome: string;
  readonly stateHome: string;
  readonly cacheHome: string;
  readonly appConfigDir: string;
  readonly appStateDir: string;
  readonly appCacheDir: string;
  readonly configFile: string;
  readonly runtimeDir: string;
  readonly runtimeBundleDir: string;
  readonly wireproxyConfigFile: string;
  readonly wireproxyConfigTestReportFile: string;
  readonly provisioningCacheFile: string;
  readonly runtimeComposeFile: string;
  readonly runtimeHttpsSidecarConfigFile: string;
  readonly runtimeBundleManifestFile: string;
  readonly runtimeStartDiagnosticsFile: string;
  readonly dockerComposePath: string;
};

export function resolveMullgatePaths(env: NodeJS.ProcessEnv = process.env): MullgatePaths {
  const home = env.HOME?.trim() || homedir();
  const configHome = resolveBaseDir(env.XDG_CONFIG_HOME, path.join(home, '.config'));
  const stateHome = resolveBaseDir(env.XDG_STATE_HOME, path.join(home, '.local', 'state'));
  const cacheHome = resolveBaseDir(env.XDG_CACHE_HOME, path.join(home, '.cache'));

  const appConfigDir = path.join(configHome, APP_NAME);
  const appStateDir = path.join(stateHome, APP_NAME);
  const appCacheDir = path.join(cacheHome, APP_NAME);
  const runtimeDir = path.join(appStateDir, 'runtime');
  const runtimeBundleDir = runtimeDir;
  const runtimeComposeFile = path.join(runtimeBundleDir, 'docker-compose.yml');

  return {
    configHome,
    stateHome,
    cacheHome,
    appConfigDir,
    appStateDir,
    appCacheDir,
    configFile: path.join(appConfigDir, 'config.json'),
    runtimeDir,
    runtimeBundleDir,
    wireproxyConfigFile: path.join(runtimeDir, 'wireproxy.conf'),
    wireproxyConfigTestReportFile: path.join(runtimeDir, 'wireproxy-configtest.json'),
    provisioningCacheFile: path.join(appCacheDir, 'relays.json'),
    runtimeComposeFile,
    runtimeHttpsSidecarConfigFile: path.join(runtimeBundleDir, 'haproxy.cfg'),
    runtimeBundleManifestFile: path.join(runtimeBundleDir, 'runtime-manifest.json'),
    runtimeStartDiagnosticsFile: path.join(runtimeDir, 'last-start.json'),
    dockerComposePath: runtimeComposeFile,
  };
}

function resolveBaseDir(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && path.isAbsolute(trimmed) ? trimmed : fallback;
}
