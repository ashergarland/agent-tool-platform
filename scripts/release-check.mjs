import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Release consistency check.
 *
 * Everything here is a fact about the repository, so it runs anywhere, needs no npm authentication,
 * and never contacts a registry. It answers a single question: if someone published right now,
 * would the result be coherent?
 *
 * For v0 the runtime and the testkit are versioned in lockstep and the testkit depends on the exact
 * runtime version. That is the invariant most likely to rot silently, because a mismatch still
 * builds, still tests, and still packs inside this workspace — the workspace resolves the local
 * runtime regardless of what the dependency range says. It only breaks for a consumer.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const repositoryUrl = 'https://github.com/ashergarland/agent-tool-platform';
const gitUrl = `git+${repositoryUrl}.git`;
const npmRegistry = 'https://registry.npmjs.org';
const runtimeName = '@agent-tool-platform/runtime';
const testkitName = '@agent-tool-platform/testkit';

/** Dependency protocols npm cannot resolve for an external consumer. */
const unpublishableProtocols =
  /^(workspace:|file:|link:|portal:|git\+|git:|github:|https?:|[^@\s/]+\/[^@\s/]+$)/u;

const semanticVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const failures = [];
const fail = (message) => failures.push(message);

const read = (relativePath) => JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8'));

const root = read('package.json');
const publishable = [
  { name: runtimeName, directory: 'packages/runtime' },
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
  if (manifest.private !== undefined) {
    fail(`${label}: still declares "private"; a publishable package must not`);
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

// v0 ships the pair together: one version, one compatibility story.
if (runtime.version !== testkit.version) {
  fail(
    `${runtimeName}@${runtime.version} and ${testkitName}@${testkit.version} must match; ` +
      'the platform packages are released in lockstep for v0',
  );
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

if (runtime.dependencies?.[testkitName] || runtime.devDependencies?.[testkitName]) {
  fail(`${runtimeName} must never depend on ${testkitName}`);
}

// The repository itself and its fixtures stay unpublishable.
for (const path of ['package.json', 'examples/minimal-capability/package.json']) {
  if (read(path).private !== true) fail(`${path}: must remain private; it is not a product`);
}

if (failures.length > 0) {
  process.stderr.write(`Release check failed:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Release check passed for ${runtime.version}:\n` +
      `- ${runtimeName}@${runtime.version} -> public on ${npmRegistry}\n` +
      `- ${testkitName}@${testkit.version} -> public on ${npmRegistry}, depending on ${runtimeName}@${declaredRuntime}\n` +
      'Publication order is runtime first, then testkit. This check publishes nothing.\n',
  );
}
