#!/usr/bin/env tsx

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type DemoRouteEntry = {
  readonly alias: string;
  readonly countryName: string;
  readonly cityName: string;
};

type OutputFormat = 'grid' | 'list' | 'json' | 'csv';

type CliOptions = {
  readonly count: number;
  readonly format: OutputFormat;
  readonly outputPath?: string;
};

// Frozen demo route pool so the recording stays stable instead of drifting with live relay churn.
export const demoRoutePool: readonly DemoRouteEntry[] = [
  { alias: 'albania-tirana', countryName: 'Albania', cityName: 'Tirana' },
  { alias: 'argentina-buenos-aires', countryName: 'Argentina', cityName: 'Buenos Aires' },
  { alias: 'austria-vienna', countryName: 'Austria', cityName: 'Vienna' },
  { alias: 'australia-adelaide', countryName: 'Australia', cityName: 'Adelaide' },
  { alias: 'australia-brisbane', countryName: 'Australia', cityName: 'Brisbane' },
  { alias: 'australia-melbourne', countryName: 'Australia', cityName: 'Melbourne' },
  { alias: 'australia-perth', countryName: 'Australia', cityName: 'Perth' },
  { alias: 'australia-sydney', countryName: 'Australia', cityName: 'Sydney' },
  { alias: 'belgium-brussels', countryName: 'Belgium', cityName: 'Brussels' },
  { alias: 'bulgaria-sofia', countryName: 'Bulgaria', cityName: 'Sofia' },
  { alias: 'brazil-fortaleza', countryName: 'Brazil', cityName: 'Fortaleza' },
  { alias: 'brazil-sao-paulo', countryName: 'Brazil', cityName: 'Sao Paulo' },
  { alias: 'canada-montreal', countryName: 'Canada', cityName: 'Montreal' },
  { alias: 'canada-toronto', countryName: 'Canada', cityName: 'Toronto' },
  { alias: 'canada-vancouver', countryName: 'Canada', cityName: 'Vancouver' },
  { alias: 'canada-calgary', countryName: 'Canada', cityName: 'Calgary' },
  { alias: 'switzerland-zurich', countryName: 'Switzerland', cityName: 'Zurich' },
  { alias: 'chile-santiago', countryName: 'Chile', cityName: 'Santiago' },
  { alias: 'colombia-bogota', countryName: 'Colombia', cityName: 'Bogota' },
  { alias: 'cyprus-nicosia', countryName: 'Cyprus', cityName: 'Nicosia' },
  { alias: 'czech-republic-prague', countryName: 'Czech Republic', cityName: 'Prague' },
  { alias: 'germany-berlin', countryName: 'Germany', cityName: 'Berlin' },
  { alias: 'germany-dusseldorf', countryName: 'Germany', cityName: 'Dusseldorf' },
  { alias: 'germany-frankfurt', countryName: 'Germany', cityName: 'Frankfurt' },
  { alias: 'denmark-copenhagen', countryName: 'Denmark', cityName: 'Copenhagen' },
  { alias: 'estonia-tallinn', countryName: 'Estonia', cityName: 'Tallinn' },
  { alias: 'spain-barcelona', countryName: 'Spain', cityName: 'Barcelona' },
  { alias: 'spain-madrid', countryName: 'Spain', cityName: 'Madrid' },
  { alias: 'spain-valencia', countryName: 'Spain', cityName: 'Valencia' },
  { alias: 'finland-helsinki', countryName: 'Finland', cityName: 'Helsinki' },
  { alias: 'france-bordeaux', countryName: 'France', cityName: 'Bordeaux' },
  { alias: 'france-marseille', countryName: 'France', cityName: 'Marseille' },
  { alias: 'france-paris', countryName: 'France', cityName: 'Paris' },
  { alias: 'uk-glasgow', countryName: 'Uk', cityName: 'Glasgow' },
  { alias: 'uk-london', countryName: 'Uk', cityName: 'London' },
  { alias: 'uk-manchester', countryName: 'Uk', cityName: 'Manchester' },
  { alias: 'greece-athens', countryName: 'Greece', cityName: 'Athens' },
  { alias: 'hong-kong-hong-kong', countryName: 'Hong Kong', cityName: 'Hong Kong' },
  { alias: 'croatia-zagreb', countryName: 'Croatia', cityName: 'Zagreb' },
  { alias: 'hungary-budapest', countryName: 'Hungary', cityName: 'Budapest' },
  { alias: 'indonesia-jakarta', countryName: 'Indonesia', cityName: 'Jakarta' },
  { alias: 'ireland-dublin', countryName: 'Ireland', cityName: 'Dublin' },
  { alias: 'israel-tel-aviv', countryName: 'Israel', cityName: 'Tel Aviv' },
  { alias: 'italy-milan', countryName: 'Italy', cityName: 'Milan' },
  { alias: 'italy-palermo', countryName: 'Italy', cityName: 'Palermo' },
  { alias: 'japan-osaka', countryName: 'Japan', cityName: 'Osaka' },
  { alias: 'japan-tokyo', countryName: 'Japan', cityName: 'Tokyo' },
  { alias: 'mexico-queretaro', countryName: 'Mexico', cityName: 'Queretaro' },
  { alias: 'malaysia-kuala-lumpur', countryName: 'Malaysia', cityName: 'Kuala Lumpur' },
  { alias: 'nigeria-lagos', countryName: 'Nigeria', cityName: 'Lagos' },
  { alias: 'netherlands-amsterdam', countryName: 'Netherlands', cityName: 'Amsterdam' },
  { alias: 'norway-oslo', countryName: 'Norway', cityName: 'Oslo' },
  { alias: 'norway-stavanger', countryName: 'Norway', cityName: 'Stavanger' },
  { alias: 'new-zealand-auckland', countryName: 'New Zealand', cityName: 'Auckland' },
  { alias: 'peru-lima', countryName: 'Peru', cityName: 'Lima' },
  { alias: 'philippines-manila', countryName: 'Philippines', cityName: 'Manila' },
  { alias: 'poland-warsaw', countryName: 'Poland', cityName: 'Warsaw' },
  { alias: 'portugal-lisbon', countryName: 'Portugal', cityName: 'Lisbon' },
  { alias: 'romania-bucharest', countryName: 'Romania', cityName: 'Bucharest' },
  { alias: 'serbia-belgrade', countryName: 'Serbia', cityName: 'Belgrade' },
] as const;

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const selectedRoutes = demoRoutePool.slice(0, options.count);
  const rendered = renderRoutePool({
    routes: selectedRoutes,
    format: options.format,
  });

  if (!options.outputPath) {
    process.stdout.write(rendered);
    if (!rendered.endsWith('\n')) {
      process.stdout.write('\n');
    }
    return;
  }

  const outputPath = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${rendered}\n`, 'utf8');
  process.stdout.write(
    `Generated ${selectedRoutes.length} demo routes at ${outputPath} using ${options.format} output.\n`,
  );
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let count = 50;
  let format: OutputFormat = 'grid';
  let outputPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--count') {
      const rawCount = requireValue({
        argv,
        index,
        flag: '--count',
      });
      const parsedCount = Number.parseInt(rawCount, 10);

      if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > demoRoutePool.length) {
        throw new Error(`--count must be an integer between 1 and ${demoRoutePool.length}.`);
      }

      count = parsedCount;
      index += 1;
      continue;
    }

    if (current === '--format') {
      const rawFormat = requireValue({
        argv,
        index,
        flag: '--format',
      });

      if (
        rawFormat !== 'grid' &&
        rawFormat !== 'list' &&
        rawFormat !== 'json' &&
        rawFormat !== 'csv'
      ) {
        throw new Error('--format must be one of: grid, list, json, csv.');
      }

      format = rawFormat;
      index += 1;
      continue;
    }

    if (current === '--output') {
      outputPath = requireValue({
        argv,
        index,
        flag: '--output',
      });
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return {
    count,
    format,
    ...(outputPath ? { outputPath } : {}),
  };
}

function requireValue(input: {
  readonly argv: readonly string[];
  readonly index: number;
  readonly flag: string;
}): string {
  const value = input.argv[input.index + 1];

  if (!value) {
    throw new Error(`${input.flag} requires a value.`);
  }

  return value;
}

function renderRoutePool(input: {
  readonly routes: readonly DemoRouteEntry[];
  readonly format: OutputFormat;
}): string {
  if (input.format === 'json') {
    return JSON.stringify(
      input.routes.map((route) => route.alias),
      null,
      2,
    );
  }

  if (input.format === 'csv') {
    return input.routes.map((route) => route.alias).join(',');
  }

  if (input.format === 'list') {
    return input.routes
      .map((route, index) => `${String(index + 1).padStart(2, '0')}. ${route.alias}`)
      .join('\n');
  }

  return renderRouteGrid(input.routes.map((route) => route.alias));
}

function renderRouteGrid(routes: readonly string[]): string {
  const midpoint = Math.ceil(routes.length / 2);
  const leftColumn = routes.slice(0, midpoint);
  const rightColumn = routes.slice(midpoint);
  const leftWidth = Math.max(
    ...leftColumn.map((route, index) => formatRouteLine(index, route).length),
  );

  return [
    `Mullgate demo route pool (${routes.length} routes)`,
    '',
    ...leftColumn.map((route, index) => {
      const left = formatRouteLine(index, route).padEnd(leftWidth + 4, ' ');
      const right = rightColumn[index];

      if (!right) {
        return left.trimEnd();
      }

      return `${left}${formatRouteLine(index + midpoint, right)}`;
    }),
  ].join('\n');
}

function formatRouteLine(index: number, route: string): string {
  return `${String(index + 1).padStart(2, '0')}. ${route}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
