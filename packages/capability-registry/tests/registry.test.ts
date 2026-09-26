import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  accessDimensions as runtimeAccessDimensions,
  deliveryDimensions as runtimeDeliveryDimensions,
  executionDimensions as runtimeExecutionDimensions,
  mutationDimensions as runtimeMutationDimensions,
  providerDimensions as runtimeProviderDimensions,
  workloadDimensions as runtimeWorkloadDimensions,
} from '@agent-tool-platform/runtime';
import {
  accessDimensions,
  capabilityEntryJsonSchema,
  capabilityRegistryJsonSchema,
  checkFirstPartyRegistry,
  capabilityRegistrySchemaVersion,
  createCapabilityRegistryReader,
  deliveryDimensions,
  executionDimensions,
  generateFirstPartyRegistry,
  loadFirstPartyCapabilityRegistry,
  mutationDimensions,
  normalizeCapabilityEntry,
  providerDimensions,
  serializeCapabilityRegistry,
  validateAccountNeutrality,
  validateCapabilityEntryDocument,
  validateCapabilityRegistryDocument,
  validateStaticFirstPartyRegistry,
  workloadDimensions,
  type CapabilityEntry,
  type CapabilityRegistry,
  type RegistryJsonSchema,
} from '../src/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoots: string[] = [];

const clone = <T>(value: T): T => structuredClone(value);
const asZodJsonSchema = (schema: RegistryJsonSchema): Parameters<typeof z.fromJSONSchema>[0] =>
  schema;
const readJson = (...path: readonly string[]): unknown =>
  JSON.parse(readFileSync(join(packageRoot, ...path), 'utf8')) as unknown;

const createFixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'capability-registry-'));
  temporaryRoots.push(root);
  await Promise.all([
    cp(join(packageRoot, 'data', 'entries'), join(root, 'data', 'entries'), {
      recursive: true,
    }),
    cp(join(packageRoot, 'package.json'), join(root, 'package.json')),
  ]);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('capability registry JSON Schemas', () => {
  it('stays aligned with the Platform deployment dimension vocabulary', () => {
    expect(executionDimensions).toEqual(runtimeExecutionDimensions);
    expect(deliveryDimensions).toEqual(runtimeDeliveryDimensions);
    expect(accessDimensions).toEqual(runtimeAccessDimensions);
    expect(workloadDimensions).toEqual(runtimeWorkloadDimensions);
    expect(providerDimensions).toEqual(runtimeProviderDimensions);
    expect(mutationDimensions).toEqual(runtimeMutationDimensions);
  });

  it('ships deterministic Draft 2020-12 schemas without drift', () => {
    expect(readJson('schemas', 'v1', 'capability-entry.schema.json')).toEqual(
      capabilityEntryJsonSchema,
    );
    expect(readJson('schemas', 'v1', 'capability-registry.schema.json')).toEqual(
      capabilityRegistryJsonSchema,
    );
    expect(capabilityEntryJsonSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(capabilityRegistryJsonSchema.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
  });

  it('executes both language-neutral schemas and rejects unknown versions', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const entrySchema = z.fromJSONSchema(asZodJsonSchema(capabilityEntryJsonSchema));
    const registrySchema = z.fromJSONSchema(asZodJsonSchema(capabilityRegistryJsonSchema));

    expect(entrySchema.safeParse(registry.capabilities[0]).success).toBe(true);
    expect(registrySchema.safeParse(registry).success).toBe(true);
    expect(capabilityRegistrySchemaVersion).toBe('1.1.0');

    const entry = clone(registry.capabilities[0]!);
    const priorEntry = { ...entry, schemaVersion: '1.0.0' };
    const priorRegistry = { ...registry, schemaVersion: '1.0.0' };
    const unsupportedEntry = { ...entry, schemaVersion: '2.0.0' };
    const unsupportedRegistry = { ...registry, schemaVersion: '2.0.0' };
    expect(entrySchema.safeParse(priorEntry).success).toBe(false);
    expect(registrySchema.safeParse(priorRegistry).success).toBe(false);
    expect(entrySchema.safeParse(unsupportedEntry).success).toBe(false);
    expect(registrySchema.safeParse(unsupportedRegistry).success).toBe(false);
  });
});

describe('first-party registry', () => {
  it('validates the complete checked-in registry', async () => {
    expect(await validateStaticFirstPartyRegistry()).toEqual({ valid: true, errors: [] });
  });

  it('contains all seven integrated capability entries with their current tool counts', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const counts = Object.fromEntries(
      registry.capabilities.map((entry) => [entry.id, entry.toolCount]),
    );
    expect(counts).toEqual({
      'ast-summarizer': 2,
      azure: 18,
      'data-cruncher': 2,
      'doc-rag': 1,
      'document-optimizer': 6,
      'git-optimizer': 1,
      vision: 4,
    });
  });

  it('represents local, remote, and hybrid bindings with one generic profile shape', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const availability = new Set(
      registry.capabilities.flatMap((entry) =>
        entry.bindings.map((binding) => binding.availability),
      ),
    );
    expect(availability).toEqual(new Set(['local', 'remote', 'hybrid']));

    const dimensionKeys = ['access', 'delivery', 'execution', 'mutation', 'provider', 'workload'];
    for (const entry of registry.capabilities) {
      expect('tools' in entry).toBe(false);
      for (const profile of entry.profiles) {
        expect(Object.keys(profile.dimensions).sort()).toEqual(dimensionKeys);
      }
    }

    const azure = registry.capabilities.find((entry) => entry.id === 'azure');
    expect(azure?.bindings.map((binding) => binding.client?.http.headers)).toEqual([
      [
        {
          name: 'x-api-key',
          value: {
            source: 'configuration',
            name: 'connector-api-key',
            prefix: '',
          },
        },
      ],
      [
        {
          name: 'x-api-key',
          value: {
            source: 'configuration',
            name: 'connector-api-key',
            prefix: '',
          },
        },
      ],
    ]);
  });

  it('generates byte-for-byte deterministic sorted output', async () => {
    const first = await generateFirstPartyRegistry();
    const second = await generateFirstPartyRegistry();
    expect(serializeCapabilityRegistry(second)).toBe(serializeCapabilityRegistry(first));
    expect(await checkFirstPartyRegistry()).toEqual([]);
    expect(first.capabilities.map((entry) => entry.id)).toEqual(
      [...first.capabilities.map((entry) => entry.id)].sort(),
    );
    for (const entry of first.capabilities) {
      expect(entry.tags).toEqual([...entry.tags].sort());
      expect(entry.profiles.map((profile) => profile.id)).toEqual(
        [...entry.profiles.map((profile) => profile.id)].sort(),
      );
      expect(entry.bindings.map((binding) => binding.id)).toEqual(
        [...entry.bindings.map((binding) => binding.id)].sort(),
      );
    }
  });

  it('orders HTTP headers case-insensitively while preserving declared casing', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const azure = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
    const binding = azure.bindings.find((item) => item.id === 'hosted-read-only-http')!;
    binding.client!.http.headers = [
      {
        name: 'Z-Trace',
        value: { source: 'configuration', name: 'connector-api-key', prefix: '' },
      },
      ...binding.client!.http.headers,
      {
        name: 'Authorization',
        value: {
          source: 'configuration',
          name: 'connector-api-key',
          prefix: 'Bearer ',
        },
      },
    ];

    const normalized = normalizeCapabilityEntry(azure);
    expect(
      normalized.bindings
        .find((item) => item.id === 'hosted-read-only-http')
        ?.client?.http.headers.map((header) => header.name),
    ).toEqual(['Authorization', 'x-api-key', 'Z-Trace']);
  });
});

