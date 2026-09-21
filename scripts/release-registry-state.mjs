import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { npmCliPath, packPackage, packPackageSpec } from './lib/tarball.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const repositoryUrl = 'git+https://github.com/ashergarland/agent-tool-platform.git';
const developmentVersion = '0.0.0-development';
const semanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const packages = [
  {
    key: 'runtime',
    name: '@agent-tool-platform/runtime',
    directory: 'packages/runtime',
    dependencies: {},
  },
  {
    key: 'capability_registry',
    name: '@agent-tool-platform/capability-registry',
    directory: 'packages/capability-registry',
    dependencies: {},
  },
  {
    key: 'agent_kit',
    name: '@agent-tool-platform/agent-kit',
    directory: 'packages/agent-kit',
    dependencies: {
      '@agent-tool-platform/runtime': true,
      '@agent-tool-platform/capability-registry': true,
    },
  },
  {
    key: 'testkit',
    name: '@agent-tool-platform/testkit',
    directory: 'packages/testkit',
    dependencies: {
      '@agent-tool-platform/runtime': true,
    },
  },
];

const usage =
  'Usage: node scripts/release-registry-state.mjs <version> <release-commit> ' +
  '[--verification <exact-artifact|package-content>] [--minimum-prefix <0-4>] ' +
  '[--attempts <positive-integer>] [--delay-ms <non-negative-integer>]\n';

const args = process.argv.slice(2);
const version = args.shift();
const releaseCommit = args.shift();
let minimumPrefix = 0;
let attempts = 1;
let delayMs = 0;
let verification = 'exact-artifact';

while (args.length > 0) {
  const option = args.shift();
  const value = args.shift();
  if (value === undefined) {
    process.stderr.write(usage);
    process.exit(1);
  }
  if (option === '--verification') {
    verification = value;
  } else if (!/^\d+$/u.test(value)) {
    process.stderr.write(usage);
    process.exit(1);
  } else if (option === '--minimum-prefix') {
    minimumPrefix = Number(value);
  } else if (option === '--attempts') {
    attempts = Number(value);
  } else if (option === '--delay-ms') {
    delayMs = Number(value);
  } else {
    process.stderr.write(usage);
    process.exit(1);
  }
}

if (
  !semanticVersion.test(version ?? '') ||
  version === developmentVersion ||
  !/^[0-9a-f]{40}$/u.test(releaseCommit ?? '') ||
  !['exact-artifact', 'package-content'].includes(verification) ||
  minimumPrefix < 0 ||
  minimumPrefix > packages.length ||
  attempts < 1
) {
  process.stderr.write(usage);
  process.exit(1);
}

const fixturePath = process.env.ATP_RELEASE_REGISTRY_FIXTURE;
const fixture = fixturePath ? JSON.parse(readFileSync(resolve(fixturePath), 'utf8')) : undefined;
const registryFixture = fixture?.registry;
const integrityFixture = fixture?.localIntegrities;
const localContentIdentityFixture = fixture?.localContentIdentities;
const publishedContentIdentityFixture = fixture?.publishedContentIdentities;
const localIntegrities = new Map();
const localContentIdentities = new Map();
const publishedContentIdentities = new Map();
let contentIdentityRoot;

