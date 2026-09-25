import type { AgentDefinition } from '@agent-tool-platform/agent-kit';
import type {
  BuildAgentRequest,
  BuildAgentResult,
  BuilderErrorCode,
  BuilderErrorResponse,
  CapabilityCatalogResponse,
} from '../shared/contracts.js';

export class BuilderApiError extends Error {
  public override readonly name = 'BuilderApiError';

  public constructor(
    public readonly code: BuilderErrorCode,
    summary: string,
    public readonly issues: readonly string[],
    options?: ErrorOptions,
  ) {
    super(summary, options);
  }
}

const isErrorResponse = (value: unknown): value is BuilderErrorResponse => {
  if (value === null || typeof value !== 'object') return false;
  const error = (value as { readonly error?: unknown }).error;
  if (error === null || typeof error !== 'object') return false;
  const fields = error as Readonly<Record<string, unknown>>;
  return (
    typeof fields['code'] === 'string' &&
    typeof fields['summary'] === 'string' &&
    Array.isArray(fields['issues']) &&
    fields['issues'].every((issue) => typeof issue === 'string')
  );
};

const responseJson = async <T>(response: Response): Promise<T> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new BuilderApiError(
      'BUILD_FAILED',
      'Agent Builder returned an unreadable response.',
      [],
      { cause: error },
    );
  }
  if (!response.ok) {
    if (isErrorResponse(body)) {
      throw new BuilderApiError(body.error.code, body.error.summary, body.error.issues);
    }
    throw new BuilderApiError(
      'BUILD_FAILED',
      `Agent Builder request failed with status ${String(response.status)}.`,
      [],
    );
  }
  return body as T;
};

export const getCapabilityCatalog = async (
  signal?: AbortSignal,
): Promise<CapabilityCatalogResponse> =>
  responseJson<CapabilityCatalogResponse>(
    await fetch('/api/capabilities', {
      headers: { Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    }),
  );

export const buildAgent = async (
  definition: AgentDefinition,
  signal?: AbortSignal,
): Promise<BuildAgentResult> => {
  const request: BuildAgentRequest = { definition };
  return responseJson<BuildAgentResult>(
    await fetch('/api/build', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    }),
  );
};
