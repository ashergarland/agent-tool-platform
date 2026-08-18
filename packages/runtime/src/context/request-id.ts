import { randomUUID } from 'node:crypto';

/**
 * Request identity.
 *
 * A caller-supplied `x-request-id` is honoured because it is what makes a trace stitch together
 * across an agent, a gateway, and this server. It is bounded because it is echoed into every log
 * line and every error payload, and an unbounded caller-controlled string in that position is an
 * amplification lever.
 */

export const maximumRequestIdLength = 200;

export const isAcceptableRequestId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximumRequestIdLength;

export const resolveRequestId = (candidate: unknown): string =>
  isAcceptableRequestId(candidate) ? candidate : randomUUID();
