import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  createGuidedPromptClient,
  describePromptStep,
  GUIDED_PROMPT_CANCELLED,
} from './proxy-export-prompt-client.js';
import type { ProxyExportFailure } from './proxy-export-selectors.js';

export async function resolveProxyExportOutputPath(input: {
  readonly outputPath: string;
  readonly force: boolean;
  readonly guided: boolean;
  readonly configPath: string;
}): Promise<
  | {
      readonly ok: true;
      readonly displayPath: string;
      readonly absolutePath: string;
    }
  | ProxyExportFailure
> {
  let displayPath = input.outputPath.startsWith('./') ? input.outputPath : input.outputPath;
  let absolutePath = path.resolve(process.cwd(), input.outputPath);

  if (input.force || !(await fileExists(absolutePath))) {
    return {
      ok: true,
      displayPath,
      absolutePath,
    };
  }

  if (!input.guided) {
    return {
      ok: false,
      phase: 'persist-file',
      source: 'filesystem',
      message: 'Refusing to overwrite an existing proxy export file without --force.',
      configPath: input.configPath,
      artifactPath: absolutePath,
    };
  }

  const prompts = createGuidedPromptClient();

  try {
    while (true) {
      const overwrite = await prompts.confirm({
        message: describePromptStep(
          `Output file ${displayPath} already exists. Overwrite it?`,
          'Choose overwrite to replace it now, or pick a new destination path.',
        ),
        initialValue: false,
        active: 'Overwrite',
        inactive: 'Choose another path',
      });

      if (overwrite === GUIDED_PROMPT_CANCELLED) {
        prompts.cancel('Guided export cancelled.');
        return {
          ok: false,
          phase: 'persist-file',
          source: 'user-input',
          message: 'Guided export cancelled before Mullgate wrote any proxy file.',
          configPath: input.configPath,
          artifactPath: absolutePath,
        };
      }

      if (overwrite) {
        return {
          ok: true,
          displayPath,
          absolutePath,
        };
      }

      const nextPath = await prompts.text({
        message: describePromptStep(
          'Choose a different output path',
          'Pick a new file path for the proxy list.',
        ),
        initialValue: 'proxies.txt',
        validate: (value) =>
          readOptionalString(value) ? undefined : 'Output path is required when writing a file.',
      });

      if (nextPath === GUIDED_PROMPT_CANCELLED) {
        prompts.cancel('Guided export cancelled.');
        return {
          ok: false,
          phase: 'persist-file',
          source: 'user-input',
          message: 'Guided export cancelled before Mullgate wrote any proxy file.',
          configPath: input.configPath,
          artifactPath: absolutePath,
        };
      }

      displayPath = nextPath.trim();
      absolutePath = path.resolve(process.cwd(), displayPath);

      if (!(await fileExists(absolutePath))) {
        return {
          ok: true,
          displayPath,
          absolutePath,
        };
      }
    }
  } finally {
    await prompts.close();
  }
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
