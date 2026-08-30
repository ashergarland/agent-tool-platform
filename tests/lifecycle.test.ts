import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApplicationLifecycle,
  ReadinessAggregator,
  createAgentToolApplication,
  createSilentLogger,
  defineAgentToolCapability,
  defineTool,
  readinessDegraded,
  readinessNotReady,
  readinessReady,
  type AnyToolDefinition,
} from '@agent-tool-platform/runtime';
import { generateTestApiKey } from '@agent-tool-platform/testkit';
import { bearer, createFixture, createStartedFixture, type Fixture } from './helpers.js';

let fixtures: Fixture[] = [];

const track = (created: Fixture): Fixture => {
  fixtures.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(fixtures.map((entry) => entry.application.shutdown().catch(() => undefined)));
  fixtures = [];
});

describe('ApplicationLifecycle', () => {
  it('moves through starting, ready, draining, and stopped', () => {
    const lifecycle = new ApplicationLifecycle();
    const seen: string[] = [];
    lifecycle.onStateChange((state) => seen.push(state));

    expect(lifecycle.state).toBe('starting');
    expect(lifecycle.accepting).toBe(true);

    lifecycle.markReady();
    expect(lifecycle.state).toBe('ready');

    lifecycle.beginDraining();
    expect(lifecycle.state).toBe('draining');
    expect(lifecycle.accepting).toBe(false);
    expect(lifecycle.signal.aborted).toBe(true);

    lifecycle.markStopped();
    expect(seen).toEqual(['ready', 'draining', 'stopped']);
  });

  it('ignores redundant transitions', () => {
    const lifecycle = new ApplicationLifecycle();
    lifecycle.markStopped();
    lifecycle.markStopped();
    lifecycle.beginDraining();
    expect(lifecycle.state).toBe('stopped');
  });

  it('stops firing removed listeners', () => {
    const lifecycle = new ApplicationLifecycle();
    const seen: string[] = [];
    const off = lifecycle.onStateChange((state) => seen.push(state));
    off();
    lifecycle.markReady();
    expect(seen).toEqual([]);
  });
});

describe('ReadinessAggregator', () => {
  it('reports the worst contributor state', async () => {
    const cases = [
      [[readinessReady('a')], 'ready', true],
      [[readinessReady('a'), readinessDegraded('b')], 'degraded', true],
      [[readinessDegraded('a'), readinessNotReady('b')], 'not_ready', false],
    ] as const;

    for (const [results, state, ready] of cases) {
      const aggregator = new ReadinessAggregator({
        contributors: results.map((result) => () => result),
        cacheMs: 0,
      });
      const report = await aggregator.evaluate(undefined);
      expect(report.state).toBe(state);
      expect(report.ready).toBe(ready);
    }
  });

  it('collapses a throwing contributor into an opaque not_ready result', async () => {
    const aggregator = new ReadinessAggregator({
      contributors: [
        () => {
          throw new Error('/var/secrets/token could not be read');
        },
      ],
      cacheMs: 0,
    });
    const report = await aggregator.evaluate(undefined);
    expect(report.ready).toBe(false);
    expect(JSON.stringify(report)).not.toContain('/var/secrets');
  });

  it('bounds contributor detail', async () => {
    const aggregator = new ReadinessAggregator({
      contributors: [() => readinessReady('long', 'x'.repeat(1000))],
      cacheMs: 0,
    });
    const report = await aggregator.evaluate(undefined);
    expect((report.checks[0]?.detail ?? '').length).toBeLessThanOrEqual(203);
  });

  it('caches results and shares one in-flight evaluation', async () => {
    let calls = 0;
    let now = 1000;
    const aggregator = new ReadinessAggregator({
      contributors: [
        async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return readinessReady('slow');
        },
      ],
      cacheMs: 1000,
      now: () => now,
    });

    await Promise.all([
      aggregator.evaluate(undefined),
      aggregator.evaluate(undefined),
      aggregator.evaluate(undefined),
    ]);
    expect(calls).toBe(1);

    await aggregator.evaluate(undefined);
    expect(calls).toBe(1);

    now += 5000;
    await aggregator.evaluate(undefined);
    expect(calls).toBe(2);

    aggregator.invalidate();
    now += 1;
    await aggregator.evaluate(undefined);
    expect(calls).toBe(3);
  });
});

