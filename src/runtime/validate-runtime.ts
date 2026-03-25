import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MullgateConfig } from '../config/schema.js';
import { createDockerValidationStage } from './docker-validation-stage.js';
import {
  ENTRY_WIREPROXY_SOCKS_PORT,
  type RenderedRouteProxyRoute,
} from './render-runtime-proxies.js';
import { validateWireproxyConfig, type WireproxyValidationIssue } from './validate-wireproxy.js';

type RuntimeValidationIssue = WireproxyValidationIssue;

export type RuntimeValidationCheck = {
  readonly artifact: 'entry-wireproxy' | 'route-proxy';
  readonly ok: boolean;
  readonly source: 'wireproxy-binary' | 'docker' | 'internal-syntax' | 'validation-suite';
  readonly validator:
    | 'wireproxy-configtest'
    | 'docker-wireproxy-configtest'
    | 'internal-syntax'
    | 'docker-3proxy-startup';
  readonly target: string;
  readonly issues: readonly RuntimeValidationIssue[];
  readonly cause?: string;
};

export type ValidateRuntimeSuccess = {
  readonly ok: true;
  readonly phase: 'validation';
  readonly source: 'validation-suite';
  readonly status: 'success';
  readonly checkedAt: string;
  readonly reportPath?: string;
  readonly checks: readonly RuntimeValidationCheck[];
};

export type ValidateRuntimeFailure = {
  readonly ok: false;
  readonly phase: 'validation';
  readonly source: RuntimeValidationCheck['source'];
  readonly status: 'failure';
  readonly checkedAt: string;
  readonly reportPath?: string;
  readonly target: string;
  readonly artifact: RuntimeValidationCheck['artifact'];
  readonly validator: RuntimeValidationCheck['validator'];
  readonly issues: readonly RuntimeValidationIssue[];
  readonly cause: string;
  readonly checks: readonly RuntimeValidationCheck[];
};

export type ValidateRuntimeResult = ValidateRuntimeSuccess | ValidateRuntimeFailure;

export type ValidateRuntimeOptions = {
  readonly entryWireproxyConfigPath: string;
  readonly entryWireproxyConfigText?: string;
  readonly routeProxyConfigPath: string;
  readonly routeProxyConfigText?: string;
  readonly routes: readonly RenderedRouteProxyRoute[];
  readonly bind: Pick<MullgateConfig['setup']['bind'], 'socksPort' | 'httpPort'>;
  readonly checkedAt?: string;
  readonly reportPath?: string;
  readonly wireproxyBinary?: string;
  readonly dockerBinary?: string;
  readonly dockerImage?: string;
  readonly routeProxyDockerImage?: string;
  readonly spawn?: typeof spawnSync;
};

const DEFAULT_DOCKER_BINARY = 'docker';
const DEFAULT_ROUTE_PROXY_DOCKER_IMAGE = 'tarampampam/3proxy:latest';
const DOCKER_ROUTE_PROXY_CONFIG_PATH = '/etc/3proxy/3proxy.cfg';

