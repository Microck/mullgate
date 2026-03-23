import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type WireproxyValidationIssue = {
  target: string;
  message: string;
};

export type ValidateWireproxySuccess = {
  ok: true;
  phase: 'validation';
  source: 'wireproxy-binary' | 'docker' | 'internal-syntax';
  status: 'success';
  checkedAt: string;
  target: string;
  reportPath?: string;
  validator: 'wireproxy-configtest' | 'docker-wireproxy-configtest' | 'internal-syntax';
  issues: [];
};

export type ValidateWireproxyFailure = {
  ok: false;
  phase: 'validation';
  source: 'wireproxy-binary' | 'docker' | 'internal-syntax';
  status: 'failure';
  checkedAt: string;
  target: string;
  reportPath?: string;
  validator: 'wireproxy-configtest' | 'docker-wireproxy-configtest' | 'internal-syntax';
  issues: WireproxyValidationIssue[];
  cause: string;
};

export type ValidateWireproxyResult = ValidateWireproxySuccess | ValidateWireproxyFailure;

export type ValidateWireproxyOptions = {
  configPath: string;
  configText?: string;
  checkedAt?: string;
  reportPath?: string;
  wireproxyBinary?: string;
  dockerBinary?: string;
  dockerImage?: string;
  spawn?: typeof spawnSync;
};

type ParsedConfig = Map<string, Map<string, string[]>>;

const ROOT_SECTION = '__root__';
const BIND_ADDRESS_PATTERN = /^.+:\d+$/;
const CIDR_PATTERN = /^[^\s]+\/\d+$/;
const DEFAULT_WIREPROXY_BINARY = 'wireproxy';
const DEFAULT_DOCKER_BINARY = 'docker';
const DEFAULT_DOCKER_IMAGE = 'ghcr.io/windtf/wireproxy:latest';

export async function validateWireproxyConfig(
  options: ValidateWireproxyOptions,
): Promise<ValidateWireproxyResult> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const wireproxyBinary = options.wireproxyBinary ?? DEFAULT_WIREPROXY_BINARY;
  const dockerBinary = options.dockerBinary ?? DEFAULT_DOCKER_BINARY;
  const runner = options.spawn ?? spawnSync;

  const localResult = runConfigTest({
    runner,
    command: wireproxyBinary,
    args: ['--configtest', options.configPath],
    checkedAt,
    source: 'wireproxy-binary',
    validator: 'wireproxy-configtest',
    target: options.configPath,
  });

  if (localResult.kind === 'result') {
    return persistValidationReport(localResult.result, options.reportPath);
  }

  const dockerResult = runConfigTest({
    runner,
    command: dockerBinary,
    args: [
      'run',
      '--rm',
      '-v',
      `${options.configPath}:/etc/wireproxy/wireproxy.conf:ro`,
      options.dockerImage ?? DEFAULT_DOCKER_IMAGE,
      '--configtest',
      '/etc/wireproxy/wireproxy.conf',
    ],
    checkedAt,
    source: 'docker',
    validator: 'docker-wireproxy-configtest',
    target: options.configPath,
  });

  if (dockerResult.kind === 'result') {
    return persistValidationReport(dockerResult.result, options.reportPath);
  }

  const configText = options.configText ?? readFileSync(options.configPath, 'utf8');
  const parsed = parseWireproxyConfig(configText, options.configPath);
  const issues = validateParsedConfig(parsed, options.configPath);

  const internalResult: ValidateWireproxyResult =
    issues.length === 0
      ? {
          ok: true,
          phase: 'validation',
          source: 'internal-syntax',
          status: 'success',
          checkedAt,
          target: options.configPath,
          ...(options.reportPath ? { reportPath: options.reportPath } : {}),
          validator: 'internal-syntax',
          issues: [],
        }
      : {
          ok: false,
          phase: 'validation',
          source: 'internal-syntax',
          status: 'failure',
          checkedAt,
          target: options.configPath,
          ...(options.reportPath ? { reportPath: options.reportPath } : {}),
          validator: 'internal-syntax',
          issues,
          cause: issues[0]?.message,
        };

  return persistValidationReport(internalResult, options.reportPath);
}

function runConfigTest(input: {
  runner: typeof spawnSync;
  command: string;
  args: string[];
  checkedAt: string;
  source: ValidateWireproxyResult['source'];
  validator: ValidateWireproxyResult['validator'];
  target: string;
}): { kind: 'result'; result: ValidateWireproxyResult } | { kind: 'missing-binary' } {
  const result = input.runner(input.command, input.args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    return { kind: 'missing-binary' };
  }

  if (isWindowsShellMissingBinary(result)) {
    return { kind: 'missing-binary' };
  }

  if ((result.status ?? 1) === 0) {
    return {
      kind: 'result',
      result: {
        ok: true,
        phase: 'validation',
        source: input.source,
        status: 'success',
        checkedAt: input.checkedAt,
        target: input.target,
        validator: input.validator,
        issues: [],
      },
    };
  }

  const message =
    [result.stderr, result.stdout]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim() || `${input.command} reported a validation error.`;

  return {
    kind: 'result',
    result: {
      ok: false,
      phase: 'validation',
      source: input.source,
      status: 'failure',
      checkedAt: input.checkedAt,
      target: input.target,
      validator: input.validator,
      issues: [
        {
          target: input.target,
          message,
        },
      ],
      cause: message,
    },
  };
}