describe('registry semantic validation', () => {
  const withCapabilities = (
    registry: CapabilityRegistry,
    capabilities: CapabilityEntry[],
  ): CapabilityRegistry => ({ ...registry, capabilities });

  it('rejects duplicate capability IDs', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const duplicate = clone(registry.capabilities[0]!);
    const result = validateCapabilityRegistryDocument(
      withCapabilities(registry, [...registry.capabilities, duplicate]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('duplicate capability ID');
  });

  it('rejects a malformed profile', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const entry = clone(registry.capabilities[0]!);
    const malformed = {
      ...entry,
      profiles: [
        {
          ...entry.profiles[0],
          dimensions: { execution: 'edge' },
        },
      ],
    };
    const result = validateCapabilityEntryDocument(malformed);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('dimensions');
  });

  it('rejects invalid profile and artifact binding references', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const entry = clone(registry.capabilities[0]!);
    entry.bindings[0] = {
      ...entry.bindings[0]!,
      profileId: 'missing-profile',
      artifactId: 'missing-artifact',
    };
    const result = validateCapabilityEntryDocument(entry);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('references unknown profile'),
        expect.stringContaining('references unknown artifact'),
      ]),
    );
  });

  it('rejects authenticated remote HTTP bindings without a complete client mapping', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const azure = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
    const binding = azure.bindings.find((item) => item.id === 'hosted-read-only-http')!;
    delete binding.client;

    const missing = validateCapabilityEntryDocument(azure);
    expect(missing.valid).toBe(false);
    expect(missing.errors.join('\n')).toContain(
      'has no HTTP client mapping for required configuration connector-api-key',
    );

    const incomplete = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
    incomplete.profiles
      .find((profile) => profile.id === 'hosted-read-only')!
      .prerequisites.requiredSecrets.push('second-secret');
    expect(validateCapabilityEntryDocument(incomplete).errors.join('\n')).toContain(
      'has no HTTP client mapping for required configuration second-secret',
    );
  });

  it('rejects mappings to undeclared configuration', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const azure = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
    const header = azure.bindings.find((item) => item.id === 'hosted-read-only-http')!.client!.http
      .headers[0]!;
    header.value.name = 'invented-secret';

    expect(validateCapabilityEntryDocument(azure).errors.join('\n')).toContain(
      'references undeclared configuration invented-secret',
    );
  });

  it('rejects duplicate HTTP header names case-insensitively', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const azure = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
    const headers = azure.bindings.find((item) => item.id === 'hosted-read-only-http')!.client!.http
      .headers;
    headers.push({
      name: 'X-API-Key',
      value: { source: 'configuration', name: 'connector-api-key', prefix: '' },
    });

    expect(validateCapabilityEntryDocument(azure).errors.join('\n')).toContain(
      'duplicate hosted-read-only-http HTTP client header name (case-insensitive): x-api-key',
    );
  });

  it.each(['', 'bad header', 'bad:header', 'bad\rheader', 'bad\nheader', 'bad(header)'])(
    'rejects invalid HTTP header name %j',
    async (name) => {
      const registry = await loadFirstPartyCapabilityRegistry();
      const azure = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
      azure.bindings.find(
        (item) => item.id === 'hosted-read-only-http',
      )!.client!.http.headers[0]!.name = name;

      const errors = validateCapabilityEntryDocument(azure).errors.join('\n');
      expect(errors).toMatch(/HTTP header name|Too small/u);
    },
  );

  it.each(['Bearer\r', 'Bearer\n', '${input:other}', 'x'.repeat(101)])(
    'rejects unsafe HTTP header prefix %j',
    async (prefix) => {
      const registry = await loadFirstPartyCapabilityRegistry();
      const azure = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
      azure.bindings.find(
        (item) => item.id === 'hosted-read-only-http',
      )!.client!.http.headers[0]!.value.prefix = prefix;

      expect(validateCapabilityEntryDocument(azure).valid).toBe(false);
    },
  );

  it.each(['stdio', 'library', 'custom'] as const)(
    'rejects HTTP client mappings on the %s interface',
    async (bindingInterface) => {
      const registry = await loadFirstPartyCapabilityRegistry();
      const ast = clone(registry.capabilities.find((entry) => entry.id === 'ast-summarizer')!);
      ast.bindings[0]!.interface = bindingInterface;
      ast.bindings[0]!.client = {
        http: {
          headers: [
            {
              name: 'Authorization',
              value: { source: 'configuration', name: 'access-token', prefix: 'Bearer ' },
            },
          ],
        },
      };

      expect(validateCapabilityEntryDocument(ast).errors.join('\n')).toContain(
        'HTTP client mapping requires the http interface',
      );
    },
  );

  it('does not admit a secret value field into the client mapping contract', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const azure = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
    const value = azure.bindings.find((item) => item.id === 'hosted-read-only-http')!.client!.http
      .headers[0]!.value;
    Object.assign(value, { secretValue: 'must-not-enter-registry' });

    const errors = validateCapabilityEntryDocument(azure).errors.join('\n');
    expect(errors).toContain('Unrecognized key');
    expect(errors).toContain('secretValue');
  });

  it('accepts an unauthenticated remote HTTP binding without a client mapping', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const azure = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
    for (const profile of azure.profiles) profile.prerequisites.requiredSecrets = [];
    for (const binding of azure.bindings) delete binding.client;

    expect(validateCapabilityEntryDocument(azure)).toEqual({ valid: true, errors: [] });
  });

  it('rejects invalid capability versions and artifact references', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const entry = clone(registry.capabilities[0]!);
    const invalid = {
      ...entry,
      version: { ...entry.version, value: 'v1' },
      artifacts: [
        {
          ...entry.artifacts[0],
          version: 'latest',
          reference: 'C:\\private\\artifact.json',
        },
      ],
    };
    const result = validateCapabilityEntryDocument(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('semantic version');
    expect(result.errors.join('\n')).toContain('repository-relative reference');
  });

  it('rejects mutation-state inconsistencies', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const vision = clone(registry.capabilities.find((entry) => entry.id === 'vision')!);
    vision.stateChanging = false;
    expect(validateCapabilityEntryDocument(vision).errors.join('\n')).toContain(
      'stateChanging does not match',
    );

    const mutating = vision.profiles.find((profile) => profile.dimensions.mutation === 'mutating')!;
    mutating.stateEffects = [];
    expect(validateCapabilityEntryDocument(vision).errors.join('\n')).toContain(
      'mutation dimension and stateEffects are inconsistent',
    );
  });

  it('rejects malformed registry JSON without throwing an unhelpful parse error', async () => {
    const root = await createFixtureRoot();
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'first-party-registry.json'), '{broken', 'utf8');
    const result = await validateStaticFirstPartyRegistry(root);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('malformed JSON');
  });

  it.each([
    ['local path', 'C:\\Users\\operator\\private-config.json'],
    ['account identifier', '00000000-1111-4111-8111-222222222222'],
    ['private endpoint', 'https://service.privatelink.database.windows.net'],
    ['private IPv4 endpoint', 'https://192.168.1.1/private'],
    ['private IPv6 endpoint', 'https://[fd00::1]'],
    ['link-local IPv6 endpoint', 'https://[fe80::1]/private'],
    ['IPv4-mapped private endpoint', 'https://[::ffff:127.0.0.1]'],
    ['secret value', 'api_key=do-not-store-this'],
  ])('rejects account-specific %s data', async (_label, value) => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const entry = clone(registry.capabilities[0]!);
    entry.routing.summary = value;
    expect(validateAccountNeutrality([entry]).join('\n')).not.toBe('');
    expect(validateCapabilityEntryDocument(entry).valid).toBe(false);
  });

  it('applies account-neutrality validation to HTTP header prefixes', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const azure = clone(registry.capabilities.find((entry) => entry.id === 'azure')!);
    azure.bindings.find(
      (item) => item.id === 'hosted-read-only-http',
    )!.client!.http.headers[0]!.value.prefix = 'token=do-not-store-this';

    expect(validateAccountNeutrality([azure]).join('\n')).toContain(
      'private secret value assignment',
    );
    expect(validateCapabilityEntryDocument(azure).valid).toBe(false);
  });

  it.each([
    ['localhost', 'https://localhost./private'],
    ['internal', 'https://service.internal./private'],
    ['local', 'https://printer.local./private'],
    ['Private Link', 'https://service.privatelink.database.windows.net./private'],
    ['multiple trailing dots', 'https://localhost.../private'],
  ])('rejects trailing-dot private %s endpoints', async (_label, value) => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const entry = clone(registry.capabilities[0]!);
    entry.routing.summary = value;
    expect(validateAccountNeutrality([entry]).join('\n')).toContain('private endpoint');
    expect(validateCapabilityEntryDocument(entry).valid).toBe(false);
  });

  it.each(['https://example.com/public', 'https://example.com./public'])(
    'accepts account-neutral public endpoint %s',
    async (value) => {
      const registry = await loadFirstPartyCapabilityRegistry();
      const entry = clone(registry.capabilities[0]!);
      entry.routing.summary = value;
      expect(validateAccountNeutrality([entry])).toEqual([]);
      expect(validateCapabilityEntryDocument(entry).valid).toBe(true);
    },
  );
});

