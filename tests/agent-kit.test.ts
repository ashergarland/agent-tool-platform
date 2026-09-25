import { describe, expect, it, vi } from 'vitest';
import {
  capabilityEntrySchemaId,
  capabilityRegistrySchemaVersion,
  type CapabilityEntry,
  type CapabilityProfileSummary,
  type CapabilityRegistryReader,
} from '@agent-tool-platform/capability-registry';
import {
  AgentKitError,
  MAX_AGENT_KIT_ERROR_LENGTH,
  PREPARATION_SCHEMA_VERSION,
  PREPARED_AGENT_INSTANCE_SCHEMA_VERSION,
  buildVsCodeAgent,
  capabilityBindingKey,
  createPreparationPlan,
  createPreparedAgentInstanceIdentity,
  createReadinessPlan,
  parsePreparedAgentInstance,
  parseAgentDefinition,
  prepareAgent,
  resolveAgentDefinition,
  resolveRegistryCapability,
  serializeAgentLock,
  serializePreparedAgentInstance,
  vscodeHostAdapter,
  type AgentBuild,
  type PreparationDriver,
  type ReadinessSnapshot,
} from '@agent-tool-platform/agent-kit';

type ProfileKind = 'hybrid' | 'incompatible-source' | 'local' | 'remote';

const sha = 'a'.repeat(40);

const profileFor = (displayName: string, kind: ProfileKind): CapabilityProfileSummary => {
  const hosted = kind === 'remote';
  const hybrid = kind === 'hybrid';
  const provider = hosted || hybrid;
  const mutating = hybrid;
  return {
    id:
      kind === 'local'
        ? 'local-package'
        : kind === 'remote'
          ? 'hosted-read-only'
          : kind === 'hybrid'
            ? 'hybrid-provider-package'
            : 'source-only',
    description: `${displayName} ${kind} profile.`,
    source: 'capability-profile-declaration',
    dimensions: {
      execution: hosted ? 'hosted' : 'local',
      delivery: kind === 'incompatible-source' ? 'source' : hosted ? 'container' : 'package',
      access: hosted ? 'authenticated-service' : 'local-process',
      workload: provider ? 'provider' : 'filesystem',
      provider: provider ? 'external' : 'none',
      mutation: mutating ? 'mutating' : 'read-only',
    },
    permissions: {
      summary: provider
        ? `Use the configured ${displayName} provider.`
        : 'Read the explicitly selected local workspace.',
      scopes: provider
        ? mutating
          ? ['artifact-write', 'network-access', 'provider-read']
          : ['network-access', 'provider-read']
        : ['filesystem-read'],
    },
    prerequisites: {
      setupRequired: true,
      summary: provider
        ? `Requires configured ${displayName} provider access.`
        : 'Requires a readable local workspace.',
      requiredSecrets: provider ? [`${displayName.toUpperCase().replaceAll(' ', '_')}_TOKEN`] : [],
      provider: provider
        ? [{ id: 'provider-access', description: `${displayName} provider access is configured.` }]
        : [],
    },
    readiness: {
      signals: provider ? ['process', 'provider', 'workload'] : ['process', 'workload'],
      summary: provider
        ? 'Ready when local and provider dependencies are usable.'
        : 'Ready when the local process and workload are usable.',
    },
    stateEffects: mutating ? ['artifact-create'] : [],
  };
};

const entryFor = (
  id: string,
  displayName: string,
  kind: ProfileKind = 'local',
  version = '1.0.0',
): CapabilityEntry => {
  const profile = profileFor(displayName, kind);
  const repository = `https://github.com/ashergarland/agent-tool-server-${id}`;
  const released = kind !== 'incompatible-source' && version !== '0.0.0-development';
  const artifactKind =
    kind === 'remote' ? 'oci' : kind === 'incompatible-source' ? 'source' : 'npm';
  const artifactId =
    artifactKind === 'oci'
      ? 'oci-container'
      : artifactKind === 'source'
        ? 'source-tree'
        : 'npm-package';
  return {
    $schema: capabilityEntrySchemaId,
    schemaVersion: capabilityRegistrySchemaVersion,
    kind: 'capability',
    id,
    displayName,
    description: `${displayName} test registry entry.`,
    publisher: {
      id: 'agent-tool-platform',
      displayName: 'Agent Tool Platform',
      url: 'https://github.com/ashergarland',
    },
    version: {
      value: version,
      status: released ? 'released' : version === '0.0.0-development' ? 'development' : 'declared',
    },
    artifacts: [
      {
        id: artifactId,
        kind: artifactKind,
        identifier:
          artifactKind === 'oci'
            ? `ghcr.io/ashergarland/${id}`
            : artifactKind === 'source'
              ? `https://github.com/ashergarland/${id}`
              : `@agent-tool-platform/${id}`,
        version,
        availability:
          artifactKind === 'source'
            ? 'source-only'
            : version === '0.0.0-development'
              ? 'declared'
              : 'published',
        reference: artifactKind === 'source' ? 'README.md#build' : 'server.json#/packages/0',
      },
    ],
    links: {
      repository,
      documentation: `${repository}#readme`,
    },
    category: {
      id: 'test-fixture',
      displayName: 'Test Fixture',
    },
    tags: ['test-fixture'],
    toolCount: 1,
    profiles: [profile],
    bindings: [
      {
        id:
          kind === 'remote'
            ? 'hosted-http'
            : kind === 'hybrid'
              ? 'hybrid-stdio'
              : kind === 'incompatible-source'
                ? 'source-library'
                : 'local-stdio',
        profileId: profile.id,
        artifactId,
        interface:
          kind === 'remote' ? 'http' : kind === 'incompatible-source' ? 'library' : 'stdio',
        availability: kind === 'remote' ? 'remote' : kind === 'hybrid' ? 'hybrid' : 'local',
        ...(kind === 'remote'
          ? {
              client: {
                http: {
                  headers: [
                    {
                      name: 'Authorization',
                      value: {
                        source: 'configuration' as const,
                        name: profile.prerequisites.requiredSecrets[0]!,
                        prefix: 'Bearer ',
                      },
                    },
                  ],
                },
              },
            }
          : {}),
      },
    ],
    stateChanging: kind === 'hybrid',
    routing: {
      summary: `Use ${displayName} for its bounded domain operations.`,
    },
    conformance: {
      status: 'verified',
      checks: ['runtime-contract', 'mcp-metadata', 'capability-profile-v1', 'routing-metadata'],
    },
    source: {
      capabilityId: `io.github.ashergarland/agent-tool-server-${id}`,
      repository,
      revision: sha,
      metadataVersion: version,
      ...(released ? { releaseTag: `v${version}` } : {}),
      metadata: {
        server: 'server.json',
        package: 'package.json',
        profiles: 'capability-profiles.json',
      },
    },
  };
};

