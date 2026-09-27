import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import {
  createBuilderApplication,
  listenBuilderApplication,
  type BuilderApplication,
} from '../src/server/application.js';
import { BuilderServiceError } from '../src/server/errors.js';
import type { BuilderService } from '../src/server/service.js';
import { LOCAL_VSCODE_ENVIRONMENT_ID } from '../src/shared/contracts.js';
import { buildResultFixture, catalogFixture, prepareResultFixture } from './fixtures.js';

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
  prepareAgent: vi.fn(async () => prepareResultFixture()),
});

describe('Agent Builder loopback API', () => {
  it('exposes only bounded health, catalog, build, and prepare operations', async () => {
    const service = serviceFixture();
    const { origin } = await start(service);
    const definition = {
      schemaVersion: 1 as const,
      id: 'test-agent',
      name: 'Test Agent',
      version: '1.0.0',
      instructions: 'Test instructions.',
      capabilities: [{ id: 'ast-summarizer' }],
    };

    const health = await fetch(`${origin}/api/health`);
    const catalog = await fetch(`${origin}/api/capabilities`);
    const build = await fetch(`${origin}/api/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }),
    });
    const prepare = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition,
        expectedLockDigest: buildResultFixture.lockDigest,
        environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
      }),
    });

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok', service: 'agent-builder' });
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toEqual(catalogFixture);
    expect(build.status).toBe(200);
    await expect(build.json()).resolves.toEqual(buildResultFixture);
    expect(prepare.status).toBe(200);
    await expect(prepare.json()).resolves.toEqual(prepareResultFixture());
    expect(service.prepareAgent).toHaveBeenCalledWith({
      definition,
      expectedLockDigest: buildResultFixture.lockDigest,
      environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
    });

    for (const path of ['/api/files', '/api/command', '/api/proxy', '/api/packages']) {
      const response = await fetch(`${origin}${path}`, { method: 'POST' });
      expect(response.status, path).toBe(404);
    }
  });

  it('validates the exact bounded Prepare request without accepting paths or commands', async () => {
    const service = serviceFixture();
    const { origin } = await start(service);
    const valid = {
      definition: {
        schemaVersion: 1,
        id: 'test-agent',
        name: 'Test Agent',
        version: '1.0.0',
        instructions: 'Test instructions.',
        capabilities: [{ id: 'ast-summarizer' }],
      },
      expectedLockDigest: buildResultFixture.lockDigest,
      environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
    };

    const mediaType = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      body: JSON.stringify(valid),
    });
    expect(mediaType.status).toBe(415);

    const extraProperty = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...valid, command: 'npm install' }),
    });
    expect(extraProperty.status).toBe(400);

    const invalidDigest = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...valid, expectedLockDigest: 'latest' }),
    });
    expect(invalidDigest.status).toBe(400);

    const arbitraryEnvironment = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...valid, environmentId: 'C:\\Users\\someone' }),
    });
    expect(arbitraryEnvironment.status).toBe(400);

    const oversized = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...valid,
        definition: { ...valid.definition, instructions: 'x'.repeat(33_000) },
      }),
    });
    expect(oversized.status).toBe(413);

    const originRejected = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.com',
      },
      body: JSON.stringify(valid),
    });
    expect(originRejected.status).toBe(403);
    expect(service.prepareAgent).not.toHaveBeenCalled();
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
      prepareAgent: vi.fn(async () => prepareResultFixture()),
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

  it('preserves bounded preparation error codes without exposing local diagnostics', async () => {
    const privateDetail = 'C:\\Users\\private\\token.txt';
    const service = serviceFixture();
    vi.mocked(service.prepareAgent).mockRejectedValueOnce(
      new BuilderServiceError(
        'INVALID_PREPARATION_INPUT',
        'The preparation input is inconsistent.',
        ['Build again before preparing.'],
        400,
        { cause: new Error(privateDetail) },
      ),
    );
    const { logger, origin } = await start(service);

    const response = await fetch(`${origin}/api/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition: {},
        expectedLockDigest: buildResultFixture.lockDigest,
        environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'INVALID_PREPARATION_INPUT',
        summary: 'The preparation input is inconsistent.',
        issues: ['Build again before preparing.'],
      },
    });
    expect(JSON.stringify(body)).not.toContain(privateDetail);
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining(privateDetail));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('INVALID_PREPARATION_INPUT'));
  });
});
