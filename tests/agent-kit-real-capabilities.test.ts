import { describe, expect, it, vi } from 'vitest';
import {
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
} from '@agent-tool-platform/capability-registry';
import {
  buildVsCodeAgent,
  capabilityBindingKey,
  createPreparationPlan,
  createReadinessPlan,
  parseRegistryCapability,
  prepareAgent,
  resolveAgentDefinition,
  serializePreparedAgentInstance,
  vscodeHostAdapter,
  type PreparationDriver,
  type PreparationDriverRequest,
} from '@agent-tool-platform/agent-kit';

const acceptanceDefinition = {
  schemaVersion: 1,
  id: 'm5-acceptance-agent',
  name: 'M5 Acceptance Agent',
  version: '1.0.0',
  instructions:
    'Use compact capability output first, preserve evidence, and escalate only when optimized context is insufficient.',
  capabilities: [{ id: 'git-optimizer' }, { id: 'ast-summarizer' }, { id: 'data-cruncher' }],
};

const m6Definition = {
  schemaVersion: 1,
  id: 'developer-optimization',
  name: 'Developer Optimization Agent',
  version: '1.0.0',
  instructions:
    'Optimize developer workflows with compact, evidence-backed output from the selected capabilities.',
  capabilities: [
    { id: 'ast-summarizer' },
    { id: 'git-optimizer' },
    { id: 'data-cruncher' },
    { id: 'doc-rag' },
    { id: 'vision' },
    { id: 'document-optimizer' },
    { id: 'azure' },
  ],
};

const loadFirstPartyRegistry = async () => {
  const document = await loadFirstPartyCapabilityRegistry();
  return {
    document,
    reader: createCapabilityRegistryReader(document),
  };
};

