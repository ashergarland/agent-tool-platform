import { z } from 'zod';
import { deploymentProfileDimensionsSchema } from '@agent-tool-platform/runtime';
import { AgentKitError, formatZodIssues } from './errors.js';
import {
  exactVersionSchema,
  npmPackageIdentifierSchema,
  ociArtifactVersionSchema,
  profileIdentifierSchema,
  publicOciIdentifierSchema,
  publicReferenceSchema,
  publicRepositorySchema,
} from './schemas.js';

const permissionScopeSchema = z.enum([
  'workspace-read',
  'repository-read',
  'filesystem-read',
  'filesystem-write',
  'artifact-write',
  'process-execute',
  'network-access',
  'provider-read',
  'provider-write',
]);
const stateEffectSchema = z.enum(['artifact-create', 'filesystem-write', 'provider-mutation']);
const descriptionSchema = z.string().min(1).max(1_000).regex(/\S/u, 'must not be blank');
const fullGitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u, 'must be a full lowercase Git SHA');
const artifactCommonShape = {
  id: profileIdentifierSchema,
  availability: z.enum(['published', 'declared', 'source-only']),
  reference: publicReferenceSchema,
} as const;
const capabilityArtifactSchema = z.discriminatedUnion('kind', [
  z.object({
    ...artifactCommonShape,
    kind: z.literal('npm'),
    identifier: npmPackageIdentifierSchema,
    version: exactVersionSchema,
  }),
  z.object({
    ...artifactCommonShape,
    kind: z.literal('oci'),
    identifier: publicOciIdentifierSchema,
    version: ociArtifactVersionSchema,
  }),
  z.object({
    ...artifactCommonShape,
    kind: z.literal('source'),
    identifier: publicRepositorySchema,
    version: exactVersionSchema,
  }),
]);

/**
 * This is deliberately a projection of the H1/H2 CapabilityEntry contract, not another registry
 * schema. Unknown catalog/UI fields remain owned and validated by capability-registry; Agent Kit
 * validates only fields it consumes to produce a build.
 */
const registryCapabilityProjectionSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  kind: z.literal('capability'),
  id: profileIdentifierSchema,
  displayName: z.string().min(1).max(200).regex(/\S/u, 'must not be blank'),
  description: z.string().min(1).max(500).regex(/\S/u, 'must not be blank'),
  version: z.object({
    value: exactVersionSchema,
    status: z.enum(['released', 'declared', 'development']),
  }),
  artifacts: z.array(capabilityArtifactSchema).min(1),
  profiles: z
    .array(
      z.object({
        id: profileIdentifierSchema,
        description: descriptionSchema,
        source: z.enum(['capability-profile-declaration', 'registry-curated']),
        dimensions: deploymentProfileDimensionsSchema,
        permissions: z.object({
          summary: descriptionSchema,
          scopes: z.array(permissionScopeSchema),
        }),
        prerequisites: z.object({
          setupRequired: z.boolean(),
          summary: descriptionSchema,
          requiredSecrets: z.array(
            z
              .string()
              .min(1)
              .max(200)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
          ),
          provider: z.array(
            z.object({
              id: profileIdentifierSchema,
              description: descriptionSchema,
            }),
          ),
        }),
        readiness: z.object({
          signals: z.array(z.enum(['process', 'workload', 'provider'])).min(1),
          summary: descriptionSchema,
        }),
        stateEffects: z.array(stateEffectSchema),
      }),
    )
    .min(1),
  bindings: z
    .array(
      z.object({
        id: profileIdentifierSchema,
        profileId: profileIdentifierSchema,
        artifactId: profileIdentifierSchema,
        interface: z.enum(['stdio', 'http', 'library', 'custom']),
        availability: z.enum(['local', 'remote', 'hybrid']),
      }),
    )
    .min(1),
  stateChanging: z.boolean(),
  routing: z.object({
    summary: z.string().min(1).max(500).regex(/\S/u, 'must not be blank'),
  }),
  source: z.object({
    capabilityId: z.string().min(1).max(200),
    repository: publicRepositorySchema,
    revision: fullGitShaSchema,
    metadataVersion: exactVersionSchema,
    releaseTag: z.string().min(1).max(200).optional(),
    metadata: z.object({
      server: publicReferenceSchema,
      package: publicReferenceSchema,
      profiles: publicReferenceSchema.optional(),
    }),
  }),
});

export type RegistryCapability = z.infer<typeof registryCapabilityProjectionSchema>;
export type RegistryCapabilityArtifact = RegistryCapability['artifacts'][number];
export type RegistryCapabilityProfile = RegistryCapability['profiles'][number];
export type RegistryCapabilityBinding = RegistryCapability['bindings'][number];

/**
 * The exact lookup behavior Agent Kit consumes from
 * `@agent-tool-platform/capability-registry`. Version requests are Agent Kit input and are checked
 * against the returned current entry; they are not forwarded as an invented registry operation.
 */
export interface CapabilityRegistryReader {
  getCapability(capabilityId: string): unknown;
}

