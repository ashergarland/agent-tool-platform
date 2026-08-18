import { describe, expect, it } from 'vitest';
import {
  ApiKeyAuthenticator,
  DisabledAuthenticator,
  EntraJwtAuthenticator,
  assessSecretStrength,
  authenticationRequestFromHeaders,
  bearerCredential,
  createAuthenticator,
  entraIssuers,
  fingerprint,
  strictBearerToken,
} from '@agent-tool-platform/runtime';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { generateTestApiKey } from '@agent-tool-platform/testkit';

const tenantId = '00000000-0000-0000-0000-000000000001';
const audience = 'api://agent-tool-platform-test';

const buildEntraFixture = async (): Promise<{
  sign: (
    claims: Record<string, unknown>,
    options?: { issuer?: string; audience?: string; expiresIn?: string },
  ) => Promise<string>;
  keyResolver: ReturnType<typeof createLocalJWKSet>;
}> => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const keyResolver = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256', kid: 'test-key' }] });
  const sign = async (
    claims: Record<string, unknown>,
    options: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer(options.issuer ?? entraIssuers(tenantId)[0]!)
      .setAudience(options.audience ?? audience)
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(privateKey);
  return { sign, keyResolver };
};

describe('credential strength', () => {
  it('accepts a randomly generated token', () => {
    expect(assessSecretStrength(generateTestApiKey()).acceptable).toBe(true);
  });

  it('refuses short, repetitive, and low-entropy credentials', () => {
    expect(assessSecretStrength('short').reason).toBe('too_short');
    expect(assessSecretStrength('abcd'.repeat(12)).reason).toBe('repetitive');
    // 40 characters drawn from a two-symbol alphabet, without a short repeating period.
    const lowEntropy = `ab${'a'.repeat(38)}`;
    expect(assessSecretStrength(lowEntropy).acceptable).toBe(false);
  });

  it('produces a stable, non-reversible fingerprint', () => {
    const key = generateTestApiKey();
    expect(fingerprint(key)).toBe(fingerprint(key));
    expect(fingerprint(key)).toHaveLength(12);
    expect(fingerprint(key)).not.toContain(key.slice(0, 8));
  });
});

describe('bearer extraction', () => {
  it('accepts both the Authorization and x-api-key forms', () => {
    expect(
      bearerCredential(authenticationRequestFromHeaders({ authorization: 'Bearer abc' })),
    ).toBe('abc');
    expect(bearerCredential(authenticationRequestFromHeaders({ 'x-api-key': 'abc' }))).toBe('abc');
    expect(bearerCredential(authenticationRequestFromHeaders({}))).toBeUndefined();
  });

  it('restricts the strict form to Authorization', () => {
    expect(
      strictBearerToken(authenticationRequestFromHeaders({ 'x-api-key': 'abc' })),
    ).toBeUndefined();
    expect(strictBearerToken(authenticationRequestFromHeaders({ authorization: 'Bearer x' }))).toBe(
      'x',
    );
    expect(
      strictBearerToken(authenticationRequestFromHeaders({ authorization: 'Basic x' })),
    ).toBeUndefined();
  });
});

