import { describe, expect, it } from 'vitest';
import type { CapabilityCatalogItem } from '../src/shared/contracts.js';
import { localProfileFor, planCapabilitySelections } from '../src/client/execution-policy.js';
import { catalogFixture } from './fixtures.js';

describe('Builder execution policy planning', () => {
  it('keeps Automatic profile-free so Agent Kit owns default resolution', () => {
    expect(
      planCapabilitySelections(
        ['vision', 'azure'],
        'automatic',
        { vision: 'hybrid-azure-package' },
        catalogFixture,
      ),
    ).toEqual({
      selections: [{ id: 'vision' }, { id: 'azure' }],
      issues: [],
    });
  });

  it('writes explicit local profiles and reports capabilities without one', () => {
    const plan = planCapabilitySelections(
      ['ast-summarizer', 'vision', 'azure'],
      'local-only',
      {},
      catalogFixture,
    );

    expect(plan.selections).toEqual([
      { id: 'ast-summarizer', profile: 'local-package' },
      { id: 'vision', profile: 'local-package' },
    ]);
    expect(plan.issues).toEqual([
      'Azure Agent Tool Server has no Registry profile that can execute locally. Choose Automatic or Custom, or remove this capability.',
    ]);
  });

  it('favors a read-only local profile over a mutating local profile', () => {
    const capability: CapabilityCatalogItem = {
      ...catalogFixture.capabilities[0]!,
      profiles: [
        {
          ...catalogFixture.capabilities[0]!.profiles[0]!,
          id: 'local-mutating',
          dimensions: {
            ...catalogFixture.capabilities[0]!.profiles[0]!.dimensions,
            mutation: 'mutating',
          },
        },
        {
          ...catalogFixture.capabilities[0]!.profiles[0]!,
          id: 'local-read-only',
        },
      ],
    };

    expect(localProfileFor(capability)?.id).toBe('local-read-only');
  });

  it('writes only Custom profile choices that the user explicitly selected', () => {
    expect(
      planCapabilitySelections(
        ['ast-summarizer', 'vision', 'azure'],
        'custom',
        {
          vision: 'hybrid-azure-package',
          azure: 'hosted-read-only',
          'not-selected': 'unused',
        },
        catalogFixture,
      ),
    ).toEqual({
      selections: [
        { id: 'ast-summarizer' },
        { id: 'vision', profile: 'hybrid-azure-package' },
        { id: 'azure', profile: 'hosted-read-only' },
      ],
      issues: [],
    });
  });
});
