/**
 * In-process fixed-window rate limiting.
 *
 * Seeded by the AST Summarizer limiter and used by the Data Cruncher two-budget model.
 *
 * This state is per replica. It is a fair-use and abuse control, not a distributed quota: two
 * replicas each admit `max` requests per window. A cross-replica quota needs shared state and is
 * deliberately out of scope for v0.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAtMs: number;
}

interface Window {
  count: number;
  resetAtMs: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  private nextSweepAtMs = 0;

  public constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** A `max` of zero disables the budget entirely. */
  public consume(key: string, now = Date.now()): RateLimitDecision {
    if (this.max === 0) {
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetAtMs: now + this.windowMs };
    }
    if (now >= this.nextSweepAtMs) {
      for (const [windowKey, candidate] of this.windows) {
        if (candidate.resetAtMs <= now) this.windows.delete(windowKey);
      }
      this.nextSweepAtMs = now + this.windowMs;
    }
    let window = this.windows.get(key);
    if (!window || window.resetAtMs <= now) {
      window = { count: 0, resetAtMs: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= this.max,
      remaining: Math.max(0, this.max - window.count),
      resetAtMs: window.resetAtMs,
    };
  }
}
