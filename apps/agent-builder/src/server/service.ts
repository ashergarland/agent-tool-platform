import {
  AgentKitError,
  READINESS_SCHEMA_VERSION,
  buildVsCodeAgent,
  createPreparationPlan as createAgentKitPreparationPlan,
  parsePreparedAgentInstance,
  prepareAgent as prepareAgentWithAgentKit,
  type AgentBuild,
  type AgentInstanceState,
  type BindingMode,
  type PreparationAction,
  type PreparationClock,
  type PreparationDriver,
  type PreparationHostIntegrationEvidence,
  type PreparationPlan,
  type PreparationResult,
  type PreparedAgentInstance,
  type ReadinessSnapshot,
  type VsCodeAdapterOutput,
} from '@agent-tool-platform/agent-kit';
import {
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
  type CapabilityRegistry,
  type CapabilityRegistryReader,
} from '@agent-tool-platform/capability-registry';
import {
  LOCAL_VSCODE_ENVIRONMENT_ID,
  type BuildAgentResult,
  type BuildCapabilityResult,
  type CapabilityCatalogItem,
  type CapabilityCatalogResponse,
  type GeneratedArtifact,
  type LocalAgentInstance,
  type LocalAgentInstanceDiscoveryResponse,
  type PrepareActionResultPresentation,
  type PrepareAgentResult,
  type PreparationActionPresentation,
  type PreparedInstanceState,
} from '../shared/contracts.js';
import {
  asBuildServiceError,
  asInstanceDiscoveryServiceError,
  asInstanceStorageServiceError,
  asPreparationServiceError,
  asRegistryServiceError,
  BuilderServiceError,
} from './errors.js';
import {
  BuilderInstanceStoreError,
  createFileSystemBuilderInstanceStore,
  type BuilderInstanceStore,
} from './instance-store.js';

export interface BuilderService {
  listCapabilities(this: void): Promise<CapabilityCatalogResponse>;
  listInstances(this: void): Promise<LocalAgentInstanceDiscoveryResponse>;
  buildAgent(this: void, definition: unknown): Promise<BuildAgentResult>;
  prepareAgent(this: void, request: BuilderPrepareInput): Promise<PrepareAgentResult>;
}

export interface BuilderPrepareInput {
  readonly definition: unknown;
  readonly expectedLockDigest: string;
  readonly environmentId: string;
}

export interface BuilderPreparationEnvironment {
  readonly environmentId: string;
  readonly readinessSnapshot:
    | ReadinessSnapshot
    | ((build: AgentBuild<VsCodeAdapterOutput>) => Promise<ReadinessSnapshot> | ReadinessSnapshot);
  readonly hostIntegration: PreparationHostIntegrationEvidence;
  readonly driver?: PreparationDriver;
  readonly clock?: PreparationClock;
}

export interface BuilderPreparationApi {
  readonly createPreparationPlan: typeof createAgentKitPreparationPlan;
  readonly prepareAgent: typeof prepareAgentWithAgentKit;
}

export interface BuilderServiceOptions {
  readonly loadRegistry?: () => Promise<CapabilityRegistry>;
  readonly instanceStore?: BuilderInstanceStore;
  readonly preparationEnvironment?: BuilderPreparationEnvironment;
  readonly preparationApi?: BuilderPreparationApi;
}

const localVsCodePreparationEnvironment = (): BuilderPreparationEnvironment => ({
  environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
  readinessSnapshot: { schemaVersion: READINESS_SCHEMA_VERSION },
  hostIntegration: 'setup-required',
});

const bindingModeOrder: Readonly<Record<BindingMode, number>> = {
  local: 0,
  hybrid: 1,
  remote: 2,
};

