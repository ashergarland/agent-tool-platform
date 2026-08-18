import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import {
  Deadline,
  buildLoggerOptions,
  createLogger,
  createSilentLogger,
  defaultRedactionPaths,
  isAcceptableRequestId,
  linkSignals,
  loggingTelemetrySink,
  neverCancelled,
  resolveRequestId,
  whenAborted,
} from '@agent-tool-platform/runtime';
import { createTestPlatformConfig, generateTestApiKey } from '@agent-tool-platform/testkit';

const captureLogs = (): { stream: Writable; lines: string[] } => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { stream, lines };
};

describe('request identity', () => {
  it('accepts a bounded non-empty caller value', () => {
    expect(isAcceptableRequestId('abc')).toBe(true);
    expect(isAcceptableRequestId('')).toBe(false);
    expect(isAcceptableRequestId('x'.repeat(201))).toBe(false);
    expect(isAcceptableRequestId(42)).toBe(false);
  });

  it('generates a replacement when the caller value is unusable', () => {
    expect(resolveRequestId('supplied')).toBe('supplied');
    const generated = resolveRequestId('x'.repeat(500));
    expect(generated).not.toBe('x'.repeat(500));
    expect(generated.length).toBeLessThanOrEqual(200);
  });
});

describe('logging', () => {
  it('redacts credential-bearing paths by default', () => {
    const config = createTestPlatformConfig();
    const options = buildLoggerOptions(config);
    for (const path of ['req.headers.authorization', 'req.headers["x-api-key"]', 'apiKeys']) {
      expect(defaultRedactionPaths).toContain(path);
    }
    expect((options.redact as { censor: string }).censor).toBe('[REDACTED]');
    expect(options.level).toBe(config.logging.level);
  });

  it('never writes a credential that arrived in a redacted position', () => {
    const key = generateTestApiKey();
    const { stream, lines } = captureLogs();
    const logger = createLogger(createTestPlatformConfig(), { destination: stream });
    logger.info({ req: { headers: { authorization: `Bearer ${key}`, 'x-api-key': key } } }, 'call');
    logger.info({ apiKeys: [key], token: key }, 'config');

    const written = lines.join('\n');
    expect(written).not.toContain(key);
    expect(written).toContain('[REDACTED]');
  });

  it('lets a capability add redaction paths without replacing the shared list', () => {
    const options = buildLoggerOptions(createTestPlatformConfig(), {
      additionalRedactionPaths: ['domainSecret'],
    });
    const paths = (options.redact as { paths: string[] }).paths;
    expect(paths).toContain('domainSecret');
    expect(paths).toContain('req.headers.authorization');
  });

  it('records service identity on every line', () => {
    const { stream, lines } = captureLogs();
    createLogger(createTestPlatformConfig({ serviceName: 'named' }), {
      destination: stream,
    }).info('hello');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      service: 'named',
      environment: 'test',
    });
  });

  it('offers a silent logger for stdio transports', () => {
    const { stream, lines } = captureLogs();
    const logger = createSilentLogger();
    logger.info('this must not appear');
    expect(lines).toHaveLength(0);
    stream.destroy();
  });

  it('forwards only telemetry fields through the logging sink', () => {
    const { stream, lines } = captureLogs();
    const logger = createLogger(createTestPlatformConfig(), { destination: stream });
    loggingTelemetrySink(logger).recordInvocation({
      capability: 'c',
      capabilityVersion: '1',
      tool: 't',
      transport: 'http',
      outcome: 'ok',
      durationMs: 3,
    });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'tool.invocation', tool: 't' });
  });
});

describe('cancellation', () => {
  it('fires on its own deadline', async () => {
    const deadline = new Deadline(20);
    expect(deadline.cancelled).toBe(false);
    await whenAborted(deadline.signal);
    expect(deadline.cancelled).toBe(true);
    expect(() => deadline.throwIfCancelled()).toThrow(/deadline/u);
    deadline.dispose();
  });

  it('fires when any parent signal aborts', async () => {
    const application = new AbortController();
    const request = new AbortController();
    const deadline = new Deadline(60_000, application.signal, request.signal);
    request.abort(new Error('client disconnected'));
    await whenAborted(deadline.signal);
    expect(deadline.cancelled).toBe(true);
    deadline.dispose();
  });

  it('is already aborted when a parent was aborted first', () => {
    const parent = new AbortController();
    parent.abort();
    const deadline = new Deadline(60_000, parent.signal);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });

  it('supports an unbounded deadline', () => {
    const deadline = new Deadline(undefined);
    expect(deadline.remainingMs).toBe(Number.POSITIVE_INFINITY);
    expect(deadline.cancelled).toBe(false);
    expect(() => deadline.throwIfCancelled()).not.toThrow();
    deadline.dispose();
  });

  it('reports the remaining budget', () => {
    const deadline = new Deadline(5000);
    expect(deadline.remainingMs).toBeGreaterThan(0);
    expect(deadline.remainingMs).toBeLessThanOrEqual(5000);
    deadline.dispose();
  });

  it('links several signals and detaches its listeners', () => {
    const first = new AbortController();
    const second = new AbortController();
    const linked = linkSignals(first.signal, undefined, second.signal);
    expect(linked.signal.aborted).toBe(false);
    second.abort();
    expect(linked.signal.aborted).toBe(true);
    linked.dispose();

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(linkSignals(alreadyAborted.signal).signal.aborted).toBe(true);
  });

  it('offers a cancellation that never fires', () => {
    expect(neverCancelled.cancelled).toBe(false);
    expect(neverCancelled.remainingMs).toBe(Number.POSITIVE_INFINITY);
    expect(() => neverCancelled.throwIfCancelled()).not.toThrow();
  });

  it('resolves immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(whenAborted(controller.signal)).resolves.toBeUndefined();
  });
});
