import type { MullgateConfig } from './schema.js';

export const REDACTED = '[redacted]';

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
    mullvad: {
      ...config.mullvad,
      accountNumber: REDACTED,
      wireguard: {
        ...config.mullvad.wireguard,
        privateKey: config.mullvad.wireguard.privateKey ? REDACTED : config.mullvad.wireguard.privateKey,
      },
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

export function formatRedactedConfig(config: MullgateConfig): string {
  return JSON.stringify(redactConfig(config), null, 2);
}

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

function collectKnownSecrets(config: MullgateConfig): string[] {
  return [
    config.mullvad.accountNumber,
    config.setup.auth.password,
    config.mullvad.wireguard.privateKey,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function redactPrivateKeyMaterial(value: string): string {
  return value.replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, REDACTED);
}
