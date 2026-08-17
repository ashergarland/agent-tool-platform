import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import {
  createAuthenticator,
  type CreateAuthenticatorOptions,
} from '../auth/create-authenticator.js';
import { anonymousPrincipal, type Authenticator, type Principal } from '../auth/types.js';
import type { ToolInvoker } from '../capability/invoker.js';
import type {
  CapabilityManifest,
  CapabilityRouteContext,
  ProtectedRouteRegistrar,
  PublicRouteRegistrar,
} from '../capability/types.js';
import type { PlatformConfig } from '../config/platform.js';
import { resolveRequestId } from '../context/request-id.js';
import { AppError, toAppError } from '../errors.js';
import type { ApplicationLifecycle } from '../lifecycle/state.js';
import type { ReadinessAggregator, ReadinessReport } from '../lifecycle/readiness.js';
import { handleMcpHttpRequest } from '../mcp/http.js';
import { buildOpenApiDocument } from '../openapi/document.js';
import type { ToolRegistry } from '../tools/registry.js';
import { registerErrorHandler } from './errors.js';
import { FixedWindowRateLimiter, type RateLimitDecision } from './rate-limit.js';
import { toAuthenticationRequest, type HttpServer } from './types.js';
/**
 * The platform HTTP server.
 *
 * Every guard is installed centrally: request identity, cache headers, body ceiling, proxy trust,
 * error normalization, authentication, the two rate-limit budgets, invocation logging, and
 * cancellation on disconnect. A capability contributes routes to an already-protected scope; it
 * never installs a guard, and therefore never forgets one.
 *
 * Seeded by the Data Cruncher HTTP lifecycle (two budgets, readiness caching, `onRequest`
 * authentication) with the AST error handling and the Azure MCP integration.
 */

export interface HttpServerDeps<TConfig extends PlatformConfig, TServices> {
  readonly config: TConfig;
  readonly logger: Logger;
  readonly services: TServices;
  readonly registry: ToolRegistry<TServices>;
  readonly invoker: ToolInvoker<TServices>;
  readonly lifecycle: ApplicationLifecycle;
  readonly readiness: ReadinessAggregator<unknown>;
  readonly readinessContext: unknown;
  readonly manifest: CapabilityManifest;
  readonly instructions: string;
  readonly protectedRoutes?: readonly ProtectedRouteRegistrar<TConfig, TServices>[] | undefined;
  readonly publicRoutes?: readonly PublicRouteRegistrar<TConfig, TServices>[] | undefined;
  readonly authenticator?: Authenticator | undefined;
  readonly authenticatorOptions?: CreateAuthenticatorOptions | undefined;
  /** Receives in-flight request counts so shutdown can drain capability routes too. */
  readonly requestTracker?: RequestTracker | undefined;
}

/** Aborts in-flight work when the client disconnects before the response is sent. */
const requestSignal = (reply: FastifyReply): AbortSignal => {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
};

/**
 * Counts in-flight HTTP requests so shutdown can wait for them.
 *
 * `http.close()` is not sufficient on its own: it does not track injected requests, and a hijacked
 * reply (which is how the Streamable HTTP MCP endpoint works) bypasses Fastify's normal response
 * lifecycle. Counting explicitly covers capability extension routes, which never run through the
 * `ToolInvoker` and would otherwise have their domain resources torn down mid-request.
 */
export class RequestTracker {
  private active = 0;
  private waiters: (() => void)[] = [];

  public get activeCount(): number {
    return this.active;
  }

  public enter(): () => void {
    this.active += 1;
    let released = false;
    // One-shot: `onResponse` and the raw `close` event can both fire for the same request.
    return (): void => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      if (this.active > 0) return;
      const waiters = this.waiters;
      this.waiters = [];
      for (const notify of waiters) notify();
    };
  }

  /** Resolves when every in-flight request has settled, or when the budget elapses. */
  public async waitForDrain(timeoutMs: number): Promise<{ readonly drained: boolean }> {
    if (this.active === 0) return { drained: true };
    if (timeoutMs <= 0) return { drained: false };
    return new Promise<{ readonly drained: boolean }>((resolve) => {
      let settled = false;
      const finish = (drained: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ drained });
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.waiters.push(() => finish(true));
    });
  }
}

