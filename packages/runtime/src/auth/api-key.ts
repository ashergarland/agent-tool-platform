import { unauthorized } from '../errors.js';
import { bearerCredential } from './bearer.js';
import { KeyedDigest, fingerprint } from './credentials.js';
import type { AuthenticationRequest, Authenticator, Principal } from './types.js';

/**
 * Static API-key authentication.
 *
 * Compares fixed-width HMAC digests of the presented secret rather than the raw bytes, so neither
 * the length nor the content of a configured key is observable through comparison timing. Only
 * digests and non-reversible fingerprints are retained. Every candidate is checked so the number
 * of configured keys does not change the work performed.
 */
export class ApiKeyAuthenticator implements Authenticator {
  private readonly digest = new KeyedDigest();
  private readonly keys: ReadonlyArray<{
    readonly value: Buffer;
    readonly principalId: string;
  }>;

  public constructor(apiKeys: readonly string[]) {
    this.keys = apiKeys.map((key) => ({
      value: this.digest.digest(key),
      // The principal identity is the fingerprint, so a rotated key produces a new bucket and a
      // shared key produces one stable bucket, without the raw secret ever appearing anywhere.
      principalId: `key:${fingerprint(key)}`,
    }));
  }

  public authenticate(request: AuthenticationRequest): Promise<Principal> {
    const presented = bearerCredential(request);
    // Rejections are returned rather than thrown, so a caller can always `await` this uniformly.
    if (!presented) {
      return Promise.reject(unauthorized('Missing bearer token or x-api-key header'));
    }
    let match: { readonly principalId: string } | undefined;
    for (const candidate of this.keys) {
      if (this.digest.matches(candidate.value, presented)) match = candidate;
    }
    if (!match) return Promise.reject(unauthorized('Invalid API key'));
    return Promise.resolve({ id: match.principalId, kind: 'api-key' });
  }
}

export class DisabledAuthenticator implements Authenticator {
  public authenticate(): Promise<Principal> {
    return Promise.resolve({ id: 'anonymous', kind: 'anonymous' });
  }
}
