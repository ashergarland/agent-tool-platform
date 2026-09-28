import {
  NpmArtifactMaterializationError,
  materializeNpmLocalArtifact,
  verifyNpmLocalArtifact,
  type NpmArtifactMaterializationOptions,
  type NpmLocalArtifactSpec,
} from '@agent-tool-platform/runtime';
import { createPreparedArtifactRealization } from './prepared-artifact.js';
import type { PreparationDriver, PreparationDriverResult } from './preparation.js';
import {
  isMaterializableResolvedNpmArtifact,
  type MaterializableResolvedNpmArtifact,
} from './schemas.js';

export type NpmLocalArtifactPreparationDriverOptions = NpmArtifactMaterializationOptions;

const materializationSpec = (
  artifact: MaterializableResolvedNpmArtifact,
): NpmLocalArtifactSpec => ({
  packageName: artifact.identifier,
  version: artifact.version,
  binName: artifact.localExecution.bin,
  integrity: artifact.localExecution.integrity,
  lifecycleScripts: artifact.localExecution.lifecycleScripts,
});

const unavailableReason = (
  error: NpmArtifactMaterializationError,
): NonNullable<PreparationDriverResult['reason']> => {
  switch (error.code) {
    case 'corrupt-installation':
      return 'artifact-corrupt';
    case 'integrity-mismatch':
      return 'artifact-integrity-mismatch';
    case 'limit-exceeded':
      return 'artifact-limit-exceeded';
    case 'materialization-failed':
      return 'artifact-materialization-failed';
    case 'invalid-input':
      return 'artifact-input-invalid';
    case 'not-materialized':
      return 'artifact-not-materialized';
  }
};

export const createNpmLocalArtifactPreparationDriver = (
  options: NpmLocalArtifactPreparationDriverOptions,
): PreparationDriver => ({
  async execute(request): Promise<PreparationDriverResult> {
    if (
      request.action.kind !== 'verify-local-artifact' &&
      request.action.kind !== 'make-local-artifact-available'
    ) {
      return { status: 'setup-required', reason: 'unsupported-preparation-action' };
    }

    const artifact = request.action.artifact;
    if (!isMaterializableResolvedNpmArtifact(artifact)) {
      return { status: 'setup-required', reason: 'artifact-not-materializable' };
    }
    const spec = materializationSpec(artifact);

    try {
      const result =
        request.action.kind === 'verify-local-artifact'
          ? await verifyNpmLocalArtifact(spec, options)
          : await materializeNpmLocalArtifact(spec, options);
      const artifactRealization = createPreparedArtifactRealization({
        binding: request.action.binding,
        artifact,
        disposition:
          result.disposition === 'materialized' ? 'newly-materialized' : 'already-materialized',
        materialization: {
          kind: 'npm',
          layout: result.layout,
        },
        launch: result.launch,
        verification: result.verification,
      });
      return {
        status: result.disposition === 'materialized' ? 'success' : 'already-ready',
        artifactRealization,
      };
    } catch (error) {
      if (!(error instanceof NpmArtifactMaterializationError)) throw error;
      if (error.code === 'not-materialized') {
        return { status: 'setup-required', reason: unavailableReason(error) };
      }
      return { status: 'unavailable', reason: unavailableReason(error) };
    }
  },
});
