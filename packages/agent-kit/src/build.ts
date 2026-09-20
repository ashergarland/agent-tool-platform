import { composeInstructions, type InstructionComposition } from './instructions.js';
import {
  validateHostAdapterOutput,
  type HostAdapter,
  type HostAdapterOutput,
} from './host-adapter.js';
import { createAgentInstanceSeam, type AgentInstanceSeam } from './instance.js';
import { createAgentLock, digestAgentLock, serializeAgentLock } from './lock.js';
import { createReadinessPlan, type ReadinessPlan, type ReadinessSnapshot } from './readiness.js';
import {
  assertCompatibleResolution,
  resolveAgentDefinition,
  type ResolvedCapability,
} from './resolution.js';
import type { CapabilityRegistryReader } from './registry.js';
import type { AgentDefinition, AgentLock } from './schemas.js';
import { vscodeHostAdapter, type VsCodeAdapterOutput } from './vscode.js';

export interface AgentBuild<TAdapterOutput extends HostAdapterOutput = HostAdapterOutput> {
  readonly definition: AgentDefinition;
  readonly capabilities: readonly ResolvedCapability[];
  readonly lock: AgentLock;
  readonly lockText: string;
  readonly lockDigest: `sha256:${string}`;
  readonly instructions: InstructionComposition;
  readonly readiness: ReadinessPlan;
  readonly adapter: TAdapterOutput;
  readonly instanceIdentity: AgentInstanceSeam;
}

export interface AgentBuildOptions<TAdapterOutput extends HostAdapterOutput> {
  readonly registry: CapabilityRegistryReader;
  readonly adapter: HostAdapter<TAdapterOutput>;
  readonly readinessSnapshot?: ReadinessSnapshot;
}

export const buildAgent = async <TAdapterOutput extends HostAdapterOutput>(
  definitionInput: unknown,
  options: AgentBuildOptions<TAdapterOutput>,
): Promise<AgentBuild<TAdapterOutput>> => {
  const resolution = await resolveAgentDefinition(
    definitionInput,
    options.registry,
    options.adapter,
  );
  const capabilities = assertCompatibleResolution(resolution);
  const instructions = composeInstructions(resolution.definition, capabilities);
  const lock = createAgentLock(resolution, capabilities, options.adapter);
  const lockText = serializeAgentLock(lock);
  const lockDigest = digestAgentLock(lock);
  const readiness = createReadinessPlan(resolution, options.readinessSnapshot, lockDigest);
  const adapter = validateHostAdapterOutput(
    options.adapter,
    options.adapter.generate({
      definition: resolution.definition,
      lock,
      lockDigest,
      capabilities,
      instructions,
    }),
  );
  const instanceIdentity = createAgentInstanceSeam(
    resolution.definition,
    lock.agent.definitionDigest,
    lockDigest,
    options.adapter,
    capabilities,
  );

  return {
    definition: resolution.definition,
    capabilities,
    lock,
    lockText,
    lockDigest,
    instructions,
    readiness,
    adapter,
    instanceIdentity,
  };
};

export interface VsCodeAgentBuildOptions {
  readonly registry: CapabilityRegistryReader;
  readonly readinessSnapshot?: ReadinessSnapshot;
}

export const buildVsCodeAgent = (
  definitionInput: unknown,
  options: VsCodeAgentBuildOptions,
): Promise<AgentBuild<VsCodeAdapterOutput>> =>
  buildAgent(definitionInput, {
    registry: options.registry,
    adapter: vscodeHostAdapter,
    ...(options.readinessSnapshot === undefined
      ? {}
      : { readinessSnapshot: options.readinessSnapshot }),
  });
