import { z } from 'zod';

/**
 * Capability repository metadata validation.
 *
 * Seeded by the Git Optimizer metadata validator and generalized for the whole family. The point
 * is narrow and worth stating: published metadata must describe something that actually exists.
 * A registry entry pointing at `example.com`, a package declaration for something never published,
 * or a `server.json` whose version has drifted from `package.json` are all worse than no metadata,
 * because a client trusts them.
 *
 * The platform repository is not a capability server and has no server endpoint of its own, so
 * these validators are exported for capability repositories to consume rather than applied to a
 * fictional `server.json` here.
 */

export const placeholderPattern =
  /(example\.(?:com|org|net|invalid)|replace-me|replace\.invalid|changeme|your-domain|TODO|FIXME|xxxxx)/iu;

export const containsPlaceholder = (value: string): boolean => placeholderPattern.test(value);

const withoutPlaceholders = (label: string): z.ZodString =>
  z.string().refine((value) => !containsPlaceholder(value), {
    message: `${label} still contains placeholder content`,
  });

const placeholderFreeUrl = (label: string) =>
  z.url().refine((value) => !containsPlaceholder(value), {
    message: `${label} still contains placeholder content`,
  });

export const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const serverMetadataSchema = z.object({
  $schema: z.url(),
  name: z.string().regex(/^[a-z0-9.-]+\/[a-z0-9._-]+$/u, 'name must be namespace/identifier'),
  description: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !containsPlaceholder(value), {
      message: 'description still contains placeholder content',
    }),
  version: z.string().regex(semanticVersionPattern, 'version must be semantic'),
  repository: z.object({
    url: placeholderFreeUrl('repository.url'),
    source: z.literal('github'),
  }),
  // Only declare a distribution channel that genuinely exists.
  packages: z
    .array(
      z.object({
        registryType: z.enum(['npm', 'oci', 'nuget', 'pypi', 'mcpb']),
        identifier: withoutPlaceholders('package identifier').min(1),
        version: z.string().min(1),
        transport: z.object({ type: z.enum(['stdio', 'streamable-http', 'sse']) }),
      }),
    )
    .optional(),
  remotes: z
    .array(
      z.object({
        type: z.enum(['streamable-http', 'sse']),
        url: placeholderFreeUrl('remote url'),
      }),
    )
    .optional(),
});

export type ServerMetadata = z.infer<typeof serverMetadataSchema>;

export const registryEntrySchema = z.object({
  id: z.string().min(1),
  repository: placeholderFreeUrl('registry repository'),
  serverMetadata: z.string().min(1),
  categories: z.array(z.string().min(1)).min(1),
});

export const packageManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  private: z.boolean().optional(),
});

export interface MetadataValidationInput {
  readonly server: unknown;
  readonly packageManifest: unknown;
  readonly registryEntry?: unknown;
}

export interface MetadataValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const issues = (label: string, error: z.ZodError): string[] =>
  error.issues.map((issue) => `${label}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);

/**
 * Validates a capability repository's metadata triple. Returns every problem rather than the first
 * one, so a repository can be fixed in a single pass.
 */
export const validateCapabilityMetadata = (
  input: MetadataValidationInput,
): MetadataValidationResult => {
  const errors: string[] = [];

  const server = serverMetadataSchema.safeParse(input.server);
  if (!server.success) errors.push(...issues('server.json', server.error));

  const manifest = packageManifestSchema.safeParse(input.packageManifest);
  if (!manifest.success) errors.push(...issues('package.json', manifest.error));

  if (input.registryEntry !== undefined) {
    const entry = registryEntrySchema.safeParse(input.registryEntry);
    if (!entry.success) errors.push(...issues('registry entry', entry.error));
  }

  if (server.success && manifest.success) {
    if (server.data.version !== manifest.data.version) {
      errors.push(
        `version mismatch: server.json declares ${server.data.version} but package.json declares ${manifest.data.version}`,
      );
    }
    // A publishable package that declares no distribution channel is metadata that lies by
    // omission; a private package that declares an npm package lies outright.
    const packages = server.data.packages ?? [];
    if (manifest.data.private !== true && packages.length === 0) {
      errors.push('package.json is publishable but server.json declares no package');
    }
    for (const declared of packages) {
      if (declared.registryType !== 'npm') continue;
      if (manifest.data.private === true) {
        errors.push(
          `server.json declares npm package ${declared.identifier} but package.json is private`,
        );
      }
      if (declared.identifier !== manifest.data.name) {
        errors.push(
          `server.json npm package identifier ${declared.identifier} does not match package.json name ${manifest.data.name}`,
        );
      }
      if (declared.version !== manifest.data.version) {
        errors.push(
          `server.json npm package version ${declared.version} does not match package.json version ${manifest.data.version}`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
};

export class MetadataValidationError extends Error {
  public override readonly name = 'MetadataValidationError';

  public constructor(public readonly errors: readonly string[]) {
    super(`Capability metadata is invalid:\n- ${errors.join('\n- ')}`);
  }
}

export const assertCapabilityMetadata = (input: MetadataValidationInput): void => {
  const result = validateCapabilityMetadata(input);
  if (!result.valid) throw new MetadataValidationError(result.errors);
};
