import type { Logger } from 'pino';
import type { PlatformConfig } from '../config/platform.js';
import type { AnyCapabilityConfigSpec } from '../config/capability.js';
import type { HttpRouter } from '../http/types.js';
import type { ApplicationLifecycle, ReadinessResult } from '../lifecycle/index.js';
import type { ScratchWorkspace, ScratchWorkspaceOptions } from '../lifecycle/scratch.js';
import type { CapabilityTelemetryEstimator, TelemetrySink } from '../telemetry/types.js';
import type { AnyToolDefinition } from '../tools/types.js';

/**
 * The capability contract.
 *
 * A capability is data, not a subclass. It declares what it is, what it configures, what services
 * it needs, what tools it offers, and where it wants to participate in the application lifecycle.
 * The runtime supplies everything else.
 */

export interface CapabilityManifest {
  /** Default service name; overridable through `SERVICE_NAME`. */
  readonly name: string;
  /** Default service version; overridable through `SERVICE_VERSION`. */
  readonly version: string;
  /** Human-readable title used by OpenAPI and MCP. */
  readonly title: string;
  /** One-paragraph description used by OpenAPI. */
  readonly description: string;
  readonly documentationUrl?: string;
}

/** What a capability sees while it is building its services. */
export interface CapabilityContext<TConfig extends PlatformConfig> {
  readonly config: TConfig;
  readonly logger: Logger;
  readonly lifecycle: ApplicationLifecycle;
  readonly telemetry: TelemetrySink;
  /**
   * Creates a private temporary directory owned by the application lifecycle. Manual disposal
   * transfers it out of lifecycle ownership after removal succeeds.
   */
  readonly createScratchWorkspace: (options?: ScratchWorkspaceOptions) => Promise<ScratchWorkspace>;
}

/** What a capability sees once its services exist. */
export interface CapabilityRuntimeContext<
  TConfig extends PlatformConfig,
  TServices,
> extends CapabilityContext<TConfig> {
  readonly services: TServices;
}

export interface CapabilityLifecycle<TConfig extends PlatformConfig, TServices> {
  start?(context: CapabilityRuntimeContext<TConfig, TServices>): Promise<void> | void;
  stop?(context: CapabilityRuntimeContext<TConfig, TServices>): Promise<void> | void;
}

export type CapabilityReadinessContributor<TConfig extends PlatformConfig, TServices> = (
  context: CapabilityRuntimeContext<TConfig, TServices>,
) => Promise<ReadinessResult> | ReadinessResult;

export interface CapabilityRouteContext<TConfig extends PlatformConfig, TServices> {
  readonly config: TConfig;
  readonly services: TServices;
  readonly logger: Logger;
}

/**
 * Registers routes on a scope where authentication, rate limiting, request identity, cache
 * headers, and error normalization are already installed. A capability never builds a second
 * Fastify application and never re-implements a guard.
 */
export type ProtectedRouteRegistrar<TConfig extends PlatformConfig, TServices> = (
  router: HttpRouter,
  context: CapabilityRouteContext<TConfig, TServices>,
) => Promise<void> | void;

/**
 * Registers routes that are deliberately unauthenticated. Separate from
 * {@link ProtectedRouteRegistrar} so exposing something publicly is always an explicit act.
 */
export type PublicRouteRegistrar<TConfig extends PlatformConfig, TServices> = (
  router: HttpRouter,
  context: CapabilityRouteContext<TConfig, TServices>,
) => Promise<void> | void;

export interface CapabilityTelemetry {
  /** Derives capability-specific measurements from an invocation. */
  estimateInvocation?: CapabilityTelemetryEstimator['estimate'];
}

export interface AgentToolCapability<TServices, TConfig extends PlatformConfig = PlatformConfig> {
  readonly manifest: CapabilityManifest;
  /** Server-wide routing guidance, published through MCP initialization and OpenAPI. */
  readonly instructions: string;
  readonly config?: AnyCapabilityConfigSpec<TConfig> | undefined;
  readonly tools: readonly AnyToolDefinition<TServices>[];
  createServices(context: CapabilityContext<TConfig>): TServices | Promise<TServices>;
  readonly lifecycle?: CapabilityLifecycle<TConfig, TServices> | undefined;
  readonly readiness?: readonly CapabilityReadinessContributor<TConfig, TServices>[] | undefined;
  readonly protectedRoutes?: readonly ProtectedRouteRegistrar<TConfig, TServices>[] | undefined;
  readonly publicRoutes?: readonly PublicRouteRegistrar<TConfig, TServices>[] | undefined;
  readonly telemetry?: CapabilityTelemetry | undefined;
}
