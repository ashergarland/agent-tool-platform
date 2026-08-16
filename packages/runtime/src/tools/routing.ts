import { z } from 'zod';
import type { AnyToolDefinition, ToolAnnotations, ToolRouting } from './types.js';

/**
 * Routing grammar and description composition.
 *
 * Rendering is centralized so every tool in the portfolio answers the same questions in the same
 * order: what it does, whether it changes state, when it applies, and what to run around it.
 * Capabilities supply the content; the platform owns the shape.
 */

export const toolRoutingSchema = z.object({
  useWhen: z.array(z.string().min(1)).min(1),
  doNotUseWhen: z.array(z.string().min(1)).min(1),
  prerequisites: z.array(z.string().min(1)).optional(),
  nextSteps: z.array(z.string().min(1)).optional(),
  scope: z.string().min(1).optional(),
  changesState: z.boolean(),
});

export const defaultAnnotations = (definition: {
  readonly kind: 'read' | 'write';
  readonly annotations?: Partial<ToolAnnotations> | undefined;
}): ToolAnnotations => ({
  readOnlyHint: definition.kind === 'read',
  destructiveHint: definition.kind === 'write',
  idempotentHint: definition.kind === 'read',
  openWorldHint: true,
  ...definition.annotations,
});

const bullets = (heading: string, entries: readonly string[]): readonly string[] =>
  entries.length === 0 ? [] : [heading, ...entries.map((entry) => `- ${entry}`)];

const stateLine = (routing: ToolRouting): string =>
  routing.changesState
    ? 'State: CHANGES state. Preview first, obtain explicit user approval, execute, then verify.'
    : 'State: read-only. Safe to call while investigating.';

/** Renders the agent-facing description from the declared description plus structured routing. */
export const composeToolDescription = (definition: {
  readonly description: string;
  readonly routing: ToolRouting;
}): string =>
  [
    definition.description.trim(),
    '',
    stateLine(definition.routing),
    ...(definition.routing.scope === undefined ? [] : [`Scope: ${definition.routing.scope}`]),
    '',
    ...bullets('Use when:', definition.routing.useWhen),
    ...bullets('Do not use when:', definition.routing.doNotUseWhen),
    ...bullets('Run these first:', definition.routing.prerequisites ?? []),
    ...bullets('Typical next steps:', definition.routing.nextSteps ?? []),
  ]
    .join('\n')
    .trim();

export class ToolRoutingError extends Error {
  public override readonly name = 'ToolRoutingError';
}

const toolNamePattern = /^[a-z][a-z0-9_]{1,62}$/u;

/**
 * Structural validation applied at registry construction. Catching a malformed routing block at
 * startup is far cheaper than discovering it in an agent transcript.
 */
export const validateToolDefinition = <TServices>(
  definition: AnyToolDefinition<TServices>,
): void => {
  if (!toolNamePattern.test(definition.name)) {
    throw new ToolRoutingError(
      `Tool name "${definition.name}" must be snake_case, start with a letter, and be at most 63 characters`,
    );
  }
  if (definition.title.trim().length === 0) {
    throw new ToolRoutingError(`Tool ${definition.name} must declare a non-empty title`);
  }
  if (definition.summary.trim().length === 0) {
    throw new ToolRoutingError(`Tool ${definition.name} must declare a non-empty summary`);
  }
  if (definition.description.trim().length === 0) {
    throw new ToolRoutingError(`Tool ${definition.name} must declare a non-empty description`);
  }
  const routing = toolRoutingSchema.safeParse(definition.routing);
  if (!routing.success) {
    throw new ToolRoutingError(
      `Tool ${definition.name} has invalid routing metadata: ${routing.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  // A read tool that admits to changing state, or a write tool that denies it, would publish
  // contradictory annotations to MCP and contradictory consequentiality to OpenAPI.
  if ((definition.kind === 'write') !== definition.routing.changesState) {
    throw new ToolRoutingError(
      `Tool ${definition.name} declares kind="${definition.kind}" but routing.changesState=${String(
        definition.routing.changesState,
      )}`,
    );
  }
};
