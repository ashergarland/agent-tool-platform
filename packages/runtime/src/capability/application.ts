import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Logger } from 'pino';
import type { CreateAuthenticatorOptions } from '../auth/create-authenticator.js';
import { loadCapabilityConfig } from '../config/capability.js';
import type { PlatformConfig } from '../config/platform.js';
import { createHttpServer, RequestTracker } from '../http/server.js';
import type { HttpServer } from '../http/types.js';
import {
  ApplicationLifecycle,
  ReadinessAggregator,
  readinessReady,
  type ReadinessReport,
  type ReadinessResult,
} from '../lifecycle/index.js';
import { createLogger } from '../logging/logger.js';
import { createStdioMcpServer } from '../mcp/stdio.js';
import { buildOpenApiDocument } from '../openapi/document.js';
import { noopTelemetrySink } from '../telemetry/sink.js';
import type { CapabilityTelemetryEstimator, TelemetrySink } from '../telemetry/types.js';
import { createToolRegistry, type ToolRegistry } from '../tools/registry.js';
import { ToolInvoker } from './invoker.js';
import type { AgentToolCapability, CapabilityRuntimeContext, CapabilityContext } from './types.js';

/**
 * Application assembly.
 *
 * The runtime owns every step here — configuration, logging, registry, authentication, HTTP, MCP,
 * OpenAPI, readiness, lifecycle — so a capability repository's entry point is a handful of lines
 * that hand over a capability definition.
 */

export interface AgentToolApplication<TConfig extends PlatformConfig, TServices> {
  readonly config: TConfig;
  readonly logger: Logger;
  readonly services: TServices;
  readonly registry: ToolRegistry<TServices>;
  readonly lifecycle: ApplicationLifecycle;
  readonly telemetry: TelemetrySink;
  readonly http: HttpServer;
  readonly invoker: ToolInvoker<TServices>;
  openApiDocument(): Record<string, unknown>;
  /** An in-process MCP server over stdio semantics; used by the stdio entry point and by tests. */
  createStdioServer(): Server;
  readiness(): Promise<ReadinessReport>;
  /** Runs capability `start` hooks and marks the application ready. */
  start(): Promise<void>;
  /** Drains, runs capability `stop` hooks, then closes the HTTP listener. */
  shutdown(): Promise<void>;
}

export interface CreateApplicationOptions<TConfig extends PlatformConfig> {
  /** Bypasses environment loading. Primarily for tests. */
  readonly config?: TConfig;
  readonly logger?: Logger;
  readonly env?: NodeJS.ProcessEnv;
  readonly telemetry?: TelemetrySink;
  readonly authenticatorOptions?: CreateAuthenticatorOptions;
  /** Readiness cache window; zero disables caching. */
  readonly readinessCacheMs?: number;
  /**
   * Overrides `http.shutdownGraceMs` as the budget for waiting on in-flight invocations. Primarily
   * for tests that do not want to wait ten seconds for a deliberately stuck handler.
   */
  readonly drainTimeoutMs?: number;
}

export const createAgentToolApplication = async <
  TServices,
  TConfig extends PlatformConfig = PlatformConfig,
