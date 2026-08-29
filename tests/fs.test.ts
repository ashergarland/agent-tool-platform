import { describe, expect, it } from 'vitest';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { RootBoundary, assertRelativeInput, extensionOf } from '@agent-tool-platform/runtime';
import { assertSameFileIdentity } from '../packages/runtime/src/fs/root-boundary.js';

interface Tree {
  readonly base: string;
  readonly root: string;
  readonly outside: string;
  readonly symlinkSupported: boolean;
}

const buildTree = async (): Promise<Tree> => {
  const base = await mkdtemp(join(tmpdir(), 'atp-fs-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'nested'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'inside.txt'), 'inside contents', 'utf8');
  await writeFile(join(root, 'nested', 'deep.txt'), 'deep', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
  let symlinkSupported = true;
  try {
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    await symlink(join(root, 'inside.txt'), join(root, 'inside-link.txt'));
  } catch (error) {
    if (process.env.ATP_SYMLINK_TESTS_REQUIRED === '1') {
      await rm(base, { recursive: true, force: true });
      throw error;
    }
    symlinkSupported = false;
  }
  return { base, root, outside, symlinkSupported };
};

const consume = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected a buffer stream');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

describe('path helpers', () => {
  it('extracts a lower-cased extension without treating a dotfile as one', () => {
    expect(extensionOf('a/b/File.TS')).toBe('.ts');
    expect(extensionOf('a/b/.gitignore')).toBe('');
    expect(extensionOf('a\\b\\thing')).toBe('');
  });

  it('rejects unacceptable inputs before touching the filesystem', () => {
    expect(() => assertRelativeInput('')).toThrow(/must not be empty/u);
    expect(() => assertRelativeInput('a\0b')).toThrow(/NUL/u);
    expect(() => assertRelativeInput('//server/share')).toThrow(/UNC/u);
    expect(() => assertRelativeInput('/etc/passwd')).toThrow(/relative/u);
    expect(() => assertRelativeInput('C:\\Windows')).toThrow(/relative/u);
    expect(() => assertRelativeInput('nested/deep.txt')).not.toThrow();
  });
});

describe('RootBoundary', () => {
  it('resolves an in-root path to a POSIX relative path', async () => {
    const tree = await buildTree();
    try {
      const boundary = new RootBoundary({ root: tree.root });
      const resolved = await boundary.resolve('nested/deep.txt');
      expect(resolved.relativePath).toBe('nested/deep.txt');
      expect(resolved.realPath).toContain('deep.txt');
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('denies traversal, absolute escape, and symlink escape', async () => {
    const tree = await buildTree();
    try {
      const boundary = new RootBoundary({ root: tree.root });
      await expect(boundary.resolve('../outside/secret.txt')).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(boundary.openFile('../outside/secret.txt')).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(boundary.resolve(join(tree.outside, 'secret.txt'))).rejects.toMatchObject({
        code: 'bad_request',
      });
      if (tree.symlinkSupported) {
        await expect(boundary.resolve('escape.txt')).rejects.toMatchObject({ code: 'forbidden' });
      }
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('distinguishes a missing path from a denied one', async () => {
    const tree = await buildTree();
    try {
      const boundary = new RootBoundary({ root: tree.root });
      await expect(boundary.resolve('missing.txt')).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('refuses the root itself unless the capability allows it', async () => {
    const tree = await buildTree();
    try {
      await expect(new RootBoundary({ root: tree.root }).resolve('.')).rejects.toMatchObject({
        code: 'forbidden',
      });
      const permissive = new RootBoundary({ root: tree.root, allowRoot: true });
      expect((await permissive.resolve('.')).relativePath).toBe('.');
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('optionally requires a regular file and enforces a size ceiling', async () => {
    const tree = await buildTree();
    try {
      const strict = new RootBoundary({
        root: tree.root,
        requireRegularFile: true,
        maxFileBytes: 4,
      });
      await expect(strict.resolve('nested')).rejects.toMatchObject({ code: 'bad_request' });
      await expect(strict.resolve('inside.txt')).rejects.toMatchObject({
        code: 'limit_exceeded',
      });
      await expect(strict.resolve('nested/deep.txt')).resolves.toMatchObject({
        relativePath: 'nested/deep.txt',
      });
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('reads a resolved file and re-checks its size on the descriptor', async () => {
    const tree = await buildTree();
    try {
      const boundary = new RootBoundary({ root: tree.root, maxFileBytes: 1024 });
      const resolved = await boundary.resolve('inside.txt');
      const read = await boundary.readFile(resolved);
      expect(read.text).toBe('inside contents');
      expect(read.bytes).toBe(15);
      await expect(boundary.readFile('inside.txt')).resolves.toEqual(read);

      const tiny = new RootBoundary({ root: tree.root, maxFileBytes: 2 });
      await expect(tiny.readFile(resolved)).rejects.toMatchObject({ code: 'limit_exceeded' });
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('opens metadata, a bounded preview, and a full descriptor-backed stream', async () => {
    const tree = await buildTree();
    try {
      const contents = Buffer.from('0123456789'.repeat(10_000));
      await writeFile(join(tree.root, 'large.txt'), contents);
      const opened = await new RootBoundary({ root: tree.root }).openFile('large.txt', {
        previewBytes: 13,
      });

      expect(opened.relativePath).toBe('large.txt');
      expect(opened.sizeBytes).toBe(contents.byteLength);
      expect(opened.preview).toEqual(contents.subarray(0, 13));
      expect(opened.preview.byteLength).toBeLessThan(opened.sizeBytes);
      await expect(consume(opened.createReadStream({ highWaterMark: 257 }))).resolves.toEqual(
        contents,
      );

      await Promise.all([opened.close(), opened.close()]);
      await expect(opened.close()).resolves.toBeUndefined();
      expect(() => opened.createReadStream()).toThrow(/closed/u);
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('keeps preview and stream attached to the opened object after its path is replaced', async () => {
    const tree = await buildTree();
    try {
      const original = Buffer.from('original descriptor contents');
      const path = join(tree.root, 'changing.txt');
      await writeFile(path, original);
      const opened = await new RootBoundary({ root: tree.root }).openFile('changing.txt', {
        previewBytes: 8,
      });

      await rename(path, join(tree.root, 'moved.txt'));
      await writeFile(path, 'replacement');

      expect(opened.preview).toEqual(original.subarray(0, 8));
      await expect(consume(opened.createReadStream())).resolves.toEqual(original);
      await opened.close();
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('enforces descriptor size and regular-file requirements when opening', async () => {
    const tree = await buildTree();
    try {
      const boundary = new RootBoundary({ root: tree.root, maxFileBytes: 15 });
      const accepted = await boundary.openFile('inside.txt', { previewBytes: 4 });
      expect(accepted).toMatchObject({ sizeBytes: 15 });
      await accepted.close();

      await appendFile(join(tree.root, 'inside.txt'), '!');
      await expect(boundary.openFile('inside.txt')).rejects.toMatchObject({
        code: 'limit_exceeded',
      });
      await expect(boundary.openFile('nested')).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('rejects final symlinks and symlink escapes when opening', async () => {
    const tree = await buildTree();
    try {
      if (!tree.symlinkSupported) return;
      const boundary = new RootBoundary({ root: tree.root });
      await expect(boundary.openFile('inside-link.txt')).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(boundary.openFile('escape.txt')).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('streams an empty opened file and validates preview bounds', async () => {
    const tree = await buildTree();
    try {
      await writeFile(join(tree.root, 'empty.txt'), '');
      const boundary = new RootBoundary({ root: tree.root });
      const opened = await boundary.openFile('empty.txt');
      expect(opened.sizeBytes).toBe(0);
      expect(opened.preview).toEqual(Buffer.alloc(0));
      await expect(consume(opened.createReadStream())).resolves.toEqual(Buffer.alloc(0));
      await opened.close();

      await expect(boundary.openFile('empty.txt', { previewBytes: -1 })).rejects.toMatchObject({
        code: 'bad_request',
      });
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('keeps the confined handle usable after a stream is cancelled', async () => {
    const tree = await buildTree();
    try {
      const contents = Buffer.from('cancel-safe-stream'.repeat(1000));
      await writeFile(join(tree.root, 'cancel.txt'), contents);
      const opened = await new RootBoundary({ root: tree.root }).openFile('cancel.txt');
      const controller = new AbortController();
      const cancelled = opened.createReadStream({
        highWaterMark: 16,
        signal: controller.signal,
      });
      cancelled.once('data', () => controller.abort());

      await expect(consume(cancelled)).rejects.toMatchObject({ name: 'AbortError' });
      await expect(consume(opened.createReadStream({ highWaterMark: 31 }))).resolves.toEqual(
        contents,
      );
      await opened.close();
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('reports status without throwing for an unusable or absent root', async () => {
    const tree = await buildTree();
    try {
      expect(await new RootBoundary({ root: tree.root }).status()).toEqual({
        usable: true,
        configured: true,
      });

      expect(await new RootBoundary({ root: undefined }).status()).toMatchObject({
        usable: false,
        configured: false,
      });
      expect(await new RootBoundary({ root: join(tree.base, 'nowhere') }).status()).toMatchObject({
        usable: false,
        configured: true,
        reason: 'root_unusable',
      });
      expect(
        await new RootBoundary({ root: join(tree.root, 'inside.txt') }).status(),
      ).toMatchObject({ usable: false, reason: 'root_unusable' });
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it('throws not_ready when no root is configured', async () => {
    await expect(new RootBoundary({ root: undefined }).resolve('a.txt')).rejects.toMatchObject({
      code: 'not_ready',
    });
  });

  describe('opened file identity', () => {
    it('accepts matching identities and fails closed for changes or unsupported metadata', () => {
      expect(() =>
        assertSameFileIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 2n }),
      ).not.toThrow();
      expect(() => assertSameFileIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 3n })).toThrow(
        /changed/u,
      );
      expect(() => assertSameFileIdentity({ dev: 1n, ino: 0n }, { dev: 1n, ino: 0n })).toThrow(
        /cannot be verified/u,
      );
    });
  });

  it('answers containment questions without throwing', async () => {
    const tree = await buildTree();
    try {
      const boundary = new RootBoundary({ root: tree.root });
      expect(boundary.isWithin(tree.root, join(tree.root, 'inside.txt'))).toBe(true);
      expect(boundary.isWithin(tree.root, join(tree.outside, 'secret.txt'))).toBe(false);
      expect(boundary.isWithin(tree.root, tree.root)).toBe(false);
      expect(boundary.isWithin(tree.root, tree.root, true)).toBe(true);
      if (process.platform === 'win32') {
        expect(boundary.isWithin(tree.root, join(tree.base, 'ROOT', 'secret.txt'))).toBe(false);
        await expect(boundary.openFile('../ROOT/inside.txt')).rejects.toMatchObject({
          code: 'forbidden',
        });
      }
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'uses non-zero matching Windows descriptor and path identity',
    async () => {
      const tree = await buildTree();
      const path = join(tree.root, 'inside.txt');
      const handle = await open(path, 'r');
      try {
        const descriptor = await handle.stat({ bigint: true });
        const addressed = await lstat(path, { bigint: true });
        expect(descriptor.dev).not.toBe(0n);
        expect(descriptor.ino).not.toBe(0n);
        expect(addressed.dev).toBe(descriptor.dev);
        expect(addressed.ino).toBe(descriptor.ino);

        // A successful RootBoundary open proves the same identity passed its internal fail-closed
        // descriptor/path checks before the handle was returned.
        const confined = await new RootBoundary({ root: tree.root }).openFile('inside.txt');
        await confined.close();
      } finally {
        await handle.close();
        await rm(tree.base, { recursive: true, force: true });
      }
    },
  );
});