const assertLocalContentCandidate = () => {
  const failures = [];
  for (const entry of packages) {
    const manifestPath = resolve(repositoryRoot, entry.directory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== version) {
      failures.push(
        `${entry.name} has local version ${String(manifest.version)}, expected ${version}`,
      );
    }
    if (manifest.private !== undefined) {
      failures.push(`${entry.name} is still marked private`);
    }
    if (!existsSync(resolve(repositoryRoot, entry.directory, 'dist'))) {
      failures.push(`${entry.name} has no built dist directory`);
    }
    for (const dependency of Object.keys(entry.dependencies)) {
      if (manifest.dependencies?.[dependency] !== version) {
        failures.push(
          `${entry.name} has local dependency ${dependency}@${String(
            manifest.dependencies?.[dependency],
          )}, expected ${version}`,
        );
      }
    }
  }

  const registryData = JSON.parse(
    readFileSync(
      resolve(repositoryRoot, 'packages/capability-registry/data/first-party-registry.json'),
      'utf8',
    ),
  );
  if (registryData.registryVersion !== version) {
    failures.push(
      `Capability Registry data has local version ${String(
        registryData.registryVersion,
      )}, expected ${version}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      'Package-content verification requires a stamped, built local release candidate. ' +
        'Check out the release source, run npm ci, stamp the requested version, and build before ' +
        `retrying:\n- ${failures.join('\n- ')}`,
    );
  }
};

if (fixture === undefined && verification === 'exact-artifact' && process.platform !== 'linux') {
  process.stderr.write(
    'Exact release artifact verification requires the canonical Linux release environment. ' +
      'Use --verification package-content for platform-neutral package content verification.\n',
  );
  process.exit(1);
}
if (fixture === undefined && verification === 'package-content') {
  assertLocalContentCandidate();
}

const contentDirectory = (label) => {
  if (contentIdentityRoot === undefined) {
    contentIdentityRoot = mkdtempSync(join(tmpdir(), 'atp-release-content-'));
    process.once('exit', () => rmSync(contentIdentityRoot, { recursive: true, force: true }));
  }
  const directory = join(contentIdentityRoot, label);
  mkdirSync(directory, { recursive: true });
  return directory;
};

const parseJsonOutput = (output, packageName) => {
  const start = output.indexOf('{');
  if (start < 0) throw new Error(`npm returned non-JSON metadata for ${packageName}@${version}`);
  return JSON.parse(output.slice(start));
};

const runNpm = (args, options = {}) => {
  const cli = npmCliPath();
  return spawnSync(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args, {
    ...options,
    shell: cli === undefined && process.platform === 'win32',
  });
};

const queryPackage = (packageName) => {
  if (fixture !== undefined) return registryFixture?.[packageName] ?? null;

  const result = runNpm(
    [
      'view',
      `${packageName}@${version}`,
      'version',
      'gitHead',
      'repository',
      'dependencies',
      'dist.integrity',
      'dist.attestations',
      '--json',
    ],
    { encoding: 'utf8' },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) return parseJsonOutput(result.stdout, packageName);
  if (output.includes('E404')) return null;
  throw new Error(`Could not query ${packageName}@${version}: ${output.trim()}`);
};

const localIntegrity = (entry) => {
  const cached = localIntegrities.get(entry.name);
  if (cached !== undefined) return cached;
  if (fixture !== undefined) {
    const expected = integrityFixture?.[entry.name];
    if (typeof expected !== 'string' || expected.length === 0) {
      throw new Error(`Registry fixture has no local integrity for ${entry.name}`);
    }
    localIntegrities.set(entry.name, expected);
    return expected;
  }

  const result = runNpm(['pack', '--dry-run', '--json'], {
    cwd: resolve(repositoryRoot, entry.directory),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Could not pack the local ${entry.name} candidate: ${`${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()}`,
    );
  }
  const start = result.stdout.indexOf('[');
  if (start < 0) {
    throw new Error(`npm pack returned non-JSON metadata for the local ${entry.name} candidate`);
  }
  const packed = JSON.parse(result.stdout.slice(start));
  const integrity = packed[0]?.integrity;
  if (typeof integrity !== 'string' || integrity.length === 0) {
    throw new Error(`npm pack returned no integrity for the local ${entry.name} candidate`);
  }
  localIntegrities.set(entry.name, integrity);
  return integrity;
};

const localContentIdentity = (entry) => {
  const cached = localContentIdentities.get(entry.name);
  if (cached !== undefined) return cached;
  if (fixture !== undefined) {
    const expected = localContentIdentityFixture?.[entry.name];
    if (typeof expected !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(expected)) {
      throw new Error(`Registry fixture has no local content identity for ${entry.name}`);
    }
    localContentIdentities.set(entry.name, expected);
    return expected;
  }

  const artifact = packPackage(
    resolve(repositoryRoot, entry.directory),
    contentDirectory(`local-${entry.key}`),
  );
  localContentIdentities.set(entry.name, artifact.contentIdentity);
  return artifact.contentIdentity;
};

const publishedContentIdentity = (entry, metadata) => {
  const cached = publishedContentIdentities.get(entry.name);
  if (cached !== undefined) return cached;
  if (fixture !== undefined) {
    const observed = publishedContentIdentityFixture?.[entry.name];
    if (typeof observed !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(observed)) {
      throw new Error(`Registry fixture has no published content identity for ${entry.name}`);
    }
    publishedContentIdentities.set(entry.name, observed);
    return observed;
  }

  const artifact = packPackageSpec(
    `${entry.name}@${version}`,
    contentDirectory(`registry-${entry.key}`),
    repositoryRoot,
  );
  if (artifact.integrity !== metadata['dist.integrity']) {
    throw new Error(
      `${entry.name}@${version} downloaded with integrity ${String(artifact.integrity)}, ` +
        `expected npm metadata integrity ${metadata['dist.integrity']}`,
    );
  }
  publishedContentIdentities.set(entry.name, artifact.contentIdentity);
  return artifact.contentIdentity;
};

const validatePublishedPackage = (entry, metadata) => {
  if (metadata.version !== version) {
    throw new Error(
      `Registry returned ${entry.name}@${String(metadata.version)} while checking ${version}`,
    );
  }
  if (metadata.gitHead !== releaseCommit) {
    throw new Error(
      `${entry.name}@${version} has gitHead ${String(metadata.gitHead)}, expected ${releaseCommit}`,
    );
  }
  if (
    metadata.repository?.type !== 'git' ||
    metadata.repository?.url !== repositoryUrl ||
    metadata.repository?.directory !== entry.directory
  ) {
    throw new Error(
      `${entry.name}@${version} does not identify ${repositoryUrl}#${entry.directory}`,
    );
  }
  if (typeof metadata['dist.integrity'] !== 'string' || metadata['dist.integrity'].length === 0) {
    throw new Error(`${entry.name}@${version} has no registry integrity digest`);
  }
  let contentIdentity;
  if (verification === 'exact-artifact') {
    const expectedIntegrity = localIntegrity(entry);
    if (metadata['dist.integrity'] !== expectedIntegrity) {
      throw new Error(
        `${entry.name}@${version} has integrity ${metadata['dist.integrity']}, ` +
          `expected the tagged candidate integrity ${expectedIntegrity}`,
      );
    }
  } else {
    const expectedContentIdentity = localContentIdentity(entry);
    contentIdentity = publishedContentIdentity(entry, metadata);
    if (contentIdentity !== expectedContentIdentity) {
      throw new Error(
        `${entry.name}@${version} has platform-neutral package content identity ` +
          `${contentIdentity}, expected ${expectedContentIdentity}`,
      );
    }
  }

  const expectedDependencies = new Map(
    Object.keys(entry.dependencies).map((dependency) => [dependency, version]),
  );
  for (const [dependency, range] of Object.entries(metadata.dependencies ?? {})) {
    if (!dependency.startsWith('@agent-tool-platform/')) continue;
    if (expectedDependencies.get(dependency) !== range) {
      throw new Error(
        `${entry.name}@${version} has unexpected internal dependency ${dependency}@${range}`,
      );
    }
    if (range === developmentVersion) {
      throw new Error(`${entry.name}@${version} leaks ${dependency}@${developmentVersion} on npm`);
    }
  }
  for (const [dependency, range] of expectedDependencies) {
    if (metadata.dependencies?.[dependency] !== range) {
      throw new Error(`${entry.name}@${version} must depend exactly on ${dependency}@${range}`);
    }
  }
  return contentIdentity;
};