describe('ApiKeyAuthenticator', () => {
  it('accepts a configured key and derives a fingerprint principal', async () => {
    const key = generateTestApiKey();
    const principal = await new ApiKeyAuthenticator([key]).authenticate(
      authenticationRequestFromHeaders({ authorization: `Bearer ${key}` }),
    );
    expect(principal).toEqual({ id: `key:${fingerprint(key)}`, kind: 'api-key' });
    expect(principal.id).not.toContain(key);
  });

  it('rejects a missing or wrong credential', async () => {
    const authenticator = new ApiKeyAuthenticator([generateTestApiKey()]);
    await expect(
      authenticator.authenticate(authenticationRequestFromHeaders({})),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      authenticator.authenticate(
        authenticationRequestFromHeaders({ authorization: 'Bearer nope' }),
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('distinguishes several configured keys', async () => {
    const [first, second] = [generateTestApiKey(), generateTestApiKey()];
    const authenticator = new ApiKeyAuthenticator([first, second]);
    const a = await authenticator.authenticate(
      authenticationRequestFromHeaders({ 'x-api-key': first }),
    );
    const b = await authenticator.authenticate(
      authenticationRequestFromHeaders({ 'x-api-key': second }),
    );
    expect(a.id).not.toBe(b.id);
  });
});

describe('DisabledAuthenticator', () => {
  it('produces the anonymous principal', async () => {
    expect(await new DisabledAuthenticator().authenticate()).toEqual({
      id: 'anonymous',
      kind: 'anonymous',
    });
  });
});

describe('EntraJwtAuthenticator', () => {
  it('accepts a well-formed token from either issuer form', async () => {
    const { sign, keyResolver } = await buildEntraFixture();
    const authenticator = new EntraJwtAuthenticator({ tenantId, audience, keyResolver });

    for (const issuer of entraIssuers(tenantId)) {
      const token = await sign({ sub: 'user-1', appid: 'app-1' }, { issuer });
      const principal = await authenticator.authenticate(
        authenticationRequestFromHeaders({ authorization: `Bearer ${token}` }),
      );
      expect(principal).toEqual({ id: 'entra:user-1', kind: 'entra-jwt' });
    }
  });

  it('rejects a wrong audience, a wrong issuer, and an expired token with one opaque message', async () => {
    const { sign, keyResolver } = await buildEntraFixture();
    const authenticator = new EntraJwtAuthenticator({ tenantId, audience, keyResolver });

    const cases = [
      await sign({ sub: 'user-1' }, { audience: 'api://someone-else' }),
      await sign({ sub: 'user-1' }, { issuer: 'https://login.microsoftonline.com/other/v2.0' }),
      await sign({ sub: 'user-1' }, { expiresIn: '-10m' }),
    ];

    for (const token of cases) {
      await expect(
        authenticator.authenticate(
          authenticationRequestFromHeaders({ authorization: `Bearer ${token}` }),
        ),
      ).rejects.toMatchObject({ code: 'unauthorized', message: 'Invalid or expired access token' });
    }
  });

  it('honours the clock tolerance', async () => {
    const { sign, keyResolver } = await buildEntraFixture();
    const token = await sign({ sub: 'user-1' }, { expiresIn: '-10s' });

    await expect(
      new EntraJwtAuthenticator({
        tenantId,
        audience,
        keyResolver,
        clockToleranceSeconds: 0,
      }).authenticate(authenticationRequestFromHeaders({ authorization: `Bearer ${token}` })),
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const tolerant = await new EntraJwtAuthenticator({
      tenantId,
      audience,
      keyResolver,
      clockToleranceSeconds: 120,
    }).authenticate(authenticationRequestFromHeaders({ authorization: `Bearer ${token}` }));
    expect(tolerant.kind).toBe('entra-jwt');
  });

  it('enforces the calling-application allow-list', async () => {
    const { sign, keyResolver } = await buildEntraFixture();
    const authenticator = new EntraJwtAuthenticator({
      tenantId,
      audience,
      keyResolver,
      allowedAppIds: ['allowed-app'],
    });

    const denied = await sign({ sub: 'user-1', appid: 'other-app' });
    await expect(
      authenticator.authenticate(
        authenticationRequestFromHeaders({ authorization: `Bearer ${denied}` }),
      ),
    ).rejects.toMatchObject({ message: 'Calling application is not allow-listed' });

    const allowed = await sign({ sub: 'user-1', azp: 'allowed-app' });
    await expect(
      authenticator.authenticate(
        authenticationRequestFromHeaders({ authorization: `Bearer ${allowed}` }),
      ),
    ).resolves.toMatchObject({ id: 'entra:user-1' });
  });

  it('requires an Authorization bearer token', async () => {
    const { keyResolver } = await buildEntraFixture();
    await expect(
      new EntraJwtAuthenticator({ tenantId, audience, keyResolver }).authenticate(
        authenticationRequestFromHeaders({ 'x-api-key': 'not-a-jwt' }),
      ),
    ).rejects.toMatchObject({ message: 'Missing bearer token' });
  });
});

describe('createAuthenticator', () => {
  it('builds one authenticator per configured mode', async () => {
    const key = generateTestApiKey();
    expect(createAuthenticator({ mode: 'disabled' })).toBeInstanceOf(DisabledAuthenticator);
    expect(createAuthenticator({ mode: 'api-key', apiKeys: [key] })).toBeInstanceOf(
      ApiKeyAuthenticator,
    );

    const { keyResolver, sign } = await buildEntraFixture();
    const entra = createAuthenticator(
      {
        mode: 'entra-jwt',
        tenantId,
        audience,
        allowedAppIds: [],
        clockToleranceSeconds: 60,
        jwksUri: undefined,
      },
      { entraKeyResolver: keyResolver },
    );
    const token = await sign({ sub: 'user-2' });
    await expect(
      entra.authenticate(authenticationRequestFromHeaders({ authorization: `Bearer ${token}` })),
    ).resolves.toMatchObject({ kind: 'entra-jwt' });
  });
});
