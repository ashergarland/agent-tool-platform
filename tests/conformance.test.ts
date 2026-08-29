import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  runAuthConformance,
  runConfigConformance,
  runHttpConformance,
  runLifecycleConformance,
  runMcpConformance,
  runMetadataConformance,
  runOpenApiConformance,
  runProcessConformance,
  runRegistryConformance,
  runRootBoundaryConformance,
  runRoutingConformance,
  runScratchWorkspaceConformance,
  runTransportParity,
  createTestPlatformConfig,
  generateTestApiKey,
} from '@agent-tool-platform/testkit';
import {
  createAgentToolApplication,
  createSilentLogger,
  defineAgentToolCapability,
  type ScratchWorkspace,
} from '@agent-tool-platform/runtime';
import {
  minimalConfig,
  minimalInstructions,
} from '@agent-tool-platform/example-minimal-capability';
import { createFixture, createStartedFixture, type Fixture } from './helpers.js';

/**
 * The testkit proves the platform against the fixture. A capability repository will call these
 * same suites against its own capability, which is the point: platform invariants are tested once
 * and reused, not reimplemented per repository.
 */

let fixtures: Fixture[] = [];

const fixture = async (): Promise<Fixture> => {
  const created = await createStartedFixture();
  fixtures.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(fixtures.map((entry) => entry.application.shutdown().catch(() => undefined)));
  fixtures = [];
});

describe('testkit conformance suites', () => {
  it('registry conformance', async () => {
    const { application } = await fixture();
    const result = await runRegistryConformance({
      registry: application.registry,
      services: application.services,
      invalidInputSample: { name: 'put_note', input: { id: 'BAD ID', text: '' } },
      invalidOutputTool: {
        name: 'broken_output',
        input: { secret: 'conformance-marker' },
        marker: 'conformance-marker',
      },
    });
    expect(result.failures).toEqual([]);
  });

  it('routing conformance', async () => {
    const { application } = await fixture();
    const result = runRoutingConformance({
      registry: application.registry,
      instructions: minimalInstructions,
    });
    expect(result.failures).toEqual([]);
  });

  it('openapi conformance', async () => {
    const { application } = await fixture();
    const result = runOpenApiConformance({
      document: application.openApiDocument(),
      registry: application.registry,
    });
    expect(result.failures).toEqual([]);
  });

  it('http conformance', async () => {
    const { application, apiKey } = await fixture();
    const result = await runHttpConformance({
      app: application.http,
      registry: application.registry,
      apiKey,
      readSample: { name: 'list_notes', body: {} },
      protectedExtensionPaths: ['/notes/stats'],
    });
    expect(result.failures).toEqual([]);
  });

  it('mcp conformance', async () => {
    const { application } = await fixture();
    const result = await runMcpConformance({
      createServer: () => application.createStdioServer(),
      registry: application.registry,
      instructions: minimalInstructions,
      readSample: {
        name: 'list_notes',
        input: {},
        expect: (value) => (value as { total: number }).total === 0,
      },
      writeSample: {
        name: 'put_note',
        input: { id: 'conformance', text: 'hello', dryRun: true },
        expect: (value) => (value as { mode: string }).mode === 'preview',
      },
    });
    expect(result.failures).toEqual([]);
  });

  it('transport parity', async () => {
    const { application, apiKey } = await fixture();
    const result = await runTransportParity({
      app: application.http,
      createMcpServer: () => application.createStdioServer(),
      apiKey,
      samples: [
        { name: 'list_notes', input: { limit: 5 } },
        { name: 'put_note', input: { id: 'parity', text: 'same', dryRun: true } },
      ],
    });
    expect(result.failures).toEqual([]);
  });

  it('auth conformance', async () => {
    const result = await runAuthConformance();
    expect(result.failures).toEqual([]);
  });

  it('config conformance', async () => {
    const result = await runConfigConformance({
      spec: minimalConfig,
      serviceName: 'minimal-capability',
      serviceVersion: '0.1.0',
      invalidEnvironments: [
        { reason: 'strict mode caps the note count', env: { MINIMAL_STRICT: 'true' } },
        { reason: 'a negative note ceiling', env: { MINIMAL_MAX_NOTES: '-1' } },
      ],
      expect: (config) => config.minimal.maxNotes === 50,
    });
    expect(result.failures).toEqual([]);
  });

  it('lifecycle conformance', async () => {
    // Every application the suite builds must accept the same credential, so the shared key is
    // generated once here rather than per fixture.
    const apiKey = generateTestApiKey();
    const result = await runLifecycleConformance({
      createApplication: async () => {
        const created = await createFixture({ apiKey });
        fixtures.push(created);
        return created.application;
      },
      startedProbe: (services) => services.notes.isStarted,
      stoppedProbe: (services) => services.notes.isStopped,
      cancellableTool: { name: 'wait_for_cancellation', input: { delayMs: 50 } },
      apiKey,
    });
    expect(result.failures).toEqual([]);
  });

  it('root boundary conformance', async () => {
    const result = await runRootBoundaryConformance();
    expect(result.failures).toEqual([]);
  }, 30_000);

  it('scratch workspace conformance', async () => {
    interface Services {
      readonly workspace: ScratchWorkspace;
    }

    const capability = defineAgentToolCapability<Services>({
      manifest: {
        name: 'scratch-conformance',
        version: '0.0.0-test',
        title: 'Scratch Conformance',
        description: 'Exercises platform scratch workspace ownership.',
      },
      instructions: 'Test fixture.',
      tools: [],
      createServices: async (context) => ({
        workspace: await context.createScratchWorkspace({ prefix: 'conformance-' }),
      }),
    });
    const result = await runScratchWorkspaceConformance({
      createApplication: async () => {
        const application = await createAgentToolApplication(capability, {
          config: createTestPlatformConfig({ serviceName: 'scratch-conformance' }),
          logger: createSilentLogger(),
        });
        return { application, workspace: application.services.workspace };
      },
    });
    expect(result.failures).toEqual([]);
  });

  it('process conformance', async () => {
    const result = await runProcessConformance();
    expect(result.failures).toEqual([]);
  }, 60_000);

  it('metadata conformance', async () => {
    const packageManifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const result = runMetadataConformance({
      // The platform repository is a library, not a capability server, so it has no server.json of
      // its own. This exercises the validator with a representative capability document.
      server: {
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
        name: 'io.github.example-owner/agent-tool-server-sample',
        description: 'A representative capability document used to exercise the shared validator.',
        version: packageManifest.version,
        repository: {
          url: 'https://github.com/example-owner/agent-tool-server-sample',
          source: 'github',
        },
      },
      packageManifest: {
        name: 'agent-tool-server-sample',
        version: packageManifest.version,
        private: true,
      },
    });
    expect(result.failures).toEqual([]);
  });
});