const expectedAvailability = (
  profile: RegistryCapabilityProfile,
): RegistryCapabilityBinding['availability'] => {
  if (profile.dimensions.execution === 'hosted') return 'remote';
  return profile.dimensions.provider === 'external' ? 'hybrid' : 'local';
};

const expectedArtifactKind = (
  profile: RegistryCapabilityProfile,
): RegistryCapabilityArtifact['kind'] => {
  if (profile.dimensions.delivery === 'package') return 'npm';
  if (profile.dimensions.delivery === 'container') return 'oci';
  return 'source';
};

export const parseRegistryCapability = (
  input: unknown,
  label = 'registry capability',
): RegistryCapability => {
  const parsed = registryCapabilityProjectionSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_REGISTRY_RECORD',
      `${label} is malformed.`,
      formatZodIssues(parsed.error),
    );
  }
  const capability = parsed.data;
  const issues: string[] = [];
  const artifacts = new Map<string, RegistryCapabilityArtifact>();
  const profiles = new Map<string, RegistryCapabilityProfile>();
  const bindingIds = new Set<string>();

  for (const artifact of capability.artifacts) {
    if (artifacts.has(artifact.id)) issues.push(`duplicate artifact id ${artifact.id}`);
    artifacts.set(artifact.id, artifact);
    if (artifact.version !== capability.version.value) {
      issues.push(
        `artifact ${artifact.id} version ${artifact.version} does not match ${capability.version.value}`,
      );
    }
  }
  for (const profile of capability.profiles) {
    if (profiles.has(profile.id)) issues.push(`duplicate profile id ${profile.id}`);
    profiles.set(profile.id, profile);
    if (
      profile.source === 'capability-profile-declaration' &&
      capability.source.metadata.profiles === undefined
    ) {
      issues.push(
        `profile ${profile.id} claims a declaration but source.metadata.profiles is absent`,
      );
    }
    if (profile.dimensions.mutation === 'read-only' && profile.stateEffects.length > 0) {
      issues.push(`read-only profile ${profile.id} declares state effects`);
    }
    if (profile.dimensions.mutation === 'mutating' && profile.stateEffects.length === 0) {
      issues.push(`mutating profile ${profile.id} declares no state effects`);
    }
  }
  for (const binding of capability.bindings) {
    if (bindingIds.has(binding.id)) issues.push(`duplicate binding id ${binding.id}`);
    bindingIds.add(binding.id);
    const profile = profiles.get(binding.profileId);
    if (profile === undefined) {
      issues.push(`binding ${binding.id} references missing profile ${binding.profileId}`);
    } else if (binding.availability !== expectedAvailability(profile)) {
      issues.push(
        `binding ${binding.id} availability ${binding.availability} conflicts with profile ${profile.id}`,
      );
    }
    const artifact = artifacts.get(binding.artifactId);
    if (artifact === undefined) {
      issues.push(`binding ${binding.id} references missing artifact ${binding.artifactId}`);
    } else if (profile !== undefined && artifact.kind !== expectedArtifactKind(profile)) {
      issues.push(
        `binding ${binding.id} artifact kind ${artifact.kind} conflicts with profile ${profile.id} delivery ${profile.dimensions.delivery}`,
      );
    }
    if (
      profile !== undefined &&
      profile.dimensions.access === 'authenticated-service' &&
      binding.interface !== 'http'
    ) {
      issues.push(`authenticated binding ${binding.id} must use the http interface`);
    }
  }
  const hasMutatingProfile = capability.profiles.some(
    (profile) => profile.dimensions.mutation === 'mutating',
  );
  if (capability.stateChanging !== hasMutatingProfile) {
    issues.push('stateChanging does not match the declared profile mutation dimensions');
  }

  if (issues.length > 0) {
    throw new AgentKitError('INVALID_REGISTRY_RECORD', `${label} is inconsistent.`, issues);
  }
  return capability;
};

export const resolveRegistryCapability = async (
  registry: CapabilityRegistryReader,
  capabilityId: string,
  requestedVersion?: string,
): Promise<RegistryCapability> => {
  const rawCapability = await registry.getCapability(capabilityId);
  if (rawCapability === undefined || rawCapability === null) {
    throw new AgentKitError(
      'CAPABILITY_NOT_FOUND',
      `Capability ${capabilityId} was not found in the registry.`,
    );
  }
  const capability = parseRegistryCapability(rawCapability, `registry capability ${capabilityId}`);
  if (capability.id !== capabilityId) {
    throw new AgentKitError(
      'INVALID_REGISTRY_RECORD',
      `Registry returned ${capability.id} while resolving ${capabilityId}.`,
    );
  }
  if (requestedVersion !== undefined && capability.version.value !== requestedVersion) {
    throw new AgentKitError(
      'CAPABILITY_VERSION_NOT_FOUND',
      `Capability ${capabilityId}@${requestedVersion} was not found.`,
      [`registry currently resolves ${capability.version.value}`],
    );
  }
  return capability;
};
