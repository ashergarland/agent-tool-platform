import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export const capabilityRegistryPackageRoot = resolve(sourceDirectory, '..');
export const capabilityEntriesDirectory = 'data/entries';
export const firstPartyRegistryPath = 'data/first-party-registry.json';