>(
  capability: AgentToolCapability<TServices, TConfig>,
  options: CreateApplicationOptions<TConfig> = {},
): Promise<AgentToolApplication<TConfig, TServices>> => {
  const config =
    options.config ??
    loadCapabilityConfig<TConfig>({
      defaults: {
        serviceName: capability.manifest.name,
        serviceVersion: capability.manifest.version,
      },
      spec: capability.config,
      ...(options.env === undefined ? {} : { source: options.env }),
    });

  const logger = options.logger ?? createLogger(config);
  const lifecycle = new ApplicationLifecycle();
  // Opt-in by default. A capability that wants invocation telemetry in its logs passes
  // `loggingTelemetrySink(logger)` explicitly, rather than every deployment paying for a log line
  // per call because the platform decided for it.
  const telemetry = options.telemetry ?? noopTelemetrySink;

  const capabilityContext: CapabilityContext<TConfig> = { config, logger, lifecycle, telemetry };
  const services = await capability.createServices(capabilityContext);
  const runtimeContext: CapabilityRuntimeContext<TConfig, TServices> = {
    ...capabilityContext,
    services,
  };

  const registry = createToolRegistry(capability.tools);

  const estimator: CapabilityTelemetryEstimator | undefined = capability.telemetry
    ?.estimateInvocation
    ? { estimate: capability.telemetry.estimateInvocation }
    : undefined;

  const invoker = new ToolInvoker<TServices>({
    registry,
    services,
    lifecycle,
    telemetry,
    logger,
    capabilityName: capability.manifest.name,
    capabilityVersion: config.service.version,
    estimator,
    requestTimeoutMs: config.http.requestTimeoutMs,
  });

  // The registry itself is a readiness input: a capability that somehow registered no tools is
  // running, but it cannot do its job.
  const contributors = [
    (): ReadinessResult =>
      registry.size > 0
        ? readinessReady('registry', `${registry.size} tools`)
        : { name: 'registry', state: 'not_ready', detail: 'the tool registry is empty' },
    ...(capability.readiness ?? []).map((contributor) => () => contributor(runtimeContext)),
  ];
  const readinessAggregator = new ReadinessAggregator<unknown>({
    contributors,
    ...(options.readinessCacheMs === undefined ? {} : { cacheMs: options.readinessCacheMs }),
  });

  const requestTracker = new RequestTracker();

  const http = createHttpServer<TConfig, TServices>({
    config,
    logger,
    services,
    registry,
    invoker,
    lifecycle,
    readiness: readinessAggregator,
    readinessContext: undefined,
    manifest: capability.manifest,
    instructions: capability.instructions,
    protectedRoutes: capability.protectedRoutes,
    publicRoutes: capability.publicRoutes,
    authenticatorOptions: options.authenticatorOptions,
    requestTracker,
  });

  const drainTimeoutMs = options.drainTimeoutMs ?? config.http.shutdownGraceMs;
  let shutdownOnce: Promise<void> | undefined;

  /**
   * Ordered teardown:
   *
   *  1. begin draining, which stops admitting new work and aborts the application signal, so every
   *     in-flight invocation observes cancellation immediately;
   *  2. wait, within the configured grace period, for in-flight tool invocations *and* in-flight
   *     HTTP requests to unwind. Both are needed: capability extension routes never run through
   *     the invoker, and tool calls over stdio MCP never run through HTTP;
   *  3. only then run the capability `stop` hook, so no handler — tool or route — is torn out from
   *     under a call still using the domain resources it is about to destroy;
   *  4. close the listener last.
   *
   * Step 3 is the whole point. Running `stop()` first is what produces use-after-teardown failures
   * during shutdown.
   */
  const runShutdown = async (): Promise<void> => {
    lifecycle.beginDraining();
    readinessAggregator.invalidate();

    const deadline = Date.now() + drainTimeoutMs;
    const invocations = await invoker.waitForDrain(drainTimeoutMs);
    if (!invocations.drained) {
      logger.warn(
        { event: 'shutdown.drain.timeout', activeInvocations: invoker.activeCount, drainTimeoutMs },
        'in-flight invocations did not finish within the shutdown grace period',
      );
    }

    // Whatever remains of the same budget, so a capability route that never returns cannot hold
    // the process open either.
    const requests = await requestTracker.waitForDrain(Math.max(0, deadline - Date.now()));
    if (!requests.drained) {
      logger.warn(
        { event: 'shutdown.requests.timeout', activeRequests: requestTracker.activeCount },
        'in-flight HTTP requests did not finish within the shutdown grace period',
      );
    }

    try {
      await capability.lifecycle?.stop?.(runtimeContext);
    } finally {
      await http.close();
      lifecycle.markStopped();
    }
  };

  return {
    config,
    logger,
    services,
    registry,
    lifecycle,
    telemetry,
    http,
    invoker,
    openApiDocument: () =>
      buildOpenApiDocument(config, registry, {
        title: capability.manifest.title,
        description: capability.manifest.description,
        instructions: capability.instructions,
      }),
    createStdioServer: () =>
      createStdioMcpServer({
        registry,
        invoker,
        serverInfo: { name: config.service.name, version: config.service.version },
        instructions: capability.instructions,
      }),
    readiness: () => readinessAggregator.evaluate(undefined),
    async start(): Promise<void> {
      await capability.lifecycle?.start?.(runtimeContext);
      lifecycle.markReady();
    },
    async shutdown(): Promise<void> {
      // Memoised so concurrent callers, a repeated call, and a signal racing an explicit shutdown
      // all await one teardown rather than closing the listener or stopping the capability twice.
      shutdownOnce ??= runShutdown();
      await shutdownOnce;
    },
  };
};

export interface StartApplicationOptions<
  TConfig extends PlatformConfig,
> extends CreateApplicationOptions<TConfig> {
  /** Install SIGINT/SIGTERM handlers. Default: true. */
  readonly handleSignals?: boolean;
}

/**
 * Creates, starts, and binds the application. Signal handling is installed by default so a
 * capability entry point does not have to reimplement graceful shutdown.
 */
export const startAgentToolApplication = async <
  TServices,
  TConfig extends PlatformConfig = PlatformConfig,
>(
  capability: AgentToolCapability<TServices, TConfig>,
  options: StartApplicationOptions<TConfig> = {},
): Promise<AgentToolApplication<TConfig, TServices>> => {
  const application = await createAgentToolApplication(capability, options);
  await application.start();
  await application.http.listen({
    host: application.config.http.host,
    port: application.config.http.port,
  });

  if (options.handleSignals !== false) {
    const stop = (signal: NodeJS.Signals): void => {
      application.logger.info({ event: 'shutdown.signal', signal }, 'shutting down');
      // A hard backstop in case teardown itself hangs. `shutdown()` already bounds its own wait for
      // in-flight work, so reaching this timer means something below that is stuck; the extra
      // second keeps the two budgets from racing each other to the millisecond.
      const graceMs = Math.max(1, application.config.http.shutdownGraceMs) + 1000;
      const timer = setTimeout(() => {
        application.logger.error(
          { event: 'shutdown.timeout', graceMs },
          'shutdown did not complete within the grace period; exiting non-zero',
        );
        process.exit(1);
      }, graceMs);
      timer.unref?.();

      void application
        .shutdown()
        .then(() => {
          clearTimeout(timer);
          process.exit(0);
        })
        .catch((error: unknown) => {
          // A failed shutdown must not look like a clean one: an orchestrator restarting the
          // replica needs to know teardown did not complete.
          application.logger.error({ err: error, event: 'shutdown.failed' }, 'shutdown failed');
          clearTimeout(timer);
          process.exit(1);
        });
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }

  return application;
};

export { noopTelemetrySink };
