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
