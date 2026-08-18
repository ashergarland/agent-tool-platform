import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  BoundedQueue,
  buildChildEnvironment,
  resolveExecutable,
  runBoundedProcess,
} from '@agent-tool-platform/runtime';
import {
  ConformanceRun,
  hasErrorCode,
  type ConformanceOptions,
  type ConformanceResult,
} from './harness.js';

/**
 * Safe process execution conformance.
 *
 * Runs the current Node binary as the subject, so the suite works on any machine that can run the
 * tests at all and needs no capability-specific tooling installed.
 */

export interface ProcessConformanceOptions extends ConformanceOptions {
  /** Executable used for the probes. Defaults to the running Node binary. */
  readonly executablePath?: string;
  /** Environment variable name used to prove parent secrets are not inherited. */
  readonly secretVariable?: string;
}

const nodeEval = (source: string): readonly string[] => ['-e', source];

export const runProcessConformance = async (
  options: ProcessConformanceOptions = {},
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('process');
  const executablePath = options.executablePath ?? process.execPath;
  const secretVariable = options.secretVariable ?? 'ATP_CONFORMANCE_PARENT_SECRET';
  const secretValue = 'parent-secret-value-must-not-leak';
  const cwd = await mkdtemp(join(tmpdir(), 'atp-process-'));

  const previous = process.env[secretVariable];
  process.env[secretVariable] = secretValue;

  try {
    const env = buildChildEnvironment({ pathEntries: [dirname(executablePath)], tempDir: cwd });

    run.check(
      'the scrubbed child environment omits parent secrets',
      !(secretVariable in env) && !Object.values(env).includes(secretValue),
    );
    run.check('the scrubbed child environment pins a temp directory', env['TMPDIR'] === cwd);

    const inherited = await runBoundedProcess({
      executablePath,
      label: 'node',
      args: nodeEval(`process.stdout.write(JSON.stringify(Object.keys(process.env)))`),
      cwd,
      env,
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
    });
    run.check(
      'a child cannot observe a parent secret',
      !inherited.stdout.includes(secretVariable) && !inherited.stdout.includes(secretValue),
      inherited.stdout.slice(0, 200),
    );

    const echoed = await runBoundedProcess({
      executablePath,
      label: 'node',
      args: nodeEval('process.stdout.write("hello")'),
      cwd,
      env,
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
    });
    run.equal('a bounded process captures stdout', echoed.stdout, 'hello');
    run.equal('a successful process reports exit code 0', echoed.code, 0);

    // A shell would interpret this; without one it is a literal argument and nothing expands.
    const noShell = await runBoundedProcess({
      executablePath,
      label: 'node',
      args: nodeEval('process.stdout.write(process.argv[1] ?? "none")').concat('$(echo pwned)'),
      cwd,
      env,
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
    });
    run.check(
      'arguments are passed without a shell',
      !noShell.stdout.includes('pwned') || noShell.stdout.includes('$('),
      noShell.stdout.slice(0, 200),
    );

    const timedOutResult = await runBoundedProcess({
      executablePath,
      label: 'node',
      args: nodeEval('setTimeout(() => {}, 60000)'),
      cwd,
      env,
      timeoutMs: 200,
      maxOutputBytes: 4096,
    });
    run.check('a process that overruns its budget is terminated', timedOutResult.timedOut);

    const controller = new AbortController();
    const cancelled = runBoundedProcess({
      executablePath,
      label: 'node',
      args: nodeEval('setTimeout(() => {}, 60000)'),
      cwd,
      env,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    run.check('a cancelled process is terminated', (await cancelled).aborted);

    const bounded = await runBoundedProcess({
      executablePath,
      label: 'node',
      args: nodeEval('process.stdout.write("x".repeat(100000))'),
      cwd,
      env,
      timeoutMs: 15_000,
      maxOutputBytes: 1024,
    });
    run.check('stdout is bounded', bounded.outputLimitReached && bounded.stdout.length <= 1024);

    const boundedStderr = await runBoundedProcess({
      executablePath,
      label: 'node',
      args: nodeEval('process.stderr.write("e".repeat(100000)); process.exit(3)'),
      cwd,
      env,
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
      maxStderrBytes: 512,
    });
    run.check('stderr is bounded', boundedStderr.stderr.length <= 512);
    run.equal('a non-zero exit code is reported', boundedStderr.code, 3);

    const withStdin = await runBoundedProcess({
      executablePath,
      label: 'node',
      args: nodeEval(
        'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))',
      ),
      cwd,
      env,
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
      stdin: Readable.from(['piped']),
    });
    run.equal('stdin is streamed to the child', withStdin.stdout, 'PIPED');

    const resolved = await resolveExecutable('node', {
      pathValue: dirname(executablePath),
    });
    run.check('an executable resolves from an absolute PATH entry', resolved.length > 0);
    await run.throws('a relative PATH entry is ignored', () =>
      resolveExecutable('node', { pathValue: 'relative-dir' }),
    );

    const queue = new BoundedQueue(1, 0, 'process work');
    let release = (): void => undefined;
    const blocking = queue.run(() => new Promise<void>((resolve) => (release = () => resolve())));
    await run.throws(
      'queue overflow becomes a retryable busy error',
      () => queue.run(() => Promise.resolve()),
      (error) =>
        hasErrorCode(error, 'busy') && (error as { retryable?: boolean }).retryable === true,
    );
    release();
    await blocking;
  } finally {
    if (previous === undefined) delete process.env[secretVariable];
    else process.env[secretVariable] = previous;
    await rm(cwd, { recursive: true, force: true });
  }

  return run.finish(options);
};
