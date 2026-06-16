import {
  autocomplete,
  autocompleteMultiselect,
  cancel as clackCancel,
  confirm,
  intro,
  isCancel,
  outro,
  select,
  text,
} from '@clack/prompts';

export const GUIDED_PROMPT_CANCELLED = Symbol('guided-prompt-cancelled');

export type PromptTextOptions = {
  readonly message: string;
  readonly initialValue?: string;
  readonly placeholder?: string;
  readonly validate?: (value: string | undefined) => string | undefined;
};

export type PromptSelectOption = {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
};

export type PromptSelectOptions = {
  readonly message: string;
  readonly options: readonly PromptSelectOption[];
  readonly initialValue?: string;
  readonly placeholder?: string;
};

export type PromptMultiSelectOptions = {
  readonly message: string;
  readonly options: readonly PromptSelectOption[];
  readonly initialValues?: readonly string[];
  readonly required?: boolean;
  readonly placeholder?: string;
};

export type PromptConfirmOptions = {
  readonly message: string;
  readonly initialValue?: boolean;
  readonly active?: string;
  readonly inactive?: string;
};

export type GuidedPromptClient = {
  readonly intro: (message: string) => void;
  readonly outro: (message: string) => void;
  readonly cancel: (message: string) => void;
  readonly text: (options: PromptTextOptions) => Promise<string | typeof GUIDED_PROMPT_CANCELLED>;
  readonly select: (
    options: PromptSelectOptions,
  ) => Promise<string | typeof GUIDED_PROMPT_CANCELLED>;
  readonly multiselect: (
    options: PromptMultiSelectOptions,
  ) => Promise<readonly string[] | typeof GUIDED_PROMPT_CANCELLED>;
  readonly confirm: (
    options: PromptConfirmOptions,
  ) => Promise<boolean | typeof GUIDED_PROMPT_CANCELLED>;
  readonly close: () => Promise<void>;
};

export function describePromptStep(title: string, detail: string): string {
  return `${title}\n${detail}`;
}

