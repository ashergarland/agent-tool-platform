import type { z } from 'zod';
import {
  capabilityProfileDeclarationSchema,
  deploymentInstanceSchema,
  type CapabilityProfile,
  type CapabilityProfileDeclaration,
  type DeploymentInstance,
  type DeploymentProfileDimensions,
} from './schemas.js';

export interface DeploymentValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface DeploymentContractValidationInput {
  readonly declaration: unknown;
  readonly instance?: unknown;
}

type ParsedDocument<T> =
  | {
      readonly structurallyValid: true;
      readonly valid: boolean;
      readonly data: T;
      readonly errors: readonly string[];
    }
  | {
      readonly structurallyValid: false;
      readonly valid: false;
      readonly errors: readonly string[];
    };

const dimensionNames = [
  'execution',
  'delivery',
  'access',
  'workload',
  'provider',
  'mutation',
] as const satisfies readonly (keyof DeploymentProfileDimensions)[];

const normalizeField = (value: string): string => value.replace(/[^a-z0-9]/giu, '').toLowerCase();

const secretValueFields = new Set([
  'accesskey',
  'accesskeyvalue',
  'accesstoken',
  'apikey',
  'apikeyvalue',
  'bearertoken',
  'clientsecret',
  'clientsecretvalue',
  'credential',
  'credentials',
  'secret',
  'secrettext',
  'secretvalue',
  'secretvalues',
  'plaintextsecret',
  'password',
  'passwordvalue',
  'refreshtoken',
  'token',
  'tokenvalue',
  'credentialvalue',
  'privatekey',
  'privatekeyvalue',
  'connectionstring',
  'connectionstringvalue',
]);

const secretContexts = [
  'secret',
  'password',
  'token',
  'credential',
  'privatekey',
  'connectionstring',
];

const observedFields = new Set([
  'actualdigest',
  'deploymentevidence',
  'deploymentstatus',
  'drift',
  'generatedevidence',
  'lastobservedat',
  'observed',
  'observedevidence',
  'produceddigest',
]);

const inspectForbiddenFields = (
  document: unknown,
  label: string,
  rejectObserved: boolean,
): string[] => {
  const errors: string[] = [];
  const visited = new WeakSet<object>();

  const visit = (value: unknown, path: readonly string[]): void => {
    if (value === null || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeField(key);
      const fieldPath = [...path, key];
      const parentIsSecretContext = path.some((part) => {
        const normalizedPart = normalizeField(part);
        return secretContexts.some((context) => normalizedPart.includes(context));
      });
      const directSecretValue =
        secretValueFields.has(normalized) && (child === null || typeof child !== 'object');
      const evidenceRequirement =
        normalized === 'produceddigest' &&
        normalizeField(path.at(-1) ?? '') === 'requiredevidence' &&
        child === true;

      if (directSecretValue || (normalized === 'value' && parentIsSecretContext)) {
        errors.push(`${label}: ${fieldPath.join('.')}: secret values are forbidden`);
      }
      if (rejectObserved && observedFields.has(normalized) && !evidenceRequirement) {
        errors.push(
          `${label}: ${fieldPath.join('.')}: observed or generated evidence is forbidden in desired state`,
        );
      }

      visit(child, fieldPath);
    }
  };

  visit(document, []);
  return errors;
};

