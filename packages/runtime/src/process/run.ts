import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { internalError, serverBusy, timedOut, upstreamError } from '../errors.js';

/**
 * Bounded subprocess execution.
 *
 * Seeded by the Data Cruncher runtime, with the Git Optimizer command experience as a second
 * reference. The platform owns the *mechanics*: no shell, an explicit environment, an isolated
 * working directory, hard wall-clock and output ceilings, cancellation, and deterministic cleanup.
 *
 * The platform does not own *policy*. Which executables may run, which argv is permitted, which
 * flags are safe, and what the output means are capability decisions.
 *
 * This is a library primitive for trusted capability code. It is deliberately not a tool, and it
 * must never be exposed as one: there is no agent-facing path from this module to
 * "run an arbitrary command".
 */

const killGraceMs = 2000;
const defaultMaxStderrBytes = 8 * 1024;

export interface BoundedProcessSpec {
  /** Absolute path to an already-resolved executable. */
  readonly executablePath: string;
  /** A label used in errors and logs. Never a caller-controlled string. */
  readonly label: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Complete child environment; nothing is inherited implicitly. */
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxStderrBytes?: number;
  readonly stdin?: Readable;
  readonly signal?: AbortSignal | undefined;
  /** Streaming consumer. Return `false` to stop reading and terminate the child early. */
  readonly onStdout?: (chunk: Buffer) => boolean;
}

export interface BoundedProcessResult {
  readonly code: number | null;
  readonly terminationSignal: NodeJS.Signals | null;
  /** Captured stdout, present only when no streaming consumer was supplied. */
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stdinBytes: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputLimitReached: boolean;
  readonly stoppedEarly: boolean;
  readonly durationMs: number;
}

export class ExecutableMissingError extends Error {
  public override readonly name = 'ExecutableMissingError';
}

export const runBoundedProcess = async (
  spec: BoundedProcessSpec,
): Promise<BoundedProcessResult> => {
  const startedAt = Date.now();
  const child = spawn(spec.executablePath, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Never a shell. With a shell, every argument becomes a potential injection point; without
    // one, argv is passed verbatim and quoting stops being a security control.
    shell: false,
  });

  let processTimedOut = false;
  let aborted = false;
  let outputLimitReached = false;
  let stoppedEarly = false;
  let stdoutBytes = 0;
  let deliveredBytes = 0;
  let stdinBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const maxStderrBytes = spec.maxStderrBytes ?? defaultMaxStderrBytes;

  const terminate = (): void => {
    if (settled || child.killed) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    killTimer.unref?.();
  };

  const timeoutTimer = setTimeout(() => {
    processTimedOut = true;
    terminate();
  }, spec.timeoutMs);
  timeoutTimer.unref?.();

  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  if (spec.signal?.aborted) onAbort();
  else spec.signal?.addEventListener('abort', onAbort, { once: true });

  // A terminated child closes its pipes; writes must not surface as unhandled errors.
  child.stdin.on('error', () => undefined);

  if (spec.stdin) {
    spec.stdin.on('data', (chunk: Buffer) => {
      stdinBytes += chunk.length;
    });
    spec.stdin.on('error', () => terminate());
    spec.stdin.pipe(child.stdin);
  } else {
    child.stdin.end();
  }

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    const allowed = Math.max(0, spec.maxOutputBytes - deliveredBytes);
    const slice = chunk.length <= allowed ? chunk : chunk.subarray(0, allowed);
    deliveredBytes += slice.length;
    if (slice.length > 0) {
      if (spec.onStdout) {
        if (spec.onStdout(slice) === false) stoppedEarly = true;
      } else {
        stdoutChunks.push(slice);
      }
    }
    if (chunk.length > allowed) outputLimitReached = true;
    if (outputLimitReached || stoppedEarly) {
      child.stdout.destroy();
      terminate();
    }
  });
  child.stdout.on('error', () => undefined);

  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = maxStderrBytes - stderrBytes;
    if (remaining <= 0) return;
    stderrChunks.push(chunk.subarray(0, remaining));
    stderrBytes += Math.min(remaining, chunk.length);
  });
  child.stderr.on('error', () => undefined);

  try {
    const [code, terminationSignal] = (await Promise.race([
      once(child, 'close'),
      once(child, 'error').then(([error]) => {
        throw error;
      }),
    ])) as [number | null, NodeJS.Signals | null];

    return {
      code,
      terminationSignal,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      stdoutBytes,
      stdinBytes,
      timedOut: processTimedOut,
      aborted,
      outputLimitReached,
      stoppedEarly,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ExecutableMissingError(`${spec.label} is not available`, { cause: error });
    }
    throw error;
  } finally {
    settled = true;
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    spec.signal?.removeEventListener('abort', onAbort);
    spec.stdin?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
};

/**
 * Maps a bounded process outcome onto the shared error model.
 *
 * Capabilities still interpret their own exit codes — a `jq` parse failure and a `git` merge
 * conflict are domain events — but the failure modes the platform creates (timeout, cancellation,
 * output ceiling, missing binary) map identically everywhere.
 */
export const processFailureToAppError = (
  result: BoundedProcessResult,
  label: string,
): Error | undefined => {
  if (result.timedOut) return timedOut(`${label} exceeded its time budget`);
  if (result.aborted) return serverBusy(`${label} was cancelled before it completed`);
  if (result.outputLimitReached) {
    return upstreamError(`${label} produced more output than the configured limit allows`);
  }
  return undefined;
};

export const toProcessError = (error: unknown, label: string): Error =>
  error instanceof ExecutableMissingError
    ? internalError(`${label} is not available on this deployment`, error)
    : internalError(`${label} failed to run`, error);