const catalogItem = (
  capability: CapabilityRegistry['capabilities'][number],
): CapabilityCatalogItem => ({
  id: capability.id,
  displayName: capability.displayName,
  description: capability.description,
  version: capability.version.value,
  versionStatus: capability.version.status,
  category: capability.category.displayName,
  tags: capability.tags,
  toolCount: capability.toolCount,
  profiles: capability.profiles.map((profile) => ({
    id: profile.id,
    description: profile.description,
    dimensions: profile.dimensions,
    bindingModes: [
      ...new Set(
        capability.bindings
          .filter((binding) => binding.profileId === profile.id)
          .map((binding) => binding.availability),
      ),
    ].sort((left, right) => bindingModeOrder[left] - bindingModeOrder[right]),
    setupRequired: profile.prerequisites.setupRequired,
    setupSummary: profile.prerequisites.summary,
    readinessSummary: profile.readiness.summary,
  })),
  bindingModes: [...new Set(capability.bindings.map((binding) => binding.availability))].sort(
    (left, right) => bindingModeOrder[left] - bindingModeOrder[right],
  ),
  stateChanging: capability.stateChanging,
});

const readinessFor = (
  build: AgentBuild<VsCodeAdapterOutput>,
  capabilityId: string,
  version: string,
  profileId: string,
): AgentBuild['readiness']['capabilities'][number] => {
  const readiness = build.readiness.capabilities.find(
    (candidate) =>
      candidate.id === capabilityId &&
      candidate.version === version &&
      candidate.profileId === profileId,
  );
  if (readiness === undefined) {
    throw new Error(`Agent Kit omitted readiness for ${capabilityId}@${version}#${profileId}.`);
  }
  return readiness;
};

const capabilityResult = (
  build: AgentBuild<VsCodeAdapterOutput>,
  capability: AgentBuild['capabilities'][number],
): BuildCapabilityResult => {
  const readiness = readinessFor(
    build,
    capability.capability.id,
    capability.capability.version.value,
    capability.profile.id,
  );
  return {
    id: capability.capability.id,
    displayName: capability.capability.displayName,
    description: capability.capability.description,
    resolvedVersion: capability.capability.version.value,
    profile: {
      id: capability.profile.id,
      description: capability.profile.description,
      mutation: capability.profile.dimensions.mutation,
    },
    binding: {
      id: capability.binding.id,
      mode: capability.binding.mode,
      interface: capability.binding.interface,
    },
    compatibility: capability.compatibility,
    artifact: {
      kind: capability.binding.artifact.kind,
      availability: capability.binding.artifact.availability,
    },
    readiness: {
      state: readiness.state,
      requirements: readiness.requirements,
      setupRequired: capability.profile.prerequisites.setupRequired,
      setupSummary: capability.profile.prerequisites.summary,
      summary: capability.profile.readiness.summary,
    },
    configuration: {
      endpointRequired: capability.binding.mode === 'remote',
      requiredNames: capability.binding.requiredSecretNames,
      headers:
        capability.binding.httpClient?.headers.map((header) => ({
          name: header.name,
          configurationName: header.configurationName,
          prefix: header.prefix,
        })) ?? [],
    },
  };
};

const generatedArtifacts = (
  build: AgentBuild<VsCodeAdapterOutput>,
): readonly GeneratedArtifact[] => {
  const [agentFile, mcpFile] = build.adapter.files;
  return [
    {
      kind: 'lock',
      label: 'agent.lock',
      path: 'agent.lock',
      mediaType: 'application/json',
      content: build.lockText,
    },
    {
      kind: 'vscode-agent',
      label: 'VS Code agent',
      path: agentFile.path,
      mediaType: agentFile.mediaType,
      content: agentFile.content,
    },
    {
      kind: 'mcp',
      label: 'MCP configuration',
      path: mcpFile.path,
      mediaType: mcpFile.mediaType,
      content: mcpFile.content,
    },
    {
      kind: 'instructions',
      label: 'Composed instructions',
      path: 'composed-instructions.md',
      mediaType: 'text/markdown',
      content: build.instructions.rendered,
    },
  ];
};

