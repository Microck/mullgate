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
  it('matches the simplified setup/proxy/config surface', { timeout: 15000 }, async () => {
    const [
      topLevelHelp,
      setupHelp,
      proxyHelp,
      proxyStartHelp,
      proxyStatusHelp,
      proxyDoctorHelp,
      proxyAccessHelp,
      proxyExportHelp,
      proxyRelayHelp,
      proxyRelayRecommendHelp,
      proxyAutostartHelp,
      proxyValidateHelp,
      configHelp,
    ] = await Promise.all([
      expectHelpOutput(['--help']),
      expectHelpOutput(['setup', '--help']),
      expectHelpOutput(['proxy', '--help']),
      expectHelpOutput(['proxy', 'start', '--help']),
      expectHelpOutput(['proxy', 'status', '--help']),
      expectHelpOutput(['proxy', 'doctor', '--help']),
      expectHelpOutput(['proxy', 'access', '--help']),
      expectHelpOutput(['proxy', 'export', '--help']),
      expectHelpOutput(['proxy', 'relay', '--help']),
      expectHelpOutput(['proxy', 'relay', 'recommend', '--help']),
      expectHelpOutput(['proxy', 'autostart', '--help']),
      expectHelpOutput(['proxy', 'validate', '--help']),
      expectHelpOutput(['config', '--help']),
    ]);

    expect(`\n${topLevelHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate [options] [command]

      Minimal Mullvad proxy CLI for setup, daily proxy operations, and advanced config

      Options:
        -h, --help       display help for command

      Commands:
        setup [options]  Run the guided Mullvad-backed setup flow and persist config
                         plus derived runtime artifacts.
        proxy            Operate runtime, access, export, relay, and startup surfaces
                         for routed proxies.
        config           Inspect saved config values, raw paths, and advanced config
                         fields.
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
    expect(`\n${proxyHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy [options] [command]

      Operate runtime, access, export, relay, and startup surfaces for routed proxies.

      Options:
        -h, --help          display help for command

      Commands:
        start               Re-render derived runtime artifacts from saved config,
                            validate them, and launch the Docker runtime bundle.
        status              Inspect saved Mullgate state, runtime artifacts, and live
                            Docker Compose status in one report.
        doctor              Run deterministic, route-aware diagnostics for config,
                            runtime, bind, DNS, and last-start failures.
        validate [options]  Validate the saved or freshly rendered shared runtime
                            artifacts and persist the result metadata.
        list                List configured routed proxies, hostnames, bind IPs, and
                            runtime ids.
        export [options]    Export proxy URLs to a text file with ordered country or
                            region batches plus optional city, server, provider,
                            ownership, run-mode, and port-speed filters.
        autostart           Manage Linux login-time Mullgate startup with a systemd
                            user service.
        access [options]    Inspect or update published route hostnames, bind IPs,
                            direct-IP entrypoints, and DNS guidance.
        relay               Inspect relays, recommend exact exits, and verify
                            configured route exits.
        help [command]      display help for command

      Quick commands:
        mullgate proxy access
        mullgate proxy start
        mullgate proxy status
        mullgate proxy doctor
        mullgate proxy export --regions

      Advanced commands:
        mullgate proxy relay list
        mullgate proxy relay probe
        mullgate proxy relay recommend
        mullgate proxy autostart status
        mullgate config show"
    `);
    expect(`\n${proxyStartHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy start [options]

      Re-render derived runtime artifacts from saved config, validate them, and launch
      the Docker runtime bundle.

      Options:
        -h, --help  display help for command"
    `);
    expect(`\n${proxyStatusHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy status [options]

      Inspect saved Mullgate state, runtime artifacts, and live Docker Compose status
      in one report.

      Options:
        -h, --help  display help for command"
    `);
    expect(`\n${proxyDoctorHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy doctor [options]

      Run deterministic, route-aware diagnostics for config, runtime, bind, DNS, and
      last-start failures.

      Options:
        -h, --help  display help for command"
    `);
    expect(`\n${proxyAccessHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy access [options]

      Inspect or update published route hostnames, bind IPs, direct-IP entrypoints,
      and DNS guidance.

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
    expect(`\n${proxyExportHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy export [options]

      Export proxy URLs to a text file with ordered country or region batches plus
      optional city, server, provider, ownership, run-mode, and port-speed filters.

      Options:
        --protocol <protocol>     Export proxy URLs for socks5, http, or https.
        --country <code-or-name>  Add a country selector. Pair it with optional
                                  --city, --server, --provider, and a following
                                  --count.
        --region <name>           Add a curated region selector (americas,
                                  asia-pacific, europe, middle-east-africa). Pair it
                                  with optional --provider and a following --count.
        --city <code-or-name>     Refine the immediately preceding --country selector
                                  to one city.
        --server <hostname>       Refine the immediately preceding --country selector
                                  to one exact Mullvad relay hostname.
        --provider <name>         Filter the immediately preceding --country or
                                  --region selector by provider. Repeat as needed.
        --owner <owner>           Filter the immediately preceding selector by relay
                                  ownership: mullvad, rented, or all.
        --run-mode <mode>         Filter the immediately preceding selector by relay
                                  run mode: ram, disk, or all.
        --min-port-speed <mbps>   Filter the immediately preceding selector by minimum
                                  advertised port speed in Mbps.
        --count <number>          Apply a per-selector export cap to the immediately
                                  preceding --country or --region batch.
        --guided                  Launch a guided flow for creating proxy lists.
        --regions                 Print the curated export region groups and exit
                                  without exporting.
        --dry-run                 Preview the export without writing a file.
        --stdout                  Write the exported proxy URLs to stdout instead of a
                                  file.
        --force                   Overwrite an existing output file.
        --output <path>           Write the export to this path instead of using an
                                  auto filename.
        -h, --help                display help for command"
    `);
    expect(`\n${proxyRelayHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy relay [options] [command]

      Inspect relays, recommend exact exits, and verify configured route exits.

      Options:
        -h, --help           display help for command

      Commands:
        list [options]       List matching Mullvad relays with location, provider,
                             ownership, run mode, and port speed details.
        probe [options]      Ping matching Mullvad relays and rank them by latency.
        verify [options]     Verify one configured route exits through Mullvad for
                             each published proxy protocol.
        recommend [options]  Probe matching Mullvad relays, recommend exact exits for
                             ordered selector batches, and optionally apply them.
        help [command]       display help for command"
    `);
    expect(`\n${proxyRelayRecommendHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy relay recommend [options]

      Probe matching Mullvad relays, recommend exact exits for ordered selector
      batches, and optionally apply them.

      Options:
        --country <code-or-name>  Add a country selector. Pair it with optional
                                  filters and a following --count.
        --region <name>           Add a curated region selector (americas,
                                  asia-pacific, europe, middle-east-africa). Pair it
                                  with optional filters and a following --count.
        --city <code-or-name>     Refine the immediately preceding --country selector
                                  by city.
        --server <hostname>       Pin the immediately preceding --country selector to
                                  one exact relay hostname.
        --provider <name>         Filter the immediately preceding selector by
                                  provider. Repeat as needed.
        --owner <owner>           Filter the immediately preceding selector by relay
                                  ownership: mullvad, rented, or all.
        --run-mode <mode>         Filter the immediately preceding selector by relay
                                  run mode: ram, disk, or all.
        --min-port-speed <mbps>   Filter the immediately preceding selector by minimum
                                  advertised port speed in Mbps.
        --count <number>          Apply a per-selector recommendation count to the
                                  immediately preceding selector batch.
        --apply                   Materialize the exact recommended relays into saved
                                  config and refreshed runtime artifacts.
        -h, --help                display help for command"
    `);
    expect(`\n${proxyAutostartHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy autostart [options] [command]

      Manage Linux login-time Mullgate startup with a systemd user service.

      Options:
        -h, --help      display help for command

      Commands:
        enable          Install and start the Mullgate systemd user service.
        disable         Stop and remove the Mullgate systemd user service.
        status          Inspect the Mullgate systemd user service state.
        help [command]  display help for command"
    `);
    expect(`\n${proxyValidateHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate proxy validate [options]

      Validate the saved or freshly rendered shared runtime artifacts and persist the
      result metadata.

      Options:
        --refresh   Re-render derived artifacts from saved config and relay cache
                    before validating.
        -h, --help  display help for command"
    `);
    expect(`\n${configHelp}`).toMatchInlineSnapshot(`
      "
      Usage: mullgate config [options] [command]

      Inspect saved config values, raw paths, and advanced config fields.

      Options:
        -h, --help                       display help for command

      Commands:
        path                             Show the resolved Mullgate config, state,
                                         cache, and runtime paths.
        show                             Show the saved Mullgate config as JSON.
        get <keyPath>                    Read one saved config value.
        set [options] <keyPath> [value]  Update a saved config value without editing
                                         JSON by hand.
        help [command]                   display help for command"
    `);
  });
});
