import type { Command } from 'commander';

import { ConfigStore } from '../config/store.js';
import { runSetupFlow, type RunSetupFlowOptions, type SetupFlowResult, type SetupInputValues } from '../app/setup-runner.js';

const ACCOUNT_NUMBER_ENV = 'MULLGATE_ACCOUNT_NUMBER';
const PROXY_PASSWORD_ENV = 'MULLGATE_PROXY_PASSWORD';
const PROXY_USERNAME_ENV = 'MULLGATE_PROXY_USERNAME';
const LOCATION_ENV = 'MULLGATE_LOCATION';
const BIND_HOST_ENV = 'MULLGATE_BIND_HOST';
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
  readonly socksPort?: string;
  readonly httpPort?: string;
  readonly httpsPort?: string;
  readonly username?: string;
  readonly password?: string;
  readonly location?: string;
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
    .option(`--socks-port <port>`, `Override ${SOCKS_PORT_ENV} or prompt for the SOCKS5 port.`)
    .option(`--http-port <port>`, `Override ${HTTP_PORT_ENV} or prompt for the HTTP port.`)
    .option(`--https-port <port>`, `Override ${HTTPS_PORT_ENV} for optional HTTPS proxy support.`)
    .option(`--username <name>`, `Override ${PROXY_USERNAME_ENV} or prompt for the proxy username.`)
    .option(`--password <secret>`, `Override ${PROXY_PASSWORD_ENV} or prompt for the proxy password.`)
    .option(`--location <alias>`, `Override ${LOCATION_ENV} or prompt for the preferred Mullvad location alias.`)
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
  const initialValues: Partial<SetupInputValues> = {
    ...(readOptionalString(options.accountNumber ?? env[ACCOUNT_NUMBER_ENV]) ? { accountNumber: readOptionalString(options.accountNumber ?? env[ACCOUNT_NUMBER_ENV]) } : {}),
    ...(readOptionalString(options.bindHost ?? env[BIND_HOST_ENV]) ? { bindHost: readOptionalString(options.bindHost ?? env[BIND_HOST_ENV]) } : {}),
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
    ...(readOptionalString(options.location ?? env[LOCATION_ENV]) ? { location: readOptionalString(options.location ?? env[LOCATION_ENV]) } : {}),
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
    ...('artifactPath' in result && result.artifactPath ? [`artifact: ${result.artifactPath}`] : []),
    ...('endpoint' in result && result.endpoint ? [`endpoint: ${result.endpoint}`] : []),
    `reason: ${result.message}`,
    ...(result.cancelled ? [] : [`config: ${result.paths.configFile}`]),
    ...(!result.cancelled && result.cause ? [`cause: ${result.cause}`] : []),
  ];

  process.stderr.write(`${lines.join('\n')}\n`);
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}
