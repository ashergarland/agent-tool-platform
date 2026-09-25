import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import {
  createBuilderApplication,
  listenBuilderApplication,
  type BuilderApplication,
} from '../src/server/application.js';
import { BuilderServiceError } from '../src/server/errors.js';
import type { BuilderService } from '../src/server/service.js';
import { buildResultFixture, catalogFixture } from './fixtures.js';

const applications: BuilderApplication[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

const start = async (service?: BuilderService) => {
  const logger = { error: vi.fn<(message: string) => void>() };
  const application = await createBuilderApplication({
    mode: 'test',
    ...(service === undefined ? {} : { service }),
    logger,
  });
  applications.push(application);
  return {
    application,
    logger,
    ...(await listenBuilderApplication(application, 0)),
  };
};

const serviceFixture = (): BuilderService => ({
  listCapabilities: vi.fn(async () => catalogFixture),
  buildAgent: vi.fn(async () => buildResultFixture),
});

describe('Agent Builder loopback API', () => {
  it('exposes only bounded health, catalog, and build operations', async () => {
    const service = serviceFixture();
    const { origin } = await start(service);

    const health = await fetch(`${origin}/api/health`);
    const catalog = await fetch(`${origin}/api/capabilities`);
    const build = await fetch(`${origin}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition: {
          schemaVersion: 1,
          id: 'test-agent',
          name: 'Test Agent',
          version: '1.0.0',
          instructions: 'Test instructions.',
          capabilities: [{ id: 'ast-summarizer' }],
        },
      }),
    });

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok', service: 'agent-builder' });
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toEqual(catalogFixture);
    expect(build.status).toBe(200);
    await expect(build.json()).resolves.toEqual(buildResultFixture);

    for (const path of ['/api/files', '/api/command', '/api/proxy', '/api/packages']) {
      const response = await fetch(`${origin}${path}`, { method: 'POST' });
      expect(response.status, path).toBe(404);
    }
  });

  it('validates media type, exact request shape, body bounds, origin, and host', async () => {
    const { origin } = await start(serviceFixture());

    const mediaType = await fetch(`${origin}/api/build`, {
      method: 'POST',
      body: '{}',
    });
    expect(mediaType.status).toBe(415);
    await expect(mediaType.json()).resolves.toMatchObject({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });

    const shape = await fetch(`${origin}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: {}, command: 'whoami' }),
    });
    expect(shape.status).toBe(400);
    await expect(shape.json()).resolves.toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });

    const oversized = await fetch(`${origin}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { instructions: 'x'.repeat(33_000) } }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });

    const originRejected = await fetch(`${origin}/api/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.com',
      },
      body: JSON.stringify({ definition: {} }),
    });
    expect(originRejected.status).toBe(403);

    const hostRejected = await new Promise<number>((resolveStatus, reject) => {
      const outgoing = request(
        `${origin}/api/health`,
        { headers: { Host: 'example.com' } },
        (response) => {
          response.resume();
          resolveStatus(response.statusCode ?? 0);
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(hostRejected).toBe(403);
  });

  it('returns bounded structured errors and logs local diagnostics', async () => {
    const service: BuilderService = {
      listCapabilities: vi.fn(async () => {
        throw new BuilderServiceError(
          'REGISTRY_UNAVAILABLE',
          'Registry is unavailable.',
          ['fixture issue'],
          503,
        );
      }),
      buildAgent: vi.fn(async () => buildResultFixture),
    };
    const { logger, origin } = await start(service);

    const response = await fetch(`${origin}/api/capabilities`);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'REGISTRY_UNAVAILABLE',
        summary: 'Registry is unavailable.',
        issues: ['fixture issue'],
      },
    });
    expect(JSON.stringify(body)).not.toContain('stack');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('REGISTRY_UNAVAILABLE'));
  });
});