export async function validateRuntimeArtifacts(
  options: ValidateRuntimeOptions,
): Promise<ValidateRuntimeResult> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const wireproxyResult = await validateWireproxyConfig({
    configPath: options.entryWireproxyConfigPath,
    configText: options.entryWireproxyConfigText,
    checkedAt,
    wireproxyBinary: options.wireproxyBinary,
    dockerBinary: options.dockerBinary,
    dockerImage: options.dockerImage,
    spawn: options.spawn,
  });
  const routeProxyResult = validateRouteProxyConfig({
    configPath: options.routeProxyConfigPath,
    configText: options.routeProxyConfigText,
    routes: options.routes,
    bind: options.bind,
    checkedAt,
    dockerBinary: options.dockerBinary,
    routeProxyDockerImage: options.routeProxyDockerImage,
    spawn: options.spawn,
  });
  const checks: RuntimeValidationCheck[] = [
    {
      artifact: 'entry-wireproxy',
      ok: wireproxyResult.ok,
      source: wireproxyResult.source,
      validator: wireproxyResult.validator,
      target: wireproxyResult.target,
      issues: wireproxyResult.issues,
      ...(wireproxyResult.ok ? {} : { cause: wireproxyResult.cause }),
    },
    routeProxyResult,
  ];
  const failedCheck = checks.find((check) => !check.ok);

  if (!failedCheck) {
    return persistValidationReport(
      {
        ok: true,
        phase: 'validation',
        source: 'validation-suite',
        status: 'success',
        checkedAt,
        ...(options.reportPath ? { reportPath: options.reportPath } : {}),
        checks,
      },
      options.reportPath,
    );
  }

  return persistValidationReport(
    {
      ok: false,
      phase: 'validation',
      source: failedCheck.source,
      status: 'failure',
      checkedAt,
      ...(options.reportPath ? { reportPath: options.reportPath } : {}),
      target: failedCheck.target,
      artifact: failedCheck.artifact,
      validator: failedCheck.validator,
      issues: failedCheck.issues,
      cause: failedCheck.cause ?? failedCheck.issues[0]?.message ?? 'Runtime validation failed.',
      checks,
    },
    options.reportPath,
  );
}

function validateRouteProxyConfig(input: {
  readonly configPath: string;
  readonly configText?: string;
  readonly routes: readonly RenderedRouteProxyRoute[];
  readonly bind: Pick<MullgateConfig['setup']['bind'], 'socksPort' | 'httpPort'>;
  readonly checkedAt: string;
  readonly dockerBinary?: string;
  readonly routeProxyDockerImage?: string;
  readonly spawn?: typeof spawnSync;
}): RuntimeValidationCheck {
  const dockerResult = runRouteProxyStartupCheck({
    configPath: input.configPath,
    configText: input.configText,
    checkedAt: input.checkedAt,
    dockerBinary: input.dockerBinary,
    routeProxyDockerImage: input.routeProxyDockerImage,
    spawn: input.spawn,
  });

  if (dockerResult.kind === 'result') {
    return dockerResult.result;
  }

  const configText = input.configText ?? readFileSync(input.configPath, 'utf8');
  const issues = validateRouteProxySyntax({
    configText,
    configPath: input.configPath,
    routes: input.routes,
    bind: input.bind,
  });

  return {
    artifact: 'route-proxy',
    ok: issues.length === 0,
    source: 'internal-syntax',
    validator: 'internal-syntax',
    target: input.configPath,
    issues,
    ...(issues.length === 0 ? {} : { cause: issues[0]?.message }),
  };
}

function runRouteProxyStartupCheck(input: {
  readonly configPath: string;
  readonly configText?: string;
  readonly checkedAt: string;
  readonly dockerBinary?: string;
  readonly routeProxyDockerImage?: string;
  readonly spawn?: typeof spawnSync;
}):
  | {
      readonly kind: 'result';
      readonly result: RuntimeValidationCheck;
    }
  | {
      readonly kind: 'missing-binary';
    } {
  const runner = input.spawn ?? spawnSync;
  const stage = createDockerValidationStage({
    prefix: 'mullgate-route-proxy-validate-',
    fileName: '3proxy.cfg',
    content: input.configText ?? readFileSync(input.configPath, 'utf8'),
    fileMode: 0o666,
  });

  let result: ReturnType<typeof spawnSync>;

  try {
    result = runner(
      input.dockerBinary ?? DEFAULT_DOCKER_BINARY,
      [
        'run',
        '--rm',
        '-v',
        `${stage.hostFilePath}:${DOCKER_ROUTE_PROXY_CONFIG_PATH}`,
        input.routeProxyDockerImage ?? DEFAULT_ROUTE_PROXY_DOCKER_IMAGE,
        '/bin/3proxy',
        DOCKER_ROUTE_PROXY_CONFIG_PATH,
      ],
      {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 1_000,
      },
    );
  } finally {
    stage.cleanup();
  }

  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    return { kind: 'missing-binary' };
  }

  if (
    result.error &&
    'code' in result.error &&
    (result.error.code === 'ETIMEDOUT' || result.error.code === 'ESRCH')
  ) {
    return {
      kind: 'result',
      result: {
        artifact: 'route-proxy',
        ok: true,
        source: 'docker',
        validator: 'docker-3proxy-startup',
        target: input.configPath,
        issues: [],
      },
    };
  }

  if ((result.status ?? 1) === 0) {
    return {
      kind: 'result',
      result: {
        artifact: 'route-proxy',
        ok: true,
        source: 'docker',
        validator: 'docker-3proxy-startup',
        target: input.configPath,
        issues: [],
      },
    };
  }

  const message =
    [result.stderr, result.stdout]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim() || '3proxy rejected the rendered config.';

  return {
    kind: 'result',
    result: {
      artifact: 'route-proxy',
      ok: false,
      source: 'docker',
      validator: 'docker-3proxy-startup',
      target: input.configPath,
      issues: [
        {
          target: input.configPath,
          message,
        },
      ],
      cause: message,
    },
  };
}

