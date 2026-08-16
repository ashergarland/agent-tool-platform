import pino, { type Logger, type LoggerOptions } from 'pino';
import type { PlatformConfig } from '../config/platform.js';

/**
 * One logging configuration for the whole portfolio.
 *
 * Redaction is centralized rather than left to each capability, because "did anyone remember to
 * redact the API key header in this repository?" is exactly the question a shared platform exists
 * to stop people asking.
 */

export const defaultRedactionPaths: readonly string[] = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers["x-api-key"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers.cookie',
  'apiKey',
  'apiKeys',
  'password',
  'secret',
  'token',
  'accessToken',
  'authorization',
];

export interface CreateLoggerOptions {
  /** Extra paths a capability wants censored, added to the shared list rather than replacing it. */
  readonly additionalRedactionPaths?: readonly string[];
  readonly destination?: pino.DestinationStream;
  readonly base?: Record<string, unknown>;
}

export const buildLoggerOptions = (
  config: PlatformConfig,
  options: CreateLoggerOptions = {},
): LoggerOptions => ({
  level: config.logging.level,
  base: {
    service: config.service.name,
    version: config.service.version,
    environment: config.env,
    ...options.base,
  },
  redact: {
    paths: [...defaultRedactionPaths, ...(options.additionalRedactionPaths ?? [])],
    censor: '[REDACTED]',
  },
});

export const createLogger = (config: PlatformConfig, options: CreateLoggerOptions = {}): Logger =>
  options.destination
    ? pino(buildLoggerOptions(config, options), options.destination)
    : pino(buildLoggerOptions(config, options));

/**
 * A logger that writes nothing. Used by the stdio MCP entry point, where stdout carries protocol
 * traffic and any stray write corrupts the stream.
 */
export const createSilentLogger = (): Logger => pino({ level: 'silent' });
