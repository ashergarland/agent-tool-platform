import { afterEach, describe, expect, it } from 'vitest';
import { connectInMemoryMcpClient } from '@agent-tool-platform/testkit';
import { minimalInstructions } from '@agent-tool-platform/example-minimal-capability';
import { bearer, createStartedFixture, type Fixture } from './helpers.js';

let fixtures: Fixture[] = [];

const fixture = async (): Promise<Fixture> => {
  const created = await createStartedFixture();
  fixtures.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(fixtures.map((entry) => entry.application.shutdown()));
  fixtures = [];
});

describe('in-process MCP', () => {
  it('publishes the capability instructions through initialization', async () => {
    const { application } = await fixture();
    const connection = await connectInMemoryMcpClient(application.createStdioServer());
    try {
      expect(connection.client.getInstructions()).toBe(minimalInstructions);
    } finally {
      await connection.close();
    }
  });

  it('publishes registry metadata verbatim', async () => {
    const { application } = await fixture();
    const connection = await connectInMemoryMcpClient(application.createStdioServer());
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools).toHaveLength(application.registry.size);

      const tool = application.registry.get('list_notes');
      const published = listed.tools.find((entry) => entry.name === 'list_notes');
      expect(published?.title).toBe(tool.title);
      expect(published?.description).toBe(tool.description);
      expect(published?.inputSchema).toEqual(tool.inputJsonSchema);
      expect(published?.outputSchema).toEqual(tool.outputJsonSchema);
      expect(published?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });

      const write = listed.tools.find((entry) => entry.name === 'put_note');
      expect(write?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    } finally {
      await connection.close();
    }
  });

  it('invokes read and write tools and reports the stdio transport', async () => {
    const { application, telemetry } = await fixture();
    const connection = await connectInMemoryMcpClient(application.createStdioServer());
    try {
      const read = await connection.client.callTool({ name: 'list_notes', arguments: {} });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ total: 0 });

      const write = await connection.client.callTool({
        name: 'put_note',
        arguments: { id: 'alpha', text: 'hello', dryRun: true },
      });
      expect(write.structuredContent).toMatchObject({ mode: 'preview', stored: false });
    } finally {
      await connection.close();
    }

    expect(telemetry.events.every((event) => event.transport === 'mcp-stdio')).toBe(true);
  });

  it('reports tool failures in band rather than as protocol errors', async () => {
    const { application } = await fixture();
    const connection = await connectInMemoryMcpClient(application.createStdioServer());
    try {
      const result = await connection.client.callTool({ name: 'no_such_tool', arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      expect(JSON.parse(text)).toMatchObject({ code: 'not_found' });
    } finally {
      await connection.close();
    }
  });
});

describe('Streamable HTTP MCP', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  };

  it('requires authentication', async () => {
    const { application } = await fixture();
    const response = await application.http.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: initialize,
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers an authenticated initialize with the capability instructions', async () => {
    const { application, apiKey } = await fixture();
    const response = await application.http.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...bearer(apiKey), accept: 'application/json, text/event-stream' },
      payload: initialize,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result?.instructions).toBe(minimalInstructions);
    expect(body.result?.serverInfo).toBeDefined();
  });

  it('is stateless: no session id is issued and none is required', async () => {
    const { application, apiKey } = await fixture();
    const first = await application.http.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...bearer(apiKey), accept: 'application/json, text/event-stream' },
      payload: initialize,
    });
    expect(first.headers['mcp-session-id']).toBeUndefined();

    const second = await application.http.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...bearer(apiKey), accept: 'application/json, text/event-stream' },
      payload: { ...initialize, id: 2 },
    });
    expect(second.statusCode).toBe(200);
  });

  it('records mcp-http as the transport on invocation telemetry', async () => {
    const { application, apiKey, telemetry } = await fixture();
    await application.http.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...bearer(apiKey), accept: 'application/json, text/event-stream' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_notes', arguments: {} },
      },
    });
    expect(telemetry.events.map((event) => event.transport)).toContain('mcp-http');
  });
});