function isWindowsShellMissingBinary(result: ReturnType<typeof spawnSync>): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  const message = [result.stderr, result.stdout]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');

  return (
    message.includes('is not recognized as an internal or external command') ||
    message.includes('The system cannot find the file specified') ||
    message.includes('The system cannot find the path specified')
  );
}

async function persistValidationReport(
  result: ValidateWireproxyResult,
  reportPath?: string,
): Promise<ValidateWireproxyResult> {
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

function parseWireproxyConfig(input: string, target: string): ParsedConfig {
  const parsed: ParsedConfig = new Map([[ROOT_SECTION, new Map()]]);
  let currentSection = ROOT_SECTION;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1);
      parsed.set(currentSection, parsed.get(currentSection) ?? new Map());
      continue;
    }

    const separator = line.indexOf('=');

    if (separator === -1) {
      record(parsed.get(ROOT_SECTION)!, target, `Unrecognized wireproxy config line: ${line}`);
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    const section = parsed.get(currentSection) ?? new Map();
    const existing = section.get(key) ?? [];

    section.set(key, [...existing, value]);
    parsed.set(currentSection, section);
  }

  return parsed;
}

function record(section: Map<string, string[]>, key: string, value: string): void {
  const existing = section.get(key) ?? [];
  section.set(key, [...existing, value]);
}

function validateParsedConfig(parsed: ParsedConfig, target: string): WireproxyValidationIssue[] {
  const issues: WireproxyValidationIssue[] = [];

  validateRequiredSection(parsed, issues, target, 'Interface', ['Address', 'PrivateKey']);
  validateRequiredSection(parsed, issues, target, 'Peer', ['PublicKey', 'Endpoint', 'AllowedIPs']);
  validateRequiredSection(parsed, issues, target, 'Socks5', [
    'BindAddress',
    'Username',
    'Password',
  ]);
  validateRequiredSection(parsed, issues, target, 'http', ['BindAddress', 'Username', 'Password']);

  validateAddressList(parsed, issues, target);
  validateEndpoint(parsed, issues, target);
  validateBindAddress(parsed, issues, target, 'Socks5');
  validateBindAddress(parsed, issues, target, 'http');

  for (const message of parsed.get(ROOT_SECTION)?.get(target) ?? []) {
    issues.push({ target, message });
  }

  return issues;
}

function validateRequiredSection(
  parsed: ParsedConfig,
  issues: WireproxyValidationIssue[],
  target: string,
  sectionName: string,
  requiredKeys: readonly string[],
): void {
  const section = parsed.get(sectionName);

  if (!section) {
    issues.push({
      target,
      message: `Missing required [${sectionName}] section.`,
    });
    return;
  }

  for (const key of requiredKeys) {
    const values = section.get(key) ?? [];

    if (values.length === 0 || values[0]?.length === 0) {
      issues.push({
        target,
        message: `Missing required ${key} entry in [${sectionName}].`,
      });
    }
  }
}

function validateAddressList(
  parsed: ParsedConfig,
  issues: WireproxyValidationIssue[],
  target: string,
): void {
  const addresses =
    parsed
      .get('Interface')
      ?.get('Address')
      ?.flatMap((value) => value.split(',').map((segment) => segment.trim())) ?? [];

  for (const address of addresses) {
    if (!CIDR_PATTERN.test(address)) {
      issues.push({
        target,
        message: `Interface address ${address} is not a CIDR value.`,
      });
    }
  }
}

function validateEndpoint(
  parsed: ParsedConfig,
  issues: WireproxyValidationIssue[],
  target: string,
): void {
  const endpoint = parsed.get('Peer')?.get('Endpoint')?.[0];

  if (endpoint && !BIND_ADDRESS_PATTERN.test(endpoint)) {
    issues.push({
      target,
      message: `Peer endpoint ${endpoint} is not in host:port form.`,
    });
  }
}

function validateBindAddress(
  parsed: ParsedConfig,
  issues: WireproxyValidationIssue[],
  target: string,
  sectionName: string,
): void {
  const bindAddress = parsed.get(sectionName)?.get('BindAddress')?.[0];

  if (bindAddress && !BIND_ADDRESS_PATTERN.test(bindAddress)) {
    issues.push({
      target,
      message: `[${sectionName}] bind address ${bindAddress} is not in host:port form.`,
    });
  }
}
