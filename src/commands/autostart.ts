import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';

import { writeCliReport } from '../cli-output.js';
import { resolveMullgatePaths } from '../config/paths.js';

const AUTOSTART_UNIT_NAME = 'mullgate.service';

type WritableTextSink = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

type SystemctlResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type SystemctlRunner = (args: readonly string[]) => Promise<SystemctlResult>;
type LoginctlRunner = (args: readonly string[]) => Promise<SystemctlResult>;

type AutostartCommandDependencies = {
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly runSystemctl?: SystemctlRunner;
  readonly runLoginctl?: LoginctlRunner;
  readonly stdout?: WritableTextSink;
  readonly stderr?: WritableTextSink;
};

type AutostartSuccess = {
  readonly ok: true;
  readonly exitCode: 0;
  readonly summary: string;
};

type AutostartFailure = {
  readonly ok: false;
  readonly exitCode: 1;
  readonly summary: string;
};

type AutostartFlowResult = AutostartSuccess | AutostartFailure;

type AutostartSupport = {
  readonly ok: true;
  readonly binaryPath: string;
  readonly unitPath: string;
  readonly userName: string;
  readonly loginctlAvailable: boolean;
};

export function registerAutostartCommand(
  program: Command,
  dependencies: AutostartCommandDependencies = {},
): void {
  const autostart = program
    .command('autostart')
    .description('Manage Linux login-time Mullgate startup with a systemd user service.');

  autostart
    .command('enable')
    .description('Install and start the Mullgate systemd user service.')
    .action(async () => {
      const result = await enableAutostart(dependencies);
      writeAutostartResult(result, dependencies);
      process.exitCode = result.exitCode;
    });

  autostart
    .command('disable')
    .description('Stop and remove the Mullgate systemd user service.')
    .action(async () => {
      const result = await disableAutostart(dependencies);
      writeAutostartResult(result, dependencies);
      process.exitCode = result.exitCode;
    });

  autostart
    .command('status')
    .description('Inspect the Mullgate systemd user service state.')
    .action(async () => {
      const result = await inspectAutostart(dependencies);
      writeAutostartResult(result, dependencies);
      process.exitCode = result.exitCode;
    });
}

