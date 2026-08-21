import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const developmentVersion = '0.0.0-development';
const semanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const repositoryRoot = resolve(import.meta.dirname, '..');
const runtimeName = '@agent-tool-platform/runtime';

const version = process.argv[2];
if (process.argv.length !== 3 || !semanticVersion.test(version ?? '')) {
  process.stderr.write('Usage: node scripts/stamp-release-version.mjs <semantic-version>\n');
  process.exit(1);
}
if (version === developmentVersion) {
  process.stderr.write(`${developmentVersion} is reserved for checked-in development metadata.\n`);
  process.exit(1);
}

const paths = {
  root: 'package.json',
  runtime: 'packages/runtime/package.json',
  testkit: 'packages/testkit/package.json',
  fixture: 'examples/minimal-capability/package.json',
};
const read = (relativePath) =>
  JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8'));
const manifests = Object.fromEntries(
  Object.entries(paths).map(([label, path]) => [label, read(path)]),
);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

expect(manifests.root.name === 'agent-tool-platform', `${paths.root}: unexpected package name`);
expect(manifests.root.private === true, `${paths.root}: repository root must remain private`);
expect(manifests.runtime.name === runtimeName, `${paths.runtime}: unexpected package name`);
expect(
  manifests.testkit.name === '@agent-tool-platform/testkit',
  `${paths.testkit}: unexpected package name`,
);
expect(
  manifests.fixture.name === '@agent-tool-platform/example-minimal-capability',
  `${paths.fixture}: unexpected package name`,
);
expect(manifests.fixture.private === true, `${paths.fixture}: fixture must remain private`);

for (const [label, manifest] of Object.entries(manifests)) {
  expect(
    manifest.version === developmentVersion,
    `${paths[label]}: expected checked-in version ${developmentVersion}, found ${manifest.version}`,
  );
}
expect(
  manifests.testkit.dependencies?.[runtimeName] === developmentVersion,
  `${paths.testkit}: expected ${runtimeName} dependency ${developmentVersion}`,
);
expect(
  manifests.fixture.dependencies?.[runtimeName] === developmentVersion,
  `${paths.fixture}: expected ${runtimeName} dependency ${developmentVersion}`,
);

if (failures.length > 0) {
  process.stderr.write(`Cannot stamp release metadata:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

for (const manifest of Object.values(manifests)) manifest.version = version;
manifests.testkit.dependencies[runtimeName] = version;
manifests.fixture.dependencies[runtimeName] = version;

for (const [label, path] of Object.entries(paths)) {
  writeFileSync(join(repositoryRoot, path), `${JSON.stringify(manifests[label], undefined, 2)}\n`);
}

process.stdout.write(
  `Stamped release ${version}: root, runtime, testkit, fixture, and exact local runtime dependencies.\n`,
);