describe('real first-party capability proofs', () => {
  it('consumes all seven canonical entries through the public Registry reader', async () => {
    const { document, reader } = await loadFirstPartyRegistry();
    const capabilities = reader.listCapabilities();

    expect(capabilities).toHaveLength(7);
    expect(capabilities).toEqual(document.capabilities);
    for (const capability of capabilities) {
      expect(parseRegistryCapability(capability)).toEqual(capability);
      expect(reader.getCapability(capability.id)).toEqual(capability);
      expect(reader.listProfiles(capability.id)).toEqual(capability.profiles);
      expect(reader.listBindings(capability.id)).toEqual(capability.bindings);
      expect(capability.source.revision).toMatch(/^[0-9a-f]{40}$/u);
    }

    const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
    expect(byId.get('ast-summarizer')?.profiles[0]).toMatchObject({
      dimensions: {
        execution: 'local',
        delivery: 'package',
        access: 'local-process',
        workload: 'filesystem',
        provider: 'none',
        mutation: 'read-only',
      },
      permissions: { scopes: ['workspace-read'] },
      stateEffects: [],
    });
    expect(byId.get('git-optimizer')?.profiles[0]?.dimensions).toMatchObject({
      execution: 'local',
      access: 'local-process',
      mutation: 'read-only',
    });
    expect(byId.get('git-optimizer')?.profiles[0]?.permissions.scopes).toEqual([
      'process-execute',
      'repository-read',
    ]);
    expect(byId.get('data-cruncher')?.profiles[0]?.dimensions).toMatchObject({
      execution: 'local',
      access: 'local-process',
      workload: 'filesystem',
      mutation: 'read-only',
    });
    expect(byId.get('data-cruncher')?.profiles[0]?.permissions.scopes).toEqual([
      'filesystem-read',
      'process-execute',
    ]);
    expect(byId.get('doc-rag')?.profiles[0]).toMatchObject({
      dimensions: {
        execution: 'local',
        workload: 'filesystem',
        provider: 'none',
        mutation: 'read-only',
      },
      permissions: { scopes: ['filesystem-read'] },
    });
    expect(byId.get('document-optimizer')?.profiles[0]).toMatchObject({
      dimensions: {
        execution: 'local',
        workload: 'filesystem',
        provider: 'none',
        mutation: 'read-only',
      },
      permissions: { scopes: ['filesystem-read'] },
    });
    expect(byId.get('vision')?.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-package',
          dimensions: expect.objectContaining({
            execution: 'local',
            provider: 'none',
            mutation: 'mutating',
          }),
          stateEffects: ['artifact-create'],
        }),
        expect.objectContaining({
          id: 'hybrid-azure-package',
          dimensions: expect.objectContaining({
            execution: 'local',
            provider: 'external',
            mutation: 'mutating',
          }),
          stateEffects: ['artifact-create'],
        }),
      ]),
    );
    expect(byId.get('azure')?.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'hosted-read-only',
          dimensions: expect.objectContaining({
            execution: 'hosted',
            access: 'authenticated-service',
            provider: 'external',
            mutation: 'read-only',
          }),
          stateEffects: [],
        }),
        expect.objectContaining({
          id: 'hosted-mutating',
          dimensions: expect.objectContaining({
            execution: 'hosted',
            access: 'authenticated-service',
            provider: 'external',
            mutation: 'mutating',
          }),
          stateEffects: ['provider-mutation'],
        }),
      ]),
    );
  });

  it('runs the M5 acceptance path reproducibly with AST, Git, and Data', async () => {
    const { reader } = await loadFirstPartyRegistry();
    const localBindings = [
      capabilityBindingKey('ast-summarizer', '0.1.1', 'local-package'),
      capabilityBindingKey('git-optimizer', '0.1.0', 'local-package'),
      capabilityBindingKey('data-cruncher', '0.0.0-development', 'local-package'),
    ];
    const options = {
      registry: reader,
      readinessSnapshot: {
        schemaVersion: 1 as const,
        availableLocalBindings: localBindings,
      },
    };

    const first = await buildVsCodeAgent(acceptanceDefinition, options);
    const second = await buildVsCodeAgent(acceptanceDefinition, options);

    expect(first.lockText).toBe(second.lockText);
    expect(first.lockDigest).toBe(second.lockDigest);
    expect(first.adapter).toEqual(second.adapter);
    expect(first.readiness).toEqual(second.readiness);
    expect(first.lock.capabilities.map((capability) => capability.id)).toEqual([
      'ast-summarizer',
      'data-cruncher',
      'git-optimizer',
    ]);
    expect(first.lock.capabilities.map((capability) => capability.version)).toEqual([
      '0.1.1',
      '0.0.0-development',
      '0.1.0',
    ]);
    expect(first.lock.capabilities.map((capability) => capability.source.revision)).toEqual([
      '93bffa78d3fbbb4d835a8da55f33af68e48ec8cd',
      '67bc95dd4ba9d2b8ae829650d470a055819121f1',
      '6fe83371af641fdbaea1e22c0c8bf981caa882ab',
    ]);
    expect(first.readiness.capabilities.map((capability) => capability.state)).toEqual([
      'available-local',
      'available-local',
      'available-local',
    ]);
    expect(
      first.readiness.capabilities.map((capability) =>
        capability.requirements.find((requirement) => requirement.kind === 'artifact-availability'),
      ),
    ).toEqual([
      { artifactId: 'npm-package', kind: 'artifact-availability', state: 'published' },
      { artifactId: 'npm-package', kind: 'artifact-availability', state: 'declared' },
      { artifactId: 'npm-package', kind: 'artifact-availability', state: 'declared' },
    ]);

    const agentFile = first.adapter.files.find((file) => file.path.endsWith('.agent.md'));
    const mcpFile = first.adapter.files.find((file) => file.path === '.vscode/mcp.json');
    expect(agentFile?.content).toContain('# Agent Instructions');
    expect(agentFile?.content).toContain('# Capability Instructions');
    expect(agentFile?.content).toContain('runtime enforcement remain authoritative');
    expect(agentFile?.content).not.toContain('inputSchema');
    expect(mcpFile?.content).toContain('@agent-tool-platform/ast-summarizer@0.1.1');
    expect(mcpFile?.content).toContain('agent-tool-server-git-optimizer@0.1.0');
    expect(mcpFile?.content).toContain('agent-tool-server-data-cruncher@0.0.0-development');
  });

  it('represents every migrated capability without capability-specific resolver branches', async () => {
    const { document, reader } = await loadFirstPartyRegistry();
    const resolution = await resolveAgentDefinition(
      {
        ...acceptanceDefinition,
        capabilities: document.capabilities.map((capability) => ({
          id: capability.id,
        })),
      },
      reader,
      vscodeHostAdapter,
    );

    expect(
      Object.fromEntries(
        resolution.capabilities.map((capability) => [
          capability.capability.id,
          capability.status === 'resolved'
            ? `${capability.profile.id}:${capability.binding.mode}`
            : 'incompatible',
        ]),
      ),
    ).toEqual({
      'ast-summarizer': 'local-package:local',
      azure: 'hosted-read-only:remote',
      'data-cruncher': 'local-package:local',
      'doc-rag': 'local-filesystem-package:local',
      'document-optimizer': 'local-filesystem-package:local',
      'git-optimizer': 'local-package:local',
      vision: 'local-package:local',
    });
  });

  it('builds the exact M6 seven-capability VS Code composition', async () => {
    const { reader } = await loadFirstPartyRegistry();
    const build = await buildVsCodeAgent(m6Definition, { registry: reader });
    const azure = build.capabilities.find((capability) => capability.capability.id === 'azure');
    const vision = build.capabilities.find((capability) => capability.capability.id === 'vision');

    expect(azure).toMatchObject({
      status: 'resolved',
      capability: {
        id: 'azure',
        version: { value: '0.3.0', status: 'released' },
        source: {
          revision: 'd036a12b5028c9d873a0fc6eec5ec450aebb8414',
          metadataVersion: '0.3.0',
          releaseTag: 'v0.3.0',
        },
      },
      profile: { id: 'hosted-read-only' },
      binding: {
        id: 'hosted-read-only-http',
        mode: 'remote',
        interface: 'http',
        artifact: {
          kind: 'oci',
          identifier: 'ghcr.io/ashergarland/agent-tool-server-azure',
          version: '0.3.0',
          availability: 'published',
          reference: 'v0.3.0',
        },
        httpClient: {
          headers: [
            {
              name: 'x-api-key',
              configurationName: 'connector-api-key',
              prefix: '',
            },
          ],
        },
      },
      compatibility: { state: 'compatible', reasons: [] },
    });
    expect(vision).toMatchObject({
      status: 'resolved',
      profile: { id: 'local-package' },
      binding: { id: 'local-stdio', mode: 'local', interface: 'stdio' },
    });

    const mcpText = build.adapter.files.find((file) => file.path === '.vscode/mcp.json')!.content;
    const mcp = JSON.parse(mcpText) as {
      readonly inputs: readonly {
        readonly id: string;
        readonly type: string;
        readonly password?: boolean;
      }[];
      readonly servers: Readonly<
        Record<
          string,
          {
            readonly type: string;
            readonly url?: string;
            readonly headers?: Readonly<Record<string, string>>;
          }
        >
      >;
    };
    expect(Object.keys(mcp.servers)).toHaveLength(7);
    expect(Object.values(mcp.servers).filter((server) => server.type === 'stdio')).toHaveLength(6);
    expect(mcp.servers.azure).toEqual({
      type: 'http',
      url: '${input:azure-endpoint}',
      headers: {
        'x-api-key': '${input:azure-connector-api-key}',
      },
    });
    expect(mcp.inputs).toEqual([
      expect.objectContaining({
        id: 'azure-connector-api-key',
        type: 'promptString',
        password: true,
      }),
      expect.objectContaining({
        id: 'azure-endpoint',
        type: 'promptString',
      }),
    ]);
    expect(mcpText).not.toContain('synthetic-secret-value');
    expect(mcpText).not.toMatch(/https?:\/\//u);
    expect(mcpText).not.toMatch(/\/subscriptions\/|tenant[-_ ]?id|subscription[-_ ]?id/iu);
    expect(mcpText).not.toMatch(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
    );

    const azureReadiness = build.readiness.capabilities.find(
      (capability) => capability.id === 'azure',
    );
    expect(azureReadiness?.state).toBe('missing-configuration');
    expect(azureReadiness?.requirements).toEqual(
      expect.arrayContaining([
        { kind: 'configuration', state: 'missing', name: 'connector-api-key' },
        { kind: 'remote-connection', state: 'setup-required' },
        expect.objectContaining({
          kind: 'provider-prerequisite',
          state: 'setup-required',
          id: 'azure-provider-registrations',
        }),
        expect.objectContaining({
          kind: 'provider-prerequisite',
          state: 'setup-required',
          id: 'azure-resource-manager',
        }),
      ]),
    );
    expect(build.lockText).not.toContain('synthetic-secret-value');
    expect(
      build.lock.capabilities.find((capability) => capability.id === 'azure')?.binding.client,
    ).toEqual({
      http: {
        headers: [
          {
            name: 'x-api-key',
            configuration: 'connector-api-key',
            prefix: '',
          },
        ],
      },
    });
  });

  it('prepares the seven-capability Developer Optimization shape without live provider calls', async () => {
    const { reader } = await loadFirstPartyRegistry();
    const build = await buildVsCodeAgent(m6Definition, { registry: reader });
    const localBindings = build.capabilities.filter(
      (capability) => capability.binding.mode === 'local',
    );
    const remoteBindings = build.capabilities.filter(
      (capability) => capability.binding.mode === 'remote',
    );
    const azure = remoteBindings[0]!;
    expect(azure.capability.version.value).toBe('0.3.0');
    expect(azure.binding).toMatchObject({
      key: 'azure@0.3.0#hosted-read-only',
      id: 'hosted-read-only-http',
      mode: 'remote',
      requiredSecretNames: ['connector-api-key'],
      providerPrerequisites: [
        expect.objectContaining({ id: 'azure-provider-registrations' }),
        expect.objectContaining({ id: 'azure-resource-manager' }),
      ],
    });
    const readinessSnapshot = {
      schemaVersion: 1 as const,
      availableLocalBindings: localBindings.map((capability) => capability.binding.key),
      availableRemoteBindings: [azure.binding.key],
      availableProviderPrerequisites: azure.binding.providerPrerequisites.map(
        (prerequisite) => `${azure.binding.key}/${prerequisite.id}`,
      ),
      configuration: [
        {
          bindingKey: azure.binding.key,
          availableNames: [...azure.binding.requiredSecretNames],
        },
      ],
    };
    const plan = createPreparationPlan(build, {
      environmentId: 'hackathon-workstation',
      readinessSnapshot,
    });
    const execute = vi.fn(async (request: PreparationDriverRequest) => {
      void request;
      return { status: 'success' as const };
    });
    const driver: PreparationDriver = { execute };
    const prepared = await prepareAgent(build, {
      environmentId: 'hackathon-workstation',
      readinessSnapshot,
      driver,
      clock: { now: () => new Date('2026-09-25T04:00:00.000Z') },
    });

    expect(localBindings).toHaveLength(6);
    expect(remoteBindings).toHaveLength(1);
    expect(
      build.readiness.capabilities.filter((item) => item.state === 'local-setup-required'),
    ).toHaveLength(6);
    expect(build.readiness.capabilities.find((item) => item.id === 'azure')?.state).toBe(
      'missing-configuration',
    );
    expect(plan).toEqual(
      createPreparationPlan(build, {
        environmentId: 'hackathon-workstation',
        readinessSnapshot,
      }),
    );
    expect(plan.actions.filter((action) => action.kind === 'verify-local-artifact')).toHaveLength(
      6,
    );
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'verify-configuration',
          configurationName: 'connector-api-key',
        }),
        expect.objectContaining({ kind: 'verify-remote-connection' }),
        expect.objectContaining({
          kind: 'verify-provider-prerequisite',
          prerequisiteId: 'azure-provider-registrations',
        }),
        expect.objectContaining({
          kind: 'verify-provider-prerequisite',
          prerequisiteId: 'azure-resource-manager',
        }),
        expect.objectContaining({ kind: 'prepare-host-integration' }),
      ]),
    );
    expect(prepared.plan).toEqual(plan);
    expect(prepared.instance.state).toBe('READY');
    expect(prepared.instance.state).not.toBe('ACTIVE');
    expect(prepared.instance.bindings).toHaveLength(7);
    expect(prepared.instance.bindings.filter((binding) => binding.mode === 'local')).toHaveLength(
      6,
    );
    expect(prepared.instance.bindings.filter((binding) => binding.mode === 'remote')).toHaveLength(
      1,
    );
    expect(
      prepared.readiness.capabilities.every(
        (item) => item.state === 'ready' || item.state === 'available-local',
      ),
    ).toBe(true);
    expect(prepared.runnable).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].action.kind).toBe('prepare-host-integration');
    expect(serializePreparedAgentInstance(prepared.instance)).not.toContain(
      'synthetic-secret-value',
    );
  });

  it('honors explicit Vision hybrid and Azure mutating selections generically', async () => {
    const definition = {
      ...acceptanceDefinition,
      capabilities: [
        { id: 'vision', profile: 'hybrid-azure-package' },
        { id: 'azure', profile: 'hosted-mutating' },
      ],
    };
    const { reader } = await loadFirstPartyRegistry();
    const resolution = await resolveAgentDefinition(definition, reader, vscodeHostAdapter);
    const vision = resolution.capabilities.find(
      (capability) => capability.capability.id === 'vision',
    );
    const azure = resolution.capabilities.find(
      (capability) => capability.capability.id === 'azure',
    );

    expect(vision?.status).toBe('resolved');
    expect(vision?.profile.dimensions).toMatchObject({
      execution: 'local',
      provider: 'external',
      mutation: 'mutating',
    });
    expect(vision?.status === 'resolved' ? vision.binding.mode : undefined).toBe('hybrid');
    expect(azure?.status).toBe('resolved');
    expect(azure?.profile.dimensions).toMatchObject({
      execution: 'hosted',
      provider: 'external',
      mutation: 'mutating',
    });
    expect(azure?.status === 'resolved' ? azure.binding.mode : undefined).toBe('remote');
    expect(azure?.status === 'resolved' ? azure.binding.httpClient : undefined).toEqual({
      headers: [
        {
          name: 'x-api-key',
          configurationName: 'connector-api-key',
          prefix: '',
        },
      ],
    });

    const readiness = createReadinessPlan(resolution);
    expect(readiness.capabilities.map((capability) => capability.state)).toEqual([
      'missing-configuration',
      'missing-configuration',
    ]);

    await expect(buildVsCodeAgent(definition, { registry: reader })).resolves.toMatchObject({
      capabilities: [
        expect.objectContaining({ status: 'resolved' }),
        expect.objectContaining({ status: 'resolved' }),
      ],
    });
  });
});