const presentBuild = (build: AgentBuild<VsCodeAdapterOutput>): BuildAgentResult => {
  const capabilities = build.capabilities.map((capability) => capabilityResult(build, capability));
  const execution: Record<BindingMode, number> = { local: 0, remote: 0, hybrid: 0 };
  for (const capability of capabilities) execution[capability.binding.mode] += 1;

  const readyStates = new Set(['available-local', 'ready']);
  const readiness = {
    setupRequired: capabilities.filter((capability) => !readyStates.has(capability.readiness.state))
      .length,
    configurationRequired: capabilities.filter(
      (capability) => capability.readiness.state === 'missing-configuration',
    ).length,
    ready: capabilities.filter((capability) => readyStates.has(capability.readiness.state)).length,
  };
  const artifacts = generatedArtifacts(build);
  const agentFile = artifacts.find((artifact) => artifact.kind === 'vscode-agent');
  if (agentFile === undefined) throw new Error('Agent Kit omitted the VS Code agent file.');

  return {
    agent: {
      id: build.definition.id,
      name: build.definition.name,
      version: build.definition.version,
    },
    lockDigest: build.lockDigest,
    capabilities,
    execution,
    readiness,
    vsCode: {
      generated: true,
      agentPath: agentFile.path,
      mcpPath: '.vscode/mcp.json',
      serverCount: capabilities.length,
    },
    artifacts,
    instanceIdentity: build.instanceIdentity,
  };
};

const preparedInstanceState = (state: AgentInstanceState): PreparedInstanceState => {
  if (state === 'READY' || state === 'NEEDS_SETUP' || state === 'UNAVAILABLE') return state;
  throw new AgentKitError(
    'INVALID_PREPARATION_RESULT',
    `Prepare returned unsupported runtime state ${state}.`,
  );
};

const presentLocalInstance = (instance: PreparedAgentInstance): LocalAgentInstance => {
  const bindingSummary = { local: 0, remote: 0, hybrid: 0, total: instance.bindings.length };
  for (const binding of instance.bindings) bindingSummary[binding.mode] += 1;
  return {
    instanceId: instance.instanceId,
    agent: {
      id: instance.agentDefinition.id,
      version: instance.agentDefinition.version,
    },
    build: { lockDigest: instance.build.lockDigest },
    environment: {
      id: instance.environmentId,
      label: 'Local · VS Code',
    },
    host: instance.host,
    preparedAt: instance.preparedAt,
    state: instance.state,
    bindingSummary,
    bindings: instance.bindings.map((binding) => ({
      capabilityId: binding.capabilityId,
      capabilityVersion: binding.capabilityVersion,
      profile: binding.profileId,
      mode: binding.mode,
      readiness: binding.readiness,
      state: binding.state,
    })),
  };
};

const preparationCapability = (
  build: AgentBuild<VsCodeAdapterOutput>,
  action: Exclude<PreparationAction, { readonly kind: 'prepare-host-integration' }>,
): NonNullable<PreparationActionPresentation['capability']> => {
  const capability = build.capabilities.find(
    (candidate) => candidate.binding.key === action.binding.key,
  );
  if (capability === undefined) {
    throw new AgentKitError(
      'INVALID_PREPARATION_RESULT',
      'A preparation action has no matching resolved capability.',
      [`actionId: ${action.actionId}`],
    );
  }
  return {
    id: action.binding.capabilityId,
    displayName: capability.capability.displayName,
    version: action.binding.capabilityVersion,
    profile: action.binding.profileId,
    bindingMode: action.binding.mode,
  };
};

const presentPreparationAction = (
  build: AgentBuild<VsCodeAdapterOutput>,
  action: PreparationAction,
): PreparationActionPresentation => {
  if (action.kind === 'prepare-host-integration') {
    return {
      actionId: action.actionId,
      kind: action.kind,
      concern: 'host-integration',
      title: 'Prepare generated VS Code host integration',
      host: {
        id: action.host.id,
        adapterSchemaVersion: action.host.adapterSchemaVersion,
        files: action.files,
      },
    };
  }

  const capability = preparationCapability(build, action);
  switch (action.kind) {
    case 'verify-local-artifact':
      return {
        actionId: action.actionId,
        kind: action.kind,
        concern: 'local-artifact',
        title: `Verify ${capability.displayName} local artifact`,
        capability,
        artifact: {
          id: action.artifact.id,
          identifier: action.artifact.identifier,
          kind: action.artifact.kind,
          version: action.artifact.version,
          availability: action.artifact.availability,
        },
      };
    case 'make-local-artifact-available':
      return {
        actionId: action.actionId,
        kind: action.kind,
        concern: 'local-artifact',
        title: `Make ${capability.displayName} local artifact available`,
        capability,
        artifact: {
          id: action.artifact.id,
          identifier: action.artifact.identifier,
          kind: action.artifact.kind,
          version: action.artifact.version,
          availability: action.artifact.availability,
        },
      };
    case 'verify-configuration':
      return {
        actionId: action.actionId,
        kind: action.kind,
        concern: 'configuration',
        title: `Verify ${capability.displayName} configuration`,
        capability,
        configurationName: action.configurationName,
      };
    case 'verify-remote-connection':
      return {
        actionId: action.actionId,
        kind: action.kind,
        concern: 'remote-connection',
        title: `Verify ${capability.displayName} remote connection`,
        capability,
      };
    case 'verify-provider-prerequisite':
      return {
        actionId: action.actionId,
        kind: action.kind,
        concern: 'provider-prerequisite',
        title: `Verify ${capability.displayName} provider prerequisite`,
        capability,
        prerequisiteId: action.prerequisiteId,
      };
  }
  throw new AgentKitError(
    'INVALID_PREPARATION_RESULT',
    'Prepare returned an unsupported preparation action.',
  );
};

