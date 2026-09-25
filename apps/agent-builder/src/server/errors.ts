import { AgentKitError, type AgentKitErrorCode } from '@agent-tool-platform/agent-kit';
import { CapabilityRegistryValidationError } from '@agent-tool-platform/capability-registry';
import type { BuilderErrorCode, BuilderErrorResponse } from '../shared/contracts.js';

const MAX_ISSUES = 20;
const MAX_ISSUE_LENGTH = 300;

const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const bound = (value: string, maximum = MAX_ISSUE_LENGTH): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;

const boundedIssues = (issues: readonly string[]): readonly string[] =>
  issues.slice(0, MAX_ISSUES).map((issue) => bound(compact(issue)));

export class BuilderServiceError extends Error {
  public override readonly name = 'BuilderServiceError';

  public constructor(
    public readonly code: BuilderErrorCode,
    summary: string,
    public readonly issues: readonly string[],
    public readonly status: number,
    options?: ErrorOptions,
  ) {
    super(bound(compact(summary), 500), options);
  }
}

const statusForAgentKitError = (code: AgentKitErrorCode): number =>
  code === 'INVALID_REGISTRY_RECORD' ? 503 : 400;

export const asBuildServiceError = (error: unknown): BuilderServiceError => {
  if (error instanceof BuilderServiceError) return error;
  if (error instanceof AgentKitError) {
    return new BuilderServiceError(
      error.code,
      error.message.split('\n', 1)[0] ?? 'Agent build failed.',
      boundedIssues(error.issues),
      statusForAgentKitError(error.code),
      { cause: error },
    );
  }
  if (error instanceof CapabilityRegistryValidationError) {
    return new BuilderServiceError(
      'REGISTRY_UNAVAILABLE',
      'The first-party Capability Registry could not be loaded.',
      boundedIssues(error.errors),
      503,
      { cause: error },
    );
  }
  return new BuilderServiceError(
    'BUILD_FAILED',
    'The agent could not be built. Try again or inspect the local server diagnostics.',
    [],
    500,
    { cause: error },
  );
};

export const asRegistryServiceError = (error: unknown): BuilderServiceError => {
  const converted = asBuildServiceError(error);
  if (converted.code === 'BUILD_FAILED') {
    return new BuilderServiceError(
      'REGISTRY_UNAVAILABLE',
      'The first-party Capability Registry could not be loaded.',
      [],
      503,
      { cause: error },
    );
  }
  return converted;
};

export const errorResponse = (error: BuilderServiceError): BuilderErrorResponse => ({
  error: {
    code: error.code,
    summary: error.message,
    issues: error.issues,
  },
});
