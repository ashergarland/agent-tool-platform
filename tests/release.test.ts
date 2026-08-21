import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const developmentVersion = '0.0.0-development';
const runtimeName = '@agent-tool-platform/runtime';
const temporaryRoots: string[] = [];

interface VersionMetadata {
  readonly version: string;
  readonly dependencies?: Record<string, string>;
  readonly packages?: Record<string, VersionMetadata>;
}

const readJson = (root: string, path: string): VersionMetadata =>
  JSON.parse(readFileSync(join(root, path), 'utf8')) as VersionMetadata;

const releaseFiles = [
  'package.json',
  'package-lock.json',
  'packages/runtime/package.json',
  'packages/testkit/package.json',
  'examples/minimal-capability/package.json',
  'scripts/release-check.mjs',
  'scripts/stamp-release-version.mjs',
];

const createReleaseFixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'atp-release-'));
  temporaryRoots.push(root);
  for (const path of releaseFiles) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repositoryRoot, path), target);
  }
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release version stamping', () => {
  it('keeps checked-in metadata at one permanent development version', () => {
    const root = readJson(repositoryRoot, 'package.json');
    const runtime = readJson(repositoryRoot, 'packages/runtime/package.json');
    const testkit = readJson(repositoryRoot, 'packages/testkit/package.json');
    const fixture = readJson(repositoryRoot, 'examples/minimal-capability/package.json');
    const lock = readJson(repositoryRoot, 'package-lock.json');

    for (const manifest of [root, runtime, testkit, fixture]) {
      expect(manifest.version).toBe(developmentVersion);
    }
    expect(testkit.dependencies?.[runtimeName]).toBe(developmentVersion);
    expect(fixture.dependencies?.[runtimeName]).toBe(developmentVersion);
    expect(lock.version).toBe(developmentVersion);
    expect(lock.packages?.['']?.version).toBe(developmentVersion);
    expect(lock.packages?.['packages/runtime']?.version).toBe(developmentVersion);
    expect(lock.packages?.['packages/testkit']?.version).toBe(developmentVersion);
    expect(lock.packages?.['packages/testkit']?.dependencies?.[runtimeName]).toBe(
      developmentVersion,
    );
  });

  it('accepts the checked-in development state without a release bump', () => {
    const output = execFileSync(
      process.execPath,
      [join(repositoryRoot, 'scripts', 'release-check.mjs')],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    expect(output).toContain(`Development check passed for ${developmentVersion}`);
  });

  it('stamps an explicit release and passes the release check without changing the lockfile', () => {
    const root = createReleaseFixture();
    const lockBefore = readFileSync(join(root, 'package-lock.json'));

    const stampOutput = execFileSync(
      process.execPath,
      [join(root, 'scripts', 'stamp-release-version.mjs'), '1.2.3'],
      { cwd: root, encoding: 'utf8' },
    );

    const repository = readJson(root, 'package.json');
    const runtime = readJson(root, 'packages/runtime/package.json');
    const testkit = readJson(root, 'packages/testkit/package.json');
    const fixture = readJson(root, 'examples/minimal-capability/package.json');
    expect(stampOutput).toContain('Stamped release 1.2.3');
    expect(repository.version).toBe('1.2.3');
    expect(runtime.version).toBe('1.2.3');
    expect(testkit.version).toBe('1.2.3');
    expect(testkit.dependencies?.[runtimeName]).toBe('1.2.3');
    expect(fixture.version).toBe('1.2.3');
    expect(fixture.dependencies?.[runtimeName]).toBe('1.2.3');
    expect(readFileSync(join(root, 'package-lock.json'))).toEqual(lockBefore);

    const checkOutput = execFileSync(
      process.execPath,
      [join(root, 'scripts', 'release-check.mjs'), '1.2.3'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(checkOutput).toContain('Release check passed for 1.2.3');
    expect(checkOutput).toContain(`${runtimeName}@1.2.3`);
  });

  it.each(['v1.2.3', '1.2', '01.2.3', '1.2.3-alpha.01', developmentVersion])(
    'rejects invalid or reserved release version %s without mutation',
    (version) => {
      const root = createReleaseFixture();
      const before = readFileSync(join(root, 'package.json'));
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts', 'stamp-release-version.mjs'), version],
        { cwd: root, encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(root, 'package.json'))).toEqual(before);
    },
  );
});
