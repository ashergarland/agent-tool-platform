import { z } from 'zod';
import {
  capabilityRegistrySchemaVersion,
  httpHeaderNameSchema,
  httpHeaderValuePrefixSchema,
} from '@agent-tool-platform/capability-registry';
import { deploymentProfileDimensionsSchema } from '@agent-tool-platform/runtime';

export const AGENT_DEFINITION_SCHEMA_VERSION = 1;
export const AGENT_LOCK_SCHEMA_VERSION = 2;
export const AGENT_BUILD_SCHEMA_VERSION = 1;
export const AGENT_INSTANCE_SEAM_SCHEMA_VERSION = 1;

export const MAX_AGENT_INSTRUCTIONS_LENGTH = 16_000;
export const MAX_COMPOSED_INSTRUCTIONS_LENGTH = 64_000;

const stableIdentifierPattern = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;
const profileIdentifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/u;
const fullGitShaPattern = /^[0-9a-f]{40}$/u;
const localAbsolutePathPattern = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;
const parentSegmentPattern = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
const portableReferencePattern =
  /^[A-Za-z0-9@._~!$&'()*+,;=/-]+(?:#[A-Za-z0-9@._~!$&'()*+,;=/-]+)?$/u;

const isPrivateIpv4Address = (address: string): boolean => {
  if (
    /^(?:0|10|127)\./u.test(address) ||
    /^169\.254\./u.test(address) ||
    /^192\.168\./u.test(address)
  ) {
    return true;
  }
  const match = /^172\.(\d{1,2})\./u.exec(address);
  return match !== null && Number(match[1]) >= 16 && Number(match[1]) <= 31;
};

const isPublicHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.+$/u, '');
  const address = normalized.replace(/^\[|\]$/gu, '');
  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (mappedIpv4 !== null) {
    const upper = Number.parseInt(mappedIpv4[1]!, 16);
    const lower = Number.parseInt(mappedIpv4[2]!, 16);
    if (isPrivateIpv4Address(`${upper >>> 8}.${upper & 0xff}.${lower >>> 8}.${lower & 0xff}`)) {
      return false;
    }
  }
  return (
    normalized.length > 0 &&
    normalized !== 'localhost' &&
    !normalized.endsWith('.localhost') &&
    !normalized.endsWith('.local') &&
    !normalized.endsWith('.internal') &&
    !normalized.includes('.privatelink.') &&
    !isPrivateIpv4Address(address) &&
    address !== '::' &&
    address !== '::1' &&
    !/^f[cd][0-9a-f]{2}:/u.test(address) &&
    !/^fe[89ab][0-9a-f]:/u.test(address)
  );
};

export const stableIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(stableIdentifierPattern, 'must be a stable lowercase identifier');

export const profileIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(profileIdentifierPattern, 'must be a lowercase kebab-case profile identifier');

export const exactVersionSchema = z
  .string()
  .max(200)
  .regex(semanticVersionPattern, 'must be an exact semantic version');

export const sha256DigestSchema = z
  .string()
  .regex(sha256DigestPattern, 'must be a lowercase sha256 digest');

const secretNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u, 'must be a stable configuration name');

export const publicReferenceSchema = z
  .string()
  .min(1)
  .max(1_000)
  .regex(
    portableReferencePattern,
    'must be a portable repository-relative path, release tag, or fragment reference',
  )
  .refine(
    (value) =>
      !localAbsolutePathPattern.test(value) &&
      !parentSegmentPattern.test(value) &&
      !value.includes('\\') &&
      !value.includes('?'),
    'must not contain an absolute path, parent segment, backslash, or query state',
  );

export const publicRepositorySchema = z
  .url()
  .max(1_000)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      isPublicHostname(url.hostname)
    );
  }, 'must be a public HTTPS URL without credentials or query state');

export const npmPackageIdentifierSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(
    /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u,
    'must be an exact npm package name',
  );

export const publicOciIdentifierSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u,
    'must be an untagged OCI image identifier',
  )
  .refine((value) => {
    const candidate = `https://${value}`;
    if (!URL.canParse(candidate)) return false;
    const url = new URL(candidate);
    return (
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      isPublicHostname(url.hostname)
    );
  }, 'must identify an image in a public registry');

export const ociArtifactVersionSchema = exactVersionSchema
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u, 'must also be a valid OCI tag');

export const capabilitySelectionSchema = z.strictObject({
  id: stableIdentifierSchema,
  version: exactVersionSchema.optional(),
  profile: profileIdentifierSchema.optional(),
});

