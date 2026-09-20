import { z } from 'zod';

export const capabilityRegistrySchemaVersion = '1.0.0';
export const capabilityRegistryKind = 'capability-registry';
export const capabilityEntryKind = 'capability';

export const capabilityEntrySchemaId =
  'https://raw.githubusercontent.com/ashergarland/agent-tool-platform/main/packages/capability-registry/schemas/v1/capability-entry.schema.json';
export const capabilityRegistrySchemaId =
  'https://raw.githubusercontent.com/ashergarland/agent-tool-platform/main/packages/capability-registry/schemas/v1/capability-registry.schema.json';

export const permissionScopes = [
  'workspace-read',
  'repository-read',
  'filesystem-read',
  'filesystem-write',
  'artifact-write',
  'process-execute',
  'network-access',
  'provider-read',
  'provider-write',
] as const;

export const stateEffects = ['artifact-create', 'filesystem-write', 'provider-mutation'] as const;

export const readinessSignals = ['process', 'workload', 'provider'] as const;
export const executionDimensions = ['local', 'hosted'] as const;
export const deliveryDimensions = ['source', 'package', 'container'] as const;
export const accessDimensions = ['local-process', 'authenticated-service'] as const;
export const workloadDimensions = [
  'none',
  'filesystem',
  'mount',
  'upload',
  'object-store',
  'provider',
] as const;
export const providerDimensions = ['none', 'external'] as const;
export const mutationDimensions = ['read-only', 'mutating'] as const;
export const conformanceChecks = [
  'runtime-contract',
  'mcp-metadata',
  'capability-profile-v1',
  'routing-metadata',
] as const;

const kebabIdentifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const sourceCapabilityIdentifierPattern = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;
const fullGitShaPattern = /^[0-9a-f]{40}$/u;
const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const repositoryReferencePattern = /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))\S+$/u;

const kebabIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(kebabIdentifierPattern, 'must be a lowercase kebab-case identifier');
const displayTextSchema = z.string().min(1).max(200).regex(/\S/u, 'must not be blank');
const descriptionSchema = z.string().min(1).max(1_000).regex(/\S/u, 'must not be blank');
const httpsUrlSchema = z.url().refine((value) => value.startsWith('https://'), {
  message: 'must use HTTPS',
});
const semanticVersionSchema = z
  .string()
  .regex(semanticVersionPattern, 'must be a semantic version');
const repositoryReferenceSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(repositoryReferencePattern, 'must be a portable repository-relative reference');
const secretNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u, 'must be a stable secret name');

const providerPrerequisiteSchema = z.strictObject({
  id: kebabIdentifierSchema,
  description: descriptionSchema,
});

export const deploymentProfileDimensionsSchema = z.strictObject({
  execution: z.enum(executionDimensions),
  delivery: z.enum(deliveryDimensions),
  access: z.enum(accessDimensions),
  workload: z.enum(workloadDimensions),
  provider: z.enum(providerDimensions),
  mutation: z.enum(mutationDimensions),
});

export const capabilityProfileSummarySchema = z.strictObject({
  id: kebabIdentifierSchema,
  description: descriptionSchema,
  source: z.enum(['capability-profile-declaration', 'registry-curated']),
  dimensions: deploymentProfileDimensionsSchema,
  permissions: z.strictObject({
    summary: descriptionSchema,
    scopes: z.array(z.enum(permissionScopes)),
  }),
  prerequisites: z.strictObject({
    setupRequired: z.boolean(),
    summary: descriptionSchema,
    requiredSecrets: z.array(secretNameSchema),
    provider: z.array(providerPrerequisiteSchema),
  }),
  readiness: z.strictObject({
    signals: z.array(z.enum(readinessSignals)).min(1),
    summary: descriptionSchema,
  }),
  stateEffects: z.array(z.enum(stateEffects)),
});

export const capabilityArtifactSchema = z.strictObject({
  id: kebabIdentifierSchema,
  kind: z.enum(['npm', 'oci', 'source']),
  identifier: z.string().min(1).max(500).regex(/^\S+$/u, 'must not contain whitespace'),
  version: semanticVersionSchema,
  availability: z.enum(['published', 'declared', 'source-only']),
  reference: repositoryReferenceSchema,
});

