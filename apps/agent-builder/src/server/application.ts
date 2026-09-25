import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import type { BuildAgentRequest, BuilderHealthResponse } from '../shared/contracts.js';
import { BuilderServiceError, errorResponse } from './errors.js';
import { createBuilderService, type BuilderService } from './service.js';

export const BUILDER_HOST = '127.0.0.1';
export const DEFAULT_BUILDER_PORT = 4173;
const MAX_REQUEST_BYTES = 32 * 1024;

type ApplicationMode = 'development' | 'production' | 'test';

export interface BuilderApplicationOptions {
  readonly mode?: ApplicationMode;
  readonly service?: BuilderService;
  readonly staticRoot?: string;
  readonly logger?: {
    error(message: string): void;
  };
}

export interface BuilderApplication {
  readonly server: Server;
  close(): Promise<void>;
}

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const defaultLogger = {
  error(message: string): void {
    process.stderr.write(`${message.slice(0, 2_000)}\n`);
  },
};

const applySecurityHeaders = (response: ServerResponse, production: boolean): void => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  if (production) {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    );
  }
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  production: boolean,
): void => {
  applySecurityHeaders(response, production);
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(body)}\n`);
};

const requestHostname = (request: IncomingMessage): string | undefined => {
  const host = request.headers.host;
  if (host === undefined) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
};

const isLoopbackRequest = (request: IncomingMessage): boolean => {
  const hostname = requestHostname(request);
  return hostname === BUILDER_HOST || hostname === 'localhost';
};

const hasAllowedOrigin = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === BUILDER_HOST || hostname === 'localhost';
  } catch {
    return false;
  }
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new BuilderServiceError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Build requests must use application/json.',
      [],
      415,
    );
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    throw new BuilderServiceError(
      'PAYLOAD_TOO_LARGE',
      `Build requests must not exceed ${String(MAX_REQUEST_BYTES)} bytes.`,
      [],
      413,
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw new BuilderServiceError(
      'INVALID_REQUEST',
      'The request body is not valid JSON.',
      [],
      400,
      { cause: error },
    );
  }
};

const requestDefinition = (body: unknown): unknown => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BuilderServiceError(
      'INVALID_REQUEST',
      'The request body must contain one agent definition.',
      [],
      400,
    );
  }
  const entries = Object.entries(body);
  if (entries.length !== 1 || entries[0]?.[0] !== 'definition') {
    throw new BuilderServiceError(
      'INVALID_REQUEST',
      'The request body must contain only the definition property.',
      [],
      400,
    );
  }
  return (body as BuildAgentRequest).definition;
};

const handleApiRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  service: BuilderService,
  production: boolean,
): Promise<boolean> => {
  const requestUrl = new URL(request.url ?? '/', 'http://agent-builder.local');
  if (!requestUrl.pathname.startsWith('/api/')) return false;

  if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
    const health: BuilderHealthResponse = { status: 'ok', service: 'agent-builder' };
    sendJson(response, 200, health, production);
    return true;
  }
  if (requestUrl.pathname === '/api/capabilities' && request.method === 'GET') {
    sendJson(response, 200, await service.listCapabilities(), production);
    return true;
  }
  if (requestUrl.pathname === '/api/build' && request.method === 'POST') {
    if (!hasAllowedOrigin(request)) {
      throw new BuilderServiceError(
        'INVALID_REQUEST',
        'The request origin is not allowed.',
        [],
        403,
      );
    }
    const definition = requestDefinition(await readJsonBody(request));
    sendJson(response, 200, await service.buildAgent(definition), production);
    return true;
  }

  sendJson(
    response,
    404,
    {
      error: {
        code: 'INVALID_REQUEST',
        summary: 'The requested Builder API operation does not exist.',
        issues: [],
      },
    },
    production,
  );
  return true;
};

const safeStaticPath = async (root: string, requestPath: string): Promise<string | undefined> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;

  const rootPath = await realpath(root);
  const candidate = await realpath(resolve(rootPath, segments.join(sep))).catch(() => undefined);
  if (candidate === undefined) return undefined;
  const fromRoot = relative(rootPath, candidate);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..') return undefined;
  return candidate;
};

const serveFile = async (
  response: ServerResponse,
  filePath: string,
  production: boolean,
): Promise<boolean> => {
  const metadata = await stat(filePath).catch(() => undefined);
  if (metadata?.isFile() !== true) return false;
  const content = await readFile(filePath);
  applySecurityHeaders(response, production);
  response.statusCode = 200;
  response.setHeader(
    'Cache-Control',
    filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  );
  response.setHeader('Content-Type', contentTypes[extname(filePath)] ?? 'application/octet-stream');
  response.end(content);
  return true;
};

const serveStatic = async (
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  production: boolean,
): Promise<void> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, HEAD');
    response.end();
    return;
  }
  const requestUrl = new URL(request.url ?? '/', 'http://agent-builder.local');
  const requestedPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const candidate = await safeStaticPath(root, requestedPath);
  if (candidate !== undefined && (await serveFile(response, candidate, production))) return;

  const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
  if (acceptsHtml && !extname(requestedPath)) {
    const indexPath = await safeStaticPath(root, '/index.html');
    if (indexPath !== undefined && (await serveFile(response, indexPath, production))) return;
  }
  applySecurityHeaders(response, production);
  response.statusCode = 404;
  response.end('Not found\n');
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else reject(error);
    });
  });
};

export const createBuilderApplication = async (
  options: BuilderApplicationOptions = {},
): Promise<BuilderApplication> => {
  const mode = options.mode ?? 'production';
  const production = mode === 'production';
  const service = options.service ?? createBuilderService();
  const logger = options.logger ?? defaultLogger;
  let vite: ViteDevServer | undefined;

  if (mode === 'development') {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      root: fileURLToPath(new URL('../..', import.meta.url)),
      appType: 'spa',
      server: { middlewareMode: true },
    });
  }

  const staticRoot = options.staticRoot ?? fileURLToPath(new URL('../../client', import.meta.url));
  const server = createServer((request, response) => {
    void (async () => {
      if (!isLoopbackRequest(request)) {
        sendJson(
          response,
          403,
          {
            error: {
              code: 'INVALID_REQUEST',
              summary: 'Agent Builder accepts loopback requests only.',
              issues: [],
            },
          },
          production,
        );
        return;
      }
      if (await handleApiRequest(request, response, service, production)) return;
      if (vite !== undefined) {
        const developmentServer = vite;
        await new Promise<void>((resolveMiddleware, reject) => {
          let settled = false;
          const cleanup = (): void => {
            response.off('finish', finish);
            response.off('close', finish);
          };
          const settle = (error?: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error === undefined) resolveMiddleware();
            else {
              reject(
                error instanceof Error
                  ? error
                  : new Error('Vite middleware failed with a non-Error value.', { cause: error }),
              );
            }
          };
          const finish = (): void => settle();
          response.once('finish', finish);
          response.once('close', finish);
          developmentServer.middlewares(request, response, (error?: unknown) => {
            if (error !== undefined) {
              settle(error);
              return;
            }
            if (!response.writableEnded) {
              response.statusCode = 404;
              response.end('Not found\n');
            }
            settle();
          });
        });
        return;
      }
      if (mode === 'test') {
        response.statusCode = 404;
        response.end('Not found\n');
        return;
      }
      await serveStatic(request, response, staticRoot, production);
    })().catch((error: unknown) => {
      const serviceError =
        error instanceof BuilderServiceError
          ? error
          : new BuilderServiceError(
              'BUILD_FAILED',
              'The Builder request could not be completed.',
              [],
              500,
              { cause: error },
            );
      const diagnostic =
        serviceError.cause instanceof Error
          ? `${serviceError.cause.name}: ${serviceError.cause.message}`
          : serviceError.message;
      logger.error(`[agent-builder] ${serviceError.code}: ${diagnostic}`);
      if (!response.headersSent) {
        sendJson(response, serviceError.status, errorResponse(serviceError), production);
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    async close() {
      await closeServer(server);
      await vite?.close();
    },
  };
};

export const listenBuilderApplication = async (
  application: BuilderApplication,
  port = DEFAULT_BUILDER_PORT,
): Promise<{
  readonly host: typeof BUILDER_HOST;
  readonly port: number;
  readonly origin: string;
}> => {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    application.server.once('error', onError);
    application.server.listen(port, BUILDER_HOST, () => {
      application.server.off('error', onError);
      resolveListen();
    });
  });
  const address = application.server.address();
  if (address === null || typeof address === 'string') {
    await application.close();
    throw new Error('Agent Builder did not receive a TCP listening address.');
  }
  return {
    host: BUILDER_HOST,
    port: address.port,
    origin: `http://${BUILDER_HOST}:${String(address.port)}`,
  };
};
