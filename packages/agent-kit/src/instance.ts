import { z } from 'zod';
import { digestCanonicalJson } from './canonical-json.js';
import { AgentKitError, formatZodIssues } from './errors.js';
import type { HostAdapter } from './host-adapter.js';
import type { ResolvedCapability } from './resolution.js';
import {
  AGENT_INSTANCE_SEAM_SCHEMA_VERSION,
  sha256DigestSchema,
  stableIdentifierSchema,
  type AgentDefinition,
} from './schemas.js';

export const agentInstanceSeamSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_INSTANCE_SEAM_SCHEMA_VERSION),
  agentDefinition: z.strictObject({
    id: stableIdentifierSchema,
    version: z.string().min(1).max(200),
    digest: sha256DigestSchema,
  }),
  build: z.strictObject({
    lockDigest: sha256DigestSchema,
  }),
  host: z.strictObject({
    id: stableIdentifierSchema,
    adapterSchemaVersion: z.number().int().positive(),
  }),
  bindings: z.array(
    z.strictObject({
      key: z.string().min(1).max(600),
      capabilityId: stableIdentifierSchema,
      capabilityVersion: z.string().min(1).max(200),
      profileId: z.string().min(1).max(100),
      mode: z.enum(['local', 'remote', 'hybrid']),
    }),
  ),
});

export const preparedAgentInstanceIdentitySchema = z.strictObject({
  schemaVersion: z.literal(AGENT_INSTANCE_SEAM_SCHEMA_VERSION),
  instanceId: sha256DigestSchema,
  environmentId: stableIdentifierSchema,
  seam: agentInstanceSeamSchema,
});

export type AgentInstanceSeam = z.infer<typeof agentInstanceSeamSchema>;
export type PreparedAgentInstanceIdentity = z.infer<typeof preparedAgentInstanceIdentitySchema>;

export const createAgentInstanceSeam = (
  definition: AgentDefinition,
  definitionDigest: string,
  lockDigest: `sha256:${string}`,
  adapter: HostAdapter,
  capabilities: readonly ResolvedCapability[],
): AgentInstanceSeam => {
  const candidate = {
    schemaVersion: AGENT_INSTANCE_SEAM_SCHEMA_VERSION,
    agentDefinition: {
      id: definition.id,
      version: definition.version,
      digest: definitionDigest,
    },
    build: { lockDigest },
    host: {
      id: adapter.id,
      adapterSchemaVersion: adapter.schemaVersion,
    },
    bindings: capabilities.map((capability) => ({
      key: capability.binding.key,
      capabilityId: capability.capability.id,
      capabilityVersion: capability.capability.version.value,
      profileId: capability.profile.id,
      mode: capability.binding.mode,
    })),
  } as const;
  const parsed = agentInstanceSeamSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_INSTANCE_IDENTITY',
      'Generated Agent Instance seam is invalid.',
      formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
};

export const createPreparedAgentInstanceIdentity = (
  seamInput: unknown,
  environmentId: string,
): PreparedAgentInstanceIdentity => {
  const seam = agentInstanceSeamSchema.safeParse(seamInput);
  const environment = stableIdentifierSchema.safeParse(environmentId);
  const issues = [
    ...(seam.success ? [] : formatZodIssues(seam.error).map((issue) => `seam.${issue}`)),
    ...(environment.success
      ? []
      : formatZodIssues(environment.error).map((issue) => `environmentId.${issue}`)),
  ];
  if (!seam.success || !environment.success) {
    throw new AgentKitError(
      'INVALID_INSTANCE_IDENTITY',
      'Agent Instance identity input is invalid.',
      issues,
    );
  }
  const identityInput = { seam: seam.data, environmentId: environment.data };
  return {
    schemaVersion: AGENT_INSTANCE_SEAM_SCHEMA_VERSION,
    instanceId: digestCanonicalJson(identityInput),
    environmentId: environment.data,
    seam: seam.data,
  };
};
