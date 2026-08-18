import { describe, expect, it } from 'vitest';
import {
  BoundedQueue,
  BoundedSemaphore,
  BoundedWarnings,
  boundList,
  boundText,
  clamp,
  resolveCeilings,
} from '@agent-tool-platform/runtime';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('BoundedSemaphore', () => {
  it('admits up to the concurrency limit and queues the rest', async () => {
    const semaphore = new BoundedSemaphore(2, 2);
    const first = deferred();
    const second = deferred();

    const a = semaphore.run(() => first.promise);
    const b = semaphore.run(() => second.promise);
    await Promise.resolve();
    expect(semaphore.stats.active).toBe(2);

    const queued = semaphore.run(() => Promise.resolve('queued'));
    await Promise.resolve();
    expect(semaphore.stats.queued).toBe(1);

    first.resolve();
    second.resolve();
    await Promise.all([a, b]);
    await expect(queued).resolves.toBe('queued');
  });

  it('rejects with a retryable busy error once the queue is full', async () => {
    const semaphore = new BoundedSemaphore(1, 1);
    const blocking = deferred();
    const running = semaphore.run(() => blocking.promise);
    const waiting = semaphore.run(() => Promise.resolve());
    await Promise.resolve();

    expect(semaphore.accepting).toBe(false);
    await expect(semaphore.run(() => Promise.resolve())).rejects.toMatchObject({
      code: 'busy',
      retryable: true,
    });

    blocking.resolve();
    await Promise.all([running, waiting]);
  });

  it('releases a queued slot when the caller aborts', async () => {
    const semaphore = new BoundedSemaphore(1, 4);
    const blocking = deferred();
    const running = semaphore.run(() => blocking.promise);
    const controller = new AbortController();
    const queued = semaphore.run(() => Promise.resolve(), { signal: controller.signal });
    await Promise.resolve();
    expect(semaphore.stats.queued).toBe(1);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'timeout' });
    expect(semaphore.stats.queued).toBe(0);

    blocking.resolve();
    await running;
  });

  it('refuses an already-aborted acquire', async () => {
    const semaphore = new BoundedSemaphore(1, 1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      semaphore.run(() => Promise.resolve(), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('drains in-flight work and refuses new work', async () => {
    const semaphore = new BoundedSemaphore(1, 2);
    const blocking = deferred();
    const running = semaphore.run(() => blocking.promise);
    const queued = semaphore.run(() => Promise.resolve());
    await Promise.resolve();

    const draining = semaphore.drain();
    await expect(queued).rejects.toMatchObject({ code: 'busy' });
    blocking.resolve();
    await running;
    await draining;

    await expect(semaphore.run(() => Promise.resolve())).rejects.toMatchObject({ code: 'busy' });
    expect(semaphore.accepting).toBe(false);
  });

  it('validates its own bounds', () => {
    expect(() => new BoundedSemaphore(0, 1)).toThrow(/maxConcurrent/u);
    expect(() => new BoundedSemaphore(1, -1)).toThrow(/maxQueued/u);
  });
});

describe('BoundedQueue', () => {
  it('runs work up to the concurrency limit', async () => {
    const queue = new BoundedQueue(2, 2, 'jobs');
    const blocking = deferred();
    const a = queue.run(() => blocking.promise);
    const b = queue.run(() => blocking.promise);
    await Promise.resolve();
    expect(queue.active).toBe(2);
    blocking.resolve();
    await Promise.all([a, b]);
  });

  it('rejects overflow with a retryable busy error', async () => {
    const queue = new BoundedQueue(1, 0, 'jobs');
    const blocking = deferred();
    const running = queue.run(() => blocking.promise);
    await expect(queue.run(() => Promise.resolve())).rejects.toMatchObject({
      code: 'busy',
      retryable: true,
    });
    blocking.resolve();
    await running;
  });

  it('rejects a queued caller that aborts', async () => {
    const queue = new BoundedQueue(1, 2, 'jobs');
    const blocking = deferred();
    const running = queue.run(() => blocking.promise);
    const controller = new AbortController();
    const queued = queue.run(() => Promise.resolve(), controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'timeout' });
    blocking.resolve();
    await running;
  });

  it('closes and drains', async () => {
    const queue = new BoundedQueue(1, 2, 'jobs');
    const blocking = deferred();
    const running = queue.run(() => blocking.promise);
    const queued = queue.run(() => Promise.resolve());
    await Promise.resolve();

    const draining = queue.drain();
    await expect(queued).rejects.toMatchObject({ code: 'busy' });
    blocking.resolve();
    await running;
    await draining;

    expect(queue.stats.closed).toBe(true);
    await expect(queue.run(() => Promise.resolve())).rejects.toMatchObject({ code: 'busy' });
  });

  it('validates its own bounds', () => {
    expect(() => new BoundedQueue(0, 1)).toThrow(/concurrency/u);
    expect(() => new BoundedQueue(1, -1)).toThrow(/queueLimit/u);
  });
});

describe('limit utilities', () => {
  it('clamps values', () => {
    expect(clamp(5, 1, 3)).toBe(3);
    expect(clamp(0, 1, 3)).toBe(1);
    expect(clamp(2, 1, 3)).toBe(2);
  });

  it('lets an override lower a ceiling but never raise it', () => {
    const ceilings = { maxFiles: 100, maxBytes: 1000 };
    const lowered = resolveCeilings(ceilings, { maxFiles: 10 });
    expect(lowered.values.maxFiles).toBe(10);
    expect(lowered.clamped).toEqual([]);

    const raised = resolveCeilings(ceilings, { maxFiles: 10_000 });
    expect(raised.values.maxFiles).toBe(100);
    expect(raised.clamped).toEqual(['maxFiles']);

    expect(resolveCeilings(ceilings, { maxBytes: Number.NaN }).values.maxBytes).toBe(1000);
  });

  it('bounds text and lists while reporting truncation', () => {
    expect(boundText('abcdef', 3)).toEqual({ text: 'abc', truncated: true, originalLength: 6 });
    expect(boundText('ab', 3).truncated).toBe(false);
    expect(boundList([1, 2, 3], 2)).toEqual({ items: [1, 2], truncated: true, originalLength: 3 });
    expect(boundList([1], 2).truncated).toBe(false);
  });

  it('de-duplicates and bounds warnings', () => {
    const warnings = new BoundedWarnings(2, 10);
    warnings.add('first');
    warnings.add('first');
    warnings.add('second');
    warnings.add('third');
    warnings.add('   ');
    expect(warnings.size).toBe(2);
    expect(warnings.truncated).toBe(true);
    expect(warnings.list()).toContain('Additional warnings were suppressed');

    const long = new BoundedWarnings(4, 5);
    long.add('abcdefghij');
    expect(long.list()[0]).toBe('abcde...');
  });
});
