import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';
import type { PlatformConfig } from '../config/platform.js';
import { installShutdownSignalHandlers } from '../lifecycle/signals.js';
import { createSilentLogger } from '../logging/logger.js';
import { connectStdio } from '../mcp/stdio.js';
import {
  createAgentToolApplication,
  type AgentToolApplication,
  type CreateApplicationOptions,
} from './application.js';
import type { AgentToolCapability } from './types.js';

/**
 * Local stdio startup.
 *
 * A capability launched over stdio needs the same steps every time: a silent logger, local
 * execution semantics, the application, the capability lifecycle, an MCP server, a transport,
 * signal handlers, an ordered teardown, and a truthful exit code. None of that is domain behaviour,
 * so none of it belongs in a capability repository — the capability decides only its own
 * environment defaults, such as which workspace root to use, and hands the rest over.
 *
 * This is an orchestration helper over {@link createAgentToolApplication}, not a second application
 * model: there is one `AgentToolApplication`, one `ApplicationLifecycle`, and one shutdown.
 */

export interface StartStdioApplicationOptions<
  TConfig extends PlatformConfig,
> extends CreateApplicationOptions<TConfig> {
  /** Install SIGINT/SIGTERM handlers. Default: true. */
  readonly handleSignals?: boolean;
  /**
   * The streams the MCP transport uses. Defaults to the process's own stdio; supplied by tests and
   * by an embedder that inherited a pipe pair rather than the standard descriptors.
   */
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

export interface StdioApplication<TConfig extends PlatformConfig, TServices> {
  readonly application: AgentToolApplication<TConfig, TServices>;
  readonly server: Server;
  readonly transport: StdioServerTransport;
  /**
   * Drains the application, runs the capability `stop` hook, then closes the MCP server. Runs once
   * however often, or however concurrently, it is called.
   */
  close(): Promise<void>;
}

/**
 * Local execution semantics for a stdio run.
 *
 * These are applied *after* the caller's environment, deliberately: stdio is a local pipe owned by
 * the process that launched it, and an inherited hosted-deployment environment must not decide how
 * it runs. In particular, ambient `NODE_ENV=production` would otherwise demand hosted credentials
 * for a transport that has no network peer to authenticate.
 *
 *  - `AUTH_MODE` is disabled because the stdio principal is fixed and anonymous. Authentication is
 *    an HTTP concern; requiring an API key to talk to a pipe protects nothing.
 *  - `NODE_ENV` is `development` unless the caller is testing, so production rules — which refuse
 *    disabled authentication — never apply to a local pipe. This is not a way to run a hosted
 *    service unauthenticated: no listener is ever bound.
 *  - `HOST` is loopback, so the configuration describes what this process actually is: local and
 *    non-networked.
 *
 * Everything else, including every capability-specific variable, is the caller's.
 */
const localStdioEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...source,
  NODE_ENV: source.NODE_ENV === 'test' ? 'test' : 'development',
  AUTH_MODE: 'disabled',
  HOST: '127.0.0.1',
});

/**
 * Starts a capability as a local stdio MCP server.
 *
 * The preferred entry point for a local capability:
 *
 * ```ts
 * await startStdioAgentToolApplication(capability, {
 *   env: { ...process.env, CAPABILITY_ROOT: process.env.CAPABILITY_ROOT?.trim() || process.cwd() },
 * });
 * ```
 *
 * No HTTP listener is bound, and nothing but protocol traffic reaches stdout: the default logger is
 * silent, because a stray log line corrupts the stream. A caller that wants diagnostics passes a
 * logger writing somewhere other than stdout.
 *
 * Supplying `config` bypasses environment loading altogether, as it does for every other entry
 * point, and with it the local execution semantics described above: that caller owns them.
 */
export const startStdioAgentToolApplication = async <
  TServices,
  TConfig extends PlatformConfig = PlatformConfig,
>(
  capability: AgentToolCapability<TServices, TConfig>,
  options: StartStdioApplicationOptions<TConfig> = {},
): Promise<StdioApplication<TConfig, TServices>> => {
  const { handleSignals, stdin, stdout, ...applicationOptions } = options;

  const application = await createAgentToolApplication<TServices, TConfig>(capability, {
    ...applicationOptions,
    logger: applicationOptions.logger ?? createSilentLogger(),
    env: localStdioEnvironment(applicationOptions.env ?? process.env),
  });

  await application.start();

  let server: Server | undefined;
  let transport: StdioServerTransport;
  try {
    server = application.createStdioServer();
    transport = await connectStdio(server, {
      ...(stdin === undefined ? {} : { stdin }),
      ...(stdout === undefined ? {} : { stdout }),
    });
  } catch (error) {
    // The capability is running by this point, so a transport that never connected must not leave
    // a started application behind. The MCP server is closed too, when there is one: `connect`
    // installs its handlers and adopts the transport *before* starting it, so a failure part-way
    // leaves a half-wired server that nothing else would ever tear down.
    //
    // A failure inside `start()` itself is deliberately left alone, exactly as the HTTP entry point
    // leaves it: a capability that could not start has not agreed to be stopped.
    await application.shutdown().catch(() => undefined);
    await server?.close().catch(() => undefined);
    throw error;
  }

  let uninstallSignals: (() => void) | undefined;
  let closeOnce: Promise<void> | undefined;

  /**
   * Teardown order mirrors the HTTP path, for the same reason: the application drains first, so
   * in-flight tool calls observe cancellation, finish, and get their replies delivered before the
   * capability `stop` hook destroys the resources they are using. Requests arriving during the
   * drain are refused with `not_ready` by the shared invoker, so keeping the transport open costs
   * nothing. The transport closes last, exactly as the HTTP listener does.
   *
   * Signal handlers are removed only once all of that has settled. Releasing them earlier would
   * return the next signal to Node's default disposition, which kills the process part-way through
   * its own teardown.
   */
  const close = async (): Promise<void> => {
    closeOnce ??= (async (): Promise<void> => {
      try {
        await application.shutdown();
      } finally {
        try {
          await server.close();
        } finally {
          uninstallSignals?.();
        }
      }
    })();
    await closeOnce;
  };

  if (handleSignals !== false) {
    uninstallSignals = installShutdownSignalHandlers({
      logger: application.logger,
      graceMs: application.config.http.shutdownGraceMs,
      shutdown: close,
    });
  }

  return { application, server, transport, close };
};
