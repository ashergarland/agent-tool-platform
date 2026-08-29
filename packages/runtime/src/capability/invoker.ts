import type { Logger } from 'pino';
import type { Principal } from '../auth/types.js';
import { Deadline } from '../cancellation.js';
import { notReady, toAppError } from '../errors.js';
import type { ApplicationLifecycle } from '../lifecycle/state.js';
import { estimateSafely } from '../telemetry/sink.js';
import type { CapabilityTelemetryEstimator, TelemetrySink } from '../telemetry/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolTransport } from '../tools/types.js';

/**
 * The single invocation path.
 *
 * HTTP, stdio MCP, and Streamable HTTP MCP all call through here, which is what makes lifecycle
 * awareness, cancellation composition, and baseline telemetry properties of the platform rather
 * than three similar blocks of code that drift.
 */

export interface ToolInvokerDeps<TServices> {
  readonly registry: ToolRegistry<TServices>;
  readonly services: TServices;
  readonly lifecycle: ApplicationLifecycle;
  readonly telemetry: TelemetrySink;
  readonly logger: Logger;
  readonly capabilityName: string;
  readonly capabilityVersion: string;
  readonly estimator?: CapabilityTelemetryEstimator | undefined;
  /** Zero or undefined disables the platform-level per-request deadline. */
  readonly requestTimeoutMs?: number | undefined;
}

export interface InvokeToolOptions {
  readonly toolName: string;
  readonly input: unknown;
  readonly requestId: string;
  readonly principal: Principal;
  readonly transport: ToolTransport;
  /** Transport-level cancellation, such as an HTTP client disconnect. */
  readonly signal?: AbortSignal | undefined;
}

export class ToolInvoker<TServices> {
  private active = 0;
  private drained: (() => void)[] = [];

  public constructor(private readonly deps: ToolInvokerDeps<TServices>) {}

  /** Number of invocations that have been admitted and have not yet settled. */
  public get activeCount(): number {
    return this.active;
  }

  /**
   * Resolves once every admitted invocation has settled, or once `timeoutMs` elapses.
   *
   * Resolving on timeout rather than rejecting is deliberate: shutdown must make progress even if
   * a capability handler ignores its cancellation signal. The caller learns what happened from the
   * returned flag and can log it, but a stuck handler cannot wedge the process open forever.
   */
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
      this.drained.push(() => finish(true));
    });
  }

  /** Resolves only after every admitted invocation has settled. */
  public async waitUntilDrained(): Promise<void> {
    if (this.active === 0) return;
    await new Promise<void>((resolve) => {
      this.drained.push(resolve);
    });
  }

  private releaseOne(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.active > 0) return;
    const waiters = this.drained;
    this.drained = [];
    for (const notify of waiters) notify();
  }

  public async invoke(options: InvokeToolOptions): Promise<unknown> {
    // Resolving the tool first means an unknown name is a 404 rather than a 503 while draining.
    const tool = this.deps.registry.get(options.toolName);

    if (!this.deps.lifecycle.accepting) {
      throw notReady('The tool server is shutting down and is not accepting new work');
    }

    const timeoutMs =
      this.deps.requestTimeoutMs && this.deps.requestTimeoutMs > 0
        ? this.deps.requestTimeoutMs
        : undefined;
    // Three independent reasons to stop, one signal handed to the capability.
    const deadline = new Deadline(timeoutMs, this.deps.lifecycle.signal, options.signal);
    const startedAt = Date.now();
    // Counted only after admission, so a rejected call never holds shutdown open.
    this.active += 1;

    try {
      const output = await tool.invoke(options.input, this.deps.services, {
        requestId: options.requestId,
        principal: options.principal,
        transport: options.transport,
        signal: deadline.signal,
      });
      this.record(options, 'ok', Date.now() - startedAt, undefined, options.input, output);
      return output;
    } catch (error) {
      const appError = toAppError(error);
      this.record(
        options,
        'error',
        Date.now() - startedAt,
        appError.code,
        options.input,
        undefined,
      );
      throw appError;
    } finally {
      deadline.dispose();
      this.releaseOne();
    }
  }

  private record(
    options: InvokeToolOptions,
    outcome: 'ok' | 'error',
    durationMs: number,
    errorCode: ReturnType<typeof toAppError>['code'] | undefined,
    input: unknown,
    output: unknown,
  ): void {
    const measurement =
      outcome === 'ok'
        ? estimateSafely(
            this.deps.estimator,
            { toolName: options.toolName, input, output, durationMs },
            (error) =>
              this.deps.logger.warn(
                { err: error, event: 'telemetry.estimate.failed', tool: options.toolName },
                'capability telemetry estimator threw',
              ),
          )
        : undefined;

    try {
      this.deps.telemetry.recordInvocation({
        capability: this.deps.capabilityName,
        capabilityVersion: this.deps.capabilityVersion,
        tool: options.toolName,
        transport: options.transport,
        outcome,
        ...(errorCode === undefined ? {} : { errorCode }),
        durationMs,
        ...(measurement === undefined ? {} : { measurement }),
      });
    } catch (error) {
      // Telemetry must never be able to fail a tool call.
      this.deps.logger.warn({ err: error, event: 'telemetry.sink.failed' }, 'telemetry sink threw');
    }
  }
}
