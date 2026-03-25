import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type DockerValidationStage = {
  readonly hostDirPath: string;
  readonly hostFilePath: string;
  cleanup: () => void;
};

export function createDockerValidationStage(input: {
  readonly prefix: string;
  readonly fileName: string;
  readonly content: string;
  readonly fileMode: number;
}): DockerValidationStage {
  const hostDirPath = mkdtempSync(path.join(tmpdir(), input.prefix));
  const hostFilePath = path.join(hostDirPath, input.fileName);

  // Containerized validators do not reliably run as the current host uid, so stage
  // disposable copies under a traverse-only temp dir instead of loosening the
  // canonical runtime artifact permissions.
  chmodSync(hostDirPath, 0o711);
  writeFileSync(hostFilePath, input.content, { encoding: 'utf8', mode: input.fileMode });
  chmodSync(hostFilePath, input.fileMode);

  return {
    hostDirPath,
    hostFilePath,
    cleanup: () => {
      rmSync(hostDirPath, { recursive: true, force: true });
    },
  };
}
