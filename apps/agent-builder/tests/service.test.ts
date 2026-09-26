import { describe, expect, it } from 'vitest';
import { BuilderServiceError } from '../src/server/errors.js';
import { createBuilderService } from '../src/server/service.js';
import { developerOptimizationPreset } from '../src/shared/developer-optimization-preset.js';

describe('Agent Builder service', () => {
  it('presents the real first-party Registry without owning duplicate records', async () => {
    const service = createBuilderService();
    const catalog = await service.listCapabilities();

    expect(catalog.capabilities).toHaveLength(7);
    expect(catalog.capabilities.map((capability) => capability.id)).toEqual([
      'ast-summarizer',
      'azure',
      'data-cruncher',
      'doc-rag',
      'document-optimizer',
      'git-optimizer',
      'vision',
    ]);
    expect(catalog.capabilities.find(({ id }) => id === 'azure')).toMatchObject({
      version: '0.3.0',
      versionStatus: 'released',
      bindingModes: ['remote'],
      profiles: expect.arrayContaining([
        expect.objectContaining({
          id: 'hosted-read-only',
          bindingModes: ['remote'],
          dimensions: expect.objectContaining({
            execution: 'hosted',
            access: 'authenticated-service',
            mutation: 'read-only',
          }),
        }),
      ]),
    });
  });

  it('leaves automatic profile choice to Agent Kit and does not prefer mutation', async () => {
    const service = createBuilderService();
    const result = await service.buildAgent({
      ...developerOptimizationPreset,
      capabilities: [{ id: 'vision' }, { id: 'azure' }],
    });

    expect(
      result.capabilities.map(({ id, profile, binding }) => ({
        id,
        profile: profile.id,
        mutation: profile.mutation,
        mode: binding.mode,
      })),
    ).toEqual([
      {
        id: 'azure',
        profile: 'hosted-read-only',
        mutation: 'read-only',
        mode: 'remote',
      },
      {
        id: 'vision',
        profile: 'local-package',
        mutation: 'mutating',
        mode: 'local',
      },
    ]);
  });

  it('accepts explicit Registry profiles and rejects unknown profiles through Agent Kit', async () => {
    const service = createBuilderService();
    const custom = await service.buildAgent({
      ...developerOptimizationPreset,
      capabilities: [
        { id: 'vision', profile: 'hybrid-azure-package' },
        { id: 'azure', profile: 'hosted-mutating' },
      ],
    });

    expect(
      custom.capabilities.map(({ id, profile, binding }) => ({
        id,
        profile: profile.id,
        mutation: profile.mutation,
        mode: binding.mode,
      })),
    ).toEqual([
      {
        id: 'azure',
        profile: 'hosted-mutating',
        mutation: 'mutating',
        mode: 'remote',
      },
      {
        id: 'vision',
        profile: 'hybrid-azure-package',
        mutation: 'mutating',
        mode: 'hybrid',
      },
    ]);

    await expect(
      service.buildAgent({
        ...developerOptimizationPreset,
        capabilities: [{ id: 'azure', profile: 'hosted-read-only-http' }],
      }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_PROFILE_NOT_FOUND',
      status: 400,
    });
  });

  it('surfaces Registry loading failures as a bounded service error and permits retry', async () => {
    let attempts = 0;
    const service = createBuilderService({
      loadRegistry: () => {
        attempts += 1;
        return Promise.reject(new Error('registry fixture failed'));
      },
    });

    await expect(service.listCapabilities()).rejects.toMatchObject({
      name: 'BuilderServiceError',
      code: 'REGISTRY_UNAVAILABLE',
      status: 503,
    });
    await expect(service.listCapabilities()).rejects.toBeInstanceOf(BuilderServiceError);
    expect(attempts).toBe(2);
  });

  it.each([
    ['blank name', { ...developerOptimizationPreset, name: '   ' }],
    ['invalid id', { ...developerOptimizationPreset, id: 'Not Valid' }],
    ['blank instructions', { ...developerOptimizationPreset, instructions: '\n ' }],
    ['no capabilities', { ...developerOptimizationPreset, capabilities: [] }],
  ])('delegates %s validation to Agent Kit', async (_label, definition) => {
    const service = createBuilderService();

    await expect(service.buildAgent(definition)).rejects.toMatchObject({
      code: 'INVALID_AGENT_DEFINITION',
      status: 400,
    });
  });

  it('returns Agent Kit unknown-capability errors without a stack-shaped response', async () => {
    const service = createBuilderService();

    await expect(
      service.buildAgent({
        ...developerOptimizationPreset,
        capabilities: [{ id: 'not-registered' }],
      }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_FOUND',
      issues: [],
      status: 400,
    });
  });
});
