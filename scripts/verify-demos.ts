import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const checks = [
  {
    label: 'README setup demo reference',
    file: path.join(repoRoot, 'README.md'),
    includes: 'images/demos/setup-guided.gif',
  },
  {
    label: 'Quickstart demo reference',
    file: path.join(repoRoot, 'docs/mullgate-docs/content/docs/getting-started/quickstart.mdx'),
    includes: '/images/demos/setup-guided.gif',
  },
  {
    label: 'Usage exposure demo reference',
    file: path.join(repoRoot, 'docs/mullgate-docs/content/docs/guides/usage.mdx'),
    includes: '/images/demos/exposure-private-network.gif',
  },
  {
    label: 'Usage status/doctor demo reference',
    file: path.join(repoRoot, 'docs/mullgate-docs/content/docs/guides/usage.mdx'),
    includes: '/images/demos/status-doctor.gif',
  },
  {
    label: 'Usage relay recommendation demo reference',
    file: path.join(repoRoot, 'docs/mullgate-docs/content/docs/guides/usage.mdx'),
    includes: '/images/demos/relay-recommend.gif',
  },
  {
    label: 'Operations demos page reference',
    file: path.join(repoRoot, 'docs/mullgate-docs/content/docs/operations/demos.mdx'),
    includes: '/images/demos/status-doctor.gif',
  },
  {
    label: 'Operations relay recommendation demo reference',
    file: path.join(repoRoot, 'docs/mullgate-docs/content/docs/operations/demos.mdx'),
    includes: '/images/demos/relay-recommend.gif',
  },
] as const;

const assetChecks = [
  path.join(repoRoot, 'images/demos/setup-guided.gif'),
  path.join(repoRoot, 'images/demos/exposure-private-network.gif'),
  path.join(repoRoot, 'images/demos/status-doctor.gif'),
  path.join(repoRoot, 'images/demos/relay-recommend.gif'),
  path.join(repoRoot, 'docs/mullgate-docs/public/images/demos/setup-guided.gif'),
  path.join(repoRoot, 'docs/mullgate-docs/public/images/demos/exposure-private-network.gif'),
  path.join(repoRoot, 'docs/mullgate-docs/public/images/demos/status-doctor.gif'),
  path.join(repoRoot, 'docs/mullgate-docs/public/images/demos/relay-recommend.gif'),
] as const;

function main(): void {
  for (const check of checks) {
    const text = fs.readFileSync(check.file, 'utf8');
    if (text.includes(check.includes)) {
      continue;
    }

    throw new Error(`${check.label} is missing ${check.includes}.`);
  }

  for (const assetPath of assetChecks) {
    if (fs.existsSync(assetPath)) {
      continue;
    }

    throw new Error(`Missing demo asset: ${assetPath}`);
  }

  process.stdout.write('Demo references and assets verified.\n');
}

main();
