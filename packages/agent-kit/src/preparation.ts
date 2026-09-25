import { z } from 'zod';
import type { AgentBuild } from './build.js';
import { compareCodeUnits, digestCanonicalJson } from './canonical-json.js';
import { AgentKitError, formatZodIssues } from './errors.js';
import type { GeneratedHostFile } from './host-adapter.js';
import { composeInstructions } from './instructions.js';
import {
  agentInstanceSeamSchema,
  createPreparedAgentInstanceIdentity,
  parsePreparedAgentInstance,
  type AgentInstanceSeam,
  type AgentInstanceState,
  type PreparedAgentInstance,
  type PreparedAgentInstanceIdentity,
} from './instance.js';
import { digestAgentLock, serializeAgentLock } from './lock.js';
import {
  createReadinessPlan,
  readinessPlanSchema,
  readinessSnapshotSchema,
  type ReadinessPlan,
  type ReadinessSnapshot,
} from './readiness.js';
import {
  capabilityBindingKey,
  type AgentResolution,
  type ResolvedCapability,
} from './resolution.js';
import {
  agentDefinitionSchema,
  agentLockSchema,
  exactVersionSchema,
  resolvedCapabilityArtifactSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type AgentDefinition,
  type AgentLock,
  type CapabilitySelection,
} from './schemas.js';

export const PREPARATION_SCHEMA_VERSION = 1;

const bindingTargetSchema = z.strictObject({
  key: z.string().min(1).max(600).regex(/^\S+$/u),
  capabilityId: stableIdentifierSchema,
  capabilityVersion: exactVersionSchema,
  profileId: z.string().min(1).max(100),
  mode: z.enum(['local', 'remote', 'hybrid']),
});

const actionCommonShape = {
  actionId: sha256DigestSchema,
  binding: bindingTargetSchema,
} as const;

const localArtifactActionSchema = z.strictObject({
  ...actionCommonShape,
  kind: z.enum(['verify-local-artifact', 'make-local-artifact-available']),
  artifact: resolvedCapabilityArtifactSchema,
});

const configurationActionSchema = z.strictObject({
  ...actionCommonShape,
  kind: z.literal('verify-configuration'),
  configurationName: z.string().min(1).max(200),
});

const remoteConnectionActionSchema = z.strictObject({
  ...actionCommonShape,
  kind: z.literal('verify-remote-connection'),
});

const providerPrerequisiteActionSchema = z.strictObject({
  ...actionCommonShape,
  kind: z.literal('verify-provider-prerequisite'),
  prerequisiteId: z.string().min(1).max(100),
});

const generatedHostFileIdentitySchema = z.strictObject({
  path: z.string().min(1).max(500),
  mediaType: z.enum(['application/json', 'text/markdown']),
  contentDigest: sha256DigestSchema,
});

const hostIntegrationActionSchema = z.strictObject({
  actionId: sha256DigestSchema,
  kind: z.literal('prepare-host-integration'),
  host: z.strictObject({
    id: stableIdentifierSchema,
    adapterSchemaVersion: z.number().int().positive(),
  }),
  files: z.array(generatedHostFileIdentitySchema).min(1).max(100),
});

export const preparationActionSchema = z.discriminatedUnion('kind', [
  localArtifactActionSchema,
  configurationActionSchema,
  remoteConnectionActionSchema,
  providerPrerequisiteActionSchema,
  hostIntegrationActionSchema,
]);

export const preparationPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(PREPARATION_SCHEMA_VERSION),
    kind: z.literal('agent-preparation-plan'),
    instance: z.strictObject({
      instanceId: sha256DigestSchema,
      environmentId: stableIdentifierSchema,
    }),
    agentDefinition: z.strictObject({
      id: stableIdentifierSchema,
      version: exactVersionSchema,
      digest: sha256DigestSchema,
    }),
    build: z.strictObject({
      lockDigest: sha256DigestSchema,
    }),
    host: z.strictObject({
      id: stableIdentifierSchema,
      adapterSchemaVersion: z.number().int().positive(),
    }),
    actions: z.array(preparationActionSchema).min(1).max(20_000),
  })
  .superRefine((plan, context) => {
    const actionIds = new Set<string>();
    plan.actions.forEach((action, index) => {
      const { actionId, ...identity } = action;
      if (actionId !== digestCanonicalJson(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['actions', index, 'actionId'],
          message: 'does not match the canonical action identity',
        });
      }
      if (actionIds.has(actionId)) {
        context.addIssue({
          code: 'custom',
          path: ['actions', index, 'actionId'],
          message: `duplicates action ${actionId}`,
        });
      }
      actionIds.add(actionId);
    });
  });

