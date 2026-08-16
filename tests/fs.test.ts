import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootBoundary, assertRelativeInput, extensionOf } from '@agent-tool-platform/runtime';

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
  } catch {
    symlinkSupported = false;
  }
  return { base, root, outside, symlinkSupported };
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

      const tiny = new RootBoundary({ root: tree.root, maxFileBytes: 2 });
      await expect(tiny.readFile(resolved)).rejects.toMatchObject({ code: 'limit_exceeded' });
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

  it('answers containment questions without throwing', async () => {
    const tree = await buildTree();
    try {
      const boundary = new RootBoundary({ root: tree.root });
      expect(boundary.isWithin(tree.root, join(tree.root, 'inside.txt'))).toBe(true);
      expect(boundary.isWithin(tree.root, join(tree.outside, 'secret.txt'))).toBe(false);
      expect(boundary.isWithin(tree.root, tree.root)).toBe(false);
      expect(boundary.isWithin(tree.root, tree.root, true)).toBe(true);
    } finally {
      await rm(tree.base, { recursive: true, force: true });
    }
  });
});
