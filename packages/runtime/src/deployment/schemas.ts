import { z } from 'zod';

export const CANONICAL_CAPABILITY_DECLARATION_PATH = 'capability-profiles.json';

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

const identifierPattern = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;
const profileIdentifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const secretNamePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const fullGitShaPattern = /^[0-9a-f]{40}$/u;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/u;
const uriPattern = /^[a-z][a-z0-9+.-]*:\S+$/iu;
const repositoryPathPattern = /^(?:\.|(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))\S+)$/u;
const immutableVersionPattern = /^(?!latest$)(?!next$)(?!.*[~^*<>=|,\s]).+$/iu;

const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(identifierPattern, 'must be a stable lowercase identifier');
const profileIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(profileIdentifierPattern, 'must be a lowercase kebab-case profile identifier');
const descriptionSchema = z.string().min(1).max(1_000).regex(/\S/u, 'must not be blank');
const referenceSchema = z.string().min(1).max(1_000).regex(/^\S+$/u, 'must not contain whitespace');
const packageIdentifierSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^\S+$/u, 'must not contain whitespace');
const uriSchema = z.string().min(1).max(1_000).regex(uriPattern, 'must be an absolute URI');
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(repositoryPathPattern, 'must be a portable repository-relative path');
const fullGitShaSchema = z
  .string()
  .regex(fullGitShaPattern, 'must be a lowercase 40-character Git SHA');
const sha256DigestSchema = z
  .string()
  .regex(sha256DigestPattern, 'must be a lowercase sha256 digest');

export const deploymentProfileDimensionsSchema = z.strictObject({
  execution: z.enum(executionDimensions),
  delivery: z.enum(deliveryDimensions),
  access: z.enum(accessDimensions),
  workload: z.enum(workloadDimensions),
  provider: z.enum(providerDimensions),
  mutation: z.enum(mutationDimensions),
});

const schemaReferenceSchema = z.strictObject({
  id: uriSchema,
  capabilityId: identifierSchema,
  path: repositoryPathSchema,
});

const namedReferenceSchema = z.strictObject({
  id: profileIdentifierSchema,
  reference: referenceSchema,
});

const publicProviderPrerequisiteSchema = z.strictObject({
  id: profileIdentifierSchema,
  description: descriptionSchema,
});

const publicWorkloadSchema = z.strictObject({
  interface: z.strictObject({
    kind: z.enum(workloadDimensions.filter((value) => value !== 'none')),
    reference: referenceSchema,
  }),
  authorization: z.strictObject({
    scope: descriptionSchema,
  }),
  lifecycle: z.strictObject({
    mode: z.enum(['request', 'session', 'persistent']),
    freshness: descriptionSchema,
    cleanup: descriptionSchema,
  }),
  notReady: z.strictObject({
    whenAbsent: z.literal('not-ready'),
    reason: descriptionSchema,
  }),
});

const publicMutationSchema = z.strictObject({
  enablement: z.literal('separate'),
  authorization: descriptionSchema,
  confirmation: descriptionSchema,
  durableRecord: z.enum(['required', 'not-required']),
  authoritativeVerification: descriptionSchema,
});

const publicDeliverySchema = z.strictObject({
  supportedForms: z.array(z.enum(deliveryDimensions)).min(1),
  publication: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('source'),
      buildReference: referenceSchema,
    }),
    z.strictObject({
      kind: z.literal('package'),
      identifier: packageIdentifierSchema,
    }),
    z.strictObject({
      kind: z.literal('container'),
      identifier: referenceSchema,
    }),
  ]),
  entrypoint: z.strictObject({
    reference: repositoryPathSchema,
    interface: z.enum(['stdio', 'http', 'library', 'custom']),
  }),
  mechanics: z.array(namedReferenceSchema).min(1),
  provenance: z.strictObject({
    method: z.enum(['package-metadata', 'source-attestation', 'build-recipe', 'provenance']),
    reference: referenceSchema,
  }),
});

