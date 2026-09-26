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

const catalogCapability = (
  id: (typeof capabilities)[number][0],
  displayName: string,
): CapabilityCatalogItem => ({
  id,
  displayName,
  description: `${displayName} provides bounded, Registry-owned capability behavior.`,
  version: id === 'azure' ? '0.3.0' : '0.1.0',
  versionStatus: id === 'ast-summarizer' || id === 'azure' ? 'released' : 'declared',
  category: id === 'azure' ? 'Cloud' : 'Development',
  tags: ['context-optimization'],
  toolCount: id === 'azure' ? 18 : 2,
  profiles: [
    {
      id: id === 'azure' ? 'hosted-read-only' : 'local-package',
      description: `Default ${displayName} profile.`,
      dimensions: {
        execution: id === 'azure' ? 'hosted' : 'local',
        delivery: id === 'azure' ? 'container' : 'package',
        access: id === 'azure' ? 'authenticated-service' : 'local-process',
        workload: id === 'azure' ? 'provider' : 'filesystem',
        provider: id === 'azure' ? 'external' : 'none',
        mutation: 'read-only',
      },
      setupRequired: true,
      setupSummary: 'Environment setup is required.',
      readinessSummary: 'Ready after environment preparation.',
    },
  ],
  bindingModes: [id === 'azure' ? 'remote' : 'local'],
  stateChanging: false,
});

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
    return {
      id: capability.id,
      displayName: capability.displayName,
      description: capability.description,
      resolvedVersion: capability.version,
      profile: {
        id: remote ? 'hosted-read-only' : 'local-package',
        description: capability.profiles[0]?.description ?? 'Default profile.',
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
