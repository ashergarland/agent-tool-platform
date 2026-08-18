import { readFile } from 'node:fs/promises';
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
 * entry, and no public endpoint, so there is nothing here to validate against the capability
 * schema. What can drift is the workspace itself, so this script asserts:
 *
 * - every workspace package carries the same version as the root,
 * - nothing is accidentally publishable, because v0 publishes nothing,
 * - no placeholder or fake-domain content has crept into a manifest,
 * - and the shared capability validator still accepts a truthful document and rejects a fake one,
 *   which is the contract capability repositories consume through `agent-tool-validate-metadata`.
 */

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly repository?: { readonly url?: string };
}

const workspacePackages = [
  'package.json',
  'packages/runtime/package.json',
  'packages/testkit/package.json',
  'examples/minimal-capability/package.json',
];

const load = async (path: string): Promise<Manifest> =>
  JSON.parse(await readFile(resolve(path), 'utf8')) as Manifest;

const failures: string[] = [];

const root = await load('package.json');

for (const path of workspacePackages) {
  const manifest = await load(path);
  if (manifest.version !== root.version) {
    failures.push(`${path}: version ${manifest.version} does not match the root ${root.version}`);
  }
  if (manifest.private !== true) {
    failures.push(`${path}: must remain private; this repository publishes nothing in v0`);
  }
  for (const [field, value] of Object.entries({
    description: manifest.description,
    repository: manifest.repository?.url,
  })) {
    if (typeof value === 'string' && containsPlaceholder(value)) {
      failures.push(`${path}: ${field} still contains placeholder content`);
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

if (failures.length > 0) {
  process.stderr.write(`Metadata check failed:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Workspace metadata is consistent, unpublished, and free of placeholders; the shared capability validator behaves correctly.\n',
  );
}