export const capabilityProfileSchema = z.strictObject({
  id: profileIdentifierSchema,
  description: descriptionSchema,
  dimensions: deploymentProfileDimensionsSchema,
  delivery: publicDeliverySchema,
  configuration: z.strictObject({
    schema: schemaReferenceSchema,
    bounded: z.boolean(),
  }),
  requiredSecrets: z.array(z.string().regex(secretNamePattern, 'must be a stable secret name')),
  providerPrerequisites: z.array(publicProviderPrerequisiteSchema),
  identity: z.strictObject({
    trustBoundary: descriptionSchema,
    rbac: z.array(descriptionSchema),
  }),
  workload: publicWorkloadSchema.optional(),
  mutation: publicMutationSchema.optional(),
  extensionSchemas: z.array(schemaReferenceSchema),
  verification: z.strictObject({
    surfaces: z
      .array(z.enum(['identity', 'readiness', 'version', 'behavior', 'provider', 'provenance']))
      .min(1),
  }),
});

export const capabilityProfileDeclarationSchema = z.strictObject({
  contractVersion: z.literal(1),
  kind: z.literal('capability-profile-declaration'),
  capability: z.strictObject({
    id: identifierSchema,
    displayName: z.string().min(1).max(200).regex(/\S/u, 'must not be blank'),
    repository: uriSchema,
  }),
  profiles: z.array(capabilityProfileSchema).min(1),
});

const immutableRepositorySchema = z.strictObject({
  repository: uriSchema,
  revision: fullGitShaSchema,
  path: repositoryPathSchema,
});

const sourceBindingSchema = z.strictObject({
  revision: fullGitShaSchema,
  method: z.enum(['attestation', 'provenance', 'package-metadata', 'build-record']),
  reference: referenceSchema,
});

export const deploymentArtifactSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('package'),
    registry: uriSchema,
    identifier: packageIdentifierSchema,
    version: z
      .string()
      .min(1)
      .max(200)
      .regex(immutableVersionPattern, 'must be an exact immutable package version'),
    digest: sha256DigestSchema,
    sourceBinding: sourceBindingSchema,
  }),
  z.strictObject({
    kind: z.literal('container'),
    registry: referenceSchema,
    image: referenceSchema,
    digest: sha256DigestSchema,
    sourceBinding: sourceBindingSchema,
  }),
  z.strictObject({
    kind: z.literal('build-from-source'),
    expectedArtifactKind: z.enum(['package', 'container']),
    buildEntrypoint: repositoryPathSchema,
    provenance: z.strictObject({
      method: z.enum(['attestation', 'provenance', 'build-record']),
      reference: referenceSchema,
    }),
    requiredEvidence: z.strictObject({
      producedDigest: z.literal(true),
      sourceBinding: z.literal(true),
    }),
  }),
]);

const verificationExpectationSchema = z.strictObject({
  id: profileIdentifierSchema,
  expectation: descriptionSchema,
});

const privateWorkloadSchema = z.strictObject({
  kind: z.enum(workloadDimensions.filter((value) => value !== 'none')),
  source: z.strictObject({
    reference: referenceSchema,
  }),
  interface: z.strictObject({
    reference: referenceSchema,
  }),
  authorization: z.strictObject({
    scope: descriptionSchema,
    reference: referenceSchema,
  }),
  lifecycle: z.strictObject({
    mode: z.enum(['request', 'session', 'persistent']),
    freshness: descriptionSchema,
    cleanup: descriptionSchema,
  }),
  notReady: z.strictObject({
    whenAbsent: z.literal('not-ready'),
    reasonCode: profileIdentifierSchema,
  }),
});

const privateMutationSchema = z.strictObject({
  enablement: z.strictObject({
    default: z.literal('disabled'),
    reference: referenceSchema,
  }),
  authorization: z.strictObject({
    reference: referenceSchema,
  }),
  confirmation: z.strictObject({
    reference: referenceSchema,
  }),
  durableRecord: z
    .strictObject({
      reference: referenceSchema,
    })
    .optional(),
  authoritativeVerification: z.strictObject({
    expectation: descriptionSchema,
  }),
});

const rollbackSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('target'),
    sourceRevision: fullGitShaSchema,
    artifactDigest: sha256DigestSchema,
  }),
  z.strictObject({
    kind: z.literal('operator-strategy'),
    reference: referenceSchema,
    description: descriptionSchema,
  }),
]);

