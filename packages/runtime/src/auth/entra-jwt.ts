import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { unauthorized } from '../errors.js';
import { strictBearerToken } from './bearer.js';
import type { AuthenticationRequest, Authenticator, Principal } from './types.js';

/**
 * Microsoft Entra ID access-token validation, seeded by the Azure capability implementation.
 *
 * The key set is fetched remotely and cached by `jose`, both issuer forms Entra emits are accepted,
 * the audience must match exactly, and a small clock tolerance absorbs skew between the token
 * issuer and this process.
 *
 * The key resolver is injectable so tests can exercise the validation boundary — issuer, audience,
 * expiry, allow-list — without reaching the network or embedding a real tenant.
 */

export interface EntraJwtOptions {
  readonly tenantId: string;
  readonly audience: string;
  readonly allowedAppIds?: readonly string[];
  readonly clockToleranceSeconds?: number;
  /** Override the discovery endpoint; defaults to the public Entra JWKS for the tenant. */
  readonly jwksUri?: string | undefined;
  /** Test seam. When supplied, no remote key set is created. */
  readonly keyResolver?: JWTVerifyGetKey;
}

export const entraIssuers = (tenantId: string): readonly string[] => [
  `https://login.microsoftonline.com/${tenantId}/v2.0`,
  `https://sts.windows.net/${tenantId}/`,
];

const callingApplicationId = (payload: JWTPayload): string | undefined => {
  const appId = payload['appid'];
  if (typeof appId === 'string') return appId;
  const authorizedParty = payload['azp'];
  return typeof authorizedParty === 'string' ? authorizedParty : undefined;
};

export class EntraJwtAuthenticator implements Authenticator {
  private readonly keyResolver: JWTVerifyGetKey;
  private readonly issuers: readonly string[];
  private readonly allowedAppIds: readonly string[];
  private readonly clockToleranceSeconds: number;

  public constructor(private readonly options: EntraJwtOptions) {
    this.issuers = entraIssuers(options.tenantId);
    this.allowedAppIds = options.allowedAppIds ?? [];
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 60;
    this.keyResolver =
      options.keyResolver ??
      createRemoteJWKSet(
        new URL(
          options.jwksUri ??
            `https://login.microsoftonline.com/${options.tenantId}/discovery/v2.0/keys`,
        ),
      );
  }

  public async authenticate(request: AuthenticationRequest): Promise<Principal> {
    const token = strictBearerToken(request);
    if (!token) throw unauthorized('Missing bearer token');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keyResolver, {
        audience: this.options.audience,
        issuer: [...this.issuers],
        clockTolerance: this.clockToleranceSeconds,
      }));
    } catch {
      // The underlying reason is deliberately discarded: distinguishing "expired" from "wrong
      // audience" from "unknown key" is a useful oracle for an attacker and useless to a client.
      throw unauthorized('Invalid or expired access token');
    }

    const appId = callingApplicationId(payload);
    if (this.allowedAppIds.length > 0 && (!appId || !this.allowedAppIds.includes(appId))) {
      throw unauthorized('Calling application is not allow-listed');
    }

    const subject = payload.sub ?? appId ?? 'unknown';
    return { id: `entra:${subject}`, kind: 'entra-jwt' };
  }
}
