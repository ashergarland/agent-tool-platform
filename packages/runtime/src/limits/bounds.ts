/**
 * Generic bounding utilities.
 *
 * Deployment ceilings themselves belong to capabilities — the platform has no opinion about
 * `maxDeclarations` or `maxJqFilterBytes`. What it does own is the shape of "a caller may lower a
 * ceiling but never raise it", and the mechanics of bounding text, collections, and warnings so a
 * result is always a complete prefix rather than a sliced payload.
 */

export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/**
 * Applies caller overrides to deployment ceilings. An override above the ceiling is refused and
 * recorded rather than silently honoured, so a caller can tell the difference between "you asked
 * for less" and "you asked for more than this deployment allows".
 */
export interface ResolvedCeilings<TName extends string> {
  readonly values: Readonly<Record<TName, number>>;
  readonly clamped: readonly TName[];
}

export const resolveCeilings = <TName extends string>(
  ceilings: Readonly<Record<TName, number>>,
  overrides: Partial<Record<TName, number | undefined>> = {},
): ResolvedCeilings<TName> => {
  const values = { ...ceilings } as Record<TName, number>;
  const clamped: TName[] = [];
  for (const name of Object.keys(ceilings) as TName[]) {
    const requested = overrides[name];
    if (requested === undefined || !Number.isFinite(requested)) continue;
    if (requested > ceilings[name]) {
      clamped.push(name);
      continue;
    }
    values[name] = Math.max(0, Math.floor(requested));
  }
  return { values, clamped: clamped.sort() };
};

export interface BoundedTextResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalLength: number;
}

/** Bounds text at a character budget, reporting whether anything was dropped. */
export const boundText = (text: string, maxChars: number): BoundedTextResult =>
  text.length <= maxChars
    ? { text, truncated: false, originalLength: text.length }
    : { text: text.slice(0, Math.max(0, maxChars)), truncated: true, originalLength: text.length };

export interface BoundedListResult<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
  readonly originalLength: number;
}

export const boundList = <T>(items: readonly T[], maxItems: number): BoundedListResult<T> =>
  items.length <= maxItems
    ? { items, truncated: false, originalLength: items.length }
    : {
        items: items.slice(0, Math.max(0, maxItems)),
        truncated: true,
        originalLength: items.length,
      };

/**
 * De-duplicated, bounded warning collector. Warnings are advisory text returned to an agent, so
 * they must never grow with the size of the input being processed.
 */
export class BoundedWarnings {
  private readonly entries = new Set<string>();
  private overflowed = false;

  public constructor(
    private readonly maxWarnings = 32,
    private readonly maxLength = 200,
  ) {}

  public add(warning: string): void {
    if (this.entries.size >= this.maxWarnings) {
      this.overflowed = true;
      return;
    }
    const trimmed = warning.trim();
    if (trimmed.length === 0) return;
    this.entries.add(
      trimmed.length <= this.maxLength ? trimmed : `${trimmed.slice(0, this.maxLength)}...`,
    );
  }

  public get truncated(): boolean {
    return this.overflowed;
  }

  public get size(): number {
    return this.entries.size;
  }

  public list(): readonly string[] {
    const warnings = [...this.entries];
    return this.overflowed ? [...warnings, 'Additional warnings were suppressed'] : warnings;
  }
}
