import type {
  BuildAgentResult,
  CapabilityCatalogItem,
  CapabilityCatalogResponse,
  LocalAgentInstanceDiscoveryResponse,
  PreparationActionPresentation,
  PrepareAgentResult,
} from '../src/shared/contracts.js';
import { LOCAL_VSCODE_ENVIRONMENT_ID } from '../src/shared/contracts.js';

const capabilities = [
  ['ast-summarizer', 'AST Summarizer'],
  ['git-optimizer', 'Git Optimizer'],
  ['data-cruncher', 'Data Cruncher'],
  ['doc-rag', 'Doc RAG'],
  ['vision', 'Vision'],
  ['document-optimizer', 'Document Optimizer'],
  ['azure', 'Azure Agent Tool Server'],
] as const;

const profileFixture = (
  id: string,
  displayName: string,
  bindingMode: 'hybrid' | 'local' | 'remote',
  mutation: 'mutating' | 'read-only',
): CapabilityCatalogItem['profiles'][number] => ({
  id,
  description: `${displayName} ${bindingMode} ${mutation} profile.`,
  dimensions: {
    execution: bindingMode === 'remote' ? 'hosted' : 'local',
    delivery: bindingMode === 'remote' ? 'container' : 'package',
    access: bindingMode === 'remote' ? 'authenticated-service' : 'local-process',
    workload: bindingMode === 'remote' ? 'provider' : 'filesystem',
    provider: bindingMode === 'local' ? 'none' : 'external',
    mutation,
  },
  bindingModes: [bindingMode],
  setupRequired: true,
  setupSummary: 'Environment setup is required.',
  readinessSummary: 'Ready after environment preparation.',
});

const catalogCapability = (
  id: (typeof capabilities)[number][0],
  displayName: string,
): CapabilityCatalogItem => {
  const profiles =
    id === 'azure'
      ? [
          profileFixture('hosted-mutating', displayName, 'remote', 'mutating'),
          profileFixture('hosted-read-only', displayName, 'remote', 'read-only'),
        ]
      : id === 'vision'
        ? [
            profileFixture('hybrid-azure-package', displayName, 'hybrid', 'mutating'),
            profileFixture('local-package', displayName, 'local', 'mutating'),
          ]
        : [profileFixture('local-package', displayName, 'local', 'read-only')];

  return {
    id,
    displayName,
    description: `${displayName} provides bounded, Registry-owned capability behavior.`,
    version: id === 'azure' ? '0.3.0' : '0.1.0',
    versionStatus: id === 'ast-summarizer' || id === 'azure' ? 'released' : 'declared',
    category: id === 'azure' ? 'Cloud' : 'Development',
    tags: ['context-optimization'],
    toolCount: id === 'azure' ? 18 : 2,
    profiles,
    bindingModes: id === 'azure' ? ['remote'] : id === 'vision' ? ['local', 'hybrid'] : ['local'],
    stateChanging: id === 'azure' || id === 'vision',
  };
};

export const catalogFixture: CapabilityCatalogResponse = {
  registryVersion: '0.0.0-development',
  capabilities: capabilities.map(([id, name]) => catalogCapability(id, name)),
};

const digest = `sha256:${'a'.repeat(64)}`;

