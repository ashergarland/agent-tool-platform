import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createMcpServer, type CreateMcpServerOptions } from './server.js';

/**
 * Stateless Streamable HTTP MCP.
 *
 * A fresh server and transport are created for each request and closed when it completes, so no
 * session state accumulates. That is what lets a deployment scale to zero and run several replicas
 * behind one hostname without sticky routing, and it is why there is deliberately no session
 * database here.
 *
 * Authentication, rate limiting, and the request identity are applied by the surrounding platform
 * hooks exactly as for the plain HTTP tool routes: this transport adds a protocol, never a way
 * around the guards.
 */
export const handleMcpHttpRequest = async <TServices>(
  options: CreateMcpServerOptions<TServices>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const server = createMcpServer(options);
  const transport = new StreamableHTTPServerTransport({
    // Omitting `sessionIdGenerator` disables session management entirely, so no session id is
    // issued and none is required. `enableJsonResponse` keeps every call a bounded
    // request/response pair rather than an open SSE stream.
    enableJsonResponse: true,
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Both are closed unconditionally, including on the error path, so a failed handshake cannot
    // leak a server or a transport.
    await Promise.allSettled([transport.close(), server.close()]);
  };
  reply.raw.on('close', () => {
    void close();
  });

  reply.hijack();
  try {
    // The SDK's Transport interface declares optional callbacks that the concrete transport types
    // as `T | undefined`; under exactOptionalPropertyTypes those are not assignable without a
    // cast. The runtime contract is unaffected.
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch (error) {
    request.log.error({ err: error, event: 'mcp.request.error' }, 'MCP request failed');
    if (!reply.raw.headersSent) {
      reply.raw.statusCode = 500;
      reply.raw.setHeader('content-type', 'application/json');
      reply.raw.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }),
      );
    } else {
      reply.raw.destroy();
    }
  } finally {
    await close();
  }
};
