import type { Logger } from 'pino';

/**
 * Signal-driven shutdown.
 *
 * Every startup helper terminates the same way: log the signal, run teardown under a bounded
 * backstop, and exit zero only if teardown actually completed. The transports differ only in what
 * teardown *is* — closing a listener, or closing an MCP server — so the sequence lives here once
 * rather than being reimplemented, and subtly diverging, per transport.
 */

/**
 * The part of `process` this module uses. Narrowing it is what lets a test drive the handlers
 * against an ordinary emitter instead of signalling the test runner itself.
 */
export interface ShutdownSignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface InstallShutdownSignalOptions {
  readonly logger: Logger;
  /** Teardown to run on the first signal. It must be safe to call more than once. */
  readonly shutdown: () => Promise<void>;
  /** The teardown budget teardown bounds itself by; the backstop allows a second beyond it. */
  readonly graceMs: number;
  /** Default: `SIGINT` and `SIGTERM`. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Test seam. Defaults to the current process. */
  readonly target?: ShutdownSignalTarget;
  /** Test seam. Defaults to `process.exit`, which a test runner cannot survive. */
  readonly exit?: (code: number) => void;
}

export const defaultShutdownSignals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * Installs handlers that shut the application down once and exit with a truthful code.
 *
 * A clean shutdown exits `0`; a failed or timed-out one exits non-zero, because an orchestrator
 * restarting the replica needs to tell the two apart. Only the first signal starts teardown: a
 * second one — `SIGTERM` following `SIGINT`, or an impatient operator — is ignored rather than
 * starting a parallel exit path while the first is still unwinding.
 *
 * The remaining handlers stay attached until teardown settles. Removing them earlier would hand
 * the next signal back to Node's default disposition, which kills the process mid-teardown: the
 * whole point of holding the signal is to keep the exit under the application's control.
 *
 * Each signal is taken with `once`, so *repeating the same signal* does fall through to Node's
 * default disposition and force-quits. That is deliberate, and it is what the HTTP entry point has
 * always done: a second Ctrl-C is how an operator says "stop waiting", and a graceful shutdown
 * nobody can abandon is its own kind of hang.
 *
 * Returns a function that removes the handlers, so a caller that shuts down for its own reasons
 * does not leave listeners attached to the process.
 */
export const installShutdownSignalHandlers = (
  options: InstallShutdownSignalOptions,
): (() => void) => {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const signals = options.signals ?? defaultShutdownSignals;

  const installed = new Map<NodeJS.Signals, () => void>();
  const uninstall = (): void => {
    for (const [signal, listener] of installed) target.removeListener(signal, listener);
    installed.clear();
  };

  let stopping = false;
  let exited = false;
  /** One exit per process. The backstop and a late teardown must not both report an outcome. */
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    uninstall();
    exit(code);
  };

  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;

    options.logger.info({ event: 'shutdown.signal', signal }, 'shutting down');
    // A hard backstop in case teardown itself hangs. Teardown already bounds its own wait for
    // in-flight work, so reaching this timer means something below that is stuck; the extra second
    // keeps the two budgets from racing each other to the millisecond.
    const graceMs = Math.max(1, options.graceMs) + 1000;
    const timer = setTimeout(() => {
      options.logger.error(
        { event: 'shutdown.timeout', graceMs },
        'shutdown did not complete within the grace period; exiting non-zero',
      );
      finish(1);
    }, graceMs);
    timer.unref?.();

    void options
      .shutdown()
      .then(() => {
        clearTimeout(timer);
        finish(0);
      })
      .catch((error: unknown) => {
        options.logger.error({ err: error, event: 'shutdown.failed' }, 'shutdown failed');
        clearTimeout(timer);
        finish(1);
      });
  };

  for (const signal of signals) {
    const listener = (): void => stop(signal);
    installed.set(signal, listener);
    target.once(signal, listener);
  }

  return uninstall;
};
