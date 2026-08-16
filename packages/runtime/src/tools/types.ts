import type { z } from 'zod';
import type { Principal } from '../auth/types.js';

/**
 * The generic tool contract.
 *
 * Seeded by the Azure capability's structured tool model, generalized so nothing Azure-specific
 * survives: `requiredScope` became an optional, free-text {@link ToolRouting.scope}, and the
 * services type is a capability-supplied generic rather than a shared `Services` interface.
 */

export type ToolKind = 'read' | 'write';

export type ToolTransport = 'http' | 'mcp-stdio' | 'mcp-http';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: Principal;
  readonly transport: ToolTransport;
  /**
   * Aborted when the application drains, the caller disconnects, or a configured request deadline
   * elapses. Never optional: a capability must always be able to observe cancellation.
   */
  readonly signal: AbortSignal;
}

/**
 * Routing guidance. Every field is rendered into the description agents see, so a model can choose
 * between overlapping tools without trial and error.
 *
 * This is *tool-level* routing only. Cross-capability workflow routing belongs to agent
 * composition repositories, not here.
 */
export interface ToolRouting {
  /** Concrete situations where this tool is the right choice. */
  readonly useWhen: readonly string[];
  /** Situations where a different tool is better, naming that tool. */
  readonly doNotUseWhen: readonly string[];
  /** Tools that normally have to succeed first. */
  readonly prerequisites?: readonly string[];
  /** Tools that normally follow. */
  readonly nextSteps?: readonly string[];
  /**
   * Optional, capability-defined statement of what the call needs access to, in the caller's
   * terms. Deliberately free text: an Azure ARM scope, a repository path, and a corpus name are
   * not the same concept and the platform must not pretend they are.
   */
  readonly scope?: string;
  readonly changesState: boolean;
}

/**
 * MCP tool annotations. Declared per tool rather than derived from {@link ToolKind} alone, because
 * "changes state" and "destroys state" are different promises.
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition<
  TServices,
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  /** One-line description surfaced in tool listings and the OpenAPI summary. */
  readonly summary: string;
  /** What the tool does. Routing guidance is composed separately from {@link routing}. */
  readonly description: string;
  readonly kind: ToolKind;
  readonly routing: ToolRouting;
  /** Defaults are derived from {@link kind} when omitted. */
  readonly annotations?: Partial<ToolAnnotations>;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;

  /**
   * Declared with method syntax on purpose: bivariant parameter checking is what lets a tool with
   * concrete schemas live in a `readonly AnyToolDefinition<TServices>[]` catalogue.
   */
  handler(
    input: z.output<TInput>,
    services: TServices,
    context: ToolInvocationContext,
  ): Promise<z.output<TOutput>>;
}

export type AnyToolDefinition<TServices> = ToolDefinition<TServices, z.ZodType, z.ZodType>;

/** Identity helper that preserves the concrete schema types when declaring a tool. */
export const defineTool = <TServices, TInput extends z.ZodType, TOutput extends z.ZodType>(
  definition: ToolDefinition<TServices, TInput, TOutput>,
): ToolDefinition<TServices, TInput, TOutput> => definition;
