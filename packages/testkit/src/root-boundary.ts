import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootBoundary } from '@agent-tool-platform/runtime';
import {
  ConformanceRun,
  hasErrorCode,
  type ConformanceOptions,
  type ConformanceResult,
} from './harness.js';

/**
 * Root-boundary conformance.
 *
 * Builds a real directory tree, because the interesting failures — a symlink whose target escapes,
 * a traversal that normalizes back inside, a path that exists but is a directory — are filesystem
 * behaviours, not string behaviours.
 */

export interface RootBoundaryConformanceOptions extends ConformanceOptions {
  /**
   * Builds the boundary under test from a prepared root. Defaults to a plain {@link RootBoundary},
   * which is what a capability composes its own policy on top of.
   */
  readonly createBoundary?: (root: string) => RootBoundary;
}

export const runRootBoundaryConformance = async (
  options: RootBoundaryConformanceOptions = {},
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('root-boundary');
  const base = await mkdtemp(join(tmpdir(), 'atp-boundary-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');

  try {
    await mkdir(join(root, 'nested'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, 'inside.txt'), 'inside', 'utf8');
    await writeFile(join(root, 'nested', 'deep.txt'), 'deep', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');

    let symlinkSupported = true;
    try {
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    } catch {
      // Unprivileged Windows sessions cannot create symlinks; the check is reported as skipped.
      symlinkSupported = false;
    }

    const boundary = options.createBoundary?.(root) ?? new RootBoundary({ root });

    const inside = await boundary.resolve('inside.txt');
    run.equal('an in-root path resolves', inside.relativePath, 'inside.txt');

    const deep = await boundary.resolve('nested/deep.txt');
    run.equal(
      'a nested path resolves to a POSIX relative path',
      deep.relativePath,
      'nested/deep.txt',
    );

    await run.throws(
      'traversal outside the root is denied',
      () => boundary.resolve('../outside/secret.txt'),
      (error) => hasErrorCode(error, 'forbidden') || hasErrorCode(error, 'not_found'),
    );

    await run.throws(
      'an absolute path is rejected before resolution',
      () => boundary.resolve(join(outside, 'secret.txt')),
      (error) => hasErrorCode(error, 'bad_request'),
    );

    await run.throws(
      'a NUL byte is rejected',
      () => boundary.resolve('inside\0.txt'),
      (error) => hasErrorCode(error, 'bad_request'),
    );

    if (symlinkSupported) {
      await run.throws(
        'a symlink whose target escapes the root is denied',
        () => boundary.resolve('escape.txt'),
        (error) => hasErrorCode(error, 'forbidden'),
      );
    } else {
      run.check(
        'a symlink whose target escapes the root is denied',
        true,
        'skipped: symlinks unavailable',
      );
    }

    await run.throws(
      'a nonexistent path produces not_found',
      () => boundary.resolve('missing.txt'),
      (error) => hasErrorCode(error, 'not_found'),
    );

    await run.throws(
      'the root itself is not addressable by default',
      () => boundary.resolve('.'),
      (error) => hasErrorCode(error, 'forbidden'),
    );

    const rootAllowed = new RootBoundary({ root, allowRoot: true });
    const resolvedRoot = await rootAllowed.resolve('.');
    run.equal('the root is addressable when allowed', resolvedRoot.relativePath, '.');

    const status = await boundary.status();
    run.check('a usable root reports usable', status.usable && status.configured);

    const unconfigured = new RootBoundary({ root: undefined });
    const unconfiguredStatus = await unconfigured.status();
    run.check(
      'an unconfigured root reports unusable without throwing',
      !unconfiguredStatus.usable && !unconfiguredStatus.configured,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  return run.finish(options);
};
