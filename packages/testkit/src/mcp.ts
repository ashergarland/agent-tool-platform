import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ToolRegistry } from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from './harness.js';

/**
 * MCP conformance.
 *
 * Uses the SDK's in-memory transport, which exercises the same `Server` the stdio and Streamable
 * HTTP entry points connect, so tool metadata, instructions, and invocation behaviour are proven
 * without spawning a process or opening a socket.
 */

export interface ConnectedMcpClient {
  readonly client: Client;
  close(): Promise<void>;
}

/** Connects an MCP `Server` to an in-process client. */
export const connectInMemoryMcpClient = async (server: Server): Promise<ConnectedMcpClient> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'agent-tool-platform-testkit', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async (): Promise<void> => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
};

export interface McpToolSample {
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** Assert something about the structured result. Return false to fail the check. */
  readonly expect?: (result: unknown) => boolean;
}

export interface McpConformanceOptions<TServices> extends ConformanceOptions {
  /** Creates a fresh MCP server bound to the capability under test. */
  readonly createServer: () => Server;
  readonly registry: ToolRegistry<TServices>;
  readonly instructions: string;
  readonly readSample?: McpToolSample;
  readonly writeSample?: McpToolSample;
}

export const runMcpConformance = async <TServices>(
  options: McpConformanceOptions<TServices>,
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('mcp');
  const connection = await connectInMemoryMcpClient(options.createServer());

  try {
    const instructions = connection.client.getInstructions();
    run.equal(
      'server instructions are published through initialization',
      instructions,
      options.instructions,
    );

    const listed = await connection.client.listTools();
    const expected = options.registry.list();
    run.equal('MCP publishes exactly the registry tools', listed.tools.length, expected.length);

    for (const tool of expected) {
      const published = listed.tools.find((entry) => entry.name === tool.name);
      if (!published) {
        run.check(`${tool.name}: is published`, false, 'missing from tools/list');
        continue;
      }
      run.check(`${tool.name}: is published`, true);
      run.equal(`${tool.name}: title comes from the registry`, published.title, tool.title);
      run.equal(
        `${tool.name}: description is the rendered description`,
        published.description,
        tool.description,
      );
      run.equal(
        `${tool.name}: input schema comes from the registry`,
        published.inputSchema,
        tool.inputJsonSchema,
      );
      run.equal(
        `${tool.name}: output schema comes from the registry`,
        published.outputSchema,
        tool.outputJsonSchema,
      );
      run.equal(
        `${tool.name}: annotations come from the registry`,
        {
          readOnlyHint: published.annotations?.readOnlyHint,
          destructiveHint: published.annotations?.destructiveHint,
          idempotentHint: published.annotations?.idempotentHint,
          openWorldHint: published.annotations?.openWorldHint,
        },
        {
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
          openWorldHint: tool.annotations.openWorldHint,
        },
      );
    }

    for (const [label, sample] of [
      ['read', options.readSample],
      ['write', options.writeSample],
    ] as const) {
      if (!sample) continue;
      const result = await connection.client.callTool({
        name: sample.name,
        arguments: sample.input,
      });
      run.check(`${label} tool ${sample.name} succeeds`, result.isError !== true);
      run.check(
        `${label} tool ${sample.name} returns structured content`,
        result.structuredContent !== undefined,
      );
      if (sample.expect) {
        run.check(
          `${label} tool ${sample.name} returns the expected result`,
          sample.expect(result.structuredContent),
        );
      }
    }

    const failure = await connection.client.callTool({
      name: 'definitely_not_a_registered_tool',
      arguments: {},
    });
    run.check(
      'unknown tools fail in band rather than as protocol errors',
      failure.isError === true,
    );
  } finally {
    await connection.close();
  }

  return run.finish(options);
};
