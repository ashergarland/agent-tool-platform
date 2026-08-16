import { timedOut } from './errors.js';

/**
 * Cancellation plumbing.
 *
 * Seeded by the AST Summarizer `Deadline`, generalized so the platform can compose the three
 * independent reasons an invocation should stop:
 *
 * - the application is shutting down,
 * - the remote caller disconnected,
 * - a configured per-request deadline elapsed.
 *
 * `ToolInvocationContext.signal` is never optional: a capability that ignores cancellation is a
 * bug, but a capability that cannot observe it is an architecture defect.
 */

export interface Cancellation {
  /** Throws when the deadline has passed or an upstream signal aborted. */
  throwIfCancelled(): void;
  readonly cancelled: boolean;
  readonly signal: AbortSignal;
  readonly remainingMs: number;
}

const attach = (
  controller: AbortController,
  parent: AbortSignal,
  reasonFor: (parent: AbortSignal) => unknown,
): (() => void) => {
  const onAbort = (): void => controller.abort(reasonFor(parent));
  if (parent.aborted) {
    onAbort();
    return (): void => undefined;
  }
  parent.addEventListener('abort', onAbort, { once: true });
  return (): void => parent.removeEventListener('abort', onAbort);
};

/**
 * Combines any number of signals into one. The returned handle must be disposed so listeners are
 * removed from long-lived parents such as the application shutdown signal; otherwise a busy server
 * accumulates one listener per request.
 */
export const linkSignals = (
  ...signals: readonly (AbortSignal | undefined)[]
): { readonly signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const detaches: (() => void)[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    detaches.push(attach(controller, signal, (parent) => parent.reason));
    if (controller.signal.aborted) break;
  }
  return {
    signal: controller.signal,
    dispose: (): void => {
      for (const detach of detaches) detach();
    },
  };
};

export class Deadline implements Cancellation {
  private readonly controller = new AbortController();
  private readonly expiresAtMs: number;
  private readonly timer: NodeJS.Timeout | undefined;
  private readonly detaches: (() => void)[] = [];

  public constructor(
    timeoutMs: number | undefined,
    ...parents: readonly (AbortSignal | undefined)[]
  ) {
    this.expiresAtMs =
      timeoutMs === undefined || !Number.isFinite(timeoutMs)
        ? Number.POSITIVE_INFINITY
        : Date.now() + timeoutMs;
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
      this.timer = undefined;
    } else {
      this.timer = setTimeout(
        () => this.controller.abort(timedOut('The request deadline was exceeded')),
        Math.max(0, timeoutMs),
      );
      this.timer.unref?.();
    }
    for (const parent of parents) {
      if (!parent) continue;
      this.detaches.push(attach(this.controller, parent, (signal) => signal.reason));
    }
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get cancelled(): boolean {
    return this.controller.signal.aborted || Date.now() >= this.expiresAtMs;
  }

  public get remainingMs(): number {
    return Math.max(0, this.expiresAtMs - Date.now());
  }

  public throwIfCancelled(): void {
    if (!this.cancelled) return;
    const reason: unknown = this.controller.signal.reason;
    throw reason instanceof Error ? reason : timedOut('The request deadline was exceeded');
  }

  public dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const detach of this.detaches) detach();
    this.detaches.length = 0;
  }
}

/** A cancellation that never fires; used by tests and by callers without a deadline. */
export const neverCancelled: Cancellation = {
  throwIfCancelled: () => undefined,
  cancelled: false,
  signal: new AbortController().signal,
  remainingMs: Number.POSITIVE_INFINITY,
};

/** Resolves once the signal aborts. Useful for racing cooperative work against cancellation. */
export const whenAborted = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
