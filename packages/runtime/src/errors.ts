/**
 * The unified, transport-safe error model.
 *
 * Seeded by the AST Summarizer implementation (bounded caller-visible text, no stack/cause/path
 * leakage, central status and retryability tables) and extended with the Azure capability's
 * `conflict` semantics.
 *
 * Two properties matter more than anything else here:
 *
 * - Nothing an operator would consider private may reach a remote caller. Stacks, causes,
 *   absolute paths, and arbitrary exception text stay inside the process.
 * - Every transport (HTTP, MCP over stdio, MCP over Streamable HTTP) projects the same shape,
 *   so a capability never has to decide what an error looks like per transport.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'not_ready'
  | 'busy'
  | 'timeout'
  | 'upstream_error'
  | 'internal_error';

export const errorCodes: readonly ErrorCode[] = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'limit_exceeded',
  'rate_limited',
  'not_ready',
  'busy',
  'timeout',
  'upstream_error',
  'internal_error',
];

const statusByCode: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  limit_exceeded: 413,
  rate_limited: 429,
  not_ready: 503,
  busy: 503,
  timeout: 504,
  upstream_error: 502,
  internal_error: 500,
};

const retryableByCode: Readonly<Record<ErrorCode, boolean>> = {
  bad_request: false,
  unauthorized: false,
  forbidden: false,
  not_found: false,
  conflict: false,
  limit_exceeded: false,
  rate_limited: true,
  not_ready: true,
  busy: true,
  timeout: true,
  upstream_error: true,
  internal_error: false,
};

export const httpStatusForErrorCode = (code: ErrorCode): number => statusByCode[code];
export const defaultRetryableForErrorCode = (code: ErrorCode): boolean => retryableByCode[code];

export const maximumMessageLength = 300;
export const maximumDetailEntries = 24;
const maximumDetailStringLength = 300;

/** Bounds a caller-visible message so no transport emits unbounded text. */
export const boundedMessage = (message: string): string =>
  message.length <= maximumMessageLength ? message : `${message.slice(0, maximumMessageLength)}...`;

const boundedDetailValue = (value: unknown): unknown =>
  typeof value === 'string' && value.length > maximumDetailStringLength
    ? `${value.slice(0, maximumDetailStringLength)}...`
    : value;

/**
 * Bounds both the breadth and the width of caller-visible details. Details are structured hints,
 * not a place to smuggle an unbounded payload back to a caller.
 */
const boundedDetails = (details: unknown): unknown => {
  if (details === undefined || details === null) return undefined;
  if (Array.isArray(details)) return details.slice(0, maximumDetailEntries).map(boundedDetailValue);
  if (typeof details === 'object') {
    return Object.fromEntries(
      Object.entries(details as Record<string, unknown>)
        .slice(0, maximumDetailEntries)
        .map(([key, value]) => [key, boundedDetailValue(value)]),
    );
  }
  return boundedDetailValue(details);
};

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly details?: unknown;
}

export class AppError extends Error {
  public override readonly name = 'AppError';
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details: unknown;

  public constructor(
    public readonly code: ErrorCode,
    message: string,
    details?: unknown,
    retryable?: boolean,
    cause?: unknown,
  ) {
    super(boundedMessage(message), { cause });
    this.statusCode = statusByCode[code];
    this.retryable = retryable ?? retryableByCode[code];
    this.details = boundedDetails(details);
  }

  /** The transport-safe projection; it never carries a stack, cause, or absolute path. */
  public toPayload(requestId: string): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      requestId,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('bad_request', message, details);
export const unauthorized = (message: string, details?: unknown): AppError =>
  new AppError('unauthorized', message, details);
export const forbidden = (message: string, details?: unknown): AppError =>
  new AppError('forbidden', message, details);
export const notFound = (message: string, details?: unknown): AppError =>
  new AppError('not_found', message, details);
export const conflict = (message: string, details?: unknown): AppError =>
  new AppError('conflict', message, details);
export const limitExceeded = (message: string, details?: unknown): AppError =>
  new AppError('limit_exceeded', message, details);
export const rateLimited = (message: string, details?: unknown): AppError =>
  new AppError('rate_limited', message, details);
export const notReady = (message: string, details?: unknown): AppError =>
  new AppError('not_ready', message, details);
export const serverBusy = (message: string, details?: unknown): AppError =>
  new AppError('busy', message, details);
export const timedOut = (message: string, details?: unknown): AppError =>
  new AppError('timeout', message, details);
export const upstreamError = (message: string, details?: unknown): AppError =>
  new AppError('upstream_error', message, details);
export const internalError = (message: string, cause?: unknown): AppError =>
  new AppError('internal_error', message, undefined, false, cause);

/** The single message used for every unmapped internal failure. */
export const genericInternalMessage = 'The tool server failed to complete the request';

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name?: unknown }).name === 'AbortError';

/**
 * Normalizes any thrown value into an `AppError`.
 *
 * An unrecognized failure deliberately loses its message: an arbitrary exception string may embed
 * a filesystem path, a connection string, or provider detail. The original value is retained as
 * `cause` so server-side logs keep full fidelity.
 */
export const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  if (isAbortError(error)) {
    return new AppError(
      'timeout',
      'The request was cancelled before it completed',
      undefined,
      true,
    );
  }
  return new AppError('internal_error', genericInternalMessage, undefined, false, error);
};

/**
 * Replaces the caller-visible text of a server-side failure with the generic message. Used by the
 * HTTP layer in production so an unexpected 5xx never becomes an information disclosure.
 */
export const redactServerError = (error: AppError): AppError =>
  error.statusCode >= 500
    ? new AppError(error.code, genericInternalMessage, undefined, error.retryable)
    : error;
