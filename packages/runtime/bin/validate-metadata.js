#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MetadataValidationError, assertCapabilityMetadata } from '../dist/metadata/index.js';

/**
 * `agent-tool-validate-metadata`
 *
 * Validates a capability repository's `server.json`, `package.json`, and optional central registry
 * entry. Intended to run in a capability repository's CI, not here: this repository is a library,
 * not a server, and has no server metadata to check.
 *
 * Usage:
 *   agent-tool-validate-metadata [--server server.json] [--package package.json] [--registry path]
 */

const parseArguments = (argv) => {
  const options = { server: 'server.json', package: 'package.json', registry: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--server' && value) options.server = value;
    else if (flag === '--package' && value) options.package = value;
    else if (flag === '--registry' && value) options.registry = value;
  }
  return options;
};

const loadJson = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'));

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const [server, packageManifest] = await Promise.all([
    loadJson(options.server),
    loadJson(options.package),
  ]);
  const registryEntry = options.registry ? await loadJson(options.registry) : undefined;

  assertCapabilityMetadata({
    server,
    packageManifest,
    ...(registryEntry === undefined ? {} : { registryEntry }),
  });
  process.stdout.write('Metadata is consistent, truthful, and free of placeholders.\n');
};

main().catch((error) => {
  if (error instanceof MetadataValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
