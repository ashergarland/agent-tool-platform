import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { extractTarball, packPackage } from './lib/tarball.mjs';

/**
 * Publication smoke test.
 *
 * This proves what an external consumer receives, not what the workspace happens to resolve. For
 * each publishable package it packs a real tarball, asserts the contents are intentional, then
 * installs that tarball into a throwaway project **outside this repository** and imports it there.
 *
 * The isolation is the point. The consumer projects live in the OS temp directory, so Node's upward
 * `node_modules` walk can never reach this workspace: nothing resolves through a workspace symlink,
 * a `paths` alias, or a dependency the package forgot to declare but the monorepo happens to hoist.
 * Only a package's own declared dependencies are linked in, so an undeclared import fails here
 * rather than in someone else's install.
 *
 * Testkit is installed against the **packed** runtime, never the workspace one, because that is the
 * relationship npm creates for a real consumer.
 *
 * No network access is required: tarballs are packed locally and third-party dependencies are
 * linked from the already-installed workspace tree.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const workspaceModules = join(repositoryRoot, 'node_modules');
const keepArtefacts = process.env.ATP_SMOKE_KEEP === '1';

const failures = [];
const fail = (message) => failures.push(message);
const note = (message) => process.stdout.write(`${message}\n`);

const readManifest = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Exports the README documents. A rename here is a breaking change for every capability. */
const documentedExports = {
  '@agent-tool-platform/runtime': [
    'defineAgentToolCapability',
    'createAgentToolApplication',
    'startAgentToolApplication',
    'defineTool',
    'ToolRegistry',
    'AppError',
    'createAuthenticator',
    'buildOpenApiDocument',
    'createMcpServer',
    'createHttpServer',
    'RootBoundary',
    'runBoundedProcess',
    'MutationGate',
    'noopTelemetrySink',
    'assertCapabilityMetadata',
  ],
  '@agent-tool-platform/testkit': [
    'runRegistryConformance',
    'runMcpConformance',
    'runHttpConformance',
    'runOpenApiConformance',
    'runTransportParity',
    'runAuthConformance',
    'runConfigConformance',
    'runRoutingConformance',
    'runLifecycleConformance',
    'runRootBoundaryConformance',
    'runProcessConformance',
    'runMetadataConformance',
  ],
};

const publishable = [
  { directory: 'packages/runtime', name: '@agent-tool-platform/runtime' },
  { directory: 'packages/testkit', name: '@agent-tool-platform/testkit' },
];

/**
 * What a consumer must receive, and what a consumer must never receive. Maps are forbidden because
 * they reference `src/`, which is deliberately not published: a map pointing at a path that does
 * not exist in the tarball is worse than no map at all.
 */
const requiredFiles = ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts'];
const forbidden = [
  [/^src\//u, 'TypeScript sources'],
  [/\.map$/u, 'source or declaration maps that would point at unpublished sources'],
  [/\.tsbuildinfo$/u, 'incremental build state'],
  [/(^|\/)tsconfig[^/]*\.json$/u, 'build configuration'],
  [/\.(test|spec)\.[cm]?[jt]s$/u, 'test files'],
  [
    /^(\.github|tests|scripts|examples|infra|coverage|node_modules)\//u,
    'repository-internal trees',
  ],
  [/(^|\/)\.(env|npmrc|gitignore|gitattributes)$/u, 'local tooling or secrets-adjacent files'],
];
const allowedRoots = [/^dist\//u, /^bin\//u, /^(package\.json|README\.md|LICENSE)$/u];

const collectExportTargets = (exportsField, targets = []) => {
  if (typeof exportsField === 'string') {
    targets.push(exportsField);
    return targets;
  }
  if (exportsField && typeof exportsField === 'object') {
    for (const value of Object.values(exportsField)) collectExportTargets(value, targets);
  }
  return targets;
};

const documentedSubpaths = (manifest) =>
  Object.keys(manifest.exports ?? {}).filter((subpath) => subpath !== './package.json');

const linkFromWorkspace = (consumerModules, name) => {
  const source = join(workspaceModules, ...name.split('/'));
  if (!existsSync(source)) {
    fail(`${name} is required by an installed package but is not present in the workspace tree`);
    return;
  }
  const target = join(consumerModules, ...name.split('/'));
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(realpathSync(source), target, process.platform === 'win32' ? 'junction' : 'dir');
};

/**
 * Builds a consumer project in the OS temp directory containing only packed platform tarballs and
 * the third-party dependencies those packages actually declare.
 */
const createConsumer = (label, packed, entryPackage) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `atp-${label}-`));
  const modules = join(root, 'node_modules');
  mkdirSync(modules, { recursive: true });

  const installedVersions = new Map();
  for (const [name, artefact] of Object.entries(packed)) {
    const installedDir = join(modules, ...name.split('/'));
    extractTarball(artefact.tarball, installedDir);
    installedVersions.set(name, readManifest(join(installedDir, 'package.json')).version);
    if (lstatSync(installedDir).isSymbolicLink()) {
      fail(`${name} was linked rather than unpacked into the ${label} consumer`);
    }
  }

  for (const name of Object.keys(packed)) {
    const manifest = readManifest(join(modules, ...name.split('/'), 'package.json'));
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@agent-tool-platform/')) {
        const installed = installedVersions.get(dependency);
        if (installed === undefined) {
          fail(`${name} depends on ${dependency}, which was not installed from a packed tarball`);
        } else if (installed !== range) {
          fail(
            `${name} depends on ${dependency}@${range} but the packed artefact is ${installed}; ` +
              'the platform packages are versioned in lockstep',
          );
        }
        continue;
      }
      linkFromWorkspace(modules, dependency);
    }
  }

  // TypeScript and the Node type definitions are consumer-side tooling, not something we ship.
  linkFromWorkspace(modules, 'typescript');
  linkFromWorkspace(modules, '@types/node');

  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: `atp-${label}-consumer`,
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: Object.fromEntries(
          Object.keys(packed).map((name) => [name, installedVersions.get(name)]),
        ),
      },
      undefined,
      2,
    )}\n`,
  );

  return { root, modules, entryPackage };
};

const importConsumerSource = (consumerRoot, specifiers, expectedNames, packageNames) => {
  const imports = specifiers
    .map((specifier, index) => `import * as namespace${index} from '${specifier}';`)
    .join('\n');
  return `import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
