import type { Command } from 'commander';

import { ConfigStore } from '../config/store.js';
import { runSetupFlow, type RawSetupInputValues, type RunSetupFlowOptions, type SetupFlowResult } from '../app/setup-runner.js';

const ACCOUNT_NUMBER_ENV = 'MULLGATE_ACCOUNT_NUMBER';
const PROXY_PASSWORD_ENV = 'MULLGATE_PROXY_PASSWORD';
const PROXY_USERNAME_ENV = 'MULLGATE_PROXY_USERNAME';
const LOCATION_ENV = 'MULLGATE_LOCATION';
const LOCATIONS_ENV = 'MULLGATE_LOCATIONS';
const BIND_HOST_ENV = 'MULLGATE_BIND_HOST';
const ROUTE_BIND_IPS_ENV = 'MULLGATE_ROUTE_BIND_IPS';
const EXPOSURE_MODE_ENV = 'MULLGATE_EXPOSURE_MODE';
const EXPOSURE_DOMAIN_ENV = 'MULLGATE_EXPOSURE_BASE_DOMAIN';
const SOCKS_PORT_ENV = 'MULLGATE_SOCKS_PORT';
const HTTP_PORT_ENV = 'MULLGATE_HTTP_PORT';
const HTTPS_PORT_ENV = 'MULLGATE_HTTPS_PORT';
const HTTPS_CERT_ENV = 'MULLGATE_HTTPS_CERT_PATH';
const HTTPS_KEY_ENV = 'MULLGATE_HTTPS_KEY_PATH';
const DEVICE_NAME_ENV = 'MULLGATE_DEVICE_NAME';
const PROVISIONING_URL_ENV = 'MULLGATE_MULLVAD_WG_URL';
const RELAYS_URL_ENV = 'MULLGATE_MULLVAD_RELAYS_URL';

type SetupCommandOptions = {
  readonly accountNumber?: string;
  readonly bindHost?: string;
  readonly routeBindIp?: string[];
  readonly exposureMode?: string;
  readonly baseDomain?: string;
  readonly socksPort?: string;
  readonly httpPort?: string;
  readonly httpsPort?: string;
  readonly username?: string;
  readonly password?: string;
  readonly location?: string[];
  readonly httpsCertPath?: string;
  readonly httpsKeyPath?: string;
  readonly deviceName?: string;
  readonly nonInteractive?: boolean;
  readonly mullvadWgUrl?: string;
  readonly mullvadRelaysUrl?: string;
};

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Run the guided Mullvad-backed setup flow and persist config plus derived runtime artifacts.')
    .option(`--account-number <digits>`, `Override ${ACCOUNT_NUMBER_ENV} or prompt for the Mullvad account number.`)
    .option(`--bind-host <host>`, `Override ${BIND_HOST_ENV} or prompt for the bind host.`)
    .option(
      `--route-bind-ip <ip>`,
      `Append an explicit route bind IPv4 address. Repeat or comma-separate values for multiple routes. ${ROUTE_BIND_IPS_ENV} accepts a comma-separated ordered list.`,
      collectLocationOption,
      [],
    )
    .option(`--exposure-mode <mode>`, `Override ${EXPOSURE_MODE_ENV} with loopback, private-network, or public.`)
    .option(`--base-domain <domain>`, `Override ${EXPOSURE_DOMAIN_ENV} for derived route hostnames like route.example.com.`)
    .option(`--socks-port <port>`, `Override ${SOCKS_PORT_ENV} or prompt for the SOCKS5 port.`)
    .option(`--http-port <port>`, `Override ${HTTP_PORT_ENV} or prompt for the HTTP port.`)
    .option(`--https-port <port>`, `Override ${HTTPS_PORT_ENV} for optional HTTPS proxy support.`)
    .option(`--username <name>`, `Override ${PROXY_USERNAME_ENV} or prompt for the proxy username.`)
    .option(`--password <secret>`, `Override ${PROXY_PASSWORD_ENV} or prompt for the proxy password.`)
    .option(
      `--location <alias>`,
      `Append a routed Mullvad location alias. Repeat or comma-separate values for multiple routes. ${LOCATION_ENV} stays shorthand for route 1; ${LOCATIONS_ENV} accepts a comma-separated ordered list.`,
      collectLocationOption,
      [],
    )
    .option(`--https-cert-path <path>`, `Override ${HTTPS_CERT_ENV} for optional HTTPS certificate validation.`)
    .option(`--https-key-path <path>`, `Override ${HTTPS_KEY_ENV} for optional HTTPS key validation.`)
    .option(`--device-name <name>`, `Override ${DEVICE_NAME_ENV} for the Mullvad device label.`)
    .option('--non-interactive', 'Fail instead of prompting when required setup values are missing.')
    .option(`--mullvad-wg-url <url>`, `Override ${PROVISIONING_URL_ENV} for provisioning.`)
    .option(`--mullvad-relays-url <url>`, `Override ${RELAYS_URL_ENV} for relay metadata.`)
    .action(async (options: SetupCommandOptions) => {
      const store = new ConfigStore();
      const result = await runSetupFlow(buildRunOptions(options, process.env, store));
      writeSetupResult(result);
      process.exitCode = result.exitCode;
    });
}

