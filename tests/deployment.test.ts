import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CANONICAL_CAPABILITY_DECLARATION_PATH,
  DeploymentValidationError,
  assertDeploymentContract,
  capabilityProfileDeclarationJsonSchema,
  deploymentInstanceJsonSchema,
  validateCapabilityProfileDeclaration,
  validateDeploymentContract,
  validateDeploymentInstance,
  type ContractJsonSchema,
} from '@agent-tool-platform/runtime';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureDirectory = join(repositoryRoot, 'tests', 'fixtures', 'deployment');

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixtureDirectory, name), 'utf8')) as unknown;

const readRepositoryJson = (...path: readonly string[]): unknown =>
  JSON.parse(readFileSync(join(repositoryRoot, ...path), 'utf8')) as unknown;

const declarationFixture = readJson(CANONICAL_CAPABILITY_DECLARATION_PATH);
const localPackageFixture = readJson('local-package.deployment.json');
const hostedProviderFixture = readJson('hosted-provider.deployment.json');
const filesystemDataFixture = readJson('filesystem-data.deployment.json');

const clone = <T>(value: T): T => structuredClone(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const valueAt = (root: unknown, ...path: readonly string[]): unknown => {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current)) throw new Error(`Expected object at ${path.join('.')}`);
    current = current[segment];
  }
  return current;
};

const objectAt = (root: unknown, ...path: readonly string[]): Record<string, unknown> => {
  const value = valueAt(root, ...path);
  if (!isRecord(value)) throw new Error(`Expected object at ${path.join('.') || '(root)'}`);
  return value;
};

const arrayAt = (root: unknown, ...path: readonly string[]): unknown[] => {
  const value = valueAt(root, ...path);
  if (!Array.isArray(value)) throw new Error(`Expected array at ${path.join('.')}`);
  return value;
};

const profileAt = (declaration: unknown, id: string): Record<string, unknown> => {
  const profile = arrayAt(declaration, 'profiles').find(
    (value) => isRecord(value) && value.id === id,
  );
  if (!isRecord(profile)) throw new Error(`Missing fixture profile ${id}`);
  return profile;
};

const expectContractFailure = (declaration: unknown, instance: unknown, expected: string): void => {
  const result = validateDeploymentContract({ declaration, instance });
  expect(result.valid).toBe(false);
  expect(result.errors.join('\n')).toContain(expected);
};

const asZodJsonSchema = (schema: ContractJsonSchema): Parameters<typeof z.fromJSONSchema>[0] =>
  schema;

describe('deployment contract JSON Schemas', () => {
  it('ships the generated Draft 2020-12 declaration schema without drift', () => {
    const shipped = readRepositoryJson(
      'packages',
      'runtime',
      'schemas',
      'deployment',
      'v1',
      'capability-profile-declaration.schema.json',
    );
    expect(shipped).toEqual(capabilityProfileDeclarationJsonSchema);
    expect(capabilityProfileDeclarationJsonSchema.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(capabilityProfileDeclarationJsonSchema.$id).toBe(
      'urn:agent-tool-platform:schema:capability-profile-declaration:v1',
    );
  });

  it('ships the generated Draft 2020-12 instance schema without drift', () => {
    const shipped = JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          'packages',
          'runtime',
          'schemas',
          'deployment',
          'v1',
          'deployment-instance.schema.json',
        ),
        'utf8',
      ),
    ) as unknown;
    expect(shipped).toEqual(deploymentInstanceJsonSchema);
    expect(deploymentInstanceJsonSchema.$id).toBe(
      'urn:agent-tool-platform:schema:deployment-instance:v1',
    );
  });

  it('executes both language-neutral schemas and rejects unknown versions', () => {
    const declarationSchema = z.fromJSONSchema(
      asZodJsonSchema(capabilityProfileDeclarationJsonSchema),
    );
    const instanceSchema = z.fromJSONSchema(asZodJsonSchema(deploymentInstanceJsonSchema));

    expect(declarationSchema.safeParse(declarationFixture).success).toBe(true);
    expect(instanceSchema.safeParse(hostedProviderFixture).success).toBe(true);

    const unknownDeclaration = clone(declarationFixture);
    objectAt(unknownDeclaration).contractVersion = 2;
    const unknownInstance = clone(hostedProviderFixture);
    objectAt(unknownInstance).contractVersion = 2;
    expect(declarationSchema.safeParse(unknownDeclaration).success).toBe(false);
    expect(instanceSchema.safeParse(unknownInstance).success).toBe(false);
  });
});

