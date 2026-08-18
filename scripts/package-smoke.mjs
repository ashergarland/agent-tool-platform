import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Package layout smoke test.
 *
 * `npm pack --dry-run --json` reports exactly what a consumer would receive. This script asserts
 * that every declared export target is actually in that set, that no `src/` file is shipped, and
 * that the built entry point genuinely loads and exposes the API the README documents.
 *
 * The failure this prevents is the common one: a package that works in-repo through path aliases
 * and breaks the moment someone installs it, because an export points at a file that was never
 * published.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const packages = ['packages/runtime', 'packages/testkit'];

const failures = [];

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

const packFileList = (packageDir) => {
  // A fixed literal command, so there is nothing for a shell to interpolate.
  const output = execSync('npm pack --dry-run --json', {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output);
  return new Set((parsed[0]?.files ?? []).map((entry) => entry.path.replace(/\\/gu, '/')));
};

for (const relativeDir of packages) {
  const packageDir = join(repositoryRoot, relativeDir);
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

  if (!existsSync(join(packageDir, 'dist'))) {
    failures.push(
      `${manifest.name}: dist/ is missing; run the build before the package smoke test`,
    );
    continue;
  }

  const shipped = packFileList(packageDir);

  for (const target of collectExportTargets(manifest.exports)) {
    const normalized = target.replace(/^\.\//u, '');
    if (!shipped.has(normalized)) {
      failures.push(`${manifest.name}: export target ${target} is not included in the package`);
    }
  }

  for (const binTarget of Object.values(manifest.bin ?? {})) {
    const normalized = String(binTarget).replace(/^\.\//u, '');
    if (!shipped.has(normalized)) {
      failures.push(`${manifest.name}: bin target ${binTarget} is not included in the package`);
    }
  }

  const leakedSources = [...shipped].filter((file) => file.startsWith('src/'));
  if (leakedSources.length > 0) {
    failures.push(
      `${manifest.name}: ships ${leakedSources.length} source files; consumers must depend on dist only`,
    );
  }

  if (manifest.private !== true) {
    failures.push(`${manifest.name}: must remain private; v0 publishes nothing`);
  }
}

// The built entry points must load from dist and expose the documented API.
const expectedRuntimeExports = [
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
];
const expectedTestkitExports = [
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
];

const assertExports = async (relativeDir, expected) => {
  const entry = join(repositoryRoot, relativeDir, 'dist', 'index.js');
  if (!existsSync(entry)) {
    failures.push(`${relativeDir}: dist/index.js is missing`);
    return;
  }
  const loaded = await import(pathToFileURL(entry).href);
  for (const name of expected) {
    if (!(name in loaded)) failures.push(`${relativeDir}: dist entry does not export ${name}`);
  }
};

await assertExports('packages/runtime', expectedRuntimeExports);
await assertExports('packages/testkit', expectedTestkitExports);

// npm pack --dry-run leaves nothing behind, but a previous real pack might have.
for (const relativeDir of packages) {
  for (const stale of ['agent-tool-platform-runtime-0.1.0.tgz']) {
    const path = join(repositoryRoot, relativeDir, stale);
    if (existsSync(path)) rmSync(path);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Package layout smoke test failed:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Package layout is consistent: every declared export ships and loads.\n');
}
