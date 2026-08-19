import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MetadataValidationError,
  assertCapabilityMetadata,
  containsPlaceholder,
} from '@agent-tool-platform/runtime';

/**
 * Repository metadata check.
 *
 * This repository is a library, not a capability server: it has no `server.json`, no MCP registry
 * entry, and no public endpoint. The capability validator in `@agent-tool-platform/runtime`
 * therefore does not apply to the manifests here, and applying it would invent a server identity
 * and a remote endpoint that do not exist. What is checked instead:
 *
 * - the two platform packages are publishable, because npm distribution is now the intended
 *   channel, and every other manifest in the workspace stays private,
 * - every workspace package carries the same version as the root,
 * - no placeholder or fake-domain content has crept into a manifest,
 * - no documentation asserts that the packages are already on npm, because preparing a release is
 *   not the same as having published one,
 * - no `server.json` has appeared here, which would apply capability semantics to a library,
 * - and the shared capability validator still accepts a truthful document and rejects a fake one,
 *   which is the contract capability repositories consume through `agent-tool-validate-metadata`.
 *
 * The capability rules themselves are deliberately untouched: a capability that declares an npm
 * package while being private is still wrong, and a publishable capability that declares no
 * distribution channel is still wrong. This repository's own publishability is asserted by
 * `npm run release:check`, not by loosening a validator other repositories depend on.
 */

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly homepage?: string;
  readonly repository?: { readonly url?: string };
  readonly publishConfig?: { readonly access?: string; readonly registry?: string };
}

/** The only manifests in this workspace that are meant to reach a registry. */
const publishablePackages = ['packages/runtime/package.json', 'packages/testkit/package.json'];
const privatePackages = ['package.json', 'examples/minimal-capability/package.json'];

const load = async (path: string): Promise<Manifest> =>
  JSON.parse(await readFile(resolve(path), 'utf8')) as Manifest;

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(resolve(path));
    return true;
  } catch {
    return false;
  }
};

const failures: string[] = [];

const root = await load('package.json');

for (const path of [...privatePackages, ...publishablePackages]) {
  const manifest = await load(path);
  if (manifest.version !== root.version) {
    failures.push(`${path}: version ${manifest.version} does not match the root ${root.version}`);
  }
  for (const [field, value] of Object.entries({
    description: manifest.description,
    homepage: manifest.homepage,
    repository: manifest.repository?.url,
  })) {
    if (typeof value === 'string' && containsPlaceholder(value)) {
      failures.push(`${path}: ${field} still contains placeholder content`);
    }
  }
}

for (const path of privatePackages) {
  const manifest = await load(path);
  if (manifest.private !== true) {
    failures.push(
      `${path}: must remain private; the repository root and fixtures are not products`,
    );
  }
}

for (const path of publishablePackages) {
  const manifest = await load(path);
  if (manifest.private === true) {
    failures.push(`${path}: is private but is one of the two packages this repository distributes`);
  }
  if (manifest.publishConfig?.access !== 'public') {
    failures.push(`${path}: declares npm distribution without public access`);
  }
  if (manifest.publishConfig?.registry !== 'https://registry.npmjs.org') {
    failures.push(`${path}: must publish to the primary npm registry`);
  }
  if (manifest.repository?.url !== 'git+https://github.com/ashergarland/agent-tool-platform.git') {
    failures.push(`${path}: repository metadata must point at this repository`);
  }
}

/**
 * A library repository has no server identity. If a `server.json` ever appeared here it would claim
 * a capability endpoint the platform does not have.
 */
if (await exists('server.json')) {
  failures.push(
    'server.json exists at the repository root: the platform is a library, not a capability server',
  );
}

/**
 * PRE-PUBLICATION ONLY.
 *
 * Preparing a release is not the same as having published one. A version badge or a package page
 * link asserts that something is already on npm, so neither may appear until it is true.
 *
 * This block expires. Once 0.1.0 is actually published the rule becomes wrong — it will reject the
 * very README edits that make the repository truthful again — so it must be removed, or inverted
 * into a check that a claimed version matches the manifests, as part of the one-time transition
 * described in `docs/releasing.md`. Nothing else in this file is tied to the pre-publication state.
 */
const claimPatterns: readonly (readonly [RegExp, string])[] = [
  [/shields\.io\/npm\//u, 'an npm version or download badge'],
  [/npmjs\.com\/package\/@agent-tool-platform/u, 'a link to an npm package page'],
];
const documentation = [
  'README.md',
  'docs/releasing.md',
  'packages/runtime/README.md',
  'packages/testkit/README.md',
];
for (const path of documentation) {
  if (!(await exists(path))) continue;
  const contents = await readFile(resolve(path), 'utf8');
  for (const [pattern, description] of claimPatterns) {
    if (pattern.test(contents)) {
      failures.push(
        `${path}: contains ${description}, which claims a publication that has not happened`,
      );
    }
  }
}

// A truthful capability document must pass, and a fake one must not. This is the behaviour a
// capability repository relies on, so it is checked here rather than assumed.
const truthful = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'io.github.example-owner/agent-tool-server-sample',
  description: 'A representative capability document used to exercise the shared validator.',
  version: root.version,
  repository: {
    url: 'https://github.com/example-owner/agent-tool-server-sample',
    source: 'github',
  },
};
const sampleManifest = {
  name: 'agent-tool-server-sample',
  version: root.version,
  private: true,
};

try {
  assertCapabilityMetadata({ server: truthful, packageManifest: sampleManifest });
} catch (error) {
  failures.push(
    `the shared validator rejected a truthful document: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

let rejectedFake = false;
try {
  assertCapabilityMetadata({
    server: {
      ...truthful,
      remotes: [{ type: 'streamable-http', url: 'https://replace-me.example.com/mcp' }],
    },
    packageManifest: sampleManifest,
  });
} catch (error) {
  rejectedFake = error instanceof MetadataValidationError;
}
if (!rejectedFake) failures.push('the shared validator accepted a placeholder production URL');

let rejectedUndeclaredChannel = false;
try {
  assertCapabilityMetadata({
    server: truthful,
    packageManifest: { ...sampleManifest, private: false },
  });
} catch (error) {
  rejectedUndeclaredChannel = error instanceof MetadataValidationError;
}
if (!rejectedUndeclaredChannel) {
  failures.push(
    'the shared validator accepted a publishable capability that declares no distribution channel',
  );
}

if (failures.length > 0) {
  process.stderr.write(`Metadata check failed:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Workspace metadata is consistent: the two platform packages are publishable and truthful, everything else stays private, no documentation claims an npm publication that has not happened, and the shared capability validator still behaves correctly.\n',
  );
}