export function createGuidedPromptClient(): GuidedPromptClient {
  if (process.stdin.isTTY && process.stderr.isTTY) {
    return {
      intro: (message) => {
        intro(message, { input: process.stdin, output: process.stderr });
      },
      outro: (message) => {
        outro(message, { input: process.stdin, output: process.stderr });
      },
      cancel: (message) => {
        clackCancel(message, { input: process.stdin, output: process.stderr });
      },
      text: async (options) => {
        const result = await text({
          message: options.message,
          ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
          ...(options.placeholder ? { placeholder: options.placeholder } : {}),
          ...(options.validate ? { validate: options.validate } : {}),
          input: process.stdin,
          output: process.stderr,
        });

        return isCancel(result) ? GUIDED_PROMPT_CANCELLED : result;
      },
      select: async (options) => {
        const result =
          options.options.length > 15
            ? await autocomplete({
                message: options.message,
                options: [...options.options],
                ...(options.initialValue !== undefined
                  ? { initialValue: options.initialValue }
                  : {}),
                ...(options.placeholder ? { placeholder: options.placeholder } : {}),
                input: process.stdin,
                output: process.stderr,
              })
            : await select({
                message: options.message,
                options: [...options.options],
                ...(options.initialValue !== undefined
                  ? { initialValue: options.initialValue }
                  : {}),
                input: process.stdin,
                output: process.stderr,
              });

        return isCancel(result) ? GUIDED_PROMPT_CANCELLED : result;
      },
      multiselect: async (options) => {
        const result = await autocompleteMultiselect({
          message: options.message,
          options: [...options.options],
          ...(options.initialValues ? { initialValues: [...options.initialValues] } : {}),
          ...(options.required !== undefined ? { required: options.required } : {}),
          ...(options.placeholder ? { placeholder: options.placeholder } : {}),
          input: process.stdin,
          output: process.stderr,
        });

        return isCancel(result) ? GUIDED_PROMPT_CANCELLED : result;
      },
      confirm: async (options) => {
        const result = await confirm({
          message: options.message,
          ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
          ...(options.active ? { active: options.active } : {}),
          ...(options.inactive ? { inactive: options.inactive } : {}),
          input: process.stdin,
          output: process.stderr,
        });

        return isCancel(result) ? GUIDED_PROMPT_CANCELLED : result;
      },
      close: async () => {},
    };
  }

  let bufferedLinesPromise: Promise<string[]> | null = null;

  async function nextBufferedLine(): Promise<string | null> {
    if (!bufferedLinesPromise) {
      bufferedLinesPromise = readAllStdinLines();
    }

    const bufferedLines = await bufferedLinesPromise;
    return bufferedLines.shift() ?? null;
  }

  return {
    intro: (message) => {
      process.stderr.write(`${message}\n`);
    },
    outro: (message) => {
      process.stderr.write(`${message}\n`);
    },
    cancel: (message) => {
      process.stderr.write(`${message}\n`);
    },
    text: async (options) => {
      while (true) {
        const renderedDefault = options.initialValue ? ` [${options.initialValue}]` : '';
        process.stderr.write(`${options.message}${renderedDefault}: `);
        const answer = await nextBufferedLine();

        if (answer === null) {
          process.stderr.write('\n');
          return GUIDED_PROMPT_CANCELLED;
        }

        const value = answer.trim().length > 0 ? answer : (options.initialValue ?? '');
        const validationError = options.validate?.(value);

        if (!validationError) {
          process.stderr.write('\n');
          return value;
        }

        process.stderr.write(`\n${validationError}\n`);
      }
    },
    select: async (options) => {
      const optionLookup = new Map(
        options.options.flatMap((option, index) => [
          [option.value.toLowerCase(), option.value],
          [String(index + 1), option.value],
          [option.label.toLowerCase(), option.value],
        ]),
      );

      while (true) {
        process.stderr.write(`${options.message}\n`);
        options.options.forEach((option, index) => {
          process.stderr.write(
            `  ${index + 1}. ${option.label}${option.hint ? ` - ${option.hint}` : ''}\n`,
          );
        });
        process.stderr.write('Select one option: ');
        const answer = await nextBufferedLine();

        if (answer === null) {
          process.stderr.write('\n');
          return GUIDED_PROMPT_CANCELLED;
        }

        const resolved = optionLookup.get(answer.trim().toLowerCase());

        if (resolved) {
          process.stderr.write('\n');
          return resolved;
        }

        process.stderr.write('\nEnter an option number or value from the list.\n');
      }
    },
    multiselect: async (options) => {
      const optionLookup = new Map(
        options.options.flatMap((option, index) => [
          [option.value.toLowerCase(), option.value],
          [String(index + 1), option.value],
          [option.label.toLowerCase(), option.value],
        ]),
      );

      while (true) {
        process.stderr.write(`${options.message}\n`);
        options.options.forEach((option, index) => {
          process.stderr.write(
            `  ${index + 1}. ${option.label}${option.hint ? ` - ${option.hint}` : ''}\n`,
          );
        });
        process.stderr.write('Select one or more options (comma-separated, blank for none): ');
        const answer = await nextBufferedLine();

        if (answer === null) {
          process.stderr.write('\n');
          return GUIDED_PROMPT_CANCELLED;
        }

        const selections = answer
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0)
          .map((entry) => optionLookup.get(entry))
          .filter(isDefined);

        if (selections.length === 0 && options.required) {
          process.stderr.write('\nSelect at least one option.\n');
          continue;
        }

        if (answer.trim().length > 0 && selections.length === 0) {
          process.stderr.write('\nEnter option numbers or values from the list.\n');
          continue;
        }

        process.stderr.write('\n');
        return [...new Set(selections)];
      }
    },
    confirm: async (options) => {
      while (true) {
        const suffix = options.initialValue ? ' [Y/n]' : ' [y/N]';
        process.stderr.write(`${options.message}${suffix}: `);
        const answer = await nextBufferedLine();

        if (answer === null) {
          process.stderr.write('\n');
          return GUIDED_PROMPT_CANCELLED;
        }

        const normalizedAnswer = answer.trim().toLowerCase();

        if (!normalizedAnswer) {
          process.stderr.write('\n');
          return options.initialValue ?? false;
        }

        if (['y', 'yes'].includes(normalizedAnswer)) {
          process.stderr.write('\n');
          return true;
        }

        if (['n', 'no'].includes(normalizedAnswer)) {
          process.stderr.write('\n');
          return false;
        }

        process.stderr.write('\nEnter yes or no.\n');
      }
    },
    close: async () => {},
  };
}

async function readAllStdinLines(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8').split(/\r?\n/));
    });
    process.stdin.on('error', reject);
  });
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
