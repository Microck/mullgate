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

export const routedLocationRuntimeSchema = z.object({
  routeId: nonEmptyString,
  wireproxyServiceName: nonEmptyString,
  haproxyBackendName: nonEmptyString,
  wireproxyConfigFile: nonEmptyString,
});

export const routedLocationSchema = z.object({
  alias: nonEmptyString,
  hostname: nonEmptyString,
  bindIp: nonEmptyString,
  relayPreference: locationInputSchema,
  mullvad: mullvadProvisioningSchema,
  runtime: routedLocationRuntimeSchema,
});

export const routedLocationInputSchema = z.object({
  alias: nonEmptyString.optional(),
  hostname: nonEmptyString.optional(),
  bindIp: nonEmptyString.optional(),
  relayPreference: locationInputSchema,
  mullvad: mullvadProvisioningSchema,
  runtime: z
    .object({
      routeId: nonEmptyString.optional(),
      wireproxyServiceName: nonEmptyString.optional(),
      haproxyBackendName: nonEmptyString.optional(),
      wireproxyConfigFile: nonEmptyString.optional(),
    })
    .optional(),
});

export const routingConfigSchema = z.object({
  locations: z.array(routedLocationSchema).min(1),
});

export const routingConfigInputSchema = z.object({
  locations: z.array(routedLocationInputSchema).min(1),
});

export const runtimeBundleArtifactSchema = z.object({
  bundleDir: nonEmptyString,
  dockerComposePath: nonEmptyString,
  httpsSidecarConfigPath: nonEmptyString,
  manifestPath: nonEmptyString,
});

export const runtimeArtifactSchema = z.object({
  backend: z.enum(['wireproxy']),
  sourceConfigPath: nonEmptyString,
  wireproxyConfigPath: nonEmptyString,
  wireproxyConfigTestReportPath: nonEmptyString,
  relayCachePath: nonEmptyString,
  dockerComposePath: nonEmptyString.nullable(),
  runtimeBundle: runtimeBundleArtifactSchema,
  status: z.object({
    phase: z.enum(['unvalidated', 'validated', 'starting', 'running', 'error']),
    lastCheckedAt: timestampString.nullable(),
    message: nonEmptyString.nullable(),
  }),
});

export const runtimeStartDiagnosticSchema = z.object({
  attemptedAt: timestampString,
  status: z.enum(['success', 'failure']),
  phase: nonEmptyString,
  source: nonEmptyString,
  code: nonEmptyString.nullable(),
  message: nonEmptyString,
  cause: nonEmptyString.nullable(),
  artifactPath: nonEmptyString.nullable(),
  composeFilePath: nonEmptyString.nullable(),
  validationSource: z.enum(['wireproxy-binary/configtest', 'docker/configtest', 'internal-syntax']).nullable(),
  command: nonEmptyString.nullable(),
});

export const diagnosticsSchema = z.object({
  lastRuntimeStartReportPath: nonEmptyString,
  lastRuntimeStart: runtimeStartDiagnosticSchema.nullable(),
});

export type RuntimeStartDiagnostic = z.infer<typeof runtimeStartDiagnosticSchema>;

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
  routing: routingConfigSchema,
  runtime: runtimeArtifactSchema,
  diagnostics: diagnosticsSchema,
});

export const mullgateConfigInputSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  createdAt: timestampString,
  updatedAt: timestampString,
  setup: guidedSetupSchema,
  mullvad: mullvadProvisioningSchema,
  routing: routingConfigInputSchema.optional(),
  runtime: runtimeArtifactSchema,
  diagnostics: diagnosticsSchema,
});

export type RoutedLocation = z.infer<typeof routedLocationSchema>;
export type RoutedLocationInput = z.infer<typeof routedLocationInputSchema>;
export type MullgateConfig = z.infer<typeof mullgateConfigSchema>;
export type MullgateConfigInput = z.infer<typeof mullgateConfigInputSchema>;
