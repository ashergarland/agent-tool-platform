import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Release consistency check.
 *
 * Everything here is a fact about the repository, so it runs anywhere, needs no npm authentication,
 * and never contacts a registry. It answers a single question: if someone published right now,
 * would the result be coherent?
 *
 * For v0 the four platform packages are versioned in lockstep and internal package dependencies are
 * exact. Those invariants are likely to rot silently because a mismatch still builds, tests, and
 * packs inside this workspace — npm workspaces resolve local packages regardless of what the
 * dependency range says. It only breaks for an external consumer.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const repositoryUrl = 'https://github.com/ashergarland/agent-tool-platform';
const gitUrl = `git+${repositoryUrl}.git`;
const npmRegistry = 'https://registry.npmjs.org';
const agentKitName = '@agent-tool-platform/agent-kit';
const capabilityRegistryName = '@agent-tool-platform/capability-registry';
const runtimeName = '@agent-tool-platform/runtime';
const testkitName = '@agent-tool-platform/testkit';
const developmentVersion = '0.0.0-development';

/** Dependency protocols npm cannot resolve for an external consumer. */
const unpublishableProtocols =
  /^(workspace:|file:|link:|portal:|git\+|git:|github:|https?:|[^@\s/]+\/[^@\s/]+$)/u;

const semanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const expectedVersion = process.argv[2];
if (process.argv.length > 3 || (expectedVersion && !semanticVersion.test(expectedVersion))) {
  process.stderr.write('Usage: node scripts/release-check.mjs [expected-release-version]\n');
  process.exit(1);
}
if (expectedVersion === developmentVersion) {
  process.stderr.write(`${developmentVersion} cannot be used as a release version.\n`);
  process.exit(1);
}

const failures = [];
const fail = (message) => failures.push(message);

const read = (relativePath) => JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8'));

const root = read('package.json');
const agentKit = read('packages/agent-kit/package.json');
const capabilityRegistry = read('packages/capability-registry/package.json');
const capabilityRegistryData = read('packages/capability-registry/data/first-party-registry.json');
const fixture = read('examples/minimal-capability/package.json');
const publishable = [
  { name: runtimeName, directory: 'packages/runtime' },
  { name: capabilityRegistryName, directory: 'packages/capability-registry' },
  { name: agentKitName, directory: 'packages/agent-kit' },
  { name: testkitName, directory: 'packages/testkit' },
];
const manifests = new Map(
  publishable.map((entry) => [entry.name, read(`${entry.directory}/package.json`)]),
);

