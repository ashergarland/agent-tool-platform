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
import { extractTarball, npmCommand, packPackage } from './lib/tarball.mjs';

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
 * Testkit is installed against the packed runtime. Agent Kit is installed against the packed
 * runtime and Capability Registry. No Platform dependency resolves through the workspace.
 *
 * Runtime and Testkit isolation checks link only their declared third-party dependencies from the
 * workspace. Registry and Agent Kit additionally go through real npm installs of their complete
 * packed dependency closures. The executable check performs a real Runtime install as well.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const workspaceModules = join(repositoryRoot, 'node_modules');
const keepArtefacts = process.env.ATP_SMOKE_KEEP === '1';
const developmentVersion = '0.0.0-development';

const failures = [];
const fail = (message) => failures.push(message);
const note = (message) => process.stdout.write(`${message}\n`);

const readManifest = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rootLicense = readFileSync(join(repositoryRoot, 'LICENSE'));

/**
 * Exports the README documents, per documented entry point. A rename here is a breaking change for
 * every capability.
 *
 * Subpath entries are not decoration: a capability that imports `@agent-tool-platform/runtime/
 * capability` must receive the same startup helpers as the root export, and only checking the root
 * would let a subpath silently lose one.
 */
const documentedExports = {
  '@agent-tool-platform/runtime': {
    '.': [
      'defineAgentToolCapability',
      'createAgentToolApplication',
      'startAgentToolApplication',
      'startStdioAgentToolApplication',
      'defineTool',
      'ToolRegistry',
      'AppError',
      'createAuthenticator',
      'buildOpenApiDocument',
      'createMcpServer',
      'createHttpServer',
      'connectStdio',
      'installShutdownSignalHandlers',
      'RootBoundary',
      'runBoundedProcess',
      'MutationGate',
      'noopTelemetrySink',
      'assertCapabilityMetadata',
      'assertDeploymentContract',
      'capabilityProfileDeclarationJsonSchema',
      'deploymentInstanceJsonSchema',
    ],
    './capability': [
      'createAgentToolApplication',
      'startAgentToolApplication',
      'startStdioAgentToolApplication',
    ],
    './lifecycle': ['ApplicationLifecycle', 'installShutdownSignalHandlers'],
    './mcp': ['createMcpServer', 'createStdioMcpServer', 'connectStdio'],
    './deployment': [
      'CANONICAL_CAPABILITY_DECLARATION_PATH',
      'assertDeploymentContract',
      'capabilityProfileDeclarationJsonSchema',
      'deploymentInstanceJsonSchema',
      'validateDeploymentContract',
    ],
  },
  '@agent-tool-platform/testkit': {
    '.': [
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
      'runScratchWorkspaceConformance',
      'runProcessConformance',
      'runMetadataConformance',
      'runDeploymentContractConformance',
    ],
    './deployment': ['runDeploymentContractConformance'],
  },
  '@agent-tool-platform/capability-registry': {
    '.': [
      'buildCapabilityRegistry',
      'createCapabilityRegistryReader',
      'loadFirstPartyCapabilityRegistry',
      'capabilityEntryJsonSchema',
      'capabilityRegistryJsonSchema',
      'capabilityRegistrySchemaVersion',
    ],
  },
  '@agent-tool-platform/agent-kit': {
    '.': [
      'buildAgent',
      'buildVsCodeAgent',
      'createAgentLock',
      'digestAgentLock',
      'serializeAgentLock',
      'vscodeHostAdapter',
    ],
  },
};

const publishable = [
  { directory: 'packages/runtime', name: '@agent-tool-platform/runtime' },
  {
    directory: 'packages/capability-registry',
    name: '@agent-tool-platform/capability-registry',
  },
  { directory: 'packages/agent-kit', name: '@agent-tool-platform/agent-kit' },
  { directory: 'packages/testkit', name: '@agent-tool-platform/testkit' },
];

const runtimeBinary = {
  name: 'agent-tool-validate-metadata',
  target: 'bin/validate-metadata.js',
};
const deploymentBinary = {
  name: 'agent-tool-validate-deployment',
  target: 'bin/validate-deployment.js',
};
const runtimeBinaries = [runtimeBinary, deploymentBinary];

/**
 * What a consumer must receive, and what a consumer must never receive. Maps are forbidden because
 * they reference `src/`, which is deliberately not published: a map pointing at a path that does
 * not exist in the tarball is worse than no map at all.
 *
 * LICENSE is required, not merely permitted. A package whose manifest says `"license": "MIT"` but
 * whose tarball carries no license text leaves the recipient without the grant itself, and npm's
 * automatic inclusion of a root-level LICENSE is a convenience, not a guarantee worth relying on.
 */