const presentPreparation = (
  build: AgentBuild<VsCodeAdapterOutput>,
  plan: PreparationPlan,
  result: PreparationResult,
): PrepareAgentResult => {
  const presentedActions = plan.actions.map((action) => presentPreparationAction(build, action));
  const actionsById = new Map(presentedActions.map((action) => [action.actionId, action]));
  const actionResults = result.actionResults.map(
    (actionResult): PrepareActionResultPresentation => {
      const action = actionsById.get(actionResult.actionId);
      if (action === undefined) {
        throw new AgentKitError(
          'INVALID_PREPARATION_RESULT',
          'A preparation result has no matching planned action.',
          [`actionId: ${actionResult.actionId}`],
        );
      }
      return { action, status: actionResult.status };
    },
  );
  const summary = {
    ready: actionResults.filter(({ status }) => status === 'success' || status === 'already-ready')
      .length,
    setupRequired: actionResults.filter(({ status }) => status === 'setup-required').length,
    unavailable: actionResults.filter(({ status }) => status === 'unavailable').length,
  };
  const capabilities = result.readiness.capabilities.map((readiness) => {
    const capability = build.capabilities.find(
      (candidate) =>
        candidate.capability.id === readiness.id &&
        candidate.capability.version.value === readiness.version &&
        candidate.profile.id === readiness.profileId,
    );
    const binding = result.instance.bindings.find(
      (candidate) =>
        candidate.capabilityId === readiness.id &&
        candidate.capabilityVersion === readiness.version &&
        candidate.profileId === readiness.profileId,
    );
    if (capability === undefined || binding === undefined) {
      throw new AgentKitError(
        'INVALID_PREPARATION_RESULT',
        'Prepared readiness has no matching Build capability or instance binding.',
        [`capability: ${readiness.id}`],
      );
    }
    return {
      id: readiness.id,
      displayName: capability.capability.displayName,
      version: readiness.version,
      profile: readiness.profileId,
      bindingMode: readiness.bindingMode,
      state: readiness.state,
      instanceState: preparedInstanceState(binding.state),
      requirements: readiness.requirements,
    };
  });
  const setupRequirements = result.setupRequirements.map((requirement) => ({
    action: presentPreparationAction(build, requirement.action),
    status: requirement.status,
  }));

  return {
    agent: {
      id: result.instance.agentDefinition.id,
      version: result.instance.agentDefinition.version,
    },
    build: { lockDigest: result.instance.build.lockDigest },
    instance: {
      instanceId: result.instance.instanceId,
      environmentId: result.instance.environmentId,
      preparedAt: result.instance.preparedAt,
      state: preparedInstanceState(result.instance.state),
    },
    environment: {
      id: result.instance.environmentId,
      label: 'Local · VS Code',
    },
    plan: {
      instanceId: plan.instance.instanceId,
      environmentId: plan.instance.environmentId,
      actions: presentedActions,
    },
    preparation: {
      runnable: result.runnable,
      disposition: result.disposition,
      hostIntegration: result.hostIntegration,
      summary,
      actionResults,
    },
    readiness: { capabilities },
    setupRequirements,
  };
};

