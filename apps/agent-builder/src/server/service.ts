import {
  buildVsCodeAgent,
  type AgentBuild,
  type BindingMode,
  type VsCodeAdapterOutput,
} from '@agent-tool-platform/agent-kit';
import {
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
  type CapabilityRegistry,
  type CapabilityRegistryReader,
} from '@agent-tool-platform/capability-registry';
import type {
  BuildAgentResult,
  BuildCapabilityResult,
  CapabilityCatalogItem,
  CapabilityCatalogResponse,
  GeneratedArtifact,
} from '../shared/contracts.js';
import { asBuildServiceError, asRegistryServiceError } from './errors.js';

export interface BuilderService {
  listCapabilities(): Promise<CapabilityCatalogResponse>;
  buildAgent(definition: unknown): Promise<BuildAgentResult>;
}

export interface BuilderServiceOptions {
  readonly loadRegistry?: () => Promise<CapabilityRegistry>;
}

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

export const createBuilderService = (options: BuilderServiceOptions = {}): BuilderService => {
  const loadRegistry = options.loadRegistry ?? loadFirstPartyCapabilityRegistry;
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

    async buildAgent(definition) {
      try {
        const { reader } = await registry();
        return presentBuild(await buildVsCodeAgent(definition, { registry: reader }));
      } catch (error) {
        throw asBuildServiceError(error);
      }
    },
  };
};