export const deploymentInstanceSchema = z.strictObject({
  contractVersion: z.literal(1),
  kind: z.literal('deployment-instance'),
  capability: z.strictObject({
    id: identifierSchema,
  }),
  environment: z.strictObject({
    name: profileIdentifierSchema,
    classification: z.enum(['development', 'test', 'staging', 'production', 'other']),
  }),
  profile: z.strictObject({
    id: profileIdentifierSchema,
    dimensions: deploymentProfileDimensionsSchema,
  }),
  declaration: z.strictObject({
    repository: uriSchema,
    revision: fullGitShaSchema,
    path: z.literal(CANONICAL_CAPABILITY_DECLARATION_PATH),
  }),
  source: immutableRepositorySchema,
  artifact: deploymentArtifactSchema,
  deployment: z.strictObject({
    entrypoint: z.strictObject({
      reference: repositoryPathSchema,
      arguments: z.array(z.string().max(500)),
    }),
    parameters: z.strictObject({
      reference: referenceSchema,
      schemaId: uriSchema,
    }),
    localTrust: z
      .strictObject({
        boundary: descriptionSchema,
        provenanceVerification: z.strictObject({
          method: z.enum(['digest', 'attestation', 'package-metadata', 'provenance']),
          reference: referenceSchema,
        }),
      })
      .optional(),
    hosted: z
      .strictObject({
        authenticatedAccess: z.strictObject({
          mechanism: descriptionSchema,
          authorityReference: referenceSchema,
        }),
        readiness: z.strictObject({
          reference: referenceSchema,
          timeoutSeconds: z.number().int().min(1).max(3_600),
        }),
        versionIdentity: z.strictObject({
          reference: referenceSchema,
          expectedSourceRevision: fullGitShaSchema,
        }),
        configurationBoundsReference: referenceSchema,
        rollout: z.strictObject({
          strategy: descriptionSchema,
          maximumUnavailable: z.number().int().min(0),
          requireArtifactEvidence: z.literal(true),
        }),
      })
      .optional(),
  }),
  secrets: z.strictObject({
    provider: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('none') }),
      z.strictObject({
        kind: z.literal('external'),
        reference: referenceSchema,
      }),
    ]),
    references: z.array(
      z.strictObject({
        name: z.string().regex(secretNamePattern, 'must be a stable secret name'),
        reference: referenceSchema,
      }),
    ),
  }),
  workload: privateWorkloadSchema.optional(),
  prerequisites: z.strictObject({
    provider: z.array(namedReferenceSchema),
    identity: z
      .strictObject({
        reference: referenceSchema,
        rbac: z.array(
          z.strictObject({
            scope: descriptionSchema,
            permissions: z.array(descriptionSchema).min(1),
          }),
        ),
      })
      .optional(),
    registrations: z.array(namedReferenceSchema),
  }),
  mutation: privateMutationSchema.optional(),
  verification: z.strictObject({
    identity: z.array(verificationExpectationSchema),
    readiness: z.array(verificationExpectationSchema),
    version: z.array(verificationExpectationSchema),
    behavior: z.array(verificationExpectationSchema),
    provider: z.array(verificationExpectationSchema),
    provenance: z.array(verificationExpectationSchema),
  }),
  rollback: rollbackSchema,
  extensions: z.array(
    z.strictObject({
      schema: schemaReferenceSchema,
      parameters: z.record(z.string(), z.json()),
    }),
  ),
});

export type DeploymentProfileDimensions = z.infer<typeof deploymentProfileDimensionsSchema>;
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;
export type CapabilityProfileDeclaration = z.infer<typeof capabilityProfileDeclarationSchema>;
export type DeploymentArtifact = z.infer<typeof deploymentArtifactSchema>;
export type DeploymentInstance = z.infer<typeof deploymentInstanceSchema>;

export type ContractJsonSchema = Readonly<Record<string, unknown>>;

const jsonSchema = (
  schema: z.ZodType,
  id: string,
  title: string,
  description: string,
): ContractJsonSchema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: id,
  title,
  description,
  $comment:
    'Conditional and cross-document invariants are enforced by agent-tool-validate-deployment.',
  ...z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'ref',
  }),
});

export const capabilityProfileDeclarationJsonSchema = jsonSchema(
  capabilityProfileDeclarationSchema,
  'urn:agent-tool-platform:schema:capability-profile-declaration:v1',
  'Capability profile declaration contract v1',
  'Account-neutral public capability profiles and their shared deployment dimensions.',
);

export const deploymentInstanceJsonSchema = jsonSchema(
  deploymentInstanceSchema,
  'urn:agent-tool-platform:schema:deployment-instance:v1',
  'Deployment instance contract v1',
  'Private non-secret desired state selecting one immutable capability profile and source.',
);