export const buildResultFixture: BuildAgentResult = {
  agent: {
    id: 'developer-optimization',
    name: 'Developer Optimization Agent',
    version: '1.0.0',
  },
  lockDigest: digest,
  capabilities: catalogFixture.capabilities.map((capability) => {
    const remote = capability.id === 'azure';
    const profileId = remote ? 'hosted-read-only' : 'local-package';
    const profile = capability.profiles.find((candidate) => candidate.id === profileId);
    if (profile === undefined) throw new Error(`Missing fixture profile ${profileId}.`);
    return {
      id: capability.id,
      displayName: capability.displayName,
      description: capability.description,
      resolvedVersion: capability.version,
      profile: {
        id: profileId,
        description: profile.description,
        mutation: profile.dimensions.mutation,
      },
      binding: {
        id: remote ? 'hosted-read-only-http' : 'local-stdio',
        mode: remote ? 'remote' : 'local',
        interface: remote ? 'http' : 'stdio',
      },
      compatibility: {
        state: 'compatible',
        reasons: [],
      },
      artifact: {
        kind: remote ? 'oci' : 'npm',
        availability: 'published',
      },
      readiness: {
        state: remote ? 'missing-configuration' : 'local-setup-required',
        requirements: remote
          ? [
              {
                kind: 'configuration',
                state: 'missing',
                name: 'connector-api-key',
              },
            ]
          : [{ kind: 'local-artifact', state: 'setup-required' }],
        setupRequired: profile.setupRequired,
        setupSummary: profile.setupSummary,
        summary: profile.readinessSummary,
      },
      configuration: {
        endpointRequired: remote,
        requiredNames: remote ? ['connector-api-key'] : [],
        headers: remote
          ? [{ name: 'x-api-key', configurationName: 'connector-api-key', prefix: '' }]
          : [],
      },
    } as const;
  }),
  execution: { local: 6, remote: 1, hybrid: 0 },
  readiness: { setupRequired: 7, configurationRequired: 1, ready: 0 },
  vsCode: {
    generated: true,
    agentPath: '.github/agents/developer-optimization.agent.md',
    mcpPath: '.vscode/mcp.json',
    serverCount: 7,
  },
  artifacts: [
    {
      kind: 'lock',
      label: 'agent.lock',
      path: 'agent.lock',
      mediaType: 'application/json',
      content: '{"kind":"agent-lock"}\n',
    },
    {
      kind: 'vscode-agent',
      label: 'VS Code agent',
      path: '.github/agents/developer-optimization.agent.md',
      mediaType: 'text/markdown',
      content: '# Agent Instructions\n',
    },
    {
      kind: 'mcp',
      label: 'MCP configuration',
      path: '.vscode/mcp.json',
      mediaType: 'application/json',
      content: '{"servers":{"azure":{"url":"${input:azure-endpoint}"}}}\n',
    },
    {
      kind: 'instructions',
      label: 'Composed instructions',
      path: 'composed-instructions.md',
      mediaType: 'text/markdown',
      content: '# Agent Instructions\n\nUse compact evidence.\n',
    },
  ],
  instanceIdentity: {
    schemaVersion: 1,
    agentDefinition: {
      id: 'developer-optimization',
      version: '1.0.0',
      digest,
    },
    build: { lockDigest: digest },
    host: { id: 'vscode', adapterSchemaVersion: 2 },
    bindings: catalogFixture.capabilities.map((capability) => ({
      key: `${capability.id}@${capability.version}#${
        capability.id === 'azure' ? 'hosted-read-only' : 'local-package'
      }`,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      profileId: capability.id === 'azure' ? 'hosted-read-only' : 'local-package',
      mode: capability.id === 'azure' ? 'remote' : 'local',
    })),
  },
};

const preparationDigest = (character: string): string => `sha256:${character.repeat(64)}`;

const preparationActions: readonly PreparationActionPresentation[] = [
  {
    actionId: preparationDigest('b'),
    kind: 'make-local-artifact-available',
    concern: 'local-artifact',
    title: 'Make Vision local artifact available',
    capability: {
      id: 'vision',
      displayName: 'Vision',
      version: '0.1.0',
      profile: 'local-package',
      bindingMode: 'local',
    },
    artifact: {
      id: 'vision-npm',
      identifier: '@agent-tool-platform/vision',
      kind: 'npm',
      version: '0.1.0',
      availability: 'published',
    },
  },
  {
    actionId: preparationDigest('c'),
    kind: 'verify-configuration',
    concern: 'configuration',
    title: 'Verify Azure Agent Tool Server configuration',
    capability: {
      id: 'azure',
      displayName: 'Azure Agent Tool Server',
      version: '0.3.0',
      profile: 'hosted-read-only',
      bindingMode: 'remote',
    },
    configurationName: 'connector-api-key',
  },
  {
    actionId: preparationDigest('d'),
    kind: 'verify-remote-connection',
    concern: 'remote-connection',
    title: 'Verify Azure Agent Tool Server remote connection',
    capability: {
      id: 'azure',
      displayName: 'Azure Agent Tool Server',
      version: '0.3.0',
      profile: 'hosted-read-only',
      bindingMode: 'remote',
    },
  },
  {
    actionId: preparationDigest('e'),
    kind: 'verify-provider-prerequisite',
    concern: 'provider-prerequisite',
    title: 'Verify Azure Agent Tool Server provider prerequisite',
    capability: {
      id: 'azure',
      displayName: 'Azure Agent Tool Server',
      version: '0.3.0',
      profile: 'hosted-read-only',
      bindingMode: 'remote',
    },
    prerequisiteId: 'azure-resource-manager',
  },
  {
    actionId: preparationDigest('f'),
    kind: 'prepare-host-integration',
    concern: 'host-integration',
    title: 'Prepare generated VS Code host integration',
    host: {
      id: 'vscode',
      adapterSchemaVersion: 2,
      files: [
        {
          path: '.github/agents/developer-optimization.agent.md',
          mediaType: 'text/markdown',
          contentDigest: preparationDigest('1'),
        },
        {
          path: '.vscode/mcp.json',
          mediaType: 'application/json',
          contentDigest: preparationDigest('2'),
        },
      ],
    },
  },
];

