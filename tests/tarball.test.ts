import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

interface TarEntry {
  readonly path: string;
  readonly contents?: Buffer | string;
  readonly mode?: number;
  readonly type?: string;
}

interface TarballHelpers {
  readonly extractTarball: (tarballPath: string, destination: string) => string[];
  readonly packageContentIdentity: (tarballPath: string) => string;
}

const temporaryRoots: string[] = [];

const loadHelpers = async (): Promise<TarballHelpers> =>
  (await import(
    pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'lib', 'tarball.mjs')).href
  )) as TarballHelpers;

const octal = (value: number, length: number): Buffer =>
  Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');

const tarHeader = ({ path, contents = '', mode = 0o644, type = '0' }: TarEntry): Buffer => {
  const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  octal(mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(body.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148);
  return header;
};

const createTarball = (root: string, name: string, entries: readonly TarEntry[]): string => {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents ?? '');
    blocks.push(tarHeader(entry), contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  const path = join(root, name);
  writeFileSync(path, gzipSync(Buffer.concat(blocks)));
  return path;
};

const sri = (path: string): string =>
  `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('platform-neutral package content identity', () => {
  it('ignores archive mode metadata while exact tarball integrity remains different', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atp-tarball-mode-'));
    temporaryRoots.push(root);
    const files: readonly TarEntry[] = [
      { path: 'package/package.json', contents: '{"name":"fixture","version":"1.0.0"}\n' },
      { path: 'package/bin/tool.js', contents: '#!/usr/bin/env node\nconsole.log("ok");\n' },
    ];
    const windows = createTarball(
      root,
      'windows.tgz',
      files.map((entry) => ({ ...entry, mode: 0o644 })),
    );
    const linux = createTarball(
      root,
      'linux.tgz',
      files.map((entry) => ({
        ...entry,
        mode: entry.path.includes('/bin/') ? 0o755 : 0o644,
      })),
    );
    const { packageContentIdentity } = await loadHelpers();

    expect(sri(windows)).not.toBe(sri(linux));
    expect(packageContentIdentity(windows)).toBe(packageContentIdentity(linux));
    expect(packageContentIdentity(linux)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('sorts normalized paths but detects every package payload change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atp-tarball-content-'));
    temporaryRoots.push(root);
    const { packageContentIdentity } = await loadHelpers();
    const baselineEntries: readonly TarEntry[] = [
      { path: 'package/package.json', contents: '{"name":"fixture","version":"1.0.0"}\n' },
      { path: 'package/dist/index.js', contents: 'export const value = 1;\n' },
    ];
    const baseline = createTarball(root, 'baseline.tgz', baselineEntries);
    const reorderedAndSeparated = createTarball(root, 'reordered.tgz', [
      { path: 'package\\dist\\index.js', contents: 'export const value = 1;\n' },
      baselineEntries[0]!,
    ]);
    const variants = [
      createTarball(root, 'added.tgz', [
        ...baselineEntries,
        { path: 'package/README.md', contents: '# Fixture\n' },
      ]),
      createTarball(root, 'removed.tgz', [baselineEntries[0]!]),
      createTarball(root, 'renamed.tgz', [
        baselineEntries[0]!,
        { path: 'package/dist/main.js', contents: 'export const value = 1;\n' },
      ]),
      createTarball(root, 'manifest-change.tgz', [
        { path: 'package/package.json', contents: '{"name":"fixture","version":"1.0.1"}\n' },
        baselineEntries[1]!,
      ]),
      createTarball(root, 'generated-change.tgz', [
        baselineEntries[0]!,
        { path: 'package/dist/index.js', contents: 'export const value = 2;\n' },
      ]),
    ];

    const baselineIdentity = packageContentIdentity(baseline);
    expect(packageContentIdentity(reorderedAndSeparated)).toBe(baselineIdentity);
    for (const variant of variants) {
      expect(packageContentIdentity(variant)).not.toBe(baselineIdentity);
    }
  });
});

describe('safe npm tarball extraction', () => {
  it('extracts regular package files beneath the destination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atp-tarball-extract-'));
    temporaryRoots.push(root);
    const tarball = createTarball(root, 'valid.tgz', [
      { path: 'package/package.json', contents: '{"name":"fixture"}\n' },
      { path: 'package/dist/index.js', contents: 'export {};\n' },
    ]);
    const destination = join(root, 'extract');
    const { extractTarball } = await loadHelpers();

    expect(extractTarball(tarball, destination)).toEqual(['package.json', 'dist/index.js']);
    expect(readFileSync(join(destination, 'dist', 'index.js'), 'utf8')).toBe('export {};\n');
  });

  it.each([
    ['parent traversal into a same-prefix sibling', 'package/../extract-escape.txt'],
    ['backslash parent traversal', 'package\\..\\extract-escape.txt'],
    ['POSIX absolute path', '/absolute.txt'],
    ['Windows absolute path', 'C:\\absolute.txt'],
    ['non-package root', 'other/file.txt'],
  ])('rejects %s', async (_label, path) => {
    const root = mkdtempSync(join(tmpdir(), 'atp-tarball-reject-'));
    temporaryRoots.push(root);
    const tarball = createTarball(root, 'unsafe.tgz', [{ path, contents: 'unsafe' }]);
    const destination = join(root, 'extract');
    const { extractTarball } = await loadHelpers();

    expect(() => extractTarball(tarball, destination)).toThrow();
    expect(existsSync(join(root, 'extract-escape.txt'))).toBe(false);
  });

  it('rejects dangerous entry types and duplicate normalized file paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atp-tarball-types-'));
    temporaryRoots.push(root);
    const symlink = createTarball(root, 'symlink.tgz', [{ path: 'package/link', type: '2' }]);
    const duplicate = createTarball(root, 'duplicate.tgz', [
      { path: 'package/dist/index.js', contents: 'first' },
      { path: 'package\\dist\\index.js', contents: 'second' },
    ]);
    const { extractTarball, packageContentIdentity } = await loadHelpers();

    expect(() => extractTarball(symlink, join(root, 'symlink-output'))).toThrow(
      /unsupported tar entry type/u,
    );
    expect(() => packageContentIdentity(duplicate)).toThrow(/duplicate package file/u);
  });
});
