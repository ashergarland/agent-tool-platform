import {
  ApiKeyAuthenticator,
  ConfigurationError,
  DisabledAuthenticator,
  assessSecretStrength,
  authenticationRequestFromHeaders,
  createAuthenticator,
  fingerprint,
  parsePlatformEnv,
  buildPlatformConfig,
  type AuthConfig,
} from '@agent-tool-platform/runtime';
import {
  ConformanceRun,
  hasErrorCode,
  type ConformanceOptions,
  type ConformanceResult,
} from './harness.js';
import { generateTestApiKey } from './fixtures.js';

/**
 * Authentication conformance.
 *
 * These are platform invariants, not capability behaviour: a weak credential must be refused at
 * configuration time, a valid one must produce a stable non-reversible principal, and an
 * unauthenticated deployment must be impossible in production.
 */

export interface AuthConformanceOptions extends ConformanceOptions {
  /** Additional auth configurations a capability wants exercised through the shared contract. */
  readonly extraModes?: readonly AuthConfig[];
}

export const runAuthConformance = async (
  options: AuthConformanceOptions = {},
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('auth');
  const key = generateTestApiKey();

  run.check('a generated 32-byte token is accepted', assessSecretStrength(key).acceptable);
  run.check(
    'a short credential is refused',
    assessSecretStrength('short-key').acceptable === false,
  );
  run.check(
    'a repetitive credential is refused',
    assessSecretStrength('abcabcabcabcabcabcabcabcabcabcabcabc').acceptable === false,
  );

  const authenticator = new ApiKeyAuthenticator([key]);
  const principal = await authenticator.authenticate(
    authenticationRequestFromHeaders({ authorization: `Bearer ${key}` }),
  );
  run.equal('a valid key produces an api-key principal', principal.kind, 'api-key');
  run.equal(
    'the principal id is the safe fingerprint, never the credential',
    principal.id,
    `key:${fingerprint(key)}`,
  );
  run.check('the principal id does not contain the credential', !principal.id.includes(key));

  const viaHeader = await authenticator.authenticate(
    authenticationRequestFromHeaders({ 'x-api-key': key }),
  );
  run.equal('the x-api-key header is accepted too', viaHeader.id, principal.id);

  await run.throws(
    'a missing credential is unauthorized',
    () => authenticator.authenticate(authenticationRequestFromHeaders({})),
    (error) => hasErrorCode(error, 'unauthorized'),
  );
  await run.throws(
    'an invalid credential is unauthorized',
    () =>
      authenticator.authenticate(
        authenticationRequestFromHeaders({ authorization: 'Bearer wrong-key' }),
      ),
    (error) => hasErrorCode(error, 'unauthorized'),
  );

  const disabled = await new DisabledAuthenticator().authenticate();
  run.equal('disabled auth yields an anonymous principal', disabled.kind, 'anonymous');

  const defaults = { serviceName: 'conformance', serviceVersion: '0.0.0-test' };
  run.check(
    'disabled auth is permitted outside production',
    buildPlatformConfig(
      parsePlatformEnv({ NODE_ENV: 'development', AUTH_MODE: 'disabled' }),
      defaults,
    ).auth.mode === 'disabled',
  );
  await run.throws(
    'disabled auth is refused in production',
    () =>
      buildPlatformConfig(
        parsePlatformEnv({ NODE_ENV: 'production', AUTH_MODE: 'disabled' }),
        defaults,
      ),
    (error) => error instanceof ConfigurationError,
  );
  await run.throws(
    'a weak API key is refused at configuration time',
    () =>
      buildPlatformConfig(
        parsePlatformEnv({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'weak' }),
        defaults,
      ),
    (error) => error instanceof ConfigurationError,
  );

  for (const mode of options.extraModes ?? []) {
    run.check(
      `createAuthenticator supports mode ${mode.mode}`,
      typeof createAuthenticator(mode).authenticate === 'function',
    );
  }

  return run.finish(options);
};
