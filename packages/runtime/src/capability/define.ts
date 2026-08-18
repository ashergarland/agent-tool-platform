import type { z } from 'zod';
import type { CapabilityConfigSpec } from '../config/capability.js';
import type { PlatformConfig } from '../config/platform.js';
import type { AnyToolDefinition } from '../tools/types.js';
import type {
  AgentToolCapability,
  CapabilityContext,
  CapabilityLifecycle,
  CapabilityManifest,
  CapabilityReadinessContributor,
  CapabilityTelemetry,
  ProtectedRouteRegistrar,
  PublicRouteRegistrar,
} from './types.js';

/**
 * The primary capability definition API.
 *
 * `defineAgentToolCapability` is an identity function whose entire job is inference: it captures
 * the capability's own configuration type and services type so tools, lifecycle hooks, readiness
 * contributors, and routes are all checked against them.
 *
 * There is no base class, no universal `Services` interface, and no shared `AppConfig` union.
 */

export interface AgentToolCapabilityDefinition<
  TServices,
  TConfig extends PlatformConfig,
  TEnvSchema extends z.ZodType,
> {
  readonly manifest: CapabilityManifest;
  readonly instructions: string;
  readonly config?: CapabilityConfigSpec<TEnvSchema, TConfig>;
  readonly tools: readonly AnyToolDefinition<TServices>[];
  createServices(context: CapabilityContext<TConfig>): TServices | Promise<TServices>;
  readonly lifecycle?: CapabilityLifecycle<TConfig, TServices>;
  readonly readiness?: readonly CapabilityReadinessContributor<TConfig, TServices>[];
  readonly protectedRoutes?: readonly ProtectedRouteRegistrar<TConfig, TServices>[];
  readonly publicRoutes?: readonly PublicRouteRegistrar<TConfig, TServices>[];
  readonly telemetry?: CapabilityTelemetry;
}

export const defineAgentToolCapability = <
  TServices,
  TConfig extends PlatformConfig = PlatformConfig,
  TEnvSchema extends z.ZodType = z.ZodType,
>(
  definition: AgentToolCapabilityDefinition<TServices, TConfig, TEnvSchema>,
): AgentToolCapability<TServices, TConfig> => definition;