export const preparationDriverResultSchema = z.strictObject({
  status: z.enum(['success', 'already-ready', 'setup-required', 'unavailable']),
});

export const preparationActionResultSchema = z.strictObject({
  actionId: sha256DigestSchema,
  status: z.enum(['success', 'already-ready', 'setup-required', 'unavailable']),
});

export const preparationHostIntegrationEvidenceSchema = z.enum([
  'available',
  'setup-required',
  'unavailable',
]);

export type PreparationAction = z.infer<typeof preparationActionSchema>;
export type PreparationPlan = z.infer<typeof preparationPlanSchema>;
export type PreparationDriverResult = z.infer<typeof preparationDriverResultSchema>;
export type PreparationActionResult = z.infer<typeof preparationActionResultSchema>;
export type PreparationHostIntegrationEvidence = z.infer<
  typeof preparationHostIntegrationEvidenceSchema
>;

type HostIntegrationAction = Extract<
  PreparationAction,
  { readonly kind: 'prepare-host-integration' }
>;
type BindingPreparationAction = Exclude<PreparationAction, HostIntegrationAction>;

export type PreparationDriverRequest =
  | {
      readonly environmentId: string;
      readonly action: BindingPreparationAction;
    }
  | {
      readonly environmentId: string;
      readonly action: HostIntegrationAction;
      readonly generatedHostFiles: readonly GeneratedHostFile[];
    };

export interface PreparationDriver {
  execute(request: PreparationDriverRequest): Promise<PreparationDriverResult>;
}

export interface PreparationClock {
  now(): Date;
}

export interface PreparationPlanOptions {
  readonly environmentId: string;
  readonly readinessSnapshot: ReadinessSnapshot;
  readonly hostIntegration?: PreparationHostIntegrationEvidence;
}

export interface PrepareAgentOptions extends PreparationPlanOptions {
  readonly driver?: PreparationDriver;
  readonly clock?: PreparationClock;
  readonly existingInstance?: unknown;
}

export interface PreparationSetupRequirement {
  readonly action: PreparationAction;
  readonly status: 'setup-required' | 'unavailable';
}

export interface PreparationResult {
  readonly identity: PreparedAgentInstanceIdentity;
  readonly instance: PreparedAgentInstance;
  readonly readiness: ReadinessPlan;
  readonly plan: PreparationPlan;
  readonly actionResults: readonly PreparationActionResult[];
  readonly hostIntegration: PreparationActionResult;
  readonly runnable: boolean;
  readonly setupRequirements: readonly PreparationSetupRequirement[];
  readonly disposition: 'created' | 'updated';
}

type NormalizedReadinessSnapshot = z.output<typeof readinessSnapshotSchema>;

interface ValidatedBuild {
  readonly definition: AgentDefinition;
  readonly lockDigest: `sha256:${string}`;
  readonly seam: AgentInstanceSeam;
  readonly capabilities: readonly ResolvedCapability[];
  readonly generatedHostFiles: readonly GeneratedHostFile[];
}

interface NormalizedPreparationOptions {
  readonly environmentId: string;
  readonly readinessSnapshot: NormalizedReadinessSnapshot;
  readonly hostIntegration: PreparationHostIntegrationEvidence;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const preparationInputError = (issues: readonly string[]): never => {
  throw new AgentKitError(
    'INVALID_PREPARATION_INPUT',
    'Agent preparation input is invalid or internally inconsistent.',
    issues,
  );
};

const assertRecord: (
  value: unknown,
  issue: string,
) => asserts value is Readonly<Record<string, unknown>> = (value, issue) => {
  if (!isRecord(value)) preparationInputError([issue]);
};

const parseGeneratedHostFiles = (input: unknown): readonly GeneratedHostFile[] => {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    return preparationInputError(['adapter.files must contain between 1 and 100 generated files']);
  }

