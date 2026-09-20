import { createHash } from 'node:crypto';

export type CanonicalJsonPrimitive = boolean | null | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalize = (value: unknown): CanonicalJsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON does not support non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)] as const);
    return Object.fromEntries(entries);
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value} values`);
};

export const serializeCanonicalJson = (value: unknown): string =>
  `${JSON.stringify(canonicalize(value), undefined, 2)}\n`;

export const digestCanonicalJson = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(serializeCanonicalJson(value), 'utf8').digest('hex')}`;
