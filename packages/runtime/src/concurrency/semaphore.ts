import { serverBusy, timedOut } from '../errors.js';

/**
 * Bounded work admission.
 *
 * Seeded by the AST Summarizer semaphore, extended with cancellation-aware waiting so a caller
 * that disconnects while queued releases its slot instead of occupying the queue until it is
 * scheduled.
 *
 * The platform keeps both a semaphore and a queue primitive on purpose: a CPU-bound capability
 * wants small concurrency with fast rejection, while a subprocess capability wants explicit
 * admission control with a visible backlog. Forcing one scheduling model on both would push
 * capability policy into the platform.
 */

export interface SemaphoreStats {
  readonly active: number;
  readonly queued: number;
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly draining: boolean;
}

interface Waiter {
  readonly admit: () => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  detach?: () => void;
}

export interface AcquireOptions {
  readonly signal?: AbortSignal | undefined;
}

export class BoundedSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private draining = false;

  public constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be at least 1');
    if (maxQueued < 0) throw new Error('maxQueued must not be negative');
  }

  public get stats(): SemaphoreStats {
    return {
      active: this.active,
      queued: this.waiters.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
      draining: this.draining,
    };
  }

  /** True when at least one more job can be admitted immediately or queued. */
  public get accepting(): boolean {
    return (
      !this.draining && (this.active < this.maxConcurrent || this.waiters.length < this.maxQueued)
    );
  }

  public async run<T>(work: () => Promise<T>, options: AcquireOptions = {}): Promise<T> {
    await this.acquire(options);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  /** Rejects new work and waits for in-flight jobs so shutdown never truncates a response. */
  public async drain(): Promise<void> {
    this.draining = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter && !waiter.settled) {
        waiter.settled = true;
        waiter.detach?.();
        waiter.reject(serverBusy('The tool server is shutting down'));
      }
    }
    while (this.active > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  public acquire(options: AcquireOptions = {}): Promise<void> {
    if (this.draining) return Promise.reject(serverBusy('The tool server is shutting down'));
    if (options.signal?.aborted) {
      return Promise.reject(timedOut('The request was cancelled before it was admitted'));
    }
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        serverBusy('Capacity is saturated; retry after a short delay', {
          maxConcurrent: this.maxConcurrent,
          maxQueued: this.maxQueued,
        }),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        admit: () => {
          this.active += 1;
          resolve();
        },
        reject,
      };
      const signal = options.signal;
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

  public release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      waiter.detach?.();
      waiter.admit();
      return;
    }
  }
}