export const createHttpServer = <TConfig extends PlatformConfig, TServices>(
  deps: HttpServerDeps<TConfig, TServices>,
): HttpServer => {
  const { config, logger, registry, invoker, lifecycle } = deps;
  const startedAt = Date.now();

  const app = Fastify({
    loggerInstance: logger,
    genReqId: (request) => resolveRequestId(request.headers['x-request-id']),
    requestIdHeader: false,
    bodyLimit: config.http.bodyLimit,
    trustProxy: config.http.trustProxy,
  });

  const authenticator =
    deps.authenticator ?? createAuthenticator(config.auth, deps.authenticatorOptions ?? {});

  // Two independent budgets. The per-principal budget is a fair-use quota for a valid caller; the
  // pre-auth budget bounds abuse from callers that cannot authenticate. Keeping them separate
  // means a well-behaved client is never throttled out by anonymous noise.
  const principalLimiter = new FixedWindowRateLimiter(
    config.http.rateLimit.max,
    config.http.rateLimit.windowMs,
  );
  const preAuthLimiter = new FixedWindowRateLimiter(
    config.http.preAuthRateLimitMax,
    config.http.rateLimit.windowMs,
  );
  // Meaningful only when TRUST_PROXY names the fronting proxy; otherwise every caller behind an
  // ingress shares one bucket, so the default is a single shared abuse budget rather than a false
  // per-client one.
  const addressKey = (request: FastifyRequest): string => request.ip || 'unknown';

  const rateLimitError = (reply: FastifyReply, decision: RateLimitDecision): AppError => {
    void reply.header(
      'retry-after',
      String(Math.max(1, Math.ceil((decision.resetAtMs - Date.now()) / 1000))),
    );
    return new AppError('rate_limited', 'Too many requests; slow down and retry', undefined, true);
  };

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  const tracker = deps.requestTracker;
  if (tracker) {
    // Registered before authentication so a request is counted for its whole life, including the
    // rejection path. Released on whichever of the two lifecycle signals fires first, because a
    // hijacked reply never reaches `onResponse`.
    app.addHook('onRequest', (request, reply, done) => {
      const release = tracker.enter();
      reply.raw.on('close', release);
      (request as FastifyRequest & { releaseTracked?: () => void }).releaseTracked = release;
      done();
    });
    app.addHook('onResponse', (request, _reply, done) => {
      (request as FastifyRequest & { releaseTracked?: () => void }).releaseTracked?.();
      done();
    });
  }

  registerErrorHandler(app, config);

  /* --------------------------------------------------------------- public */

  app.get('/health', () => ({
    status: 'ok' as const,
    service: config.service.name,
    state: lifecycle.state,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  app.get('/ready', async (_request, reply) => {
    if (lifecycle.draining) {
      const draining: ReadinessReport = {
        ready: false,
        state: 'not_ready',
        checkedAt: new Date().toISOString(),
        checks: [{ name: 'application', state: 'not_ready', detail: 'draining' }],
      };
      return reply.code(503).send(draining);
    }
    const report = await deps.readiness.evaluate(deps.readinessContext);
    return reply.code(report.ready ? 200 : 503).send(report);
  });

  app.get('/version', () => ({
    service: config.service.name,
    version: config.service.version,
    gitSha: config.service.gitSha,
    node: process.version,
    environment: config.env,
    state: lifecycle.state,
    capabilities: {
      capability: deps.manifest.name,
      transports: ['http', 'mcp-stdio', 'mcp-http'],
      authMode: config.auth.mode,
      mutationsEnabled: config.mutations.enabled,
      confirmationRequired: config.mutations.confirmationRequired,
      toolCount: registry.size,
      tools: registry.names(),
    },
  }));

  const openApi = buildOpenApiDocument(config, registry, {
    title: deps.manifest.title,
    description: deps.manifest.description,
    instructions: deps.instructions,
  });
  app.get('/openapi.json', () => openApi);

  const routeContext: CapabilityRouteContext<TConfig, TServices> = {
    config,
    services: deps.services,
    logger,
  };

  for (const register of deps.publicRoutes ?? []) {
    void app.register(async (publicApp) => {
      await register(publicApp, routeContext);
    });
  }

  /* ------------------------------------------------------------ protected */

  void app.register(async (protectedApp) => {
    /**
     * Authentication only reads a header, so it runs at `onRequest` — before body parsing. That
     * ordering matters: a valid caller is charged solely to its own principal budget, while
     * traffic that cannot authenticate is charged to the pre-auth abuse budget and rejected
     * without the server reading a body. Checking the address budget before knowing whether the
     * credential is valid would let one noisy neighbour lock out everyone sharing an address.
     */
    protectedApp.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      let principal: Principal;
      try {
        principal = await authenticator.authenticate(toAuthenticationRequest(request));
      } catch (error) {
        const abuse = preAuthLimiter.consume(addressKey(request));
        if (!abuse.allowed) throw rateLimitError(reply, abuse);
        throw error;
      }
      request.principal = principal;
      const decision = principalLimiter.consume(principal.id);
      void reply.header('x-ratelimit-remaining', String(decision.remaining));
      if (!decision.allowed) throw rateLimitError(reply, decision);
    });

    protectedApp.get('/tools', () => ({
      instructions: deps.instructions,
      tools: registry.list().map((tool) => ({
        name: tool.name,
        title: tool.title,
        summary: tool.summary,
        description: tool.description,
        kind: tool.kind,
        routing: tool.routing,
        annotations: tool.annotations,
        inputSchema: tool.inputJsonSchema,
        outputSchema: tool.outputJsonSchema,
      })),
    }));

    protectedApp.post<{ Params: { toolName: string }; Body: unknown }>(
      '/tools/:toolName',
      async (request, reply) => {
        const toolName = request.params.toolName;
        const invokedAt = Date.now();
        request.log.info({ event: 'tool.invoke', tool: toolName });
        try {
          const result = await invoker.invoke({
            toolName,
            input: request.body ?? {},
            requestId: String(request.id),
            principal: request.principal ?? anonymousPrincipal,
            transport: 'http',
            signal: requestSignal(reply),
          });
          request.log.info({
            event: 'tool.result',
            tool: toolName,
            durationMs: Date.now() - invokedAt,
            outcome: 'ok',
          });
          return { tool: toolName, requestId: request.id, result };
        } catch (error) {
          request.log.info({
            event: 'tool.result',
            tool: toolName,
            durationMs: Date.now() - invokedAt,
            outcome: 'error',
            errorCode: toAppError(error).code,
          });
          throw error;
        }
      },
    );

    const handleMcp = (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const principal = request.principal ?? anonymousPrincipal;
      const signal = requestSignal(reply);
      return handleMcpHttpRequest(
        {
          registry,
          invoker,
          transport: 'mcp-http',
          serverInfo: { name: config.service.name, version: config.service.version },
          instructions: deps.instructions,
          identity: () => ({ requestId: String(request.id), principal, signal }),
        },
        request,
        reply,
      );
    };

    protectedApp.get<{ Body: unknown }>('/mcp', handleMcp);
    protectedApp.post<{ Body: unknown }>('/mcp', handleMcp);
    protectedApp.delete<{ Body: unknown }>('/mcp', handleMcp);

    for (const register of deps.protectedRoutes ?? []) {
      await protectedApp.register(async (capabilityApp) => {
        await register(capabilityApp, routeContext);
      });
    }
  });

  return app;
};
