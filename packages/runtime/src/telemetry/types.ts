import type { ErrorCode } from '../errors.js';
import type { ToolTransport } from '../tools/types.js';

/**
 * Minimal telemetry v1 seam.
 *
 * This is intentionally a contract and nothing more. There is no exporter, no Application
 * Insights wiring, no rollup, and no dashboard here — those belong to a later phase. What must
 * exist now is a stable shape, so adding a backend later does not mean editing every capability.
 *
 * The single long-term question this is built to answer is "how much model context did routing
 * through a tool avoid?", which is why {@link InvocationMeasurement} is expressed in bytes and
 * token estimates rather than in domain nouns.
 *
 * Nothing here carries content. No prompts, source, arguments, results, file paths, filenames,
 * resource identifiers, or credentials are part of any type in this module, and the runtime never
 * passes them to a sink.
 */

export interface InvocationMeasurement {
  /** Size of the material the capability consulted to answer, in bytes. */
  readonly sourceBytes?: number;
  /** Size of what the capability returned, in bytes. */
  readonly outputBytes?: number;
  /** Tokens an agent would have spent had it read the raw material itself. */
  readonly rawEquivalentTokens?: number;
  /** Tokens the returned result actually costs. */
  readonly resultTokens?: number;
  /** `rawEquivalentTokens - resultTokens`, when the capability can estimate both. */
  readonly estimatedTokensAvoided?: number;
  readonly truncated?: boolean;
  /** True when the capability answered through a degraded or secondary path. */
  readonly fallback?: boolean;
}

export interface TelemetryEstimateInput {
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly durationMs: number;
}

export interface CapabilityTelemetryEstimator {
  /**
   * Derives measurements from an invocation. The runtime passes input and output so a capability
   * can size them; it must return only aggregates, never the values themselves.
   */
  estimate(input: TelemetryEstimateInput): InvocationMeasurement | undefined;
}

export type InvocationOutcome = 'ok' | 'error';

/** Everything the runtime knows without any capability cooperation. */
export interface InvocationTelemetryEvent {
  readonly capability: string;
  readonly capabilityVersion: string;
  readonly tool: string;
  readonly transport: ToolTransport;
  readonly outcome: InvocationOutcome;
  readonly errorCode?: ErrorCode;
  readonly durationMs: number;
  readonly measurement?: InvocationMeasurement;
}

export interface TelemetrySink {
  recordInvocation(event: InvocationTelemetryEvent): void;
}