export async function enableAutostart(
  dependencies: Omit<AutostartCommandDependencies, 'stdout' | 'stderr'> = {},
): Promise<AutostartFlowResult> {
  const env = dependencies.env ?? process.env;
  const support = await resolveAutostartSupport({
    env,
    argv: dependencies.argv ?? process.argv,
    platform: dependencies.platform ?? process.platform,
    requireSystemctlOnPath: dependencies.runSystemctl === undefined,
    loginctlAvailableOverride: dependencies.runLoginctl ? true : undefined,
  });

  if (!support.ok) {
    return support;
  }

  const runSystemctl = dependencies.runSystemctl ?? runSystemctlCommand;
  const runLoginctl = dependencies.runLoginctl ?? runLoginctlCommand;
  const lingerResult = await ensureUserLinger({
    support,
    runLoginctl,
  });

  if (!lingerResult.ok) {
    return lingerResult;
  }

  const unitFile = buildAutostartUnitFile({ binaryPath: support.binaryPath });

  try {
    await mkdir(path.dirname(support.unitPath), { recursive: true, mode: 0o700 });
    await writeFile(support.unitPath, `${unitFile}\n`, { mode: 0o644 });
  } catch (error) {
    return renderAutostartFailure({
      action: 'enable',
      unitPath: support.unitPath,
      message: 'Failed to write the Mullgate autostart unit file.',
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const daemonReload = await runSystemctl(['--user', 'daemon-reload']);

  if (daemonReload.code !== 0) {
    return renderAutostartFailure({
      action: 'enable',
      unitPath: support.unitPath,
      binaryPath: support.binaryPath,
      message: 'systemctl --user daemon-reload failed.',
      cause: collectSystemctlCause(daemonReload),
    });
  }

  const enableResult = await runSystemctl(['--user', 'enable', '--now', AUTOSTART_UNIT_NAME]);

  if (enableResult.code !== 0) {
    return renderAutostartFailure({
      action: 'enable',
      unitPath: support.unitPath,
      binaryPath: support.binaryPath,
      message: 'systemctl --user enable --now failed.',
      cause: collectSystemctlCause(enableResult),
    });
  }

  return {
    ok: true,
    exitCode: 0,
    summary: [
      'Mullgate autostart enabled.',
      'phase: autostart-enable',
      'platform: linux',
      `user: ${support.userName}`,
      `unit: ${support.unitPath}`,
      `exec start: ${support.binaryPath} proxy start`,
      `linger: ${lingerResult.state}`,
      'service: enabled and started',
      'next step: run `mullgate proxy autostart status` if you want to verify the user service state.',
    ].join('\n'),
  };
}

export async function disableAutostart(
  dependencies: Omit<AutostartCommandDependencies, 'stdout' | 'stderr'> = {},
): Promise<AutostartFlowResult> {
  const env = dependencies.env ?? process.env;
  const support = await resolveAutostartSupport({
    env,
    argv: dependencies.argv ?? process.argv,
    platform: dependencies.platform ?? process.platform,
    requireSystemctlOnPath: dependencies.runSystemctl === undefined,
    loginctlAvailableOverride: dependencies.runLoginctl ? true : undefined,
  });

  if (!support.ok) {
    return support;
  }

  const runSystemctl = dependencies.runSystemctl ?? runSystemctlCommand;
  const disableResult = await runSystemctl(['--user', 'disable', '--now', AUTOSTART_UNIT_NAME]);

  if (disableResult.code !== 0 && !isBenignDisableResult(disableResult)) {
    return renderAutostartFailure({
      action: 'disable',
      unitPath: support.unitPath,
      message: 'systemctl --user disable --now failed.',
      cause: collectSystemctlCause(disableResult),
    });
  }

  try {
    await rm(support.unitPath, { force: true });
  } catch (error) {
    return renderAutostartFailure({
      action: 'disable',
      unitPath: support.unitPath,
      message: 'Failed to remove the Mullgate autostart unit file.',
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const daemonReload = await runSystemctl(['--user', 'daemon-reload']);

  if (daemonReload.code !== 0) {
    return renderAutostartFailure({
      action: 'disable',
      unitPath: support.unitPath,
      message: 'systemctl --user daemon-reload failed after removing the unit.',
      cause: collectSystemctlCause(daemonReload),
    });
  }

  return {
    ok: true,
    exitCode: 0,
    summary: [
      'Mullgate autostart disabled.',
      'phase: autostart-disable',
      'platform: linux',
      `user: ${support.userName}`,
      `unit: ${support.unitPath}`,
      'service: stopped and removed',
      'linger: unchanged',
      'next step: run `mullgate proxy start` manually whenever you want the proxy runtime online.',
    ].join('\n'),
  };
}

export async function inspectAutostart(
  dependencies: Omit<AutostartCommandDependencies, 'stdout' | 'stderr'> = {},
): Promise<AutostartFlowResult> {
  const env = dependencies.env ?? process.env;
  const support = await resolveAutostartSupport({
    env,
    argv: dependencies.argv ?? process.argv,
    platform: dependencies.platform ?? process.platform,
    requireSystemctlOnPath: dependencies.runSystemctl === undefined,
    loginctlAvailableOverride: dependencies.runLoginctl ? true : undefined,
  });

  if (!support.ok) {
    return support;
  }

  const runSystemctl = dependencies.runSystemctl ?? runSystemctlCommand;
  const runLoginctl = dependencies.runLoginctl ?? runLoginctlCommand;
  const [enabled, active, unitContents] = await Promise.all([
    runSystemctl(['--user', 'is-enabled', AUTOSTART_UNIT_NAME]),
    runSystemctl(['--user', 'is-active', AUTOSTART_UNIT_NAME]),
    readExistingUnitFile(support.unitPath),
  ]);
  const lingerState = support.loginctlAvailable
    ? await queryLingerState({ support, runLoginctl })
    : 'unknown (loginctl unavailable)';

  const unitState = unitContents === null ? 'missing' : 'present';
  const enabledState = normalizeSystemctlState(enabled, 'disabled');
  const activeState = normalizeSystemctlState(active, 'inactive');

  return {
    ok: true,
    exitCode: 0,
    summary: [
      'Mullgate autostart status',
      'phase: autostart-status',
      'platform: linux',
      `user: ${support.userName}`,
      `unit: ${support.unitPath}`,
      `unit file: ${unitState}`,
      `exec start: ${support.binaryPath} proxy start`,
      `linger: ${lingerState}`,
      `enabled: ${enabledState}`,
      `active: ${activeState}`,
      ...(unitContents === null ? [] : ['preview:', ...unitContents.split('\n')]),
    ].join('\n'),
  };
}

export function buildAutostartUnitFile(input: { readonly binaryPath: string }): string {
  return [
    '[Unit]',
    'Description=Mullgate proxy runtime',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${escapeSystemdExecArgument(input.binaryPath)} proxy start`,
    'RemainAfterExit=yes',
    'Restart=on-failure',
    'RestartSec=15',
    'WorkingDirectory=%h',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n');
}

async function resolveAutostartSupport(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly requireSystemctlOnPath: boolean;
  readonly loginctlAvailableOverride?: boolean;
}): Promise<AutostartSupport | AutostartFailure> {
  if (input.platform !== 'linux') {
    return renderAutostartFailure({
      action: 'status',
      message: 'Autostart is only supported on Linux right now.',
    });
  }

  if (input.requireSystemctlOnPath) {
    const systemctlPath = await resolveExecutableFromPath('systemctl', input.env);
    const loginctlAvailable =
      input.loginctlAvailableOverride ??
      Boolean(await resolveExecutableFromPath('loginctl', input.env));

    if (systemctlPath) {
      return resolveSupportedAutostartPaths(input.env, input.argv, loginctlAvailable);
    }

    return renderAutostartFailure({
      action: 'status',
      message: 'systemctl was not found on PATH, so Mullgate cannot manage a user service.',
    });
  }

  const loginctlAvailable =
    input.loginctlAvailableOverride ??
    Boolean(await resolveExecutableFromPath('loginctl', input.env));

  return resolveSupportedAutostartPaths(input.env, input.argv, loginctlAvailable);
}

async function resolveSupportedAutostartPaths(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  loginctlAvailable: boolean,
): Promise<AutostartSupport | AutostartFailure> {
  const binaryPath = await resolveMullgateBinaryPath({
    env,
    argv,
  });

  if (!binaryPath) {
    return renderAutostartFailure({
      action: 'status',
      message:
        'Could not resolve an installed `mullgate` executable on PATH. Install the CLI first, then retry `mullgate proxy autostart enable`.',
    });
  }

  const userName = resolveCurrentUserName(env);

  if (!userName) {
    return renderAutostartFailure({
      action: 'status',
      message: 'Could not determine the current Linux user for the autostart service.',
    });
  }

  const paths = resolveMullgatePaths(env);

  return {
    ok: true,
    binaryPath,
    unitPath: path.join(paths.configHome, 'systemd', 'user', AUTOSTART_UNIT_NAME),
    userName,
    loginctlAvailable,
  };
}

async function resolveMullgateBinaryPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
}): Promise<string | null> {
  const currentArgvPath = input.argv[1];
  const currentBinaryPath = resolveCurrentBinaryPath(currentArgvPath);

  if (currentBinaryPath) {
    try {
      await access(currentBinaryPath, fsConstants.X_OK);
      return currentBinaryPath;
    } catch {
      // Fall through to PATH lookup when the current entrypoint is not an executable shim.
    }
  }

  return resolveExecutableFromPath('mullgate', input.env);
}

function resolveCurrentBinaryPath(currentArgvPath: string | undefined): string | null {
  if (!currentArgvPath) {
    return null;
  }

  const normalizedPath = path.resolve(currentArgvPath);

  if (path.basename(normalizedPath) !== 'mullgate') {
    return null;
  }

  return normalizedPath;
}

async function resolveExecutableFromPath(
  executableName: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const rawPath = env.PATH;

  if (!rawPath) {
    return null;
  }

  const searchDirectories = rawPath.split(path.delimiter).filter((segment) => segment.length > 0);

  for (const directory of searchDirectories) {
    const candidate = path.join(directory, executableName);

    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }

  return null;
}

async function runSystemctlCommand(args: readonly string[]): Promise<SystemctlResult> {
  return runCommand('systemctl', args);
}

async function runLoginctlCommand(args: readonly string[]): Promise<SystemctlResult> {
  return runCommand('loginctl', args);
}

async function runCommand(
  command: string,
  args: readonly string[],
): Promise<SystemctlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8').trim(),
        stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
      });
    });
  });
}

async function ensureUserLinger(input: {
  readonly support: AutostartSupport;
  readonly runLoginctl: LoginctlRunner;
}): Promise<{ readonly ok: true; readonly state: 'enabled' | 'already-enabled' } | AutostartFailure> {
  if (!input.support.loginctlAvailable) {
    return renderAutostartFailure({
      action: 'enable',
      unitPath: input.support.unitPath,
      binaryPath: input.support.binaryPath,
      message:
        'loginctl was not found on PATH, so Mullgate cannot guarantee reboot-time startup for the systemd user service.',
      cause:
        `Install loginctl support or enable linger manually for ${input.support.userName} before retrying \`mullgate proxy autostart enable\`.`,
    });
  }

  const currentState = await queryLingerState(input);

  if (currentState === 'yes') {
    return {
      ok: true,
      state: 'already-enabled',
    };
  }

  const result = await input.runLoginctl(['enable-linger', input.support.userName]);

  if (result.code !== 0) {
    return renderAutostartFailure({
      action: 'enable',
      unitPath: input.support.unitPath,
      binaryPath: input.support.binaryPath,
      message:
        'loginctl enable-linger failed, so Mullgate cannot guarantee reboot-time startup for the systemd user service.',
      cause: collectSystemctlCause(result),
    });
  }

  return {
    ok: true,
    state: 'enabled',
  };
}

async function queryLingerState(input: {
  readonly support: AutostartSupport;
  readonly runLoginctl: LoginctlRunner;
}): Promise<string> {
  const result = await input.runLoginctl([
    'show-user',
    input.support.userName,
    '--property=Linger',
    '--value',
  ]);

  if (result.code !== 0) {
    return `unknown (${collectSystemctlCause(result)})`;
  }

  return result.stdout || 'unknown';
}

function writeAutostartResult(
  result: AutostartFlowResult,
  dependencies: Pick<AutostartCommandDependencies, 'stdout' | 'stderr'>,
): void {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  if (result.ok) {
    writeCliReport({ sink: stdout, text: result.summary, tone: 'success' });
    return;
  }

  writeCliReport({ sink: stderr, text: result.summary, tone: 'error' });
}

function renderAutostartFailure(input: {
  readonly action: 'enable' | 'disable' | 'status';
  readonly message: string;
  readonly cause?: string;
  readonly unitPath?: string;
  readonly binaryPath?: string;
}): AutostartFailure {
  return {
    ok: false,
    exitCode: 1,
    summary: [
      'Mullgate autostart failed.',
      `phase: autostart-${input.action}`,
      ...(input.unitPath ? [`unit: ${input.unitPath}`] : []),
      ...(input.binaryPath ? [`exec start: ${input.binaryPath} proxy start`] : []),
      `reason: ${input.message}`,
      ...(input.cause ? [`cause: ${input.cause}`] : []),
    ].join('\n'),
  };
}

function collectSystemctlCause(result: SystemctlResult): string {
  return result.stderr || result.stdout || `systemctl exited with code ${result.code}.`;
}

function normalizeSystemctlState(result: SystemctlResult, fallback: string): string {
  if (result.stdout) {
    return result.stdout;
  }

  if (result.stderr) {
    return result.stderr;
  }

  return result.code === 0 ? 'active' : fallback;
}

function isBenignDisableResult(result: SystemctlResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();

  return (
    combined.includes('not loaded') ||
    combined.includes('does not exist') ||
    combined.includes('not-found') ||
    combined.includes('no such file')
  );
}

async function readExistingUnitFile(unitPath: string): Promise<string | null> {
  try {
    return (await readFile(unitPath, 'utf8')).trimEnd();
  } catch {
    return null;
  }
}

function escapeSystemdExecArgument(value: string): string {
  return value.replace(/([\\\s])/g, '\\$1');
}

function resolveCurrentUserName(env: NodeJS.ProcessEnv): string | null {
  const user = env.USER?.trim() || env.LOGNAME?.trim();
  return user ? user : null;
}
