import { randomBytes } from 'node:crypto';
import {
  anonymousPrincipal,
  buildPlatformConfig,
  parsePlatformEnv,
  type PlatformConfig,
  type Principal,
  type ToolInvocationContext,
  type ToolTransport,
} from '@agent-tool-platform/runtime';

/**
 * Shared fixtures.
 *
 * Every capability test needs the same few things: a credential strong enough for the platform to
 * accept, a valid platform configuration, and an invocation context. Providing them here stops
 * each repository from inventing a slightly different, slightly weaker version.
 */

/** A credential that satisfies the platform's minimum entropy rules. Generated, never literal. */
export const generateTestApiKey = (): string => randomBytes(32).toString('hex');

export interface TestConfigOverrides {
  readonly env?: NodeJS.ProcessEnv;
  readonly serviceName?: string;
  readonly serviceVersion?: string;
}

/**
 * A valid platform configuration built through the real parser, so a test can never accidentally
 * rely on a shape the environment loader would reject.
 */
export const createTestPlatformConfig = (overrides: TestConfigOverrides = {}): PlatformConfig =>
  buildPlatformConfig(
    parsePlatformEnv({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: generateTestApiKey(),
      ...overrides.env,
    }),
    {
      serviceName: overrides.serviceName ?? 'test-capability',
      serviceVersion: overrides.serviceVersion ?? '0.0.0-test',
    },
  );

export interface TestInvocationContextOptions {
  readonly requestId?: string;
  readonly principal?: Principal;
  readonly transport?: ToolTransport;
  readonly signal?: AbortSignal;
}

export const createTestInvocationContext = (
  options: TestInvocationContextOptions = {},
): ToolInvocationContext => ({
  requestId: options.requestId ?? 'test-request',
  principal: options.principal ?? anonymousPrincipal,
  transport: options.transport ?? 'http',
  signal: options.signal ?? new AbortController().signal,
});