  const files: GeneratedHostFile[] = [];
  const paths = new Set<string>();
  const candidates: readonly unknown[] = input;
  for (const [index, candidate] of candidates.entries()) {
    assertRecord(candidate, `adapter.files.${String(index)} must be a generated host file`);
    const path =
      typeof candidate.path === 'string'
        ? candidate.path
        : preparationInputError([`adapter.files.${String(index)}.path is not a string`]);
    const mediaType =
      candidate.mediaType === 'application/json' || candidate.mediaType === 'text/markdown'
        ? candidate.mediaType
        : preparationInputError([`adapter.files.${String(index)}.mediaType is unsupported`]);
    const content =
      typeof candidate.content === 'string'
        ? candidate.content
        : preparationInputError([`adapter.files.${String(index)}.content is invalid`]);
    const invalidPath =
      path.length === 0 ||
      path.length > 500 ||
      path.startsWith('/') ||
      /^[A-Za-z]:/u.test(path) ||
      path.includes('\\') ||
      /(?:^|\/)\.\.(?:\/|$)/u.test(path);
    if (invalidPath) {
      preparationInputError([`adapter.files.${String(index)}.path is not portable`]);
    }
    if (content.length > 1_000_000) {
      preparationInputError([`adapter.files.${String(index)}.content is invalid`]);
    }
    if (paths.has(path)) {
      preparationInputError(['adapter.files contains a duplicate path']);
    }
    paths.add(path);
    files.push({ path, mediaType, content });
  }
  return files.sort((left, right) => compareCodeUnits(left.path, right.path));
};