export const prepareResultFixture = (
  state: PrepareAgentResult['instance']['state'] = 'NEEDS_SETUP',
): PrepareAgentResult => {
  const statuses =
    state === 'READY'
      ? (['already-ready', 'already-ready', 'already-ready', 'already-ready', 'success'] as const)
      : state === 'UNAVAILABLE'
        ? ([
            'setup-required',
            'setup-required',
            'unavailable',
            'setup-required',
            'setup-required',
          ] as const)
        : ([
            'setup-required',
            'setup-required',
            'setup-required',
            'setup-required',
            'setup-required',
          ] as const);
  const actionResults = preparationActions.map((action, index) => ({
    action,
    status: statuses[index]!,
  }));
  const setupRequirements: PrepareAgentResult['setupRequirements'] = actionResults.flatMap(
    (result) =>
      result.status === 'setup-required' || result.status === 'unavailable'
        ? [{ action: result.action, status: result.status }]
        : [],
  );
  const ready = actionResults.filter(
    ({ status }) => status === 'already-ready' || status === 'success',
  ).length;
  const setupRequired = actionResults.filter(({ status }) => status === 'setup-required').length;
  const unavailable = actionResults.filter(({ status }) => status === 'unavailable').length;
  const readinessReady = state === 'READY';

  return {
    agent: { id: buildResultFixture.agent.id, version: buildResultFixture.agent.version },
    build: { lockDigest: buildResultFixture.lockDigest },
    instance: {
      instanceId: preparationDigest('9'),
      environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
      preparedAt: '2026-09-27T12:00:00.000Z',
      state,
    },
    environment: {
      id: LOCAL_VSCODE_ENVIRONMENT_ID,
      label: 'Local · VS Code',
    },
    plan: {
      instanceId: preparationDigest('9'),
      environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
      actions: preparationActions,
    },
    preparation: {
      runnable: state === 'READY',
      disposition: 'created',
      hostIntegration: {
        actionId: preparationActions[4]!.actionId,
        status: statuses[4],
      },
      summary: { ready, setupRequired, unavailable },
      actionResults,
    },
    readiness: {
      capabilities: [
        {
          id: 'vision',
          displayName: 'Vision',
          version: '0.1.0',
          profile: 'local-package',
          bindingMode: 'local',
          state: readinessReady ? 'available-local' : 'local-setup-required',
          instanceState: state === 'READY' ? 'READY' : 'NEEDS_SETUP',
          requirements: [
            {
              kind: 'artifact-availability',
              state: 'published',
              artifactId: 'vision-npm',
            },
            {
              kind: 'local-artifact',
              state: readinessReady ? 'available' : 'setup-required',
            },
          ],
        },
        {
          id: 'azure',
          displayName: 'Azure Agent Tool Server',
          version: '0.3.0',
          profile: 'hosted-read-only',
          bindingMode: 'remote',
          state: readinessReady ? 'ready' : 'missing-configuration',
          instanceState:
            state === 'READY' ? 'READY' : state === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'NEEDS_SETUP',
          requirements: [
            {
              kind: 'configuration',
              state: readinessReady ? 'available' : 'missing',
              name: 'connector-api-key',
            },
            {
              kind: 'remote-connection',
              state: readinessReady ? 'available' : 'setup-required',
            },
            {
              kind: 'provider-prerequisite',
              state: readinessReady ? 'available' : 'setup-required',
              id: 'azure-resource-manager',
              description: 'Azure Resource Manager access must be verified.',
            },
          ],
        },
      ],
    },
    setupRequirements,
  };
};

export const emptyInstanceDiscoveryFixture: LocalAgentInstanceDiscoveryResponse = {
  instances: [],
  diagnostics: {
    inspectedRecordCount: 0,
    invalidRecordCount: 0,
    truncated: false,
    warnings: [],
  },
};

export const instanceDiscoveryFixture = (
  state: PrepareAgentResult['instance']['state'] = 'NEEDS_SETUP',
): LocalAgentInstanceDiscoveryResponse => ({
  instances: [
    {
      instanceId: preparationDigest('9'),
      agent: {
        id: buildResultFixture.agent.id,
        version: buildResultFixture.agent.version,
      },
      build: { lockDigest: buildResultFixture.lockDigest },
      environment: {
        id: LOCAL_VSCODE_ENVIRONMENT_ID,
        label: 'Local · VS Code',
      },
      host: {
        id: 'vscode',
        adapterSchemaVersion: 2,
      },
      preparedAt: '2026-09-27T12:00:00.000Z',
      state,
      bindingSummary: {
        ...buildResultFixture.execution,
        total: buildResultFixture.capabilities.length,
      },
      bindings: buildResultFixture.capabilities.map((capability) => ({
        capabilityId: capability.id,
        capabilityVersion: capability.resolvedVersion,
        profile: capability.profile.id,
        mode: capability.binding.mode,
        readiness:
          state === 'READY'
            ? capability.binding.mode === 'local'
              ? 'available-local'
              : 'ready'
            : capability.readiness.state,
        state,
      })),
    },
  ],
  diagnostics: {
    inspectedRecordCount: 1,
    invalidRecordCount: 0,
    truncated: false,
    warnings: [],
  },
});

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
