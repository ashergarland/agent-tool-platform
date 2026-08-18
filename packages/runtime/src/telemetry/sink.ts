import type { Logger } from 'pino';
import type {
  CapabilityTelemetryEstimator,
  InvocationMeasurement,
  InvocationTelemetryEvent,
  TelemetryEstimateInput,
  TelemetrySink,
} from './types.js';

/** The default. A capability that configures nothing still runs, and costs nothing to run. */
export const noopTelemetrySink: TelemetrySink = { recordInvocation: () => undefined };

/**
 * Emits invocation telemetry as structured logs. Only the fields defined by
 * {@link InvocationTelemetryEvent} are forwarded, so no argument, result, path, or credential can
 * reach the log through this sink.
 */
export const loggingTelemetrySink = (logger: Logger): TelemetrySink => ({
  recordInvocation: (event) => logger.info({ ...event, event: 'tool.invocation' }),
});

/** Fans one event out to several sinks; a failing sink never fails the invocation. */
export const compositeTelemetrySink = (
  sinks: readonly TelemetrySink[],
  onError?: (error: unknown) => void,
): TelemetrySink => ({
  recordInvocation: (event) => {
    for (const sink of sinks) {
      try {
        sink.recordInvocation(event);
      } catch (error) {
        onError?.(error);
      }
    }
  },
});

/** Collects events in memory. Intended for tests and for the conformance testkit. */
export class RecordingTelemetrySink implements TelemetrySink {
  public readonly events: InvocationTelemetryEvent[] = [];

  public recordInvocation(event: InvocationTelemetryEvent): void {
    this.events.push(event);
  }
}

const numericFields = [
  'sourceBytes',
  'outputBytes',
  'rawEquivalentTokens',
  'resultTokens',
  'estimatedTokensAvoided',
] as const;

/**
 * Keeps a capability estimator from poisoning the telemetry stream: only known keys survive, only
 * finite non-negative numbers survive, and anything else is dropped rather than propagated.
 */
export const sanitizeMeasurement = (
  measurement: InvocationMeasurement | undefined,
): InvocationMeasurement | undefined => {
  if (!measurement || typeof measurement !== 'object') return undefined;
  const result: Record<string, number | boolean> = {};
  for (const field of numericFields) {
    const value = measurement[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      result[field] = Math.round(value);
    }
  }
  if (typeof measurement.truncated === 'boolean') result['truncated'] = measurement.truncated;
  if (typeof measurement.fallback === 'boolean') result['fallback'] = measurement.fallback;
  return Object.keys(result).length === 0 ? undefined : result;
};

/**
 * Runs a capability estimator defensively. An estimator that throws must degrade telemetry, never
 * the tool call that produced it.
 */
export const estimateSafely = (
  estimator: CapabilityTelemetryEstimator | undefined,
  input: TelemetryEstimateInput,
  onError?: (error: unknown) => void,
): InvocationMeasurement | undefined => {
  if (!estimator) return undefined;
  try {
    return sanitizeMeasurement(estimator.estimate(input));
  } catch (error) {
    onError?.(error);
    return undefined;
  }
};

/** Rough size proxy used by capabilities that have nothing better; four bytes per token. */
export const approximateTokens = (bytes: number): number => Math.ceil(bytes / 4);

/** Serialized byte length of a value, or 0 when it cannot be serialized. */
export const jsonByteLength = (value: unknown): number => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
  } catch {
    return 0;
  }
};