const capabilityIssues = (
  capability: ResolvedCapability,
  selection: CapabilitySelection | undefined,
  lockCapability: AgentLock['capabilities'][number] | undefined,
  seamBinding: AgentInstanceSeam['bindings'][number] | undefined,
  readinessCapability: ReadinessPlan['capabilities'][number] | undefined,
  index: number,
): readonly string[] => {
  const prefix = `capabilities.${String(index)}`;
  if (
    lockCapability === undefined ||
    seamBinding === undefined ||
    readinessCapability === undefined
  ) {
    return [`${prefix} has no matching lock, seam, or readiness entry`];
  }

  const issues: string[] = [];
  const binding = capability.binding;
  const registryProfile = capability.capability.profiles.find(
    (profile) => profile.id === capability.profile.id,
  );
  const registryBinding = capability.capability.bindings.find(
    (candidate) => candidate.id === binding.id,
  );
  const registryArtifact =
    registryBinding === undefined
      ? undefined
      : capability.capability.artifacts.find(
          (artifact) => artifact.id === registryBinding.artifactId,
        );
  const expectedKey = capabilityBindingKey(
    capability.capability.id,
    capability.capability.version.value,
    capability.profile.id,
  );
  if (
    selection === undefined ||
    selection.id !== capability.capability.id ||
    (selection.version ?? null) !== capability.requestedVersion ||
    (selection.profile !== undefined && selection.profile !== capability.profile.id)
  ) {
    issues.push(`${prefix} does not match the canonical definition selection`);
  }
  if (binding.key !== expectedKey) issues.push(`${prefix}.binding.key is inconsistent`);
  if (lockCapability.registryEntryDigest !== digestCanonicalJson(capability.capability)) {
    issues.push(`${prefix}.capability does not match its locked Registry digest`);
  }
  if (
    registryProfile === undefined ||
    digestCanonicalJson(registryProfile) !== digestCanonicalJson(capability.profile)
  ) {
    issues.push(`${prefix}.profile does not match its Registry entry`);
  }
  if (
    registryBinding === undefined ||
    registryArtifact === undefined ||
    registryBinding.profileId !== capability.profile.id ||
    registryBinding.availability !== binding.mode ||
    registryBinding.interface !== binding.interface
  ) {
    issues.push(`${prefix}.binding does not match its Registry entry`);
  } else {
    const expectedArtifact = {
      ...registryArtifact,
      sourceRevision: capability.capability.source.revision,
    };
    const expectedHttpClient =
      registryBinding.client === undefined
        ? undefined
        : {
            headers: registryBinding.client.http.headers
              .map((header) => ({
                name: header.name,
                configurationName: header.value.name,
                prefix: header.value.prefix ?? '',
              }))
              .sort(
                (left, right) =>
                  compareCodeUnits(left.name.toLowerCase(), right.name.toLowerCase()) ||
                  compareCodeUnits(left.name, right.name),
              ),
          };
    if (digestCanonicalJson(expectedArtifact) !== digestCanonicalJson(binding.artifact)) {
      issues.push(`${prefix}.artifact does not match its Registry entry`);
    }
    if (
      digestCanonicalJson(expectedHttpClient ?? null) !==
      digestCanonicalJson(binding.httpClient ?? null)
    ) {
      issues.push(`${prefix}.httpClient does not match its Registry entry`);
    }
  }
  if (
    capability.compatibility.state !== 'compatible' ||
    capability.compatibility.reasons.length !== 0
  ) {
    issues.push(`${prefix}.compatibility is not a successful build result`);
  }
  if (registryProfile !== undefined) {
    const expectedRequirements = {
      setupRequired: registryProfile.prerequisites.setupRequired,
      requiredSecretNames: [...registryProfile.prerequisites.requiredSecrets].sort(
        compareCodeUnits,
      ),
      providerPrerequisites: [...registryProfile.prerequisites.provider].sort((left, right) =>
        compareCodeUnits(left.id, right.id),
      ),
      permissions: [...registryProfile.permissions.scopes].sort(compareCodeUnits),
      readinessSignals: [...registryProfile.readiness.signals].sort(compareCodeUnits),
    };
    const actualRequirements = {
      setupRequired: binding.setupRequired,
      requiredSecretNames: binding.requiredSecretNames,
      providerPrerequisites: binding.providerPrerequisites,
      permissions: binding.permissions,
      readinessSignals: binding.readinessSignals,
    };
    if (
      digestCanonicalJson(registryProfile.dimensions) !== digestCanonicalJson(binding.dimensions) ||
      digestCanonicalJson(expectedRequirements) !== digestCanonicalJson(actualRequirements)
    ) {
      issues.push(`${prefix}.profile requirements do not match its Registry entry`);
    }
  }
  if (
    lockCapability.id !== capability.capability.id ||
    lockCapability.version !== capability.capability.version.value ||
    lockCapability.requestedVersion !== capability.requestedVersion ||
    lockCapability.source.repository !== capability.capability.source.repository ||
    lockCapability.source.revision !== capability.capability.source.revision ||
    lockCapability.source.profileDeclaration !==
      (capability.capability.source.metadata.profiles ?? null) ||
    lockCapability.profile.id !== capability.profile.id ||
    lockCapability.profile.source !== capability.profile.source ||
    lockCapability.binding.id !== binding.id ||
    lockCapability.binding.mode !== binding.mode ||
    lockCapability.binding.interface !== binding.interface
  ) {
    issues.push(`${prefix} identity does not match agent.lock`);
  }
  if (
    digestCanonicalJson(lockCapability.profile.dimensions) !==
      digestCanonicalJson(binding.dimensions) ||
    digestCanonicalJson(lockCapability.artifact) !== digestCanonicalJson(binding.artifact)
  ) {
    issues.push(`${prefix} profile or artifact does not match agent.lock`);
  }
  const bindingRequirements = {
    setupRequired: binding.setupRequired,
    requiredSecretNames: binding.requiredSecretNames,
    providerPrerequisiteIds: binding.providerPrerequisites.map((prerequisite) => prerequisite.id),
    permissions: binding.permissions,
    readinessSignals: binding.readinessSignals,
  };
  const lockClient =
    binding.httpClient === undefined
      ? null
      : {
          http: {
            headers: binding.httpClient.headers.map((header) => ({
              name: header.name,
              configuration: header.configurationName,
              prefix: header.prefix,
            })),
          },
        };
  if (
    digestCanonicalJson(lockCapability.requirements) !== digestCanonicalJson(bindingRequirements) ||
    digestCanonicalJson(lockCapability.binding.client) !== digestCanonicalJson(lockClient)
  ) {
    issues.push(`${prefix} requirements or client mapping do not match agent.lock`);
  }
  if (
    seamBinding.key !== binding.key ||
    seamBinding.capabilityId !== capability.capability.id ||
    seamBinding.capabilityVersion !== capability.capability.version.value ||
    seamBinding.profileId !== capability.profile.id ||
    seamBinding.mode !== binding.mode
  ) {
    issues.push(`${prefix} identity does not match the Agent Instance seam`);
  }
  if (
    readinessCapability.id !== capability.capability.id ||
    readinessCapability.version !== capability.capability.version.value ||
    readinessCapability.profileId !== capability.profile.id ||
    readinessCapability.bindingMode !== binding.mode
  ) {
    issues.push(`${prefix} identity does not match build readiness`);
  }
  return issues;
};

