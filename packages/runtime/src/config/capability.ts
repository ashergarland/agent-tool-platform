import type { z } from 'zod';
import {
  ConfigurationError,
  buildPlatformConfig,
  formatIssues,
  parsePlatformEnv,
  withoutBlankValues,
  type PlatformConfig,
  type PlatformConfigDefaults,
} from './platform.js';

/**
 * Capability configuration composition.
 *
 * A capability never subclasses anything and never replaces the platform configuration. It
 * contributes an additional environment schema, a pure `build` that produces its own config type
 * from `{ base, env }`, and an optional cross-field `validate`.
 *
 * The result is that `AstConfig`, `AzureConfig`, and `DocRagConfig` never meet each other in a
 * shared union: each capability's config type extends {@link PlatformConfig} and nothing more.
 */

export interface CapabilityConfigBuildInput<TEnv> {
  readonly base: PlatformConfig;
  readonly env: TEnv;
}

export interface CapabilityConfigSpec<
  TEnvSchema extends z.ZodType,
  TConfig extends PlatformConfig,
> {
  /** Additional environment variables this capability understands. */
  readonly schema?: TEnvSchema;
  build(input: CapabilityConfigBuildInput<z.output<TEnvSchema>>): TConfig;
  /** Cross-field invariants that a per-variable schema cannot express. */
  validate?(config: TConfig): void;
}

export type AnyCapabilityConfigSpec<TConfig extends PlatformConfig> = CapabilityConfigSpec<
  z.ZodType,
  TConfig
>;

/** Identity helper that preserves the concrete env schema and config types. */
export const defineCapabilityConfig = <
  TEnvSchema extends z.ZodType,
  TConfig extends PlatformConfig,
>(
  spec: CapabilityConfigSpec<TEnvSchema, TConfig>,
): CapabilityConfigSpec<TEnvSchema, TConfig> => spec;

export interface LoadCapabilityConfigOptions<TConfig extends PlatformConfig> {
  readonly defaults: PlatformConfigDefaults;
  readonly spec?: AnyCapabilityConfigSpec<TConfig> | undefined;
  readonly source?: NodeJS.ProcessEnv;
}

/**
 * Parses the platform environment and, when present, the capability environment, then composes
 * them. Platform validation always runs first so a capability never sees a half-valid base.
 */
export const loadCapabilityConfig = <TConfig extends PlatformConfig>({
  defaults,
  spec,
  source = process.env,
}: LoadCapabilityConfigOptions<TConfig>): TConfig => {
  const base = buildPlatformConfig(parsePlatformEnv(source), defaults);
  if (!spec) return base as TConfig;

  let env: unknown = {};
  if (spec.schema) {
    const parsed = spec.schema.safeParse(withoutBlankValues(source));
    if (!parsed.success) {
      throw new ConfigurationError(
        `Invalid capability environment configuration: ${formatIssues(parsed.error)}`,
      );
    }
    env = parsed.data;
  }

  const config = spec.build({ base, env });
  spec.validate?.(config);
  return config;
};
