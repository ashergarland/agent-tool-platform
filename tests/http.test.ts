import { afterEach, describe, expect, it } from 'vitest';
import { bearer, createStartedFixture, type Fixture } from './helpers.js';

let fixtures: Fixture[] = [];

const fixture = async (options?: Parameters<typeof createStartedFixture>[0]): Promise<Fixture> => {
  const created = await createStartedFixture(options);
  fixtures.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(fixtures.map((entry) => entry.application.shutdown()));
  fixtures = [];
});

describe('public routes', () => {
  it('serves health, ready, version, and openapi without credentials', async () => {
    const { application } = await fixture();
    for (const path of ['/health', '/ready', '/version', '/openapi.json']) {
      const response = await application.http.inject({ method: 'GET', url: path });
      expect(response.statusCode, path).toBe(200);
    }
  });

  it('sets cache-control: no-store and echoes a request id everywhere', async () => {
    const { application } = await fixture();
    const response = await application.http.inject({ method: 'GET', url: '/version' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBeTypeOf('string');
  });

  it('reports the tool catalogue and auth mode on /version', async () => {
    const { application } = await fixture();
    const body = (await application.http.inject({ method: 'GET', url: '/version' })).json();
    expect(body.capabilities.authMode).toBe('api-key');
    expect(body.capabilities.toolCount).toBe(application.registry.size);
    expect(body.capabilities.tools).toContain('list_notes');
  });
});

describe('request identity', () => {
  it('honours a bounded caller-supplied request id', async () => {
    const { application } = await fixture();
    const response = await application.http.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'caller-supplied-id' },
    });
    expect(response.headers['x-request-id']).toBe('caller-supplied-id');
  });

  it('replaces an empty or oversized caller request id', async () => {
    const { application } = await fixture();
    for (const value of ['', 'x'.repeat(201)]) {
      const response = await application.http.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': value },
      });
      const id = response.headers['x-request-id'] as string;
      expect(id).not.toBe(value);
      expect(id.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('protected routes', () => {
  it('refuses unauthenticated access to every protected surface', async () => {
    const { application } = await fixture();
    const paths: [string, 'GET' | 'POST' | 'DELETE'][] = [
      ['/tools', 'GET'],
      ['/tools/list_notes', 'POST'],
      ['/mcp', 'POST'],
      ['/mcp', 'GET'],
      ['/mcp', 'DELETE'],
      ['/notes/stats', 'GET'],
    ];
    for (const [url, method] of paths) {
      const response = await application.http.inject(
        method === 'POST' ? { method, url, payload: {} } : { method, url },
      );
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('accepts a valid credential over both header forms', async () => {
    const { application, apiKey } = await fixture();
    for (const headers of [{ authorization: `Bearer ${apiKey}` }, { 'x-api-key': apiKey }]) {
      const response = await application.http.inject({ method: 'GET', url: '/tools', headers });
      expect(response.statusCode).toBe(200);
    }
  });

  it('invokes a read tool and returns the tool name and request id', async () => {
    const { application, apiKey } = await fixture();
    const response = await application.http.inject({
      method: 'POST',
      url: '/tools/list_notes',
      headers: bearer(apiKey),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tool: 'list_notes',
      result: { notes: [], total: 0, truncated: false },
    });
  });

  it('lets a capability extension route inherit authentication and the platform hooks', async () => {
    const { application, apiKey } = await fixture();
    const response = await application.http.inject({
      method: 'GET',
      url: '/notes/stats',
      headers: bearer(apiKey),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ count: 0, maxNotes: 50 });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBeTypeOf('string');
  });

  it('normalizes an unknown tool to a 404 error payload', async () => {
    const { application, apiKey } = await fixture();
    const response = await application.http.inject({
      method: 'POST',
      url: '/tools/not_a_tool',
      headers: bearer(apiKey),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'not_found', retryable: false },
    });
  });

  it('normalizes an unknown route to a 404 error payload', async () => {
    const { application } = await fixture();
    const response = await application.http.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('rate limiting', () => {
  it('charges failed authentication to the pre-auth abuse budget', async () => {
    const { application } = await fixture({
      env: { PRE_AUTH_RATE_LIMIT_MAX: '2', RATE_LIMIT_MAX: '1000' },
    });
    const attempt = () =>
      application.http.inject({
        method: 'GET',
        url: '/tools',
        headers: { authorization: 'Bearer invalid-credential' },
      });

    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    const throttled = await attempt();
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBeTypeOf('string');
  });

  it('does not let a caller-supplied X-Forwarded-For choose its own abuse bucket', async () => {
    // TRUST_PROXY=1 is what the shared Container App module configures: exactly one trusted hop.
    const { application } = await fixture({
      env: { PRE_AUTH_RATE_LIMIT_MAX: '2', RATE_LIMIT_MAX: '1000', TRUST_PROXY: '1' },
    });
    expect(application.config.http.trustProxy).toBe(1);

    // Container Apps ingress *appends* the real peer address to whatever the caller sent, so the
    // header a hostile caller produces looks like "<forged>, <real>". A caller rotating the forged
    // portion would, if the whole chain were trusted, land in a fresh bucket every request and
    // never exhaust the abuse budget.
    const ingressAddress = '198.51.100.7';
    const attempt = (forged: string) =>
      application.http.inject({
        method: 'GET',
        url: '/tools',
        headers: {
          authorization: 'Bearer invalid-credential',
          'x-forwarded-for': `${forged}, ${ingressAddress}`,
        },
      });

    expect((await attempt('10.1.1.1')).statusCode).toBe(401);
    expect((await attempt('10.2.2.2')).statusCode).toBe(401);

    // A third distinct forged address is still throttled, because all three were charged to the
    // one hop ingress actually vouched for.
    const throttled = await attempt('10.3.3.3');
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBeTypeOf('string');
  });

  it('charges the ingress-provided hop rather than the caller-prepended one', async () => {
    const { application } = await fixture({
      env: { PRE_AUTH_RATE_LIMIT_MAX: '1', RATE_LIMIT_MAX: '1000', TRUST_PROXY: '1' },
    });

    const attempt = (header: string) =>
      application.http.inject({
        method: 'GET',
        url: '/tools',
        headers: { authorization: 'Bearer invalid-credential', 'x-forwarded-for': header },
      });

    // Exhaust the budget for the address ingress reports.
    expect((await attempt('10.0.0.1, 198.51.100.7')).statusCode).toBe(401);
    expect((await attempt('10.0.0.2, 198.51.100.7')).statusCode).toBe(429);

    // A genuinely different ingress hop is a different bucket, which is what makes the budget
    // per-caller rather than global.
    expect((await attempt('10.0.0.3, 203.0.113.4')).statusCode).toBe(401);
  });

  it('treats TRUST_PROXY=1 as one hop rather than as a boolean', async () => {
    // '1' reads as truthy in most environment parsing, and trusting the whole chain here would
    // silently reintroduce the spoofing hole the hop count exists to close.
    const one = await fixture({ env: { TRUST_PROXY: '1' } });
    expect(one.application.config.http.trustProxy).toBe(1);

    const zero = await fixture({ env: { TRUST_PROXY: '0' } });
    expect(zero.application.config.http.trustProxy).toBe(false);

    const all = await fixture({ env: { TRUST_PROXY: 'true' } });
    expect(all.application.config.http.trustProxy).toBe(true);
  });

  it('does not let anonymous noise consume the principal budget', async () => {
    const { application, apiKey } = await fixture({
      env: { PRE_AUTH_RATE_LIMIT_MAX: '1', RATE_LIMIT_MAX: '5' },
    });
    for (let index = 0; index < 4; index += 1) {
      await application.http.inject({
        method: 'GET',
        url: '/tools',
        headers: { authorization: 'Bearer invalid-credential' },
      });
    }
    const valid = await application.http.inject({
      method: 'GET',
      url: '/tools',
      headers: bearer(apiKey),
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.headers['x-ratelimit-remaining']).toBe('4');
  });

  it('throttles an authenticated principal that exceeds its own budget', async () => {
    const { application, apiKey } = await fixture({ env: { RATE_LIMIT_MAX: '2' } });
    const call = () =>
      application.http.inject({ method: 'GET', url: '/tools', headers: bearer(apiKey) });

    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);
    const throttled = await call();
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toMatchObject({ error: { code: 'rate_limited', retryable: true } });
  });
});

describe('body limits', () => {
  it('refuses a body larger than the configured limit', async () => {
    const { application, apiKey } = await fixture({ env: { BODY_LIMIT_BYTES: '2048' } });
    const response = await application.http.inject({
      method: 'POST',
      url: '/tools/list_notes',
      headers: bearer(apiKey),
      payload: { prefix: 'a'.repeat(8192) },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).not.toBe(200);
  });
});

describe('error disclosure', () => {
  it('returns a generic message for server failures in production', async () => {
    const { application, apiKey } = await fixture({
      env: { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://tools.internal.test' },
    });
    const response = await application.http.inject({
      method: 'POST',
      url: '/tools/broken_output',
      headers: bearer(apiKey),
      payload: { secret: 'do-not-leak-me' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('do-not-leak-me');
    expect(response.json()).toMatchObject({
      error: { code: 'internal_error', message: 'The tool server failed to complete the request' },
    });
  });
});