const formatIssues = (label: string, error: z.ZodError): string[] =>
  error.issues.map((issue) => `${label}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);

const duplicates = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }
  return [...duplicateValues];
};

const requireSurface = (
  profile: CapabilityProfile,
  surface: CapabilityProfile['verification']['surfaces'][number],
  errors: string[],
  path: string,
): void => {
  if (!profile.verification.surfaces.includes(surface)) {
    errors.push(`${path}.verification.surfaces: ${surface} verification is required`);
  }
};

const validateProfile = (
  profile: CapabilityProfile,
  capabilityId: string,
  path: string,
  errors: string[],
): void => {
  const { dimensions } = profile;

  if (!profile.delivery.supportedForms.includes(dimensions.delivery)) {
    errors.push(
      `${path}.delivery.supportedForms: must include selected delivery dimension ${dimensions.delivery}`,
    );
  }
  if (profile.delivery.publication.kind !== dimensions.delivery) {
    errors.push(
      `${path}.delivery.publication.kind: must match selected delivery dimension ${dimensions.delivery}`,
    );
  }
  if (dimensions.execution === 'local' && dimensions.access !== 'local-process') {
    errors.push(`${path}.dimensions.access: local execution requires local-process access`);
  }
  if (dimensions.execution === 'hosted' && dimensions.access !== 'authenticated-service') {
    errors.push(
      `${path}.dimensions.access: hosted execution requires authenticated-service access`,
    );
  }
  if (dimensions.workload === 'provider' && dimensions.provider !== 'external') {
    errors.push(`${path}.dimensions.provider: provider workloads require an external provider`);
  }
  if (profile.configuration.schema.capabilityId !== capabilityId) {
    errors.push(
      `${path}.configuration.schema.capabilityId: must match declaration capability ${capabilityId}`,
    );
  }

  for (const schema of profile.extensionSchemas) {
    if (schema.capabilityId !== capabilityId) {
      errors.push(
        `${path}.extensionSchemas: schema ${schema.id} must be owned by capability ${capabilityId}`,
      );
    }
  }

  for (const value of duplicates(profile.delivery.supportedForms)) {
    errors.push(`${path}.delivery.supportedForms: duplicate delivery form ${value}`);
  }
  for (const value of duplicates(profile.requiredSecrets)) {
    errors.push(`${path}.requiredSecrets: duplicate secret name ${value}`);
  }
  for (const value of duplicates(profile.providerPrerequisites.map(({ id }) => id))) {
    errors.push(`${path}.providerPrerequisites: duplicate prerequisite ${value}`);
  }
  for (const value of duplicates(profile.extensionSchemas.map(({ id }) => id))) {
    errors.push(`${path}.extensionSchemas: duplicate schema id ${value}`);
  }
  for (const value of duplicates(profile.verification.surfaces)) {
    errors.push(`${path}.verification.surfaces: duplicate verification surface ${value}`);
  }

  requireSurface(profile, 'behavior', errors, path);
  requireSurface(profile, 'provenance', errors, path);

  if (dimensions.execution === 'hosted') {
    if (!profile.configuration.bounded) {
      errors.push(`${path}.configuration.bounded: hosted profiles must be bounded`);
    }
    for (const surface of ['identity', 'readiness', 'version'] as const) {
      requireSurface(profile, surface, errors, path);
    }
  }

  if (dimensions.workload === 'none') {
    if (profile.workload !== undefined) {
      errors.push(`${path}.workload: must be omitted when the workload dimension is none`);
    }
  } else if (profile.workload === undefined) {
    errors.push(
      `${path}.workload: is required when the workload dimension is ${dimensions.workload}`,
    );
  } else if (profile.workload.interface.kind !== dimensions.workload) {
    errors.push(
      `${path}.workload.interface.kind: must match workload dimension ${dimensions.workload}`,
    );
  } else {
    requireSurface(profile, 'readiness', errors, path);
  }

  if (dimensions.provider === 'none') {
    if (profile.providerPrerequisites.length > 0) {
      errors.push(
        `${path}.providerPrerequisites: must be empty when the provider dimension is none`,
      );
    }
  } else {
    if (profile.providerPrerequisites.length === 0) {
      errors.push(`${path}.providerPrerequisites: provider-backed profiles require prerequisites`);
    }
    if (profile.requiredSecrets.length === 0) {
      errors.push(`${path}.requiredSecrets: provider-backed profiles require secret names`);
    }
    if (profile.identity.rbac.length === 0) {
      errors.push(`${path}.identity.rbac: provider-backed profiles require scoped RBAC`);
    }
    for (const surface of ['identity', 'readiness', 'provider'] as const) {
      requireSurface(profile, surface, errors, path);
    }
  }

  if (dimensions.mutation === 'read-only') {
    if (profile.mutation !== undefined) {
      errors.push(`${path}.mutation: must be omitted for read-only profiles`);
    }
  } else if (profile.mutation === undefined) {
    errors.push(`${path}.mutation: mutating profiles require explicit mutation expectations`);
  }
};

const parseDeclaration = (document: unknown): ParsedDocument<CapabilityProfileDeclaration> => {
  const errors = inspectForbiddenFields(document, 'declaration', false);
  const parsed = capabilityProfileDeclarationSchema.safeParse(document);
  if (!parsed.success) {
    return {
      structurallyValid: false,
      valid: false,
      errors: [...errors, ...formatIssues('declaration', parsed.error)],
    };
  }

  for (const value of duplicates(parsed.data.profiles.map(({ id }) => id))) {
    errors.push(`declaration.profiles: duplicate profile id ${value}`);
  }
  parsed.data.profiles.forEach((profile, index) =>
    validateProfile(profile, parsed.data.capability.id, `declaration.profiles.${index}`, errors),
  );

  return {
    structurallyValid: true,
    valid: errors.length === 0,
    data: parsed.data,
    errors,
  };
};

const requireVerification = (
  instance: DeploymentInstance,
  surface: keyof DeploymentInstance['verification'],
  errors: string[],
): void => {
  if (instance.verification[surface].length === 0) {
    errors.push(`instance.verification.${surface}: at least one expectation is required`);
  }
};

const validateArtifactForDelivery = (instance: DeploymentInstance, errors: string[]): void => {
  const delivery = instance.profile.dimensions.delivery;
  const { artifact } = instance;

  if (delivery === 'source' && artifact.kind !== 'build-from-source') {
    errors.push('instance.artifact: source delivery requires an explicit build-from-source plan');
  }
  if (
    delivery === 'package' &&
    !(
      artifact.kind === 'package' ||
      (artifact.kind === 'build-from-source' && artifact.expectedArtifactKind === 'package')
    )
  ) {
    errors.push(
      'instance.artifact: package delivery requires an immutable package or a package build plan',
    );
  }
  if (
    delivery === 'container' &&
    !(
      artifact.kind === 'container' ||
      (artifact.kind === 'build-from-source' && artifact.expectedArtifactKind === 'container')
    )
  ) {
    errors.push(
      'instance.artifact: container delivery requires an immutable container or a container build plan',
    );
  }

  if (
    artifact.kind !== 'build-from-source' &&
    artifact.sourceBinding.revision !== instance.source.revision
  ) {
    errors.push(
      'instance.artifact.sourceBinding.revision: must match the deployed source revision',
    );
  }
};

const parseInstance = (document: unknown): ParsedDocument<DeploymentInstance> => {
  const errors = inspectForbiddenFields(document, 'instance', true);
  const parsed = deploymentInstanceSchema.safeParse(document);
  if (!parsed.success) {
    return {
      structurallyValid: false,
      valid: false,
      errors: [...errors, ...formatIssues('instance', parsed.error)],
    };
  }

  const instance = parsed.data;
  const { dimensions } = instance.profile;

  validateArtifactForDelivery(instance, errors);

  if (dimensions.workload === 'provider' && dimensions.provider !== 'external') {
    errors.push(
      'instance.profile.dimensions.provider: provider workloads require an external provider',
    );
  }

  for (const value of duplicates(instance.secrets.references.map(({ name }) => name))) {
    errors.push(`instance.secrets.references: duplicate secret reference ${value}`);
  }
  for (const value of duplicates(instance.prerequisites.provider.map(({ id }) => id))) {
    errors.push(`instance.prerequisites.provider: duplicate prerequisite ${value}`);
  }
  for (const value of duplicates(instance.extensions.map(({ schema }) => schema.id))) {
    errors.push(`instance.extensions: duplicate extension schema ${value}`);
  }
  for (const extension of instance.extensions) {
    if (extension.schema.capabilityId !== instance.capability.id) {
      errors.push(
        `instance.extensions: schema ${extension.schema.id} must be owned by capability ${instance.capability.id}`,
      );
    }
  }

  if (instance.secrets.references.length === 0 && instance.secrets.provider.kind !== 'none') {
    errors.push('instance.secrets.provider: must be none when no secret references are selected');
  }
  if (instance.secrets.references.length > 0 && instance.secrets.provider.kind !== 'external') {
    errors.push('instance.secrets.provider: secret references require an external secret provider');
  }

  if (dimensions.execution === 'local') {
    if (dimensions.access !== 'local-process') {
      errors.push('instance.profile.dimensions.access: local execution requires local-process');
    }
    if (instance.deployment.localTrust === undefined) {
      errors.push('instance.deployment.localTrust: local execution requires a trust boundary');
    }
    if (instance.deployment.hosted !== undefined) {
      errors.push('instance.deployment.hosted: must be omitted for local execution');
    }
  } else {
    if (dimensions.access !== 'authenticated-service') {
      errors.push(
        'instance.profile.dimensions.access: hosted execution requires authenticated-service',
      );
    }
    if (instance.deployment.hosted === undefined) {
      errors.push('instance.deployment.hosted: hosted execution requirements are missing');
    } else if (
      instance.deployment.hosted.versionIdentity.expectedSourceRevision !== instance.source.revision
    ) {
      errors.push(
        'instance.deployment.hosted.versionIdentity.expectedSourceRevision: must match deployed source',
      );
    }
    if (instance.deployment.localTrust !== undefined) {
      errors.push('instance.deployment.localTrust: must be omitted for hosted execution');
    }
    if (instance.prerequisites.identity === undefined) {
      errors.push('instance.prerequisites.identity: hosted execution requires service identity');
    }
    for (const surface of ['identity', 'readiness', 'version'] as const) {
      requireVerification(instance, surface, errors);
    }
  }

  requireVerification(instance, 'behavior', errors);
  requireVerification(instance, 'provenance', errors);

  if (dimensions.workload === 'none') {
    if (instance.workload !== undefined) {
      errors.push('instance.workload: must be omitted when the workload dimension is none');
    }
  } else if (instance.workload === undefined) {
    errors.push(
      `instance.workload: is required when the workload dimension is ${dimensions.workload}`,
    );
  } else if (instance.workload.kind !== dimensions.workload) {
    errors.push(`instance.workload.kind: must match workload dimension ${dimensions.workload}`);
  } else {
    requireVerification(instance, 'readiness', errors);
  }

  if (dimensions.provider === 'none') {
    if (instance.prerequisites.provider.length > 0) {
      errors.push(
        'instance.prerequisites.provider: must be empty when the provider dimension is none',
      );
    }
  } else {
    if (instance.prerequisites.provider.length === 0) {
      errors.push('instance.prerequisites.provider: provider prerequisites are required');
    }
    if (instance.prerequisites.identity === undefined) {
      errors.push('instance.prerequisites.identity: provider-backed profiles require identity');
    } else if (instance.prerequisites.identity.rbac.length === 0) {
      errors.push('instance.prerequisites.identity.rbac: provider-backed profiles require RBAC');
    }
    if (instance.secrets.references.length === 0) {
      errors.push(
        'instance.secrets.references: provider-backed profiles require secret references',
      );
    }
    requireVerification(instance, 'provider', errors);
    requireVerification(instance, 'readiness', errors);
  }

  if (dimensions.mutation === 'read-only') {
    if (instance.mutation !== undefined) {
      errors.push('instance.mutation: must be omitted for read-only profiles');
    }
  } else if (instance.mutation === undefined) {
    errors.push('instance.mutation: mutating profiles require separate mutation enablement');
  }

  return {
    structurallyValid: true,
    valid: errors.length === 0,
    data: instance,
    errors,
  };
};

const sameSchemaReference = (
  left: CapabilityProfile['configuration']['schema'],
  right: DeploymentInstance['extensions'][number]['schema'],
): boolean =>
  left.id === right.id && left.capabilityId === right.capabilityId && left.path === right.path;

const crossValidate = (
  declaration: CapabilityProfileDeclaration,
  instance: DeploymentInstance,
): string[] => {
  const errors: string[] = [];

  if (instance.capability.id !== declaration.capability.id) {
    errors.push(
      `instance.capability.id: expected ${declaration.capability.id}, found ${instance.capability.id}`,
    );
  }
  if (instance.declaration.repository !== declaration.capability.repository) {
    errors.push('instance.declaration.repository: must match the public declaration repository');
  }
  const profile = declaration.profiles.find(({ id }) => id === instance.profile.id);
  if (profile === undefined) {
    errors.push(
      `instance.profile.id: unknown profile ${instance.profile.id} for capability ${declaration.capability.id}`,
    );
    return errors;
  }

  for (const dimension of dimensionNames) {
    if (instance.profile.dimensions[dimension] !== profile.dimensions[dimension]) {
      errors.push(
        `instance.profile.dimensions.${dimension}: expected ${profile.dimensions[dimension]}, found ${instance.profile.dimensions[dimension]}`,
      );
    }
  }

  if (instance.deployment.entrypoint.reference !== profile.delivery.entrypoint.reference) {
    errors.push(
      'instance.deployment.entrypoint.reference: must match the selected public profile entrypoint',
    );
  }
  if (instance.deployment.parameters.schemaId !== profile.configuration.schema.id) {
    errors.push(
      'instance.deployment.parameters.schemaId: must match the selected public configuration schema',
    );
  }
  if (
    instance.deployment.localTrust !== undefined &&
    instance.deployment.localTrust.boundary !== profile.identity.trustBoundary
  ) {
    errors.push(
      'instance.deployment.localTrust.boundary: must match the selected public trust boundary',
    );
  }

  const selectedSecrets = [...instance.secrets.references.map(({ name }) => name)].sort();
  const requiredSecrets = [...profile.requiredSecrets].sort();
  if (
    selectedSecrets.length !== requiredSecrets.length ||
    selectedSecrets.some((name, index) => name !== requiredSecrets[index])
  ) {
    errors.push(
      'instance.secrets.references: names must exactly match the selected profile requiredSecrets',
    );
  }

  const selectedPrerequisites = new Set(instance.prerequisites.provider.map(({ id }) => id));
  for (const prerequisite of profile.providerPrerequisites) {
    if (!selectedPrerequisites.has(prerequisite.id)) {
      errors.push(
        `instance.prerequisites.provider: missing declared prerequisite ${prerequisite.id}`,
      );
    }
  }

  const selectedPermissions = new Set(
    instance.prerequisites.identity?.rbac.flatMap(({ permissions }) => permissions) ?? [],
  );
  for (const expectation of profile.identity.rbac) {
    if (!selectedPermissions.has(expectation)) {
      errors.push(`instance.prerequisites.identity.rbac: missing expectation ${expectation}`);
    }
  }

  for (const surface of profile.verification.surfaces) {
    if (surface !== 'provenance' && instance.verification[surface].length === 0) {
      errors.push(
        `instance.verification.${surface}: selected profile requires this verification surface`,
      );
    }
  }

  if (
    profile.delivery.publication.kind === 'package' &&
    instance.artifact.kind === 'package' &&
    instance.artifact.identifier !== profile.delivery.publication.identifier
  ) {
    errors.push('instance.artifact.identifier: must match the public package identity');
  }
  if (
    profile.delivery.publication.kind === 'container' &&
    instance.artifact.kind === 'container' &&
    instance.artifact.image !== profile.delivery.publication.identifier
  ) {
    errors.push('instance.artifact.image: must match the public container identity');
  }
  if (
    profile.delivery.publication.kind === 'source' &&
    instance.artifact.kind === 'build-from-source' &&
    instance.artifact.buildEntrypoint !== profile.delivery.publication.buildReference
  ) {
    errors.push('instance.artifact.buildEntrypoint: must match the public build reference');
  }

  if (
    profile.mutation?.durableRecord === 'required' &&
    instance.mutation?.durableRecord === undefined
  ) {
    errors.push('instance.mutation.durableRecord: selected profile requires a durable record');
  }

  for (const extension of instance.extensions) {
    const declared = profile.extensionSchemas.some((schema) =>
      sameSchemaReference(schema, extension.schema),
    );
    if (!declared) {
      errors.push(
        `instance.extensions: schema ${extension.schema.id} is not declared by selected profile ${profile.id}`,
      );
    }
  }

  return errors;
};

export const validateCapabilityProfileDeclaration = (
  declaration: unknown,
): DeploymentValidationResult => {
  const parsed = parseDeclaration(declaration);
  return { valid: parsed.valid, errors: parsed.errors };
};

export const validateDeploymentInstance = (instance: unknown): DeploymentValidationResult => {
  const parsed = parseInstance(instance);
  return { valid: parsed.valid, errors: parsed.errors };
};

export const validateDeploymentContract = (
  input: DeploymentContractValidationInput,
): DeploymentValidationResult => {
  const declaration = parseDeclaration(input.declaration);
  if (input.instance === undefined) {
    return { valid: declaration.valid, errors: declaration.errors };
  }

  const instance = parseInstance(input.instance);
  const errors = [...declaration.errors, ...instance.errors];
  if (declaration.structurallyValid && instance.structurallyValid) {
    errors.push(...crossValidate(declaration.data, instance.data));
  }
  return { valid: errors.length === 0, errors };
};

export class DeploymentValidationError extends Error {
  public override readonly name = 'DeploymentValidationError';

  public constructor(public readonly errors: readonly string[]) {
    super(`Deployment contract is invalid:\n- ${errors.join('\n- ')}`);
  }
}

export const assertCapabilityProfileDeclaration = (declaration: unknown): void => {
  const result = validateCapabilityProfileDeclaration(declaration);
  if (!result.valid) throw new DeploymentValidationError(result.errors);
};

export const assertDeploymentInstance = (instance: unknown): void => {
  const result = validateDeploymentInstance(instance);
  if (!result.valid) throw new DeploymentValidationError(result.errors);
};

export const assertDeploymentContract = (input: DeploymentContractValidationInput): void => {
  const result = validateDeploymentContract(input);
  if (!result.valid) throw new DeploymentValidationError(result.errors);
};
