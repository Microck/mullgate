import { describe, expect, it } from 'vitest';

import { renderCliReport, writeCliRaw, writeCliReport } from '../src/cli-output.js';

function visibleAnsi(text: string): string {
  return text
    .replaceAll('\u001B[0m', '<RESET>')
    .replaceAll('\u001B[1m', '<BOLD>')
    .replaceAll('\u001B[2m', '<DIM>')
    .replaceAll('\u001B[31m', '<RED>')
    .replaceAll('\u001B[32m', '<GREEN>')
    .replaceAll('\u001B[33m', '<YELLOW>')
    .replaceAll('\u001B[34m', '<BLUE>')
    .replaceAll('\u001B[36m', '<CYAN>')
    .replaceAll('\u001B[37m', '<WHITE>');
}

function createSink(isTTY = false): {
  readonly chunks: string[];
  readonly sink: {
    readonly isTTY: boolean;
    write(chunk: string): void;
  };
} {
  const chunks: string[] = [];

  return {
    chunks,
    sink: {
      isTTY,
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
  };
}

describe('cli output helpers', () => {
  it('writes reports with a trailing newline', () => {
    const { chunks, sink } = createSink(false);

    writeCliReport({
      sink,
      text: 'status: ready',
    });

    expect(chunks).toEqual(['status: ready\n']);
  });

  it('writes raw output without modification', () => {
    const { chunks, sink } = createSink(false);

    writeCliRaw({
      sink,
      text: 'raw-output',
    });

    expect(chunks).toEqual(['raw-output']);
  });

  it('returns plain text when the sink is not a tty', () => {
    expect(
      renderCliReport(
        ['Title', '', 'Section', 'Label: value', '- bullet', '1. step', 'plain `code`'].join('\n'),
        { isTTY: false },
      ),
    ).toBe(
      ['Title', '', 'Section', 'Label: value', '- bullet', '1. step', 'plain `code`'].join('\n'),
    );
  });

  it('applies the requested title tone when rendering for a tty', () => {
    expect(visibleAnsi(renderCliReport('Info title', { isTTY: true }, 'info'))).toBe(
      '<BOLD><CYAN>Info title<RESET>',
    );
    expect(visibleAnsi(renderCliReport('Success title', { isTTY: true }, 'success'))).toBe(
      '<BOLD><GREEN>Success title<RESET>',
    );
    expect(visibleAnsi(renderCliReport('Error title', { isTTY: true }, 'error'))).toBe(
      '<BOLD><RED>Error title<RESET>',
    );
  });

  it('styles headings, labels, bullets, numbering, blank lines, and inline code', () => {
    const report = renderCliReport(
      [
        'Proxy Status',
        '',
        'Connection Details',
        '  Bind Host: 127.0.0.1',
        '- route `se-got`',
        '2. run `mullgate proxy status`',
        'plain `code`',
      ].join('\n'),
      { isTTY: true },
      'success',
    );

    expect(visibleAnsi(report)).toMatchInlineSnapshot(`
      "<BOLD><GREEN>Proxy Status<RESET>

      <BOLD><YELLOW>Connection Details<RESET>
        <DIM><WHITE>Bind Host:<RESET> 127.0.0.1
      <YELLOW>-<RESET> route \`se-got\`
      <CYAN>2.<RESET> run \`mullgate proxy status\`
      plain <BOLD><BLUE>\`code\`<RESET>"
    `);
  });
});
