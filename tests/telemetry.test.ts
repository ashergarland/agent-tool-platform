import { afterEach, describe, expect, it } from 'vitest';
import {
  RecordingTelemetrySink,
  approximateTokens,
  compositeTelemetrySink,
  createSilentLogger,
  estimateSafely,
  jsonByteLength,
  noopTelemetrySink,
  sanitizeMeasurement,
} from '@agent-tool-platform/runtime';
import { bearer, createStartedFixture, type Fixture } from './helpers.js';

let fixtures: Fixture[] = [];

const fixture = async (): Promise<Fixture> => {
  const created = await createStartedFixture();
  fixtures.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(fixtures.map((entry) => entry.application.shutdown()));
  fixtures = [];
});

describe('telemetry primitives', () => {
  it('provides a no-op default that never throws', () => {
    expect(() =>
      noopTelemetrySink.recordInvocation({
        capability: 'x',
        capabilityVersion: '1',
        tool: 't',
        transport: 'http',
        outcome: 'ok',
        durationMs: 1,
      }),
    ).not.toThrow();
  });

  it('fans out to several sinks and survives a failing one', () => {
    const good = new RecordingTelemetrySink();
    const errors: unknown[] = [];
    const sink = compositeTelemetrySink(
      [
        {
          recordInvocation: () => {
            throw new Error('sink failure');
          },
        },
        good,
      ],
      (error) => errors.push(error),
    );

    sink.recordInvocation({
      capability: 'x',
      capabilityVersion: '1',
      tool: 't',
      transport: 'http',
      outcome: 'ok',
      durationMs: 1,
    });
    expect(good.events).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('drops unknown, negative, and non-finite measurement fields', () => {
    expect(
      sanitizeMeasurement({
        sourceBytes: 100.6,
        outputBytes: -5,
        rawEquivalentTokens: Number.NaN,
        truncated: true,
        // A capability must not be able to smuggle content through the measurement channel.
        prompt: 'the user asked about their password',
      } as never),
    ).toEqual({ sourceBytes: 101, truncated: true });

    expect(sanitizeMeasurement(undefined)).toBeUndefined();
    expect(sanitizeMeasurement({})).toBeUndefined();
  });

  it('never lets a capability estimator fail an invocation', () => {
    const errors: unknown[] = [];
    const measurement = estimateSafely(
      {
        estimate: () => {
          throw new Error('estimator exploded');
        },
      },
      { toolName: 't', input: {}, output: {}, durationMs: 1 },
      (error) => errors.push(error),
    );
    expect(measurement).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(
      estimateSafely(undefined, { toolName: 't', input: {}, output: {}, durationMs: 1 }),
    ).toBeUndefined();
  });

  it('sizes values without serializing cycles', () => {
    expect(jsonByteLength({ a: 1 })).toBe(7);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(jsonByteLength(cyclic)).toBe(0);
    expect(jsonByteLength(undefined)).toBe(0);
    expect(approximateTokens(9)).toBe(3);
  });
});

describe('runtime telemetry integration', () => {
  it('records baseline invocation metadata the capability never supplies', async () => {
    const { application, apiKey } = await fixture();
    await application.http.inject({
      method: 'POST',
      url: '/tools/list_notes',
      headers: bearer(apiKey),
      payload: {},
    });

    const event = application.telemetry as RecordingTelemetrySink;
    expect(event.events).toHaveLength(1);
    expect(event.events[0]).toMatchObject({
      capability: 'minimal-capability',
      tool: 'list_notes',
      transport: 'http',
      outcome: 'ok',
    });
    expect(event.events[0]?.durationMs).toBeTypeOf('number');
    expect(event.events[0]?.capabilityVersion).toBe(application.config.service.version);
  });

  it('merges the capability estimator into the baseline event', async () => {
    const { application, apiKey, telemetry } = await fixture();
    await application.http.inject({
      method: 'POST',
      url: '/tools/list_notes',
      headers: bearer(apiKey),
      payload: { limit: 5 },
    });
    const measurement = telemetry.events[0]?.measurement;
    expect(measurement).toBeDefined();
    expect(measurement?.estimatedTokensAvoided).toBeGreaterThanOrEqual(0);
    expect(measurement?.sourceBytes).toBeGreaterThan(0);
  });

  it('records failures with an error code and no measurement', async () => {
    const { application, apiKey, telemetry } = await fixture();
    await application.http.inject({
      method: 'POST',
      url: '/tools/broken_output',
      headers: bearer(apiKey),
      payload: { secret: 'never-in-telemetry' },
    });
    expect(telemetry.events[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'internal_error',
    });
    expect(telemetry.events[0]?.measurement).toBeUndefined();
    expect(JSON.stringify(telemetry.events)).not.toContain('never-in-telemetry');
  });

  it('carries no arguments, results, or identifiers in the recorded event', async () => {
    const { application, apiKey, telemetry } = await fixture();
    await application.http.inject({
      method: 'POST',
      url: '/tools/put_note',
      headers: bearer(apiKey),
      payload: { id: 'sensitive-note-id', text: 'sensitive note body', dryRun: true },
    });
    const serialized = JSON.stringify(telemetry.events);
    expect(serialized).not.toContain('sensitive-note-id');
    expect(serialized).not.toContain('sensitive note body');
    expect(Object.keys(telemetry.events[0] ?? {}).sort()).toEqual([
      'capability',
      'capabilityVersion',
      'durationMs',
      'measurement',
      'outcome',
      'tool',
      'transport',
    ]);
  });

  it('never fails an invocation because a sink threw', async () => {
    const throwingSink = {
      recordInvocation: (): never => {
        throw new Error('sink failure');
      },
    };
    const { application } = await fixture();
    const invoker = new (
      Object.getPrototypeOf(application.invoker).constructor as new (
        deps: unknown,
      ) => typeof application.invoker
    )({
      registry: application.registry,
      services: application.services,
      lifecycle: application.lifecycle,
      telemetry: throwingSink,
      logger: createSilentLogger(),
      capabilityName: 'minimal-capability',
      capabilityVersion: '0.1.0',
    });

    await expect(
      invoker.invoke({
        toolName: 'list_notes',
        input: {},
        requestId: 'r',
        principal: { id: 'p', kind: 'anonymous' },
        transport: 'http',
      }),
    ).resolves.toMatchObject({ total: 0 });
  });
});