class FixtureRegistry implements CapabilityRegistryReader {
  public constructor(private readonly capabilities: readonly CapabilityEntry[]) {}

  public listCapabilities(): readonly CapabilityEntry[] {
    return this.capabilities;
  }

  public getCapability(capabilityId: string): CapabilityEntry | undefined {
    return this.capabilities.find((entry) => entry.id === capabilityId);
  }

  public listProfiles(capabilityId: string): readonly CapabilityProfileSummary[] | undefined {
    return this.getCapability(capabilityId)?.profiles;
  }

  public listBindings(capabilityId: string): CapabilityEntry['bindings'] | undefined {
    return this.getCapability(capabilityId)?.bindings;
  }
}

const definition = (
  capabilities: readonly {
    readonly id: string;
    readonly version?: string;
    readonly profile?: string;
  }[],
) => ({
  schemaVersion: 1,
  id: 'test-agent',
  name: 'Test Agent',
  version: '1.0.0',
  instructions: 'Use the selected capabilities to produce concise, evidence-backed results.',
  capabilities,
});

const expectAgentKitError = async (
  action: () => unknown,
  code: AgentKitError['code'],
): Promise<AgentKitError> => {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentKitError);
    expect((error as AgentKitError).code).toBe(code);
    return error as AgentKitError;
  }
  throw new Error(`Expected AgentKitError ${code}`);
};

describe('canonical Agent Kit model', () => {
  it('normalizes capability order without changing editable instructions', () => {
    const parsed = parseAgentDefinition(
      definition([{ id: 'git-optimizer' }, { id: 'ast-summarizer' }]),
    );
    expect(parsed.instructions).toContain('evidence-backed');
    expect(parsed.capabilities.map((capability) => capability.id)).toEqual([
      'ast-summarizer',
      'git-optimizer',
    ]);
  });

  it('rejects duplicate capability identities even when selections differ', () => {
    expect(() =>
      parseAgentDefinition(
        definition([
          { id: 'ast-summarizer', version: '1.0.0' },
          { id: 'ast-summarizer', version: '1.1.0' },
        ]),
      ),
    ).toThrow(/duplicates/u);
  });
});

