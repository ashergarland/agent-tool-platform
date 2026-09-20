import type { InstructionComposition } from './instructions.js';
import { AgentKitError } from './errors.js';
import type {
  CapabilityArtifact,
  CapabilityBinding,
  CapabilityProfileSummary,
} from '@agent-tool-platform/capability-registry';
import type { ResolvedCapability } from './resolution.js';
import type { AgentDefinition, AgentLock } from './schemas.js';

export interface HostCompatibility {
  readonly state: 'compatible' | 'incompatible';
  readonly reasons: readonly string[];
}

export interface HostCompatibilityInput {
  readonly profile: CapabilityProfileSummary;
  readonly binding: CapabilityBinding;
  readonly artifact: CapabilityArtifact;
}

export interface GeneratedHostFile {
  readonly path: string;
  readonly mediaType: 'application/json' | 'text/markdown';
  readonly content: string;
}

export interface HostAdapterOutput {
  readonly hostId: string;
  readonly schemaVersion: number;
  readonly files: readonly GeneratedHostFile[];
}

export interface HostAdapterGenerationInput {
  readonly definition: AgentDefinition;
  readonly lock: AgentLock;
  readonly lockDigest: `sha256:${string}`;
  readonly capabilities: readonly ResolvedCapability[];
  readonly instructions: InstructionComposition;
}

export interface HostAdapter<TOutput extends HostAdapterOutput = HostAdapterOutput> {
  readonly id: string;
  readonly schemaVersion: number;
  evaluate(input: HostCompatibilityInput): HostCompatibility;
  generate(input: HostAdapterGenerationInput): TOutput;
}

export const validateHostAdapterOutput = <TOutput extends HostAdapterOutput>(
  adapter: HostAdapter<TOutput>,
  output: TOutput,
): TOutput => {
  const issues: string[] = [];
  if (output.hostId !== adapter.id) {
    issues.push(`hostId ${output.hostId} does not match adapter ${adapter.id}`);
  }
  if (output.schemaVersion !== adapter.schemaVersion) {
    issues.push(
      `schemaVersion ${String(output.schemaVersion)} does not match adapter ${String(adapter.schemaVersion)}`,
    );
  }
  if (output.files.length === 0 || output.files.length > 100) {
    issues.push('files must contain between 1 and 100 generated files');
  }
  const paths = new Set<string>();
  for (const file of output.files) {
    if (
      file.path.length === 0 ||
      file.path.length > 500 ||
      file.path.startsWith('/') ||
      /^[A-Za-z]:/u.test(file.path) ||
      file.path.includes('\\') ||
      /(?:^|\/)\.\.(?:\/|$)/u.test(file.path)
    ) {
      issues.push(`generated file path is not portable: ${file.path.slice(0, 100)}`);
    }
    if (paths.has(file.path)) issues.push(`duplicate generated file path: ${file.path}`);
    paths.add(file.path);
    if (file.content.length > 1_000_000) {
      issues.push(`generated file ${file.path} exceeds the 1000000 character limit`);
    }
  }
  if (issues.length > 0) {
    throw new AgentKitError(
      'INVALID_ADAPTER_OUTPUT',
      `Adapter ${adapter.id} generated invalid output.`,
      issues,
    );
  }
  return output;
};
