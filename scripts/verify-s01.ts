#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { requireArrayValue, requireDefined } from '../src/required.js';

const repoRoot = process.cwd();
const fixturesDir = path.join(repoRoot, 'test/fixtures/mullvad');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'mullgate-verify-s01-'));
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    MULLGATE_ACCOUNT_NUMBER: '123456789012',
    MULLGATE_PROXY_USERNAME: 'alice',
    MULLGATE_PROXY_PASSWORD: 'verify-secret',
    MULLGATE_LOCATION: 'sweden-gothenburg',
  } satisfies NodeJS.ProcessEnv;

  try {
    await createFakeWireproxyBinary(env);

    const provisionFixture = await readTextFixture('wg-provision-response.txt');
    const relayFixture = await readJsonFixture<unknown>('app-relays.json');

    await withJsonServer(
      {
        '/wg': (request) => {
          const payload = request.body as { pubkey: string; name?: string };
          return {
            body: JSON.stringify({
              ...JSON.parse(provisionFixture),
              pubkey: payload.pubkey,
              name: payload.name ?? 'mullgate-verify-host',
            }),
          };
        },
        '/relays': () => ({ body: JSON.stringify(relayFixture) }),
      },
      async (baseUrl) => {
        const setupResult = await runCli(
          [
            'setup',
            '--non-interactive',
            '--mullvad-wg-url',
            new URL('/wg', baseUrl).toString(),
            '--mullvad-relays-url',
            new URL('/relays', baseUrl).toString(),
          ],
          { env },
        );

        assert(setupResult.status === 0, `setup failed:\n${setupResult.stderr}`);
        assert(
          setupResult.stdout.includes('Mullgate setup completed.'),
          'setup output did not report success',
        );

        const showResult = await runCli(['config', 'show'], { env });
        assert(showResult.status === 0, `config show failed:\n${showResult.stderr}`);
        assert(
          !showResult.stdout.includes('123456789012'),
          'config show leaked the Mullvad account number',
        );
        assert(
          !showResult.stdout.includes('verify-secret'),
          'config show leaked the proxy password',
        );
        assert(showResult.stdout.includes('[redacted]'), 'config show did not redact secrets');

        const getResult = await runCli(['config', 'get', 'setup.location.requested'], { env });
        assert(getResult.status === 0, `config get failed:\n${getResult.stderr}`);
        assert(
          getResult.stdout.trim() === 'sweden-gothenburg',
          'config get returned the wrong location',
        );

        const setPasswordResult = await runCli(
          ['config', 'set', 'setup.auth.password', '--stdin'],
          {
            env,
            input: 'rotated-verify-secret\n',
          },
        );
        assert(
          setPasswordResult.status === 0,
          `config set password failed:\n${setPasswordResult.stderr}`,
        );
        assert(
          !setPasswordResult.stdout.includes('rotated-verify-secret'),
          'config set echoed a secret value',
        );

        const setPortResult = await runCli(['config', 'set', 'setup.bind.httpPort', '9091'], {
          env,
        });
        assert(setPortResult.status === 0, `config set port failed:\n${setPortResult.stderr}`);

        const validateRefreshResult = await runCli(['config', 'validate'], { env });
        assert(
          validateRefreshResult.status === 0,
          `config validate failed:\n${validateRefreshResult.stderr}`,
        );
        assert(
          validateRefreshResult.stdout.includes('artifacts refreshed: yes'),
          'config validate did not refresh stale artifacts',
        );

        const wireproxyPath = path.join(
          requireDefined(env.XDG_STATE_HOME, 'Expected XDG_STATE_HOME in the verification env.'),
          'mullgate/runtime/wireproxy.conf',
        );
        const renderedWireproxy = await readFile(wireproxyPath, 'utf8');
        assert(
          renderedWireproxy.includes('BindAddress = 0.0.0.0:9091'),
          'wireproxy config did not pick up the updated HTTP port',
        );
        assert(
          renderedWireproxy.includes('Password = rotated-verify-secret'),
          'wireproxy config did not pick up the rotated password',
        );

        await writeFile(wireproxyPath, '[Interface]\nPrivateKey = broken\n', 'utf8');
        const validateFailureResult = await runCli(['config', 'validate'], { env });
        assert(
          validateFailureResult.status === 1,
          'corrupted wireproxy config unexpectedly validated',
        );
        assert(
          validateFailureResult.stderr.includes('phase: validation'),
          'failure output did not report the validation phase',
        );
        assert(
          validateFailureResult.stderr.includes('source: wireproxy-binary'),
          'failure output did not report the validator source',
        );
        assert(
          !validateFailureResult.stderr.includes('rotated-verify-secret'),
          'failure output leaked the rotated password',
        );
      },
    );

    process.stdout.write('S01 verification passed.\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readJsonFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixturesDir, name), 'utf8')) as T;
}

async function readTextFixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

async function createFakeWireproxyBinary(env: NodeJS.ProcessEnv): Promise<void> {
  const binDir = requireArrayValue(
    requireDefined(env.PATH, 'Expected PATH in the verification env.').split(path.delimiter),
    0,
    'Expected a writable bin directory at the front of PATH.',
  );
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, 'wireproxy'),
    [
      '#!/bin/sh',
      'if [ "$1" != "--configtest" ]; then',
      '  echo "unsupported fake wireproxy invocation" >&2',
      '  exit 1',
      'fi',
      'config="$2"',
      'if grep -q "^Address = " "$config" && grep -q "^\\[Peer\\]" "$config" && grep -q "^\\[Socks5\\]" "$config" && grep -q "^\\[http\\]" "$config"; then',
      '  exit 0',
      'fi',
      'echo "fake wireproxy configtest: invalid rendered config at $config" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(path.join(binDir, 'wireproxy'), 0o755);
}

async function withJsonServer(
  routes: Record<
    string,
    (request: { body: unknown }) => { status?: number; body: string; contentType?: string }
  >,
  run: (baseUrl: URL) => Promise<void>,
): Promise<void> {
  const server = createServer(async (request, response) => {
    const rawBody = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });

    const route = routes[request.url ?? '/'];
    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"detail":"not found"}');
      return;
    }

    const routeResult = route({ body: rawBody.length > 0 ? tryParseJson(rawBody) : null });
    response.writeHead(routeResult.status ?? 200, {
      'content-type': routeResult.contentType ?? 'application/json',
    });
    response.end(routeResult.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();

  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind local verification server.');
  }

  try {
    await run(new URL(`http://127.0.0.1:${address.port}`));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function runCli(
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: string },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, 'src/cli.ts', ...args], {
      cwd: repoRoot,
      env: options.env,
      stdio: 'pipe',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        status: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
