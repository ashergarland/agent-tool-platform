import type { HttpServer, ToolRegistry } from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from './harness.js';

/**
 * HTTP conformance.
 *
 * Uses Fastify's `inject`, so the whole hook chain runs — request identity, authentication, both
 * rate-limit budgets, error normalization, cache headers — without binding a port.
 */

export interface HttpConformanceOptions<TServices> extends ConformanceOptions {
  readonly app: HttpServer;
  readonly registry: ToolRegistry<TServices>;
  /** A credential the server accepts. Omit when the deployment under test disables auth. */
  readonly apiKey?: string;
  /** A read tool plus a valid body, used to prove an authenticated invocation succeeds. */
  readonly readSample?: { readonly name: string; readonly body: unknown };
  /** Capability extension routes that must inherit authentication. */
  readonly protectedExtensionPaths?: readonly string[];
  readonly publicPaths?: readonly string[];
}

const authHeaders = (apiKey: string | undefined): Record<string, string> =>
  apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };

export const runHttpConformance = async <TServices>(
  options: HttpConformanceOptions<TServices>,
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('http');
  const { app, apiKey } = options;

  for (const path of options.publicPaths ?? ['/health', '/version', '/openapi.json']) {
    const response = await app.inject({ method: 'GET', url: path });
    run.check(`${path} is public`, response.statusCode === 200, `status ${response.statusCode}`);
    run.check(
      `${path} sets cache-control: no-store`,
      response.headers['cache-control'] === 'no-store',
    );
    run.check(`${path} echoes a request id`, typeof response.headers['x-request-id'] === 'string');
  }

  const ready = await app.inject({ method: 'GET', url: '/ready' });
  run.check(
    '/ready is public and answers 200 or 503',
    ready.statusCode === 200 || ready.statusCode === 503,
    `status ${ready.statusCode}`,
  );

  const protectedPaths = [
    '/tools',
    ...options.registry.list().map((tool) => `/tools/${tool.name}`),
    '/mcp',
    ...(options.protectedExtensionPaths ?? []),
  ];

  if (apiKey !== undefined) {
    for (const path of protectedPaths) {
      const isGet = path === '/tools' || (options.protectedExtensionPaths ?? []).includes(path);
      const response = isGet
        ? await app.inject({ method: 'GET', url: path })
        : await app.inject({ method: 'POST', url: path, payload: {} });
      run.check(
        `${path} requires authentication`,
        response.statusCode === 401,
        `status ${response.statusCode}`,
      );
    }

    const invalid = await app.inject({
      method: 'GET',
      url: '/tools',
      headers: { authorization: 'Bearer not-a-valid-key' },
    });
    run.check('an invalid credential is rejected', invalid.statusCode === 401);

    const catalogue = await app.inject({
      method: 'GET',
      url: '/tools',
      headers: authHeaders(apiKey),
    });
    run.check('a valid credential reaches the catalogue', catalogue.statusCode === 200);
    const body = catalogue.json();
    run.equal(
      'the HTTP catalogue matches the registry',
      body.tools?.length,
      options.registry.list().length,
    );
  }

  const suppliedId = 'conformance-request-id';
  const echoed = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { 'x-request-id': suppliedId },
  });
  run.equal('a caller request id is echoed', echoed.headers['x-request-id'], suppliedId);

  const oversized = await app.inject({
    method: 'GET',
    url: '/health',
    headers: { 'x-request-id': 'x'.repeat(500) },
  });
  run.check(
    'an oversized caller request id is replaced',
    typeof oversized.headers['x-request-id'] === 'string' &&
      oversized.headers['x-request-id'].length <= 200,
  );

  if (options.readSample && apiKey !== undefined) {
    const response = await app.inject({
      method: 'POST',
      url: `/tools/${options.readSample.name}`,
      headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
      payload: options.readSample.body as Record<string, unknown>,
    });
    run.check(
      `${options.readSample.name} is invocable over HTTP`,
      response.statusCode === 200,
      `status ${response.statusCode}: ${response.body.slice(0, 200)}`,
    );
    const payload = response.json();
    run.equal('the response names the tool', payload.tool, options.readSample.name);
    run.check('the response carries a request id', typeof payload.requestId === 'string');
  }

  const unknownRoute = await app.inject({ method: 'GET', url: '/definitely-not-a-route' });
  run.check('unknown routes produce a normalized 404', unknownRoute.statusCode === 404);

  return run.finish(options);
};
