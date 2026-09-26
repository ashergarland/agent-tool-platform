import type { CapabilitySelection } from '@agent-tool-platform/agent-kit';
import type {
  CapabilityCatalogItem,
  CapabilityCatalogProfile,
  CapabilityCatalogResponse,
} from '../shared/contracts.js';

export type ExecutionPolicy = 'automatic' | 'local-only' | 'custom';

export interface CapabilitySelectionPlan {
  readonly selections: readonly CapabilitySelection[];
  readonly issues: readonly string[];
}

const compareProfileIds = (
  left: CapabilityCatalogProfile,
  right: CapabilityCatalogProfile,
): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

export const selectableProfiles = (
  capability: CapabilityCatalogItem,
): readonly CapabilityCatalogProfile[] =>
  capability.profiles
    .filter((profile) => profile.bindingModes.length > 0)
    .sort(
      (left, right) =>
        Number(left.dimensions.mutation === 'mutating') -
          Number(right.dimensions.mutation === 'mutating') || compareProfileIds(left, right),
    );

export const localProfileFor = (
  capability: CapabilityCatalogItem,
): CapabilityCatalogProfile | undefined =>
  selectableProfiles(capability).find((profile) => profile.bindingModes.includes('local'));

export const planCapabilitySelections = (
  selectedCapabilityIds: readonly string[],
  policy: ExecutionPolicy,
  profileSelections: Readonly<Record<string, string>>,
  catalog: CapabilityCatalogResponse | undefined,
): CapabilitySelectionPlan => {
  if (policy === 'automatic') {
    return {
      selections: selectedCapabilityIds.map((id) => ({ id })),
      issues: [],
    };
  }

  if (policy === 'custom') {
    return {
      selections: selectedCapabilityIds.map((id) => {
        const profile = profileSelections[id];
        return profile === undefined ? { id } : { id, profile };
      }),
      issues: [],
    };
  }

  if (catalog === undefined) {
    return {
      selections: [],
      issues: ['Capability profile data must finish loading before Local only can be built.'],
    };
  }

  const catalogById = new Map(
    catalog.capabilities.map((capability) => [capability.id, capability]),
  );
  const selections: CapabilitySelection[] = [];
  const issues: string[] = [];
  for (const id of selectedCapabilityIds) {
    const capability = catalogById.get(id);
    if (capability === undefined) {
      issues.push(`${id} is not available in the current Registry.`);
      continue;
    }
    const profile = localProfileFor(capability);
    if (profile === undefined) {
      issues.push(
        `${capability.displayName} has no Registry profile that can execute locally. Choose Automatic or Custom, or remove this capability.`,
      );
      continue;
    }
    selections.push({ id, profile: profile.id });
  }

  return { selections, issues };
};
