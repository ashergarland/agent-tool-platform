import type { DeploymentProfileDimensions } from '@agent-tool-platform/runtime';
import { compareCodeUnits } from './canonical-json.js';
import { AgentKitError } from './errors.js';
import type { HostAdapter, HostCompatibility } from './host-adapter.js';
import { parseAgentDefinition } from './model.js';
import {
  resolveRegistryCapability,
  type CapabilityRegistryReader,
  type RegistryCapability,
  type RegistryCapabilityArtifact,
  type RegistryCapabilityBinding,
  type RegistryCapabilityProfile,
} from './registry.js';
import type {
  AgentDefinition,
  CapabilitySelection,
  ResolvedCapabilityArtifact,
} from './schemas.js';

export type BindingMode = 'hybrid' | 'local' | 'remote';

export interface ExecutionBinding {
  readonly key: string;
  readonly id: string;
  readonly mode: BindingMode;
  readonly interface: RegistryCapabilityBinding['interface'];
  readonly profileId: string;
  readonly dimensions: DeploymentProfileDimensions;
  readonly artifact: ResolvedCapabilityArtifact;
  readonly setupRequired: boolean;
  readonly requiredSecretNames: readonly string[];
  readonly providerPrerequisites: RegistryCapabilityProfile['prerequisites']['provider'];
  readonly permissions: readonly string[];
  readonly readinessSignals: readonly string[];
}

export interface ResolvedCapability {
  readonly status: 'resolved';
  readonly requestedVersion: string | null;
  readonly capability: RegistryCapability;
  readonly profile: RegistryCapabilityProfile;
  readonly binding: ExecutionBinding;
  readonly compatibility: HostCompatibility & { readonly state: 'compatible' };
}

export interface IncompatibleCapability {
  readonly status: 'incompatible';
  readonly requestedVersion: string | null;
  readonly capability: RegistryCapability;
  readonly profile: RegistryCapabilityProfile;
  readonly registryBinding: RegistryCapabilityBinding;
  readonly artifact: RegistryCapabilityArtifact;
  readonly compatibility: HostCompatibility & { readonly state: 'incompatible' };
}

export type CapabilityResolution = ResolvedCapability | IncompatibleCapability;

export interface AgentResolution {
  readonly definition: AgentDefinition;
  readonly host: {
    readonly id: string;
    readonly adapterSchemaVersion: number;
  };
  readonly capabilities: readonly CapabilityResolution[];
}

export const bindingModeForDimensions = (dimensions: DeploymentProfileDimensions): BindingMode => {
  if (dimensions.execution === 'hosted') return 'remote';
  return dimensions.provider === 'external' ? 'hybrid' : 'local';
};

export const capabilityBindingKey = (
  capabilityId: string,
  version: string,
  profileId: string,
): string => `${capabilityId}@${version}#${profileId}`;

const modeRank: Readonly<Record<BindingMode, number>> = {
  local: 0,
  hybrid: 1,
  remote: 2,
};

interface BindingCandidate {
  readonly profile: RegistryCapabilityProfile;
  readonly binding: RegistryCapabilityBinding;
  readonly artifact: RegistryCapabilityArtifact;
}

const candidatesFor = (capability: RegistryCapability): readonly BindingCandidate[] => {
  const profiles = new Map(capability.profiles.map((profile) => [profile.id, profile]));
  const artifacts = new Map(capability.artifacts.map((artifact) => [artifact.id, artifact]));
  return capability.bindings
    .map((binding) => {
      const profile = profiles.get(binding.profileId);
      const artifact = artifacts.get(binding.artifactId);
      if (profile === undefined || artifact === undefined) {
        throw new AgentKitError(
          'INVALID_REGISTRY_RECORD',
          `Capability ${capability.id}@${capability.version.value} binding ${binding.id} has unresolved references.`,
        );
      }
      return { profile, binding, artifact };
    })
    .sort(
      (left, right) =>
        Number(left.profile.dimensions.mutation === 'mutating') -
          Number(right.profile.dimensions.mutation === 'mutating') ||
        modeRank[left.binding.availability] - modeRank[right.binding.availability] ||
        compareCodeUnits(left.profile.id, right.profile.id) ||
        compareCodeUnits(left.binding.id, right.binding.id),
    );
};