const validateBuild = (build: AgentBuild): ValidatedBuild => {
  if (!isRecord(build)) preparationInputError(['build must be an AgentBuild object']);

  const definition = agentDefinitionSchema.safeParse(build.definition);
  const lock = agentLockSchema.safeParse(build.lock);
  const seam = agentInstanceSeamSchema.safeParse(build.instanceIdentity);
  const readiness = readinessPlanSchema.safeParse(build.readiness);
  const schemaIssues = [
    ...(definition.success
      ? []
      : formatZodIssues(definition.error).map((issue) => `definition.${issue}`)),
    ...(lock.success ? [] : formatZodIssues(lock.error).map((issue) => `lock.${issue}`)),
    ...(seam.success
      ? []
      : formatZodIssues(seam.error).map((issue) => `instanceIdentity.${issue}`)),
    ...(readiness.success
      ? []
      : formatZodIssues(readiness.error).map((issue) => `readiness.${issue}`)),
  ];
  if (!definition.success || !lock.success || !seam.success || !readiness.success) {
    return preparationInputError(schemaIssues);
  }
  const incompatibleIndex = build.capabilities.findIndex(
    (capability) => capability.status !== 'resolved',
  );
  if (incompatibleIndex >= 0) {
    return preparationInputError([
      `capabilities.${String(incompatibleIndex)} is not a resolved capability`,
    ]);
  }

  const issues: string[] = [];
  const expectedDefinitionDigest = digestCanonicalJson(definition.data);
  const expectedLockDigest = digestAgentLock(lock.data);
  if (
    lock.data.agent.id !== definition.data.id ||
    lock.data.agent.version !== definition.data.version ||
    lock.data.agent.definitionDigest !== expectedDefinitionDigest
  ) {
    issues.push('definition identity does not match agent.lock');
  }
  if (build.lockDigest !== expectedLockDigest) {
    issues.push('lockDigest does not match agent.lock');
  }
  if (build.lockText !== serializeAgentLock(lock.data)) {
    issues.push('lockText does not match agent.lock');
  }
  try {
    if (
      digestCanonicalJson(build.instructions) !==
      digestCanonicalJson(composeInstructions(definition.data, build.capabilities))
    ) {
      issues.push('composed instructions do not match the definition and capabilities');
    }
  } catch {
    issues.push('composed instructions are invalid');
  }
  if (
    seam.data.agentDefinition.id !== definition.data.id ||
    seam.data.agentDefinition.version !== definition.data.version ||
    seam.data.agentDefinition.digest !== expectedDefinitionDigest ||
    seam.data.build.lockDigest !== expectedLockDigest
  ) {
    issues.push('Agent Instance seam does not match the definition and lock');
  }

  const adapter = build.adapter;
  if (
    !isRecord(adapter) ||
    adapter.hostId !== seam.data.host.id ||
    adapter.schemaVersion !== seam.data.host.adapterSchemaVersion
  ) {
    issues.push('host adapter output identity does not match the Agent Instance seam');
  }
  if (
    lock.data.build.adapters.length !== 1 ||
    lock.data.build.adapters[0]?.id !== seam.data.host.id ||
    lock.data.build.adapters[0]?.schemaVersion !== seam.data.host.adapterSchemaVersion
  ) {
    issues.push('host adapter identity does not match agent.lock');
  }
  if (
    readiness.data.agent.id !== definition.data.id ||
    readiness.data.agent.version !== definition.data.version ||
    readiness.data.agent.lockDigest !== expectedLockDigest ||
    readiness.data.host.id !== seam.data.host.id ||
    readiness.data.host.adapterSchemaVersion !== seam.data.host.adapterSchemaVersion
  ) {
    issues.push('build readiness identity does not match the definition, lock, and host');
  }

  const capabilities = build.capabilities;
  if (
    capabilities.length !== lock.data.capabilities.length ||
    capabilities.length !== seam.data.bindings.length ||
    capabilities.length !== readiness.data.capabilities.length
  ) {
    issues.push('capability counts differ across the build, lock, seam, and readiness');
  }
  capabilities.forEach((capability, index) => {
    issues.push(
      ...capabilityIssues(
        capability,
        definition.data.capabilities[index],
        lock.data.capabilities[index],
        seam.data.bindings[index],
        readiness.data.capabilities[index],
        index,
      ),
    );
  });
  if (issues.length > 0) return preparationInputError(issues);

  const files = parseGeneratedHostFiles(isRecord(adapter) ? adapter.files : undefined);
  return {
    definition: definition.data,
    lockDigest: expectedLockDigest,
    seam: seam.data,
    capabilities,
    generatedHostFiles: files,
  };
};

