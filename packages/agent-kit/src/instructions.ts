import { AgentKitError } from './errors.js';
import type { ResolvedCapability } from './resolution.js';
import { MAX_COMPOSED_INSTRUCTIONS_LENGTH, type AgentDefinition } from './schemas.js';

export interface CapabilityInstructionSection {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly profileId: string;
  readonly capabilityBoundary: string;
  readonly profileGuidance: string;
  readonly runtimeInstructions: {
    readonly strategy: 'mcp-server-instructions';
    readonly sourceRevision: string;
  };
  readonly toolRouting: {
    readonly strategy: 'runtime-tool-metadata';
    readonly summary: string;
  };
}

export interface InstructionComposition {
  readonly schemaVersion: 1;
  readonly agentInstructions: string;
  readonly capabilities: readonly CapabilityInstructionSection[];
  readonly rendered: string;
}

const renderCapability = (capability: ResolvedCapability): readonly string[] => [
  `## ${capability.capability.displayName} (\`${capability.capability.id}@${capability.capability.version.value}\`, profile \`${capability.profile.id}\`)`,
  '',
  `Capability boundary: ${capability.capability.description}`,
  '',
  `Selected profile: ${capability.profile.description}`,
  '',
  `Routing summary: ${capability.capability.routing.summary}`,
  '',
  'The capability server instructions and its per-tool routing metadata remain authoritative at runtime.',
];

export const composeInstructions = (
  definition: AgentDefinition,
  capabilities: readonly ResolvedCapability[],
): InstructionComposition => {
  const sections = capabilities.map((capability) => ({
    capabilityId: capability.capability.id,
    capabilityVersion: capability.capability.version.value,
    profileId: capability.profile.id,
    capabilityBoundary: capability.capability.description,
    profileGuidance: capability.profile.description,
    runtimeInstructions: {
      strategy: 'mcp-server-instructions' as const,
      sourceRevision: capability.capability.source.revision,
    },
    toolRouting: {
      strategy: 'runtime-tool-metadata' as const,
      summary: capability.capability.routing.summary,
    },
  }));
  const rendered = [
    '# Agent Instructions',
    '',
    definition.instructions.trim(),
    '',
    '# Capability Instructions',
    '',
    'Use each capability within its declared boundary. Capability-server instructions, tool-level routing metadata, and runtime enforcement remain authoritative.',
    '',
    ...capabilities.flatMap((capability, index) => [
      ...(index === 0 ? [] : ['']),
      ...renderCapability(capability),
    ]),
  ]
    .join('\n')
    .trim();

  if (rendered.length > MAX_COMPOSED_INSTRUCTIONS_LENGTH) {
    throw new AgentKitError(
      'INSTRUCTION_LIMIT_EXCEEDED',
      `Composed instructions exceed the ${String(MAX_COMPOSED_INSTRUCTIONS_LENGTH)} character limit.`,
      [`actual length: ${String(rendered.length)}`],
    );
  }

  return {
    schemaVersion: 1,
    agentInstructions: definition.instructions,
    capabilities: sections,
    rendered,
  };
};
