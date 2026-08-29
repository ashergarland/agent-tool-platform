import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentToolApplication,
  createSilentLogger,
  defineAgentToolCapability,
  startAgentToolApplication,
  type AgentToolApplication,
  type CapabilityContext,
  type CapabilityLifecycle,
  type PlatformConfig,
  type PublicRouteRegistrar,
  type ScratchWorkspace,
} from '@agent-tool-platform/runtime';
import { createTestPlatformConfig } from '@agent-tool-platform/testkit';

interface ScratchServices {
  readonly workspace: ScratchWorkspace;
}

interface ScratchCapabilityOptions {
  readonly createServices?: (
    context: CapabilityContext<PlatformConfig>,
  ) => ScratchServices | Promise<ScratchServices>;
  readonly lifecycle?: CapabilityLifecycle<PlatformConfig, ScratchServices>;
  readonly publicRoutes?: readonly PublicRouteRegistrar<PlatformConfig, ScratchServices>[];
}

const scratchCapability = (options: ScratchCapabilityOptions = {}) =>
  defineAgentToolCapability<ScratchServices>({
    manifest: {
      name: 'scratch-test',
      version: '0.0.0-test',
      title: 'Scratch Test',
      description: 'Exercises lifecycle-owned scratch workspaces.',
    },
    instructions: 'Test fixture.',
    tools: [],
    createServices:
      options.createServices ??
      (async (context) => ({
        workspace: await context.createScratchWorkspace(),
      })),
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
    ...(options.publicRoutes === undefined ? {} : { publicRoutes: options.publicRoutes }),
  });

const applications: AgentToolApplication<PlatformConfig, ScratchServices>[] = [];

