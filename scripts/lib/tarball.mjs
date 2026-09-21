import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Tarball helpers for the package smoke test.
 *
 * The smoke test has to answer one question: what does an external consumer actually receive? The
 * only honest source of truth is the artefact `npm publish` would upload, so these helpers pack a
 * real tarball and unpack it with a self-contained reader rather than trusting `dist/` on disk or
 * shelling out to a `tar` binary that is not guaranteed to exist on every runner.
 */

/**
 * Runs npm without a shell.
 *
 * npm scripts export `npm_execpath`, which is npm's own JavaScript entry point, so the child can be
 * started with the current Node binary. That avoids `.cmd` shims, which Node refuses to spawn
 * without a shell on Windows, and avoids a shell interpreting any argument. When the script is run
 * directly rather than through `npm run`, npm's CLI is located next to the Node binary instead.
 */
export const npmCliPath = () => {
  const fromScript = process.env.npm_execpath;
  if (fromScript && fromScript.endsWith('.js')) return fromScript;
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
};

export const npmCommand = (args, options) => {
  const cli = npmCliPath();
  if (cli) return execFileSync(process.execPath, [cli, ...args], options);
  return execFileSync('npm', args, { ...options, shell: process.platform === 'win32' });
};

const trimNulls = (value) => value.replace(/\0.*$/u, '');

const headerString = (header, start, length) =>
  trimNulls(header.subarray(start, start + length).toString('utf8'));

const paxPath = (block) => {
  let offset = 0;
  let path;
  while (offset < block.length) {
    const separator = block.indexOf(0x20, offset);
    if (separator < 0) throw new Error('malformed PAX record: missing length separator');
    const lengthText = block.subarray(offset, separator).toString('ascii');
    if (!/^[1-9]\d*$/u.test(lengthText)) {
      throw new Error(`malformed PAX record length ${JSON.stringify(lengthText)}`);
    }
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > block.length || block[end - 1] !== 0x0a) {
      throw new Error(`malformed PAX record with declared length ${lengthText}`);
    }
    const record = block.subarray(separator + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 1) throw new Error(`malformed PAX record ${JSON.stringify(record)}`);
    if (record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    offset = end;
  }
  return path;
};

const packagePath = (entryName, type, tarballPath) => {
  if (entryName.includes('\0')) {
    throw new Error(`tar entry path contains a null byte in ${tarballPath}`);
  }
  const normalized = entryName.replace(/\\/gu, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`tar entry ${entryName} is absolute`);
  }

  const withoutTrailingSlash = type === '5' ? normalized.replace(/\/+$/u, '') : normalized;
  const segments = withoutTrailingSlash.split('/');
  if (
    segments.length === 0 ||
    segments[0] !== 'package' ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`tar entry ${entryName} is outside the npm package payload`);
  }

  const path = segments.slice(1).join('/');
  if (type === '0' && path === '') {
    throw new Error(`tar entry ${entryName} has no package-relative file path`);
  }
  return path;
};

const tarNumber = (header, start, length, field, tarballPath) => {
  const value = headerString(header, start, length).trim();
  if (value === '') return 0;
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`tar entry has invalid ${field} ${JSON.stringify(value)} in ${tarballPath}`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `tar entry has unsupported ${field} ${JSON.stringify(value)} in ${tarballPath}`,
    );
  }
  return parsed;
};

const readPackageFiles = (tarballPath) => {
  const buffer = gunzipSync(readFileSync(tarballPath));
  const files = [];
  const seen = new Set();
  let offset = 0;
  let overrideName;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;

    const prefix = headerString(header, 345, 155);
    const base = headerString(header, 0, 100);
    const name = overrideName ?? (prefix ? `${prefix}/${base}` : base);
    overrideName = undefined;

    const size = tarNumber(header, 124, 12, 'size', tarballPath);
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > buffer.length) {
      throw new Error(`tar entry ${name} is truncated in ${tarballPath}`);
    }
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]);
    const body = buffer.subarray(offset, offset + size);
    offset += paddedSize;

    if (type === 'x') {
      overrideName = paxPath(body);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      overrideName = trimNulls(body.toString('utf8'));
      continue;
    }
    if (type !== '0' && type !== '5') {
      throw new Error(`unsupported tar entry type ${type} for ${name} in ${tarballPath}`);
    }

    const path = packagePath(name, type, tarballPath);
    if (type === '5') continue;
    if (seen.has(path)) throw new Error(`duplicate package file ${path} in ${tarballPath}`);
    seen.add(path);
    files.push({ path, contents: Buffer.from(body) });
  }

  return files;
};

