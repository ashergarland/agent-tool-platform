import type { ToolRegistry } from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from './harness.js';

/**
 * OpenAPI conformance.
 *
 * The invariant under test is that the document is *derived* from the registry rather than
 * maintained beside it: one POST operation per tool, schemas byte-identical to the registry's, and
 * consequentiality that follows the tool's declared kind.
 */

type JsonObject = Record<string, unknown>;

export interface OpenApiConformanceOptions<TServices> extends ConformanceOptions {
  readonly document: JsonObject;
  readonly registry: ToolRegistry<TServices>;
  /** Public paths that must not require a security scheme. */
  readonly publicPaths?: readonly string[];
}

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null ? (value as JsonObject) : undefined;

export const runOpenApiConformance = <TServices>(
  options: OpenApiConformanceOptions<TServices>,
): ConformanceResult => {
  const run = new ConformanceRun('openapi');
  const { document, registry } = options;
  const paths = asObject(document['paths']) ?? {};
  const tools = registry.list();

  run.check('document declares OpenAPI 3.1', document['openapi'] === '3.1.0');

  const info = asObject(document['info']);
  run.check('info.title is present', typeof info?.['title'] === 'string' && info['title'] !== '');
  run.check(
    'info.version is present',
    typeof info?.['version'] === 'string' && info['version'] !== '',
  );

  const toolPaths = Object.keys(paths).filter((path) => path.startsWith('/tools/'));
  run.equal('one tool operation per registered tool', toolPaths.length, tools.length);

  for (const tool of tools) {
    const path = asObject(paths[`/tools/${tool.name}`]);
    const operation = asObject(path?.['post']);
    if (!operation) {
      run.check(`${tool.name}: has a POST operation`, false, `missing /tools/${tool.name}`);
      continue;
    }
    run.check(`${tool.name}: has a POST operation`, true);
    run.equal(
      `${tool.name}: operationId equals the tool name`,
      operation['operationId'],
      tool.name,
    );
    run.equal(
      `${tool.name}: consequentiality follows the tool kind`,
      operation['x-openai-isConsequential'],
      tool.kind === 'write',
    );
    run.equal(`${tool.name}: annotations are surfaced`, operation['x-tool-annotations'], {
      readOnlyHint: tool.annotations.readOnlyHint,
      destructiveHint: tool.annotations.destructiveHint,
      idempotentHint: tool.annotations.idempotentHint,
      openWorldHint: tool.annotations.openWorldHint,
    });

    const requestSchema = asObject(
      asObject(asObject(asObject(operation['requestBody'])?.['content'])?.['application/json'])?.[
        'schema'
      ],
    );
    run.equal(
      `${tool.name}: request schema derives from the registry`,
      requestSchema,
      tool.inputJsonSchema,
    );

    const responseSchema = asObject(
      asObject(
        asObject(asObject(asObject(operation['responses'])?.['200'])?.['content'])?.[
          'application/json'
        ],
      )?.['schema'],
    );
    const resultSchema = asObject(responseSchema?.['properties'])?.['result'];
    run.equal(
      `${tool.name}: response result schema derives from the registry`,
      resultSchema,
      tool.outputJsonSchema,
    );

    const responses = asObject(operation['responses']) ?? {};
    run.check(
      `${tool.name}: shares the standard platform error responses`,
      ['400', '401', '429', '500'].every((status) => status in responses),
    );
  }

  const components = asObject(document['components']);
  const securitySchemes = asObject(components?.['securitySchemes']);
  const security = document['security'];
  run.check(
    'security derives from the configured auth mode',
    Array.isArray(security) &&
      (security.length === 0
        ? securitySchemes !== undefined
        : securitySchemes !== undefined && Object.keys(securitySchemes).length > 0),
  );

  for (const path of options.publicPaths ?? ['/health', '/ready', '/version', '/openapi.json']) {
    const entry = asObject(paths[path]);
    const operation = asObject(entry?.['get']);
    run.check(
      `${path} is documented as public`,
      Array.isArray(operation?.['security']) && (operation['security'] as unknown[]).length === 0,
    );
  }

  run.check(
    'the shared Error schema is declared',
    asObject(components?.['schemas'])?.['Error'] !== undefined,
  );

  return run.finish(options);
};
