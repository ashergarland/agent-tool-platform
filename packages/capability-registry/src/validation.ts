import { join } from 'node:path';
import type { ZodError } from 'zod';
import {
  checkFirstPartyRegistry,
  readCapabilityEntryDocuments,
  readJsonDocument,
  type RegistryDataIssue,
} from './data.js';
import { capabilityRegistryPackageRoot, firstPartyRegistryPath } from './paths.js';
import {
  capabilityEntrySchema,
  capabilityRegistrySchema,
  type CapabilityEntry,
  type CapabilityProfileSummary,
  type CapabilityRegistry,
  type PermissionScope,
  type StateEffect,
} from './schema.js';

export interface CapabilityRegistryValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const formatZodIssues = (source: string, error: ZodError): string[] =>
  error.issues.map((issue) => `${source}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);

const duplicates = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort((left, right) => left.localeCompare(right));
};

const addDuplicateErrors = (
  errors: string[],
  source: string,
  label: string,
  values: readonly string[],
): void => {
  for (const value of duplicates(values)) {
    errors.push(`${source}: duplicate ${label}: ${value}`);
  }
};

const expectedBindingAvailability = (
  profile: CapabilityProfileSummary,
): 'local' | 'remote' | 'hybrid' => {
  if (profile.dimensions.execution === 'hosted') return 'remote';
  return profile.dimensions.provider === 'external' ? 'hybrid' : 'local';
};

const expectedArtifactKind = (
  delivery: CapabilityProfileSummary['dimensions']['delivery'],
): 'npm' | 'oci' | 'source' => {
  if (delivery === 'package') return 'npm';
  if (delivery === 'container') return 'oci';
  return 'source';
};

const effectPermission: Readonly<Record<StateEffect, PermissionScope>> = {
  'artifact-create': 'artifact-write',
  'filesystem-write': 'filesystem-write',
  'provider-mutation': 'provider-write',
};

const privateValuePatterns: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: 'account identifier',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
  },
  {
    label: 'Azure resource identifier',
    pattern: /\/subscriptions\/[^/\s]+(?:\/|$)/iu,
  },
  {
    label: 'Windows filesystem path',
    pattern: /(?:^|\s)[A-Za-z]:[\\/](?:Users|Documents and Settings|home)[\\/]/iu,
  },
  {
    label: 'local filesystem path',
    pattern: /(?:^|\s)(?:~\/|\/(?:home|Users|var\/(?:lib|run)|etc)\/)\S*/u,
  },
  {
    label: 'secret value assignment',
    pattern:
      /(?:password|secret|token|api[_-]?key|connection[_-]?string)\s*[=:]\s*['"]?[^\s,'"]+/iu,
  },
  {
    label: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
];

const privateIpv4Address = (address: string): boolean => {
  if (
    /^(?:0|10|127)\./u.test(address) ||
    /^169\.254\./u.test(address) ||
    /^192\.168\./u.test(address)
  ) {
    return true;
  }
  const match = /^172\.(\d{1,2})\./u.exec(address);
  return match !== null && Number(match[1]) >= 16 && Number(match[1]) <= 31;
};

const privateHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.+$/u, '');
  const address = normalized.replace(/^\[|\]$/gu, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.includes('.privatelink.')
  ) {
    return true;
  }
  if (privateIpv4Address(address)) return true;
  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (mappedIpv4 !== null) {
    const upper = Number.parseInt(mappedIpv4[1]!, 16);
    const lower = Number.parseInt(mappedIpv4[2]!, 16);
    const ipv4 = `${upper >>> 8}.${upper & 0xff}.${lower >>> 8}.${lower & 0xff}`;
    if (privateIpv4Address(ipv4)) return true;
  }
  return (
    address === '::' ||
    address === '::1' ||
    /^f[cd][0-9a-f]{2}:/u.test(address) ||
    /^fe[89ab][0-9a-f]:/u.test(address)
  );
};

const scanAccountNeutralValue = (value: unknown, path: string, errors: string[]): void => {
  if (typeof value === 'string') {
    for (const { label, pattern } of privateValuePatterns) {
      if (pattern.test(value)) errors.push(`${path}: contains a private ${label}`);
    }
    if (/^https?:\/\//iu.test(value) && URL.canParse(value)) {
      const hostname = new URL(value).hostname;
      if (privateHostname(hostname)) errors.push(`${path}: contains a private endpoint`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanAccountNeutralValue(item, `${path}[${index}]`, errors));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      scanAccountNeutralValue(child, `${path}.${key}`, errors);
    }
  }
};

export const validateAccountNeutrality = (
  entries: readonly CapabilityEntry[],
): readonly string[] => {
  const errors: string[] = [];
  for (const entry of entries) scanAccountNeutralValue(entry, entry.id, errors);
  return errors;
};

export const validateCapabilityConsistency = (
  entries: readonly CapabilityEntry[],
  filenames: ReadonlyMap<string, string> = new Map(),
): readonly string[] => {
  const errors: string[] = [];
  addDuplicateErrors(
    errors,
    'registry',
    'capability ID',
    entries.map((entry) => entry.id),
  );
  addDuplicateErrors(
    errors,
    'registry',
    'source capability ID',
    entries.map((entry) => entry.source.capabilityId),
  );
  addDuplicateErrors(
    errors,
    'registry',
    'source repository',
    entries.map((entry) => entry.source.repository),
  );

  for (const entry of entries) {
    const source = filenames.get(entry.id) ?? entry.id;
    if (filenames.has(entry.id) && filenames.get(entry.id) !== `${entry.id}.json`) {
      errors.push(`${source}: filename must be ${entry.id}.json`);
    }
    if (entry.links.repository !== entry.source.repository) {
      errors.push(`${source}: links.repository must match source.repository`);
    }

    addDuplicateErrors(errors, source, 'tag', entry.tags);
    addDuplicateErrors(
      errors,
      source,
      'artifact ID',
      entry.artifacts.map((artifact) => artifact.id),
    );
    addDuplicateErrors(
      errors,
      source,
      'profile ID',
      entry.profiles.map((profile) => profile.id),
    );
    addDuplicateErrors(
      errors,
      source,
      'binding ID',
      entry.bindings.map((binding) => binding.id),
    );
    addDuplicateErrors(errors, source, 'conformance check', entry.conformance.checks);

    const artifacts = new Map(entry.artifacts.map((artifact) => [artifact.id, artifact]));
    const profiles = new Map(entry.profiles.map((profile) => [profile.id, profile]));

    for (const artifact of entry.artifacts) {
      if (artifact.version !== entry.version.value) {
        errors.push(
          `${source}: artifact ${artifact.id} version ${artifact.version} must match capability version ${entry.version.value}`,
        );
      }
      if (artifact.availability === 'published' && entry.version.status !== 'released') {
        errors.push(
          `${source}: published artifact ${artifact.id} requires released version status`,
        );
      }
    }

    if (entry.version.status === 'released') {
      if (entry.source.releaseTag === undefined) {
        errors.push(`${source}: released version requires source.releaseTag`);
      }
      if (!entry.artifacts.some((artifact) => artifact.availability === 'published')) {
        errors.push(`${source}: released version requires at least one published artifact`);
      }
    } else if (entry.source.releaseTag !== undefined) {
      errors.push(`${source}: source.releaseTag is only valid for a released version`);
    }
    if (
      entry.version.status !== 'released' &&
      entry.source.metadataVersion !== entry.version.value
    ) {
      errors.push(
        `${source}: non-release source metadata version must match the capability version`,
      );
    }

    const declaredProfiles = entry.source.metadata.profiles !== undefined;
    const hasProfileConformance = entry.conformance.checks.includes('capability-profile-v1');
    if (declaredProfiles !== hasProfileConformance) {
      errors.push(
        `${source}: capability-profile-v1 conformance must match source profile metadata availability`,
      );
    }

    for (const profile of entry.profiles) {
      addDuplicateErrors(
        errors,
        source,
        `${profile.id} permission scope`,
        profile.permissions.scopes,
      );
      addDuplicateErrors(
        errors,
        source,
        `${profile.id} required secret`,
        profile.prerequisites.requiredSecrets,
      );
      addDuplicateErrors(
        errors,
        source,
        `${profile.id} provider prerequisite`,
        profile.prerequisites.provider.map((prerequisite) => prerequisite.id),
      );
      addDuplicateErrors(
        errors,
        source,
        `${profile.id} readiness signal`,
        profile.readiness.signals,
      );
      addDuplicateErrors(errors, source, `${profile.id} state effect`, profile.stateEffects);

      const expectedSource = declaredProfiles
        ? 'capability-profile-declaration'
        : 'registry-curated';
      if (profile.source !== expectedSource) {
        errors.push(`${source}: profile ${profile.id} source must be ${expectedSource}`);
      }

      const mutating = profile.dimensions.mutation === 'mutating';
      if (mutating !== profile.stateEffects.length > 0) {
        errors.push(
          `${source}: profile ${profile.id} mutation dimension and stateEffects are inconsistent`,
        );
      }
      for (const effect of profile.stateEffects) {
        const permission = effectPermission[effect];
        if (!profile.permissions.scopes.includes(permission)) {
          errors.push(
            `${source}: profile ${profile.id} effect ${effect} requires permission ${permission}`,
          );
        }
      }

      if (!profile.readiness.signals.includes('process')) {
        errors.push(`${source}: profile ${profile.id} readiness must include process`);
      }
      const workloadExpected = profile.dimensions.workload !== 'none';
      if (workloadExpected !== profile.readiness.signals.includes('workload')) {
        errors.push(
          `${source}: profile ${profile.id} workload readiness must match its workload dimension`,
        );
      }
      const providerExpected = profile.dimensions.provider === 'external';
      if (providerExpected !== profile.readiness.signals.includes('provider')) {
        errors.push(
          `${source}: profile ${profile.id} provider readiness must match its provider dimension`,
        );
      }
      if (providerExpected !== profile.prerequisites.provider.length > 0) {
        errors.push(
          `${source}: profile ${profile.id} provider prerequisites must match its provider dimension`,
        );
      }
    }

    for (const binding of entry.bindings) {
      const profile = profiles.get(binding.profileId);
      const artifact = artifacts.get(binding.artifactId);
      const clientHeaders = binding.client?.http.headers ?? [];
      if (binding.client !== undefined && binding.interface !== 'http') {
        errors.push(
          `${source}: binding ${binding.id} HTTP client mapping requires the http interface`,
        );
      }
      addDuplicateErrors(
        errors,
        source,
        `${binding.id} HTTP client header name (case-insensitive)`,
        clientHeaders.map((header) => header.name.toLowerCase()),
      );
      if (profile === undefined) {
        errors.push(
          `${source}: binding ${binding.id} references unknown profile ${binding.profileId}`,
        );
      }
      if (artifact === undefined) {
        errors.push(
          `${source}: binding ${binding.id} references unknown artifact ${binding.artifactId}`,
        );
      }
      if (profile !== undefined) {
        const expectedAvailability = expectedBindingAvailability(profile);
        if (binding.availability !== expectedAvailability) {
          errors.push(
            `${source}: binding ${binding.id} availability must be ${expectedAvailability}`,
          );
        }
        if (profile.dimensions.access === 'authenticated-service' && binding.interface !== 'http') {
          errors.push(`${source}: authenticated binding ${binding.id} must use the http interface`);
        }
        const requiredConfigurations = new Set(profile.prerequisites.requiredSecrets);
        for (const header of clientHeaders) {
          if (!requiredConfigurations.has(header.value.name)) {
            errors.push(
              `${source}: binding ${binding.id} HTTP client header ${header.name} references undeclared configuration ${header.value.name}`,
            );
          }
        }
        if (binding.availability === 'remote' && binding.interface === 'http') {
          const mappedConfigurations = new Set(clientHeaders.map((header) => header.value.name));
          for (const name of profile.prerequisites.requiredSecrets) {
            if (!mappedConfigurations.has(name)) {
              errors.push(
                `${source}: binding ${binding.id} has no HTTP client mapping for required configuration ${name}`,
              );
            }
          }
        }
        if (
          artifact !== undefined &&
          artifact.kind !== expectedArtifactKind(profile.dimensions.delivery)
        ) {
          errors.push(
            `${source}: binding ${binding.id} artifact kind ${artifact.kind} does not match ${profile.dimensions.delivery} delivery`,
          );
        }
      }
    }

    for (const profile of entry.profiles) {
      if (!entry.bindings.some((binding) => binding.profileId === profile.id)) {
        errors.push(`${source}: profile ${profile.id} has no binding`);
      }
    }
    for (const artifact of entry.artifacts) {
      if (!entry.bindings.some((binding) => binding.artifactId === artifact.id)) {
        errors.push(`${source}: artifact ${artifact.id} has no binding`);
      }
    }

    const expectedStateChanging = entry.profiles.some(
      (profile) => profile.dimensions.mutation === 'mutating',
    );
    if (entry.stateChanging !== expectedStateChanging) {
      errors.push(`${source}: stateChanging does not match the available profiles`);
    }
  }

  errors.push(...validateAccountNeutrality(entries));
  return errors;
};

export const validateCapabilityEntryDocument = (
  document: unknown,
  source = 'capability entry',
): CapabilityRegistryValidationResult => {
  const parsed = capabilityEntrySchema.safeParse(document);
  if (!parsed.success) {
    return { valid: false, errors: formatZodIssues(source, parsed.error) };
  }
  const errors = validateCapabilityConsistency([parsed.data]);
  return { valid: errors.length === 0, errors };
};

export const validateCapabilityRegistryDocument = (
  document: unknown,
  source = 'capability registry',
): CapabilityRegistryValidationResult => {
  const parsed = capabilityRegistrySchema.safeParse(document);
  if (!parsed.success) {
    return { valid: false, errors: formatZodIssues(source, parsed.error) };
  }
  const errors = validateCapabilityConsistency(parsed.data.capabilities);
  return { valid: errors.length === 0, errors };
};

export class CapabilityRegistryValidationError extends Error {
  public override readonly name = 'CapabilityRegistryValidationError';

  public constructor(public readonly errors: readonly string[]) {
    super(`Capability registry is invalid:\n- ${errors.join('\n- ')}`);
  }
}

export function assertCapabilityRegistryDocument(
  document: unknown,
  source?: string,
): asserts document is CapabilityRegistry {
  const result = validateCapabilityRegistryDocument(document, source);
  if (!result.valid) throw new CapabilityRegistryValidationError(result.errors);
}

const issueStrings = (issues: readonly RegistryDataIssue[]): string[] =>
  issues.map((issue) => `${issue.source}: ${issue.message}`);

export const validateStaticFirstPartyRegistry = async (
  root = capabilityRegistryPackageRoot,
): Promise<CapabilityRegistryValidationResult> => {
  const loaded = await readCapabilityEntryDocuments(root);
  const errors = issueStrings(loaded.issues);
  const entries: CapabilityEntry[] = [];
  const filenames = new Map<string, string>();

  for (const { filename, document } of loaded.documents) {
    const parsed = capabilityEntrySchema.safeParse(document);
    if (!parsed.success) {
      errors.push(...formatZodIssues(filename, parsed.error));
      continue;
    }
    entries.push(parsed.data);
    filenames.set(parsed.data.id, filename);
  }

  errors.push(...validateCapabilityConsistency(entries, filenames));

  const generated = await readJsonDocument(
    join(root, firstPartyRegistryPath),
    firstPartyRegistryPath,
  );
  errors.push(...issueStrings(generated.issues));
  if (generated.document !== undefined) {
    const validated = validateCapabilityRegistryDocument(
      generated.document,
      firstPartyRegistryPath,
    );
    errors.push(...validated.errors);
  }

  if (loaded.issues.length === 0 && entries.length === loaded.documents.length) {
    errors.push(...issueStrings(await checkFirstPartyRegistry(root)));
  }

  return { valid: errors.length === 0, errors };
};

export const loadFirstPartyCapabilityRegistry = async (
  root = capabilityRegistryPackageRoot,
): Promise<CapabilityRegistry> => {
  const result = await readJsonDocument(join(root, firstPartyRegistryPath), firstPartyRegistryPath);
  if (result.document === undefined) {
    throw new CapabilityRegistryValidationError(issueStrings(result.issues));
  }
  assertCapabilityRegistryDocument(result.document, firstPartyRegistryPath);
  return result.document;
};
