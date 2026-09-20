import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z, type ZodError } from 'zod';
import type { CapabilityArtifact, CapabilityEntry, CapabilityRegistry } from './schema.js';
import { deploymentProfileDimensionsSchema } from './schema.js';

const packageManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  private: z.boolean().optional(),
});

const serverMetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  repository: z.object({ url: z.string().min(1) }),
  packages: z
    .array(
      z.object({
        registryType: z.enum(['npm', 'oci', 'nuget', 'pypi', 'mcpb']),
        identifier: z.string().min(1),
        version: z.string().min(1),
      }),
    )
    .optional(),
});

const sourceProfileDeclarationSchema = z.object({
  capability: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    repository: z.string().min(1),
  }),
  profiles: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      dimensions: deploymentProfileDimensionsSchema,
      delivery: z.object({
        publication: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('source'), buildReference: z.string().min(1) }),
          z.object({ kind: z.literal('package'), identifier: z.string().min(1) }),
          z.object({ kind: z.literal('container'), identifier: z.string().min(1) }),
        ]),
        entrypoint: z.object({
          interface: z.enum(['stdio', 'http', 'library', 'custom']),
        }),
      }),
      requiredSecrets: z.array(z.string()),
      providerPrerequisites: z.array(
        z.object({
          id: z.string().min(1),
          description: z.string().min(1),
        }),
      ),
    }),
  ),
});

export interface CapabilitySourceRoot {
  readonly capabilityId: string;
  readonly root: string;
}

export interface CapabilitySourceIssue {
  readonly capabilityId: string;
  readonly message: string;
}

const runGit = (root: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error instanceof Error ? error : new Error('Git command failed'));
        return;
      }
      resolve(stdout.trim());
    });
  });

const referencePath = (reference: string): string => {
  const path = reference.split('#', 1)[0];
  if (path === undefined) throw new Error(`Invalid empty metadata reference: ${reference}`);
  return path;
};

const readJson = async (root: string, reference: string): Promise<unknown> =>
  JSON.parse(await readFile(join(root, referencePath(reference)), 'utf8')) as unknown;

const formatZod = (label: string, error: ZodError): string =>
  `${label}: ${error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')}`;

const normalizedRepository = (value: string): string =>
  value.replace(/^git\+/u, '').replace(/\.git$/u, '');

const sortedStrings = (values: readonly string[]): string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

const dimensionNames = [
  'execution',
  'delivery',
  'access',
  'workload',
  'provider',
  'mutation',
] as const;

const artifactRegistryType = (artifact: CapabilityArtifact): 'npm' | 'oci' | undefined => {
  if (artifact.kind === 'npm') return 'npm';
  if (artifact.kind === 'oci') return 'oci';
  return undefined;
};