const requiredFiles = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts'];
const runtimeSchemaFiles = [
  'schemas/deployment/v1/capability-profile-declaration.schema.json',
  'schemas/deployment/v1/deployment-instance.schema.json',
];
const registryDataFiles = [
  'data/first-party-registry.json',
  'schemas/v1/capability-entry.schema.json',
  'schemas/v1/capability-registry.schema.json',
];
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
const allowedRoots = [
  /^dist\//u,
  /^bin\//u,
  /^data\//u,
  /^schemas\//u,
  /^(package\.json|README\.md|LICENSE)$/u,
];

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
  Object.keys(manifest.exports ?? {}).filter(
    (subpath) => subpath !== './package.json' && !subpath.endsWith('.json'),
  );

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

/**
 * Runs npm's installer over packed Platform artefacts in an external project. Platform packages
 * are supplied as tarballs in one transaction so exact internal versions resolve without a
 * registry; third-party dependencies resolve exactly as they do for a normal npm consumer.
 */
const createInstalledConsumer = (label, packed, entryPackage) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `atp-${label}-installed-`));
  const modules = join(root, 'node_modules');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: `atp-${label}-consumer`, version: '0.0.0', private: true })}\n`,
  );

  try {
    npmCommand(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--save-exact',
        ...Object.values(packed).map((artefact) => artefact.tarball),
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    fail(
      `${entryPackage}: npm could not install its packed dependency closure:\n${
        error.stderr || error.stdout || error.message
      }`,
    );
    return { root, modules, entryPackage, installed: false };
  }

  for (const [name, artefact] of Object.entries(packed)) {
    const installedDir = join(modules, ...name.split('/'));
    if (!existsSync(installedDir)) {
      fail(`${entryPackage}: npm did not install packed dependency ${name}`);
      continue;
    }
    if (lstatSync(installedDir).isSymbolicLink()) {
      fail(`${name} was linked rather than installed from ${artefact.tarball}`);
    }
    const installedManifest = readManifest(join(installedDir, 'package.json'));
    const packedManifest = readManifest(
      join(staging, `extracted${name.replace(/[@/]/gu, '-')}`, 'package.json'),
    );
    if (installedManifest.version !== packedManifest.version) {
      fail(
        `${entryPackage}: installed ${name}@${installedManifest.version}, expected packed version ${packedManifest.version}`,
      );
    }
  }

  linkFromWorkspace(modules, 'typescript');
  linkFromWorkspace(modules, '@types/node');
  return { root, modules, entryPackage, installed: true };
};

const importConsumerSource = (consumerRoot, specifiers, expectations, packageNames) => {
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

for (const { index, names } of ${JSON.stringify(expectations)}) {
  for (const name of names) {
    if (!(name in namespaces[index])) failures.push(specifiers[index] + ' does not export ' + name);
  }
}

// Every platform package must resolve inside this throwaway project. Resolving anywhere else would
// mean the test proved nothing about a real install.
for (const name of ${JSON.stringify(packageNames)}) {
  const resolved = realpathSync(fileURLToPath(import.meta.resolve(name)));
  if (!resolved.startsWith(consumerRoot)) {
    failures.push(name + ' resolved to ' + resolved + ', outside the consumer project');
  }
  if (
    /[\\\\/]packages[\\\\/](runtime|testkit|capability-registry|agent-kit)[\\\\/]src[\\\\/]/u.test(
      resolved,
    )
  ) {
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

const typeConsumerSource = (specifiers, expectations) => {
  const imports = specifiers
    .map((specifier, index) => `import * as namespace${index} from '${specifier}';`)
    .join('\n');
  const uses = specifiers.map((_, index) => `void namespace${index};`).join('\n');
  const named = expectations
    .flatMap(({ index, names }) =>
      names.map(
        (name) =>
          `const check_${index}_${name}: unknown = namespace${index}.${name};\nvoid check_${index}_${name};`,
      ),
    )
    .join('\n');
  return `${imports}\n\n${uses}\n\n${named}\n`;
};

const exerciseConsumer = (consumer, packed) => {
  const entry = consumer.entryPackage;
  const manifest = readManifest(join(consumer.modules, ...entry.split('/'), 'package.json'));
  const subpaths = documentedSubpaths(manifest);
  const specifiers = subpaths.map((subpath) =>
    subpath === '.' ? entry : `${entry}${subpath.slice(1)}`,
  );
  const expected = documentedExports[entry];
  const packageNames = Object.keys(packed);

  // A documented export list that names an entry point the package does not publish is drift in
  // this script, and would otherwise pass by silently checking nothing.
  for (const subpath of Object.keys(expected)) {
    if (!subpaths.includes(subpath)) {
      fail(`${entry}: documented exports name ${subpath}, which the package does not publish`);
    }
  }

  const expectations = subpaths
    .map((subpath, index) => ({ index, names: expected[subpath] ?? [] }))
    .filter(({ names }) => names.length > 0);

  writeFileSync(
    join(consumer.root, 'consumer.mjs'),
    importConsumerSource(consumer.root, specifiers, expectations, packageNames),
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

  writeFileSync(join(consumer.root, 'consumer.ts'), typeConsumerSource(specifiers, expectations));
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

const exerciseRegistryAssets = (consumer) => {
  const source = `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  capabilityRegistrySchemaVersion,
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
} from '@agent-tool-platform/capability-registry';

