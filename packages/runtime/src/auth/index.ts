export {
  anonymousPrincipal,
  authenticationRequestFromHeaders,
  type AuthenticationRequest,
  type Authenticator,
  type Principal,
  type PrincipalKind,
} from './types.js';
export { bearerCredential, strictBearerToken } from './bearer.js';
export {
  KeyedDigest,
  assessSecretStrength,
  fingerprint,
  minimumSecretBits,
  type SecretStrength,
} from './credentials.js';
export { ApiKeyAuthenticator, DisabledAuthenticator } from './api-key.js';
export { EntraJwtAuthenticator, entraIssuers, type EntraJwtOptions } from './entra-jwt.js';
export { createAuthenticator, type CreateAuthenticatorOptions } from './create-authenticator.js';