describe('Agent Kit read seam', () => {
  it('resolves Azure 0.3.0 as the current released capability', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const reader = createCapabilityRegistryReader(registry);

    expect(reader.getCapability('azure')).toMatchObject({
      id: 'azure',
      version: {
        value: '0.3.0',
        status: 'released',
      },
      artifacts: [
        {
          id: 'oci-container',
          kind: 'oci',
          identifier: 'ghcr.io/ashergarland/agent-tool-server-azure',
          version: '0.3.0',
          availability: 'published',
          reference: 'v0.3.0',
        },
      ],
      source: {
        revision: 'd036a12b5028c9d873a0fc6eec5ec450aebb8414',
        metadataVersion: '0.3.0',
        releaseTag: 'v0.3.0',
      },
    });
  });

  it('enumerates, resolves, and exposes profiles and bindings without composition logic', async () => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const reader = createCapabilityRegistryReader(registry);

    expect(reader.listCapabilities()).toHaveLength(7);
    expect(reader.getCapability('ast-summarizer')?.version.value).toBe('0.1.1');
    expect(reader.getCapability('missing')).toBeUndefined();
    expect(reader.listProfiles('vision')?.map((profile) => profile.id)).toEqual([
      'hybrid-azure-package',
      'local-package',
    ]);
    expect(reader.listBindings('azure')?.map((binding) => binding.availability)).toEqual([
      'remote',
      'remote',
    ]);
    expect(reader.listProfiles('missing')).toBeUndefined();
  });
});