describe('capability profile declaration validation', () => {
  it('accepts account-neutral local, hosted-provider, and filesystem profiles', () => {
    expect(validateCapabilityProfileDeclaration(declarationFixture)).toEqual({
      valid: true,
      errors: [],
    });

    const expectedDimensions = [
      'access',
      'delivery',
      'execution',
      'mutation',
      'provider',
      'workload',
    ];
    for (const profile of arrayAt(declarationFixture, 'profiles')) {
      expect(Object.keys(objectAt(profile, 'dimensions')).sort()).toEqual(expectedDimensions);
    }
  });

  it('rejects unknown contract versions', () => {
    const declaration = clone(declarationFixture);
    objectAt(declaration).contractVersion = 9;
    const result = validateCapabilityProfileDeclaration(declaration);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('contractVersion');

    const instance = clone(localPackageFixture);
    objectAt(instance).contractVersion = 9;
    expect(validateDeploymentInstance(instance).errors.join(' ')).toContain('contractVersion');
  });

  it('rejects contradictory execution/access and delivery declarations', () => {
    const declaration = clone(declarationFixture);
    const profile = profileAt(declaration, 'local-package');
    objectAt(profile, 'dimensions').access = 'authenticated-service';
    objectAt(profile, 'delivery').supportedForms = ['container'];

    const errors = validateCapabilityProfileDeclaration(declaration).errors.join('\n');
    expect(errors).toContain('local execution requires local-process access');
    expect(errors).toContain('must include selected delivery dimension package');

    const providerWorkload = profileAt(declaration, 'filesystem-data');
    objectAt(providerWorkload, 'dimensions').workload = 'provider';
    objectAt(providerWorkload, 'workload', 'interface').kind = 'provider';
    expect(validateCapabilityProfileDeclaration(declaration).errors.join('\n')).toContain(
      'provider workloads require an external provider',
    );
  });

  it('rejects public operator state and secret value fields', () => {
    const declaration = clone(declarationFixture);
    objectAt(declaration, 'capability').tenantId = 'synthetic-tenant';
    objectAt(declaration).secretValue = 'synthetic-sensitive-material';

    const errors = validateCapabilityProfileDeclaration(declaration).errors.join('\n');
    expect(errors).toContain('tenantId');
    expect(errors).toContain('secret values are forbidden');
  });

  it('requires hosted, provider, workload, and mutation declarations conditionally', () => {
    const declaration = clone(declarationFixture);
    const hosted = profileAt(declaration, 'hosted-provider');
    objectAt(hosted, 'configuration').bounded = false;
    hosted.providerPrerequisites = [];
    hosted.requiredSecrets = [];
    objectAt(hosted, 'identity').rbac = [];

    const filesystem = profileAt(declaration, 'filesystem-data');
    delete filesystem.workload;

    const local = profileAt(declaration, 'local-package');
    objectAt(local, 'dimensions').mutation = 'mutating';

    const errors = validateCapabilityProfileDeclaration(declaration).errors.join('\n');
    expect(errors).toContain('hosted profiles must be bounded');
    expect(errors).toContain('provider-backed profiles require prerequisites');
    expect(errors).toContain('provider-backed profiles require secret names');
    expect(errors).toContain('provider-backed profiles require scoped RBAC');
    expect(errors).toContain('workload: is required');
    expect(errors).toContain('mutating profiles require explicit mutation expectations');
  });
});

