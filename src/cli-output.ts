const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  cyan: '\u001B[36m',
  white: '\u001B[37m',
} as const;

type WritableTextSink = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

type CliTone = 'info' | 'success' | 'error';

export function writeCliReport(input: {
  readonly sink: WritableTextSink;
  readonly text: string;
  readonly tone?: CliTone;
}): void {
  input.sink.write(`${renderCliReport(input.text, input.sink, input.tone)}\n`);
}

export function writeCliRaw(input: {
  readonly sink: WritableTextSink;
  readonly text: string;
}): void {
  input.sink.write(input.text);
}

export function renderCliReport(
  text: string,
  sink: Pick<WritableTextSink, 'isTTY'>,
  tone: CliTone = 'info',
): string {
  if (!sink.isTTY) {
    return text;
  }

  const lines = text.split('\n');

  return lines
    .map((line, index) => {
      const withInlineCode = colorInlineCode(line);

      if (index === 0) {
        return applyTitleTone(withInlineCode, tone);
      }

      const trimmed = line.trim();

      if (!trimmed) {
        return line;
      }

      if (isSectionHeading(trimmed)) {
        return colorize(`${ANSI.bold}${ANSI.yellow}`, trimmed);
      }

      const keyValueMatch = /^(\s*)([^:]+:)(\s.*)?$/.exec(line);

      if (keyValueMatch) {
        const [, indentation, label, value = ''] = keyValueMatch;
        return `${indentation}${ANSI.dim}${ANSI.white}${label}${ANSI.reset}${colorInlineCode(value)}`;
      }

      if (/^\s*-\s/.test(line)) {
        return line.replace('-', `${ANSI.yellow}-${ANSI.reset}`);
      }

      if (/^\s*\d+\.\s/.test(line)) {
        return line.replace(/^(\s*\d+\.)/, `${ANSI.cyan}$1${ANSI.reset}`);
      }

      return withInlineCode;
    })
    .join('\n');
}

function applyTitleTone(line: string, tone: CliTone): string {
  if (tone === 'success') {
    return colorize(`${ANSI.bold}${ANSI.green}`, line);
  }

  if (tone === 'error') {
    return colorize(`${ANSI.bold}${ANSI.red}`, line);
  }

  return colorize(`${ANSI.bold}${ANSI.cyan}`, line);
}

function colorInlineCode(line: string): string {
  return line.replace(/`([^`]+)`/g, `${ANSI.bold}${ANSI.blue}$&${ANSI.reset}`);
}

function colorize(prefix: string, value: string): string {
  return `${prefix}${value}${ANSI.reset}`;
}

function isSectionHeading(line: string): boolean {
  return (
    !line.includes(':') &&
    !line.startsWith('- ') &&
    !/^\d+\.\s/.test(line) &&
    !line.startsWith('   ') &&
    /^[A-Za-z][A-Za-z0-9/() -]+$/.test(line)
  );
}
