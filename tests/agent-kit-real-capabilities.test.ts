import { describe, expect, it } from 'vitest';
import {
  buildVsCodeAgent,
  capabilityBindingKey,
  createReadinessPlan,
  parseRegistryCapability,
  resolveAgentDefinition,
  vscodeHostAdapter,
} from '@agent-tool-platform/agent-kit';
import {
  createFirstPartyRegistryFixture,
  firstPartyCapabilityFixtures,
} from './fixtures/agent-kit-registry.js';

const acceptanceDefinition = {
  schemaVersion: 1,
  id: 'm5-acceptance-agent',
  name: 'M5 Acceptance Agent',
  version: '1.0.0',
  instructions:
    'Use compact capability output first, preserve evidence, and escalate only when optimized context is insufficient.',
  capabilities: [{ id: 'git-optimizer' }, { id: 'ast-summarizer' }, { id: 'data-cruncher' }],
};

describe('real first-party capability proofs', () => {
  it('accepts the seven H1/H2 registry projections and their pinned source revisions', () => {
    expect(firstPartyCapabilityFixtures).toHaveLength(7);
    for (const capability of firstPartyCapabilityFixtures) {
      expect(parseRegistryCapability(capability)).toEqual(capability);
      expect(capability.source.revision).toMatch(/^[0-9a-f]{40}$/u);
    }

    const byId = new Map(
      firstPartyCapabilityFixtures.map((capability) => [capability.id, capability]),
    );
    expect(byId.get('ast-summarizer')?.profiles[0]?.dimensions).toMatchObject({
      execution: 'local',
      mutation: 'read-only',
    });
    expect(byId.get('git-optimizer')?.profiles[0]?.permissions.scopes).toEqual([
      'process-execute',
      'repository-read',
    ]);
    expect(byId.get('data-cruncher')?.profiles[0]?.permissions.scopes).toEqual([
      'filesystem-read',
      'process-execute',
    ]);
    expect(byId.get('doc-rag')?.profiles[0]?.dimensions.workload).toBe('filesystem');
    expect(byId.get('document-optimizer')?.profiles[0]?.dimensions.workload).toBe('filesystem');
    expect(byId.get('vision')?.profiles).toHaveLength(2);
    expect(byId.get('azure')?.profiles).toHaveLength(2);
  });

  it('runs the M5 acceptance path reproducibly with AST, Git, and Data', async () => {
    const registry = createFirstPartyRegistryFixture();
    const localBindings = [
      capabilityBindingKey('ast-summarizer', '0.1.1', 'local-package'),
      capabilityBindingKey('git-optimizer', '0.1.0', 'local-package'),
      capabilityBindingKey('data-cruncher', '0.0.0-development', 'local-package'),
    ];
    const options = {
      registry,
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
    const resolution = await resolveAgentDefinition(
      {
        ...acceptanceDefinition,
        capabilities: firstPartyCapabilityFixtures.map((capability) => ({
          id: capability.id,
        })),
      },
      createFirstPartyRegistryFixture(),
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
      azure: 'incompatible',
      'data-cruncher': 'local-package:local',
      'doc-rag': 'local-filesystem-package:local',
      'document-optimizer': 'local-filesystem-package:local',
      'git-optimizer': 'local-package:local',
      vision: 'local-package:local',
    });
  });

  it('selects Vision hybrid and safely rejects Azure remote auth without header metadata', async () => {
    const definition = {
      ...acceptanceDefinition,
      capabilities: [
        { id: 'vision', profile: 'hybrid-azure-package' },
        { id: 'azure', profile: 'hosted-mutating' },
      ],
    };
    const registry = createFirstPartyRegistryFixture();
    const resolution = await resolveAgentDefinition(definition, registry, vscodeHostAdapter);
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
    expect(azure?.status).toBe('incompatible');
    expect(azure?.profile.dimensions).toMatchObject({
      execution: 'hosted',
      provider: 'external',
      mutation: 'mutating',
    });
    expect(azure?.status === 'incompatible' ? azure.registryBinding.availability : undefined).toBe(
      'remote',
    );
    expect(azure?.compatibility.reasons).toContain(
      'authenticated HTTP bindings require a registry-defined client header mapping that is not available',
    );

    const readiness = createReadinessPlan(resolution);
    expect(readiness.capabilities.map((capability) => capability.state)).toEqual([
      'incompatible-binding',
      'missing-configuration',
    ]);

    await expect(buildVsCodeAgent(definition, { registry })).rejects.toMatchObject({
      code: 'INCOMPATIBLE_BINDING',
    });
  });
});
