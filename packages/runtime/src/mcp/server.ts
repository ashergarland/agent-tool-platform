import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Principal } from '../auth/types.js';
import type { ToolInvoker } from '../capability/invoker.js';
import { toAppError } from '../errors.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolTransport } from '../tools/types.js';

/**
 * MCP adaptation of the tool registry.
 *
 * The list and call handlers are implemented against the low-level `Server` rather than the
 * higher-level helper, because that helper re-derives a JSON Schema from a Zod shape and quietly
 * drops constraints declared on the object itself. Serving `tool.inputJsonSchema` verbatim is what
 * guarantees an MCP client and an HTTP client see byte-identical contracts.
 *
 * Seeded by the Azure MCP server.
 */

export interface McpInvocationIdentity {
  readonly requestId: string;
  readonly principal: Principal;
  readonly signal?: AbortSignal | undefined;
}

export interface CreateMcpServerOptions<TServices> {
  readonly registry: ToolRegistry<TServices>;
  readonly invoker: ToolInvoker<TServices>;
  readonly transport: ToolTransport;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly instructions: string;
  /** Resolves the identity for one call; per-request for HTTP, fixed for stdio. */
  readonly identity: (toolName: string) => McpInvocationIdentity;
}

type ToolListEntry = ListToolsResult['tools'][number];

export const createMcpServer = <TServices>(options: CreateMcpServerOptions<TServices>): Server => {
  const server = new Server(options.serverInfo, {
    capabilities: { tools: {} },
    instructions: options.instructions,
  });

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({
    tools: options.registry.list().map((tool): ToolListEntry => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputJsonSchema as ToolListEntry['inputSchema'],
      outputSchema: tool.outputJsonSchema as ToolListEntry['outputSchema'],
      annotations: {
        title: tool.title,
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        openWorldHint: tool.annotations.openWorldHint,
      },
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const identity = options.identity(request.params.name);
      const signal = extra.signal ?? identity.signal;
      try {
        const result = await options.invoker.invoke({
          toolName: request.params.name,
          input: request.params.arguments ?? {},
          requestId: identity.requestId,
          principal: identity.principal,
          transport: options.transport,
          ...(signal === undefined ? {} : { signal }),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (error) {
        // Tool failures are reported in band so the model can react to them, rather than as
        // protocol errors, which look to a client like the server itself is broken.
        const appError = toAppError(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify(appError.toPayload(identity.requestId), null, 2),
            },
          ],
        };
      }
    },
  );

  return server;
};