describe('deployment instance validation', () => {
  it.each([
    ['local package', localPackageFixture],
    ['hosted provider-backed', hostedProviderFixture],
    ['filesystem data', filesystemDataFixture],
  ])('accepts the %s safe fixture', (_label, instance) => {
    expect(validateDeploymentInstance(instance)).toEqual({ valid: true, errors: [] });
  });

  it('requires immutable declaration and deployed-source identities', () => {
    const missingDeclarationPin = clone(localPackageFixture);
    delete objectAt(missingDeclarationPin, 'declaration').revision;
    expect(validateDeploymentInstance(missingDeclarationPin).errors.join(' ')).toContain(
      'declaration.revision',
    );

    const mutableSource = clone(localPackageFixture);
    objectAt(mutableSource, 'source').revision = 'main';
    expect(validateDeploymentInstance(mutableSource).errors.join(' ')).toContain('source.revision');
  });

  it('rejects invalid package/container identities and source bindings', () => {
    const invalidDigest = clone(hostedProviderFixture);
    objectAt(invalidDigest, 'artifact').digest = 'latest';
    expect(validateDeploymentInstance(invalidDigest).errors.join(' ')).toContain('artifact.digest');

    const mutablePackage = clone(localPackageFixture);
    objectAt(mutablePackage, 'artifact').version = '^1.2.3';
    expect(validateDeploymentInstance(mutablePackage).errors.join(' ')).toContain(
      'exact immutable package version',
    );

    const mismatchedBinding = clone(localPackageFixture);
    objectAt(mismatchedBinding, 'artifact', 'sourceBinding').revision =
      '4444444444444444444444444444444444444444';
    expect(validateDeploymentInstance(mismatchedBinding).errors.join(' ')).toContain(
      'must match the deployed source revision',
    );
  });

  it('rejects a build-from-source desired state that fabricates a produced digest', () => {
    const instance = clone(filesystemDataFixture);
    objectAt(instance, 'artifact').digest =
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const result = validateDeploymentInstance(instance);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('digest');
  });

  it('requires hosted, provider, workload, and rollback state conditionally', () => {
    const hostedWithoutMechanics = clone(hostedProviderFixture);
    delete objectAt(hostedWithoutMechanics, 'deployment').hosted;
    expect(validateDeploymentInstance(hostedWithoutMechanics).errors.join(' ')).toContain(
      'hosted execution requirements are missing',
    );

    const providerWithoutPrerequisites = clone(hostedProviderFixture);
    objectAt(providerWithoutPrerequisites, 'prerequisites').provider = [];
    expect(validateDeploymentInstance(providerWithoutPrerequisites).errors.join(' ')).toContain(
      'provider prerequisites are required',
    );

    const filesystemWithoutWorkload = clone(filesystemDataFixture);
    delete objectAt(filesystemWithoutWorkload).workload;
    expect(validateDeploymentInstance(filesystemWithoutWorkload).errors.join(' ')).toContain(
      'instance.workload: is required',
    );

    const hostedWithoutRollback = clone(hostedProviderFixture);
    delete objectAt(hostedWithoutRollback).rollback;
    expect(validateDeploymentInstance(hostedWithoutRollback).errors.join(' ')).toContain(
      'rollback',
    );
  });

  it('rejects secret values and observed/generated evidence in desired state', () => {
    const secretValue = clone(hostedProviderFixture);
    objectAt(arrayAt(secretValue, 'secrets', 'references')[0]).value =
      'synthetic-sensitive-material';
    expect(validateDeploymentInstance(secretValue).errors.join(' ')).toContain(
      'secret values are forbidden',
    );

    const extensionSecret = clone(localPackageFixture);
    objectAt(arrayAt(extensionSecret, 'extensions')[0], 'parameters').apiKey =
      'synthetic-sensitive-material';
    expect(validateDeploymentInstance(extensionSecret).errors.join(' ')).toContain(
      'secret values are forbidden',
    );

    const observed = clone(hostedProviderFixture);
    objectAt(observed).observedEvidence = {
      producedDigest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    };
    const errors = validateDeploymentInstance(observed).errors.join(' ');
    expect(errors).toContain('observed or generated evidence is forbidden in desired state');
  });

  it('requires instance extensions to identify the selected capability as owner', () => {
    const instance = clone(localPackageFixture);
    objectAt(arrayAt(instance, 'extensions')[0], 'schema').capabilityId =
      'fixture.invalid/other-capability';

    expect(validateDeploymentInstance(instance).errors.join(' ')).toContain(
      'must be owned by capability fixture.invalid/safe-capability',
    );
  });
});

