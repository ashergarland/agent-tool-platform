/**
 * Conformance harness.
 *
 * The testkit is deliberately runner-agnostic: it does not import vitest, jest, or node:test. Each
 * suite collects checks and throws a {@link ConformanceError} that names every failure, so it works
 * inside whichever `it(...)` a capability repository already uses.
 */

export interface ConformanceCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface ConformanceResult {
  readonly suite: string;
  readonly checks: readonly ConformanceCheck[];
  readonly failures: readonly ConformanceCheck[];
}

export class ConformanceError extends Error {
  public override readonly name = 'ConformanceError';

  public constructor(public readonly result: ConformanceResult) {
    super(
      `${result.suite} conformance failed:\n${result.failures
        .map((failure) => `  - ${failure.name}${failure.detail ? `: ${failure.detail}` : ''}`)
        .join('\n')}`,
    );
  }
}

export interface ConformanceOptions {
  /** Set false to inspect the result instead of throwing. Default: true. */
  readonly throwOnFailure?: boolean;
}

/** Deterministic serialization: property order must not decide whether two schemas match. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};

export class ConformanceRun {
  private readonly checks: ConformanceCheck[] = [];

  public constructor(private readonly suite: string) {}

  public check(name: string, passed: boolean, detail?: string): void {
    this.checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  }

  public equal(name: string, actual: unknown, expected: unknown): void {
    const passed = JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
    this.check(
      name,
      passed,
      passed
        ? undefined
        : `expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}`,
    );
  }

  /** Records a check that passes when `run` throws and the predicate accepts the thrown value. */
  public async throws(
    name: string,
    run: () => unknown,
    predicate: (error: unknown) => boolean = () => true,
  ): Promise<void> {
    try {
      await run();
      this.check(name, false, 'expected the operation to fail but it succeeded');
    } catch (error) {
      this.check(
        name,
        predicate(error),
        predicate(error)
          ? undefined
          : `thrown value did not match: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public finish(options: ConformanceOptions = {}): ConformanceResult {
    const failures = this.checks.filter((entry) => !entry.passed);
    const result: ConformanceResult = { suite: this.suite, checks: this.checks, failures };
    if (failures.length > 0 && options.throwOnFailure !== false) throw new ConformanceError(result);
    return result;
  }
}

export const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === code;