${imports}

const namespaces = [${specifiers.map((_, index) => `namespace${index}`).join(', ')}];
const specifiers = ${JSON.stringify(specifiers)};
const consumerRoot = realpathSync(${JSON.stringify(consumerRoot)});
const failures = [];

namespaces.forEach((namespace, index) => {
  if (typeof namespace !== 'object' || Object.keys(namespace).length === 0) {
    failures.push(specifiers[index] + ' resolved but exported nothing');
  }
});

for (const name of ${JSON.stringify(expectedNames)}) {
  if (!(name in namespace0)) failures.push(specifiers[0] + ' does not export ' + name);
}

// Every platform package must resolve inside this throwaway project. Resolving anywhere else would
// mean the test proved nothing about a real install.
for (const name of ${JSON.stringify(packageNames)}) {
  const resolved = realpathSync(fileURLToPath(import.meta.resolve(name)));
  if (!resolved.startsWith(consumerRoot)) {
    failures.push(name + ' resolved to ' + resolved + ', outside the consumer project');
  }
  if (/[\\\\/]packages[\\\\/](runtime|testkit)[\\\\/]src[\\\\/]/u.test(resolved)) {
    failures.push(name + ' resolved to a source workspace path: ' + resolved);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\\n'));
  process.exit(1);
}
console.log('ok');
`;
};

const typeConsumerSource = (specifiers, expectedNames) => {
  const imports = specifiers
    .map((specifier, index) => `import * as namespace${index} from '${specifier}';`)
    .join('\n');
  const uses = specifiers.map((_, index) => `void namespace${index};`).join('\n');
  const named = expectedNames
    .map((name) => `const check_${name}: unknown = namespace0.${name};\nvoid check_${name};`)
    .join('\n');
  return `${imports}\n\n${uses}\n\n${named}\n`;
};

const exerciseConsumer = (consumer, packed) => {
  const entry = consumer.entryPackage;
  const manifest = readManifest(join(consumer.modules, ...entry.split('/'), 'package.json'));
  const specifiers = documentedSubpaths(manifest).map((subpath) =>
    subpath === '.' ? entry : `${entry}${subpath.slice(1)}`,
  );
  const expectedNames = documentedExports[entry];
  const packageNames = Object.keys(packed);

  writeFileSync(
    join(consumer.root, 'consumer.mjs'),
    importConsumerSource(consumer.root, specifiers, expectedNames, packageNames),
  );
  try {
    execFileSync(process.execPath, [join(consumer.root, 'consumer.mjs')], {
      cwd: consumer.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    note(`${entry}: ${specifiers.length} documented entry points import from an external install`);
  } catch (error) {
    fail(
      `${entry}: an installed consumer could not import the published entry points:\n${
        error.stderr || error.stdout || error.message
      }`,
    );
    return;
  }

  writeFileSync(join(consumer.root, 'consumer.ts'), typeConsumerSource(specifiers, expectedNames));
  writeFileSync(
    join(consumer.root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['consumer.ts'],
      },
      undefined,
      2,
    )}\n`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        join(workspaceModules, 'typescript', 'bin', 'tsc'),
        '--project',
        join(consumer.root, 'tsconfig.json'),
      ],
      { cwd: consumer.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    note(`${entry}: published declarations type-check for an external TypeScript consumer`);
  } catch (error) {
    fail(
      `${entry}: a TypeScript consumer could not compile against the published declarations:\n${
        error.stdout || error.stderr || error.message
      }`,
    );
  }
};

