import { spawn } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

type CliResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCliPath = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

async function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, 'src/cli.ts', ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'pipe',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        status: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function expectHelpOutput(args: readonly string[]): Promise<string> {
  const result = await runCli(args);

  expect({
    args: [...args],
    status: result.status,
    stderr: result.stderr,
  }).toEqual({
    args: [...args],
    status: 0,
    stderr: '',
  });

  return result.stdout.trimEnd();
}

describe('mullgate help command contract', () => {
  it('matches the Linux-first operator docs surface', async () => {
    const [
      topLevelHelp,
      setupHelp,
      startHelp,
      statusHelp,
      doctorHelp,
      configHelp,
      configHostsHelp,
      configExposureHelp,
      configValidateHelp,
    ] = await Promise.all([
      expectHelpOutput(['--help']),
      expectHelpOutput(['setup', '--help']),
      expectHelpOutput(['start', '--help']),
      expectHelpOutput(['status', '--help']),
      expectHelpOutput(['doctor', '--help']),
      expectHelpOutput(['config', '--help']),
      expectHelpOutput(['config', 'hosts', '--help']),
      expectHelpOutput(['config', 'exposure', '--help']),
      expectHelpOutput(['config', 'validate', '--help']),
    ]);

    expect(`\n${topLevelHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate [options] [command]

      CLI-first Mullvad proxy provisioning and config management

      Options:
        -h, --help       display help for command

      Commands:
        setup [options]  Run the guided Mullvad-backed setup flow and persist config
                         plus derived runtime artifacts.
        start            Re-render derived runtime artifacts from saved config,
                         validate them, and launch the Docker runtime bundle.
        status           Inspect saved Mullgate state, runtime artifacts, and live
                         Docker Compose status in one report.
        doctor           Run deterministic, route-aware diagnostics for config,
                         runtime, bind, DNS, and last-start failures.
        config           Inspect or update saved Mullgate configuration and derived
                         paths.
        help [command]   display help for command"
    `);
    expect(`\n${setupHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate setup [options]

      Run the guided Mullvad-backed setup flow and persist config plus derived runtime
      artifacts.

      Options:
        --account-number <digits>   Override MULLGATE_ACCOUNT_NUMBER or prompt for the
                                    Mullvad account number.
        --bind-host <host>          Override MULLGATE_BIND_HOST or prompt for the bind
                                    host.
        --route-bind-ip <ip>        Append an explicit route bind IPv4 address. Repeat
                                    or comma-separate values for multiple routes.
                                    MULLGATE_ROUTE_BIND_IPS accepts a comma-separated
                                    ordered list. (default: [])
        --exposure-mode <mode>      Override MULLGATE_EXPOSURE_MODE with loopback,
                                    private-network, or public.
        --base-domain <domain>      Override MULLGATE_EXPOSURE_BASE_DOMAIN for derived
                                    route hostnames like route.example.com.
        --socks-port <port>         Override MULLGATE_SOCKS_PORT or prompt for the
                                    SOCKS5 port.
        --http-port <port>          Override MULLGATE_HTTP_PORT or prompt for the HTTP
                                    port.
        --https-port <port>         Override MULLGATE_HTTPS_PORT for optional HTTPS
                                    proxy support.
        --username <name>           Override MULLGATE_PROXY_USERNAME or prompt for the
                                    proxy username.
        --password <secret>         Override MULLGATE_PROXY_PASSWORD or prompt for the
                                    proxy password.
        --location <alias>          Append a routed Mullvad location alias. Repeat or
                                    comma-separate values for multiple routes.
                                    MULLGATE_LOCATION stays shorthand for route 1;
                                    MULLGATE_LOCATIONS accepts a comma-separated
                                    ordered list. (default: [])
        --https-cert-path <path>    Override MULLGATE_HTTPS_CERT_PATH for optional
                                    HTTPS certificate validation.
        --https-key-path <path>     Override MULLGATE_HTTPS_KEY_PATH for optional
                                    HTTPS key validation.
        --device-name <name>        Override MULLGATE_DEVICE_NAME for the Mullvad
                                    device label.
        --non-interactive           Fail instead of prompting when required setup
                                    values are missing.
        --mullvad-wg-url <url>      Override MULLGATE_MULLVAD_WG_URL for provisioning.
        --mullvad-relays-url <url>  Override MULLGATE_MULLVAD_RELAYS_URL for relay
                                    metadata.
        -h, --help                  display help for command"
    `);
    expect(`\n${startHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate start [options]

      Re-render derived runtime artifacts from saved config, validate them, and launch
      the Docker runtime bundle.

      Options:
        -h, --help  display help for command"
    `);
    expect(`\n${statusHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate status [options]

      Inspect saved Mullgate state, runtime artifacts, and live Docker Compose status
      in one report.

      Options:
        -h, --help  display help for command"
    `);
    expect(`\n${doctorHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate doctor [options]

      Run deterministic, route-aware diagnostics for config, runtime, bind, DNS, and
      last-start failures.

      Options:
        -h, --help  display help for command"
    `);
    expect(`\n${configHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate config [options] [command]

      Inspect or update saved Mullgate configuration and derived paths.

      Options:
        -h, --help                       display help for command

      Commands:
        path                             Show the resolved Mullgate
                                         config/state/cache/runtime paths.
        show                             Show the saved Mullgate config with secrets
                                         redacted.
        locations                        List routed location aliases, bind IPs, relay
                                         preferences, and runtime ids without secrets.
        hosts                            List configured proxy hostnames and their
                                         route bind IP mappings without secrets.
        exposure [options]               Inspect or update remote exposure mode, bind
                                         IPs, DNS guidance, and restart status without
                                         raw JSON edits.
        get <keyPath>                    Read one saved config value with secret-safe
                                         redaction.
        set [options] <keyPath> [value]  Update a saved config value without printing
                                         secrets back to the terminal.
        validate [options]               Validate the saved or freshly rendered
                                         wireproxy config and persist the result
                                         metadata.
        help [command]                   display help for command"
    `);
    expect(`\n${configHostsHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate config hosts [options]

      List configured proxy hostnames and their route bind IP mappings without
      secrets.

      Options:
        -h, --help  display help for command"
    `);
    expect(`\n${configExposureHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate config exposure [options]

      Inspect or update remote exposure mode, bind IPs, DNS guidance, and restart
      status without raw JSON edits.

      Options:
        --mode <mode>           Set exposure mode to loopback, private-network, or
                                public.
        --base-domain <domain>  Set the base domain used to derive per-route
                                hostnames.
        --clear-base-domain     Remove any configured base domain and fall back to
                                alias/direct-IP hostnames.
        --route-bind-ip <ip>    Set an ordered per-route bind IP. Repeat once per
                                route. (default: [])
        -h, --help              display help for command"
    `);
    expect(`\n${configValidateHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate config validate [options]

      Validate the saved or freshly rendered wireproxy config and persist the result
      metadata.

      Options:
        --refresh   Re-render derived artifacts from saved config and relay cache
                    before validating.
        -h, --help  display help for command"
    `);
  });
});
