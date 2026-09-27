import type {
  BuildAgentResult,
  CapabilityCatalogItem,
  CapabilityCatalogResponse,
} from '../src/shared/contracts.js';

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

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
