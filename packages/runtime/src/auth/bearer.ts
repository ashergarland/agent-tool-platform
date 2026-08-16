import type { AuthenticationRequest } from './types.js';

/**
 * Credential extraction.
 *
 * Both header shapes are accepted for the same reason every capability accepts both today: MCP
 * clients and OpenAPI/Actions clients disagree about which one is idiomatic, and requiring the
 * "right" one only produces confusing 401s.
 */

export const bearerCredential = (request: AuthenticationRequest): string | undefined => {
  const authorization = request.header('authorization');
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim() || undefined;
  }
  const apiKey = request.header('x-api-key');
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : undefined;
};

/** Only the `Authorization: Bearer` form; used where an API key would be meaningless. */
export const strictBearerToken = (request: AuthenticationRequest): string | undefined => {
  const authorization = request.header('authorization');
  if (typeof authorization !== 'string') return undefined;
  if (!authorization.toLowerCase().startsWith('bearer ')) return undefined;
  return authorization.slice(7).trim() || undefined;
};
