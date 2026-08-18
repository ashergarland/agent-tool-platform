import {
  validateCapabilityMetadata,
  type MetadataValidationInput,
} from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from '../harness.js';

/**
 * Metadata conformance.
 *
 * A capability repository passes its own `server.json`, `package.json`, and optional registry entry
 * and gets both directions checked: its real metadata must validate, and deliberately corrupted
 * variants of it must not.
 */

export interface MetadataConformanceOptions extends ConformanceOptions, MetadataValidationInput {}

const withServerField = (server: unknown, patch: Record<string, unknown>): unknown => ({
  ...(server as Record<string, unknown>),
  ...patch,
});

export const runMetadataConformance = (options: MetadataConformanceOptions): ConformanceResult => {
  const run = new ConformanceRun('metadata');

  const actual = validateCapabilityMetadata(options);
  run.check(
    'the repository metadata is truthful and free of placeholders',
    actual.valid,
    actual.errors.join('; '),
  );

  const placeholderDescription = validateCapabilityMetadata({
    ...options,
    server: withServerField(options.server, {
      description: 'A tool server. TODO: describe this properly.',
    }),
  });
  run.check('placeholder text is rejected', !placeholderDescription.valid);

  const placeholderRemote = validateCapabilityMetadata({
    ...options,
    server: withServerField(options.server, {
      remotes: [{ type: 'streamable-http', url: 'https://replace-me.example.com/mcp' }],
    }),
  });
  run.check('a placeholder production URL is rejected', !placeholderRemote.valid);

  const mismatched = validateCapabilityMetadata({
    ...options,
    server: withServerField(options.server, { version: '99.99.99' }),
  });
  run.check('a version mismatch is rejected', !mismatched.valid);

  const malformedVersion = validateCapabilityMetadata({
    ...options,
    server: withServerField(options.server, { version: 'v1' }),
  });
  run.check('a non-semantic version is rejected', !malformedVersion.valid);

  return run.finish(options);
};