for (const { name, directory } of publishable) {
  const manifest = manifests.get(name);
  const label = `${directory}/package.json`;

  if (manifest.name !== name) fail(`${label}: name is ${manifest.name}, expected ${name}`);
  if (!semanticVersion.test(manifest.version ?? '')) {
    fail(`${label}: version ${manifest.version} is not a semantic version`);
  }
  const developmentPrivate = name === capabilityRegistryName || name === agentKitName;
  if (expectedVersion && manifest.private !== undefined) {
    fail(`${label}: still declares "private"; a stamped release candidate must not`);
  }
  if (!expectedVersion && developmentPrivate && manifest.private !== true) {
    fail(`${label}: must remain private until release metadata is stamped`);
  }
  if (!expectedVersion && !developmentPrivate && manifest.private !== undefined) {
    fail(`${label}: must not declare "private"`);
  }
  if (manifest.publishConfig?.access !== 'public') {
    fail(`${label}: publishConfig.access must be "public" for a scoped package`);
  }
  if (manifest.publishConfig?.registry !== npmRegistry) {
    fail(`${label}: publishConfig.registry must be ${npmRegistry}`);
  }
  if (manifest.repository?.type !== 'git' || manifest.repository?.url !== gitUrl) {
    fail(`${label}: repository must be ${gitUrl}`);
  }
  if (manifest.repository?.directory !== directory) {
    fail(`${label}: repository.directory must be ${directory}`);
  }
  if (!manifest.homepage?.startsWith(repositoryUrl)) {
    fail(`${label}: homepage must point at ${repositoryUrl}`);
  }
  if (manifest.bugs?.url !== `${repositoryUrl}/issues`) {
    fail(`${label}: bugs.url must be ${repositoryUrl}/issues`);
  }
  if (!manifest.license) fail(`${label}: license is missing`);
  if (!manifest.description) fail(`${label}: description is missing`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${label}: files must list exactly what is published`);
  }

  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (unpublishableProtocols.test(range)) {
      fail(`${label}: dependency ${dependency}@${range} cannot be resolved from a registry`);
    }
  }
}

const runtime = manifests.get(runtimeName);
const testkit = manifests.get(testkitName);
const publishedAgentKit = manifests.get(agentKitName);
const publishedCapabilityRegistry = manifests.get(capabilityRegistryName);
const requiredVersion = expectedVersion ?? developmentVersion;

for (const [label, manifest] of [
  ['package.json', root],
  ['packages/agent-kit/package.json', agentKit],
  ['packages/capability-registry/package.json', capabilityRegistry],
  ['packages/runtime/package.json', runtime],
  ['packages/testkit/package.json', testkit],
  ['examples/minimal-capability/package.json', fixture],
]) {
  if (manifest.version !== requiredVersion) {
    fail(`${label}: version ${manifest.version} must be ${requiredVersion}`);
  }
}
if (capabilityRegistryData.registryVersion !== requiredVersion) {
  fail(
    `packages/capability-registry/data/first-party-registry.json: registryVersion ` +
      `${capabilityRegistryData.registryVersion} must be ${requiredVersion}`,
  );
}

// v0 ships all four packages together: one version and one compatibility story.
const platformVersions = new Set(
  [runtime, testkit, publishedAgentKit, publishedCapabilityRegistry].map(
    (manifest) => manifest.version,
  ),
);
if (platformVersions.size !== 1) {
  fail(`platform package versions must match for v0; found ${[...platformVersions].join(', ')}`);
}
if (root.version !== runtime.version) {
  fail(`the repository version ${root.version} does not match the packages ${runtime.version}`);
}

const declaredRuntime = testkit.dependencies?.[runtimeName];
if (declaredRuntime !== runtime.version) {
  fail(
    `${testkitName} depends on ${runtimeName}@${declaredRuntime ?? '(missing)'} but the runtime ` +
      `being released is ${runtime.version}; it must be the exact version`,
  );
}

if (fixture.dependencies?.[runtimeName] !== runtime.version) {
  fail(
    `examples/minimal-capability/package.json depends on ${runtimeName}@${
      fixture.dependencies?.[runtimeName] ?? '(missing)'
    } but the workspace runtime is ${runtime.version}`,
  );
}
if (agentKit.dependencies?.[runtimeName] !== runtime.version) {
  fail(
    `${agentKitName} depends on ${runtimeName}@${
      agentKit.dependencies?.[runtimeName] ?? '(missing)'
    } but the workspace runtime is ${runtime.version}`,
  );
}
if (agentKit.dependencies?.[capabilityRegistryName] !== capabilityRegistry.version) {
  fail(
    `${agentKitName} depends on ${capabilityRegistryName}@${
      agentKit.dependencies?.[capabilityRegistryName] ?? '(missing)'
    } but the workspace registry is ${capabilityRegistry.version}`,
  );
}

const expectedInternalDependencies = new Map([
  [runtimeName, new Map()],
  [capabilityRegistryName, new Map()],
  [testkitName, new Map([[runtimeName, runtime.version]])],
  [
    agentKitName,
    new Map([
      [runtimeName, runtime.version],
      [capabilityRegistryName, capabilityRegistry.version],
    ]),
  ],
]);
for (const [name, manifest] of manifests) {
  const expectedDependencies = expectedInternalDependencies.get(name);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (!dependency.startsWith('@agent-tool-platform/')) continue;
      if (field !== 'dependencies' || expectedDependencies?.get(dependency) !== range) {
        fail(
          `${name} declares unexpected internal ${field} entry ${dependency}@${range}; ` +
            'the v0 package graph must remain acyclic and exact',
        );
      }
      if (expectedVersion && range === developmentVersion) {
        fail(`${name} leaks ${dependency}@${developmentVersion} into a release candidate`);
      }
    }
  }
}

for (const [name, expectedDependencies] of expectedInternalDependencies) {
  const manifest = manifests.get(name);
  for (const [dependency, version] of expectedDependencies) {
    if (manifest.dependencies?.[dependency] !== version) {
      fail(`${name} must depend exactly on ${dependency}@${version}`);
    }
  }
}

// The repository itself and its fixtures stay unpublishable.
for (const [path, manifest] of [
  ['package.json', root],
  ['examples/minimal-capability/package.json', fixture],
]) {
  if (manifest.private !== true) fail(`${path}: must remain private; it is not a product`);
}

if (failures.length > 0) {
  process.stderr.write(`Release check failed:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${expectedVersion ? 'Release' : 'Development'} check passed for ${runtime.version}:\n` +
      `- ${runtimeName}@${runtime.version} -> public on ${npmRegistry}\n` +
      `- ${capabilityRegistryName}@${capabilityRegistry.version} -> public on ${npmRegistry}\n` +
      `- ${agentKitName}@${agentKit.version} -> public on ${npmRegistry}, depending on ${runtimeName}@${agentKit.dependencies?.[runtimeName]} and ${capabilityRegistryName}@${agentKit.dependencies?.[capabilityRegistryName]}\n` +
      `- ${testkitName}@${testkit.version} -> public on ${npmRegistry}, depending on ${runtimeName}@${declaredRuntime}\n` +
      'Publication order is runtime, capability-registry, agent-kit, then testkit. This check publishes nothing.\n',
  );
}
