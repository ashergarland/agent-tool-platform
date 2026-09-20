import { z } from 'zod';
import { AgentKitError, formatZodIssues } from './errors.js';
import type { AgentResolution, CapabilityResolution } from './resolution.js';
import { capabilityBindingKey } from './resolution.js';
import { sha256DigestSchema, stableIdentifierSchema } from './schemas.js';

export const READINESS_SCHEMA_VERSION = 1;

const bindingKeySchema = z.string().min(1).max(600).regex(/^\S+$/u);

export const readinessSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(READINESS_SCHEMA_VERSION),
    availableLocalBindings: z.array(bindingKeySchema).max(200).default([]),
    availableRemoteBindings: z.array(bindingKeySchema).max(200).default([]),
    availableProviderPrerequisites: z.array(bindingKeySchema).max(500).default([]),
    configuration: z
      .array(
        z.strictObject({
          bindingKey: bindingKeySchema,
          availableNames: z.array(z.string().min(1).max(200)).max(200),
        }),
      )
      .max(200)
      .default([]),
  })
  .superRefine((snapshot, context) => {
    const seen = new Set<string>();
    snapshot.configuration.forEach((entry, index) => {
      if (seen.has(entry.bindingKey)) {
        context.addIssue({
          code: 'custom',
          path: ['configuration', index, 'bindingKey'],
          message: `duplicates configuration for ${entry.bindingKey}`,
        });
      }
      seen.add(entry.bindingKey);
    });
  });

const readinessRequirementSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('host-compatibility'),
    state: z.enum(['compatible', 'incompatible']),
    reasons: z.array(z.string().min(1).max(1_000)).max(20),
  }),
  z.strictObject({
    kind: z.literal('setup'),
    state: z.literal('declared'),
    summary: z.string().min(1).max(1_000),
  }),
  z.strictObject({
    kind: z.literal('artifact-availability'),
    state: z.enum(['published', 'declared', 'source-only']),
    artifactId: z.string().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal('configuration'),
    state: z.enum(['available', 'missing']),
    name: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal('local-artifact'),
    state: z.enum(['available', 'setup-required']),
  }),
  z.strictObject({
    kind: z.literal('remote-connection'),
    state: z.enum(['available', 'setup-required']),
  }),
  z.strictObject({
    kind: z.literal('provider-prerequisite'),
    state: z.enum(['available', 'setup-required']),
    id: z.string().min(1).max(100),
    description: z.string().min(1).max(1_000),
  }),
]);

export const readinessPlanSchema = z.strictObject({
  schemaVersion: z.literal(READINESS_SCHEMA_VERSION),
  kind: z.literal('agent-readiness-plan'),
  agent: z.strictObject({
    id: stableIdentifierSchema,
    version: z.string().min(1).max(200),
    lockDigest: sha256DigestSchema.nullable(),
  }),
  host: z.strictObject({
    id: stableIdentifierSchema,
    adapterSchemaVersion: z.number().int().positive(),
  }),
  activityAssessment: z.literal('not-evaluated'),
  capabilities: z.array(
    z.strictObject({
      id: stableIdentifierSchema,
      version: z.string().min(1).max(200),
      profileId: z.string().min(1).max(100),
      bindingMode: z.enum(['local', 'remote', 'hybrid']),
      state: z.enum([
        'available-local',
        'ready',
        'local-setup-required',
        'remote-provider-setup-required',
        'missing-configuration',
        'incompatible-binding',
      ]),
      requirements: z.array(readinessRequirementSchema),
    }),
  ),
});

export type ReadinessSnapshot = z.input<typeof readinessSnapshotSchema>;
export type ReadinessPlan = z.infer<typeof readinessPlanSchema>;
export type ReadinessRequirement = z.infer<typeof readinessRequirementSchema>;

const emptySnapshot: ReadinessSnapshot = { schemaVersion: READINESS_SCHEMA_VERSION };

const keyFor = (capability: CapabilityResolution): string =>
  capabilityBindingKey(
    capability.capability.id,
    capability.capability.version.value,
    capability.profile.id,
  );

const configurationFor = (
  bindingKey: string,
  snapshot: z.output<typeof readinessSnapshotSchema>,
): ReadonlySet<string> =>
  new Set(
    snapshot.configuration.find((entry) => entry.bindingKey === bindingKey)?.availableNames ?? [],
  );

