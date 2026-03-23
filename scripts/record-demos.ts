import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { getRepoRoot, syncDemoAsset } from './demo-helpers.js';

type DemoDefinition = {
  readonly name: string;
  readonly runnerPath: string;
  readonly assetPath: string;
};

const repoRoot = getRepoRoot();
const tsxCliPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const castDir = path.join(repoRoot, '.tmp', 'demo-casts');
const imageDir = path.join(repoRoot, 'images', 'demos');
const docsImageDir = path.join(repoRoot, 'docs', 'mullgate-docs', 'public', 'images', 'demos');
const demos: readonly DemoDefinition[] = [
  {
    name: 'setup-guided',
    runnerPath: path.join(repoRoot, 'scripts', 'demo-setup-guided.ts'),
    assetPath: path.join(imageDir, 'setup-guided.gif'),
  },
  {
    name: 'exposure-private-network',
    runnerPath: path.join(repoRoot, 'scripts', 'demo-exposure-private-network.ts'),
    assetPath: path.join(imageDir, 'exposure-private-network.gif'),
  },
  {
    name: 'status-doctor',
    runnerPath: path.join(repoRoot, 'scripts', 'demo-status-doctor.ts'),
    assetPath: path.join(imageDir, 'status-doctor.gif'),
  },
] as const;

async function main(): Promise<void> {
  await mkdir(castDir, { recursive: true });
  await mkdir(imageDir, { recursive: true });
  await mkdir(docsImageDir, { recursive: true });

  for (const demo of demos) {
    const castPath = path.join(castDir, `${demo.name}.cast`);
    await runCommand({
      command: 'asciinema',
      args: [
        'rec',
        '-q',
        '--overwrite',
        '-i',
        '0.2',
        '--cols',
        '92',
        '--rows',
        '22',
        '-c',
        `${process.execPath} ${tsxCliPath} ${demo.runnerPath}`,
        castPath,
      ],
    });

    await runCommand({
      command: 'agg',
      args: [
        '--theme',
        'asciinema',
        '--font-size',
        '14',
        '--idle-time-limit',
        '2',
        '--last-frame-duration',
        '4',
        castPath,
        demo.assetPath,
      ],
    });

    await syncDemoAsset({
      sourcePath: demo.assetPath,
      destinationPath: path.join(docsImageDir, path.basename(demo.assetPath)),
    });
  }
}

async function runCommand(options: {
  readonly command: string;
  readonly args: readonly string[];
}): Promise<void> {
  const { spawn } = await import('node:child_process');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${options.command} exited with code ${code ?? 1}.`));
    });
  });
}

await main();