const inspect = () => {
  const states = packages.map((entry) => {
    const metadata = queryPackage(entry.name);
    const contentIdentity =
      metadata === null ? undefined : validatePublishedPackage(entry, metadata);
    return {
      ...entry,
      exists: metadata !== null,
      contentIdentity,
      attested:
        metadata?.['dist.attestations']?.provenance?.predicateType ===
        'https://slsa.dev/provenance/v1',
    };
  });

  const firstMissing = states.findIndex((entry) => !entry.exists);
  const publishedCount = firstMissing < 0 ? states.length : firstMissing;
  const outOfOrder = states.slice(publishedCount).filter((entry) => entry.exists);
  return { states, publishedCount, outOfOrder };
};

const sleep = (milliseconds) => {
  if (milliseconds === 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
};

let result;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  result = inspect();
  if (result.outOfOrder.length === 0 && result.publishedCount >= minimumPrefix) break;
  if (attempt === attempts) break;
  process.stderr.write(
    `Waiting for release registry prefix ${minimumPrefix}/${packages.length} ` +
      `(attempt ${attempt} of ${attempts}).\n`,
  );
  sleep(delayMs);
}

if (result.outOfOrder.length > 0) {
  process.stderr.write(
    `Unsafe release state for ${version}: ${result.outOfOrder
      .map((entry) => entry.name)
      .join(', ')} exists after a missing package in the required publication order.\n`,
  );
  process.exit(1);
}
if (result.publishedCount < minimumPrefix) {
  process.stderr.write(
    `Registry propagation timed out for ${version}: expected a published prefix of at least ` +
      `${minimumPrefix}, found ${result.publishedCount}.\n`,
  );
  process.exit(1);
}

const state =
  result.publishedCount === 0
    ? 'absent'
    : result.publishedCount === packages.length
      ? 'complete'
      : 'partial';
const published = result.states.slice(0, result.publishedCount);
const missing = result.states.slice(result.publishedCount);
const attested = published.filter((entry) => entry.attested);
const unattested = published.filter((entry) => !entry.attested);

process.stdout.write(`verification=${verification}\n`);
process.stdout.write(`state=${state}\n`);
process.stdout.write(`published_count=${result.publishedCount}\n`);
for (const entry of result.states) {
  process.stdout.write(`${entry.key}_exists=${entry.exists}\n`);
  if (entry.contentIdentity !== undefined) {
    process.stdout.write(`${entry.key}_content_identity=${entry.contentIdentity}\n`);
  }
}
process.stdout.write(`published_prefix=${published.map((entry) => entry.name).join(',')}\n`);
process.stdout.write(`missing_suffix=${missing.map((entry) => entry.name).join(',')}\n`);
process.stdout.write(`attested_packages=${attested.map((entry) => entry.name).join(',')}\n`);
process.stdout.write(`unattested_packages=${unattested.map((entry) => entry.name).join(',')}\n`);
