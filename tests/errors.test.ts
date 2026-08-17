import { describe, expect, it } from 'vitest';
import {
  AppError,
  badRequest,
  boundedMessage,
  conflict,
  defaultRetryableForErrorCode,
  errorCodes,
  genericInternalMessage,
  httpStatusForErrorCode,
  maximumDetailEntries,
  maximumMessageLength,
  redactServerError,
  toAppError,
} from '@agent-tool-platform/runtime';

describe('error model', () => {
  it('maps every code to a status and a retryability default', () => {
    for (const code of errorCodes) {
      expect(httpStatusForErrorCode(code)).toBeGreaterThanOrEqual(400);
      expect(typeof defaultRetryableForErrorCode(code)).toBe('boolean');
    }
  });

  it('adds conflict semantics with a 409', () => {
    const error = conflict('The resource changed since the preview');
    expect(error.statusCode).toBe(409);
    expect(error.retryable).toBe(false);
  });

  it('bounds caller-visible messages', () => {
    const long = 'x'.repeat(maximumMessageLength * 3);
    expect(boundedMessage(long).length).toBe(maximumMessageLength + 3);
    expect(new AppError('bad_request', long).message.length).toBe(maximumMessageLength + 3);
  });

  it('bounds caller-visible details by breadth and width', () => {
    const wide = Object.fromEntries(
      Array.from({ length: maximumDetailEntries * 2 }, (_, index) => [`k${index}`, index]),
    );
    const error = badRequest('too much', wide);
    expect(Object.keys(error.details as object)).toHaveLength(maximumDetailEntries);

    const deep = badRequest('long value', { note: 'y'.repeat(1000) });
    expect(((deep.details as { note: string }).note ?? '').length).toBeLessThanOrEqual(303);
  });

  it('bounds strings nested inside objects and arrays, not just at the top level', () => {
    const error = badRequest('nested', {
      outer: { inner: { note: 'z'.repeat(5000) } },
      list: ['w'.repeat(5000)],
    });
    const details = error.details as {
      outer: { inner: { note: string } };
      list: string[];
    };
    expect(details.outer.inner.note.length).toBeLessThanOrEqual(303);
    expect((details.list[0] ?? '').length).toBeLessThanOrEqual(303);
  });

  it('bounds nested array lengths', () => {
    const error = badRequest('wide arrays', {
      items: Array.from({ length: 500 }, (_, index) => index),
    });
    const items = (error.details as { items: unknown[] }).items;
    // Bounded entries plus the explicit truncation marker.
    expect(items.length).toBe(maximumDetailEntries + 1);
    expect(items[items.length - 1]).toBe('[truncated]');
  });

  it('bounds nesting depth rather than following an arbitrarily deep structure', () => {
    let deep: Record<string, unknown> = { leaf: 'value' };
    for (let index = 0; index < 50; index += 1) deep = { nested: deep };

    const payload = badRequest('deep', deep).toPayload('req');
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('[object]');
    // Depth alone could otherwise produce a payload far larger than any message bound allows.
    expect(serialized.length).toBeLessThan(2000);
  });

  it('replaces circular references instead of following them', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    cyclic['branch'] = { back: cyclic };

    const error = badRequest('cycles', cyclic);
    const details = error.details as Record<string, unknown>;
    expect(details['name']).toBe('root');
    expect(details['self']).toBe('[circular]');
    expect(() => JSON.stringify(error.toPayload('req'))).not.toThrow();
  });

  it('does not misreport a value repeated across sibling branches as circular', () => {
    const shared = { id: 'shared' };
    const error = badRequest('shared', { left: shared, right: shared });
    expect(error.details).toEqual({ left: { id: 'shared' }, right: { id: 'shared' } });
  });

  it('keeps a large detail payload bounded end to end', () => {
    // A hostile or careless capability handing back a big structure must not become a big error.
    const hostile = {
      rows: Array.from({ length: 1000 }, (_, index) => ({
        index,
        blob: 'q'.repeat(2000),
        nested: { deeper: { deepest: 'r'.repeat(2000) } },
      })),
    };
    const serialized = JSON.stringify(badRequest('huge', hostile).toPayload('req'));
    expect(serialized.length).toBeLessThan(20_000);
  });

  it('bounds a shape that is both wide and deep through the total node budget', () => {
    // Entry and depth limits alone do not bound this: 24 entries at each of 4 levels is ~330k
    // nodes, all of them within both ceilings. Only the total node budget stops it, so this is
    // the case that fails if the budget is removed.
    const branch = (depth: number): unknown =>
      depth === 0
        ? 'leaf'
        : Object.fromEntries(
            Array.from({ length: maximumDetailEntries }, (_, index) => [
              `k${index}`,
              branch(depth - 1),
            ]),
          );

    const serialized = JSON.stringify(badRequest('wide and deep', branch(4)).toPayload('req'));
    expect(serialized).toContain('[truncated]');
    expect(serialized.length).toBeLessThan(20_000);
  });

  it('degrades rather than throwing when a detail value fights back', () => {
    // `boundedDetails` runs inside the AppError constructor, so a throw here would replace a
    // precise 4xx with an opaque 500. Enumeration is not inert: getters and proxy traps run code.
    const throwingGetter = {
      get boom(): never {
        throw new Error('getter blew up');
      },
    };
    expect(() => badRequest('getter', { value: throwingGetter })).not.toThrow();
    expect(badRequest('getter', { value: throwingGetter }).details).toEqual({
      value: '[unserializable]',
    });

    const hostileProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap blew up');
        },
      },
    );
    expect(() => badRequest('proxy', { value: hostileProxy })).not.toThrow();

    // An invalid Date throws from `toISOString`, which is exactly the shape a capability produces
    // by passing a caller-supplied timestamp straight through.
    const invalidDate = badRequest('window', { from: new Date('not-a-date') });
    expect(invalidDate.code).toBe('bad_request');
    expect(invalidDate.details).toEqual({ from: '[invalid date]' });
  });

  it('preserves small structured details untouched', () => {
    const issues = {
      issues: [
        { path: 'path', message: 'required', code: 'invalid_type' },
        { path: 'limit', message: 'too big', code: 'too_big' },
      ],
      maxBytes: 1024,
      retryable: false,
    };
    expect(badRequest('invalid input', issues).details).toEqual(issues);
  });

  it('renders values JSON cannot carry rather than dropping them silently', () => {
    const error = badRequest('exotic', {
      when: new Date('2026-01-01T00:00:00.000Z'),
      huge: BigInt(42),
      fn: () => undefined,
    });
    expect(error.details).toEqual({
      when: '2026-01-01T00:00:00.000Z',
      huge: '42',
      fn: '[function]',
    });
  });

  it('never exposes a stack, cause, or arbitrary exception text through toPayload', () => {
    const original = new Error('/absolute/path/to/secret.env failed to open');
    const normalized = toAppError(original);
    const payload = normalized.toPayload('req-1');

    expect(normalized.code).toBe('internal_error');
    expect(payload.message).toBe(genericInternalMessage);
    expect(JSON.stringify(payload)).not.toContain('secret.env');
    expect(Object.keys(payload)).toEqual(['code', 'message', 'retryable', 'requestId']);
    expect(normalized.cause).toBe(original);
  });

  it('passes AppError instances through unchanged', () => {
    const original = badRequest('invalid');
    expect(toAppError(original)).toBe(original);
  });

  it('treats an AbortError as a retryable timeout', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const normalized = toAppError(abort);
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });

  it('redacts only server-side failures', () => {
    const server = new AppError('internal_error', 'connection string is postgres://user:pw@host');
    expect(redactServerError(server).message).toBe(genericInternalMessage);

    const client = badRequest('the path must be relative');
    expect(redactServerError(client).message).toBe('the path must be relative');
  });
});
