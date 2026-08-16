import { badRequest, conflict, forbidden } from '../errors.js';

/**
 * The generic mutation gate.
 *
 * Only the behaviour the template and the Azure capability genuinely share lives here: a
 * state-changing tool may always be previewed, may only execute when mutations are enabled, and
 * may only execute without confirmation when confirmation is not required.
 *
 * Everything Azure-specific — subscription allow-lists, ARM identifiers, deployment scope
 * validation, management-group policy, Bicep scope rules — stays in the Azure capability. The
 * platform cannot express those rules without learning a domain, and a platform that learns a
 * domain stops being a platform.
 */

export interface MutationRequest {
  readonly toolName: string;
  readonly dryRun: boolean;
  readonly confirm: boolean;
}

export type MutationDecision = { readonly mode: 'preview' } | { readonly mode: 'execute' };

export interface MutationPolicy {
  readonly enabled: boolean;
  readonly confirmationRequired: boolean;
}

/**
 * Returns the decision, or throws a transport-safe error explaining precisely which condition was
 * not met. A preview is always permitted: refusing to describe an action the caller cannot perform
 * teaches an agent nothing and makes it guess.
 */
export const decideMutation = (
  policy: MutationPolicy,
  request: MutationRequest,
): MutationDecision => {
  if (request.dryRun) return { mode: 'preview' };

  if (!policy.enabled) {
    throw forbidden(
      `Tool ${request.toolName} changes state and mutations are disabled on this deployment. ` +
        'Re-run with dryRun=true to preview the action.',
      { toolName: request.toolName, reason: 'mutations_disabled' },
    );
  }

  if (policy.confirmationRequired && !request.confirm) {
    throw badRequest(
      `Tool ${request.toolName} changes state and requires an explicit confirm=true from the user.`,
      { toolName: request.toolName, reason: 'confirmation_required' },
    );
  }

  return { mode: 'execute' };
};

/**
 * Convenience for capabilities that want the gate as an object bound to configuration once, rather
 * than threading policy through every handler.
 */
export class MutationGate {
  public constructor(private readonly policy: MutationPolicy) {}

  public get enabled(): boolean {
    return this.policy.enabled;
  }

  public get confirmationRequired(): boolean {
    return this.policy.confirmationRequired;
  }

  public decide(request: MutationRequest): MutationDecision {
    return decideMutation(this.policy, request);
  }

  /** Convenience predicate: true when the caller only wants a plan. */
  public isPreview(request: MutationRequest): boolean {
    return this.decide(request).mode === 'preview';
  }
}

/**
 * Raised by a capability when the observed state no longer matches what a preview was based on.
 * Exposed here so "the world changed under you" is one code across the portfolio.
 */
export const mutationConflict = (message: string, details?: unknown): Error =>
  conflict(message, details);
