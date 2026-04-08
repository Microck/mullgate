import type { Command } from 'commander';

import { withRuntimeStatus } from '../app/setup-runner.js';
import { type WritableTextSink, writeCliReport } from '../cli-output.js';
import { ConfigStore } from '../config/store.js';
import { type StopDockerRuntimeOptions, stopDockerRuntime } from '../runtime/docker-runtime.js';
import { renderLoadConfigError, renderMissingConfigError } from './config.js';

export type StopCommandDependencies = {
  readonly store?: ConfigStore;
  readonly checkedAt?: string;
  readonly stopRuntime?: (
    options: StopDockerRuntimeOptions,
  ) => Promise<Awaited<ReturnType<typeof stopDockerRuntime>>>;
  readonly stdout?: WritableTextSink;
  readonly stderr?: WritableTextSink;
};

export type StopFlowResult =
  | {
      readonly ok: true;
      readonly exitCode: 0;
      readonly summary: string;
    }
  | {
      readonly ok: false;
      readonly exitCode: 1;
      readonly summary: string;
    };

export function registerStopCommand(
  program: Command,
  dependencies: StopCommandDependencies = {},
): void {
  program
    .command('stop')
    .description('Stop the saved Docker runtime bundle without rerendering config artifacts.')
    .action(createStopCommandAction(dependencies));
}

export function createStopCommandAction(
  dependencies: StopCommandDependencies = {},
): () => Promise<void> {
  return async () => {
    const result = await runStopFlow(dependencies);
    const stdout = dependencies.stdout ?? process.stdout;
    const stderr = dependencies.stderr ?? process.stderr;

    if (result.ok) {
      writeCliReport({ sink: stdout, text: result.summary, tone: 'success' });
    } else {
      writeCliReport({ sink: stderr, text: result.summary, tone: 'error' });
    }

    process.exitCode = result.exitCode;
  };
}

export async function runStopFlow(
  dependencies: Omit<StopCommandDependencies, 'stdout' | 'stderr'> = {},
): Promise<StopFlowResult> {
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
  const stopRuntime = dependencies.stopRuntime ?? stopDockerRuntime;
  const composeFilePath = store.paths.runtimeComposeFile;
  const stopResult = await stopRuntime({ composeFilePath, checkedAt });

  if (!stopResult.ok) {
    return {
      ok: false,
      exitCode: 1,
      summary: [
        'Mullgate runtime stop failed.',
        `phase: ${stopResult.phase}`,
        `source: ${stopResult.source}`,
        `attempted at: ${stopResult.checkedAt}`,
        ...(stopResult.code ? [`code: ${stopResult.code}`] : []),
        `docker compose: ${stopResult.composeFilePath}`,
        `command: ${stopResult.command.rendered}`,
        `reason: ${stopResult.message}`,
        ...(stopResult.cause ? [`cause: ${stopResult.cause}`] : []),
        'remediation: Check `docker compose ps` / `docker compose logs` for the saved runtime bundle, resolve the failing service or Docker issue, then rerun `mullgate proxy stop`.',
      ].join('\n'),
    };
  }

  const stoppedConfig = withRuntimeStatus(
    loadResult.config,
    'validated',
    checkedAt,
    `Runtime stopped via docker compose down from ${composeFilePath}.`,
  );
  await store.save(stoppedConfig);

  return {
    ok: true,
    exitCode: 0,
    summary: [
      'Mullgate runtime stopped.',
      'phase: compose-down',
      'source: docker-compose',
      `attempted at: ${checkedAt}`,
      `docker compose: ${composeFilePath}`,
      `command: ${stopResult.command.rendered}`,
      `config: ${store.paths.configFile}`,
      'runtime status: validated (bundle stopped)',
    ].join('\n'),
  };
}