const staging = mkdtempSync(join(realpathSync(tmpdir()), 'atp-pack-'));
const consumers = [];
const packed = {};

try {
  for (const { directory, name } of publishable) {
    const packageDir = join(repositoryRoot, directory);
    const manifest = readManifest(join(packageDir, 'package.json'));

    if (manifest.name !== name) {
      fail(`${directory}: expected package name ${name} but found ${manifest.name}`);
      continue;
    }
    if (!existsSync(join(packageDir, 'dist'))) {
      fail(`${name}: dist/ is missing; run the build before the package smoke test`);
      continue;
    }
    if (manifest.private === true) {
      fail(`${name}: is marked private and could never be published`);
    }

    const artefact = packPackage(packageDir, staging);
    packed[name] = artefact;
    const shipped = new Set(artefact.files);

    for (const required of requiredFiles) {
      if (!shipped.has(required)) fail(`${name}: does not ship the required file ${required}`);
    }
    for (const target of collectExportTargets(manifest.exports)) {
      const normalized = target.replace(/^\.\//u, '');
      if (!shipped.has(normalized)) {
        fail(`${name}: export target ${target} is not included in the package`);
      }
    }
    for (const binTarget of Object.values(manifest.bin ?? {})) {
      const normalized = String(binTarget).replace(/^\.\//u, '');
      if (!shipped.has(normalized)) {
        fail(`${name}: bin target ${binTarget} is not included in the package`);
      }
    }
    for (const [pattern, reason] of forbidden) {
      const offenders = artefact.files.filter((file) => pattern.test(file));
      if (offenders.length > 0) {
        fail(`${name}: ships ${offenders.length} ${reason} (for example ${offenders[0]})`);
      }
    }
    for (const file of artefact.files) {
      if (!allowedRoots.some((pattern) => pattern.test(file))) {
        fail(`${name}: ships ${file}, which is outside dist/, bin/, and the package documentation`);
      }
    }

    // Emitted JavaScript and declarations must never point back at sources that are not published.
    const extracted = join(staging, `extracted${name.replace(/[@/]/gu, '-')}`);
    extractTarball(artefact.tarball, extracted);
    for (const file of artefact.files) {
      if (!/\.(js|d\.ts)$/u.test(file)) continue;
      const contents = readFileSync(join(extracted, file), 'utf8');
      if (/['"][^'"]*\.\.\/src\//u.test(contents)) {
        fail(`${name}: ${file} references an unpublished source path`);
      }
    }

    note(`${name}@${manifest.version}: packed ${artefact.files.length} files`);
  }

  if (failures.length === 0) {
    // Runtime must stand alone. Testkit must consume the packed runtime, not the workspace one.
    const runtimeOnly = { '@agent-tool-platform/runtime': packed['@agent-tool-platform/runtime'] };
    const runtimeConsumer = createConsumer('runtime', runtimeOnly, '@agent-tool-platform/runtime');
    consumers.push(runtimeConsumer);
    exerciseConsumer(runtimeConsumer, runtimeOnly);

    const testkitConsumer = createConsumer('testkit', packed, '@agent-tool-platform/testkit');
    consumers.push(testkitConsumer);
    exerciseConsumer(testkitConsumer, packed);

    // The dependency may only point one way.
    const runtimeManifest = readManifest(
      join(runtimeConsumer.modules, '@agent-tool-platform', 'runtime', 'package.json'),
    );
    const runtimeDependencies = {
      ...runtimeManifest.dependencies,
      ...runtimeManifest.peerDependencies,
    };
    if ('@agent-tool-platform/testkit' in runtimeDependencies) {
      fail('the runtime depends on the testkit; that dependency may only point the other way');
    }
  }
} finally {
  if (keepArtefacts) {
    note(`kept ${staging}${consumers.map((consumer) => ` and ${consumer.root}`).join('')}`);
  } else {
    for (const consumer of consumers) rmSync(consumer.root, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  process.stderr.write(`Package publication smoke test failed:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Publication smoke test passed: both tarballs ship only intended files, install outside the workspace, expose every documented export, and type-check for an external TypeScript consumer.\n',
  );
}
