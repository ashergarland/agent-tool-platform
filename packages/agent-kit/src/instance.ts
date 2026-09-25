import { z } from 'zod';
import { digestCanonicalJson, serializeCanonicalJson } from './canonical-json.js';
import { AgentKitError, formatZodIssues } from './errors.js';
import type { HostAdapter } from './host-adapter.js';
import { readinessCapabilityStateSchema } from './readiness.js';
import type { ResolvedCapability } from './resolution.js';
import {
  AGENT_INSTANCE_SEAM_SCHEMA_VERSION,
  exactVersionSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type AgentDefinition,
} from './schemas.js';

export const PREPARED_AGENT_INSTANCE_SCHEMA_VERSION = 1;

export const agentInstanceStateSchema = z.enum([
  'READY',
  'ACTIVE',
  'DEGRADED',
  'NEEDS_SETUP',
  'UNAVAILABLE',
]);

const seamBindingSchema = z.strictObject({
  key: z.string().min(1).max(600),
  capabilityId: stableIdentifierSchema,
  capabilityVersion: z.string().min(1).max(200),
  profileId: z.string().min(1).max(100),
  mode: z.enum(['local', 'remote', 'hybrid']),
});

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
  bindings: z.array(seamBindingSchema),
});

export const preparedAgentInstanceIdentitySchema = z.strictObject({
  schemaVersion: z.literal(AGENT_INSTANCE_SEAM_SCHEMA_VERSION),
  instanceId: sha256DigestSchema,
  environmentId: stableIdentifierSchema,
  seam: agentInstanceSeamSchema,
});

export const preparedAgentInstanceSchema = z
  .strictObject({
    schemaVersion: z.literal(PREPARED_AGENT_INSTANCE_SCHEMA_VERSION),
    instanceId: sha256DigestSchema,
    environmentId: stableIdentifierSchema,
    agentDefinition: z.strictObject({
      id: stableIdentifierSchema,
      version: exactVersionSchema,
      digest: sha256DigestSchema,
    }),
    build: z.strictObject({
      lockDigest: sha256DigestSchema,
    }),
    host: z.strictObject({
      id: stableIdentifierSchema,
      adapterSchemaVersion: z.number().int().positive(),
    }),
    preparedAt: z.iso.datetime({ offset: true }),
    state: agentInstanceStateSchema,
    bindings: z
      .array(
        seamBindingSchema.extend({
          key: z.string().min(1).max(600).regex(/^\S+$/u),
          capabilityVersion: exactVersionSchema,
          state: agentInstanceStateSchema,
          readiness: readinessCapabilityStateSchema,
        }),
      )
      .min(1)
      .max(64),
  })
  .superRefine((instance, context) => {
    const seen = new Set<string>();
    instance.bindings.forEach((binding, index) => {
      if (seen.has(binding.key)) {
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'key'],
          message: `duplicates binding ${binding.key}`,
        });
      }
      seen.add(binding.key);
    });

    const seam: AgentInstanceSeam = {
      schemaVersion: AGENT_INSTANCE_SEAM_SCHEMA_VERSION,
      agentDefinition: instance.agentDefinition,
      build: instance.build,
      host: instance.host,
      bindings: instance.bindings.map((binding) => ({
        key: binding.key,
        capabilityId: binding.capabilityId,
        capabilityVersion: binding.capabilityVersion,
        profileId: binding.profileId,
        mode: binding.mode,
      })),
    };
    const expectedInstanceId = digestCanonicalJson({
      seam,
      environmentId: instance.environmentId,
    });
    if (instance.instanceId !== expectedInstanceId) {
      context.addIssue({
        code: 'custom',
        path: ['instanceId'],
        message: 'does not match the canonical build, host, and environment identity',
      });
    }
  });

export type AgentInstanceSeam = z.infer<typeof agentInstanceSeamSchema>;
export type PreparedAgentInstanceIdentity = z.infer<typeof preparedAgentInstanceIdentitySchema>;
export type AgentInstanceState = z.infer<typeof agentInstanceStateSchema>;
export type PreparedAgentInstance = z.infer<typeof preparedAgentInstanceSchema>;

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

const validatePreparedAgentInstance = (input: unknown): PreparedAgentInstance => {
  const parsed = preparedAgentInstanceSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_AGENT_INSTANCE',
      'Prepared Agent Instance is invalid.',
      formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
};

export const parsePreparedAgentInstance = (input: unknown): PreparedAgentInstance => {
  if (typeof input !== 'string') return validatePreparedAgentInstance(input);

  let document: unknown;
  try {
    document = JSON.parse(input);
  } catch {
    throw new AgentKitError('INVALID_AGENT_INSTANCE', 'Prepared Agent Instance JSON is invalid.');
  }
  return validatePreparedAgentInstance(document);
};

export const serializePreparedAgentInstance = (input: unknown): string =>
  serializeCanonicalJson(validatePreparedAgentInstance(input));
