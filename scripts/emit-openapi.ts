import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createAgentToolApplication, createSilentLogger } from '@agent-tool-platform/runtime';
import minimalCapability, {
  type MinimalConfig,
  type MinimalServices,
} from '@agent-tool-platform/example-minimal-capability';

/**
 * Emits the OpenAPI document for the minimal capability fixture.
 *
 * CI runs this to prove the generator produces a complete document for a real capability, and to
 * publish the result as an artifact that can be diffed across changes.
 */

const target = resolve(process.argv[2] ?? 'openapi.fixture.json');

const application = await createAgentToolApplication<MinimalServices, MinimalConfig>(
  minimalCapability,
  {
    logger: createSilentLogger(),
    env: {
      NODE_ENV: 'development',
      AUTH_MODE: 'disabled',
      SERVICE_VERSION: '0.1.0',
      PUBLIC_BASE_URL: 'http://localhost:8080',
    },
  },
);

const document = application.openApiDocument();
const operations = Object.keys(document['paths'] as Record<string, unknown>).filter((path) =>
  path.startsWith('/tools/'),
);

if (operations.length !== application.registry.size) {
  throw new Error(
    `OpenAPI drift: ${operations.length} tool operations for ${application.registry.size} registered tools`,
  );
}

await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
await application.shutdown();

console.log(`Wrote ${target} with ${operations.length} tool operations.`);