function buildRunOptions(options: SetupCommandOptions, env: NodeJS.ProcessEnv, store: ConfigStore): RunSetupFlowOptions {
  const configuredLocations = readLocationInputs(options.location, env);
  const configuredRouteBindIps = readRouteBindIpInputs(options.routeBindIp, env);
  const initialValues: Partial<RawSetupInputValues> = {
    ...(readOptionalString(options.accountNumber ?? env[ACCOUNT_NUMBER_ENV]) ? { accountNumber: readOptionalString(options.accountNumber ?? env[ACCOUNT_NUMBER_ENV]) } : {}),
    ...(readOptionalString(options.bindHost ?? env[BIND_HOST_ENV]) ? { bindHost: readOptionalString(options.bindHost ?? env[BIND_HOST_ENV]) } : {}),
    ...(configuredRouteBindIps.length > 0 ? { routeBindIps: configuredRouteBindIps } : {}),
    ...(readOptionalExposureMode(options.exposureMode ?? env[EXPOSURE_MODE_ENV])
      ? { exposureMode: readOptionalExposureMode(options.exposureMode ?? env[EXPOSURE_MODE_ENV]) }
      : {}),
    ...(readOptionalString(options.baseDomain ?? env[EXPOSURE_DOMAIN_ENV])
      ? { exposureBaseDomain: readOptionalString(options.baseDomain ?? env[EXPOSURE_DOMAIN_ENV]) }
      : {}),
    ...(readOptionalNumber(options.socksPort ?? env[SOCKS_PORT_ENV]) !== undefined
      ? { socksPort: readOptionalNumber(options.socksPort ?? env[SOCKS_PORT_ENV]) }
      : {}),
    ...(readOptionalNumber(options.httpPort ?? env[HTTP_PORT_ENV]) !== undefined
      ? { httpPort: readOptionalNumber(options.httpPort ?? env[HTTP_PORT_ENV]) }
      : {}),
    ...(readOptionalNumber(options.httpsPort ?? env[HTTPS_PORT_ENV]) !== undefined
      ? { httpsPort: readOptionalNumber(options.httpsPort ?? env[HTTPS_PORT_ENV]) }
      : {}),
    ...(readOptionalString(options.username ?? env[PROXY_USERNAME_ENV]) ? { username: readOptionalString(options.username ?? env[PROXY_USERNAME_ENV]) } : {}),
    ...(readOptionalString(options.password ?? env[PROXY_PASSWORD_ENV]) ? { password: readOptionalString(options.password ?? env[PROXY_PASSWORD_ENV]) } : {}),
    ...(configuredLocations.length > 0
      ? { locations: configuredLocations as [string, ...string[]], location: configuredLocations[0] }
      : {}),
    ...(readOptionalString(options.httpsCertPath ?? env[HTTPS_CERT_ENV])
      ? { httpsCertPath: readOptionalString(options.httpsCertPath ?? env[HTTPS_CERT_ENV]) }
      : {}),
    ...(readOptionalString(options.httpsKeyPath ?? env[HTTPS_KEY_ENV])
      ? { httpsKeyPath: readOptionalString(options.httpsKeyPath ?? env[HTTPS_KEY_ENV]) }
      : {}),
    ...(readOptionalString(options.deviceName ?? env[DEVICE_NAME_ENV]) ? { deviceName: readOptionalString(options.deviceName ?? env[DEVICE_NAME_ENV]) } : {}),
  };

  return {
    store,
    initialValues,
    interactive: !options.nonInteractive,
    ...(readOptionalString(options.mullvadWgUrl ?? env[PROVISIONING_URL_ENV])
      ? { provisioningBaseUrl: readOptionalString(options.mullvadWgUrl ?? env[PROVISIONING_URL_ENV]) }
      : {}),
    ...(readOptionalString(options.mullvadRelaysUrl ?? env[RELAYS_URL_ENV])
      ? { relayCatalogUrl: readOptionalString(options.mullvadRelaysUrl ?? env[RELAYS_URL_ENV]) }
      : {}),
  };
}