const requirementsFor = (
  capability: CapabilityResolution,
  snapshot: z.output<typeof readinessSnapshotSchema>,
): readonly ReadinessRequirement[] => {
  const profile = capability.profile;
  const bindingKey = keyFor(capability);
  const availableConfiguration = configurationFor(bindingKey, snapshot);
  const requirements: ReadinessRequirement[] = [
    {
      kind: 'host-compatibility',
      state: capability.compatibility.state,
      reasons: [...capability.compatibility.reasons],
    },
    {
      kind: 'setup',
      state: 'declared',
      summary: profile.prerequisites.summary,
    },
    {
      kind: 'artifact-availability',
      state:
        capability.status === 'resolved'
          ? capability.binding.artifact.availability
          : capability.artifact.availability,
      artifactId:
        capability.status === 'resolved' ? capability.binding.artifact.id : capability.artifact.id,
    },
    ...profile.prerequisites.requiredSecrets.map((name): ReadinessRequirement => ({
      kind: 'configuration',
      state: availableConfiguration.has(name) ? 'available' : 'missing',
      name,
    })),
  ];

  const mode =
    capability.status === 'resolved'
      ? capability.binding.mode
      : capability.registryBinding.availability;

  if (mode === 'local' || mode === 'hybrid') {
    requirements.push({
      kind: 'local-artifact',
      state: snapshot.availableLocalBindings.includes(bindingKey) ? 'available' : 'setup-required',
    });
  }
  if (mode === 'remote') {
    requirements.push({
      kind: 'remote-connection',
      state: snapshot.availableRemoteBindings.includes(bindingKey) ? 'available' : 'setup-required',
    });
  }
  if (mode === 'remote' || mode === 'hybrid') {
    requirements.push(
      ...profile.prerequisites.provider.map((prerequisite): ReadinessRequirement => ({
        kind: 'provider-prerequisite',
        state: snapshot.availableProviderPrerequisites.includes(`${bindingKey}/${prerequisite.id}`)
          ? 'available'
          : 'setup-required',
        id: prerequisite.id,
        description: prerequisite.description,
      })),
    );
  }
  return requirements;
};

const readinessState = (
  capability: CapabilityResolution,
  requirements: readonly ReadinessRequirement[],
): ReadinessPlan['capabilities'][number]['state'] => {
  if (capability.status === 'incompatible') return 'incompatible-binding';
  if (requirements.some((item) => item.kind === 'configuration' && item.state === 'missing')) {
    return 'missing-configuration';
  }
  if (
    requirements.some((item) => item.kind === 'local-artifact' && item.state === 'setup-required')
  ) {
    return 'local-setup-required';
  }
  if (
    requirements.some(
      (item) =>
        (item.kind === 'remote-connection' || item.kind === 'provider-prerequisite') &&
        item.state === 'setup-required',
    )
  ) {
    return 'remote-provider-setup-required';
  }
  return capability.binding.mode === 'local' ? 'available-local' : 'ready';
};

const bindingMode = (capability: CapabilityResolution): 'hybrid' | 'local' | 'remote' => {
  if (capability.status === 'resolved') return capability.binding.mode;
  return capability.registryBinding.availability;
};

export const createReadinessPlan = (
  resolution: AgentResolution,
  snapshotInput: unknown = emptySnapshot,
  lockDigest: `sha256:${string}` | null = null,
): ReadinessPlan => {
  const parsedSnapshot = readinessSnapshotSchema.safeParse(snapshotInput);
  if (!parsedSnapshot.success) {
    throw new AgentKitError(
      'INVALID_READINESS_INPUT',
      'Readiness snapshot is invalid.',
      formatZodIssues(parsedSnapshot.error),
    );
  }

  const capabilities = resolution.capabilities.map((capability) => {
    const requirements = requirementsFor(capability, parsedSnapshot.data);
    return {
      id: capability.capability.id,
      version: capability.capability.version.value,
      profileId: capability.profile.id,
      bindingMode: bindingMode(capability),
      state: readinessState(capability, requirements),
      requirements,
    };
  });
  const candidate = {
    schemaVersion: READINESS_SCHEMA_VERSION,
    kind: 'agent-readiness-plan',
    agent: {
      id: resolution.definition.id,
      version: resolution.definition.version,
      lockDigest,
    },
    host: resolution.host,
    activityAssessment: 'not-evaluated',
    capabilities,
  } as const;
  const parsedPlan = readinessPlanSchema.safeParse(candidate);
  if (!parsedPlan.success) {
    throw new AgentKitError(
      'INVALID_READINESS_INPUT',
      'Generated readiness plan is invalid.',
      formatZodIssues(parsedPlan.error),
    );
  }
  return parsedPlan.data;
};
