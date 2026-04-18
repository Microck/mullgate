import {
  type MullgateConfig,
  type SensitiveConfigFieldPath,
  sensitiveConfigFieldPaths,
} from './schema.js';

/** Placeholder used in place of sensitive configuration values. */
export const REDACTED = '[redacted]';

/**
 * Return a deep copy of `config` with all sensitive fields replaced by {@link REDACTED}.
 *
 * @param config - The full Mullgate configuration.
 * @returns A safe-to-log copy with secrets redacted.
 */
export function redactConfig(config: MullgateConfig): MullgateConfig {
  const redacted = {
    ...config,
    setup: {
      ...config.setup,
      auth: {
        ...config.setup.auth,
        password: REDACTED,
      },
    },
    mullvad: redactProvisioning(config.mullvad),
    routing: {
      locations: config.routing.locations.map((location) => ({
        ...location,
        mullvad: {
          ...location.mullvad,
        },
      })),
    },
  } satisfies MullgateConfig;

  if (!redacted.diagnostics.lastRuntimeStart) {
    return redacted;
  }

  return {
    ...redacted,
    diagnostics: {
      ...redacted.diagnostics,
      lastRuntimeStart: {
        ...redacted.diagnostics.lastRuntimeStart,
        message: redactSensitiveText(redacted.diagnostics.lastRuntimeStart.message, config),
        cause: redactOptionalText(redacted.diagnostics.lastRuntimeStart.cause, config),
        command: redactOptionalText(redacted.diagnostics.lastRuntimeStart.command, config),
      },
    },
  } satisfies MullgateConfig;
}

/**
 * Serialize a redacted config as pretty-printed JSON.
 *
 * @param config - The full Mullgate configuration.
 * @returns A JSON string with secrets replaced by `[redacted]`.
 */
export function formatRedactedConfig(config: MullgateConfig): string {
  return JSON.stringify(redactConfig(config), null, 2);
}

/**
 * Replace all known secrets and PEM-encoded private keys within an arbitrary string.
 *
 * @param value - The text to sanitize.
 * @param config - Used to discover current secret values.
 * @returns The sanitized text with secrets replaced by `[redacted]`.
 */
export function redactSensitiveText(value: string, config: MullgateConfig): string {
  let redacted = value;

  for (const secret of collectKnownSecrets(config)) {
    redacted = redacted.split(secret).join(REDACTED);
  }

  return redactPrivateKeyMaterial(redacted);
}

function redactOptionalText(value: string | null, config: MullgateConfig): string | null {
  return value ? redactSensitiveText(value, config) : value;
}

/**
 * Sensitive fields from `src/config/schema.ts`. This list MUST be kept in sync
 * whenever the config schema changes:
 * - `setup.auth.password`
 * - `mullvad.accountNumber`
 * - `mullvad.wireguard.privateKey`
 */
export function collectKnownSecrets(config: MullgateConfig): string[] {
  return sensitiveConfigFieldPaths
    .map((path) => readSensitiveConfigField(config, path))
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function readSensitiveConfigField(
  config: MullgateConfig,
  path: SensitiveConfigFieldPath,
): string | null {
  switch (path) {
    case 'setup.auth.password':
      return config.setup.auth.password;
    case 'mullvad.accountNumber':
      return config.mullvad.accountNumber;
    case 'mullvad.wireguard.privateKey':
      return config.mullvad.wireguard.privateKey;
  }
}

function redactProvisioning(provisioning: MullgateConfig['mullvad']): MullgateConfig['mullvad'] {
  return {
    ...provisioning,
    accountNumber: REDACTED,
    wireguard: {
      ...provisioning.wireguard,
      privateKey: provisioning.wireguard.privateKey ? REDACTED : provisioning.wireguard.privateKey,
    },
  };
}

function redactPrivateKeyMaterial(value: string): string {
  return value.replace(
    /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g,
    REDACTED,
  );
}
