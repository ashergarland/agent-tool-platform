import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import {
  capabilityProfileDeclarationJsonSchema,
  deploymentInstanceJsonSchema,
} from '../packages/runtime/src/deployment/schemas.js';

const schemaDirectory = fileURLToPath(
  new URL('../packages/runtime/schemas/deployment/v1/', import.meta.url),
);

const schemas = [
  {
    name: 'capability-profile-declaration.schema.json',
    document: capabilityProfileDeclarationJsonSchema,
  },
  {
    name: 'deployment-instance.schema.json',
    document: deploymentInstanceJsonSchema,
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

process.stdout.write(`Emitted ${schemas.length} deployment contract schemas.\n`);
