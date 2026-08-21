import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Readable, Writable } from 'node:stream';
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

export interface ConnectStdioOptions {
  /**
   * The streams the transport reads and writes. Both default to the process's own stdio; naming
   * them explicitly is what lets a test, or an embedder holding an inherited pipe pair, speak the
   * real protocol without commandeering the process descriptors.
   */
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

export const connectStdio = async (
  server: Server,
  options: ConnectStdioOptions = {},
): Promise<StdioServerTransport> => {
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await server.connect(transport);
  return transport;
};