describe('capability and binding resolution', () => {
  it('resolves the registry-pinned version and verifies exact requests', async () => {
    const registry = new FixtureRegistry([
      entryFor('ast-summarizer', 'AST Summarizer', 'local', '1.10.0'),
    ]);
    await expect(resolveRegistryCapability(registry, 'ast-summarizer')).resolves.toMatchObject({
      version: { value: '1.10.0' },
    });
    await expect(
      resolveRegistryCapability(registry, 'ast-summarizer', '1.10.0'),
    ).resolves.toMatchObject({ id: 'ast-summarizer' });
  });

  it('reports missing capabilities and exact versions', async () => {
    const registry = new FixtureRegistry([
      entryFor('ast-summarizer', 'AST Summarizer', 'local', '1.0.0'),
    ]);
    await expectAgentKitError(
      () => resolveRegistryCapability(registry, 'missing'),
      'CAPABILITY_NOT_FOUND',
    );
    await expectAgentKitError(
      () => resolveRegistryCapability(registry, 'ast-summarizer', '9.0.0'),
      'CAPABILITY_VERSION_NOT_FOUND',
    );
    await expectAgentKitError(
      () => resolveRegistryCapability(new FixtureRegistry([]), 'ast-summarizer'),
      'CAPABILITY_NOT_FOUND',
    );
  });

  it('rejects malformed and inconsistent registry projections with bounded errors', async () => {
    const malformed = {
      ...entryFor('ast-summarizer', 'AST Summarizer'),
      description: 'x'.repeat(20_000),
    };
    const error = await expectAgentKitError(
      () => resolveRegistryCapability(new FixtureRegistry([malformed]), 'ast-summarizer'),
      'INVALID_REGISTRY_RECORD',
    );
    expect(error.message.length).toBeLessThanOrEqual(MAX_AGENT_KIT_ERROR_LENGTH);

    const inconsistent = structuredClone(entryFor('ast-summarizer', 'AST Summarizer'));
    const binding = inconsistent.bindings[0];
    if (binding === undefined) throw new Error('missing fixture binding');
    binding.profileId = 'missing-profile';
    await expectAgentKitError(
      () => resolveRegistryCapability(new FixtureRegistry([inconsistent]), 'ast-summarizer'),
      'INVALID_REGISTRY_RECORD',
    );
  });

  it.each([
    ['file:///C:/Users/operator/package.tgz', 'npm'],
    ['file:///home/operator/package.tgz', 'source'],
    ['http://public.example/package.tgz', 'source'],
    ['[fd00::1]/private/image', 'oci'],
    ['0.0.0.0/private/image', 'oci'],
    ['service.privatelink.azure.com/private/image', 'oci'],
  ] as const)('rejects non-public %s artifact identifiers', async (identifier, kind) => {
    const capability = structuredClone(entryFor('unsafe-artifact', 'Unsafe Artifact'));
    const artifact = capability.artifacts[0];
    if (artifact === undefined) throw new Error('missing fixture artifact');
    Object.assign(artifact, { identifier, kind });

    await expectAgentKitError(
      () => resolveRegistryCapability(new FixtureRegistry([capability]), capability.id),
      'INVALID_REGISTRY_RECORD',
    );
  });

  it.each([
    'file:C:/Users/operator/package.tgz',
    'file:/home/operator/package.tgz',
    'server.json?token=secret',
  ])('rejects non-portable artifact reference %s', async (reference) => {
    const capability = structuredClone(entryFor('unsafe-reference', 'Unsafe Reference'));
    const artifact = capability.artifacts[0];
    if (artifact === undefined) throw new Error('missing fixture artifact');
    artifact.reference = reference;

    await expectAgentKitError(
      () => resolveRegistryCapability(new FixtureRegistry([capability]), capability.id),
      'INVALID_REGISTRY_RECORD',
    );
  });

  it('wraps malformed and private repository URLs in bounded registry errors', async () => {
    for (const repository of ['not a url', 'https://localhost./package']) {
      const capability = structuredClone(entryFor('unsafe-repository', 'Unsafe Repository'));
      capability.source.repository = repository;
      capability.links.repository = repository;
      await expectAgentKitError(
        () => resolveRegistryCapability(new FixtureRegistry([capability]), capability.id),
        'INVALID_REGISTRY_RECORD',
      );
    }
  });

  it('rejects artifact kinds that conflict with profile delivery', async () => {
    const capability = structuredClone(entryFor('wrong-artifact', 'Wrong Artifact'));
    const artifact = capability.artifacts[0];
    if (artifact === undefined) throw new Error('missing fixture artifact');
    Object.assign(artifact, {
      kind: 'oci',
      identifier: 'ghcr.io/ashergarland/wrong-artifact',
    });

    await expectAgentKitError(
      () => resolveRegistryCapability(new FixtureRegistry([capability]), capability.id),
      'INVALID_REGISTRY_RECORD',
    );
  });

  it('rejects OCI artifact versions that cannot be Docker tags', async () => {
    const capability = structuredClone(
      entryFor('invalid-oci-version', 'Invalid OCI Version', 'local', '1.2.3+build.7'),
    );
    const artifact = capability.artifacts[0];
    if (artifact === undefined) throw new Error('missing fixture artifact');
    Object.assign(artifact, {
      kind: 'oci',
      identifier: 'ghcr.io/ashergarland/invalid-oci-version',
    });
    capability.profiles[0]!.dimensions.delivery = 'container';

    await expectAgentKitError(
      () => resolveRegistryCapability(new FixtureRegistry([capability]), capability.id),
      'INVALID_REGISTRY_RECORD',
    );
  });

  it('represents local, hybrid, and remote modes from canonical registry bindings', async () => {
    const remote = entryFor('azure', 'Azure', 'remote');
    remote.profiles[0]!.prerequisites.requiredSecrets = [];
    delete remote.bindings[0]!.client;
    const capabilities = [
      entryFor('ast-summarizer', 'AST Summarizer'),
      entryFor('vision', 'Vision', 'hybrid'),
      remote,
    ];
    const resolution = await resolveAgentDefinition(
      definition(capabilities.map((capability) => ({ id: capability.id }))),
      new FixtureRegistry(capabilities),
      vscodeHostAdapter,
    );
    expect(
      resolution.capabilities.map((capability) => [
        capability.capability.id,
        capability.status === 'resolved' ? capability.binding.mode : 'incompatible',
      ]),
    ).toEqual([
      ['ast-summarizer', 'local'],
      ['azure', 'remote'],
      ['vision', 'hybrid'],
    ]);
  });

  it('fails closed when authenticated HTTP bindings omit an explicit client mapping', async () => {
    const capability = entryFor('azure', 'Azure', 'remote');
    const profile = capability.profiles[0]!;
    const binding = capability.bindings[0]!;
    const artifact = capability.artifacts[0]!;
    delete binding.client;
    const registry = new FixtureRegistry([capability]);

    expect(vscodeHostAdapter.evaluate({ profile, binding, artifact })).toEqual({
      state: 'incompatible',
      reasons: [
        'authenticated HTTP bindings require explicit client header mappings for configuration: AZURE_TOKEN',
      ],
    });
    await expectAgentKitError(
      () =>
        resolveAgentDefinition(definition([{ id: capability.id }]), registry, vscodeHostAdapter),
      'INVALID_REGISTRY_RECORD',
    );
  });

  it('resolves and generates authenticated HTTP headers without credential values', async () => {
    const capability = entryFor('azure', 'Azure', 'remote');
    capability.profiles[0]!.prerequisites.requiredSecrets.push('SECOND_TOKEN');
    capability.bindings[0]!.client!.http.headers.unshift({
      name: 'X-Second',
      value: {
        source: 'configuration',
        name: 'SECOND_TOKEN',
        prefix: '',
      },
    });
    const registry = new FixtureRegistry([capability]);
    const build = await buildVsCodeAgent(definition([{ id: capability.id }]), { registry });
    const resolved = build.capabilities[0]!;

    expect(resolved.binding.httpClient).toEqual({
      headers: [
        {
          name: 'Authorization',
          configurationName: 'AZURE_TOKEN',
          prefix: 'Bearer ',
        },
        {
          name: 'X-Second',
          configurationName: 'SECOND_TOKEN',
          prefix: '',
        },
      ],
    });
    expect(build.lock.schemaVersion).toBe(2);
    expect(build.lock.build.adapters).toEqual([{ id: 'vscode', schemaVersion: 2 }]);
    expect(build.lock.capabilities[0]?.binding.client).toEqual({
      http: {
        headers: [
          {
            name: 'Authorization',
            configuration: 'AZURE_TOKEN',
            prefix: 'Bearer ',
          },
          {
            name: 'X-Second',
            configuration: 'SECOND_TOKEN',
            prefix: '',
          },
        ],
      },
    });

    const mcp = JSON.parse(build.adapter.files[1].content) as {
      readonly inputs: readonly { readonly id: string; readonly password?: boolean }[];
      readonly servers: Readonly<
        Record<string, { readonly headers?: Readonly<Record<string, string>> }>
      >;
    };
    expect(mcp.inputs).toEqual([
      expect.objectContaining({ id: 'azure-azure-token', password: true }),
      expect.objectContaining({ id: 'azure-endpoint' }),
      expect.objectContaining({ id: 'azure-second-token', password: true }),
    ]);
    expect(mcp.servers.azure?.headers).toEqual({
      Authorization: 'Bearer ${input:azure-azure-token}',
      'X-Second': '${input:azure-second-token}',
    });
    expect(build.lockText).not.toContain('synthetic-secret-value');
    expect(build.adapter.files[1].content).not.toContain('synthetic-secret-value');
    expect(build.readiness.capabilities[0]?.state).toBe('missing-configuration');
    expect(build.readiness.capabilities[0]?.requirements).toEqual(
      expect.arrayContaining([
        { kind: 'configuration', state: 'missing', name: 'AZURE_TOKEN' },
        { kind: 'configuration', state: 'missing', name: 'SECOND_TOKEN' },
        { kind: 'remote-connection', state: 'setup-required' },
        expect.objectContaining({
          kind: 'provider-prerequisite',
          state: 'setup-required',
        }),
      ]),
    );
  });

  it('surfaces incompatible bindings in readiness and refuses to build them', async () => {
    const capability = entryFor('source-only', 'Source Only', 'incompatible-source');
    const registry = new FixtureRegistry([capability]);
    const resolution = await resolveAgentDefinition(
      definition([{ id: capability.id }]),
      registry,
      vscodeHostAdapter,
    );
    expect(createReadinessPlan(resolution).capabilities[0]?.state).toBe('incompatible-binding');
    await expectAgentKitError(
      () => buildVsCodeAgent(definition([{ id: capability.id }]), { registry }),
      'INCOMPATIBLE_BINDING',
    );
  });
});