export const agentDefinitionSchema = z
  .strictObject({
    schemaVersion: z.literal(AGENT_DEFINITION_SCHEMA_VERSION),
    id: stableIdentifierSchema,
    name: z.string().min(1).max(200).regex(/\S/u, 'must not be blank'),
    version: exactVersionSchema,
    instructions: z
      .string()
      .min(1)
      .max(MAX_AGENT_INSTRUCTIONS_LENGTH)
      .regex(/\S/u, 'must not be blank'),
    capabilities: z.array(capabilitySelectionSchema).min(1).max(64),
  })
  .superRefine((definition, context) => {
    const firstIndex = new Map<string, number>();
    definition.capabilities.forEach((capability, index) => {
      const duplicateOf = firstIndex.get(capability.id);
      if (duplicateOf === undefined) {
        firstIndex.set(capability.id, index);
        return;
      }
      context.addIssue({
        code: 'custom',
        path: ['capabilities', index, 'id'],
        message: `duplicates capabilities.${String(duplicateOf)}.id (${capability.id})`,
      });
    });
  });

const resolvedArtifactCommonShape = {
  id: profileIdentifierSchema,
  availability: z.enum(['published', 'declared', 'source-only']),
  reference: publicReferenceSchema,
  sourceRevision: z.string().regex(fullGitShaPattern, 'must be a lowercase 40-character Git SHA'),
} as const;

export const resolvedCapabilityArtifactSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...resolvedArtifactCommonShape,
    kind: z.literal('npm'),
    identifier: npmPackageIdentifierSchema,
    version: exactVersionSchema,
  }),
  z.strictObject({
    ...resolvedArtifactCommonShape,
    kind: z.literal('oci'),
    identifier: publicOciIdentifierSchema,
    version: ociArtifactVersionSchema,
  }),
  z.strictObject({
    ...resolvedArtifactCommonShape,
    kind: z.literal('source'),
    identifier: publicRepositorySchema,
    version: exactVersionSchema,
  }),
]);

const lockCapabilitySchema = z.strictObject({
  id: profileIdentifierSchema,
  version: exactVersionSchema,
  requestedVersion: exactVersionSchema.nullable(),
  registryEntryDigest: sha256DigestSchema,
  source: z.strictObject({
    repository: publicRepositorySchema,
    revision: z.string().regex(fullGitShaPattern, 'must be a lowercase 40-character Git SHA'),
    profileDeclaration: publicReferenceSchema.nullable(),
  }),
  profile: z.strictObject({
    id: profileIdentifierSchema,
    source: z.enum(['capability-profile-declaration', 'registry-curated']),
    dimensions: deploymentProfileDimensionsSchema,
  }),
  binding: z.strictObject({
    id: profileIdentifierSchema,
    mode: z.enum(['local', 'remote', 'hybrid']),
    interface: z.enum(['stdio', 'http', 'library', 'custom']),
    client: z
      .strictObject({
        http: z.strictObject({
          headers: z
            .array(
              z.strictObject({
                name: httpHeaderNameSchema,
                configuration: secretNameSchema,
                prefix: httpHeaderValuePrefixSchema,
              }),
            )
            .min(1)
            .max(50),
        }),
      })
      .nullable(),
  }),
  artifact: resolvedCapabilityArtifactSchema,
  requirements: z.strictObject({
    setupRequired: z.boolean(),
    requiredSecretNames: z.array(secretNameSchema).max(100),
    providerPrerequisiteIds: z.array(profileIdentifierSchema).max(100),
    permissions: z.array(profileIdentifierSchema).max(100),
    readinessSignals: z.array(z.enum(['process', 'workload', 'provider'])).max(10),
  }),
});

export const agentLockSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_LOCK_SCHEMA_VERSION),
  kind: z.literal('agent-lock'),
  agent: z.strictObject({
    id: stableIdentifierSchema,
    version: exactVersionSchema,
    definitionDigest: sha256DigestSchema,
  }),
  capabilities: z.array(lockCapabilitySchema).min(1).max(64),
  build: z.strictObject({
    schemaVersion: z.literal(AGENT_BUILD_SCHEMA_VERSION),
    registrySchemaVersion: z.literal(capabilityRegistrySchemaVersion),
    adapters: z
      .array(
        z.strictObject({
          id: stableIdentifierSchema,
          schemaVersion: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(20),
  }),
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type CapabilitySelection = z.infer<typeof capabilitySelectionSchema>;
export type ResolvedCapabilityArtifact = z.infer<typeof resolvedCapabilityArtifactSchema>;
export type AgentLock = z.infer<typeof agentLockSchema>;
