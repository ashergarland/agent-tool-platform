/**
 * Transport-neutral authentication contract.
 *
 * `Authenticator` deliberately does not depend on Fastify. The HTTP layer adapts a Fastify request
 * into {@link AuthenticationRequest}; a future transport (or a test) can construct one directly.
 */

export type PrincipalKind = 'anonymous' | 'api-key' | 'entra-jwt';

export interface Principal {
  /** Stable identifier used in logs, rate-limit buckets, and telemetry. Never the raw credential. */
  readonly id: string;
  readonly kind: PrincipalKind;
}

/** Minimal view of an inbound request that authentication actually needs. */
export interface AuthenticationRequest {
  /** Lower-cased header lookup. Returns `undefined` when the header is absent or empty. */
  header(name: string): string | undefined;
}

export interface Authenticator {
  authenticate(request: AuthenticationRequest): Promise<Principal>;
}

export const anonymousPrincipal: Principal = { id: 'anonymous', kind: 'anonymous' };

/** Builds an {@link AuthenticationRequest} from a plain header record. */
export const authenticationRequestFromHeaders = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
): AuthenticationRequest => {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.length > 0) normalized.set(key.toLowerCase(), first);
  }
  return { header: (name) => normalized.get(name.toLowerCase()) };
};