const normalizeOptions = (options: PreparationPlanOptions): NormalizedPreparationOptions => {
  const environment = stableIdentifierSchema.safeParse(options.environmentId);
  const snapshot = readinessSnapshotSchema.safeParse(options.readinessSnapshot);
  const hostIntegration = preparationHostIntegrationEvidenceSchema.safeParse(
    options.hostIntegration ?? 'setup-required',
  );
  const issues = [
    ...(environment.success
      ? []
      : formatZodIssues(environment.error).map((issue) => `environmentId.${issue}`)),
    ...(snapshot.success
      ? []
      : formatZodIssues(snapshot.error).map((issue) => `readinessSnapshot.${issue}`)),
    ...(hostIntegration.success
      ? []
      : formatZodIssues(hostIntegration.error).map((issue) => `hostIntegration.${issue}`)),
  ];
  if (!environment.success || !snapshot.success || !hostIntegration.success) {
    return preparationInputError(issues);
  }
  return {
    environmentId: environment.data,
    readinessSnapshot: snapshot.data,
    hostIntegration: hostIntegration.data,
  };
};

const bindingTargetFor = (capability: ResolvedCapability): z.infer<typeof bindingTargetSchema> => ({
  key: capability.binding.key,
  capabilityId: capability.capability.id,
  capabilityVersion: capability.capability.version.value,
  profileId: capability.profile.id,
  mode: capability.binding.mode,
});

const addActionId = <T extends Omit<PreparationAction, 'actionId'>>(
  action: T,
): T & { readonly actionId: `sha256:${string}` } => ({
  actionId: digestCanonicalJson(action),
  ...action,
});

const actionSortKey = (action: PreparationAction): string => {
  const bindingKey = 'binding' in action ? action.binding.key : '';
  const detail =
    action.kind === 'verify-configuration'
      ? action.configurationName
      : action.kind === 'verify-provider-prerequisite'
        ? action.prerequisiteId
        : '';
  return `${action.kind}\u0000${bindingKey}\u0000${detail}`;
};

const createPlanFromValidated = (
  build: ValidatedBuild,
  options: NormalizedPreparationOptions,
): PreparationPlan => {
  const identity = createPreparedAgentInstanceIdentity(build.seam, options.environmentId);
  const availableLocalBindings = new Set(options.readinessSnapshot.availableLocalBindings);
  const actions: PreparationAction[] = [];

  for (const capability of build.capabilities) {
    const binding = bindingTargetFor(capability);
    if (binding.mode === 'local' || binding.mode === 'hybrid') {
      actions.push(
        addActionId({
          kind: availableLocalBindings.has(binding.key)
            ? 'verify-local-artifact'
            : 'make-local-artifact-available',
          binding,
          artifact: capability.binding.artifact,
        }),
      );
    }
    for (const configurationName of capability.binding.requiredSecretNames) {
      actions.push(
        addActionId({
          kind: 'verify-configuration',
          binding,
          configurationName,
        }),
      );
    }
    if (binding.mode === 'remote') {
      actions.push(addActionId({ kind: 'verify-remote-connection', binding }));
    }
    if (binding.mode === 'remote' || binding.mode === 'hybrid') {
      for (const prerequisite of capability.binding.providerPrerequisites) {
        actions.push(
          addActionId({
            kind: 'verify-provider-prerequisite',
            binding,
            prerequisiteId: prerequisite.id,
          }),
        );
      }
    }
  }

  actions.push(
    addActionId({
      kind: 'prepare-host-integration',
      host: build.seam.host,
      files: build.generatedHostFiles.map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        contentDigest: digestCanonicalJson(file.content),
      })),
    }),
  );
  actions.sort((left, right) => compareCodeUnits(actionSortKey(left), actionSortKey(right)));

  const candidate = {
    schemaVersion: PREPARATION_SCHEMA_VERSION,
    kind: 'agent-preparation-plan',
    instance: {
      instanceId: identity.instanceId,
      environmentId: identity.environmentId,
    },
    agentDefinition: build.seam.agentDefinition,
    build: build.seam.build,
    host: build.seam.host,
    actions,
  } as const;
  const parsed = preparationPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_PREPARATION_RESULT',
      'Generated preparation plan is invalid.',
      formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
};

export const createPreparationPlan = (
  build: AgentBuild,
  options: PreparationPlanOptions,
): PreparationPlan => createPlanFromValidated(validateBuild(build), normalizeOptions(options));

const cloneSnapshot = (snapshot: NormalizedReadinessSnapshot): NormalizedReadinessSnapshot => ({
  schemaVersion: snapshot.schemaVersion,
  availableLocalBindings: [...snapshot.availableLocalBindings],
  availableRemoteBindings: [...snapshot.availableRemoteBindings],
  availableProviderPrerequisites: [...snapshot.availableProviderPrerequisites],
  configuration: snapshot.configuration.map((entry) => ({
    bindingKey: entry.bindingKey,
    availableNames: [...entry.availableNames],
  })),
});

