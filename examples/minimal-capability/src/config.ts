import {
  ConfigurationError,
  defineCapabilityConfig,
  positiveInteger,
  strictBoolean,
  type PlatformConfig,
} from '@agent-tool-platform/runtime';
import { z } from 'zod';

/**
 * Capability configuration composition.
 *
 * `MinimalConfig` extends {@link PlatformConfig}; it does not replace it and it is not a member of
 * any shared union. This is exactly the shape a real capability uses.
 */

export const minimalEnvSchema = z.object({
  MINIMAL_MAX_NOTES: positiveInteger(50),
  MINIMAL_GREETING: z.string().min(1).max(120).default('minimal capability'),
  MINIMAL_STRICT: strictBoolean.default(false),
});

export interface MinimalConfig extends PlatformConfig {
  readonly minimal: {
    readonly maxNotes: number;
    readonly greeting: string;
    readonly strict: boolean;
  };
}

export const minimalConfig = defineCapabilityConfig({
  schema: minimalEnvSchema,
  build({ base, env }): MinimalConfig {
    return {
      ...base,
      minimal: {
        maxNotes: env.MINIMAL_MAX_NOTES,
        greeting: env.MINIMAL_GREETING,
        strict: env.MINIMAL_STRICT,
      },
    };
  },
  validate(config) {
    // A cross-field invariant a per-variable schema cannot express.
    if (config.minimal.strict && config.minimal.maxNotes > 10) {
      throw new ConfigurationError(
        'MINIMAL_STRICT=true requires MINIMAL_MAX_NOTES to be at most 10',
      );
    }
  },
});
