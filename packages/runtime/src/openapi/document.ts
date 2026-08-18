import type { PlatformConfig } from '../config/platform.js';
import { errorCodes } from '../errors.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';

/**
 * Registry-derived OpenAPI 3.1.
 *
 * Seeded by the Azure document builder and generalized: no Azure wording, no ARM concepts, and the
 * title, description, and consequentiality all derive from capability metadata plus the tool's own
 * declared kind.
 *
 * The invariant this exists to protect is that every tool in the registry becomes exactly one POST
 * operation. Registry count, HTTP endpoint count, OpenAPI operation count, and MCP tool count are
 * therefore the same number by construction rather than by discipline.
 */

type JsonObject = Record<string, unknown>;

export interface OpenApiCapabilityMetadata {
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
}

const errorSchema: JsonObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable', 'requestId'],
      properties: {
        code: { type: 'string', enum: [...errorCodes] },
        message: { type: 'string' },
        details: {},
        retryable: { type: 'boolean' },
        requestId: { type: 'string' },
      },
    },
  },
};

const readinessSchema: JsonObject = {
  type: 'object',
  required: ['ready', 'state', 'checkedAt', 'checks'],
  properties: {
    ready: { type: 'boolean' },
    state: { type: 'string', enum: ['ready', 'degraded', 'not_ready'] },
    checkedAt: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'state'],
        properties: {
          name: { type: 'string' },
          state: { type: 'string', enum: ['ready', 'degraded', 'not_ready'] },
          detail: { type: 'string' },
        },
      },
    },
  },
};

const toolCatalogueSchema: JsonObject = {
  type: 'object',
  required: ['instructions', 'tools'],
  properties: {
    instructions: { type: 'string' },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'title', 'summary', 'description', 'kind'],
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          description: { type: 'string' },
          kind: { type: 'string', enum: ['read', 'write'] },
          annotations: { type: 'object', additionalProperties: true },
          routing: { type: 'object', additionalProperties: true },
          inputSchema: { type: 'object', additionalProperties: true },
          outputSchema: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
};

const errorResponse = (description: string): JsonObject => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const errorResponses: JsonObject = {
  '400': errorResponse('Invalid input'),
  '401': errorResponse('Missing or invalid credentials'),
  '403': errorResponse('The request is not permitted'),
  '404': errorResponse('Unknown tool or resource'),
  '409': errorResponse('The request conflicts with current state'),
  '413': errorResponse('A deployment limit was exceeded'),
  '429': errorResponse('Rate limited'),
  '500': errorResponse('Tool server failure'),
  '502': errorResponse('Upstream failure'),
  '503': errorResponse('Not ready, draining, or capacity saturated'),
  '504': errorResponse('The request deadline was exceeded'),
};

/**
 * ChatGPT Actions rejects operation descriptions longer than 300 characters, so the operation
 * carries the summary and the full rendered routing guidance stays available from `/tools` and MCP.
 *
 * As with the rendered routing state line, this states only that the tool changes state. Whether a
 * preview or a confirmation exists is the tool's own contract, declared in its schema and its
 * description, not something the platform can assert on every write tool's behalf.
 */
const operationDescription = (tool: RegisteredTool<unknown>): string =>
  tool.kind === 'write' ? `${tool.summary} This changes state.` : tool.summary;

const toolPath = (tool: RegisteredTool<unknown>): JsonObject => ({
  post: {
    operationId: tool.name,
    summary: tool.summary,
    description: operationDescription(tool),
    tags: [tool.kind],
    'x-openai-isConsequential': tool.kind === 'write',
    'x-tool-annotations': {
      readOnlyHint: tool.annotations.readOnlyHint,
      destructiveHint: tool.annotations.destructiveHint,
      idempotentHint: tool.annotations.idempotentHint,
      openWorldHint: tool.annotations.openWorldHint,
    },
    'x-tool-routing': {
      useWhen: tool.routing.useWhen,
      doNotUseWhen: tool.routing.doNotUseWhen,
      ...(tool.routing.prerequisites ? { prerequisites: tool.routing.prerequisites } : {}),
      ...(tool.routing.nextSteps ? { nextSteps: tool.routing.nextSteps } : {}),
      ...(tool.routing.scope === undefined ? {} : { scope: tool.routing.scope }),
      changesState: tool.routing.changesState,
    },
    requestBody: {
      required: true,
      content: { 'application/json': { schema: tool.inputJsonSchema } },
    },
    responses: {
      '200': {
        description: 'Tool result',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tool', 'requestId', 'result'],
              properties: {
                tool: { type: 'string' },
                requestId: { type: 'string' },
                result: tool.outputJsonSchema,
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  },
});

const securityScheme = (config: PlatformConfig): JsonObject => ({
  type: 'http',
  scheme: 'bearer',
  description:
    config.auth.mode === 'entra-jwt'
      ? 'Microsoft Entra ID access token issued for the configured audience.'
      : 'Static API key supplied as a bearer token or x-api-key header.',
});

export const buildOpenApiDocument = <TServices>(
  config: PlatformConfig,
  registry: ToolRegistry<TServices>,
  capability: OpenApiCapabilityMetadata,
): JsonObject => {
  const paths: JsonObject = {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe.',
        description: 'Reports that the process is running. It does not imply the server is usable.',
        security: [],
        responses: { '200': { description: 'Process is alive' } },
      },
    },
    '/ready': {
      get: {
        operationId: 'ready',
        summary: 'Readiness probe.',
        description: 'Aggregates the capability readiness contributors.',
        security: [],
        responses: {
          '200': {
            description: 'Ready to serve',
            content: { 'application/json': { schema: readinessSchema } },
          },
          '503': {
            description: 'Not ready or draining',
            content: { 'application/json': { schema: readinessSchema } },
          },
        },
      },
    },
    '/version': {
      get: {
        operationId: 'version',
        summary: 'Build and capability information.',
        security: [],
        responses: { '200': { description: 'Service metadata' } },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'openapi',
        summary: 'Generated OpenAPI document.',
        security: [],
        responses: { '200': { description: 'OpenAPI 3.1 document' } },
      },
    },
    '/tools': {
      get: {
        operationId: 'listTools',
        summary: 'List every registered tool with its JSON Schemas and routing metadata.',
        responses: {
          '200': {
            description: 'Tool catalogue',
            content: { 'application/json': { schema: toolCatalogueSchema } },
          },
          ...errorResponses,
        },
      },
    },
    '/mcp': {
      post: {
        operationId: 'mcp',
        summary: 'Stateless Streamable HTTP MCP endpoint.',
        responses: { '200': { description: 'MCP response' }, ...errorResponses },
      },
    },
  };

  for (const tool of registry.list()) {
    paths[`/tools/${tool.name}`] = toolPath(tool);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: capability.title,
      version: config.service.version,
      description: `${capability.description}\n\n${capability.instructions}`,
    },
    servers: [{ url: config.service.publicBaseUrl ?? `http://localhost:${config.http.port}` }],
    security: config.auth.mode === 'disabled' ? [] : [{ bearerAuth: [] }],
    components: {
      schemas: { Error: errorSchema },
      securitySchemes: { bearerAuth: securityScheme(config) },
    },
    paths,
    tags: [
      { name: 'read', description: 'Read-only tools.' },
      { name: 'write', description: 'State-changing tools.' },
    ],
  };
};