describe('deterministic build outputs', () => {
  const localCapabilities = [
    entryFor('data-cruncher', 'Data Cruncher'),
    entryFor('ast-summarizer', 'AST Summarizer'),
    entryFor('git-optimizer', 'Git Optimizer'),
  ];
  const localDefinition = definition([
    { id: 'git-optimizer' },
    { id: 'data-cruncher', version: '1.0.0' },
    { id: 'ast-summarizer' },
  ]);
  const localBindings = localCapabilities.map((capability) =>
    capabilityBindingKey(
      capability.id,
      capability.version.value,
      capability.profiles[0]?.id ?? 'missing',
    ),
  );

  it('reproduces definition -> lock -> VS Code adapter -> readiness exactly', async () => {
    const options = {
      registry: new FixtureRegistry(localCapabilities),
      readinessSnapshot: {
        schemaVersion: 1 as const,
        availableLocalBindings: localBindings,
      },
    };
    const first = await buildVsCodeAgent(localDefinition, options);
    const second = await buildVsCodeAgent(
      { ...localDefinition, capabilities: [...localDefinition.capabilities].reverse() },
      { ...options, registry: new FixtureRegistry([...localCapabilities].reverse()) },
    );

    expect(first.lockText).toBe(second.lockText);
    expect(first.lockDigest).toBe(second.lockDigest);
    expect(first.adapter).toEqual(second.adapter);
    expect(first.readiness).toEqual(second.readiness);
    expect(first.lock.capabilities.map((capability) => capability.id)).toEqual([
      'ast-summarizer',
      'data-cruncher',
      'git-optimizer',
    ]);
    expect(first.readiness.capabilities.every((item) => item.state === 'available-local')).toBe(
      true,
    );
    expect(first.adapter.files[0].path).toBe('.github/agents/test-agent.agent.md');
    expect(first.adapter.files[0].content).toContain('ast-summarizer/*');
    expect(first.adapter.files[0].content).not.toContain('inputSchema');

    const mcp = JSON.parse(first.adapter.files[1].content) as {
      readonly servers: Record<string, { readonly command: string; readonly args: string[] }>;
    };
    expect(mcp.servers['ast-summarizer']).toEqual({
      args: ['-y', '@agent-tool-platform/ast-summarizer@1.0.0'],
      command: 'npx',
      type: 'stdio',
    });
  });

  describe('Prepare and prepared Agent Instances', () => {
    const environmentId = 'developer-workstation';
    const fixedClock = {
      now: () => new Date('2026-09-25T04:00:00.000Z'),
    };

    const buildComposition = async (): Promise<AgentBuild> => {
      const capabilities = [
        entryFor('ast-summarizer', 'AST Summarizer'),
        entryFor('vision', 'Vision', 'hybrid'),
        entryFor('azure', 'Azure', 'remote'),
      ];
      return buildVsCodeAgent(
        definition(capabilities.map((capability) => ({ id: capability.id }))),
        { registry: new FixtureRegistry(capabilities) },
      );
    };

    const readySnapshotFor = (build: AgentBuild): ReadinessSnapshot => ({
      schemaVersion: 1,
      availableLocalBindings: build.capabilities
        .filter((capability) => capability.binding.mode !== 'remote')
        .map((capability) => capability.binding.key),
      availableRemoteBindings: build.capabilities
        .filter((capability) => capability.binding.mode === 'remote')
        .map((capability) => capability.binding.key),
      availableProviderPrerequisites: build.capabilities.flatMap((capability) =>
        capability.binding.providerPrerequisites.map(
          (prerequisite) => `${capability.binding.key}/${prerequisite.id}`,
        ),
      ),
      configuration: build.capabilities
        .filter((capability) => capability.binding.requiredSecretNames.length > 0)
        .map((capability) => ({
          bindingKey: capability.binding.key,
          availableNames: [...capability.binding.requiredSecretNames],
        })),
    });

    it('creates a deterministic capability-neutral plan without host file contents', async () => {
      const build = await buildComposition();
      const options = {
        environmentId,
        readinessSnapshot: { schemaVersion: 1 as const },
      };
      const first = createPreparationPlan(build, options);
      const second = createPreparationPlan(build, options);
      const text = JSON.stringify(first);

      expect(first).toEqual(second);
      expect(first.schemaVersion).toBe(PREPARATION_SCHEMA_VERSION);
      expect(first.instance.instanceId).toBe(
        createPreparedAgentInstanceIdentity(build.instanceIdentity, environmentId).instanceId,
      );
      expect(first.actions.map((action) => action.kind)).toEqual([
        'make-local-artifact-available',
        'make-local-artifact-available',
        'prepare-host-integration',
        'verify-configuration',
        'verify-configuration',
        'verify-provider-prerequisite',
        'verify-provider-prerequisite',
        'verify-remote-connection',
      ]);
      expect(first.actions.every((action) => action.actionId.startsWith('sha256:'))).toBe(true);
      expect(text).not.toContain(build.definition.instructions);
      expect(text).not.toContain(build.adapter.files[0]?.content);
      expect(text).not.toContain(build.adapter.files[1]?.content);
    });

    it('produces READY but never ACTIVE when all environment evidence exists', async () => {
      const build = await buildComposition();
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: readySnapshotFor(build),
        hostIntegration: 'available',
        clock: fixedClock,
      });

      expect(result.instance.schemaVersion).toBe(PREPARED_AGENT_INSTANCE_SCHEMA_VERSION);
      expect(result.instance.state).toBe('READY');
      expect(result.instance.state).not.toBe('ACTIVE');
      expect(result.instance.preparedAt).toBe('2026-09-25T04:00:00.000Z');
      expect(result.instance.bindings.every((binding) => binding.state === 'READY')).toBe(true);
      expect(result.runnable).toBe(true);
      expect(result.setupRequirements).toEqual([]);
      expect(result.readiness.activityAssessment).toBe('not-evaluated');
      expect(result.actionResults.every((action) => action.status === 'already-ready')).toBe(true);
    });

    it('keeps instance identity stable across re-Prepare and updates mutable state', async () => {
      const build = await buildComposition();
      const readinessSnapshot = readySnapshotFor(build);
      const first = await prepareAgent(build, {
        environmentId,
        readinessSnapshot,
        hostIntegration: 'available',
        clock: fixedClock,
      });
      const second = await prepareAgent(build, {
        environmentId,
        readinessSnapshot,
        hostIntegration: 'available',
        existingInstance: serializePreparedAgentInstance(first.instance),
        clock: { now: () => new Date('2026-09-25T05:00:00.000Z') },
      });

      expect(first.disposition).toBe('created');
      expect(second.disposition).toBe('updated');
      expect(second.instance.instanceId).toBe(first.instance.instanceId);
      expect(second.instance.preparedAt).toBe('2026-09-25T05:00:00.000Z');
      expect(second.identity).toEqual(first.identity);
    });

    it('changes identity for a different environment or locked build', async () => {
      const firstBuild = await buildComposition();
      const changedCapability = entryFor('ast-summarizer', 'AST Summarizer', 'local', '1.1.0');
      const changedBuild = await buildVsCodeAgent(definition([{ id: changedCapability.id }]), {
        registry: new FixtureRegistry([changedCapability]),
      });
      const first = await prepareAgent(firstBuild, {
        environmentId,
        readinessSnapshot: readySnapshotFor(firstBuild),
        hostIntegration: 'available',
        clock: fixedClock,
      });
      const otherEnvironment = await prepareAgent(firstBuild, {
        environmentId: 'ci-environment',
        readinessSnapshot: readySnapshotFor(firstBuild),
        hostIntegration: 'available',
        clock: fixedClock,
      });
      const otherBuild = await prepareAgent(changedBuild, {
        environmentId,
        readinessSnapshot: readySnapshotFor(changedBuild),
        hostIntegration: 'available',
        clock: fixedClock,
      });

      expect(otherEnvironment.instance.instanceId).not.toBe(first.instance.instanceId);
      expect(otherBuild.instance.instanceId).not.toBe(first.instance.instanceId);
    });

    it('keeps a missing local artifact in NEEDS_SETUP, including declared development artifacts', async () => {
      const capability = entryFor('doc-rag', 'Document RAG', 'local', '0.0.0-development');
      const build = await buildVsCodeAgent(definition([{ id: capability.id }]), {
        registry: new FixtureRegistry([capability]),
      });
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: { schemaVersion: 1 },
        hostIntegration: 'available',
        clock: fixedClock,
      });

      expect(build.capabilities[0]?.binding.artifact.availability).toBe('declared');
      expect(result.instance.state).toBe('NEEDS_SETUP');
      expect(result.instance.bindings[0]).toMatchObject({
        state: 'NEEDS_SETUP',
        readiness: 'local-setup-required',
      });
      expect(result.setupRequirements).toEqual([
        expect.objectContaining({
          action: expect.objectContaining({ kind: 'make-local-artifact-available' }),
          status: 'setup-required',
        }),
      ]);
    });

    it('requires named configuration independently from remote connectivity and provider readiness', async () => {
      const capability = entryFor('azure', 'Azure', 'remote');
      const build = await buildVsCodeAgent(definition([{ id: capability.id }]), {
        registry: new FixtureRegistry([capability]),
      });
      const key = build.capabilities[0]!.binding.key;
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: {
          schemaVersion: 1,
          availableRemoteBindings: [key],
          availableProviderPrerequisites: [`${key}/provider-access`],
        },
        hostIntegration: 'available',
        clock: fixedClock,
      });

      expect(result.instance.state).toBe('NEEDS_SETUP');
      expect(result.readiness.capabilities[0]?.state).toBe('missing-configuration');
      expect(result.setupRequirements.map((requirement) => requirement.action.kind)).toEqual([
        'verify-configuration',
      ]);
    });

    it('requires a remote connection independently from configuration and provider readiness', async () => {
      const capability = entryFor('azure', 'Azure', 'remote');
      const build = await buildVsCodeAgent(definition([{ id: capability.id }]), {
        registry: new FixtureRegistry([capability]),
      });
      const key = build.capabilities[0]!.binding.key;
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: {
          schemaVersion: 1,
          availableProviderPrerequisites: [`${key}/provider-access`],
          configuration: [{ bindingKey: key, availableNames: ['AZURE_TOKEN'] }],
        },
        hostIntegration: 'available',
        clock: fixedClock,
      });

      expect(result.instance.state).toBe('NEEDS_SETUP');
      expect(result.readiness.capabilities[0]?.state).toBe('remote-provider-setup-required');
      expect(result.setupRequirements.map((requirement) => requirement.action.kind)).toEqual([
        'verify-remote-connection',
      ]);
    });

    it('requires provider readiness independently from a reachable remote endpoint', async () => {
      const capability = entryFor('azure', 'Azure', 'remote');
      const build = await buildVsCodeAgent(definition([{ id: capability.id }]), {
        registry: new FixtureRegistry([capability]),
      });
      const key = build.capabilities[0]!.binding.key;
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: {
          schemaVersion: 1,
          availableRemoteBindings: [key],
          configuration: [{ bindingKey: key, availableNames: ['AZURE_TOKEN'] }],
        },
        hostIntegration: 'available',
        clock: fixedClock,
      });

      expect(result.instance.state).toBe('NEEDS_SETUP');
      expect(result.readiness.capabilities[0]?.state).toBe('remote-provider-setup-required');
      expect(result.setupRequirements.map((requirement) => requirement.action.kind)).toEqual([
        'verify-provider-prerequisite',
      ]);
    });

    it('represents mixed local and remote partial readiness without treating inactivity as failure', async () => {
      const build = await buildComposition();
      const readySnapshot = readySnapshotFor(build);
      const vision = build.capabilities.find(
        (capability) => capability.capability.id === 'vision',
      )!;
      const snapshot: ReadinessSnapshot = {
        ...readySnapshot,
        availableLocalBindings: readySnapshot.availableLocalBindings?.filter(
          (binding) => binding !== vision.binding.key,
        ),
        availableProviderPrerequisites: readySnapshot.availableProviderPrerequisites?.filter(
          (prerequisite) => !prerequisite.startsWith(`${vision.binding.key}/`),
        ),
        configuration: readySnapshot.configuration?.filter(
          (entry) => entry.bindingKey !== vision.binding.key,
        ),
      };
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: snapshot,
        hostIntegration: 'available',
        clock: fixedClock,
      });
      const states = Object.fromEntries(
        result.instance.bindings.map((binding) => [binding.capabilityId, binding.state]),
      );

      expect(states).toEqual({
        'ast-summarizer': 'READY',
        azure: 'READY',
        vision: 'NEEDS_SETUP',
      });
      expect(result.instance.state).toBe('NEEDS_SETUP');
      expect(result.readiness.activityAssessment).toBe('not-evaluated');
    });

    it('reconciles successful bounded driver actions through the existing readiness engine', async () => {
      const build = await buildComposition();
      const execute = vi.fn(async () => ({ status: 'success' as const }));
      const driver: PreparationDriver = { execute };
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: { schemaVersion: 1 },
        driver,
        clock: fixedClock,
      });

      expect(execute).toHaveBeenCalledTimes(result.plan.actions.length);
      expect(result.actionResults.every((action) => action.status === 'success')).toBe(true);
      expect(result.hostIntegration.status).toBe('success');
      expect(result.readiness.capabilities.map((capability) => capability.state)).toEqual([
        'available-local',
        'ready',
        'ready',
      ]);
      expect(result.instance.state).toBe('READY');
      expect(result.runnable).toBe(true);
    });

    it('uses UNAVAILABLE only when the driver reports concrete unavailable evidence', async () => {
      const build = await buildComposition();
      const driver: PreparationDriver = {
        execute: vi.fn(async ({ action }) => ({
          status:
            action.kind === 'verify-remote-connection'
              ? ('unavailable' as const)
              : ('success' as const),
        })),
      };
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: { schemaVersion: 1 },
        driver,
        clock: fixedClock,
      });
      const azure = result.instance.bindings.find((binding) => binding.capabilityId === 'azure');

      expect(azure?.state).toBe('UNAVAILABLE');
      expect(result.instance.state).toBe('UNAVAILABLE');
      expect(result.runnable).toBe(false);
    });

    it('reports host integration setup and unavailability without regenerating the adapter', async () => {
      const build = await buildComposition();
      const readinessSnapshot = readySnapshotFor(build);
      const setup = await prepareAgent(build, {
        environmentId,
        readinessSnapshot,
        clock: fixedClock,
      });
      const unavailable = await prepareAgent(build, {
        environmentId,
        readinessSnapshot,
        hostIntegration: 'unavailable',
        clock: fixedClock,
      });

      expect(setup.hostIntegration.status).toBe('setup-required');
      expect(setup.instance.state).toBe('NEEDS_SETUP');
      expect(unavailable.hostIntegration.status).toBe('unavailable');
      expect(unavailable.instance.state).toBe('UNAVAILABLE');
      expect(
        setup.plan.actions.find((action) => action.kind === 'prepare-host-integration'),
      ).toMatchObject({
        host: {
          id: build.adapter.hostId,
          adapterSchemaVersion: build.adapter.schemaVersion,
        },
        files: build.adapter.files.map((file) => ({ path: file.path })),
      });
    });

    it('never persists secret values, endpoint values, prompts, or host file contents', async () => {
      const secret = 'synthetic-secret-value';
      const privateEndpoint = 'https://private.example.invalid/mcp';
      const build = await buildComposition();
      const driver: PreparationDriver = {
        execute: vi.fn(async () => {
          void secret;
          void privateEndpoint;
          return { status: 'success' as const };
        }),
      };
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: { schemaVersion: 1 },
        driver,
        clock: fixedClock,
      });
      const serialized = serializePreparedAgentInstance(result.instance);

      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(privateEndpoint);
      expect(serialized).not.toContain(build.definition.instructions);
      expect(serialized).not.toContain(build.adapter.files[0]?.content);
      expect(serialized).not.toContain(build.adapter.files[1]?.content);
      expect(serialized).not.toMatch(/[A-Za-z]:\\/u);
    });

    it('rejects extra driver payloads before they can enter supported state', async () => {
      const secret = 'synthetic-secret-value';
      const build = await buildComposition();
      const unsafeDriver: PreparationDriver = {
        execute: vi.fn(async () => ({ status: 'success' as const, secret })),
      };
      const error = await expectAgentKitError(
        () =>
          prepareAgent(build, {
            environmentId,
            readinessSnapshot: { schemaVersion: 1 },
            driver: unsafeDriver,
            clock: fixedClock,
          }),
        'INVALID_PREPARATION_RESULT',
      );

      expect(error.message).not.toContain(secret);
    });

    it('round-trips deterministic serialization and rejects malformed instance data', async () => {
      const build = await buildComposition();
      const result = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: readySnapshotFor(build),
        hostIntegration: 'available',
        clock: fixedClock,
      });
      const serialized = serializePreparedAgentInstance(result.instance);

      expect(parsePreparedAgentInstance(serialized)).toEqual(result.instance);
      expect(serializePreparedAgentInstance(parsePreparedAgentInstance(serialized))).toBe(
        serialized,
      );
      expect(() =>
        parsePreparedAgentInstance({
          ...result.instance,
          instanceId: `sha256:${'0'.repeat(64)}`,
        }),
      ).toThrow(/canonical build, host, and environment identity/u);
      expect(() =>
        parsePreparedAgentInstance({ ...result.instance, secretValue: 'not-allowed' }),
      ).toThrow(/unrecognized key/iu);
      expect(() => parsePreparedAgentInstance({ ...result.instance, schemaVersion: 2 })).toThrow(
        /schemaVersion/u,
      );
      expect(() => parsePreparedAgentInstance('{')).toThrow(/JSON is invalid/u);
    });

    it('fails closed on inconsistent build material and cross-build updates', async () => {
      const build = await buildComposition();
      const mutated = structuredClone(build);
      Object.assign(mutated, { lockDigest: `sha256:${'0'.repeat(64)}` });
      await expectAgentKitError(
        () =>
          prepareAgent(mutated, {
            environmentId,
            readinessSnapshot: readySnapshotFor(build),
            hostIntegration: 'available',
            clock: fixedClock,
          }),
        'INVALID_PREPARATION_INPUT',
      );

      const mutatedInstructions = structuredClone(build);
      Object.assign(mutatedInstructions.instructions, { rendered: 'Different instructions' });
      await expectAgentKitError(
        () =>
          prepareAgent(mutatedInstructions, {
            environmentId,
            readinessSnapshot: readySnapshotFor(build),
            hostIntegration: 'available',
            clock: fixedClock,
          }),
        'INVALID_PREPARATION_INPUT',
      );

      const first = await prepareAgent(build, {
        environmentId,
        readinessSnapshot: readySnapshotFor(build),
        hostIntegration: 'available',
        clock: fixedClock,
      });
      await expectAgentKitError(
        () =>
          prepareAgent(build, {
            environmentId: 'other-environment',
            readinessSnapshot: readySnapshotFor(build),
            hostIntegration: 'available',
            existingInstance: first.instance,
            clock: fixedClock,
          }),
        'INVALID_PREPARATION_INPUT',
      );
    });

    it('bounds unexpected driver failures without copying private payloads', async () => {
      const secret = 'synthetic-secret-value';
      const build = await buildComposition();
      const driver: PreparationDriver = {
        execute: vi.fn(async () => {
          throw new AgentKitError('PREPARATION_FAILED', secret);
        }),
      };
      const error = await expectAgentKitError(
        () =>
          prepareAgent(build, {
            environmentId,
            readinessSnapshot: { schemaVersion: 1 },
            driver,
            clock: fixedClock,
          }),
        'PREPARATION_FAILED',
      );

      expect(error.message).not.toContain(secret);
      expect(error.message.length).toBeLessThanOrEqual(MAX_AGENT_KIT_ERROR_LENGTH);
    });
  });

  it('changes lock identity when registry content that affects generated output changes', async () => {
    const firstCapability = entryFor('ast-summarizer', 'AST Summarizer');
    const secondCapability = structuredClone(firstCapability);
    secondCapability.routing.summary =
      'Use the AST Summarizer only for a changed routing boundary.';

    const first = await buildVsCodeAgent(definition([{ id: firstCapability.id }]), {
      registry: new FixtureRegistry([firstCapability]),
    });
    const second = await buildVsCodeAgent(definition([{ id: secondCapability.id }]), {
      registry: new FixtureRegistry([secondCapability]),
    });

    expect(first.adapter.files[0]?.content).not.toBe(second.adapter.files[0]?.content);
    expect(first.lockDigest).not.toBe(second.lockDigest);
    expect(first.lock.capabilities[0]?.registryEntryDigest).not.toBe(
      second.lock.capabilities[0]?.registryEntryDigest,
    );
    expect(second.lockText).not.toContain(secondCapability.routing.summary);
  });

  it('forwards configured values into OCI containers', async () => {
    const capability = entryFor('vision', 'Vision', 'hybrid', '0.0.0-development');
    const artifact = capability.artifacts[0];
    const binding = capability.bindings[0];
    if (artifact === undefined || binding === undefined) throw new Error('missing fixture binding');
    Object.assign(artifact, {
      id: 'oci-container',
      kind: 'oci',
      identifier: 'ghcr.io/ashergarland/agent-tool-server-vision',
    });
    binding.artifactId = artifact.id;
    capability.profiles[0]!.dimensions.delivery = 'container';

    const build = await buildVsCodeAgent(definition([{ id: capability.id }]), {
      registry: new FixtureRegistry([capability]),
    });
    const mcp = JSON.parse(build.adapter.files[1].content) as {
      readonly servers: Record<
        string,
        {
          readonly args: readonly string[];
          readonly env: Readonly<Record<string, string>>;
        }
      >;
    };
    expect(mcp.servers.vision?.args).toEqual([
      'run',
      '--rm',
      '-i',
      '--pull=never',
      '--env',
      'VISION_TOKEN',
      'ghcr.io/ashergarland/agent-tool-server-vision:0.0.0-development',
    ]);
    expect(mcp.servers.vision?.env).toEqual({
      VISION_TOKEN: '${input:vision-vision-token}',
    });
  });

  it('validates locks before deterministic serialization', async () => {
    const build = await buildVsCodeAgent(localDefinition, {
      registry: new FixtureRegistry(localCapabilities),
    });
    const mutated = structuredClone(build.lock) as Record<string, unknown>;
    mutated.endpoint = 'https://private.invalid/mcp';
    expect(() => serializeAgentLock(mutated)).toThrow(/invalid/u);

    const priorSchema = structuredClone(build.lock) as Record<string, unknown>;
    priorSchema.schemaVersion = 1;
    expect(() => serializeAgentLock(priorSchema)).toThrow(/invalid/u);

    const wrongArtifactKind = structuredClone(build.lock);
    Object.assign(wrongArtifactKind.capabilities[0]!.artifact, {
      identifier: 'https://public.example/payload',
    });
    expect(() => serializeAgentLock(wrongArtifactKind)).toThrow(/invalid/u);
  });

  it('keeps catalog and setup prose out of agent.lock', async () => {
    const capabilities = [
      entryFor('vision', 'Vision', 'hybrid'),
      entryFor('azure', 'Azure', 'remote'),
    ];
    capabilities[0]!.description = 'Catalog-only boundary marker.';
    capabilities[0]!.routing.summary = 'Routing-only marker.';
    capabilities[0]!.profiles[0]!.prerequisites.summary = 'Setup-only prerequisite marker.';
    const build = await buildVsCodeAgent(
      definition(capabilities.map((capability) => ({ id: capability.id }))),
      {
        registry: new FixtureRegistry(capabilities),
        readinessSnapshot: {
          schemaVersion: 1,
          configuration: capabilities.map((capability) => ({
            bindingKey: capabilityBindingKey(
              capability.id,
              capability.version.value,
              capability.profiles[0]?.id ?? 'missing',
            ),
            availableNames: [`${capability.displayName.toUpperCase()}_TOKEN`],
          })),
        },
      },
    );
    expect(build.lockText).not.toContain('Catalog-only boundary marker');
    expect(build.lockText).not.toContain('Routing-only marker');
    expect(build.lockText).not.toContain('Setup-only prerequisite marker');
    expect(build.lockText).not.toMatch(/[A-Za-z]:\\/u);
    expect(build.adapter.files[1].content).toContain('${input:azure-endpoint}');
    expect(build.adapter.files[1].content).toContain('"password": true');
  });

  it('distinguishes missing configuration, local setup, provider setup, and ready state', async () => {
    const capabilities = [
      entryFor('ast-summarizer', 'AST Summarizer'),
      entryFor('vision', 'Vision', 'hybrid'),
      entryFor('azure', 'Azure', 'remote'),
    ];
    capabilities[2]!.profiles[0]!.prerequisites.requiredSecrets = [];
    delete capabilities[2]!.bindings[0]!.client;
    const registry = new FixtureRegistry(capabilities);
    const resolution = await resolveAgentDefinition(
      definition(capabilities.map((capability) => ({ id: capability.id }))),
      registry,
      vscodeHostAdapter,
    );
    const initial = createReadinessPlan(resolution);
    expect(Object.fromEntries(initial.capabilities.map((item) => [item.id, item.state]))).toEqual({
      'ast-summarizer': 'local-setup-required',
      azure: 'remote-provider-setup-required',
      vision: 'missing-configuration',
    });

    const astKey = capabilityBindingKey('ast-summarizer', '1.0.0', 'local-package');
    const visionKey = capabilityBindingKey('vision', '1.0.0', 'hybrid-provider-package');
    const azureKey = capabilityBindingKey('azure', '1.0.0', 'hosted-read-only');
    const prepared = createReadinessPlan(resolution, {
      schemaVersion: 1,
      availableLocalBindings: [astKey, visionKey],
      availableRemoteBindings: [azureKey],
      availableProviderPrerequisites: [
        `${visionKey}/provider-access`,
        `${azureKey}/provider-access`,
      ],
      configuration: [
        { bindingKey: visionKey, availableNames: ['VISION_TOKEN'] },
        { bindingKey: azureKey, availableNames: ['AZURE_TOKEN'] },
      ],
    });
    expect(Object.fromEntries(prepared.capabilities.map((item) => [item.id, item.state]))).toEqual({
      'ast-summarizer': 'available-local',
      azure: 'ready',
      vision: 'ready',
    });
    expect(prepared.activityAssessment).toBe('not-evaluated');
    expect(
      prepared.capabilities[0]?.requirements.find(
        (requirement) => requirement.kind === 'artifact-availability',
      ),
    ).toMatchObject({ state: 'published' });
  });

  it('provides a deterministic environment identity seam without fleet state', async () => {
    const build = await buildVsCodeAgent(localDefinition, {
      registry: new FixtureRegistry(localCapabilities),
    });
    const first = createPreparedAgentInstanceIdentity(
      build.instanceIdentity,
      'developer-workstation',
    );
    const second = createPreparedAgentInstanceIdentity(
      build.instanceIdentity,
      'developer-workstation',
    );
    expect(first).toEqual(second);
    expect(first.instanceId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.seam.bindings).toHaveLength(3);
  });

  it('fails rather than truncating oversized composed instructions', async () => {
    const capabilities = Array.from({ length: 50 }, (_, index) => {
      const capability = entryFor(`capability-${String(index)}`, `Capability ${String(index)}`);
      capability.description = 'x'.repeat(499);
      const profile = capability.profiles[0];
      if (profile === undefined) throw new Error('missing fixture profile');
      profile.description = 'y'.repeat(999);
      capability.routing.summary = 'z'.repeat(499);
      return capability;
    });
    const error = await expectAgentKitError(
      () =>
        buildVsCodeAgent(definition(capabilities.map((capability) => ({ id: capability.id }))), {
          registry: new FixtureRegistry(capabilities),
        }),
      'INSTRUCTION_LIMIT_EXCEEDED',
    );
    expect(error.message.length).toBeLessThanOrEqual(MAX_AGENT_KIT_ERROR_LENGTH);
  });

  it('does not use host locale collation for identity-bearing output', async () => {
    const baseline = await buildVsCodeAgent(localDefinition, {
      registry: new FixtureRegistry(localCapabilities),
    });
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => 1);
    try {
      const underDifferentCollation = await buildVsCodeAgent(localDefinition, {
        registry: new FixtureRegistry([...localCapabilities].reverse()),
      });
      expect(underDifferentCollation.lockText).toBe(baseline.lockText);
      expect(underDifferentCollation.lockDigest).toBe(baseline.lockDigest);
      expect(underDifferentCollation.adapter).toEqual(baseline.adapter);
    } finally {
      localeCompare.mockRestore();
    }
  });
});
