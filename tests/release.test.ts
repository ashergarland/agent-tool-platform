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
  const runState = (metadata: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), 'atp-registry-state-'));
    temporaryRoots.push(root);
    const fixture = join(root, 'registry.json');
    writeFileSync(
      fixture,
      `${JSON.stringify({
        registry: metadata,
        localIntegrities: Object.fromEntries(
          [
            '@agent-tool-platform/runtime',
            '@agent-tool-platform/capability-registry',
            '@agent-tool-platform/agent-kit',
            '@agent-tool-platform/testkit',
          ].map((name) => [name, 'sha512-release-fixture']),
        ),
      })}\n`,
    );
    return spawnSync(process.execPath, [stateScript, version, releaseCommit], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, ATP_RELEASE_REGISTRY_FIXTURE: fixture },
    });
  };

  it('classifies an empty release and a valid published prefix', () => {
    const empty = runState({});
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain('state=absent');
    expect(empty.stdout).toContain('published_count=0');

    const prefix = runState({
      '@agent-tool-platform/runtime': packageMetadata('packages/runtime'),
      '@agent-tool-platform/capability-registry': packageMetadata('packages/capability-registry'),
      '@agent-tool-platform/agent-kit': packageMetadata('packages/agent-kit', {
        '@agent-tool-platform/runtime': version,
        '@agent-tool-platform/capability-registry': version,
      }),
    });
    expect(prefix.status).toBe(0);
    expect(prefix.stdout).toContain('state=partial');
    expect(prefix.stdout).toContain('published_count=3');
    expect(prefix.stdout).toContain('missing_suffix=@agent-tool-platform/testkit');
  });

  it('refuses out-of-order, wrong-source, and inconsistent dependency states', () => {
    const outOfOrder = runState({
      '@agent-tool-platform/runtime': packageMetadata('packages/runtime'),
      '@agent-tool-platform/agent-kit': packageMetadata('packages/agent-kit', {
        '@agent-tool-platform/runtime': version,
        '@agent-tool-platform/capability-registry': version,
      }),
    });
    expect(outOfOrder.status).not.toBe(0);
    expect(outOfOrder.stderr).toContain('Unsafe release state');

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
});
