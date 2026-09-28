import { describe, expect, it } from 'vitest';
import { createInMemoryBuilderInstanceStore } from '../src/server/instance-store.js';
import { createBuilderService } from '../src/server/service.js';
import { LOCAL_VSCODE_ENVIRONMENT_ID } from '../src/shared/contracts.js';
import { developerOptimizationPreset } from '../src/shared/developer-optimization-preset.js';

describe('Developer Optimization Agent Builder acceptance', () => {
  it('builds all seven capabilities deterministically through Registry and Agent Kit', async () => {
    expect(developerOptimizationPreset.capabilities).toEqual(
      expect.arrayContaining([
        { id: 'vision', profile: 'local-package' },
        { id: 'azure', profile: 'hosted-read-only' },
      ]),
    );
    const service = createBuilderService({
      instanceStore: createInMemoryBuilderInstanceStore(),
    });
    const first = await service.buildAgent(developerOptimizationPreset);
    const second = await service.buildAgent(developerOptimizationPreset);

    expect(first).toEqual(second);
    expect(first.agent).toEqual({
      id: 'developer-optimization',
      name: 'Developer Optimization Agent',
      version: '1.0.0',
    });
    expect(first.capabilities).toHaveLength(7);
    expect(first.capabilities.map(({ id }) => id)).toEqual([
      'ast-summarizer',
      'azure',
      'data-cruncher',
      'doc-rag',
      'document-optimizer',
      'git-optimizer',
      'vision',
    ]);
    expect(first.capabilities.every(({ binding }) => binding.mode.length > 0)).toBe(true);
    expect(first.capabilities.every(({ readiness }) => readiness.state.length > 0)).toBe(true);
    expect(first.execution).toEqual({ local: 6, remote: 1, hybrid: 0 });

    const lock = first.artifacts.find(({ kind }) => kind === 'lock');
    const agent = first.artifacts.find(({ kind }) => kind === 'vscode-agent');
    const mcp = first.artifacts.find(({ kind }) => kind === 'mcp');
    expect(lock).toMatchObject({ path: 'agent.lock', mediaType: 'application/json' });
    expect(JSON.parse(lock?.content ?? '{}')).toMatchObject({
      kind: 'agent-lock',
      agent: { id: 'developer-optimization', version: '1.0.0' },
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: 'azure', version: '0.3.0' }),
      ]),
    });
    expect(agent?.path).toBe('.github/agents/developer-optimization.agent.md');
    expect(agent?.content).toContain('# Agent Instructions');
    expect(mcp?.path).toBe('.vscode/mcp.json');

    const mcpDocument = JSON.parse(mcp?.content ?? '{}') as {
      readonly inputs?: readonly {
        readonly id: string;
        readonly password?: boolean;
      }[];
      readonly servers?: Readonly<
        Record<
          string,
          { readonly url?: string; readonly headers?: Readonly<Record<string, string>> }
        >
      >;
    };
    expect(Object.keys(mcpDocument.servers ?? {})).toHaveLength(7);
    expect(mcpDocument.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'azure-endpoint' }),
        expect.objectContaining({ id: 'azure-connector-api-key', password: true }),
      ]),
    );
    expect(mcpDocument.servers?.['azure']).toEqual({
      type: 'http',
      url: '${input:azure-endpoint}',
      headers: { 'x-api-key': '${input:azure-connector-api-key}' },
    });

    const azure = first.capabilities.find(({ id }) => id === 'azure');
    expect(azure).toMatchObject({
      resolvedVersion: '0.3.0',
      profile: { id: 'hosted-read-only' },
      binding: { mode: 'remote', interface: 'http' },
      compatibility: { state: 'compatible', reasons: [] },
      artifact: { kind: 'oci', availability: 'published' },
      readiness: { state: 'missing-configuration' },
      configuration: {
        endpointRequired: true,
        requiredNames: ['connector-api-key'],
        headers: [
          {
            name: 'x-api-key',
            configurationName: 'connector-api-key',
            prefix: '',
          },
        ],
      },
    });
    expect(first.capabilities.find(({ id }) => id === 'vision')).toMatchObject({
      profile: { id: 'local-package', mutation: 'mutating' },
      binding: { mode: 'local' },
    });
    expect(mcp?.content).not.toContain('actual-secret');
    expect(first.readiness.setupRequired).toBe(7);
    expect(first.readiness.configurationRequired).toBe(1);
    expect(first.lockDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const prepared = await service.prepareAgent({
      definition: developerOptimizationPreset,
      expectedLockDigest: first.lockDigest,
      environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
    });
    expect(prepared.agent).toEqual({
      id: 'developer-optimization',
      version: '1.0.0',
    });
    expect(prepared.build.lockDigest).toBe(first.lockDigest);
    expect(prepared.instance).toMatchObject({
      environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
      state: 'NEEDS_SETUP',
    });
    expect(prepared.instance.instanceId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(prepared.preparation.runnable).toBe(false);
    expect(prepared.preparation.hostIntegration.status).toBe('setup-required');
    expect(prepared.setupRequirements.length).toBe(prepared.plan.actions.length);
    expect(prepared.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'make-local-artifact-available',
          capability: expect.objectContaining({ id: 'vision', profile: 'local-package' }),
        }),
        expect.objectContaining({
          kind: 'verify-configuration',
          capability: expect.objectContaining({ id: 'azure', profile: 'hosted-read-only' }),
          configurationName: 'connector-api-key',
        }),
        expect.objectContaining({ kind: 'verify-remote-connection' }),
        expect.objectContaining({ kind: 'verify-provider-prerequisite' }),
        expect.objectContaining({ kind: 'prepare-host-integration' }),
      ]),
    );
    expect(prepared.readiness.capabilities.find(({ id }) => id === 'vision')).toMatchObject({
      profile: 'local-package',
      state: 'local-setup-required',
    });
    expect(prepared.readiness.capabilities.find(({ id }) => id === 'azure')).toMatchObject({
      profile: 'hosted-read-only',
      state: 'missing-configuration',
    });
    expect(JSON.stringify(prepared)).not.toContain('actual-secret');
    expect(JSON.stringify(prepared)).not.toMatch(/[A-Za-z]:\\/u);

    const discovery = await service.listInstances();
    expect(discovery.instances).toHaveLength(1);
    expect(discovery.instances[0]).toMatchObject({
      instanceId: prepared.instance.instanceId,
      state: 'NEEDS_SETUP',
      bindingSummary: { local: 6, remote: 1, hybrid: 0, total: 7 },
    });
    expect(JSON.stringify(discovery)).not.toContain(developerOptimizationPreset.instructions);
    expect(JSON.stringify(discovery)).not.toMatch(/[A-Za-z]:\\/u);
  });
});
