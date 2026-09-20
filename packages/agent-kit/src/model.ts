import { AgentKitError, formatZodIssues } from './errors.js';
import { compareCodeUnits } from './canonical-json.js';
import { agentDefinitionSchema, type AgentDefinition } from './schemas.js';

const compareSelections = (
  left: AgentDefinition['capabilities'][number],
  right: AgentDefinition['capabilities'][number],
): number =>
  compareCodeUnits(left.id, right.id) ||
  compareCodeUnits(left.version ?? '', right.version ?? '') ||
  compareCodeUnits(left.profile ?? '', right.profile ?? '');

export const parseAgentDefinition = (input: unknown): AgentDefinition => {
  const parsed = agentDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentKitError(
      'INVALID_AGENT_DEFINITION',
      'Agent definition is invalid.',
      formatZodIssues(parsed.error),
    );
  }
  return {
    ...parsed.data,
    capabilities: [...parsed.data.capabilities].sort(compareSelections),
  };
};
