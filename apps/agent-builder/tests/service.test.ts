import {
  AgentKitError,
  READINESS_SCHEMA_VERSION,
  createPreparationPlan,
  prepareAgent as prepareAgentWithAgentKit,
  type AgentBuild,
  type PreparationDriver,
  type PreparationDriverRequest,
  type ReadinessSnapshot,
  type VsCodeAdapterOutput,
} from '@agent-tool-platform/agent-kit';
import { describe, expect, it, vi } from 'vitest';
import { asPreparationServiceError, BuilderServiceError } from '../src/server/errors.js';
import {
  BuilderInstanceStoreError,
  createInMemoryBuilderInstanceStore,
} from '../src/server/instance-store.js';
import {
  createBuilderService as createProductionBuilderService,
  type BuilderServiceOptions,
} from '../src/server/service.js';
import { LOCAL_VSCODE_ENVIRONMENT_ID } from '../src/shared/contracts.js';
import { developerOptimizationPreset } from '../src/shared/developer-optimization-preset.js';

const prepareRequest = (
  expectedLockDigest: string,
  environmentId = LOCAL_VSCODE_ENVIRONMENT_ID,
) => ({
  definition: developerOptimizationPreset,
  expectedLockDigest,
  environmentId,
});

const readySnapshotFor = (build: AgentBuild<VsCodeAdapterOutput>): ReadinessSnapshot => ({
  schemaVersion: READINESS_SCHEMA_VERSION,
  availableLocalBindings: build.capabilities
    .filter(({ binding }) => binding.mode === 'local' || binding.mode === 'hybrid')
    .map(({ binding }) => binding.key),
  availableRemoteBindings: build.capabilities
    .filter(({ binding }) => binding.mode === 'remote')
    .map(({ binding }) => binding.key),
  availableProviderPrerequisites: build.capabilities.flatMap(({ binding }) =>
    binding.providerPrerequisites.map((item) => `${binding.key}/${item.id}`),
  ),
  configuration: build.capabilities
    .filter(({ binding }) => binding.requiredSecretNames.length > 0)
    .map(({ binding }) => ({
      bindingKey: binding.key,
      availableNames: [...binding.requiredSecretNames],
    })),
});

