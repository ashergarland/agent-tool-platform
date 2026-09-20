/**
 * `@agent-tool-platform/agent-kit`
 *
 * Host-neutral agent composition over capability-owned contracts. This package resolves immutable
 * capability releases and six-dimensional profiles; it does not execute tools, deploy providers,
 * store registry data, or manage running agent fleets.
 */

export { AgentKitError, MAX_AGENT_KIT_ERROR_LENGTH, type AgentKitErrorCode } from './errors.js';
export {
  compareCodeUnits,
  digestCanonicalJson,
  serializeCanonicalJson,
  type CanonicalJsonPrimitive,
  type CanonicalJsonValue,
} from './canonical-json.js';
export {
  AGENT_BUILD_SCHEMA_VERSION,
  AGENT_DEFINITION_SCHEMA_VERSION,
  AGENT_INSTANCE_SEAM_SCHEMA_VERSION,
  AGENT_LOCK_SCHEMA_VERSION,
  MAX_AGENT_INSTRUCTIONS_LENGTH,
  MAX_COMPOSED_INSTRUCTIONS_LENGTH,
  agentDefinitionSchema,
  agentLockSchema,
  capabilitySelectionSchema,
  exactVersionSchema,
  profileIdentifierSchema,
  publicReferenceSchema,
  resolvedCapabilityArtifactSchema,
  sha256DigestSchema,
  stableIdentifierSchema,
  type AgentDefinition,
  type AgentLock,
  type CapabilitySelection,
  type ResolvedCapabilityArtifact,
} from './schemas.js';
export { parseAgentDefinition } from './model.js';
export {
  parseRegistryCapability,
  resolveRegistryCapability,
  type CapabilityRegistryReader,
  type RegistryCapability,
  type RegistryCapabilityArtifact,
  type RegistryCapabilityBinding,
  type RegistryCapabilityProfile,
} from './registry.js';
export {
  assertCompatibleResolution,
  bindingModeForDimensions,
  capabilityBindingKey,
  resolveAgentDefinition,
  type AgentResolution,
  type BindingMode,
  type CapabilityResolution,
  type ExecutionBinding,
  type IncompatibleCapability,
  type ResolvedCapability,
} from './resolution.js';
export {
  composeInstructions,
  type CapabilityInstructionSection,
  type InstructionComposition,
} from './instructions.js';
export { createAgentLock, digestAgentLock, serializeAgentLock } from './lock.js';
export {
  READINESS_SCHEMA_VERSION,
  createReadinessPlan,
  readinessPlanSchema,
  readinessSnapshotSchema,
  type ReadinessPlan,
  type ReadinessRequirement,
  type ReadinessSnapshot,
} from './readiness.js';
export {
  createAgentInstanceSeam,
  createPreparedAgentInstanceIdentity,
  agentInstanceSeamSchema,
  preparedAgentInstanceIdentitySchema,
  type AgentInstanceSeam,
  type PreparedAgentInstanceIdentity,
} from './instance.js';
export {
  type GeneratedHostFile,
  type HostAdapter,
  type HostAdapterGenerationInput,
  type HostAdapterOutput,
  type HostCompatibility,
  type HostCompatibilityInput,
  validateHostAdapterOutput,
} from './host-adapter.js';
export {
  VSCODE_ADAPTER_SCHEMA_VERSION,
  vscodeHostAdapter,
  type VsCodeAdapterOutput,
} from './vscode.js';
export {
  buildAgent,
  buildVsCodeAgent,
  type AgentBuild,
  type AgentBuildOptions,
  type VsCodeAgentBuildOptions,
} from './build.js';
