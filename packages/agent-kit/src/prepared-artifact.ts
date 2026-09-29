import { z } from 'zod';
import { npmArtifactLayoutIdentity } from '@agent-tool-platform/runtime';
import { digestCanonicalJson } from './canonical-json.js';
import { AgentKitError, formatZodIssues } from './errors.js';
import {
  exactVersionSchema,
  materializableResolvedNpmArtifactSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type MaterializableResolvedNpmArtifact,
} from './schemas.js';

export const PREPARED_ARTIFACT_REALIZATION_SCHEMA_VERSION = 1;

export const artifactPreparationBindingSchema = z.strictObject({
  key: z.string().min(1).max(600).regex(/^\S+$/u),
  capabilityId: stableIdentifierSchema,
  capabilityVersion: exactVersionSchema,
  profileId: z.string().min(1).max(100),
  mode: z.enum(['local', 'remote', 'hybrid']),
});

const absoluteLocalPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^(?:[A-Za-z]:[\\/]|\/)(?!.*[\0\r\n]).+/u, 'must be an absolute local path');

const materializationLayoutSchema = z
  .string()
  .regex(
    /^artifacts\/npm\/sha256-[0-9a-f]{64}$/u,
    'must be an identity-derived portable npm layout',
  );

export const preparedNodeLaunchSchema = z.strictObject({
  kind: z.literal('node'),
  executablePath: absoluteLocalPathSchema,
  entrypointPath: absoluteLocalPathSchema,
});

const realizationIdentity = (
  realization: Omit<PreparedArtifactRealization, 'realizationId' | 'disposition'>,
): Readonly<Record<string, unknown>> => ({
  schemaVersion: realization.schemaVersion,
  binding: realization.binding,
  artifact: realization.artifact,
  materialization: realization.materialization,
  launch: realization.launch,
  verification: realization.verification,
});

export const preparedArtifactRealizationSchema = z
  .strictObject({
    schemaVersion: z.literal(PREPARED_ARTIFACT_REALIZATION_SCHEMA_VERSION),
    realizationId: sha256DigestSchema,
    binding: artifactPreparationBindingSchema,
    artifact: materializableResolvedNpmArtifactSchema,
    disposition: z.enum(['newly-materialized', 'already-materialized']),
    materialization: z.strictObject({
      kind: z.literal('npm'),
      layout: materializationLayoutSchema,
    }),
    launch: preparedNodeLaunchSchema,
    verification: z.strictObject({
      status: z.literal('verified'),
      integrity: z.string().max(95),
      installationDigest: sha256DigestSchema,
      fileCount: z.number().int().nonnegative().max(50_000),
      totalBytes: z
        .number()
        .int()
        .nonnegative()
        .max(500 * 1024 * 1024),
    }),
  })
  .superRefine((realization, context) => {
    const expectedLayout = npmArtifactLayoutIdentity({
      packageName: realization.artifact.identifier,
      version: realization.artifact.version,
      binName: realization.artifact.localExecution.bin,
      integrity: realization.artifact.localExecution.integrity,
      lifecycleScripts: realization.artifact.localExecution.lifecycleScripts,
    });
    if (realization.materialization.layout !== expectedLayout) {
      context.addIssue({
        code: 'custom',
        path: ['materialization', 'layout'],
        message: 'does not match the locked npm artifact identity',
      });
    }
    if (realization.verification.integrity !== realization.artifact.localExecution.integrity) {
      context.addIssue({
        code: 'custom',
        path: ['verification', 'integrity'],
        message: 'does not match the locked npm artifact integrity',
      });
    }
    const expectedId = digestCanonicalJson(realizationIdentity(realization));
    if (realization.realizationId !== expectedId) {
      context.addIssue({
        code: 'custom',
        path: ['realizationId'],
        message: 'does not match the verified executable realization',
      });
    }
  });

export type ArtifactPreparationBinding = z.infer<typeof artifactPreparationBindingSchema>;
export type PreparedNodeLaunch = z.infer<typeof preparedNodeLaunchSchema>;
export type PreparedArtifactRealization = z.infer<typeof preparedArtifactRealizationSchema>;

export interface CreatePreparedArtifactRealizationInput {
  readonly binding: ArtifactPreparationBinding;
  readonly artifact: MaterializableResolvedNpmArtifact;
  readonly disposition: PreparedArtifactRealization['disposition'];
  readonly materialization: PreparedArtifactRealization['materialization'];
  readonly launch: PreparedNodeLaunch;
  readonly verification: PreparedArtifactRealization['verification'];
}

export const createPreparedArtifactRealization = (
  input: CreatePreparedArtifactRealizationInput,
): PreparedArtifactRealization => {
  const identity = {
    schemaVersion: PREPARED_ARTIFACT_REALIZATION_SCHEMA_VERSION,
    binding: input.binding,
    artifact: input.artifact,
    materialization: input.materialization,
    launch: input.launch,
    verification: input.verification,
  } as const;
  const parsed = preparedArtifactRealizationSchema.safeParse({
    ...identity,
    realizationId: digestCanonicalJson(identity),
    disposition: input.disposition,
  });
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_PREPARATION_RESULT',
      'Prepared artifact realization is invalid.',
      formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
};