const registry = await loadFirstPartyCapabilityRegistry();
const reader = createCapabilityRegistryReader(registry);
const packageManifest = JSON.parse(
  readFileSync(
    fileURLToPath(import.meta.resolve('@agent-tool-platform/capability-registry/package.json')),
    'utf8',
  ),
);
if (registry.schemaVersion !== capabilityRegistrySchemaVersion) {
  throw new Error('first-party registry schema version does not match the public API');
}
if (registry.registryVersion !== packageManifest.version) {
  throw new Error('first-party registry version does not match the installed package');
}
if (reader.listCapabilities().length !== 7 || reader.getCapability('ast-summarizer') === undefined) {
  throw new Error('first-party registry data did not load through the installed reader');
}
for (const specifier of [
  '@agent-tool-platform/capability-registry/first-party-registry.json',
  '@agent-tool-platform/capability-registry/schemas/v1/capability-entry.json',
  '@agent-tool-platform/capability-registry/schemas/v1/capability-registry.json',
]) {
  const document = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(specifier)), 'utf8'));
  if (typeof document !== 'object' || document === null) {
    throw new Error(specifier + ' did not resolve to a JSON document');
  }
}
console.log('ok');
`;
  writeFileSync(join(consumer.root, 'registry-assets.mjs'), source);
  try {
    execFileSync(process.execPath, [join(consumer.root, 'registry-assets.mjs')], {
      cwd: consumer.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    note(
      '@agent-tool-platform/capability-registry: installed data, schemas, loader, and reader work externally',
    );
  } catch (error) {
    fail(
      `@agent-tool-platform/capability-registry: installed data/schema proof failed:\n${
        error.stderr || error.stdout || error.message
      }`,
    );
  }
};

const exerciseAgentKitBuild = (consumer) => {
  const source = `import {
  createCapabilityRegistryReader,
  loadFirstPartyCapabilityRegistry,
} from '@agent-tool-platform/capability-registry';
import { buildVsCodeAgent } from '@agent-tool-platform/agent-kit';

