import type {
  MullgatePathSource,
  MullgatePaths,
  MullgatePlatform,
  MullgatePlatformSource,
} from '../config/paths.js';

export type PlatformSupportLevel = 'full' | 'partial';
export type PlatformSurfaceSupport = 'supported' | 'limited';
export type PlatformHostNetworkingSupport = 'native' | 'limited';
export type PlatformSupportWarningCode = 'LINUX_RUNTIME_RECOMMENDED' | 'DOCKER_DESKTOP_HOST_NETWORKING_LIMITED';

export type PlatformSupportWarning = {
  readonly code: PlatformSupportWarningCode;
  readonly severity: 'warning';
  readonly message: string;
};

export type PlatformSupportContract = {
  readonly platform: MullgatePlatform;
  readonly platformSource: MullgatePlatformSource;
  readonly pathSources: {
    readonly configHome: MullgatePathSource;
    readonly stateHome: MullgatePathSource;
    readonly cacheHome: MullgatePathSource;
  };
  readonly paths: {
    readonly configHome: string;
    readonly stateHome: string;
    readonly cacheHome: string;
    readonly appConfigDir: string;
    readonly appStateDir: string;
    readonly appCacheDir: string;
    readonly runtimeDir: string;
    readonly runtimeBundleDir: string;
    readonly runtimeManifestPath: string;
  };
  readonly posture: {
    readonly supportLevel: PlatformSupportLevel;
    readonly modeLabel: string;
    readonly summary: string;
    readonly runtimeStory: string;
  };
  readonly surfaces: {
    readonly configPaths: PlatformSurfaceSupport;
    readonly configWorkflow: PlatformSurfaceSupport;
    readonly runtimeArtifacts: PlatformSurfaceSupport;
    readonly runtimeExecution: PlatformSurfaceSupport;
    readonly diagnostics: PlatformSurfaceSupport;
  };
  readonly hostNetworking: {
    readonly support: PlatformHostNetworkingSupport;
    readonly modeLabel: string;
    readonly summary: string;
    readonly remediation: string;
  };
  readonly guidance: readonly string[];
  readonly warnings: readonly PlatformSupportWarning[];
};

export function buildPlatformSupportContract(input: { readonly paths: MullgatePaths }): PlatformSupportContract {
  const { paths } = input;

  const baseContract = {
    platform: paths.platform,
    platformSource: paths.platformSource,
    pathSources: paths.pathSources,
    paths: {
      configHome: paths.configHome,
      stateHome: paths.stateHome,
      cacheHome: paths.cacheHome,
      appConfigDir: paths.appConfigDir,
      appStateDir: paths.appStateDir,
      appCacheDir: paths.appCacheDir,
      runtimeDir: paths.runtimeDir,
      runtimeBundleDir: paths.runtimeBundleDir,
      runtimeManifestPath: paths.runtimeBundleManifestFile,
    },
  } as const;

  if (paths.platform === 'linux') {
    return {
      ...baseContract,
      posture: {
        supportLevel: 'full',
        modeLabel: 'Linux-first runtime support',
        summary:
          'Linux is the fully supported Mullgate runtime environment. The shipped Docker host-networking model, per-route bind IP listeners, and runtime-manifest diagnostics are designed around Linux network semantics.',
        runtimeStory:
          'Use Linux for the full setup, runtime, status, and doctor workflow with the current Docker-first topology.',
      },
      surfaces: {
        configPaths: 'supported',
        configWorkflow: 'supported',
        runtimeArtifacts: 'supported',
        runtimeExecution: 'supported',
        diagnostics: 'supported',
      },
      hostNetworking: {
        support: 'native',
        modeLabel: 'Native host networking available',
        summary:
          'Docker host networking behaves as expected on Linux, so the routing layer and per-route wireproxy listeners can bind directly to the saved route IPs.',
        remediation:
          'If runtime checks fail on Linux, inspect Docker Compose health, route bind IP ownership, and hostname-resolution drift before assuming the platform contract is wrong.',
      },
      guidance: [
        'Linux is the reference runtime target for the current Mullgate topology and verification flow.',
        'Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.',
      ],
      warnings: [],
    };
  }

  const modeLabel = paths.platform === 'macos' ? 'macOS path + diagnostics support' : 'Windows path + diagnostics support';
  const platformLabel = paths.platform === 'macos' ? 'macOS' : 'Windows';

  return {
    ...baseContract,
    posture: {
      supportLevel: 'partial',
      modeLabel,
      summary: `${platformLabel} keeps truthful config paths, runtime-manifest output, and diagnostics, but the current Docker-first runtime remains Linux-first because Docker Desktop does not provide the same host-networking semantics.`,
      runtimeStory:
        'Use this platform for config inspection and deterministic diagnostics, but plan on a Linux host when you need the current multi-route runtime to be truthful end-to-end.',
    },
    surfaces: {
      configPaths: 'supported',
      configWorkflow: 'supported',
      runtimeArtifacts: 'supported',
      runtimeExecution: 'limited',
      diagnostics: 'supported',
    },
    hostNetworking: {
      support: 'limited',
      modeLabel: 'Docker Desktop host networking is limited',
      summary:
        'Docker Desktop does not expose Linux host-networking semantics for per-route bind IP listeners, so Mullgate cannot claim runtime parity with the Linux host-networking deployment on this platform.',
      remediation:
        'Treat Linux as the runtime execution target for now, or move the current Docker-first runtime into a Linux VM or host when you need the shipped multi-route topology to behave truthfully.',
    },
    guidance: [
      `${platformLabel} should still resolve the correct config/state/cache locations and emit the same exposure and diagnostic contracts as Linux.`,
      `When the CLI talks about runtime limitations on ${platformLabel}, it should point at Docker Desktop host-networking differences instead of pretending the Linux runtime model is fully portable.`,
    ],
    warnings: [
      {
        code: 'LINUX_RUNTIME_RECOMMENDED',
        severity: 'warning',
        message: 'Linux remains the recommended runtime host for the current Docker-first Mullgate topology.',
      },
      {
        code: 'DOCKER_DESKTOP_HOST_NETWORKING_LIMITED',
        severity: 'warning',
        message:
          'Docker Desktop does not provide the Linux host-networking behavior that the current per-route bind-IP runtime depends on.',
      },
    ],
  };
}
