/**
 * `@agent-tool-platform/testkit`
 *
 * Reusable conformance suites that prove a capability satisfies the platform contracts. These test
 * PLATFORM invariants only: no suite asserts anything about ASTs, repositories, Azure resources,
 * documents, or images. Domain behaviour stays in the capability repository's own tests.
 *
 * The testkit imports no test runner, so each suite can be called from whichever `it(...)` a
 * capability repository already uses.
 */

export {
  ConformanceError,
  ConformanceRun,
  hasErrorCode,
  type ConformanceCheck,
  type ConformanceOptions,
  type ConformanceResult,
} from './harness.js';

export {
  createTestInvocationContext,
  createTestPlatformConfig,
  generateTestApiKey,
  type TestConfigOverrides,
  type TestInvocationContextOptions,
} from './fixtures.js';

export { runAuthConformance, type AuthConformanceOptions } from './auth.js';
export { runConfigConformance, type ConfigConformanceOptions } from './config.js';
export { runHttpConformance, type HttpConformanceOptions } from './http.js';
export { runLifecycleConformance, type LifecycleConformanceOptions } from './lifecycle.js';
export {
  connectInMemoryMcpClient,
  runMcpConformance,
  type ConnectedMcpClient,
  type McpConformanceOptions,
  type McpToolSample,
} from './mcp.js';
export { runMetadataConformance, type MetadataConformanceOptions } from './metadata/index.js';
export { runOpenApiConformance, type OpenApiConformanceOptions } from './openapi.js';
export { runProcessConformance, type ProcessConformanceOptions } from './process.js';
export { runRegistryConformance, type RegistryConformanceOptions } from './registry.js';
export {
  runRootBoundaryConformance,
  type RootBoundaryConformanceOptions,
} from './root-boundary.js';
export { runRoutingConformance, type RoutingConformanceOptions } from './routing.js';
export {
  runTransportParity,
  type TransportParityOptions,
  type TransportParitySample,
} from './transport-parity.js';
