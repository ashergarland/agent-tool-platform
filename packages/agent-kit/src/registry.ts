import { z } from 'zod';
import {
  capabilityEntrySchema,
  validateCapabilityConsistency,
  type CapabilityEntry,
  type CapabilityRegistryReader,
} from '@agent-tool-platform/capability-registry';
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

const artifactCommonShape = {
  id: profileIdentifierSchema,
  availability: z.enum(['published', 'declared', 'source-only']),
  reference: publicReferenceSchema,
} as const;

const buildArtifactSchema = z.discriminatedUnion('kind', [
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

export const parseRegistryCapability = (
  input: unknown,
  label = 'registry capability',
): CapabilityEntry => {
  const parsed = capabilityEntrySchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_REGISTRY_RECORD',
      `${label} is malformed.`,
      formatZodIssues(parsed.error),
    );
  }

  const capability = parsed.data;
  const issues = [...validateCapabilityConsistency([capability])];

  for (const artifact of capability.artifacts) {
    const parsedArtifact = buildArtifactSchema.safeParse(artifact);
    if (!parsedArtifact.success) {
      issues.push(
        ...formatZodIssues(parsedArtifact.error).map(
          (issue) => `artifact ${artifact.id}: ${issue}`,
        ),
      );
    }
  }

  const parsedRepository = publicRepositorySchema.safeParse(capability.source.repository);
  if (!parsedRepository.success) {
    issues.push(
      ...formatZodIssues(parsedRepository.error).map((issue) => `source.repository: ${issue}`),
    );
  }

  for (const [name, reference] of Object.entries(capability.source.metadata)) {
    if (reference === undefined) continue;
    const parsedReference = publicReferenceSchema.safeParse(reference);
    if (!parsedReference.success) {
      issues.push(
        ...formatZodIssues(parsedReference.error).map(
          (issue) => `source.metadata.${name}: ${issue}`,
        ),
      );
    }
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
): Promise<CapabilityEntry> => {
  const rawCapability = await Promise.resolve(registry.getCapability(capabilityId));
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
