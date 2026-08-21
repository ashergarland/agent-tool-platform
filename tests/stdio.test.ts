import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ConfigurationError,
  createAgentToolApplication,
  createSilentLogger,
  defineAgentToolCapability,
  defineTool,
  installShutdownSignalHandlers,
  loadCapabilityConfig,
  startAgentToolApplication,
  startStdioAgentToolApplication,
  type StdioApplication,
} from '@agent-tool-platform/runtime';
import minimalCapability, {
  minimalConfig,
  minimalInstructions,
  type MinimalConfig,
  type MinimalServices,
} from '@agent-tool-platform/example-minimal-capability';

/**
 * The stdio entry point the platform owns.
 *
 * These tests drive the *real* transport over a real pair of pipes rather than the in-memory
 * transport used by MCP conformance: the whole point of the helper is the wiring between a
 * process's standard streams, the MCP server, and the application lifecycle, and an in-memory
 * transport would prove none of it. Every line the server writes is captured, so "stdout carries
 * protocol traffic and nothing else" is an assertion rather than an aspiration.
 */

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

/** A minimal JSON-RPC client speaking the newline-delimited stdio framing over two pipes. */
class StdioProtocolClient {
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();
  private buffer = '';
  private nextId = 1;
  /** Every line the server wrote, exactly as it wrote it. */
  public readonly lines: string[] = [];

