import { validateDeploymentContract } from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from '../harness.js';

export interface DeploymentContractConformanceOptions extends ConformanceOptions {
  readonly declaration: unknown;
  readonly instance?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const withRootField = (document: unknown, patch: Record<string, unknown>): unknown => ({
  ...(isRecord(document) ? document : {}),
  ...patch,
});

export const runDeploymentContractConformance = (
  options: DeploymentContractConformanceOptions,
): ConformanceResult => {
  const run = new ConformanceRun('deployment contract');
  const actual = validateDeploymentContract({
    declaration: options.declaration,
    ...(options.instance === undefined ? {} : { instance: options.instance }),
  });
  run.check('the supplied deployment contract is valid', actual.valid, actual.errors.join('; '));

  const unknownVersion = validateDeploymentContract({
    declaration: withRootField(options.declaration, { contractVersion: 999 }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
  });
  run.check('unknown contract versions are rejected', !unknownVersion.valid);

  const publicSecretValue = validateDeploymentContract({
    declaration: withRootField(options.declaration, {
      secretValue: 'synthetic-sensitive-material',
    }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
  });
  run.check('secret value fields are rejected', !publicSecretValue.valid);

  if (options.instance !== undefined) {
    const instance = structuredClone(options.instance);
    const profile = isRecord(instance) && isRecord(instance.profile) ? instance.profile : undefined;
    if (profile !== undefined) profile.id = 'profile-not-declared';

    const unknownProfile = validateDeploymentContract({
      declaration: options.declaration,
      instance,
    });
    run.check(
      'unknown selected profiles are rejected',
      profile !== undefined && !unknownProfile.valid,
      profile === undefined ? 'deployment instance has no profile object' : undefined,
    );

    const observed = validateDeploymentContract({
      declaration: options.declaration,
      instance: withRootField(options.instance, {
        observedEvidence: { state: 'synthetic' },
      }),
    });
    run.check('observed evidence is rejected from desired state', !observed.valid);
  }

  return run.finish(options);
};
