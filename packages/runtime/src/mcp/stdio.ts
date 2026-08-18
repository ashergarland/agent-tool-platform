import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { anonymousPrincipal } from '../auth/types.js';
import { createMcpServer } from './server.js';
import type { CreateMcpServerOptions } from './server.js';

/**
 * Local stdio MCP.
 *
 * stdio is a local, non-networked transport owned by the process that launched it, so credentials
 * add nothing: the principal is fixed and anonymous, and authentication configuration is
 * irrelevant. Nothing but protocol traffic may be written to stdout, which is why the stdio entry
 * point uses a silent logger.
 */

export type StdioMcpOptions<TServices> = Omit<
  CreateMcpServerOptions<TServices>,
  'transport' | 'identity'
> & {
  readonly identity?: CreateMcpServerOptions<TServices>['identity'];
};

export const createStdioMcpServer = <TServices>(options: StdioMcpOptions<TServices>): Server =>
  createMcpServer({
    ...options,
    transport: 'mcp-stdio',
    identity:
      options.identity ??
      ((): { requestId: string; principal: typeof anonymousPrincipal } => ({
        requestId: `stdio-${process.pid}-${Date.now().toString(36)}`,
        principal: anonymousPrincipal,
      })),
  });

export const connectStdio = async (server: Server): Promise<StdioServerTransport> => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
};
