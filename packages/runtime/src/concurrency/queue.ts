import { serverBusy, timedOut } from '../errors.js';

/**
 * Bounded work queue, seeded by the Data Cruncher runtime.
 *
 * At most `concurrency` tasks run at once and at most `queueLimit` tasks wait. Saturation produces
 * a typed, retryable `busy` error instead of unbounded memory growth, and a caller that
 * disconnects while queued gives its place back immediately.
 */

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  detach?: () => void;
  settled: boolean;
}

export interface QueueStats {
  readonly active: number;
  readonly queued: number;
  readonly concurrency: number;
  readonly queueLimit: number;
  readonly closed: boolean;
}

export class BoundedQueue {
  private running = 0;
  private closed = false;
  private readonly waiters: Waiter[] = [];

  public constructor(
    private readonly concurrency: number,
    private readonly queueLimit: number,
    private readonly label = 'work',
  ) {
    if (concurrency < 1) throw new Error('concurrency must be at least 1');
    if (queueLimit < 0) throw new Error('queueLimit must not be negative');
  }

  public get active(): number {
    return this.running;
  }

  public get queued(): number {
    return this.waiters.length;
  }

  public get stats(): QueueStats {
    return {
      active: this.running,
      queued: this.waiters.length,
      concurrency: this.concurrency,
      queueLimit: this.queueLimit,
      closed: this.closed,
    };
  }

  /** Rejects everything waiting and refuses new admissions. In-flight tasks are left alone. */
  public close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      waiter.detach?.();
      waiter.reject(serverBusy(`The server is shutting down and cannot accept ${this.label}`));
    }
  }

  /** Waits for in-flight tasks to finish after {@link close}. */
  public async drain(): Promise<void> {
    this.close();
    while (this.running > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  public async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        serverBusy(`The server is shutting down and cannot accept ${this.label}`),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(timedOut('The request was cancelled before it started'));
    }
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.reject(
        serverBusy(`Too much ${this.label} in progress; retry after a short delay`, {
          active: this.running,
          queued: this.waiters.length,
        }),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false };
      if (signal) {
        const onAbort = (): void => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(timedOut('The request was cancelled while queued'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.detach = (): void => signal.removeEventListener('abort', onAbort);
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1);
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      waiter.detach?.();
      this.running += 1;
      waiter.resolve();
      return;
    }
  }
}