  public constructor(
    private readonly toServer: PassThrough,
    fromServer: PassThrough,
  ) {
    fromServer.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim().length > 0) this.deliver(line);
        newline = this.buffer.indexOf('\n');
      }
    });
  }

  private deliver(line: string): void {
    this.lines.push(line);
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Left in `lines` so the protocol-safety assertion can report it.
      return;
    }
    if (message.id === undefined) return;
    this.pending.get(message.id)?.(message);
    this.pending.delete(message.id);
  }

  public async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for a response to ${method}`));
      }, 10_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    if (response.error) throw new Error(`${method} failed: ${response.error.message}`);
    return response.result ?? {};
  }

  public notify(method: string, params: Record<string, unknown> = {}): void {
    this.toServer.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  public async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-test-client', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return result;
  }
}

interface Pipes {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly client: StdioProtocolClient;
}

const createPipes = (): Pipes => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return { stdin, stdout, client: new StdioProtocolClient(stdin, stdout) };
};

const signalListeners = (signal: NodeJS.Signals): ((...args: unknown[]) => void)[] =>
  process.listeners(signal) as ((...args: unknown[]) => void)[];

/** Removes handlers a test installed on the real process, leaving the runner's own untouched. */
const removeAddedSignalListeners = (
  signal: NodeJS.Signals,
  before: readonly ((...args: unknown[]) => void)[],
): void => {
  for (const listener of signalListeners(signal)) {
    if (!before.includes(listener)) process.removeListener(signal, listener);
  }
};

let started: { close: () => Promise<void> }[] = [];
const track = <T extends { close: () => Promise<void> }>(stdio: T): T => {
  started.push(stdio);
  return stdio;
};

afterEach(async () => {
  await Promise.all(started.map((entry) => entry.close().catch(() => undefined)));
  started = [];
});

const startMinimal = async (
  env: NodeJS.ProcessEnv,
  pipes: Pipes,
): Promise<StdioApplication<MinimalConfig, MinimalServices>> =>
  track(
    await startStdioAgentToolApplication<MinimalServices, MinimalConfig>(minimalCapability, {
      env,
      handleSignals: false,
      stdin: pipes.stdin,
      stdout: pipes.stdout,
    }),
  );

describe('startStdioAgentToolApplication', () => {
  it('starts the capability, publishes its instructions, and serves its registered tools', async () => {
    const pipes = createPipes();
    const { application } = await startMinimal({ NODE_ENV: 'test' }, pipes);

    expect(application.lifecycle.state).toBe('ready');
    // The capability start hook ran, and it ran through the one shared lifecycle.
    expect(application.services.notes.isStarted).toBe(true);

    const initialized = await pipes.client.initialize();
    expect(initialized.instructions).toBe(minimalInstructions);
    expect(initialized.serverInfo).toMatchObject({ name: 'minimal-capability' });

    const listed = (await pipes.client.request('tools/list')) as {
      tools: { name: string; description: string; inputSchema: unknown }[];
    };
    expect(listed.tools).toHaveLength(application.registry.size);

    const registered = application.registry.get('list_notes');
    const published = listed.tools.find((tool) => tool.name === 'list_notes');
    expect(published?.description).toBe(registered.description);
    expect(published?.inputSchema).toEqual(registered.inputJsonSchema);
  }, 30_000);

  it('invokes a tool over the transport and returns structured content', async () => {
    const pipes = createPipes();
    await startMinimal({ NODE_ENV: 'test' }, pipes);
    await pipes.client.initialize();

    const called = (await pipes.client.request('tools/call', {
      name: 'list_notes',
      arguments: {},
    })) as { structuredContent?: { total?: number }; isError?: boolean };

    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({ total: 0 });
  }, 30_000);

  it('writes nothing to the transport but protocol traffic', async () => {
    const pipes = createPipes();
    // Nothing the platform does may reach the real stdout either: an injected pipe would happily
    // hide a log line that a deployed capability would have written straight into the protocol.
    const realStdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const strayWrites: string[] = [];
    try {
      const stdio = await startMinimal({ NODE_ENV: 'test' }, pipes);

      // The default logger is silent because stdout carries the protocol; a single stray log line
      // would corrupt the stream for every client.
      expect(stdio.application.logger.level).toBe('silent');

      await pipes.client.initialize();
      await pipes.client.request('tools/list');
      // Shutdown logs a signal line on the HTTP path; on stdio it must reach no one.
      await stdio.close();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Read the calls before restoring: `mockRestore` also clears the recorded history, so an
      // assertion made afterwards would pass no matter what was written.
      for (const call of realStdout.mock.calls) strayWrites.push(String(call[0]));
    } finally {
      realStdout.mockRestore();
    }

    expect(strayWrites).toEqual([]);
    expect(pipes.client.lines.length).toBeGreaterThan(0);
    for (const line of pipes.client.lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(JSON.parse(line) as unknown).toMatchObject({ jsonrpc: '2.0' });
    }
  }, 30_000);

  it('binds no HTTP listener', async () => {
    const pipes = createPipes();
    const { application } = await startMinimal({ NODE_ENV: 'test', PORT: '8080' }, pipes);

    expect(application.http.server.listening).toBe(false);
    expect(application.http.server.address()).toBeNull();
    // Local execution semantics: even the configuration describes a loopback-only process.
    expect(application.config.http.host).toBe('127.0.0.1');
  }, 30_000);

  it('needs no API key configuration, unlike the hosted HTTP application', async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const pipes = createPipes();
    const { application } = await startMinimal(env, pipes);

    expect(application.config.auth.mode).toBe('disabled');

    // The same environment is still refused for an application that would bind a listener: stdio
    // does not relax authentication anywhere else.
    await expect(
      createAgentToolApplication<MinimalServices, MinimalConfig>(minimalCapability, {
        env,
        logger: createSilentLogger(),
      }),
    ).rejects.toThrow(/AUTH_MODE=api-key requires API_KEYS/u);
  }, 30_000);

  it('cannot be turned into an unauthenticated hosted service by a production environment', async () => {
    const hosted: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      AUTH_MODE: 'disabled',
      HOST: '0.0.0.0',
      PORT: '8080',
      PUBLIC_BASE_URL: 'https://example.invalid',
    };
    const pipes = createPipes();
    const { application } = await startMinimal(hosted, pipes);

    // Local stdio, not a production deployment: no listener, loopback host, development rules.
    expect(application.config.env).toBe('development');
    expect(application.config.isProduction).toBe(false);
    expect(application.config.http.host).toBe('127.0.0.1');
    expect(application.http.server.listening).toBe(false);

    // And the hosted rule itself is untouched: disabled authentication is still refused in
    // production for anything that actually serves HTTP.
    expect(() =>
      loadCapabilityConfig<MinimalConfig>({
        defaults: { serviceName: 'minimal-capability', serviceVersion: '0.1.0' },
        spec: minimalConfig,
        source: hosted,
      }),
    ).toThrow(ConfigurationError);
  }, 30_000);

  it('preserves capability-supplied environment values', async () => {
    const pipes = createPipes();
    const { application } = await startMinimal(
      {
        NODE_ENV: 'test',
        SERVICE_VERSION: '9.9.9',
        MINIMAL_GREETING: 'howdy',
        MINIMAL_MAX_NOTES: '3',
      },
      pipes,
    );

    expect(application.config.minimal.greeting).toBe('howdy');
    expect(application.config.minimal.maxNotes).toBe(3);
    expect(application.config.service.version).toBe('9.9.9');
  }, 30_000);

  it('honours a supplied logger and telemetry sink', async () => {
    const pipes = createPipes();
    const logger = createSilentLogger().child({ probe: 'stdio' });
    const stdio = track(
      await startStdioAgentToolApplication<MinimalServices, MinimalConfig>(minimalCapability, {
        env: { NODE_ENV: 'test' },
        handleSignals: false,
        logger,
        stdin: pipes.stdin,
        stdout: pipes.stdout,
      }),
    );

    expect(stdio.application.logger).toBe(logger);
  }, 30_000);

  it('falls back to the process environment and keeps NODE_ENV=test while testing', async () => {
    const pipes = createPipes();
    const stdio = track(
      await startStdioAgentToolApplication<MinimalServices, MinimalConfig>(minimalCapability, {
        handleSignals: false,
        stdin: pipes.stdin,
        stdout: pipes.stdout,
      }),
    );

    expect(stdio.application.config.env).toBe('test');
    expect(stdio.application.config.auth.mode).toBe('disabled');
  }, 30_000);
});

describe('stdio shutdown', () => {
  const probeCapability = (counts: { starts: number; stops: number }) =>
    defineAgentToolCapability<Record<string, never>>({
      manifest: {
        name: 'stdio-probe',
        version: '0.0.0-test',
        title: 'Stdio Probe',
        description: 'A test-only capability that counts lifecycle hook invocations.',
      },
      instructions: 'Routing: test-only capability. Use nothing here for real work.',
      tools: [
        defineTool({
          name: 'noop',
          title: 'No-op',
          summary: 'Does nothing.',
          description: 'Does nothing at all.',
          kind: 'read',
          routing: {
            useWhen: ['never'],
            doNotUseWhen: ['you want anything to happen'],
            changesState: false,
          },
          inputSchema: z.object({}),
          outputSchema: z.object({ ok: z.boolean() }),
          handler() {
            return Promise.resolve({ ok: true });
          },
        }),
      ],
      createServices(): Record<string, never> {
        return {};
      },
      lifecycle: {
        start() {
          counts.starts += 1;
        },
        stop() {
          counts.stops += 1;
        },
      },
    });

  it('runs the capability stop hook and closes the MCP server exactly once', async () => {
    const counts = { starts: 0, stops: 0 };
    const pipes = createPipes();
    const stdio = track(
      await startStdioAgentToolApplication<Record<string, never>>(probeCapability(counts), {
        env: { NODE_ENV: 'test' },
        handleSignals: false,
        stdin: pipes.stdin,
        stdout: pipes.stdout,
      }),
    );

    expect(counts.starts).toBe(1);
    await pipes.client.initialize();

    // Repeated and concurrent teardown must collapse into one: a second close may not run the
    // capability stop hook again, and may not tear the server down twice.
    await Promise.all([stdio.close(), stdio.close()]);
    await stdio.close();

    expect(counts.stops).toBe(1);
    expect(stdio.application.lifecycle.state).toBe('stopped');
    // The transport is closed, so a further request is never answered.
    await expect(
      Promise.race([
        pipes.client.request('tools/list'),
        new Promise((resolve) => setTimeout(() => resolve('no-response'), 150)),
      ]),
    ).resolves.toBe('no-response');
  }, 30_000);

  it('installs signal handlers by default and removes them once teardown has run', async () => {
    const beforeInt = signalListeners('SIGINT');
    const beforeTerm = signalListeners('SIGTERM');
    const pipes = createPipes();

    const stdio = track(
      await startStdioAgentToolApplication<Record<string, never>>(
        probeCapability({ starts: 0, stops: 0 }),
        { env: { NODE_ENV: 'test' }, stdin: pipes.stdin, stdout: pipes.stdout },
      ),
    );

    try {
      expect(signalListeners('SIGINT')).toHaveLength(beforeInt.length + 1);
      expect(signalListeners('SIGTERM')).toHaveLength(beforeTerm.length + 1);

      await stdio.close();

      expect(signalListeners('SIGINT')).toHaveLength(beforeInt.length);
      expect(signalListeners('SIGTERM')).toHaveLength(beforeTerm.length);
    } finally {
      removeAddedSignalListeners('SIGINT', beforeInt);
      removeAddedSignalListeners('SIGTERM', beforeTerm);
    }
  }, 30_000);

  it('tears down and exits zero when a real signal handler fires', async () => {
    const beforeInt = signalListeners('SIGINT');
    const beforeTerm = signalListeners('SIGTERM');
    const counts = { starts: 0, stops: 0 };
    const pipes = createPipes();

    const stdio = track(
      await startStdioAgentToolApplication<Record<string, never>>(probeCapability(counts), {
        env: { NODE_ENV: 'test' },
        stdin: pipes.stdin,
        stdout: pipes.stdout,
      }),
    );
    // `process.exit` is the one part of the signal path a test cannot let run for real.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const [handler] = signalListeners('SIGINT').filter(
        (listener) => !beforeInt.includes(listener),
      );
      expect(handler).toBeDefined();
      handler?.();

      const deadline = Date.now() + 5000;
      while (exit.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // A clean signal-driven shutdown exits zero, having run capability teardown exactly once.
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(counts.stops).toBe(1);
      expect(stdio.application.lifecycle.state).toBe('stopped');
      // The handler removed itself and its sibling, so a following SIGTERM starts nothing.
      expect(signalListeners('SIGINT')).toHaveLength(beforeInt.length);
      expect(signalListeners('SIGTERM')).toHaveLength(beforeTerm.length);
    } finally {
      exit.mockRestore();
      removeAddedSignalListeners('SIGINT', beforeInt);
      removeAddedSignalListeners('SIGTERM', beforeTerm);
    }
  }, 30_000);

  it('leaves no started capability behind when the transport cannot connect', async () => {
    const counts = { starts: 0, stops: 0 };
    const beforeInt = signalListeners('SIGINT');

    await expect(
      startStdioAgentToolApplication<Record<string, never>>(probeCapability(counts), {
        env: { NODE_ENV: 'test' },
        // Not a readable stream: the transport fails while starting, after the capability has run.
        stdin: {} as unknown as Readable,
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow();

    expect(counts.starts).toBe(1);
    expect(counts.stops).toBe(1);
    // A startup that never completed must not have left signal handlers attached either.
    expect(signalListeners('SIGINT')).toHaveLength(beforeInt.length);
  }, 30_000);

  it('installs no signal handlers when the caller declines them', async () => {
    const beforeInt = signalListeners('SIGINT');
    const beforeTerm = signalListeners('SIGTERM');
    const pipes = createPipes();

    const stdio = track(
      await startStdioAgentToolApplication<Record<string, never>>(
        probeCapability({ starts: 0, stops: 0 }),
        {
          env: { NODE_ENV: 'test' },
          handleSignals: false,
          stdin: pipes.stdin,
          stdout: pipes.stdout,
        },
      ),
    );

    expect(signalListeners('SIGINT')).toHaveLength(beforeInt.length);
    expect(signalListeners('SIGTERM')).toHaveLength(beforeTerm.length);
    expect(stdio.application.lifecycle.state).toBe('ready');
  }, 30_000);
});

describe('installShutdownSignalHandlers', () => {
  const emitterTarget = (): EventEmitter => new EventEmitter();

  it('tears down once and exits zero, however many signals arrive', async () => {
    const target = emitterTarget();
    const exits: number[] = [];
    let teardowns = 0;
    let releaseTeardown: (() => void) | undefined;

    installShutdownSignalHandlers({
      logger: createSilentLogger(),
      graceMs: 5000,
      target,
      exit: (code) => exits.push(code),
      shutdown: async () => {
        teardowns += 1;
        await new Promise<void>((resolve) => {
          releaseTeardown = resolve;
        });
      },
    });

    target.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Teardown is in flight. The other signal's handler must still be attached: releasing it here
    // would hand the next signal to Node's default disposition, which kills the process
    // mid-teardown. The fired signal's own handler is released by `once`, which is the deliberate
    // force-quit escape hatch a repeated Ctrl-C relies on.
    expect(target.listenerCount('SIGTERM')).toBe(1);
    expect(target.listenerCount('SIGINT')).toBe(0);

    target.emit('SIGTERM');
    expect(teardowns).toBe(1);
    expect(exits).toEqual([]);

    releaseTeardown?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(teardowns).toBe(1);
    expect(exits).toEqual([0]);
    expect(target.listenerCount('SIGTERM')).toBe(0);
  }, 30_000);

  it('exits non-zero when teardown fails', async () => {
    const target = emitterTarget();
    const exits: number[] = [];

    installShutdownSignalHandlers({
      logger: createSilentLogger(),
      graceMs: 1000,
      target,
      exit: (code) => exits.push(code),
      shutdown: () => Promise.reject(new Error('teardown exploded')),
    });

    target.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exits).toEqual([1]);
  });

  it('exits non-zero when teardown outlives the backstop', async () => {
    const target = emitterTarget();
    const exits: number[] = [];

    installShutdownSignalHandlers({
      logger: createSilentLogger(),
      graceMs: 0,
      target,
      exit: (code) => exits.push(code),
      shutdown: () => new Promise<void>(() => undefined),
    });

    target.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(exits).toEqual([1]);
  }, 30_000);

  it('stops responding to signals once uninstalled', async () => {
    const target = emitterTarget();
    const exits: number[] = [];
    let teardowns = 0;

    const uninstall = installShutdownSignalHandlers({
      logger: createSilentLogger(),
      graceMs: 1000,
      target,
      exit: (code) => exits.push(code),
      shutdown: async () => {
        teardowns += 1;
      },
    });

    uninstall();
    uninstall();
    target.emit('SIGINT');
    target.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(teardowns).toBe(0);
    expect(exits).toEqual([]);
    expect(target.listenerCount('SIGINT')).toBe(0);
    expect(target.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('HTTP startup after sharing the signal path', () => {
  it('still binds a listener and installs one handler per signal', async () => {
    const beforeInt = signalListeners('SIGINT');
    const beforeTerm = signalListeners('SIGTERM');

    const loaded = loadCapabilityConfig<MinimalConfig>({
      defaults: { serviceName: 'minimal-capability', serviceVersion: '0.1.0' },
      spec: minimalConfig,
      source: {
        NODE_ENV: 'test',
        AUTH_MODE: 'disabled',
        HOST: '127.0.0.1',
      },
    });
    const config: MinimalConfig = { ...loaded, http: { ...loaded.http, port: 0 } };

    const application = await startAgentToolApplication<MinimalServices, MinimalConfig>(
      minimalCapability,
      { config, logger: createSilentLogger(), readinessCacheMs: 0 },
    );

    try {
      expect(application.http.server.listening).toBe(true);
      expect(signalListeners('SIGINT')).toHaveLength(beforeInt.length + 1);
      expect(signalListeners('SIGTERM')).toHaveLength(beforeTerm.length + 1);

      const address = application.http.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await application.shutdown();
      removeAddedSignalListeners('SIGINT', beforeInt);
      removeAddedSignalListeners('SIGTERM', beforeTerm);
    }
  }, 30_000);
});