const createBuilderService = (options: BuilderServiceOptions = {}) =>
  createProductionBuilderService({
    instanceStore: createInMemoryBuilderInstanceStore(),
    ...options,
  });

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

  it('reconstructs the exact Build, invokes both public H7 APIs, and presents the deterministic plan', async () => {
    const createPlan = vi.fn(createPreparationPlan);
    const runPreparation = vi.fn(prepareAgentWithAgentKit);
    const service = createBuilderService({
      preparationApi: {
        createPreparationPlan: createPlan,
        prepareAgent: runPreparation,
      },
    });
    const build = await service.buildAgent(developerOptimizationPreset);

    const first = await service.prepareAgent(prepareRequest(build.lockDigest));
    const second = await service.prepareAgent(prepareRequest(build.lockDigest));

    expect(createPlan).toHaveBeenCalledTimes(2);
    expect(runPreparation).toHaveBeenCalledTimes(2);
    expect(createPlan.mock.calls[0]?.[0]).toMatchObject({
      lockDigest: build.lockDigest,
      definition: {
        id: developerOptimizationPreset.id,
        version: developerOptimizationPreset.version,
      },
    });
    expect(runPreparation.mock.calls[0]?.[0]).toMatchObject({
      lockDigest: build.lockDigest,
      definition: {
        id: developerOptimizationPreset.id,
        version: developerOptimizationPreset.version,
      },
    });
    expect(first.plan).toEqual(second.plan);
    expect(first.plan.environmentId).toBe(LOCAL_VSCODE_ENVIRONMENT_ID);
    expect(first.instance.instanceId).toBe(second.instance.instanceId);
    expect(first.instance.instanceId).toBe(first.plan.instanceId);
    expect(first.preparation.disposition).toBe('created');
    expect(second.preparation.disposition).toBe('updated');
    expect(runPreparation.mock.calls[1]?.[1]).toMatchObject({
      existingInstance: { instanceId: first.instance.instanceId },
    });
    expect(first.plan.actions.map(({ kind }) => kind)).toEqual([
      'make-local-artifact-available',
      'make-local-artifact-available',
      'make-local-artifact-available',
      'make-local-artifact-available',
      'make-local-artifact-available',
      'make-local-artifact-available',
      'prepare-host-integration',
      'verify-configuration',
      'verify-provider-prerequisite',
      'verify-provider-prerequisite',
      'verify-remote-connection',
    ]);
  });

  it('rejects a stale displayed lock before either H7 preparation API is called', async () => {
    const createPlan = vi.fn(createPreparationPlan);
    const runPreparation = vi.fn(prepareAgentWithAgentKit);
    const service = createBuilderService({
      preparationApi: {
        createPreparationPlan: createPlan,
        prepareAgent: runPreparation,
      },
    });
    const build = await service.buildAgent(developerOptimizationPreset);

    await expect(
      service.prepareAgent(prepareRequest(`sha256:${'0'.repeat(64)}`)),
    ).rejects.toMatchObject({
      code: 'BUILD_LOCK_MISMATCH',
      status: 409,
    });
    await expect(
      service.prepareAgent({
        ...prepareRequest(build.lockDigest),
        definition: { ...developerOptimizationPreset, instructions: 'Changed after Build.' },
      }),
    ).rejects.toMatchObject({
      code: 'BUILD_LOCK_MISMATCH',
      status: 409,
    });
    expect(createPlan).not.toHaveBeenCalled();
    expect(runPreparation).not.toHaveBeenCalled();
  });

  it('uses conservative production evidence and surfaces every unresolved preparation class', async () => {
    const service = createBuilderService();
    const build = await service.buildAgent(developerOptimizationPreset);
    const prepared = await service.prepareAgent(prepareRequest(build.lockDigest));
    const azure = prepared.readiness.capabilities.find(({ id }) => id === 'azure');
    const vision = prepared.readiness.capabilities.find(({ id }) => id === 'vision');

    expect(prepared.instance.state).toBe('NEEDS_SETUP');
    expect(prepared.preparation.runnable).toBe(false);
    expect(prepared.preparation.summary).toEqual({
      ready: 0,
      setupRequired: prepared.plan.actions.length,
      unavailable: 0,
    });
    expect(
      prepared.preparation.actionResults.every(({ status }) => status === 'setup-required'),
    ).toBe(true);
    expect(prepared.preparation.hostIntegration.status).toBe('setup-required');
    expect(vision).toMatchObject({
      profile: 'local-package',
      bindingMode: 'local',
      state: 'local-setup-required',
      instanceState: 'NEEDS_SETUP',
    });
    expect(azure).toMatchObject({
      profile: 'hosted-read-only',
      bindingMode: 'remote',
      state: 'missing-configuration',
      instanceState: 'NEEDS_SETUP',
    });
    expect(prepared.setupRequirements.map(({ action }) => action.concern)).toEqual(
      expect.arrayContaining([
        'local-artifact',
        'configuration',
        'remote-connection',
        'provider-prerequisite',
        'host-integration',
      ]),
    );
    expect(JSON.stringify(prepared)).not.toContain(developerOptimizationPreset.instructions);
    expect(JSON.stringify(prepared)).not.toMatch(/[A-Za-z]:\\/u);
  });

  it('reaches READY only with controlled evidence and a controlled driver', async () => {
    const execute = vi.fn(async (request: PreparationDriverRequest) => {
      expect(request.environmentId).toBe('synthetic-vscode');
      expect(request.action.kind).toBe('prepare-host-integration');
      return { status: 'success' as const };
    });
    const driver: PreparationDriver = { execute };
    const service = createBuilderService({
      preparationEnvironment: {
        environmentId: 'synthetic-vscode',
        readinessSnapshot: readySnapshotFor,
        hostIntegration: 'setup-required',
        driver,
        clock: { now: () => new Date('2026-09-27T12:00:00.000Z') },
      },
    });
    const build = await service.buildAgent(developerOptimizationPreset);
    const prepared = await service.prepareAgent(
      prepareRequest(build.lockDigest, 'synthetic-vscode'),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(prepared.instance.state).toBe('READY');
    expect(prepared.preparation.runnable).toBe(true);
    expect(prepared.setupRequirements).toEqual([]);
    expect(prepared.preparation.hostIntegration.status).toBe('success');
    expect(
      prepared.preparation.actionResults.every(
        ({ status }) => status === 'success' || status === 'already-ready',
      ),
    ).toBe(true);

    const production = createBuilderService();
    const productionBuild = await production.buildAgent(developerOptimizationPreset);
    const conservative = await production.prepareAgent(prepareRequest(productionBuild.lockDigest));
    expect(conservative.instance.state).toBe('NEEDS_SETUP');
    expect(conservative.preparation.runnable).toBe(false);
  });

  it('loads the persisted instance into H7 for deterministic update reconciliation', async () => {
    const instanceStore = createInMemoryBuilderInstanceStore();
    let capturedExistingInstance: unknown;
    const captureExistingInstance = vi.fn(
      async (...parameters: Parameters<typeof prepareAgentWithAgentKit>) => {
        capturedExistingInstance = parameters[1].existingInstance;
        return prepareAgentWithAgentKit(...parameters);
      },
    );
    const firstService = createBuilderService({
      instanceStore,
      preparationEnvironment: {
        environmentId: 'reconciliation-vscode',
        readinessSnapshot: readySnapshotFor,
        hostIntegration: 'available',
        clock: { now: () => new Date('2026-09-27T12:00:00.000Z') },
      },
    });
    const build = await firstService.buildAgent(developerOptimizationPreset);
    const first = await firstService.prepareAgent(
      prepareRequest(build.lockDigest, 'reconciliation-vscode'),
    );

    const secondService = createBuilderService({
      instanceStore,
      preparationEnvironment: {
        environmentId: 'reconciliation-vscode',
        readinessSnapshot: readySnapshotFor,
        hostIntegration: 'available',
        clock: { now: () => new Date('2026-09-27T13:00:00.000Z') },
      },
      preparationApi: {
        createPreparationPlan,
        prepareAgent: captureExistingInstance,
      },
    });
    const second = await secondService.prepareAgent(
      prepareRequest(build.lockDigest, 'reconciliation-vscode'),
    );

    expect(capturedExistingInstance).toMatchObject({
      instanceId: first.instance.instanceId,
      preparedAt: '2026-09-27T12:00:00.000Z',
    });
    expect(first.preparation.disposition).toBe('created');
    expect(second.preparation.disposition).toBe('updated');
    expect(second.instance.instanceId).toBe(first.instance.instanceId);
    expect(second.instance.preparedAt).toBe('2026-09-27T13:00:00.000Z');
    await expect(instanceStore.list()).resolves.toMatchObject({
      instances: [{ instanceId: first.instance.instanceId }],
      diagnostics: { invalidRecordCount: 0 },
    });
  });

  it('keeps changed canonical Builds as distinct local Agent Instances', async () => {
    const instanceStore = createInMemoryBuilderInstanceStore();
    const service = createBuilderService({ instanceStore });
    const firstBuild = await service.buildAgent(developerOptimizationPreset);
    const first = await service.prepareAgent(prepareRequest(firstBuild.lockDigest));
    const changedDefinition = {
      ...developerOptimizationPreset,
      instructions: `${developerOptimizationPreset.instructions}\nPreserve changed-build evidence.`,
    };
    const secondBuild = await service.buildAgent(changedDefinition);
    const second = await service.prepareAgent({
      definition: changedDefinition,
      expectedLockDigest: secondBuild.lockDigest,
      environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
    });

    expect(secondBuild.lockDigest).not.toBe(firstBuild.lockDigest);
    expect(second.instance.instanceId).not.toBe(first.instance.instanceId);
    const discovery = await service.listInstances();
    expect(discovery.instances.map(({ instanceId }) => instanceId)).toEqual(
      expect.arrayContaining([first.instance.instanceId, second.instance.instanceId]),
    );
    expect(discovery.instances).toHaveLength(2);
  });

  it('derives distinct instance identity from a different injected environment', async () => {
    const instanceStore = createInMemoryBuilderInstanceStore();
    const firstService = createBuilderService({
      instanceStore,
      preparationEnvironment: {
        environmentId: 'environment-a',
        readinessSnapshot: readySnapshotFor,
        hostIntegration: 'available',
      },
    });
    const secondService = createBuilderService({
      instanceStore,
      preparationEnvironment: {
        environmentId: 'environment-b',
        readinessSnapshot: readySnapshotFor,
        hostIntegration: 'available',
      },
    });
    const build = await firstService.buildAgent(developerOptimizationPreset);
    const first = await firstService.prepareAgent(
      prepareRequest(build.lockDigest, 'environment-a'),
    );
    const second = await secondService.prepareAgent(
      prepareRequest(build.lockDigest, 'environment-b'),
    );

    expect(second.instance.instanceId).not.toBe(first.instance.instanceId);
    await expect(instanceStore.list()).resolves.toMatchObject({
      instances: expect.arrayContaining([
        expect.objectContaining({ instanceId: first.instance.instanceId }),
        expect.objectContaining({ instanceId: second.instance.instanceId }),
      ]),
    });
  });

  it('returns a bounded failure when a successful preparation cannot be persisted', async () => {
    const privatePath = 'C:\\Users\\private\\instances\\record.json';
    const service = createBuilderService({
      instanceStore: {
        async get() {
          return undefined;
        },
        async put() {
          throw new BuilderInstanceStoreError('write', 'fixture persistence failure', {
            cause: new Error(privatePath),
          });
        },
        async list() {
          return {
            instances: [],
            diagnostics: {
              inspectedRecordCount: 0,
              invalidRecordCount: 0,
              truncated: false,
              warnings: [],
            },
          };
        },
      },
    });
    const build = await service.buildAgent(developerOptimizationPreset);

    await expect(service.prepareAgent(prepareRequest(build.lockDigest))).rejects.toMatchObject({
      code: 'INSTANCE_STORAGE_FAILED',
      status: 500,
      issues: [],
      message: 'The Prepared Agent Instance could not be reconciled with local storage.',
    });
  });

  it.each([
    ['INVALID_PREPARATION_INPUT', 400],
    ['INVALID_AGENT_INSTANCE', 400],
    ['INVALID_PREPARATION_RESULT', 500],
    ['PREPARATION_FAILED', 502],
  ] as const)('preserves bounded %s error mapping', (code, status) => {
    const converted = asPreparationServiceError(
      new AgentKitError(code, 'Bounded preparation failure.', ['safe issue']),
    );

    expect(converted).toMatchObject({
      code,
      status,
      issues: ['safe issue'],
    });
  });
});
