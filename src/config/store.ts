import { chmod, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { resolveMullgatePaths, type MullgatePaths } from './paths.js';
import { mullgateConfigSchema, type MullgateConfig } from './schema.js';

export type LoadConfigResult =
  | {
      readonly ok: true;
      readonly phase: 'load-config';
      readonly source: 'empty';
      readonly paths: MullgatePaths;
      readonly config: null;
      readonly message: string;
    }
  | {
      readonly ok: true;
      readonly phase: 'load-config';
      readonly source: 'file';
      readonly paths: MullgatePaths;
      readonly config: MullgateConfig;
      readonly artifactPath: string;
    }
  | {
      readonly ok: false;
      readonly phase: 'read-config' | 'parse-config';
      readonly source: 'file';
      readonly paths: MullgatePaths;
      readonly artifactPath: string;
      readonly message: string;
    };

export type SaveConfigResult = {
  readonly ok: true;
  readonly phase: 'persist-config';
  readonly source: 'input';
  readonly paths: MullgatePaths;
  readonly artifactPath: string;
  readonly config: MullgateConfig;
};

export type PathReport = {
  readonly phase: 'resolve-paths';
  readonly source: 'xdg';
  readonly paths: MullgatePaths;
  readonly exists: {
    readonly configFile: boolean;
    readonly runtimeDir: boolean;
    readonly relayCacheFile: boolean;
  };
};

export class ConfigStore {
  readonly paths: MullgatePaths;

  constructor(paths: MullgatePaths = resolveMullgatePaths()) {
    this.paths = paths;
  }

  async load(): Promise<LoadConfigResult> {
    try {
      const raw = await readFile(this.paths.configFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const config = mullgateConfigSchema.parse(parsed);

      return {
        ok: true,
        phase: 'load-config',
        source: 'file',
        paths: this.paths,
        config,
        artifactPath: this.paths.configFile,
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          ok: true,
          phase: 'load-config',
          source: 'empty',
          paths: this.paths,
          config: null,
          message: `Mullgate is not configured yet. Run \`mullgate setup\` to create ${this.paths.configFile}.`,
        };
      }

      if (error instanceof SyntaxError) {
        return {
          ok: false,
          phase: 'parse-config',
          source: 'file',
          paths: this.paths,
          artifactPath: this.paths.configFile,
          message: `Config file is not valid JSON: ${error.message}`,
        };
      }

      if (error instanceof Error && error.name === 'ZodError') {
        return {
          ok: false,
          phase: 'parse-config',
          source: 'file',
          paths: this.paths,
          artifactPath: this.paths.configFile,
          message: 'Config file does not match the Mullgate schema.',
        };
      }

      return {
        ok: false,
        phase: 'read-config',
        source: 'file',
        paths: this.paths,
        artifactPath: this.paths.configFile,
        message: error instanceof Error ? error.message : 'Unknown error while reading config.',
      };
    }
  }

  async save(input: MullgateConfig): Promise<SaveConfigResult> {
    const config = mullgateConfigSchema.parse(input);

    await ensureDirectory(this.paths.appConfigDir);
    await ensureDirectory(this.paths.appStateDir);
    await ensureDirectory(this.paths.appCacheDir);
    await ensureDirectory(this.paths.runtimeDir);

    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    await writeFileAtomic(this.paths.configFile, serialized, 0o600);

    return {
      ok: true,
      phase: 'persist-config',
      source: 'input',
      paths: this.paths,
      artifactPath: this.paths.configFile,
      config,
    };
  }

  async inspectPaths(): Promise<PathReport> {
    return {
      phase: 'resolve-paths',
      source: 'xdg',
      paths: this.paths,
      exists: {
        configFile: await fileExists(this.paths.configFile),
        runtimeDir: await fileExists(this.paths.runtimeDir),
        relayCacheFile: await fileExists(this.paths.provisioningCacheFile),
      },
    };
  }
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
}

async function writeFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

  let fileHandle;
  try {
    fileHandle = await open(temporaryPath, 'w', mode);
    await fileHandle.writeFile(content, 'utf8');
    await fileHandle.sync();
  } finally {
    await fileHandle?.close();
  }

  try {
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
    await chmod(filePath, mode);

    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await readFile(targetPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    return true;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function listTemporaryArtifacts(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
    .map((entry) => entry.name)
    .sort();
}
