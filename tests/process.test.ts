import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ExecutableResolutionError,
  buildChildEnvironment,
  isExecutableFile,
  processFailureToAppError,
  resolveExecutable,
  runBoundedProcess,
  toProcessError,
} from '@agent-tool-platform/runtime';

const nodePath = process.execPath;
const nodeDir = dirname(nodePath);

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'atp-process-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const childEnv = (dir: string): Record<string, string> =>
  buildChildEnvironment({ pathEntries: [nodeDir], tempDir: dir });

describe('buildChildEnvironment', () => {
  it('constructs an allowlist rather than filtering the parent environment', () => {
    const env = buildChildEnvironment({ pathEntries: ['/usr/bin'], tempDir: '/tmp/x' });
    expect(Object.keys(env).sort()).toEqual(
      expect.arrayContaining(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TEMP', 'TMP', 'TMPDIR']),
    );
    expect(env['HOME']).toBe('/tmp/x');
  });

  it('omits parent secrets entirely', () => {
    const source = {
      API_KEYS: 'super-secret-key',
      AZURE_CLIENT_SECRET: 'another-secret',
      NODE_OPTIONS: '--require=/tmp/evil.js',
      PATH: '/attacker/bin',
    };
    const env = buildChildEnvironment({
      pathEntries: ['/usr/bin'],
      tempDir: '/tmp/x',
      source,
      platform: 'linux',
    });
    expect(env).not.toHaveProperty('API_KEYS');
    expect(env).not.toHaveProperty('AZURE_CLIENT_SECRET');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env['PATH']).toBe('/usr/bin');
    expect(Object.values(env)).not.toContain('super-secret-key');
  });

  it('adds only the non-sensitive Windows system variables', () => {
    const env = buildChildEnvironment({
      pathEntries: ['C:/bin'],
      tempDir: 'C:/tmp',
      platform: 'win32',
      source: { SystemRoot: 'C:/Windows', windir: 'C:/Windows', API_KEYS: 'secret' },
    });
    expect(env['SystemRoot']).toBe('C:/Windows');
    expect(env).not.toHaveProperty('API_KEYS');
  });

  it('lets a capability opt a variable in explicitly', () => {
    const env = buildChildEnvironment({
      pathEntries: ['/usr/bin'],
      tempDir: '/tmp/x',
      extra: { GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
  });

  it('deduplicates PATH entries', () => {
    const env = buildChildEnvironment({
      pathEntries: ['/usr/bin', '/usr/bin'],
      tempDir: '/tmp/x',
    });
    expect(env['PATH']).toBe('/usr/bin');
  });
});

describe('runBoundedProcess', () => {
  it('captures stdout and the exit code', async () => {
    await withTempDir(async (dir) => {
      const result = await runBoundedProcess({
        executablePath: nodePath,
        label: 'node',
        args: ['-e', 'process.stdout.write("ok")'],
        cwd: dir,
        env: childEnv(dir),
        timeoutMs: 15_000,
        maxOutputBytes: 4096,
      });
      expect(result.stdout).toBe('ok');
      expect(result.code).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('proves a parent secret is absent from the default child environment', async () => {
    process.env['ATP_TEST_PARENT_SECRET'] = 'parent-secret-must-not-leak';
    try {
      await withTempDir(async (dir) => {
        const result = await runBoundedProcess({
          executablePath: nodePath,
          label: 'node',
          args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
          cwd: dir,
          env: childEnv(dir),
          timeoutMs: 15_000,
          maxOutputBytes: 65_536,
        });
        expect(result.stdout).not.toContain('ATP_TEST_PARENT_SECRET');
        expect(result.stdout).not.toContain('parent-secret-must-not-leak');
      });
    } finally {
      delete process.env['ATP_TEST_PARENT_SECRET'];
    }
  });

  it('runs without a shell so metacharacters stay literal', async () => {
    await withTempDir(async (dir) => {
      const result = await runBoundedProcess({
        executablePath: nodePath,
        label: 'node',
        args: ['-e', 'process.stdout.write(process.argv[1] ?? "")', '$(echo pwned)'],
        cwd: dir,
        env: childEnv(dir),
        timeoutMs: 15_000,
        maxOutputBytes: 4096,
      });
      expect(result.stdout).toBe('$(echo pwned)');
    });
  });

  it('terminates a child that overruns its time budget', async () => {
    await withTempDir(async (dir) => {
      const result = await runBoundedProcess({
        executablePath: nodePath,
        label: 'node',
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: dir,
        env: childEnv(dir),
        timeoutMs: 150,
        maxOutputBytes: 4096,
      });
      expect(result.timedOut).toBe(true);
      expect(processFailureToAppError(result, 'node')).toMatchObject({ code: 'timeout' });
    });
  });

  it('terminates a child when the caller cancels', async () => {
    await withTempDir(async (dir) => {
      const controller = new AbortController();
      const pending = runBoundedProcess({
        executablePath: nodePath,
        label: 'node',
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: dir,
        env: childEnv(dir),
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 30);
      const result = await pending;
      expect(result.aborted).toBe(true);
      expect(processFailureToAppError(result, 'node')).toMatchObject({ code: 'busy' });
    });
  });

  it('honours an already-aborted signal', async () => {
    await withTempDir(async (dir) => {
      const controller = new AbortController();
      controller.abort();
      const result = await runBoundedProcess({
        executablePath: nodePath,
        label: 'node',
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: dir,
        env: childEnv(dir),
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
        signal: controller.signal,
      });
      expect(result.aborted).toBe(true);
    });
  });

  it('bounds stdout and stderr', async () => {
    await withTempDir(async (dir) => {
      const stdout = await runBoundedProcess({
        executablePath: nodePath,
        label: 'node',
        args: ['-e', 'process.stdout.write("x".repeat(200000))'],
        cwd: dir,
        env: childEnv(dir),
        timeoutMs: 15_000,
        maxOutputBytes: 512,
      });
      expect(stdout.outputLimitReached).toBe(true);
      expect(stdout.stdout.length).toBeLessThanOrEqual(512);
      expect(processFailureToAppError(stdout, 'node')).toMatchObject({ code: 'upstream_error' });

      const stderr = await runBoundedProcess({
        executablePath: nodePath,
        label: 'node',
        args: ['-e', 'process.stderr.write("e".repeat(200000)); process.exit(4)'],
        cwd: dir,
        env: childEnv(dir),
        timeoutMs: 15_000,
        maxOutputBytes: 65_536,
        maxStderrBytes: 256,
      });
      expect(stderr.stderr.length).toBeLessThanOrEqual(256);
      expect(stderr.code).toBe(4);
      expect(processFailureToAppError(stderr, 'node')).toBeUndefined();
    });
  });

  it('streams stdin and lets a consumer stop early', async () => {
    await withTempDir(async (dir) => {
      const piped = await runBoundedProcess({
        executablePath: nodePath,
        label: 'node',
        args: [
          '-e',
          'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))',
        ],
        cwd: dir,
        env: childEnv(dir),
        timeoutMs: 15_000,
        maxOutputBytes: 4096,
        stdin: Readable.from(['piped input']),
      });
      expect(piped.stdout).toBe('PIPED INPUT');
      expect(piped.stdinBytes).toBeGreaterThan(0);

      const stopped = await runBoundedProcess({
        executablePath: nodePath,
        label: 'node',
        args: ['-e', 'setInterval(() => process.stdout.write("chunk"), 5)'],
        cwd: dir,
        env: childEnv(dir),
        timeoutMs: 15_000,
        maxOutputBytes: 65_536,
        onStdout: () => false,
      });
      expect(stopped.stoppedEarly).toBe(true);
    });
  });

  it('reports a missing executable distinctly', async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir, 'not-a-real-binary');
      await expect(
        runBoundedProcess({
          executablePath: missing,
          label: 'ghost',
          args: [],
          cwd: dir,
          env: childEnv(dir),
          timeoutMs: 5000,
          maxOutputBytes: 1024,
        }),
      ).rejects.toMatchObject({ name: 'ExecutableMissingError' });
    });
  });

  it('maps process errors onto the shared error model', () => {
    expect(toProcessError(new Error('boom'), 'node')).toMatchObject({ code: 'internal_error' });
  });
});

describe('resolveExecutable', () => {
  it('finds an executable on an absolute PATH entry', async () => {
    await expect(resolveExecutable('node', { pathValue: nodeDir })).resolves.toContain('node');
  });

  it('ignores relative PATH entries', async () => {
    await expect(resolveExecutable('node', { pathValue: 'relative' })).rejects.toBeInstanceOf(
      ExecutableResolutionError,
    );
  });

  it('accepts an explicit override but still checks it', async () => {
    await expect(resolveExecutable('node', { override: nodePath })).resolves.toBe(nodePath);
    await withTempDir(async (dir) => {
      // A directory is rejected on every platform; `access(X_OK)` is not meaningful on Windows,
      // so the regular-file check is what actually carries this guarantee.
      await expect(resolveExecutable('thing', { override: dir })).rejects.toBeInstanceOf(
        ExecutableResolutionError,
      );
      await writeFile(join(dir, 'plain.txt'), 'not a binary', 'utf8');
      await expect(
        resolveExecutable('thing', { override: join(dir, 'missing-binary') }),
      ).rejects.toBeInstanceOf(ExecutableResolutionError);
    });
  });

  it('reports a directory as not executable', async () => {
    await withTempDir(async (dir) => {
      expect(await isExecutableFile(dir)).toBe(false);
      expect(await isExecutableFile(join(dir, 'nope'))).toBe(false);
    });
  });
});