const createApplication = async (
  options: ScratchCapabilityOptions = {},
  drainTimeoutMs = 1000,
): Promise<AgentToolApplication<PlatformConfig, ScratchServices>> => {
  const application = await createAgentToolApplication(scratchCapability(options), {
    config: createTestPlatformConfig({ serviceName: 'scratch-test' }),
    logger: createSilentLogger(),
    drainTimeoutMs,
  });
  applications.push(application);
  return application;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const waitUntilRemoved = async (path: string): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (await exists(path)) {
    if (Date.now() >= deadline) throw new Error('Scratch workspace was not removed');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

afterEach(async () => {
  await Promise.all(
    applications.map((application) => application.shutdown().catch(() => undefined)),
  );
  applications.length = 0;
});

describe('lifecycle-owned scratch workspaces', () => {
  it('creates a private prefixed workspace for the capability lifetime and removes it on shutdown', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'atp-scratch-parent-'));
    try {
      const application = await createApplication({
        createServices: async (context) => ({
          workspace: await context.createScratchWorkspace({
            parentDirectory: parent,
            prefix: 'owned-',
          }),
        }),
      });
      const { workspace } = application.services;

      expect(dirname(workspace.path)).toBe(parent);
      expect(basename(workspace.path)).toMatch(/^owned-/u);
      const metadata = await stat(workspace.path);
      expect(metadata.isDirectory()).toBe(true);
      if (process.platform === 'win32') {
        // Node's POSIX mode bits do not describe Windows ACLs; existence is the portable contract.
        expect(metadata.mode).toBeTypeOf('number');
      } else {
        expect(metadata.mode & 0o777).toBe(0o700);
      }

      await application.start();
      expect(await exists(workspace.path)).toBe(true);
      await application.shutdown();
      expect(await exists(workspace.path)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('disposes idempotently and releases a manually removed path from lifecycle ownership', async () => {
    const application = await createApplication();
    await application.start();
    const { workspace } = application.services;

    await Promise.all([workspace.dispose(), workspace.dispose()]);
    await workspace.dispose();
    expect(await exists(workspace.path)).toBe(false);

    await mkdir(workspace.path);
    await writeFile(join(workspace.path, 'owner.txt'), 'external replacement', 'utf8');
    await application.shutdown();
    await expect(readFile(join(workspace.path, 'owner.txt'), 'utf8')).resolves.toBe(
      'external replacement',
    );
    await rm(workspace.path, { recursive: true, force: true });
  });

  it('cleans workspaces when service initialization fails', async () => {
    let workspacePath: string | undefined;
    const failure = new Error('service initialization failed');
    const capability = scratchCapability({
      createServices: async (context) => {
        const workspace = await context.createScratchWorkspace({ prefix: 'failed-services-' });
        workspacePath = workspace.path;
        throw failure;
      },
    });

    await expect(
      createAgentToolApplication(capability, {
        config: createTestPlatformConfig({ serviceName: 'scratch-failed-services' }),
        logger: createSilentLogger(),
      }),
    ).rejects.toBe(failure);
    if (workspacePath === undefined) throw new Error('Expected a scratch workspace path');
    expect(await exists(workspacePath)).toBe(false);
  });

  it('rolls back workspaces when the capability start hook fails', async () => {
    const failure = new Error('start hook failed');
    let stopCalls = 0;
    let startWorkspacePath: string | undefined;
    const application = await createApplication({
      lifecycle: {
        async start(context) {
          const workspace = await context.createScratchWorkspace({ prefix: 'failed-start-' });
          startWorkspacePath = workspace.path;
          throw failure;
        },
        stop() {
          stopCalls += 1;
        },
      },
    });
    const path = application.services.workspace.path;

    await expect(application.start()).rejects.toBe(failure);
    expect(application.lifecycle.state).toBe('stopped');
    expect(stopCalls).toBe(1);
    expect(await exists(path)).toBe(false);
    if (startWorkspacePath === undefined) throw new Error('Expected a start-hook workspace path');
    expect(await exists(startWorkspacePath)).toBe(false);
  });

  it('rolls back workspaces when listener startup fails', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP listener address');
    }

    let workspacePath: string | undefined;
    const capability = scratchCapability({
      createServices: async (context) => {
        const workspace = await context.createScratchWorkspace({ prefix: 'failed-listen-' });
        workspacePath = workspace.path;
        return { workspace };
      },
    });
    const baseConfig = createTestPlatformConfig({ serviceName: 'scratch-failed-listen' });

    try {
      await expect(
        startAgentToolApplication(capability, {
          config: {
            ...baseConfig,
            http: { ...baseConfig.http, host: '127.0.0.1', port: address.port },
          },
          logger: createSilentLogger(),
          handleSignals: false,
        }),
      ).rejects.toBeTruthy();
      if (workspacePath === undefined) throw new Error('Expected a scratch workspace path');
      expect(await exists(workspacePath)).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it('does not remove a workspace while admitted route work is still using it', async () => {
    let entered!: () => void;
    const routeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const routeRelease = new Promise<void>((resolve) => {
      release = resolve;
    });

    const application = await createApplication(
      {
        publicRoutes: [
          (router, { services }) => {
            router.get('/scratch/use', async () => {
              entered();
              await routeRelease;
              await writeFile(join(services.workspace.path, 'finished.txt'), 'done', 'utf8');
              return { used: true };
            });
          },
        ],
      },
      25,
    );
    await application.start();
    const path = application.services.workspace.path;

    const request = application.http.inject({ method: 'GET', url: '/scratch/use' });
    await routeEntered;
    await application.shutdown();
    expect(await exists(path)).toBe(true);

    release();
    const response = await request;
    expect(response.statusCode).toBe(200);
    await waitUntilRemoved(path);
  });

  it('keeps a workspace until a disconnected route handler has actually settled', async () => {
    let entered!: () => void;
    const routeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const routeRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled!: () => void;
    const routeSettled = new Promise<void>((resolve) => {
      settled = resolve;
    });
    let handlerError: unknown;

    const application = await createApplication(
      {
        publicRoutes: [
          (router, { services }) => {
            router.get('/scratch/disconnect', async () => {
              entered();
              await routeRelease;
              try {
                await writeFile(join(services.workspace.path, 'disconnected.txt'), 'done', 'utf8');
                return { used: true };
              } catch (error) {
                handlerError = error;
                throw error;
              } finally {
                settled();
              }
            });
          },
        ],
      },
      25,
    );
    await application.start();
    await application.http.listen({ host: '127.0.0.1', port: 0 });
    const address = application.http.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP listener address');
    }

    let client!: ClientRequest;
    const clientClosed = new Promise<void>((resolve, reject) => {
      client = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: '/scratch/disconnect',
        method: 'GET',
      });
      client.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') resolve();
        else reject(error);
      });
      client.on('close', resolve);
      client.end();
    });

    await routeEntered;
    client.destroy();
    await clientClosed;
    const shutdown = application.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(await exists(application.services.workspace.path)).toBe(true);

    release();
    await routeSettled;
    await shutdown;
    expect(handlerError).toBeUndefined();
    await waitUntilRemoved(application.services.workspace.path);
  });
});