function writeSetupResult(result: SetupFlowResult): void {
  if (result.ok) {
    process.stdout.write(`${result.summary}\n`);
    return;
  }

  const lines = [
    result.cancelled ? 'Mullgate setup cancelled.' : 'Mullgate setup failed.',
    `phase: ${result.phase}`,
    `source: ${result.source}`,
    ...('code' in result && result.code ? [`code: ${result.code}`] : []),
    ...('route' in result && result.route
      ? [
          `route: ${result.route.index + 1}`,
          `route alias: ${result.route.alias}`,
          `requested alias: ${result.route.requested}`,
          `hostname: ${result.route.hostname}`,
          `bind ip: ${result.route.bindIp}`,
          `device: ${result.route.deviceName}`,
        ]
      : []),
    ...('artifactPath' in result && result.artifactPath ? [`artifact: ${result.artifactPath}`] : []),
    ...('endpoint' in result && result.endpoint ? [`endpoint: ${result.endpoint}`] : []),
    `reason: ${result.message}`,
    ...(result.cancelled ? [] : [`config: ${result.paths.configFile}`]),
    ...(!result.cancelled && result.cause ? [`cause: ${result.cause}`] : []),
  ];

  process.stderr.write(`${lines.join('\n')}\n`);
}

function collectLocationOption(value: string, previous: string[] = []): string[] {
  return [...previous, ...parseLocationEntries(value)];
}

function readLocationInputs(cliValues: readonly string[] | undefined, env: NodeJS.ProcessEnv): string[] {
  const cliLocations = (cliValues ?? []).flatMap((value) => parseLocationEntries(value));

  if (cliLocations.length > 0) {
    return cliLocations;
  }

  const envLocations = parseLocationEntries(env[LOCATIONS_ENV]);

  if (envLocations.length > 0) {
    return envLocations;
  }

  return parseLocationEntries(env[LOCATION_ENV]);
}

function readRouteBindIpInputs(cliValues: readonly string[] | undefined, env: NodeJS.ProcessEnv): string[] {
  const cliBindIps = (cliValues ?? []).flatMap((value) => parseLocationEntries(value));

  if (cliBindIps.length > 0) {
    return cliBindIps;
  }

  return parseLocationEntries(env[ROUTE_BIND_IPS_ENV]);
}

function parseLocationEntries(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalExposureMode(value: string | undefined): RawSetupInputValues['exposureMode'] | undefined {
  const trimmed = value?.trim();

  if (trimmed === 'loopback' || trimmed === 'private-network' || trimmed === 'public') {
    return trimmed;
  }

  return undefined;
}

function readOptionalNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}
