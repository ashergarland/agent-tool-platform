import { afterEach, describe, expect, it } from 'vitest';
import { connectInMemoryMcpClient } from '@agent-tool-platform/testkit';
import { bearer, createStartedFixture, type Fixture } from './helpers.js';

let fixtures: Fixture[] = [];

const fixture = async (options?: Parameters<typeof createStartedFixture>[0]): Promise<Fixture> => {
  const created = await createStartedFixture(options);
  fixtures.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(fixtures.map((entry) => entry.application.shutdown()));
  fixtures = [];
});

type JsonObject = Record<string, unknown>;

describe('OpenAPI document', () => {
  it('derives exactly one POST operation per registered tool', async () => {
    const { application } = await fixture();
    const document = application.openApiDocument();
    const paths = document['paths'] as JsonObject;
    const toolPaths = Object.keys(paths).filter((path) => path.startsWith('/tools/'));

    expect(document['openapi']).toBe('3.1.0');
    expect(toolPaths).toHaveLength(application.registry.size);
    for (const tool of application.registry.list()) {
      const operation = (paths[`/tools/${tool.name}`] as JsonObject)['post'] as JsonObject;
      expect(operation['operationId']).toBe(tool.name);
    }
  });

  it('reuses the registry schemas rather than restating them', async () => {
    const { application } = await fixture();
    const paths = application.openApiDocument()['paths'] as JsonObject;
    const tool = application.registry.get('put_note');
    const operation = (paths['/tools/put_note'] as JsonObject)['post'] as JsonObject;

    const requestSchema = (
      ((operation['requestBody'] as JsonObject)['content'] as JsonObject)[
        'application/json'
      ] as JsonObject
    )['schema'];
    expect(requestSchema).toEqual(tool.inputJsonSchema);

    const responseSchema = (
      (((operation['responses'] as JsonObject)['200'] as JsonObject)['content'] as JsonObject)[
        'application/json'
      ] as JsonObject
    )['schema'] as JsonObject;
    expect((responseSchema['properties'] as JsonObject)['result']).toEqual(tool.outputJsonSchema);
  });

  it('marks write tools consequential and read tools not', async () => {
    const { application } = await fixture();
    const paths = application.openApiDocument()['paths'] as JsonObject;
    for (const tool of application.registry.list()) {
      const operation = (paths[`/tools/${tool.name}`] as JsonObject)['post'] as JsonObject;
      expect(operation['x-openai-isConsequential'], tool.name).toBe(tool.kind === 'write');
      expect(operation['tags']).toEqual([tool.kind]);
    }
  });

  it('surfaces annotations and routing metadata', async () => {
    const { application } = await fixture();
    const paths = application.openApiDocument()['paths'] as JsonObject;
    const operation = (paths['/tools/list_notes'] as JsonObject)['post'] as JsonObject;
    expect(operation['x-tool-annotations']).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(operation['x-tool-routing']).toMatchObject({ changesState: false });
  });

  it('derives the security scheme from the configured auth mode', async () => {
    const withKey = await fixture();
    const secured = withKey.application.openApiDocument();
    expect(secured['security']).toEqual([{ bearerAuth: [] }]);

    const open = await fixture({ env: { NODE_ENV: 'development', AUTH_MODE: 'disabled' } });
    expect(open.application.openApiDocument()['security']).toEqual([]);
  });

  it('uses the capability title, description, and instructions', async () => {
    const { application } = await fixture();
    const info = application.openApiDocument()['info'] as JsonObject;
    expect(info['title']).toBe('Minimal Capability Fixture');
    expect(String(info['description'])).toContain('Routing:');
    expect(info['version']).toBe(application.config.service.version);
  });

  it('advertises the public base URL when one is configured', async () => {
    const { application } = await fixture({
      env: { PUBLIC_BASE_URL: 'https://tools.example.test' },
    });
    expect(application.openApiDocument()['servers']).toEqual([
      { url: 'https://tools.example.test' },
    ]);
  });

  it('shares one error schema across every tool operation', async () => {
    const { application } = await fixture();
    const document = application.openApiDocument();
    const components = document['components'] as JsonObject;
    expect((components['schemas'] as JsonObject)['Error']).toBeDefined();

    const paths = document['paths'] as JsonObject;
    const responses = ((paths['/tools/list_notes'] as JsonObject)['post'] as JsonObject)[
      'responses'
    ] as JsonObject;
    for (const status of ['400', '401', '403', '404', '409', '429', '500', '503', '504']) {
      expect(responses[status], status).toBeDefined();
    }
  });
});

describe('transport count invariant', () => {
  it('keeps registry, HTTP, OpenAPI, and MCP tool counts identical', async () => {
    const { application, apiKey } = await fixture();
    const registryCount = application.registry.size;

    const catalogue = (
      await application.http.inject({ method: 'GET', url: '/tools', headers: bearer(apiKey) })
    ).json();

    const paths = application.openApiDocument()['paths'] as JsonObject;
    const openApiCount = Object.keys(paths).filter((path) => path.startsWith('/tools/')).length;

    const connection = await connectInMemoryMcpClient(application.createStdioServer());
    try {
      const listed = await connection.client.listTools();
      expect(catalogue.tools).toHaveLength(registryCount);
      expect(openApiCount).toBe(registryCount);
      expect(listed.tools).toHaveLength(registryCount);
    } finally {
      await connection.close();
    }
  });
});
