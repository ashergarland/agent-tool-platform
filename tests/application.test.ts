import { afterEach, describe, expect, it } from 'vitest';
import {
  createSilentLogger,
  loadCapabilityConfig,
  startAgentToolApplication,
  type AgentToolApplication,
} from '@agent-tool-platform/runtime';
import { generateTestApiKey } from '@agent-tool-platform/testkit';
import minimalCapability, {
  NoteStore,
  minimalConfig,
  type MinimalConfig,
  type MinimalServices,
} from '@agent-tool-platform/example-minimal-capability';
import { bearer, createStartedFixture, type Fixture } from './helpers.js';

let started: AgentToolApplication<MinimalConfig, MinimalServices>[] = [];
let fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(started.map((application) => application.shutdown().catch(() => undefined)));
  await Promise.all(fixtures.map((entry) => entry.application.shutdown().catch(() => undefined)));
  started = [];
  fixtures = [];
});

describe('startAgentToolApplication', () => {
  it('binds a listener, serves the capability, and shuts down cleanly', async () => {
    const apiKey = generateTestApiKey();
    const loaded = loadCapabilityConfig<MinimalConfig>({
      defaults: { serviceName: 'minimal-capability', serviceVersion: '0.1.0' },
      spec: minimalConfig,
      source: { NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: apiKey, HOST: '127.0.0.1' },
    });
    // Port 0 asks the OS for a free port. The environment schema deliberately refuses it, because
    // a hosted deployment that binds an arbitrary port is a misconfiguration, so the test supplies
    // a configuration object rather than weakening the schema.
    const config: MinimalConfig = { ...loaded, http: { ...loaded.http, port: 0 } };

    const application = await startAgentToolApplication<MinimalServices, MinimalConfig>(
      minimalCapability,
      {
        config,
        logger: createSilentLogger(),
        handleSignals: false,
        readinessCacheMs: 0,
      },
    );
    started.push(application);

    expect(application.lifecycle.state).toBe('ready');
    const address = application.http.server.address();
    expect(address).not.toBeNull();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', state: 'ready' });

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/tools`);
    expect(unauthenticated.status).toBe(401);

    const catalogue = await fetch(`http://127.0.0.1:${port}/tools`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(catalogue.status).toBe(200);

    await application.shutdown();
    expect(application.lifecycle.state).toBe('stopped');
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toBeTruthy();
  }, 30_000);
});

describe('fixture services', () => {
  it('bounds the store and refuses an unknown note', () => {
    const store = new NoteStore(2);
    store.put({ id: 'a', text: 'first' });
    store.put({ id: 'b', text: 'second' });
    store.put({ id: 'a', text: 'replacement' });
    expect(store.size).toBe(2);
    expect(store.get('a').text).toBe('replacement');
    expect(() => store.put({ id: 'c', text: 'third' })).toThrow(/at most 2 notes/u);
    expect(() => store.get('missing')).toThrow(/Unknown note/u);
  });

  it('filters and counts by prefix and clears on stop', () => {
    const store = new NoteStore(10);
    store.start();
    store.put({ id: 'alpha-1', text: 'a' });
    store.put({ id: 'alpha-2', text: 'bb' });
    store.put({ id: 'beta-1', text: 'ccc' });

    expect(store.count('alpha')).toBe(2);
    expect(store.count(undefined)).toBe(3);
    expect(store.list('alpha', 1)).toEqual([{ id: 'alpha-1', bytes: 1 }]);
    expect(store.list(undefined, 10).map((note) => note.id)).toEqual([
      'alpha-1',
      'alpha-2',
      'beta-1',
    ]);

    expect(store.isStarted).toBe(true);
    store.stop();
    expect(store.isStopped).toBe(true);
    expect(store.size).toBe(0);
  });
});

describe('the fixture mutation gate over HTTP', () => {
  const fixture = async (env?: NodeJS.ProcessEnv): Promise<Fixture> => {
    const created = await createStartedFixture(env === undefined ? {} : { env });
    fixtures.push(created);
    return created;
  };

  it('previews while mutations are disabled and refuses to execute', async () => {
    const { application, apiKey } = await fixture();

    const preview = await application.http.inject({
      method: 'POST',
      url: '/tools/put_note',
      headers: bearer(apiKey),
      payload: { id: 'gated', text: 'hello', dryRun: true },
    });
    expect(preview.json()).toMatchObject({ result: { mode: 'preview', stored: false } });

    const denied = await application.http.inject({
      method: 'POST',
      url: '/tools/put_note',
      headers: bearer(apiKey),
      payload: { id: 'gated', text: 'hello', dryRun: false, confirm: true },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('requires confirmation once mutations are enabled', async () => {
    const { application, apiKey } = await fixture({ MUTATIONS_ENABLED: 'true' });

    const unconfirmed = await application.http.inject({
      method: 'POST',
      url: '/tools/put_note',
      headers: bearer(apiKey),
      payload: { id: 'gated', text: 'hello', dryRun: false },
    });
    expect(unconfirmed.statusCode).toBe(400);

    const executed = await application.http.inject({
      method: 'POST',
      url: '/tools/put_note',
      headers: bearer(apiKey),
      payload: { id: 'gated', text: 'hello', dryRun: false, confirm: true },
    });
    expect(executed.json()).toMatchObject({ result: { mode: 'execute', stored: true, bytes: 5 } });

    const listed = await application.http.inject({
      method: 'POST',
      url: '/tools/list_notes',
      headers: bearer(apiKey),
      payload: {},
    });
    expect(listed.json()).toMatchObject({
      result: { total: 1, notes: [{ id: 'gated', bytes: 5 }] },
    });
  });

  it('executes without confirmation only when confirmation is not required', async () => {
    const { application, apiKey } = await fixture({
      MUTATIONS_ENABLED: 'true',
      MUTATION_CONFIRMATION_REQUIRED: 'false',
    });
    const response = await application.http.inject({
      method: 'POST',
      url: '/tools/put_note',
      headers: bearer(apiKey),
      payload: { id: 'open', text: 'hi', dryRun: false },
    });
    expect(response.json()).toMatchObject({ result: { mode: 'execute', stored: true } });
  });

  it('enforces the capability note ceiling', async () => {
    const { application, apiKey } = await fixture({
      MUTATIONS_ENABLED: 'true',
      MUTATION_CONFIRMATION_REQUIRED: 'false',
      MINIMAL_MAX_NOTES: '1',
    });
    const write = (id: string) =>
      application.http.inject({
        method: 'POST',
        url: '/tools/put_note',
        headers: bearer(apiKey),
        payload: { id, text: 'x', dryRun: false },
      });

    expect((await write('one')).statusCode).toBe(200);
    const overflow = await write('two');
    expect(overflow.statusCode).toBe(400);
    expect(overflow.json()).toMatchObject({ error: { code: 'bad_request' } });
  });
});
