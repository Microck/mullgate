import type { Command } from 'commander';

import { type WritableTextSink, writeCliReport } from '../cli-output.js';
import { ConfigStore } from '../config/store.js';
import { runStartFlow, type StartCommandDependencies } from './start.js';
import { runStopFlow, type StopCommandDependencies } from './stop.js';

/**
 * Dependency overrides for composing the `mullgate restart` stop-then-start flow.
 */
export type RestartCommandDependencies = {
  readonly store?: ConfigStore;
  readonly checkedAt?: string;
  readonly stdout?: WritableTextSink;
  readonly stderr?: WritableTextSink;
  readonly startDependencies?: Omit<
    StartCommandDependencies,
    'store' | 'checkedAt' | 'stdout' | 'stderr'
  >;
  readonly stopDependencies?: Omit<
    StopCommandDependencies,
    'store' | 'checkedAt' | 'stdout' | 'stderr'
  >;
};

/**
 * Registers the `restart` command and wires it to the shared restart action.
 *
 * @param program - Root CLI program to extend.
 * @param dependencies - Optional restart flow dependency overrides.
 */
export function registerRestartCommand(
  program: Command,
  dependencies: RestartCommandDependencies = {},
): void {
  program
    .command('restart')
    .description('Stop the current runtime bundle, rerender artifacts, and start it again.')
    .action(createRestartCommandAction(dependencies));
}

/**
 * Creates the async action used by the `restart` command.
 *
 * @param dependencies - Optional restart flow dependency overrides.
 * @returns A command action that stops the active runtime and then starts it again.
 */
export function createRestartCommandAction(
  dependencies: RestartCommandDependencies = {},
): () => Promise<void> {
  return async () => {
    const stdout = dependencies.stdout ?? process.stdout;
    const stderr = dependencies.stderr ?? process.stderr;
    const checkedAt = dependencies.checkedAt ?? new Date().toISOString();
    const store = dependencies.store ?? new ConfigStore();

    const stopResult = await runStopFlow({
      store,
      checkedAt,
      ...(dependencies.stopDependencies ?? {}),
    });

    if (!stopResult.ok) {
      writeCliReport({ sink: stderr, text: stopResult.summary, tone: 'error' });
      process.exitCode = stopResult.exitCode;
      return;
    }

    const startResult = await runStartFlow({
      store,
      checkedAt,
      ...(dependencies.startDependencies ?? {}),
    });

    const combinedSummary = [stopResult.summary, '', renderStartSummary(startResult)].join('\n');

    if (startResult.ok) {
      writeCliReport({ sink: stdout, text: combinedSummary, tone: 'success' });
    } else {
      writeCliReport({ sink: stderr, text: combinedSummary, tone: 'error' });
    }

    process.exitCode = startResult.exitCode;
  };
}

function renderStartSummary(result: Awaited<ReturnType<typeof runStartFlow>>): string {
  if (result.ok) {
    return result.summary;
  }

  return [
    'Mullgate restart failed during start.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    ...(result.attemptedAt ? [`attempted at: ${result.attemptedAt}`] : []),
    ...(result.code ? [`code: ${result.code}`] : []),
    ...(result.command ? [`command: ${result.command}`] : []),
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
    `config: ${result.paths.configFile}`,
  ].join('\n');
}