const hasConfiguration = (
  snapshot: NormalizedReadinessSnapshot,
  bindingKey: string,
  configurationName: string,
): boolean =>
  snapshot.configuration
    .find((entry) => entry.bindingKey === bindingKey)
    ?.availableNames.includes(configurationName) ?? false;

const evidenceStatusFor = (
  action: PreparationAction,
  snapshot: NormalizedReadinessSnapshot,
  hostIntegration: PreparationHostIntegrationEvidence,
): 'already-ready' | 'unavailable' | undefined => {
  switch (action.kind) {
    case 'verify-local-artifact':
    case 'make-local-artifact-available':
      return snapshot.availableLocalBindings.includes(action.binding.key)
        ? 'already-ready'
        : undefined;
    case 'verify-configuration':
      return hasConfiguration(snapshot, action.binding.key, action.configurationName)
        ? 'already-ready'
        : undefined;
    case 'verify-remote-connection':
      return snapshot.availableRemoteBindings.includes(action.binding.key)
        ? 'already-ready'
        : undefined;
    case 'verify-provider-prerequisite':
      return snapshot.availableProviderPrerequisites.includes(
        `${action.binding.key}/${action.prerequisiteId}`,
      )
        ? 'already-ready'
        : undefined;
    case 'prepare-host-integration':
      return hostIntegration === 'available'
        ? 'already-ready'
        : hostIntegration === 'unavailable'
          ? 'unavailable'
          : undefined;
  }
};

const addSortedUnique = (values: string[], value: string): void => {
  if (!values.includes(value)) values.push(value);
  values.sort(compareCodeUnits);
};

const recordSuccessfulAction = (
  snapshot: NormalizedReadinessSnapshot,
  action: PreparationAction,
): void => {
  switch (action.kind) {
    case 'verify-local-artifact':
    case 'make-local-artifact-available':
      addSortedUnique(snapshot.availableLocalBindings, action.binding.key);
      return;
    case 'verify-remote-connection':
      addSortedUnique(snapshot.availableRemoteBindings, action.binding.key);
      return;
    case 'verify-provider-prerequisite':
      addSortedUnique(
        snapshot.availableProviderPrerequisites,
        `${action.binding.key}/${action.prerequisiteId}`,
      );
      return;
    case 'verify-configuration': {
      let configuration = snapshot.configuration.find(
        (entry) => entry.bindingKey === action.binding.key,
      );
      if (configuration === undefined) {
        configuration = { bindingKey: action.binding.key, availableNames: [] };
        snapshot.configuration.push(configuration);
        snapshot.configuration.sort((left, right) =>
          compareCodeUnits(left.bindingKey, right.bindingKey),
        );
      }
      addSortedUnique(configuration.availableNames, action.configurationName);
      return;
    }
    case 'prepare-host-integration':
      return;
  }
};

const requestFor = (
  action: PreparationAction,
  environmentId: string,
  generatedHostFiles: readonly GeneratedHostFile[],
): PreparationDriverRequest =>
  action.kind === 'prepare-host-integration'
    ? { environmentId, action, generatedHostFiles }
    : { environmentId, action };

const executeAction = async (
  action: PreparationAction,
  options: NormalizedPreparationOptions,
  snapshot: NormalizedReadinessSnapshot,
  driver: PreparationDriver | undefined,
  generatedHostFiles: readonly GeneratedHostFile[],
): Promise<PreparationActionResult> => {
  const evidenceStatus = evidenceStatusFor(action, snapshot, options.hostIntegration);
  if (evidenceStatus !== undefined) {
    return { actionId: action.actionId, status: evidenceStatus };
  }
  if (driver === undefined) {
    return { actionId: action.actionId, status: 'setup-required' };
  }

  let candidate: unknown;
  try {
    candidate = await driver.execute(requestFor(action, options.environmentId, generatedHostFiles));
  } catch {
    throw new AgentKitError(
      'PREPARATION_FAILED',
      `Preparation driver failed while executing ${action.kind}.`,
      [`actionId: ${action.actionId}`],
    );
  }

  const parsed = preparationDriverResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_PREPARATION_RESULT',
      `Preparation driver returned an invalid result for ${action.kind}.`,
      formatZodIssues(parsed.error),
    );
  }
  const driverResult = parsed.data;
  if (driverResult.status === 'success' || driverResult.status === 'already-ready') {
    recordSuccessfulAction(snapshot, action);
  }
  return { actionId: action.actionId, status: driverResult.status };
};

const preparedAt = (clock: PreparationClock | undefined): string => {
  const value = clock?.now() ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    return preparationInputError(['clock.now() must return a valid Date']);
  }
  return value.toISOString();
};

