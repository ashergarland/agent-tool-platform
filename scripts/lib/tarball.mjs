import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
const npmCliPath = () => {
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

/**
 * Packs a workspace package and returns the tarball path plus the file list npm reports.
 */
export const packPackage = (packageDir, destination) => {
  const output = npmCommand(['pack', '--json', '--pack-destination', destination], {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output.slice(output.indexOf('[')));
  const entry = parsed[0];
  return {
    tarball: join(destination, entry.filename),
    files: (entry.files ?? []).map((file) => file.path.replace(/\\/gu, '/')),
  };
};

const trimNulls = (value) => value.replace(/\0.*$/u, '');

const headerString = (header, start, length) =>
  trimNulls(header.subarray(start, start + length).toString('utf8'));

const paxPath = (block) => {
  const text = block.toString('utf8');
  for (const record of text.split('\n')) {
    const match = /^\d+ path=(.*)$/u.exec(record);
    if (match) return match[1];
  }
  return undefined;
};

/**
 * Extracts an npm tarball, stripping the leading `package/` directory npm always adds.
 *
 * Only the entry kinds npm produces are handled: regular files, directories, and the long-path
 * headers node-tar emits. Anything else is a signal the artefact is not what we think it is, so it
 * fails loudly instead of being skipped quietly.
 */
export const extractTarball = (tarballPath, destinationDir) => {
  const buffer = gunzipSync(readFileSync(tarballPath));
  const destination = resolve(destinationDir);
  const written = [];
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

    const size = Number.parseInt(headerString(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]);
    const body = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (type === 'x' || type === 'g' || type === 'L') {
      overrideName = type === 'L' ? trimNulls(body.toString('utf8')) : paxPath(body);
      continue;
    }
    if (type === '5') continue;
    if (type !== '0') {
      throw new Error(`unsupported tar entry type ${type} for ${name} in ${tarballPath}`);
    }

    const relative = name.replace(/^package\//u, '');
    const target = resolve(destination, relative);
    if (!target.startsWith(destination)) {
      throw new Error(`tar entry ${name} escapes the extraction directory`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    written.push(relative);
  }

  return written;
};
