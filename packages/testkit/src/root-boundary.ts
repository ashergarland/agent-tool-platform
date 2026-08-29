import { constants } from 'node:fs';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
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

const consume = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected RootBoundary to emit buffer chunks');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

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
    const largeContents = Buffer.from('0123456789'.repeat(10_000));
    await writeFile(join(root, 'large.txt'), largeContents);
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');

    let symlinkSupported = true;
    try {
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
      await symlink(join(root, 'inside.txt'), join(root, 'inside-link.txt'));
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

    const opened = await boundary.openFile('large.txt', { previewBytes: 11 });
    run.equal(
      'opened metadata reports descriptor size',
      opened.sizeBytes,
      largeContents.byteLength,
    );
    run.equal('opened metadata reports a root-relative path', opened.relativePath, 'large.txt');
    run.check(
      'the opened preview is bounded',
      opened.preview.equals(largeContents.subarray(0, 11)) &&
        opened.preview.byteLength < opened.sizeBytes,
    );
    run.check(
      'a file larger than its preview streams in full',
      (await consume(opened.createReadStream({ highWaterMark: 257 }))).equals(largeContents),
    );
    await Promise.all([opened.close(), opened.close()]);

    const changingPath = join(root, 'changing.txt');
    const changingContents = Buffer.from('opened-object-contents');
    await writeFile(changingPath, changingContents);
    const changing = await boundary.openFile('changing.txt', { previewBytes: 6 });
    await rename(changingPath, join(root, 'moved.txt'));
    await writeFile(changingPath, 'replacement');
    run.check(
      'preview and stream stay on the same opened object after path replacement',
      changing.preview.equals(changingContents.subarray(0, 6)) &&
        (await consume(changing.createReadStream())).equals(changingContents),
    );
    await changing.close();
    await changing.close();

    const limited = new RootBoundary({ root, maxFileBytes: 5 });
    await run.throws(
      'opened descriptor size is enforced',
      () => limited.openFile('inside.txt'),
      (error) => hasErrorCode(error, 'limit_exceeded'),
    );
    await run.throws(
      'opened objects must be regular files',
      () => boundary.openFile('nested'),
      (error) => hasErrorCode(error, 'bad_request'),
    );

    await run.throws(
      'traversal outside the root is denied',
      () => boundary.resolve('../outside/secret.txt'),
      (error) => hasErrorCode(error, 'forbidden') || hasErrorCode(error, 'not_found'),
    );
    await run.throws(
      'traversal outside the root is denied before opening',
      () => boundary.openFile('../outside/secret.txt'),
      (error) => hasErrorCode(error, 'forbidden'),
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
      await run.throws(
        'a final in-root symlink is rejected when opening',
        () => boundary.openFile('inside-link.txt'),
        (error) => hasErrorCode(error, 'forbidden'),
      );
      await run.throws(
        'a symlink escape is rejected when opening',
        () => boundary.openFile('escape.txt'),
        (error) => hasErrorCode(error, 'forbidden'),
      );
    } else {
      run.check(
        'a symlink whose target escapes the root is denied',
        true,
        'skipped: symlinks unavailable',
      );
      run.check(
        'a final in-root symlink is rejected when opening',
        true,
        'skipped: symlinks unavailable',
      );
      run.check('a symlink escape is rejected when opening', true, 'skipped: symlinks unavailable');
    }

    if (process.platform === 'win32') {
      run.check(
        'Windows uses post-open path and descriptor identity checks',
        typeof constants.O_NOFOLLOW !== 'number',
        'Node does not expose O_NOFOLLOW on Windows',
      );
      run.check(
        'Windows does not collapse case-distinct canonical siblings',
        !boundary.isWithin(root, join(base, 'ROOT', 'secret.txt')),
      );
    } else {
      run.check(
        'POSIX provides atomic final-component no-follow',
        typeof constants.O_NOFOLLOW === 'number',
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
