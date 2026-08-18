import { z } from 'zod';
import { badRequest, internalError, notFound, toAppError } from '../errors.js';
import { composeToolDescription, defaultAnnotations, validateToolDefinition } from './routing.js';
import type {
  AnyToolDefinition,
  ToolAnnotations,
  ToolInvocationContext,
  ToolKind,
  ToolRouting,
} from './types.js';

/**
 * The single source of truth for what tools exist and what their contracts are.
 *
 * Every transport — HTTP, OpenAPI, MCP over stdio, MCP over Streamable HTTP — reads from this one
 * registry, which is what makes the "one tool, one schema, four surfaces" invariant hold rather
 * than being a convention people remember to follow.
 *
 * Seeded by the Azure registry (strict output validation, path-only schema errors, both base and
 * rendered descriptions retained) with the AST error normalization.
 */

/** Type-erased view of a tool, used by every transport. */
export interface RegisteredTool<TServices> {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  /** Description exactly as declared, without routing guidance. */
  readonly baseDescription: string;
  /** Description agents see: declaration plus rendered routing guidance. */
  readonly description: string;
  readonly kind: ToolKind;
  readonly routing: ToolRouting;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly inputJsonSchema: Record<string, unknown>;
  readonly outputJsonSchema: Record<string, unknown>;
  invoke(rawInput: unknown, services: TServices, context: ToolInvocationContext): Promise<unknown>;
}

const jsonSchema = (schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> =>
  z.toJSONSchema(schema, { io, target: 'draft-7', unrepresentable: 'any' });

const inputIssues = (error: z.ZodError): unknown =>
  error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));

/**
 * Only the offending paths, never the offending value: a handler's result may contain capability
 * data that has no business appearing in an error payload.
 */
const outputIssuePaths = (error: z.ZodError): readonly string[] =>
  error.issues.slice(0, 20).map((issue) => issue.path.join('.') || '(root)');

const erase = <TServices>(definition: AnyToolDefinition<TServices>): RegisteredTool<TServices> => ({
  name: definition.name,
  title: definition.title,
  summary: definition.summary,
  baseDescription: definition.description,
  description: composeToolDescription(definition),
  kind: definition.kind,
  routing: definition.routing,
  annotations: defaultAnnotations(definition),
  inputSchema: definition.inputSchema,
  outputSchema: definition.outputSchema,
  inputJsonSchema: jsonSchema(definition.inputSchema, 'input'),
  outputJsonSchema: jsonSchema(definition.outputSchema, 'output'),
  async invoke(rawInput, services, context) {
    const parsed = definition.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw badRequest(`Invalid input for tool ${definition.name}`, {
        issues: inputIssues(parsed.error),
      });
    }

    let result: unknown;
    try {
      result = await definition.handler(parsed.data, services, context);
    } catch (error) {
      throw toAppError(error);
    }

    // Outputs are validated as strictly as inputs. A handler that has drifted from its declared
    // schema is a server defect, and must not reach the caller as a plausible-looking result that
    // the advertised JSON Schema promised.
    const validated = definition.outputSchema.safeParse(result);
    if (!validated.success) {
      throw internalError(
        `Tool ${definition.name} produced a result that does not match its declared output schema`,
        new Error(`invalid output paths: ${outputIssuePaths(validated.error).join(', ')}`),
      );
    }
    return validated.data;
  },
});

export class ToolRegistry<TServices> {
  private readonly tools: ReadonlyMap<string, RegisteredTool<TServices>>;

  public constructor(definitions: readonly AnyToolDefinition<TServices>[]) {
    const map = new Map<string, RegisteredTool<TServices>>();
    for (const definition of definitions) {
      validateToolDefinition(definition);
      if (map.has(definition.name)) {
        throw new Error(`Duplicate tool name in registry: ${definition.name}`);
      }
      map.set(definition.name, erase(definition));
    }
    this.tools = map;
  }

  public get size(): number {
    return this.tools.size;
  }

  public list(): readonly RegisteredTool<TServices>[] {
    return [...this.tools.values()];
  }

  public names(): readonly string[] {
    return [...this.tools.keys()];
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public get(name: string): RegisteredTool<TServices> {
    const tool = this.tools.get(name);
    if (!tool) throw notFound(`Unknown tool: ${name}`, { availableTools: [...this.tools.keys()] });
    return tool;
  }

  public invoke(
    name: string,
    rawInput: unknown,
    services: TServices,
    context: ToolInvocationContext,
  ): Promise<unknown> {
    return this.get(name).invoke(rawInput, services, context);
  }
}

export const createToolRegistry = <TServices>(
  definitions: readonly AnyToolDefinition<TServices>[],
): ToolRegistry<TServices> => new ToolRegistry(definitions);
