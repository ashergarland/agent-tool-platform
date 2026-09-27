import type {
  AgentDefinition,
  AgentInstanceSeam,
  BindingMode,
  ReadinessRequirement,
} from '@agent-tool-platform/agent-kit';
import type { DeploymentProfileDimensions } from '@agent-tool-platform/capability-registry';

export type CapabilityVersionStatus = 'declared' | 'development' | 'released';

export interface CapabilityCatalogProfile {
  readonly id: string;
  readonly description: string;
  readonly dimensions: DeploymentProfileDimensions;
  readonly bindingModes: readonly BindingMode[];
  readonly setupRequired: boolean;
  readonly setupSummary: string;
  readonly readinessSummary: string;
}

export interface CapabilityCatalogItem {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly versionStatus: CapabilityVersionStatus;
  readonly category: string;
  readonly tags: readonly string[];
  readonly toolCount: number;
  readonly profiles: readonly CapabilityCatalogProfile[];
  readonly bindingModes: readonly BindingMode[];
  readonly stateChanging: boolean;
}

export interface CapabilityCatalogResponse {
  readonly registryVersion: string;
  readonly capabilities: readonly CapabilityCatalogItem[];
}

export interface BuildAgentRequest {
  readonly definition: AgentDefinition;
}

export type ReadinessState =
  | 'available-local'
  | 'ready'
  | 'local-setup-required'
  | 'remote-provider-setup-required'
  | 'missing-configuration'
  | 'incompatible-binding';

export interface BuildCapabilityResult {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly resolvedVersion: string;
  readonly profile: {
    readonly id: string;
    readonly description: string;
    readonly mutation: DeploymentProfileDimensions['mutation'];
  };
  readonly binding: {
    readonly id: string;
    readonly mode: BindingMode;
    readonly interface: string;
  };
  readonly compatibility: {
    readonly state: 'compatible';
    readonly reasons: readonly string[];
  };
  readonly artifact: {
    readonly kind: 'npm' | 'oci' | 'source';
    readonly availability: 'published' | 'declared' | 'source-only';
  };
  readonly readiness: {
    readonly state: ReadinessState;
    readonly requirements: readonly ReadinessRequirement[];
    readonly setupRequired: boolean;
    readonly setupSummary: string;
    readonly summary: string;
  };
  readonly configuration: {
    readonly endpointRequired: boolean;
    readonly requiredNames: readonly string[];
    readonly headers: readonly {
      readonly name: string;
      readonly configurationName: string;
      readonly prefix: string;
    }[];
  };
}

export type GeneratedArtifactKind = 'instructions' | 'lock' | 'mcp' | 'vscode-agent';

export interface GeneratedArtifact {
  readonly kind: GeneratedArtifactKind;
  readonly label: string;
  readonly path: string;
  readonly mediaType: 'application/json' | 'text/markdown';
  readonly content: string;
}

export interface BuildAgentResult {
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
  };
  readonly lockDigest: string;
  readonly capabilities: readonly BuildCapabilityResult[];
  readonly execution: Readonly<Record<BindingMode, number>>;
  readonly readiness: {
    readonly setupRequired: number;
    readonly configurationRequired: number;
    readonly ready: number;
  };
  readonly vsCode: {
    readonly generated: true;
    readonly agentPath: string;
    readonly mcpPath: '.vscode/mcp.json';
    readonly serverCount: number;
  };
  readonly artifacts: readonly GeneratedArtifact[];
  readonly instanceIdentity: AgentInstanceSeam;
}

export type BuilderErrorCode =
  | 'BUILD_FAILED'
  | 'INVALID_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'REGISTRY_UNAVAILABLE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INVALID_AGENT_DEFINITION'
  | 'INVALID_REGISTRY_RECORD'
  | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_VERSION_NOT_FOUND'
  | 'CAPABILITY_PROFILE_NOT_FOUND'
  | 'INCOMPATIBLE_BINDING'
  | 'INSTRUCTION_LIMIT_EXCEEDED'
  | 'INVALID_LOCK'
  | 'INVALID_ADAPTER_OUTPUT'
  | 'INVALID_READINESS_INPUT'
  | 'INVALID_INSTANCE_IDENTITY';

export interface BuilderErrorResponse {
  readonly error: {
    readonly code: BuilderErrorCode;
    readonly summary: string;
    readonly issues: readonly string[];
  };
}

export interface BuilderHealthResponse {
  readonly status: 'ok';
  readonly service: 'agent-builder';
}