const registry = createCapabilityRegistryReader(await loadFirstPartyCapabilityRegistry());
const definition = {
  schemaVersion: 1,
  id: 'package-smoke-agent',
  name: 'Package Smoke Agent',
  version: '1.0.0',
  instructions: 'Use the selected capability and preserve evidence.',
  capabilities: [{ id: 'ast-summarizer' }],
};
const first = await buildVsCodeAgent(definition, { registry });
const second = await buildVsCodeAgent(definition, { registry });
if (first.lockText !== second.lockText || first.lockDigest !== second.lockDigest) {
  throw new Error('agent lock generation is not deterministic');
}
if (JSON.stringify(first.adapter) !== JSON.stringify(second.adapter)) {
  throw new Error('VS Code adapter generation is not deterministic');
}
if (
  !first.adapter.files.some((file) => file.path.endsWith('.agent.md')) ||
  !first.adapter.files.some((file) => file.path === '.vscode/mcp.json')
) {
  throw new Error('VS Code adapter did not generate the required files');
}
console.log('ok');
`;
  writeFileSync(join(consumer.root, 'agent-build.mjs'), source);
  try {
    execFileSync(process.execPath, [join(consumer.root, 'agent-build.mjs')], {
      cwd: consumer.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    note(
      '@agent-tool-platform/agent-kit: installed packages generate deterministic locks and adapters',
    );
  } catch (error) {
    fail(
      `@agent-tool-platform/agent-kit: installed build proof failed:\n${
        error.stderr || error.stdout || error.message
      }`,
    );
  }
};

const exerciseRuntimeBinaries = (artefact) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'atp-runtime-cli-'));
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'atp-runtime-cli-consumer', private: true })}\n`,
  );

  try {
    npmCommand(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--no-save',
        artefact.tarball,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const serverPath = join(root, 'server.json');
    const manifestPath = join(root, 'capability-package.json');
    writeFileSync(
      serverPath,
      `${JSON.stringify({
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
        name: 'io.github.example-owner/agent-tool-server-sample',
        description: 'Representative metadata for the installed runtime executable smoke test.',
        version: '1.2.3',
        repository: {
          url: 'https://github.com/example-owner/agent-tool-server-sample',
          source: 'github',
        },
      })}\n`,
    );
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        name: 'agent-tool-server-sample',
        version: '1.2.3',
        private: true,
      })}\n`,
    );

    const output = npmCommand(
      [
        'exec',
        '--offline',
        '--',
        runtimeBinary.name,
        '--server',
        serverPath,
        '--package',
        manifestPath,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (!output.includes('Metadata is consistent, truthful, and free of placeholders.')) {
      fail(`${runtimeBinary.name}: installed command produced unexpected output: ${output.trim()}`);
    } else {
      note(`${runtimeBinary.name}: npm-installed command validated representative metadata`);
    }

    const deploymentOutput = npmCommand(
      [
        'exec',
        '--offline',
        '--',
        deploymentBinary.name,
        '--declaration',
        join(repositoryRoot, 'tests', 'fixtures', 'deployment', 'capability-profiles.json'),
        '--instance',
        join(repositoryRoot, 'tests', 'fixtures', 'deployment', 'hosted-provider.deployment.json'),
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (
      !deploymentOutput.includes(
        'Capability profile declaration and deployment instance are valid.',
      )
    ) {
      fail(
        `${deploymentBinary.name}: installed command produced unexpected output: ${deploymentOutput.trim()}`,
      );
    } else {
      note(`${deploymentBinary.name}: npm-installed command cross-validated safe fixtures`);
    }
  } catch (error) {
    fail(
      `runtime commands: npm could not install and execute the packed commands:\n${
        error.stderr || error.stdout || error.message
      }`,
    );
  }

  return { root };
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
    const developmentPrivate =
      name === '@agent-tool-platform/capability-registry' ||
      name === '@agent-tool-platform/agent-kit';
    if (
      manifest.version === developmentVersion &&
      developmentPrivate &&
      manifest.private !== true
    ) {
      fail(`${name}: development metadata must stay private until release stamping`);
    }
    if (manifest.version !== developmentVersion && manifest.private !== undefined) {
      fail(`${name}: stamped release candidate is still marked private`);
    }
    if (!developmentPrivate && manifest.private !== undefined) {
      fail(`${name}: established public package unexpectedly declares private`);
    }

    const artefact = packPackage(packageDir, staging);
    packed[name] = artefact;
    const shipped = new Set(artefact.files);

    const packageRequiredFiles =
      name === '@agent-tool-platform/runtime'
        ? [...requiredFiles, ...runtimeSchemaFiles]
        : name === '@agent-tool-platform/capability-registry'
          ? [...requiredFiles, ...registryDataFiles]
          : requiredFiles;
    for (const required of packageRequiredFiles) {
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
        fail(
          `${name}: ships ${file}, which is outside dist/, bin/, data/, schemas/, and package documentation`,
        );
      }
    }

    // Emitted JavaScript and declarations must never point back at sources that are not published.
    const extracted = join(staging, `extracted${name.replace(/[@/]/gu, '-')}`);
    extractTarball(artefact.tarball, extracted);
    const packedManifest = readManifest(join(extracted, 'package.json'));

    for (const [dependency, range] of Object.entries(packedManifest.dependencies ?? {})) {
      if (!dependency.startsWith('@agent-tool-platform/')) continue;
      if (range !== packedManifest.version) {
        fail(
          `${name}: packed manifest depends on ${dependency}@${range}, not exact version ${packedManifest.version}`,
        );
      }
      if (packedManifest.version !== developmentVersion && range === developmentVersion) {
        fail(`${name}: packed manifest leaks ${dependency}@${developmentVersion}`);
      }
    }

    if (name === '@agent-tool-platform/runtime') {
      for (const binary of runtimeBinaries) {
        const binTarget = packedManifest.bin?.[binary.name];
        if (binTarget !== binary.target) {
          fail(
            `${name}: packed manifest bin.${binary.name} must be ${binary.target}, ` +
              `found ${binTarget === undefined ? 'no mapping' : JSON.stringify(binTarget)}`,
          );
        } else {
          const executable = join(extracted, binTarget);
          if (!shipped.has(binTarget) || !existsSync(executable)) {
            fail(`${name}: packed bin target ${binTarget} does not exist in the tarball`);
          } else if (!readFileSync(executable, 'utf8').startsWith('#!/usr/bin/env node\n')) {
            fail(`${name}: packed bin target ${binTarget} does not begin with the Node shebang`);
          }
        }
      }

      for (const schemaFile of runtimeSchemaFiles) {
        const schema = readManifest(join(extracted, schemaFile));
        if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
          fail(`${name}: ${schemaFile} is not a Draft 2020-12 JSON Schema`);
        }
      }
    }

    for (const file of artefact.files) {
      if (!/\.(js|d\.ts)$/u.test(file)) continue;
      const contents = readFileSync(join(extracted, file), 'utf8');
      if (/['"][^'"]*\.\.\/src\//u.test(contents)) {
        fail(`${name}: ${file} references an unpublished source path`);
      }
    }

    // The shipped license must be the repository's license, compared as bytes rather than as text:
    // a re-worded, re-wrapped, or differently line-ended copy is a different legal document, and a
    // drifted per-package license is exactly the kind of thing nobody notices until it matters.
    if (shipped.has('LICENSE')) {
      const shippedLicense = readFileSync(join(extracted, 'LICENSE'));
      if (!shippedLicense.equals(rootLicense)) {
        fail(`${name}: the shipped LICENSE is not byte-identical to the repository LICENSE`);
      }
    }

    note(`${name}@${manifest.version}: packed ${artefact.files.length} files`);
  }

  if (failures.length === 0) {
    consumers.push(exerciseRuntimeBinaries(packed['@agent-tool-platform/runtime']));

    // Runtime must stand alone. Testkit must consume the packed runtime, not the workspace one.
    const runtimeOnly = { '@agent-tool-platform/runtime': packed['@agent-tool-platform/runtime'] };
    const runtimeConsumer = createConsumer('runtime', runtimeOnly, '@agent-tool-platform/runtime');
    consumers.push(runtimeConsumer);
    exerciseConsumer(runtimeConsumer, runtimeOnly);

    const testkitClosure = {
      '@agent-tool-platform/runtime': packed['@agent-tool-platform/runtime'],
      '@agent-tool-platform/testkit': packed['@agent-tool-platform/testkit'],
    };
    const testkitConsumer = createConsumer(
      'testkit',
      testkitClosure,
      '@agent-tool-platform/testkit',
    );
    consumers.push(testkitConsumer);
    exerciseConsumer(testkitConsumer, testkitClosure);

    const registryClosure = {
      '@agent-tool-platform/capability-registry':
        packed['@agent-tool-platform/capability-registry'],
    };
    const registryConsumer = createInstalledConsumer(
      'capability-registry',
      registryClosure,
      '@agent-tool-platform/capability-registry',
    );
    consumers.push(registryConsumer);
    if (registryConsumer.installed) {
      exerciseConsumer(registryConsumer, registryClosure);
      exerciseRegistryAssets(registryConsumer);
    }

    const agentKitClosure = {
      '@agent-tool-platform/runtime': packed['@agent-tool-platform/runtime'],
      '@agent-tool-platform/capability-registry':
        packed['@agent-tool-platform/capability-registry'],
      '@agent-tool-platform/agent-kit': packed['@agent-tool-platform/agent-kit'],
    };
    const agentKitConsumer = createInstalledConsumer(
      'agent-kit',
      agentKitClosure,
      '@agent-tool-platform/agent-kit',
    );
    consumers.push(agentKitConsumer);
    if (agentKitConsumer.installed) {
      exerciseConsumer(agentKitConsumer, agentKitClosure);
      exerciseAgentKitBuild(agentKitConsumer);
    }

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
    'Publication smoke test passed: all four tarballs ship only intended files, external npm installs resolve exact Platform dependencies, Registry data and schemas load, Agent Kit builds deterministically, Runtime commands work, and public declarations type-check.\n',
  );
}
