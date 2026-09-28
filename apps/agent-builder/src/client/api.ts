import type { AgentDefinition } from '@agent-tool-platform/agent-kit';
import type {
  BuildAgentRequest,
  BuildAgentResult,
  BuilderErrorCode,
  BuilderErrorResponse,
  CapabilityCatalogResponse,
  LocalAgentInstanceDiscoveryResponse,
  PrepareAgentRequest,
  PrepareAgentResult,
} from '../shared/contracts.js';
import { LOCAL_VSCODE_ENVIRONMENT_ID } from '../shared/contracts.js';

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

export class BuilderUnavailableError extends Error {
  public override readonly name = 'BuilderUnavailableError';

  public constructor(options?: ErrorOptions) {
    super(
      'Agent Builder server is unavailable. Check that the local Builder process is still running.',
      options,
    );
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

const responseJson = async <T>(
  response: Response,
  fallbackCode: BuilderErrorCode = 'BUILD_FAILED',
): Promise<T> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new BuilderApiError(fallbackCode, 'Agent Builder returned an unreadable response.', [], {
      cause: error,
    });
  }
  if (!response.ok) {
    if (isErrorResponse(body)) {
      throw new BuilderApiError(body.error.code, body.error.summary, body.error.issues);
    }
    throw new BuilderApiError(
      fallbackCode,
      `Agent Builder request failed with status ${String(response.status)}.`,
      [],
    );
  }
  return body as T;
};

const fetchBuilder = async (input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init.signal?.aborted === true) throw error;
    throw new BuilderUnavailableError({ cause: error });
  }
};

export const getCapabilityCatalog = async (
  signal?: AbortSignal,
): Promise<CapabilityCatalogResponse> =>
  responseJson<CapabilityCatalogResponse>(
    await fetchBuilder('/api/capabilities', {
      headers: { Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    }),
  );

export const getLocalAgentInstances = async (
  signal?: AbortSignal,
): Promise<LocalAgentInstanceDiscoveryResponse> =>
  responseJson<LocalAgentInstanceDiscoveryResponse>(
    await fetchBuilder('/api/instances', {
      headers: { Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    }),
    'INSTANCE_DISCOVERY_FAILED',
  );

export const buildAgent = async (
  definition: AgentDefinition,
  signal?: AbortSignal,
): Promise<BuildAgentResult> => {
  const request: BuildAgentRequest = { definition };
  return responseJson<BuildAgentResult>(
    await fetchBuilder('/api/build', {
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

export const prepareAgent = async (
  definition: AgentDefinition,
  expectedLockDigest: string,
  signal?: AbortSignal,
): Promise<PrepareAgentResult> => {
  const request: PrepareAgentRequest = {
    definition,
    expectedLockDigest,
    environmentId: LOCAL_VSCODE_ENVIRONMENT_ID,
  };
  return responseJson<PrepareAgentResult>(
    await fetchBuilder('/api/prepare', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    }),
    'PREPARATION_FAILED',
  );
};
