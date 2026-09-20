import type { z } from 'zod';

export const MAX_AGENT_KIT_ERROR_LENGTH = 4_096;
const MAX_ISSUES = 20;
const MAX_ISSUE_LENGTH = 300;

export type AgentKitErrorCode =
  | 'INVALID_AGENT_DEFINITION'
  | 'INVALID_REGISTRY_RECORD'
  | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_VERSION_NOT_FOUND'
  | 'CAPABILITY_PROFILE_NOT_FOUND'
  | 'INCOMPATIBLE_BINDING'
  | 'INSTRUCTION_LIMIT_EXCEEDED'
  | 'INVALID_LOCK'
  | 'INVALID_ADAPTER_OUTPUT'
  | 'INVALID_READINESS_INPUT'
  | 'INVALID_INSTANCE_IDENTITY';

const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const truncate = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 3))}...`;

const boundedIssues = (values: readonly string[]): readonly string[] => {
  const selected = values
    .slice(0, MAX_ISSUES)
    .map((value) => truncate(compact(value), MAX_ISSUE_LENGTH));
  if (values.length > selected.length) {
    return [...selected, `${String(values.length - selected.length)} additional issue(s) omitted`];
  }
  return selected;
};

export class AgentKitError extends Error {
  public override readonly name = 'AgentKitError';
  public readonly issues: readonly string[];

  public constructor(
    public readonly code: AgentKitErrorCode,
    summary: string,
    issues: readonly string[] = [],
  ) {
    const safeIssues = boundedIssues(issues);
    const details = safeIssues.length === 0 ? '' : `\n- ${safeIssues.join('\n- ')}`;
    super(truncate(`${compact(summary)}${details}`, MAX_AGENT_KIT_ERROR_LENGTH));
    this.issues = safeIssues;
  }
}

export const formatZodIssues = (error: z.ZodError): readonly string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