function validateRouteProxySyntax(input: {
  readonly configText: string;
  readonly configPath: string;
  readonly routes: readonly RenderedRouteProxyRoute[];
  readonly bind: Pick<MullgateConfig['setup']['bind'], 'socksPort' | 'httpPort'>;
}): RuntimeValidationIssue[] {
  const issues: RuntimeValidationIssue[] = [];
  const lines = input.configText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (!lines.includes('fakeresolve')) {
    issues.push({
      target: input.configPath,
      message:
        'Route proxy config must enable fakeresolve for hostname-preserving upstream chaining.',
    });
  }

  if (!lines.includes('auth strong')) {
    issues.push({
      target: input.configPath,
      message: 'Route proxy config must enable strong auth.',
    });
  }

  if (!lines.some((line) => line.startsWith('users '))) {
    issues.push({
      target: input.configPath,
      message: 'Route proxy config must define one authenticated user.',
    });
  }

  for (const route of input.routes) {
    const expectedSocks = `socks -p${input.bind.socksPort} -i${route.routeBindIp} -e${route.routeBindIp}`;
    const expectedHttp = `proxy -p${input.bind.httpPort} -i${route.routeBindIp} -e${route.routeBindIp}`;
    const expectedEntryParent = `parent 1000 socks5+ 127.0.0.1 ${ENTRY_WIREPROXY_SOCKS_PORT}`;
    const expectedExitParent = `parent 1000 socks5+ ${route.exitSocksHostname} ${route.exitSocksPort}`;

    if (!lines.includes(expectedSocks)) {
      issues.push({
        target: input.configPath,
        message: `Route ${route.routeId} is missing its SOCKS5 listener line.`,
      });
    }

    if (!lines.includes(expectedHttp)) {
      issues.push({
        target: input.configPath,
        message: `Route ${route.routeId} is missing its HTTP listener line.`,
      });
    }

    const entryParentCount = lines.filter((line) => line === expectedEntryParent).length;
    const exitParentCount = lines.filter((line) => line === expectedExitParent).length;

    if (entryParentCount < 2) {
      issues.push({
        target: input.configPath,
        message: `Route ${route.routeId} is missing one or more chained entry-tunnel parents.`,
      });
    }

    if (exitParentCount < 2) {
      issues.push({
        target: input.configPath,
        message: `Route ${route.routeId} is missing one or more chained Mullvad SOCKS parents.`,
      });
    }
  }

  return issues;
}

async function persistValidationReport(
  result: ValidateRuntimeResult,
  reportPath?: string,
): Promise<ValidateRuntimeResult> {
  if (!reportPath) {
    return result;
  }

  await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

  return {
    ...result,
    reportPath,
  };
}
