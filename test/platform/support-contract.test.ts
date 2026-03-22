import { describe, expect, it } from 'vitest';

import { resolveMullgatePaths } from '../../src/config/paths.js';
import { buildPlatformSupportContract } from '../../src/platform/support-contract.js';

describe('buildPlatformSupportContract', () => {
  it('classifies Linux as the full-support runtime target', () => {
    const contract = buildPlatformSupportContract({
      paths: resolveMullgatePaths({
        ...process.env,
        MULLGATE_PLATFORM: 'linux',
        HOME: '/home/alice',
        XDG_CONFIG_HOME: undefined,
        XDG_STATE_HOME: undefined,
        XDG_CACHE_HOME: undefined,
      }),
    });

    expect(contract).toMatchObject({
      platform: 'linux',
      platformSource: 'env:MULLGATE_PLATFORM',
      posture: {
        supportLevel: 'full',
        modeLabel: 'Linux-first runtime support',
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
      },
      warnings: [],
    });
    expect(contract.guidance).toMatchInlineSnapshot(`
      [
        "Linux is the reference runtime target for the current Mullgate topology and verification flow.",
        "Path inspection, runtime-manifest rendering, status, and doctor should all agree on this Linux support posture without extra platform-specific wording.",
      ]
    `);
  });

  it('classifies macOS as a partial-support diagnostics/config surface with limited host networking', () => {
    const contract = buildPlatformSupportContract({
      paths: resolveMullgatePaths({
        ...process.env,
        MULLGATE_PLATFORM: 'macos',
        HOME: '/Users/alice',
        XDG_CONFIG_HOME: undefined,
        XDG_STATE_HOME: undefined,
        XDG_CACHE_HOME: undefined,
      }),
    });

    expect(contract).toMatchObject({
      platform: 'macos',
      posture: {
        supportLevel: 'partial',
        modeLabel: 'macOS path + diagnostics support',
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
      },
    });
    expect(contract.warnings.map((warning) => warning.code)).toEqual([
      'LINUX_RUNTIME_RECOMMENDED',
      'DOCKER_DESKTOP_HOST_NETWORKING_LIMITED',
    ]);
  });

  it('classifies Windows as a partial-support diagnostics/config surface with limited host networking', () => {
    const contract = buildPlatformSupportContract({
      paths: resolveMullgatePaths({
        ...process.env,
        MULLGATE_PLATFORM: 'windows',
        USERPROFILE: 'C:\\Users\\alice',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        HOME: undefined,
        XDG_CONFIG_HOME: undefined,
        XDG_STATE_HOME: undefined,
        XDG_CACHE_HOME: undefined,
      }),
    });

    expect(contract).toMatchObject({
      platform: 'windows',
      posture: {
        supportLevel: 'partial',
        modeLabel: 'Windows path + diagnostics support',
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
      },
      paths: {
        configHome: 'C:\\Users\\alice\\AppData\\Roaming',
        stateHome: 'C:\\Users\\alice\\AppData\\Local',
        cacheHome: 'C:\\Users\\alice\\AppData\\Local',
      },
    });
    expect(contract.guidance).toMatchInlineSnapshot(`
      [
        "Windows should still resolve the correct config/state/cache locations and emit the same exposure and diagnostic contracts as Linux.",
        "When the CLI talks about runtime limitations on Windows, it should point at Docker Desktop host-networking differences instead of pretending the Linux runtime model is fully portable.",
      ]
    `);
  });
});
