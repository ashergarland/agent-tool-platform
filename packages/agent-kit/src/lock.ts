import { digestCanonicalJson, serializeCanonicalJson } from './canonical-json.js';
import { AgentKitError, formatZodIssues } from './errors.js';
import type { HostAdapter } from './host-adapter.js';
import type { AgentResolution, ResolvedCapability } from './resolution.js';
import {
  AGENT_BUILD_SCHEMA_VERSION,
  AGENT_LOCK_SCHEMA_VERSION,
  agentLockSchema,
  type AgentLock,
} from './schemas.js';

export const createAgentLock = (
  resolution: AgentResolution,
  capabilities: readonly ResolvedCapability[],
  adapter: HostAdapter,
): AgentLock => {
  const definitionDigest = digestCanonicalJson(resolution.definition);
  const candidate = {
    schemaVersion: AGENT_LOCK_SCHEMA_VERSION,
    kind: 'agent-lock',
    agent: {
      id: resolution.definition.id,
      version: resolution.definition.version,
      definitionDigest,
    },
    capabilities: capabilities.map((capability) => ({
      id: capability.capability.id,
      version: capability.capability.version.value,
      requestedVersion: capability.requestedVersion,
      registryEntryDigest: digestCanonicalJson(capability.capability),
      source: {
        repository: capability.capability.source.repository,
        revision: capability.capability.source.revision,
        profileDeclaration: capability.capability.source.metadata.profiles ?? null,
      },
      profile: {
        id: capability.profile.id,
        source: capability.profile.source,
        dimensions: capability.binding.dimensions,
      },
      binding: {
        id: capability.binding.id,
        mode: capability.binding.mode,
        interface: capability.binding.interface,
      },
      artifact: capability.binding.artifact,
      requirements: {
        setupRequired: capability.binding.setupRequired,
        requiredSecretNames: capability.binding.requiredSecretNames,
        providerPrerequisiteIds: capability.binding.providerPrerequisites.map(
          (prerequisite) => prerequisite.id,
        ),
        permissions: capability.binding.permissions,
        readinessSignals: capability.binding.readinessSignals,
      },
    })),
    build: {
      schemaVersion: AGENT_BUILD_SCHEMA_VERSION,
      registrySchemaVersion: '1.0.0',
      adapters: [{ id: adapter.id, schemaVersion: adapter.schemaVersion }],
    },
  } as const;

  const parsed = agentLockSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_LOCK',
      'Generated agent lock is invalid.',
      formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
};

export const serializeAgentLock = (input: unknown): string => {
  const parsed = agentLockSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_LOCK',
      'Agent lock is invalid.',
      formatZodIssues(parsed.error),
    );
  }
  return serializeCanonicalJson(parsed.data);
};

export const digestAgentLock = (lock: AgentLock): `sha256:${string}` => digestCanonicalJson(lock);