export const createBuilderService = (options: BuilderServiceOptions = {}): BuilderService => {
  const loadRegistry = options.loadRegistry ?? loadFirstPartyCapabilityRegistry;
  const instanceStore = options.instanceStore ?? createFileSystemBuilderInstanceStore();
  const preparationEnvironment =
    options.preparationEnvironment ?? localVsCodePreparationEnvironment();
  const preparationApi = options.preparationApi ?? {
    createPreparationPlan: createAgentKitPreparationPlan,
    prepareAgent: prepareAgentWithAgentKit,
  };
  let readerPromise:
    | Promise<{
        readonly document: CapabilityRegistry;
        readonly reader: CapabilityRegistryReader;
      }>
    | undefined;

  const registry = async (): Promise<{
    readonly document: CapabilityRegistry;
    readonly reader: CapabilityRegistryReader;
  }> => {
    if (readerPromise === undefined) {
      const candidate = loadRegistry().then((document) => ({
        document,
        reader: createCapabilityRegistryReader(document),
      }));
      readerPromise = candidate;
      candidate.catch(() => {
        if (readerPromise === candidate) readerPromise = undefined;
      });
    }
    return readerPromise;
  };

  return {
    async listCapabilities() {
      try {
        const { document, reader } = await registry();
        return {
          registryVersion: document.registryVersion,
          capabilities: reader.listCapabilities().map(catalogItem),
        };
      } catch (error) {
        throw asRegistryServiceError(error);
      }
    },

    async listInstances() {
      try {
        const discovery = await instanceStore.list();
        return {
          instances: discovery.instances.map((instance) => presentLocalInstance(instance)),
          diagnostics: discovery.diagnostics,
        };
      } catch (error) {
        throw asInstanceDiscoveryServiceError(error);
      }
    },

    async buildAgent(definition) {
      try {
        const { reader } = await registry();
        return presentBuild(await buildVsCodeAgent(definition, { registry: reader }));
      } catch (error) {
        throw asBuildServiceError(error);
      }
    },

    async prepareAgent(request) {
      try {
        if (request.environmentId !== preparationEnvironment.environmentId) {
          throw new BuilderServiceError(
            'INVALID_PREPARATION_INPUT',
            'The requested preparation environment is not available.',
            [],
            400,
          );
        }
        const { reader } = await registry();
        const build = await buildVsCodeAgent(request.definition, { registry: reader });
        if (build.lockDigest !== request.expectedLockDigest) {
          throw new BuilderServiceError(
            'BUILD_LOCK_MISMATCH',
            'The displayed Build no longer matches the canonical definition. Build the agent again before preparing.',
            [],
            409,
          );
        }
        const readinessSnapshot =
          typeof preparationEnvironment.readinessSnapshot === 'function'
            ? await preparationEnvironment.readinessSnapshot(build)
            : preparationEnvironment.readinessSnapshot;
        const preparationOptions = {
          environmentId: preparationEnvironment.environmentId,
          readinessSnapshot,
          hostIntegration: preparationEnvironment.hostIntegration,
        };
        const plan = preparationApi.createPreparationPlan(build, preparationOptions);
        const existingInstance = await instanceStore.get(plan.instance.instanceId);
        const result = await preparationApi.prepareAgent(build, {
          ...preparationOptions,
          ...(preparationEnvironment.driver === undefined
            ? {}
            : { driver: preparationEnvironment.driver }),
          ...(preparationEnvironment.clock === undefined
            ? {}
            : { clock: preparationEnvironment.clock }),
          ...(existingInstance === undefined ? {} : { existingInstance }),
        });
        const instance = parsePreparedAgentInstance(result.instance);
        if (
          instance.instanceId !== plan.instance.instanceId ||
          result.identity.instanceId !== plan.instance.instanceId
        ) {
          throw new AgentKitError(
            'INVALID_PREPARATION_RESULT',
            'Prepare returned an Agent Instance for a different preparation plan.',
          );
        }
        await instanceStore.put(instance);
        return presentPreparation(build, plan, { ...result, instance });
      } catch (error) {
        if (error instanceof BuilderInstanceStoreError) {
          throw asInstanceStorageServiceError(error);
        }
        throw asPreparationServiceError(error);
      }
    },
  };
};
