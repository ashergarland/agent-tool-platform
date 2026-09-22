import type {
  CapabilityBinding,
  CapabilityEntry,
  CapabilityProfileSummary,
  CapabilityRegistry,
} from './schema.js';
import {
  capabilityRegistryKind,
  capabilityRegistrySchemaId,
  capabilityRegistrySchemaVersion,
} from './schema.js';

const sorted = <T>(values: readonly T[], key: (value: T) => string): T[] =>
  [...values].sort((left, right) => key(left).localeCompare(key(right)));

const sortedStrings = <T extends string>(values: readonly T[]): T[] =>
  [...values].sort((left, right) => left.localeCompare(right));

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizeBinding = (binding: CapabilityBinding): CapabilityBinding => {
  if (binding.client === undefined) return binding;
  return {
    ...binding,
    client: {
      http: {
        headers: [...binding.client.http.headers].sort(
          (left, right) =>
            compareCodeUnits(left.name.toLowerCase(), right.name.toLowerCase()) ||
            compareCodeUnits(left.name, right.name),
        ),
      },
    },
  };
};

export const normalizeCapabilityEntry = (entry: CapabilityEntry): CapabilityEntry => ({
  ...entry,
  artifacts: sorted(entry.artifacts, (artifact) => artifact.id),
  tags: sortedStrings(entry.tags),
  profiles: sorted(entry.profiles, (profile) => profile.id).map((profile) => ({
    ...profile,
    permissions: {
      ...profile.permissions,
      scopes: sortedStrings(profile.permissions.scopes),
    },
    prerequisites: {
      ...profile.prerequisites,
      requiredSecrets: sortedStrings(profile.prerequisites.requiredSecrets),
      provider: sorted(profile.prerequisites.provider, (prerequisite) => prerequisite.id),
    },
    readiness: {
      ...profile.readiness,
      signals: sortedStrings(profile.readiness.signals),
    },
    stateEffects: sortedStrings(profile.stateEffects),
  })),
  bindings: sorted(entry.bindings, (binding) => binding.id).map(normalizeBinding),
  conformance: {
    ...entry.conformance,
    checks: sortedStrings(entry.conformance.checks),
  },
});

export const buildCapabilityRegistry = (
  entries: readonly CapabilityEntry[],
  registryVersion: string,
): CapabilityRegistry => ({
  $schema: capabilityRegistrySchemaId,
  schemaVersion: capabilityRegistrySchemaVersion,
  kind: capabilityRegistryKind,
  registryVersion,
  capabilities: sorted(
    entries.map((entry) => normalizeCapabilityEntry(entry)),
    (entry) => entry.id,
  ),
});

export const serializeCapabilityRegistry = (registry: CapabilityRegistry): string =>
  `${JSON.stringify(registry, null, 2)}\n`;

export interface CapabilityRegistryReader {
  listCapabilities(): readonly CapabilityEntry[];
  getCapability(id: string): CapabilityEntry | undefined;
  listProfiles(id: string): readonly CapabilityProfileSummary[] | undefined;
  listBindings(id: string): readonly CapabilityBinding[] | undefined;
}

export class DuplicateCapabilityIdError extends Error {
  public override readonly name = 'DuplicateCapabilityIdError';

  public constructor(id: string) {
    super(`Duplicate capability ID: ${id}`);
  }
}

export const createCapabilityRegistryReader = (
  registry: CapabilityRegistry,
): CapabilityRegistryReader => {
  const capabilities = [...registry.capabilities];
  const byId = new Map<string, CapabilityEntry>();
  for (const capability of capabilities) {
    if (byId.has(capability.id)) throw new DuplicateCapabilityIdError(capability.id);
    byId.set(capability.id, capability);
  }

  return {
    listCapabilities: () => capabilities,
    getCapability: (id) => byId.get(id),
    listProfiles: (id) => byId.get(id)?.profiles,
    listBindings: (id) => byId.get(id)?.bindings,
  };
};
