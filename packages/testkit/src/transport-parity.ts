import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { HttpServer } from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from './harness.js';
import { connectInMemoryMcpClient } from './mcp.js';

/**
 * Transport parity.
 *
 * The same tool, the same input, and the same registry must produce the same result whether the
 * caller arrived over HTTP or over MCP. This is the check that catches a transport quietly
 * acquiring its own defaults, its own coercion, or its own catalogue.
 */

export interface TransportParitySample {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface TransportParityOptions extends ConformanceOptions {
  readonly app: HttpServer;
  readonly createMcpServer: () => Server;
  readonly apiKey?: string;
  readonly samples: readonly TransportParitySample[];
}

export const runTransportParity = async (
  options: TransportParityOptions,
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('transport-parity');
  const connection = await connectInMemoryMcpClient(options.createMcpServer());

  try {
    const listed = await connection.client.listTools();
    const catalogue = await options.app.inject({
      method: 'GET',
      url: '/tools',
      headers: options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` },
    });
    const httpTools = catalogue.json<{ tools: { name: string }[] }>().tools;
    run.equal(
      'HTTP and MCP publish the same tool names',
      [...httpTools.map((tool) => tool.name)].sort(),
      [...listed.tools.map((tool) => tool.name)].sort(),
    );

    for (const sample of options.samples) {
      const httpResponse = await options.app.inject({
        method: 'POST',
        url: `/tools/${sample.name}`,
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        payload: sample.input,
      });
      const httpResult = httpResponse.json().result;

      const mcpResponse = await connection.client.callTool({
        name: sample.name,
        arguments: sample.input,
      });

      run.check(
        `${sample.name}: HTTP invocation succeeds`,
        httpResponse.statusCode === 200,
        `status ${httpResponse.statusCode}`,
      );
      run.check(`${sample.name}: MCP invocation succeeds`, mcpResponse.isError !== true);
      run.equal(
        `${sample.name}: HTTP and MCP results agree`,
        httpResult,
        mcpResponse.structuredContent,
      );
    }
  } finally {
    await connection.close();
  }

  return run.finish(options);
};
