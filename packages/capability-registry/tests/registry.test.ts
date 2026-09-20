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
  createCapabilityRegistryReader,
  deliveryDimensions,
  executionDimensions,
  generateFirstPartyRegistry,
  loadFirstPartyCapabilityRegistry,
  mutationDimensions,
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

    const entry = clone(registry.capabilities[0]!);
    const unsupportedEntry = { ...entry, schemaVersion: '2.0.0' };
    const unsupportedRegistry = { ...registry, schemaVersion: '2.0.0' };
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
    ['private IPv6 endpoint', 'https://[fd00::1]'],
    ['IPv4-mapped private endpoint', 'https://[::ffff:127.0.0.1]'],
    ['secret value', 'api_key=do-not-store-this'],
  ])('rejects account-specific %s data', async (_label, value) => {
    const registry = await loadFirstPartyCapabilityRegistry();
    const entry = clone(registry.capabilities[0]!);
    entry.routing.summary = value;
    expect(validateAccountNeutrality([entry]).join('\n')).not.toBe('');
    expect(validateCapabilityEntryDocument(entry).valid).toBe(false);
  });
});

describe('Agent Kit read seam', () => {
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