describe('cross-document deployment validation', () => {
  it.each([
    ['local package', localPackageFixture],
    ['hosted provider-backed', hostedProviderFixture],
    ['filesystem data', filesystemDataFixture],
  ])('cross-validates the %s safe fixture', (_label, instance) => {
    expect(validateDeploymentContract({ declaration: declarationFixture, instance })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('keeps declaration and deployed-source pins independent', () => {
    expect(objectAt(localPackageFixture, 'declaration').revision).not.toBe(
      objectAt(localPackageFixture, 'source').revision,
    );
    expect(
      validateDeploymentContract({
        declaration: declarationFixture,
        instance: localPackageFixture,
      }).valid,
    ).toBe(true);
  });

  it('rejects unknown profiles, capability mismatches, and selected-dimension drift', () => {
    const unknownProfile = clone(localPackageFixture);
    objectAt(unknownProfile, 'profile').id = 'not-declared';
    expectContractFailure(declarationFixture, unknownProfile, 'unknown profile not-declared');

    const wrongCapability = clone(localPackageFixture);
    objectAt(wrongCapability, 'capability').id = 'fixture.invalid/other-capability';
    expectContractFailure(declarationFixture, wrongCapability, 'instance.capability.id');

    const dimensionDrift = clone(localPackageFixture);
    objectAt(dimensionDrift, 'profile', 'dimensions').provider = 'external';
    expectContractFailure(
      declarationFixture,
      dimensionDrift,
      'instance.profile.dimensions.provider',
    );
  });

  it('enforces the exact declaration repository, canonical path, entrypoint, and config schema', () => {
    const wrongRepository = clone(localPackageFixture);
    objectAt(wrongRepository, 'declaration').repository =
      'https://code.invalid/other-capability.git';
    expectContractFailure(
      declarationFixture,
      wrongRepository,
      'must match the public declaration repository',
    );

    const wrongPath = clone(localPackageFixture);
    objectAt(wrongPath, 'declaration').path = 'other.json';
    expectContractFailure(declarationFixture, wrongPath, 'declaration.path');

    const wrongEntrypoint = clone(localPackageFixture);
    objectAt(wrongEntrypoint, 'deployment', 'entrypoint').reference = 'bin/other.js';
    expectContractFailure(
      declarationFixture,
      wrongEntrypoint,
      'must match the selected public profile entrypoint',
    );

    const wrongSchema = clone(localPackageFixture);
    objectAt(wrongSchema, 'deployment', 'parameters').schemaId =
      'urn:safe-fixture:other-configuration:v1';
    expectContractFailure(
      declarationFixture,
      wrongSchema,
      'must match the selected public configuration schema',
    );
  });

  it('enforces package/container identities, required secrets, prerequisites, and verification', () => {
    const declaration = clone(declarationFixture);
    objectAt(profileAt(declaration, 'local-package'), 'delivery', 'publication').identifier =
      'safe-fixture/other-package';
    expectContractFailure(declaration, localPackageFixture, 'public package identity');

    const missingSecret = clone(hostedProviderFixture);
    objectAt(missingSecret, 'secrets').references = [];
    expectContractFailure(declarationFixture, missingSecret, 'require secret references');

    const missingPrerequisite = clone(hostedProviderFixture);
    objectAt(missingPrerequisite, 'prerequisites').provider = [
      {
        id: 'other-prerequisite',
        reference: 'provider-prerequisite:fixture/other',
      },
    ];
    expectContractFailure(
      declarationFixture,
      missingPrerequisite,
      'missing declared prerequisite fixture-api-enabled',
    );

    const missingProviderVerification = clone(hostedProviderFixture);
    objectAt(missingProviderVerification, 'verification').provider = [];
    expectContractFailure(
      declarationFixture,
      missingProviderVerification,
      'instance.verification.provider',
    );
  });

  it('validates identified capability-owned extensions without interpreting domain parameters', () => {
    expect(
      validateDeploymentContract({
        declaration: declarationFixture,
        instance: localPackageFixture,
      }).valid,
    ).toBe(true);

    const instance = clone(localPackageFixture);
    objectAt(arrayAt(instance, 'extensions')[0], 'schema').id =
      'urn:safe-fixture:undeclared-extension:v1';
    expectContractFailure(declarationFixture, instance, 'is not declared by selected profile');
  });

  it('composes mutating-profile enablement, authorization, records, and verification', () => {
    const declaration = clone(declarationFixture);
    const hosted = profileAt(declaration, 'hosted-provider');
    objectAt(hosted, 'dimensions').mutation = 'mutating';
    hosted.mutation = {
      enablement: 'separate',
      authorization: 'Require an explicitly authorized fixture principal.',
      confirmation: 'Require explicit confirmation for each synthetic mutation.',
      durableRecord: 'required',
      authoritativeVerification: 'Verify the synthetic record at its authoritative source.',
    };

    const instance = clone(hostedProviderFixture);
    objectAt(instance, 'profile', 'dimensions').mutation = 'mutating';
    objectAt(instance).mutation = {
      enablement: {
        default: 'disabled',
        reference: 'operator-git:fixtures/hosted/mutation-enablement.json',
      },
      authorization: {
        reference: 'operator-git:fixtures/hosted/mutation-authorization.json',
      },
      confirmation: {
        reference: 'operator-git:fixtures/hosted/mutation-confirmation.json',
      },
      durableRecord: {
        reference: 'record-store:fixture/non-live-mutations',
      },
      authoritativeVerification: {
        expectation: 'Verify the synthetic mutation at the non-live authoritative source.',
      },
    };

    expect(validateDeploymentContract({ declaration, instance }).valid).toBe(true);

    delete objectAt(instance, 'mutation').durableRecord;
    expectContractFailure(declaration, instance, 'selected profile requires a durable record');
  });

  it('throws a deterministic aggregate error from the assertion surface', () => {
    const invalid = clone(localPackageFixture);
    objectAt(invalid, 'profile').id = 'not-declared';
    expect(() =>
      assertDeploymentContract({ declaration: declarationFixture, instance: invalid }),
    ).toThrow(DeploymentValidationError);
  });
});
