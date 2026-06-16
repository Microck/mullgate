import type { ProxyExportPlanSuccess, ProxyExportWriteMode } from './proxy-export-plan.js';
import { renderProxyExportSelectorLabel } from './proxy-export-relays.js';
import type { ProxyExportFailure } from './proxy-export-selectors.js';

export function renderProxyExportSuccess(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly configPath: string;
  readonly outputPath: string;
}): string {
  return [
    'Mullgate proxy export complete.',
    ...renderProxyExportSummaryLines({
      result: input.result,
      configPath: input.configPath,
      writeMode: 'file',
    }),
    `output: ${input.outputPath}`,
  ].join('\n');
}

export function renderProxyExportPreview(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly configPath: string;
  readonly outputPath: string;
}): string {
  return [
    'Mullgate proxy export preview.',
    ...renderProxyExportSummaryLines({
      result: input.result,
      configPath: input.configPath,
      writeMode: 'dry-run',
    }),
    `output: ${input.outputPath}`,
    '',
    'preview',
    ...input.result.entries.map(
      (entry, index) =>
        `${index + 1}. ${entry.url} (alias: ${entry.alias}, country: ${entry.countryCode ?? 'n/a'}, city: ${entry.cityCode ?? 'n/a'}, relay: ${entry.relayHostname ?? 'n/a'})`,
    ),
  ].join('\n');
}

export function renderProxyExportError(result: ProxyExportFailure): string {
  return [
    'Mullgate proxy export failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    ...(result.configPath ? [`config: ${result.configPath}`] : []),
    ...(result.artifactPath ? [`artifact: ${result.artifactPath}`] : []),
    `reason: ${result.message}`,
    ...(result.cause ? [`cause: ${result.cause}`] : []),
  ].join('\n');
}

export function renderProxyExportStdoutNotice(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly configPath: string;
}): string {
  return [
    'Mullgate proxy export complete.',
    ...renderProxyExportSummaryLines({
      result: input.result,
      configPath: input.configPath,
      writeMode: 'stdout',
    }),
    'output: stdout',
  ].join('\n');
}

function renderProxyExportSummaryLines(input: {
  readonly result: ProxyExportPlanSuccess;
  readonly configPath: string;
  readonly writeMode: ProxyExportWriteMode;
}): string[] {
  return [
    'phase: export-proxies',
    'source: canonical-config',
    `config: ${input.configPath}`,
    `protocol: ${input.result.protocol}`,
    `write mode: ${input.writeMode}`,
    ...(input.result.selectors.length === 0
      ? ['selection: all configured routes']
      : [
          `selectors: ${input.result.selectors.length}`,
          ...input.result.selectors.map(
            (selector, index) =>
              `${index + 1}. ${renderProxyExportSelectorLabel(selector)} requested=${selector.requestedCount ?? 'default'} matched=${selector.matchedCount} exported=${selector.exportedCount}`,
          ),
        ]),
    `exported count: ${input.result.entries.length}`,
  ];
}
