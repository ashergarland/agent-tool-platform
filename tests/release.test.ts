import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const developmentVersion = '0.0.0-development';
const runtimeName = '@agent-tool-platform/runtime';
const capabilityRegistryName = '@agent-tool-platform/capability-registry';
const temporaryRoots: string[] = [];

interface VersionMetadata {
  version: string;
  private?: boolean;
  registryVersion?: string;
  dependencies?: Record<string, string>;
  readonly packages?: Record<string, VersionMetadata>;
}

const readJson = (root: string, path: string): VersionMetadata =>
  JSON.parse(readFileSync(join(root, path), 'utf8')) as VersionMetadata;

const releaseFiles = [
  'package.json',
  'package-lock.json',
  'packages/agent-kit/package.json',
  'packages/capability-registry/package.json',
  'packages/capability-registry/data/first-party-registry.json',
  'packages/runtime/package.json',
  'packages/testkit/package.json',
  'examples/minimal-capability/package.json',
  'scripts/lib/tarball.mjs',
  'scripts/release-check.mjs',
  'scripts/release-registry-state.mjs',
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
  for (const path of [
    'package.json',
    'packages/agent-kit/package.json',
    'packages/capability-registry/package.json',
    'packages/runtime/package.json',
    'packages/testkit/package.json',
    'examples/minimal-capability/package.json',
  ]) {
    const manifest = readJson(root, path);
    manifest.version = developmentVersion;
    if (manifest.dependencies?.[runtimeName]) {
      manifest.dependencies[runtimeName] = developmentVersion;
    }
    if (manifest.dependencies?.[capabilityRegistryName]) {
      manifest.dependencies[capabilityRegistryName] = developmentVersion;
    }
    if (
      path === 'packages/agent-kit/package.json' ||
      path === 'packages/capability-registry/package.json'
    ) {
      manifest.private = true;
    }
    writeFileSync(join(root, path), `${JSON.stringify(manifest, undefined, 2)}\n`);
  }
  const registry = readJson(root, 'packages/capability-registry/data/first-party-registry.json');
  registry.registryVersion = developmentVersion;
  writeFileSync(
    join(root, 'packages/capability-registry/data/first-party-registry.json'),
    `${JSON.stringify(registry, undefined, 2)}\n`,
  );
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release version stamping', () => {
  it('uses release metadata only when the release workflow supplies a version', () => {
    const root = readJson(repositoryRoot, 'package.json');
    const agentKit = readJson(repositoryRoot, 'packages/agent-kit/package.json');
    const capabilityRegistry = readJson(
      repositoryRoot,
      'packages/capability-registry/package.json',
    );
    const registryData = readJson(
      repositoryRoot,
      'packages/capability-registry/data/first-party-registry.json',
    );
    const runtime = readJson(repositoryRoot, 'packages/runtime/package.json');
    const testkit = readJson(repositoryRoot, 'packages/testkit/package.json');
    const fixture = readJson(repositoryRoot, 'examples/minimal-capability/package.json');
    const lock = readJson(repositoryRoot, 'package-lock.json');

    const expectedVersion = process.env.RELEASE_VERSION ?? developmentVersion;
    for (const manifest of [root, agentKit, capabilityRegistry, runtime, testkit, fixture]) {
      expect(manifest.version).toBe(expectedVersion);
    }
    expect(agentKit.dependencies?.[runtimeName]).toBe(expectedVersion);
    expect(agentKit.dependencies?.[capabilityRegistryName]).toBe(expectedVersion);
    expect(agentKit.private).toBe(expectedVersion === developmentVersion ? true : undefined);
    expect(capabilityRegistry.private).toBe(
      expectedVersion === developmentVersion ? true : undefined,
    );
    expect(registryData.registryVersion).toBe(expectedVersion);
    expect(testkit.dependencies?.[runtimeName]).toBe(expectedVersion);
    expect(fixture.dependencies?.[runtimeName]).toBe(expectedVersion);
    expect(lock.version).toBe(developmentVersion);
    expect(lock.packages?.['']?.version).toBe(developmentVersion);
    expect(lock.packages?.['packages/agent-kit']?.version).toBe(developmentVersion);
    expect(lock.packages?.['packages/agent-kit']?.dependencies?.[runtimeName]).toBe(
      developmentVersion,
    );
    expect(lock.packages?.['packages/agent-kit']?.dependencies?.[capabilityRegistryName]).toBe(
      developmentVersion,
    );
    expect(lock.packages?.['packages/capability-registry']?.version).toBe(developmentVersion);
    expect(lock.packages?.['packages/runtime']?.version).toBe(developmentVersion);
    expect(lock.packages?.['packages/testkit']?.version).toBe(developmentVersion);
    expect(lock.packages?.['packages/testkit']?.dependencies?.[runtimeName]).toBe(
      developmentVersion,
    );
  });

  it('accepts development state normally and stamped state during a release', () => {
    const releaseVersion = process.env.RELEASE_VERSION;
    const output = execFileSync(
      process.execPath,
      [
        join(repositoryRoot, 'scripts', 'release-check.mjs'),
        ...(releaseVersion ? [releaseVersion] : []),
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    expect(output).toContain(
      releaseVersion
        ? `Release check passed for ${releaseVersion}`
        : `Development check passed for ${developmentVersion}`,
    );
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
    const agentKit = readJson(root, 'packages/agent-kit/package.json');
    const capabilityRegistry = readJson(root, 'packages/capability-registry/package.json');
    const registryData = readJson(
      root,
      'packages/capability-registry/data/first-party-registry.json',
    );
    const runtime = readJson(root, 'packages/runtime/package.json');
    const testkit = readJson(root, 'packages/testkit/package.json');
    const fixture = readJson(root, 'examples/minimal-capability/package.json');
    expect(stampOutput).toContain('Stamped release 1.2.3');
    expect(repository.version).toBe('1.2.3');
    expect(agentKit.version).toBe('1.2.3');
    expect(agentKit.dependencies?.[runtimeName]).toBe('1.2.3');
    expect(agentKit.dependencies?.[capabilityRegistryName]).toBe('1.2.3');
    expect(agentKit.private).toBeUndefined();
    expect(capabilityRegistry.version).toBe('1.2.3');
    expect(capabilityRegistry.private).toBeUndefined();
    expect(registryData.registryVersion).toBe('1.2.3');
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
    expect(checkOutput).toContain(`${capabilityRegistryName}@1.2.3`);
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

describe('release registry state', () => {
  const releaseCommit = 'a'.repeat(40);
  const version = '1.2.3';
  const stateScript = join(repositoryRoot, 'scripts', 'release-registry-state.mjs');
  const statePackages = [
    ['@agent-tool-platform/runtime', 'packages/runtime', {}],
    ['@agent-tool-platform/capability-registry', 'packages/capability-registry', {}],
    [
      '@agent-tool-platform/agent-kit',
      'packages/agent-kit',
      {
        '@agent-tool-platform/runtime': version,
        '@agent-tool-platform/capability-registry': version,
      },
    ],
    [
      '@agent-tool-platform/testkit',
      'packages/testkit',
      { '@agent-tool-platform/runtime': version },
    ],
  ] as const;
  const contentIdentity = `sha256:${'1'.repeat(64)}`;
  const packageMetadata = (
    directory: string,
    dependencies: Record<string, string> = {},
  ): Record<string, unknown> => ({
    version,
    gitHead: releaseCommit,
    repository: {
      type: 'git',
      url: 'git+https://github.com/ashergarland/agent-tool-platform.git',
      directory,
    },
    dependencies,
    'dist.integrity': 'sha512-release-fixture',
  });
  const runState = (
    metadata: Record<string, unknown>,
    options: {
      readonly verification?: 'exact-artifact' | 'package-content';
      readonly localContentIdentity?: string;
      readonly publishedContentIdentity?: string;
    } = {},
  ) => {
    const root = mkdtempSync(join(tmpdir(), 'atp-registry-state-'));
    temporaryRoots.push(root);
    const fixture = join(root, 'registry.json');
    const packageNames = statePackages.map(([name]) => name);
    writeFileSync(
      fixture,
      `${JSON.stringify({
        registry: metadata,
        localIntegrities: Object.fromEntries(
          packageNames.map((name) => [name, 'sha512-release-fixture']),
        ),
        localContentIdentities: Object.fromEntries(
          packageNames.map((name) => [name, options.localContentIdentity ?? contentIdentity]),
        ),
        publishedContentIdentities: Object.fromEntries(
          packageNames.map((name) => [name, options.publishedContentIdentity ?? contentIdentity]),
        ),
      })}\n`,
    );
    return spawnSync(
      process.execPath,
      [
        stateScript,
        version,
        releaseCommit,
        '--verification',
        options.verification ?? 'exact-artifact',
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, ATP_RELEASE_REGISTRY_FIXTURE: fixture },
      },
    );
  };

  it.each(Array.from({ length: 16 }, (_, mask) => mask.toString(2).padStart(4, '0')))(
    'classifies Registry presence subset %s',
    (presence) => {
      const metadata = Object.fromEntries(
        statePackages.flatMap(([name, directory, dependencies], index) =>
          presence[index] === '1' ? [[name, packageMetadata(directory, dependencies)]] : [],
        ),
      );
      const result = runState(metadata);
      const validPrefixes = new Set(['0000', '1000', '1100', '1110', '1111']);

      if (!validPrefixes.has(presence)) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Unsafe release state');
        return;
      }

      const publishedCount = presence.replace(/0/gu, '').length;
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('verification=exact-artifact');
      expect(result.stdout).toContain(`published_count=${publishedCount}`);
      expect(result.stdout).toContain(
        `state=${publishedCount === 0 ? 'absent' : publishedCount === 4 ? 'complete' : 'partial'}`,
      );
    },
  );

  it('refuses wrong-source and inconsistent dependency states', () => {
    const wrongSource = packageMetadata('packages/runtime');
    wrongSource.gitHead = 'b'.repeat(40);
    const sourceResult = runState({
      '@agent-tool-platform/runtime': wrongSource,
    });
    expect(sourceResult.status).not.toBe(0);
    expect(sourceResult.stderr).toContain('expected');

    const wrongDependency = runState({
      '@agent-tool-platform/runtime': packageMetadata('packages/runtime'),
      '@agent-tool-platform/capability-registry': packageMetadata('packages/capability-registry'),
      '@agent-tool-platform/agent-kit': packageMetadata('packages/agent-kit', {
        '@agent-tool-platform/runtime': developmentVersion,
        '@agent-tool-platform/capability-registry': version,
      }),
    });
    expect(wrongDependency.status).not.toBe(0);
    expect(wrongDependency.stderr).toContain('unexpected internal dependency');

    const wrongIntegrity = packageMetadata('packages/runtime');
    wrongIntegrity['dist.integrity'] = 'sha512-different-artifact';
    const integrityResult = runState({
      '@agent-tool-platform/runtime': wrongIntegrity,
    });
    expect(integrityResult.status).not.toBe(0);
    expect(integrityResult.stderr).toContain('tagged candidate integrity');
  });

  it('keeps exact SRI strict while explicit package-content verification ignores archive-only drift', () => {
    const runtime = packageMetadata('packages/runtime');
    runtime['dist.integrity'] = 'sha512-platform-specific-archive';

    const exact = runState({ '@agent-tool-platform/runtime': runtime });
    expect(exact.status).not.toBe(0);
    expect(exact.stderr).toContain('tagged candidate integrity');

    const content = runState(
      { '@agent-tool-platform/runtime': runtime },
      { verification: 'package-content' },
    );
    expect(content.status).toBe(0);
    expect(content.stdout).toContain('verification=package-content');
    expect(content.stdout).toContain(`runtime_content_identity=${contentIdentity}`);

    const changedContent = runState(
      { '@agent-tool-platform/runtime': runtime },
      {
        verification: 'package-content',
        publishedContentIdentity: `sha256:${'2'.repeat(64)}`,
      },
    );
    expect(changedContent.status).not.toBe(0);
    expect(changedContent.stderr).toContain('platform-neutral package content identity');
  });

  it('rejects package-content verification from an unstamped or unbuilt checkout', () => {
    const root = createReleaseFixture();
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'scripts', 'release-registry-state.mjs'),
        version,
        releaseCommit,
        '--verification',
        'package-content',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ATP_RELEASE_REGISTRY_FIXTURE: '' },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Package-content verification requires a stamped, built local release candidate',
    );
    expect(result.stderr).toContain(`${runtimeName} has local version ${developmentVersion}`);
  });
});