const createBinding = (
  capability: RegistryCapability,
  candidate: BindingCandidate,
): ExecutionBinding => ({
  key: capabilityBindingKey(capability.id, capability.version.value, candidate.profile.id),
  id: candidate.binding.id,
  mode: candidate.binding.availability,
  interface: candidate.binding.interface,
  profileId: candidate.profile.id,
  dimensions: candidate.profile.dimensions,
  artifact: {
    ...candidate.artifact,
    sourceRevision: capability.source.revision,
  },
  setupRequired: candidate.profile.prerequisites.setupRequired,
  requiredSecretNames: [...candidate.profile.prerequisites.requiredSecrets].sort(compareCodeUnits),
  providerPrerequisites: [...candidate.profile.prerequisites.provider].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  ),
  permissions: [...candidate.profile.permissions.scopes].sort(compareCodeUnits),
  readinessSignals: [...candidate.profile.readiness.signals].sort(compareCodeUnits),
});

const resolveSelection = async (
  selection: CapabilitySelection,
  registry: CapabilityRegistryReader,
  adapter: HostAdapter,
): Promise<CapabilityResolution> => {
  const capability = await resolveRegistryCapability(registry, selection.id, selection.version);
  const candidates = candidatesFor(capability).filter(
    (candidate) => selection.profile === undefined || candidate.profile.id === selection.profile,
  );
  if (candidates.length === 0) {
    throw new AgentKitError(
      'CAPABILITY_PROFILE_NOT_FOUND',
      `Capability ${selection.id}@${capability.version.value} does not provide profile ${selection.profile ?? '(unspecified)'}.`,
      [`available profiles: ${capability.profiles.map((profile) => profile.id).join(', ')}`],
    );
  }

  const evaluated = candidates.map((candidate) => ({
    candidate,
    compatibility: adapter.evaluate({
      profile: candidate.profile,
      binding: candidate.binding,
      artifact: candidate.artifact,
    }),
  }));
  const compatible = evaluated.find((candidate) => candidate.compatibility.state === 'compatible');
  if (compatible !== undefined) {
    return {
      status: 'resolved',
      requestedVersion: selection.version ?? null,
      capability,
      profile: compatible.candidate.profile,
      binding: createBinding(capability, compatible.candidate),
      compatibility: { state: 'compatible', reasons: [] },
    };
  }

  const first = evaluated[0];
  if (first === undefined) {
    throw new AgentKitError(
      'CAPABILITY_PROFILE_NOT_FOUND',
      `Capability ${selection.id}@${capability.version.value} has no selectable bindings.`,
    );
  }
  return {
    status: 'incompatible',
    requestedVersion: selection.version ?? null,
    capability,
    profile: first.candidate.profile,
    registryBinding: first.candidate.binding,
    artifact: first.candidate.artifact,
    compatibility: {
      state: 'incompatible',
      reasons: first.compatibility.reasons.slice(0, 20),
    },
  };
};

export const resolveAgentDefinition = async (
  definitionInput: unknown,
  registry: CapabilityRegistryReader,
  adapter: HostAdapter,
): Promise<AgentResolution> => {
  const definition = parseAgentDefinition(definitionInput);
  const capabilities: CapabilityResolution[] = [];
  for (const selection of definition.capabilities) {
    capabilities.push(await resolveSelection(selection, registry, adapter));
  }
  return {
    definition,
    host: { id: adapter.id, adapterSchemaVersion: adapter.schemaVersion },
    capabilities,
  };
};

export const assertCompatibleResolution = (
  resolution: AgentResolution,
): readonly ResolvedCapability[] => {
  const incompatible = resolution.capabilities.filter(
    (capability): capability is IncompatibleCapability => capability.status === 'incompatible',
  );
  if (incompatible.length > 0) {
    throw new AgentKitError(
      'INCOMPATIBLE_BINDING',
      `Agent ${resolution.definition.id}@${resolution.definition.version} has no compatible ${resolution.host.id} build.`,
      incompatible.flatMap((capability) =>
        capability.compatibility.reasons.map(
          (reason) =>
            `${capability.capability.id}@${capability.capability.version.value}/${capability.profile.id}: ${reason}`,
        ),
      ),
    );
  }
  return resolution.capabilities.filter(
    (capability): capability is ResolvedCapability => capability.status === 'resolved',
  );
};
