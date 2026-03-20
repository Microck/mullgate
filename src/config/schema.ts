import { z } from 'zod';

export const CONFIG_VERSION = 1 as const;

const nonEmptyString = z.string().trim().min(1);
const timestampString = z.string().datetime({ offset: true });

export const bindConfigSchema = z.object({
  host: nonEmptyString,
  socksPort: z.number().int().min(1).max(65535),
  httpPort: z.number().int().min(1).max(65535),
  httpsPort: z.number().int().min(1).max(65535).nullable(),
});

export const authConfigSchema = z.object({
  username: nonEmptyString,
  password: nonEmptyString,
});

export const exposureConfigSchema = z.object({
  mode: z.enum(['loopback', 'private-network', 'public']),
  allowLan: z.boolean(),
});

export const locationInputSchema = z.object({
  requested: nonEmptyString,
  country: nonEmptyString.optional(),
  city: nonEmptyString.optional(),
  hostnameLabel: nonEmptyString.optional(),
  resolvedAlias: nonEmptyString.nullable(),
});

export const httpsConfigSchema = z.object({
  enabled: z.boolean(),
  certPath: nonEmptyString.optional(),
  keyPath: nonEmptyString.optional(),
});

export const mullvadProvisioningSchema = z.object({
  accountNumber: z.string().trim().regex(/^\d{6,16}$/, 'Mullvad account number must be 6-16 digits.'),
  deviceName: nonEmptyString.optional(),
  lastProvisionedAt: timestampString.nullable(),
  relayConstraints: z.object({
    ownership: nonEmptyString.optional(),
    providers: z.array(nonEmptyString).default([]),
  }),
  wireguard: z.object({
    publicKey: nonEmptyString.nullable(),
    privateKey: nonEmptyString.nullable(),
    ipv4Address: nonEmptyString.nullable(),
    ipv6Address: nonEmptyString.nullable(),
    gatewayIpv4: nonEmptyString.nullable(),
    gatewayIpv6: nonEmptyString.nullable(),
    dnsServers: z.array(nonEmptyString),
    peerPublicKey: nonEmptyString.nullable(),
    peerEndpoint: nonEmptyString.nullable(),
  }),
});

export const runtimeArtifactSchema = z.object({
  backend: z.enum(['wireproxy']),
  sourceConfigPath: nonEmptyString,
  wireproxyConfigPath: nonEmptyString,
  wireproxyConfigTestReportPath: nonEmptyString,
  relayCachePath: nonEmptyString,
  dockerComposePath: nonEmptyString.nullable(),
  status: z.object({
    phase: z.enum(['unvalidated', 'validated', 'error']),
    lastCheckedAt: timestampString.nullable(),
    message: nonEmptyString.nullable(),
  }),
});

export const guidedSetupSchema = z.object({
  source: z.literal('guided-setup'),
  bind: bindConfigSchema,
  auth: authConfigSchema,
  exposure: exposureConfigSchema,
  location: locationInputSchema,
  https: httpsConfigSchema,
});

export const mullgateConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  createdAt: timestampString,
  updatedAt: timestampString,
  setup: guidedSetupSchema,
  mullvad: mullvadProvisioningSchema,
  runtime: runtimeArtifactSchema,
});

export type MullgateConfig = z.infer<typeof mullgateConfigSchema>;
