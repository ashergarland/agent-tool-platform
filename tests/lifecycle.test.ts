import { afterEach, describe, expect, it } from 'vitest';
import {
  ApplicationLifecycle,
  ReadinessAggregator,
  readinessDegraded,
  readinessNotReady,
  readinessReady,
} from '@agent-tool-platform/runtime';
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
