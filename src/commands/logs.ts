import type { Command } from 'commander';

import { type WritableTextSink, writeCliRaw, writeCliReport } from '../cli-output.js';
import { ConfigStore } from '../config/store.js';
import {
  type ReadDockerComposeLogsOptions,
  readDockerComposeLogs,
} from '../runtime/docker-runtime.js';
import { renderLoadConfigError, renderMissingConfigError } from './config.js';

type LogsCommandOptions = {
  readonly tail?: string;
  readonly follow?: boolean;
};

export type LogsCommandDependencies = {
  readonly store?: ConfigStore;
  readonly checkedAt?: string;
  readonly readLogs?: (
    options: ReadDockerComposeLogsOptions,
  ) => Promise<Awaited<ReturnType<typeof readDockerComposeLogs>>>;
  readonly stdout?: WritableTextSink;
  readonly stderr?: WritableTextSink;
};

export type LogsFlowResult =
  | {
      readonly ok: true;
      readonly exitCode: 0;
      readonly output: string;
    }
  | {
      readonly ok: false;
      readonly exitCode: 1;
      readonly summary: string;
    };

export function registerLogsCommand(
  program: Command,
  dependencies: LogsCommandDependencies = {},
): void {
  program
    .command('logs')
    .description('Read the saved Docker Compose logs for the current runtime bundle.')
    .option('--tail <lines>', 'Show this many log lines from the end of the bundle logs.')
    .option('--follow', 'Keep streaming the Docker Compose logs until interrupted.')
    .action(createLogsCommandAction(dependencies));
}

export function createLogsCommandAction(
  dependencies: LogsCommandDependencies = {},
): (options: LogsCommandOptions) => Promise<void> {
  return async (options: LogsCommandOptions) => {
    const result = await runLogsFlow(options, dependencies);
    const stdout = dependencies.stdout ?? process.stdout;
    const stderr = dependencies.stderr ?? process.stderr;

    if (result.ok) {
      writeCliRaw({ sink: stdout, text: result.output });
    } else {
      writeCliReport({ sink: stderr, text: result.summary, tone: 'error' });
    }

    process.exitCode = result.exitCode;
  };
}

export async function runLogsFlow(
  options: LogsCommandOptions,
  dependencies: Omit<LogsCommandDependencies, 'stdout' | 'stderr'> = {},
): Promise<LogsFlowResult> {
  const store = dependencies.store ?? new ConfigStore();
  const loadResult = await store.load();

  if (!loadResult.ok) {
    return {
      ok: false,
      exitCode: 1,
      summary: renderLoadConfigError(loadResult),
    };
  }

  if (loadResult.source === 'empty') {
    return {
      ok: false,
      exitCode: 1,
      summary: renderMissingConfigError(loadResult.message, store.paths.configFile),
    };
  }

  const checkedAt = dependencies.checkedAt ?? new Date().toISOString();
  let tail: number;

  try {
    tail = parsePositiveInteger(options.tail ?? '200', 'tail');
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      summary: [
        'Mullgate runtime logs failed.',
        'phase: input',
        'source: cli',
        `reason: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
    };
  }

  const readLogs = dependencies.readLogs ?? readDockerComposeLogs;
  const result = await readLogs({
    composeFilePath: store.paths.runtimeComposeFile,
    checkedAt,
    tail,
    follow: Boolean(options.follow),
  });

  if (!result.ok) {
    return {
      ok: false,
      exitCode: 1,
      summary: [
        'Mullgate runtime logs failed.',
        `phase: ${result.phase}`,
        `source: ${result.source}`,
        `attempted at: ${result.checkedAt}`,
        ...(result.code ? [`code: ${result.code}`] : []),
        `docker compose: ${result.composeFilePath}`,
        `command: ${result.command.rendered}`,
        `reason: ${result.message}`,
        ...(result.cause ? [`cause: ${result.cause}`] : []),
      ].join('\n'),
    };
  }

  return {
    ok: true,
    exitCode: 0,
    output: result.stdout,
  };
}

function parsePositiveInteger(raw: string, label: string): number {
  const numeric = Number.parseInt(raw, 10);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Expected --${label} to be a positive integer.`);
  }

  return numeric;
}
