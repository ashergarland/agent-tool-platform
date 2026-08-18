import type { AuthConfig } from '../config/platform.js';
import { ApiKeyAuthenticator, DisabledAuthenticator } from './api-key.js';
import { EntraJwtAuthenticator } from './entra-jwt.js';
import type { Authenticator } from './types.js';

export interface CreateAuthenticatorOptions {
  /** Test seam forwarded to the Entra authenticator so JWKS retrieval can be stubbed. */
  readonly entraKeyResolver?: ConstructorParameters<typeof EntraJwtAuthenticator>[0]['keyResolver'];
}

/**
 * One factory for every supported mode. Capabilities never choose an authenticator: they choose an
 * auth *mode* through configuration, and the platform decides what that means.
 */
export const createAuthenticator = (
  auth: AuthConfig,
  options: CreateAuthenticatorOptions = {},
): Authenticator => {
  switch (auth.mode) {
    case 'disabled':
      return new DisabledAuthenticator();
    case 'api-key':
      return new ApiKeyAuthenticator(auth.apiKeys);
    case 'entra-jwt':
      return new EntraJwtAuthenticator({
        tenantId: auth.tenantId,
        audience: auth.audience,
        allowedAppIds: auth.allowedAppIds,
        clockToleranceSeconds: auth.clockToleranceSeconds,
        jwksUri: auth.jwksUri,
        ...(options.entraKeyResolver ? { keyResolver: options.entraKeyResolver } : {}),
      });
  }
};
