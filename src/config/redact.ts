import type { MullgateConfig } from './schema.js';

export const REDACTED = '[redacted]';

export function redactConfig(config: MullgateConfig): MullgateConfig {
  return {
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
  };
}

export function formatRedactedConfig(config: MullgateConfig): string {
  return JSON.stringify(redactConfig(config), null, 2);
}
