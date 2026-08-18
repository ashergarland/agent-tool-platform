/**
 * Readiness aggregation.
 *
 * `/health` answers "is the process running". `/ready` answers "can it do its job". The second
 * question is expensive to answer honestly — it may touch disk, a store, or a subprocess — and it
 * is exposed publicly so orchestrators can probe it. Both facts together mean the result must be
 * cached and concurrent probes must share one evaluation, or an unauthenticated flood amplifies
 * into real work. That behaviour is seeded by the Data Cruncher readiness endpoint.
 *
 * Readiness output is public, so it must never carry a secret, an absolute path, a resource
 * identifier, or a raw provider error. Details are bounded and contributor failures are collapsed
 * into a fixed string rather than propagated.
 */

export type ReadinessState = 'ready' | 'degraded' | 'not_ready';

export interface ReadinessResult {
  readonly name: string;
  readonly state: ReadinessState;
  readonly detail?: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly state: ReadinessState;
  readonly checkedAt: string;
  readonly checks: readonly ReadinessResult[];
}

export type ReadinessContributor<TContext> = (
  context: TContext,
) => Promise<ReadinessResult> | ReadinessResult;

const maximumDetailLength = 200;

const boundedDetail = (detail: string | undefined): string | undefined => {
  if (typeof detail !== 'string') return undefined;
  const trimmed = detail.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= maximumDetailLength
    ? trimmed
    : `${trimmed.slice(0, maximumDetailLength)}...`;
};

const normalize = (result: ReadinessResult): ReadinessResult => {
  const detail = boundedDetail(result.detail);
  return { name: result.name, state: result.state, ...(detail === undefined ? {} : { detail }) };
};

const worst = (states: readonly ReadinessState[]): ReadinessState => {
  if (states.includes('not_ready')) return 'not_ready';
  if (states.includes('degraded')) return 'degraded';
  return 'ready';
};

export interface ReadinessAggregatorOptions<TContext> {
  readonly contributors: readonly ReadinessContributor<TContext>[];
  /** How long a computed report is reused. Zero disables caching. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

export class ReadinessAggregator<TContext> {
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cache: { readonly at: number; readonly value: ReadinessReport } | undefined;
  private inFlight: Promise<ReadinessReport> | undefined;

  public constructor(private readonly options: ReadinessAggregatorOptions<TContext>) {
    this.cacheMs = options.cacheMs ?? 3000;
    this.now = options.now ?? Date.now;
  }

  public invalidate(): void {
    this.cache = undefined;
  }

  public evaluate(context: TContext): Promise<ReadinessReport> {
    const cached = this.cache;
    if (cached && this.now() - cached.at < this.cacheMs) return Promise.resolve(cached.value);
    // A single in-flight evaluation is shared by every concurrent probe, so N simultaneous
    // requests cost one check rather than N.
    this.inFlight ??= this.compute(context)
      .then((value) => {
        this.cache = { at: this.now(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async compute(context: TContext): Promise<ReadinessReport> {
    const checks = await Promise.all(
      this.options.contributors.map(async (contributor, index): Promise<ReadinessResult> => {
        try {
          return normalize(await contributor(context));
        } catch {
          // A contributor that throws is itself a readiness failure, but its exception text may
          // embed provider or filesystem detail, so it never reaches the response.
          return {
            name: `check_${index}`,
            state: 'not_ready',
            detail: 'the readiness check failed',
          };
        }
      }),
    );
    const state = worst(checks.map((check) => check.state));
    return {
      // `degraded` deliberately stays in rotation: removing a working replica over a warning is
      // its own outage.
      ready: state !== 'not_ready',
      state,
      checkedAt: new Date(this.now()).toISOString(),
      checks,
    };
  }
}

export const readinessReady = (name: string, detail?: string): ReadinessResult =>
  detail === undefined ? { name, state: 'ready' } : { name, state: 'ready', detail };
export const readinessDegraded = (name: string, detail?: string): ReadinessResult =>
  detail === undefined ? { name, state: 'degraded' } : { name, state: 'degraded', detail };
export const readinessNotReady = (name: string, detail?: string): ReadinessResult =>
  detail === undefined ? { name, state: 'not_ready' } : { name, state: 'not_ready', detail };