/**
 * Hashes the regular files an npm package consumer receives.
 *
 * The v1 framing is a fixed domain separator and file count followed by each UTF-8 path length,
 * path, unsigned 64-bit file length, and exact file bytes. Paths use `/` and are sorted by
 * JavaScript's deterministic code-unit ordering. Archive metadata, including executable mode,
 * timestamps, uid/gid, and gzip headers, is deliberately excluded.
 */
export const packageContentIdentity = (tarballPath) => {
  const files = readPackageFiles(tarballPath).sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const hash = createHash('sha256');
  hash.update('agent-tool-platform-package-content-v1\0', 'utf8');
  const count = Buffer.alloc(4);
  count.writeUInt32BE(files.length);
  hash.update(count);

  for (const file of files) {
    const path = Buffer.from(file.path, 'utf8');
    if (path.length > 0xffffffff) {
      throw new Error(`package path is too long to frame: ${file.path}`);
    }
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(path.length);
    const fileLength = Buffer.alloc(8);
    fileLength.writeBigUInt64BE(BigInt(file.contents.length));
    hash.update(pathLength);
    hash.update(path);
    hash.update(fileLength);
    hash.update(file.contents);
  }

  return `sha256:${hash.digest('hex')}`;
};

const packedArtifact = (output, destination) => {
  const start = output.indexOf('[');
  if (start < 0) throw new Error('npm pack returned non-JSON output');
  const parsed = JSON.parse(output.slice(start));
  const entry = parsed[0];
  if (typeof entry?.filename !== 'string' || entry.filename.length === 0) {
    throw new Error('npm pack returned no tarball filename');
  }
  const tarball = join(destination, entry.filename);
  return {
    tarball,
    files: (entry.files ?? []).map((file) => file.path.replace(/\\/gu, '/')),
    integrity: entry.integrity,
    shasum: entry.shasum,
    size: entry.size,
    contentIdentity: packageContentIdentity(tarball),
  };
};

/**
 * Packs a workspace package and returns both exact-archive and platform-neutral identities.
 */
export const packPackage = (packageDir, destination) => {
  const output = npmCommand(['pack', '--json', '--pack-destination', destination], {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return packedArtifact(output, destination);
};

/**
 * Downloads an npm package specification as the registry serves it.
 */
export const packPackageSpec = (spec, destination, cwd = process.cwd()) => {
  const output = npmCommand(['pack', spec, '--json', '--pack-destination', destination], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return packedArtifact(output, destination);
};

/**
 * Extracts an npm tarball, stripping the leading `package/` directory npm always adds.
 *
 * Only the entry kinds npm produces are handled: regular files, directories, and the long-path
 * headers node-tar emits. Anything else is a signal the artefact is not what we think it is, so it
 * fails loudly instead of being skipped quietly.
 */
export const extractTarball = (tarballPath, destinationDir) => {
  const destination = resolve(destinationDir);
  const files = readPackageFiles(tarballPath);
  const written = [];

  for (const file of files) {
    const target = resolve(destination, ...file.path.split('/'));
    const containment = relative(destination, target);
    if (
      containment === '' ||
      containment === '..' ||
      containment.startsWith(`..${sep}`) ||
      isAbsolute(containment)
    ) {
      throw new Error(`tar entry ${file.path} escapes the extraction directory`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents);
    written.push(file.path);
  }

  return written;
};