export const capabilityBindingSchema = z.strictObject({
  id: kebabIdentifierSchema,
  profileId: kebabIdentifierSchema,
  artifactId: kebabIdentifierSchema,
  interface: z.enum(['stdio', 'http', 'library', 'custom']),
  availability: z.enum(['local', 'remote', 'hybrid']),
});

export const capabilityEntrySchema = z.strictObject({
  $schema: z.literal(capabilityEntrySchemaId),
  schemaVersion: z.literal(capabilityRegistrySchemaVersion),
  kind: z.literal(capabilityEntryKind),
  id: kebabIdentifierSchema,
  displayName: displayTextSchema,
  description: z.string().min(1).max(500).regex(/\S/u, 'must not be blank'),
  publisher: z.strictObject({
    id: kebabIdentifierSchema,
    displayName: displayTextSchema,
    url: httpsUrlSchema,
  }),
  version: z.strictObject({
    value: semanticVersionSchema,
    status: z.enum(['released', 'declared', 'development']),
  }),
  artifacts: z.array(capabilityArtifactSchema).min(1),
  links: z.strictObject({
    repository: httpsUrlSchema,
    documentation: httpsUrlSchema,
  }),
  category: z.strictObject({
    id: kebabIdentifierSchema,
    displayName: displayTextSchema,
  }),
  tags: z.array(kebabIdentifierSchema).min(1),
  toolCount: z.number().int().min(1),
  profiles: z.array(capabilityProfileSummarySchema).min(1),
  bindings: z.array(capabilityBindingSchema).min(1),
  stateChanging: z.boolean(),
  routing: z.strictObject({
    summary: z.string().min(1).max(500).regex(/\S/u, 'must not be blank'),
  }),
  conformance: z.strictObject({
    status: z.enum(['verified', 'partial', 'unverified']),
    checks: z.array(z.enum(conformanceChecks)),
  }),
  source: z.strictObject({
    capabilityId: z
      .string()
      .min(1)
      .max(200)
      .regex(sourceCapabilityIdentifierPattern, 'must be a stable capability identifier'),
    repository: httpsUrlSchema,
    revision: z.string().regex(fullGitShaPattern, 'must be a full lowercase Git SHA'),
    metadataVersion: semanticVersionSchema,
    releaseTag: z
      .string()
      .regex(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u)
      .optional(),
    metadata: z.strictObject({
      server: repositoryReferenceSchema,
      package: repositoryReferenceSchema,
      profiles: repositoryReferenceSchema.optional(),
    }),
  }),
});

export const capabilityRegistrySchema = z.strictObject({
  $schema: z.literal(capabilityRegistrySchemaId),
  schemaVersion: z.literal(capabilityRegistrySchemaVersion),
  kind: z.literal(capabilityRegistryKind),
  registryVersion: semanticVersionSchema,
  capabilities: z.array(capabilityEntrySchema),
});

export type PermissionScope = (typeof permissionScopes)[number];
export type StateEffect = (typeof stateEffects)[number];
export type ReadinessSignal = (typeof readinessSignals)[number];
export type ConformanceCheck = (typeof conformanceChecks)[number];
export type CapabilityProfileSummary = z.infer<typeof capabilityProfileSummarySchema>;
export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;
export type CapabilityBinding = z.infer<typeof capabilityBindingSchema>;
export type CapabilityEntry = z.infer<typeof capabilityEntrySchema>;
export type CapabilityRegistry = z.infer<typeof capabilityRegistrySchema>;
export type DeploymentProfileDimensions = z.infer<typeof deploymentProfileDimensionsSchema>;

export type RegistryJsonSchema = Readonly<Record<string, unknown>>;

const jsonSchema = (
  schema: z.ZodType,
  id: string,
  title: string,
  description: string,
): RegistryJsonSchema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: id,
  title,
  description,
  $comment:
    'Cross-entry references, mutation consistency, ordering, and account-neutrality are enforced by the capability-registry validator.',
  ...z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'ref',
  }),
});

export const capabilityEntryJsonSchema = jsonSchema(
  capabilityEntrySchema,
  capabilityEntrySchemaId,
  'Capability registry entry v1',
  'Normalized discovery, compatibility, routing, and readiness metadata for one capability product.',
);

export const capabilityRegistryJsonSchema = jsonSchema(
  capabilityRegistrySchema,
  capabilityRegistrySchemaId,
  'Capability registry v1',
  'A deterministic first-party catalog of capability products and their available profiles and bindings.',
);
