import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  capabilityEntryJsonSchema,
  capabilityRegistryJsonSchema,
} from '../packages/capability-registry/src/schema.js';

const schemaDirectory = fileURLToPath(
  new URL('../packages/capability-registry/schemas/v1/', import.meta.url),
);

const schemas = [
  {
    name: 'capability-entry.schema.json',
    document: capabilityEntryJsonSchema,
  },
  {
    name: 'capability-registry.schema.json',
    document: capabilityRegistryJsonSchema,
  },
] as const;

await mkdir(schemaDirectory, { recursive: true });
await Promise.all(
  schemas.map(async ({ name, document }) => {
    const path = resolve(schemaDirectory, name);
    const prettierOptions = (await resolveConfig(path)) ?? {};
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      await format(JSON.stringify(document), {
        ...prettierOptions,
        parser: 'json',
      }),
      'utf8',
    );
  }),
);

process.stdout.write(`Emitted ${schemas.length} capability registry schemas.\n`);