describe('application lifecycle integration', () => {
  it('runs the capability start hook and then reports ready', async () => {
    const { application } = track(await createFixture());
    expect(application.services.notes.isStarted).toBe(false);
    expect(application.lifecycle.state).toBe('starting');

    await application.start();
    expect(application.services.notes.isStarted).toBe(true);
    expect(application.lifecycle.state).toBe('ready');
    expect((await application.readiness()).ready).toBe(true);
  });

  it('returns 503 from /ready until the capability contributor is satisfied', async () => {
    const { application } = track(await createFixture());
    const before = await application.http.inject({ method: 'GET', url: '/ready' });
    expect(before.statusCode).toBe(503);
    expect(before.json()).toMatchObject({ ready: false });

    await application.start();
    const after = await application.http.inject({ method: 'GET', url: '/ready' });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ ready: true, state: 'ready' });
  });

  it('refuses new work and reports not ready while draining', async () => {
    const { application, apiKey } = track(await createStartedFixture());
    application.lifecycle.beginDraining();

    const ready = await application.http.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ checks: [{ name: 'application', detail: 'draining' }] });

    const invocation = await application.http.inject({
      method: 'POST',
      url: '/tools/list_notes',
      headers: bearer(apiKey),
      payload: {},
    });
    expect(invocation.statusCode).toBe(503);
    expect(invocation.json()).toMatchObject({ error: { code: 'not_ready' } });
  });

  it('runs the capability stop hook on shutdown', async () => {
    const fixture = track(await createStartedFixture());
    const { application } = fixture;
    expect(application.services.notes.isStopped).toBe(false);
    await application.shutdown();
    expect(application.services.notes.isStopped).toBe(true);
    expect(application.lifecycle.state).toBe('stopped');
  });

  it('propagates application shutdown to in-flight invocations', async () => {
    const { application, apiKey } = track(await createStartedFixture());
    const pending = application.http.inject({
      method: 'POST',
      url: '/tools/wait_for_cancellation',
      headers: bearer(apiKey),
      payload: { delayMs: 10_000 },
    });
    setTimeout(() => application.lifecycle.beginDraining(), 20);

    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: { cancelled: true } });
  });

  it('does not run the capability stop hook until in-flight work has unwound', async () => {
    const { application, apiKey } = track(await createStartedFixture({ drainTimeoutMs: 5000 }));

    // Capture the invoker's state at the moment the stop hook runs. Comparing promise resolution
    // order instead would be a microtask race: the response is delivered to the caller's `.then`
    // after the request has already settled internally, so that ordering proves nothing.
    let activeAtStop = -1;
    let stopRan = false;
    const store = application.services.notes;
    const originalStop = store.stop.bind(store);
    store.stop = (): void => {
      activeAtStop = application.invoker.activeCount;
      stopRan = true;
      originalStop();
    };

    // `ignore_cancellation` deliberately does not observe its signal, so it stays in flight for
    // its full delay. A cooperative tool would unwind the instant draining begins, and the test
    // would then pass even with no drain wait at all.
    const invocation = application.http.inject({
      method: 'POST',
      url: '/tools/ignore_cancellation',
      headers: bearer(apiKey),
      payload: { delayMs: 300 },
    });

    // Give the request time to be admitted and counted before shutdown begins.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(application.invoker.activeCount).toBe(1);
    expect(stopRan).toBe(false);

    const shutdown = application.shutdown();
    const response = await invocation;
    await shutdown;

    // The invocation finished before the stop hook destroyed the domain state it was using.
    expect(response.statusCode).toBe(200);
    expect(stopRan).toBe(true);
    expect(activeAtStop).toBe(0);
  });

  it('propagates cancellation to an in-flight invocation before teardown', async () => {
    // The cooperative path: a tool that observes its signal unwinds as soon as draining begins,
    // well before its own delay would have elapsed.
    const { application, apiKey } = track(await createStartedFixture());

    const invocation = application.http.inject({
      method: 'POST',
      url: '/tools/wait_for_cancellation',
      headers: bearer(apiKey),
      payload: { delayMs: 10_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    const shutdown = application.shutdown();
    const response = await invocation;
    await shutdown;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: { cancelled: true } });
    // Far below the tool's own 10s delay, so this is cancellation rather than the delay elapsing.
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('does not tear down domain state under an in-flight capability extension route', async () => {
    // Extension routes never run through the invoker, so they are covered by the request tracker
    // rather than the invocation counter. The guarantee has to hold for them too.
    const { application, apiKey } = track(await createStartedFixture());

    const store = application.services.notes;
    store.put({ id: 'present', text: 'x' });
    expect(store.size).toBe(1);

    // The handler reads `services.notes.size` *after* its delay and returns it, so the response
    // body reports what the domain state looked like at handler-end. A stop-first teardown would
    // have cleared the store and this would come back as 0.
    const route = application.http.inject({
      method: 'GET',
      url: '/notes/slow-stats?delayMs=300',
      headers: bearer(apiKey),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const shutdown = application.shutdown();

    const response = await route;
    await shutdown;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ count: 1 });
    expect(store.isStopped).toBe(true);
  });

  it('runs teardown exactly once for concurrent and repeated shutdowns', async () => {
    const fixture = track(await createStartedFixture());
    const { application } = fixture;
    let stopCalls = 0;
    const store = application.services.notes;
    const originalStop = store.stop.bind(store);
    store.stop = (): void => {
      stopCalls += 1;
      originalStop();
    };

    await Promise.all([application.shutdown(), application.shutdown(), application.shutdown()]);
    await application.shutdown();

    expect(stopCalls).toBe(1);
    expect(application.lifecycle.state).toBe('stopped');
  });

  it('gives up waiting on a stuck invocation after the drain budget', async () => {
    const { application, apiKey } = track(
      await createStartedFixture({ drainTimeoutMs: 50, env: { REQUEST_TIMEOUT_MS: '0' } }),
    );

    // A handler that ignores its cancellation signal must not be able to hold shutdown open.
    const pending = application.http.inject({
      method: 'POST',
      url: '/tools/ignore_cancellation',
      headers: bearer(apiKey),
      payload: { delayMs: 3000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const startedAt = Date.now();
    await expect(application.shutdown()).rejects.toThrow(/shutdown is incomplete/u);
    const elapsed = Date.now() - startedAt;

    expect(application.lifecycle.state).toBe('stopped');
    // Bounded by the drain budget rather than by the stuck handler's own duration, but no longer
    // reported as a clean teardown while admitted work remains active.
    expect(elapsed).toBeLessThan(1500);
    await pending;
  });

  it('refuses new work as soon as draining begins', async () => {
    const { application, apiKey } = track(await createStartedFixture({ drainTimeoutMs: 500 }));

    // Hold shutdown inside its drain window with a handler that ignores cancellation, so the
    // listener is still up while the application is draining. Without this the teardown finishes
    // before the probe arrives and the test would be asserting against a closed socket instead.
    const inFlight = application.http.inject({
      method: 'POST',
      url: '/tools/ignore_cancellation',
      headers: bearer(apiKey),
      payload: { delayMs: 300 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const shutdown = application.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const rejected = await application.http.inject({
      method: 'POST',
      url: '/tools/list_notes',
      headers: bearer(apiKey),
      payload: {},
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toMatchObject({ error: { code: 'not_ready' } });

    await inFlight;
    await shutdown;
  });

  it('refuses a NEW capability extension route once draining has begun', async () => {
    const { application, apiKey } = track(await createStartedFixture({ drainTimeoutMs: 1000 }));
    const probe = application.services.routeProbe;

    // Hold shutdown inside its drain window so the listener is still open when the second request
    // arrives. Without this the teardown finishes first and the probe would be hitting a closed
    // socket rather than the admission guard.
    const inFlight = application.http.inject({
      method: 'GET',
      url: '/notes/slow-stats?delayMs=400',
      headers: bearer(apiKey),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probe.startCount).toBe(1);

    const shutdown = application.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(application.lifecycle.accepting).toBe(false);

    // The race this closes: the tracker only protects requests already in flight, so without an
    // admission guard this request would begin against services that are about to be destroyed.
    const rejected = await application.http.inject({
      method: 'GET',
      url: '/notes/stats',
      headers: bearer(apiKey),
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toMatchObject({ error: { code: 'not_ready', retryable: true } });

    // The decisive assertion: the capability handler never ran. A 503 produced *after* the handler
    // began would still satisfy the status check above but would not close the race.
    expect(probe.startCount).toBe(1);

    const original = await inFlight;
    await shutdown;

    // The request that was already in flight still completed against live domain state.
    expect(original.statusCode).toBe(200);
    expect(application.lifecycle.state).toBe('stopped');
    expect(application.services.notes.isStopped).toBe(true);
  });

  it('keeps operational endpoints available while draining', async () => {
    const { application, apiKey } = track(await createStartedFixture({ drainTimeoutMs: 1000 }));

    const inFlight = application.http.inject({
      method: 'GET',
      url: '/notes/slow-stats?delayMs=400',
      headers: bearer(apiKey),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const shutdown = application.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Operators and orchestrators still need to observe a draining replica, so the guard must not
    // be applied to the core endpoints.
    for (const path of ['/health', '/version', '/openapi.json']) {
      const response = await application.http.inject({ method: 'GET', url: path });
      expect(response.statusCode, path).toBe(200);
    }

    // `/ready` stays reachable and keeps reporting not-ready while draining.
    const ready = await application.http.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ ready: false, checks: [{ detail: 'draining' }] });

    await inFlight;
    await shutdown;
  });

  it('applies a configured request deadline to the invocation signal', async () => {
    const { application, apiKey } = track(
      await createStartedFixture({ env: { REQUEST_TIMEOUT_MS: '60' } }),
    );
    const response = await application.http.inject({
      method: 'POST',
      url: '/tools/wait_for_cancellation',
      headers: bearer(apiKey),
      payload: { delayMs: 5000, throwOnCancel: true },
    });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: { code: 'timeout', retryable: true } });
  });
});

describe('public capability extension routes during drain', () => {
  /**
   * The minimal fixture deliberately has no public routes — the platform's position is that
   * exposing something unauthenticated should be a rare, explicit act, so the fixture should not
   * normalise it. This suite therefore defines its own tiny capability rather than growing one
   * onto the shared fixture.
   */
  interface ProbeServices {
    readonly probe: { starts: number; stopped: boolean };
  }

  const noopTool = defineTool({
    name: 'noop',
    title: 'No-op',
    summary: 'Return a constant.',
    description: 'Return a constant so the registry is non-empty and readiness passes.',
    kind: 'read',
    routing: {
      useWhen: ['a capability needs at least one registered tool'],
      doNotUseWhen: ['you want anything to happen'],
      changesState: false,
    },
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    handler() {
      return Promise.resolve({ ok: true });
    },
  }) as AnyToolDefinition<ProbeServices>;

  const publicRouteCapability = defineAgentToolCapability<ProbeServices>({
    manifest: {
      name: 'public-route-probe',
      version: '0.0.0-test',
      title: 'Public Route Probe',
      description: 'A test-only capability that exposes a public extension route.',
    },
    instructions: 'Routing: test-only capability. Use nothing here for real work.',
    tools: [noopTool],
    createServices(): ProbeServices {
      return { probe: { starts: 0, stopped: false } };
    },
    lifecycle: {
      stop({ services }) {
        services.probe.stopped = true;
      },
    },
    publicRoutes: [
      (router, { services }) => {
        router.get('/public/slow', async () => {
          services.probe.starts += 1;
          await new Promise((resolve) => setTimeout(resolve, 400));
          return { ok: true };
        });
        router.get('/public/quick', () => {
          services.probe.starts += 1;
          return { ok: true };
        });
      },
    ],
  });

  it('refuses a NEW public capability route once draining has begun', async () => {
    const application = await createAgentToolApplication<ProbeServices>(publicRouteCapability, {
      logger: createSilentLogger(),
      readinessCacheMs: 0,
      drainTimeoutMs: 1000,
      env: { NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: generateTestApiKey() },
    });
    await application.start();

    try {
      // Public routes are reachable without credentials while the application is accepting.
      const before = await application.http.inject({ method: 'GET', url: '/public/quick' });
      expect(before.statusCode).toBe(200);
      expect(application.services.probe.starts).toBe(1);

      // Hold the drain window open with a slow public request.
      const inFlight = application.http.inject({ method: 'GET', url: '/public/slow' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(application.services.probe.starts).toBe(2);

      const shutdown = application.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 30));

      // "Public" means unauthenticated, not exempt from draining: this route still touches
      // capability services that the stop hook is about to tear down.
      const rejected = await application.http.inject({ method: 'GET', url: '/public/quick' });
      expect(rejected.statusCode).toBe(503);
      expect(rejected.json()).toMatchObject({ error: { code: 'not_ready' } });
      // The handler never began, so nothing touched services mid-teardown.
      expect(application.services.probe.starts).toBe(2);

      const original = await inFlight;
      await shutdown;

      expect(original.statusCode).toBe(200);
      expect(application.services.probe.stopped).toBe(true);
    } finally {
      await application.shutdown();
    }
  });
});
