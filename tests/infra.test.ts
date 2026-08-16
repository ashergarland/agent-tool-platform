import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Account neutrality.
 *
 * Shared infrastructure has to be safe for anyone to consume, which means it must not carry one
 * account's tenant, subscription, resource group, hostname, or credential. This suite scans the
 * Bicep sources for those shapes rather than trusting review to catch them.
 */

const infraRoot = new URL('../infra/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');

const listBicepFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listBicepFiles(path)));
    else if (entry.name.endsWith('.bicep')) files.push(path);
  }
  return files;
};

/**
 * Azure built-in role definition ids are GUIDs and are legitimately hard-coded: they are the same
 * in every tenant. Every other GUID in a shared module would be account-specific.
 */
const allowedRoleDefinitionIds = new Set([
  '7f951dda-4ed3-4680-a7ca-43fe172d538d', // AcrPull
  '4633458b-17de-408a-b874-0445c86b69e6', // Key Vault Secrets User
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7', // Key Vault Secrets Officer
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe', // Storage Blob Data Contributor
  '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1', // Storage Blob Data Reader
]);

const guidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

describe('shared infrastructure', () => {
  it('ships the modules the platform promises', async () => {
    const files = (await listBicepFiles(infraRoot)).map((file) =>
      relative(infraRoot, file).split('\\').join('/'),
    );
    expect(files).toEqual(
      expect.arrayContaining([
        'modules/container-app.bicep',
        'modules/container-registry.bicep',
        'modules/identity.bicep',
        'modules/key-vault.bicep',
        'modules/observability.bicep',
        'modules/storage/private-blob.bicep',
        'examples/composition.bicep',
      ]),
    );
  });

  it('hard-codes no GUID other than a built-in Azure role definition', async () => {
    for (const file of await listBicepFiles(infraRoot)) {
      const source = await readFile(file, 'utf8');
      for (const guid of source.match(guidPattern) ?? []) {
        expect(allowedRoleDefinitionIds, `${file} contains ${guid}`).toContain(guid.toLowerCase());
      }
    }
  });

  it('names no account-specific tenant, subscription, resource group, or host', async () => {
    // Deliberately broad: anything that looks like one account's world has no place in a module
    // several unrelated repositories are meant to consume.
    const forbidden: readonly [RegExp, string][] = [
      [/tenantId:\s*'/u, 'a literal tenant id'],
      [/subscriptionId:\s*'/u, 'a literal subscription id'],
      [/resourceGroup\(\s*'/u, 'a literal resource group name'],
      [
        /https?:\/\/(?!schema\.management\.azure\.com|aka\.ms|mcr\.microsoft\.com)[a-z0-9.-]+\.(com|net|org|io|dev)/iu,
        'an external hostname',
      ],
      [/\b(password|clientSecret|connectionString)\s*:\s*'[^']+'/iu, 'an inline credential'],
    ];

    for (const file of await listBicepFiles(infraRoot)) {
      const source = await readFile(file, 'utf8');
      for (const [pattern, description] of forbidden) {
        expect(pattern.test(source), `${file} contains ${description}`).toBe(false);
      }
    }
  });

  it('derives every secret from a Key Vault reference rather than a parameter value', async () => {
    const containerApp = await readFile(join(infraRoot, 'modules/container-app.bicep'), 'utf8');
    expect(containerApp).toContain('keyVaultUrl');
    // Secret *values* must never be module parameters: a parameter value lands in deployment
    // history, where it is readable long after the deployment is forgotten.
    expect(containerApp).not.toMatch(/param\s+\w*[sS]ecretValue/u);

    const vault = await readFile(join(infraRoot, 'modules/key-vault.bicep'), 'utf8');
    expect(vault).toContain('enableRbacAuthorization: true');
    expect(vault).toContain('enablePurgeProtection: true');
  });

  it('keeps capability-specific settings out of the shared container app module', async () => {
    const containerApp = await readFile(join(infraRoot, 'modules/container-app.bicep'), 'utf8');
    for (const leaked of [
      'AST_',
      'JQ_',
      'RIPGREP_',
      'DOC_RAG',
      'VISION_',
      'BICEP_CLI',
      'AZURE_SUBSCRIPTION_IDS',
    ]) {
      expect(containerApp, `container-app.bicep names ${leaked}`).not.toContain(leaked);
    }
    // The extension points that replace them.
    expect(containerApp).toContain('additionalEnv');
    expect(containerApp).toContain('secretRefs');
    expect(containerApp).toContain('volumeMounts');
  });

  it('probes the platform health and readiness endpoints', async () => {
    const containerApp = await readFile(join(infraRoot, 'modules/container-app.bicep'), 'utf8');
    expect(containerApp).toContain("path: '/health'");
    expect(containerApp).toContain("path: '/ready'");
    expect(containerApp).toContain('minReplicas');
  });

  it('documents the unresolved distribution decision rather than silently choosing one', async () => {
    const readme = await readFile(join(infraRoot, 'README.md'), 'utf8');
    expect(readme).toMatch(/unresolved/iu);
    for (const candidate of ['registry', 'package', 'release artifact']) {
      expect(readme.toLowerCase()).toContain(candidate);
    }
    // No submodule has been introduced, and the README must say so explicitly.
    expect(readme.toLowerCase()).toContain('submodule');
  });
});
