import { describe, expect, it } from 'vitest';
import {
  MetadataValidationError,
  assertCapabilityMetadata,
  containsPlaceholder,
  validateCapabilityMetadata,
} from '@agent-tool-platform/runtime';

const validServer = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'io.github.example-owner/agent-tool-server-thing',
  description: 'Structured analysis tools for a single local workspace.',
  version: '1.2.3',
  repository: { url: 'https://github.com/example-owner/agent-tool-server-thing', source: 'github' },
};

const privateManifest = { name: 'agent-tool-server-thing', version: '1.2.3', private: true };

describe('placeholder detection', () => {
  it('recognizes the usual unfinished-metadata markers', () => {
    for (const value of [
      'https://replace-me.invalid/mcp',
      'https://tools.example.com',
      'TODO: describe',
      'changeme',
      'your-domain.net',
    ]) {
      expect(containsPlaceholder(value), value).toBe(true);
    }
    expect(containsPlaceholder('https://github.com/example-owner/thing')).toBe(false);
  });
});

describe('validateCapabilityMetadata', () => {
  it('accepts truthful private metadata', () => {
    expect(
      validateCapabilityMetadata({ server: validServer, packageManifest: privateManifest }),
    ).toEqual({ valid: true, errors: [] });
  });

  it('rejects placeholder descriptions and remotes', () => {
    expect(
      validateCapabilityMetadata({
        server: { ...validServer, description: 'A server. TODO: write this.' },
        packageManifest: privateManifest,
      }).valid,
    ).toBe(false);

    expect(
      validateCapabilityMetadata({
        server: {
          ...validServer,
          remotes: [{ type: 'streamable-http', url: 'https://replace-me.invalid/mcp' }],
        },
        packageManifest: privateManifest,
      }).valid,
    ).toBe(false);
  });

  it('rejects a version mismatch between server.json and package.json', () => {
    const result = validateCapabilityMetadata({
      server: validServer,
      packageManifest: { ...privateManifest, version: '9.9.9' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('version mismatch');
  });

  it('rejects a non-semantic version', () => {
    expect(
      validateCapabilityMetadata({
        server: { ...validServer, version: 'v1' },
        packageManifest: { ...privateManifest, version: 'v1' },
      }).valid,
    ).toBe(false);
  });

  it('rejects a publishable package that declares no distribution channel', () => {
    const result = validateCapabilityMetadata({
      server: validServer,
      packageManifest: { name: 'agent-tool-server-thing', version: '1.2.3' },
    });
    expect(result.errors.join(' ')).toContain('declares no package');
  });

  it('rejects an npm declaration that contradicts the manifest', () => {
    const withPackage = {
      ...validServer,
      packages: [
        {
          registryType: 'npm',
          identifier: 'some-other-name',
          version: '0.0.1',
          transport: { type: 'stdio' },
        },
      ],
    };
    const errors = validateCapabilityMetadata({
      server: withPackage,
      packageManifest: privateManifest,
    }).errors.join(' ');
    expect(errors).toContain('package.json is private');
    expect(errors).toContain('does not match package.json name');
    expect(errors).toContain('does not match package.json version');
  });

  it('accepts a truthful published npm declaration', () => {
    expect(
      validateCapabilityMetadata({
        server: {
          ...validServer,
          packages: [
            {
              registryType: 'npm',
              identifier: 'agent-tool-server-thing',
              version: '1.2.3',
              transport: { type: 'stdio' },
            },
          ],
        },
        packageManifest: { name: 'agent-tool-server-thing', version: '1.2.3', private: false },
      }).valid,
    ).toBe(true);
  });

  it('validates an optional central registry entry', () => {
    const registryEntry = {
      id: 'agent-tool-server-thing',
      repository: 'https://github.com/example-owner/agent-tool-server-thing',
      serverMetadata: 'server.json',
      categories: ['developer-tools'],
    };
    expect(
      validateCapabilityMetadata({
        server: validServer,
        packageManifest: privateManifest,
        registryEntry,
      }).valid,
    ).toBe(true);

    expect(
      validateCapabilityMetadata({
        server: validServer,
        packageManifest: privateManifest,
        registryEntry: { ...registryEntry, categories: [] },
      }).valid,
    ).toBe(false);
  });

  it('reports every problem at once rather than only the first', () => {
    const result = validateCapabilityMetadata({
      server: { ...validServer, description: 'TODO', version: 'nope' },
      packageManifest: { name: 'x', version: '1.2.3' },
    });
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe('assertCapabilityMetadata', () => {
  it('throws a MetadataValidationError listing every failure', () => {
    expect(() =>
      assertCapabilityMetadata({
        server: { ...validServer, description: 'TODO' },
        packageManifest: privateManifest,
      }),
    ).toThrow(MetadataValidationError);
  });

  it('is silent for valid metadata', () => {
    expect(() =>
      assertCapabilityMetadata({ server: validServer, packageManifest: privateManifest }),
    ).not.toThrow();
  });
});