export const verifyCapabilitySource = async (
  entry: CapabilityEntry,
  root: string,
): Promise<CapabilitySourceIssue[]> => {
  const issues: CapabilitySourceIssue[] = [];
  const report = (message: string): void => {
    issues.push({ capabilityId: entry.id, message });
  };

  try {
    const revision = await runGit(root, ['rev-parse', 'HEAD']);
    if (revision !== entry.source.revision) {
      report(`source revision is ${revision}, expected ${entry.source.revision}`);
    }
    if (entry.source.releaseTag !== undefined) {
      const tags = (await runGit(root, ['tag', '--points-at', 'HEAD'])).split(/\r?\n/u);
      if (!tags.includes(entry.source.releaseTag)) {
        report(`source revision is not tagged ${entry.source.releaseTag}`);
      }
      if (entry.source.releaseTag.slice(1) !== entry.version.value) {
        report('release tag does not match the registry version');
      }
    }
  } catch (error) {
    report(
      `cannot inspect Git revision: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let packageDocument: unknown;
  let serverDocument: unknown;
  try {
    [packageDocument, serverDocument] = await Promise.all([
      readJson(root, entry.source.metadata.package),
      readJson(root, entry.source.metadata.server),
    ]);
  } catch (error) {
    report(
      `cannot read source metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
    return issues;
  }

  const packageManifest = packageManifestSchema.safeParse(packageDocument);
  const serverMetadata = serverMetadataSchema.safeParse(serverDocument);
  if (!packageManifest.success) report(formatZod('package metadata', packageManifest.error));
  if (!serverMetadata.success) report(formatZod('server metadata', serverMetadata.error));
  if (!packageManifest.success || !serverMetadata.success) return issues;

  if (serverMetadata.data.name !== entry.source.capabilityId) {
    report(
      `server capability ID is ${serverMetadata.data.name}, expected ${entry.source.capabilityId}`,
    );
  }
  if (
    normalizedRepository(serverMetadata.data.repository.url) !==
    normalizedRepository(entry.source.repository)
  ) {
    report('server repository does not match the registry source repository');
  }
  if (serverMetadata.data.description !== entry.description) {
    report('server description does not match the registry description');
  }
  if (packageManifest.data.version !== serverMetadata.data.version) {
    report('package and server versions do not match each other');
  }
  if (packageManifest.data.version !== entry.source.metadataVersion) {
    report(
      `package version is ${packageManifest.data.version}, expected ${entry.source.metadataVersion}`,
    );
  }
  if (serverMetadata.data.version !== entry.source.metadataVersion) {
    report(
      `server version is ${serverMetadata.data.version}, expected ${entry.source.metadataVersion}`,
    );
  }

  for (const artifact of entry.artifacts) {
    const registryType = artifactRegistryType(artifact);
    if (registryType === undefined) continue;
    const declared = serverMetadata.data.packages?.find(
      (candidate) =>
        candidate.registryType === registryType && candidate.identifier === artifact.identifier,
    );
    if (declared === undefined) {
      report(`artifact ${artifact.id} is not declared by server metadata`);
      continue;
    }
    if (declared.version !== entry.source.metadataVersion) {
      report(
        `source artifact ${artifact.id} version is ${declared.version}, expected ${entry.source.metadataVersion}`,
      );
    }
    if (artifact.kind === 'npm' && packageManifest.data.name !== artifact.identifier) {
      report(
        `npm artifact ${artifact.identifier} does not match package ${packageManifest.data.name}`,
      );
    }
  }

  if (entry.source.metadata.profiles === undefined) return issues;

  let profileDocument: unknown;
  try {
    profileDocument = await readJson(root, entry.source.metadata.profiles);
  } catch (error) {
    report(
      `cannot read profile declaration: ${error instanceof Error ? error.message : String(error)}`,
    );
    return issues;
  }
  const declaration = sourceProfileDeclarationSchema.safeParse(profileDocument);
  if (!declaration.success) {
    report(formatZod('profile declaration', declaration.error));
    return issues;
  }
  if (declaration.data.capability.id !== entry.source.capabilityId) {
    report('profile declaration capability ID does not match the registry source capability ID');
  }
  if (
    normalizedRepository(declaration.data.capability.repository) !==
    normalizedRepository(entry.source.repository)
  ) {
    report('profile declaration repository does not match the registry source repository');
  }
  if (declaration.data.capability.displayName !== entry.displayName) {
    report(
      `profile display name is ${declaration.data.capability.displayName}, expected ${entry.displayName}`,
    );
  }

  const registryProfiles = entry.profiles.filter(
    (profile) => profile.source === 'capability-profile-declaration',
  );
  if (declaration.data.profiles.length !== registryProfiles.length) {
    report(
      `profile declaration has ${declaration.data.profiles.length} profiles, registry has ${registryProfiles.length}`,
    );
  }

  for (const sourceProfile of declaration.data.profiles) {
    const profile = registryProfiles.find((candidate) => candidate.id === sourceProfile.id);
    if (profile === undefined) {
      report(`source profile ${sourceProfile.id} is missing from the registry`);
      continue;
    }
    if (profile.description !== sourceProfile.description) {
      report(`profile ${profile.id} description has drifted`);
    }
    if (
      dimensionNames.some(
        (dimension) => sourceProfile.dimensions[dimension] !== profile.dimensions[dimension],
      )
    ) {
      report(`profile ${profile.id} dimensions have drifted`);
    }
    if (
      JSON.stringify(sortedStrings(profile.prerequisites.requiredSecrets)) !==
      JSON.stringify(sortedStrings(sourceProfile.requiredSecrets))
    ) {
      report(`profile ${profile.id} required secrets have drifted`);
    }

    const sourceProvider = sourceProfile.providerPrerequisites
      .map((item) => `${item.id}\u0000${item.description}`)
      .sort();
    const registryProvider = profile.prerequisites.provider
      .map((item) => `${item.id}\u0000${item.description}`)
      .sort();
    if (JSON.stringify(sourceProvider) !== JSON.stringify(registryProvider)) {
      report(`profile ${profile.id} provider prerequisites have drifted`);
    }

    const bindings = entry.bindings.filter((binding) => binding.profileId === profile.id);
    if (
      !bindings.some((binding) => binding.interface === sourceProfile.delivery.entrypoint.interface)
    ) {
      report(`profile ${profile.id} has no binding for its declared entrypoint interface`);
    }
    const publication = sourceProfile.delivery.publication;
    if (publication.kind !== 'source') {
      const artifact = entry.artifacts.find(
        (candidate) => candidate.identifier === publication.identifier,
      );
      if (artifact === undefined) {
        report(`profile ${profile.id} publication is missing from registry artifacts`);
      }
    }
  }

  return issues;
};

export const verifyCapabilitySources = async (
  registry: CapabilityRegistry,
  sourceRoots: readonly CapabilitySourceRoot[],
): Promise<CapabilitySourceIssue[]> => {
  const roots = new Map(sourceRoots.map(({ capabilityId, root }) => [capabilityId, root]));
  const issues: CapabilitySourceIssue[] = [];
  for (const entry of registry.capabilities) {
    const root = roots.get(entry.id);
    if (root === undefined) {
      issues.push({ capabilityId: entry.id, message: 'source checkout was not supplied' });
      continue;
    }
    issues.push(...(await verifyCapabilitySource(entry, root)));
  }
  for (const capabilityId of roots.keys()) {
    if (!registry.capabilities.some((entry) => entry.id === capabilityId)) {
      issues.push({ capabilityId, message: 'source checkout does not match a registry entry' });
    }
  }
  return issues;
};