const stateForBinding = (
  readiness: ReadinessPlan['capabilities'][number],
  unavailable: boolean,
): AgentInstanceState => {
  if (unavailable || readiness.state === 'incompatible-binding') return 'UNAVAILABLE';
  return readiness.state === 'available-local' || readiness.state === 'ready'
    ? 'READY'
    : 'NEEDS_SETUP';
};

export const prepareAgent = async (
  buildInput: AgentBuild,
  optionsInput: PrepareAgentOptions,
): Promise<PreparationResult> => {
  const build = validateBuild(buildInput);
  const options = normalizeOptions(optionsInput);
  const identity = createPreparedAgentInstanceIdentity(build.seam, options.environmentId);
  const existing =
    optionsInput.existingInstance === undefined
      ? undefined
      : parsePreparedAgentInstance(optionsInput.existingInstance);
  if (existing !== undefined && existing.instanceId !== identity.instanceId) {
    return preparationInputError([
      'existingInstance belongs to a different build, host, or environment identity',
    ]);
  }

  const plan = createPlanFromValidated(build, options);
  const snapshot = cloneSnapshot(options.readinessSnapshot);
  const actionResults: PreparationActionResult[] = [];
  for (const action of plan.actions) {
    actionResults.push(
      await executeAction(action, options, snapshot, optionsInput.driver, build.generatedHostFiles),
    );
  }

  const resolution: AgentResolution = {
    definition: build.definition,
    host: build.seam.host,
    capabilities: build.capabilities,
  };
  const readiness = createReadinessPlan(resolution, snapshot, build.lockDigest);
  const resultsById = new Map(actionResults.map((result) => [result.actionId, result]));
  const unavailableBindingKeys = new Set(
    plan.actions
      .filter(
        (action): action is BindingPreparationAction =>
          'binding' in action && resultsById.get(action.actionId)?.status === 'unavailable',
      )
      .map((action) => action.binding.key),
  );
  const bindings = readiness.capabilities.map((capability) => {
    const key = capabilityBindingKey(capability.id, capability.version, capability.profileId);
    const seamBinding = build.seam.bindings.find((binding) => binding.key === key);
    if (seamBinding === undefined) {
      throw new AgentKitError(
        'INVALID_PREPARATION_RESULT',
        'Prepared readiness has no matching Agent Instance binding.',
        [`bindingKey: ${key}`],
      );
    }
    return {
      ...seamBinding,
      state: stateForBinding(capability, unavailableBindingKeys.has(key)),
      readiness: capability.state,
    };
  });

  const hostAction = plan.actions.find(
    (action): action is HostIntegrationAction => action.kind === 'prepare-host-integration',
  );
  if (hostAction === undefined) {
    throw new AgentKitError(
      'INVALID_PREPARATION_RESULT',
      'Preparation plan has no host integration action.',
    );
  }
  const hostIntegration = resultsById.get(hostAction.actionId);
  if (hostIntegration === undefined) {
    throw new AgentKitError(
      'INVALID_PREPARATION_RESULT',
      'Preparation plan has no host integration result.',
    );
  }

  const hostUnavailable = hostIntegration.status === 'unavailable';
  const hostReady =
    hostIntegration.status === 'success' || hostIntegration.status === 'already-ready';
  const state: AgentInstanceState =
    hostUnavailable || bindings.some((binding) => binding.state === 'UNAVAILABLE')
      ? 'UNAVAILABLE'
      : !hostReady || bindings.some((binding) => binding.state !== 'READY')
        ? 'NEEDS_SETUP'
        : 'READY';
  const preparationTimestamp = preparedAt(optionsInput.clock);
  const instance = parsePreparedAgentInstance({
    schemaVersion: 1,
    instanceId: identity.instanceId,
    environmentId: identity.environmentId,
    agentDefinition: build.seam.agentDefinition,
    build: build.seam.build,
    host: build.seam.host,
    preparedAt: preparationTimestamp,
    state,
    bindings,
  });
  const setupRequirements = plan.actions.flatMap(
    (action): readonly PreparationSetupRequirement[] => {
      const status = resultsById.get(action.actionId)?.status;
      return status === 'setup-required' || status === 'unavailable' ? [{ action, status }] : [];
    },
  );

  return {
    identity,
    instance,
    readiness,
    plan,
    actionResults,
    hostIntegration,
    runnable: state === 'READY',
    setupRequirements,
    disposition: existing === undefined ? 'created' : 'updated',
  };
};
